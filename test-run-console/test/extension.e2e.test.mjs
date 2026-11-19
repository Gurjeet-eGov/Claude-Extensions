// Bug Reporter and Test Run together, in a real Chromium with the extension
// (from this repo) loaded. Checks what Chrome allows: the extension reaching
// the local server (host permission + Test Run's origin check), the Report
// Issue form's Test Run box (suite, optional test case) appearing only while
// Test Run runs, an invite link pasted in Settings, and the bug landing on the
// test case picked (marked failed, issue linked) or as a finding. Filing a real
// issue needs GitHub, so the note is sent the way the page does after filing,
// from the extension's own page.
// Skipped when Playwright is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer } from '../server.mjs';
import { ROOT } from '../lib/runtime.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { extensionIdFromKey } from '../../bug-reporter/host/lib/extension-id.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
for (const dir of [process.env.PLAYWRIGHT_DIR, join(homedir(), 'Documents/Citizen-Complaint-Resolution-System/tests/integration-tests/node_modules/playwright')].filter(Boolean)) {
  if (existsSync(dir)) { try { ({ chromium } = require(dir)); break; } catch { /* next */ } }
}

const EXT = join(ROOT, '..', 'bug-reporter', 'extension');
const EXT_ID = extensionIdFromKey(JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')).key);
const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';

test('Bug Reporter offers "Also add this to Test Run" on the form: the suite, an optional test case, only while Test Run runs', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async () => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-ext-'));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh' });
  const base = await server.listenOn(0);
  const port = Number(new URL(base).port);
  const call = (fn, ...args) => fetch(`${base}api/call/${fn}`, { method: 'POST', headers: { 'X-Test-Run': '1', 'content-type': 'application/json' }, body: JSON.stringify({ book: BOOK, args }) }).then((r) => r.json());
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  await call('api_loadTab', TAB, '');

  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'testrun-profile-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${EXT_ID}/options/options.html`);
    await opts.evaluate(async (p) => {
      const m = await import('/lib/settings.js');
      const s = await m.getSettings();
      s.testRun = { enabled: true, port: p };
      await m.saveSettings(s);
      await m.saveProjects([{ id: 'p1', boardTitle: 'Board', repo: 'org/repo', boardUrl: 'https://github.com/orgs/org/projects/1', envUrls: ['https://env.example/digit-ui'], envPrefix: 'Env', priority: { mode: 'title' } }]);
      const idb = await import('/lib/idb.js');
      await idb.put('reports', { id: 'r-e2e', haltWall: Date.now(), pageUrl: 'https://env.example/digit-ui/citizen/complaints', pageTitle: 'Complaints', media: [] });
    }, port);

    // Options → Test Run → Check now: the extension reaches the server.
    await opts.reload();
    await opts.locator('.tabs button[data-tab=testrun]').click();
    await opts.locator('#trCheck').click();
    await opts.locator('#trState', { hasText: 'Connected: CMS Sign Off (sample) · CMS 2.20.1 · cycle v2.12' }).waitFor({ timeout: 5000 });
    assert.equal(await opts.locator('#trUrl').inputValue(), `http://127.0.0.1:${port}`, 'an old port setting shows as the address');

    // An invite link pasted in Settings fills in the address and keeps the key.
    await opts.locator('#trInvite').fill(`https://owner.github.io/r/test-run/#join=${'k'.repeat(32)}&server=${encodeURIComponent(base.replace(/\/$/, ''))}`);
    await opts.locator('#trUseInvite').click();
    await opts.locator('#trInviteState', { hasText: 'Invite saved (key …kkkk)' }).waitFor();
    await opts.locator('#trState', { hasText: 'Connected' }).waitFor({ timeout: 5000 });
    const saved = await opts.evaluate(async () => (await (await import('/lib/settings.js')).getSettings()).testRun);
    assert.deepEqual([saved.url, saved.key.length, saved.enabled], [base.replace(/\/$/, ''), 32, true]);

    // The form: the Test Run box, with the suite and an optional test case, before drafting.
    const rp = await context.newPage();
    await rp.goto(`chrome-extension://${EXT_ID}/report/report.html?id=r-e2e&dry=1`);
    await rp.locator('#trBox').waitFor({ state: 'visible', timeout: 5000 });
    assert.deepEqual(await rp.locator('#trSuite option').allTextContents(), ['CMS Sign Off (sample) › CMS 2.20.1', 'CMS Sign Off (sample) › CMS 2.20.1 Features', 'CMS Sign Off (sample) › Dashboard KPI']);
    assert.equal(await rp.locator('#trSuite option:checked').textContent(), 'CMS Sign Off (sample) › CMS 2.20.1', 'starts on the suite open in Test Run');
    assert.equal(await rp.locator('#trNoteChk').isChecked(), false, 'starts unticked');
    assert.equal(await rp.locator('#trCase').isVisible(), false, 'the pickers show once ticked');
    await rp.locator('#trNoteChk').check();
    assert.equal(await rp.evaluate(() => chrome.storage.local.get('testRunNote').then((x) => x.testRunNote)), true, 'choice remembered');
    await rp.locator('#trCase').waitFor({ state: 'visible' });
    await rp.waitForFunction(() => document.querySelectorAll('#trCases option').length === 18);
    assert.match(await rp.locator('#trCases option').first().getAttribute('value'), /^CMS\/01 · Verify if the CSR sees/);
    assert.match(await rp.locator('#trHint').textContent(), /added as a finding/);

    await rp.locator('input[name=prio][value=P2]').check({ force: true });
    await rp.locator('#actual').fill('No Reopen button on a complaint resolved 4 days ago');
    await rp.locator('#trCase').fill('CMS/99');
    assert.match(await rp.locator('#trHint').textContent(), /No test case like "CMS\/99"/);
    await rp.locator('#skipClaude').click();
    await rp.locator('#formErr', { hasText: 'Pick the test case from the list' }).waitFor();
    await rp.locator('#trCase').fill('CMS/12');
    assert.match(await rp.locator('#trHint').textContent(), /CMS\/12 will be marked failed in cycle v2\.12, with the issue linked/);
    assert.equal(await rp.locator('#claudeApis').isChecked(), true, 'Claude reads the ticked API calls unless switched off');
    await rp.locator('#skipClaude').click();
    await rp.locator('#trSummary', { hasText: 'Then in Test Run: CMS/12 marked failed, with this issue linked (CMS Sign Off (sample) › CMS 2.20.1).' }).waitFor();

    // Filing sends it from the extension's origin: against the case, the case is marked failed with the issue linked.
    const fileNote = (extra) => rp.evaluate(async (x) => {
      const m = await import('/lib/testrun.js');
      const s = await (await import('/lib/settings.js')).getSettings();
      return m.noteBugInTestRun(s, m.buildBugNote({
        title: 'Env: Citizen: Reopen button missing 4 days after resolution',
        filed: { number: x.number, url: `https://github.com/org/repo/issues/${x.number}` },
        repo: 'org/repo',
        draft: { description: 'Reopen is not offered', actual: 'No Reopen button', expected: 'Reopen offered within 5 days' },
        module: 'Citizen',
        pageUrl: 'https://env.example/digit-ui/citizen/complaints',
        suite: x.suite,
        testCase: x.testCase,
        priority: 'P2',
      }));
    }, extra);
    const onCase = await fileNote({ number: 78, suite: { book: BOOK, tab: TAB }, testCase: { key: 'CMS/12' } });
    assert.deepEqual([onCase.kind, onCase.key, onCase.status, onCase.cycle], ['case', 'CMS/12', 'Fail', 'v2.12']);
    const c12 = (await call('api_loadTab', TAB, '')).cases.find((c) => c.id === 'CMS/12');
    assert.equal(c12.statuses[0], 'Fail');
    assert.deepEqual(c12.issues, [{ ref: '#78', url: 'https://github.com/org/repo/issues/78' }]);
    const known = (await call('api_listIssues')).issues.find((i) => i.ref === '#78');
    assert.deepEqual([known.title, known.priority], ['Env: Citizen: Reopen button missing 4 days after resolution', 'P2']);

    // Another suite: the case list follows it; with no case, the bug becomes a finding there.
    await rp.locator('#back').click();
    await rp.locator('#trSuite').selectOption({ label: 'CMS Sign Off (sample) › CMS 2.20.1 Features' });
    assert.deepEqual(await rp.evaluate(() => chrome.storage.local.get('testRunSuite').then((x) => x.testRunSuite)), { book: BOOK, tab: 'CMS 2.20.1 Features' }, 'suite remembered');
    assert.equal(await rp.locator('#trCase').inputValue(), '', 'the case picked in the other suite is cleared');
    await rp.waitForFunction(() => /^CMS\/0/.test((document.querySelector('#trCases option') || {}).value || '') && !/^CMS\/01 · Verify if the CSR/.test(document.querySelector('#trCases option').value));
    const res = await fileNote({ number: 77, suite: { book: BOOK, tab: 'CMS 2.20.1 Features' } });
    assert.deepEqual([res.kind, res.key, res.book, res.tab], ['finding', 'F-001', BOOK, 'CMS 2.20.1 Features']);
    const f = (await call('api_listFindings')).findings[0];
    assert.deepEqual([f.source, f.issue, f.area], ['bug-reporter', '#77', 'Citizen']);

    // With Test Run stopped, the box is gone.
    await new Promise((r) => server.close(r));
    await rp.reload();
    await rp.locator('#actual').waitFor();
    await rp.waitForTimeout(1500);
    assert.equal(await rp.locator('#trBox').isVisible(), false);
  } finally {
    await context.close();
    server.close();
  }
});
