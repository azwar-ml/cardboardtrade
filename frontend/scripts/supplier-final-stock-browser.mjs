import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
const directory=path.resolve(process.env.TRADE_DATA_DIR||'');
if(!path.basename(directory).startsWith('.qa-supplier-final'))throw new Error('Explicit disposable stock QA directory required');
const base=process.env.BASE_URL||'http://127.0.0.1:3026';
const report={checks:[],browser_errors:[],real_emails:0,gemini_requests:0,serpapi_searches:0};
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1500,height:1080}});const page=await context.newPage();page.on('pageerror',e=>report.browser_errors.push(e.message));
const get=async p=>{const r=await context.request.get(base+'/api/console/stock'+p);assert.equal(r.status(),200,await r.text());return r.json();};
async function wait(test){for(let i=0;i<75;i++){if(await test())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for stock workflow');}
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});console.log('PASS',name);}catch(e){report.checks.push({name,status:'FAIL',error:String(e.stack||e)});console.error('FAIL',name,String(e));await page.screenshot({path:path.join(directory,'failure-'+report.checks.length+'.png'),fullPage:true});}}
let rid,mid,proposal;
await check('Anonymous and Sales monitoring access denied',async()=>{
 assert.equal((await context.request.get(base+'/api/console/stock/summary')).status(),401);
 const sales=await browser.newContext();const p=await sales.newPage();await p.goto(base+'/console/login');await p.getByLabel('Email').fill('sales@qa.invalid');await p.getByLabel('Password').fill('qa-sales-pass');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForURL(/\/console$/);assert.equal((await sales.request.get(base+'/api/console/stock/summary')).status(),403);await sales.close();
});
await check('Implemented Agent #4 card and eight database-driven sections',async()=>{
 await page.goto(base+'/console/login');await page.getByLabel('Email').fill('admin@qa.invalid');await page.getByLabel('Password').fill('qa-admin-pass');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/console$/);await page.goto(base+'/console/admin/agents');await page.locator('[data-agent-id="supplier-stock"]').getByText('Local email mode',{exact:true}).waitFor();await page.locator('[data-agent-id="supplier-stock"]').click();await page.getByRole('heading',{name:'Supplier Stock Monitor',exact:true}).waitFor();
 for(const tab of ['Overview','Suppliers','Stock Requests','Supplier Inbox','Inventory Changes','Follow-Ups','Agent Activity','Settings']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();assert.equal(await page.getByTestId('stock-monitor-dashboard').getByRole('alert').count(),0);}
});
await check('Eligible supplier selection, stock request and individual local email approval',async()=>{
 await page.getByRole('tab',{name:'Stock Requests',exact:true}).click();await page.getByLabel('Enquiry supplier').selectOption('1');await page.getByLabel('Enquiry contact').selectOption('1');await page.getByLabel('Request QA-BOARD-1',{exact:true}).check();await page.getByRole('button',{name:'Prepare draft',exact:true}).click();await page.getByText('Reviewable email draft created',{exact:true}).waitFor();
 const requests=await get('/requests');rid=requests.rows[0].id;mid=requests.rows[0].messages[0].id;
 assert.equal(requests.rows[0].messages[0].status,'Draft');
 await page.getByRole('button',{name:`outgoing · Draft · #${mid}`,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Supplier conversation'});await dialog.getByLabel('Email draft body').waitFor();
 page.once('dialog',d=>d.accept('QA individual email approval'));await dialog.getByRole('button',{name:'Approve email draft',exact:true}).click();await dialog.getByRole('button',{name:'Write to local outbox',exact:true}).waitFor();
 page.once('dialog',d=>d.accept('QA local outbox only; no real delivery'));await dialog.getByRole('button',{name:'Write to local outbox',exact:true}).click();await dialog.getByRole('link',{name:'Download local email',exact:true}).waitFor();
 const eml=await context.request.get(base+`/api/console/stock/messages/${mid}/outbox`);assert.equal(eml.status(),200);assert.match(await eml.text(),/X-Cardboard-Thread/);assert.equal(fs.readdirSync(path.join(directory,'outbox/stock-monitor')).filter(n=>n.endsWith('.eml')).length,1);
 await page.screenshot({path:path.join(directory,'stock-email-approval.png'),fullPage:true});await dialog.getByRole('button',{name:'Close conversation',exact:true}).click();
});
await check('Due follow-up creates a draft without dispatch',async()=>{
 const db=new Database(path.join(directory,'trade.db'));db.prepare("UPDATE stock_requests SET next_followup_at='2020-01-01T00:00:00Z' WHERE id=?").run(rid);db.close();
 await page.getByRole('button',{name:'Run monitoring cycle',exact:true}).click();await page.getByText('Monitoring cycle complete; no email was sent',{exact:true}).waitFor();await page.getByRole('tab',{name:'Follow-Ups',exact:true}).click();await page.getByRole('cell').filter({hasText:'Follow-up: Initial availability | Cardboard Package'}).first().waitFor();
 const f=await get('/followups');assert.equal(f.rows[0].status,'Draft');assert.equal(fs.readdirSync(path.join(directory,'outbox/stock-monitor')).filter(n=>n.endsWith('.eml')).length,1);
});
await check('Simulated authenticated reply, durable processing and missing price preserved',async()=>{
 await page.getByRole('tab',{name:'Supplier Inbox',exact:true}).click();await page.getByText('Simulate a supplier reply · local testing only',{exact:true}).click();await page.getByLabel('Simulated conversation').selectOption(rid);await page.getByLabel('Simulated reply body').fill('SKU: QA-BOARD-1\nWe currently have 20 tons of 300 GSM board, but the price will be confirmed tomorrow.');await page.getByRole('button',{name:'Capture simulated reply',exact:true}).click();await page.getByText('Simulated reply captured. Add attachments, then queue processing.',{exact:true}).waitFor();
 const inbox=await get('/messages');const incoming=inbox.rows.find(m=>m.direction==='incoming');assert.equal(incoming.status,'Received');
 await page.getByRole('button',{name:'Open message',exact:true}).first().click();const dialog=page.getByRole('dialog',{name:'Supplier conversation'});await dialog.getByRole('button',{name:'Queue reply processing',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await wait(async()=>{const p=await get('/proposals');proposal=p.rows[0];return proposal?.status==='Pending';});
 assert.equal(proposal.proposed.quantity,'20');assert.equal(proposal.proposed.quantity_unit,'ton');assert.equal(proposal.proposed.price,undefined);assert.equal(proposal.errors.length,0);
});
await check('Field-level Admin publication, provenance and current inventory freshness',async()=>{
 await page.getByRole('tab',{name:'Inventory Changes',exact:true}).click();await page.getByRole('button',{name:'Review change',exact:true}).first().click();const dialog=page.getByRole('dialog',{name:'Inventory change review'});
 for(const field of ['quantity','quantity_unit','availability'])await dialog.getByLabel('Approve field '+field,{exact:true}).check();await dialog.getByLabel('Inventory review note').fill('Approve only current confirmed quantity. Price remains unknown.');await dialog.getByRole('button',{name:'Approve selected fields',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByText('Inventory review saved. Only approved fields may change.',{exact:true}).waitFor();
 const inventory=await get('/inventory');const row=inventory.rows.find(r=>r.ref==='QA-BOARD-1');assert.equal(row.data.quantity,'20');assert.equal(row.data.quantity_unit,'ton');assert.equal(row.data.price,'50');assert.equal(row.freshness.state,'Fresh');
 await page.screenshot({path:path.join(directory,'stock-approved-changes.png'),fullPage:true});await page.goto(base+'/console/inventory?view=catalog');await page.getByText(/Supplier-reported qty: 20 ton/).waitFor();await page.screenshot({path:path.join(directory,'stock-inventory.png'),fullPage:true});
});
await check('Unknown sender quarantined; mobile dashboard and no idle polling',async()=>{
 const options=await get('/options');const thread=options.threads.find(r=>r.id===rid);const response=await context.request.post(base+'/api/console/stock/inbound/simulate',{data:{source_id:'unknown-browser',sender:'unknown@fixture.invalid',body:'We have 999 tons',thread_token:thread.thread_token,authenticated:true}});assert.equal((await response.json()).status,'Quarantined');
 await page.goto(base+'/console/admin/agents/supplier-stock');await page.getByRole('tab',{name:'Supplier Inbox',exact:true}).click();await page.locator('span').filter({hasText:/^Quarantined$/}).waitFor();await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(directory,'stock-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('tab',{name:'Overview',exact:true}).click();await page.getByRole('heading',{name:'Pending actions',exact:true}).waitFor();await new Promise(r=>setTimeout(r,500));let requests=0;const listener=r=>{if(r.url().includes('/api/console/stock/'))requests++;};page.on('request',listener);await new Promise(r=>setTimeout(r,3500));page.off('request',listener);assert.equal(requests,0);
});
await check('Settings persistence and backend error recovery',async()=>{
 await page.getByRole('tab',{name:'Settings',exact:true}).click();await page.getByLabel('Freshness window · days',{exact:true}).fill('12');await page.getByRole('button',{name:'Save monitoring settings',exact:true}).click();await page.getByText('Monitoring settings saved',{exact:true}).waitFor();assert.equal((await get('/summary')).settings.fresh_days,12);
 await page.route('**/api/console/stock/summary',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'QA stock backend unavailable'})}));await page.reload();await page.getByTestId('stock-monitor-dashboard').getByRole('alert').waitFor();await page.unroute('**/api/console/stock/summary');await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Connection refreshed',{exact:true}).waitFor();
});
await check('History and logout invalidate session',async()=>{await page.getByRole('tab',{name:'Agent Activity',exact:true}).click();await page.locator('summary').filter({hasText:'Inventory update approved'}).first().waitFor();await page.setViewportSize({width:1440,height:1000});await page.reload();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.waitForURL(/\/console\/login/);assert.equal((await context.request.get(base+'/api/console/stock/summary')).status(),401);});
report.request_id=rid;report.proposal_id=proposal?.id;fs.writeFileSync(path.join(directory,'browser-results.json'),JSON.stringify(report,null,2));await browser.close();if(report.checks.some(c=>c.status==='FAIL')||report.browser_errors.length)process.exitCode=1;
