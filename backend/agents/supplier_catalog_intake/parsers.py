"""Bounded, nonexecuting parsers retaining worksheet/row/page evidence."""
import csv
import io
import json
import zipfile
from pathlib import Path
from bs4 import BeautifulSoup
from .normalization import header_mapping

MAX_EXPANDED = 60 * 1024 * 1024


def check_file(name, content):
    kind = Path(name).suffix.lower().lstrip('.')
    if kind not in ('xlsx', 'csv', 'pdf'):
        raise ValueError('Supported formats: XLSX, CSV and PDF')
    if not content:
        raise ValueError('File is empty')
    if kind == 'xlsx':
        if not content.startswith(b'PK'):
            raise ValueError('Invalid XLSX signature')
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                entries = archive.infolist()
                if len(entries) > 1500 or sum(e.file_size for e in entries) > MAX_EXPANDED:
                    raise ValueError('Workbook expanded size exceeds safe limit')
                if any(e.flag_bits & 1 or e.filename.endswith('vbaProject.bin') or
                       (e.file_size > 1024 * 1024 and e.file_size > max(1, e.compress_size) * 250) for e in entries):
                    raise ValueError('Encrypted, macro or excessive compression workbook is not allowed')
                if '[Content_Types].xml' not in archive.namelist() or 'xl/workbook.xml' not in archive.namelist():
                    raise ValueError('Not an XLSX workbook')
        except zipfile.BadZipFile:
            raise ValueError('Corrupt XLSX archive')
    elif kind == 'pdf' and not content.startswith(b'%PDF-'):
        raise ValueError('Invalid PDF signature')
    elif kind == 'csv' and (b'\x00' in content or content.startswith((b'PK', b'%PDF-'))):
        raise ValueError('CSV must contain plain text without NUL bytes')
    return kind


def table_rows(rows, source, limit, mapping=None):
    header_at, headers = None, []
    for i, cells in enumerate(rows[:30]):
        candidate = [str(c).strip() if c is not None else '' for c in cells]
        if any(len(c) > 500 for c in candidate): continue
        mapped = header_mapping(candidate, mapping)
        # Do not import vendor directories, assumptions or reference lists as products.
        if len(mapped) >= 2 and any(f in mapped.values() for f in ('name', 'description', 'line')):
            if len([h for h in candidate if h]) != len(set(h for h in candidate if h)):
                raise ValueError('Duplicate column names require correction in the source')
            header_at, headers = i, candidate
            break
    if header_at is None:
        return [], ['No reliable product header found in ' + str(source)]
    output = []
    for index, cells in enumerate(rows[header_at + 1:], header_at + 2):
        if not any(c is not None and str(c).strip() for c in cells): continue
        if any(c is not None and str(c).strip() for c in cells[len(headers):]):
            raise ValueError('Record contains values beyond its header columns')
        if any(c is not None and len(str(c)) > 12000 for c in cells):
            raise ValueError('Cell exceeds 12000-character extraction limit; original file remains available')
        raw = {h: (str(cells[j])[:12000] if j < len(cells) and cells[j] is not None else None)
               for j, h in enumerate(headers) if h}
        if any(str(v or '').upper().startswith('EXAMPLE') for h, v in raw.items() if header_mapping([h]).get(h) == 'vendor_sku'):
            continue
        if len(output) >= limit:
            raise ValueError('Catalog exceeds configured row limit; split the source')
        output.append({'raw': raw, 'source': {**source, 'row': index, 'header_row': header_at + 1,
                                            'text': json.dumps(raw, ensure_ascii=False)}})
    return output, []


def parse(content, kind, limit=2000, mapping=None):
    result, warnings, texts = [], [], []
    if kind == 'xlsx':
        from openpyxl import load_workbook
        book = load_workbook(io.BytesIO(content), read_only=True, data_only=False, keep_links=False)
        try:
            if len(book.worksheets) > 40: raise ValueError('Too many worksheets')
            for sheet in book:
                if sheet.sheet_state != 'visible': continue
                rows = []
                for row in sheet.iter_rows(values_only=True):
                    if len(rows) > limit + 35: raise ValueError('Worksheet exceeds row limit')
                    if len(row) > 150: raise ValueError('Too many columns')
                    rows.append(row)
                values, notes = table_rows(rows, {'worksheet': sheet.title}, limit - len(result), mapping)
                result.extend(values)
                warnings.extend(notes)
        finally:
            book.close()
    elif kind == 'csv':
        text = None
        for encoding in ('utf-8-sig', 'cp1252'):
            try:
                text = content.decode(encoding)
                break
            except UnicodeDecodeError: pass
        if text is None: raise ValueError('Unsupported CSV encoding')
        try: dialect = csv.Sniffer().sniff(text[:10000], delimiters=',;\t|')
        except csv.Error: dialect = csv.excel
        rows = []
        for row in csv.reader(io.StringIO(text), dialect, strict=True):
            if len(row) > 150 or len(rows) > limit + 35: raise ValueError('CSV exceeds row/column limit')
            rows.append(row)
        result, warnings = table_rows(rows, {'worksheet': 'CSV'}, limit, mapping)
        texts = [{'page': 1, 'text': text[:16000]}]
    elif kind == 'pdf':
        from pypdf import PdfReader
        from pypdf._configuration import overwrite_configuration
        # Context-local limits apply only to this bounded parser worker.
        overwrite_configuration(zlib_maximum_output_length=8000000, lzw_maximum_output_length=8000000,
            run_length_maximum_output_length=8000000, array_based_stream_maximum_output_length=8000000,
            maximum_declared_stream_length=8000000, stream_decoding_work_maximum_length=16000000,
            page_tree_maximum_entries=1000, xform_maximum_invocations_per_extraction=100)
        reader = PdfReader(io.BytesIO(content), strict=True)
        if reader.is_encrypted: raise ValueError('Encrypted PDFs are not supported')
        if len(reader.pages) > 80: raise ValueError('PDF exceeds 80-page limit')
        for index, page in enumerate(reader.pages, 1):
            # Bound decompression before text extraction, including malicious streams.
            streams = page.get('/Contents')
            if streams:
                refs = streams if isinstance(streams, list) else [streams]
                for ref in refs:
                    obj = ref.get_object()
                    if len(getattr(obj, '_data', b'')) > 2 * 1024 * 1024:
                        raise ValueError('PDF page content exceeds safe limit')
            text = (page.extract_text(extraction_mode='layout') or '')[:50000]
            texts.append({'page': index, 'text': text})
            lines = [line for line in text.splitlines() if line.strip()]
            # Text tables with explicit column separators only. Do not guess prose prices.
            import re
            rows = [re.split(r'\s{2,}|\t|\|', line.strip()) for line in lines]
            values, notes = table_rows(rows, {'page': index, 'text': text}, limit - len(result), mapping)
            result.extend(values)
            warnings.extend(notes)
        if not result:
            warnings.append('PDF requires manual review: scanned or unstructured content cannot be extracted reliably')
    return result, warnings, texts


def parse_html(html, url, limit=2000, mapping=None):
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'nav', 'footer']): tag.decompose()
    output, notes = [], []
    for index, table in enumerate(soup.select('table')[:30]):
        rows = [[c.get_text(' ', strip=True) for c in r.select('th,td')] for r in table.select('tr')]
        found, warnings = table_rows(rows, {'url': url, 'table': index + 1}, limit - len(output), mapping)
        output.extend(found)
        notes.extend(warnings)
    text = soup.get_text(' ', strip=True)[:16000]
    if not output: notes.append('No reliable product table; manual review or explicitly enabled AI interpretation required')
    return output, notes, [{'url': url, 'text': text}]
