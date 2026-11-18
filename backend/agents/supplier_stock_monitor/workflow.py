import asyncio
import datetime as dt
import hashlib
import json
import re
from decimal import Decimal
from typing import TypedDict
from langgraph.graph import StateGraph,START,END
from agents.supplier_catalog_intake import parsers
from . import ai,extraction
from .models import Enquiry,Extracted
from .storage import connection,required,settings,now,dump,audit,folder
from .domain import inventory,sync_watch,eligibility,freshness,compare,timestamp
from .communications import add_draft,create_request,followups


class State(TypedDict,total=False):
    job:dict
    message:dict
    sources:list
    records:list
    warnings:list


def capture(state):
    message=state['message'];sources=[{'text':extraction.clean_text(message['body'],message['html']),'location':'Current unquoted email body','observed_at':message['created_at']}];warnings=[]
    with connection() as conn:attachments=[dict(r) for r in conn.execute('SELECT * FROM stock_attachments WHERE message_id=?',(message['id'],))]
    if message.get('html'):
        from bs4 import BeautifulSoup
        soup=BeautifulSoup(message['html'],'html.parser')
        for tag in soup(['blockquote','script','style']):tag.decompose()
        rows,_,_=parsers.parse_html(str(soup),'supplier-email',500)
        sources.extend({'text':item['source']['text'],'raw':item['raw'],'location':'Current email HTML table '+str(item['source'].get('table',1)),
                        'message_context':sources[0]['text'],'observed_at':message['created_at']} for item in rows)
    for attachment in attachments:
        if attachment['status']=='Deleted':continue
        try:
            content=(folder('attachments')/attachment['stored_name']).read_bytes()
            rows,notes,texts=parsers.parse(content,attachment['kind'],500)
            sources.extend({'text':item['source']['text'],'raw':item['raw'],'location':f"Attachment {attachment['id']}, "+dump(item['source']),'message_context':sources[0]['text'],'observed_at':message['created_at']} for item in rows)
            if not rows:sources.extend({'text':item['text'],'location':f"Attachment {attachment['id']}, page {item.get('page',1)}",'observed_at':message['created_at']} for item in texts)
            warnings.extend(notes)
            with connection() as conn:conn.execute("UPDATE stock_attachments SET status='Parsed' WHERE id=?",(attachment['id'],))
        except Exception:
            warnings.append(f"Attachment {attachment['id']} cannot be parsed reliably; manual review required")
            with connection() as conn:conn.execute("UPDATE stock_attachments SET status='Failed',error='Safe parsing failed; manual review required' WHERE id=?",(attachment['id'],))
    if len(sources)>50:warnings.append('More than 50 evidence rows/pages: remaining evidence requires a separate review; originals are retained')
    return {'sources':sources[:50],'warnings':warnings}


def extract_node(state):
    with connection() as conn:
        request=required(conn,'stock_requests',state['message']['request_id'])
        refs=[inventory(conn,i)['ref'] for i in json.loads(request['watch_ids'])]
    records=extraction.deterministic(state['sources'],refs)
    warnings=state['warnings'][:]
    if not records:
        records,error=ai.extract(state['job']['id'],state['sources'])
        if error:warnings.append(error)
    return {'records':records,'warnings':warnings}


def propose(state):
    message=state['message'];job=state['job'];text=state['sources'][0]['text'];config=settings()
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        request=required(conn,'stock_requests',message['request_id'])
        active=conn.execute('SELECT status,attempts FROM stock_jobs WHERE id=?',(job['id'],)).fetchone()
        if active[0]!='Processing' or active[1]!=job['attempts']:return {}
        if request['status'] in ('Closed','Cancelled','Declined','Completed'):
            conn.execute("UPDATE stock_jobs SET status='Cancelled',stage='Request closed',updated_at=? WHERE id=?",(now(),job['id']))
            conn.execute("UPDATE stock_messages SET extraction_status='Cancelled' WHERE id=?",(message['id'],))
            audit(conn,None,'Reply processing stopped for closed request',{},request['id'],message['id'])
            return {}
        if eligibility(conn,request['vendor_id'],request['contact_id']):raise ValueError('Supplier/contact is no longer eligible; review the conversation')
        if re.search(r'\b(unsubscribe|do not contact|stop emailing|opt.out)\b',text,re.I):
            conn.execute('UPDATE stock_policies SET opted_out=1 WHERE vendor_id=?',(request['vendor_id'],))
            conn.execute("UPDATE stock_requests SET status='Declined',next_followup_at=NULL WHERE vendor_id=? AND status NOT IN ('Closed','Cancelled')",(request['vendor_id'],))
            conn.execute("UPDATE stock_messages SET status='Cancelled' WHERE vendor_id=? AND direction='outgoing' AND status IN ('Draft','Approved')",(request['vendor_id'],))
            audit(conn,None,'Supplier opt-out recorded',{},request['id'],message['id'])
        elif re.search(r'\b(not interested|decline this request|cannot supply)\b',text,re.I):
            conn.execute("UPDATE stock_requests SET status='Declined',next_followup_at=NULL WHERE id=?",(request['id'],))
            audit(conn,None,'Supplier decline recorded',{},request['id'],message['id'])
        else:
            watched=[inventory(conn,i) for i in json.loads(request['watch_ids'])];seen=set();needs_clarification=bool(state['warnings'])
            for record in state['records']:
                ref=record['data']['product_ref']
                candidates=[w for w in watched if w['ref'].casefold()==ref.casefold()]
                target=candidates[0] if len(candidates)==1 else None
                before=target['data'] if target else {}
                clean,errors,warnings=extraction.validate_record(record,before)
                warnings+=state['warnings']
                if not target:errors.append('New or ambiguous product: use Agent #3 catalog intake or explicitly resolve the existing match')
                else:seen.add(target['id'])
                if clean.get('valid_until') and timestamp(clean['valid_until'])+dt.timedelta(days=1)<timestamp(now()):errors.append('Supplier quotation has expired')
                # Two independent sources in one message cannot silently overwrite each other.
                previous=conn.execute('SELECT * FROM stock_proposals WHERE message_id=? AND product_ref=?',(message['id'],ref)).fetchone()
                if previous:
                    previous_data=json.loads(previous['proposed'])
                    conflicts=[f for f,v in clean.items() if f in previous_data and previous_data[f]!=v and v not in (None,'Unknown') and previous_data[f] not in (None,'Unknown')]
                    merged={**previous_data,**{f:v for f,v in clean.items() if f not in previous_data or previous_data[f] in (None,'Unknown')}}
                    old_errors=json.loads(previous['errors'])+errors+(['Conflicting email/attachment fields: '+','.join(conflicts)] if conflicts else [])
                    conn.execute('UPDATE stock_proposals SET proposed=?,errors=?,warnings=? WHERE id=?',(dump(merged),dump(old_errors),dump(json.loads(previous['warnings'])+warnings),previous['id']))
                    needs_clarification=True
                    continue
                changes=compare(before,clean,config)
                conn.execute('INSERT INTO stock_proposals(message_id,watch_id,product_ref,before_data,proposed,evidence,warnings,errors,changes,baseline) VALUES(?,?,?,?,?,?,?,?,?,?)',
                 (message['id'],target['id'] if target else None,ref,dump(before),dump(clean),dump(record['evidence']),dump(warnings),dump(errors),dump(changes),target['version'] if target else ''))
                needs_clarification=needs_clarification or bool(errors or warnings)
            omitted=[w['ref'] for w in watched if w['id'] not in seen]
            if omitted:
                audit(conn,None,'Products omitted; existing values preserved',{'refs':omitted},request['id'],message['id'])
                needs_clarification=True
            conn.execute("UPDATE stock_requests SET status='Under Review',next_followup_at=NULL WHERE id=?",(request['id'],))
            if needs_clarification or not state['records']:
                add_draft(conn,request,None,clarification='Please confirm any missing prices, currencies, quantity units, omitted products or conflicting specifications. No missing value has been assumed.')
        conn.execute("UPDATE stock_jobs SET status='Completed',stage='Admin review',error=?,updated_at=? WHERE id=?",('; '.join(state['warnings'])[:1500] or None,now(),job['id']))
        conn.execute("UPDATE stock_messages SET extraction_status='Processed' WHERE id=?",(message['id'],))
        audit(conn,None,'Reply processed',{'extractions':len(state['records']),'warnings':state['warnings']},request['id'],message['id'])
    return {}


builder=StateGraph(State);builder.add_node('capture',capture);builder.add_node('extract',extract_node);builder.add_node('propose',propose)
builder.add_edge(START,'capture');builder.add_edge('capture','extract');builder.add_edge('extract','propose');builder.add_edge('propose',END)
graph=builder.compile()


async def run_job(job_id):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute("UPDATE stock_jobs SET status='Processing',stage='Source extraction',attempts=attempts+1,updated_at=? WHERE id=? AND status='Queued'",(now(),job_id)).rowcount:return
        job=required(conn,'stock_jobs',job_id);message=required(conn,'stock_messages',job['message_id'])
        conn.execute("UPDATE stock_messages SET extraction_status='Processing' WHERE id=?",(message['id'],))
    try:await asyncio.wait_for(graph.ainvoke({'job':job,'message':message}),120)
    except Exception as exc:
        message_text=ai.provider.safe_error(exc) if isinstance(exc,ValueError) else 'Reply processing failed or timed out; source preserved, operator retry available'
        with connection() as conn:
            conn.execute("UPDATE stock_jobs SET status='Failed',stage='Failed',error=?,updated_at=? WHERE id=?",(message_text[:1200],now(),job_id))
            conn.execute("UPDATE stock_messages SET extraction_status='Failed' WHERE id=?",(message['id'],))
            audit(conn,None,'Reply processing failed',{'job_id':job_id,'error':message_text[:1200]},message['request_id'],message['id'])


def recover():
    with connection() as conn:
        conn.execute("UPDATE stock_jobs SET status='Queued',stage='Recovered after restart' WHERE status='Processing'")
        conn.execute("UPDATE stock_messages SET status='Dispatch Uncertain',error='Restart interrupted dispatch; reconcile before any resend' WHERE status='Dispatching'")


def tick():
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');sync_watch(conn);config=settings(conn)
        if config.paused:return
        followups(conn)
        if config.automatic_drafts:
            for policy in conn.execute('SELECT vendor_id FROM stock_policies WHERE enabled=1 AND excluded=0 AND opted_out=0').fetchall():
                contact=conn.execute('SELECT id FROM stock_contacts WHERE vendor_id=? AND confirmed=1 AND do_not_contact=0 ORDER BY id LIMIT 1',(policy[0],)).fetchone()
                if not contact or eligibility(conn,policy[0],contact[0]):continue
                stale=[r[0] for r in conn.execute('SELECT id FROM stock_watch WHERE vendor_id=?',(policy[0],)).fetchall() if freshness(conn,inventory(conn,r[0]))['state'] in ('Stale','Expired','Awaiting supplier confirmation')]
                if stale:
                    actor=conn.execute("SELECT actor FROM stock_audit WHERE action='Monitoring policy updated' AND json_extract(detail,'$.vendor_id')=? AND actor IS NOT NULL ORDER BY id DESC LIMIT 1",(policy[0],)).fetchone()
                    if not actor:continue
                    try:create_request(conn,Enquiry(vendor_id=policy[0],contact_id=contact[0],watch_ids=stale[:30]),actor[0])
                    except ValueError:pass


async def worker():
    last_tick=0
    while True:
        if asyncio.get_running_loop().time()-last_tick>settings().monitor_interval_seconds:
            try:await asyncio.to_thread(tick)
            except Exception:
                with connection() as conn:audit(conn,None,'Monitoring cycle failed',{'error':'Monitoring cycle failed; inspect current configuration and database integrity'})
            last_tick=asyncio.get_running_loop().time()
        with connection() as conn:
            config=settings(conn)
            row=conn.execute("SELECT id FROM stock_jobs WHERE status='Queued' ORDER BY id LIMIT 1").fetchone() if not config.paused else None
        if row:await run_job(row[0])
        else:await asyncio.sleep(1)


def approve_proposal(conn,proposal_id,fields,actor,version,note,fx_ack=False):
    proposal=required(conn,'stock_proposals',proposal_id)
    if proposal['status']=='Approved':return {'status':'Approved','reused':True}
    if proposal['status']!='Pending' or proposal['version']!=version:raise ValueError('Proposal changed or is not pending')
    if not proposal['watch_id']:raise ValueError('Resolve inventory association through Agent #3 first')
    message=required(conn,'stock_messages',proposal['message_id']);request=required(conn,'stock_requests',message['request_id'])
    if request['status'] in ('Closed','Cancelled','Declined'):raise ValueError('The source request is closed or cancelled')
    if eligibility(conn,request['vendor_id'],request['contact_id']):raise ValueError('Supplier or contact is no longer eligible')
    current=inventory(conn,proposal['watch_id'])
    if current['version']!=proposal['baseline']:raise ValueError('Inventory changed since extraction; refresh and resolve the conflict')
    if current['source_message_id']:
        previous=required(conn,'stock_messages',current['source_message_id'])
        if timestamp(previous.get('source_at') or previous['created_at'])>timestamp(message.get('source_at') or message['created_at']):raise ValueError('A newer supplier confirmation already exists')
    proposed=json.loads(proposal['proposed']);Extracted.model_validate(proposed)
    errors=json.loads(proposal['errors'])
    if errors:raise ValueError('Resolve extraction errors before approval: '+'; '.join(errors))
    if not fields or len(fields)!=len(set(fields)) or any(f not in proposed or f=='product_ref' for f in fields):raise ValueError('Select explicit extracted fields')
    if 'quantity' in fields and ('quantity_unit' not in fields or proposed.get('availability') not in ('Confirmed','Unavailable') or 'availability' not in fields):
        raise ValueError('Quantity publication requires an explicit unit and current availability approval')
    if 'price' in fields and (not all(f in fields for f in ('currency','price_unit'))):raise ValueError('Price approval requires currency and pricing basis')
    if 'currency' in fields and proposed.get('currency')!=current['data'].get('currency') and 'price' not in fields:raise ValueError('Currency changes require a reviewed price; no implicit conversion')
    data=current['data'].copy();extra=json.loads(current['details']);original=data.copy()
    for f in fields:data[f]=proposed[f]
    for f in ('quantity_unit','form','grade','availability','available_from','terms','notes'):
        if f in fields:extra[f]=data[f]
    if 'price' in fields:extra['price_confirmed_at']=message.get('source_at') or message['created_at']
    if 'quantity' in fields:
        if current['item_id'] and data['quantity_unit']!='piece':raise ValueError('Ready-stock item quantities are pieces; unsupported units require catalog intake')
        if data['quantity_unit']=='piece' and Decimal(str(data['quantity']))%1:raise ValueError('Piece quantities must be whole numbers')
        if data['quantity_unit']!='piece':extra['quantity']=data['quantity']
        else:extra.pop('quantity',None)
    fx=None
    if current['item_id']:
        changes={}
        allowed={'price','currency','moq','lead_days','board','gsm','length_mm','width_mm','height_mm','valid_until'}
        for f in fields:
            if f in allowed:changes[f]=data[f]
        if 'quantity' in fields:changes['qty']=int(Decimal(str(data['quantity'])))
        if 'price' in fields:
            if data['price_unit']!='piece':raise ValueError('Ready-stock prices must be per piece')
            if data['currency']=='PKR':changes['price_pkr']=str(data['price'])
            else:
                row=conn.execute("SELECT value FROM settings WHERE key='fx_pkr_per_usd'").fetchone()
                if not row or not fx_ack:raise ValueError('USD ready-stock updates require the configured FX basis and explicit acknowledgement')
                fx=Decimal(row[0])
                if not fx.is_finite() or fx<=0:raise ValueError('Configured FX rate is invalid')
                changes['price_pkr']=str(Decimal(str(data['price']))*fx)
            changes['price_source']='vendor'
        if any(f in fields for f in ('gsm','board','length_mm','width_mm','height_mm','form')):
            raise ValueError('Ready-stock shipping/specification changes require the existing inventory import service to recompute freight; use Agent #3')
        if 'availability' in fields and data['availability']=='Unavailable':changes['status']='offline'
        if changes:
            conn.execute('UPDATE items SET '+','.join(f+'=?' for f in changes)+' WHERE id=?',list(changes.values())+[current['item_id']])
    else:
        row=required(conn,'catalog_products',current['catalog_id']);catalog=json.loads(row['data'])
        for f in fields:
            if f in catalog and f not in ('availability','quantity_unit'):catalog[f]=data[f]
        if 'quantity' in fields and data['quantity_unit']=='piece':catalog['qty']=int(Decimal(str(data['quantity'])))
        if 'availability' in fields:catalog['availability']='Unavailable' if data['availability']=='Unavailable' else 'Supplier reported stock' if data['availability']=='Confirmed' else 'Catalog only'
        source=json.loads(row['source']);source['stock_confirmation']={'message_id':message['id'],'proposal_id':proposal_id,'approved_by':actor,'at':now()}
        from agents.supplier_catalog_intake.normalization import identity,Product
        Product.model_validate(catalog)
        conn.execute('UPDATE catalog_products SET data=?,source=?,updated_at=?,identity=? WHERE id=?',(dump(catalog),dump(source),now(),identity(catalog),current['catalog_id']))
    confirmed=(message.get('source_at') or message['created_at']) if 'availability' in fields and data['availability']=='Confirmed' and ('quantity' in fields or current['last_confirmed_at']) else current['last_confirmed_at']
    if 'availability' in fields and data['availability']!='Confirmed':confirmed=None
    conn.execute('UPDATE stock_watch SET details=?,last_confirmed_at=?,source_message_id=? WHERE id=?',(dump(extra),confirmed,message['id'],current['id']))
    updated=inventory(conn,current['id'])
    conn.execute('UPDATE stock_watch SET base_version=? WHERE id=?',(updated['base_version_current'],current['id']))
    conn.execute("UPDATE stock_proposals SET status='Approved',approved_fields=?,reviewed_by=?,reviewed_at=?,review_note=?,version=version+1 WHERE id=?",(dump(fields),actor,now(),note,proposal_id))
    audit(conn,actor,'Inventory update approved',{'before':original,'after':updated['data'],'fields':fields,'fx_pkr_per_usd':str(fx) if fx else None,'source_id':message['source_id']},request['id'],message['id'],proposal_id)
    conn.execute("INSERT INTO stock_events(kind,watch_id,proposal_id,created_at,payload) VALUES('Inventory updated',?,?,?,?)",(current['id'],proposal_id,now(),dump({'fields':fields,'confirmed_at':confirmed})))
    if not conn.execute("SELECT 1 FROM stock_proposals p JOIN stock_messages m ON m.id=p.message_id WHERE m.request_id=? AND p.status='Pending'",(request['id'],)).fetchone() and not conn.execute("SELECT 1 FROM stock_messages WHERE request_id=? AND direction='outgoing' AND status IN ('Draft','Approved')",(request['id'],)).fetchone():
        conn.execute("UPDATE stock_requests SET status='Completed',next_followup_at=NULL WHERE id=?",(request['id'],))
    return {'status':'Approved','fields':fields}
