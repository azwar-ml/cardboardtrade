import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const dataDir = process.env.TRADE_DATA_DIR;
if (!dataDir) throw new Error("Set TRADE_DATA_DIR to the fresh disposable QA database directory.");
const checks = [];
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let fixture;
async function check(name, fn) {
  try { await fn(); checks.push([name, "PASS"]); console.log(`PASS ${name}`); }
  catch (error) { checks.push([name, "FAIL"]); console.error(`FAIL ${name}: ${error?.stack ?? error}`); }
}
const browser = await chromium.launch({ headless: true });
const admin = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await admin.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await check("FastAPI health and mixed agent catalog", async () => {
  const health = await fetch(`${process.env.AGENTS_API_URL ?? "http://127.0.0.1:8000"}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const response = await fetch(`${process.env.AGENTS_API_URL ?? "http://127.0.0.1:8000"}/api/v1/agents`);
  const payload = await response.json();
  assert.equal(payload.agents.length, 10);
  assert.equal(payload.agents.filter((a) => a.group === "supplier").length, 4);
  assert.equal(payload.agents.filter((a) => a.group === "buyer").length, 4);
  assert.equal(payload.agents.filter((a) => a.group === "shared").length, 2);
});

await check("public site and email-only enquiry flow", async () => {
  const response = await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  const submissions = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const fd = new FormData();
    fd.set("firstName", `QA${runId}-${i}`); fd.set("lastName", "Browser"); fd.set("email", `qa-${runId}-${i}@qa.invalid`);
    fd.set("company", `Disposable QA Company ${runId}-${i}`); fd.set("country", "QA only"); fd.set("message", `Isolated browser submission ${i}`);
    return fetch(`${base}/api/request`, { method: "POST", body: fd });
  }));
  const records = await Promise.all(submissions.map(async (r) => { assert.equal(r.status, 200); return r.json(); }));
  assert.equal(new Set(records.map((r) => r.id)).size, 10);
  const d = new Database(path.join(dataDir, "trade.db"), { readonly: true });
  const count = d.prepare("SELECT count(*) n FROM enquiries WHERE first_name LIKE ? AND company LIKE ? AND callback=0").get(`QA${runId}-%`, `Disposable QA Company ${runId}-%`).n;
  d.close();
  assert.equal(count, 10, "the fresh disposable database should contain exactly these ten parallel requests");
});

await check("anonymous admin redirect", async () => {
  const response = await page.goto(`${base}/console/admin/agents`, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  assert.match(page.url(), /\/console\/login/);
});

await check("Admin login and main-screen Control Center button", async () => {
  await page.getByLabel("Email").fill(process.env.ADMIN_EMAIL ?? "admin@qa.invalid");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "qa-admin-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/console$/);
  await page.getByRole("link", { name: "Open AI Control Center" }).waitFor();
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
});

await check("synthetic inventory, recipients and duplicate supplier listings are isolated", async () => {
  const d = new Database(path.join(dataDir, "trade.db"));
  fixture = d.transaction(() => {
    const vendorId = Number(d.prepare("INSERT INTO vendors(code,name,legal_name,city,business_type,product_lines,sources,status) VALUES(?,?,?,?,?,?,?,?)").run("QASUP", "QA Synthetic Supplier", "QA Synthetic Supplier LLC", "Lahore", "manufacturer", '["Pizza"]', '["fixture only"]', "active").lastInsertRowid);
    d.prepare("INSERT INTO freight_lanes(code,port,country,region,rate_40hc_usd,transit_days) VALUES('AEJEA','Jebel Ali','UAE','Middle East',1500,14)").run();
    const insertUpload = d.prepare("INSERT INTO uploads(vendor_id,status,rows_total,rows_ok,created_at,published_at) VALUES(?,'published',1,1,datetime('now'),datetime('now'))");
    const insertItem = d.prepare(`INSERT INTO items(ref,vendor_id,upload_id,vendor_sku,line,family,description,style,choice,ply,flute,board,gsm,length_mm,width_mm,height_mm,dim_type,print,coating,qty,moq,price,currency,price_pkr,price_source,cbm_per_1000,kg_per_1000,location,status,created_at)
      VALUES(?,?,?,?,?,'Food & Beverages',?,'Pizza box','1st','3','E','QA-FLUTE-MATERIAL',300,300,300,40,'Internal','Plain','None',1500,100,0.5,'USD',140,'vendor',0.5,430,'Lahore','online',datetime('now'))`);
    const uploadIds = [];
    for (let i = 1; i <= 2; i++) {
      const uploadId = Number(insertUpload.run(vendorId).lastInsertRowid); uploadIds.push(uploadId);
      insertItem.run(`QA-LOT-${i}`, vendorId, uploadId, `QA-SKU-SECRET-${i}`, "Pizza", `QA Synthetic Supplier source USD 999.99 cost: 999.99 vendor price: 999.99 QASUP QA-SKU-SECRET-${i}`);
    }
    const insertBuyer = d.prepare("INSERT INTO buyers(name,country,city,port_code,industry,interests,choice_pref,min_order_pcs,incoterm,language,status,is_demo) VALUES(?, 'QA only', 'QA City', 'AEJEA', 'QA fixture', '[\"Pizza\"]', 'mixed', 100, 'CFR', 'EN', ?, 1)");
    const insertContact = d.prepare("INSERT INTO contacts(buyer_id,name,title,email,language,register,bounce,primary_contact) VALUES(?,?,NULL,?,'EN','Formal',?,1)");
    const outboxBuyer = Number(insertBuyer.run("QA Outbox Recipient", "active").lastInsertRowid);
    const outboxContact = Number(insertContact.run(outboxBuyer, "Test Recipient", "qa-outbox@qa.invalid", "none").lastInsertRowid);
    const blockedBuyer = Number(insertBuyer.run("QA Blocked Recipient", "blocked").lastInsertRowid);
    insertContact.run(blockedBuyer, "Blocked Recipient", "qa-blocked@qa.invalid", "none");
    const bouncedBuyer = Number(insertBuyer.run("QA Bounced Recipient", "active").lastInsertRowid);
    insertContact.run(bouncedBuyer, "Bounced Recipient", "qa-bounced@qa.invalid", "hard");
    const cappedBuyer = Number(insertBuyer.run("QA Seven Day Cap Recipient", "active").lastInsertRowid);
    const cappedContact = Number(insertContact.run(cappedBuyer, "Cap Recipient", "qa-cap@qa.invalid", "none").lastInsertRowid);
    const previous = Number(d.prepare("INSERT INTO sendouts(name,status,upload_ids,options,created_by,sender_id,sent_at) VALUES('QA prior send','sent',?,'{}',1,1,datetime('now'))").run(JSON.stringify(uploadIds)).lastInsertRowid);
    d.prepare("INSERT INTO sendout_messages(sendout_id,buyer_id,contact_id,item_ids,subject,body,status,sent_at) VALUES(?,?,?,?,? ,?,'outbox',datetime('now'))")
      .run(previous, cappedBuyer, cappedContact, "[]", "QA prior", "QA only");
    const blockedVendor = Number(d.prepare("INSERT INTO vendors(code,name,city,business_type,product_lines,sources,status) VALUES('QABLK','QA Blocked Supplier','Lahore','manufacturer','[\"Pizza\"]','[]','blocked')").run().lastInsertRowid);
    const parsed = [{ vendor_sku: "QA-BLOCKED-SKU", line: "Pizza", description: "QA blocked test", style: "Pizza box", choice: "1st", defects: null, ply: "3", flute: "E", board: "QA", gsm: null, length_mm: 300, width_mm: 300, height_mm: 40, dim_type: "Internal", print: "Plain", coating: "None", food_safe: false, qty: 1000, moq: 100, price: 1, currency: "USD", bundle_qty: null, bundle_l_cm: null, bundle_w_cm: null, bundle_h_cm: null, bundle_kg: null, location: "Lahore", lead_days: 0, valid_until: "", certifications: null, photos: false, notes: null, _ok: true }];
    const blockedUpload = Number(d.prepare("INSERT INTO uploads(vendor_id,status,transformed_file,transformed_sha,rows_total,rows_ok,rows_error,issues,parsed) VALUES(?,'checked','qa/blocked.csv',?,1,1,0,'[]',?)").run(blockedVendor, "a".repeat(64), JSON.stringify(parsed)).lastInsertRowid);
    return { vendorId, uploadIds, outboxBuyer, outboxContact, blockedUpload, blockedBuyer, blockedVendor };
  })();
  d.close();
  await page.goto(`${base}/console/inventory?view=specs&flute=E&material=QA-FLUTE-MATERIAL`, { waitUntil: "domcontentloaded" });
  const table = page.locator("table").first();
  const headers = await table.locator("thead th").allTextContents();
  const fluteColumn = headers.findIndex((header) => header.trim() === "Flute");
  assert.ok(fluteColumn >= 0, `Flute column missing from ${headers.join(", ")}`);
  const row = table.locator("tbody tr").filter({ hasText: "QA Synthetic Supplier" }).first();
  assert.equal((await row.locator("td").nth(fluteColumn).innerText()).trim(), "E");
  await page.getByRole("heading", { name: "Inventory" }).waitFor();
});

await check("blocked supplier upload cannot be published", async () => {
  await page.goto(`${base}/console/uploads/${fixture.blockedUpload}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Publishing is disabled because this supplier is blocked.").waitFor();
  assert.equal(await page.getByRole("button", { name: /Publish/ }).count(), 0);
});

await check("buyer blocking, bounce and seven-day cap are respected; duplicate listing selectors are unique", async () => {
  await page.goto(`${base}/console/sendouts/new`, { waitUntil: "domcontentloaded" });
  const selections = page.getByRole("checkbox", { name: /Select listing QA Synthetic Supplier, upload/ });
  assert.equal(await selections.count(), 2);
  const labels = await selections.evaluateAll((inputs) => inputs.map((el) => el.getAttribute("aria-label")));
  assert.equal(new Set(labels).size, 2);
  await selections.first().check();
  await page.getByRole("button", { name: "View matched buyers" }).click();
  await page.getByText("Blocked: no reason recorded").waitFor();
  await page.getByText(/No non-bounced email contact/).waitFor();
  await page.getByText(/inside the 7-day cap/).waitFor();
  await page.getByRole("button", { name: "Compose emails" }).click();
  await page.waitForURL(/\/compose$/);
  const preview = (await page.locator("pre").allTextContents()).join("\n");
  assert.doesNotMatch(preview, /QA Synthetic Supplier|QASUP|QA-SKU-SECRET|QA-COST-SECRET|999\.99/);
  await page.getByRole("link", { name: "Review & send" }).click();
  await page.waitForURL(/\/send$/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Send 1 emails" }).click();
  await page.waitForURL(/\/send$/);
  await page.getByText("in outbox", { exact: true }).waitFor();
  const d = new Database(path.join(dataDir, "trade.db"), { readonly: true });
  const message = d.prepare("SELECT * FROM sendout_messages WHERE buyer_id=? ORDER BY id DESC LIMIT 1").get(fixture.outboxBuyer);
  d.close();
  assert.equal(message.status, "outbox");
  assert.ok(message.attachment, "buyer-specific Excel attachment should be written");
  const eml = fs.readFileSync(path.join(dataDir, "outbox", message.eml_path), "utf8");
  assert.doesNotMatch(eml, /QA Synthetic Supplier|QASUP|QA-SKU-SECRET|QA-COST-SECRET|999\.99/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(dataDir, "files", message.attachment));
  const sheet = workbook.getWorksheet("Material list");
  const headings = sheet.getRow(4).values.slice(1).map(String);
  const cfrColumn = headings.findIndex((heading) => heading.startsWith("Price USD/pc CFR")) + 1;
  const actualOffer = Number(sheet.getRow(5).getCell(cfrColumn).value);
  const cbmPerPiece = 0.5 / 1000;
  const expectedFob = 0.5 + cbmPerPiece * (15 + 9);
  const expectedCfr = expectedFob + cbmPerPiece * (1500 / 68);
  const expectedOffer = Math.max(expectedCfr * 1.12, expectedCfr + 0.005);
  assert.equal(actualOffer, Number(expectedOffer.toFixed(3)), "buyer Excel must include the CFR freight build and configured margin");
  const text = workbook.worksheets.flatMap((ws) => ws.getSheetValues().flatMap((row) => Array.isArray(row) ? row : []).map(String)).join(" ");
  assert.match(text, /QA Outbox Recipient/);
  assert.doesNotMatch(text, /QA Synthetic Supplier|QASUP|QA-SKU-SECRET|QA-COST-SECRET|999\.99/);
});

await check("CSV supplier upload is checked and published without FX-corrupting its USD source price", async () => {
  await page.goto(`${base}/console/uploads/new?vendor=${fixture.vendorId}`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="raw"]').setInputFiles({ name: "qa-original.csv", mimeType: "text/csv", buffer: Buffer.from("Supplier's original disposable offer\n") });
  const csv = [
    "Supplier SKU,Product line,Description,Style,Choice,Defect notes,Ply,Flute,Board / liner build,Total GSM,Length mm,Width mm,Height mm,Dimension type,Print,Coating,Food safe (Y/N),Qty available pcs,MOQ pcs,Unit price,Currency,Pcs per bundle,Bundle L cm,Bundle W cm,Bundle H cm,Bundle weight kg,Stock location city,Lead time days,Price valid until,Certifications,Photos available (Y/N),Notes",
    "QA-UPLOAD-SKU,Pizza,QA upload test,Pizza box,1st,,3,E,QA,300,300,300,40,Internal,Plain,None,N,1200,100,0.5,USD,,,,,,Lahore,0,,,N,",
  ].join("\n");
  await page.locator('input[name="transformed"]').setInputFiles({ name: "qa-transformed.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.waitForURL(/\/console\/uploads\/\d+$/);
  await page.getByText("1 / 1 rows pass").waitFor();
  await page.getByRole("button", { name: "Publish 1 rows to inventory" }).click();
  await page.waitForURL(/\/console\/inventory/);
  const d = new Database(path.join(dataDir, "trade.db"), { readonly: true });
  const row = d.prepare("SELECT i.price,i.currency,i.price_pkr,i.price_source,u.status FROM items i JOIN uploads u ON u.id=i.upload_id WHERE i.vendor_sku='QA-UPLOAD-SKU'").get();
  d.close();
  assert.equal(row.status, "published");
  assert.equal(row.price, 0.5);
  assert.equal(row.currency, "USD");
  assert.equal(row.price_pkr, 140);
  assert.equal(row.price_source, "vendor");
});

await check("Sales cannot clear admin buyer blocks or change blocked supplier status", async () => {
  const sales = await browser.newContext();
  const p = await sales.newPage();
  await p.goto(`${base}/console/login`, { waitUntil: "domcontentloaded" });
  await p.getByLabel("Email").fill(process.env.SALES_EMAIL ?? "sales@qa.invalid");
  await p.getByLabel("Password").fill(process.env.SALES_PASSWORD ?? "qa-sales-pass");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/console$/);
  await p.goto(`${base}/console/buyers/${fixture.blockedBuyer}`, { waitUntil: "domcontentloaded" });
  await p.locator('select[name="status"]').selectOption("active");
  await p.getByRole("button", { name: "Save", exact: true }).click();
  await p.waitForTimeout(250);
  await p.goto(`${base}/console/vendors/${fixture.blockedVendor}`, { waitUntil: "domcontentloaded" });
  await p.locator('select[name="status"]').selectOption("active");
  await p.getByRole("button", { name: "Save", exact: true }).click();
  await p.waitForTimeout(250);
  const d = new Database(path.join(dataDir, "trade.db"), { readonly: true });
  const buyer = d.prepare("SELECT status FROM buyers WHERE id=?").get(fixture.blockedBuyer).status;
  const vendor = d.prepare("SELECT status FROM vendors WHERE id=?").get(fixture.blockedVendor).status;
  d.close();
  assert.equal(buyer, "blocked");
  assert.equal(vendor, "blocked");
  await sales.close();
});

await check("Admin supplier blocking takes existing inventory offline", async () => {
  await page.goto(`${base}/console/vendors/${fixture.vendorId}`, { waitUntil: "domcontentloaded" });
  await page.locator('select[name="status"]').selectOption("blocked");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(250);
  const d = new Database(path.join(dataDir, "trade.db"), { readonly: true });
  const status = d.prepare("SELECT status FROM vendors WHERE id=?").get(fixture.vendorId).status;
  const online = d.prepare("SELECT count(*) n FROM items WHERE vendor_id=? AND status='online'").get(fixture.vendorId).n;
  d.close();
  assert.equal(status, "blocked");
  assert.equal(online, 0);
});

await check("shared sidebar active, hover and keyboard states stay light", async () => {
  await page.goto(`${base}/console`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Open AI Control Center" }).click();
  await page.waitForURL(/\/console\/admin\/agents$/);
  await page.waitForFunction(() => {
    const marker = document.querySelector('[data-nav-active="true"] [data-testid="nav-active-indicator"]');
    return marker && getComputedStyle(marker).backgroundColor === "rgb(227, 91, 44)";
  });
  const active = page.locator('[data-testid="console-sidebar-navigation"] [data-nav-active="true"]');
  assert.equal(await active.count(), 1);
  const states = await active.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor }));
  assert.notEqual(states.bg, "rgb(14, 16, 19)");
  assert.equal(await active.locator('[data-testid="nav-active-indicator"]').evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(227, 91, 44)");
  await active.focus();
  await page.locator('[data-testid="console-sidebar-navigation"] a[href="/console/inventory"]').hover();
  const hover = await page.locator('[data-testid="console-sidebar-navigation"] a[href="/console/inventory"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(hover, "rgb(14, 16, 19)");
});

await check("AI Control Center tabs, compact cards and nine Demo detail dashboards", async () => {
  await page.getByRole("tab", { name: "Supplier (4)", exact: true }).click();
  assert.equal(await page.getByTestId("agent-card").count(), 4);
  await page.getByText("Total agents", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("agent-dashboard").count(), 0);
  const demoUrls = [];
  for (const [name, count] of [["Supplier (4)",4], ["Buyer (4)",4], ["Operations (2)",2]]) {
    await page.getByRole("tab", { name, exact: true }).click();
    assert.equal(await page.getByTestId("agent-card").count(), count);
    demoUrls.push(...await page.getByTestId("agent-card").evaluateAll((cards) => cards.filter((c) => c.dataset.agentId !== "supplier-discovery").map((c) => c.getAttribute("href"))));
  }
  assert.equal(demoUrls.length, 9);
  for (const url of demoUrls) {
    await page.goto(`${base}${url}`);
    await page.getByText("Demo", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Dashboard preview" }).waitFor();
  }
  await page.goto(`${base}/console/admin/agents/supplier-discovery`);
  await page.getByRole("button", { name: "Run Now", exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Discovery settings" }).isVisible(), false);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page.getByRole("heading", { name: "Research job history" }).waitFor();
});

await check("Admin pages and operator pages are reachable for Admin", async () => {
  for (const [url, title] of [["/console/admin/users", "Users"], ["/console/admin/pricing", "Pricing & Freight"], ["/console/inventory", "Inventory"], ["/console/uploads", "List Upload"], ["/console/vendors", "Vendors"], ["/console/buyers", "Buyers"], ["/console/enquiries", "Enquiries"], ["/console/sendouts", "Sendout Tracking"]]) {
    const response = await page.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200, url);
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
  }
});

await check("zero FX input is rejected without overwriting a valid rate", async () => {
  const d = new Database(path.join(dataDir, "trade.db"));
  d.prepare("INSERT INTO settings(key,value) VALUES('fx_pkr_per_usd','310') ON CONFLICT(key) DO UPDATE SET value='310'").run();
  d.close();
  await page.goto(`${base}/console/admin/pricing`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="fx_pkr_per_usd"]').fill("0");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(350);
  const read = new Database(path.join(dataDir, "trade.db"), { readonly: true });
  const fx = read.prepare("SELECT value FROM settings WHERE key='fx_pkr_per_usd'").get()?.value;
  read.close();
  assert.equal(fx, "310");
});

await check("mobile sidebar opens and closes without horizontal overflow", async () => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await mobile.newPage();
  await p.goto(`${base}/console/login`, { waitUntil: "domcontentloaded" });
  await p.getByLabel("Email").fill(process.env.ADMIN_EMAIL ?? "admin@qa.invalid");
  await p.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "qa-admin-pass");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/console$/);
  await p.getByRole("link", { name: "Open AI Control Center" }).click();
  const toggle = p.getByRole("button", { name: "Open navigation" });
  await toggle.click();
  const nav = p.getByTestId("console-sidebar-navigation");
  assert.equal(await nav.isVisible(), true);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await nav.getByRole("link", { name: "Inventory" }).click();
  await p.getByRole("heading", { name: "Inventory" }).waitFor({ state: "visible" });
  await mobile.close();
});

await check("Sales cannot open Admin pages", async () => {
  const sales = await browser.newContext();
  const p = await sales.newPage();
  await p.goto(`${base}/console/login`, { waitUntil: "domcontentloaded" });
  await p.getByLabel("Email").fill(process.env.SALES_EMAIL ?? "sales@qa.invalid");
  await p.getByLabel("Password").fill(process.env.SALES_PASSWORD ?? "qa-sales-pass");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/console$/);
  await p.goto(`${base}/console/admin/agents`, { waitUntil: "domcontentloaded" });
  await p.waitForURL(/denied=1/);
  await p.getByText("That page is for admins only.").waitFor();
  await sales.close();
});

await browser.close();
const passed = checks.filter(([, result]) => result === "PASS").length;
const failed = checks.length - passed;
console.log(`\nBrowser QA: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
