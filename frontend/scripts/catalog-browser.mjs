import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:3023';
const directory = path.resolve(process.env.TRADE_DATA_DIR || '');
if (!path.basename(directory).startsWith('.qa-')) throw new Error('Use an explicitly disposable QA database');
const fixture = path.resolve('../deliverables/Example_filled_list_Afeef_Packages_DEMO.xlsx');
const report = { checks: [], browser_errors: [], fixture, gemini_requests: 0, serpapi_searches: 0, demonstration: {} };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage();
page.on('pageerror', e => report.browser_errors.push(e.message));
let job, rowId;
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, status: 'PASS' }); console.log('PASS',name); }
  catch(e) { report.checks.push({ name, status: 'FAIL', error: String(e.stack || e) }); console.error('FAIL',name,String(e)); await page.screenshot({ path: path.join(directory,'failure-'+report.checks.length+'.png'),fullPage:true }); }
}
async function data(url) { const r=await context.request.get(base+'/api/console/catalog'+url);assert.equal(r.status(),200,await r.text());return r.json(); }
async function waitFor(predicate) { for(let i=0;i<50;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for catalog state'); }
await check('Anonymous and Sales access denied', async()=>{
  assert.equal((await context.request.get(base+'/api/console/catalog/summary')).status(),401);
  const sales=await browser.newContext();const p=await sales.newPage();await p.goto(base+'/console/login');await p.getByLabel('Email').fill('sales@qa.invalid');await p.getByLabel('Password').fill('qa-sales-pass');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForURL(/\/console$/);
  assert.equal((await sales.request.get(base+'/api/console/catalog/summary')).status(),403);await sales.close();
});
await check('Admin opens implemented card and four functional tabs',async()=>{
  await page.goto(base+'/console/login');await page.getByLabel('Email').fill('admin@qa.invalid');await page.getByLabel('Password').fill('qa-admin-pass');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/console$/);
  await page.goto(base+'/console/admin/agents');await page.locator('[data-agent-id="supplier-catalog"]').getByText('Development ready',{exact:true}).waitFor();await page.locator('[data-agent-id="supplier-catalog"]').click();
  await page.getByRole('heading',{name:'Supplier Catalog Intake',exact:true}).waitFor();
  for(const tab of ['Overview','Catalog Imports','Product Review','Supplier Catalog']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();}
});
await check('Upload unchanged Afeef workbook and parse actual 15 source rows',async()=>{
  await page.getByRole('tab',{name:'Catalog Imports',exact:true}).click();await page.getByLabel('Import supplier').selectOption('1');await page.getByLabel('Catalog file').setInputFiles(fixture);await page.getByRole('button',{name:'Queue import',exact:true}).click();
  await waitFor(async()=>{const jobs=await data('/imports');job=jobs.rows.find(j=>j.name===path.basename(fixture));return job?.status==='Needs Review';});
  assert.equal(job.parsed_count,15);report.demonstration.job_id=job.id;report.demonstration.parsed=15;
  const rows=(await data('/rows?job='+job.id)).rows;report.demonstration.initial_validation_errors=rows.filter(r=>r.errors.length).length;assert.equal(rows.length,15);
  assert.equal(rows[0].source.worksheet,'BULK_UPLOAD');assert.ok(rows[0].source.row>=2);
  const source=await context.request.get(base+`/api/console/catalog/imports/${job.id}/source`);assert.deepEqual(await source.body(),fs.readFileSync(fixture));
  await page.getByRole('button',{name:'Review rows',exact:true}).first().click();await page.locator('[data-testid="catalog-product-row"]').first().waitFor();
  await page.screenshot({path:path.join(directory,'catalog-review-desktop.png'),fullPage:true});
});
await check('Editable preview rejects invalid price, then Admin corrects from preserved evidence',async()=>{
  const row=(await data('/rows?job='+job.id)).rows[0];rowId=row.id;report.demonstration.corrected_sku=row.data.vendor_sku;report.demonstration.original_price=row.data.price;
  await page.getByRole('button',{name:'Details / edit',exact:true}).first().click();const dialog=page.getByRole('dialog',{name:'Product evidence and correction'});await dialog.getByLabel('Edit price',{exact:true}).fill('-1');await dialog.getByLabel('Correction reason').fill('QA injects invalid review value to verify rejection');await dialog.getByRole('button',{name:'Save correction',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await waitFor(async()=>{const r=(await data('/rows?job='+job.id)).rows.find(r=>r.id===rowId);return r.errors.some(e=>e.startsWith('price:'));});
  const rejected=await context.request.post(base+`/api/console/catalog/imports/${job.id}/review`,{data:{ids:[rowId],action:'approve',note:'Cannot approve invalid price'}});assert.equal(rejected.status(),409);
  await page.getByRole('button',{name:'Details / edit',exact:true}).first().click();await dialog.getByLabel('Edit price',{exact:true}).fill(String(row.data.price));await dialog.getByLabel('Correction reason').fill('Restore the literal original workbook price after validation test');await dialog.getByRole('button',{name:'Save correction',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await waitFor(async()=>!(await data('/rows?job='+job.id)).rows.find(r=>r.id===rowId).errors.length);
  report.demonstration.correction='Injected -1 price rejected, restored exact source value '+row.data.price;
});
await check('Explicit selection, Admin approval, publication and existing Inventory view',async()=>{
  const row=(await data('/rows?job='+job.id)).rows.find(r=>r.id===rowId);await page.getByLabel('Select '+row.data.vendor_sku,{exact:true}).check();
  page.once('dialog',d=>d.accept('Reviewed source in disposable QA database'));await page.getByRole('button',{name:'Approve selected',exact:true}).click();
  await waitFor(async()=>(await data('/rows?job='+job.id)).rows.find(r=>r.id===rowId).status==='Approved');
  await page.getByText('Review decision saved',{exact:true}).waitFor();
  await waitFor(async()=>!(await page.getByLabel('Select '+row.data.vendor_sku,{exact:true}).isChecked()));
  await page.getByLabel('Select '+row.data.vendor_sku,{exact:true}).check();page.once('dialog',d=>d.accept('Publish DEMO evidence only inside disposable QA database'));await page.getByRole('button',{name:'Publish approved',exact:true}).click();
  await waitFor(async()=>(await data('/products')).total===1);report.demonstration.published=1;
  await page.getByRole('tab',{name:'Supplier Catalog',exact:true}).click();await page.getByRole('link',{name:'View in Inventory',exact:true}).click();await page.locator('[data-testid="catalog-inventory-offer"]').waitFor();
  await page.getByText(row.data.name,{exact:true}).waitFor();await page.screenshot({path:path.join(directory,'catalog-inventory-desktop.png'),fullPage:true});
});
await check('Idempotent unchanged re-upload and duplicate SKU warnings',async()=>{
  await page.goto(base+'/console/admin/agents/supplier-catalog');await page.getByRole('tab',{name:'Catalog Imports',exact:true}).click();await page.getByLabel('Import supplier').selectOption('1');await page.getByLabel('Catalog file').setInputFiles(fixture);await page.getByRole('button',{name:'Queue import',exact:true}).click();await page.getByText(/This unchanged source already exists/).waitFor();assert.equal((await data('/imports')).total,1);
  const form={vendor_id:'1',file:{name:'duplicate-skus.csv',mimeType:'text/csv',buffer:Buffer.from('SKU,Product name,Category\nDUP,QA fixture carton,Shipping Box\nDUP,QA fixture carton,Shipping Box\n')}};
  const result=await context.request.post(base+'/api/console/catalog/imports',{multipart:form});assert.equal(result.status(),200);const duplicateJob=(await result.json()).id;
  await waitFor(async()=>(await data('/imports/'+duplicateJob)).status==='Needs Review');const duplicates=(await data('/rows?job='+duplicateJob)).rows;assert.equal(duplicates.length,2);assert.ok(duplicates.some(r=>r.errors.some(e=>e.includes('Duplicate'))));report.demonstration.duplicate_rows_detected=1;
});
await check('Supplier search, status filter, mobile layout and no idle polling',async()=>{
  await page.getByRole('tab',{name:'Supplier Catalog',exact:true}).click();await page.getByLabel('Search products').fill('no-such-product');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByText('No products match these filters.',{exact:true}).waitFor();await page.getByLabel('Search products').fill('');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('link',{name:'View in Inventory'}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(directory,'catalog-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.getByRole('tab',{name:'Product Review',exact:true}).click();await page.getByLabel('Filter review status').selectOption('Published');await page.getByRole('button',{name:'Search',exact:true}).click();await page.locator('[data-testid="catalog-product-row"]').first().waitFor();await waitFor(async()=>await page.locator('[data-testid="catalog-product-row"]').count()===1);
  await page.getByRole('tab',{name:'Overview',exact:true}).click();await page.getByText('Recently processed suppliers',{exact:true}).waitFor();await new Promise(r=>setTimeout(r,700));let calls=0;const listener=r=>{if(r.url().includes('/api/console/catalog/'))calls++;};page.on('request',listener);await new Promise(r=>setTimeout(r,3500));page.off('request',listener);assert.equal(calls,0);
});
await check('Backend error state and explicit retry',async()=>{
  await page.route('**/api/console/catalog/summary',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'QA backend unavailable'})}));await page.reload();await page.getByRole('alert').getByText('QA backend unavailable',{exact:false}).waitFor();await page.unroute('**/api/console/catalog/summary');await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Reconnected',{exact:true}).waitFor();
});
report.browser_errors = [...new Set(report.browser_errors)];
fs.writeFileSync(path.join(directory,'browser-results.json'),JSON.stringify(report,null,2));
await browser.close();
if(report.checks.some(c=>c.status==='FAIL')||report.browser_errors.length)process.exitCode=1;
