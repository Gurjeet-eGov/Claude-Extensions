#!/usr/bin/env node
// Test Run console: the local server.
//
//   npm start                  -> http://127.0.0.1:5178, opens the browser
//   npm run share              -> same, and shares it with your team through a quick tunnel
//   npm run demo               -> on a temporary copy of a sample workbook
//   node server.mjs --port 6000 --sheets /path/to/folder --no-open [--share] [--fake-github]
//
// It only listens on 127.0.0.1. Workbooks are the .xlsx files in sheets/
// (git-ignored); console data for each workbook is kept beside it in
// sheets/.testrun/. When shared (Setup › Access), teammates reach it through a
// tunnel with their own invite key (lib/team.mjs); nothing else leaves the laptop.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, mkdtempSync, readdirSync, copyFileSync, unlinkSync, statSync, createReadStream, rmSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRuntime, ROOT } from './lib/runtime.mjs';
import { XSheetsApi, XBook } from './lib/xlsx-book.mjs';
import { Library } from './lib/books.mjs';
import { createMemoryStore } from './lib/store.mjs';
import { normalizeTeam, personForKey, addPerson, rotateKey, publicPeople, newAdminKey, publicAdmin, inviteLink, isLocalRequest, bearer, mayCall, cleanUrl, cleanTunnelName, pagesUrlFromRemote, cleanBooks, cleanSuites, setRole, MODES } from './lib/team.mjs';
import { startTunnel, publishAddress, findCommand } from './lib/share.mjs';
import { githubIssue, isGithubIssue } from './lib/issues.mjs';
import { publishFiles, readRemoteFile, readRef, dispatchWorkflow, repoFromRemote, repoInfo, ghCommand, slugFor, newPublishId } from './lib/publish.mjs';
import { isWorkbookName } from './lib/books.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { extensionIdFromKey } from './lib/extension-id.mjs';
import { EvidenceStore, normalizeMedia, mediaLimits, evidenceType, MAX_FILE_BYTES, reportSeconds, writeCompleteZip, safeName, KINDS } from './lib/evidence.mjs';
import { createAutomation } from './lib/automation/routes.mjs';
import { createGithub } from './lib/github.mjs';
import { normalizeAutomationSettings } from './lib/automation/store.mjs';
import { previousRun, RUN_ID } from './lib/automation/results.mjs';
import { cleanLock, newIdentity, recipientsFor, sealRuns, SealCache, isAutomationPath, FILES as SEALED_FILES, EVERYONE } from './lib/automation/seal.mjs';
import { publishedMeta, runDetailData, liveCaseIds, everyoneSummary } from './lib/automation/summary.mjs';

const UI = join(ROOT, 'ui');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/summary.html': 'summary.html', '/styles.css': 'styles.css', '/shared.js': 'shared.js', '/client.js': 'client.js', '/summary.js': 'summary.js',
  // age for the browser (one file, built by scripts/build-age-vendor.mjs): the published site unlocks automated results with it
  '/vendor/age.js': 'vendor/age.js' };
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

/** The IDs of this repository's extensions (Test Run Extension, and Bug Reporter if its folder is there): on the laptop they act as the host. */
function ourExtensionIds() {
  const ids = [];
  for (const dir of [join(ROOT, 'extension'), join(ROOT, '..', 'bug-reporter', 'extension')]) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      if (manifest.key) ids.push(extensionIdFromKey(manifest.key));
    } catch { /* not there */ }
  }
  return ids;
}

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** Publishing to GitHub: which workbooks, when, and what was last published or fetched. */
function normalizePublish(p = {}) {
  const books = {};
  for (const [k, v] of Object.entries(p.books || {})) if (v === true && isWorkbookName(k)) books[k] = true;
  const last = p.last || {};
  return {
    books,
    nightly: p.nightly !== false,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.time || '')) ? String(p.time) : '17:00',
    acknowledged: p.acknowledged === true, // the owner confirmed once that publishing makes these public
    knownId: clip(p.knownId, 32), // the publish this laptop made or fetched last
    autoDate: clip(p.autoDate, 10),
    last: { at: clip(last.at, 40), by: clip(last.by, 80), commit: clip(last.commit, 64), url: clip(last.url, 300), error: clip(last.error, 400), note: clip(last.note, 200), pagesError: clip(last.pagesError, 400) },
  };
}

function normalizeApp(a = {}) {
  return {
    user: clip(a.user, 80),
    last: { book: clip(a.last && a.last.book, 260), tab: clip(a.last && a.last.tab, 160), cycle: clip(a.last && a.last.cycle, 60) },
    team: normalizeTeam(a.team),
    publish: normalizePublish(a.publish),
    media: normalizeMedia(a.media),
    automation: normalizeAutomationSettings(a.automation), // { keep, checkEvery, excludeEnvironments }: runs kept per suite and cycle; minutes between looks at a GitHub run; environments the run form leaves out (set by the host)
    lock: cleanLock(a.lock), // { identity }: the host's own age key for the published automated results (lib/automation/seal.mjs)
  };
}

/** Where this app sits in its repository ("test-run-console/"), for the paths it publishes to. */
function repoPrefix() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--show-prefix'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'test-run-console/';
  } catch {
    return 'test-run-console/';
  }
}

function gitRemote() {
  try {
    return execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

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

/** Tailscale's own address for this laptop (https://<name>.<tailnet>.ts.net), when Tailscale is installed and signed in. */
let tailscaleCache = { at: 0, url: '' };
function tailscaleUrl(bin) {
  if (Date.now() - tailscaleCache.at < 60000) return tailscaleCache.url;
  tailscaleCache = { at: Date.now(), url: '' };
  const cmd = bin || findCommand('tailscale') || (existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : null);
  if (!cmd) return '';
  try {
    const st = JSON.parse(execFileSync(cmd, ['status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const name = String((st.Self && st.Self.DNSName) || '').replace(/\.$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) tailscaleCache.url = `https://${name}`;
  } catch { /* not signed in, or not running */ }
  return tailscaleCache.url;
}

// Publishing: dataBranch is the branch everything published goes to (one commit, replaced each
// time), dataPrefix the folder in it ('' for its root), pagesWorkflow the workflow that builds the
// site. publishPrefix and publishedDir are where published data was kept before that branch (the
// default branch's test-run-console/published/, and this checkout's copy of it), read until the
// branch exists. cloneDir is the clone whose copy of the data branch "Start from the published data" reads.
export function createServer({ sheetsDir = join(ROOT, 'sheets'), tunnelBin, ghPath, tailscaleBin, restartDelays = [2000, 5000, 15000, 30000, 60000, 120000, 300000], publishedDir = join(ROOT, 'published'), repo: repoOverride, publishPrefix, dataBranch = 'test-run-data', dataPrefix = '', pagesWorkflow = 'test-run-pages.yml', cloneDir = ROOT, log = () => {}, github, automationPollMs } = {}) {
  const INSTANCE = randomBytes(8).toString('hex'); // tells "this Test Run" apart when checking an address
  mkdirSync(sheetsDir, { recursive: true });
  const lib = new Library(sheetsDir);
  const appFile = join(sheetsDir, '.testrun', 'app.json');
  let app = normalizeApp(existsSync(appFile) ? JSON.parse(readFileSync(appFile, 'utf8')) : {});
  if (!app.user) app.user = defaultUser();
  const extIds = ourExtensionIds();
  const evidence = new EvidenceStore(sheetsDir);
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
    writeFileSync(tmp, JSON.stringify(app, null, 2), { mode: 0o600 }); // it holds the invite keys: readable by you only
    renameSync(tmp, appFile);
  }

  // One workbook operation at a time: load, change, save.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  };

  /** The person at the laptop. */
  const owner = () => ({ role: 'owner', name: app.user, local: true });
  /** The owner: at the laptop, or elsewhere with the admin link. */
  const isOwnerPerson = (person) => !!person && person.role === 'owner';
  /** May this person open this workbook? Teammates can be given one workbook instead of all. */
  const mayOpen = (person, name) => isOwnerPerson(person) || !person || !Array.isArray(person.books) || person.books.includes(name);
  const booksFor = (person) => lib.list().filter((b) => mayOpen(person, b.name));
  // Automated results (lib/automation/): suites, runs and their results, at /api/automation/*.
  // GitHub (starting and following runs) through the one client, lib/github.mjs: gh api today.
  const automation = createAutomation({
    sheetsDir, lib, callApi, mayOpen, isOwner: isOwnerPerson, keep: () => app.automation.keep, readBody,
    github: github || createGithub({ ghPath }), log, pollMs: automationPollMs,
    checkEvery: () => app.automation.checkEvery,
    excludeEnvironments: () => app.automation.excludeEnvironments,
    setKeep: (n) => { app.automation = normalizeAutomationSettings({ ...app.automation, keep: n }); saveApp(); return app.automation.keep; },
    setCheckEvery: (n) => { app.automation = normalizeAutomationSettings({ ...app.automation, checkEvery: n }); saveApp(); return app.automation.checkEvery; },
    setExcludeEnvironments: (list) => { app.automation = normalizeAutomationSettings({ ...app.automation, excludeEnvironments: list }); saveApp(); return app.automation.excludeEnvironments; },
  });

  async function openBook(name, person) {
    if (name && !mayOpen(person, name) && lib.list().some((b) => b.name === name)) throw err('FORBIDDEN', 'This workbook is not shared with you. Ask your test lead.');
    const books = booksFor(person);
    const has = (n) => n && books.some((b) => b.name === n);
    const want = has(name) ? name : has(app.last.book) ? app.last.book : books[0] && books[0].name;
    if (!want) throw err('NO_BOOK', lib.list().length ? 'No workbook is shared with you yet. Ask your test lead.' : 'There are no workbooks yet. Put an .xlsx file in the sheets folder, or use Import.');
    const entry = await lib.get(want);
    if (isOwnerPerson(person) && person.remember !== false && app.last.book !== want) { // only the owner's own choice is remembered
      app.last = { book: want, tab: '', cycle: '' };
      saveApp();
    }
    return entry;
  }

  /** Run one api_* function on a workbook as a person, then save it if it changed (or drop the changes if it failed). */
  function callApi(fn, args, bookName, person = owner()) {
    return serial(async () => {
      const entry = await openBook(bookName, person);
      current = entry;
      rt.state.user = person.name;
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
      if (fn === 'api_loadTab' && out && out.ok) out.evidence = evidenceOut(evidence.forCycle(entry.name, out.tab, out.cycleIdx >= 0 ? out.cycles[out.cycleIdx].label : ''));
      if (fn === 'api_loadTab' && out && out.ok && isOwnerPerson(person) && person.remember !== false) {
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

  function appInfo(person) {
    return {
      ok: true,
      settings: { user: app.user },
      me: { name: person.name, role: person.role, local: !!person.local, admin: !!person.admin },
      last: mayOpen(person, app.last.book) ? app.last : { book: '', tab: '', cycle: '' },
      books: booksFor(person).map((b) => (isOwnerPerson(person) ? b : { name: b.name, modified: b.modified, excelOpen: b.excelOpen })),
      sheetsDir: person.local ? sheetsDir : '',
      team: { enabled: app.team.enabled },
      // for the host: published data to start from (a fresh clone), or a newer publish by someone else
      published: isOwnerPerson(person) && !lib.list().length ? localOffer() : null,
      automationBooks: automation.booksWithSuites(person), // the workbooks where the Automation tab shows
      publishNotice: isOwnerPerson(person) && pub.remote && pub.remote.id && pub.remote.id !== app.publish.knownId ? { by: pub.remote.by, at: pub.remote.publishedAt } : null,
      version: VERSION,
    };
  }

  // -------------------------------------------------------------------------
  // Team: invite links, the shared address, the gist that keeps it findable
  // -------------------------------------------------------------------------

  // How teammates reach the laptop. mode 'quick': a Cloudflare quick tunnel, new address on
  // every start (kept findable through the gist and the hosted page). mode 'fixed': an address
  // that stays the same, served by the owner's own tunnel or by a named tunnel Test Run runs.
  const tunnel = { running: false, url: '', error: '', stop: null, kind: '', gen: 0, retries: 0, restartTimer: null, restartAt: 0, startedAt: 0 };
  const mode = () => app.team.mode;
  const address = () => (mode() === 'fixed' ? app.team.fixedUrl : tunnel.url) || '';
  const checks = { hosted: null, fixed: null }; // { url, ok, message, at }
  const hostedLive = () => !!(checks.hosted && checks.hosted.url === app.team.hostedUrl && checks.hosted.ok);
  const linkFor = (key) => inviteLink(app.team, address(), key, { hostedLive: hostedLive() });

  /** The linked automated suites, [{ id, name }], from sheets/.testrun/automation/suites.json ([] until one is linked). */
  function linkedSuites() {
    let data = null;
    try { data = JSON.parse(readFileSync(join(sheetsDir, '.testrun', 'automation', 'suites.json'), 'utf8')); } catch { return []; }
    const seen = new Set();
    return (data && Array.isArray(data.suites) ? data.suites : [])
      .filter((x) => x && typeof x.id === 'string' && x.id.trim() && !seen.has(x.id) && seen.add(x.id))
      .map((x) => ({ id: x.id, name: String(x.name || x.id) }));
  }

  function teamInfo(extra = {}) {
    const t = app.team;
    const fresh = (c, url) => (c && c.url === url ? c : null);
    return {
      ok: true,
      team: { enabled: t.enabled, mode: t.mode, sharing: t.sharing, fixedUrl: t.fixedUrl, tunnelName: t.tunnelName, hostedUrl: t.hostedUrl, publish: t.publish, gist: t.gist, publishedAt: t.publishedAt, publishedUrl: t.publishedUrl, publishError: t.publishError },
      address: {
        effective: address(),
        tunnel: { running: tunnel.running, url: tunnel.url, error: tunnel.error, kind: tunnel.kind, reconnectIn: tunnel.restartTimer ? Math.max(0, Math.round((tunnel.restartAt - Date.now()) / 1000)) : null, available: !!findCommand('cloudflared', tunnelBin) },
      },
      checks: { hosted: fresh(checks.hosted, t.hostedUrl), fixed: fresh(checks.fixed, t.fixedUrl) },
      suggest: { hostedUrl: pagesUrlFromRemote(gitRemote()), tailscaleUrl: tailscaleUrl(tailscaleBin), port: server.address() ? server.address().port : 5178 },
      canInvite: !!linkFor('k').link,
      admin: publicAdmin(t),
      people: publicPeople(t),
      suites: linkedSuites(), // for each person's Automated suites
      ...extra,
    };
  }

  /** Keep the gist pointing at the current address (when the owner asked for it). */
  async function publish() {
    const t = app.team;
    const url = address();
    if (!t.enabled || !t.publish || !url) return;
    if (t.gist && t.publishedUrl === url && !t.publishError) return;
    try {
      t.gist = await publishAddress({ gist: t.gist, url, ghPath });
      t.publishedAt = stamp();
      t.publishedUrl = url;
      t.publishError = '';
    } catch (e) {
      t.publishError = `Could not update the gist: ${e.message}`;
    }
    saveApp();
  }

  /** Is the hosted page really the console? (A github.com repository page, or a page not deployed yet, is not.) */
  async function checkHosted() {
    const url = app.team.hostedUrl;
    if (!url) { checks.hosted = null; return; }
    let res;
    if (/^https?:\/\/(www\.)?github\.com\//i.test(url)) {
      res = { ok: false, code: 'REPO_PAGE', message: 'This is a repository page on github.com, not a GitHub Pages site.' };
    } else {
      try {
        const r = await fetch(url.replace(/\/?$/, '/'), { signal: AbortSignal.timeout(6000), redirect: 'follow', headers: { 'cache-control': 'no-cache' } }); // as invite links open it
        const text = r.ok ? await r.text() : '';
        if (r.status === 404) res = { ok: false, code: 'NOT_LIVE', message: 'Not live yet: the address answers 404.' };
        else if (!r.ok) res = { ok: false, code: 'HTTP', message: `It answers ${r.status}.` };
        else if (!/name="test-run-console"/.test(text)) res = { ok: false, code: 'NOT_CONSOLE', message: 'Something is there, but it is not the Test Run console.' };
        else res = { ok: true, code: 'LIVE', message: 'Live.' };
      } catch (e) {
        res = { ok: false, code: 'UNREACHABLE', message: `Could not reach it (${(e.cause && e.cause.code) || e.name || e.message}).` };
      }
    }
    checks.hosted = { url, ...res, at: stamp() };
  }

  /** Does the fixed address reach this Test Run (and not something else)? */
  async function checkFixed() {
    const url = app.team.fixedUrl;
    if (!url) { checks.fixed = null; return; }
    let res;
    try {
      const r = await fetch(`${url}/api/status`, { headers: { 'X-Test-Run': '1' }, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null);
      if (j && j.app === 'test-run' && j.instance === INSTANCE) res = { ok: true, message: 'Reaches this Test Run.' };
      else if (j && j.app === 'test-run') res = { ok: false, message: 'It reaches a different Test Run (another host-server, or an earlier run).' };
      else res = { ok: false, message: `Something else answers there (${r.status}). Check the tunnel sends it to port ${server.address().port}.` };
    } catch (e) {
      res = { ok: false, message: `No answer (${(e.cause && e.cause.code) || e.name || e.message}). Is the tunnel for this address running?` };
    }
    checks.fixed = { url, ...res, at: stamp() };
  }

  function scheduleRestart() {
    clearTimeout(tunnel.restartTimer);
    const ms = restartDelays[Math.min(tunnel.retries, restartDelays.length - 1)];
    tunnel.retries++;
    tunnel.restartAt = Date.now() + ms;
    tunnel.restartTimer = setTimeout(() => {
      tunnel.restartTimer = null;
      if (app.team.enabled && app.team.sharing) startSharing();
    }, ms);
    if (tunnel.restartTimer.unref) tunnel.restartTimer.unref();
  }

  /** cloudflared exited by itself (sleep, a network change, too many failed reconnects): start it again. */
  function tunnelDropped(gen, code) {
    if (gen !== tunnel.gen) return; // stopped on purpose
    Object.assign(tunnel, { running: false, url: mode() === 'fixed' ? tunnel.url : '', stop: null });
    if (!app.team.enabled || !app.team.sharing) { tunnel.error = ''; return; }
    if (Date.now() - tunnel.startedAt > 120000) tunnel.retries = 0; // it had been up a while: retry quickly
    tunnel.error = `The tunnel dropped (cloudflared exited${code != null ? ` with code ${code}` : ''}). Reconnecting by itself.`;
    log(`Test Run: ${tunnel.error}`);
    scheduleRestart();
  }

  async function startSharing() {
    const t = app.team;
    if (!t.enabled) return;
    if (!t.sharing) { t.sharing = true; saveApp(); }
    if (tunnel.running) return;
    clearTimeout(tunnel.restartTimer);
    tunnel.restartTimer = null;
    const named = mode() === 'fixed' && t.tunnelName;
    if (mode() === 'fixed' && !named) { // the owner's own tunnel serves the fixed address; nothing to run here
      Object.assign(tunnel, { error: '', kind: '' });
      await publish();
      return;
    }
    if (named && !t.fixedUrl) { tunnel.error = 'Enter the fixed address your named tunnel serves first.'; return; }
    const gen = ++tunnel.gen;
    Object.assign(tunnel, { running: true, error: '', kind: named ? 'named' : 'quick' });
    try {
      const r = await startTunnel({ port: server.address().port, bin: tunnelBin, name: named ? t.tunnelName : '', url: named ? t.fixedUrl : '', onExit: (code) => tunnelDropped(gen, code) });
      if (gen !== tunnel.gen) { r.stop(); return; } // stopped while it was starting
      Object.assign(tunnel, { url: r.url, stop: r.stop, startedAt: Date.now(), error: '' });
      await publish();
    } catch (e) {
      if (gen !== tunnel.gen) return;
      Object.assign(tunnel, { running: false, url: '', stop: null, error: e.message });
      if (e.code !== 'NO_TUNNEL' && app.team.sharing) {
        scheduleRestart();
        tunnel.error = `${e.message} Trying again in ${Math.round((tunnel.restartAt - Date.now()) / 1000)} s.`;
      }
    }
  }

  /** Stop the tunnel. forget: also stop starting it with Test Run (the owner pressed Stop). */
  function stopSharing({ forget = true } = {}) {
    tunnel.gen++;
    clearTimeout(tunnel.restartTimer);
    tunnel.restartTimer = null;
    tunnel.retries = 0;
    const stop = tunnel.stop;
    Object.assign(tunnel, { running: false, url: '', stop: null, error: '', kind: '' });
    if (stop) stop();
    if (forget && app.team.sharing) { app.team.sharing = false; saveApp(); }
  }

  async function teamPost(path, body) {
    const t = app.team;
    if (path === '/api/team') {
      const was = { mode: t.mode, fixedUrl: t.fixedUrl, tunnelName: t.tunnelName, hostedUrl: t.hostedUrl };
      if (body.enabled != null) t.enabled = body.enabled === true;
      if (body.mode != null && MODES.includes(body.mode)) t.mode = body.mode;
      if (body.fixedUrl != null) {
        const u = cleanUrl(body.fixedUrl);
        if (body.fixedUrl && !u) return { ok: false, code: 'BAD_INPUT', error: 'The fixed address must start with https:// (or http://).' };
        t.fixedUrl = u;
      }
      if (body.tunnelName != null) {
        const n = cleanTunnelName(body.tunnelName);
        if (body.tunnelName && !n) return { ok: false, code: 'BAD_INPUT', error: 'A tunnel name has only letters, digits, dots, dashes and underscores.' };
        t.tunnelName = n;
      }
      if (body.hostedUrl != null) {
        const u = cleanUrl(body.hostedUrl);
        if (body.hostedUrl && !u) return { ok: false, code: 'BAD_INPUT', error: 'The hosted page must be an https:// address.' };
        if (/^https?:\/\/(www\.)?github\.com\//i.test(u)) return { ok: false, code: 'BAD_INPUT', error: 'That is a repository page on github.com. The hosted page is the GitHub Pages address, like https://owner.github.io/Repo/test-run/ (Pages must be turned on for the repository).' };
        t.hostedUrl = u;
      }
      if (body.publish != null) t.publish = body.publish === true;
      saveApp();
      if (!t.enabled) stopSharing({ forget: false });
      else if (t.sharing && (was.mode !== t.mode || was.tunnelName !== t.tunnelName || (t.tunnelName && was.fixedUrl !== t.fixedUrl))) {
        stopSharing({ forget: false }); // the way in changed: start it again the new way
        await startSharing();
      }
      if (was.hostedUrl !== t.hostedUrl) await checkHosted();
      if (was.fixedUrl !== t.fixedUrl && t.mode === 'fixed') await checkFixed();
      await publish();
      return teamInfo();
    }
    if (path === '/api/team/check') {
      await Promise.all([checkHosted(), t.mode === 'fixed' ? checkFixed() : null]);
      return teamInfo();
    }
    if (path === '/api/team/share') {
      if (body.on && !t.enabled) { t.enabled = true; saveApp(); }
      if (body.on) { await startSharing(); if (t.mode === 'fixed') await checkFixed(); } else stopSharing();
      return teamInfo();
    }
    // A link is shown once, so make one only when it can find this laptop.
    if ((path === '/api/team/people' || path === '/api/team/people/link' || path === '/api/team/admin' || body.rotate) && t.hostedUrl && !hostedLive()) await checkHosted();
    const noLink = () => { const w = linkFor('k'); return w.link ? null : { ok: false, code: 'NO_ADDRESS', error: w.warning }; };
    if (path === '/api/team/admin') {
      // The owner's own link: everything the laptop can do, from another computer.
      if (body.action === 'remove') { t.admin = null; saveApp(); return teamInfo(); }
      if (noLink()) return noLink();
      let key = t.admin && t.admin.key;
      if (body.action === 'new' || !key) key = newAdminKey(t, stamp());
      saveApp();
      const inv = linkFor(key);
      return teamInfo({ link: inv.link, linkWarning: inv.warning });
    }
    if (path === '/api/team/people') {
      if (!clip(body.name, 80)) return { ok: false, code: 'BAD_INPUT', error: 'Give the person a name.' };
      if (noLink()) return noLink();
      const books = cleanBooks(body.books);
      if (books && !books.some((n) => lib.list().some((b) => b.name === n))) return { ok: false, code: 'BAD_INPUT', error: 'Choose a workbook, or All workbooks.' };
      const { person, key } = addPerson(t, { name: body.name, role: body.role, books }, stamp());
      saveApp();
      const inv = linkFor(key);
      return teamInfo({ person: { id: person.id, name: person.name, role: person.role }, link: inv.link, linkWarning: inv.warning });
    }
    const p = t.people.find((x) => x.id === body.id);
    if (!p) return { ok: false, code: 'GONE', error: 'That person is not in the team any more.' };
    if (path === '/api/team/people/update') {
      if (body.role != null) setRole(p, body.role); // View only turns Start runs off
      if (body.books !== undefined) {
        const books = cleanBooks(body.books);
        if (books && !books.some((n) => lib.list().some((b) => b.name === n))) return { ok: false, code: 'BAD_INPUT', error: 'Choose a workbook, or All workbooks.' };
        p.books = books;
      }
      let extra = {};
      if (body.rotate) {
        if (noLink()) return noLink();
        const inv = linkFor(rotateKey(p));
        extra = { link: inv.link, linkWarning: inv.warning };
      }
      saveApp();
      return teamInfo(extra);
    }
    if (path === '/api/team/people/automation') {
      // What a person may do with automated suites: whose results they see, and whether they start runs.
      const { automationSuites: suites, startRuns } = body;
      if (suites === undefined && startRuns === undefined) return { ok: false, code: 'BAD_INPUT', error: 'Choose their automated suites, or whether they start runs.' };
      if (suites !== undefined) {
        const known = new Set(linkedSuites().map((x) => x.id));
        const ok = suites === 'all' || suites === 'none' || (Array.isArray(suites) && suites.every((id) => typeof id === 'string' && known.has(id)));
        if (!ok) return { ok: false, code: 'BAD_INPUT', error: 'Choose a linked suite, All suites or None.' };
      }
      if (startRuns !== undefined && typeof startRuns !== 'boolean') return { ok: false, code: 'BAD_INPUT', error: 'Start runs is on or off.' };
      if (startRuns === true && p.role === 'viewer') return { ok: false, code: 'BAD_INPUT', error: `${p.name} has View only, which never starts runs. Give them Update status first.` };
      if (suites !== undefined) p.automationSuites = cleanSuites(suites);
      if (startRuns !== undefined) p.startRuns = startRuns;
      saveApp();
      return teamInfo();
    }
    if (path === '/api/team/people/link') {
      // The person's link again, as it is now (current address, hosted page, gist)
      if (!p.key) return { ok: false, code: 'NO_KEY', error: `${p.name}'s link was made before links could be copied again. Make a new link once; after that it can be copied any time.` };
      if (noLink()) return noLink();
      const inv = linkFor(p.key);
      return teamInfo({ link: inv.link, linkWarning: inv.warning, person: { id: p.id, name: p.name, role: p.role } });
    }
    if (path === '/api/team/people/remove') {
      t.people = t.people.filter((x) => x !== p);
      saveApp();
      return teamInfo();
    }
    return { ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' };
  }


  // -------------------------------------------------------------------------
  // Publishing to GitHub (the host only): the workbooks, their sidecar files and
  // the reports, as the one commit of the data branch (lib/publish.mjs, replace
  // mode), then the Pages workflow is started. Anyone can read the reports on
  // the GitHub Pages site, and someone else can carry on from a clone.
  // -------------------------------------------------------------------------

  // head: the data branch's tip when last read (null: no such branch yet; undefined: not known)
  const pub = { running: null, remote: null, remoteAt: 0, head: undefined, info: null, space: null, spaceRunning: null, timers: [] };
  const PUBLISHED = `${(publishPrefix || repoPrefix()).replace(/\/?$/, '/')}published`; // before the data branch: on the default branch
  const DATA = dataPrefix ? dataPrefix.replace(/^\/+/, '').replace(/\/?$/, '/') : ''; // where in the data branch ('' its root)
  const reportsCache = join(sheetsDir, '.testrun', 'published'); // the last published reports, served at /reports/
  const repoOf = () => repoOverride || repoFromRemote(gitRemote());
  const p2 = (n) => String(n).padStart(2, '0');

  async function repoContext() {
    const r = repoOf();
    if (!r) throw err('NO_REPO', 'This copy of Test Run is not in a GitHub repository, so there is nowhere to publish.');
    const cmd = ghCommand(ghPath);
    if (!pub.info) pub.info = await repoInfo({ cmd, ...r });
    return { cmd, ...r, branch: pub.info.defaultBranch, info: pub.info };
  }

  /**
   * What is published on GitHub now (its index), or null. Never throws. It reads the data
   * branch at its tip; until that branch exists, the old folder on the default branch.
   */
  async function remoteIndex() {
    try {
      const c = await repoContext();
      const head = await readRef({ ...c, branch: dataBranch });
      const buf = head
        ? await readRemoteFile({ ...c, ref: head, path: `${DATA}reports/index.json` })
        : await readRemoteFile({ ...c, ref: c.branch, path: `${PUBLISHED}/reports/index.json` });
      pub.head = head;
      pub.remote = buf ? JSON.parse(buf.toString('utf8')) : null;
      pub.remoteAt = Date.now();
      return pub.remote;
    } catch {
      pub.head = undefined;
      return null;
    }
  }

  /** Where the published files are read from on GitHub: the data branch's tip, or (before it exists) the default branch's old folder. */
  const remoteSource = (c) => (pub.head ? { ref: pub.head, root: DATA } : { ref: c.branch, root: `${PUBLISHED}/` });

  const parseIndex = (buf) => { try { const i = buf && JSON.parse(buf.toString('utf8')); return i && Array.isArray(i.workbooks) ? i : null; } catch { return null; } };
  const git = (args) => execFileSync('git', ['-C', cloneDir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 10000 });
  /** A file of the clone's copy of a ref, or null. */
  const gitShow = (ref, path) => { try { return git(['show', `${ref}:${path}`]); } catch { return null; } };
  let localCache = { at: 0, value: null };
  /**
   * The published data in this clone, or null: { index, read(path) -> Buffer | null }, path
   * relative to the data ("workbooks/…", "reports/…"). It is the clone's copy of the data
   * branch (origin/test-run-data, as of the clone or the last fetch); before that branch
   * existed, the published folder of this checkout.
   */
  function localData() {
    if (Date.now() - localCache.at < 5000) return localCache.value;
    let value = null;
    for (const ref of [`refs/remotes/origin/${dataBranch}`, `refs/heads/${dataBranch}`]) {
      try { git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { continue; }
      const index = parseIndex(gitShow(ref, `${DATA}reports/index.json`));
      if (index) { value = { index, read: (p) => gitShow(ref, DATA + p) }; break; }
    }
    if (!value) {
      const read = (p) => { const f = join(publishedDir, ...p.split('/')); return existsSync(f) ? readFileSync(f) : null; };
      const index = parseIndex(read('reports/index.json'));
      if (index) value = { index, read };
    }
    localCache = { at: Date.now(), value };
    return value;
  }
  /** For a fresh clone's host: who published the data in it, when, and which workbooks. */
  const localOffer = () => { const d = localData(); return d ? { by: d.index.by, at: d.index.publishedAt, workbooks: d.index.workbooks.map((w) => w.name) } : null; };
  const manualTabs = (boot) => boot.tabs.filter((t) => ((t.saved && t.saved.role) || t.detected.role) === 'manual');
  const cleanReport = (r) => { const { excelOpen, reloaded, ok, ...rest } = r; return rest; };

  // Locked automated results (lib/automation/seal.mjs): the kept runs attached to the workbooks
  // being published, each locked to the people who may open it. Sealed runs are cached, so an
  // unchanged run publishes the same bytes; one build at a time (the space meter builds too).
  const sealCache = new SealCache(join(sheetsDir, '.testrun', 'automation', 'sealed'));
  let sealChain = Promise.resolve();
  /** The host's own age identity (made once, kept in app.json, which only the host can read). */
  async function hostIdentity() {
    if (!app.lock.identity) { app.lock = { identity: await newIdentity() }; saveApp(); }
    return app.lock.identity;
  }
  /** The automation/ files of a publish. slugs: { workbook name: slug } of the workbooks it holds. */
  function automationFiles(slugs) {
    const job = sealChain.then(async () => {
      const store = automation.store;
      const index = store.index();
      const me = { ...owner(), remember: false };
      const caseIds = new Map(); // workbook › test suite -> its live case IDs ("Manual cases also run by automation")
      const items = [];
      for (const m of index) {
        if (!slugs[m.attach.book]) continue;
        const run = store.run(m.id);
        if (!run) continue;
        const k = `${m.attach.book}\n${m.attach.tab}`;
        if (!caseIds.has(k)) caseIds.set(k, liveCaseIds(await callApi('api_loadTab', [m.attach.tab, ''], m.attach.book, me)));
        const prevMeta = previousRun(index, m);
        const prev = prevMeta ? store.run(prevMeta.id) : null;
        const who = await recipientsFor(m, { team: app.team, hostIdentity: await hostIdentity() });
        items.push({ id: m.id, slug: slugs[m.attach.book], meta: publishedMeta(store, m, run, prev, caseIds.get(k)), detail: runDetailData(store, m, run, prev), recipients: who.map((r) => r.recipient) });
      }
      const out = await sealRuns(items, { cache: sealCache, prefix: DATA });
      // and what everyone sees without an invite link: the figures only, not locked (everyone.json)
      const kept = new Set(out.index.runs.map((r) => r.id));
      if (kept.size) out.files.push({ path: `${DATA}${EVERYONE}`, content: Buffer.from(JSON.stringify(everyoneSummary(items.filter((it) => kept.has(it.id))), null, 1)) });
      return out;
    });
    sealChain = job.then(() => {}, () => {});
    return job;
  }

  /** Everything one publish holds ([{ path, content }]) and its index. */
  async function buildPublish() {
    const me = { ...owner(), remember: false };
    const index = { app: 'test-run', id: newPublishId(), publishedAt: stamp(), by: app.user, workbooks: [] };
    const files = [];
    const slugs = {};
    for (const b of lib.list()) {
      if (!app.publish.books[b.name]) continue;
      const boot = await callApi('api_bootstrap', [], b.name, me);
      if (!boot.ok) continue;
      const slug = slugFor(b.name);
      const title = b.name.replace(/\.xlsx$/i, '');
      const suites = [];
      for (const t of manualTabs(boot)) {
        const cur = await callApi('api_summary', [t.name, ''], b.name, me);
        if (!cur.ok) continue;
        const summaries = {};
        for (const c of cur.cycles) {
          const one = c.label === cur.cycle ? cur : await callApi('api_summary', [t.name, c.label], b.name, me);
          if (one.ok) summaries[c.label] = cleanReport(one);
        }
        suites.push({ tab: t.name, current: cur.cycle, cycles: cur.cycles.map((c) => c.label), summaries });
      }
      const report = { app: 'test-run', book: b.name, title, slug, sheetName: boot.sheetName, publishedAt: index.publishedAt, by: index.by, suites };
      // the workbook and its sidecar as saved (every change is saved at once), for whoever carries on
      files.push({ path: `${DATA}workbooks/${b.name}`, content: readFileSync(lib.path(b.name)) });
      const side = lib.storeFile(b.name);
      if (existsSync(side)) files.push({ path: `${DATA}workbooks/.testrun/${basename(side)}`, content: readFileSync(side) });
      files.push({ path: `${DATA}reports/${slug}.json`, content: Buffer.from(JSON.stringify(report)) });
      files.push({ path: `${DATA}reports/${slug}.xlsx`, content: await downloadCopy(b.name) }); // the Download on the reports page
      index.workbooks.push({ name: b.name, title, slug, suites: suites.map((x) => x.tab), xlsx: true });
      slugs[b.name] = slug;
    }
    files.push({ path: `${DATA}reports/index.json`, content: Buffer.from(JSON.stringify(index, null, 1)) });
    const auto = await automationFiles(slugs); // automation/: the locked automated results, and everyone.json
    files.push(...auto.files);
    return { files, index, automation: auto.index };
  }

  // Space on GitHub Pages: what a publish puts on the site (the data branch's reports/: a download
  // copy of each workbook and its reports; later automation/), against the 1 GB a Pages site may use.
  const PAGES_LIMIT = 1024 ** 3;
  const PAGES_WARN = 800 * 1024 ** 2;
  function spaceOf(files) {
    const parts = { workbooks: 0, reports: 0, automation: 0 };
    for (const f of files) {
      const p = f.path.slice(DATA.length);
      if (p.startsWith('reports/')) parts[p.endsWith('.xlsx') ? 'workbooks' : 'reports'] += f.content.length;
      else if (p.startsWith('automation/')) parts.automation += f.content.length;
    }
    const total = parts.workbooks + parts.reports + parts.automation;
    return { total, limit: PAGES_LIMIT, warnAt: PAGES_WARN, warn: total > PAGES_WARN, parts };
  }
  const fileStamp = (f) => { try { const s = statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return ''; } };
  /** Who may open the published automated results: changes with links, people and their access. */
  const lockSig = () => createHash('sha256').update(JSON.stringify([app.team.admin && app.team.admin.key, app.team.people.map((p) => [p.key, p.role, p.books, p.automationSuites])])).digest('hex');
  /** Changes when what a publish would hold changes: the ticked workbooks and their files, the kept runs, who may open them. */
  const spaceKey = () => JSON.stringify([
    lib.list().filter((b) => app.publish.books[b.name]).map((b) => [b.name, fileStamp(lib.path(b.name)), fileStamp(lib.storeFile(b.name))]),
    automation.store.index().filter((m) => app.publish.books[m.attach.book]).map((m) => [m.id, m.bytes, m.attach.book, m.attach.tab, m.attach.cycle]),
    lockSig(),
  ]);
  async function publishSpace() {
    const key = spaceKey();
    if (pub.space && pub.space.key === key) return { ok: true, ...pub.space.value };
    if (!pub.spaceRunning) {
      pub.spaceRunning = buildPublish()
        .then(({ files }) => { pub.space = { key, value: spaceOf(files) }; })
        .finally(() => { pub.spaceRunning = null; });
    }
    await pub.spaceRunning;
    return { ok: true, ...pub.space.value };
  }

  /**
   * The workbook as people download it: a copy as saved, with a Known issues sheet added and rows
   * grown to fit wrapped text (a Google Sheets download keeps every row one line high). Deprecated and
   * duplicate cases stay in it, struck out, with "Deprecated: <reason>" in their comment. The file
   * itself is not changed.
   */
  function downloadCopy(name, user) {
    return serial(async () => {
      const entry = await lib.get(name);
      const copy = await XBook.fromBuffer(await entry.book.toBuffer(), entry.name);
      current = { book: copy, store: entry.store };
      rt.state.user = user || app.user;
      try {
        rt.call('api_writeIssuesSheet'); // retired cases stay, as in the workbook: struck out, the comment saying why
      } finally { current = null; }
      copy.fitRowHeights();
      return Buffer.from(await copy.toBuffer());
    });
  }

  /**
   * Keep the reports of the last publish on the laptop too, served at /reports/ (for visitors without a key),
   * and its locked automated results, served at /automation/ (they open only with an invite key, as on the site).
   */
  function writeReportsCache(files) {
    mkdirSync(reportsCache, { recursive: true });
    const keep = new Set();
    for (const f of files) {
      if (!f.path.startsWith(`${DATA}reports/`)) continue;
      const name = basename(f.path);
      keep.add(name);
      writeFileSync(join(reportsCache, name), f.content);
    }
    for (const f of readdirSync(reportsCache)) if (/\.(json|xlsx)$/.test(f) && !keep.has(f)) unlinkSync(join(reportsCache, f));
    rmSync(join(reportsCache, 'automation'), { recursive: true, force: true });
    for (const f of files) {
      const p = f.path.slice(DATA.length);
      if (!f.path.startsWith(DATA) || !isAutomationPath(p)) continue;
      const out = join(reportsCache, ...p.split('/'));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, f.content);
    }
  }

  /** Start the Pages workflow on the default branch, so the site is built again from it and the data branch. Resolves '' or what went wrong. */
  async function updateSite(c) {
    try {
      await dispatchWorkflow({ ...c, workflow: pagesWorkflow, ref: c.branch });
      return '';
    } catch (e) {
      return `Published, but the GitHub Pages site was not updated (${e.message}). Publish again, or run the “Test Run page” workflow in the repository’s Actions tab.`;
    }
  }

  async function publishNow({ confirmPublic = false, force = false, auto = false } = {}) {
    if (pub.running) return pub.running;
    pub.running = (async () => {
      const P = app.publish;
      // With nothing ticked, publishing takes everything published down (after it was published once)
      if (!lib.list().some((b) => P.books[b.name]) && !P.acknowledged) return { ok: false, code: 'NOTHING', error: 'Tick at least one workbook to publish.' };
      if (!P.acknowledged && !confirmPublic) {
        return { ok: false, code: 'CONFIRM_PUBLIC', error: 'Publishing puts the ticked workbooks, their findings and their reports in the public repository: anyone can read them, and copy them.' };
      }
      let c;
      try { c = await repoContext(); } catch (e) { return { ok: false, code: e.code || 'NO_REPO', error: e.message }; }
      /** Someone else published after this laptop last published or got the data: say who, and do not replace it unasked. */
      const newer = (remote, fallback) => {
        const res = { ok: false, code: 'NEWER_REMOTE', remote: remote ? { by: remote.by, at: remote.publishedAt } : {}, error: remote && remote.publishedAt ? `${remote.by || 'Someone'} published at ${remote.publishedAt}, after this host-server last published or got the data. Publishing now replaces their copy.` : `${fallback} Publishing now replaces their copy.` };
        if (auto) { P.last = { ...P.last, error: `Not published by itself: ${res.error}` }; saveApp(); }
        return res;
      };
      const remote = await remoteIndex();
      if (!force && remote && remote.id && remote.id !== P.knownId) return newer(remote);
      const seenHead = pub.head; // the data branch as just read; it must not move before this publish replaces it
      const { files, index } = await buildPublish();
      try {
        const res = await publishFiles({
          ...c,
          branch: dataBranch,
          files,
          replace: true, // one commit with no parent: the branch holds this publish only
          expectHead: force ? undefined : seenHead,
          message: index.workbooks.length
            ? `Test Run: publish ${index.workbooks.map((w) => w.title).join(', ')} (${index.publishedAt}, ${index.by})`
            : `Test Run: take the published reports down (${index.publishedAt}, ${index.by})`,
          // reports differ by their time stamp alone; automation/index.json changes only with the sealed files it lists
          minor: (path) => path.startsWith(`${DATA}reports/`) || path === `${DATA}automation/index.json`,
        });
        writeReportsCache(files);
        pub.space = { key: spaceKey(), value: spaceOf(files) };
        P.acknowledged = true;
        if (res.commit) {
          const n = res.changed.length;
          P.knownId = index.id;
          pub.remote = index; // what GitHub has now is what was just published (not news to this laptop)
          pub.remoteAt = Date.now();
          pub.head = res.commit;
          P.last = { at: index.publishedAt, by: index.by, commit: res.commit, url: res.url, error: '', pagesError: await updateSite(c), note: `${n} file${n === 1 ? '' : 's'} updated${res.removed.length ? `, ${res.removed.length} removed` : ''}${auto ? ' (by itself)' : ''}.` };
        } else {
          if (remote && remote.id) P.knownId = remote.id; // the same data as what is there
          // the site was not updated after the last publish: try again
          P.last = { ...P.last, error: '', pagesError: P.last.pagesError ? await updateSite(c) : '', note: 'Nothing changed since the last publish.' };
        }
        saveApp();
        return { ok: true, committed: !!res.commit, url: res.url || '', changed: res.changed, removed: res.removed, note: P.last.note, pagesError: P.last.pagesError };
      } catch (e) {
        if (e.code === 'NEWER_REMOTE') { const now = await remoteIndex(); return newer(now && now.id !== P.knownId ? now : null, e.message); }
        P.last = { ...P.last, error: `Could not publish: ${e.message}` };
        saveApp();
        return { ok: false, code: 'PUBLISH_FAILED', error: P.last.error };
      }
    })().finally(() => { pub.running = null; });
    return pub.running;
  }

  async function publishStatus({ refresh = false } = {}) {
    const P = app.publish;
    const r = repoOf();
    let ctx = null;
    let problem = '';
    try { ctx = await repoContext(); } catch (e) { problem = e.message; }
    if (ctx && (refresh || Date.now() - pub.remoteAt > 5 * 60000)) await remoteIndex();
    const remote = pub.remote;
    return {
      ok: true,
      repo: r ? `${r.owner}/${r.repo}` : '',
      branch: ctx ? ctx.branch : '', // the default branch: the site's page comes from it
      dataBranch, // where publishing goes: one commit, replaced each time
      folder: DATA.replace(/\/$/, ''), // in the data branch ('' its root)
      dataBranchExists: pub.head === undefined ? null : !!pub.head, // null: not known
      oldFolder: PUBLISHED, // read until the data branch exists
      isPrivate: ctx ? ctx.info.private : null,
      problem,
      pagesUrl: pagesUrlFromRemote(gitRemote()),
      books: lib.list().map((b) => ({ name: b.name, on: !!P.books[b.name] })),
      settings: { nightly: P.nightly, time: P.time },
      acknowledged: P.acknowledged,
      last: P.last,
      remote: remote ? { id: remote.id || '', by: remote.by || '', at: remote.publishedAt || '', workbooks: (remote.workbooks || []).map((w) => w.name) } : null,
      newer: !!(remote && remote.id && remote.id !== P.knownId),
      // the kept automated runs of the ticked workbooks: published locked, for invited people only
      automation: { runs: automation.store.index().filter((m) => P.books[m.attach.book]).length },
    };
  }

  /** Put a workbook (and its sidecar) into the sheets folder, keeping a copy of what was there. */
  async function installWorkbook(name, xlsx, side) {
    const backups = join(sheetsDir, '.testrun', 'backups');
    const when = stamp().replace(/[: ]/g, '-');
    const file = lib.path(name);
    const sideFile = lib.storeFile(name);
    mkdirSync(backups, { recursive: true });
    if (existsSync(file)) copyFileSync(file, join(backups, `${name.replace(/\.xlsx$/i, '')} before-get ${when}.xlsx`));
    if (existsSync(sideFile)) copyFileSync(sideFile, join(backups, `${basename(sideFile, '.json')} before-get ${when}.json`));
    await serial(async () => {
      await lib.importFile(name, xlsx, { overwrite: true }); // checks it is a real workbook, writes it safely, forgets the open copy
      if (side) { JSON.parse(side.toString('utf8')); writeFileSync(sideFile, side); }
      lib.open.delete(name);
    });
  }

  /** Get what is published on GitHub now into the sheets folder (when someone else published since). */
  async function getLatest() {
    let c;
    try { c = await repoContext(); } catch (e) { return { ok: false, code: e.code || 'NO_REPO', error: e.message }; }
    const remote = await remoteIndex();
    if (!remote || !(remote.workbooks || []).length) return { ok: false, code: 'NOTHING', error: 'Nothing is published on GitHub yet.' };
    const src = remoteSource(c); // every file from the same commit as the index
    const got = [];
    for (const w of remote.workbooks) {
      if (!isWorkbookName(w.name)) continue;
      const xlsx = await readRemoteFile({ ...c, ref: src.ref, path: `${src.root}workbooks/${w.name}` });
      if (!xlsx) continue;
      const side = await readRemoteFile({ ...c, ref: src.ref, path: `${src.root}workbooks/.testrun/${w.name.replace(/\.xlsx$/i, '')}.json` });
      await installWorkbook(w.name, xlsx, side);
      app.publish.books[w.name] = true;
      got.push(w.name);
    }
    const files = [{ path: `${DATA}reports/index.json`, content: Buffer.from(JSON.stringify(remote)) }];
    for (const w of remote.workbooks) {
      if (!/^[\w.-]+$/.test(String(w.slug || ''))) continue;
      for (const ext of ['json', 'xlsx']) {
        const rep = await readRemoteFile({ ...c, ref: src.ref, path: `${src.root}reports/${w.slug}.${ext}` });
        if (rep) files.push({ path: `${DATA}reports/${w.slug}.${ext}`, content: rep });
      }
    }
    // the locked automated results published with them, as they are (only invited people open them)
    const autoIndex = await readRemoteFile({ ...c, ref: src.ref, path: `${src.root}automation/index.json` });
    if (autoIndex) {
      files.push({ path: `${DATA}automation/index.json`, content: autoIndex });
      const everyone = await readRemoteFile({ ...c, ref: src.ref, path: `${src.root}${EVERYONE}` });
      if (everyone) files.push({ path: `${DATA}${EVERYONE}`, content: everyone });
      let runs = [];
      try { runs = JSON.parse(autoIndex.toString('utf8')).runs || []; } catch { runs = []; }
      for (const r of runs) {
        if (!RUN_ID.test(String(r && r.id))) continue;
        for (const f of SEALED_FILES) {
          const buf = await readRemoteFile({ ...c, ref: src.ref, path: `${src.root}automation/${r.id}/${f}` });
          if (buf) files.push({ path: `${DATA}automation/${r.id}/${f}`, content: buf });
        }
      }
    }
    writeReportsCache(files);
    app.publish.knownId = remote.id || '';
    pub.remote = remote;
    pub.remoteAt = Date.now();
    saveApp();
    return { ok: true, books: got, by: remote.by, at: remote.publishedAt };
  }

  /** A fresh clone: start from the data published in it (its copy of the data branch, or the old folder). */
  async function startFromLocal() {
    localCache.at = 0;
    const data = localData();
    const idx = data && data.index;
    if (!idx || !idx.workbooks.length) return { ok: false, code: 'NOTHING', error: 'There is no published data in this copy.' };
    const got = [];
    for (const w of idx.workbooks) {
      if (!isWorkbookName(w.name)) continue;
      const xlsx = data.read(`workbooks/${w.name}`);
      if (!xlsx) continue;
      await installWorkbook(w.name, xlsx, data.read(`workbooks/.testrun/${w.name.replace(/\.xlsx$/i, '')}.json`));
      app.publish.books[w.name] = true;
      got.push(w.name);
    }
    if (!got.length) return { ok: false, code: 'NOTHING', error: 'The published workbooks are missing from this copy.' };
    app.publish.knownId = idx.id || '';
    app.last = { book: got[0], tab: '', cycle: '' };
    saveApp();
    return { ok: true, books: got, by: idx.by, at: idx.publishedAt };
  }

  async function publishPost(path, body) {
    const P = app.publish;
    if (path === '/api/publish/settings') {
      if (body.books && typeof body.books === 'object') for (const [k, v] of Object.entries(body.books)) { if (!isWorkbookName(k)) continue; if (v) P.books[k] = true; else delete P.books[k]; }
      if (body.nightly != null) P.nightly = body.nightly === true;
      if (body.time != null) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) return { ok: false, code: 'BAD_INPUT', error: 'Give the time as HH:MM, for example 17:00.' };
        P.time = String(body.time);
      }
      saveApp();
      return publishStatus();
    }
    if (path === '/api/publish/now') {
      const r = await publishNow({ confirmPublic: body.confirmPublic === true, force: body.force === true });
      return { ...(await publishStatus()), result: r, ok: r.ok, code: r.code, error: r.error };
    }
    if (path === '/api/publish/get-latest') { const r = await getLatest(); return { ...(await publishStatus()), result: r, ok: r.ok, code: r.code, error: r.error }; }
    if (path === '/api/publish/start-from-local') return startFromLocal();
    return { ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' };
  }

  /** Every minute: publish by itself once a day, after the set time (only once the host has published by hand). */
  function publishTick(now = new Date()) {
    const P = app.publish;
    if (!P.acknowledged || !P.nightly) return null;
    const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    if (`${p2(now.getHours())}:${p2(now.getMinutes())}` < P.time || P.autoDate === day) return null;
    P.autoDate = day;
    saveApp();
    return publishNow({ auto: true });
  }

  /** Where someone opens the console: the hosted page if there is one, else the shared address. */
  function consoleUrl(person) {
    if (person.local) return `http://127.0.0.1:${server.address().port}/`;
    return (hostedLive() && app.team.hostedUrl) || (address() ? `${address()}/` : '');
  }

  /** Every test case tab of every workbook, for Bug Reporter's "which suite?" choice. */
  async function suites(person) {
    const out = [];
    for (const b of booksFor(person)) {
      const boot = await callApi('api_bootstrap', [], b.name, { ...person, remember: false });
      if (!boot.ok) continue;
      const tabs = boot.tabs.filter((x) => ((x.saved && x.saved.role) || x.detected.role) === 'manual').map((x) => x.name);
      if (tabs.length) out.push({ book: b.name, tabs });
    }
    return { ok: true, suites: out, current: { book: app.last.book || '', tab: app.last.tab || '' } };
  }

  /** The test cases of one suite, for Bug Reporter's "which test case?" choice (retired ones left out). */
  async function suiteCases(book, tab, person) {
    const res = await callApi('api_loadTab', [tab], book, { ...person, remember: false });
    if (!res.ok) return res;
    const ci = res.cycleIdx;
    return {
      ok: true,
      book: res.book,
      tab: res.tab,
      cycle: ci >= 0 ? res.cycles[ci].label : '',
      // what a form for a new case in this suite needs: its columns, result values, comment column
      fields: res.fields,
      statusOptions: res.statusOptions,
      hasCycle: ci >= 0,
      hasComment: ci >= 0 ? !!res.cycles[ci].hasComment : false,
      cases: res.cases.filter((c) => !c.retired).map((c) => ({ key: c.key, id: c.id, scenario: clip(c.scenario, 160), status: ci >= 0 ? c.statuses[ci] || '' : '', group1: c.group1, group2: c.group2, testType: c.testType })),
    };
  }

  async function noteBug(body, person) {
    const title = clip(body.title, 1000);
    if (!title) return { ok: false, code: 'BAD_INPUT', error: 'The bug needs a title.' };
    const number = String(body.number || '').replace(/\D/g, '').slice(0, 8);
    const url = /^https:\/\//i.test(String(body.url || '')) ? clip(body.url, 500) : '';
    const priority = clip(body.priority, 40);
    const details = [
      body.description && clip(body.description, 2000),
      body.actual && `Actual: ${clip(body.actual, 1500)}`,
      body.expected && `Expected: ${clip(body.expected, 1500)}`,
      body.extra && `Notes: ${clip(body.extra, 800)}`,
      body.pageUrl && `Page: ${clip(body.pageUrl, 300)}`,
    ].filter(Boolean).join('\n');
    // The suite chosen in Bug Reporter (workbook + tab), else the one open in Test Run.
    if (body.book && !mayOpen(person, body.book)) return { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you. Ask your test lead.' };
    const list = (await suites(person)).suites;
    const suite = list.find((x) => x.book === body.book) || list.find((x) => x.book === app.last.book) || list[0];
    if (!suite) return { ok: false, code: 'NO_BOOK', error: 'Test Run has no workbook with test cases yet.' };
    const tab = suite.tabs.includes(body.tab) ? body.tab : suite.tabs.includes(app.last.tab) ? app.last.tab : suite.tabs[0];
    const caseKey = clip(body.caseKey, 200);
    if (caseKey) {
      // A bug against a test case: the case is marked failed, with the bug linked to it.
      if (!url) return { ok: false, code: 'BAD_INPUT', error: 'The bug link is needed to link it to a test case.' };
      if (body.tab && tab !== body.tab) return { ok: false, code: 'NO_TAB', error: `The tab "${body.tab}" is not a test suite in Test Run any more.` };
      const res = await callApi('api_linkBug', [{ tab, key: caseKey, url, title, priority }], suite.book, { ...person, remember: false });
      if (!res.ok) return res;
      return { ok: true, kind: 'case', key: res.id || res.key, book: res.book, tab, cycle: res.cycle, status: res.status, previous: res.previous };
    }
    const res = await callApi('api_saveFinding', [{ text: title, issue: number ? `#${number}` : '', url, tab, area: clip(body.module, 160), details, source: 'bug-reporter', priority }], suite.book, { ...person, remember: false });
    if (!res.ok) return res;
    return { ok: true, kind: 'finding', key: res.finding.key, book: res.book, tab };
  }

  // Titles, states and priorities of GitHub issues, filled in from GitHub in the background.
  const issueFetch = new Map(); // book -> running promise
  const STALE_FAIL_MS = 6 * 3600 * 1000;
  function fetchIssues(book, issues, all) {
    const todo = issues.filter((e) => isGithubIssue(e.url) && (all || (!e.title && !(e.fetchError && Date.now() - Date.parse(String(e.fetchedAt).replace(' ', 'T')) < STALE_FAIL_MS))));
    if (!todo.length || issueFetch.has(book) || !findCommand('gh', ghPath)) return issueFetch.has(book) ? -1 : 0;
    const run = (async () => {
      for (const e of todo) {
        let meta;
        try {
          const g = await githubIssue(e.url, { ghPath });
          meta = { key: e.key, title: g.title, state: g.state, labels: g.labels, fetchedAt: stamp(), fetchError: '' };
          if (g.priority) meta.priority = g.priority; // a priority typed here is kept when GitHub has none
        } catch (err2) {
          meta = { key: e.key, fetchedAt: stamp(), fetchError: err2.message };
        }
        await callApi('api_saveIssueMeta', [[meta]], book, { ...owner(), remember: false });
      }
    })().catch((e) => log(e)).finally(() => issueFetch.delete(book));
    issueFetch.set(book, run);
    return todo.length;
  }

  async function listIssues(body, person, { refresh = false } = {}) {
    const res = await callApi('api_listIssues', [], body.book, { ...person, remember: false });
    if (!res.ok) return res;
    const n = fetchIssues(res.book, res.issues, refresh);
    return { ...res, fetching: n !== 0 || issueFetch.has(res.book), github: !!findCommand('gh', ghPath) };
  }

  async function exportSummary(body, person) {
    const s = await callApi('api_summary', [body.tab, body.cycle || ''], body.book, { ...person, remember: false });
    if (!s.ok) return s;
    const when = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `${s.sheetName} - ${s.tab}${s.cycle ? ` - ${s.cycle}` : ''} - ${when}.html`.replace(/[\\/:*?"<>|\0]/g, '_');
    const html = summaryPage(s);
    if (!person.local) return { ok: true, name, html };
    const dir = join(sheetsDir, 'exports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), html); // a copy stays on the laptop too
    return { ok: true, name, html, file: join(dir, name) };
  }

  // -------------------------------------------------------------------------
  // Test Run Extension: what each person is testing, the media limits, evidence
  // -------------------------------------------------------------------------

  /** What each person has open in Test Run (workbook, suite, cycle, case), for the extension to follow. */
  const selections = new Map();
  const whoKey = (person) => (isOwnerPerson(person) ? 'owner' : `p:${person.id}`);

  /** Evidence as the pages see it: no paths on the laptop. */
  const itemOut = (it) => ({ name: it.name, size: it.size, kind: it.kind, by: it.by, at: it.at, usedFor: it.usedFor || '', fresh: !!it.fresh });
  /** A case's files: { photo?, video? }. */
  const filesOut = (byKind) => { const o = {}; for (const [k, it] of Object.entries(byKind || {})) o[k] = itemOut(it); return o; };
  /** { caseKey: { photo?, video? } } */
  const evidenceOut = (map) => { const out = {}; for (const [ck, byKind] of Object.entries(map)) out[ck] = filesOut(byKind); return out; };

  /** The case's comment names the files that back its result: "Evidence: a.png, b.mp4" (none: no line). */
  function writeEvidenceNote(book, tab, cycle, key, person) {
    const used = Object.values(evidence.forCase(book, tab, cycle, key)).filter((x) => x.usedFor);
    return callApi('api_setEvidenceNote', [{ tab, key, cycle, files: used.map((x) => x.name) }], book, { ...person, remember: false });
  }

  /** One suite and cycle as the extension needs it: its result values and live cases, each with its evidence. */
  async function extSuite(q, person) {
    const m = await callApi('api_loadTab', [q.tab, q.cycle || ''], q.book, { ...person, remember: false });
    if (!m.ok) return m;
    const ci = m.cycleIdx;
    const cycle = ci >= 0 ? m.cycles[ci].label : '';
    return {
      ok: true,
      book: m.book,
      tab: m.tab,
      cycle,
      hasCycle: ci >= 0,
      cycles: m.cycles.map((c) => c.label),
      statusOptions: (m.statusOptions || []).map((o) => ({ value: o.value, cls: o.cls })),
      cases: m.cases.filter((c) => !c.retired).map((c) => ({
        key: c.key, id: c.id, sh: c.sh, row: c.row, scenario: clip(c.scenario, 400), group1: c.group1, group2: c.group2,
        status: ci >= 0 ? c.statuses[ci] || '' : '', comment: ci >= 0 ? String(c.comments[ci] || '') : '',
        evidence: m.evidence[c.key] || null, // { photo?, video? }
      })),
    };
  }

  /** A file from the extension, for one case and cycle. Replaces the case's earlier file of the same kind. */
  async function addEvidence(q, buf, person) {
    if (!buf.length) return { ok: false, code: 'BAD_INPUT', error: 'The file is empty.' };
    const type = evidenceType(buf);
    if (!type) return { ok: false, code: 'BAD_INPUT', error: 'Only PNG photos and WebM or MP4 recordings can be attached.' };
    const s = await extSuite(q, person);
    if (!s.ok) return s;
    if (!s.hasCycle) return { ok: false, code: 'NO_CYCLE', error: `${s.tab} has no test cycle yet.` };
    const c = s.cases.find((x) => x.key === q.key || (x.id && x.id === q.key));
    if (!c) return { ok: false, code: 'NO_CASE', error: `There is no test case "${q.key}" in ${s.tab} (or it is retired).` };
    // A file for the result the case has now backs that result at once; one for a result
    // about to be marked (or a case not run yet) waits for that mark.
    const forStatus = clip(q.forStatus, 60);
    const backsNow = !!c.status && (!forStatus || forStatus === c.status);
    const item = evidence.put(s.book, { tab: s.tab, cycle: s.cycle, caseKey: c.key, caseId: c.id, buf, type, by: person.name, usedFor: backsNow ? c.status : '' });
    if (backsNow) await writeEvidenceNote(s.book, s.tab, s.cycle, c.key, person);
    return { ok: true, book: s.book, tab: s.tab, cycle: s.cycle, key: c.key, added: itemOut(item), evidence: filesOut(evidence.forCase(s.book, s.tab, s.cycle, c.key)) };
  }

  /** Remove a case's screenshot or recording (kind), or both (no kind): deleted for good. */
  async function removeEvidence(body, person) {
    const book = lib.list().some((b) => b.name === body.book) ? body.book : app.last.book;
    if (!mayOpen(person, book)) return { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you. Ask your test lead.' };
    const tab = String(body.tab || '');
    const cycle = String(body.cycle || '');
    const key = String(body.key || '');
    const kinds = KINDS.includes(body.kind) ? [body.kind] : KINDS;
    const gone = kinds.map((k) => evidence.remove(book, tab, cycle, key, k)).filter(Boolean);
    if (!gone.length) return { ok: false, code: 'NO_EVIDENCE', error: 'That case has no such attachment any more.' };
    await writeEvidenceNote(book, gone[0].tab, gone[0].cycle, gone[0].caseKey, person);
    return { ok: true, removed: gone.map((x) => x.name).join(', '), evidence: filesOut(evidence.forCase(book, tab, cycle, key)) };
  }

  /**
   * Marking a result that has evidence: a result backed by files changes only with a new
   * file (a screenshot or a recording added since the result was marked), or once the files
   * are removed. When it changes, the new files back the new result and the old result's
   * other files are deleted.
   */
  async function markWithEvidence(body, person) {
    const args = Array.isArray(body.args) ? body.args : [];
    const r = args[0] || {};
    const book = lib.list().some((b) => b.name === body.book) ? body.book : app.last.book;
    if (!mayOpen(person, book)) return { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you. Ask your test lead.' };
    const cycle = r.cycle || '';
    const items = book && r.tab && r.key ? Object.values(evidence.forCase(book, r.tab, cycle, r.key)) : [];
    const next = r.status == null ? null : String(r.status).trim();
    const changes = next != null && next !== String(r.expect == null ? '' : r.expect).trim();
    const stale = items.filter((x) => !x.fresh && x.usedFor && x.usedFor !== next);
    const fresh = items.filter((x) => x.fresh);
    if (changes && stale.length && !fresh.length) {
      return { ok: false, code: 'EVIDENCE', evidence: filesOut(evidence.forCase(book, r.tab, cycle, r.key)), error: `${stale[0].caseId || 'This case'} is ${stale[0].usedFor} with evidence (${stale.map((x) => x.name).join(', ')}). To change the result, attach new evidence with Test Run Extension (a screenshot or a recording), or remove the files first.` };
    }
    const out = await callApi('api_mark', args, body.book, person);
    if (out && out.ok && changes && items.length) {
      for (const x of stale) evidence.remove(out.book, r.tab, cycle, r.key, x.kind); // the old result's files are out of date
      if (out.status) for (const x of fresh) evidence.setUsed(out.book, r.tab, cycle, r.key, x.kind, out.status);
      const note = await writeEvidenceNote(out.book, r.tab, cycle, r.key, person);
      if (note.ok && note.comment != null) out.comment = note.comment;
      out.evidence = filesOut(evidence.forCase(out.book, r.tab, cycle, r.key));
      if (stale.length) out.removedEvidence = stale.map((x) => x.name);
    }
    return out;
  }

  // The Complete Report: the workbook and every suite's evidence in one zip, made in the
  // background one at a time, kept for the host's chosen time, then deleted.
  const reportsDir = join(sheetsDir, '.testrun', 'complete-reports');
  const reports = new Map(); // book -> { state: 'running'|'ready'|'failed', startedAt, eta, createdAt, expiresAt, file, size, error }
  let reportChain = Promise.resolve();
  try { for (const f of readdirSync(reportsDir)) unlinkSync(join(reportsDir, f)); } catch { /* none yet */ }

  function expireReports(now = Date.now()) {
    for (const [book, r] of reports) {
      if (r.state === 'ready' && now >= r.expiresAt) {
        try { unlinkSync(r.file); } catch { /* gone */ }
        reports.delete(book);
      }
      if (r.state === 'failed' && now - r.startedAt > 10 * 60000) reports.delete(book);
    }
  }

  function reportInfo(book) {
    expireReports();
    const r = reports.get(book);
    const now = Date.now();
    const base = { ok: true, book, keepMinutes: app.media.keepMinutes, estimate: reportSeconds(evidence.bookBytes(book)), files: evidence.all(book).length };
    if (!r) return { ...base, state: 'none' };
    if (r.state === 'running') return { ...base, state: 'running', readyIn: Math.max(1, Math.round((r.startedAt + r.eta * 1000 - now) / 1000)) };
    if (r.state === 'failed') return { ...base, state: 'failed', error: r.error };
    return { ...base, state: 'ready', createdAt: new Date(r.createdAt).toISOString(), expiresIn: Math.max(0, Math.round((r.expiresAt - now) / 1000)), size: r.size };
  }

  function startReport(book, person) {
    expireReports();
    const had = reports.get(book);
    if (had && had.state === 'running') return { ...reportInfo(book), code: 'RUNNING' };
    if (had && had.state === 'ready') return { ...reportInfo(book), ok: false, code: 'WAIT', error: 'A Complete Report was made recently. Download it, or wait until it expires to make a new one.' };
    const items = evidence.all(book).map((it) => ({ ...it, book }));
    const eta = reportSeconds(items.reduce((n, it) => n + (it.size || 0), 0));
    const job = { state: 'running', startedAt: Date.now(), eta };
    reports.set(book, job);
    reportChain = reportChain.then(async () => {
      try {
        const xlsx = await downloadCopy(book, person.name);
        const name = `${safeName(book.replace(/\.xlsx$/i, ''), 'Workbook')} - Complete Report - ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
        const file = join(reportsDir, name);
        const size = await writeCompleteZip({ out: file, xlsx, xlsxName: book, items, store: evidence });
        Object.assign(job, { state: 'ready', file, name, size, createdAt: Date.now(), expiresAt: Date.now() + app.media.keepMinutes * 60000 });
      } catch (e) {
        log(e);
        Object.assign(job, { state: 'failed', error: `The Complete Report could not be made: ${e.message}` });
      }
    });
    return { ...reportInfo(book), started: true };
  }

  const reportTimer = setInterval(() => expireReports(), 30000);
  if (reportTimer.unref) reportTimer.unref();

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const origin = req.headers.origin;
    // Cross-origin answers (the hosted page, Bug Reporter) carry CORS headers. No cookies are
    // used: a key in the Authorization header is the only credential, so this opens nothing.
    const cors = origin ? {
      'access-control-allow-origin': origin,
      vary: 'Origin',
      'access-control-allow-headers': 'X-Test-Run, Authorization, Content-Type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      'access-control-allow-private-network': 'true',
    } : {};
    const send = (code, type, body, headers = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors, ...headers });
      res.end(body);
    };
    const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));
    try {
      if (req.method === 'OPTIONS') return send(204, 'text/plain', '');

      // Who is asking. The laptop itself (Host 127.0.0.1/localhost, no tunnel in between) from
      // this console's own page or the Bug Reporter extension is the owner and needs no key;
      // anyone else must send a teammate's invite key.
      const local = isLocalRequest(req, port);
      const okOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      for (const id of extIds) okOrigins.push(`chrome-extension://${id}`);
      let person = null;
      // A teammate's key says who it is, on the laptop too (a teammate testing their link there);
      // without one, the laptop itself is the owner.
      const p = bearer(req) ? personForKey(app.team, bearer(req)) : null;
      if (!p && local && (!origin || okOrigins.includes(origin))) person = owner();
      else {
        if (p) {
          person = p === app.team.admin
            ? { role: 'owner', name: app.user, id: 'admin', admin: true, local: false } // the owner's admin link
            : { role: p.role, name: p.name, id: p.id, local: false, books: Array.isArray(p.books) ? p.books : null, automationSuites: p.automationSuites, startRuns: p.startRuns };
          const now = stamp();
          if (p.lastSeen !== now) { p.lastSeen = now; saveApp(); }
        }
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = url.pathname;

      // The page itself is public (it is the same code as on GitHub); everything it shows needs a key.
      if (req.method === 'GET' && STATIC[path]) {
        const file = join(UI, STATIC[path]);
        return send(200, TYPES[extname(file)], readFileSync(file), { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://api.github.com; frame-ancestors 'none'" });
      }
      // A page from another site with no invite key gets nothing on the laptop (DNS rebinding,
      // cross-site forms). One that sends a key is told whether the key works.
      if (local && origin && !okOrigins.includes(origin) && !person && !bearer(req)) return json(403, { ok: false, code: 'FORBIDDEN', error: 'Not allowed from this page.' });
      if (req.method === 'GET' && path.startsWith('/exports/') && person && person.local) {
        const name = decodeURIComponent(path.slice('/exports/'.length));
        if (!/^[^/\\]+\.html$/.test(name)) return send(404, 'text/plain', 'Not found');
        const file = join(sheetsDir, 'exports', name);
        if (!existsSync(file)) return send(404, 'text/plain', 'Not found');
        return send(200, 'text/html; charset=utf-8', readFileSync(file), { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      }
      // The published reports are public (the same files the GitHub Pages site serves).
      if (req.method === 'GET' && /^\/reports\/[\w.-]+\.(json|xlsx)$/.test(path)) {
        const name = path.slice('/reports/'.length);
        // the last publish (or Get latest) from this laptop; before any, the published data in this clone
        let data = null;
        if (existsSync(join(reportsCache, 'index.json'))) { if (existsSync(join(reportsCache, name))) data = readFileSync(join(reportsCache, name)); }
        else { const d = localData(); if (d) data = d.read(`reports/${name}`); }
        if (!data) return send(404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, code: 'NOT_PUBLISHED', error: 'Nothing is published yet.' }));
        return send(200, name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json; charset=utf-8', data);
      }
      // The locked automated results, as published (anyone may fetch them; only invited people can open them).
      if (req.method === 'GET' && path.startsWith('/automation/') && isAutomationPath(path.slice(1))) {
        const rel = path.slice(1);
        let data = null;
        if (existsSync(join(reportsCache, 'index.json'))) { const f = join(reportsCache, ...rel.split('/')); if (existsSync(f)) data = readFileSync(f); }
        else { const d = localData(); if (d) data = d.read(rel); }
        if (!data) return send(404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, code: 'NOT_PUBLISHED', error: 'Nothing is published yet.' }));
        return send(200, rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream', data);
      }
      if (!path.startsWith('/api/')) return send(404, 'text/plain', 'Not found');
      // A custom header: plain cross-site forms and links cannot send it.
      if (req.headers['x-test-run'] !== '1') return json(403, { ok: false, code: 'FORBIDDEN', error: 'Missing X-Test-Run header.' });

      if (req.method === 'GET' && path === '/api/status') {
        if (!person) return json(200, { ok: true, app: 'test-run', version: VERSION, instance: INSTANCE, auth: 'required' });
        const seen = mayOpen(person, app.last.book); // the host's open workbook, only if it is shared with them
        return json(200, { ok: true, app: 'test-run', version: VERSION, instance: INSTANCE, book: (seen && app.last.book) || null, tab: (seen && app.last.tab) || null, cycle: (seen && app.last.cycle) || null, user: app.user, me: { name: person.name, role: person.role, local: !!person.local, admin: !!person.admin }, consoleUrl: consoleUrl(person) });
      }
      if (!person) {
        return json(401, { ok: false, code: 'AUTH', error: app.team.enabled ? 'This Test Run is shared by invite. Open your invite link (or paste it in Bug Reporter settings).' : 'This Test Run is not shared. Only the host-server running it can open it.' });
      }
      const ownerOnly = () => json(403, { ok: false, code: 'FORBIDDEN', error: 'Only the person running Test Run can do that.' });

      if (req.method === 'GET' && path === '/api/app') return json(200, appInfo(person));
      if (req.method === 'GET' && path === '/api/suites') return json(200, await suites(person));
      if (req.method === 'GET' && path === '/api/suite-cases') return json(200, await suiteCases(url.searchParams.get('book') || '', url.searchParams.get('tab') || '', person));
      if (req.method === 'GET' && path === '/api/issues') return json(200, await listIssues({ book: url.searchParams.get('book') || '' }, person));
      if (req.method === 'GET' && path === '/api/team') return isOwnerPerson(person) ? json(200, teamInfo()) : ownerOnly();
      if (req.method === 'GET' && path === '/api/publish') return isOwnerPerson(person) ? json(200, await publishStatus({ refresh: url.searchParams.get('refresh') === '1' })) : json(403, { ok: false, code: 'FORBIDDEN', error: 'Only the host publishes.' });
      if (req.method === 'GET' && path === '/api/publish/space') return isOwnerPerson(person) ? json(200, await publishSpace()) : json(403, { ok: false, code: 'FORBIDDEN', error: 'Only the host publishes.' });
      if (req.method === 'GET' && path === '/api/media') return json(200, { ok: true, ...mediaLimits(app.media), used: isOwnerPerson(person) ? evidence.usedBytes() : undefined });
      if (req.method === 'GET' && path === '/api/current') {
        return json(200, { ok: true, current: selections.get(whoKey(person)) || null, me: { name: person.name, role: person.role, local: !!person.local, admin: !!person.admin }, consoleUrl: consoleUrl(person) });
      }
      if (req.method === 'GET' && path === '/api/ext/suite') {
        return json(200, await extSuite({ book: url.searchParams.get('book') || '', tab: url.searchParams.get('tab') || '', cycle: url.searchParams.get('cycle') || '' }, person));
      }
      if (req.method === 'GET' && path === '/api/evidence/file') {
        const book = url.searchParams.get('book') || '';
        if (!mayOpen(person, book)) return json(403, { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you. Ask your test lead.' });
        const files = lib.list().some((b) => b.name === book) ? evidence.forCase(book, url.searchParams.get('tab') || '', url.searchParams.get('cycle') || '', url.searchParams.get('key') || '') : {};
        const it = files[url.searchParams.get('kind')] || files.photo || files.video || null;
        if (!it || !existsSync(evidence.pathOf(book, it))) return json(404, { ok: false, code: 'NO_EVIDENCE', error: 'That attachment is not there any more.' });
        return send(200, it.ext === 'png' ? 'image/png' : it.ext === 'mp4' ? 'video/mp4' : 'video/webm', readFileSync(evidence.pathOf(book, it)), { 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(it.name)}` });
      }
      if (req.method === 'GET' && path === '/api/complete-report') {
        if (!isOwnerPerson(person)) return ownerOnly();
        return json(200, reportInfo(url.searchParams.get('book') || ''));
      }
      if (req.method === 'GET' && path === '/api/complete-report/download') {
        if (!isOwnerPerson(person)) return ownerOnly();
        expireReports();
        const r = reports.get(url.searchParams.get('book') || '');
        if (!r || r.state !== 'ready' || !existsSync(r.file)) return json(404, { ok: false, code: 'NO_REPORT', error: 'That Complete Report has expired. Make a new one.' });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': statSync(r.file).size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors });
        createReadStream(r.file).pipe(res);
        return undefined;
      }
      if (req.method === 'GET' && path === '/api/books/download') {
        const name = url.searchParams.get('name') || '';
        const file = lib.path(name);
        if (!existsSync(file)) return send(404, 'text/plain', 'Not found');
        if (!mayOpen(person, name)) return json(403, { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you.' });
        const buf = await downloadCopy(name, person.name);
        return send(200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf, { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
      }
      if (path === '/api/automation' || path.startsWith('/api/automation/')) {
        // its own bodies: results files (raw or multipart, up to 20 MB) and small JSON
        const r = await automation.handle(req.method, path, url, req, person);
        return r.json ? json(r.code, r.json) : send(r.code, r.type, r.body, r.headers);
      }
      if (req.method !== 'POST') return json(405, { ok: false, code: 'METHOD', error: 'Use POST.' });

      if (path === '/api/books/import') {
        if (!isOwnerPerson(person)) return ownerOnly();
        const buf = await readBody(req, 40 * 1024 * 1024);
        const name = await serial(() => lib.importFile(url.searchParams.get('name'), buf, { overwrite: url.searchParams.get('overwrite') === '1' }));
        app.last = { book: name, tab: '', cycle: '' };
        saveApp();
        // Every test suite needs Tested by and Tested on: mapped when there, added when not.
        const cols = await callApi('api_requireTestedColumns', [], name, { ...person, remember: false });
        return json(200, { ok: true, name, books: lib.list(), addedColumns: cols.ok ? cols.added : [] });
      }

      if (path === '/api/evidence') {
        if (person.role === 'viewer') return json(403, { ok: false, code: 'FORBIDDEN', error: 'You can view this Test Run, not change it.' });
        const buf = await readBody(req, MAX_FILE_BYTES);
        const q = Object.fromEntries(['book', 'tab', 'cycle', 'key', 'forStatus'].map((k) => [k, url.searchParams.get(k) || '']));
        return json(200, await addEvidence(q, buf, person));
      }

      const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
      if (path === '/api/current') {
        const v = { book: clip(body.book, 260), tab: clip(body.tab, 160), cycle: clip(body.cycle, 60), caseKey: clip(body.caseKey, 200), at: Date.now() };
        selections.set(whoKey(person), v);
        return json(200, { ok: true, current: v });
      }
      if (path === '/api/media') {
        if (!isOwnerPerson(person)) return ownerOnly();
        app.media = normalizeMedia({ ...app.media, ...body });
        saveApp();
        return json(200, { ok: true, ...mediaLimits(app.media), used: evidence.usedBytes() });
      }
      if (path === '/api/evidence/remove') {
        if (person.role === 'viewer') return json(403, { ok: false, code: 'FORBIDDEN', error: 'You can view this Test Run, not change it.' });
        return json(200, await removeEvidence(body, person));
      }
      if (path === '/api/complete-report') {
        if (!isOwnerPerson(person)) return ownerOnly();
        const name = String(body.book || '');
        if (!lib.list().some((b) => b.name === name)) return json(200, { ok: false, code: 'NO_BOOK', error: `"${name}" is not in the sheets folder any more.` });
        return json(200, startReport(name, person));
      }
      if (path === '/api/app') {
        if (!isOwnerPerson(person)) return ownerOnly();
        app = normalizeApp({ ...app, user: body.user != null ? body.user : app.user });
        if (!app.user) app.user = defaultUser();
        saveApp();
        return json(200, appInfo(owner()));
      }
      if (path.startsWith('/api/team')) return isOwnerPerson(person) ? json(200, await teamPost(path, body)) : ownerOnly();
      if (path.startsWith('/api/publish')) {
        if (!isOwnerPerson(person)) return json(403, { ok: false, code: 'FORBIDDEN', error: 'Only the host publishes.' });
        const r = await publishPost(path, body);
        if (path === '/api/publish/start-from-local' && r.ok) return json(200, { ...r, app: appInfo(person) });
        return json(200, r);
      }
      if (path === '/api/books/delete') {
        // The host only; the page asks first (it cannot be undone from Test Run).
        if (!isOwnerPerson(person)) return ownerOnly();
        const name = String(body.name || '');
        await serial(async () => lib.remove(name));
        evidence.removeBook(name);
        automation.removeBook(name); // automated runs attached to it go too
        const rep = reports.get(name);
        if (rep && rep.file) { try { unlinkSync(rep.file); } catch { /* gone */ } }
        reports.delete(name);
        delete app.publish.books[name];
        if (app.last.book === name) app.last = { book: '', tab: '', cycle: '' };
        saveApp();
        return json(200, { ...appInfo(person), deleted: name });
      }
      if (path === '/api/books/select') {
        await serial(() => openBook(body.name, person));
        return json(200, appInfo(person));
      }
      if (path.startsWith('/api/call/')) {
        const fn = path.slice('/api/call/'.length);
        if (!/^api_\w+$/.test(fn)) return json(404, { ok: false, code: 'NO_FUNCTION', error: 'Unknown function.' });
        if (!mayCall(person, fn)) return json(403, { ok: false, code: 'FORBIDDEN', error: person.role === 'viewer' ? 'You can view this Test Run, not change it.' : 'Only the person running Test Run can do that.' });
        if (fn === 'api_mark') return json(200, await markWithEvidence(body, person));
        const out = await callApi(fn, Array.isArray(body.args) ? body.args : [], body.book, person);
        if (fn === 'api_renameCycle' && out && out.ok && !out.unchanged) {
          // what refers to the cycle by name follows: its evidence, the host's last place, what people have open
          evidence.renameCycle(out.book, out.tab, out.from, out.to);
          if (app.last.book === out.book && app.last.tab === out.tab && app.last.cycle === out.from) { app.last.cycle = out.to; saveApp(); }
          for (const v of selections.values()) if (v.book === out.book && v.tab === out.tab && v.cycle === out.from) { v.cycle = out.to; v.at = Date.now(); }
        }
        return json(200, out);
      }
      if (path === '/api/note-bug') {
        if (person.role === 'viewer') return json(403, { ok: false, code: 'FORBIDDEN', error: 'Your invite is view-only, so bugs cannot be added to Test Run with it.' });
        return json(200, await noteBug(body, person));
      }
      if (path === '/api/export-summary') return json(200, await exportSummary(body, person));
      if (path === '/api/issues/refresh') {
        if (person.role === 'viewer') return json(403, { ok: false, code: 'FORBIDDEN', error: 'You can view this Test Run, not change it.' });
        return json(200, await listIssues(body, person, { refresh: true }));
      }
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
  server.share = {
    start: startSharing,
    stop: stopSharing,
    info: teamInfo,
    enable: () => { app.team.enabled = true; saveApp(); },
    /** Was sharing on when Test Run last stopped? Then `npm start` starts it again. */
    wanted: () => app.team.enabled && app.team.sharing,
  };
  server.issues = { fetching: () => issueFetch.size };
  server.publish = {
    now: publishNow,
    status: publishStatus,
    tick: publishTick,
    /** The once-a-minute check for the daily publish, and a look at GitHub for newer publishes every 30 minutes. */
    startSchedule: () => {
      pub.timers.push(setInterval(() => publishTick(), 60000));
      remoteIndex();
      pub.timers.push(setInterval(() => remoteIndex(), 30 * 60000));
      for (const t of pub.timers) if (t.unref) t.unref();
    },
  };
  server.on('close', () => { stopSharing({ forget: false }); pub.timers.forEach(clearInterval); clearInterval(reportTimer); automation.stop(); });
  server.evidence = evidence;
  server.automation = automation;
  server.reports = { info: reportInfo, start: startReport, expire: expireReports, wait: () => reportChain };
  return server;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // the rest is read and dropped, so the answer (413) still reaches the sender
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; reject(err('TOO_BIG', `That is too large (at most ${Math.round(max / (1024 * 1024))} MB).`)); return; }
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
  // TEST_RUN_GH: another gh to use (development: dev/fake-gh.cjs, so previews publish nothing for real)
  // --fake-github: Automation talks to a pretend GitHub (dev/fake-github.mjs) with one suite repository, demo-org/cms-automation
  const github = args.includes('--fake-github') ? (await import('./dev/fake-github.mjs')).demoGithub().github : undefined;
  const server = createServer({ sheetsDir, ghPath: process.env.TEST_RUN_GH || undefined, github, log: (e) => console.error(e && e.stack ? e.stack : e) });
  let quitting = false;
  const quit = async () => {
    if (quitting) process.exit(0); // Ctrl+C again: stop now
    quitting = true;
    server.share.stop({ forget: false }); // sharing starts again with Test Run
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  server.listenOn(port).then((url) => {
    server.publish.startSchedule();
    console.log(`Test Run is running at ${url}`);
    console.log(`Workbooks folder: ${sheetsDir}${demo ? ' (demo copy, deleted by your OS later)' : ''}`);
    if (!server.library.list().length) console.log('No workbooks yet: put an .xlsx file in that folder, or use Import in the console.');
    if (args.includes('--share') || server.share.wanted()) {
      server.share.enable();
      const t0 = server.share.info();
      console.log(t0.team.mode === 'fixed'
        ? `Sharing with your team at your fixed address ${t0.team.fixedUrl || '(not set yet)'}${t0.team.tunnelName ? `, through Cloudflare tunnel "${t0.team.tunnelName}"` : ''}…`
        : 'Sharing with your team: opening a Cloudflare quick tunnel…');
      server.share.start().then(() => {
        const t = server.share.info();
        if (t.address.effective && !t.address.tunnel.error) {
          console.log(`Your team reaches Test Run at ${t.address.effective}`);
          if (t.team.publish && t.team.gist) console.log(`The address is kept in your gist (${t.team.gist}), so invite links keep working.`);
          console.log('Add people and copy their invite links in Setup › Access › Users.');
        } else {
          console.log(`Could not share: ${t.address.tunnel.error}`);
        }
      });
    }
    console.log('Press Ctrl+C to stop.');
    if (!args.includes('--no-open') && process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }, (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Test Run already running? Otherwise start it with --port <another>.` : e.message);
    process.exit(1);
  });
}

export { summaryPage };
