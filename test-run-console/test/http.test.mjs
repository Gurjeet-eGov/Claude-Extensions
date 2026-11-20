// The local server over HTTP: guards, workbooks, notes from Bug Reporter,
// exports. Uses a temporary sheets folder. Team access is in team.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { XBook } from '../lib/xlsx-book.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { extensionIdFromKey } from '../../bug-reporter/host/lib/extension-id.mjs';
import { makeFakeGh } from '../dev/fake-tools.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const EXT_ORIGIN = `chrome-extension://${extensionIdFromKey(JSON.parse(readFileSync(new URL('../../bug-reporter/extension/manifest.json', import.meta.url), 'utf8')).key)}`;

async function start({ ghPath = '/nope/gh' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-http-'));
  const sheets = join(dir, 'sheets');
  const server = createServer({ sheetsDir: sheets, ghPath }); // never the real gh in tests
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const base = await server.listenOn(0);
  const req = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path.replace(/^\//, ''), {
      method,
      headers: { 'X-Test-Run': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, text }; }
  };
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { book: BOOK, args });
  const disk = async (tab = TAB) => (await XBook.fromFile(join(sheets, BOOK), 'x')).getSheetByName(tab).getDataRange().getDisplayValues();
  // Setup as detected.
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  await call('api_loadTab', TAB, '');
  return { server, base, sheets, req, call, disk, close: () => server.close() };
}

test('only this computer, this console and Bug Reporter may call it', async () => {
  const s = await start();
  try {
    assert.equal((await s.req('GET', '/api/status', undefined, { 'X-Test-Run': '' })).code, 'FORBIDDEN', 'no custom header: refused');
    assert.equal((await s.req('GET', '/api/status', undefined, { Origin: 'https://evil.example' })).code, 'FORBIDDEN', 'other websites: refused');
    assert.equal((await s.req('GET', '/api/status', undefined, { Origin: EXT_ORIGIN })).ok, true, 'Bug Reporter: allowed');
    const asHost = (path, host) => new Promise((resolve, reject) => {
      const u = new URL(s.base);
      http.get({ host: '127.0.0.1', port: u.port, path, headers: { 'X-Test-Run': '1', Host: host.replace('PORT', u.port) } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      }).on('error', reject);
    });
    const rebound = await asHost('/api/app', 'evil.example:PORT');
    assert.deepEqual([rebound.status, rebound.body.code], [401, 'AUTH'], 'another host name (DNS rebinding, a tunnel) needs an invite key');
    assert.equal((await asHost('/api/status', 'evil.example:PORT')).body.auth, 'required', 'and is only told that');
    assert.equal((await s.req('POST', '/api/call/eval', {})).code, 'NO_FUNCTION');
    const page = await fetch(s.base);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  } finally { s.close(); }
});

test('marking writes the .xlsx on disk, with a backup and no temp files', async () => {
  const s = await start();
  try {
    const d = await s.call('api_loadTab', TAB, '');
    const c = d.cases.find((x) => x.id === 'CMS/04');
    const r = await s.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    assert.equal(r.ok, true, r.error);
    assert.equal((await s.disk())[c.row - 1][7], 'Pass');
    assert.equal(readdirSync(join(s.sheets, '.testrun', 'backups')).length, 1);
    assert.deepEqual(readdirSync(s.sheets).filter((f) => f.endsWith('.tmp')), []);
    const status = await s.req('GET', '/api/status');
    assert.deepEqual([status.book, status.tab, status.cycle], [BOOK, TAB, 'v2.12']);
  } finally { s.close(); }
});

test('suites: every test case tab of every workbook, for Bug Reporter to choose from', async () => {
  const s = await start();
  try {
    writeFileSync(join(s.sheets, 'Bomet.xlsx'), await buildSampleXlsx());
    const r = await s.req('GET', '/api/suites', undefined, { Origin: EXT_ORIGIN });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.suites.map((x) => x.book), ['Bomet.xlsx', BOOK]);
    assert.deepEqual(r.suites.find((x) => x.book === BOOK).tabs, ['CMS 2.20.1', 'CMS 2.20.1 Features', 'Dashboard KPI']);
    assert.deepEqual(r.current, { book: BOOK, tab: TAB });
  } finally { s.close(); }
});

test('a note from Bug Reporter becomes a finding in the current tab', async () => {
  const s = await start();
  try {
    const r = await s.req('POST', '/api/note-bug', {
      title: 'Citizen cannot reopen a complaint resolved 4 days ago', number: 77, url: 'https://github.com/example/repo/issues/77',
      description: 'Reopen button missing', actual: 'No button', expected: 'Reopen offered', extra: 'tenant ke', module: 'Citizen', pageUrl: 'https://env.example/citizen',
    }, { Origin: EXT_ORIGIN });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.key, r.book, r.tab], ['F-001', BOOK, TAB]);
    const f = (await s.call('api_listFindings')).findings[0];
    assert.equal(f.source, 'bug-reporter');
    assert.equal(f.issue, '#77');
    assert.equal(f.url, 'https://github.com/example/repo/issues/77');
    assert.equal(f.area, 'Citizen');
    assert.match(f.details, /Actual: No button\nExpected: Reopen offered/);
    assert.equal((await s.req('POST', '/api/note-bug', { title: '' })).code, 'BAD_INPUT');
    const other = await s.req('POST', '/api/note-bug', { title: 'Sign-up link expires too soon', book: BOOK, tab: 'CMS 2.20.1 Features' }, { Origin: EXT_ORIGIN });
    assert.deepEqual([other.ok, other.tab], [true, 'CMS 2.20.1 Features'], 'the suite picked in Bug Reporter');
    const unknown = await s.req('POST', '/api/note-bug', { title: 'y', book: 'Nope.xlsx', tab: 'Nope' });
    assert.deepEqual([unknown.book, unknown.tab], [BOOK, TAB], 'an unknown suite falls back to the one open in Test Run');
    const bad = await s.req('POST', '/api/note-bug', { title: 'x', url: 'javascript:alert(1)' });
    assert.equal((await s.call('api_listFindings')).findings.find((x) => x.key === bad.key).url, '', 'only https links are kept');
  } finally { s.close(); }
});

test('a bug filed against a test case marks it failed with the bug linked (no finding)', async () => {
  const s = await start();
  try {
    const url = 'https://github.com/example/repo/issues/78';
    const r = await s.req('POST', '/api/note-bug', { title: 'Assign button does nothing', number: 78, url, priority: 'P1', book: BOOK, tab: TAB, caseKey: 'CMS/12' }, { Origin: EXT_ORIGIN });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.kind, r.key, r.status, r.previous, r.cycle, r.tab], ['case', 'CMS/12', 'Fail', '', 'v2.12', TAB]);
    const row = (await s.disk()).find((x) => x[0] === 'CMS/12');
    assert.deepEqual(row.slice(7), ['Fail', 'Bug #78: Assign button does nothing', '#78'], 'status, comment, and a new Linked issue column');
    const disk = await XBook.fromFile(join(s.sheets, BOOK), 'x');
    const r12 = disk.getSheetByName(TAB).getDataRange().getDisplayValues().findIndex((x) => x[0] === 'CMS/12') + 1;
    assert.equal(disk.getSheetByName(TAB).getRange(r12, 10).getLinkUrls()[0][0], url, 'the cell links to the bug');
    assert.equal((await s.call('api_listFindings')).findings.length, 0, 'no finding: the case already covers it');
    const issue = (await s.call('api_listIssues')).issues.find((i) => i.url === url);
    assert.deepEqual([issue.title, issue.priority, issue.source], ['Assign button does nothing', 'P1', 'bug-reporter']);
    assert.equal((await s.req('POST', '/api/note-bug', { title: 'x', caseKey: 'CMS/12', book: BOOK, tab: TAB })).code, 'BAD_INPUT', 'a case link needs the bug link');
    assert.equal((await s.req('POST', '/api/note-bug', { title: 'x', url, caseKey: 'CMS/99', book: BOOK, tab: TAB })).code, 'NO_CASE');
  } finally { s.close(); }
});

test('a bug noted as a finding (no test case) is an open failure in its suite\'s Summary', async () => {
  const s = await start();
  try {
    const url = 'https://github.com/example/repo/issues/66';
    const r = await s.req('POST', '/api/note-bug', { title: 'Employee redirected to citizen login after password update', number: 66, url, book: BOOK, tab: TAB }, { Origin: EXT_ORIGIN });
    assert.equal(r.kind, 'finding', r.error);
    await s.call('api_saveFinding', { text: 'Something odd, no issue yet', tab: TAB }); // no issue link: not a failure
    const sum = (await s.call('api_summary', TAB, '')).summary;
    const f = sum.failures.find((x) => x.id === r.key);
    assert.ok(f, JSON.stringify(sum.failures.map((x) => x.id)));
    assert.deepEqual([f.scenario, f.issue, f.comment, f.finding], ['Employee redirected to citizen login after password update', '#66', '', true]);
    assert.equal(f.issues[0].url, url);
    assert.equal(sum.failures.some((x) => /Something odd/.test(x.scenario)), false);
    const other = (await s.call('api_summary', 'CMS 2.20.1 Features', '')).summary;
    assert.equal(other.failures.some((x) => x.id === r.key), false, 'only in its own suite');
    await s.call('api_setFindingState', r.key, 'covered', 'CMS/12');
    assert.equal((await s.call('api_summary', TAB, '')).summary.failures.some((x) => x.id === r.key), false, 'not once it is done');
  } finally { s.close(); }
});

test('a bug finding mapped to a test case (covered by it, or written up as it) fails that case with the issue linked', async () => {
  const s = await start();
  try {
    const note = (n) => s.req('POST', '/api/note-bug', { title: `Login lands on the wrong realm ${n}`, number: n, url: `https://github.com/example/repo/issues/${n}`, book: BOOK, tab: TAB }, { Origin: EXT_ORIGIN });
    const row = (rows, id) => rows.find((r) => r[0] === id);
    // Covered by CMS/12
    const a = await note(68);
    assert.equal(a.kind, 'finding', a.error);
    const cov = await s.call('api_setFindingState', a.key, 'covered', 'CMS/12');
    assert.equal(cov.ok, true, cov.error);
    assert.deepEqual([cov.linked.status, cov.linked.previous, cov.linked.cycle], ['Fail', '', 'v2.12']);
    let disk = await s.disk();
    const h = disk[0];
    const r12 = row(disk, 'CMS/12');
    assert.equal(r12[h.indexOf('Test Status / v2.12')], 'Fail');
    assert.equal(r12[h.indexOf('Comment / v2.12')], 'Bug #68: Login lands on the wrong realm 68');
    assert.equal(r12[h.indexOf('Linked issue')], '#68');
    const sum = (await s.call('api_summary', TAB, 'v2.12')).summary;
    assert.equal(sum.failures.find((x) => x.id === 'CMS/12').issues[0].ref, '#68', 'in Open failures, with its issue');
    assert.equal(sum.failures.some((x) => x.id === a.key), false, 'the finding itself is done');
    assert.equal((await s.call('api_setFindingState', a.key, 'covered', 'CMS/12')).linked, null, 'covering again changes nothing');
    disk = await s.disk();
    assert.equal(row(disk, 'CMS/12')[h.indexOf('Linked issue')], '#68', 'not linked twice');
    // Written up as a new test case
    const b = await note(69);
    const up = await s.call('api_addCases', TAB, [{ scenario: 'Login after a password update stays on the right realm', issue: 'https://github.com/example/repo/issues/69', fromFinding: b.key }], 'v2.12');
    assert.equal(up.ok, true, up.error);
    assert.equal(up.added[0].linked.status, 'Fail');
    disk = await s.disk();
    const nr = row(disk, up.added[0].id);
    assert.deepEqual([nr[h.indexOf('Test Status / v2.12')], nr[h.indexOf('Linked issue')]], ['Fail', '#69']);
    assert.equal((await s.call('api_listFindings')).findings.find((x) => x.key === b.key).state, 'written');
    // A finding with no issue link: covering only marks it done
    await s.call('api_saveFinding', { text: 'An odd thing, no issue', tab: TAB });
    const plain = (await s.call('api_listFindings')).findings.find((x) => x.text === 'An odd thing, no issue');
    assert.equal((await s.call('api_setFindingState', plain.key, 'covered', 'CMS/04')).linked, null);
    assert.equal(row(await s.disk(), 'CMS/04')[h.indexOf('Test Status / v2.12')], '');
  } finally { s.close(); }
});

test('suite cases: one suite\'s test cases for Bug Reporter to pick from, without changing what the owner has open', async () => {
  const s = await start();
  try {
    const r = await s.req('GET', `/api/suite-cases?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent('CMS 2.20.1 Features')}`, undefined, { Origin: EXT_ORIGIN });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.tab, 'CMS 2.20.1 Features');
    assert.ok(r.cases.length > 0);
    assert.deepEqual(Object.keys(r.cases[0]).sort(), ['group1', 'group2', 'id', 'key', 'scenario', 'status', 'testType']);
    assert.equal(r.fields.scenario >= 0, true, 'with the suite\'s columns, for a new-case form');
    assert.ok(Array.isArray(r.statusOptions));
    assert.equal((await s.req('GET', '/api/app')).last.tab, TAB, 'the console keeps its tab');
    const main = await s.req('GET', `/api/suite-cases?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}`);
    const c5 = main.cases.find((c) => c.id === 'CMS/05');
    assert.deepEqual([c5.key, c5.status, c5.group2], ['CMS/05', 'Fail', 'Complaint Details']);
    assert.equal(main.hasComment, true);
    assert.equal(main.cycle, 'v2.12');
    assert.equal((await s.req('GET', `/api/suite-cases?book=${encodeURIComponent(BOOK)}&tab=Nope`)).code, 'NO_TAB');
  } finally { s.close(); }
});

test('known issues over HTTP: GitHub fills in titles, states and priorities; the download gets a Known issues sheet', async () => {
  const url = 'https://github.com/example/repo/issues/812';
  const tools = mkdtempSync(join(tmpdir(), 'testrun-gh-'));
  const gh = makeFakeGh(tools, { issues: { [url]: { title: 'Assign fails for GRO', state: 'OPEN', labels: ['bug'], priority: 'P1' } } });
  const s = await start({ ghPath: gh.bin });
  try {
    const c = (await s.call('api_loadTab', TAB, '')).cases.find((x) => x.id === 'CMS/04');
    const m = await s.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Fail', issue: url });
    assert.equal(m.ok, true, m.error);
    const first = await s.req('GET', `/api/issues?book=${encodeURIComponent(BOOK)}`);
    assert.deepEqual([first.ok, first.github, first.fetching], [true, true, true]);
    let got = null;
    for (let i = 0; i < 100 && !got; i++) {
      const r = await s.req('GET', `/api/issues?book=${encodeURIComponent(BOOK)}`);
      got = r.issues.find((e) => e.url === url && e.title);
      if (!got) await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(got, 'the title arrives');
    assert.deepEqual([got.title, got.state, got.priority, got.cases.map((x) => x.id)], ['Assign fails for GRO', 'open', 'P1', ['CMS/04', 'CMS/002']]);
    const asked = readFileSync(gh.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(asked[0], { graphql: url, withProject: true }, 'one GraphQL query, with the project board for the priority');
    // Typed priority stays when GitHub has none; a refresh asks again
    await s.call('api_saveIssueMeta', [{ key: url, priority: 'P0' }]);
    const ref = await s.req('POST', '/api/issues/refresh', { book: BOOK });
    assert.equal(ref.fetching, true);

    const dl = await fetch(`${s.base}api/books/download?name=${encodeURIComponent(BOOK)}`, { headers: { 'X-Test-Run': '1' } });
    const book = await XBook.fromBuffer(Buffer.from(await dl.arrayBuffer()), 'dl');
    const ki = book.getSheetByName('Known issues');
    assert.ok(ki, 'the download has a Known issues sheet');
    assert.deepEqual([ki.getRange(5, 1).getValue(), ki.getRange(5, 1).getLinkUrls()[0][0]], ['#812', url]);
    assert.equal((await XBook.fromFile(join(s.sheets, BOOK), 'x')).getSheetByName('Known issues'), null, 'the file itself is not changed');
    const sheetCell = book.getSheetByName(TAB).getDataRange().getDisplayValues().find((x) => x[0] === 'CMS/04');
    assert.equal(sheetCell[9], '#812', 'the case shows the short reference');
  } finally { s.close(); }
});

test('import, switch and download workbooks', async () => {
  const s = await start();
  try {
    const bytes = await buildSampleXlsx();
    let r = await fetch(`${s.base}api/books/import?name=${encodeURIComponent('Bomet.xlsx')}`, { method: 'POST', headers: { 'X-Test-Run': '1' }, body: bytes }).then((x) => x.json());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.books.map((b) => b.name), ['Bomet.xlsx', BOOK]);
    r = await fetch(`${s.base}api/books/import?name=x.xlsx`, { method: 'POST', headers: { 'X-Test-Run': '1' }, body: Buffer.from('not a workbook') }).then((x) => x.json());
    assert.equal(r.ok, false);
    const sel = await s.req('POST', '/api/books/select', { name: BOOK });
    assert.equal(sel.last.book, BOOK);
    const dl = await fetch(`${s.base}api/books/download?name=${encodeURIComponent(BOOK)}`, { headers: { 'X-Test-Run': '1' } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    const got = await XBook.fromBuffer(Buffer.from(await dl.arrayBuffer()), 'dl');
    const rowOf = (book, id) => book.getSheetByName(TAB).getDataRange().getDisplayValues().findIndex((x) => x[0] === id) + 1;
    const dlRow = got.getSheetByName(TAB).ws.getRow(rowOf(got, 'CMS/02'));
    assert.ok(dlRow.height > 30, `rows with wrapped text are tall enough in the download (got ${dlRow.height})`);
    const onDisk = await XBook.fromFile(join(s.sheets, BOOK), 'x');
    assert.equal(onDisk.getSheetByName(TAB).ws.getRow(rowOf(onDisk, 'CMS/02')).height, undefined, 'downloading does not write the file');
    const bad = await fetch(`${s.base}api/books/download?name=${encodeURIComponent('../x.xlsx')}`, { headers: { 'X-Test-Run': '1' } }).then((x) => x.json());
    assert.equal(bad.ok, false, 'no path tricks');
  } finally { s.close(); }
});

test('delete a workbook: its file and Test Run data go, daily backups stay', async () => {
  const s = await start();
  try {
    await s.call('api_saveFinding', { text: 'Something odd' });
    const d = await s.call('api_loadTab', TAB, '');
    const c = d.cases.find((x) => x.id === 'CMS/04');
    assert.equal((await s.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' })).ok, true);
    const side = join(s.sheets, '.testrun', BOOK.replace(/\.xlsx$/, '.json'));
    assert.equal(existsSync(side), true, 'the workbook has Test Run data beside it');
    const r = await s.req('POST', '/api/books/delete', { name: BOOK });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.deleted, r.books, r.last.book], [BOOK, [], '']);
    assert.equal(existsSync(join(s.sheets, BOOK)), false, 'the file is gone');
    assert.equal(existsSync(side), false, 'so is its setup, findings and issue list');
    assert.ok(readdirSync(join(s.sheets, '.testrun', 'backups')).some((f) => f.startsWith('CMS Sign Off (sample) ')), 'the daily backup stays');
    assert.equal((await s.req('POST', '/api/books/delete', { name: BOOK })).code, 'NO_BOOK');
    assert.equal((await s.req('POST', '/api/books/delete', { name: '../x.xlsx' })).ok, false, 'no path tricks');
  } finally { s.close(); }
});

test('Add issue: linking a case without marking it failed leaves its result alone', async () => {
  const s = await start();
  try {
    const url = 'https://github.com/example/repo/issues/91';
    const r = await s.call('api_linkBug', { tab: TAB, key: 'CMS/12', url, title: 'Logged on GitHub', priority: 'P2', markFailed: false, source: 'manual' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.status, r.previous], ['', '']);
    const row = (await s.disk()).find((x) => x[0] === 'CMS/12');
    assert.deepEqual(row.slice(7), ['', '', '#91'], 'no status, no comment line; only the Linked issue');
    const issue = (await s.call('api_listIssues')).issues.find((i) => i.url === url);
    assert.deepEqual([issue.title, issue.priority, issue.source], ['Logged on GitHub', 'P2', 'manual']);
    // Without a case: a finding, whose issue keeps no made-up title (GitHub fills it in)
    const f = await s.call('api_saveFinding', { text: 'Issue example/repo/issues/92', issueTitle: '', url: 'https://github.com/example/repo/issues/92', tab: TAB, source: 'manual' });
    assert.equal(f.ok, true, f.error);
    const i2 = (await s.call('api_listIssues')).issues.find((i) => i.url.endsWith('/92'));
    assert.deepEqual([i2.title, i2.findings.map((x) => x.key)], ['', [f.finding.key]]);
  } finally { s.close(); }
});

test('the downloaded workbook leaves out retired cases; the one in sheets/ keeps them', async () => {
  const s = await start();
  try {
    const d = await s.call('api_loadTab', TAB, '');
    const base = (id) => { const c = d.cases.find((x) => x.id === id); return { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12' }; };
    const url = 'https://github.com/example/repo/issues/55';
    for (const id of ['CMS/08', 'CMS/09']) assert.equal((await s.call('api_linkBug', { tab: TAB, key: id, url, markFailed: false })).ok, true);
    // CMS/08 holds the Sub feature "Workflow" that CMS/09 to CMS/11 fill down from; CMS/04 fills down itself
    for (const id of ['CMS/08', 'CMS/04']) assert.equal((await s.call('api_retireCase', { ...base(id), kind: 'deprecated', reason: 'Gone' })).ok, true);
    assert.equal((await s.call('api_writeSummaryTab', TAB, 'v2.12')).ok, true);
    // A summary tab written by an earlier version, with a Retired cases section before the comparison
    const old = await XBook.fromFile(join(s.sheets, BOOK), 'x');
    const sum = old.getSheetByName('Test Run Summary');
    const last = sum.getLastRow();
    sum.getRange(last + 1, 1, 6, 4).setValues([['', '', '', ''], ['Retired cases, not counted above (1)', '', '', ''], ['ID', 'Scenario', 'Why', 'Retired in'], ['CMS/08', 'Assign', 'Deprecated: Gone', 'v2.12'], ['', '', '', ''], ['Compared with v2.11', '', '', '']]);
    writeFileSync(join(s.sheets, BOOK), Buffer.from(await old.toBuffer()));

    const dl = await fetch(`${s.base}api/books/download?name=${encodeURIComponent(BOOK)}`, { headers: { 'X-Test-Run': '1' } });
    assert.equal(dl.status, 200);
    const got = await XBook.fromBuffer(Buffer.from(await dl.arrayBuffer()), 'dl');
    const rows = got.getSheetByName(TAB).getDataRange().getDisplayValues();
    const ids = rows.map((r) => r[0]);
    assert.equal(ids.includes('CMS/08') || ids.includes('CMS/04'), false, 'no retired rows');
    assert.ok(ids.includes('CMS/09') && ids.includes('CMS/05'));
    assert.equal(rows.find((r) => r[0] === 'CMS/09')[2], 'Workflow', 'the Sub feature it filled down from the removed row is written in');
    assert.equal(rows.find((r) => r[0] === 'CMS/10')[2], '', 'the rows below still fill down from it');
    const issues = got.getSheetByName('Known issues').getDataRange().getDisplayValues();
    const issueRow = issues.find((r) => r[0] === '#55');
    assert.match(issueRow[4], /CMS\/09/);
    assert.doesNotMatch(issueRow[4], /CMS\/08|retired/i, 'the issue keeps its other cases; the retired one is not named');
    const summary = got.getSheetByName('Test Run Summary').getDataRange().getDisplayValues().map((r) => r[0]);
    assert.equal(summary.some((x) => /^Retired cases/.test(x) || x === 'CMS/08'), false, 'the old Retired cases section is gone');
    assert.ok(summary.includes('Compared with v2.11'), 'what came after it stays');

    const kept = (await s.disk()).map((r) => r[0]);
    assert.ok(kept.includes('CMS/08') && kept.includes('CMS/04'), 'the workbook in sheets/ keeps them, so they can be restored');
  } finally { s.close(); }
});

test('export summary writes one standalone HTML file', async () => {
  const s = await start();
  try {
    const r = await s.req('POST', '/api/export-summary', { book: BOOK, tab: TAB, cycle: 'v2.12' });
    assert.equal(r.ok, true, r.error);
    assert.ok(existsSync(r.file), 'a copy stays on the laptop');
    assert.match(r.name, /\.html$/);
    const html = r.html;
    assert.equal(readFileSync(r.file, 'utf8'), html);
    assert.match(html, /<style>:root/);
    assert.match(html, /Open failures/);
    assert.doesNotMatch(html, /<script/);

  } finally { s.close(); }
});

test('rename a test cycle: both its column headers; results, evidence and the current cycle follow', async () => {
  const s = await start();
  try {
    const d = await s.call('api_loadTab', TAB, 'v2.12');
    const c = d.cases.find((x) => x.id === 'CMS/04');
    assert.equal((await s.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' })).ok, true);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
    const up = await fetch(`${s.base}api/evidence?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12&key=CMS%2F04`, { method: 'POST', headers: { 'X-Test-Run': '1' }, body: png }).then((x) => x.json());
    assert.equal(up.ok, true, up.error);
    await s.call('api_setTabPrefs', TAB, { cycle: 'v2.12' });

    const r = await s.call('api_renameCycle', TAB, 'Test Status / v2.12', 'v2.13');
    assert.deepEqual([r.ok, r.from, r.to], [true, 'v2.12', 'v2.13'], r.error);
    const head = (await s.disk())[0];
    assert.ok(head.includes('Test Status / v2.13') && head.includes('Comment / v2.13'), head.join(' | '));
    assert.equal(head.includes('Test Status / v2.12'), false);
    const after = await s.call('api_loadTab', TAB, '');
    assert.equal(after.cycles[after.cycleIdx].label, 'v2.13', 'it is still the current cycle');
    assert.equal(after.cases.find((x) => x.id === 'CMS/04').statuses[after.cycleIdx], 'Pass', 'results stay');
    const ext = await s.req('GET', `/api/ext/suite?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.13`);
    assert.equal(ext.cases.find((x) => x.id === 'CMS/04').evidence.photo.name, up.added.name, 'its evidence follows');

    assert.equal((await s.call('api_startCycle', TAB, 'v2.20')).ok, true);
    assert.equal((await s.call('api_renameCycle', TAB, 'Test Status / v2.13', 'V2.20')).code, 'EXISTS', 'not the name of another cycle');
    assert.equal((await s.call('api_renameCycle', TAB, 'Test Status / v2.13', '  ')).code, 'BAD_INPUT');
    assert.equal((await s.call('api_renameCycle', TAB, 'Test Status / v9', 'x1')).code, 'NO_CYCLE');
    const words = await s.call('api_renameCycle', TAB, 'Test Status / v2.13', 'Sprint A');
    assert.equal(words.ok, true, words.error);
    assert.ok((await s.disk())[0].includes('Test Status / Sprint A'), 'a name without a digit still reads as a cycle');
  } finally { s.close(); }
});

test('settings: your name is kept per computer and fills Tested by', async () => {
  const s = await start();
  try {
    const r = await s.req('POST', '/api/app', { user: 'Tester One' });
    assert.equal(r.settings.user, 'Tester One');
    assert.deepEqual(r.me, { name: 'Tester One', role: 'owner', local: true, admin: false });
    const d = await s.call('api_loadTab', TAB, '');
    const c = d.cases.find((x) => x.id === 'CMS/09');
    await s.call('api_addColumns', TAB, ['testedBy']);
    const m = await s.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    assert.equal(m.testedBy, 'Tester One');
    assert.ok(JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8')).user === 'Tester One');
  } finally { s.close(); }
});
