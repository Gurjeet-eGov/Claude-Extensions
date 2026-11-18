import test from 'node:test';
import assert from 'node:assert/strict';
import { testRunBase, testRunStatus, noteBugInTestRun, buildBugNote, whereLabel } from '../extension/lib/testrun.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('Test Run address: local only, port from settings', () => {
  assert.equal(testRunBase({}), 'http://127.0.0.1:5178');
  assert.equal(testRunBase({ testRun: { port: 6100 } }), 'http://127.0.0.1:6100');
  assert.equal(testRunBase({ testRun: { port: 'x' } }), 'http://127.0.0.1:5178');
});

test('status: shown only when Test Run answers as itself', async () => {
  const seen = [];
  const ok = async (url, opts) => { seen.push([url, opts.headers['X-Test-Run']]); return json(200, { ok: true, app: 'test-run', book: 'CMS.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.20.1' }); };
  const s = await testRunStatus({}, { fetchImpl: ok });
  assert.equal(s.tab, 'CMS 2.20.1');
  assert.deepEqual(seen, [['http://127.0.0.1:5178/api/status', '1']]);
  assert.equal(await testRunStatus({ testRun: { enabled: false } }, { fetchImpl: ok }), null, 'switched off in settings');
  assert.equal(await testRunStatus({}, { fetchImpl: async () => json(200, { ok: true, app: 'something-else' }) }), null);
  assert.equal(await testRunStatus({}, { fetchImpl: async () => json(403, { ok: false }) }), null);
  assert.equal(await testRunStatus({}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), null, 'not running');
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  assert.equal(await testRunStatus({}, { fetchImpl: hang, timeoutMs: 50 }), null, 'gives up quickly');
  assert.ok(Date.now() - t0 < 1000);
});

test('the note carries the filed issue and the drafted text, clipped', () => {
  const note = buildBugNote({
    title: '  [P1] Bomet: Citizen: Reopen missing  ',
    filed: { number: 77, url: 'https://github.com/org/repo/issues/77' },
    repo: 'org/repo',
    draft: { description: 'd'.repeat(3000), actual: 'No button', expected: 'Reopen offered' },
    extra: 'tenant ke',
    module: 'Citizen',
    pageUrl: 'https://env/citizen',
  });
  assert.equal(note.title, '[P1] Bomet: Citizen: Reopen missing');
  assert.equal(note.number, 77);
  assert.equal(note.url, 'https://github.com/org/repo/issues/77');
  assert.equal(note.description.length, 2000);
  assert.deepEqual([note.actual, note.expected, note.extra, note.module], ['No button', 'Reopen offered', 'tenant ke', 'Citizen']);
  assert.equal(buildBugNote({ title: 'x' }).actual, '', 'skipped Claude: empty fields, no crash');
});

test('noting: success and readable failures', async () => {
  let sent;
  const r = await noteBugInTestRun({}, { title: 't' }, { fetchImpl: async (url, opts) => { sent = [url, opts.method, opts.headers['X-Test-Run'], JSON.parse(opts.body)]; return json(200, { ok: true, key: 'F-004', book: 'CMS.xlsx', tab: 'T' }); } });
  assert.deepEqual(r, { key: 'F-004', book: 'CMS.xlsx', tab: 'T' });
  assert.deepEqual(sent, ['http://127.0.0.1:5178/api/note-bug', 'POST', '1', { title: 't' }]);
  await assert.rejects(noteBugInTestRun({}, {}, { fetchImpl: async () => json(200, { ok: false, error: 'The bug needs a title.' }) }), /needs a title/);
  await assert.rejects(noteBugInTestRun({}, {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /not running any more/);
});

test('where the note goes, in words', () => {
  assert.equal(whereLabel({ book: 'CMS Sign Off.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.20.1' }), 'CMS Sign Off · CMS 2.20.1 · cycle v2.20.1');
  assert.equal(whereLabel({ book: 'A.xlsx', tab: 'T', cycle: null }), 'A · T');
  assert.equal(whereLabel(null), '');
});
