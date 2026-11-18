import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const dataDir = process.env.TRADE_DATA_DIR;
if (!dataDir || !path.basename(dataDir).startsWith('.qa-')) throw new Error('Use the disposable QA database from the real discovery browser run');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const checks = [];
async function check(name, action) {
  try { await action(); checks.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch (error) { checks.push({ name, status: 'FAIL', error: String(error.stack ?? error) }); console.error('FAIL', name, error); }
}
await page.goto(`${base}/console/login`);
await page.getByLabel('Email').fill('admin@qa.invalid');
await page.getByLabel('Password').fill('qa-admin-pass');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/console$/);
const agent = page.locator('[data-agent-id="supplier-discovery"]');
await check('Unavailable status and Retry recover through the real API after network fault injection', async () => {
  // Only the failure is injected; recovery reads the real backend and persisted suppliers.
  await page.route('**/api/console/discovery/summary', (route) => route.abort('connectionrefused'));
  await page.goto(`${base}/console/admin/agents/supplier-discovery`);
  await agent.getByText('Error', { exact: true }).waitFor();
  await agent.getByRole('alert').filter({ hasText: 'Cannot reach Supplier Discovery' }).waitFor();
  assert.equal(await agent.getByRole('button', { name: 'Run Now', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(dataDir, 'screenshots/unavailable.png'), fullPage: true });
  await page.unroute('**/api/console/discovery/summary');
  await agent.getByRole('button', { name: 'Retry' }).click();
  await agent.getByText('Paused', { exact: true }).waitFor();
  await agent.getByRole('button', { name: 'Corruboard Industries', exact: true }).waitFor();
  assert.equal(await agent.getByRole('alert').count(), 0);
});
await check('Real backend URL rejection stays visible across polling; explicit Retry clears the action error', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Public supplier website', { exact: false }).fill('http://127.0.0.1/');
  await page.getByLabel('I have permission to research this public website and have checked its terms.').check();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/console/discovery/jobs') && r.request().method() === 'POST');
  await agent.getByRole('button', { name: 'Run Now', exact: true }).click();
  assert.equal((await response).status(), 422);
  await agent.getByRole('alert').filter({ hasText: 'Invalid public source URL' }).waitFor();
  await agent.getByText('Error', { exact: true }).waitFor();
  await page.waitForTimeout(5500);
  assert.match(await agent.getByRole('alert').innerText(), /Invalid public source URL/);
  await agent.getByRole('button', { name: 'Retry' }).click();
  await agent.getByText('Paused', { exact: true }).waitFor();
  assert.equal(await agent.getByRole('alert').count(), 0);
  await page.getByLabel('Public supplier website', { exact: false }).fill('');
});
await check('Admin opens real evidence, a duplicate vendor match, and recorded research attempts', async () => {
  const db = new Database(path.join(dataDir, 'trade.db'));
  db.prepare("INSERT OR IGNORE INTO vendors(code,name,website,notes) VALUES('QA-CBI-MATCH','QA Synthetic Website Match','https://www.cbi.com.pk/','Isolated QA duplicate fixture; not a verified vendor')").run();
  db.close();
  await agent.getByRole('button', { name: 'Corruboard Industries', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Supplier details' });
  await detail.getByRole('heading', { name: 'Sources and evidence' }).waitFor();
  await detail.getByText(/QA Synthetic Website Match/).waitFor();
  await detail.getByRole('heading', { name: 'Research and review history' }).waitFor();
  assert.ok(await detail.locator('a[href="https://www.cbi.com.pk/"]').count() > 0);
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await agent.getByRole('button', { name: /View job #/ }).first().click();
  const job = page.getByRole('region', { name: 'Research job details' });
  await job.getByRole('heading', { name: /Completed/ }).waitFor();
  assert.ok(await job.locator('a[href="https://www.cbi.com.pk/"]').count() > 0);

  await page.screenshot({ path: path.join(dataDir, 'screenshots/integration-ready.png'), fullPage: true });
});
await browser.close();
fs.writeFileSync(path.join(dataDir, 'integration-browser-results.json'), JSON.stringify(checks, null, 2));
if (checks.some((c) => c.status === 'FAIL')) process.exitCode = 1;
