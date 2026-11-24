// A stand-in for GitHub's REST API, as a transport for lib/github.mjs (createGithub({ transport })),
// for the tests and local previews (node server.mjs --demo --fake-github). It answers the REST paths
// Test Run uses, from repositories held in memory: the account, repositories, branches,
// environments, workflows and their files (contents API, base64), starting a workflow
// (dispatches), its runs, jobs and steps, artifacts and their zips, cancelling, gists and the
// GraphQL issue lookup. Nothing goes to GitHub. Every request is kept in calls.
//
// A workflow file can differ per branch (byBranch: { branch: yaml }, null where the file isn't),
// as on GitHub; starting a run checks the inputs against that branch's file and refuses any it
// doesn't have ("Unexpected inputs provided"), as GitHub does.
//
// Runs move on only when told (setRun), unless the fake was made with autoAdvance: then a run
// started here is queued for a moment, goes through its steps, and finishes with a results
// artifact (made by results(run)), as a real one would.
import JSZip from 'jszip';
import YAML from 'yaml';
import { createGithub, GithubError } from '../lib/github.mjs';

/** A zip of { name: text or bytes }, as GitHub serves an artifact. */
export async function zipOf(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const fail = (status, message, body) => { throw new GithubError(message, { status, body: body || { message } }); };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha = (n) => (String(n).padStart(7, '0') + 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678').slice(0, 40);
const DAY = 86400000;

/** The names of a workflow file's workflow_dispatch inputs (null when it can't be started by hand). */
function dispatchInputs(yaml) {
  let doc;
  try { doc = YAML.parse(String(yaml || '')); } catch { return null; }
  const on = doc && (Object.prototype.hasOwnProperty.call(doc, 'on') ? doc.on : doc.true);
  if (on === 'workflow_dispatch' || (Array.isArray(on) && on.includes('workflow_dispatch'))) return [];
  if (!on || typeof on !== 'object' || !Object.prototype.hasOwnProperty.call(on, 'workflow_dispatch')) return null;
  const inputs = on.workflow_dispatch && on.workflow_dispatch.inputs;
  return inputs && typeof inputs === 'object' ? Object.keys(inputs) : [];
}

/**
 * o: { login ('test-user'), now () => ms, autoAdvance: { queuedMs, stepMs, steps: [names], results(run) -> zip bytes,
 *      artifact ('test-results'), conclusion(run) }, returnsRunDetails (dispatch answers with the run, as newer GitHub may),
 *      issues: { url: { title, state, labels, priority } } }
 */
export function makeFakeGithub(o = {}) {
  const now = o.now || (() => Date.now());
  const login = o.login || 'test-user';
  const repos = new Map(); // 'owner/name' -> repo
  const calls = [];
  const gists = new Map();
  const failures = []; // { match: RegExp, method, status, message, times }
  let nextId = 9000;

  /**
   * Add a repository. r: { private, defaultBranch, branches, environments, workflows: [{ id, name, path, yaml, state,
   * byBranch: { branch: yaml, or null where the file isn't on that branch } }] }
   */
  function addRepo(full, r = {}) {
    const [owner, name] = full.split('/');
    const repo = {
      full, owner, name,
      private: !!r.private,
      defaultBranch: r.defaultBranch || 'main',
      branches: r.branches || [r.defaultBranch || 'main'],
      environments: r.environments || [],
      workflows: (r.workflows || []).map((w) => ({ id: w.id || ++nextId, name: w.name, path: w.path, yaml: w.yaml || '', state: w.state || 'active', byBranch: w.byBranch || {} })),
      runs: [],
      artifacts: new Map(), // id -> { id, name, runId, bytes, expired }
    };
    repos.set(full, repo);
    return repo;
  }

  /** Add a run (one done before, say). r: { workflowId, event, branch, status, conclusion, createdAt (ms), actor, jobs, artifacts: [{ name, bytes, expired }] } */
  function addRun(full, r = {}) {
    const repo = repos.get(full);
    const id = r.id || ++nextId;
    const created = r.createdAt || now();
    const run = {
      id, workflowId: r.workflowId || (repo.workflows[0] && repo.workflows[0].id), event: r.event || 'workflow_dispatch',
      branch: r.branch || repo.defaultBranch, sha: r.sha || sha(id), status: r.status || 'completed', conclusion: r.conclusion === undefined ? (r.status && r.status !== 'completed' ? null : 'success') : r.conclusion,
      createdAt: created, startedAt: r.startedAt || created, updatedAt: created, actor: r.actor || login, number: r.number || repo.runs.length + 1,
      inputs: r.inputs || {}, jobs: r.jobs || [], cancelRequested: false, title: r.title || '',
    };
    repo.runs.push(run);
    for (const a of r.artifacts || []) addArtifact(full, id, a.name, a.bytes, a);
    return run;
  }

  /** a: { id, expired, size, expiresAt (ms; null for none in GitHub's answer; 90 days after the run by default) } */
  function addArtifact(full, runId, name, bytes, a = {}) {
    const repo = repos.get(full);
    const id = a.id || ++nextId;
    repo.artifacts.set(id, { id, name, runId, bytes: bytes || Buffer.alloc(0), expired: !!a.expired, size: a.size, expiresAt: a.expiresAt });
    return id;
  }

  /** Move a run on: { status, conclusion, jobs, startedAt }. */
  function setRun(full, id, patch) {
    const run = repos.get(full).runs.find((x) => x.id === id);
    Object.assign(run, patch, { updatedAt: now() });
    return run;
  }

  /** The next request matching (method, path) fails with this status and message (times: how many). */
  function failNext(method, match, status, message, times = 1) { failures.push({ method, match, status, message, times }); }

  const runJson = (repo, r) => {
    const wf = repo.workflows.find((w) => w.id === r.workflowId) || {};
    return {
      id: r.id, name: wf.name || '', display_title: r.title || wf.name || '', run_number: r.number, event: r.event, status: r.status, conclusion: r.conclusion,
      head_branch: r.branch, head_sha: r.sha, workflow_id: r.workflowId, path: wf.path,
      html_url: `https://github.com/${repo.full}/actions/runs/${r.id}`,
      created_at: iso(r.createdAt), updated_at: iso(r.updatedAt), run_started_at: iso(r.startedAt),
      actor: { login: r.actor }, triggering_actor: { login: r.actor },
    };
  };

  // autoAdvance: where a run started here is, by the time since it was made
  async function advance(repo, r) {
    const a = o.autoAdvance;
    if (!a || !r.auto || r.status === 'completed') return;
    const steps = a.steps || ['Set up job', `Check out ${r.branch}`, 'Install dependencies', 'Run the tests', 'Upload test-results'];
    const queuedMs = a.queuedMs == null ? 3000 : a.queuedMs;
    const stepMs = a.stepMs == null ? 3000 : a.stepMs;
    const t = now() - r.createdAt;
    const done = r.cancelRequested ? -1 : Math.floor((t - queuedMs) / stepMs); // steps finished
    const jobName = a.jobName ? a.jobName(r) : `Run tests${Object.keys(r.inputs).length ? ` (${Object.values(r.inputs).filter((v) => v && v !== 'false').join(' · ')})` : ''}`;
    if (r.cancelRequested) {
      r.status = 'completed'; r.conclusion = 'cancelled';
      r.jobs = [{ name: jobName, status: 'completed', conclusion: 'cancelled', steps: steps.map((name) => ({ name, status: 'completed', conclusion: 'skipped' })) }];
      return;
    }
    if (t < queuedMs) { r.status = 'queued'; r.jobs = [{ name: jobName, status: 'queued', conclusion: null, steps: [] }]; return; }
    if (done < steps.length) {
      r.status = 'in_progress';
      r.startedAt = r.createdAt + queuedMs;
      r.jobs = [{ name: jobName, status: 'in_progress', conclusion: null, steps: steps.map((name, i) => ({ name, status: i < done ? 'completed' : i === done ? 'in_progress' : 'queued', conclusion: i < done ? 'success' : null })) }];
      return;
    }
    const conclusion = a.conclusion ? a.conclusion(r) : 'failure';
    r.status = 'completed'; r.conclusion = conclusion;
    r.jobs = [{ name: jobName, status: 'completed', conclusion, steps: steps.map((name, i) => ({ name, status: 'completed', conclusion: i === steps.length - 2 ? conclusion : 'success' })) }];
    if (a.results) addArtifact(repo.full, r.id, a.artifact || 'test-results', await a.results(r));
  }

  async function transport({ method = 'GET', path, query, body, binary }) {
    const m = String(method).toUpperCase();
    const [p0, qs] = String(path).replace(/^\/+/, '').split('?');
    const p = p0.split('/').map(decodeURIComponent).join('/');
    const q = { ...Object.fromEntries(new URLSearchParams(qs || '')), ...Object.fromEntries(Object.entries(query || {}).map(([k, v]) => [k, String(v)])) };
    calls.push({ method: m, path: p, query: q, body: body == null ? null : JSON.parse(JSON.stringify(body)) });
    await new Promise((r) => setImmediate(r));
    const f = failures.find((x) => (!x.method || x.method === m) && x.match.test(p));
    if (f) { if (--f.times <= 0) failures.splice(failures.indexOf(f), 1); fail(f.status, f.message); }

    if (p === 'user' && m === 'GET') return { login, name: login };
    if (p === 'graphql' && m === 'POST') {
      const url = body && body.variables && body.variables.url;
      const it = (o.issues || {})[url];
      if (!it) fail(200, 'Could not resolve to a Resource with the URL.', { data: { resource: null }, errors: [{ message: 'Could not resolve to a Resource with the URL.' }] });
      const resource = { __typename: 'Issue', title: it.title, state: it.state || 'OPEN', labels: { nodes: (it.labels || []).map((name) => ({ name })) } };
      if (String(body.query).includes('projectItems')) resource.projectItems = { nodes: it.priority ? [{ fieldValueByName: { name: it.priority } }] : [] };
      return { data: { resource } };
    }
    if (p === 'gists' && m === 'POST') { const id = `g${++nextId}`; gists.set(id, body); return { id }; }
    let r;
    if ((r = /^gists\/([^/]+)$/.exec(p)) && m === 'PATCH') { if (!gists.has(r[1])) fail(404, 'Not Found'); gists.set(r[1], body); return { id: r[1] }; }

    const rm = /^repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!rm) fail(404, 'Not Found');
    const repo = repos.get(`${rm[1]}/${rm[2]}`);
    if (!repo) fail(404, 'Not Found');
    const rest = rm[3] || '';
    if (!rest && m === 'GET') return { full_name: repo.full, name: repo.name, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch, html_url: `https://github.com/${repo.full}`, archived: false };
    if (rest === '/branches' && m === 'GET') return repo.branches.map((name, i) => ({ name, commit: { sha: sha(i + 1) }, protected: false }));
    if (rest === '/environments' && m === 'GET') return { total_count: repo.environments.length, environments: repo.environments.map((name, i) => ({ id: i + 1, name })) };
    if (rest === '/actions/workflows' && m === 'GET') return { total_count: repo.workflows.length, workflows: repo.workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state, html_url: `https://github.com/${repo.full}/blob/${repo.defaultBranch}/${w.path}` })) };
    const wfOf = (v) => repo.workflows.find((w) => String(w.id) === v || w.path.split('/').pop() === v);
    if ((r = /^\/actions\/workflows\/([^/]+)$/.exec(rest)) && m === 'GET') {
      const w = wfOf(r[1]);
      if (!w) fail(404, 'Not Found');
      return { id: w.id, name: w.name, path: w.path, state: w.state };
    }
    // a workflow file as it is on a branch (the default branch's when no ref is given)
    const fileOn = (w, ref) => (ref && Object.prototype.hasOwnProperty.call(w.byBranch, ref) ? w.byBranch[ref] : w.yaml);
    if ((r = /^\/contents\/(.+)$/.exec(rest)) && m === 'GET') {
      const w = repo.workflows.find((x) => x.path === r[1]);
      if (!w || (q.ref && !repo.branches.includes(q.ref))) fail(404, q.ref && w ? `No commit found for the ref ${q.ref}` : 'Not Found');
      const yaml = fileOn(w, q.ref);
      if (yaml == null) fail(404, 'Not Found');
      return { type: 'file', path: w.path, encoding: 'base64', content: Buffer.from(yaml).toString('base64').replace(/(.{60})/g, '$1\n') };
    }
    if ((r = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest)) && m === 'POST') {
      const w = wfOf(r[1]);
      if (!w) fail(404, 'Not Found');
      if (!body || !repo.branches.includes(body.ref)) fail(422, `No ref found for: ${body && body.ref}`);
      const names = dispatchInputs(fileOn(w, body.ref));
      if (!names) fail(422, 'Workflow does not have \'workflow_dispatch\' trigger');
      const extra = Object.keys(body.inputs || {}).filter((k) => !names.includes(k));
      if (extra.length) fail(422, `Unexpected inputs provided: ${JSON.stringify(extra)}`);
      const run = addRun(repo.full, { workflowId: w.id, event: 'workflow_dispatch', branch: body.ref, status: 'queued', conclusion: null, inputs: body.inputs || {} });
      run.auto = true;
      if (o.returnsRunDetails && body.return_run_details) return { workflow_run_id: run.id, run_url: `https://api.github.com/repos/${repo.full}/actions/runs/${run.id}`, html_url: `https://github.com/${repo.full}/actions/runs/${run.id}` };
      return null; // 204 No Content
    }
    const listRuns = async (wf) => {
      let list = repo.runs.filter((x) => !wf || x.workflowId === wf.id);
      for (const x of list) await advance(repo, x);
      if (q.event) list = list.filter((x) => x.event === q.event);
      if (q.branch) list = list.filter((x) => x.branch === q.branch);
      if (q.status) list = list.filter((x) => (['completed', 'in_progress', 'queued'].includes(q.status) ? x.status === q.status : x.conclusion === q.status));
      if (q.actor) list = list.filter((x) => x.actor === q.actor);
      if (q.created) {
        const c = /^(>=|<=|>|<)?(.+)$/.exec(q.created);
        const at = Date.parse(c[2]);
        list = list.filter((x) => (c[1] === '>=' ? x.createdAt >= at : c[1] === '>' ? x.createdAt > at : c[1] === '<=' ? x.createdAt <= at : c[1] === '<' ? x.createdAt < at : true));
      }
      list = list.slice().sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
      return { total_count: list.length, workflow_runs: list.slice(0, Number(q.per_page) || 30).map((x) => runJson(repo, x)) };
    };
    if ((r = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest)) && m === 'GET') { const w = wfOf(r[1]); if (!w) fail(404, 'Not Found'); return listRuns(w); }
    if (rest === '/actions/runs' && m === 'GET') return listRuns(null);
    const runOf = async (id) => { const x = repo.runs.find((y) => String(y.id) === id); if (!x) fail(404, 'Not Found'); await advance(repo, x); return x; };
    if ((r = /^\/actions\/runs\/(\d+)$/.exec(rest)) && m === 'GET') return runJson(repo, await runOf(r[1]));
    if ((r = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest)) && m === 'GET') {
      const x = await runOf(r[1]);
      return { total_count: x.jobs.length, jobs: x.jobs.map((j, i) => ({ id: x.id * 10 + i, run_id: x.id, name: j.name, status: j.status, conclusion: j.conclusion, steps: (j.steps || []).map((s, k) => ({ number: k + 1, name: s.name, status: s.status, conclusion: s.conclusion })) })) };
    }
    if ((r = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(rest)) && m === 'GET') {
      const x = await runOf(r[1]);
      const list = [...repo.artifacts.values()].filter((a) => a.runId === x.id);
      return { total_count: list.length, artifacts: list.map((a) => ({ id: a.id, name: a.name, size_in_bytes: a.size != null ? a.size : a.bytes.length, expired: a.expired, archive_download_url: `https://api.github.com/repos/${repo.full}/actions/artifacts/${a.id}/zip`, created_at: iso(x.updatedAt),
        expires_at: a.expiresAt === null ? null : iso(a.expiresAt || x.updatedAt + 90 * DAY) })) };
    }
    if ((r = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(rest)) && m === 'GET') {
      const a = repo.artifacts.get(Number(r[1]));
      if (!a) fail(404, 'Not Found');
      if (a.expired) fail(410, 'Artifact has expired');
      if (!binary) fail(400, 'Ask for the zip as bytes');
      return Buffer.from(a.bytes);
    }
    if ((r = /^\/actions\/runs\/(\d+)\/cancel$/.exec(rest)) && m === 'POST') {
      const x = await runOf(r[1]);
      if (x.status === 'completed') fail(409, 'Cannot cancel a workflow run that is completed.');
      x.cancelRequested = true;
      if (!x.auto || !o.autoAdvance) { x.status = 'completed'; x.conclusion = 'cancelled'; }
      return {}; // 202 Accepted
    }
    fail(404, `Not faked: ${m} ${rest}`);
    return null;
  }
  transport.kind = 'fake';

  return {
    transport,
    github: createGithub({ transport }),
    calls,
    repos,
    gists,
    login,
    addRepo, addRun, addArtifact, setRun, failNext,
    /** The runs of a repository, newest last. */
    runs: (full) => repos.get(full).runs,
    /** The calls made so far to paths matching re (and this method). */
    callsTo: (re, method) => calls.filter((c) => re.test(c.path) && (!method || c.method === method)),
  };
}

/** A workflow file with Run workflow inputs, like a real suite's. */
export const SAMPLE_WORKFLOW = `name: Integration tests
on:
  push:
    branches: [master]
  workflow_dispatch:
    inputs:
      environment:
        description: Deployment to test
        type: choice
        options: [naipepea, net_two, bomet]
        default: net_two
      scope:
        description: Which tests
        type: choice
        required: true
        options: [profile-only, smoke, api, full]
        default: smoke
      grep:
        description: Only tests whose title or tags match
        type: string
      headed:
        description: Show the browser
        type: boolean
        default: false
jobs:
  test:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: results/junit.xml
`;

/**
 * The simpler form a branch can have (CMS-Automation's "Integration tests" today): the environment is
 * a GitHub environment (its secrets CONFIG_ENV and SECRETS_ENV), a scope, an optional grep; the results
 * go up as test-results, kept 90 days.
 */
export const SIMPLE_WORKFLOW = `name: Integration tests
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Deployment to test, a GitHub environment holding CONFIG_ENV and SECRETS_ENV
        type: environment
        required: true
      scope:
        description: Which tests
        type: choice
        options: [full, profile-only, smoke, api]
        default: full
      grep:
        description: Only tests whose title or tags match
        type: string
        required: false
jobs:
  test:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test --reporter=junit
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: results.xml
          retention-days: 90
`;

/** A JUnit file for a demo run: a few passes and one failure. */
export function sampleJunit(at = new Date().toISOString()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="playwright" tests="5" failures="1" skipped="1" time="42.1" timestamp="${at}">
  <testsuite name="pgr/create.spec.ts" tests="2" failures="0" time="20.3" timestamp="${at}">
    <testcase name="Citizen files a complaint with a photo @CMS/01" classname="pgr/create.spec.ts" time="12.3"/>
    <testcase name="Employee inbox lists the new complaint" classname="inbox/list.spec.ts" time="5.2"/>
  </testsuite>
  <testsuite name="pgr/assign.spec.ts" tests="3" failures="1" skipped="1" time="21.8" timestamp="${at}">
    <testcase name="GRO assigns the complaint to an LME @CMS/02" classname="pgr/assign.spec.ts" time="30.0">
      <failure message="Timeout 30000ms exceeded waiting for getByRole('button', { name: 'Assign' })">at AssignPage.assign (tests/pages/assign.page.ts:41:22)</failure>
    </testcase>
    <testcase name="Search by mobile number" classname="api/search.spec.ts" time="1.2"/>
    <testcase name="Citizen reopens within 5 days @CMS/04" classname="citizen/reopen.spec.ts" time="0"><skipped message="needs a complaint resolved 5 days ago"/></testcase>
  </testsuite>
</testsuites>
`;
}

/** The fake the demo server uses (--fake-github): one suite repository whose runs take about 20 seconds. */
export function demoGithub() {
  const fake = makeFakeGithub({
    login: 'demo-user',
    autoAdvance: { queuedMs: 4000, stepMs: 3500, results: () => zipOf({ 'results/junit.xml': sampleJunit() }) },
  });
  fake.addRepo('demo-org/cms-automation', {
    // simple-run-form: the newer, simpler run form (an environment field listing the GitHub environments,
    // less github-pages, which GitHub made by itself when Pages was switched on)
    defaultBranch: 'master', branches: ['master', 'product-suite', 'simple-run-form'], environments: ['naipepea', 'net_two', 'bomet', 'github-pages'],
    workflows: [
      { id: 101, name: 'Integration tests', path: '.github/workflows/integration.yml', yaml: SAMPLE_WORKFLOW, byBranch: { 'simple-run-form': SIMPLE_WORKFLOW } },
      { id: 102, name: 'Lint', path: '.github/workflows/lint.yml', yaml: 'name: Lint\non: [push]\njobs: {}\n' },
    ],
  });
  // like CMS-Automation's runs: the whole output (results-<environment>, results file included) and a
  // results-only artifact (test-results) hold the same results file; Link a suite offers it once
  const junit = sampleJunit(new Date(Date.now() - 86400000).toISOString());
  Promise.all([zipOf({ 'results/junit.xml': junit }), zipOf({ 'index.html': '<!doctype html><title>Report</title>' }), zipOf({ 'results.xml': junit, 'report.json': '{}', 'playwright-report/index.html': '<!doctype html><title>Report</title>' })]).then(([bytes, report, whole]) => {
    fake.addRun('demo-org/cms-automation', { workflowId: 101, event: 'schedule', branch: 'master', conclusion: 'failure', createdAt: Date.now() - 86400000, actor: 'schedule-bot', artifacts: [{ name: 'results-naipepea', bytes: whole }, { name: 'test-results', bytes }, { name: 'playwright-report', bytes: report }] });
  });
  return fake;
}
