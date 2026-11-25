// Automation with GitHub Actions over HTTP, against the fake GitHub (dev/fake-github.mjs), never
// the real one: link a suite (check the repository, its workflows and inputs, the artifacts and
// which hold results), start a run and follow it (queued → in progress → completed → imported),
// a run that ends without its results artifact, cancelling, a restart that picks a run up again,
// Import from GitHub, Setup › Automation, and who may do what. Also: the run form read from the
// branch being run, the environments the host excludes, the artifact's expiry date, the environment
// field picked by itself, and the example workflow in docs/connect-a-suite.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { hashKey, newKey } from '../lib/team.mjs';
import { makeFakeGithub, SAMPLE_WORKFLOW, SIMPLE_WORKFLOW, zipOf, sampleJunit } from '../dev/fake-github.mjs';
import { parseWorkflowInputs } from '../lib/automation/github-runs.mjs';
import YAML from 'yaml';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const REPO = 'qa-team/cms-automation';
const WF = 101;
const ATTACH = { book: BOOK, tab: TAB, cycle: 'v2.12' };
const KEYS = { viewer: newKey(), tester: newKey(), norun: newKey(), other: newKey(), nobook: newKey() };

function fakeRepo(o = {}) {
  const fake = makeFakeGithub({ login: 'host-gh', ...o });
  fake.addRepo(REPO, {
    private: true, defaultBranch: 'master', branches: ['master', 'develop'], environments: ['net_two', 'bomet'],
    workflows: [
      { id: WF, name: 'Integration tests', path: '.github/workflows/integration.yml', yaml: SAMPLE_WORKFLOW },
      { id: 102, name: 'Lint', path: '.github/workflows/lint.yml', yaml: 'name: Lint\non: [push]\njobs: {}\n' },
      { id: 103, name: 'Pages', path: 'dynamic/pages/pages-build-deployment', yaml: '' },
    ],
  });
  return fake;
}

async function start({ fake = fakeRepo(), sheets } = {}) {
  if (!sheets) {
    sheets = join(mkdtempSync(join(tmpdir(), 'testrun-augh-')), 'sheets');
    mkdirSync(join(sheets, '.testrun'), { recursive: true });
    writeFileSync(join(sheets, '.testrun', 'app.json'), JSON.stringify({
      user: 'Host',
      team: { enabled: true, people: [
        { id: 'v1', name: 'Meera', role: 'viewer', hash: hashKey(KEYS.viewer) },
        { id: 't1', name: 'Priya', role: 'tester', hash: hashKey(KEYS.tester) },
        { id: 't2', name: 'Ravi', role: 'tester', hash: hashKey(KEYS.norun), startRuns: false },
        { id: 't3', name: 'Asha', role: 'tester', hash: hashKey(KEYS.other), automationSuites: ['some-other-suite'] },
        { id: 't4', name: 'Rahul', role: 'tester', hash: hashKey(KEYS.nobook), books: ['Bomet UAT.xlsx'] },
      ] },
    }));
    writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  }
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh', github: fake.github, automationPollMs: 60000 });
  const base = await server.listenOn(0);
  const req = async (method, path, body, key) => {
    const headers = { 'X-Test-Run': '1' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path.replace(/^\//, ''), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { book: BOOK, args });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  const gh = server.automation.github;
  return { server, sheets, fake, req, gh, close: () => server.close() };
}

async function linked(s, id = '') {
  const r = await s.req('POST', '/api/automation/github/link', { id, name: 'CMS Automation', repo: `https://github.com/${REPO}`, workflowId: WF, artifact: 'test-results', envInput: 'environment', casePattern: 'CMS/\\d+' });
  assert.equal(r.ok, true, r.error);
  return r.suite;
}
const results = (at) => zipOf({ 'results/junit.xml': sampleJunit(at), 'report/index.html': '<html></html>' });

test('the same results file in two artifacts of a run is offered once, in the smaller artifact', async () => {
  const s = await start();
  try {
    s.fake.addRun(REPO, { workflowId: WF, event: 'schedule', number: 212, artifacts: [
      { name: 'results-Nai Pepea', bytes: await zipOf({ 'results.xml': sampleJunit('2026-11-23T09:00:00Z'), 'report.json': '{"suites":[]}', 'run-meta.json': '{"runId":"x"}', 'report/index.html': '<html>' + 'x'.repeat(5000) + '</html>' }) },
      { name: 'test-results', bytes: await zipOf({ 'results/junit.xml': sampleJunit('2026-11-23T09:00:00Z') }) },
      { name: 'other-results', bytes: await zipOf({ 'junit.xml': sampleJunit('2026-11-23T10:00:00Z') }) }] });
    const twice = await s.req('POST', '/api/automation/github/artifacts', { repo: REPO, workflowId: WF });
    assert.equal(twice.run.number, 212);
    assert.deepEqual(twice.artifacts.map((x) => x.name), ['test-results', 'other-results'], 'one entry per results file; different results stay apart');
    assert.ok(twice.artifacts.every((x) => !('digest' in x)), 'the digest stays on the server');
  } finally { s.close(); }
});

test('link a suite: the repository checked, its workflows with their inputs, the artifacts with results', async () => {
  const s = await start();
  try {
    const st = await s.req('GET', '/api/automation/github/status');
    assert.deepEqual([st.ok, st.transport, st.login], [true, 'fake', 'host-gh']);
    const c = await s.req('POST', '/api/automation/github/check', { repo: `https://github.com/${REPO}/actions` });
    assert.equal(c.ok, true, c.error);
    assert.deepEqual([c.repo.fullName, c.repo.private, c.repo.defaultBranch], [REPO, true, 'master']);
    assert.deepEqual(c.workflows.map((w) => [w.name, w.dispatch]), [['Integration tests', true], ['Lint', false]], 'only workflow files; Lint has no workflow_dispatch');
    assert.deepEqual(c.counts, { total: 2, dispatch: 1 });
    assert.deepEqual(c.workflows[0].inputs.map((x) => x.name), ['environment', 'scope', 'grep', 'headed']);
    assert.equal((await s.req('POST', '/api/automation/github/check', { repo: 'https://github.com/qa-team/nope' })).code, 'GH_NOT_FOUND');
    assert.equal((await s.req('POST', '/api/automation/github/check', { repo: 'https://gitlab.com/a/b' })).code, 'BAD_INPUT');

    // no finished run yet: no artifacts to look in
    assert.deepEqual((await s.req('POST', '/api/automation/github/artifacts', { repo: REPO, workflowId: WF })).artifacts, []);
    s.fake.addRun(REPO, { workflowId: WF, event: 'schedule', conclusion: 'failure', number: 211, artifacts: [{ name: 'test-results', bytes: await results('2026-11-23T08:00:00Z') }, { name: 'playwright-report', bytes: await zipOf({ 'index.html': '<html>' }) }] });
    const a = await s.req('POST', '/api/automation/github/artifacts', { repo: REPO, workflowId: WF });
    assert.equal(a.run.number, 211);
    assert.deepEqual(a.artifacts.map((x) => [x.name, x.results && x.results.formatLabel, x.results && x.results.tests, x.note]), [['test-results', 'JUnit XML', 5, ''], ['playwright-report', null, null, 'no results file']]);

    assert.equal((await s.req('POST', '/api/automation/github/link', { name: 'Lint', repo: REPO, workflowId: 102 })).code, 'BAD_INPUT', 'a workflow that cannot be started by hand');
    assert.equal((await s.req('POST', '/api/automation/github/link', { name: 'X', repo: REPO, workflowId: WF, envInput: 'nope' })).code, 'BAD_INPUT');
    const suite = await linked(s);
    assert.deepEqual([suite.repo, suite.workflowId, suite.workflowPath, suite.workflow, suite.artifact, suite.envInput, suite.defaultBranch], [REPO, WF, '.github/workflows/integration.yml', 'Integration tests', 'test-results', 'environment', 'master']);
    assert.equal(suite.inputs.find((x) => x.name === 'scope').required, true);
    const list = await s.req('GET', '/api/automation');
    assert.equal(list.suites[0].workflowId, WF, 'the page sees the link');
    // a change of repository in Edit drops the workflow link that no longer fits
    const moved = await s.req('POST', '/api/automation/suites', { id: suite.id, name: 'CMS Automation', repo: 'qa-team/elsewhere' });
    assert.deepEqual([moved.suite.workflowId, moved.suite.inputs, moved.suite.artifact], [0, [], '']);

    // ⤒ Import Results (Link a suite): the latest finished run, attached where asked (required), only once
    await linked(s, suite.id);
    assert.equal((await s.req('POST', '/api/automation/github/import', { suite: suite.id })).code, 'NO_ATTACH');
    const im = await s.req('POST', '/api/automation/github/import', { suite: suite.id, ...ATTACH });
    assert.equal(im.ok, true, im.error);
    assert.deepEqual([im.githubRun.number, im.run.totals.total, im.run.source.kind, im.run.source.repo, im.run.source.runUrl], [211, 5, 'github', REPO, `https://github.com/${REPO}/actions/runs/${im.githubRun.id}`]);
    assert.equal((await s.req('POST', '/api/automation/github/import', { suite: suite.id, ...ATTACH })).code, 'ALREADY');
    const recent = await s.req('GET', `/api/automation/github/runs?suite=${suite.id}`);
    assert.deepEqual(recent.runs.map((r) => [r.number, r.kept, r.event]), [[211, true, 'schedule']]);
  } finally { s.close(); }
});

test('start a run and follow it: found after the dispatch, queued, in progress, completed, imported by itself', async () => {
  const s = await start();
  try {
    const suite = await linked(s);
    // someone else's run on the same branch, just before: never taken for ours
    s.fake.addRun(REPO, { workflowId: WF, event: 'workflow_dispatch', branch: 'master', status: 'in_progress', actor: 'someone-else', createdAt: Date.now() });
    const b = await s.req('GET', `/api/automation/github/branches?suite=${suite.id}`);
    assert.deepEqual([b.branches.map((x) => x.name), b.defaultBranch], [['master', 'develop'], 'master']);
    assert.equal((await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: { scope: 'smoke' } })).code, 'NO_ATTACH', 'never without a workbook › test suite › cycle');
    assert.equal((await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: { scope: 'all' }, ...ATTACH })).code, 'BAD_INPUT');
    assert.match((await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'nope', inputs: {}, ...ATTACH })).error, /no branch “nope”/);
    const r = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: { environment: 'bomet', scope: 'api', headed: true }, ...ATTACH });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.job.state, r.job.githubRunId, r.job.env, r.job.by, r.job.attach], ['waiting', null, 'bomet', 'Host', ATTACH]);
    const sent = s.fake.callsTo(/dispatches$/, 'POST').at(-1).body;
    assert.deepEqual(sent, { ref: 'master', inputs: { environment: 'bomet', scope: 'api', headed: 'true' } }, 'values as text, as GitHub takes them');
    assert.equal(r.job.known, undefined, 'internals stay on the server');
    const jobsFile = join(s.sheets, '.testrun', 'automation', 'jobs.json');
    assert.equal(JSON.parse(readFileSync(jobsFile, 'utf8')).jobs[0].id, r.job.id, 'kept on disk');

    const ours = s.fake.runs(REPO).find((x) => x.inputs.scope === 'api');
    await s.gh.tick();
    let j = (await s.req('GET', `/api/automation/job?id=${r.job.id}`)).job;
    assert.deepEqual([j.githubRunId, j.state, j.runNumber], [ours.id, 'queued', ours.number], 'found: ours, not the other one');
    s.fake.setRun(REPO, ours.id, { status: 'in_progress', jobs: [{ name: 'Run tests', status: 'in_progress', steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run the tests', status: 'in_progress', conclusion: null }] }] });
    await s.gh.tick();
    j = (await s.req('GET', '/api/automation/jobs')).jobs[0];
    assert.equal(j.state, 'in_progress');
    assert.deepEqual(j.jobs[0].steps.map((x) => [x.name, x.status]), [['Set up job', 'completed'], ['Run the tests', 'in_progress']]);
    s.fake.addArtifact(REPO, ours.id, 'test-results', await results('2026-11-24T10:00:00Z'));
    s.fake.setRun(REPO, ours.id, { status: 'completed', conclusion: 'failure' });
    await s.gh.tick();
    j = (await s.req('GET', `/api/automation/job?id=${r.job.id}`)).job;
    assert.equal(j.state, 'imported', j.message);
    assert.deepEqual(j.totals, { passed: 3, failed: 1, skipped: 1, flaky: 0, total: 5 });
    const run = (await s.req('GET', `/api/automation/run?id=${j.importedRunId}`)).run;
    assert.deepEqual([run.source.kind, run.source.runId, run.branch, run.sha, run.env, run.options, run.attach], ['github', String(ours.id), 'master', ours.sha, 'bomet', { scope: 'api', headed: 'headed' }, ATTACH]);
    assert.deepEqual(run.tests.find((t) => t.status === 'fail').caseIds, ['CMS/02'], 'the suite\'s case-ID pattern applies');
    // a finished job can be dismissed; a running one cannot
    assert.equal((await s.req('POST', '/api/automation/job/dismiss', { id: j.id })).ok, true);
    assert.equal((await s.req('GET', '/api/automation/jobs')).jobs.length, 0);
  } finally { s.close(); }
});

test('a run without its results artifact, an artifact without a results file, and a cancelled run', async () => {
  const s = await start();
  try {
    const suite = await linked(s);
    // without results
    const r1 = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'develop', inputs: {}, ...ATTACH });
    const run1 = s.fake.runs(REPO).at(-1);
    s.fake.addArtifact(REPO, run1.id, 'coverage', await zipOf({ 'lcov.info': 'x' }));
    s.fake.setRun(REPO, run1.id, { status: 'completed', conclusion: 'success' });
    await s.gh.tick();
    let j = (await s.req('GET', `/api/automation/job?id=${r1.job.id}`)).job;
    assert.equal(j.state, 'no_results');
    assert.match(j.message, /no artifact named “test-results” \(it has “coverage”\)/);
    assert.equal(j.runUrl, `https://github.com/${REPO}/actions/runs/${run1.id}`, 'a link to the run on GitHub');
    // an artifact with no results file in it
    const r2 = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: {}, ...ATTACH });
    const run2 = s.fake.runs(REPO).at(-1);
    s.fake.addArtifact(REPO, run2.id, 'test-results', await zipOf({ 'notes.txt': 'hello' }));
    s.fake.setRun(REPO, run2.id, { status: 'completed', conclusion: 'success' });
    await s.gh.tick();
    j = (await s.req('GET', `/api/automation/job?id=${r2.job.id}`)).job;
    assert.deepEqual([j.state, /no JUnit XML or CTRF JSON/.test(j.message)], ['no_results', true]);
    // cancelled: asks GitHub, and ends as cancelled
    const r3 = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: {}, ...ATTACH });
    const run3 = s.fake.runs(REPO).at(-1);
    s.fake.setRun(REPO, run3.id, { status: 'in_progress' });
    await s.gh.tick();
    const c = await s.req('POST', '/api/automation/job/cancel', { id: r3.job.id });
    assert.equal(c.ok, true, c.error);
    assert.equal(s.fake.callsTo(new RegExp(`runs/${run3.id}/cancel$`), 'POST').length, 1);
    assert.equal((await s.req('POST', '/api/automation/job/dismiss', { id: r3.job.id })).code, 'RUNNING');
    await s.gh.tick();
    j = (await s.req('GET', `/api/automation/job?id=${r3.job.id}`)).job;
    assert.deepEqual([j.state, j.conclusion], ['cancelled', 'cancelled']);
    assert.equal((await s.req('POST', '/api/automation/job/cancel', { id: r3.job.id })).code, 'DONE');
    assert.equal((await s.req('GET', '/api/automation')).runs.length, 0, 'nothing was imported');
  } finally { s.close(); }
});

test('a run going when Test Run stops is followed again after a restart', async () => {
  const fake = fakeRepo();
  const s1 = await start({ fake });
  const suite = await linked(s1);
  const r = await s1.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: { scope: 'full' }, ...ATTACH });
  await s1.gh.tick();
  assert.equal((await s1.req('GET', `/api/automation/job?id=${r.job.id}`)).job.state, 'queued');
  s1.close();
  const run = fake.runs(REPO).at(-1);
  fake.addArtifact(REPO, run.id, 'test-results', await results('2026-11-24T11:00:00Z'));
  fake.setRun(REPO, run.id, { status: 'completed', conclusion: 'success' });
  const s2 = await start({ fake, sheets: s1.sheets });
  try {
    await s2.gh.settle(3000);
    const j = (await s2.req('GET', `/api/automation/job?id=${r.job.id}`)).job;
    assert.equal(j.state, 'imported', j.message);
    assert.equal((await s2.req('GET', '/api/automation')).runs.length, 1, 'imported once');
  } finally { s2.close(); }
});

test('who may: viewers, testers without Start runs, suites not shared, workbooks not shared; Setup › Automation is the host\'s', async () => {
  const s = await start();
  try {
    const suite = await linked(s);
    const runBody = { suite: suite.id, branch: 'master', inputs: {}, ...ATTACH };
    assert.equal((await s.req('POST', '/api/automation/github/run', runBody, KEYS.viewer)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/github/run', runBody, KEYS.norun)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/github/run', runBody, KEYS.other)).code, 'NO_SUITE', 'a suite not shared with them');
    assert.equal((await s.req('POST', '/api/automation/github/run', runBody, KEYS.nobook)).code, 'FORBIDDEN', 'a workbook not shared with them');
    assert.equal((await s.req('POST', '/api/automation/github/import', { suite: suite.id, ...ATTACH }, KEYS.viewer)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/github/check', { repo: REPO }, KEYS.viewer)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/github/check', { repo: REPO }, KEYS.norun)).status, 403);
    assert.equal((await s.req('GET', `/api/automation/github/branches?suite=${suite.id}`, undefined, KEYS.viewer)).status, 403);
    const t = await s.req('POST', '/api/automation/github/run', runBody, KEYS.tester);
    assert.equal(t.ok, true, t.error);
    assert.equal(t.job.by, 'Priya');
    // seeing the run going: the suite and the workbook
    assert.equal((await s.req('GET', '/api/automation/jobs', undefined, KEYS.viewer)).jobs.length, 1, 'a viewer follows it');
    assert.equal((await s.req('GET', '/api/automation/jobs', undefined, KEYS.other)).jobs.length, 0);
    assert.equal((await s.req('GET', '/api/automation/jobs', undefined, KEYS.nobook)).jobs.length, 0);
    assert.equal((await s.req('GET', `/api/automation/job?id=${t.job.id}`, undefined, KEYS.nobook)).code, 'GONE');
    assert.equal((await s.req('POST', '/api/automation/job/cancel', { id: t.job.id }, KEYS.viewer)).status, 403);
    // Setup › Automation
    assert.equal((await s.req('GET', '/api/automation/github/status', undefined, KEYS.tester)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/settings', { keep: 3 }, KEYS.tester)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/settings', { keep: 0 })).code, 'BAD_INPUT');
    assert.equal((await s.req('POST', '/api/automation/settings', { keep: 3 })).keep, 3);
    assert.equal((await s.req('GET', '/api/automation')).keep, 3);
    assert.equal(JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8')).automation.keep, 3, 'kept in app.json');
    // how often GitHub is asked about a running run: 5 minutes by default, 1 while debugging, nothing else
    assert.equal((await s.req('GET', '/api/automation')).checkEvery, 5, 'default 5 minutes');
    assert.equal((await s.req('POST', '/api/automation/settings', { checkEvery: 1 }, KEYS.tester)).status, 403);
    assert.equal((await s.req('POST', '/api/automation/settings', { checkEvery: 3 })).code, 'BAD_INPUT');
    assert.equal((await s.req('POST', '/api/automation/settings', { checkEvery: 1 })).checkEvery, 1);
    assert.equal((await s.req('GET', '/api/automation')).checkEvery, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8')).automation, { keep: 3, checkEvery: 1, excludeEnvironments: ['github-pages'] }, 'both kept in app.json');
    assert.equal((await s.req('POST', '/api/automation/settings', {})).code, 'BAD_INPUT');
  } finally { s.close(); }
});

test('the check pace: 5 minutes unless set to 1; anything else falls back to 5', async () => {
  const { normalizeAutomationSettings } = await import('../lib/automation/store.mjs');
  assert.equal(normalizeAutomationSettings({}).checkEvery, 5);
  assert.equal(normalizeAutomationSettings({ checkEvery: 1 }).checkEvery, 1);
  assert.equal(normalizeAutomationSettings({ checkEvery: 3 }).checkEvery, 5);
  assert.equal(normalizeAutomationSettings({ checkEvery: '1' }).checkEvery, 1);
});

test('GitHub access problems are reported in plain words', async () => {
  const fake = fakeRepo();
  const s = await start({ fake });
  try {
    fake.failNext('GET', /^user$/, 401, 'Bad credentials');
    const st = await s.req('GET', '/api/automation/github/status');
    assert.deepEqual([st.ok, st.code], [false, 'GH_AUTH']);
    assert.match(st.error, /gh auth login/);
    const suite = await linked(s);
    fake.failNext('POST', /dispatches$/, 403, 'Resource not accessible by integration');
    const r = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: {}, ...ATTACH });
    assert.equal(r.code, 'GH_FORBIDDEN');
    assert.match(r.error, /Actions write/);
    assert.equal((await s.req('GET', '/api/automation/jobs')).jobs.length, 0, 'no job for a run that did not start');
  } finally { s.close(); }
});

/** The suite's repository with a second form on branch simple-run-form (and none on no-workflow). */
function twoForms(o = {}) {
  const fake = fakeRepo(o);
  const r = fake.repos.get(REPO);
  r.branches.push('simple-run-form', 'no-workflow');
  r.environments = ['net_two', 'bomet', 'github-pages'];
  r.workflows[0].byBranch = { 'simple-run-form': SIMPLE_WORKFLOW, 'no-workflow': null };
  return fake;
}
const form = (s, suite, branch, key) => s.req('GET', `/api/automation/github/form?suite=${suite.id}&branch=${encodeURIComponent(branch)}`, undefined, key);
const names = (list) => list.map((x) => x.name);

test('the run form comes from the branch being run: its own fields, and only those are sent', async () => {
  const fake = twoForms();
  const s = await start({ fake });
  try {
    const suite = await linked(s);
    assert.deepEqual(names(suite.inputs), ['environment', 'scope', 'grep', 'headed'], 'the saved copy: master\'s form');
    let f = await form(s, suite, 'master');
    assert.equal(f.ok, true, f.error);
    assert.deepEqual([names(f.inputs), f.from, f.dispatch, f.note, f.refreshed], [['environment', 'scope', 'grep', 'headed'], 'branch', true, '', false]);
    assert.deepEqual([f.environments, f.noEnvironments], [[], false], 'master\'s environment is a choice: no environments to list');
    f = await form(s, suite, 'simple-run-form');
    assert.deepEqual(names(f.inputs), ['environment', 'scope', 'grep'], 'the branch\'s own form');
    assert.deepEqual([f.inputs[0].type, f.inputs[0].required, f.inputs[1].default], ['environment', true, 'full']);
    assert.deepEqual(f.environments, ['net_two', 'bomet'], 'github-pages is left out');
    assert.equal(f.noEnvironments, false);
    assert.equal(fake.callsTo(/contents\//).at(-1).query.ref, 'simple-run-form', 'read on that branch');

    // GitHub refuses fields the branch's workflow doesn't have…
    await assert.rejects(fake.github.dispatchWorkflow('qa-team', 'cms-automation', WF, 'simple-run-form', { environment: 'bomet', headed: 'true' }), /Unexpected inputs provided: \["headed"\]/);
    // …so only the branch's fields are sent, whatever the page sends
    const r = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'simple-run-form', inputs: { environment: 'bomet', scope: 'smoke', grep: '', headed: true }, ...ATTACH });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(fake.callsTo(/dispatches$/, 'POST').at(-1).body, { ref: 'simple-run-form', inputs: { environment: 'bomet', scope: 'smoke' } });
    assert.deepEqual([r.job.env, r.job.inputs, r.job.flags], ['bomet', { environment: 'bomet', scope: 'smoke' }, []]);
    // a choice the branch's form doesn't offer is refused before GitHub is asked
    assert.equal((await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'simple-run-form', inputs: { environment: 'bomet', scope: 'citizen' }, ...ATTACH })).code, 'BAD_INPUT');
    // and master still runs with master's form
    const m = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: { scope: 'api', headed: true }, ...ATTACH });
    assert.equal(m.ok, true, m.error);
    assert.deepEqual(fake.callsTo(/dispatches$/, 'POST').at(-1).body, { ref: 'master', inputs: { environment: 'net_two', scope: 'api', headed: 'true' } });

    // a branch without the workflow file: the saved form, and a note saying it can't run there
    f = await form(s, suite, 'no-workflow');
    assert.deepEqual([f.from, f.dispatch, names(f.inputs)], ['saved', false, ['environment', 'scope', 'grep', 'headed']]);
    assert.match(f.note, /isn't on no-workflow/);
    // GitHub can't be read: the form saved when the suite was linked
    fake.failNext('GET', /\/contents\//, 502, 'Server Error');
    f = await form(s, suite, 'simple-run-form');
    assert.deepEqual([f.ok, f.from, names(f.inputs)], [true, 'saved', ['environment', 'scope', 'grep', 'headed']]);
    assert.match(f.note, /saved when the suite was linked/);
    fake.failNext('GET', /\/contents\//, 502, 'Server Error');
    const fb = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: { scope: 'full' }, ...ATTACH });
    assert.equal(fb.ok, true, fb.error);
    assert.deepEqual(fake.callsTo(/dispatches$/, 'POST').at(-1).body.inputs, { environment: 'net_two', scope: 'full', headed: 'false' }, 'started with the saved form');

    // who may: as for the other suite routes
    assert.equal((await form(s, suite, 'master', KEYS.viewer)).status, 403);
    assert.equal((await form(s, suite, 'master', KEYS.norun)).status, 403);
    assert.equal((await form(s, suite, 'master', KEYS.other)).code, 'NO_SUITE');
    assert.equal((await form(s, suite, '')).code, 'BAD_INPUT');
    assert.equal((await form(s, suite, 'master', KEYS.tester)).ok, true);
  } finally { s.close(); }
});

test('the default branch\'s form changed: the saved copy is refreshed, its environment field picked', async () => {
  const fake = twoForms();
  const s = await start({ fake });
  try {
    const suite = await linked(s);
    assert.deepEqual((await s.req('GET', `/api/automation/github/branches?suite=${suite.id}`)).environments, [], 'no environment field in the saved form yet');
    fake.repos.get(REPO).workflows[0].yaml = SIMPLE_WORKFLOW; // master now has the simpler form
    const f = await form(s, suite, 'master');
    assert.deepEqual([f.refreshed, f.envInput, names(f.inputs)], [true, 'environment', ['environment', 'scope', 'grep']]);
    const kept = (await s.req('GET', '/api/automation')).suites[0];
    assert.deepEqual([names(kept.inputs), kept.envInput], [['environment', 'scope', 'grep'], 'environment']);
    const onDisk = JSON.parse(readFileSync(join(s.sheets, '.testrun', 'automation', 'suites.json'), 'utf8')).suites[0];
    assert.deepEqual(names(onDisk.inputs), ['environment', 'scope', 'grep'], 'kept in suites.json');
    assert.equal((await form(s, suite, 'master')).refreshed, false, 'once');
    // the run form's branches() now lists the environments too, less github-pages
    assert.deepEqual((await s.req('GET', `/api/automation/github/branches?suite=${suite.id}`)).environments, ['net_two', 'bomet']);
    // another branch's form never replaces the saved copy
    fake.repos.get(REPO).workflows[0].byBranch.develop = SAMPLE_WORKFLOW;
    assert.equal((await form(s, suite, 'develop')).refreshed, false);
    assert.deepEqual(names((await s.req('GET', '/api/automation')).suites[0].inputs), ['environment', 'scope', 'grep']);
  } finally { s.close(); }
});

test('no environments to pick: the run form says so (the hint links the guide)', async () => {
  const fake = twoForms();
  fake.repos.get(REPO).environments = ['github-pages'];
  const s = await start({ fake });
  try {
    const suite = await linked(s);
    let f = await form(s, suite, 'simple-run-form');
    assert.deepEqual([f.environments, f.noEnvironments], [[], true], 'only github-pages, which is left out');
    assert.equal((await form(s, suite, 'master')).noEnvironments, false, 'master has no environment field');
    fake.failNext('GET', /\/environments$/, 403, 'Resource not accessible');
    assert.equal((await form(s, suite, 'simple-run-form')).noEnvironments, false, 'not known: no hint');
    assert.deepEqual((await s.req('POST', '/api/automation/settings', { excludeEnvironments: [] })).excludeEnvironments, []);
    f = await form(s, suite, 'simple-run-form');
    assert.deepEqual([f.environments, f.noEnvironments], [['github-pages'], false], 'nothing excluded: github-pages is listed');
  } finally { s.close(); }
});

test('Exclude environments (Setup › Automation): the host\'s, checked, kept in app.json, matched without regard to case', async () => {
  const fake = twoForms();
  fake.repos.get(REPO).environments = ['net_two', 'GitHub-Pages', 'Staging', 'bomet'];
  const s = await start({ fake });
  try {
    const suite = await linked(s);
    const app = () => JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8')).automation;
    assert.deepEqual((await s.req('GET', '/api/automation')).excludeEnvironments, ['github-pages'], 'github-pages to start with');
    assert.deepEqual((await form(s, suite, 'simple-run-form')).environments, ['net_two', 'Staging', 'bomet'], 'GitHub-Pages is left out too');
    assert.equal((await s.req('POST', '/api/automation/settings', { excludeEnvironments: ['x'] }, KEYS.tester)).status, 403);
    for (const bad of ['github-pages', [1], [''], ['  '], ['a'.repeat(101)], Array.from({ length: 21 }, (_, i) => `e${i}`), { a: 1 }]) {
      assert.equal((await s.req('POST', '/api/automation/settings', { excludeEnvironments: bad })).code, 'BAD_INPUT', JSON.stringify(bad).slice(0, 40));
    }
    assert.deepEqual(app().excludeEnvironments, ['github-pages'], 'unchanged by the refused ones');
    const r = await s.req('POST', '/api/automation/settings', { excludeEnvironments: ['github-pages', ' staging '] });
    assert.deepEqual(r.excludeEnvironments, ['github-pages', 'staging'], 'trimmed');
    assert.deepEqual((await s.req('GET', '/api/automation')).excludeEnvironments, ['github-pages', 'staging']);
    assert.deepEqual(app(), { keep: 2, checkEvery: 5, excludeEnvironments: ['github-pages', 'staging'] }, 'kept in app.json');
    assert.deepEqual((await form(s, suite, 'simple-run-form')).environments, ['net_two', 'bomet'], 'Staging is left out');
    assert.deepEqual((await s.req('POST', '/api/automation/settings', { excludeEnvironments: Array.from({ length: 20 }, (_, i) => `e${i}`) })).excludeEnvironments.length, 20, '20 is the most');
    // cleared: every environment is listed, and the empty list is kept (not the default again)
    assert.deepEqual((await s.req('POST', '/api/automation/settings', { excludeEnvironments: [] })).excludeEnvironments, []);
    assert.deepEqual(app().excludeEnvironments, []);
    assert.deepEqual((await form(s, suite, 'simple-run-form')).environments, ['net_two', 'GitHub-Pages', 'Staging', 'bomet']);
    s.close();
    const s2 = await start({ fake, sheets: s.sheets });
    try {
      assert.deepEqual((await s2.req('GET', '/api/automation')).excludeEnvironments, [], 'still cleared after a restart');
    } finally { s2.close(); }
  } finally { s.close(); }
});

test('the environment field is picked by itself when linking', async () => {
  const fake = twoForms();
  fake.repos.get(REPO).workflows[0].yaml = SIMPLE_WORKFLOW;
  const s = await start({ fake });
  try {
    const r = await s.req('POST', '/api/automation/github/link', { name: 'CMS 3.0', repo: REPO, workflowId: WF, artifact: 'test-results', envInput: '' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.suite.envInput, 'environment', 'its input of type environment');
    // a form without one: none, unless chosen
    fake.repos.get(REPO).workflows[0].yaml = SAMPLE_WORKFLOW;
    const r2 = await s.req('POST', '/api/automation/github/link', { id: r.suite.id, name: 'CMS 3.0', repo: REPO, workflowId: WF, artifact: 'test-results', envInput: '' });
    assert.equal(r2.suite.envInput, '', 'environment there is a choice: not guessed on the server');
    const r3 = await s.req('POST', '/api/automation/github/link', { id: r.suite.id, name: 'CMS 3.0', repo: REPO, workflowId: WF, artifact: 'test-results', envInput: 'scope' });
    assert.equal(r3.suite.envInput, 'scope', 'what was chosen stays');
  } finally { s.close(); }
});

test('the results artifact\'s expiry date is kept with the run, for the Full report\'s ?', async () => {
  const s = await start();
  try {
    const suite = await linked(s);
    s.fake.addRun(REPO, { workflowId: WF, event: 'schedule', number: 301, createdAt: Date.parse('2026-11-23T08:00:00Z'), artifacts: [{ name: 'test-results', bytes: await results('2026-11-23T08:00:00Z'), expiresAt: Date.parse('2026-12-08T09:30:00Z') }] });
    const im = await s.req('POST', '/api/automation/github/import', { suite: suite.id, ...ATTACH });
    assert.equal(im.ok, true, im.error);
    assert.equal(im.run.source.expiresAt, '2026-12-08T09:30:00.000Z');
    assert.equal((await s.req('GET', `/api/automation/run?id=${im.run.id}`)).run.source.expiresAt, '2026-12-08T09:30:00.000Z', 'the run view has it');
    const cyc = await s.req('GET', `/api/automation/cycle?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
    assert.equal(cyc.latest.source.expiresAt, '2026-12-08T09:30:00.000Z', 'Summary › Automated has it');
    assert.equal(cyc.runs[0].source.expiresAt, '2026-12-08T09:30:00.000Z');
    // GitHub gives no date: none kept (the ? then says "at most 90 days")
    s.fake.addRun(REPO, { workflowId: WF, event: 'schedule', number: 302, artifacts: [{ name: 'test-results', bytes: await results('2026-11-24T08:00:00Z'), expiresAt: null }] });
    const im2 = await s.req('POST', '/api/automation/github/import', { suite: suite.id, ...ATTACH });
    assert.equal(im2.ok, true, im2.error);
    assert.equal(im2.run.source.expiresAt, '');
    // a run started from Test Run keeps it too
    const r = await s.req('POST', '/api/automation/github/run', { suite: suite.id, branch: 'master', inputs: {}, ...ATTACH });
    const ours = s.fake.runs(REPO).at(-1);
    s.fake.addArtifact(REPO, ours.id, 'test-results', await results('2026-11-24T10:00:00Z'), { expiresAt: Date.parse('2027-02-22T10:00:00Z') });
    s.fake.setRun(REPO, ours.id, { status: 'completed', conclusion: 'success' });
    await s.gh.tick();
    const j = (await s.req('GET', `/api/automation/job?id=${r.job.id}`)).job;
    assert.equal(j.state, 'imported', j.message);
    assert.equal((await s.req('GET', `/api/automation/run?id=${j.importedRunId}`)).run.source.expiresAt, '2027-02-22T10:00:00.000Z');
  } finally { s.close(); }
});

test('the guide\'s example workflow (docs/connect-a-suite.md) reads as a run form with an environment field', () => {
  const md = readFileSync(new URL('../docs/connect-a-suite.md', import.meta.url), 'utf8');
  const block = /```yaml\n([\s\S]*?)```/.exec(md);
  assert.ok(block, 'a yaml block');
  const lines = block[1].trim().split('\n').length;
  assert.ok(lines >= 20 && lines <= 32, `about 25 lines (${lines})`);
  const p = parseWorkflowInputs(block[1]);
  assert.equal(p.dispatch, true, 'workflow_dispatch');
  assert.deepEqual([p.inputs[0].name, p.inputs[0].type, p.inputs[0].required], ['environment', 'environment', true]);
  const doc = YAML.parse(block[1]);
  const job = Object.values(doc.jobs)[0];
  assert.equal(job.environment, '${{ inputs.environment }}');
  const upload = job.steps.find((x) => String(x.uses || '').startsWith('actions/upload-artifact@v4'));
  assert.deepEqual([upload.if, upload.with.name, upload.with['retention-days']], ['always()', 'test-results', 90]);
  const run = job.steps.find((x) => x.env && x.env.CONFIG_ENV);
  assert.deepEqual([run.env.CONFIG_ENV, run.env.SECRETS_ENV], ['${{ secrets.CONFIG_ENV }}', '${{ secrets.SECRETS_ENV }}'], 'secrets passed as env');
  // the guide is linked from the console's docs and the README
  assert.match(readFileSync(new URL('../docs/automation.md', import.meta.url), 'utf8'), /\(connect-a-suite\.md\)/);
  assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /\(docs\/connect-a-suite\.md\)/);
});
