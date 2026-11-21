// Talking to Test Run: the access link a teammate pastes, and requests with its key.
//
// An access link is https://…/test-run/#join=<key>&server=<address> (or &gist=<id>, when the
// address changes on every start and is kept in a gist). The host can also paste the laptop's
// own address, http://127.0.0.1:5178, which needs no key.

export const DEFAULT_LOCAL = 'http://127.0.0.1:5178';

const cleanBase = (s) => {
  const v = String(s ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(v) ? v : '';
};

export const isLocalBase = (base) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(base || ''));

/**
 * What a pasted link says: { link, server, key, gist, local } or null when it is not one.
 * local: the laptop's own address (no key).
 */
export function parseLink(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const i = s.indexOf('#');
  if (i < 0) {
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/i.test(u.hostname)) return { link: s, server: u.origin, key: '', gist: '', local: true };
    } catch { /* not a URL */ }
    return null;
  }
  const p = new URLSearchParams(s.slice(i + 1));
  const key = String(p.get('join') || '').replace(/[^\w-]/g, '');
  if (!key) return null;
  let server = cleanBase(p.get('server'));
  const gist = String(p.get('gist') || '').replace(/[^0-9a-f]/gi, '');
  if (!server && !gist) {
    // a link straight to the shared Test Run (no hosted page): its own address
    try {
      const u = new URL(s.slice(0, i));
      if (/^https?:$/.test(u.protocol)) server = cleanBase(u.origin + u.pathname.replace(/\/[^/]*$/, ''));
    } catch { /* not a URL */ }
  }
  if (!server && !gist) return null;
  return { link: s, server, key, gist, local: false };
}

/**
 * Where to open Test Run for this connection, on a screen ('run', 'summary'); at: { book, tab,
 * cycle, case } opens on that workbook, suite, cycle and test case.
 */
export function consoleUrl(conn, view, at = {}) {
  if (!conn) return '';
  const q = new URLSearchParams({ view });
  for (const k of ['book', 'tab', 'cycle', 'case']) if (at[k] != null && at[k] !== '') q.set(k, at[k]);
  if (conn.local) return `${conn.server}/?${q}`;
  const i = conn.link.indexOf('#');
  const page = conn.link.slice(0, i);
  return `${page}${page.includes('?') ? '&' : '?'}${q}${conn.link.slice(i)}`;
}

async function timedFetch(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/** The address a shared Test Run last wrote to its gist ('' if none). */
export async function addressFromGist(gist) {
  if (!gist) return '';
  try {
    const r = await timedFetch(`https://api.github.com/gists/${encodeURIComponent(gist)}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' }, 5000);
    if (!r.ok) return '';
    const g = await r.json();
    const info = JSON.parse(g?.files?.['test-run.json']?.content || 'null');
    return info && info.app === 'test-run' ? cleanBase(info.url) : '';
  } catch {
    return '';
  }
}

export class Offline extends Error {}

/**
 * A request to Test Run with the link's key. Resolves the JSON answer ({ ok, … }), or
 * throws Offline when Test Run does not answer. When the address moved (a gist link),
 * it is looked up once and saved through onMove.
 */
export async function request(conn, method, path, { body, raw = false, timeoutMs, onMove } = {}) {
  const headers = { 'X-Test-Run': '1' };
  if (conn.key) headers.Authorization = `Bearer ${conn.key}`;
  const opts = { method, headers };
  if (body !== undefined) {
    if (raw) { opts.body = body; headers['content-type'] = 'application/octet-stream'; } else { opts.body = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  }
  const ms = timeoutMs ?? (raw ? 120000 : isLocalBase(conn.server) ? 5000 : 15000);
  const go = async (base) => {
    const r = await timedFetch(`${base}${path}`, opts, ms);
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!j) return { ok: false, code: r.status === 413 ? 'TOO_BIG' : 'ERROR', status: r.status, error: r.status === 413 ? 'That file is too large for Test Run.' : `Test Run answered ${r.status}.` };
    return { status: r.status, ...j };
  };
  if (conn.server) {
    try { return await go(conn.server); } catch (e) { if (!conn.gist) throw new Offline(e?.name === 'AbortError' ? 'Test Run did not answer in time.' : 'Test Run is not answering.'); }
  }
  const moved = await addressFromGist(conn.gist);
  if (!moved || moved === conn.server) throw new Offline('Test Run is not answering. The laptop running it may be off or asleep.');
  conn.server = moved;
  if (onMove) await onMove(moved);
  try { return await go(moved); } catch (e) { throw new Offline('Test Run is not answering.'); }
}
