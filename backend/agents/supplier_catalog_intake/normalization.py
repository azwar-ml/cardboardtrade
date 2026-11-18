"""Decimal commercial normalization. No inferred prices, stock or dimensions."""
import hashlib
import json
import re
import datetime as dt
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional, Literal
from pydantic import BaseModel, ConfigDict, Field


def taxonomy():
    # Read the existing inventory taxonomy; never maintain a second category list.
    text = (Path(__file__).resolve().parents[3] / 'frontend/lib/trade/catalog.ts').read_text(encoding='utf-8')
    return re.findall(r'\{ line: "([^"]+)", family: "([^"]+)"', text)


class Product(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    vendor_sku: Optional[str] = Field(None, max_length=180)
    name: str = Field(min_length=1, max_length=500)
    line: str
    description: Optional[str] = Field(None, max_length=6000)
    length_mm: Optional[Decimal] = Field(None, gt=0, le=100000)
    width_mm: Optional[Decimal] = Field(None, gt=0, le=100000)
    height_mm: Optional[Decimal] = Field(None, gt=0, le=100000)
    board: Optional[str] = None
    ply: Optional[Literal['Board', '3', '5', '7']] = None
    flute: Optional[Literal['E', 'B', 'C', 'EB', 'BC', 'BCB', 'EBC']] = None
    gsm: Optional[Decimal] = Field(None, gt=0)
    grade: Optional[str] = None
    style: Optional[str] = None
    print: Optional[str] = None
    coating: Optional[str] = None
    colour: Optional[str] = None
    customization: Optional[str] = None
    price: Optional[Decimal] = Field(None, ge=0, le=1000000000)
    currency: Optional[Literal['PKR', 'USD']] = None
    price_unit: Optional[str] = None
    moq: Optional[int] = Field(None, ge=1, le=1000000000)
    qty: Optional[int] = Field(None, ge=0, le=1000000000)
    tiers: Optional[str] = None
    lead_days: Optional[int] = Field(None, ge=0, le=3650)
    capacity: Optional[str] = None
    availability: Literal['Catalog only', 'Supplier reported stock', 'Made to order', 'Unavailable'] = 'Catalog only'
    observed_at: str
    location: Optional[str] = None
    choice: Optional[Literal['1st', '2nd']] = None
    defects: Optional[str] = None
    notes: Optional[str] = None
    dim_type: Optional[str] = None
    food_safe: Optional[str] = None
    certifications: Optional[str] = None
    photos: Optional[str] = None
    valid_until: Optional[str] = None
    bundle_qty: Optional[int] = Field(None, ge=1)
    bundle_l_cm: Optional[Decimal] = Field(None, gt=0)
    bundle_w_cm: Optional[Decimal] = Field(None, gt=0)
    bundle_h_cm: Optional[Decimal] = Field(None, gt=0)
    bundle_kg: Optional[Decimal] = Field(None, gt=0)


ALIASES = {
 'vendor_sku': ['supplier sku', 'vendor sku', 'sku', 'supplier product code', 'product code', 'code'],
 'name': ['product name', 'name', 'item name'],
 'line': ['product line', 'product', 'category', 'product category'],
 'description': ['description', 'product description'],
 'style': ['style', 'box style'], 'choice': ['choice'], 'defects': ['defect notes'],
 'ply': ['ply', 'corrugated ply'], 'flute': ['flute', 'flute type'], 'board': ['board liner build', 'material', 'board material'],
 'gsm': ['total gsm', 'gsm'], 'grade': ['board grade', 'grade'],
 'length_mm': ['length mm', 'length', 'l mm', 'length cm', 'length in'], 'width_mm': ['width mm', 'width', 'w mm', 'width cm', 'width in'], 'height_mm': ['height mm', 'height', 'h mm', 'height cm', 'height in'],
 'unit': ['unit', 'dimension unit', 'measurement unit'], 'dim_type': ['dimension type'],
 'print': ['print', 'printing'], 'coating': ['coating', 'finishing'], 'colour': ['colour', 'color'],
 'customization': ['customization', 'customisation'], 'food_safe': ['food safe y n'],
 'qty': ['qty available pcs', 'quantity', 'stock', 'stock quantity', 'available pcs', 'qty pcs'],
 'moq': ['moq pcs', 'moq', 'minimum order quantity'], 'price': ['unit price', 'vendor price', 'price', 'price pkr', 'price usd'],
 'currency': ['currency'], 'price_unit': ['pricing unit', 'price unit'], 'tiers': ['quantity discount tiers', 'price tiers'],
 'lead_days': ['lead time days', 'lead days'], 'capacity': ['production capacity', 'capacity'],
 'availability': ['availability', 'availability status'], 'observed_at': ['availability observation date', 'observed at'],
 'location': ['stock location city', 'location', 'city'], 'notes': ['notes'], 'valid_until': ['price valid until'],
 'certifications': ['certifications'], 'photos': ['photos available y n'],
 'bundle_qty': ['pcs per bundle'], 'bundle_l_cm': ['bundle l cm'], 'bundle_w_cm': ['bundle w cm'],
 'bundle_h_cm': ['bundle h cm'], 'bundle_kg': ['bundle weight kg'],
}


def key(value):
    return re.sub(r'[^a-z0-9]+', ' ', str(value).lower()).strip()


def header_mapping(headers, custom=None):
    lookup = {key(a): field for field, names in ALIASES.items() for a in names + [field]}
    result = {}
    for h in headers:
        field = (custom or {}).get(h, lookup.get(key(h)))
        if field in Product.model_fields or field == 'unit':
            result[h] = field
    return result


NUMERIC = {'price', 'gsm', 'length_mm', 'width_mm', 'height_mm', 'moq', 'qty', 'lead_days',
           'bundle_qty', 'bundle_l_cm', 'bundle_w_cm', 'bundle_h_cm', 'bundle_kg'}


def normalize(raw, mapping, observed):
    data, errors, warnings = {}, [], []
    for header, value in raw.items():
        field = mapping.get(header)
        if not field or value is None or str(value).strip() == '':
            continue
        value = str(value).strip()
        if value.startswith('='):
            errors.append(f'{field}: formula is not accepted; supply a literal value')
            continue
        if field in NUMERIC:
            try:
                number = Decimal(value.replace(',', ''))
                if not number.is_finite():
                    raise InvalidOperation()
                data[field] = str(number)
            except InvalidOperation:
                data[field] = value
                errors.append(f'{field}: invalid number')
        else:
            data[field] = value
        if field == 'price' and key(header).endswith(('pkr', 'usd')):
            data.setdefault('currency', key(header).split()[-1].upper())
        if field == 'price' and key(header) in ('unit price', 'vendor price'):
            # Supplier template explicitly defines this column as a price per piece.
            data.setdefault('price_unit', 'piece')
    data.setdefault('name', data.get('description') or data.get('vendor_sku') or '')
    unit = data.pop('unit', 'mm').lower().strip()
    factors = {'mm': Decimal(1), 'millimeter': Decimal(1), 'cm': Decimal(10), 'm': Decimal(1000),
               'meter': Decimal(1000), 'metre': Decimal(1000), 'in': Decimal('25.4'), 'inch': Decimal('25.4'), 'inches': Decimal('25.4')}
    for field in ('length_mm', 'width_mm', 'height_mm'):
        if field in data:
            header = next((h for h, f in mapping.items() if f == field), '')
            suffix = re.search(r'\b(mm|cm|inches|inch|in|m)\b', key(header))
            measure_unit = suffix[1] if suffix else unit
            if measure_unit not in factors:
                errors.append(f'{field}: unsupported unit {measure_unit}')
            else:
                try:
                    data[field] = str(Decimal(data[field]) * factors[measure_unit])
                except InvalidOperation:
                    pass
    for field in ('currency', 'flute'):
        if field in data:
            data[field] = data[field].upper()
    if data.get('flute') in ('—', '-', 'NONE', 'N/A'):
        data.pop('flute')
    if 'ply' in data:
        data['ply'] = re.sub(r'\s*[- ]?ply$', '', data['ply'], flags=re.I)
        if data['ply'].lower() == 'board': data['ply'] = 'Board'
    lines = {line.lower(): line for line, _ in taxonomy()}
    data['line'] = lines.get(str(data.get('line', '')).lower(), data.get('line', ''))
    data.setdefault('observed_at', observed)
    data.setdefault('availability', 'Supplier reported stock' if data.get('qty') is not None else 'Catalog only')
    checked, more_errors, more_warnings = validate(data)
    return checked, list(dict.fromkeys(errors + more_errors)), warnings + more_warnings


def validate(data):
    errors, warnings = [], []
    try:
        product = Product.model_validate(data)
        clean = product.model_dump(mode='json')
    except Exception as exc:
        if hasattr(exc, 'errors'):
            errors.extend('.'.join(map(str, e['loc'])) + ': ' + e['msg'] for e in exc.errors(include_input=False, include_url=False))
        else:
            errors.append('Invalid product data')
        clean = data
    if data.get('line') not in dict(taxonomy()):
        errors.append('line: select an existing product category')
    if data.get('price') is not None and (not data.get('currency') or not data.get('price_unit')):
        errors.append('price: currency and pricing unit are required')
    if data.get('qty') is None:
        warnings.append('Stock quantity unknown; catalog listing is not confirmed ready stock')
    if data.get('price') is None:
        warnings.append('Price unknown; request a supplier quotation')
    if any(data.get(k) is None for k in ('length_mm', 'width_mm', 'height_mm')):
        warnings.append('Dimensions incomplete; comparability requires review')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}(?:T.*)?', str(data.get('observed_at', ''))):
        errors.append('observed_at: ISO observation date required')
    else:
        try:
            observed = dt.datetime.fromisoformat(str(data['observed_at']).replace('Z', '+00:00'))
            if not observed.tzinfo: observed = observed.replace(tzinfo=dt.timezone.utc)
            clean['observed_at'] = observed.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        except ValueError: errors.append('observed_at: invalid date')
    return clean, errors, warnings


def identity(data):
    fields = ('vendor_sku', 'name', 'line', 'length_mm', 'width_mm', 'height_mm', 'board', 'ply', 'flute', 'gsm',
              'grade', 'style', 'print', 'coating', 'colour', 'customization', 'choice')
    values = []
    for field in fields:
        # A SKU identifies a product even if its display name later changes.
        if field == 'name' and data.get('vendor_sku'): continue
        value = str(data.get(field) or '').strip().casefold()
        if field in NUMERIC and value:
            try: value = str(Decimal(value).normalize())
            except InvalidOperation: pass
        values.append((field, value))
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()
