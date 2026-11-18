import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base='http://127.0.0.1:3026',output=path.resolve('../deliverables/supplier-side-final-qa'),browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),report={checks:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});console.log('PASS',name);}catch(e){report.checks.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,String(e));}}
try{
 await page.goto(base+'/console/login');await page.getByLabel('Email',{exact:true}).fill('admin@qa.invalid');await page.getByLabel('Password',{exact:true}).fill('qa-admin-pass');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/console$/);
 await check('Stock settings retain user edits when delayed summary refresh arrives',async()=>{
  await page.goto(base+'/console/admin/agents/supplier-stock');await page.getByRole('heading',{name:'Pending actions',exact:true}).waitFor();
  await page.route('**/api/console/stock/summary',async r=>{await new Promise(resolve=>setTimeout(resolve,1000));await r.continue();});
  await page.getByRole('tab',{name:'Settings',exact:true}).click();const input=page.getByLabel('Freshness window · days',{exact:true});await input.fill('12');await page.waitForTimeout(1500);assert.equal(await input.inputValue(),'12');
  await page.getByRole('button',{name:'Save monitoring settings',exact:true}).click();await page.getByText('Monitoring settings saved',{exact:true}).waitFor();const r=await context.request.get(base+'/api/console/stock/summary');assert.equal((await r.json()).settings.fresh_days,12);await page.unroute('**/api/console/stock/summary');
 });
 await check('Four dashboards retain natural Inter typography and mobile readability',async()=>{
  await page.setViewportSize({width:390,height:844});for(const id of ['supplier-discovery','supplier-qualification','supplier-catalog','supplier-stock']){await page.goto(base+'/console/admin/agents/'+id);await page.locator('h1').waitFor();await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,id);assert.match(await page.locator('h1').evaluate(e=>getComputedStyle(e).fontFamily),/inter/i);}
  await page.screenshot({path:path.join(output,'final-mobile.png'),fullPage:true});
 });
 await check('Service restart preserves identity links, qualification, catalog, inventory, conversations and disabled live email',async()=>{
  const get=async p=>(await (await context.request.get(base+'/api/console/'+p)).json());const lifecycle=JSON.parse(fs.readFileSync(path.join(output,'lifecycle-browser.json'))).identity;
  const lead=await get('discovery/leads/'+lifecycle.lead_id),qualification=await get('qualification/jobs/'+lifecycle.qualification_job_id);assert.equal(lead.linked_vendor_id,lifecycle.vendor_id);assert.equal(qualification.review_status,'Reviewed');assert.equal(qualification.report.ai.status,'Available');
  const summary=await get('stock/summary');assert.equal(summary.email.mode,'mock');assert.equal(summary.email.live_ready,false);assert.equal(summary.email.inbound_enabled,false);assert.equal(summary.counts.approved_updates,1);
  const inventory=await get('stock/inventory');assert.equal(inventory.rows[0].data.quantity,'20');assert.equal(inventory.rows[0].data.quantity_unit,'ton');assert.equal(inventory.rows[0].data.price,'50');assert.equal(inventory.rows[0].freshness.state,'Fresh');assert.equal((await get('catalog/products')).total,1);
  const messages=await get('stock/messages');assert.equal(messages.rows.filter(m=>m.status==='Mock Sent').length,1);assert.equal(messages.rows.filter(m=>m.status==='Quarantined').length,1);
  await page.goto(base+'/console/inventory?view=catalog');await page.getByText(/Supplier-reported qty: 20 ton/).waitFor();await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(output,'after-restart-inventory.png'),fullPage:true});
  await page.goto(base+'/console/admin/agents/supplier-stock');await page.getByRole('tab',{name:'Agent Activity',exact:true}).click();await page.locator('summary').filter({hasText:'Inventory update approved'}).first().waitFor();await page.screenshot({path:path.join(output,'after-restart-history.png'),fullPage:true});
 });
 await check('Logout invalidates the Admin session',async()=>{await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.waitForURL(/\/console\/login/);assert.equal((await context.request.get(base+'/api/console/stock/summary')).status(),401);});
}finally{await browser.close();fs.writeFileSync(path.join(output,'persistence-browser.json'),JSON.stringify(report,null,2));}
if(report.checks.some(c=>c.status==='FAIL')||report.errors.length)process.exitCode=1;
