// Where automated runs are kept (lib/automation/store.mjs): suites.json, index.json and one
// gzip file per run in sheets/.testrun/automation/; keeping the last N runs per suite ›
// workbook › test suite › cycle; delete; attaching to another cycle; who may see and act.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { AutomationStore, normalizeAutomationSettings, cleanRepo } from '../lib/automation/store.mjs';
import { canSeeSuite, canAct } from '../lib/automation/access.mjs';
import { buildRun } from '../lib/automation/results.mjs';

const ATTACH = { book: 'CMS Sign Off.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.12' };
const parsed = (startedAt, failed = 0) => {
  const tests = [{ id: 'aaaaaaaaaaaa', title: 'a', file: 'a.spec.ts', suite: '', tags: [], caseIds: [], status: failed ? 'fail' : 'pass', durationMs: 5, retries: 0, flaky: false, message: failed ? 'boom' : '', stack: '' }];
  return { format: 'junit', tool: '', tests, startedAt, durationMs: 5, branch: '', sha: '', env: '' };
};
let n = 0;
const runAt = (startedAt, attach = ATTACH, suite = { id: 'cms', name: 'CMS' }) => buildRun(parsed(startedAt), { suite, attach, now: new Date(Date.parse('2026-11-24T12:00:00Z') + (n++) * 1000) });
const fresh = () => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-auto-'));
  return { sheets, store: new AutomationStore(sheets), dir: join(sheets, '.testrun', 'automation') };
};

test('suites.json keeps { suites: [{ id, name, ... }] }; names and patterns are checked', () => {
  const { store, dir } = fresh();
  const s = store.saveSuite({ name: 'CMS Automation', repo: 'https://github.com/Gurjeet-eGov/CMS-Automation.git', casePattern: 'CMS/\\d+', masking: 'otp=\\d{6}\n\n/pin:\\d{4}/' }, { by: 'Gurjeet', now: new Date('2026-11-20T10:00:00Z') });
  assert.equal(s.id, 'cms-automation');
  assert.equal(s.repo, 'Gurjeet-eGov/CMS-Automation');
  assert.deepEqual(s.masking, ['otp=\\d{6}', '/pin:\\d{4}/']);
  assert.deepEqual([s.linkedBy, s.linkedAt, s.workflow, s.artifact, s.envInput, s.format], ['Gurjeet', '2026-11-20T10:00:00.000Z', '', '', '', '']);
  const onDisk = JSON.parse(readFileSync(join(dir, 'suites.json'), 'utf8'));
  assert.deepEqual(onDisk.suites.map((x) => [x.id, x.name]), [['cms-automation', 'CMS Automation']], 'another part of Test Run reads suites[].id and name');
  assert.throws(() => store.saveSuite({ name: 'cms automation' }), (e) => e.code === 'BAD_INPUT' && /already linked/.test(e.message));
  assert.throws(() => store.saveSuite({ name: '' }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => store.saveSuite({ name: 'X', casePattern: '(' }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => store.saveSuite({ name: 'X', masking: ['/[/'] }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => store.saveSuite({ name: 'X', repo: 'https://gitlab.com/a/b' }), (e) => e.code === 'BAD_INPUT');
  const changed = store.saveSuite({ id: s.id, name: 'CMS Automation (UI)', repo: '', casePattern: '', masking: [] });
  assert.deepEqual([changed.id, changed.name, changed.repo, changed.linkedBy], ['cms-automation', 'CMS Automation (UI)', '', 'Gurjeet'], 'a change keeps its ID and who linked it');
  assert.equal(store.saveSuite({ name: 'CMS Automation' }).id.startsWith('cms-automation-'), true, 'a second suite with a name like it gets its own ID');
  assert.throws(() => store.saveSuite({ id: 'nope', name: 'Y' }), (e) => e.code === 'GONE');
  assert.equal(cleanRepo('owner/repo'), 'owner/repo');
  assert.equal(cleanRepo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(cleanRepo('https://github.com/owner/repo/actions'), 'owner/repo');
});

test('a run is kept as a gzip file, with its meta (no tests) in index.json; files are written whole', () => {
  const { store, dir } = fresh();
  const run = runAt('2026-11-24T10:00:00Z');
  const { meta, removed } = store.add(run, 2);
  assert.deepEqual(removed, []);
  assert.equal(meta.tests, undefined);
  assert.ok(meta.bytes > 0);
  const gz = readFileSync(join(dir, 'runs', `${run.id}.json.gz`));
  assert.deepEqual(JSON.parse(gunzipSync(gz).toString('utf8')), run);
  assert.deepEqual(store.run(run.id), run);
  const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.version, 1);
  assert.deepEqual(idx.runs.map((m) => m.id), [run.id]);
  assert.equal(idx.runs[0].tests, undefined);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.deepEqual(readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.tmp')), []);
  assert.throws(() => store.add({ ...runAt('2026-11-24T11:00:00Z'), attach: { book: 'x.xlsx' } }), (e) => e.code === 'NO_ATTACH', 'never without its workbook › test suite › cycle');
  assert.equal(store.run('../../app'), null, 'only run IDs');
});

test('retention: a third run for the same suite, workbook, test suite and cycle removes the oldest, and says which', () => {
  const { store, dir } = fresh();
  const r1 = runAt('2026-11-19T09:40:00Z');
  const r2 = runAt('2026-11-22T18:05:00Z');
  const otherCycle = runAt('2026-11-20T08:00:00Z', { ...ATTACH, cycle: 'v2.11' });
  const otherTab = runAt('2026-11-20T09:00:00Z', { ...ATTACH, tab: 'Notifications' });
  const otherBook = runAt('2026-11-20T10:00:00Z', { ...ATTACH, book: 'Bomet UAT.xlsx' });
  const otherSuite = runAt('2026-11-18T10:00:00Z', ATTACH, { id: 'notif', name: 'Notifications API' });
  for (const r of [r1, r2, otherCycle, otherTab, otherBook, otherSuite]) assert.deepEqual(store.add(r, 2).removed, []);
  const r3 = runAt('2026-11-24T10:23:00Z');
  const { removed } = store.add(r3, 2);
  assert.deepEqual(removed.map((m) => m.id), [r1.id], 'only the oldest of that group');
  assert.equal(existsSync(join(dir, 'runs', `${r1.id}.json.gz`)), false, 'and it really goes');
  assert.equal(store.run(r1.id), null);
  assert.deepEqual(store.group(r3).map((m) => m.id), [r3.id, r2.id], 'newest first');
  assert.equal(store.index().length, 6);
  // the host keeps one: the next run pushes out the other
  const r4 = runAt('2026-11-24T11:00:00Z');
  assert.deepEqual(store.add(r4, 1).removed.map((m) => m.id), [r3.id, r2.id]);
  // a run older than everything kept would be removed straight away: refused instead
  assert.throws(() => store.add(runAt('2026-11-01T00:00:00Z'), 1), (e) => e.code === 'TOO_OLD');
  assert.deepEqual(store.group(r4).map((m) => m.id), [r4.id]);
  assert.deepEqual(normalizeAutomationSettings({}), { keep: 2, checkEvery: 5 });
  assert.deepEqual(normalizeAutomationSettings({ keep: 5 }), { keep: 5, checkEvery: 5 });
  assert.deepEqual(normalizeAutomationSettings({ keep: 0 }), { keep: 2, checkEvery: 5 });
  assert.deepEqual(normalizeAutomationSettings({ keep: 'x' }), { keep: 2, checkEvery: 5 });
});

test('delete, and attaching a run to another cycle (which can push out that cycle\'s oldest)', () => {
  const { store, dir } = fresh();
  const a = runAt('2026-11-19T09:40:00Z');
  const b = runAt('2026-11-22T18:05:00Z', { ...ATTACH, cycle: 'v2.11' });
  const c = runAt('2026-11-23T18:05:00Z', { ...ATTACH, cycle: 'v2.11' });
  for (const r of [a, b, c]) store.add(r, 2);
  const moved = store.reattach(a.id, { ...ATTACH, cycle: 'v2.10' }, 2);
  assert.deepEqual(moved.removed, []);
  assert.equal(store.run(a.id).attach.cycle, 'v2.10', 'the run file changes too');
  assert.equal(store.meta(a.id).attach.cycle, 'v2.10');
  const d = runAt('2026-11-24T08:00:00Z');
  store.add(d, 2);
  const into = store.reattach(d.id, { ...ATTACH, cycle: 'v2.11' }, 2);
  assert.deepEqual(into.removed.map((m) => m.id), [b.id]);
  assert.equal(existsSync(join(dir, 'runs', `${b.id}.json.gz`)), false);
  assert.throws(() => store.reattach(d.id, { book: 'x.xlsx', tab: '' }, 2), (e) => e.code === 'NO_ATTACH');
  assert.throws(() => store.reattach('20200101-000000-000000', ATTACH, 2), (e) => e.code === 'GONE');
  const gone = store.remove(c.id);
  assert.equal(gone.id, c.id);
  assert.equal(existsSync(join(dir, 'runs', `${c.id}.json.gz`)), false);
  assert.equal(store.meta(c.id), null);
  assert.equal(store.remove(c.id), null, 'twice: nothing there');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).runs.map((m) => m.id).sort(), [a.id, d.id].sort());
});

test('unlinking a suite deletes its runs; a lost index is read back from the run files', () => {
  const { sheets, store, dir } = fresh();
  const s = store.saveSuite({ name: 'CMS' });
  const t = store.saveSuite({ name: 'Notifications' });
  const mine = runAt('2026-11-22T10:00:00Z', ATTACH, s);
  const theirs = runAt('2026-11-22T11:00:00Z', ATTACH, t);
  store.add(mine, 2);
  store.add(theirs, 2);
  unlinkSync(join(dir, 'index.json'));
  const again = new AutomationStore(sheets);
  assert.deepEqual(again.index().map((m) => m.id).sort(), [mine.id, theirs.id].sort(), 'rebuilt from runs/');
  assert.ok(existsSync(join(dir, 'index.json')));
  writeFileSync(join(dir, 'index.json'), '{ broken');
  assert.equal(new AutomationStore(sheets).index().length, 2, 'a damaged index too');
  const r = again.removeSuite(s.id);
  assert.equal(r.suite.id, s.id);
  assert.deepEqual(r.runs.map((m) => m.id), [mine.id]);
  assert.equal(existsSync(join(dir, 'runs', `${mine.id}.json.gz`)), false);
  assert.deepEqual(again.suites().map((x) => x.id), [t.id]);
  assert.deepEqual(again.index().map((m) => m.id), [theirs.id]);
  assert.equal(again.removeSuite('nope'), null);
});

test('access: automated suites (all, none, a list) and starting runs; the host always', () => {
  const owner = { role: 'owner' };
  const tester = { role: 'tester' };
  const viewer = { role: 'viewer' };
  assert.equal(canSeeSuite(owner, 'cms'), true);
  assert.equal(canSeeSuite(tester, 'cms'), true, 'no field yet: all suites');
  assert.equal(canSeeSuite({ role: 'tester', automationSuites: 'all' }, 'cms'), true);
  assert.equal(canSeeSuite({ role: 'tester', automationSuites: 'none' }, 'cms'), false);
  assert.equal(canSeeSuite({ role: 'viewer', automationSuites: ['notif'] }, 'cms'), false);
  assert.equal(canSeeSuite({ role: 'viewer', automationSuites: ['notif'] }, 'notif'), true);
  assert.equal(canSeeSuite({ role: 'owner', automationSuites: 'none' }, 'cms'), true);
  assert.equal(canSeeSuite(null, 'cms'), false);
  assert.equal(canAct(owner), true);
  assert.equal(canAct(tester), true, 'a tester may by default');
  assert.equal(canAct({ role: 'tester', startRuns: false }), false);
  assert.equal(canAct(viewer), false);
  assert.equal(canAct({ role: 'viewer', startRuns: true }), false, 'never for View only');
  assert.equal(canAct(null), false);
});
