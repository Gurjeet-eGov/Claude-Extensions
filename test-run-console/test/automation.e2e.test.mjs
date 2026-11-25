// The Automation screen in Chromium against the real local server, on a temporary sheets
// folder with the sample .xlsx: link a suite, import a results file (with the file chooser),
// open the run view, download Excel, change the cycle, delete. Skipped when Playwright is not
// installed (looked up in PLAYWRIGHT_DIR, else in the CCRS checkout), like console.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeGh } from '../dev/fake-tools.mjs';
import { hashKey, newKey } from '../lib/team.mjs';

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
    await t.test('no suites yet: + Link Suite, then Save', async () => {
      await page.goto(`${base}?view=automation`);
      await page.locator('.empty h3', { hasText: 'No automated suites yet' }).waitFor();
      await page.locator('.empty [data-action=au-link]').click();
      await page.locator('h2', { hasText: 'Link a suite' }).waitFor();
      await page.locator('#auRepo').fill('https://github.com/Gurjeet-eGov/CMS-Automation');
      await page.locator('#auName').fill('CMS Automation');
      await page.locator('#auPattern').fill('CMS/(\\d+');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.toast.bad', { hasText: 'case-ID pattern' }).waitFor();
      await page.locator('#auPattern').fill('CMS/\\d+');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
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
      await page.getByRole('button', { name: '⤒ Choose Files' }).click();
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
      // one row above the title: ‹ Back first, then the actions in order, ? last
      await page.locator('.run-actions > [data-action=au-back]', { hasText: '‹ Back' }).waitFor();
      const order = await page.locator('.run-actions > button, .run-actions > .help-wrap > button').allTextContents();
      assert.deepEqual(order.map((x) => x.trim()), ['‹ Back', 'Change Cycle', 'Delete', '⤓ Download', '?']);
      assert.ok(await page.locator('.run-actions + .auto-head h2', { hasText: 'CMS Automation · 2 failed' }).count(), 'the row sits above the title');
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

    await t.test('Change Cycle attaches the run elsewhere; Delete asks first, then it goes', async () => {
      await page.getByRole('button', { name: 'Change Cycle' }).click();
      await page.locator('#au_mv_tab').click();
      await page.locator('.multi-pop .dd-item', { hasText: 'CMS 2.20.1 Features' }).click();
      assert.equal(await page.locator('#au_mv_cycle > .grow').textContent(), 'Cycle v2.20');
      await page.locator('.item [data-action=au-move-save]').click();
      await toast('Moved the run to CMS Sign Off (sample) › CMS 2.20.1 Features › Cycle v2.20.');
      await page.locator('.auto-head .small', { hasText: 'CMS 2.20.1 Features › Cycle v2.20' }).waitFor();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
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

test('Summary › Automated, Auto badges on Run, and the published site unlocking with an invite link', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-auto-pub-e2e-'));
  const sheets = join(dir, 'sheets');
  mkdirSync(join(sheets, '.testrun'), { recursive: true });
  const KEYS = { priya: newKey(), rahul: newKey() };
  writeFileSync(join(sheets, '.testrun', 'app.json'), JSON.stringify({
    user: 'Host',
    team: { enabled: true, people: [
      { id: 'p1', name: 'Priya', role: 'tester', hash: hashKey(KEYS.priya), key: KEYS.priya },
      { id: 'r1', name: 'Rahul', role: 'tester', hash: hashKey(KEYS.rahul), key: KEYS.rahul, books: ['Bomet UAT.xlsx'] },
    ] },
  }));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-auto-pub-gh-')));
  const server = createServer({ sheetsDir: sheets, ghPath: gh.bin, repo: { owner: 'org', repo: 'tools' }, publishPrefix: 'test-run-console/', publishedDir: join(dir, 'published'), cloneDir: join(dir, 'no-clone') });
  const base = await server.listenOn(0);
  const req = async (method, path, body, raw) => (await fetch(base + path.replace(/^\//, ''), {
    method, headers: { 'X-Test-Run': '1', ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) }, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  })).json();
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { book: BOOK, args });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((x) => ({ name: x.name, ...x.detected })) });
  const suite = (await req('POST', '/api/automation/suites', { name: 'CMS Automation', casePattern: 'CMS/\\d+' })).suite.id;
  const q = `suite=${suite}&name=results.xml&book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12&branch=master&env=net_two`;
  const earlier = readFileSync(FIXTURE, 'utf8').replace('2026-11-24T04:53:00.000Z', '2026-11-22T12:35:00.000Z').replace(/<failure message="assign[\s\S]*?<\/failure>/, '');
  assert.equal((await req('POST', `/api/automation/import?${q}`, Buffer.from(earlier), true)).ok, true);
  assert.equal((await req('POST', `/api/automation/import?${q}`, readFileSync(FIXTURE), true)).ok, true);
  await req('POST', '/api/publish/settings', { books: { [BOOK]: true } });
  assert.equal((await req('POST', '/api/publish/now', { confirmPublic: true })).ok, true);

  const browser = await chromium.launch();
  const errors = [];
  /** A browser with this invite key kept in it (as after opening the link once), or none. */
  const visitor = async (key) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    if (key) await ctx.addInitScript((k) => { window.localStorage.setItem('testrun.connection', JSON.stringify({ server: '', token: k, gist: '' })); }, key);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  const autoOn = (p) => p.waitForFunction(() => { const b = [...document.querySelectorAll('.seg.same button')].find((x) => x.textContent === 'Automated'); return b && !b.disabled; });
  try {
    const page = await visitor(null);
    await t.test('Summary: Manual | Automated; Automated shows the latest run attached to the suite and cycle', async () => {
      await page.goto(`${base}?view=summary`);
      await page.locator('.seg.same button[aria-pressed=true]', { hasText: 'Manual' }).waitFor();
      await autoOn(page);
      await page.locator('.seg.same button', { hasText: 'Automated' }).click();
      await page.locator('h2', { hasText: 'Latest run · CMS Automation' }).waitFor();
      await page.locator('.kpi', { hasText: 'pass rate' }).locator('.delta', { hasText: '↓ from 75%' }).waitFor();
      await page.locator('.changed button', { hasText: 'new failures' }).locator('.v', { hasText: '1' }).waitFor();
      assert.equal(await page.locator('.cause').count(), 2, 'the top 2 causes');
      assert.equal(await page.locator('[data-action=sum-open][aria-label^="Open the run"]').count(), 2, 'the runs kept for the cycle');
      await page.locator('p', { hasText: 'Manual cases also run by automation: 2 of 18 · automation passing on 1, failing on 1.' }).waitFor();
      const order = await page.locator('.report-tools > button, .report-tools > .help-wrap > button').allTextContents();
      assert.deepEqual(order.map((x) => x.trim()), ['⤓ Download', 'Print / PDF', '?'], 'Download and Print / PDF as on Manual, then ? last (no Git Report for an imported run)');
      assert.equal(await page.locator('.report-tools .small-btn').count(), 0, 'the same size as Manual\'s');
      const dl = page.waitForEvent('download');
      await page.locator('.report-tools [data-action=sum-excel]').click();
      assert.match((await dl).suggestedFilename(), /^CMS Automation - .* - results\.xlsx$/);
      await page.reload(); // the choice is kept for the session
      await page.locator('h2', { hasText: 'Latest run · CMS Automation' }).waitFor();
      await page.locator('.changed button', { hasText: 'still failing' }).click();
      await page.locator('h2', { hasText: 'CMS Automation · 2 failed' }).waitFor();
      assert.equal(await page.locator('.chip[aria-pressed=true]').textContent(), 'Still failing 1', 'the card\'s filter');
    });

    await t.test('Summary: a cycle with no run keeps Automated off, with a note', async () => {
      await page.goto(`${base}?view=summary&tab=${encodeURIComponent('CMS 2.20.1 Features')}`);
      await page.locator('.sum-note', { hasText: 'Automated results show here once a run is attached' }).waitFor();
      const b = page.locator('.seg.same button', { hasText: 'Automated' });
      assert.ok(await b.isDisabled());
      assert.match(await b.getAttribute('title'), /No automated run is attached to .+ › Cycle v2\.20 yet/);
    });

    await t.test('Run: Auto ✓ / ✗ on the cases automated tests name', async () => {
      await page.goto(`${base}?view=run&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await page.locator('.chip[data-show=all]').click();
      const row = (id) => page.locator('.case', { has: page.locator('.cid', { hasText: new RegExp(`^${id}$`) }) });
      await row('CMS/01').locator('.pill.pass', { hasText: 'Auto ✓' }).waitFor();
      await row('CMS/02').locator('.pill.fail', { hasText: 'Auto ✗' }).waitFor();
      assert.equal(await row('CMS/02').locator('.pill.fail[title="Latest automated result attached to this cycle"]').count(), 1);
      assert.equal(await row('CMS/03').locator('.pill', { hasText: 'Auto' }).count(), 0, 'not named by any test');
    });

    await t.test('published site: an invited key unlocks the automated results; the run opens read only', async () => {
      const p = await visitor(KEYS.priya);
      await p.goto(`${base}?reports=1`);
      await autoOn(p);
      await p.locator('.seg.same button', { hasText: 'Automated' }).click();
      await p.locator('h2', { hasText: 'Latest run · CMS Automation' }).waitFor();
      await p.locator('.pill.pass', { hasText: 'Unlocked for Priya' }).waitFor();
      await p.locator('p', { hasText: 'Manual cases also run by automation: 2 of 18' }).waitFor();
      assert.equal(await p.locator('.cause').count(), 2, 'an invited key sees the top causes');
      const tools = await p.locator('.report-tools > button, .report-tools > .help-wrap > button').allTextContents();
      assert.deepEqual(tools.map((x) => x.trim()), ['⤓ Download', 'Print / PDF', '?']);
      await p.locator('[data-action=pub-open][aria-label^="Open the run"]').first().click();
      await p.locator('h2', { hasText: 'CMS Automation · 2 failed' }).waitFor();
      await p.locator('.run-actions > [data-action=pub-back]', { hasText: '‹ Back' }).waitFor();
      const order = await p.locator('main .stack .run-actions > button').allTextContents();
      assert.deepEqual(order.map((x) => x.trim()), ['‹ Back', '⤓ Download'], 'read only: no Change Cycle or Delete');
      assert.ok(await p.locator('main .stack .run-actions + .auto-head h2', { hasText: 'CMS Automation · 2 failed' }).count(), 'the row sits above the title');
      const dl = p.waitForEvent('download');
      await p.locator('main .stack .run-actions [data-action=pub-csv]').click();
      const csv = readFileSync(await (await dl).path(), 'utf8');
      assert.match(csv, /GRO assigns the complaint/);
      await p.locator('[data-action=pub-back]').click();
      await p.locator('h2', { hasText: 'Latest run · CMS Automation' }).waitFor();
      await p.context().close();
    });

    await t.test('published site: a guest (no key, or one without the workbook) sees the figures only', async () => {
      /** What a guest sees: the figures, no top causes, Git Report or Open; Download and Print / PDF. */
      const guestView = async (g) => {
        await g.locator('h2', { hasText: 'Latest run · CMS Automation' }).waitFor();
        await g.locator('.kpi', { hasText: 'pass rate' }).locator('.delta', { hasText: '↓ from 75%' }).waitFor();
        await g.locator('.changed .chg', { hasText: 'new failures' }).locator('.v', { hasText: '1' }).waitFor();
        await g.locator('p', { hasText: 'Manual cases also run by automation: 2 of 18 · automation passing on 1, failing on 1.' }).waitFor();
        assert.equal(await g.locator('h2', { hasText: 'Top failure causes' }).count(), 0, 'no top failure causes');
        assert.equal(await g.locator('.cause').count(), 0);
        assert.equal(await g.locator('.changed button').count(), 0, 'the What changed cards open nothing');
        assert.equal(await g.locator('main tbody tr').count(), 2, 'the runs kept for the cycle');
        assert.equal(await g.locator('[data-action=pub-open]').count(), 0, 'no Open');
        assert.equal(await g.locator('[data-action=sum-full-report]').count(), 0, 'no Git Report');
        assert.equal(await g.locator('.pill', { hasText: 'Unlocked' }).count(), 0);
        const tools = await g.locator('.report-tools > button, .report-tools > .help-wrap > button').allTextContents();
        assert.deepEqual(tools.map((x) => x.trim()), ['⤓ Download', 'Print / PDF'], 'Download and Print / PDF, as on Manual');
        const dl = g.waitForEvent('download');
        await g.locator('.report-tools [data-action=pub-guest-csv]').click();
        const file = await dl;
        assert.match(file.suggestedFilename(), / - automated\.csv$/);
        const csv = readFileSync(await file.path(), 'utf8');
        assert.match(csv, /^\ufeffWhen,Suite,Environment,Options,Passed,Failed,Skipped,Flaky,Total,Pass rate \(%\)\r\n/);
        assert.equal(csv.trim().split('\r\n').length, 3, 'a row per run kept');
        assert.doesNotMatch(csv, /GRO assigns the complaint|Error|expect\(/, 'no test names or failure messages');
      };
      const r = await visitor(KEYS.rahul);
      await r.goto(`${base}?reports=1`);
      await autoOn(r);
      await r.locator('.seg.same button', { hasText: 'Automated' }).click();
      await guestView(r);
      await r.context().close();
      const n = await visitor(null);
      await n.goto(`${base}?reports=1`);
      await autoOn(n);
      await n.locator('.seg.same button', { hasText: 'Automated' }).click();
      await guestView(n);
      await n.locator('.seg.same button', { hasText: 'Manual' }).click();
      await n.locator('.kpi', { hasText: 'executed' }).first().waitFor(); // Manual stays public
      await n.context().close();
    });

    await t.test('no page errors', () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close();
    server.close();
  }
});
