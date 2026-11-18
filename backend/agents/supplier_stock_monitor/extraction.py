import json
import re
from decimal import Decimal
from bs4 import BeautifulSoup
from .models import Extracted
from .storage import dump

UNITS={'pcs':'piece','pieces':'piece','piece':'piece','pc':'piece','tons':'ton','tonnes':'ton','tonne':'ton','ton':'ton','kg':'kg','kgs':'kg','kilograms':'kg','sheets':'sheet','sheet':'sheet','reels':'reel','reel':'reel'}


def clean_text(body,html=None):
    if not body and html:
        soup=BeautifulSoup(html,'html.parser')
        for tag in soup(['script','style','blockquote','iframe','form','svg']):tag.decompose()
        body=soup.get_text('\n',strip=True)
    lines=[]
    for line in (body or '').splitlines():
        if re.match(r'^\s*(On .+wrote:|[-_]{2,}\s*Original Message|From:\s.+@)',line,re.I):break
        if not line.lstrip().startswith('>'):lines.append(line)
    return '\n'.join(lines)[:50000]


def classify(text):
    if re.search(r'\b(previous|historical|last week|last month|old quote)\b',text,re.I):return 'Historical'
    if re.search(r'\b(out of stock|unavailable|no stock)\b',text,re.I):return 'Unavailable'
    if re.search(r'\b(subject to|conditional|if payment|if you order)\b',text,re.I):return 'Conditional'
    if re.search(r'\b(production capacity|can produce|will manufacture|future production)\b',text,re.I):return 'Future production'
    if re.search(r'\b(estimate|estimated|approximately|around)\b',text,re.I):return 'Estimated'
    if re.search(r'\b(currently have|current stock|in stock|available now|confirmed availability|quantity:)\b',text,re.I):return 'Confirmed'
    return 'Unknown'


def number(value):return str(Decimal(str(value).replace(',','')))


def deterministic(sources,refs):
    records=[]
    for source_index,source in enumerate(sources):
        text=source['text']
        # Structured attachment rows use the existing Agent #3 header/normalization contract.
        if source.get('raw'):
            from agents.supplier_catalog_intake.normalization import normalize,header_mapping
            data,errors,warnings=normalize(source['raw'],header_mapping(source['raw']),source['observed_at'])
            ref=data.get('vendor_sku') or data.get('name')
            if not ref:continue
            quantity=data.get('qty');unit=None;mapping=header_mapping(source['raw'])
            for header,value in source['raw'].items():
                header_key=re.sub(r'[^a-z0-9]+',' ',header.lower()).strip()
                if header_key in ('quantity unit','stock unit','qty unit','uom','unit') and value:
                    unit=UNITS.get(str(value).lower().strip(),unit)
                if mapping.get(header)=='qty' and value is not None:
                    quantity=str(value).strip()
                    if re.search(r'\b(pcs|pieces)\b',header_key):unit='piece'
            if ref in refs:errors=[e for e in errors if not e.startswith(('line:','name:','observed_at:'))]
            if unit and unit!='piece':errors=[e for e in errors if not e.startswith('qty:')]
            fields={k:v for k,v in data.items() if k in Extracted.model_fields and v is not None}
            context=source.get('message_context','')
            availability=classify(context) if context else 'Unknown'
            if data.get('availability')=='Unavailable':availability='Unavailable'
            availability_labels={'confirmed':'Confirmed','in stock':'Confirmed','available now':'Confirmed','unavailable':'Unavailable',
                'out of stock':'Unavailable','made to order':'Future production','future production':'Future production','estimated':'Estimated',
                'historical':'Historical','conditional':'Conditional','unknown':'Unknown','catalog only':'Unknown','supplier reported stock':'Unknown'}
            explicit_availability=False
            for h,v in source['raw'].items():
                if header_mapping([h]).get(h)=='availability' and str(v).lower() in availability_labels:
                    explicit_availability=True;availability=availability_labels[str(v).lower()]
                    errors=[e for e in errors if not e.startswith('availability:')]
            fields.update(product_ref=ref,quantity=quantity,quantity_unit=unit,availability=availability)
            fields.pop('observed_at',None)
            evidence={f:{'source':source_index,'quote':text,'location':source.get('location','Attachment row')} for f in fields}
            if context and not explicit_availability:evidence['availability']={'source':0,'quote':context,'location':'Current supplier email covering the stock list','method':'Deterministic wording classification'}
            records.append({'data':fields,'evidence':evidence,'parser_errors':errors})
            continue
        blocks=re.split(r'(?im)(?=^\s*(?:SKU|Product code|Product ref)\s*[:=])',text)
        for block in blocks:
            if not block.strip():continue
            match=re.search(r'(?im)^\s*(?:SKU|Product code|Product ref)\s*[:=]\s*([^\n]+)',block)
            ref=match[1].strip() if match else refs[0] if len(refs)==1 else None
            if not ref:continue
            fields={'product_ref':ref}
            patterns={
              'quantity':r'(?:quantity|stock|we\s+(?:currently\s+)?have)\s*[:=]?\s*([\d,.]+)(?:\s*(pieces|pcs|pc|piece|tons|tonnes|tonne|ton|kgs|kg|kilograms|sheets|sheet|reels|reel)\b)?',
              'gsm':r'(\d+(?:\.\d+)?)\s*GSM\b','moq':r'\bMOQ\s*[:=]?\s*([\d,]+)',
              'lead_days':r'(?:lead(?:\s*time)?|dispatch)\s*[:=]?\s*(\d+)\s*days',
              'price':r'\b(?:price\s*[:=]?\s*)?(PKR|USD)\s*([\d,.]+)\s*(?:/|per\s+)(piece|pcs|ton|kg|sheet|reel)\b',
            }
            evidence={}
            for field,pattern in patterns.items():
                found=list(re.finditer(pattern,block,re.I))
                if len(found)>1 and len({m.group(0).lower() for m in found})>1:
                    evidence[field]={'source':source_index,'quote':block,'location':source.get('location','Message body'),'conflict':True}
                    continue
                if not found:continue
                m=found[0];quote=m.group(0)
                if field=='quantity':
                    fields['quantity']=number(m[1])
                    if m[2]:
                        fields['quantity_unit']=UNITS[m[2].lower()]
                        evidence['quantity_unit']={'source':source_index,'quote':quote,'location':source.get('location','Message body')}
                elif field=='price':
                    fields.update(price=number(m[2]),currency=m[1].upper(),price_unit=UNITS.get(m[3].lower(),m[3].lower()))
                    for f in ('currency','price_unit'):evidence[f]={'source':source_index,'quote':quote,'location':source.get('location','Message body')}
                else:fields[field]=number(m[1])
                evidence[field]={'source':source_index,'quote':quote,'location':source.get('location','Message body')}
            for field,label in [('board','Material'),('grade','Grade'),('form','Form'),('available_from','Available date'),('valid_until','Valid until'),('terms','Terms')]:
                m=re.search(r'(?im)^\s*'+label+r'\s*:\s*([^\n]+)',block)
                if m:
                    fields[field]=m[1].strip().lower() if field=='form' else m[1].strip()
                    evidence[field]={'source':source_index,'quote':m[0],'location':source.get('location','Message body')}
            for field,label in [('length_mm','Length'),('width_mm','Width'),('height_mm','Height')]:
                m=re.search(label+r'\s*:\s*(\d+(?:\.\d+)?)\s*(mm|cm|inches|inch|in|m)\b',block,re.I)
                if m:
                    fields[field]=str(Decimal(m[1])*{'mm':Decimal(1),'cm':Decimal(10),'m':Decimal(1000),'inch':Decimal('25.4'),'inches':Decimal('25.4'),'in':Decimal('25.4')}[m[2].lower()])
                    evidence[field]={'source':source_index,'quote':m[0],'location':source.get('location','Message body'),'method':'Deterministic Decimal unit conversion'}
            if len(fields)==1:continue
            fields['availability']=classify(block)
            evidence['availability']={'source':source_index,'quote':block,'location':source.get('location','Message body'),'method':'Deterministic wording classification; Admin review required'}
            records.append({'data':fields,'evidence':evidence,'parser_errors':[]})
    return records


def validate_record(record,before=None):
    errors=list(record.get('parser_errors',[]));warnings=[];raw=record['data']
    try:
        clean=Extracted.model_validate(raw).model_dump(mode='json',exclude_none=True)
    except Exception as exc:
        clean=raw
        errors.extend('.'.join(map(str,e['loc']))+': '+e['msg'] for e in exc.errors(include_input=False,include_url=False))
    for f in ('available_from','valid_until'):
        if clean.get(f):
            try:
                from .domain import timestamp
                timestamp(clean[f])
            except ValueError:errors.append(f+': invalid date')
    if raw.get('quantity') is not None and not raw.get('quantity_unit'):errors.append('Quantity unit is unknown; request clarification')
    if raw.get('price') is not None and (not raw.get('currency') or not raw.get('price_unit')):errors.append('Price requires explicit currency and pricing basis')
    if raw.get('price') is None:warnings.append('Price unconfirmed; preserve existing price and request clarification')
    if clean.get('quantity') is not None:
        try:
            if Decimal(str(clean['quantity']))==0 and clean.get('availability')=='Confirmed':
                clean['availability']='Unavailable'
                warnings.append('Explicit zero current quantity means unavailable stock')
        except Exception:pass
    if clean.get('available_from') and clean.get('availability')=='Confirmed':
        from .domain import timestamp
        from .storage import now
        try:
            if timestamp(clean['available_from'])>timestamp(now()):errors.append('Future availability date conflicts with current availability; request clarification')
        except ValueError:pass
    if raw.get('availability') in ('Historical','Conditional','Estimated','Future production','Unknown'):
        warnings.append(raw.get('availability','Unknown')+' information is not confirmed current stock')
    if raw.get('availability')=='Historical':errors.append('Historical quotation cannot confirm current inventory')
    if any(v.get('conflict') for v in record['evidence'].values()):errors.append('Conflicting values in the same supplier response')
    if before and raw.get('quantity_unit') and before.get('quantity_unit') and raw['quantity_unit']!=before['quantity_unit']:
        old,new=before['quantity_unit'],raw['quantity_unit']
        factors={'kg':Decimal(1),'ton':Decimal(1000)}
        if old in factors and new in factors and raw.get('quantity') is not None:
            clean['quantity']=str(Decimal(str(raw['quantity']))*factors[new]/factors[old]);clean['quantity_unit']=old
            warnings.append('Quantity converted deterministically between kg and metric tons; source unit preserved')
        else:errors.append('Quantity units are not safely convertible to the existing inventory basis')
    return clean,list(dict.fromkeys(errors)),warnings
