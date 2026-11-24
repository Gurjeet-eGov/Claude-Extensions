// The one GitHub client (lib/github.mjs): how each transport builds its requests (gh api arguments,
// fetch URLs and headers, the artifact redirect followed without the token), the helpers' REST
// paths, GraphQL answers with errors; then the pieces of lib/automation/github-runs.mjs that need
// no server: reading a workflow's Run workflow inputs, checking input values, finding the run a
// dispatch made, and the results files inside an artifact. Nothing here reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGithub, ghTransport, ghArgs, fetchTransport, pathWithQuery, splitRepo, GithubError } from '../lib/github.mjs';
import { parseWorkflowInputs, inputValues, findRunAfterDispatch, resultFilesIn } from '../lib/automation/github-runs.mjs';
import { makeFakeGithub, SAMPLE_WORKFLOW, zipOf, sampleJunit } from '../dev/fake-github.mjs';
import { publishAddress } from '../lib/share.mjs';
import { githubIssue } from '../lib/issues.mjs';

/** A gh that is never run: exec records the arguments and stdin, and answers as told. */
function fakeExec(answer = () => ({ stdout: '{}' })) {
  const seen = [];
  const exec = (cmd, args, opts, cb) => {
    const call = { cmd, args, opts, stdin: '' };
    seen.push(call);
    const child = { stdin: { end: (s) => { call.stdin = s; } } };
    setImmediate(() => {
      const a = answer(call);
      if (a.error) cb(Object.assign(new Error('exit 1'), { killed: !!a.killed }), Buffer.from(a.stdout || ''), Buffer.from(a.stderr || ''));
      else cb(null, Buffer.isBuffer(a.stdout) ? a.stdout : Buffer.from(a.stdout || ''), Buffer.from(''));
    });
    return child;
  };
  return { exec, seen };
}
const ghBin = () => { const d = mkdtempSync(join(tmpdir(), 'testrun-ghbin-')); const f = join(d, 'gh'); writeFileSync(f, '#!/bin/sh\nexit 0\n'); chmodSync(f, 0o755); return f; };

test('gh transport: api [-X METHOD] path?query [-H Accept] [--input -], the body on stdin, bytes for binary', async () => {
  assert.deepEqual(ghArgs({ path: '/repos/o/r/actions/runs', query: { per_page: 5, branch: 'feat/x', empty: '' } }), ['api', 'repos/o/r/actions/runs?per_page=5&branch=feat%2Fx']);
  assert.deepEqual(ghArgs({ method: 'post', path: 'gists', body: {} }), ['api', '-X', 'POST', 'gists', '--input', '-']);
  assert.deepEqual(ghArgs({ path: 'repos/o/r/contents/a', accept: 'application/vnd.github.raw' }), ['api', 'repos/o/r/contents/a', '-H', 'Accept: application/vnd.github.raw']);
  const { exec, seen } = fakeExec((c) => (c.args.includes('zip') || c.args[1].endsWith('/zip') ? { stdout: Buffer.from([0x50, 0x4b, 3, 4]) } : { stdout: c.args.includes('-X') ? '' : '{"login":"me"}' }));
  const gh = createGithub({ transport: ghTransport({ ghPath: ghBin(), exec }) });
  assert.equal(gh.kind, 'gh');
  assert.deepEqual(await gh.getUser(), { login: 'me' });
  assert.deepEqual(await gh.dispatchWorkflow('o', 'r', 7, 'master', { scope: 'smoke' }), {}, 'a 204 names no run');
  assert.deepEqual(seen[1].args, ['api', '-X', 'POST', 'repos/o/r/actions/workflows/7/dispatches', '--input', '-']);
  assert.deepEqual(JSON.parse(seen[1].stdin), { ref: 'master', inputs: { scope: 'smoke' } });
  const zip = await gh.downloadArtifact('o', 'r', 42);
  assert.ok(Buffer.isBuffer(zip) && zip[0] === 0x50, 'raw bytes');
  assert.equal(seen[2].args[1], 'repos/o/r/actions/artifacts/42/zip');
  assert.equal(seen[2].opts.timeout, 180000, 'downloads get longer');
  await gh.cancelRun('o', 'r', 9);
  assert.deepEqual(seen[3].args, ['api', '-X', 'POST', 'repos/o/r/actions/runs/9/cancel']);
  await gh.listRuns('o', 'r', { workflowId: 7, event: 'workflow_dispatch', created: '>=2026-11-24T10:00:00Z' });
  assert.equal(seen[4].args[1], 'repos/o/r/actions/workflows/7/runs?per_page=20&event=workflow_dispatch&created=%3E%3D2026-11-24T10%3A00%3A00Z');
  await gh.getFile('o', 'r', '.github/workflows/a b.yml', 'main');
  assert.equal(seen[5].args[1], 'repos/o/r/contents/.github/workflows/a%20b.yml?ref=main');
  await gh.updateRef('o', 'r', 'test-run-data', 'abc', { force: true });
  assert.deepEqual([seen[6].args.slice(0, 4), JSON.parse(seen[6].stdin)], [['api', '-X', 'PATCH', 'repos/o/r/git/refs/heads/test-run-data'], { sha: 'abc', force: true }]);
});

test('gh transport: errors carry the HTTP status, the body GitHub sent, and a code; gh missing is NO_GH', async () => {
  const { exec } = fakeExec((c) => (c.args.includes('graphql')
    ? { error: true, stdout: '{"data":{"resource":null},"errors":[{"message":"Could not resolve"}]}', stderr: 'gh: Could not resolve' }
    : c.args[1] === 'user' ? { error: true, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
      : { error: true, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' }));
  const gh = createGithub({ transport: ghTransport({ ghPath: ghBin(), exec }) });
  await assert.rejects(gh.getRepo('o', 'r'), (e) => e instanceof GithubError && e.status === 404 && e.code === 'GH_NOT_FOUND' && e.message === 'Not Found (HTTP 404)' && e.body.message === 'Not Found');
  await assert.rejects(gh.getUser(), (e) => e.code === 'GH_AUTH');
  assert.equal(await gh.getFile('o', 'r', 'x.yml'), null, 'a missing file is null');
  const g = await gh.graphql('query { x }', { url: 'u' });
  assert.equal(g.errors[0].message, 'Could not resolve', 'GraphQL errors come back as the answer');
  const none = createGithub({ ghPath: '/nope/gh' });
  await assert.rejects(none.getUser(), (e) => e.code === 'NO_GH');
});

test('fetch transport: the URL, token and API version headers, JSON bodies; an artifact redirect is followed without the token', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(body) });
    if (url.endsWith('/zip')) return reply(302, '', { location: 'https://storage.example/blob?sig=1' });
    if (url.startsWith('https://storage.example')) return reply(200, 'PK\u0003\u0004zip');
    if (url.includes('/dispatches')) return reply(204, '');
    if (url.includes('/nope')) return reply(404, { message: 'Not Found' });
    return reply(200, { login: 'bot' });
  };
  const gh = createGithub({ transport: fetchTransport({ token: 't0ken', fetchImpl }) });
  assert.equal(gh.kind, 'fetch');
  assert.deepEqual(await gh.getUser(), { login: 'bot' });
  assert.equal(seen[0].url, 'https://api.github.com/user');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer t0ken');
  assert.equal(seen[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(seen[0].init.headers.Accept, 'application/vnd.github+json');
  await gh.dispatchWorkflow('o', 'r', 'ci.yml', 'main', null);
  assert.deepEqual([seen[1].init.method, seen[1].url, JSON.parse(seen[1].init.body), seen[1].init.headers['Content-Type']], ['POST', 'https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches', { ref: 'main' }, 'application/json']);
  const zip = await gh.downloadArtifact('o', 'r', 5);
  assert.equal(zip.toString('latin1', 0, 2), 'PK');
  assert.equal(seen[2].init.redirect, 'manual');
  assert.equal(seen[3].url, 'https://storage.example/blob?sig=1');
  assert.equal(seen[3].init.headers.Authorization, undefined, 'the token never goes to the storage host');
  await assert.rejects(gh.request('GET', '/repos/o/nope'), (e) => e.status === 404 && e.message === 'Not Found');
  await assert.rejects(createGithub({ transport: fetchTransport({ fetchImpl }) }).getUser(), (e) => e.code === 'GH_AUTH', 'no token');
  assert.equal(createGithub({ token: 'x', fetchImpl }).kind, 'fetch', 'a token picks the fetch transport');
});

test('dispatch: the new run named by GitHub\'s answer when it gives one (return_run_details), else found later', async () => {
  const fake = makeFakeGithub({ returnsRunDetails: true });
  fake.addRepo('o/r', { workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', yaml: 'on: workflow_dispatch' }] });
  const named = await fake.github.dispatchWorkflow('o', 'r', 1, 'main', null, { returnRunDetails: true });
  const id = fake.runs('o/r')[0].id;
  assert.deepEqual(named, { runId: id, runUrl: `https://github.com/o/r/actions/runs/${id}` });
  assert.equal(fake.calls.at(-1).body.return_run_details, true);
  assert.deepEqual(await fake.github.dispatchWorkflow('o', 'r', 1, 'main'), {}, 'not asked for: a 204, nothing named');
  assert.equal(fake.calls.at(-1).body.return_run_details, undefined, 'the key is only sent when asked for');
});

test('helpers: query strings, repository names', () => {
  assert.equal(pathWithQuery('/a/b?x=1', { y: 'z w' }), 'a/b?x=1&y=z%20w');
  assert.deepEqual(splitRepo('https://github.com/QA-Team/notification-tests.git'), { owner: 'QA-Team', repo: 'notification-tests' });
  assert.deepEqual(splitRepo('o/r'), { owner: 'o', repo: 'r' });
  assert.equal(splitRepo('not a repo'), null);
});

test('share and issues go through the client: POST /gists, PATCH /gists/{id}, POST /graphql', async () => {
  const url = 'https://github.com/org/repo/issues/9';
  const fake = makeFakeGithub({ issues: { [url]: { title: 'Assign fails', state: 'CLOSED', labels: ['P2'] } } });
  const id = await publishAddress({ url: 'https://a.trycloudflare.com', github: fake.github, now: 'now' });
  assert.equal(await publishAddress({ gist: id, url: 'https://b.trycloudflare.com', github: fake.github }), id);
  assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.path}`), ['POST gists', `PATCH gists/${id}`]);
  assert.match(fake.gists.get(id).files['test-run.json'].content, /b\.trycloudflare/);
  const it = await githubIssue(url, { github: fake.github });
  assert.deepEqual(it, { title: 'Assign fails', state: 'closed', labels: ['P2'], priority: 'P2' });
  assert.equal(fake.calls[2].path, 'graphql');
  assert.deepEqual(fake.calls[2].body.variables, { url });
  await assert.rejects(githubIssue('https://github.com/org/repo/issues/404', { github: fake.github }), (e) => e.code === 'GH_FAILED' && /Could not resolve/.test(e.message));
});

test('a workflow\'s Run workflow inputs, read from its YAML', () => {
  const w = parseWorkflowInputs(SAMPLE_WORKFLOW);
  assert.equal(w.dispatch, true);
  assert.equal(w.name, 'Integration tests');
  assert.deepEqual(w.inputs.map((x) => [x.name, x.type, x.required, x.default]), [['environment', 'choice', false, 'net_two'], ['scope', 'choice', true, 'smoke'], ['grep', 'string', false, ''], ['headed', 'boolean', false, 'false']]);
  assert.deepEqual(w.inputs[1].options, ['profile-only', 'smoke', 'api', 'full']);
  assert.equal(w.inputs[0].description, 'Deployment to test');
  assert.deepEqual(parseWorkflowInputs('on: workflow_dispatch\njobs: {}'), { name: '', dispatch: true, inputs: [] });
  assert.equal(parseWorkflowInputs('on: [push, workflow_dispatch]').dispatch, true);
  assert.equal(parseWorkflowInputs('on:\n  push:\n  workflow_dispatch:\n').dispatch, true, 'workflow_dispatch with nothing under it');
  assert.equal(parseWorkflowInputs('on: [push]').dispatch, false);
  const env = parseWorkflowInputs('on:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: environment\n        required: true\n      count:\n        type: number\n        default: 3\n      odd:\n        type: weird\n');
  assert.deepEqual(env.inputs.map((x) => [x.name, x.type, x.default]), [['target', 'environment', ''], ['count', 'number', '3'], ['odd', 'string', '']]);
  assert.throws(() => parseWorkflowInputs('on: [unclosed'), (e) => e.code === 'BAD_WORKFLOW');
});

test('input values are checked against the form: choices, booleans, required, defaults', () => {
  const defs = parseWorkflowInputs(SAMPLE_WORKFLOW).inputs;
  assert.deepEqual(inputValues(defs, { scope: 'api', headed: true, grep: ' @pgr ', extra: 'dropped' }), { environment: 'net_two', scope: 'api', grep: '@pgr', headed: 'true' });
  assert.deepEqual(inputValues(defs, {}), { environment: 'net_two', scope: 'smoke', headed: 'false' }, 'defaults fill the gaps');
  assert.throws(() => inputValues(defs, { scope: 'everything' }), (e) => e.code === 'BAD_INPUT' && /choices for scope/.test(e.message));
  const req = parseWorkflowInputs('on:\n  workflow_dispatch:\n    inputs:\n      who:\n        required: true\n      n:\n        type: number\n').inputs;
  assert.throws(() => inputValues(req, {}), (e) => /Fill in who/.test(e.message));
  assert.throws(() => inputValues(req, { who: 'x', n: 'many' }), (e) => /takes a number/.test(e.message));
});

test('the run a dispatch made: on its branch, since just before, not seen before, by the same account', () => {
  const at = Date.parse('2026-11-24T10:00:00Z');
  const run = (id, o = {}) => ({ id, event: 'workflow_dispatch', head_branch: 'master', created_at: new Date(at + (o.after || 0) * 1000).toISOString(), actor: { login: o.actor || 'me' }, ...o.extra });
  const runs = [run(1, { after: -600 }), run(2, { after: 5 }), run(3, { after: 7, actor: 'someone' }), run(4, { after: 6, extra: { head_branch: 'dev' } }), run(5, { after: 3, extra: { event: 'push' } })];
  assert.equal(findRunAfterDispatch(runs, { since: at, branch: 'master', actor: 'me' }).id, 2);
  assert.equal(findRunAfterDispatch(runs, { since: at, branch: 'master' }).id, 3, 'without an account: the newest that fits');
  assert.equal(findRunAfterDispatch(runs, { since: at, branch: 'master', actor: 'me', known: [2] }), null, 'one there before is not it');
  assert.equal(findRunAfterDispatch(runs, { since: at, branch: 'master', claimed: [3, 2] }), null, 'one another job follows is not it');
  assert.equal(findRunAfterDispatch([run(6, { after: -30 })], { since: at, branch: 'master' }).id, 6, 'a laptop clock a little ahead of GitHub\'s');
  assert.equal(findRunAfterDispatch([], { since: at }), null);
});

test('the results files inside an artifact: .xml and .json only, readable zips only', async () => {
  const zip = await zipOf({ 'results/junit.xml': sampleJunit(), 'report/index.html': '<html>', 'report/data/a.png': Buffer.alloc(10), 'ctrf.json': '{"results":{"tests":[]}}' });
  const files = await resultFilesIn(zip, 'artifact “x”');
  assert.deepEqual(files.map((f) => f.name).sort(), ['artifact “x” › ctrf.json', 'artifact “x” › results/junit.xml']);
  await assert.rejects(resultFilesIn(Buffer.from('nope')), (e) => e.code === 'BAD_FORMAT');
});
