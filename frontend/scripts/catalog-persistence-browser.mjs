import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const directory=path.resolve(process.env.TRADE_DATA_DIR||'');
if(!path.basename(directory).startsWith('.qa-'))throw new Error('Disposable QA directory required');
const base=process.env.BASE_URL||'http://127.0.0.1:3023';
const report={checks:[],browser_errors:[]};
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
page.on('pageerror',e=>report.browser_errors.push(e.message));
try{
  await page.goto(base+'/console/login');await page.getByLabel('Email').fill('admin@qa.invalid');await page.getByLabel('Password').fill('qa-admin-pass');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/console$/);
  await page.goto(base+'/console/admin/agents/supplier-catalog');await page.getByRole('tab',{name:'Supplier Catalog',exact:true}).click();await page.getByRole('link',{name:'View in Inventory',exact:true}).waitFor();
  const response=await context.request.get(base+'/api/console/catalog/products');assert.equal(response.status(),200);const products=await response.json();assert.equal(products.total,1);assert.equal(products.rows[0].data.vendor_sku,'AFEEFP-SL-12');
  await page.getByRole('link',{name:'View in Inventory',exact:true}).click();await page.locator('[data-testid="catalog-inventory-offer"]').waitFor();await page.getByText('Cup sleeve for 12–16 oz, kraft',{exact:true}).waitFor();
  report.checks.push({name:'Restarted backend serves original published evidence in Admin and existing Inventory',status:'PASS'});
  await page.screenshot({path:path.join(directory,'catalog-after-restart.png'),fullPage:true});
  await page.goto(base+'/console/admin/agents/supplier-catalog');await page.getByRole('tab',{name:'Catalog Imports',exact:true}).click();await page.getByLabel('Import supplier').selectOption('2');
  await page.getByLabel('Catalog file').setInputFiles({name:'post-restart.csv',mimeType:'text/csv',buffer:Buffer.from('SKU,Product name,Category\nRESTART,Post restart fixture,Shipping Box\n')});
  await page.getByRole('button',{name:'Queue import',exact:true}).click();await page.getByText('post-restart.csv',{exact:true}).waitFor();
  let job;
  for(let i=0;i<50;i++){const r=await context.request.get(base+'/api/console/catalog/imports');job=(await r.json()).rows.find(j=>j.name==='post-restart.csv');if(job?.status==='Needs Review')break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(job.status,'Needs Review');assert.equal(job.parsed_count,1);
  report.checks.push({name:'Final multipart limiter and parser accept one valid post-restart upload',status:'PASS'});
  await page.getByLabel('Source type').selectOption('url');await page.getByText('Fetch a revised observation of this URL for a new Admin review',{exact:false}).waitFor();
  report.checks.push({name:'Explicit URL reobservation control is present; no website request issued',status:'PASS'});
  assert.equal(report.browser_errors.length,0);
}catch(e){report.checks.push({name:'Post-restart browser verification',status:'FAIL',error:String(e.stack||e)});process.exitCode=1;}
fs.writeFileSync(path.join(directory,'post-restart-browser-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));await browser.close();
