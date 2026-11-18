import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:3012';
const directory = process.env.TRADE_DATA_DIR;
if (!directory || !path.basename(directory).startsWith('.qa-')) throw new Error('Use disposable QA data');
const report = { providers: 'MOCKED fixtures. Zero live search or Gemini requests.', checks: [], browser_errors: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();
page.on('pageerror', error => report.browser_errors.push(error.message));

async function check(name, fn) {
  try { await fn(); report.checks.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch (error) { report.checks.push({ name, status: 'FAIL', error: String(error.stack || error) }); console.error('FAIL', name, error); }
}

await check('Public access requires authentication', async () => {
  assert.equal((await context.request.get(`${base}/api/console/qualification/summary`)).status(), 401);
});
await check('Admin opens live Agent #2 and evaluates Agent #1 supplier evidence', async () => {
  await page.goto(`${base}/console/login`);
  await page.getByLabel('Email').fill('admin@qa.invalid');
  await page.getByLabel('Password').fill('qa-admin-pass');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/console$/);
  await page.goto(`${base}/console/admin/agents/supplier-qualification`);
  await page.getByRole('heading', { name: 'Supplier Verification & Market Prices' }).waitFor();
  await page.getByRole('button', { name: 'Evaluate Now' }).click();
  await page.getByRole('button', { name: 'QA Fixture Packaging', exact: true }).waitFor();
  await page.getByRole('button', { name: 'QA Fixture Packaging', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Supplier evaluation details' });
  await dialog.getByText('AI analysis unavailable', { exact: true }).waitFor();
  await dialog.getByText('Evidence sources (1)', { exact: true }).click();
  await dialog.getByText('Supplier claim', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, 'verification-desktop.png'), fullPage: true });
  await dialog.getByLabel('Review note').fill('QA reviewed source evidence, documents still required.');
  await dialog.getByRole('button', { name: 'Documents Requested', exact: true }).click();
  await dialog.getByRole('heading', { name: /Admin review · Documents Requested/ }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});
await check('Market tab shows honest empty data and completes source research', async () => {
  await page.getByRole('tab', { name: 'Market Prices', exact: true }).click();
  await page.getByText(/Insufficient Comparable Data\. Research permitted public pages/).waitFor();
  await page.getByText('Research market sources', { exact: true }).click();
  await page.getByLabel('Product research query', { exact: true }).fill('kraft carton');
  await page.getByRole('button', { name: 'Research Sources', exact: true }).click();
  await page.getByText('QA fixture kraft carton', { exact: true }).first().waitFor();
});
await check('Specification-aware wholesale comparison excludes incompatible products', async () => {
  const spec = { 'Packaging type': 'carton', 'Dimensions in mm (L × W × H)': '100 x 200 x 300', Material: 'kraft', Flute: 'B', Ply: '3', Printing: 'none', Finishing: 'none' };
  for (const [label, value] of Object.entries(spec)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Compare Prices', exact: true }).click();
  await page.getByRole('heading', { name: 'Comparable Data Available', exact: true }).waitFor();
  await page.getByText(/PKR 10(?:\.0+)? – 12(?:\.0+)?/).waitFor();
  await page.screenshot({ path: path.join(directory, 'market-desktop.png'), fullPage: true });
  await page.getByLabel('Ply', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Compare Prices', exact: true }).click();
  await page.getByRole('heading', { name: 'Insufficient Comparable Data', exact: true }).waitFor();
  await page.getByText('Excluded references (2)', { exact: true }).click();
  await page.getByText('Different specification ply', { exact: true }).first().waitFor();
});
await check('Mobile tabs and layout remain usable', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Supplier Verification', exact: true }).click();
  assert.ok(await page.getByRole('button', { name: 'Evaluate Now', exact: true }).isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(directory, 'verification-mobile.png'), fullPage: true });
});
await check('Other eight agent dashboards remain Demo and Agent #1 is live', async () => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`${base}/console/admin/agents`);
  assert.equal(await page.locator('[data-agent-id="supplier-qualification"]').getByText('Live', { exact: true }).count(), 1);
  for (const id of ['supplier-catalog', 'supplier-stock', 'buyer-discovery', 'buyer-intent', 'buyer-matching', 'buyer-rfq', 'ops-pricing', 'ops-compliance']) {
    await page.goto(`${base}/console/admin/agents/${id}`);
    await page.getByText('Demo', { exact: true }).waitFor();
  }
  await page.goto(`${base}/console/admin/agents/supplier-discovery`);
  await page.getByRole('button', { name: 'Run Now', exact: true }).waitFor();
});
await check('Sales cannot read or write qualification API', async () => {
  const sales = await browser.newContext();
  const salesPage = await sales.newPage();
  await salesPage.goto(`${base}/console/login`);
  await salesPage.getByLabel('Email').fill('sales@qa.invalid');
  await salesPage.getByLabel('Password').fill('qa-sales-pass');
  await salesPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await salesPage.waitForURL(/\/console$/);
  assert.equal((await sales.request.get(`${base}/api/console/qualification/summary`)).status(), 403);
  assert.equal((await sales.request.post(`${base}/api/console/qualification/automation`, { data: { enabled: true } })).status(), 403);
  await sales.close();
});
await check('Browser remains free of JavaScript errors', async () => assert.deepEqual(report.browser_errors, []));
fs.writeFileSync(path.join(directory, 'qualification-browser-results.json'), JSON.stringify(report, null, 2));
await browser.close();
if (report.checks.some(check => check.status === 'FAIL')) process.exitCode = 1;
