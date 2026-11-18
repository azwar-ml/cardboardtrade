import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const dir = process.env.TRADE_DATA_DIR;
if (!dir || !path.basename(dir).startsWith('.qa-') || process.env.AUTOMATIC_PROVIDER_TEST_MODE !== 'mock') throw new Error('Isolated QA and explicit mocked provider required');
const base = process.env.BASE_URL || 'http://localhost:3002';
const report = { provider: 'MOCKED; no live search credits', elapsed_time: '48-hour deadlines simulated in disposable SQLite', checks: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage();
const api = async (route, body) => {
  const response = await context.request[body === undefined ? 'get' : 'post'](`${base}/api/console/discovery/${route}`, body === undefined ? {} : { data: body });
  const data = await response.json(); assert.ok(response.ok(), JSON.stringify(data)); return data;
};
try {
  await page.goto(`${base}/console/login`);
  await page.getByLabel('Email').fill('admin@qa.invalid');
  await page.getByLabel('Password').fill('qa-admin-pass');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/console$/);
  await page.goto(`${base}/console/admin/agents/supplier-discovery`);
  await page.getByText('Paused', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Research product', { exact: true }).fill('carton');
  await page.getByLabel('Research city', { exact: true }).fill('Sialkot');
  await page.getByRole('button', { name: 'Resume Automation', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Automation resumed' }).waitFor();
  const initial = await api('summary');
  assert.equal(initial.schedule.interval_seconds, 172800);
  assert.equal(initial.schedule.rotation_enabled, true);
  assert.equal(initial.search_usage.used, 0);
  assert.equal((await api('jobs')).total, 0);
  assert.ok(Date.parse(initial.schedule.next_run_at) - Date.now() > 172790000);
  await page.getByText('Active', { exact: true }).waitFor();
  await page.getByText('2026-12-17', { exact: true }).waitFor();
  report.checks.push('PASS: Resume schedules 48 hours ahead without searching; subscription metadata visible');

  for (let index = 0; index < 2; index++) {
    const db = new Database(path.join(dir, 'trade.db'));
    db.prepare("UPDATE discovery_schedule SET next_run_at='2000-01-01T00:00:00.000Z'").run(); db.close();
    let jobs;
    for (let count = 0; count < 100; count++) {
      jobs = (await api('jobs')).items.filter(job => job.trigger_type === 'Scheduled');
      if (jobs.length > index && !['Queued', 'Running'].includes(jobs[0].status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(jobs.length, index + 1);
    assert.equal(jobs[0].status, 'Completed', JSON.stringify(jobs[0]));
    assert.equal(jobs[0].filters.rotation_index, index);
    assert.ok(Date.parse((await api('summary')).schedule.next_run_at) - Date.now() > 172790000);
  }
  assert.equal(await page.getByLabel('Research product', { exact: true }).inputValue(), 'carton');
  assert.equal(await page.getByLabel('Research city', { exact: true }).inputValue(), 'Sialkot');
  report.checks.push('PASS: two simulated-due background runs rotate criteria and preserve custom Run Now settings');

  await page.getByRole('button', { name: 'Pause Automation', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Schedule paused' }).waitFor();
  const paused = await api('summary');
  assert.equal(paused.schedule.enabled, false);
  assert.equal(paused.schedule.next_run_at, null);
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Research job #' }).waitFor();
  let manual;
  for (let count = 0; count < 100; count++) {
    manual = (await api('jobs')).items[0];
    if (!['Queued', 'Running'].includes(manual.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(manual.trigger_type, 'Manual');
  assert.equal(manual.filters.product, 'carton');
  assert.equal(manual.filters.city, 'Sialkot');
  assert.equal((await api('summary')).search_usage.used, 3);
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.locator('#discovery-History').getByText(/Automatic/).first().waitFor();
  await page.locator('#discovery-History').getByText(/Manual/).first().waitFor();
  report.checks.push('PASS: paused automation still permits manual research with the same budget and clearly labeled history');

  const db = new Database(path.join(dir, 'trade.db'));
  const setting = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'discovery.duckduckgo.%.budget'").get();
  const ledger = JSON.parse(setting.value); ledger.used = 20;
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(ledger), setting.key); db.close();
  await page.reload();
  await page.getByRole('status').filter({ hasText: /Local monthly DuckDuckGo search budget reached/ }).waitFor();
  assert.equal((await api('summary')).agent_status, 'Paused');
  const denied = await context.request.post(`${base}/api/console/discovery/schedule/resume`, { data: {} });
  assert.equal(denied.status(), 422);
  report.checks.push('PASS: insufficient-credit notification and shared 20-search budget block resumption without spending searches');
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(dir, 'screenshots/credit-pause.png'), fullPage: true });
  fs.writeFileSync(path.join(dir, 'automation-48h-browser-results.json'), JSON.stringify(report, null, 2));
  console.log(report.checks.join('\n'));
} finally { await browser.close(); }
