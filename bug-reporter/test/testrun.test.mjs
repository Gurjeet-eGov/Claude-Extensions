import test from 'node:test';
import assert from 'node:assert/strict';
import { testRunBase, testRunStatus, noteBugInTestRun, buildBugNote, whereLabel, parseInvite, canNote, listSuites, pickSuite, listCases, caseLabel, matchCase, consoleLink, addressFromGist, isLocalBase } from '../extension/lib/testrun.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const SHARED = { testRun: { url: 'https://quick-fox.trycloudflare.com', key: 'k'.repeat(32), gist: 'abc123' } };

test('Test Run address: this computer by default, a typed address, or an old port setting', () => {
  assert.equal(testRunBase({}), 'http://127.0.0.1:5178');
  assert.equal(testRunBase({ testRun: { port: 6100 } }), 'http://127.0.0.1:6100', 'settings saved before addresses existed');
  assert.equal(testRunBase({ testRun: { port: 'x' } }), 'http://127.0.0.1:5178');
  assert.equal(testRunBase({ testRun: { url: 'https://tr.example.org/', port: 6100 } }), 'https://tr.example.org');
  assert.equal(testRunBase({ testRun: { url: 'javascript:alert(1)' } }), 'http://127.0.0.1:5178', 'junk is ignored');
  assert.equal(isLocalBase('http://127.0.0.1:5178'), true);
  assert.equal(isLocalBase('https://quick-fox.trycloudflare.com'), false);
});

test('invite links: hosted page with a gist or an address, or straight to the server', () => {
  assert.deepEqual(parseInvite('https://o.github.io/r/test-run/#join=AbC_123-xyz&gist=0a1b2c'), { key: 'AbC_123-xyz', server: '', gist: '0a1b2c' });
  assert.deepEqual(parseInvite(`https://o.github.io/r/test-run/#join=K1234&server=${encodeURIComponent('https://fox.trycloudflare.com')}`), { key: 'K1234', server: 'https://fox.trycloudflare.com', gist: '' });
  assert.deepEqual(parseInvite('https://fox.trycloudflare.com/#join=K1234'), { key: 'K1234', server: 'https://fox.trycloudflare.com', gist: '' });
  assert.equal(parseInvite('not a link').key, '');
});

test('status: shown only when Test Run answers as itself', async () => {
  const seen = [];
  const ok = async (url, opts) => { seen.push([url, opts.headers['X-Test-Run'], opts.headers.Authorization]); return json(200, { ok: true, app: 'test-run', book: 'CMS.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.20.1', me: { role: 'owner', local: true } }); };
  const s = await testRunStatus({}, { fetchImpl: ok });
  assert.equal(s.tab, 'CMS 2.20.1');
  assert.equal(s.base, 'http://127.0.0.1:5178');
  assert.deepEqual(seen, [['http://127.0.0.1:5178/api/status', '1', undefined]], 'no key for this computer');
  assert.equal(canNote(s), true);
  assert.equal(await testRunStatus({ testRun: { enabled: false } }, { fetchImpl: ok }), null, 'switched off in settings');
  assert.equal(await testRunStatus({}, { fetchImpl: async () => json(200, { ok: true, app: 'something-else' }) }), null);
  assert.equal(await testRunStatus({}, { fetchImpl: async () => json(403, { ok: false }) }), null);
  assert.equal(await testRunStatus({}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), null, 'not running');
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  assert.equal(await testRunStatus({}, { fetchImpl: hang, timeoutMs: 50 }), null, 'gives up quickly');
  assert.ok(Date.now() - t0 < 1000);
});

test('a shared Test Run: the invite key is sent, view-only and missing keys are told apart', async () => {
  let auth;
  const st = await testRunStatus(SHARED, { fetchImpl: async (url, opts) => { auth = opts.headers.Authorization; return json(200, { ok: true, app: 'test-run', me: { name: 'Priya', role: 'tester', local: false }, consoleUrl: 'https://o.github.io/r/test-run/' }); } });
  assert.equal(auth, `Bearer ${'k'.repeat(32)}`);
  assert.equal(canNote(st), true);
  assert.equal(consoleLink(st, st.base), 'https://o.github.io/r/test-run/?view=findings');
  const viewer = await testRunStatus(SHARED, { fetchImpl: async () => json(200, { ok: true, app: 'test-run', me: { role: 'viewer' } }) });
  assert.equal(canNote(viewer), false, 'a view-only invite cannot add bugs');
  const locked = await testRunStatus(SHARED, { fetchImpl: async () => json(200, { ok: true, app: 'test-run', auth: 'required' }) });
  assert.deepEqual([locked.needsKey, canNote(locked)], [true, false]);
  assert.equal(consoleLink({}, 'http://127.0.0.1:5178'), 'http://127.0.0.1:5178/?view=findings');
});

test('a shared Test Run that moved is found through its gist', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://quick-fox')) throw new TypeError('Failed to fetch'); // the old tunnel address is gone
    if (url === 'https://api.github.com/gists/abc123') return json(200, { files: { 'test-run.json': { content: JSON.stringify({ app: 'test-run', url: 'https://slow-owl.trycloudflare.com' }) } } });
    if (url === 'https://slow-owl.trycloudflare.com/api/status') return json(200, { ok: true, app: 'test-run', me: { role: 'tester' } });
    return json(404, {});
  };
  const st = await testRunStatus(SHARED, { fetchImpl });
  assert.equal(st.base, 'https://slow-owl.trycloudflare.com', 'the caller saves this address for next time');
  assert.deepEqual(calls, ['https://quick-fox.trycloudflare.com/api/status', 'https://api.github.com/gists/abc123', 'https://slow-owl.trycloudflare.com/api/status']);
  assert.equal(await addressFromGist('abc123', { fetchImpl: async () => json(200, { files: { 'test-run.json': { content: '{"app":"other","url":"https://x"}' } } }) }), '', 'only a Test Run gist counts');
  assert.equal(await addressFromGist('', { fetchImpl }), '');
});

test('suites: every workbook › tab, preselecting the last one picked, else the one open in Test Run', async () => {
  const fetchImpl = async () => json(200, { ok: true, suites: [{ book: 'CMS.xlsx', tabs: ['CMS 2.20.1', 'Features'] }, { book: 'Bomet.xlsx', tabs: ['Sign-off'] }], current: { book: 'CMS.xlsx', tab: 'Features' } });
  const { suites, current } = await listSuites({}, 'http://127.0.0.1:5178', { fetchImpl });
  assert.deepEqual(suites.map((s) => s.label), ['CMS › CMS 2.20.1', 'CMS › Features', 'Bomet › Sign-off']);
  assert.equal(pickSuite(suites, { book: 'Bomet.xlsx', tab: 'Sign-off' }, current).label, 'Bomet › Sign-off');
  assert.equal(pickSuite(suites, { book: 'Gone.xlsx', tab: 'x' }, current).label, 'CMS › Features', 'a remembered suite that is gone');
  assert.equal(pickSuite([], null, current), null);
  assert.deepEqual(await listSuites({}, 'http://127.0.0.1:5178', { fetchImpl: async () => { throw new TypeError('down'); } }), { suites: [], current: null });
});

test('test cases of a suite: listed for the picker, matched by label or ID', async () => {
  let asked;
  const fetchImpl = async (url, opts) => { asked = [url, opts.headers.Authorization]; return json(200, { ok: true, cycle: 'v2.20.1', cases: [{ key: 'CMS/12', id: 'CMS/12', scenario: 'Citizen  can\nfile a complaint', status: '' }, { key: 'CMS/05', id: 'CMS/05', scenario: 'Block level shown', status: 'Fail' }] }); };
  const { cases, cycle } = await listCases(SHARED, 'https://quick-fox.trycloudflare.com', { book: 'CMS Sign Off.xlsx', tab: 'CMS 2.20.1' }, { fetchImpl });
  assert.deepEqual(asked, ['https://quick-fox.trycloudflare.com/api/suite-cases?book=CMS%20Sign%20Off.xlsx&tab=CMS%202.20.1', `Bearer ${'k'.repeat(32)}`]);
  assert.equal(cycle, 'v2.20.1');
  assert.equal(caseLabel(cases[0]), 'CMS/12 · Citizen can file a complaint', 'one line, for the list');
  assert.equal(matchCase(cases, 'CMS/12 · Citizen can file a complaint').key, 'CMS/12', 'picked from the list');
  assert.equal(matchCase(cases, ' cms/05 ').key, 'CMS/05', 'or just the ID typed');
  assert.equal(matchCase(cases, 'CMS/99'), null);
  assert.equal(matchCase(cases, ''), null);
  assert.deepEqual(await listCases({}, 'http://127.0.0.1:5178', null), { cases: [], cycle: '' });
  assert.deepEqual((await listCases({}, 'http://127.0.0.1:5178', { book: 'x', tab: 'y' }, { fetchImpl: async () => { throw new TypeError('down'); } })).cases, []);
  assert.match(consoleLink({ consoleUrl: 'http://127.0.0.1:5178/' }, '', 'issues'), /\?view=issues$/);
});

test('the note carries the filed issue, the drafted text and the chosen suite, clipped', () => {
  const note = buildBugNote({
    title: '  [P1] Bomet: Citizen: Reopen missing  ',
    filed: { number: 77, url: 'https://github.com/org/repo/issues/77' },
    repo: 'org/repo',
    draft: { description: 'd'.repeat(3000), actual: 'No button', expected: 'Reopen offered' },
    extra: 'tenant ke',
    module: 'Citizen',
    pageUrl: 'https://env/citizen',
    suite: { book: 'Bomet.xlsx', tab: 'Sign-off', label: 'x' },
  });
  assert.equal(note.title, '[P1] Bomet: Citizen: Reopen missing');
  assert.equal(note.number, 77);
  assert.equal(note.url, 'https://github.com/org/repo/issues/77');
  assert.equal(note.description.length, 2000);
  assert.deepEqual([note.actual, note.expected, note.extra, note.module], ['No button', 'Reopen offered', 'tenant ke', 'Citizen']);
  assert.deepEqual([note.book, note.tab, note.caseKey, note.priority], ['Bomet.xlsx', 'Sign-off', '', '']);
  const onCase = buildBugNote({ title: 'x', suite: { book: 'B.xlsx', tab: 'T' }, testCase: { key: 'CMS/12', id: 'CMS/12' }, priority: 'P1' });
  assert.deepEqual([onCase.caseKey, onCase.priority], ['CMS/12', 'P1'], 'against a test case, with the priority');
  assert.equal(buildBugNote({ title: 'x' }).actual, '', 'skipped Claude: empty fields, no crash');
  assert.equal(buildBugNote({ title: 'x' }).book, '', 'no suite: Test Run picks the open one');
});

test('noting: success and readable failures', async () => {
  let sent;
  const r = await noteBugInTestRun({}, { title: 't' }, { fetchImpl: async (url, opts) => { sent = [url, opts.method, opts.headers['X-Test-Run'], JSON.parse(opts.body)]; return json(200, { ok: true, key: 'F-004', book: 'CMS.xlsx', tab: 'T' }); } });
  assert.deepEqual(r, { kind: 'finding', key: 'F-004', book: 'CMS.xlsx', tab: 'T', status: '', previous: '', cycle: '' });
  const c = await noteBugInTestRun({}, { title: 't', caseKey: 'CMS/12' }, { fetchImpl: async () => json(200, { ok: true, kind: 'case', key: 'CMS/12', book: 'CMS.xlsx', tab: 'T', status: 'Fail', previous: '', cycle: 'v2' }) });
  assert.deepEqual([c.kind, c.key, c.status, c.cycle], ['case', 'CMS/12', 'Fail', 'v2']);
  assert.deepEqual(sent, ['http://127.0.0.1:5178/api/note-bug', 'POST', '1', { title: 't' }]);
  let shared;
  await noteBugInTestRun(SHARED, { title: 't' }, { base: 'https://slow-owl.trycloudflare.com', fetchImpl: async (url, opts) => { shared = [url, opts.headers.Authorization]; return json(200, { ok: true, key: 'F-005' }); } });
  assert.deepEqual(shared, ['https://slow-owl.trycloudflare.com/api/note-bug', `Bearer ${'k'.repeat(32)}`], 'to where it answered, with the key');
  await assert.rejects(noteBugInTestRun({}, {}, { fetchImpl: async () => json(200, { ok: false, error: 'The bug needs a title.' }) }), /needs a title/);
  await assert.rejects(noteBugInTestRun({}, {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /not running any more/);
  await assert.rejects(noteBugInTestRun(SHARED, {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /shared Test Run is not answering/);
  await assert.rejects(noteBugInTestRun(SHARED, {}, { fetchImpl: async () => json(403, { ok: false, error: 'Your invite is view-only' }) }), /view-only/);
});

test('where the note goes, in words', () => {
  assert.equal(whereLabel({ book: 'CMS Sign Off.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.20.1' }), 'CMS Sign Off · CMS 2.20.1 · cycle v2.20.1');
  assert.equal(whereLabel({ book: 'A.xlsx', tab: 'T', cycle: null }), 'A · T');
  assert.equal(whereLabel(null), '');
});
