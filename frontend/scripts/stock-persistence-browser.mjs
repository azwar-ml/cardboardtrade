import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const directory=path.resolve(process.env.TRADE_DATA_DIR||'');
if(!path.basename(directory).startsWith('.qa-stock-'))throw new Error('Disposable stock QA data is required');
const base=process.env.BASE_URL||'http://127.0.0.1:3024';
const report={checks:[],browser_errors:[]};
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1500,height:1080}});const page=await context.newPage();page.on('pageerror',e=>report.browser_errors.push(e.message));
try{
 await page.goto(base+'/console/login');await page.getByLabel('Email').fill('admin@qa.invalid');await page.getByLabel('Password').fill('qa-admin-pass');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/console$/);
 await page.goto(base+'/console/admin/agents/supplier-stock');
 for(const tab of ['Overview','Suppliers','Stock Requests','Supplier Inbox','Inventory Changes','Follow-Ups','Agent Activity','Settings']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();assert.equal(await page.getByTestId('stock-monitor-dashboard').getByRole('alert').count(),0);}
 report.checks.push({name:'All eight sections remain functional after service restart and final build',status:'PASS'});
 const summary=await (await context.request.get(base+'/api/console/stock/summary')).json();assert.equal(summary.email.mode,'mock');assert.equal(summary.email.live_ready,false);assert.equal(summary.email.inbound_enabled,false);assert.equal(summary.counts.approved_updates,1);
 const messages=await (await context.request.get(base+'/api/console/stock/messages')).json();assert.equal(messages.rows.filter(m=>m.status==='Mock Sent').length,1);assert.equal(messages.rows.filter(m=>m.status==='Quarantined').length,1);
 const local=await context.request.get(base+'/api/console/stock/messages/1/outbox');assert.equal(local.status(),200);assert.match(await local.text(),/X-Cardboard-Thread/);
 report.checks.push({name:'Conversation, quarantine, local MIME and disabled live-provider gates persist',status:'PASS'});
 await page.goto(base+'/console/inventory?view=catalog');await page.getByText(/Supplier-reported qty: 20 ton/).waitFor();await page.getByRole('cell').filter({hasText:/^Fresh/}).first().waitFor();assert.equal(await page.getByRole('cell').filter({hasText:'Quotation required'}).count(),2);await page.screenshot({path:path.join(directory,'stock-after-restart.png'),fullPage:true});
 report.checks.push({name:'Approved quantity persists in existing Inventory while both prices remain unknown',status:'PASS'});
 assert.equal(report.browser_errors.length,0);
}catch(e){report.checks.push({name:'Post-restart browser verification',status:'FAIL',error:String(e.stack||e)});process.exitCode=1;}
fs.writeFileSync(path.join(directory,'post-restart-browser-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();
