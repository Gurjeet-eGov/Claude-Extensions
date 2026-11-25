// The Summary's Automated view and Run's Auto badges (GET /api/automation/cycle), and the locked
// automated results a publish carries (automation/ on the data branch): only kept runs of the
// workbooks being published, locked to who may see them, the same bytes while nothing changes (no
// new commit), locked again when access changes. A fake gh stands in for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeGh } from '../dev/fake-tools.mjs';
import { hashKey, newKey } from '../lib/team.mjs';
import { slugFor } from '../lib/publish.mjs';
import { identityFromKey, openRun } from '../lib/automation/seal.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const DATA = 'test-run-data';
const fx = (name) => readFileSync(new URL(`./fixtures/automation/${name}`, import.meta.url));
const earlier = () => Buffer.from(fx('playwright-junit.xml').toString('utf8').replace('2026-11-24T04:53:00.000Z', '2026-11-22T12:35:00.000Z').replace(/<failure message="assign[\s\S]*?<\/failure>/, ''));
const KEYS = { priya: newKey(), meera: newKey(), rahul: newKey(), notif: newKey() };

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-locked-'));
  const sheets = join(dir, 'sheets');
  mkdirSync(join(sheets, '.testrun'), { recursive: true });
  const p = (id, name, key, extra = {}) => ({ id, name, role: 'tester', hash: hashKey(key), key, ...extra });
  writeFileSync(join(sheets, '.testrun', 'app.json'), JSON.stringify({
    user: 'Host',
    team: { enabled: true, people: [
      p('p1', 'Priya', KEYS.priya),
      p('m1', 'Meera', KEYS.meera, { role: 'viewer' }),
      p('r1', 'Rahul', KEYS.rahul, { books: ['Bomet UAT.xlsx'] }), // another workbook only
      p('n1', 'Nina', KEYS.notif, { automationSuites: ['notifications'] }), // another suite only
    ] },
  }));
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-locked-gh-')));
  const server = createServer({ sheetsDir: sheets, ghPath: gh.bin, repo: { owner: 'org', repo: 'tools' }, publishPrefix: 'test-run-console/', dataBranch: DATA, publishedDir: join(dir, 'published'), cloneDir: join(dir, 'no-clone') });
  const base = await server.listenOn(0);
  const req = async (method, path, { body, raw, key } = {}) => {
    const headers = { 'X-Test-Run': '1' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path.replace(/^\//, ''), { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    return (r.headers.get('content-type') || '').startsWith('application/json') ? { status: r.status, ...JSON.parse(buf.toString('utf8')) } : { status: r.status, buf };
  };
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { body: { book: BOOK, args } });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  const suite = (await req('POST', '/api/automation/suites', { body: { name: 'CMS Automation', casePattern: 'CMS/\\d+' } })).suite.id;
  const importRun = (buf, cycle = 'v2.12', tab = TAB) => req('POST', `/api/automation/import?suite=${suite}&name=r.xml&book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(tab)}&cycle=${encodeURIComponent(cycle)}`, { raw: buf });
  const cycle = (q, key) => req('GET', `/api/automation/cycle?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(q.tab || TAB)}&cycle=${encodeURIComponent(q.cycle)}`, { key });
  return { server, base, sheets, gh, req, call, suite, importRun, cycle, close: () => server.close() };
}

test('Summary › Automated and the Auto badges: the latest run attached to the suite and cycle, the runs kept, case results; nothing attached: no data; access', async () => {
  const s = await start();
  try {
    const none = await s.cycle({ cycle: 'v2.12' });
    assert.deepEqual([none.ok, none.latest, none.runs, none.cases, none.coverage], [true, null, [], {}, null], 'nothing attached yet: Automated stays off');
    const first = await s.importRun(earlier());
    const second = await s.importRun(fx('playwright-junit.xml'));
    assert.ok(first.ok && second.ok);
    const d = await s.cycle({ cycle: 'v2.12' });
    assert.equal(d.ok, true, d.error);
    assert.equal(d.latest.id, second.run.id, 'the newest kept run');
    assert.deepEqual([d.latest.suiteName, d.latest.passRate, d.latest.previous.id, d.latest.previous.passRate], ['CMS Automation', 50, first.run.id, 75]);
    assert.deepEqual(d.latest.changed, { newFailures: 1, stillFailing: 1, fixed: 0, flaky: 0 });
    assert.equal(d.latest.causes.length, 2, 'the top 2 causes');
    assert.match(d.latest.causes[0].tests[0], /GRO assigns/);
    assert.equal(d.latest.tests, undefined, 'a summary, not the tests');
    assert.deepEqual(d.runs.map((r) => [r.id, r.prevPassRate]), [[second.run.id, 75], [first.run.id, null]]);
    assert.equal(d.keep, 2);
    // Run's badges: CMS/01 passed, CMS/02 failed in the latest run
    assert.deepEqual(d.cases, { 'CMS/01': 'pass', 'CMS/02': 'fail' });
    assert.deepEqual(d.coverage, { total: 18, covered: 2, passing: 1, failing: 1, skipped: 0 });
    // another cycle of the same suite: nothing there
    assert.equal((await s.cycle({ cycle: 'v2.11' })).latest, null);
    // access: a viewer reads it; someone without the workbook is refused; someone without the suite sees none
    assert.equal((await s.cycle({ cycle: 'v2.12' }, KEYS.meera)).latest.id, second.run.id);
    assert.equal((await s.cycle({ cycle: 'v2.12' }, KEYS.rahul)).status, 403);
    const other = await s.cycle({ cycle: 'v2.12' }, KEYS.notif);
    assert.deepEqual([other.ok, other.latest, other.cases], [true, null, {}]);
    assert.equal((await s.req('GET', '/api/automation/cycle?book=Gone.xlsx&tab=x&cycle=')).code, 'NO_BOOK');
  } finally { s.close(); }
});

test('publish: only kept runs of the published workbooks, locked to who may see them; nothing changed: no new commit; access changes lock them again', async () => {
  const s = await start();
  try {
    const slug = slugFor(BOOK);
    const r1 = await s.importRun(earlier());
    const r2 = await s.importRun(fx('playwright-junit.xml'));
    const r3 = await s.importRun(fx('playwright-junit.xml').toString('utf8').replace('2026-11-24T04:53:00.000Z', '2026-11-24T08:00:00.000Z'));
    assert.deepEqual(r3.removed.map((m) => m.id), [r1.run.id], 'the third run pushed the oldest out');
    await s.req('POST', '/api/publish/settings', { body: { books: { [BOOK]: true } } });
    const pub = await s.req('POST', '/api/publish/now', { body: { confirmPublic: true } });
    assert.equal(pub.ok, true, pub.error);
    assert.equal(pub.automation.runs, 2);
    const files = () => s.gh.readRepo(DATA).files;
    const f = files();
    const idx = JSON.parse(f['automation/index.json'].toString('utf8'));
    assert.deepEqual(idx.runs.map((x) => x.id).sort(), [r2.run.id, r3.run.id].sort(), 'only the kept runs');
    assert.ok(idx.runs.every((x) => x.book === slug && x.bytes > 0 && x.publishedAt && Object.keys(x).length === 4), 'the index says nothing more');
    assert.ok(!Object.keys(f).some((p) => p.includes(r1.run.id)), 'the run pushed out is not published');
    const sealed = (id) => Object.fromEntries(['key.age', 'meta.age', 'run.age'].map((n) => [n, files()[`automation/${id}/${n}`]]));
    const priya = await openRun(sealed(r3.run.id), identityFromKey(KEYS.priya));
    assert.equal(priya.meta.summary.id, r3.run.id);
    assert.deepEqual(priya.meta.summary.attach, { book: BOOK, tab: TAB, cycle: 'v2.12' });
    assert.equal(priya.meta.tabCases, 18);
    assert.deepEqual(priya.meta.cases, { 'CMS/01': 'pass', 'CMS/02': 'fail' });
    assert.equal(priya.detail.run.tests.length, 5, 'the run view\'s data');
    assert.equal(priya.detail.canAct, false);
    assert.ok(await openRun(sealed(r3.run.id), identityFromKey(KEYS.meera)), 'a viewer opens it');
    assert.equal(await openRun(sealed(r3.run.id), identityFromKey(KEYS.rahul)), null, 'not without the workbook');
    assert.equal(await openRun(sealed(r3.run.id), identityFromKey(KEYS.notif)), null, 'not without the suite');
    assert.equal(await openRun(sealed(r3.run.id), identityFromKey(newKey())), null, 'not a stranger');
    const app = JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8'));
    assert.match(app.lock.identity, /^AGE-SECRET-KEY-1/, 'the host\'s own key, in app.json');
    assert.ok(await openRun(sealed(r3.run.id), app.lock.identity), 'the host opens it');
    assert.ok(!f['automation/index.json'].toString('utf8').includes('AGE-SECRET'));

    // what everyone sees, not locked: the figures of each cycle, and nothing else
    const everyoneText = f['automation/everyone.json'].toString('utf8');
    const ev = JSON.parse(everyoneText);
    assert.equal(ev.cycles.length, 1);
    const cy = ev.cycles[0];
    assert.deepEqual([cy.book, cy.tab, cy.cycle], [slug, TAB, 'v2.12']);
    assert.equal(cy.latest.suiteName, priya.meta.summary.suiteName);
    assert.deepEqual(cy.latest.totals, priya.meta.summary.totals);
    assert.deepEqual(cy.latest.changed, priya.meta.summary.changed);
    assert.equal(cy.latest.passRate, priya.meta.summary.passRate);
    assert.deepEqual(cy.runs.map((x) => x.startedAt), [r3, r2].map((x) => x.run.startedAt), 'the runs kept, newest first');
    assert.deepEqual(cy.coverage, { total: 18, covered: 2, passing: 1, failing: 1 });
    assert.deepEqual(Object.keys(cy.latest).sort(), ['attach', 'changed', 'env', 'importedAt', 'options', 'passRate', 'previous', 'startedAt', 'suiteName', 'totals']);
    assert.deepEqual(Object.keys(cy.latest.attach).sort(), ['cycle', 'tab']);
    assert.ok(cy.runs.every((x) => !('id' in x) && !('source' in x) && !('sha' in x) && !('branch' in x)));
    for (const secret of [r2.run.id, r3.run.id, 'causes', 'runUrl', 'reportUrl', 'sha', 'branch', 'GRO assigns', 'AGE-SECRET', 'Priya']) assert.ok(!everyoneText.includes(secret), `everyone.json leaves out ${secret}`);
    assert.equal((await s.req('GET', '/automation/everyone.json')).cycles.length, 1, 'served by the laptop too');

    // served by the laptop too, as published
    assert.equal((await s.req('GET', '/automation/index.json')).runs.length, 2);
    const key = await s.req('GET', `/automation/${r3.run.id}/key.age`);
    assert.deepEqual([key.status, Buffer.compare(key.buf, files()[`automation/${r3.run.id}/key.age`])], [200, 0]);
    assert.equal((await s.req('GET', '/automation/../.testrun/app.json')).status, 404);

    // nothing changed: the same bytes, no new commit
    const commits = s.gh.readRepo(DATA).commits;
    const again = await s.req('POST', '/api/publish/now', { body: {} });
    assert.deepEqual([again.ok, again.result.committed, s.gh.readRepo(DATA).commits], [true, false, commits]);
    // the space meter builds the same publish: still nothing new
    await s.req('GET', '/api/publish/space');
    assert.equal((await s.req('POST', '/api/publish/now', { body: {} })).result.committed, false);

    // Priya is removed: the next publish locks the runs again, and her key no longer opens them
    await s.req('POST', '/api/team/people/remove', { body: { id: 'p1' } });
    const relock = await s.req('POST', '/api/publish/now', { body: {} });
    assert.equal(relock.result.committed, true, 'locked again');
    assert.ok(relock.result.changed.includes(`automation/${r3.run.id}/key.age`));
    assert.equal(await openRun(sealed(r3.run.id), identityFromKey(KEYS.priya)), null, 'a removed person\'s key opens nothing');
    assert.ok(await openRun(sealed(r3.run.id), identityFromKey(KEYS.meera)));

    // Meera is given another workbook only: locked again without her
    await s.req('POST', '/api/team/people/update', { body: { id: 'm1', books: [BOOK] } });
    assert.equal((await s.req('POST', '/api/publish/now', { body: {} })).result.committed, false, 'the same access: nothing new');

    // a deleted run leaves the branch; with the workbook unticked, no automation goes out at all
    await s.req('POST', '/api/automation/delete', { body: { id: r2.run.id } });
    const del = await s.req('POST', '/api/publish/now', { body: {} });
    assert.equal(del.result.committed, true);
    assert.ok(!Object.keys(files()).some((p) => p.includes(r2.run.id)), 'the deleted run is gone from the branch');
    await s.req('POST', '/api/publish/settings', { body: { books: { [BOOK]: false } } });
    await s.req('POST', '/api/publish/now', { body: {} });
    assert.ok(!Object.keys(files()).some((p) => p.startsWith('automation/')), 'a workbook taken off takes its runs with it');
    assert.equal((await s.req('GET', '/automation/index.json')).status, 404);
  } finally { s.close(); }
});
