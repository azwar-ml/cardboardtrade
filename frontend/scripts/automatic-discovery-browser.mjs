import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const dir = process.env.TRADE_DATA_DIR;
if (!dir || !path.basename(dir).startsWith('.qa-') || process.env.AUTOMATIC_PROVIDER_TEST_MODE !== 'mock') throw new Error('Use a disposable QA database and explicitly acknowledge mocked DuckDuckGo responses');
const report = { duckduckgo_search: 'MOCKED - live DuckDuckGo NOT VERIFIED', page_crawling: 'REAL PUBLIC WEBSITE', checks: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const api = async (route, body) => {
  const response = await context.request[body === undefined ? 'get' : 'post'](`${base}/api/console/discovery/${route}`, body === undefined ? {} : { data: body });
  const data = await response.json(); assert.ok(response.ok(), JSON.stringify(data)); return data;
};
const agent = page.locator('[data-agent-id="supplier-discovery"]');
await page.goto(`${base}/console/login`);
await page.getByLabel('Email').fill('admin@qa.invalid'); await page.getByLabel('Password').fill('qa-admin-pass');
await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForURL(/\/console$/);
await page.goto(`${base}/console/admin/agents/supplier-discovery`);
await agent.getByText('Paused', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.getByLabel('Research product', { exact: true }).fill('corrugated');
await page.getByLabel('Research city', { exact: true }).fill('Lahore');
await page.getByLabel('Research keywords', { exact: true }).fill('manufacturer');
assert.equal(await page.getByLabel('Public supplier website', { exact: false }).inputValue(), '');
assert.equal(await agent.getByRole('button', { name: 'Run Now', exact: true }).isEnabled(), true);
await agent.getByRole('button', { name: 'Check account (free)', exact: true }).click();
await agent.getByRole('status').filter({ hasText: 'SerpApi account checked' }).waitFor();
const started = page.waitForResponse((r) => r.url().endsWith('/api/console/discovery/jobs') && r.request().method() === 'POST');
await agent.getByRole('button', { name: 'Run Now', exact: true }).click();
const response = await started; assert.equal(response.status(), 202); const { id } = await response.json();
let job;
for (let i = 0; i < 100; i++) { job = await api(`jobs/${id}`); if (!['Running', 'Queued'].includes(job.status)) break; await page.waitForTimeout(500); }
assert.equal(job.status, 'Completed', JSON.stringify(job));
assert.equal(job.search_results.length, 2); assert.equal(job.found + job.duplicates, 1);
assert.ok(job.attempts.some((a) => a.url.includes('127.0.0.1') && a.status === 'Skipped' && /Private/.test(a.detail)));
await page.reload(); await agent.getByRole('button', { name: 'Corruboard Industries', exact: true }).click();
const detail = page.getByRole('dialog', { name: 'Supplier details' });
await detail.getByRole('heading', { name: 'Sources and evidence' }).waitFor();
assert.ok(await detail.locator('a[href="https://www.cbi.com.pk/"]').count() > 0);
report.checks.push({ name: 'Automatic criteria-only discovery, guarded live website extraction and reload persistence', status: 'PASS' });
console.log('PASS automatic search workflow with mocked DuckDuckGo response and real permitted website crawling');

await page.getByRole('button', { name: 'Close details' }).click();
await page.getByRole('button', { name: 'Settings', exact: true }).click();
// Exercise actual elapsed-time scheduling twice. No clock patch or manual job trigger.
await page.getByLabel('Scheduled product', { exact: true }).fill('corrugated');
await page.getByLabel('Scheduled city', { exact: true }).fill('Lahore');
await page.getByLabel('Scheduled keywords', { exact: true }).fill('manufacturer');
await page.getByLabel('Interval (minutes)', { exact: true }).fill('1');
await page.getByLabel('Enable recurring research', { exact: true }).check();
await agent.getByRole('button', { name: 'Save schedule', exact: true }).click();
await agent.getByRole('status').filter({ hasText: 'Recurring discovery settings saved' }).waitFor();
const saved = await api('summary'); assert.equal(saved.schedule.status, 'Scheduled'); assert.ok(saved.schedule.next_run_at);
console.log(`Schedule saved; waiting for two real timer-driven runs. First due: ${saved.schedule.next_run_at}`);
const scheduledIds = new Set(); const runningIds = new Set(); let overlapChecked = false;
for (let i = 0; i < 340; i++) {
  const jobs = (await api('jobs')).items.filter((j) => j.trigger_type === 'Scheduled');
  for (const entry of jobs) {
    if (entry.status === 'Running' && !runningIds.has(entry.id)) { runningIds.add(entry.id); console.log(`Scheduled job #${entry.id} running: ${entry.stage}`); }
    if (entry.status === 'Running' && !overlapChecked) {
      const overlapping = await context.request.post(`${base}/api/console/discovery/jobs`, { data: { mode: 'automatic', product: 'corrugated' } });
      assert.equal(overlapping.status(), 409); overlapChecked = true;
    }
    if (entry.status === 'Completed' && !scheduledIds.has(entry.id)) { scheduledIds.add(entry.id); console.log(`Scheduled job #${entry.id} completed: ${entry.duplicates} duplicates, ${entry.failed} failures`); }
    if (entry.status === 'Failed') throw new Error(JSON.stringify(entry));
  }
  if (scheduledIds.size >= 2) break;
  await page.waitForTimeout(500);
}
assert.equal(scheduledIds.size, 2, 'Two actual scheduled jobs must complete');
// The SQLite one-job constraint is separately tested; cooldown-only jobs may finish between polls.
for (const jobId of scheduledIds) {
  const scheduled = await api(`jobs/${jobId}`);
  assert.equal(scheduled.filters.city, 'Lahore'); assert.equal(scheduled.filters.product, 'corrugated');
  assert.equal(scheduled.filters.keywords, 'manufacturer'); assert.equal(scheduled.duplicates, 0); assert.ok(scheduled.search_results.some(r => /cooldown/.test(r.disposition)));
}
assert.equal((await api('leads?q=Corruboard')).total, 1);
await agent.getByRole('button', { name: 'Pause Automation', exact: true }).click();
await agent.getByRole('status').filter({ hasText: 'Schedule paused' }).waitFor();
await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('region', { name: 'Recurring discovery' }).getByText(/Status: Disabled/).waitFor();
const disabled = await api('summary'); assert.equal(disabled.schedule.next_run_at, null);
report.checks.push({ name: 'Two real timer-driven scheduled jobs retain filters and prevent overlapping/duplicate leads; disable persists', status: 'PASS' });
report.scheduled_job_ids = [...scheduledIds];

fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
await page.screenshot({ path: path.join(dir, 'screenshots/automatic-and-schedule.png'), fullPage: true });
fs.writeFileSync(path.join(dir, 'automatic-browser-results.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));
