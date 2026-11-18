import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
const root=path.resolve('..'),data=path.join(root,'frontend/data/trade.db'),output=path.join(root,'.tmp/integration-fix');
const database=new Database(data,{readonly:true,fileMustExist:true});
const session=database.prepare("SELECT s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.role='admin' AND u.active=1 AND s.expires_at>? ORDER BY s.expires_at DESC LIMIT 1").get(new Date().toISOString());
if(!session)throw new Error('An existing Admin login on localhost:3000 is required. No test credentials or sessions will be created.');
const before=process.env.INTEGRATION_BEFORE==='1';
const report={mode:before?'before':'after',checks:[],errors:[],database:data,read_only:true};
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addCookies([{name:'cp_session',value:session.token,url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);
const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
async function check(name,work){try{await work();report.checks.push({name,status:'PASS'});console.log('PASS',name);}catch(e){report.checks.push({name,status:'FAIL',error:String(e.message)});console.error('FAIL',name,String(e.message));}}
try{
 if(before){
  for(const id of ['supplier-catalog','supplier-stock'])await check('Old main build serves Demo preview: '+id,async()=>{await page.goto('http://localhost:3000/console/admin/agents/'+id);await page.getByRole('heading',{name:'Dashboard preview',exact:true}).waitFor();await page.screenshot({path:path.join(output,'before-'+id+'.png'),fullPage:true});});
 }else{
  await check('Main cards distinguish development and local email from production',async()=>{
   await page.goto('http://localhost:3000/console/admin/agents');
   await page.locator('[data-agent-id="supplier-catalog"]').getByText('Development ready',{exact:true}).waitFor();
   await page.locator('[data-agent-id="supplier-stock"]').getByText('Local email mode',{exact:true}).waitFor();
   for(const id of ['supplier-catalog','supplier-stock'])assert.doesNotMatch(await page.locator(`[data-agent-id="${id}"]`).innerText(),/Dashboard preview|\bDemo\b|\bLive\b|146|189 lots/);
   await page.screenshot({path:path.join(output,'main-agent-cards.png'),fullPage:true});
  });
  await check('Agent #3 main card opens the real four-tab interface and API counts',async()=>{
   await page.locator('[data-agent-id="supplier-catalog"]').click();await page.getByTestId('catalog-dashboard').waitFor();
   assert.equal(await page.getByRole('heading',{name:'Dashboard preview',exact:true}).count(),0);
   for(const tab of ['Overview','Catalog Imports','Product Review','Supplier Catalog']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();assert.equal(await page.getByTestId('catalog-dashboard').getByRole('alert').count(),0);}
   const response=await context.request.get('http://localhost:3000/api/console/catalog/summary');assert.equal(response.status(),200);const actual=await response.json();
   assert.equal(actual.imports,database.prepare('SELECT count(*) n FROM catalog_jobs').get().n);
   assert.equal(actual.approved_products,database.prepare('SELECT count(*) n FROM catalog_products').get().n);
   await page.screenshot({path:path.join(output,'main-catalog.png'),fullPage:true});
  });
  await check('Agent #4 main card opens the real eight-tab interface with email disabled',async()=>{
   await page.goto('http://localhost:3000/console/admin/agents');await page.locator('[data-agent-id="supplier-stock"]').click();await page.getByTestId('stock-monitor-dashboard').waitFor();
   assert.equal(await page.getByRole('heading',{name:'Dashboard preview',exact:true}).count(),0);
   for(const tab of ['Overview','Suppliers','Stock Requests','Supplier Inbox','Inventory Changes','Follow-Ups','Agent Activity','Settings']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();assert.equal(await page.getByTestId('stock-monitor-dashboard').getByRole('alert').count(),0);}
   const r=await context.request.get('http://localhost:3000/api/console/stock/summary');assert.equal(r.status(),200);const s=await r.json();assert.equal(s.email.mode,'mock');assert.equal(s.email.live_ready,false);assert.equal(s.email.inbound_enabled,false);
   assert.equal(s.counts.monitored_suppliers,database.prepare('SELECT count(*) n FROM stock_policies WHERE enabled=1').get().n);
   await page.screenshot({path:path.join(output,'main-stock.png'),fullPage:true});
  });
  await check('Both protected API families use the intended main backend and database',async()=>{
   for(const route of ['catalog/options','catalog/imports','catalog/rows','catalog/products','stock/options','stock/inventory','stock/requests','stock/messages','stock/proposals','stock/followups','stock/activity']){
    const r=await context.request.get('http://localhost:3000/api/console/'+route);assert.equal(r.status(),200,route);
   }
   const registry=await(await context.request.get('http://127.0.0.1:8000/api/v1/agents')).json();
   for(const id of ['supplier-catalog','supplier-stock']){const a=registry.agents.find(a=>a.id===id);assert.equal(a.status,'implemented-development');assert.equal(a.mode,'development');assert.deepEqual(a.metrics,{});}
   const health=await(await context.request.get('http://127.0.0.1:8000/health')).json();assert.equal(health.database_fingerprint,createHash('sha256').update(data.replaceAll('\\','/').toLowerCase()).digest('hex'));report.backend_pid=health.process_id;report.database_fingerprint=health.database_fingerprint;
  });
  await check('Backend error is shown without a false ready badge',async()=>{
   await page.route('**/api/console/catalog/summary',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Controlled read-only unavailable response'})}));
   await page.goto('http://localhost:3000/console/admin/agents');await page.locator('[data-agent-id="supplier-catalog"]').getByText('Backend unavailable',{exact:true}).waitFor();await page.unroute('**/api/console/catalog/summary');
  });
  await check('Main dashboard remains usable on mobile',async()=>{await page.goto('http://localhost:3000/console/admin/agents/supplier-stock');await page.getByRole('tabpanel',{name:'Overview',exact:true}).waitFor();await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'main-stock-mobile.png'),fullPage:true});});
 }
}finally{database.close();await browser.close();fs.writeFileSync(path.join(output,before?'before-browser.json':'browser-results.json'),JSON.stringify(report,null,2));}
if(report.checks.some(x=>x.status==='FAIL')||report.errors.length)process.exitCode=1;
