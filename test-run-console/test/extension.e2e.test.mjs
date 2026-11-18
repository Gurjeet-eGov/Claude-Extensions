// Bug Reporter and Test Run together, in a real Chromium with the extension
// (from this repo) loaded. Checks what Chrome allows: the extension reaching
// the local server (host permission + Test Run's origin check), the review
// screen's checkbox appearing only while Test Run runs, and a note landing as
// a finding. Filing a real issue needs GitHub, so the note is sent the way the
// review screen does after filing, from the extension's own page.
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

test('Bug Reporter offers "Also add this scenario to Test Run" only while Test Run runs', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async () => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-ext-'));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir: sheets });
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
    await opts.locator('#trState', { hasText: 'Running: CMS Sign Off (sample) · CMS 2.20.1 · cycle v2.12' }).waitFor({ timeout: 5000 });

    // Review screen: the checkbox shows, with where the note goes.
    const rp = await context.newPage();
    await rp.goto(`chrome-extension://${EXT_ID}/report/report.html?id=r-e2e&dry=1`);
    await rp.locator('input[name=prio][value=P2]').check({ force: true });
    await rp.locator('#actual').fill('No Reopen button on a complaint resolved 4 days ago');
    await rp.locator('#skipClaude').click();
    await rp.locator('#trNote').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await rp.locator('#trWhere').textContent(), '(CMS Sign Off (sample) · CMS 2.20.1 · cycle v2.12)');
    assert.equal(await rp.locator('#trNoteChk').isChecked(), false, 'starts unticked');
    await rp.locator('#trNoteChk').check();
    assert.equal(await rp.evaluate(() => chrome.storage.local.get('testRunNote').then((x) => x.testRunNote)), true, 'choice remembered');

    // After filing, the page sends the note from the extension's origin.
    const res = await rp.evaluate(async () => {
      const m = await import('/lib/testrun.js');
      const s = await (await import('/lib/settings.js')).getSettings();
      return m.noteBugInTestRun(s, m.buildBugNote({
        title: 'Env: Citizen: Reopen button missing 4 days after resolution',
        filed: { number: 77, url: 'https://github.com/org/repo/issues/77' },
        repo: 'org/repo',
        draft: { description: 'Reopen is not offered', actual: 'No Reopen button', expected: 'Reopen offered within 5 days' },
        module: 'Citizen',
        pageUrl: 'https://env.example/digit-ui/citizen/complaints',
      }));
    });
    assert.deepEqual(res, { key: 'F-001', book: BOOK, tab: TAB });
    const f = (await call('api_listFindings')).findings[0];
    assert.deepEqual([f.source, f.issue, f.area], ['bug-reporter', '#77', 'Citizen']);

    // With Test Run stopped, the checkbox is gone.
    await new Promise((r) => server.close(r));
    await rp.locator('#back').click();
    await rp.locator('#skipClaude').click();
    await rp.waitForTimeout(1200);
    assert.equal(await rp.locator('#trNote').isVisible(), false);
  } finally {
    await context.close();
    server.close();
  }
});
