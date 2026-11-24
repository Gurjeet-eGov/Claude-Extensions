// Publishing to GitHub (the host only), the public reports, and carrying on from
// a clone. A fake gh with a small repository stands in for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeGh } from '../dev/fake-tools.mjs';
import { blobSha, repoFromRemote, slugFor } from '../lib/publish.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const PREFIX = 'test-run-console/published';

async function host({ gh, sheets, publishedDir, withBook = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-pub-'));
  const sheetsDir = sheets || join(dir, 'sheets');
  mkdirSync(sheetsDir, { recursive: true });
  if (withBook) writeFileSync(join(sheetsDir, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir, ghPath: gh.bin, repo: { owner: 'org', repo: 'tools' }, publishPrefix: 'test-run-console/', publishedDir: publishedDir || join(dir, 'published') });
  const base = await server.listenOn(0);
  const local = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path.replace(/^\//, ''), { method, headers: { 'X-Test-Run': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, text }; }
  };
  const call = (fn, ...args) => local('POST', `/api/call/${fn}`, { book: BOOK, args });
  if (withBook) {
    const boot = await call('api_bootstrap');
    await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  }
  return { server, base, sheetsDir, local, call, close: () => server.close() };
}

const files = (gh) => gh.readRepo().files;
const json = (buf) => JSON.parse(buf.toString('utf8'));

test('publish: the host ticks workbooks, confirms once, and one commit holds the workbook, its sidecar and the reports', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    const st = await h.local('GET', '/api/publish');
    assert.deepEqual([st.repo, st.branch, st.books], ['org/tools', 'master', [{ name: BOOK, on: false }]]);
    assert.equal(st.settings.time, '17:00', 'daily at 5 pm unless changed');
    assert.equal((await h.local('POST', '/api/publish/now', {})).code, 'NOTHING', 'nothing ticked');
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const first = await h.local('POST', '/api/publish/now', {});
    assert.equal(first.code, 'CONFIRM_PUBLIC', 'the first publish asks: it is public');
    const ok = await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.result.committed, true);
    assert.equal(ok.newer, false, 'your own publish is not "newer data" to you');
    assert.equal((await h.local('GET', '/api/app')).publishNotice, null);
    const f = files(gh);
    const slug = slugFor(BOOK);
    assert.deepEqual(Object.keys(f).sort(), ['README.md', `${PREFIX}/reports/${slug}.json`, `${PREFIX}/reports/${slug}.xlsx`, `${PREFIX}/reports/index.json`, `${PREFIX}/workbooks/${BOOK}`, `${PREFIX}/workbooks/.testrun/CMS Sign Off (sample).json`].sort());
    assert.deepEqual([...f[`${PREFIX}/reports/${slug}.xlsx`].subarray(0, 2)], [0x50, 0x4b], 'the Download copy is a real .xlsx');
    assert.equal(blobSha(f[`${PREFIX}/workbooks/${BOOK}`]), blobSha(readFileSync(join(h.sheetsDir, BOOK))), 'the workbook exactly as saved');
    assert.ok(!Object.keys(f).some((p) => /app\.json|backups|exports/.test(p)), 'never the team settings, backups or exports');
    const index = json(f[`${PREFIX}/reports/index.json`]);
    assert.deepEqual(index.workbooks.map((w) => [w.name, w.slug, w.xlsx]), [[BOOK, slug, true]]);
    const report = json(f[`${PREFIX}/reports/${slug}.json`]);
    const suite = report.suites.find((x) => x.tab === TAB);
    assert.equal(suite.current, 'v2.12');
    assert.equal(suite.summaries['v2.12'].summary.counts.total, 18);
    assert.equal(ok.last.note, '5 files updated.');

    // Nothing changed: no new commit
    const before = gh.readRepo().commits;
    const again = await h.local('POST', '/api/publish/now', {});
    assert.deepEqual([again.ok, again.result.committed, gh.readRepo().commits], [true, false, before]);
    // A result marked: only what changed is sent, in a new commit
    const c = (await h.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/04');
    await h.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    const third = await h.local('POST', '/api/publish/now', {});
    assert.equal(third.result.committed, true);
    assert.equal(third.newer, false, 'still not news after a later publish');
    assert.equal((await h.local('GET', '/api/app')).publishNotice, null);
    assert.ok(third.result.changed.includes(`${PREFIX}/workbooks/${BOOK}`));
    assert.ok(!third.result.changed.includes(`${PREFIX}/workbooks/.testrun/CMS Sign Off (sample).json`), 'the unchanged sidecar is not sent again');
    assert.equal(json(files(gh)[`${PREFIX}/reports/${slug}.json`]).suites.find((x) => x.tab === TAB).summaries['v2.12'].summary.counts.pass, 5);

    // The reports are public on the laptop too (visitors without a key)
    const pub = await fetch(`${h.base}reports/index.json`);
    assert.equal(pub.status, 200);
    assert.equal((await pub.json()).workbooks[0].name, BOOK);
    assert.equal((await fetch(`${h.base}reports/nope.json`)).status, 404);
    const xl = await fetch(`${h.base}reports/${slug}.xlsx`);
    assert.deepEqual([xl.status, xl.headers.get('content-type')], [200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], 'and the Download copy');
  } finally { h.close(); }
});

test('with nothing ticked, a publish takes every published report down', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    assert.equal((await h.local('POST', '/api/publish/now', { confirmPublic: true })).ok, true);
    const slug = slugFor(BOOK);
    assert.ok(files(gh)[`${PREFIX}/reports/${slug}.json`]);
    // Untick it: one commit removes it all; the index stays, listing no workbooks
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: false } });
    const down = await h.local('POST', '/api/publish/now', {});
    assert.equal(down.ok, true, down.error);
    assert.equal(down.result.committed, true);
    assert.deepEqual(Object.keys(files(gh)).sort(), ['README.md', `${PREFIX}/reports/index.json`], 'workbooks, sidecars and reports removed');
    assert.deepEqual(json(files(gh)[`${PREFIX}/reports/index.json`]).workbooks, []);
    assert.match(gh.readRepo().message, /take the published reports down/);
    assert.equal(down.last.note, '1 file updated, 4 removed.', 'the index, and the four files of the workbook');
    // The laptop's copy of the reports follows
    assert.deepEqual((await (await fetch(`${h.base}reports/index.json`)).json()).workbooks, []);
    assert.equal((await fetch(`${h.base}reports/${slug}.json`)).status, 404);
    // Again: nothing left to take down
    const again = await h.local('POST', '/api/publish/now', {});
    assert.deepEqual([again.ok, again.result.committed], [true, false]);
  } finally { h.close(); }
});

test('only the host publishes: testers and viewers are refused', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    await h.local('POST', '/api/team', { enabled: true, mode: 'fixed', fixedUrl: h.base.replace(/\/$/, '') });
    const p = await h.local('POST', '/api/team/people', { name: 'John Doe', role: 'tester' });
    const key = new URLSearchParams(p.link.split('#')[1]).get('join');
    const remote = (method, path, body) => new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ host: '127.0.0.1', port: new URL(h.base).port, path, method, headers: { 'X-Test-Run': '1', Host: 'fox.trycloudflare.com', 'X-Forwarded-For': '203.0.113.7', Authorization: `Bearer ${key}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(b) }));
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
    assert.equal((await remote('GET', '/api/publish')).status, 403);
    assert.equal((await remote('POST', '/api/publish/now', { confirmPublic: true })).status, 403);
  } finally { h.close(); }
});

test('two hosts: a newer publish by someone else is not overwritten unasked; Get latest brings it in', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const a = await host({ gh });
  const b = await host({ gh });
  try {
    for (const h of [a, b]) await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    assert.equal((await a.local('POST', '/api/publish/now', { confirmPublic: true })).ok, true);
    // b has never got or published anything: a's publish is news to it
    const bs = await b.local('GET', '/api/publish?refresh=1');
    assert.equal(bs.newer, true);
    const refused = await b.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(refused.code, 'NEWER_REMOTE');
    assert.match(refused.error, /published at .+ after this laptop/);
    // b gets a's data, then can publish on top of it
    const c = (await a.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/12');
    await a.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Fail' });
    await a.local('POST', '/api/publish/now', {});
    const got = await b.local('POST', '/api/publish/get-latest', {});
    assert.equal(got.ok, true, got.error);
    assert.deepEqual(got.result.books, [BOOK]);
    const c12 = (await b.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/12');
    assert.equal(c12.statuses[0], 'Fail', "b now has a's results");
    assert.ok(existsSync(join(b.sheetsDir, '.testrun', 'backups')), 'b kept a copy of what it had');
    assert.equal((await b.local('GET', '/api/publish')).newer, false);
    const nothingNew = await b.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.deepEqual([nothingNew.ok, nothingNew.result.committed], [true, false], 'the same data as what is there: nothing to commit');
    const c13 = (await b.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/13');
    await b.call('api_mark', { tab: TAB, key: c13.key, sh: c13.sh, row: c13.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    const bPub = await b.local('POST', '/api/publish/now', {});
    assert.equal(bPub.result.committed, true, bPub.error);
    // ... and now a is the one behind
    assert.equal((await a.local('POST', '/api/publish/now', {})).code, 'NEWER_REMOTE');
    assert.equal((await a.local('POST', '/api/publish/now', { force: true })).ok, true, 'unless asked to publish anyway');
  } finally { a.close(); b.close(); }
});

test('if someone pushes while publishing, the publish is built again on top of theirs', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')), { raceOnce: true });
  const h = await host({ gh });
  try {
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const r = await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(r.ok, true, r.error);
    const f = files(gh);
    assert.ok(f['OTHER.md'], 'their change is kept');
    assert.ok(f[`${PREFIX}/reports/index.json`], 'ours is on top');
  } finally { h.close(); }
});

test('daily at the set time (5 pm by default) and when Test Run stops, once the host has published by hand', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    assert.equal(h.server.publish.tick(new Date(2026, 10, 19, 17, 30)), null, 'never by itself before the first publish by hand');
    await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(h.server.publish.tick(new Date(2026, 10, 20, 16, 59)), null, 'not before 17:00');
    const c = (await h.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/09');
    await h.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    const run = h.server.publish.tick(new Date(2026, 10, 20, 17, 1));
    assert.ok(run, 'publishes after 17:00');
    assert.equal((await run).committed, true);
    assert.equal(h.server.publish.tick(new Date(2026, 10, 20, 18, 0)), null, 'once a day');
    assert.equal((await h.local('POST', '/api/publish/settings', { time: '25:00' })).code, 'BAD_INPUT');
    // Stopping Test Run does not publish (there is no such option any more)
    assert.equal(h.server.publish.onStop, undefined);
    assert.equal('onStop' in (await h.local('GET', '/api/publish')).settings, false);
  } finally { h.close(); }
});

test('carry on from a clone: start from the published data in it', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const a = await host({ gh });
  await a.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
  await a.local('POST', '/api/publish/now', { confirmPublic: true });
  a.close();
  // what a clone has: the published folder, from the repository
  const clone = mkdtempSync(join(tmpdir(), 'testrun-clone-'));
  for (const [path, buf] of Object.entries(files(gh))) {
    if (!path.startsWith(`${PREFIX}/`)) continue;
    const to = join(clone, path.slice(PREFIX.length + 1));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, buf);
  }
  const b = await host({ gh, publishedDir: clone, withBook: false });
  try {
    const app0 = await b.local('GET', '/api/app');
    assert.deepEqual(app0.published.workbooks, [BOOK], 'a fresh clone offers the published data');
    const r = await b.local('POST', '/api/publish/start-from-local', {});
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.app.books.map((x) => x.name), [BOOK]);
    assert.equal(r.app.last.book, BOOK);
    const boot = await b.call('api_bootstrap');
    assert.ok(boot.config && boot.config.tabs[TAB], 'its setup came along (the sidecar)');
    assert.equal((await b.local('GET', '/api/publish')).newer, false, 'it knows it has the latest');
    assert.equal((await fetch(`${b.base}reports/index.json`)).status, 200, 'and serves the reports');
  } finally { b.close(); }
});

test('publish helpers', () => {
  assert.equal(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', "git's own id for the file");
  assert.deepEqual(repoFromRemote('https://github.com/example-org/tools.git'), { owner: 'example-org', repo: 'tools' });
  assert.deepEqual(repoFromRemote('git@github.com:Org/repo.git'), { owner: 'Org', repo: 'repo' });
  assert.equal(repoFromRemote('https://gitlab.com/a/b'), null);
  assert.match(slugFor('CMS Sign Off (sample).xlsx'), /^cms-sign-off-sample-[0-9a-f]{6}$/);
  assert.notEqual(slugFor('A.xlsx'), slugFor('a.xlsx'), 'distinct names stay distinct');
});
