import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const apiRoot = process.env.AGENTS_API_URL ?? 'http://127.0.0.1:8000';
const dataDir = process.env.TRADE_DATA_DIR;
if (!dataDir || !path.basename(dataDir).startsWith('.qa-')) throw new Error('Use a disposable .qa- data directory');
const report = { checks: [], discoveries: 0, duplicates: 0, failures: 0 };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const api = async (url, body) => {
  const response = await context.request[body === undefined ? 'get' : 'post'](`${base}/api/console/discovery/${url}`, body === undefined ? {} : { data: body });
  const payload = await response.json();
  assert.ok(response.ok(), `${response.status()}: ${JSON.stringify(payload)}`);
  return payload;
};
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch (err) { report.checks.push({ name, status: 'FAIL', error: String(err.stack ?? err) }); console.error('FAIL', name, err); }
}
let leadId;
await check('Public and Sales cannot access discovery contacts or controls', async () => {
  assert.equal((await fetch(`${apiRoot}/api/v1/discovery/leads`)).status, 401);
  assert.equal((await fetch(`${base}/api/console/discovery/summary`)).status, 401);
  const sales = await browser.newContext(); const p = await sales.newPage();
  await p.goto(`${base}/console/login`); await p.getByLabel('Email').fill('sales@qa.invalid'); await p.getByLabel('Password').fill('qa-sales-pass');
  await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForURL(/\/console$/);
  assert.equal((await sales.request.get(`${base}/api/console/discovery/leads`)).status(), 403);
  assert.equal((await sales.request.post(`${base}/api/console/discovery/jobs`, { data: {} })).status(), 403);
  await sales.close();
});
await check('Admin logs in and runs genuine permitted supplier discovery', async () => {
  await page.goto(`${base}/console/login`); await page.getByLabel('Email').fill('admin@qa.invalid'); await page.getByLabel('Password').fill('qa-admin-pass');
  await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForURL(/\/console$/);
  await page.goto(`${base}/console/admin/agents/supplier-discovery`);
  await page.getByRole('button', { name: 'Run Now', exact: true }).waitFor({ state: 'visible' });
  const run = page.getByRole('button', { name: 'Run Now', exact: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Research product', { exact: true }).fill('corrugated');
  await page.getByLabel('Research city', { exact: true }).fill('Lahore');
  await page.getByLabel('Public supplier website', { exact: false }).fill('https://www.cbi.com.pk/');
  assert.equal(await run.isDisabled(), true, 'New public sources require permission');
  await page.getByLabel('I have permission to research this public website and have checked its terms.').check();
  const started = page.waitForResponse((r) => r.url().endsWith('/api/console/discovery/jobs') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  const startResponse = await started;
  assert.equal(startResponse.status(), 202, await startResponse.text());
  await page.getByRole('status').filter({ hasText: /Research job #/ }).waitFor();
  let summary;
  for (let i = 0; i < 90; i++) { summary = await api('summary'); if (!summary.active) break; await page.waitForTimeout(500); }
  assert.equal(summary.active, false);
  assert.equal(summary.web_discoveries, 1);
  report.discoveries = summary.web_discoveries;
  const leads = await api('leads?q=Corruboard'); assert.equal(leads.total, 1); leadId = leads.items[0].id;
  assert.equal(leads.items[0].company, 'Corruboard Industries'); assert.equal(leads.items[0].status, 'Pending Review');
  await page.reload();
  await page.getByRole('button', { name: 'Corruboard Industries', exact: true }).waitFor();
});
await check('Evidence source URLs, public business contacts and timestamps appear in Admin', async () => {
  await page.getByRole('button', { name: 'Corruboard Industries', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Supplier details' });
  await detail.getByRole('heading', { name: 'Sources and evidence' }).waitFor();
  await detail.getByText(/info@cbi.com.pk/).first().waitFor();
  const links = detail.locator('a[href="https://www.cbi.com.pk/"]'); assert.ok(await links.count() >= 2);
  assert.equal(await links.first().getAttribute('target'), '_blank');
  const data = await api(`leads/${leadId}`); assert.ok(data.sources[0].accessed_at); assert.ok(data.sources[0].evidence.snippets.length);
  fs.mkdirSync(path.join(dataDir, 'screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(dataDir, 'screenshots/evidence.png'), fullPage: true });
});
await check('Repeat real discovery is idempotent and records a duplicate attempt', async () => {
  const { id } = await api('jobs', { seed_urls: ['https://www.cbi.com.pk/'], source_permission_confirmed: true });
  let job;
  for (let i = 0; i < 90; i++) { job = await api(`jobs/${id}`); if (!['Queued', 'Running'].includes(job.status)) break; await page.waitForTimeout(500); }
  assert.equal(job.status, 'Completed'); assert.equal(job.duplicates, 1);
  assert.equal((await api('leads?q=Corruboard')).total, 1);
});
await check('Existing I want to sell form stores enquiry, permitted attachment and linked discovery lead', async () => {
  await page.goto(`${base}/#contact`);
  await page.getByText('I want to sell', { exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('QA'); await page.getByLabel('Last name', { exact: true }).fill('Supplier');
  await page.getByLabel('Work email', { exact: true }).fill('qa-seller@qa.invalid');
  await page.getByLabel('Company', { exact: true }).fill('QA Isolated Seller Discovery');
  await page.getByLabel('Country', { exact: true }).selectOption('Pakistan');
  await page.getByLabel('What do you make?', { exact: true }).fill('QA fixture only. Corrugated cartons in Lahore. Do not contact.');
  await page.locator('input[type="file"]').setInputFiles({ name: 'qa-stock.csv', mimeType: 'text/csv', buffer: Buffer.from('product,quantity\nQA cartons,10\n') });
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('heading', { name: 'Request received.' }).waitFor();
  const ref = (await page.getByRole('status').innerText()).match(/CP-[A-Z0-9-]+/)[0];
  const records = await api('leads?q=QA Isolated Seller Discovery'); assert.equal(records.total, 1);
  const detail = await api(`leads/${records.items[0].id}`);
  assert.equal(detail.source_type, 'Website Submission'); assert.equal(detail.sources[0].enquiry_id, ref);
  assert.equal(detail.sources[0].evidence.attachments.length, 1);
  const d = new Database(path.join(dataDir, 'trade.db'), { readonly: true });
  assert.equal(d.prepare('SELECT company FROM enquiries WHERE id=?').get(ref).company, 'QA Isolated Seller Discovery'); d.close();
  await page.goto(`${base}/console/admin/agents/supplier-discovery`); await page.getByRole('button', { name: 'QA Isolated Seller Discovery', exact: true }).click();
  await page.getByRole('link', { name: ref, exact: true }).waitFor();
  const attachment = page.getByRole('link', { name: /Attachment: .*qa-stock.csv/ });
  assert.equal((await context.request.get(new URL(await attachment.getAttribute('href'), base).href)).status(), 200);
  await page.screenshot({ path: path.join(dataDir, 'screenshots/seller.png'), fullPage: true });
});
await check('Cross-source duplicate preserves original submissions and review actions', async () => {
  for (let i = 0; i < 2; i++) {
    const data = { firstName: 'QA', lastName: 'Duplicate', email: 'qa-cross-source@qa.invalid', company: 'Corruboard Industries', country: 'Pakistan', subject: 'Selling request', product: 'Corrugated cartons', message: 'Isolated QA duplicate test. Not a real supplier submission. Do not contact.' };
    assert.equal((await context.request.post(`${base}/api/request`, { multipart: data })).status(), 200);
  }
  const records = await api('leads?q=Corruboard'); assert.equal(records.total, 1);
  const detail = await api(`leads/${leadId}`);
  assert.equal(detail.sources.filter((s) => s.source_type === 'Website Submission').length, 2);
  assert.equal(detail.email, 'info@cbi.com.pk');
  await page.goto(`${base}/console/admin/agents/supplier-discovery`); await page.getByRole('button', { name: 'Corruboard Industries', exact: true }).click();
  await page.getByLabel('Review note', { exact: true }).fill('QA reviewed evidence only; unverified supplier.');
  await page.getByRole('button', { name: 'Approve for qualification', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Review saved' }).waitFor();
  assert.equal((await api(`leads/${leadId}`)).status, 'Reviewed');
  await page.getByRole('button', { name: 'Return to pending', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Review saved' }).waitFor();
  assert.equal((await api(`leads/${leadId}`)).status, 'Pending Review');
});
await check('Discovery filters, pagination and detail dashboard', async () => {
  assert.equal((await api('leads?city=Karachi')).total, 0);
  assert.equal((await api('leads?page_size=1')).items.length, 1);

  assert.equal(await page.locator('[data-testid="agent-dashboard"]').count(), 1);
  const summary = await api('summary'); report.duplicates = summary.duplicates;
  const jobs = await api('jobs'); report.failures = jobs.items.reduce((n, j) => n + j.failed, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
});
await browser.close();
fs.writeFileSync(path.join(dataDir, 'discovery-browser-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((c) => c.status === 'FAIL')) process.exitCode = 1;
