// Publishing to GitHub (the host only), the public reports, and carrying on from
// a clone. A fake gh with a small repository stands in for GitHub. Everything
// published goes to the data branch, as one commit with no parent, replaced at
// each publish; the default branch is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeGh } from '../dev/fake-tools.mjs';
import { blobSha, repoFromRemote, slugFor, publishFiles } from '../lib/publish.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const SIDE = 'CMS Sign Off (sample).json';
const TAB = 'CMS 2.20.1';
const DATA = 'test-run-data';
const OLD = 'test-run-console/published'; // where publishing went before the data branch

async function host({ gh, sheets, publishedDir, cloneDir, withBook = true, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-pub-'));
  const sheetsDir = sheets || join(dir, 'sheets');
  mkdirSync(sheetsDir, { recursive: true });
  if (withBook) writeFileSync(join(sheetsDir, BOOK), await buildSampleXlsx());
  const server = createServer({ sheetsDir, ghPath: gh.bin, repo: { owner: 'org', repo: 'tools' }, publishPrefix: 'test-run-console/', dataBranch: DATA, publishedDir: publishedDir || join(dir, 'published'), cloneDir: cloneDir || join(dir, 'no-clone'), ...opts });
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

const data = (gh) => gh.readRepo(DATA);
const files = (gh) => data(gh).files;
const json = (buf) => JSON.parse(buf.toString('utf8'));
/** The data branch is one commit with no parent. */
function oneCommit(gh, what) {
  const d = data(gh);
  assert.ok(d, `${what}: the data branch is there`);
  assert.deepEqual([d.parents, d.history], [[], 1], `${what}: one commit, with no parent`);
}

test('publish: the host ticks workbooks, confirms once; the first publish creates the data branch with one commit holding the workbook, its sidecar and the reports', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    const st = await h.local('GET', '/api/publish');
    assert.deepEqual([st.repo, st.branch, st.dataBranch, st.folder, st.books], ['org/tools', 'master', DATA, '', [{ name: BOOK, on: false }]]);
    assert.equal(st.dataBranchExists, false, 'no data branch yet');
    assert.equal(st.settings.time, '17:00', 'daily at 5 pm unless changed');
    assert.equal((await h.local('POST', '/api/publish/now', {})).code, 'NOTHING', 'nothing ticked');
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const first = await h.local('POST', '/api/publish/now', {});
    assert.equal(first.code, 'CONFIRM_PUBLIC', 'the first publish asks: it is public');
    assert.equal(data(gh), null, 'nothing published before that');
    const ok = await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.result.committed, true);
    assert.equal(ok.result.pagesError, '');
    assert.equal(ok.newer, false, 'your own publish is not "newer data" to you');
    assert.equal(ok.dataBranchExists, true);
    assert.equal((await h.local('GET', '/api/app')).publishNotice, null);
    oneCommit(gh, 'the first publish');
    const f = files(gh);
    const slug = slugFor(BOOK);
    assert.deepEqual(Object.keys(f).sort(), [`reports/${slug}.json`, `reports/${slug}.xlsx`, 'reports/index.json', `workbooks/${BOOK}`, `workbooks/.testrun/${SIDE}`].sort(), 'the data alone, at the root of the branch');
    assert.deepEqual([Object.keys(gh.readRepo().files), gh.readRepo().history], [['README.md'], 1], 'the default branch is not touched');
    assert.deepEqual(gh.dispatches().map((d) => [d.dispatch, d.body]), [['test-run-pages.yml', { ref: 'master' }]], 'the Pages workflow is started, on the default branch');
    assert.deepEqual([...f[`reports/${slug}.xlsx`].subarray(0, 2)], [0x50, 0x4b], 'the Download copy is a real .xlsx');
    assert.equal(blobSha(f[`workbooks/${BOOK}`]), blobSha(readFileSync(join(h.sheetsDir, BOOK))), 'the workbook exactly as saved');
    assert.ok(!Object.keys(f).some((p) => /app\.json|backups|exports/.test(p)), 'never the team settings, backups or exports');
    const index = json(f['reports/index.json']);
    assert.deepEqual(index.workbooks.map((w) => [w.name, w.slug, w.xlsx]), [[BOOK, slug, true]]);
    const report = json(f[`reports/${slug}.json`]);
    const suite = report.suites.find((x) => x.tab === TAB);
    assert.equal(suite.current, 'v2.12');
    assert.equal(suite.summaries['v2.12'].summary.counts.total, 18);
    assert.equal(ok.last.note, '5 files updated.');

    // Nothing changed: no new commit, and the site is not built again
    const before = data(gh).commits;
    const again = await h.local('POST', '/api/publish/now', {});
    assert.deepEqual([again.ok, again.result.committed, data(gh).commits], [true, false, before]);
    assert.equal(gh.dispatches().length, 1);
    // A result marked: the branch is replaced by a new single commit; only what changed is uploaded
    const c = (await h.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/04');
    await h.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    const firstSha = data(gh).sha;
    const third = await h.local('POST', '/api/publish/now', {});
    assert.equal(third.result.committed, true);
    assert.notEqual(data(gh).sha, firstSha);
    oneCommit(gh, 'the second publish');
    assert.equal(third.newer, false, 'still not news after a later publish');
    assert.equal((await h.local('GET', '/api/app')).publishNotice, null);
    assert.ok(third.result.changed.includes(`workbooks/${BOOK}`));
    assert.ok(!third.result.changed.includes(`workbooks/.testrun/${SIDE}`), 'the unchanged sidecar is not sent again');
    assert.ok(files(gh)[`workbooks/.testrun/${SIDE}`], '... but it is still on the branch');
    assert.equal(json(files(gh)[`reports/${slug}.json`]).suites.find((x) => x.tab === TAB).summaries['v2.12'].summary.counts.pass, 5);
    assert.equal(gh.dispatches().length, 2, 'the site is built again');

    // The reports are public on the laptop too (visitors without a key)
    const pub = await fetch(`${h.base}reports/index.json`);
    assert.equal(pub.status, 200);
    assert.equal((await pub.json()).workbooks[0].name, BOOK);
    assert.equal((await fetch(`${h.base}reports/nope.json`)).status, 404);
    const xl = await fetch(`${h.base}reports/${slug}.xlsx`);
    assert.deepEqual([xl.status, xl.headers.get('content-type')], [200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], 'and the Download copy');
  } finally { h.close(); }
});

test('a workbook taken off leaves the branch; with nothing ticked, a publish takes every published report down', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    writeFileSync(join(h.sheetsDir, 'Second.xlsx'), await buildSampleXlsx());
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true, 'Second.xlsx': true } });
    assert.equal((await h.local('POST', '/api/publish/now', { confirmPublic: true })).ok, true);
    const slug = slugFor(BOOK);
    const slug2 = slugFor('Second.xlsx');
    const second = Object.keys(files(gh)).filter((p) => p.includes('Second') || p.includes(slug2)).sort();
    assert.ok(second.includes('workbooks/Second.xlsx') && second.includes(`reports/${slug2}.json`) && second.includes(`reports/${slug2}.xlsx`), second.join());
    // Untick one: the branch is replaced without it
    await h.local('POST', '/api/publish/settings', { books: { 'Second.xlsx': false } });
    const one = await h.local('POST', '/api/publish/now', {});
    assert.equal(one.result.committed, true, one.error);
    oneCommit(gh, 'after taking one off');
    assert.deepEqual(Object.keys(files(gh)).sort(), [`reports/${slug}.json`, `reports/${slug}.xlsx`, 'reports/index.json', `workbooks/${BOOK}`, `workbooks/.testrun/${SIDE}`].sort(), 'Second is gone from the branch');
    assert.deepEqual(one.result.removed.sort(), second, 'its files, reported as removed');
    // Untick the other: one commit holds the index alone, listing no workbooks
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: false } });
    const down = await h.local('POST', '/api/publish/now', {});
    assert.equal(down.ok, true, down.error);
    assert.equal(down.result.committed, true);
    oneCommit(gh, 'after taking everything down');
    assert.deepEqual(Object.keys(files(gh)), ['reports/index.json'], 'workbooks, sidecars and reports removed');
    assert.deepEqual(json(files(gh)['reports/index.json']).workbooks, []);
    assert.match(data(gh).message, /take the published reports down/);
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
    assert.equal((await remote('GET', '/api/publish/space')).status, 403);
    assert.equal((await remote('POST', '/api/publish/now', { confirmPublic: true })).status, 403);
  } finally { h.close(); }
});

test('two hosts: a newer publish by someone else is not overwritten unasked; Get latest brings it in from the data branch', async () => {
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
    assert.match(refused.error, /published at .+ after this host-server/);
    // b gets a's data, then can publish on top of it
    const c = (await a.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/12');
    await a.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Fail' });
    await a.local('POST', '/api/publish/now', {});
    const got = await b.local('POST', '/api/publish/get-latest', {});
    assert.equal(got.ok, true, got.error);
    assert.deepEqual(got.result.books, [BOOK]);
    const c12 = (await b.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/12');
    assert.equal(c12.statuses[0], 'Fail', "b now has a's results, from the data branch");
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
    oneCommit(gh, 'after four publishes by two hosts');
  } finally { a.close(); b.close(); }
});

test('if someone else publishes while this laptop is publishing, it is refused rather than replacing theirs unseen', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')), { raceReplaceOnce: DATA });
  const h = await host({ gh });
  try {
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const r = await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(r.code, 'NEWER_REMOTE', r.error);
    assert.match(r.error, /^Someone Else published at 2026-11-24 09:00, after this host-server/);
    assert.deepEqual(Object.keys(files(gh)), ['reports/index.json'], 'theirs is kept');
    assert.equal(json(files(gh)['reports/index.json']).by, 'Someone Else');
    assert.equal(gh.dispatches().length, 0, 'the site is not built for a publish that did not happen');
    // Publish anyway: ours replaces theirs, still one commit
    const forced = await h.local('POST', '/api/publish/now', { confirmPublic: true, force: true });
    assert.equal(forced.ok, true, forced.error);
    oneCommit(gh, 'after publishing anyway');
    assert.ok(files(gh)[`workbooks/${BOOK}`]);
  } finally { h.close(); }
});

test('before the data branch exists: what was published on the default branch is read, and the first publish creates the branch', async () => {
  const slug = slugFor(BOOK);
  const index = { app: 'test-run', id: 'old-publish', publishedAt: '2026-11-01 10:00', by: 'Old Host', workbooks: [{ name: BOOK, title: 'CMS Sign Off (sample)', slug, suites: [], xlsx: false }] };
  const old = {
    'README.md': '# Repo\n',
    [`${OLD}/reports/index.json`]: JSON.stringify(index),
    [`${OLD}/reports/${slug}.json`]: JSON.stringify({ app: 'test-run', book: BOOK, slug, suites: [] }),
    [`${OLD}/workbooks/${BOOK}`]: await buildSampleXlsx(),
  };
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')), { files: old });
  const masterBefore = gh.readRepo();
  const b = await host({ gh, withBook: false });
  try {
    const st = await b.local('GET', '/api/publish?refresh=1');
    assert.equal(st.dataBranchExists, false);
    assert.equal(st.oldFolder, OLD);
    assert.deepEqual([st.newer, st.remote.by, st.remote.workbooks], [true, 'Old Host', [BOOK]], 'the old publish is found on the default branch');
    const got = await b.local('POST', '/api/publish/get-latest', {});
    assert.equal(got.ok, true, got.error);
    assert.deepEqual(got.result.books, [BOOK]);
    assert.equal(blobSha(readFileSync(join(b.sheetsDir, BOOK))), blobSha(old[`${OLD}/workbooks/${BOOK}`]), 'the workbook came from the default branch');
    assert.equal((await (await fetch(`${b.base}reports/index.json`)).json()).by, 'Old Host', 'and its reports');
    // The first publish creates the data branch; the default branch keeps its old folder, untouched
    const pub = await b.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(pub.ok, true, pub.error);
    assert.equal(pub.result.committed, true);
    assert.equal(pub.dataBranchExists, true);
    oneCommit(gh, 'the first publish after the old place');
    assert.ok(files(gh)[`workbooks/${BOOK}`] && files(gh)['reports/index.json']);
    const masterAfter = gh.readRepo();
    assert.deepEqual([masterAfter.sha, masterAfter.history], [masterBefore.sha, 1]);
    assert.deepEqual(Object.keys(masterAfter.files).sort(), Object.keys(old).sort());
    // From now on it is read from the data branch
    const st2 = await b.local('GET', '/api/publish?refresh=1');
    assert.deepEqual([st2.newer, st2.remote.by], [false, json(files(gh)['reports/index.json']).by]);
  } finally { b.close(); }
});

test('the site update is started after a publish; if GitHub refuses it, the publish still succeeds and says so', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')), { failDispatch: true });
  const h = await host({ gh });
  try {
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const r = await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.committed, true);
    oneCommit(gh, 'published');
    assert.match(r.result.pagesError, /^Published, but the GitHub Pages site was not updated \(Resource not accessible by integration \(HTTP 403\)\)\. Publish again, or run the “Test Run page” workflow/);
    assert.equal(r.last.error, '', 'not an error of the publish');
    assert.equal((await h.local('GET', '/api/publish')).last.pagesError, r.result.pagesError, 'Setup › Publish shows it');
    assert.deepEqual(gh.dispatches().map((d) => d.dispatch), ['test-run-pages.yml']);
    // Publish again with nothing changed: no commit, but the site update is tried again
    const again = await h.local('POST', '/api/publish/now', {});
    assert.deepEqual([again.ok, again.result.committed], [true, false]);
    assert.equal(gh.dispatches().length, 2);
    assert.match(again.result.pagesError, /not updated/);
  } finally { h.close(); }
});

test('the data branch and the folder in it are settings', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh, dataBranch: 'pages-data', dataPrefix: 'site' });
  try {
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const r = await h.local('POST', '/api/publish/now', { confirmPublic: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.dataBranch, r.folder], ['pages-data', 'site']);
    const d = gh.readRepo('pages-data');
    assert.deepEqual([d.parents, d.history], [[], 1]);
    assert.ok(d.files['site/reports/index.json'] && d.files[`site/workbooks/${BOOK}`]);
    assert.ok(!Object.keys(d.files).some((p) => !p.startsWith('site/')));
    assert.equal(data(gh), null, 'nothing on test-run-data');
    assert.equal((await fetch(`${h.base}reports/index.json`)).status, 200, 'the laptop serves the reports');
    assert.equal((await h.local('GET', '/api/publish?refresh=1')).newer, false, 'and reads the index back from there');
  } finally { h.close(); }
});

test('space on GitHub Pages: what a publish puts on the site, in parts, against 1 GB', async () => {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const h = await host({ gh });
  try {
    const none = await h.local('GET', '/api/publish/space');
    assert.equal(none.ok, true, none.error);
    assert.deepEqual([none.limit, none.warnAt, none.warn, none.parts.workbooks, none.parts.automation], [1024 ** 3, 800 * 1024 ** 2, false, 0, 0]);
    assert.ok(none.parts.reports > 0 && none.total === none.parts.reports, 'nothing ticked: the index alone');
    await h.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
    const ticked = await h.local('GET', '/api/publish/space');
    assert.ok(ticked.parts.workbooks > 1000, 'the download copy of the workbook');
    assert.equal(ticked.total, ticked.parts.workbooks + ticked.parts.reports);
    // After a publish: exactly what went to the site's folder of the branch
    await h.local('POST', '/api/publish/now', { confirmPublic: true });
    const after = await h.local('GET', '/api/publish/space');
    const f = files(gh);
    const size = (re) => Object.keys(f).filter((p) => re.test(p)).reduce((n, p) => n + f[p].length, 0);
    assert.deepEqual([after.parts.workbooks, after.parts.reports], [size(/^reports\/.+\.xlsx$/), size(/^reports\/.+\.json$/)]);
    assert.ok(size(/^workbooks\//) > 0, 'the workbooks folder is on the branch, not on the site');
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

/** Publish once from a first host, and give back what is on the data branch. */
async function publishedOnce() {
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')));
  const a = await host({ gh });
  await a.local('POST', '/api/publish/settings', { books: { [BOOK]: true } });
  await a.local('POST', '/api/publish/now', { confirmPublic: true });
  a.close();
  return { gh, published: files(gh) };
}

async function startsFromIt(b, by) {
  const app0 = await b.local('GET', '/api/app');
  assert.deepEqual(app0.published.workbooks, [BOOK], 'a fresh clone offers the published data');
  if (by) assert.equal(app0.published.by, by);
  assert.equal((await fetch(`${b.base}reports/index.json`)).status, 200, 'and serves its reports');
  const r = await b.local('POST', '/api/publish/start-from-local', {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.app.books.map((x) => x.name), [BOOK]);
  assert.equal(r.app.last.book, BOOK);
  const boot = await b.call('api_bootstrap');
  assert.ok(boot.config && boot.config.tabs[TAB], 'its setup came along (the sidecar)');
  assert.equal((await b.local('GET', '/api/publish')).newer, false, 'it knows it has the latest');
}

test('carry on from a clone: start from its copy of the data branch', async () => {
  const { gh, published } = await publishedOnce();
  // what a clone has: the data branch, fetched as origin/test-run-data (here a local branch)
  const clone = mkdtempSync(join(tmpdir(), 'testrun-clone-'));
  const git = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', `refs/heads/${DATA}`);
  for (const [path, buf] of Object.entries(published)) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), buf);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'Test Run: publish');
  // an older copy in the checkout's published folder is not used once the branch is there
  const stale = mkdtempSync(join(tmpdir(), 'testrun-stale-'));
  mkdirSync(join(stale, 'reports'), { recursive: true });
  writeFileSync(join(stale, 'reports', 'index.json'), JSON.stringify({ app: 'test-run', id: 'old', publishedAt: '2026-01-01 10:00', by: 'Old Host', workbooks: [{ name: BOOK }] }));
  const b = await host({ gh, cloneDir: clone, publishedDir: stale, withBook: false });
  try {
    await startsFromIt(b, json(published['reports/index.json']).by);
  } finally { b.close(); }
});

test('carry on from a clone made before the data branch: start from its published folder', async () => {
  const { gh, published } = await publishedOnce();
  // what an older clone has: the published folder (the same layout), in the checkout
  const clone = mkdtempSync(join(tmpdir(), 'testrun-clone-'));
  for (const [path, buf] of Object.entries(published)) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), buf);
  }
  const b = await host({ gh, publishedDir: clone, withBook: false });
  try {
    await startsFromIt(b);
  } finally { b.close(); }
});

test('publish helpers', async () => {
  assert.equal(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', "git's own id for the file");
  assert.deepEqual(repoFromRemote('https://github.com/example-org/tools.git'), { owner: 'example-org', repo: 'tools' });
  assert.deepEqual(repoFromRemote('git@github.com:Org/repo.git'), { owner: 'Org', repo: 'repo' });
  assert.equal(repoFromRemote('https://gitlab.com/a/b'), null);
  assert.match(slugFor('CMS Sign Off (sample).xlsx'), /^cms-sign-off-sample-[0-9a-f]{6}$/);
  assert.notEqual(slugFor('A.xlsx'), slugFor('a.xlsx'), 'distinct names stay distinct');
  // The default mode still commits on top: if someone pushes meanwhile, it is built again on theirs
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')), { raceOnce: true });
  const res = await publishFiles({ cmd: gh.bin, owner: 'org', repo: 'tools', branch: 'master', prefix: 'out', files: [{ path: 'out/a.txt', content: Buffer.from('a') }], message: 'On top' });
  assert.ok(res.commit);
  const m = gh.readRepo();
  assert.deepEqual(Object.keys(m.files).sort(), ['OTHER.md', 'README.md', 'out/a.txt'], 'their change is kept, ours is on top');
  assert.equal(m.history, 3);
});
