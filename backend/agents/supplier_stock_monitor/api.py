import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import List,Optional,Literal
from fastapi import APIRouter,Depends,HTTPException,Request,Query
from fastapi.routing import APIRoute
from fastapi.responses import FileResponse,JSONResponse
from pydantic import Field
from starlette.datastructures import UploadFile
from agents.supplier_discovery.api import admin
from agents.supplier_catalog_intake.parsers import check_file
from .models import Strict,Settings,Enquiry,Incoming,Extracted
from .storage import connection,settings,required,decoded,dump,now,audit,folder
from .domain import eligibility,inventory,sync_watch,freshness,email,timestamp,iso
from . import communications,workflow,mail,ai,extraction


class SafeRoute(APIRoute):
    def get_route_handler(self):
        original=super().get_route_handler()
        async def handle(request):
            try:return await original(request)
            except ValueError as exc:raise HTTPException(409,str(exc)[:1500])
            except sqlite3.IntegrityError:raise HTTPException(409,'Conflicting or repeated operation; refresh the record')
            except sqlite3.OperationalError:raise HTTPException(503,'Stock monitoring storage is temporarily busy or unavailable; retry this request')
        return handle


router=APIRouter(prefix='/api/v1/stock',dependencies=[Depends(admin)],route_class=SafeRoute)
webhooks=APIRouter(prefix='/api/v1/stock-hooks',route_class=SafeRoute)


@router.get('/options')
def options():
    with connection() as conn:
        sync_watch(conn)
        suppliers=[]
        for row in conn.execute('SELECT id,name FROM vendors ORDER BY name'):
            suppliers.append({**dict(row),'eligibility':eligibility(conn,row['id']),
                'contacts':[dict(c) for c in conn.execute('SELECT id,name,email,confirmed,do_not_contact FROM stock_contacts WHERE vendor_id=?',(row['id'],))]})
        records=[]
        for row in conn.execute('SELECT id FROM stock_watch ORDER BY id LIMIT 2000'):
            record=inventory(conn,row[0]);records.append({'id':record['id'],'vendor_id':record['vendor_id'],'ref':record['ref'],'freshness':freshness(conn,record)})
        threads=[dict(r) for r in conn.execute('SELECT r.id,r.thread_token,c.email sender,v.name supplier FROM stock_requests r JOIN stock_contacts c ON c.id=r.contact_id JOIN vendors v ON v.id=r.vendor_id ORDER BY r.created_at DESC LIMIT 100')]
    return {'suppliers':suppliers,'inventory':records,'threads':threads,'extraction_fields':list(Extracted.model_fields)}


@router.get('/summary')
def summary():
    with connection() as conn:
        sync_watch(conn)
        states={r[0]:r[1] for r in conn.execute('SELECT freshness,count(*) FROM stock_inventory_freshness GROUP BY freshness')}
        counts={
         'monitored_suppliers':conn.execute('SELECT count(*) FROM stock_policies WHERE enabled=1').fetchone()[0],
         'fresh':states.get('Fresh',0),'stale':states.get('Stale',0)+states.get('Expired',0),
         'pending_enquiries':conn.execute("SELECT count(*) FROM stock_messages WHERE direction='outgoing' AND status='Draft'").fetchone()[0],
         'awaiting_replies':conn.execute("SELECT count(*) FROM stock_requests WHERE status='Awaiting Reply'").fetchone()[0],
         'overdue':conn.execute("SELECT count(*) FROM stock_requests WHERE status='Awaiting Reply' AND COALESCE(response_due_at,next_followup_at)<=?",(now(),)).fetchone()[0],
         'unprocessed_replies':conn.execute("SELECT count(*) FROM stock_jobs WHERE status IN ('Received','Queued','Processing')").fetchone()[0],
         'pending_changes':conn.execute("SELECT count(*) FROM stock_proposals WHERE status='Pending'").fetchone()[0],
         'approved_updates':conn.execute("SELECT count(*) FROM stock_proposals WHERE status='Approved' AND reviewed_at>=datetime('now','-30 days')").fetchone()[0],
         'failed_jobs':conn.execute("SELECT count(*) FROM stock_jobs WHERE status='Failed'").fetchone()[0]}
        activity=[decoded(r) for r in conn.execute('SELECT * FROM stock_audit ORDER BY id DESC LIMIT 10')]
        active=conn.execute("SELECT count(*) FROM stock_jobs WHERE status IN ('Queued','Processing')").fetchone()[0]
        return {'counts':counts,'freshness':states,'activity':activity,'active':active,'email':mail.config(),'ai':ai.configuration(),
                'settings':settings(conn).model_dump(mode='json'),'status':'Paused' if settings(conn).paused else 'Processing' if active else 'Ready'}


@router.get('/suppliers')
def suppliers(q:str='',page:int=Query(1,ge=1)):
    with connection() as conn:
        rows=conn.execute('SELECT v.*,p.enabled,p.excluded,p.opted_out,p.fresh_days,p.contact_days,p.template FROM vendors v LEFT JOIN stock_policies p ON p.vendor_id=v.id WHERE v.name LIKE ? ORDER BY v.name LIMIT 20 OFFSET ?',('%'+q[:150]+'%',(page-1)*20)).fetchall()
        result=[]
        for row in rows:
            vendor=dict(row);vendor['eligibility']=eligibility(conn,row['id'])
            vendor['contacts']=[dict(c) for c in conn.execute('SELECT * FROM stock_contacts WHERE vendor_id=?',(row['id'],))]
            stats=dict(conn.execute("SELECT count(*) requests,sum(reply_at IS NOT NULL) responses,avg((julianday(reply_at)-julianday(last_sent_at))*24) response_hours,max(reply_at) last_response,max(last_sent_at) last_contact,sum(followup_count) followups FROM stock_requests WHERE vendor_id=?",(row['id'],)).fetchone())
            stats['response_rate']=round((stats['responses'] or 0)/stats['requests']*100,1) if stats['requests'] else None
            stats['confirmations']=conn.execute('SELECT count(*) FROM stock_events e JOIN stock_watch w ON w.id=e.watch_id WHERE w.vendor_id=?',(row['id'],)).fetchone()[0]
            stats['conflicts']=conn.execute("SELECT count(*) FROM stock_proposals p JOIN stock_messages m ON m.id=p.message_id WHERE m.vendor_id=? AND p.errors<>'[]'",(row['id'],)).fetchone()[0]
            stats['incomplete']=conn.execute("SELECT count(*) FROM stock_proposals p JOIN stock_messages m ON m.id=p.message_id WHERE m.vendor_id=? AND p.warnings<>'[]'",(row['id'],)).fetchone()[0]
            vendor['metrics']=stats;result.append(vendor)
        total=conn.execute('SELECT count(*) FROM vendors WHERE name LIKE ?',('%'+q[:150]+'%',)).fetchone()[0]
    return {'rows':result,'total':total}


class Policy(Strict):
    enabled:bool
    excluded:bool=False
    opted_out:bool=False
    fresh_days:Optional[int]=Field(None,ge=1,le=365)
    contact_days:Optional[int]=Field(None,ge=1,le=365)
    template:Optional[str]=Field(None,max_length=2000)
    note:str=Field(min_length=3,max_length=1000)


@router.post('/suppliers/{vendor_id}/policy')
def policy(vendor_id:int,body:Policy,user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');required(conn,'vendors',vendor_id)
        if body.template:mail.disclosure_check(conn,'',body.template)
        previous=conn.execute('SELECT * FROM stock_policies WHERE vendor_id=?',(vendor_id,)).fetchone()
        if conn.execute("SELECT 1 FROM stock_messages WHERE vendor_id=? AND status='Dispatching'",(vendor_id,)).fetchone():raise ValueError('Dispatch is in flight; wait for reconciliation before changing the monitoring policy')
        if previous and previous['opted_out'] and not body.opted_out:raise ValueError('Supplier opt-out cannot be cleared through monitoring settings; documented re-consent is required')
        conn.execute('INSERT INTO stock_policies VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(vendor_id) DO UPDATE SET enabled=excluded.enabled,excluded=excluded.excluded,opted_out=excluded.opted_out,fresh_days=excluded.fresh_days,contact_days=excluded.contact_days,template=excluded.template,updated_at=excluded.updated_at',
                     (vendor_id,int(body.enabled),int(body.excluded),int(body.opted_out),body.fresh_days,body.contact_days,body.template,now()))
        if body.opted_out or body.excluded:
            conn.execute("UPDATE stock_requests SET status='Cancelled',next_followup_at=NULL WHERE vendor_id=? AND status NOT IN ('Closed','Completed','Declined')",(vendor_id,))
            conn.execute("UPDATE stock_messages SET status='Cancelled' WHERE vendor_id=? AND direction='outgoing' AND status IN ('Draft','Approved')",(vendor_id,))
        sync_watch(conn);audit(conn,user['id'],'Monitoring policy updated',{'vendor_id':vendor_id,**body.model_dump()})
    return {'ok':True}


class Contact(Strict):
    name:str=Field(min_length=1,max_length=150)
    email:str=Field(max_length=320)
    confirmed:bool=False
    do_not_contact:bool=False
    reference:str=Field(min_length=3,max_length=1000)


@router.post('/suppliers/{vendor_id}/contacts')
def contact(vendor_id:int,body:Contact,user=Depends(admin)):
    address=email(body.email)
    with connection() as conn:
        required(conn,'vendors',vendor_id)
        previous=conn.execute('SELECT do_not_contact FROM stock_contacts WHERE vendor_id=? AND email=?',(vendor_id,address)).fetchone()
        if previous and previous[0] and not body.do_not_contact:raise ValueError('Do-not-contact flag requires documented supplier re-consent before it can be cleared')
        conn.execute('INSERT INTO stock_contacts(vendor_id,name,email,confirmed,do_not_contact,reference,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vendor_id,email) DO UPDATE SET name=excluded.name,confirmed=excluded.confirmed,do_not_contact=excluded.do_not_contact,reference=excluded.reference',
          (vendor_id,body.name,address,int(body.confirmed),int(body.do_not_contact),body.reference,now()))
        audit(conn,user['id'],'Supplier contact recorded',{'vendor_id':vendor_id,'confirmed':body.confirmed,'reference':body.reference})
    return {'ok':True}


@router.get('/inventory')
def watched(vendor:Optional[int]=None,q:str='',state:str='',page:int=Query(1,ge=1)):
    with connection() as conn:
        sync_watch(conn);result=[]
        for row in conn.execute('SELECT id FROM stock_watch WHERE (? IS NULL OR vendor_id=?) ORDER BY id',(vendor,vendor)):
            item=inventory(conn,row[0]);item['freshness']=freshness(conn,item)
            item['supplier']=conn.execute('SELECT name FROM vendors WHERE id=?',(item['vendor_id'],)).fetchone()[0]
            if q.lower() not in (item['ref']+' '+item['supplier']+' '+str(item['data'].get('name',''))).lower():continue
            if state and item['freshness']['state']!=state:continue
            item.pop('base_version',None);item.pop('base_version_current',None);item.pop('version',None);result.append(item)
    return {'rows':result[(page-1)*20:page*20],'total':len(result)}


class ProductPolicy(Strict):
    fresh_days:Optional[int]=Field(None,ge=1,le=365)
    note:str=Field(min_length=3,max_length=1000)


@router.post('/inventory/{watch_id}/policy')
def product_policy(watch_id:int,body:ProductPolicy,user=Depends(admin)):
    with connection() as conn:
        required(conn,'stock_watch',watch_id);conn.execute('UPDATE stock_watch SET fresh_days=? WHERE id=?',(body.fresh_days,watch_id))
        audit(conn,user['id'],'Product freshness policy updated',{'watch_id':watch_id,**body.model_dump()})
    return {'ok':True}


@router.post('/requests')
def create_request(body:Enquiry,user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');return communications.create_request(conn,body,user['id'])


@router.get('/requests')
def requests(q:str='',status:str='',page:int=Query(1,ge=1)):
    with connection() as conn:
        where=" WHERE (v.name LIKE ? OR r.request_type LIKE ?) AND (?='' OR r.status=?)"
        args=['%'+q[:100]+'%']*2+[status,status]
        rows=conn.execute('SELECT r.*,v.name supplier,c.email contact_email FROM stock_requests r JOIN vendors v ON v.id=r.vendor_id JOIN stock_contacts c ON c.id=r.contact_id'+where+' ORDER BY r.created_at DESC LIMIT 20 OFFSET ?',args+[(page-1)*20]).fetchall()
        total=conn.execute('SELECT count(*) FROM stock_requests r JOIN vendors v ON v.id=r.vendor_id'+where,args).fetchone()[0]
        result=[]
        for row in rows:
            request=decoded(row);request['messages']=[decoded(m) for m in conn.execute('SELECT * FROM stock_messages WHERE request_id=? ORDER BY id',(row['id'],))];result.append(request)
    return {'rows':result,'total':total}


class RequestAction(Strict):
    action:Literal['close','cancel','schedule']
    version:int
    note:str=Field(min_length=3,max_length=1000)
    next_followup_at:Optional[str]=None


@router.post('/requests/{request_id}/action')
def request_action(request_id:str,body:RequestAction,user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');row=required(conn,'stock_requests',request_id)
        if row['version']!=body.version:raise ValueError('Request changed; refresh first')
        if conn.execute("SELECT 1 FROM stock_messages WHERE request_id=? AND status='Dispatching'",(request_id,)).fetchone():raise ValueError('Dispatch is in flight; reconcile before closing or cancelling')
        if body.action=='schedule':
            if row['status']!='Awaiting Reply' or row['reply_at']:raise ValueError('Only unanswered requests can schedule follow-ups')
            if not body.next_followup_at or timestamp(body.next_followup_at)<=timestamp(now()):raise ValueError('Choose a future follow-up time')
            value=timestamp(body.next_followup_at)
            import datetime as dt
            if settings(conn).skip_weekends and value.astimezone(dt.timezone(dt.timedelta(hours=5))).weekday()>4:raise ValueError('Weekend follow-ups are disabled')
            conn.execute('UPDATE stock_requests SET next_followup_at=?,version=version+1 WHERE id=?',(iso(value),request_id))
        else:
            conn.execute('UPDATE stock_requests SET status=?,closed_at=?,note=?,next_followup_at=NULL,version=version+1 WHERE id=?',('Closed' if body.action=='close' else 'Cancelled',now(),body.note,request_id))
            conn.execute("UPDATE stock_messages SET status='Cancelled' WHERE request_id=? AND direction='outgoing' AND status IN ('Draft','Approved')",(request_id,))
            conn.execute("UPDATE stock_proposals SET status='Cancelled',reviewed_by=?,reviewed_at=?,review_note=?,version=version+1 WHERE status='Pending' AND message_id IN (SELECT id FROM stock_messages WHERE request_id=?)",(user['id'],now(),body.note,request_id))
        audit(conn,user['id'],'Request '+body.action,body.model_dump(),request_id)
    return {'ok':True}


class DraftAction(Strict):
    action:Literal['edit','approve','reject','cancel','dispatch']
    version:int
    subject:Optional[str]=Field(None,max_length=300)
    body:Optional[str]=Field(None,max_length=10000)
    note:str=Field(min_length=3,max_length=1000)
    live_authorization:Optional[str]=None


@router.post('/messages/{message_id}/review')
def draft_review(message_id:int,body:DraftAction,user=Depends(admin)):
    if body.action=='dispatch':return communications.dispatch(message_id,user['id'],body.version,body.live_authorization)
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');message=required(conn,'stock_messages',message_id)
        if message['direction']!='outgoing' or message['status'] not in ('Draft','Approved'):raise ValueError('Only unsent drafts can be reviewed')
        if message['version']!=body.version:raise ValueError('Draft changed; refresh first')
        if body.action=='edit':
            if not body.subject or not body.body:raise ValueError('Subject and body are required')
            mail.safe_header(body.subject);mail.disclosure_check(conn,body.subject,body.body)
            conn.execute("UPDATE stock_messages SET subject=?,body=?,status='Draft',approved_by=NULL,approved_at=NULL,version=version+1 WHERE id=?",(body.subject,body.body,message_id))
        else:
            status={'approve':'Approved','reject':'Rejected','cancel':'Cancelled'}[body.action]
            conn.execute('UPDATE stock_messages SET status=?,approved_by=?,approved_at=?,version=version+1 WHERE id=?',(status,user['id'] if status=='Approved' else None,now(),message_id))
        audit(conn,user['id'],'Email '+body.action,{'note':body.note},message['request_id'],message_id)
    return {'ok':True}


@router.get('/messages')
def messages(q:str='',status:str='',page:int=Query(1,ge=1)):
    with connection() as conn:
        where=" WHERE (m.subject LIKE ? OR m.sender LIKE ?) AND (?='' OR m.status=?)"
        args=['%'+q[:100]+'%']*2+[status,status]
        rows=conn.execute('SELECT m.*,v.name supplier FROM stock_messages m LEFT JOIN vendors v ON v.id=m.vendor_id'+where+' ORDER BY m.id DESC LIMIT 20 OFFSET ?',args+[(page-1)*20]).fetchall()
        result=[]
        for row in rows:
            message=decoded(row);message['attachments']=[decoded(a) for a in conn.execute('SELECT * FROM stock_attachments WHERE message_id=?',(row['id'],))];result.append(message)
        total=conn.execute('SELECT count(*) FROM stock_messages m'+where,args).fetchone()[0]
    return {'rows':result,'total':total}


@router.get('/messages/{message_id}')
def message_detail(message_id:int):
    with connection() as conn:
        message=decoded(required(conn,'stock_messages',message_id))
        message['parsed_text']=extraction.clean_text(message['body'],message.get('html'))
        message['attachments']=[decoded(a) for a in conn.execute('SELECT * FROM stock_attachments WHERE message_id=?',(message_id,))]
        message['thread']=[decoded(m) for m in conn.execute('SELECT * FROM stock_messages WHERE request_id=? ORDER BY id',(message['request_id'],))]
        message['proposals']=[decoded(p) for p in conn.execute('SELECT * FROM stock_proposals WHERE message_id=?',(message_id,))]
        return message


@router.get('/messages/{message_id}/outbox')
def outbox(message_id:int):
    with connection() as conn:message=required(conn,'stock_messages',message_id)
    if message['status']!='Mock Sent' or not message['outbox_file']:raise HTTPException(404,'Local outbox file not available')
    return FileResponse(folder('outbox')/message['outbox_file'],filename=f'stock-message-{message_id}.eml',media_type='message/rfc822')


@router.post('/inbound/simulate')
def simulate(body:Incoming,user=Depends(admin)):
    if mail.config()['mode']!='mock':raise ValueError('Simulated replies are available only in mock mode')
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');return communications.ingest(conn,body,user['id'],True)


class Release(Strict):
    request_id:str
    authentication_reference:str=Field(min_length=10,max_length=1000)


@router.post('/messages/{message_id}/release')
def release(message_id:int,body:Release,user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');message=required(conn,'stock_messages',message_id);request=required(conn,'stock_requests',body.request_id);contact=required(conn,'stock_contacts',request['contact_id'])
        if message['status']!='Quarantined' or message['sender']!=contact['email'] or eligibility(conn,request['vendor_id'],contact['id']):raise ValueError('A matching confirmed contact and eligible supplier are required')
        conn.execute("UPDATE stock_messages SET request_id=?,vendor_id=?,contact_id=?,status='Received',extraction_status='Received',version=version+1 WHERE id=?",(request['id'],request['vendor_id'],contact['id'],message_id))
        conn.execute("UPDATE stock_requests SET status='Reply Pending',reply_at=?,next_followup_at=NULL WHERE id=?",(now(),request['id']))
        conn.execute("INSERT INTO stock_jobs(message_id,status,created_at,updated_at) VALUES(?,'Received',?,?)",(message_id,now(),now()))
        audit(conn,user['id'],'Quarantine manually associated',{'authentication_reference':body.authentication_reference},request['id'],message_id)
    return {'ok':True}


@router.post('/messages/{message_id}/attachments')
async def attachment(message_id:int,request:Request,user=Depends(admin)):
    with connection() as conn:
        message=required(conn,'stock_messages',message_id);config=settings(conn)
        job=conn.execute('SELECT status FROM stock_jobs WHERE message_id=?',(message_id,)).fetchone()
        if message['direction']!='incoming' or (job and job[0] not in ('Received','Failed')):raise ValueError('Add attachments before queuing reply processing')
        if conn.execute('SELECT count(*) FROM stock_attachments WHERE message_id=?',(message_id,)).fetchone()[0]>=4:raise ValueError('Maximum four attachments per reply')
    form=await request.form(max_files=1,max_fields=0,max_part_size=2048);file=form.get('file')
    if not isinstance(file,UploadFile):raise ValueError('Choose one XLSX/CSV/PDF attachment')
    data=await file.read(config.attachment_mb*1024*1024+1);await file.close()
    if len(data)>config.attachment_mb*1024*1024:raise HTTPException(413,'Attachment exceeds configured limit')
    name=Path((file.filename or '').replace('\\','/')).name[:150];kind=check_file(name,data);digest=hashlib.sha256(data).hexdigest();stored=digest+'.'+kind;target=folder('attachments')/stored
    if not target.exists():target.write_bytes(data)
    scan='Unavailable: scanner not installed';scanner=shutil.which('clamscan')
    if scanner:
        try:
            result=subprocess.run([scanner,'--no-summary',str(target)],capture_output=True,timeout=20)
            if result.returncode==1:raise ValueError('Malware detected; attachment rejected')
            if result.returncode!=0:raise ValueError('Malware scanner failed; attachment rejected')
            scan='Clean'
        except subprocess.TimeoutExpired:raise ValueError('Malware scanner timed out')
    elif os.getenv('STOCK_REQUIRE_MALWARE_SCAN')=='true':raise ValueError('A malware scanner is required but unavailable')
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        # A retention pass may have removed an older reference while this upload
        # was being scanned. Restore the exact already-checked bytes under lock.
        if not target.exists():target.write_bytes(data)
        conn.execute('INSERT OR IGNORE INTO stock_attachments(message_id,name,kind,sha256,size,stored_name,status,scan_status,created_at) VALUES(?,?,?,?,?,?,\'Stored\',?,?)',(message_id,name,kind,digest,len(data),stored,scan,now()))
        audit(conn,user['id'],'Attachment captured',{'sha256':digest,'size':len(data),'scan':scan},message['request_id'],message_id)
    return {'ok':True,'sha256':digest,'scan_status':scan}


@router.get('/attachments/{attachment_id}')
def download_attachment(attachment_id:int):
    with connection() as conn:attachment=required(conn,'stock_attachments',attachment_id)
    if attachment['status']=='Deleted':raise HTTPException(410,'Attachment removed under retention policy; source hash and audit retained')
    return FileResponse(folder('attachments')/attachment['stored_name'],filename=attachment['name'],media_type='application/octet-stream',headers={'X-Content-Type-Options':'nosniff'})


@router.post('/messages/{message_id}/process')
def process(message_id:int,user=Depends(admin)):
    with connection() as conn:
        job=conn.execute('SELECT * FROM stock_jobs WHERE message_id=?',(message_id,)).fetchone()
        if not job or job['status'] not in ('Received','Failed') or job['attempts']>=3:raise ValueError('Reply is quarantined, already processed/active or has exhausted retries')
        if conn.execute('SELECT 1 FROM stock_proposals WHERE message_id=?',(message_id,)).fetchone():raise ValueError('Existing review decisions prevent reprocessing')
        conn.execute("UPDATE stock_jobs SET status='Queued',stage='Queued',error=NULL WHERE id=?",(job['id'],));audit(conn,user['id'],'Reply processing queued',{'job_id':job['id']},message=message_id)
    return {'job_id':job['id']}


@router.get('/proposals')
def proposals(q:str='',status:str='',page:int=Query(1,ge=1)):
    with connection() as conn:
        where=" WHERE (p.product_ref LIKE ? OR v.name LIKE ?) AND (?='' OR p.status=?)"
        args=['%'+q[:100]+'%']*2+[status,status]
        base=' FROM stock_proposals p JOIN stock_messages m ON m.id=p.message_id JOIN vendors v ON v.id=m.vendor_id'
        rows=conn.execute('SELECT p.*,v.name supplier'+base+where+' ORDER BY p.id DESC LIMIT 20 OFFSET ?',args+[(page-1)*20]).fetchall()
        total=conn.execute('SELECT count(*)'+base+where,args).fetchone()[0]
    return {'rows':[decoded(p) for p in rows],'total':total}


class ProposalReview(Strict):
    action:Literal['approve','reject','correct','clarify','match']
    version:int
    fields:List[str]=Field(default_factory=list,max_length=30)
    corrected:Optional[Extracted]=None
    quote:Optional[str]=Field(None,max_length=5000)
    note:str=Field(min_length=3,max_length=1000)
    watch_id:Optional[int]=None
    fx_acknowledged:bool=False


@router.post('/proposals/{proposal_id}/review')
def proposal_review(proposal_id:int,body:ProposalReview,user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE');proposal=required(conn,'stock_proposals',proposal_id)
        if body.action=='approve':return workflow.approve_proposal(conn,proposal_id,body.fields,user['id'],body.version,body.note,body.fx_acknowledged)
        if proposal['status']!='Pending' or proposal['version']!=body.version:raise ValueError('Proposal changed or already reviewed')
        message=required(conn,'stock_messages',proposal['message_id']);request=required(conn,'stock_requests',message['request_id'])
        if body.action=='reject':conn.execute("UPDATE stock_proposals SET status='Rejected',reviewed_by=?,reviewed_at=?,review_note=?,version=version+1 WHERE id=?",(user['id'],now(),body.note,proposal_id))
        elif body.action=='clarify':communications.add_draft(conn,request,user['id'],clarification=body.note)
        elif body.action=='match':
            if not body.watch_id or inventory(conn,body.watch_id)['vendor_id']!=message['vendor_id']:raise ValueError('Choose existing inventory from this supplier')
            record=inventory(conn,body.watch_id);data=json.loads(proposal['proposed']);clean,errors,warnings=extraction.validate_record({'data':data,'evidence':json.loads(proposal['evidence'])},record['data'])
            conn.execute('UPDATE stock_proposals SET watch_id=?,before_data=?,baseline=?,proposed=?,errors=?,warnings=?,changes=?,version=version+1 WHERE id=?',
                         (body.watch_id,dump(record['data']),record['version'],dump(clean),dump(errors),dump(warnings),dump(workflow.compare(record['data'],clean,settings(conn))),proposal_id))
        else:
            if not body.corrected or not body.quote:raise ValueError('Corrected fields require an exact source quote')
            text=extraction.clean_text(message['body'],message['html'])
            if body.quote not in text:raise ValueError('Correction quote is absent from current supplier message')
            corrected=body.corrected.model_dump(mode='json',exclude_none=True)
            for f,v in corrected.items():
                if f not in ('product_ref','availability') and str(v).casefold() not in body.quote.casefold():raise ValueError('Corrected value lacks literal source support')
            before=inventory(conn,proposal['watch_id'])['data'] if proposal['watch_id'] else {}
            evidence={f:{'quote':body.quote,'location':'Admin reviewed current message','method':'Admin correction'} for f in corrected}
            clean,errors,warnings=extraction.validate_record({'data':corrected,'evidence':evidence},before)
            if corrected.get('availability')!=extraction.classify(body.quote):raise ValueError('Availability classification conflicts with source wording')
            conn.execute('UPDATE stock_proposals SET proposed=?,evidence=?,errors=?,warnings=?,changes=?,version=version+1 WHERE id=?',
                         (dump(clean),dump(evidence),dump(errors),dump(warnings),dump(workflow.compare(before,clean,settings(conn))),proposal_id))
        audit(conn,user['id'],'Proposal '+body.action,{'note':body.note},request['id'],message['id'],proposal_id)
    return {'ok':True}


@router.get('/followups')
def followup_list(page:int=Query(1,ge=1)):
    with connection() as conn:
        rows=[decoded(r) for r in conn.execute('SELECT m.*,v.name supplier,r.next_followup_at FROM stock_messages m JOIN stock_requests r ON r.id=m.request_id JOIN vendors v ON v.id=m.vendor_id WHERE m.followup_number>0 ORDER BY m.id DESC LIMIT 20 OFFSET ?',((page-1)*20,))]
        scheduled=[dict(r) for r in conn.execute("SELECT r.id,r.vendor_id,v.name supplier,r.next_followup_at,r.followup_count,r.version FROM stock_requests r JOIN vendors v ON v.id=r.vendor_id WHERE r.next_followup_at IS NOT NULL ORDER BY r.next_followup_at LIMIT 100")]
        total=conn.execute('SELECT count(*) FROM stock_messages WHERE followup_number>0').fetchone()[0]
    return {'rows':rows,'scheduled':scheduled,'total':total}


@router.post('/tick')
def tick(user=Depends(admin)):
    workflow.tick()
    with connection() as conn:audit(conn,user['id'],'Manual monitoring cycle',{})
    return {'ok':True}


@router.get('/activity')
def activity(page:int=Query(1,ge=1)):
    with connection() as conn:
        jobs=[dict(r) for r in conn.execute('SELECT * FROM stock_jobs ORDER BY id DESC LIMIT 20 OFFSET ?',((page-1)*20,))]
        history=[decoded(r) for r in conn.execute('SELECT * FROM stock_audit ORDER BY id DESC LIMIT 20 OFFSET ?',((page-1)*20,))]
        events=[decoded(r) for r in conn.execute('SELECT * FROM stock_events ORDER BY id DESC LIMIT 20')]
        usage=[dict(r) for r in conn.execute('SELECT * FROM stock_ai_usage ORDER BY id DESC LIMIT 20')]
        total=max(conn.execute('SELECT count(*) FROM stock_jobs').fetchone()[0],conn.execute('SELECT count(*) FROM stock_audit').fetchone()[0])
    return {'rows':jobs,'audit':history,'events':events,'ai_usage':usage,'total':total}


@router.post('/settings')
def configure(body:Settings,user=Depends(admin)):
    from agents.supplier_catalog_intake.normalization import taxonomy
    if body.expire_days<=body.fresh_days or body.warning_days>=body.fresh_days:raise ValueError('Expiry must follow freshness; warning window must be shorter')
    if body.second_followup_days<=body.first_followup_days:raise ValueError('Second follow-up must follow the first')
    if any(k not in dict(taxonomy()) or not 1<=v<=365 for k,v in body.category_days.items()):raise ValueError('Invalid existing category freshness policy')
    with connection() as conn:
        conn.execute('UPDATE stock_settings SET payload=? WHERE id=1',(body.model_dump_json(),));audit(conn,user['id'],'Stock settings updated',body.model_dump(mode='json'))
    return {'ok':True}


@router.post('/retention')
def retention(user=Depends(admin)):
    import datetime as dt
    removed=0
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        cutoff=iso(timestamp(now())-dt.timedelta(days=settings(conn).retention_days))
        for row in conn.execute("SELECT a.* FROM stock_attachments a WHERE a.created_at<? AND a.status<>'Deleted' AND NOT EXISTS(SELECT 1 FROM stock_jobs j WHERE j.message_id=a.message_id AND j.status IN ('Received','Queued','Processing')) AND NOT EXISTS(SELECT 1 FROM stock_proposals p WHERE p.message_id=a.message_id AND p.status='Pending')",(cutoff,)).fetchall():
            shared=conn.execute("SELECT 1 FROM stock_attachments WHERE stored_name=? AND id<>? AND status<>'Deleted'",(row['stored_name'],row['id'])).fetchone()
            target=(folder('attachments')/row['stored_name']).resolve()
            if target.parent!=folder('attachments').resolve():raise ValueError('Invalid attachment storage reference')
            if not shared:target.unlink(missing_ok=True)
            conn.execute("UPDATE stock_attachments SET status='Deleted',stored_name=NULL WHERE id=?",(row['id'],));removed+=1
        audit(conn,user['id'],'Attachment retention applied',{'removed':removed,'cutoff':cutoff})
    return {'removed':removed}


@webhooks.post('/resend')
async def webhook(request:Request):
    if not mail.config()['inbound_enabled']:raise HTTPException(503,'Live inbound integration is disabled')
    raw=await request.body()
    try:identifier=mail.verify_webhook(raw,request.headers)
    except ValueError:raise HTTPException(401,'Webhook authentication failed')
    event=json.loads(raw);kind=event.get('type','');provider_id=event.get('data',{}).get('email_id','')
    with connection() as conn:
        if conn.execute('SELECT 1 FROM stock_delivery_events WHERE id=?',(identifier,)).fetchone():return {'duplicate':True}
    if kind=='email.received':
        payload=Incoming.model_validate(await __import__('asyncio').to_thread(mail.ResendInbound().receive,event))
        with connection() as conn:
            conn.execute('BEGIN IMMEDIATE');result=communications.ingest(conn,payload,None,False)
            conn.execute('INSERT OR IGNORE INTO stock_delivery_events VALUES(?,?,?,?,?)',(identifier,provider_id,kind,now(),hashlib.sha256(raw).hexdigest()))
        return result
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute('INSERT OR IGNORE INTO stock_delivery_events VALUES(?,?,?,?,?)',(identifier,provider_id,kind,now(),hashlib.sha256(raw).hexdigest())).rowcount:return {'duplicate':True}
        statuses={'email.delivered':'Delivered','email.bounced':'Bounced','email.complained':'Complained','email.failed':'Delivery Failed'}
        message=conn.execute('SELECT * FROM stock_messages WHERE provider_id=?',(provider_id,)).fetchone()
        if message and kind in statuses:
            conn.execute('UPDATE stock_messages SET status=? WHERE id=?',(statuses[kind],message['id']))
            if kind in ('email.complained','email.bounced'):
                conn.execute('UPDATE stock_contacts SET do_not_contact=1 WHERE id=?',(message['contact_id'],))
                conn.execute("UPDATE stock_requests SET status='Delivery Failed',next_followup_at=NULL WHERE id=?",(message['request_id'],))
                conn.execute("UPDATE stock_messages SET status='Cancelled' WHERE request_id=? AND direction='outgoing' AND status IN ('Draft','Approved')",(message['request_id'],))
            audit(conn,None,'Provider delivery event',{'type':kind},message['request_id'],message['id'])
    return {'ok':True}


class StockBodyLimit:
    def __init__(self,app):self.app=app
    async def __call__(self,scope,receive,send):
        if scope['type']!='http' or not scope.get('path','').startswith(('/api/v1/stock/','/api/v1/stock-hooks/')) or scope.get('method')=='GET':return await self.app(scope,receive,send)
        limit=21*1024*1024 if scope.get('path','').endswith('/attachments') else 256*1024
        chunks=[];size=0
        while True:
            message=await receive()
            if message['type']=='http.disconnect':return
            size+=len(message.get('body',b''))
            if size>limit:return await JSONResponse({'detail':'Stock monitor request exceeds size limit'},status_code=413)(scope,receive,send)
            chunks.append(message.get('body',b''))
            if not message.get('more_body'):break
        delivered=False
        async def replay():
            nonlocal delivered
            if not delivered:delivered=True;return {'type':'http.request','body':b''.join(chunks),'more_body':False}
            return await receive()
        return await self.app(scope,replay,send)
