import base64
import hashlib
import hmac
import html
import json
import os
import re
import time
from email.message import EmailMessage
from .storage import folder, now
from .domain import email


def config():
    # No live keys are loaded or exercised in mock mode.
    return {'mode':os.getenv('STOCK_EMAIL_MODE','mock'),
            'from':os.getenv('STOCK_MAIL_FROM','stock@cardboardpackage.com'),
            'reply_to':os.getenv('STOCK_REPLY_TO','stock@cardboardpackage.com'),
            'live_ready':os.getenv('STOCK_ENVIRONMENT')=='production' and os.getenv('STOCK_EMAIL_MODE')=='resend'
             and os.getenv('STOCK_RESEND_DOMAIN_VERIFIED')=='true' and os.getenv('STOCK_LIVE_SEND_AUTHORIZATION')=='authorized'
             and bool(os.getenv('RESEND_API_KEY')),
            'inbound_enabled':os.getenv('STOCK_INBOUND_AUTHORIZED')=='true' and bool(os.getenv('STOCK_WEBHOOK_SECRET'))}


def safe_header(value):
    if '\r' in value or '\n' in value:raise ValueError('Email header line breaks are forbidden')
    return value


def disclosure_check(conn,subject,body):
    text=(subject+' '+body).casefold()
    if re.search(r'\b(markup|internal margin|our margin|system prompt|chain.of.thought|supplier ranking|internal quotation)\b',text):
        raise ValueError('Draft contains restricted internal information')
    for row in conn.execute('SELECT name FROM buyers UNION SELECT email FROM contacts'):
        value=str(row[0] or '').strip().casefold()
        if len(value)>4 and value in text:raise ValueError('Draft contains buyer information requiring a separate authorized workflow')


def content(message,token):
    sender=email(config()['from']);recipient=email(message['recipient'])
    subject=safe_header(message['subject'])
    headers={'Message-ID':f'<stock-{message["id"]}@cardboardpackage.com>',
             'X-Cardboard-Thread':token}
    if message.get('reply_to_id'):
        headers['In-Reply-To']=safe_header(message['reply_to_id'])
        headers['References']=safe_header(message['reply_to_id'])
    plain=message['body']+'\n\nReference: '+token
    return {'from':sender,'to':[recipient],'reply_to':email(config()['reply_to']),'subject':subject,'text':plain,
            'html':'<div>'+html.escape(plain).replace('\n','<br>')+'</div>','headers':headers}


class MockOutbound:
    def send(self,message,token):
        payload=content(message,token)
        doc=EmailMessage();doc['From']=payload['from'];doc['To']=payload['to'][0];doc['Subject']=payload['subject'];doc['Reply-To']=payload['reply_to']
        for k,v in payload['headers'].items():doc[k]=v
        doc.set_content(payload['text']);doc.add_alternative(payload['html'],subtype='html')
        name=str(message['id'])+'.eml';target=folder('outbox')/name
        data=doc.as_bytes()
        if not target.exists():
            with target.open('xb') as handle:handle.write(data)
        return {'id':'mock-stock-'+str(message['id']),'status':'Mock Sent','outbox_file':name}


class ResendOutbound:
    def send(self,message,token,live_authorization=None):
        if not config()['live_ready'] or live_authorization!='SEND LIVE':
            raise ValueError('Live delivery disabled: production configuration, verified domain and per-message authorization required')
        import httpx
        payload=content(message,token)
        # Fixed endpoint, zero retries; durable DB reservation precedes this call.
        with httpx.Client(timeout=20) as api:
            response=api.post('https://api.resend.com/emails',headers={'Authorization':'Bearer '+os.environ['RESEND_API_KEY'],
              'Idempotency-Key':'stock-message-'+str(message['id'])},json=payload)
        if response.status_code not in (200,201):
            raise ValueError(f'Resend HTTP {response.status_code}; no automatic retry. Operator reconciliation required')
        identifier=response.json().get('id')
        if not identifier:raise ValueError('Resend response missing provider identifier; reconcile before retry')
        return {'id':identifier,'status':'Sent','outbox_file':None}


def verify_webhook(raw,headers,secret=None,at=None):
    secret=secret or os.getenv('STOCK_WEBHOOK_SECRET','')
    identifier=headers.get('svix-id','');stamp=headers.get('svix-timestamp','');signature=headers.get('svix-signature','')
    if not secret or not identifier or not stamp:raise ValueError('Webhook signature required')
    try:
        if abs((at or time.time())-int(stamp))>300:raise ValueError('Webhook timestamp expired')
        key=base64.b64decode(secret.removeprefix('whsec_'),validate=True)
    except (TypeError,ValueError):raise ValueError('Webhook authentication failed')
    expected=base64.b64encode(hmac.new(key,identifier.encode()+b'.'+stamp.encode()+b'.'+raw,hashlib.sha256).digest()).decode()
    if not any(hmac.compare_digest(expected,s.split(',',1)[-1]) for s in signature.split() if s.startswith('v1,')):
        raise ValueError('Webhook authentication failed')
    return identifier


class ResendInbound:
    """Signed events carry metadata; content must be fetched separately after authorization."""
    def receive(self,event):
        if not config()['inbound_enabled']:raise ValueError('Live inbound is disabled')
        identifier=event.get('data',{}).get('email_id','')
        if not re.fullmatch(r'[A-Za-z0-9-]{1,100}',identifier):raise ValueError('Invalid provider email ID')
        import httpx
        with httpx.Client(timeout=20) as api:
            response=api.get('https://api.resend.com/emails/receiving/'+identifier,
                            headers={'Authorization':'Bearer '+os.environ.get('RESEND_API_KEY','')})
        if response.status_code!=200:raise ValueError(f'Inbound content retrieval HTTP {response.status_code}')
        data=response.json()
        headers={str(h.get('name','')).lower():h.get('value','') for h in data.get('headers',[]) } if isinstance(data.get('headers'),list) else {str(k).lower():v for k,v in data.get('headers',{}).items()}
        return {'source_id':'resend:'+identifier,'sender':data['from'],'recipient':data.get('to',[''])[0],
                'subject':data.get('subject',''),'body':data.get('text',''),'html':data.get('html'),
                'source_at':data.get('created_at'),
                'in_reply_to':headers.get('in-reply-to'),'references':headers.get('references'),
                'thread_token':headers.get('x-cardboard-thread'),'authenticated':authenticated_sender(headers,data['from'])}


def authenticated_sender(headers,sender):
    # A signed webhook authenticates Resend, not the person in From.
    # Fail closed unless the operator has configured the trusted receiver's authserv-id.
    trusted=os.getenv('STOCK_TRUSTED_AUTHSERV_ID','').strip().lower()
    result=str(headers.get('authentication-results','')).lower()
    domain=email(sender).split('@')[-1]
    return bool(trusted and result.split(';',1)[0].strip()==trusted and re.search(r'\bdmarc=pass\b',result)
                and re.search(r'\bheader\.from='+re.escape(domain)+r'(?:\s|;|$)',result))
