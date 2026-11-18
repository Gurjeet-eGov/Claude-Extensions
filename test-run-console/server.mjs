#!/usr/bin/env node
// Test Run console: the local server.
//
//   npm start                  -> http://127.0.0.1:5178, opens the browser
//   npm run demo               -> same, on a temporary copy of a sample workbook
//   node server.mjs --port 6000 --sheets /path/to/folder --no-open
//
// It only listens on 127.0.0.1. Workbooks are the .xlsx files in sheets/
// (git-ignored); console data for each workbook is kept beside it in
// sheets/.testrun/. Nothing is sent anywhere except the Claude calls you start,
// which go through your own Claude Code login.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, createReadStream, mkdtempSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRuntime, ROOT } from './lib/runtime.mjs';
import { XSheetsApi } from './lib/xlsx-book.mjs';
import { Library } from './lib/books.mjs';
import { createMemoryStore } from './lib/store.mjs';
import { askClaude, claudeStatus, MODELS, MODEL_LABELS, EFFORTS } from './lib/claude-run.mjs';
import { extensionIdFromKey } from '../bug-reporter/host/lib/extension-id.mjs';

const UI = join(ROOT, 'ui');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/summary.html': 'summary.html', '/styles.css': 'styles.css', '/shared.js': 'shared.js', '/client.js': 'client.js', '/summary.js': 'summary.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});

function defaultUser() {
  try {
    const n = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (n) return n;
  } catch { /* no git name */ }
  try { return userInfo().username; } catch { return ''; }
}

function bugReporterExtensionId() {
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, '..', 'bug-reporter', 'extension', 'manifest.json'), 'utf8'));
    return manifest.key ? extensionIdFromKey(manifest.key) : null;
  } catch {
    return null;
  }
}

const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function normalizeApp(a = {}) {
  const c = a.claude || {};
  const part = (p, d) => ({ model: pick(p && p.model, MODELS, d.model), effort: pick(p && p.effort, EFFORTS, d.effort) });
  return {
    user: clip(a.user, 80),
    claude: {
      enabled: c.enabled !== false,
      draft: part(c.draft, { model: 'sonnet', effort: 'low' }),
      paths: part(c.paths, { model: 'sonnet', effort: 'medium' }),
    },
    last: { book: clip(a.last && a.last.book, 260), tab: clip(a.last && a.last.tab, 160), cycle: clip(a.last && a.last.cycle, 60) },
  };
}

/** The summary page as one standalone HTML file (styles inlined), for sharing. */
function summaryPage(s) {
  const css = readFileSync(join(UI, 'styles.css'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(join(UI, 'shared.js'), 'utf8'), ctx, { filename: 'shared.js' });
  const TR = ctx.TR;
  const esc = TR.esc;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Run summary: ${esc(s.tab)}${s.cycle ? ` (${esc(s.cycle)})` : ''}</title>
<style>${css}</style></head>
<body><div class="app"><main>
<div class="summary-head"><h1>${esc(s.tab)}</h1><span class="muted">${esc(s.sheetName)} · cycle ${esc(s.cycle || '–')}${s.release ? ` · release ${esc(s.release)}` : ''} · as of ${esc(s.generatedAt)}</span></div>
${TR.summaryHtml(s)}
</main></div></body></html>
`;
}

export function createServer({ sheetsDir = join(ROOT, 'sheets'), claudePath, log = () => {} } = {}) {
  mkdirSync(sheetsDir, { recursive: true });
  const lib = new Library(sheetsDir);
  const appFile = join(sheetsDir, '.testrun', 'app.json');
  let app = normalizeApp(existsSync(appFile) ? JSON.parse(readFileSync(appFile, 'utf8')) : {});
  if (!app.user) app.user = defaultUser();
  const extId = bugReporterExtensionId();
  let current = null;
  const noStore = createMemoryStore();
  const rt = createRuntime({
    sheetsApi: XSheetsApi,
    getBook: () => (current ? current.book : null),
    getStore: () => (current ? current.store : noStore),
    env: { user: app.user },
  });

  function saveApp() {
    mkdirSync(join(sheetsDir, '.testrun'), { recursive: true });
    const tmp = `${appFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(app, null, 2));
    renameSync(tmp, appFile);
  }

  // One workbook operation at a time: load, change, save.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  };

  async function openBook(name) {
    const books = lib.list();
    const has = (n) => n && books.some((b) => b.name === n);
    const want = has(name) ? name : has(app.last.book) ? app.last.book : books[0] && books[0].name;
    if (!want) throw err('NO_BOOK', 'There are no workbooks yet. Put an .xlsx file in the sheets folder, or use Import.');
    const entry = await lib.get(want);
    if (app.last.book !== want) {
      app.last = { book: want, tab: '', cycle: '' };
      saveApp();
    }
    return entry;
  }

  /** Run one api_* function on a workbook, then save it if it changed (or drop the changes if it failed). */
  function callApi(fn, args, bookName) {
    return serial(async () => {
      const entry = await openBook(bookName);
      current = entry;
      rt.state.user = app.user;
      let out;
      try {
        out = rt.call(fn, ...(args || []));
      } finally {
        current = null;
      }
      if (out && out.ok === false && entry.book.dirty) {
        lib.open.delete(entry.name); // a failed call must not leave half-done changes behind
      } else {
        try {
          await lib.save(entry);
        } catch (e) {
          lib.open.delete(entry.name);
          return { ok: false, code: 'SAVE_FAILED', error: `Could not save the workbook: ${e.message}` };
        }
      }
      if (fn === 'api_loadTab' && out && out.ok) {
        app.last.tab = out.tab;
        app.last.cycle = out.cycleIdx >= 0 ? out.cycles[out.cycleIdx].label : '';
        saveApp();
      }
      if (out && typeof out === 'object') {
        out.book = entry.name;
        out.excelOpen = lib.excelOpen(entry.name);
        if (entry.reloaded) out.reloaded = true;
      }
      return out;
    });
  }

  function appInfo() {
    return {
      ok: true,
      settings: { user: app.user, claude: app.claude },
      last: app.last,
      books: lib.list(),
      claude: { ...claudeStatus(claudePath), models: MODEL_LABELS, efforts: EFFORTS },
      sheetsDir,
      version: VERSION,
    };
  }

  async function claudeDraft(body) {
    const kind = body.kind === 'paths' ? 'paths' : 'draft';
    if (!app.claude.enabled) return { ok: false, code: 'CLAUDE_OFF', error: 'Claude help is switched off in Setup.' };
    const opts = kind === 'paths'
      ? { onlyUntested: !!body.onlyUntested, focus: clip(body.focus, 400), cycle: clip(body.cycle, 60) }
      : { findingKeys: Array.isArray(body.findingKeys) ? body.findingKeys.map((k) => clip(k, 20)).slice(0, 40) : [] };
    const prompt = await callApi('api_buildPrompt', [kind, body.tab, opts], body.book);
    if (!prompt.ok) return prompt;
    const d = app.claude[kind];
    let ask;
    try {
      ask = await askClaude({ kind, prompt: prompt.text, model: body.model || d.model, effort: body.effort || d.effort, claudePath });
    } catch (e) {
      return { ok: false, code: e.code || 'CLAUDE_ERROR', error: e.message, fix: e.fix || [] };
    }
    const parsed = await callApi('api_parseReply', [body.tab, ask.text], body.book);
    if (!parsed.ok) return { ok: false, code: 'CLAUDE_BAD_REPLY', error: `Claude's reply could not be used: ${parsed.error}`, usage: ask.usage, reply: ask.text.slice(0, 4000) };
    return { ok: true, entry: parsed.entry, usage: ask.usage };
  }

  async function noteBug(body) {
    const title = clip(body.title, 1000);
    if (!title) return { ok: false, code: 'BAD_INPUT', error: 'The bug needs a title.' };
    const number = String(body.number || '').replace(/\D/g, '').slice(0, 8);
    const url = /^https:\/\//i.test(String(body.url || '')) ? clip(body.url, 500) : '';
    const details = [
      body.description && clip(body.description, 2000),
      body.actual && `Actual: ${clip(body.actual, 1500)}`,
      body.expected && `Expected: ${clip(body.expected, 1500)}`,
      body.extra && `Notes: ${clip(body.extra, 800)}`,
      body.pageUrl && `Page: ${clip(body.pageUrl, 300)}`,
    ].filter(Boolean).join('\n');
    let tab = app.last.tab;
    if (!tab) {
      const boot = await callApi('api_bootstrap', [], app.last.book);
      const first = boot.ok && boot.tabs.find((t) => ((t.saved && t.saved.role) || t.detected.role) === 'manual');
      tab = first ? first.name : '';
    }
    const res = await callApi('api_saveFinding', [{ text: title, issue: number ? `#${number}` : '', url, tab, area: clip(body.module, 160), details, source: 'bug-reporter' }], app.last.book);
    if (!res.ok) return res;
    return { ok: true, key: res.finding.key, book: res.book, tab };
  }

  async function exportSummary(body) {
    const s = await callApi('api_summary', [body.tab, body.cycle || ''], body.book);
    if (!s.ok) return s;
    const dir = join(sheetsDir, 'exports');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `${s.sheetName} - ${s.tab}${s.cycle ? ` - ${s.cycle}` : ''} - ${stamp}.html`.replace(/[\\/:*?"<>|\0]/g, '_');
    writeFileSync(join(dir, name), summaryPage(s));
    return { ok: true, file: join(dir, name), url: `/exports/${encodeURIComponent(name)}` };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const send = (code, type, body, headers = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
      res.end(body);
    };
    const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));
    try {
      // Only this computer, by name (stops DNS-rebinding pages) ...
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(421, 'text/plain', 'Wrong host');
      // ... and only this console's pages or the Bug Reporter extension.
      const origin = req.headers.origin;
      const okOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (extId) okOrigins.push(`chrome-extension://${extId}`);
      if (origin && !okOrigins.includes(origin)) return json(403, { ok: false, code: 'FORBIDDEN', error: 'Not allowed from this page.' });

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = url.pathname;

      if (req.method === 'GET' && STATIC[path]) {
        const file = join(UI, STATIC[path]);
        return send(200, TYPES[extname(file)], readFileSync(file), { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      }
      if (req.method === 'GET' && path === '/api/books/download') {
        const file = lib.path(url.searchParams.get('name') || '');
        if (!existsSync(file)) return send(404, 'text/plain', 'Not found');
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(url.searchParams.get('name'))}`, 'content-length': statSync(file).size });
        return createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && path.startsWith('/exports/')) {
        const name = decodeURIComponent(path.slice('/exports/'.length));
        if (!/^[^/\\]+\.html$/.test(name)) return send(404, 'text/plain', 'Not found');
        const file = join(sheetsDir, 'exports', name);
        if (!existsSync(file)) return send(404, 'text/plain', 'Not found');
        return send(200, 'text/html; charset=utf-8', readFileSync(file), { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      }
      if (!path.startsWith('/api/')) return send(404, 'text/plain', 'Not found');
      // A custom header: plain cross-site forms and links cannot send it.
      if (req.headers['x-test-run'] !== '1') return json(403, { ok: false, code: 'FORBIDDEN', error: 'Missing X-Test-Run header.' });

      if (req.method === 'GET' && path === '/api/status') {
        return json(200, { ok: true, app: 'test-run', version: VERSION, book: app.last.book || null, tab: app.last.tab || null, cycle: app.last.cycle || null, user: app.user });
      }
      if (req.method === 'GET' && path === '/api/app') return json(200, appInfo());
      if (req.method !== 'POST') return json(405, { ok: false, code: 'METHOD', error: 'Use POST.' });

      if (path === '/api/books/import') {
        const buf = await readBody(req, 40 * 1024 * 1024);
        const name = await serial(() => lib.importFile(url.searchParams.get('name'), buf, { overwrite: url.searchParams.get('overwrite') === '1' }));
        app.last = { book: name, tab: '', cycle: '' };
        saveApp();
        return json(200, { ok: true, name, books: lib.list() });
      }

      const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
      if (path === '/api/app') {
        app = normalizeApp({ ...app, ...body, claude: { ...app.claude, ...(body.claude || {}) }, last: app.last });
        if (!app.user) app.user = defaultUser();
        saveApp();
        return json(200, appInfo());
      }
      if (path === '/api/books/select') {
        await serial(() => openBook(body.name));
        return json(200, appInfo());
      }
      if (path.startsWith('/api/call/')) {
        const fn = path.slice('/api/call/'.length);
        if (!/^api_\w+$/.test(fn)) return json(404, { ok: false, code: 'NO_FUNCTION', error: 'Unknown function.' });
        return json(200, await callApi(fn, Array.isArray(body.args) ? body.args : [], body.book));
      }
      if (path === '/api/claude') return json(200, await claudeDraft(body));
      if (path === '/api/note-bug') return json(200, await noteBug(body));
      if (path === '/api/export-summary') return json(200, await exportSummary(body));
      return json(404, { ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' });
    } catch (e) {
      log(e);
      return json(e.code === 'TOO_BIG' ? 413 : 200, { ok: false, code: e.code || 'ERROR', error: e.message || String(e) });
    }
  });

  server.listenOn = (port = 5178) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
  server.library = lib;
  return server;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(err('TOO_BIG', 'That is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const demo = args.includes('--demo');
  let sheetsDir = arg('--sheets') || process.env.TEST_RUN_SHEETS || join(ROOT, 'sheets');
  if (demo) {
    sheetsDir = mkdtempSync(join(tmpdir(), 'testrun-demo-'));
    const { buildSampleXlsx } = await import('./dev/sample-workbook.mjs');
    writeFileSync(join(sheetsDir, 'CMS Sign Off (sample).xlsx'), await buildSampleXlsx());
  }
  const port = Number(arg('--port') || process.env.PORT || 5178);
  const server = createServer({ sheetsDir, log: (e) => console.error(e && e.stack ? e.stack : e) });
  server.listenOn(port).then((url) => {
    console.log(`Test Run is running at ${url}`);
    console.log(`Workbooks folder: ${sheetsDir}${demo ? ' (demo copy, deleted by your OS later)' : ''}`);
    if (!server.library.list().length) console.log('No workbooks yet: put an .xlsx file in that folder, or use Import in the console.');
    console.log('Press Ctrl+C to stop.');
    if (!args.includes('--no-open') && process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }, (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Test Run already running? Otherwise start it with --port <another>.` : e.message);
    process.exit(1);
  });
}

export { summaryPage };
