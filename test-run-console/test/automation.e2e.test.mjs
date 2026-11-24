// The Automation screen in Chromium against the real local server, on a temporary sheets
// folder with the sample .xlsx: link a suite, import a results file (with the file chooser),
// open the run view, download Excel, change the cycle, delete. Skipped when Playwright is not
// installed (looked up in PLAYWRIGHT_DIR, else in the CCRS checkout), like console.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
for (const dir of [process.env.PLAYWRIGHT_DIR, join(homedir(), 'Documents/Citizen-Complaint-Resolution-System/tests/integration-tests/node_modules/playwright')].filter(Boolean)) {
  if (existsSync(dir)) { try { ({ chromium } = require(dir)); break; } catch { /* try next */ } }
}

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const FIXTURE = new URL('./fixtures/automation/playwright-junit.xml', import.meta.url);
/** "24 Nov", as the page shows a time stamp on this computer. */
const day = (iso) => { const d = new Date(iso); return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`; };
const NOW = day('2026-11-24T04:53:00.000Z'); // the fixture's run
const BEFORE = day('2026-11-22T12:35:00.000Z'); // the earlier run made from it

test('Automation end to end in a browser', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-auto-e2e-'));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh', publishedDir: join(sheets, 'no-published-data') });
  const base = await server.listenOn(0);
  const req = async (method, path, body, raw) => (await fetch(base + path.replace(/^\//, ''), {
    method, headers: { 'X-Test-Run': '1', ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) }, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  })).json();
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { book: BOOK, args });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((x) => ({ name: x.name, ...x.detected })) });
  // an earlier run, so the run view has something to compare with: the first failing test passed then
  const earlier = readFileSync(FIXTURE, 'utf8').replace('2026-11-24T04:53:00.000Z', '2026-11-22T12:35:00.000Z').replace(/<failure message="assign[\s\S]*?<\/failure>/, '');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor();

  try {
    await t.test('no suites yet: + Link Suite, then Save Suite', async () => {
      await page.goto(`${base}?view=automation`);
      await page.locator('.empty h3', { hasText: 'No automated suites yet' }).waitFor();
      await page.locator('.empty [data-action=au-link]').click();
      await page.locator('h2', { hasText: 'Link a suite' }).waitFor();
      await page.locator('#auRepo').fill('https://github.com/Gurjeet-eGov/CMS-Automation');
      await page.locator('#auName').fill('CMS Automation');
      await page.locator('#auPattern').fill('CMS/(\\d+');
      await page.getByRole('button', { name: 'Save Suite' }).click();
      await page.locator('.toast.bad', { hasText: 'case-ID pattern' }).waitFor();
      await page.locator('#auPattern').fill('CMS/\\d+');
      await page.getByRole('button', { name: 'Save Suite' }).click();
      await toast('Linked “CMS Automation”.');
      await page.locator('.subtab[aria-selected=true]', { hasText: 'CMS Automation' }).waitFor();
      await page.locator('.auto-head a', { hasText: 'Gurjeet-eGov/CMS-Automation ↗' }).waitFor();
      await page.locator('td.no-data', { hasText: 'No runs yet' }).waitFor();
    });

    await t.test('Import results: a file chosen is read at once; the run is attached to Workbook › Test suite › Test cycle', async () => {
      const suite = (await req('GET', '/api/automation')).suites[0].id;
      const q = `suite=${suite}&name=results.xml&book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12&branch=master&env=net_two`;
      assert.equal((await req('POST', `/api/automation/import?${q}`, Buffer.from(earlier), true)).ok, true);
      await page.locator('.nav [data-view=automation]').click(); // read afresh
      await page.locator('td', { hasText: BEFORE }).first().waitFor();
      await page.getByRole('button', { name: '⤒ Import Results' }).click();
      await page.locator('h2', { hasText: 'Import results' }).waitFor();
      assert.equal(await page.locator('#au_im_book > .grow').textContent(), 'CMS Sign Off (sample)');
      await page.locator('#au_im_tab > .grow', { hasText: TAB }).waitFor();
      assert.equal(await page.locator('#au_im_cycle > .grow').textContent(), 'Cycle v2.12');
      assert.ok(await page.getByRole('button', { name: 'Import Results', exact: true }).isDisabled(), 'no file yet');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '⤒ Choose Files…' }).click();
      await (await chooser).setFiles(FIXTURE.pathname);
      await page.locator('.item', { hasText: 'playwright-junit.xml' }).locator('text=JUnit XML · 5 tests').waitFor();
      await page.locator('#auBranch').fill('master');
      await page.locator('#auEnv').fill('net_two');
      await page.getByRole('button', { name: 'Import Results', exact: true }).click();
      await toast('Imported 5 tests into CMS 2.20.1 › Cycle v2.12.');
      assert.equal(await page.locator('tbody tr', { has: page.locator('[data-action=au-open]') }).count(), 2);
      await page.locator('.delta.bad', { hasText: '↓ from 75%' }).waitFor();
    });

    await t.test('the run view: figures with the previous run, what changed, causes, a test with its masked message', async () => {
      await page.locator('[data-action=au-open]').first().click();
      await page.locator('h2', { hasText: 'CMS Automation · 2 failed' }).waitFor();
      assert.match(page.url(), /[?&]run=\d{8}-\d{6}-[0-9a-f]{6}/, 'a refresh comes back to it');
      // the actions row, in order, ? last
      const order = await page.locator('.run-actions > button, .run-actions > .help-wrap > button').allTextContents();
      assert.deepEqual(order.map((x) => x.trim()), ['‹ Runs', 'Change Cycle…', 'Delete…', '⤓ Download', '?']);
      await page.locator('.kpi', { hasText: 'pass rate' }).locator('.delta', { hasText: '↓ from 75%' }).waitFor();
      await page.locator('.changed button', { hasText: 'new failures' }).locator('.v', { hasText: '1' }).waitFor();
      assert.equal(await page.locator('.cause').count(), 2);
      await page.locator('.cause-head', { hasText: 'Error: locator.click: Test timeout of {n}ms exceeded.' }).waitFor();
      await page.locator('.changed button', { hasText: 'still failing' }).click();
      assert.equal(await page.locator('.chip[aria-pressed=true]').textContent(), 'Still failing 1');
      await page.locator('.test-row', { hasText: 'search by mobile number' }).click();
      const panel = page.locator('#auTestPanel');
      await panel.locator('pre.trace .masked').first().waitFor();
      assert.ok(!(await panel.textContent()).includes('1c2f3e4d'), 'the token is not on the page');
      await panel.locator('text=A token or password was masked before it was saved.').waitFor();
      await page.locator('#auQ').fill('assign');
      await page.locator('.chip[data-f=all]').click();
      assert.equal(await page.locator('.test-row').count(), 2);
      await page.locator('.help-wrap .help-btn').hover();
      await page.locator('#frTip', { hasText: 'imported from a results file' }).waitFor();
    });

    await t.test('⤓ Download: the results as a workbook', async () => {
      const dl = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click(); // the ⤓ is aria-hidden
      const file = await dl;
      assert.match(file.suggestedFilename(), /^CMS Automation - \d{4}-\d{2}-\d{2} \d{2}-\d{2} - results\.xlsx$/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(await file.path());
      assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Results']);
    });

    await t.test('Change Cycle… attaches the run elsewhere; Delete… asks first, then it goes', async () => {
      await page.getByRole('button', { name: 'Change Cycle…' }).click();
      await page.locator('#au_mv_tab').click();
      await page.locator('.multi-pop .dd-item', { hasText: 'CMS 2.20.1 Features' }).click();
      assert.equal(await page.locator('#au_mv_cycle > .grow').textContent(), 'Cycle v2.20');
      await page.locator('.item [data-action=au-move-save]').click();
      await toast('Moved the run to CMS Sign Off (sample) › CMS 2.20.1 Features › Cycle v2.20.');
      await page.locator('.auto-head .small', { hasText: 'CMS 2.20.1 Features › Cycle v2.20' }).waitFor();
      await page.getByRole('button', { name: 'Delete…' }).click();
      const box = page.locator('.modal-box.confirm');
      await box.locator('h2', { hasText: `Delete “${NOW} · master · net_two”?` }).waitFor();
      await box.locator('.banner.bad', { hasText: 'This cannot be undone.' }).waitFor();
      await box.locator('li', { hasText: 'CMS 2.20.1 Features › Cycle v2.20 keeps no runs.' }).waitFor();
      await box.getByRole('button', { name: 'Delete Run' }).click();
      await toast(`Deleted the run from ${NOW}`);
      await page.locator('h2', { hasText: 'Runs' }).waitFor();
      assert.equal(await page.locator('[data-action=au-open]').count(), 1);
      assert.equal((await req('GET', '/api/automation')).runs.length, 1);
    });

    await t.test('no page errors', () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close();
    server.close();
  }
});
