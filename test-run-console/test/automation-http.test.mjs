// Automation over HTTP (/api/automation/*): link a suite, import results (one file, several,
// a zip), the run view's data, Excel made on demand, delete, re-attach, keeping the last N runs,
// and who may read or act: a viewer reads but doesn't import; someone without the workbook sees nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { hashKey, newKey } from '../lib/team.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const fx = (name) => readFileSync(new URL(`./fixtures/automation/${name}`, import.meta.url));
const KEYS = { viewer: newKey(), tester: newKey(), outsider: newKey() };

async function start({ keep } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-autohttp-'));
  const sheets = join(dir, 'sheets');
  mkdirSync(join(sheets, '.testrun'), { recursive: true });
  // a team: a viewer, a tester, and a tester given another workbook only
  writeFileSync(join(sheets, '.testrun', 'app.json'), JSON.stringify({
    user: 'Host',
    team: { enabled: true, people: [
      { id: 'v1', name: 'Meera', role: 'viewer', hash: hashKey(KEYS.viewer) },
      { id: 't1', name: 'Priya', role: 'tester', hash: hashKey(KEYS.tester) },
      { id: 't2', name: 'Rahul', role: 'tester', hash: hashKey(KEYS.outsider), books: ['Bomet UAT.xlsx'] },
    ] },
    ...(keep ? { automation: { keep } } : {}),
  }));
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh' });
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const base = await server.listenOn(0);
  const req = async (method, path, { body, raw, type, key } = {}) => {
    const headers = { 'X-Test-Run': '1' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw !== undefined && type) headers['content-type'] = type;
    const r = await fetch(base + path.replace(/^\//, ''), { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    if (ct.startsWith('application/json')) return { status: r.status, ...JSON.parse(buf.toString('utf8')) };
    return { status: r.status, type: ct, disposition: r.headers.get('content-disposition'), buf };
  };
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { body: { book: BOOK, args } });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const importFile = (suite, name, buf, attach = { book: BOOK, tab: TAB, cycle: 'v2.12' }, extra = {}, key) =>
    req('POST', `/api/automation/import?${q({ suite, name, ...attach, ...extra })}`, { raw: buf, key });
  return { server, base, sheets, req, call, q, importFile, close: () => server.close() };
}

/** The Playwright fixture as an earlier run: its first failing test passed then. */
const earlierPlaywright = () => Buffer.from(fx('playwright-junit.xml').toString('utf8').replace('2026-11-24T04:53:00.000Z', '2026-11-22T12:35:00.000Z').replace(/<failure message="assign[\s\S]*?<\/failure>/, ''));

test('link a suite, import results, read the run view\'s data, download Excel, delete', async () => {
  const s = await start();
  try {
    const empty = await s.req('GET', '/api/automation');
    assert.deepEqual([empty.ok, empty.suites, empty.runs, empty.keep, empty.canAct, empty.isOwner], [true, [], [], 2, true, true]);
    const linked = await s.req('POST', '/api/automation/suites', { body: { name: 'CMS Automation', repo: 'https://github.com/Gurjeet-eGov/CMS-Automation', casePattern: 'CMS/\\d+', masking: 'otp=\\d{6}' } });
    assert.equal(linked.ok, true, linked.error);
    assert.deepEqual([linked.suite.id, linked.suite.repo, linked.created], ['cms-automation', 'Gurjeet-eGov/CMS-Automation', true]);
    assert.equal((await s.req('POST', '/api/automation/suites', { body: { name: 'Bad', casePattern: '(' } })).code, 'BAD_INPUT');
    const id = linked.suite.id;

    // a dry run first: what the file holds, nothing kept
    const pre = await s.req('POST', `/api/automation/preview?suite=${id}&name=results.xml`, { raw: fx('playwright-junit.xml') });
    assert.deepEqual([pre.ok, pre.format, pre.formatLabel, pre.totals.total, pre.totals.failed], [true, 'junit', 'JUnit XML', 5, 2]);
    assert.equal((await s.req('GET', '/api/automation')).runs.length, 0);
    assert.equal((await s.req('POST', `/api/automation/preview?suite=${id}&name=notes.txt`, { raw: Buffer.from('hello') })).code, 'BAD_FORMAT');

    // never without a workbook › test suite › cycle that exists
    assert.equal((await s.req('POST', `/api/automation/import?suite=${id}&name=r.xml`, { raw: fx('robot-xunit.xml') })).code, 'NO_ATTACH');
    assert.equal((await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), { book: BOOK, tab: TAB })).code, 'NO_ATTACH', 'no cycle');
    assert.equal((await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), { book: BOOK, tab: TAB, cycle: 'v9.99' })).code, 'NO_CYCLE');
    assert.equal((await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), { book: BOOK, tab: 'Nope', cycle: 'v2.12' })).ok, false);
    assert.equal((await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), { book: 'Gone.xlsx', tab: TAB, cycle: 'v2.12' })).code, 'NO_BOOK');
    assert.equal((await s.importFile('nope', 'r.xml', fx('robot-xunit.xml'))).code, 'NO_SUITE');
    assert.equal((await s.req('GET', '/api/automation')).runs.length, 0, 'nothing was kept');

    const first = await s.importFile(id, 'results.xml', earlierPlaywright(), undefined, { branch: 'master', env: 'net_two' });
    assert.equal(first.ok, true, first.error);
    const second = await s.importFile(id, 'results.xml', fx('playwright-junit.xml'), undefined, { branch: 'master', env: 'net_two' });
    assert.equal(second.ok, true, second.error);
    assert.deepEqual(second.removed, []);
    assert.deepEqual(second.run.attach, { book: BOOK, tab: TAB, cycle: 'v2.12' });
    assert.equal(second.run.passRate, 50);
    assert.equal(second.run.tests, undefined, 'the summary, not the tests');

    const list = await s.req('GET', '/api/automation');
    assert.deepEqual(list.runs.map((r) => r.id), [second.run.id, first.run.id], 'newest first');
    assert.deepEqual([list.runs[0].prev.id, list.runs[0].prev.passRate], [first.run.id, 75], 'for "↓ from 75%"');
    assert.equal(list.suites[0].format, 'junit');

    const one = await s.req('GET', `/api/automation/run?id=${second.run.id}`);
    assert.equal(one.ok, true);
    assert.equal(one.run.tests.length, 5);
    assert.equal(one.previous.id, first.run.id);
    assert.equal(one.compare.newFailures.length, 1);
    assert.equal(one.compare.stillFailing.length, 1);
    assert.equal(one.causes.length, 2);
    assert.deepEqual(one.history.runs.map((r) => r.id), [first.run.id, second.run.id]);
    const gro = one.run.tests.find((t) => t.title.includes('GRO assigns'));
    assert.deepEqual(one.history.byTest[gro.id], ['pass', 'fail']);
    assert.deepEqual(gro.caseIds, ['CMS/02']);
    assert.deepEqual(one.files.map((f) => f.file).sort(), ['api/search.spec.ts', 'pgr/assign.spec.ts']);
    assert.deepEqual(one.kept.map((m) => m.id), [second.run.id, first.run.id]);
    assert.equal((await s.req('GET', '/api/automation/run?id=20200101-000000-abcdef')).code, 'GONE');

    // Excel, made now
    const x = await s.req('GET', `/api/automation/excel?id=${second.run.id}`);
    assert.equal(x.status, 200);
    assert.equal(x.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(decodeURIComponent(x.disposition), /CMS Automation - .* - results\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Results']);
    const res = wb.getWorksheet('Results');
    assert.deepEqual(res.getRow(1).values.slice(1), ['Suite', 'File', 'Test', 'Tags', 'Case IDs', 'Status', 'Duration (s)', 'Retries', 'Message']);
    assert.equal(res.rowCount, 6);
    const groRow = res.getRows(2, 5).find((r) => String(r.getCell(3).value).includes('GRO assigns'));
    assert.deepEqual([groRow.getCell(2).value, groRow.getCell(5).value, groRow.getCell(6).value, groRow.getCell(7).value], ['pgr/assign.spec.ts', 'CMS/02', 'Failed', 30]);
    const sum = wb.getWorksheet('Summary');
    const rowOf = (k) => sum.getRows(1, sum.rowCount).find((r) => r.getCell(1).value === k);
    assert.equal(rowOf('Failed').getCell(2).value, 2);
    assert.equal(rowOf('Test cycle').getCell(2).value, 'v2.12');
    assert.ok(!existsSync(join(s.sheets, '.testrun', 'automation', 'runs', `${second.run.id}.xlsx`)), 'never kept');

    // delete
    const del = await s.req('POST', '/api/automation/delete', { body: { id: first.run.id } });
    assert.equal(del.ok, true);
    assert.deepEqual(del.kept.map((m) => m.id), [second.run.id]);
    assert.ok(!existsSync(join(s.sheets, '.testrun', 'automation', 'runs', `${first.run.id}.json.gz`)));
    assert.equal((await s.req('GET', `/api/automation/run?id=${first.run.id}`)).code, 'GONE');
    assert.equal((await s.req('POST', '/api/automation/delete', { body: { id: first.run.id } })).code, 'GONE');
  } finally { s.close(); }
});

test('several files in one upload, or a zip, make one run; the third run of a cycle removes the oldest', async () => {
  const s = await start();
  try {
    const id = (await s.req('POST', '/api/automation/suites', { body: { name: 'Notifications API', casePattern: 'NOTIF/\\d+' } })).suite.id;
    const boundary = 'testrunBoundary42';
    const part = (name, buf, type) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), buf, Buffer.from('\r\n')]);
    const body = Buffer.concat([part('robot.xml', fx('robot-xunit.xml'), 'text/xml'), part('ctrf.json', fx('ctrf-report.json'), 'application/json'), Buffer.from(`--${boundary}--\r\n`)]);
    const at = s.q({ book: BOOK, tab: TAB, cycle: 'v2.12' });
    const multi = await s.req('POST', `/api/automation/import?suite=${id}&${at}`, { raw: body, type: `multipart/form-data; boundary=${boundary}` });
    assert.equal(multi.ok, true, multi.error);
    assert.equal(multi.run.totals.total, 9);
    assert.equal(multi.run.source.fileName, '2 files');
    assert.equal(multi.run.source.format, 'mixed');
    assert.deepEqual([multi.run.branch, multi.run.sha, multi.run.env], ['develop', 'c81e09d', 'staging'], 'from the CTRF file when the form leaves them empty');

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('surefire/TEST-LoginTest.xml', fx('surefire.xml'));
    zip.file('cypress/results-1.xml', fx('cypress-junit.xml'));
    const zipped = await s.importFile(id, 'test-results.zip', await zip.generateAsync({ type: 'nodebuffer' }));
    assert.equal(zipped.ok, true, zipped.error);
    assert.equal(zipped.run.totals.total, 7);
    assert.deepEqual(zipped.removed, []);

    // the oldest by when it ran (the Cypress file in the zip ran on 21 Nov), not by when it came in
    assert.ok(zipped.run.startedAt < multi.run.startedAt);
    const third = await s.importFile(id, 'results.xml', fx('playwright-junit.xml'));
    assert.equal(third.ok, true, third.error);
    assert.deepEqual(third.removed.map((m) => m.id), [zipped.run.id], 'the oldest of that suite and cycle');
    assert.deepEqual(third.kept.map((m) => m.id), [third.run.id, multi.run.id]);
    // another cycle is another group
    const elsewhere = await s.importFile(id, 'results.xml', fx('robot-xunit.xml'), { book: BOOK, tab: 'CMS 2.20.1 Features', cycle: 'v2.20' });
    assert.deepEqual(elsewhere.removed, []);
    assert.equal((await s.req('GET', '/api/automation')).runs.length, 3);

    // attach to another cycle
    const moved = await s.req('POST', '/api/automation/reattach', { body: { id: elsewhere.run.id, book: BOOK, tab: TAB, cycle: 'v2.12' } });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(moved.run.attach.tab, TAB);
    assert.deepEqual(moved.removed.map((m) => m.id), [multi.run.id], 'the new cycle\'s oldest makes room (same start; it came in first)');
    assert.equal((await s.req('POST', '/api/automation/reattach', { body: { id: third.run.id, book: BOOK, tab: TAB, cycle: 'v0' } })).code, 'NO_CYCLE');

    // deleting the workbook deletes its runs
    assert.equal((await s.req('POST', '/api/books/delete', { body: { name: BOOK } })).ok, true);
    assert.equal((await s.req('GET', '/api/automation')).runs.length, 0);
  } finally { s.close(); }
});

test('the host\'s keep setting (app.json automation.keep) decides how many runs stay', async () => {
  const s = await start({ keep: 1 });
  try {
    const id = (await s.req('POST', '/api/automation/suites', { body: { name: 'CMS' } })).suite.id;
    const a = await s.importFile(id, 'a.xml', earlierPlaywright());
    const b = await s.importFile(id, 'b.xml', fx('playwright-junit.xml'));
    assert.deepEqual(b.removed.map((m) => m.id), [a.run.id]);
    assert.equal((await s.req('GET', '/api/automation')).keep, 1);
    const old = await s.importFile(id, 'old.xml', earlierPlaywright());
    assert.equal(old.code, 'TOO_OLD', 'older than the one kept: refused, not kept and removed at once');
    const app = JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8'));
    assert.deepEqual(app.automation, { keep: 1, checkEvery: 5 }, 'kept when app.json is saved');
  } finally { s.close(); }
});

test('a viewer reads results but cannot import or change them; without the workbook, a run cannot be seen', async () => {
  const s = await start();
  try {
    const id = (await s.req('POST', '/api/automation/suites', { body: { name: 'CMS Automation', masking: ['s3cr3t-value'] } })).suite.id;
    const run = (await s.importFile(id, 'results.xml', fx('playwright-junit.xml'))).run;

    const v = await s.req('GET', '/api/automation', { key: KEYS.viewer });
    assert.deepEqual([v.ok, v.canAct, v.isOwner, v.runs.length], [true, false, false, 1]);
    assert.deepEqual(v.suites[0].masking, [], 'masking rules (they may name a secret) only for those who can change them');
    assert.equal((await s.req('GET', `/api/automation/run?id=${run.id}`, { key: KEYS.viewer })).ok, true);
    assert.equal((await s.req('GET', `/api/automation/excel?id=${run.id}`, { key: KEYS.viewer })).status, 200, 'and download it');
    const imp = await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), undefined, {}, KEYS.viewer);
    assert.deepEqual([imp.status, imp.code], [403, 'FORBIDDEN']);
    assert.equal((await s.req('POST', `/api/automation/preview?suite=${id}`, { raw: fx('robot-xunit.xml'), key: KEYS.viewer })).status, 403);
    assert.equal((await s.req('POST', '/api/automation/delete', { body: { id: run.id }, key: KEYS.viewer })).status, 403);
    assert.equal((await s.req('POST', '/api/automation/reattach', { body: { id: run.id, book: BOOK, tab: TAB, cycle: 'v2.12' }, key: KEYS.viewer })).status, 403);
    assert.equal((await s.req('POST', '/api/automation/suites', { body: { name: 'Mine' }, key: KEYS.viewer })).status, 403);

    // a tester may import and link (startRuns defaults to on), but only the host unlinks a suite
    const t = await s.req('GET', '/api/automation', { key: KEYS.tester });
    assert.deepEqual([t.canAct, t.suites[0].masking], [true, ['s3cr3t-value']]);
    assert.equal((await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), undefined, {}, KEYS.tester)).ok, true);
    assert.equal((await s.req('POST', '/api/automation/suites/remove', { body: { id }, key: KEYS.tester })).status, 403);

    // given another workbook only: the run and its targets are not there for them
    const o = await s.req('GET', '/api/automation', { key: KEYS.outsider });
    assert.deepEqual([o.ok, o.runs.length, o.suites.length], [true, 0, 1]);
    assert.equal((await s.req('GET', `/api/automation/run?id=${run.id}`, { key: KEYS.outsider })).code, 'GONE');
    assert.equal((await s.req('GET', `/api/automation/excel?id=${run.id}`, { key: KEYS.outsider })).code, 'GONE');
    assert.equal((await s.req('GET', `/api/automation/targets?book=${encodeURIComponent(BOOK)}`, { key: KEYS.outsider })).status, 403);
    assert.equal((await s.importFile(id, 'r.xml', fx('robot-xunit.xml'), undefined, {}, KEYS.outsider)).code, 'FORBIDDEN');
    assert.equal((await s.req('POST', '/api/automation/delete', { body: { id: run.id }, key: KEYS.outsider })).code, 'GONE');

    // the attach pickers: a workbook's test suites and their cycles
    const tg = await s.req('GET', `/api/automation/targets?book=${encodeURIComponent(BOOK)}`, { key: KEYS.tester });
    const tab = tg.tabs.find((x) => x.name === TAB);
    assert.deepEqual([tab.cycles, tab.current], [['v2.12'], 'v2.12']);

    // the host unlinks the suite: its runs go too
    const rm = await s.req('POST', '/api/automation/suites/remove', { body: { id } });
    assert.deepEqual([rm.ok, rm.runs], [true, 2]);
    assert.deepEqual((await s.req('GET', '/api/automation')).runs, []);
  } finally { s.close(); }
});

test('an upload over 20 MB is refused with 413', async () => {
  const s = await start();
  try {
    const id = (await s.req('POST', '/api/automation/suites', { body: { name: 'CMS' } })).suite.id;
    const big = Buffer.alloc(21 * 1024 * 1024, 32);
    const r = await s.req('POST', `/api/automation/preview?suite=${id}&name=big.xml`, { raw: big });
    assert.deepEqual([r.status, r.code], [413, 'TOO_BIG']);
  } finally { s.close(); }
});
