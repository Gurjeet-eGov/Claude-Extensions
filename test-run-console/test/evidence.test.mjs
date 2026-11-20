// Test Run Extension's side of the server: media limits, what each person has open,
// evidence on test cases (and the rule that a result backed by a file cannot change
// until the file is replaced or removed), the Complete Report zip, and Tested by /
// Tested on added on import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { createServer } from '../server.mjs';
import { XBook } from '../lib/xlsx-book.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { evidenceType, safeName, mediaLimits, normalizeMedia, MAX_FILE_BYTES } from '../lib/evidence.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const CYCLE = 'v2.12';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 3)]);

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-ev-'));
  const sheets = join(dir, 'sheets');
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh' });
  writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const base = await server.listenOn(0);
  const raw = async (method, path, body, headers = {}) => fetch(base + path.replace(/^\//, ''), { method, headers: { 'X-Test-Run': '1', ...headers }, body });
  const req = async (method, path, body) => {
    const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { 'content-type': 'application/json' });
    const text = await r.text();
    try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, text }; }
  };
  const call = (fn, ...args) => req('POST', `/api/call/${fn}`, { book: BOOK, args });
  const upload = async (key, buf, extra = '') => {
    const r = await raw('POST', `/api/evidence?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=${CYCLE}&key=${encodeURIComponent(key)}${extra}`, buf, { 'content-type': 'application/octet-stream' });
    return { status: r.status, ...(await r.json()) };
  };
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  const caseOf = async (id) => (await call('api_loadTab', TAB, CYCLE)).cases.find((c) => c.id === id);
  const mark = async (id, status, expect) => {
    const c = await caseOf(id);
    return call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: CYCLE, expect: expect != null ? expect : c.statuses[(await call('api_loadTab', TAB, CYCLE)).cycleIdx] || '', status });
  };
  return { server, base, sheets, req, raw, call, upload, caseOf, mark, close: () => server.close() };
}

test('media limits: the host picks 720p or 1080p and how long a Complete Report is kept; the rest is fixed', async () => {
  assert.deepEqual(normalizeMedia({}), { quality: '1080p', keepMinutes: 60 });
  assert.deepEqual(normalizeMedia({ quality: '4k', keepMinutes: 7 }), { quality: '1080p', keepMinutes: 60 }, 'anything else falls back');
  const l = mediaLimits(normalizeMedia({ quality: '720p' }));
  assert.deepEqual([l.width, l.height, l.fps, l.maxBytes], [1280, 720, 30, 20 * 1024 * 1024]);
  assert.ok(l.maxSeconds > 100 && l.maxSeconds < 120, `720p fits about 1 min 50 s in 20 MB (${l.maxSeconds})`);
  assert.ok(mediaLimits(normalizeMedia({})).maxSeconds < 70, 'and 1080p about a minute');
  const s = await start();
  try {
    const m = await s.req('GET', '/api/media');
    assert.deepEqual([m.ok, m.quality, m.keepMinutes, m.photo.width, m.used], [true, '1080p', 60, 1920, 0]);
    const set = await s.req('POST', '/api/media', { quality: '720p', keepMinutes: 15 });
    assert.deepEqual([set.ok, set.quality, set.keepMinutes, set.height], [true, '720p', 15, 720]);
    assert.equal((await s.req('GET', '/api/media')).quality, '720p', 'kept');
  } finally { s.close(); }
});

test('what each person has open in Test Run is what the extension shows', async () => {
  const s = await start();
  try {
    assert.equal((await s.req('GET', '/api/current')).current, null);
    await s.req('POST', '/api/current', { book: BOOK, tab: TAB, cycle: CYCLE, caseKey: 'CMS/07' });
    const cur = await s.req('GET', '/api/current');
    assert.deepEqual([cur.current.book, cur.current.tab, cur.current.cycle, cur.current.caseKey], [BOOK, TAB, CYCLE, 'CMS/07']);
    assert.equal(cur.me.role, 'owner');
    const suite = await s.req('GET', `/api/ext/suite?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=${CYCLE}`);
    assert.equal(suite.ok, true, suite.error);
    assert.equal(suite.cycle, CYCLE);
    assert.ok(suite.statusOptions.some((o) => o.value === 'Pass' && o.cls === 'pass'));
    const c = suite.cases.find((x) => x.id === 'CMS/07');
    assert.ok(c.sh && c.row && c.scenario);
    assert.equal(c.evidence, null);
  } finally { s.close(); }
});

test('evidence: a screenshot and a recording per case; used by the next result; a changed result needs a new file; removing deletes it', async () => {
  assert.deepEqual(evidenceType(PNG), { kind: 'photo', ext: 'png' });
  assert.deepEqual(evidenceType(WEBM), { kind: 'video', ext: 'webm' });
  assert.equal(evidenceType(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(safeName('CMS/07'), 'CMS-07');
  const s = await start();
  try {
    assert.equal((await s.upload('CMS/04', Buffer.from('not an image at all, honestly'))).code, 'BAD_INPUT');
    assert.equal((await s.upload('CMS/99', PNG)).code, 'NO_CASE');
    const big = await s.raw('POST', `/api/evidence?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=${CYCLE}&key=CMS%2F04`, Buffer.alloc(MAX_FILE_BYTES + 10), { 'content-type': 'application/octet-stream' });
    assert.equal(big.status, 413, 'over 20 MB is refused');

    // CMS/04 not run yet: a screenshot and a recording, both waiting for the result
    const a = await s.upload('CMS/04', PNG);
    assert.equal(a.ok, true, a.error);
    assert.match(a.added.name, /^CMS-04_v2\.12_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);
    const v = await s.upload('CMS/04', WEBM);
    assert.deepEqual(Object.keys(v.evidence).sort(), ['photo', 'video'], 'one of each');
    assert.deepEqual([v.evidence.photo.usedFor, v.evidence.video.usedFor], ['', '']);
    const dir = join(s.sheets, '.testrun', 'evidence', 'CMS Sign Off (sample)', TAB, CYCLE);
    assert.ok(existsSync(join(dir, a.added.name)) && existsSync(join(dir, v.added.name)), 'kept on the host');
    const a2 = await s.upload('CMS/04', PNG);
    assert.equal(existsSync(join(dir, a.added.name)), false, 'a new screenshot replaces the screenshot only');
    assert.ok(existsSync(join(dir, v.added.name)));

    const m1 = await s.mark('CMS/04', 'Pass');
    assert.equal(m1.ok, true, m1.error);
    assert.deepEqual([m1.evidence.photo.usedFor, m1.evidence.video.usedFor], ['Pass', 'Pass']);
    const ci = (await s.call('api_loadTab', TAB, CYCLE)).cycleIdx;
    const c1 = await s.caseOf('CMS/04');
    assert.ok(c1.comments[ci].endsWith(`Evidence: ${a2.added.name}, ${v.added.name}`), 'both file names go in the cycle comment');
    assert.deepEqual(Object.keys((await s.call('api_loadTab', TAB, CYCLE)).evidence[c1.key]).sort(), ['photo', 'video'], 'Run sees both');

    // Changing a result backed by files needs a new file first
    const no = await s.mark('CMS/04', 'Fail', 'Pass');
    assert.equal(no.code, 'EVIDENCE');
    assert.match(no.error, /attach new evidence/);
    assert.equal((await s.caseOf('CMS/04')).statuses[ci], 'Pass', 'still Pass');
    assert.equal((await s.mark('CMS/04', 'Pass', 'Pass')).ok, true, 'saving the same result (a comment, say) is fine');

    // A new screenshot for Fail: once Fail is saved, the old result's recording is out of date and goes
    const b = await s.upload('CMS/04', PNG, '&forStatus=Fail');
    assert.equal(b.ok, true, b.error);
    assert.deepEqual([b.evidence.photo.usedFor, b.evidence.video.usedFor], ['', 'Pass']);
    const m2 = await s.mark('CMS/04', 'Fail', 'Pass');
    assert.equal(m2.ok, true, m2.error);
    assert.deepEqual(m2.removedEvidence, [v.added.name]);
    assert.deepEqual(Object.keys(m2.evidence), ['photo']);
    assert.equal(m2.evidence.photo.usedFor, 'Fail');
    assert.equal(existsSync(join(dir, v.added.name)), false, 'the old recording is deleted');
    const c2 = (await s.caseOf('CMS/04')).comments[ci];
    assert.equal((c2.match(/Evidence:/g) || []).length, 1);
    assert.match(c2, new RegExp(`Evidence: ${b.added.name.replace(/\./g, '\\.')}$`));

    // Removed: deleted from the host and the comment; the result can change again freely
    const r = await s.req('POST', '/api/evidence/remove', { book: BOOK, tab: TAB, cycle: CYCLE, key: 'CMS/04', kind: 'photo' });
    assert.equal(r.ok, true, r.error);
    assert.equal(existsSync(join(dir, b.added.name)), false);
    assert.doesNotMatch((await s.caseOf('CMS/04')).comments[ci], /Evidence:/);
    assert.equal((await s.mark('CMS/04', 'Pass', 'Fail')).ok, true, 'no file, no rule');

    // A file for a case that already has a result backs that result at once
    await s.mark('CMS/07', 'Pass');
    const d = await s.upload('CMS/07', PNG);
    assert.equal(d.evidence.photo.usedFor, 'Pass');
    assert.match((await s.caseOf('CMS/07')).comments[ci], /Evidence: CMS-07_/);
    const file = await s.raw('GET', `/api/evidence/file?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=${CYCLE}&key=CMS%2F07&kind=photo`);
    assert.deepEqual([file.status, file.headers.get('content-type')], [200, 'image/png']);
    assert.equal(Buffer.from(await file.arrayBuffer()).length, PNG.length);

    // Deleting the workbook deletes its evidence
    assert.equal((await s.req('POST', '/api/books/delete', { name: BOOK })).ok, true);
    assert.equal(existsSync(join(s.sheets, '.testrun', 'evidence', 'CMS Sign Off (sample)')), false);
  } finally { s.close(); }
});

test('evidence kept by the first version (one file per case) is read as that kind', async () => {
  const s = await start();
  try {
    const a = await s.upload('CMS/09', PNG);
    const file = join(s.sheets, '.testrun', 'evidence', 'CMS Sign Off (sample)', 'index.json');
    const idx = JSON.parse(readFileSync(file, 'utf8'));
    const it = Object.values(idx.items)[0];
    writeFileSync(file, JSON.stringify({ version: 1, items: { [`${TAB}\u0001${CYCLE}\u0001${it.caseKey}`]: it } }));
    const v = await s.upload('CMS/09', WEBM);
    assert.deepEqual([v.evidence.photo.name, v.evidence.video.name], [a.added.name, v.added.name], 'the old file is still there, as the screenshot');
  } finally { s.close(); }
});

test('Complete Report: the workbook and every suite\'s evidence in one zip, made in the background, kept for a while', async () => {
  const s = await start();
  try {
    await s.req('POST', '/api/media', { keepMinutes: 15 });
    assert.equal((await s.req('GET', `/api/complete-report?book=${encodeURIComponent(BOOK)}`)).state, 'none');
    await s.mark('CMS/07', 'Pass');
    const a = (await s.upload('CMS/07', PNG)).added;
    // another suite of the same workbook
    const feat = await s.call('api_loadTab', 'CMS 2.20.1 Features', '');
    const fc = feat.cases[0];
    const cyc = feat.cycles[feat.cycleIdx].label;
    const up = await s.raw('POST', `/api/evidence?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent('CMS 2.20.1 Features')}&cycle=${encodeURIComponent(cyc)}&key=${encodeURIComponent(fc.key)}`, WEBM, { 'content-type': 'application/octet-stream' }).then((x) => x.json());
    assert.equal(up.ok, true, up.error);

    const go = await s.req('POST', '/api/complete-report', { book: BOOK });
    assert.deepEqual([go.ok, go.state, go.started], [true, 'running', true]);
    assert.ok(go.readyIn >= 1);
    await s.server.reports.wait();
    const ready = await s.req('GET', `/api/complete-report?book=${encodeURIComponent(BOOK)}`);
    assert.equal(ready.state, 'ready');
    assert.ok(ready.expiresIn > 14 * 60 && ready.expiresIn <= 15 * 60, 'kept for the host\'s 15 minutes');
    const again = await s.req('POST', '/api/complete-report', { book: BOOK });
    assert.deepEqual([again.ok, again.code], [false, 'WAIT'], 'no new one while it is kept');

    const dl = await s.raw('GET', `/api/complete-report/download?book=${encodeURIComponent(BOOK)}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/zip');
    const zip = await JSZip.loadAsync(Buffer.from(await dl.arrayBuffer()));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    assert.deepEqual(names, [
      BOOK,
      `Evidence/CMS 2.20.1 Features/${cyc}/${safeName(fc.id || fc.key)}/${up.added.name}`,
      `Evidence/CMS 2.20.1/v2.12/CMS-07/${a.name}`,
    ]);
    const xbook = await XBook.fromBuffer(await zip.file(BOOK).async('nodebuffer'), 'x');
    assert.ok(xbook.getSheetByName(TAB), 'the workbook as Summary Report gives it');

    // After the keep time it is deleted, and a new one can be made
    s.server.reports.expire(Date.now() + 16 * 60000);
    assert.equal((await s.req('GET', `/api/complete-report?book=${encodeURIComponent(BOOK)}`)).state, 'none');
    assert.deepEqual(readdirSync(join(s.sheets, '.testrun', 'complete-reports')), [], 'the zip is gone from the host');
    assert.equal((await s.raw('GET', `/api/complete-report/download?book=${encodeURIComponent(BOOK)}`)).status, 404);
  } finally { s.close(); }
});

test('import: every test suite gets Tested by and Tested on (mapped when there, added when not)', async () => {
  const s = await start();
  try {
    const bytes = await buildSampleXlsx();
    const r = await fetch(`${s.base}api/books/import?name=${encodeURIComponent('Bomet.xlsx')}`, { method: 'POST', headers: { 'X-Test-Run': '1' }, body: bytes }).then((x) => x.json());
    assert.equal(r.ok, true, r.error);
    assert.ok(r.addedColumns.length >= 1, JSON.stringify(r.addedColumns));
    assert.ok(r.addedColumns.every((a) => a.added.includes('testedBy') && a.added.includes('testedOn')));
    const disk = await XBook.fromFile(join(s.sheets, 'Bomet.xlsx'), 'x');
    const headers = disk.getSheetByName(TAB).getDataRange().getDisplayValues()[0];
    assert.ok(headers.includes('Tested by') && headers.includes('Tested on'), headers.join(' | '));
    // Setup is still the welcome one (nothing saved), and finds the new columns by their headers
    const boot = await s.req('POST', '/api/call/api_bootstrap', { book: 'Bomet.xlsx', args: [] });
    assert.equal(boot.config, null, 'Setup is not saved for them');
    const t = boot.tabs.find((x) => x.name === TAB);
    assert.equal(t.detected.columns.testedBy, 'Tested by');
    // Importing it again (now with the columns): nothing added
    const again = await fetch(`${s.base}api/books/import?name=${encodeURIComponent('Bomet.xlsx')}&overwrite=1`, { method: 'POST', headers: { 'X-Test-Run': '1' }, body: await disk.toBuffer() }).then((x) => x.json());
    assert.deepEqual(again.addedColumns, []);
  } finally { s.close(); }
});
