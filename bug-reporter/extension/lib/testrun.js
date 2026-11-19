// Test Run integration. When Test Run is reachable, the Report Issue form offers
// to add the bug to it once filed, in the test suite (workbook and tab) the
// reporter picks: against a test case (marked failed, with the bug linked), or,
// with no test case picked, as a Finding to be written up as a test case.
//
// Where Test Run is, from Settings → Test Run:
// - on this computer: http://127.0.0.1:5178 (the default; no key needed);
// - a teammate's shared Test Run: the address and invite key from the invite
//   link they sent. A shared Test Run's address can change (a quick tunnel gets
//   a new one on every start); it keeps the current one in a gist, which is
//   looked up when the address that was saved stops answering.

export const DEFAULT_PORT = 5178;

const clean = (s) => {
  const v = String(s ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(v) ? v : '';
};

/** Where Test Run is: the saved address, else this computer on the saved (or default) port. */
export function testRunBase(settings) {
  const t = settings?.testRun || {};
  const url = clean(t.url);
  if (url) return url;
  return `http://127.0.0.1:${Number(t.port) || DEFAULT_PORT}`;
}

export function isLocalBase(base) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base);
}

function headers(settings, extra = {}) {
  const h = { 'X-Test-Run': '1', ...extra };
  const key = String(settings?.testRun?.key || '').trim();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

/** An invite link (https://…#join=<key>&gist=<id> or &server=<address>) as { key, server, gist }. */
export function parseInvite(text) {
  const s = String(text ?? '').trim();
  const i = s.indexOf('#');
  const p = new URLSearchParams(i >= 0 ? s.slice(i + 1) : s);
  const out = { key: String(p.get('join') || '').replace(/[^\w-]/g, ''), server: clean(p.get('server')), gist: String(p.get('gist') || '').replace(/[^0-9a-f]/gi, '') };
  if (out.key && !out.server && !out.gist && i > 0) {
    try {
      const u = new URL(s.slice(0, i));
      if (/^https?:$/.test(u.protocol)) out.server = clean(u.origin + u.pathname.replace(/\/[^/]*$/, ''));
    } catch {}
  }
  return out;
}

async function timedFetch(fetchImpl, url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The address a shared Test Run last wrote to its gist ('' if none or unreadable). */
export async function addressFromGist(gist, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (!gist) return '';
  try {
    const r = await timedFetch(fetchImpl, `https://api.github.com/gists/${encodeURIComponent(gist)}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' }, timeoutMs);
    if (!r.ok) return '';
    const g = await r.json();
    const info = JSON.parse(g?.files?.['test-run.json']?.content || 'null');
    return info && info.app === 'test-run' ? clean(info.url) : '';
  } catch {
    return '';
  }
}

async function statusAt(base, settings, fetchImpl, timeoutMs) {
  try {
    const r = await timedFetch(fetchImpl, `${base}/api/status`, { headers: headers(settings) }, timeoutMs);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok && j.app === 'test-run' ? { ...j, base } : null;
  } catch {
    return null;
  }
}

/**
 * Test Run's status, or null when it is switched off or not reachable. Never throws.
 * The result carries base (where it answered; it can differ from Settings when the
 * gist named a new address) and, for a shared Test Run, needsKey / me.role.
 */
export async function testRunStatus(settings, { fetchImpl = fetch, timeoutMs } = {}) {
  if (settings?.testRun?.enabled === false) return null;
  const base = testRunBase(settings);
  const ms = timeoutMs ?? (isLocalBase(base) ? 600 : 4000);
  let st = await statusAt(base, settings, fetchImpl, ms);
  if (!st && settings?.testRun?.gist) {
    const moved = await addressFromGist(settings.testRun.gist, { fetchImpl });
    if (moved && moved !== base) st = await statusAt(moved, settings, fetchImpl, ms);
  }
  if (st && st.auth === 'required') return { ...st, needsKey: true };
  return st;
}

/** Can this status take a note? (Reachable, signed in, and not a view-only invite.) */
export function canNote(st) {
  return !!st && !st.needsKey && st.me?.role !== 'viewer';
}

/** "CMS Sign Off · CMS 2.20.1 · cycle v2.20.1" */
export function whereLabel(s) {
  if (!s) return '';
  const book = String(s.book || '').replace(/\.xlsx$/i, '');
  return [book, s.tab, s.cycle ? `cycle ${s.cycle}` : ''].filter(Boolean).join(' · ');
}

/** Every test suite (workbook › test case tab) Test Run has: [{ book, tab, label }], plus the one open there. */
export async function listSuites(settings, base, { fetchImpl = fetch, timeoutMs } = {}) {
  try {
    const r = await timedFetch(fetchImpl, `${base}/api/suites`, { headers: headers(settings) }, timeoutMs ?? (isLocalBase(base) ? 3000 : 8000));
    const j = await r.json();
    if (!j || !j.ok) return { suites: [], current: null };
    const suites = [];
    for (const s of j.suites || []) for (const tab of s.tabs || []) suites.push({ book: s.book, tab, label: `${String(s.book).replace(/\.xlsx$/i, '')} › ${tab}` });
    return { suites, current: j.current || null };
  } catch {
    return { suites: [], current: null };
  }
}

/** The suite to preselect: the last one picked (if it still exists), else the one open in Test Run, else the first. */
export function pickSuite(suites, remembered, current) {
  const same = (s, x) => x && s.book === x.book && s.tab === x.tab;
  return suites.find((s) => same(s, remembered)) || suites.find((s) => same(s, current)) || suites[0] || null;
}

/** The test cases of one suite: { cases: [{ key, id, scenario, status }], cycle }. Never throws. */
export async function listCases(settings, base, suite, { fetchImpl = fetch, timeoutMs } = {}) {
  if (!suite) return { cases: [], cycle: '' };
  try {
    const q = `book=${encodeURIComponent(suite.book)}&tab=${encodeURIComponent(suite.tab)}`;
    const r = await timedFetch(fetchImpl, `${base}/api/suite-cases?${q}`, { headers: headers(settings) }, timeoutMs ?? (isLocalBase(base) ? 5000 : 10000));
    const j = await r.json();
    return j && j.ok ? { cases: j.cases || [], cycle: j.cycle || '' } : { cases: [], cycle: '', error: j?.error || '' };
  } catch {
    return { cases: [], cycle: '' };
  }
}

/** How a test case is offered in the picker: "CMS/12 · Citizen can file a complaint". */
export function caseLabel(c) {
  return `${c.id || 'Row'} · ${String(c.scenario || '').replace(/\s+/g, ' ').trim()}`;
}

/** The test case the typed text names: its label from the list, or just its ID. null if none. */
export function matchCase(cases, text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  return (cases || []).find((c) => caseLabel(c).toLowerCase() === t)
    || (cases || []).find((c) => String(c.id || '').toLowerCase() === t)
    || (cases || []).find((c) => String(c.key || '').toLowerCase() === t)
    || null;
}

/** Where to open Test Run to see the note: Run for a test case, Findings for a finding. */
export function consoleLink(st, base, view = 'findings') {
  const u = st?.consoleUrl || `${base}/`;
  return `${u}${u.includes('?') ? '&' : '?'}view=${view}`;
}

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

/** What Test Run needs to add a filed bug, in the chosen suite (and against the chosen test case, if any). */
export function buildBugNote({ title, filed, repo, draft, extra, module, pageUrl, suite, testCase, priority }) {
  return {
    title: clip(title, 300),
    number: filed?.number ?? '',
    url: clip(filed?.url, 500),
    repo: clip(repo, 200),
    description: clip(draft?.description, 2000),
    actual: clip(draft?.actual, 1500),
    expected: clip(draft?.expected, 1500),
    extra: clip(extra, 800),
    module: clip(module, 80),
    pageUrl: clip(pageUrl, 300),
    book: clip(suite?.book, 260),
    tab: clip(suite?.tab, 160),
    caseKey: clip(testCase?.key, 200),
    priority: clip(priority, 40),
  };
}

/** Sends the note; resolves { kind: 'case'|'finding', key, book, tab, status } or throws with a readable message. */
export async function noteBugInTestRun(settings, note, { fetchImpl = fetch, timeoutMs, base } = {}) {
  const at = base || testRunBase(settings);
  let r;
  try {
    r = await timedFetch(fetchImpl, `${at}/api/note-bug`, {
      method: 'POST',
      headers: headers(settings, { 'content-type': 'application/json' }),
      body: JSON.stringify(note),
    }, timeoutMs ?? (isLocalBase(at) ? 5000 : 15000));
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'Test Run did not answer in time.' : isLocalBase(at) ? 'Test Run is not running any more.' : 'The shared Test Run is not answering.');
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  if (!r.ok || !j || !j.ok) throw new Error(j?.error || `Test Run answered ${r.status}.`);
  return { kind: j.kind || 'finding', key: j.key, book: j.book, tab: j.tab, status: j.status || '', previous: j.previous || '', cycle: j.cycle || '' };
}
