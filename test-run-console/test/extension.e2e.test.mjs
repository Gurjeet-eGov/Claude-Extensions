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
    await opts.locator('.tabs button[data-tab=testrun]').click(); // opening the tab checks by itself
    await opts.locator('#trState', { hasText: 'Connected: CMS Sign Off (sample) · CMS 2.20.1 · cycle v2.12' }).waitFor({ timeout: 5000 });
    assert.equal(await opts.locator('#trStatusCard').getAttribute('data-state'), 'ok', 'a green status');
    await opts.locator('#trCheck').click();
    await opts.locator('#trState', { hasText: 'Connected: CMS Sign Off (sample)' }).waitFor({ timeout: 5000 });
    assert.equal(await opts.locator('#trUrl').isVisible(), false, 'the address is folded away under Connection');
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
    assert.equal(await rp.locator('#trBox .tr-mark').count(), 1, 'marked as Test Run');
    assert.deepEqual(await rp.locator('#trBook option').allTextContents(), ['CMS Sign Off (sample)'], 'the workbook, then its suites');
    assert.deepEqual(await rp.locator('#trSuite option').allTextContents(), ['CMS 2.20.1', 'CMS 2.20.1 Features', 'Dashboard KPI']);
    assert.equal(await rp.locator('#trSuite option:checked').textContent(), 'CMS 2.20.1', 'starts on the suite open in Test Run');
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
    await rp.locator('#trSuite').selectOption({ label: 'CMS 2.20.1 Features' });
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

// Test Run Extension and the console together (in this file, after Bug Reporter, so the two
// extension tests take turns), in Chromium with the extension loaded,
// against the real local server on a temporary sheets folder with the sample .xlsx:
// sign in with only a link, follow what the console has open, mark results, evidence
// (and the rule for changing a result that has it), a recording, the host's Media
// settings and Complete Report, and a View only link. Skipped when Playwright is not
// installed (looked up in PLAYWRIGHT_DIR, else in the CCRS checkout).
const TRX = join(ROOT, '..', 'test-run-extension');
const TRX_ID = extensionIdFromKey(JSON.parse(readFileSync(join(TRX, 'manifest.json'), 'utf8')).key);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 9)]);

test('Test Run Extension end to end', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-ext-'));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh' });
  const base = await server.listenOn(0);
  const api = (method, path, body, headers = {}) => fetch(base + path.slice(1), { method, headers: { 'X-Test-Run': '1', ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) }).then((x) => x.json());
  const boot = await api('POST', '/api/call/api_bootstrap', { book: BOOK, args: [] });
  await api('POST', '/api/call/api_saveSetup', { book: BOOK, args: [{ tabs: boot.tabs.map((x) => ({ name: x.name, ...x.detected })) }] });
  const suite = () => api('GET', `/api/ext/suite?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
  const caseIn = async (id) => (await suite()).cases.find((c) => c.id === id);

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'pw-ext-')), { channel: 'chromium', headless: true, acceptDownloads: true, viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${TRX}`, `--load-extension=${TRX}`] });
  const errors = [];
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const popupUrl = `chrome-extension://${TRX_ID}/popup/popup.html`;
  let popup;
  try {
    await t.test('signed out, the extension only asks for the access link', async () => {
      popup = await ctx.newPage();
      await popup.goto(popupUrl);
      await popup.getByText('Sign in to Test Run').waitFor();
      assert.equal(await popup.getByText('Choose Workbook/Suite').count(), 0, 'nothing else');
      await popup.locator('#link').fill('https://example.org/just-a-page');
      await popup.getByRole('button', { name: 'Sign in' }).click();
      await popup.getByText('That is not an access link').waitFor();
      await popup.locator('#link').fill(base);
      await popup.getByRole('button', { name: 'Sign in' }).click();
      await popup.getByRole('button', { name: 'Choose Workbook/Suite' }).waitFor();
      await popup.getByText('Set by your test lead').waitFor();
      await popup.getByText(/Video 1080p · 30 fps · up to about 1 min/).first().waitFor();
    });

    let consolePage;
    await t.test('Choose Workbook/Suite opens Test Run; the case selected there shows in the extension, and follows it', async () => {
      const [opened] = await Promise.all([ctx.waitForEvent('page'), popup.getByRole('button', { name: 'Choose Workbook/Suite' }).click()]);
      consolePage = opened;
      await consolePage.waitForLoadState();
      assert.match(consolePage.url(), /^http:\/\/127\.0\.0\.1:\d+\/\?view=run$/);
      await consolePage.locator('[data-action=show][data-show=all]').click();
      await consolePage.locator('.case', { hasText: 'CMS/07' }).click();
      popup = await ctx.newPage();
      await popup.goto(popupUrl);
      await popup.getByText('CMS Sign Off (sample)').waitFor();
      await popup.locator('.lb', { hasText: 'CMS/07' }).waitFor();
      await popup.getByText('v2.12').first().waitFor();
      await consolePage.locator('.case', { hasText: 'CMS/09' }).click();
      await popup.locator('.lb', { hasText: 'CMS/09' }).waitFor({ timeout: 6000 }); // it follows Test Run
    });

    await t.test('marking a result from the extension saves it in the workbook and moves on', async () => {
      await popup.locator('.st button[data-value="Pass"]').click();
      await popup.getByText('CMS/09: Pass.').waitFor();
      assert.equal((await caseIn('CMS/09')).status, 'Pass');
      await popup.locator('.lb', { hasText: 'CMS/10' }).waitFor();
      // closed and opened again: it carries on at CMS/10, not back at CMS/09 (picked in Test Run)
      await popup.reload();
      await popup.locator('.lb', { hasText: 'CMS/10' }).waitFor();
      assert.equal(await popup.locator('.lb', { hasText: 'CMS/09' }).count(), 0);
      // the case ID is a link: Test Run opens on that case
      const [run] = await Promise.all([ctx.waitForEvent('page'), popup.locator('.lb .case-link', { hasText: 'CMS/10' }).click()]);
      await run.waitForLoadState();
      assert.match(run.url(), /view=run&book=.+&tab=.+&cycle=v2\.12&case=CMS%2F10/);
      await run.locator('.case.sel', { hasText: 'CMS/10' }).waitFor();
      await run.waitForFunction(() => !/[?&]case=/.test(location.search)); // a refresh will not jump back to it
      await run.close();
      popup = await ctx.newPage();
      await popup.goto(popupUrl);
      await popup.locator('.lb', { hasText: 'CMS/10' }).waitFor();
    });

    await t.test('evidence: used by the next result; changing that result needs new evidence; removing deletes it', async () => {
      const up = await api('POST', `/api/evidence?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12&key=CMS%2F08`, PNG);
      assert.equal(up.ok, true, up.error);
      await popup.locator('#find').fill('CMS/08');
      await popup.locator('#find').press('Enter');
      await popup.locator('.file .name', { hasText: up.added.name }).waitFor();
      await popup.locator('.st button[data-value="Fail"]').click();
      await popup.getByText('CMS/08: Fail, with evidence.').waitFor();
      assert.match((await caseIn('CMS/08')).comment, new RegExp(`Evidence: ${up.added.name.replace(/\./g, '\\.')}`));
      await popup.locator('[data-action=prev]').click();
      await popup.locator('.lb', { hasText: 'with evidence' }).waitFor();
      await popup.locator('.st button[data-value="Pass"]').click();
      await popup.locator('.ask', { hasText: 'Add a new screenshot or screen recording to mark it Pass.' }).waitFor();
      assert.equal(await popup.locator('.warn').count(), 0, 'no yellow box');
      assert.equal((await caseIn('CMS/08')).status, 'Fail', 'nothing saved yet');
      await popup.getByRole('button', { name: 'Cancel' }).click();
      await popup.locator('[data-action=remove]').click();
      await popup.getByText(`Delete ${up.added.name} for good?`).waitFor();
      await popup.getByRole('button', { name: 'Delete', exact: true }).click();
      await popup.getByText(`Deleted ${up.added.name}.`).waitFor();
      assert.equal((await caseIn('CMS/08')).evidence, null);
      assert.equal(existsSync(join(sheets, '.testrun', 'evidence', 'CMS Sign Off (sample)', TAB, 'v2.12', up.added.name)), false, 'gone from the host');
      await popup.locator('.st button[data-value="Pass"]').click();
      await popup.getByText('CMS/08: Pass.').waitFor();
    });

    await t.test('recording: the window gets out of the way; the popup has Pause and Stop in place of Record; a screenshot and a recording per case', async () => {
      const q = new URLSearchParams({ book: BOOK, tab: TAB, cycle: 'v2.12', key: 'CMS/10', id: 'CMS/10', scenario: 'Resolve with a photo', forStatus: 'Pass', test: 'pattern' });
      const rec = await ctx.newPage();
      await rec.goto(`chrome-extension://${TRX_ID}/recorder/recorder.html?${q}`);
      await rec.getByText('Pass is saved when this recording is attached.').waitFor();
      await rec.getByText(/1080p · 30 fps · up to 20 MB/).waitFor();
      await rec.getByText(/pause and stop from the Test Run Extension button/).waitFor();
      await rec.getByRole('button', { name: 'Choose what to record' }).click();
      await rec.getByRole('button', { name: '■ Stop' }).waitFor();
      // The popup while it records: Pause and Stop, half each, where Record was
      await popup.locator('#find').fill('CMS/10');
      await popup.locator('#find').press('Enter');
      const pause = popup.locator('.split [data-action=rec-pause]');
      const stop = popup.locator('.split [data-action=rec-stop]');
      await pause.waitFor();
      assert.equal(await popup.locator('[data-action=record]').count(), 0, 'no Record while recording');
      const [pb, sb, shot] = await Promise.all([pause.boundingBox(), stop.boundingBox(), popup.locator('[data-action=screenshot]').boundingBox()]);
      assert.ok(Math.abs(pb.width - sb.width) < 1, 'equal halves');
      assert.ok(Math.abs(pb.width + sb.width + 6 - shot.width) < 2, 'together as wide as Record was');
      await popup.locator('.rec-line', { hasText: 'Recording' }).waitFor();
      await pause.click();
      await rec.getByText('Paused').first().waitFor();
      await popup.locator('.rec-line', { hasText: 'Paused' }).waitFor();
      await popup.locator('.split [data-action=rec-resume]').click();
      await rec.getByRole('button', { name: '❚❚ Pause' }).waitFor();
      await rec.waitForTimeout(1500);
      await popup.locator('.split [data-action=rec-stop]').click();
      await rec.getByText(/Saved CMS\/10 as Pass, with CMS-10_v2\.12_.+\.(mp4|webm) as evidence\./).waitFor({ timeout: 20000 });
      await popup.locator('.flash', { hasText: 'Saved CMS/10 as Pass' }).waitFor();
      await popup.locator('[data-action=record]').waitFor(); // Record is back
      const c = await caseIn('CMS/10');
      assert.deepEqual([c.status, c.evidence.video.usedFor], ['Pass', 'Pass']);
      assert.ok(c.evidence.video.size > 1000 && c.evidence.video.size < 20 * 1024 * 1024);
      // and a screenshot: one of each, side by side
      const shotUp = await api('POST', `/api/evidence?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12&key=CMS%2F10`, PNG);
      assert.deepEqual(Object.keys(shotUp.evidence).sort(), ['photo', 'video']);
      await popup.locator('.file .name', { hasText: shotUp.added.name }).waitFor();
      await popup.locator('.file .name', { hasText: c.evidence.video.name }).waitFor();
      assert.equal(await popup.locator('.file').count(), 2);
      await rec.close();
      // Run in Test Run shows both, each with View and Remove
      await consolePage.reload();
      await consolePage.locator('[data-action=show][data-show=all]').click();
      await consolePage.locator('.case', { hasText: 'CMS/10' }).click();
      await consolePage.locator('.evidence-row', { hasText: 'Screenshot for Pass:' }).locator('.mono', { hasText: shotUp.added.name }).waitFor();
      await consolePage.locator('.evidence-row', { hasText: 'Recording for Pass:' }).locator('.mono', { hasText: c.evidence.video.name }).waitFor();
      assert.equal(await consolePage.locator('.evidence-row [data-action=ev-remove]').count(), 2);
    });

    await t.test('the host: Media sets the limits the extension shows; Download offers a Complete Report', async () => {
      await consolePage.locator('.nav [data-view=setup]').click();
      await consolePage.locator('[data-action=setup-part][data-part=media]').click();
      await consolePage.getByText('Limits for everyone').waitFor();
      await consolePage.locator('.seg [data-quality="720p"]').click();
      await consolePage.locator('.seg [data-quality="720p"][aria-pressed=true]').waitFor();
      await consolePage.locator('#mediaKeep option:checked', { hasText: '1 hr' }).waitFor({ state: 'attached' });
      await popup.reload();
      await popup.getByText(/Video 720p · 30 fps/).first().waitFor();

      await consolePage.locator('.nav [data-view=summary]').click();
      const dl = consolePage.locator('main .report-tools [data-action=dl-menu]');
      await dl.click();
      await consolePage.locator('.dl-menu', { hasText: 'Summary Report' }).waitFor();
      const box = await consolePage.locator('.dl-menu').boundingBox();
      const kpi = await consolePage.locator('.kpi').first().boundingBox();
      assert.ok(box.y < kpi.y + kpi.height, 'the menu floats over the page');
      await consolePage.locator('.dl-menu [data-action=complete-report]').click();
      const pop = consolePage.locator('.modal-box', { hasText: 'Complete Report' });
      await pop.locator('.cr-opt.off', { hasText: 'None yet' }).waitFor();
      await pop.getByRole('button', { name: 'Generate New' }).click();
      await consolePage.locator('.toast', { hasText: 'Your download will be ready in less than a minute.' }).waitFor();
      await consolePage.locator('.ready-bubble', { hasText: 'Download is ready, click here' }).waitFor({ timeout: 15000 });
      await dl.click();
      await consolePage.locator('.dl-menu [data-action=complete-report]').click();
      await pop.locator('.cr-opt.off', { hasText: /Wait for \d+:\d\d/ }).waitFor();
      await pop.getByText(/Created (just now|1 min ago)/).waitFor();
      const [download] = await Promise.all([consolePage.waitForEvent('download'), pop.getByRole('button', { name: 'Download Existing' }).click()]);
      assert.match(download.suggestedFilename(), /^CMS Sign Off \(sample\) - Complete Report\.zip$/);
    });

    await t.test('a View only link: just a message, with a link to the summary', async () => {
      await api('POST', '/api/team', { enabled: true, mode: 'fixed', fixedUrl: base.replace(/\/$/, '') });
      const boss = await api('POST', '/api/team/people', { name: 'Manager', role: 'viewer' });
      await popup.getByRole('button', { name: 'Sign out' }).click();
      await popup.getByText('Sign in to Test Run').waitFor();
      await popup.locator('#link').fill(boss.link);
      await popup.getByRole('button', { name: 'Sign in' }).click();
      await popup.getByText('Only view access, click here for summary').waitFor();
      assert.equal(await popup.getByText('Choose Workbook/Suite').count(), 0);
      const [summary] = await Promise.all([ctx.waitForEvent('page'), popup.getByRole('link', { name: 'here' }).click()]);
      await summary.locator('.user-btn[title="Manager · View only"]').waitFor(); // signed in with the link
      assert.match(summary.url(), /\?view=summary/);
      assert.doesNotMatch(summary.url(), /join=/, 'the key leaves the address bar');
    });

    assert.deepEqual(errors, [], 'no script errors');
  } finally {
    await ctx.close();
    server.close();
  }
});
