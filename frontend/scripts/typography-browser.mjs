import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
const root=path.resolve('..'),output=path.join(root,'.tmp/typography'),before=process.env.TYPOGRAPHY_BEFORE==='1';
const db=new Database(path.join(root,'frontend/data/trade.db'),{readonly:true,fileMustExist:true});
const session=db.prepare("SELECT s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.role='admin' AND u.active=1 AND s.expires_at>? ORDER BY s.expires_at DESC LIMIT 1").get(new Date().toISOString());
if(!session)throw new Error('Sign into the normal app as Admin first. This test does not create credentials or sessions.');
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
await context.addCookies([{name:'cp_session',value:session.token,url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);
const page=await context.newPage(),cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
const report={phase:before?'before':'after',checks:[],pages:[],errors:[],font_requests:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(/woff2?|fonts\.google|fonts\.gstatic/.test(r.url()))report.font_requests.push(r.url());});
async function fonts(selector){const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});return nodeId?(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts:[];}
async function measure(name,url){
 await page.goto('http://localhost:3000'+url);await page.locator('h1').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1200);
 const styles=await page.evaluate(()=>{
  const read=e=>{if(!e)return null;const c=getComputedStyle(e);return {family:c.fontFamily,weight:c.fontWeight,size:c.fontSize,line_height:c.lineHeight,tracking:c.letterSpacing,stretch:c.fontStretch,transform:c.transform};};
  return {body:read(document.body),heading:read(document.querySelector('h1')),section:read(document.querySelector('h2')),button:read(document.querySelector('button,.btn')),navigation:read(document.querySelector('nav a')),overflow:document.documentElement.scrollWidth>innerWidth};
 });
 const result={name,url,...styles,heading_fonts:await fonts('h1'),body_fonts:await fonts('main p')};report.pages.push(result);
 if(!before){assert.ok(result.heading_fonts.some(f=>f.isCustomFont&&f.familyName.includes('Inter')),name+': actual rendered heading must be Inter');assert.equal(result.heading.stretch,'100%');assert.ok(Number(result.heading.weight)>=600);assert.equal(result.body.weight,'400');assert.equal(styles.overflow,false,name+': document overflow');}
 return result;
}
async function check(name,work){try{await work();report.checks.push({name,status:'PASS'});console.log('PASS',name);}catch(e){report.checks.push({name,status:'FAIL',error:String(e.message)});console.error('FAIL',name,String(e.message));}}
try{
 await check('Public website typography',async()=>{await measure('Public website','/');await page.screenshot({path:path.join(output,report.phase+'-public.png')});});
 await check('AI Control Center typography and categories',async()=>{
  await measure('AI Control Center','/console/admin/agents');
  if(!before){await page.getByText('Manage and oversee the intelligent workflows powering Cardboard Package, bringing supplier operations, inventory intelligence and business automation together in one place.',{exact:true}).waitFor();for(const label of ['Total agents','Running now','Demo / planned'])assert.equal(await page.getByText(label,{exact:true}).count(),0);for(const [tab,n] of [['Supplier',4],['Buyer',4],['Operations',2]]){await page.getByRole('tab',{name:`${tab} (${n})`,exact:true}).click();assert.equal(await page.getByTestId('agent-card').count(),n);}await page.getByRole('tab',{name:'Supplier (4)',exact:true}).click();await page.locator('#agent-cards[aria-labelledby="tab-Supplier"]').waitFor();await page.waitForTimeout(300);}
  await page.screenshot({path:path.join(output,report.phase+'-control-center.png'),fullPage:true});
 });
 if(!before){
  await check('All four implemented supplier dashboards retain their interfaces',async()=>{
   for(const [id,title] of [['supplier-discovery','Supplier Discovery'],['supplier-qualification','Supplier Verification & Market Prices'],['supplier-catalog','Supplier Catalog Intake'],['supplier-stock','Supplier Stock Monitor']]){
    await measure(id,'/console/admin/agents/'+id);assert.equal(await page.getByRole('heading',{name:'Dashboard preview',exact:true}).count(),0);await page.getByRole('heading',{name:title,exact:true}).waitFor();
    if(id==='supplier-catalog')for(const tab of ['Overview','Catalog Imports','Product Review','Supplier Catalog']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();}
    if(id==='supplier-stock')for(const tab of ['Overview','Suppliers','Stock Requests','Supplier Inbox','Inventory Changes','Follow-Ups','Agent Activity','Settings']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('tabpanel',{name:tab,exact:true}).waitFor();}
   }
  });
  await check('Inventory, buyer and operations typography',async()=>{for(const [name,url] of [['Admin overview','/console'],['Inventory','/console/inventory'],['Buyers','/console/buyers'],['Operations','/console/admin/agents/ops-pricing']])await measure(name,url);});
 }
 if(!before) await check('Mobile public website and supplier dashboards',async()=>{await page.setViewportSize({width:390,height:844});for(const [name,url] of [['Mobile public','/'],['Mobile catalog','/console/admin/agents/supplier-catalog'],['Mobile stock','/console/admin/agents/supplier-stock']])await measure(name,url);});
 await check('Desktop and mobile Control Center readability',async()=>{await page.setViewportSize({width:390,height:844});await measure('Mobile Control Center','/console/admin/agents');await page.screenshot({path:path.join(output,report.phase+'-mobile.png'),fullPage:true});});
 await check('Login typography without authentication changes',async()=>{
  const guest=await browser.newContext({viewport:{width:390,height:844}}),login=await guest.newPage();await login.goto('http://localhost:3000/console/login');await login.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await login.evaluate(()=>document.fonts.ready);
  report.login_style=await login.locator('h1').evaluate(e=>({family:getComputedStyle(e).fontFamily,weight:getComputedStyle(e).fontWeight,overflow:document.documentElement.scrollWidth>innerWidth}));
  if(!before){assert.match(report.login_style.family,/inter/i);assert.equal(report.login_style.weight,'600');assert.equal(report.login_style.overflow,false);}
  await login.screenshot({path:path.join(output,report.phase+'-login.png'),fullPage:true});await guest.close();
 });
 if(!before){assert.equal(report.font_requests.some(u=>u.includes('googleapis')||u.includes('gstatic')),false);assert.equal(report.errors.length,0);}
}finally{db.close();await browser.close();fs.writeFileSync(path.join(output,report.phase+'-results.json'),JSON.stringify(report,null,2));}
if(report.checks.some(x=>x.status==='FAIL')||report.errors.length)process.exitCode=1;
