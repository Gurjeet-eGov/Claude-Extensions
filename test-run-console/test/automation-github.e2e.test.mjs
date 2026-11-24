// Automation with GitHub Actions in Chromium, against the fake GitHub (never the real one): Link a
// suite's GitHub steps (Check, workflow, results artifact, Import Latest Run), ▶ Run with the
// workflow's own options, the Running view (and the count on the Automation tab) until the results
// come in by themselves (a branch with another form swaps the fields), Import results › GitHub Run,
// and Setup › Automation (Exclude environments, and the hint when none is left). Skipped when
// Playwright is not installed, like the other browser tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeGithub, SAMPLE_WORKFLOW, SIMPLE_WORKFLOW, zipOf, sampleJunit } from '../dev/fake-github.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
for (const dir of [process.env.PLAYWRIGHT_DIR, join(homedir(), 'Documents/Citizen-Complaint-Resolution-System/tests/integration-tests/node_modules/playwright')].filter(Boolean)) {
  if (existsSync(dir)) { try { ({ chromium } = require(dir)); break; } catch { /* try next */ } }
}

const BOOK = 'CMS Sign Off (sample).xlsx';
const REPO = 'qa-team/cms-automation';

test('Automation with GitHub Actions in a browser', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const fake = makeFakeGithub({ login: 'host-gh', autoAdvance: { queuedMs: 600, stepMs: 400, results: () => zipOf({ 'results/junit.xml': sampleJunit(new Date().toISOString()) }) } });
  fake.addRepo(REPO, {
    defaultBranch: 'master', branches: ['master', 'develop', 'simple-run-form'], environments: ['net_two', 'github-pages'],
    workflows: [{ id: 101, name: 'Integration tests', path: '.github/workflows/integration.yml', yaml: SAMPLE_WORKFLOW, byBranch: { 'simple-run-form': SIMPLE_WORKFLOW } }],
  });
  fake.addRun(REPO, { workflowId: 101, event: 'schedule', conclusion: 'failure', number: 211, createdAt: Date.now() - 86400000, artifacts: [{ name: 'test-results', bytes: await zipOf({ 'junit.xml': sampleJunit(new Date(Date.now() - 86400000).toISOString()) }) }] });
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-augh-e2e-'));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh', github: fake.github, automationPollMs: 300, publishedDir: join(sheets, 'no-published-data') });
  const base = await server.listenOn(0);
  const req = async (method, path, body) => (await fetch(base + path.replace(/^\//, ''), { method, headers: { 'X-Test-Run': '1', 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined })).json();
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { book: BOOK, args });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((x) => ({ name: x.name, ...x.detected })) });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor();
  try {
    await t.test('Link a suite: Check, the workflow and its results artifact, Import Latest Run, Save Suite', async () => {
      await page.goto(`${base}?view=automation`);
      await page.locator('.empty [data-action=au-link]').click();
      await page.locator('#auRepo').fill(`https://github.com/${REPO}`);
      await page.getByRole('button', { name: 'Check', exact: true }).click();
      await page.locator('.check-line.ok', { hasText: `${REPO} · public · 1 workflow, 1 you can start by hand` }).waitFor();
      assert.equal(await page.locator('#au_l_wf > .grow').textContent(), 'Integration tests', 'the only one is chosen');
      await page.locator('#au_l_art > .grow', { hasText: 'test-results' }).waitFor();
      assert.equal(await page.locator('#au_l_env > .grow').textContent(), 'environment', 'an input called environment is guessed');
      await page.locator('#auName').fill('CMS Automation');
      await page.locator('#au_lk_cycle > .grow', { hasText: 'Cycle v2.12' }).waitFor();
      await page.getByRole('button', { name: 'Import Latest Run' }).click();
      await page.locator('.check-line.ok', { hasText: '✓ Read 5 tests from run #211' }).waitFor();
      await toast('Linked “CMS Automation” and imported its latest run into CMS 2.20.1 › Cycle v2.12.');
      await page.getByRole('button', { name: 'Save Suite' }).click();
      await toast('Saved “CMS Automation”.');
      await page.locator('.auto-head', { hasText: 'workflow Integration tests' }).waitFor();
      const actions = (await page.locator('.auto-head .row button').allTextContents()).map((x) => x.trim());
      assert.deepEqual(actions, ['✎ Edit', '⤒ Import Results', '▶ Run'], '▶ Run is the primary one, with no …');
      assert.equal(await page.locator('.auto-head .row button.primary').textContent(), '▶ Run');
    });

    await t.test('▶ Run: branch, the workflow\'s options, Workbook › Test suite › Test cycle; the run is followed until its results come in', async () => {
      await page.getByRole('button', { name: '▶ Run' }).click();
      await page.locator('h2', { hasText: 'Start a run' }).waitFor();
      await page.locator('#au_rn_branch > .grow', { hasText: 'master' }).waitFor();
      assert.equal(await page.locator('#au_in_scope > .grow').textContent(), 'smoke', 'a choice shows its default');
      await page.locator('#au_in_scope').click();
      await page.locator('.multi-pop .dd-item', { hasText: 'api' }).click();
      // another branch, another form: its own fields; what was picked stays where the field does
      await page.locator('#au_rn_branch').click();
      await page.locator('.multi-pop .dd-item', { hasText: 'simple-run-form' }).click();
      await page.locator('#au_in_headed').waitFor({ state: 'detached' });
      await page.locator('#au_in_environment.multi-btn').waitFor();
      assert.equal(await page.locator('#au_in_scope > .grow').textContent(), 'api', 'scope kept: the branch offers api too');
      await page.locator('#au_in_environment').click();
      assert.deepEqual((await page.locator('.multi-pop .dd-item .dd-label').allTextContents()), ['net_two'], 'github-pages is left out');
      await page.locator('.multi-pop .dd-item', { hasText: 'net_two' }).click();
      assert.equal(await page.locator('.no-envs').count(), 0);
      await page.locator('#au_rn_branch').click();
      await page.locator('.multi-pop .dd-item', { hasText: 'master' }).click();
      await page.locator('#au_in_headed').check();
      assert.equal(await page.locator('#au_in_scope > .grow').textContent(), 'api');
      await page.locator('.secrets-note', { hasText: 'GitHub environment net_two' }).waitFor();
      await page.locator('#au_rn_cycle > .grow', { hasText: 'Cycle v2.12' }).waitFor();
      await page.getByRole('button', { name: 'Start Run' }).click();
      await page.locator('h2', { hasText: /in GitHub Actions/ }).waitFor();
      await page.locator('.nav [data-view=automation] .count', { hasText: '1' }).waitFor();
      await page.getByRole('button', { name: '↗ GitHub Log' }).waitFor();
      await page.locator('.steps-list').first().waitFor();
      const sent = fake.callsTo(/dispatches$/, 'POST')[0].body;
      assert.deepEqual(sent, { ref: 'master', inputs: { environment: 'net_two', scope: 'api', headed: 'true' } });
      // the results come in by themselves, and the run opens
      await page.locator('h2', { hasText: 'CMS Automation · 1 failed' }).waitFor({ timeout: 15000 });
      await toast('Imported 5 tests into CMS 2.20.1 › Cycle v2.12 from GitHub Actions.');
      assert.equal(await page.locator('.nav [data-view=automation] .count').count(), 0, 'nothing going any more');
      await page.locator('.run-actions button', { hasText: '↗ Full Report' }).waitFor();
      assert.match(await page.locator('#frTip').textContent(), /Available until \d{1,2} [A-Z][a-z]{2} \d{4}\./, 'the date GitHub gave for the results artifact');
    });

    await t.test('Import results › GitHub Run, and Setup › Automation', async () => {
      await page.locator('[data-action=au-back]').first().click();
      await page.getByRole('button', { name: '⤒ Import Results' }).click();
      await page.getByRole('button', { name: 'GitHub Run' }).click();
      await page.locator('#au_gh_run').click();
      const opts = await page.locator('.multi-pop .dd-item').allTextContents();
      assert.ok(opts.every((x) => /already in Test Run/.test(x)), 'both runs are in Test Run already');
      await page.keyboard.press('Escape');
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('[data-part=automation]').click();
      await page.locator('.check-line.ok', { hasText: 'signed in as host-gh' }).waitFor();
      await page.locator('#auKeep').click();
      await page.locator('.multi-pop .dd-item', { hasText: '3' }).click();
      await toast('Saved. Test Run keeps the last 3 runs');
      await page.locator('td', { hasText: REPO }).waitFor();
      // Exclude environments: github-pages to start with; a name and Enter adds one, ✕ removes one
      assert.deepEqual((await page.locator('.filter-tag').allTextContents()).map((x) => x.replace('✕', '').trim()), ['github-pages']);
      await page.locator('#auExclude').fill('net_two');
      await page.locator('#auExclude').press('Enter');
      await toast('Saved. The run form leaves out github-pages, net_two.');
      await page.locator('.filter-tag', { hasText: 'net_two' }).waitFor();
      // none left to pick: ▶ Run says so, and links the guide
      await page.locator('.nav [data-view=automation]').click();
      await page.locator('[data-action=au-suite]', { hasText: 'CMS Automation' }).first().click();
      await page.getByRole('button', { name: '▶ Run' }).click();
      await page.locator('#au_rn_branch > .grow', { hasText: 'master' }).waitFor();
      await page.locator('#au_rn_branch').click();
      await page.locator('.multi-pop .dd-item', { hasText: 'simple-run-form' }).click();
      const hint = page.locator('.no-envs', { hasText: 'This repository has no GitHub environments yet.' });
      await hint.waitFor();
      assert.match(await hint.locator('a').getAttribute('href'), /test-run-console\/docs\/connect-a-suite\.md$/);
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('[data-part=automation]').click();
      await page.locator('.filter-tag', { hasText: 'net_two' }).locator('button').click();
      await toast('Saved. The run form leaves out github-pages.');
    });

    await t.test('no page errors', () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close();
    server.close();
  }
});
