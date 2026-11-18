// Drives the real console in Chromium against the real local server, on a
// temporary sheets folder with the sample .xlsx and a fake `claude` CLI.
// Every check reads the workbook back from disk. Skipped when Playwright is
// not installed (looked up in PLAYWRIGHT_DIR, else in the CCRS checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, utimesSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { XBook } from '../lib/xlsx-book.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeClaude } from '../dev/fake-claude.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
for (const dir of [process.env.PLAYWRIGHT_DIR, join(homedir(), 'Documents/Citizen-Complaint-Resolution-System/tests/integration-tests/node_modules/playwright')].filter(Boolean)) {
  if (existsSync(dir)) { try { ({ chromium } = require(dir)); break; } catch { /* try next */ } }
}

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';

test('console end to end in a browser', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-e2e-'));
  const file = join(sheets, BOOK);
  writeFileSync(file, await buildSampleXlsx());
  const fake = makeFakeClaude(mkdtempSync(join(tmpdir(), 'testrun-claude-')));
  const server = createServer({ sheetsDir: sheets, claudePath: fake.bin });
  const base = await server.listenOn(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const disk = async (path = file, tab = TAB) => (await XBook.fromFile(path, 'x')).getSheetByName(tab).getDataRange().getDisplayValues();
  const row = (rows, id) => rows.find((r) => r[0] === id);
  const claudeCalls = () => readFileSync(fake.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  try {
    await t.test('first run opens Setup; saving it lands on Run with paths', async () => {
      await page.goto(base);
      await page.getByText('Welcome.').waitFor();
      await page.getByRole('button', { name: 'Save setup' }).click();
      await page.locator('.nav [data-view=run][aria-current=page]').waitFor();
      await page.locator('.path-title', { hasText: 'CSR Employee' }).waitFor();
      assert.ok(await page.locator('.case').count() >= 8);
    });

    await t.test('P marks Pass, saved in the .xlsx file, and moves on', async () => {
      await page.locator('.case', { hasText: 'CMS/04' }).click();
      await page.locator('.detail').waitFor();
      await page.keyboard.press('p');
      await page.locator('.case.sel', { hasText: 'CMS/07' }).waitFor();
      await page.locator('.case', { hasText: 'CMS/04' }).locator('.dot.pass').waitFor();
      await eventually(async () => row(await disk(), 'CMS/04')[7] === 'Pass');
    });

    await t.test('F marks Fail, focuses the comment, Enter saves it', async () => {
      await page.keyboard.press('f');
      const box = page.locator('#comment');
      await box.waitFor();
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'comment');
      await page.keyboard.type('Clear keeps the locality filter');
      await page.keyboard.press('Enter');
      await eventually(async () => {
        const r = row(await disk(), 'CMS/07');
        return r[7] === 'Fail' && r[8].endsWith('\nClear keeps the locality filter') && r[8].startsWith('Partly automated');
      });
    });

    await t.test('undo puts the previous result back', async () => {
      await page.locator('.case', { hasText: 'CMS/09' }).click();
      await page.keyboard.press('p');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === 'Pass');
      await page.keyboard.press('u');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === '');
    });

    await t.test('a change saved from Excel is picked up and never overwritten', async () => {
      const book = await XBook.fromFile(file, 'x');
      const sh = book.getSheetByName(TAB);
      const r = sh.getDataRange().getDisplayValues().findIndex((x) => x[0] === 'CMS/08') + 1;
      sh.getRange(r, 8).setValue('Pass');
      writeFileSync(file, Buffer.from(await book.toBuffer()));
      const later = new Date(statSync(file).mtimeMs + 5000);
      utimesSync(file, later, later);
      await page.locator('.case', { hasText: 'CMS/08' }).click();
      await page.keyboard.press('f');
      await page.locator('.toast', { hasText: 'was just marked "Pass"' }).waitFor();
      assert.equal(row(await disk(), 'CMS/08')[7], 'Pass');
    });

    await t.test('a bug noted from Bug Reporter shows up as a finding', async () => {
      await page.locator('.nav [data-view=findings]').click();
      await fetch(`${base}api/note-bug`, { method: 'POST', headers: { 'X-Test-Run': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Citizen cannot reopen a complaint resolved 4 days ago', number: 77, url: 'https://github.com/org/repo/issues/77', module: 'Citizen UI', actual: 'No button', expected: 'Reopen offered' }) });
      await page.locator('.toast', { hasText: 'New finding from Bug Reporter: F-001' }).waitFor({ timeout: 15000 });
      await page.locator('td', { hasText: 'from Bug Reporter' }).waitFor();
    });

    await t.test('Draft with Claude uses the model and effort chosen for this draft', async () => {
      await page.getByLabel('Select F-001').check();
      await page.locator('select[data-bind="cl:draft:model"]').selectOption('haiku');
      await page.locator('select[data-bind="cl:draft:effort"]').selectOption('medium');
      await page.getByRole('button', { name: 'Draft 1 with Claude' }).click();
      await page.locator('.nav [data-view=inbox][aria-current=page]').waitFor({ timeout: 15000 });
      await page.locator('.item', { hasText: 'Verify that citizen cannot reopen' }).waitFor();
      const last = claudeCalls().pop();
      assert.deepEqual([last.model, last.effort], ['claude-haiku-5-5', 'medium']);
      await page.locator('.nav [data-view=findings]').click();
      await page.getByText('Last run: Haiku 5.5 · effort medium').waitFor();
      assert.equal(await page.locator('select[data-bind="cl:draft:model"]').inputValue(), 'haiku', 'kept for the next draft in this session');
    });

    await t.test('review in the Inbox, then Add to workbook appends the row on disk', async () => {
      await page.locator('.nav [data-view=inbox]').click();
      await page.getByRole('button', { name: 'Add to workbook' }).first().click();
      await page.locator('.toast', { hasText: 'Added to the workbook as CMS/19' }).waitFor();
      const r = row(await disk(), 'CMS/19');
      assert.equal(r[1], 'Verify that citizen cannot reopen a complaint resolved 4 days ago');
      assert.equal(r[7], 'Fail', 'a draft with a bug number defaults to Fail');
      await page.locator('.nav [data-view=findings]').click();
      await page.getByText('Written up · CMS/19').waitFor();
    });

    await t.test('Plan paths with Claude, then use the plan', async () => {
      await page.locator('.nav [data-view=plan]').click();
      await page.getByRole('button', { name: 'Plan paths with Claude' }).click();
      await page.locator('.nav [data-view=inbox][aria-current=page]').waitFor({ timeout: 15000 });
      const last = claudeCalls().pop();
      assert.deepEqual([last.model, last.effort], ['claude-sonnet-5-5', 'medium'], 'planning defaults');
      await page.getByRole('button', { name: 'Use this plan' }).click();
      await page.locator('.path-title', { hasText: 'Planned path A' }).waitFor();
    });

    await t.test('start a new cycle from Plan', async () => {
      await page.locator('.nav [data-view=plan]').click();
      await page.locator('#newCycle').fill('v2.20.1');
      await page.getByRole('button', { name: 'Start new cycle' }).click();
      await page.locator('#cyclePick option:checked', { hasText: 'v2.20.1' }).waitFor({ state: 'attached' });
      assert.deepEqual((await disk())[0].slice(7, 11), ['Test Status / v2.12', 'Comment / v2.12', 'Test Status / v2.20.1', 'Comment / v2.20.1']);
    });

    await t.test('summary: page, export file, download', async () => {
      const s = await browser.newPage();
      await s.goto(`${base}summary.html?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await s.locator('.kpi', { hasText: 'executed' }).waitFor();
      await s.getByText('Open failures').waitFor();
      await s.close();
      await page.locator('.nav [data-view=summary]').click();
      await page.getByRole('button', { name: 'Export summary' }).click();
      await page.locator('.banner', { hasText: '.html' }).waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download' }).click()]);
      assert.equal(download.suggestedFilename(), BOOK);
    });

    await t.test('import another workbook and switch to it', async () => {
      const other = join(mkdtempSync(join(tmpdir(), 'testrun-imp-')), 'Bomet Test Cases.xlsx');
      writeFileSync(other, await buildSampleXlsx());
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import' }).first().click()]);
      await chooser.setFiles(other);
      await page.locator('#bookPick option:checked', { hasText: 'Bomet Test Cases' }).waitFor({ state: 'attached' });
      await page.getByText('Welcome.').waitFor();
      assert.ok(existsSync(join(sheets, 'Bomet Test Cases.xlsx')));
    });

    await t.test('a read-only workbook file says so', async () => {
      await page.locator('#bookPick').selectOption(BOOK);
      await page.locator('.path-title').first().waitFor();
      chmodSync(file, 0o444);
      server.library.open.delete(BOOK);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.keyboard.press('p');
      await page.locator('.banner', { hasText: 'View only.' }).waitFor();
      chmodSync(file, 0o644);
    });

    assert.deepEqual(errors, [], 'no script errors on the page');
  } finally {
    await browser.close();
    server.close();
  }
});

async function eventually(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.fail('The workbook did not reach the expected state in time');
}
