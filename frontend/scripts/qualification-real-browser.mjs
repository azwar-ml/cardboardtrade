import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const root = path.resolve(process.cwd(), '..');
const phase = process.argv[2] || 'before';
assert.ok(['before', 'after'].includes(phase));
const demo = JSON.parse(fs.readFileSync(path.join(root, 'deliverables/agent2-real-e2e.json'), 'utf8'));
const db = new Database(path.join(process.cwd(), 'data/trade.db'));
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
assert.ok(admin, 'Existing Admin account required');
const token = randomBytes(32).toString('hex');
db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, admin.id, new Date(Date.now() + 600000).toISOString());
let browser;
const result = { phase, checks: [], report_hashes: {}, browser_errors: [] };
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addCookies([{ name: 'cp_session', value: token, url: 'http://localhost:3013', httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.on('pageerror', error => result.browser_errors.push(error.message));
  for (const [kind, id] of Object.entries(demo.jobs)) {
    const response = await context.request.get(`http://localhost:3013/api/console/qualification/jobs/${id}`);
    assert.equal(response.status(), 200);
    const job = await response.json();
    assert.equal(job.status, 'Completed');
    assert.equal(job.review_status, 'Pending Admin Review');
    result.report_hashes[kind] = createHash('sha256').update(JSON.stringify(job)).digest('hex');
  }
  result.checks.push('Persisted genuine supplier and market jobs are readable with Admin authentication');
  await page.goto('http://localhost:3013/console/admin/agents/supplier-qualification');
  await page.getByRole('button', { name: 'Corruboard Industries', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Corruboard Industries', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Supplier evaluation details' });
  await dialog.getByText('AI analysis unavailable', { exact: true }).waitFor();
  await dialog.getByText(/2 independently supported categories/).waitFor();
  await dialog.getByText(/Evidence sources \(/).click();
  await dialog.locator('a[href="https://www.urdupoint.com/business/directory/detail/corruboard-industries-98136.html"]').last().waitFor();
  await page.screenshot({ path: path.join(root, `deliverables/agent2-real-supplier-${phase}.png`), fullPage: true });
  result.checks.push('Supplier tab displays real independent sources, dates, limited corroboration and AI failure');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: 'Market Prices', exact: true }).click();
  const labels = { packaging_type: 'Packaging type', dimensions_mm: 'Dimensions in mm (L × W × H)',
    material: 'Material', flute: 'Flute', ply: 'Ply', printing: 'Printing', finishing: 'Finishing' };
  for (const [field, label] of Object.entries(labels)) await page.getByLabel(label, { exact: true }).fill(demo.product[field]);
  await page.getByLabel('Quantity', { exact: true }).fill(String(demo.quantity));
  await page.getByRole('button', { name: 'Compare Prices', exact: true }).click();
  await page.getByRole('heading', { name: 'Insufficient Comparable Data', exact: true }).waitFor();
  result.checks.push('Specified carton comparison uses the live Python comparator and reports insufficient data');
  await page.getByRole('heading', { name: 'Published prices requiring specification checks', exact: true }).waitFor();
  await page.getByText('₨ 110 – ₨ 1,470', { exact: true }).click();
  await page.locator('a[href="https://packagingbox.pk/product/standard-ecommerce-box/"]').waitFor();
  await page.getByText('$0.10-0.68', { exact: true }).click();
  await page.getByText(/Insufficient Comparable Data\. Research permitted public pages/).waitFor();
  await page.screenshot({ path: path.join(root, `deliverables/agent2-real-market-${phase}.png`), fullPage: true });
  result.checks.push('Market tab shows actual published ranges and insufficient comparable data');
  await page.getByText('Gemini usage and availability', { exact: true }).click();
  await page.getByText('GEMINI_API_KEY_3 · additional · Disabled', { exact: true }).waitFor();
  result.checks.push('Key #3 is disabled');
  assert.deepEqual(result.browser_errors, []);
  if (phase === 'after') {
    const before = JSON.parse(fs.readFileSync(path.join(root, 'deliverables/agent2-real-dashboard-before.json'), 'utf8'));
    assert.deepEqual(result.report_hashes, before.report_hashes);
    result.checks.push('Both report hashes are identical after the report backend restart');
  }
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.close();
  fs.writeFileSync(path.join(root, `deliverables/agent2-real-dashboard-${phase}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
