// The local server over HTTP: guards, workbooks, Claude drafting (with a fake
// claude CLI), notes from Bug Reporter, exports. Uses a temporary sheets folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { XBook } from '../lib/xlsx-book.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeClaude } from '../dev/fake-claude.mjs';
import { extensionIdFromKey } from '../../bug-reporter/host/lib/extension-id.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const EXT_ORIGIN = `chrome-extension://${extensionIdFromKey(JSON.parse(readFileSync(new URL('../../bug-reporter/extension/manifest.json', import.meta.url), 'utf8')).key)}`;

async function start({ claude = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-http-'));
  const sheets = join(dir, 'sheets');
  const tools = mkdtempSync(join(tmpdir(), 'testrun-tools-'));
  const fake = makeFakeClaude(tools);
  const server = createServer({ sheetsDir: sheets, claudePath: claude ? fake.bin : join(tools, 'missing-claude') });
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
  const calls = () => readFileSync(fake.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Setup as detected.
  const boot = await call('api_bootstrap');
  await call('api_saveSetup', { tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) });
  await call('api_loadTab', TAB, '');
  return { server, base, sheets, req, call, disk, calls, close: () => server.close() };
}

test('only this computer, this console and Bug Reporter may call it', async () => {
  const s = await start();
  try {
    assert.equal((await s.req('GET', '/api/status', undefined, { 'X-Test-Run': '' })).code, 'FORBIDDEN', 'no custom header: refused');
    assert.equal((await s.req('GET', '/api/status', undefined, { Origin: 'https://evil.example' })).code, 'FORBIDDEN', 'other websites: refused');
    assert.equal((await s.req('GET', '/api/status', undefined, { Origin: EXT_ORIGIN })).ok, true, 'Bug Reporter: allowed');
    const status = await new Promise((resolve, reject) => {
      const u = new URL(s.base);
      http.get({ host: '127.0.0.1', port: u.port, path: '/api/status', headers: { 'X-Test-Run': '1', Host: `evil.example:${u.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 421, 'wrong Host (DNS rebinding): refused');
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
    const bad = await s.req('POST', '/api/note-bug', { title: 'x', url: 'javascript:alert(1)' });
    assert.equal((await s.call('api_listFindings')).findings.find((x) => x.key === bad.key).url, '', 'only https links are kept');
  } finally { s.close(); }
});

test('Claude drafts from findings with the defaults, or the model and effort chosen for this draft', async () => {
  const s = await start();
  try {
    await s.call('api_saveFinding', { text: 'Citizen cannot reopen a complaint resolved 4 days ago', issue: '#77', tab: TAB, area: 'Citizen UI' });
    const r = await s.req('POST', '/api/claude', { kind: 'draft', book: BOOK, tab: TAB, findingKeys: ['F-001'] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.entry.type, 'scenarios');
    assert.equal(r.entry.items[0].scenario, 'Verify that citizen cannot reopen a complaint resolved 4 days ago');
    assert.equal(r.usage.requested.model, 'sonnet');
    assert.equal(r.usage.requested.effort, 'low');
    assert.equal(r.usage.costText, '$0.0082', 'API-equivalent cost from Bug Reporter\'s price table');
    let call = s.calls().pop();
    assert.deepEqual([call.model, call.effort, call.tools], ['claude-sonnet-5-5', 'low', ''], 'Sonnet 5.5, Low, no tools');
    assert.match(call.system, /skill\/test-run\/SKILL\.md$/);

    const r2 = await s.req('POST', '/api/claude', { kind: 'draft', book: BOOK, tab: TAB, findingKeys: ['F-001'], model: 'haiku', effort: 'medium' });
    assert.equal(r2.ok, true);
    call = s.calls().pop();
    assert.deepEqual([call.model, call.effort], ['claude-haiku-5-5', 'medium'], 'changed for this draft only');

    await s.req('POST', '/api/app', { claude: { paths: { model: 'opus', effort: 'high' } } });
    const p = await s.req('POST', '/api/claude', { kind: 'paths', book: BOOK, tab: TAB, onlyUntested: false, cycle: 'v2.12' });
    assert.equal(p.ok, true, p.error);
    assert.deepEqual(p.entry.paths.map((x) => x.name), ['Planned path A', 'Planned path B']);
    call = s.calls().pop();
    assert.deepEqual([call.model, call.effort], ['claude-opus-5-5', 'high'], 'saved defaults for planning');
    assert.equal((await s.call('api_listInbox')).inbox.length, 3, 'all drafts wait in the Inbox');
    assert.equal((await s.disk()).length, 19, 'nothing written to the workbook by drafting');
  } finally { s.close(); }
});

test('Claude problems come back as clear messages', async () => {
  const s = await start({ claude: false });
  try {
    await s.call('api_saveFinding', { text: 'x', tab: TAB });
    const r = await s.req('POST', '/api/claude', { kind: 'draft', book: BOOK, tab: TAB, findingKeys: ['F-001'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /not answer|ENOENT|not found|exited|spawn/i);
    await s.req('POST', '/api/app', { claude: { enabled: false } });
    assert.equal((await s.req('POST', '/api/claude', { kind: 'draft', book: BOOK, tab: TAB, findingKeys: ['F-001'] })).code, 'CLAUDE_OFF');
    assert.equal((await s.req('POST', '/api/claude', { kind: 'draft', book: BOOK, tab: TAB, findingKeys: [] })).code, 'CLAUDE_OFF');
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
    const dl = await fetch(`${s.base}api/books/download?name=${encodeURIComponent(BOOK)}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    const bad = await fetch(`${s.base}api/books/download?name=${encodeURIComponent('../x.xlsx')}`).then((x) => x.json());
    assert.equal(bad.ok, false, 'no path tricks');
  } finally { s.close(); }
});

test('export summary writes one standalone HTML file', async () => {
  const s = await start();
  try {
    const r = await s.req('POST', '/api/export-summary', { book: BOOK, tab: TAB, cycle: 'v2.12' });
    assert.equal(r.ok, true, r.error);
    assert.ok(existsSync(r.file));
    const html = readFileSync(r.file, 'utf8');
    assert.match(html, /<style>:root/);
    assert.match(html, /Open failures/);
    assert.doesNotMatch(html, /<script/);
    const page = await fetch(s.base + r.url.slice(1));
    assert.equal(page.status, 200);
  } finally { s.close(); }
});

test('settings: name and Claude defaults are kept per computer', async () => {
  const s = await start();
  try {
    const r = await s.req('POST', '/api/app', { user: 'Tester One', claude: { draft: { model: 'opus', effort: 'nonsense' } } });
    assert.equal(r.settings.user, 'Tester One');
    assert.deepEqual(r.settings.claude.draft, { model: 'opus', effort: 'low' }, 'unknown effort falls back to the default');
    const d = await s.call('api_loadTab', TAB, '');
    const c = d.cases.find((x) => x.id === 'CMS/09');
    await s.call('api_addColumns', TAB, ['testedBy']);
    const m = await s.call('api_mark', { tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' });
    assert.equal(m.testedBy, 'Tester One');
    assert.ok(JSON.parse(readFileSync(join(s.sheets, '.testrun', 'app.json'), 'utf8')).user === 'Tester One');
  } finally { s.close(); }
});
