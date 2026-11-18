import datetime as dt
import hashlib
import json
import re
import uuid
from .storage import connection,required,settings,now,dump,audit
from .domain import eligibility,inventory,email,business_after,timestamp,freshness
from . import mail


def render(conn,request,followup=0,clarification=None):
    vendor=required(conn,'vendors',request['vendor_id']);contact=required(conn,'stock_contacts',request['contact_id'])
    refs=[]
    for wid in json.loads(request['watch_ids']):
        record=inventory(conn,wid)
        refs.append(f"- {record['ref']}: {record['data'].get('line','Packaging')} ({record['data'].get('length_mm') or '?'} × {record['data'].get('width_mm') or '?'} mm)")
    purpose=request['request_type']
    subject=('Follow-up: ' if followup else '')+purpose+' | Cardboard Package'
    body=f"Dear {contact['name']},\n\n"+('Following up on our previous enquiry. ' if followup else '')
    body+=f"Please help us confirm {purpose.lower()} for the following supplier products:\n"+'\n'.join(refs)
    body+='\n\nPlease provide current quantity and unit, price and currency per stated unit, MOQ, dispatch lead time and quotation validity. Leave any unconfirmed information clearly marked.'
    if clarification:body+='\n\nPlease clarify: '+clarification
    policy=conn.execute('SELECT template FROM stock_policies WHERE vendor_id=?',(request['vendor_id'],)).fetchone()
    if policy and policy['template']:body+='\n\n'+policy['template']
    body+='\n\nThank you,\nSupplier Operations\nCardboard Package'
    mail.disclosure_check(conn,subject,body)
    return subject,body


def add_draft(conn,request,actor,followup=0,clarification=None):
    contact=required(conn,'stock_contacts',request['contact_id'])
    subject,body=render(conn,request,followup,clarification)
    last=conn.execute("SELECT source_id FROM stock_messages WHERE request_id=? AND direction='incoming' AND status<>'Quarantined' ORDER BY id DESC LIMIT 1",(request['id'],)).fetchone()
    message=conn.execute('''INSERT INTO stock_messages(request_id,vendor_id,contact_id,direction,sender,recipient,subject,body,status,followup_number,created_at,reply_to_id)
      VALUES(?,?,?,'outgoing',?,?,?,?,'Draft',?,?,?)''',(request['id'],request['vendor_id'],contact['id'],mail.config()['from'],contact['email'],subject,body,followup,now(),last[0] if last else None)).lastrowid
    audit(conn,actor,'Draft prepared',{'type':request['request_type'],'followup':followup},request['id'],message)
    return message


def create_request(conn,payload,actor):
    reasons=eligibility(conn,payload.vendor_id,payload.contact_id)
    if reasons:raise ValueError('; '.join(reasons))
    ids=sorted(set(payload.watch_ids))
    if len(ids)!=len(payload.watch_ids):raise ValueError('Repeated inventory selection')
    for wid in ids:
        if inventory(conn,wid)['vendor_id']!=payload.vendor_id:raise ValueError('Inventory belongs to another supplier')
    # Prevent overlaps, even when a new request selects a different subset.
    for request in conn.execute("SELECT watch_ids FROM stock_requests WHERE vendor_id=? AND status NOT IN ('Closed','Completed','Cancelled','Declined')",(payload.vendor_id,)):
        if set(ids)&set(json.loads(request[0])):raise ValueError('An active request already covers this inventory')
    config=settings(conn);policy=conn.execute('SELECT contact_days FROM stock_policies WHERE vendor_id=?',(payload.vendor_id,)).fetchone()
    last=conn.execute('SELECT max(last_sent_at) FROM stock_requests WHERE vendor_id=?',(payload.vendor_id,)).fetchone()[0]
    if last and timestamp(now())-timestamp(last)<dt.timedelta(days=policy[0] or config.contact_days):raise ValueError('Supplier contact frequency limit is active')
    rid=uuid.uuid4().hex;token='CPST-'+uuid.uuid4().hex
    conn.execute('INSERT INTO stock_requests(id,vendor_id,contact_id,watch_ids,scope,request_type,thread_token,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      (rid,payload.vendor_id,payload.contact_id,dump(ids),hashlib.sha256(dump(ids).encode()).hexdigest(),payload.request_type,token,actor,now()))
    request=required(conn,'stock_requests',rid);message=add_draft(conn,request,actor)
    return {'id':rid,'message_id':message}


def dispatch(message_id,actor,version,live_authorization=None):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        message=required(conn,'stock_messages',message_id)
        if message['status'] in ('Mock Sent','Sent','Delivered'):return {'status':message['status'],'reused':True}
        if message['direction']!='outgoing' or message['status']!='Approved' or not message['approved_by']:raise ValueError('Individual Admin approval is required')
        if message['version']!=version:raise ValueError('Draft changed; refresh before dispatch')
        request=required(conn,'stock_requests',message['request_id'])
        if request['status'] in ('Closed','Completed','Cancelled','Declined'):raise ValueError('Request is closed')
        reasons=eligibility(conn,request['vendor_id'],request['contact_id'])
        if reasons:raise ValueError('; '.join(reasons))
        if message['followup_number'] and (request['reply_at'] or request['status']=='Reply Pending'):
            raise ValueError('A reply already exists; cancel this unanswered follow-up')
        contact=required(conn,'stock_contacts',request['contact_id'])
        if email(message['recipient'])!=contact['email']:raise ValueError('Recipient does not match the approved conversation contact')
        mail.disclosure_check(conn,message['subject'],message['body'])
        config=settings(conn)
        if not message['followup_number'] and not message.get('reply_to_id'):
            policy=conn.execute('SELECT contact_days FROM stock_policies WHERE vendor_id=?',(request['vendor_id'],)).fetchone()
            last=conn.execute("SELECT max(sent_at) FROM stock_messages WHERE vendor_id=? AND direction='outgoing' AND id<>?",(request['vendor_id'],message_id)).fetchone()[0]
            if last and timestamp(now())-timestamp(last)<dt.timedelta(days=(policy[0] if policy else None) or config.contact_days):
                raise ValueError('Supplier contact frequency limit blocks this new enquiry')
        count=conn.execute("SELECT count(*) FROM stock_messages WHERE direction='outgoing' AND (sent_at>=date('now') OR (status='Dispatching' AND created_at>=date('now')))",()).fetchone()[0]
        if count>=config.daily_limit:raise ValueError('Daily sending limit reached')
        if mail.config()['mode']!='mock' and (not mail.config()['live_ready'] or live_authorization!='SEND LIVE'):
            raise ValueError('Live delivery remains disabled')
        conn.execute("UPDATE stock_messages SET status='Dispatching',sent_at=?,version=version+1 WHERE id=?",(now(),message_id))
        audit(conn,actor,'Dispatch reserved',{'mode':mail.config()['mode']},request['id'],message_id)
    try:
        result=mail.MockOutbound().send(message,request['thread_token']) if mail.config()['mode']=='mock' else mail.ResendOutbound().send(message,request['thread_token'],live_authorization)
    except Exception:
        with connection() as conn:
            conn.execute("UPDATE stock_messages SET status='Dispatch Uncertain',error='Provider unavailable or dispatch interrupted; reconcile provider/outbox before any retry' WHERE id=?",(message_id,))
            audit(conn,actor,'Dispatch uncertain',{},request['id'],message_id)
        raise ValueError('Dispatch failed or uncertain; operator reconciliation is required. No automatic resend occurred')
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('UPDATE stock_messages SET status=?,provider_id=?,source_id=?,outbox_file=?,sent_at=?,error=NULL WHERE id=?',
                     (result['status'],result['id'],f'<stock-{message_id}@cardboardpackage.com>',result['outbox_file'],now(),message_id))
        next_days=config.first_followup_days if message['followup_number']==0 else config.second_followup_days
        next_at=business_after(request['last_sent_at'] or now(),next_days,config.skip_weekends)
        conn.execute("UPDATE stock_requests SET status='Awaiting Reply',last_sent_at=?,next_followup_at=?,followup_count=max(followup_count,?),version=version+1 WHERE id=?",(now(),next_at,message['followup_number'],request['id']))
        conn.execute('UPDATE stock_requests SET response_due_at=COALESCE(response_due_at,?) WHERE id=?',(business_after(now(),config.response_days,config.skip_weekends),request['id']))
        audit(conn,actor,'Mock outbox written' if result['status']=='Mock Sent' else 'Provider accepted',{'provider_id':result['id']},request['id'],message_id)
    return {'status':result['status'],'provider_id':result['id']}


def ingest(conn,payload,actor=None,simulated=True):
    existing=conn.execute('SELECT id,status FROM stock_messages WHERE source_id=?',(payload.source_id,)).fetchone()
    if existing:return {'id':existing[0],'status':existing[1],'duplicate':True}
    sender=email(payload.sender);recipient=email(payload.recipient)
    headers=' '.join([payload.in_reply_to or '',payload.references or ''])
    requests=set()
    for reference in headers.split():
        for row in conn.execute('SELECT request_id FROM stock_messages WHERE direction=\'outgoing\' AND (source_id=? OR provider_id=?)',(reference,reference)):
            requests.add(row[0])
    if payload.thread_token:
        row=conn.execute('SELECT id FROM stock_requests WHERE thread_token=?',(payload.thread_token,)).fetchone()
        if row:requests.add(row[0])
    # Replies do not necessarily preserve custom headers. An exact stored random
    # reference in quoted text is safe only together with the authenticated contact.
    for token in set(re.findall(r'\bCPST-[a-f0-9]{32}\b',payload.body+' '+(payload.html or ''))):
        row=conn.execute('SELECT id FROM stock_requests WHERE thread_token=?',(token,)).fetchone()
        if row:requests.add(row[0])
    request=required(conn,'stock_requests',next(iter(requests))) if len(requests)==1 else None
    contact=required(conn,'stock_contacts',request['contact_id']) if request else None
    trusted=bool(request and request['status'] not in ('Closed','Completed','Cancelled','Declined') and contact and contact['email']==sender and contact['confirmed'] and not contact['do_not_contact'] and payload.authenticated
                 and recipient in (email(mail.config()['from']),email(mail.config()['reply_to']))
                 and not eligibility(conn,request['vendor_id'],contact['id']))
    status='Received' if trusted else 'Quarantined'
    rid=request['id'] if trusted else None
    message=conn.execute('''INSERT INTO stock_messages(request_id,vendor_id,contact_id,direction,sender,recipient,subject,body,html,source_id,reply_to_id,references_header,status,created_at,extraction_status,source_hash,simulated)
      VALUES(?,?,?,'incoming',?,?,?,?,?,?,?,?,?,?,?, ?,?)''',(rid,request['vendor_id'] if trusted else None,contact['id'] if trusted else None,
      sender,recipient,mail.safe_header(payload.subject),payload.body,payload.html,payload.source_id,payload.in_reply_to,payload.references,status,now(),
      ('Queued' if payload.process_now else 'Received') if trusted else 'Quarantined',hashlib.sha256((payload.body+(payload.html or '')).encode()).hexdigest(),int(simulated))).lastrowid
    if trusted:
        if payload.source_at:
            source_time=timestamp(payload.source_at)
            if source_time>timestamp(now())+dt.timedelta(minutes=5):raise ValueError('Supplier message timestamp cannot be in the future')
            conn.execute('UPDATE stock_messages SET source_at=? WHERE id=?',(source_time.isoformat().replace('+00:00','Z'),message))
        conn.execute("UPDATE stock_requests SET status='Reply Pending',reply_at=?,next_followup_at=NULL,version=version+1 WHERE id=?",(now(),rid))
        conn.execute("UPDATE stock_messages SET status='Cancelled' WHERE request_id=? AND direction='outgoing' AND followup_number>0 AND status IN ('Draft','Approved')",(rid,))
        conn.execute('INSERT INTO stock_jobs(message_id,status,created_at,updated_at) VALUES(?,?,?,?)',(message,'Queued' if payload.process_now else 'Received',now(),now()))
    audit(conn,actor,'Simulated inbound' if simulated else 'Authenticated inbound',{'status':status,'correlation':'headers/token + exact verified contact' if trusted else 'Ambiguous thread, unauthenticated or unknown sender'},rid,message)
    return {'id':message,'status':status,'duplicate':False}


def followups(conn,at=None):
    at=at or now();config=settings(conn);created=[]
    for row in conn.execute("SELECT * FROM stock_requests WHERE status='Awaiting Reply' AND reply_at IS NULL AND next_followup_at<=?",(at,)).fetchall():
        request=dict(row)
        if eligibility(conn,request['vendor_id'],request['contact_id']):continue
        if conn.execute("SELECT 1 FROM stock_messages WHERE request_id=? AND (extraction_status IN ('Queued','Processing') OR (direction='outgoing' AND status IN ('Draft','Approved','Dispatching','Dispatch Uncertain'))) ",(request['id'],)).fetchone():continue
        number=request['followup_count']+1
        if number>config.max_followups:continue
        if conn.execute('SELECT 1 FROM stock_messages WHERE request_id=? AND followup_number=?',(request['id'],number)).fetchone():continue
        created.append(add_draft(conn,request,None,number))
        conn.execute('UPDATE stock_requests SET next_followup_at=NULL WHERE id=?',(request['id'],))
    return created
