// Drives the real console page in Chromium against the demo server (real .gs
// code, in-memory sample sheet). Skipped when Playwright is not installed.
// Playwright is looked up in PLAYWRIGHT_DIR, else in the CCRS integration-tests
// checkout next to this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDemo } from '../demo/server.mjs';

const require = createRequire(import.meta.url);
const candidates = [
  process.env.PLAYWRIGHT_DIR,
  join(homedir(), 'Documents/Citizen-Complaint-Resolution-System/tests/integration-tests/node_modules/playwright'),
].filter(Boolean);
let chromium = null;
for (const dir of candidates) {
  if (existsSync(dir)) { try { ({ chromium } = require(dir)); break; } catch { /* try next */ } }
}

const TAB = 'CMS 2.20.1';
const REPLY = '```json\n' + JSON.stringify({
  type: 'scenarios',
  items: [{ fromFinding: 'F-001', scenario: 'Verify if the citizen is able to reopen a complaint resolved 4 days ago', subFeature: 'Citizen UI', testType: 'Functional', expected: ['Reopen shall be offered', 'Complaint shall move to PENDINGFORASSIGNMENT'], issue: '#77' }],
  covered: [],
}) + '\n```';

test('console end to end in a browser', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const demo = createDemo({ latency: 20 });
  const base = await demo.listenOn(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sheet = async () => (await fetch(`${base}__admin/dump?tab=${encodeURIComponent(TAB)}`)).json();
  const admin = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const row = (rows, id) => rows.find((r) => r[0] === id);

  try {
    await t.test('first run opens Setup; saving it lands on Run with paths', async () => {
      await page.goto(base);
      await page.getByText('Welcome.').waitFor();
      await page.getByLabel('Claude help (copy and paste)').check();
      await page.getByRole('button', { name: 'Save setup' }).click();
      await page.getByRole('button', { name: 'Run', exact: true }).and(page.locator('[aria-current=page]')).waitFor();
      await page.locator('.path-title', { hasText: 'CSR Employee' }).waitFor();
      assert.ok(await page.locator('.case').count() >= 8);
    });

    await t.test('click a case, P marks Pass and moves on; the marked case stays visible', async () => {
      await page.locator('.case', { hasText: 'CMS/04' }).click();
      await page.locator('.detail').waitFor();
      await page.keyboard.press('p');
      await page.locator('.case.sel', { hasText: 'CMS/07' }).waitFor();
      await page.locator('.case', { hasText: 'CMS/04' }).locator('.dot.pass').waitFor();
      await expectSheet(async () => row(await sheet(), 'CMS/04')[7] === 'Pass');
    });

    await t.test('F marks Fail, focuses the comment at the end, Enter saves it', async () => {
      await page.keyboard.press('f');
      const box = page.locator('#comment');
      await box.waitFor();
      assert.equal(await box.evaluate((el) => document.activeElement === el), true);
      await page.keyboard.type('Clear keeps the locality filter');
      await page.keyboard.press('Enter');
      await expectSheet(async () => {
        const r = row(await sheet(), 'CMS/07');
        return r[7] === 'Fail' && r[8].endsWith('\nClear keeps the locality filter') && r[8].startsWith('Partly automated');
      });
    });

    await t.test('undo puts the previous result back', async () => {
      await page.locator('.case', { hasText: 'CMS/09' }).click();
      await page.keyboard.press('p');
      await expectSheet(async () => row(await sheet(), 'CMS/09')[7] === 'Pass');
      await page.keyboard.press('u');
      await expectSheet(async () => row(await sheet(), 'CMS/09')[7] === '');
    });

    await t.test('another tester\'s change is never overwritten', async () => {
      const rows = await sheet();
      const r = rows.findIndex((x) => x[0] === 'CMS/08') + 1;
      await admin('__admin/set', { tab: TAB, row: r, col: 8, value: 'Pass' });
      await page.locator('.case', { hasText: 'CMS/08' }).click();
      await page.keyboard.press('f');
      await page.locator('.toast', { hasText: 'was just marked "Pass"' }).waitFor();
      assert.equal(row(await sheet(), 'CMS/08')[7], 'Pass');
    });

    await t.test('finding -> Copy for Claude shows exactly the selected finding', async () => {
      await page.getByRole('button', { name: 'Findings' }).click();
      await page.locator('#fText').fill('Citizen cannot reopen a complaint resolved 4 days ago');
      await page.locator('#fIssue').fill('#77');
      await page.getByRole('button', { name: 'Save finding' }).click();
      await page.locator('td', { hasText: 'F-001' }).waitFor();
      await page.getByLabel('Select F-001').check();
      await page.getByRole('button', { name: /Copy 1 for Claude/ }).click();
      const text = await page.locator('#promptText').inputValue();
      assert.match(text, /F-001: Citizen cannot reopen/);
      assert.doesNotMatch(text, /you@example\.org/);
      await page.getByRole('button', { name: 'Close' }).click();
    });

    await t.test('pasted reply -> review -> Add to sheet appends the row and closes the finding', async () => {
      await page.locator('.nav [data-view=inbox]').click();
      await page.locator('#reply').fill(REPLY);
      await page.getByRole('button', { name: 'Read reply' }).click();
      await page.locator('.item', { hasText: 'Looks similar to' }).waitFor();
      await page.getByRole('button', { name: 'Add to sheet' }).first().click();
      await page.locator('.toast', { hasText: 'Added to the sheet as CMS/19' }).waitFor();
      const r = row(await sheet(), 'CMS/19');
      assert.equal(r[1], 'Verify if the citizen is able to reopen a complaint resolved 4 days ago');
      assert.equal(r[6], '• Reopen shall be offered\n• Complaint shall move to PENDINGFORASSIGNMENT');
      assert.equal(r[7], 'Fail', 'a draft with a bug number defaults to Fail');
      await page.getByRole('button', { name: 'Findings' }).click();
      await page.getByText('Written up · CMS/19').waitFor();
    });

    await t.test('start a new cycle from Plan', async () => {
      await page.getByRole('button', { name: 'Plan' }).click();
      await page.locator('#newCycle').fill('v2.20.1');
      await page.getByRole('button', { name: 'Start new cycle' }).click();
      await page.locator('#cyclePick option:checked', { hasText: 'v2.20.1' }).waitFor({ state: 'attached' });
      const headers = (await sheet())[0];
      assert.deepEqual(headers.slice(7, 11), ['Test Status / v2.12', 'Comment / v2.12', 'Test Status / v2.20.1', 'Comment / v2.20.1']);
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page.locator('.chip', { hasText: 'Failed last cycle' }).locator('.n', { hasText: '4' }).waitFor();
    });

    await t.test('summary page for management', async () => {
      const s = await browser.newPage();
      await s.goto(`${base}exec?view=summary&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await s.locator('.kpi', { hasText: 'executed' }).waitFor();
      await s.getByText('Open failures').waitFor();
      assert.ok(await s.locator('tbody tr', { hasText: 'CMS/05' }).count() >= 1);
      await s.close();
    });

    await t.test('a viewer sees a clear view-only message', async () => {
      await admin('__admin/user', { readOnly: true });
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.keyboard.press('p');
      await page.locator('.banner', { hasText: 'View only.' }).waitFor();
      await admin('__admin/user', { readOnly: false });
    });

    assert.deepEqual(errors, [], 'no script errors on the page');
  } finally {
    await browser.close();
    demo.close();
  }
});

async function expectSheet(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('The sheet did not reach the expected state in time');
}
