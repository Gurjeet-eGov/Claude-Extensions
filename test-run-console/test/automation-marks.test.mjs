// Automated results in the manual suite: importing a run writes each named case's result into the
// cycle's "Automation <cycle>" column, and its Status, Tested by and Tested on when nobody has marked
// it; a newer run updates what automation wrote (not what a tester changed); deleting or moving a run
// takes back what it wrote, where nothing changed since.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { hashKey, newKey } from '../lib/team.mjs';
import { automatedItems, AUTO_TEXT_MAX } from '../lib/automation/summary.mjs';
import { loadCore, plain } from '../lib/runtime.mjs';

const { TRCore } = loadCore();
const detectColumns = (h) => plain(TRCore.detectColumns(h));
const detectCycles = (h) => plain(TRCore.detectCycles(h));

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const TESTER = newKey();
const p2 = (n) => String(n).padStart(2, '0');
const local = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

// ------------------------------------------------------------------ the text each case gets

test('the Automation text: file names, failures first with their first error line, skips with a reason, cut at 250', () => {
  const t = (status, file, message, ids, title = 'a test') => ({ status, file, message, caseIds: ids, title });
  const items = automatedItems({ tests: [
    t('pass', 'tests/smoke/auth.spec.ts', '', ['CMS/01']),
    t('fail', 'tests/pgr/create.spec.ts', 'expect(locator).toBeVisible() failed\n  at create.spec.ts:12', ['CMS/02']),
    t('other', 'tests/pgr/sms.spec.ts', 'No SMS gateway', ['CMS/03']),
    t('other', 'tests/pgr/quiet.spec.ts', '', ['cms/04']),
    t('pass', 'tests/a/one.spec.ts', '', ['CMS/05']),
    t('fail', 'tests/a/two.spec.ts', 'Timed out', ['CMS/05']),
    t('pass', 'tests/a/one.spec.ts', '', ['CMS/05']), // same file again: listed once
    t('pass', '', '', ['CMS/06'], 'login returns token'),
    t('fail', 'x.spec.ts', 'boom '.repeat(80), ['CMS/07']),
  ] });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by['CMS/01'], { id: 'CMS/01', result: 'pass', text: 'auth.spec.ts' });
  assert.deepEqual(by['CMS/02'], { id: 'CMS/02', result: 'fail', text: 'create.spec.ts: expect(locator).toBeVisible() failed' });
  assert.deepEqual(by['CMS/03'], { id: 'CMS/03', result: 'other', text: 'sms.spec.ts: No SMS gateway' });
  assert.deepEqual(by['CMS/04'], { id: 'CMS/04', result: 'other', text: 'quiet.spec.ts' }, 'IDs are matched in upper case');
  assert.deepEqual(by['CMS/05'], { id: 'CMS/05', result: 'fail', text: 'two.spec.ts: Timed out, one.spec.ts' }, 'the worst result decides; failing tests first');
  assert.equal(by['CMS/06'].text, 'login returns token', 'no file: the test title');
  assert.equal(by['CMS/07'].text.length, AUTO_TEXT_MAX);
  assert.ok(by['CMS/07'].text.endsWith('…'));
  assert.deepEqual(automatedItems({ tests: [t('pass', 'a.spec.ts', '', [])] }), [], 'no case IDs: nothing to write');
});

// ------------------------------------------------------------------ the column

test('the Automation column pairs with its cycle by name; other "Automation…" headers are left alone', () => {
  const det = detectColumns(['S .No', 'Scenario', 'Automated by', 'Test Status / v2.12', 'Comment / v2.12', 'Automation v2.12', 'Test Status / v2.13', 'Comment / v2.13', 'Automation / v2.13', 'Automation Status']);
  assert.deepEqual(det.cycles.map((c) => [c.label, c.status, c.comment, c.auto]), [['v2.12', 3, 4, 5], ['v2.13', 6, 7, 8]]);
  assert.equal(det.fields.automatedBy, 2, '"Automated by" is still its own column');
  assert.ok(det.extras.includes(9), '"Automation Status" names no cycle: an ordinary column');
  assert.ok(!det.extras.includes(5) && !det.extras.includes(8), 'the Automation columns belong to their cycles');
  const wrapped = detectCycles(['Test Status\nv2.20', 'Comment\nv2.20', 'Automation\nv2.20']);
  assert.equal(wrapped[0].auto, 2, 'the name on its own line');
  const bare = detectCycles(['Status', 'Notes', 'Automation Comments']);
  assert.equal(bare[0].auto, 2, 'a cycle without a name: "Automation Comments"');
  assert.equal(detectCycles(['Test Status / v2.12', 'Comment / v2.12'])[0].auto, undefined, 'none yet');
  assert.equal(TRCore.autoHeader('v2.12'), 'Automation v2.12');
  assert.equal(TRCore.autoHeader(''), 'Automation Comments');
});

// ------------------------------------------------------------------ over HTTP, in the sample workbook

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-marks-'));
  const sheets = join(dir, 'sheets');
  mkdirSync(join(sheets, '.testrun'), { recursive: true });
  writeFileSync(join(sheets, '.testrun', 'app.json'), JSON.stringify({
    user: 'Host',
    team: { enabled: true, people: [{ id: 't1', name: 'Priya', role: 'tester', hash: hashKey(TESTER) }] },
  }));
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh' });
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const base = await server.listenOn(0);
  const req = async (method, path, { body, raw, key } = {}) => {
    const headers = { 'X-Test-Run': '1' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined || raw !== undefined) headers['content-type'] = raw !== undefined ? 'application/octet-stream' : 'application/json';
    const r = await fetch(base + path.replace(/^\//, ''), { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { body: { book: BOOK, args } });
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const importFile = (suite, buf, attach = { book: BOOK, tab: TAB, cycle: 'v2.12' }, key = TESTER) =>
    req('POST', `/api/automation/import?${q({ suite, name: 'results.xml', ...attach })}`, { raw: buf, key });
  const tab = async (cycle = 'v2.12') => {
    const m = await call('api_loadTab', TAB, cycle);
    const ci = m.cycleIdx;
    const byId = Object.fromEntries(m.cases.map((c) => [c.id, { status: c.statuses[ci], comment: c.comments[ci], auto: c.autoComments[ci], by: c.testedBy, on: c.testedOn }]));
    return { m, byId };
  };
  return { server, req, call, importFile, tab, close: () => server.close() };
}

const junit = (stamp, cases) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="playwright"><testsuite name="pgr" timestamp="${stamp}" tests="${cases.length}">
${cases.map(([title, file, kind, msg]) => `<testcase name="${title}" classname="${file}" file="${file}" time="1">${kind === 'fail' ? `<failure message="${msg}">${msg}</failure>` : kind === 'skip' ? `<skipped message="${msg || ''}"/>` : ''}</testcase>`).join('\n')}
</testsuite></testsuites>`);

test('importing fills in unmarked cases and the Automation column; a newer run updates only what automation wrote; delete and move take it back', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('api_addColumns', TAB, ['testedBy', 'testedOn'])).ok, true);
    const linked = await s.req('POST', '/api/automation/suites', { body: { name: 'CMS Automation', casePattern: 'CMS/\\d+' } });
    const id = linked.suite.id;
    const before = await s.tab();
    assert.equal(before.byId['CMS/01'].status, 'Pass', 'CMS/01 was marked by a tester');
    assert.equal(before.m.cycles[0].hasAuto, undefined);

    // run 1: CMS/04 passes, CMS/08 fails, CMS/09 is skipped, CMS/12 has a passing and a failing test,
    // and CMS/01 (a tester marked it Pass) fails
    const stamp1 = '2026-11-20T05:30:00Z';
    const r1 = await s.importFile(id, junit(stamp1, [
      ['CMS/04 create with mandatory fields', 'tests/pgr/create.spec.ts', 'pass'],
      ['CMS/08 GRO assigns', 'tests/pgr/assign.spec.ts', 'fail', 'expected PENDINGATLME'],
      ['CMS/09 GRO rejects', 'tests/pgr/reject.spec.ts', 'skip', 'not on this deployment'],
      ['CMS/12 timeline actors', 'tests/pgr/timeline.spec.ts', 'pass'],
      ['CMS/12 timeline times', 'tests/pgr/timeline-time.spec.ts', 'fail', 'time missing'],
      ['CMS/01 left menu', 'tests/ui/menu.spec.ts', 'fail', 'menu item missing'],
    ]));
    assert.equal(r1.ok, true, r1.error);
    assert.deepEqual(r1.marks, { updated: 5, marked: 4, column: 'Automation v2.12', addedColumn: true });
    const a = await s.tab();
    const when1 = local(stamp1);
    assert.deepEqual(a.byId['CMS/04'], { status: 'Pass', comment: '', auto: 'create.spec.ts', by: 'Priya', on: when1 });
    assert.deepEqual(a.byId['CMS/08'], { status: 'Fail', comment: '', auto: 'assign.spec.ts: expected PENDINGATLME', by: 'Priya', on: when1 });
    assert.deepEqual(a.byId['CMS/09'], { status: 'NA (Skipped)', comment: '', auto: 'reject.spec.ts: not on this deployment', by: 'Priya', on: when1 });
    assert.equal(a.byId['CMS/12'].status, 'Fail');
    assert.equal(a.byId['CMS/12'].auto, 'timeline-time.spec.ts: time missing, timeline.spec.ts');
    assert.deepEqual([a.byId['CMS/01'].status, a.byId['CMS/01'].auto], ['Pass', 'menu.spec.ts: menu item missing'], 'a tester\'s result stays; the Automation column says what automation found');
    assert.equal(a.byId['CMS/01'].by, before.byId['CMS/01'].by, 'and Tested by is left as it was');
    assert.equal(a.byId['CMS/05'].comment, 'Block level missing on details page', 'manual comments are never touched');
    assert.equal(a.byId['CMS/02'].auto, '', 'a case no test names');

    // the column sits right after the cycle's Comment column, and belongs to the cycle
    const xl = await s.call('api_detectTab', TAB, a.m.headerRow);
    const row = xl.top[a.m.headerRow - 1];
    assert.equal(row[row.indexOf('Comment / v2.12') + 1], 'Automation v2.12');

    // a tester re-marks CMS/09 by hand: from now on it is theirs
    const c9 = a.m.cases.find((x) => x.id === 'CMS/09');
    const m9 = await s.call('api_mark', { tab: TAB, key: c9.key, sh: c9.sh, row: c9.row, cycle: 'v2.12', expect: 'NA (Skipped)', status: 'Pass', comment: 'checked by hand' });
    assert.equal(m9.ok, true, m9.error);

    // run 2 (newer): CMS/04 now fails, CMS/08 passes, CMS/09 fails
    const stamp2 = '2026-11-21T06:45:00Z';
    const r2 = await s.importFile(id, junit(stamp2, [
      ['CMS/04 create with mandatory fields', 'tests/pgr/create.spec.ts', 'fail', 'button disabled'],
      ['CMS/08 GRO assigns', 'tests/pgr/assign.spec.ts', 'pass'],
      ['CMS/09 GRO rejects', 'tests/pgr/reject.spec.ts', 'fail', 'reason box missing'],
    ]));
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.marks.updated, 3);
    assert.equal(r2.marks.addedColumn, false);
    const b = await s.tab();
    const when2 = local(stamp2);
    assert.deepEqual(b.byId['CMS/04'], { status: 'Fail', comment: '', auto: 'create.spec.ts: button disabled', by: 'Priya', on: when2 }, 'automation updates what it wrote');
    assert.deepEqual([b.byId['CMS/08'].status, b.byId['CMS/08'].auto], ['Pass', 'assign.spec.ts']);
    assert.deepEqual([b.byId['CMS/09'].status, b.byId['CMS/09'].comment, b.byId['CMS/09'].auto], ['Pass', 'checked by hand', 'reject.spec.ts: reason box missing'], 'not the result a tester changed');
    assert.equal(b.byId['CMS/12'].auto, 'timeline-time.spec.ts: time missing, timeline.spec.ts', 'a case the newer run doesn\'t name keeps what the older one wrote');

    // delete run 2: what it wrote and nobody changed since is taken back
    const del = await s.req('POST', '/api/automation/delete', { body: { id: r2.run.id } });
    assert.equal(del.ok, true, del.error);
    assert.equal(del.cleared, 3);
    const c = await s.tab();
    assert.deepEqual(c.byId['CMS/04'], { status: '', comment: '', auto: '', by: '', on: '' });
    assert.deepEqual([c.byId['CMS/08'].status, c.byId['CMS/08'].auto], ['', '']);
    assert.deepEqual([c.byId['CMS/09'].status, c.byId['CMS/09'].auto], ['Pass', ''], 'the tester\'s status stays; its Automation cell goes');
    assert.equal(c.byId['CMS/12'].status, 'Fail', 'run 1\'s writes stay');

    // move run 1 to a new cycle: taken back from v2.12, written into v2.13
    assert.equal((await s.call('api_startCycle', TAB, 'v2.13')).ok, true);
    const mv = await s.req('POST', '/api/automation/reattach', { body: { id: r1.run.id, book: BOOK, tab: TAB, cycle: 'v2.13' } });
    assert.equal(mv.ok, true, mv.error);
    assert.equal(mv.marks.column, 'Automation v2.13');
    const old = await s.tab('v2.12');
    assert.deepEqual([old.byId['CMS/12'].status, old.byId['CMS/12'].auto, old.byId['CMS/01'].auto], ['', '', '']);
    assert.equal(old.byId['CMS/01'].status, 'Pass', 'the tester\'s result was never automation\'s to take back');
    const moved = await s.tab('v2.13');
    assert.deepEqual([moved.byId['CMS/12'].status, moved.byId['CMS/12'].auto], ['Fail', 'timeline-time.spec.ts: time missing, timeline.spec.ts']);
    assert.equal(moved.byId['CMS/01'].status, 'Fail', 'in the new cycle nobody had marked CMS/01');

    // renaming a cycle renames its Automation column; removing it removes the column too
    const ren = await s.call('api_renameCycle', TAB, 'Test Status / v2.13', 'v2.14');
    assert.equal(ren.ok, true, ren.error);
    const top = (await s.call('api_detectTab', TAB, old.m.headerRow)).top[old.m.headerRow - 1];
    assert.ok(top.includes('Automation v2.14') && !top.includes('Automation v2.13'));
    assert.equal((await s.call('api_removeCycle', TAB, 'Test Status / v2.14')).ok, true);
    const after = (await s.call('api_detectTab', TAB, old.m.headerRow)).top[old.m.headerRow - 1];
    assert.ok(!after.some((h) => /v2\.14/.test(h)), 'its three columns are gone');
  } finally { s.close(); }
});
