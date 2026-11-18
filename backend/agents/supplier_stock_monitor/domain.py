import datetime as dt
import json
import re
from decimal import Decimal,InvalidOperation
from email.utils import parseaddr,getaddresses
from .storage import connection, now, dump, settings, required, audit

ITEM_FIELDS=('qty','price','currency','price_pkr','moq','lead_days','board','gsm','length_mm','width_mm','height_mm','style','flute','ply','status','valid_until','description')
ITEM_VERSION="json_object("+','.join("'%s',i.%s"%(f,f) for f in ITEM_FIELDS)+")"


def timestamp(value):
    if not value:return None
    parsed=dt.datetime.fromisoformat(str(value).replace('Z','+00:00'))
    return parsed.replace(tzinfo=dt.timezone.utc) if not parsed.tzinfo else parsed.astimezone(dt.timezone.utc)


def iso(value):return value.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def email(value):
    if '\r' in value or '\n' in value or len([a for _,a in getaddresses([value]) if a])!=1:raise ValueError('Exactly one email address without control characters is required')
    address=parseaddr(value)[1].lower().strip()
    if not re.fullmatch(r'[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[a-z]{2,}',address):raise ValueError('A valid single email address is required')
    return address


def eligibility(conn,vendor_id,contact_id=None):
    vendor=required(conn,'vendors',vendor_id)
    policy=conn.execute('SELECT * FROM stock_policies WHERE vendor_id=?',(vendor_id,)).fetchone()
    reasons=[]
    if vendor['status']!='active':reasons.append('Supplier is not active/approved')
    run=conn.execute('''SELECT j.* FROM qualification_jobs j JOIN discovery_leads l ON l.id=j.lead_id
        WHERE l.linked_vendor_id=? AND j.kind='verification' ORDER BY j.id DESC LIMIT 1''',(vendor_id,)).fetchone()
    report=json.loads(run['report'] or '{}') if run else {}
    supported=any(f.get('category')=='identity' and f.get('result')=='Supported' for f in report.get('findings',[]))
    if not run or run['status']!='Completed' or run['review_status']!='Reviewed' or not supported:
        reasons.append('Requires linked Agent #2 completed Admin-reviewed independent identity evidence')
    if not policy or not policy['enabled']:reasons.append('Monitoring is not enabled')
    if policy and (policy['excluded'] or policy['opted_out']):reasons.append('Supplier excluded or opted out')
    if contact_id:
        contact=required(conn,'stock_contacts',contact_id)
        if contact['vendor_id']!=vendor_id or not contact['confirmed'] or contact['do_not_contact']:
            reasons.append('Contact is unconfirmed, restricted or belongs to another supplier')
    return reasons


def sync_watch(conn):
    missing=conn.execute('''SELECT EXISTS(SELECT 1 FROM items i JOIN stock_policies p ON p.vendor_id=i.vendor_id
      WHERE p.enabled=1 AND NOT EXISTS(SELECT 1 FROM stock_watch w WHERE w.item_id=i.id)) OR
      EXISTS(SELECT 1 FROM catalog_products i JOIN stock_policies p ON p.vendor_id=i.vendor_id
      WHERE p.enabled=1 AND NOT EXISTS(SELECT 1 FROM stock_watch w WHERE w.catalog_id=i.id))''').fetchone()[0]
    if not missing:return
    if not conn.in_transaction:conn.execute('BEGIN IMMEDIATE')
    conn.execute('''INSERT OR IGNORE INTO stock_watch(vendor_id,item_id) SELECT i.vendor_id,i.id FROM items i
      JOIN stock_policies p ON p.vendor_id=i.vendor_id WHERE p.enabled=1 AND NOT EXISTS(SELECT 1 FROM stock_watch w WHERE w.item_id=i.id)''')
    conn.execute('''INSERT OR IGNORE INTO stock_watch(vendor_id,catalog_id) SELECT i.vendor_id,i.id FROM catalog_products i
      JOIN stock_policies p ON p.vendor_id=i.vendor_id WHERE p.enabled=1 AND NOT EXISTS(SELECT 1 FROM stock_watch w WHERE w.catalog_id=i.id)''')


def inventory(conn,watch_id):
    watch=required(conn,'stock_watch',watch_id)
    extra=json.loads(watch['details'])
    if watch['item_id']:
        row=dict(conn.execute('SELECT i.*,'+ITEM_VERSION+' base_version FROM items i WHERE id=?',(watch['item_id'],)).fetchone())
        data={**row,'name':row['description'] or row['line'],'quantity':str(row['qty']),'quantity_unit':'piece','price_unit':'piece'}
    else:
        row=required(conn,'catalog_products',watch['catalog_id'])
        data=json.loads(row['data']);row['base_version']=row['data']
        data['quantity']=data.get('qty');data['quantity_unit']='piece' if data.get('qty') is not None else None
    data.update(extra)
    return {**watch,'data':data,'base_version_current':row['base_version'],'version':dump({'base':row['base_version'],'details':watch['details'],'confirmed':watch['last_confirmed_at']}),
            'ref':data.get('vendor_sku') or data.get('ref') or ('CAT-'+str(watch['catalog_id']))}


def freshness(conn,record,at=None):
    at=at or timestamp(now());config=settings(conn);data=record['data']
    policy=conn.execute('SELECT fresh_days FROM stock_policies WHERE vendor_id=?',(record['vendor_id'],)).fetchone()
    days=record['fresh_days'] or (policy[0] if policy else None) or config.category_days.get(data.get('line','')) or config.fresh_days
    age=(at-timestamp(record['last_confirmed_at'])).total_seconds()/86400 if record['last_confirmed_at'] else None
    if data.get('availability')=='Unavailable' or (record['item_id'] and data.get('status') in ('offline','sold')):state='Unavailable'
    elif data.get('valid_until') and timestamp(data['valid_until'])+dt.timedelta(days=1)<at:state='Expired'
    elif conn.execute("SELECT 1 FROM stock_proposals WHERE watch_id=? AND status='Pending'",(record['id'],)).fetchone():state='Under review'
    elif record['base_version'] and record['base_version']!=record['base_version_current']:state='Under review'
    elif not record['last_confirmed_at']:state='Awaiting supplier confirmation'
    elif conn.execute("SELECT 1 FROM stock_requests WHERE status IN ('Awaiting Reply','Reply Pending') AND EXISTS(SELECT 1 FROM json_each(watch_ids) WHERE value=?)",(record['id'],)).fetchone():state='Awaiting supplier confirmation'
    elif age>=max(config.expire_days,days+1):state='Expired'
    elif age>=days:state='Stale'
    elif age>=max(0,days-config.warning_days):state='Approaching re-verification'
    else:state='Fresh'
    return {'state':state,'fresh_days':days,'age_days':round(age,2) if age is not None else None,
            'confirmed_stock':state=='Fresh' and data.get('availability')=='Confirmed' and Decimal(str(data.get('quantity') or 0))>0}


def install_view(conn):
    # Shared, real-time SQLite read contract, without private messages or costs.
    conn.executescript('''DROP VIEW IF EXISTS stock_inventory_freshness;
    CREATE VIEW stock_inventory_freshness AS WITH source AS (
      SELECT w.*,i.line,i.valid_until,i.status source_status,'''+ITEM_VERSION+''' current_version
      FROM stock_watch w JOIN items i ON i.id=w.item_id
      UNION ALL SELECT w.*,json_extract(p.data,'$.line'),json_extract(p.data,'$.valid_until'),'catalog',p.data
      FROM stock_watch w JOIN catalog_products p ON p.id=w.catalog_id
    ), policy AS (
      SELECT source.*,s.payload config,COALESCE(source.fresh_days,p.fresh_days,
        json_extract(s.payload,'$.category_days.'||json_quote(source.line)),json_extract(s.payload,'$.fresh_days')) days
      FROM source JOIN stock_settings s ON s.id=1 LEFT JOIN stock_policies p ON p.vendor_id=source.vendor_id
    ) SELECT id watch_id,item_id,catalog_id,vendor_id,last_confirmed_at,days freshness_days,
      CASE WHEN json_extract(details,'$.availability')='Unavailable' OR source_status IN ('offline','sold') THEN 'Unavailable'
       WHEN valid_until IS NOT NULL AND valid_until<>'' AND julianday(valid_until)+1<julianday('now') THEN 'Expired'
       WHEN EXISTS(SELECT 1 FROM stock_proposals x WHERE x.watch_id=policy.id AND x.status='Pending') THEN 'Under review'
       WHEN base_version IS NOT NULL AND base_version<>current_version THEN 'Under review'
       WHEN last_confirmed_at IS NULL THEN 'Awaiting supplier confirmation'
       WHEN EXISTS(SELECT 1 FROM stock_requests r,json_each(r.watch_ids) j WHERE j.value=policy.id AND r.status IN ('Awaiting Reply','Reply Pending')) THEN 'Awaiting supplier confirmation'
       WHEN julianday('now')-julianday(last_confirmed_at)>=max(json_extract(config,'$.expire_days'),days+1) THEN 'Expired'
       WHEN julianday('now')-julianday(last_confirmed_at)>=days THEN 'Stale'
       WHEN julianday('now')-julianday(last_confirmed_at)>=max(0,days-json_extract(config,'$.warning_days')) THEN 'Approaching re-verification'
       ELSE 'Fresh' END freshness
    FROM policy;''')


def business_after(start,days,skip_weekends=True):
    value=timestamp(start).astimezone(dt.timezone(dt.timedelta(hours=5)));count=0
    while count<days:
        value+=dt.timedelta(days=1)
        if not skip_weekends or value.weekday()<5:count+=1
    return iso(value)


def compare(before,proposed,config):
    changes=[]
    for field,value in proposed.items():
        if field=='product_ref' or value is None:continue
        old=before.get(field)
        if str(old)==str(value):continue
        pct=None
        if field in ('quantity','price') and old is not None and Decimal(str(old))!=0:
            try:
                pct=abs((Decimal(str(value))-Decimal(str(old)))/Decimal(str(old))*100)
                if not pct.is_finite():pct=None
            except (InvalidOperation,ValueError):pct=None
        significant=bool(pct is not None and pct>=(config.quantity_change_pct if field=='quantity' else config.price_change_pct))
        changes.append({'field':field,'before':old,'after':value,'percent':str(pct) if pct is not None else None,'significant':significant})
    return changes
