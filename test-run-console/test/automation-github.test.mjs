// Automation with GitHub Actions over HTTP, against the fake GitHub (dev/fake-github.mjs), never
// the real one: link a suite (check the repository, its workflows and inputs, the artifacts and
// which hold results), start a run and follow it (queued → in progress → completed → imported),
// a run that ends without its results artifact, cancelling, a restart that picks a run up again,
// Import from GitHub, Setup › Automation, and who may do what.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { hashKey, newKey } from '../lib/team.mjs';
import { makeFakeGithub, SAMPLE_WORKFLOW, zipOf, sampleJunit } from '../dev/fake-github.mjs';

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

    // Import Latest Run: the latest finished run, attached where asked (required), only once
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
  } finally { s.close(); }
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
