// Sharing one Test Run with a team.
//
// Test Run always listens on 127.0.0.1 only. Teammates reach it through a
// tunnel (a Cloudflare quick tunnel started by `npm run share`, or any tunnel
// at a fixed address: Tailscale Funnel, or a Cloudflare named tunnel). Every
// request that comes through a tunnel must carry an invite key:
//   Authorization: Bearer <key>
// The owner makes one invite link per person in Setup → Team. Requests are
// checked against a hash of each key. The key itself is kept too, in
// sheets/.testrun/app.json on the owner's laptop (git-ignored, readable only by
// the owner), so the owner can copy a person's link again; it never leaves the
// laptop except in that copied link.
//
// Who can do what:
//   owner  - the person at the laptop (requests from 127.0.0.1, no key needed), or
//            the same person elsewhere with their admin link (team.admin)
//   tester - marks results, changes and retires cases, writes up findings
//   viewer - follows the run and the summary (managers); changes nothing
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ROLES = ['tester', 'viewer'];

/** api_* functions anyone signed in may call (they only read). */
export const READ_FNS = new Set(['api_bootstrap', 'api_loadTab', 'api_version', 'api_listFindings', 'api_summary', 'api_listIssues', 'api_automationSummary']);
/** ... and those a tester may call too. */
export const TESTER_FNS = new Set(['api_mark', 'api_addCases', 'api_editCase', 'api_updateCase', 'api_retireCase', 'api_restoreCase',
  'api_saveFinding', 'api_setFindingState', 'api_deleteFinding', 'api_writeSummaryTab', 'api_saveIssueMeta', 'api_linkBug']);
// Everything else (Setup, cycles, columns, path plans, Claude) is the owner's.

/** May this person call this api_* function? */
export function mayCall(person, fn) {
  if (!person) return false;
  if (person.role === 'owner') return true;
  if (READ_FNS.has(fn)) return true;
  return person.role === 'tester' && TESTER_FNS.has(fn);
}

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** An http(s) address without a trailing slash, or ''. */
export function cleanUrl(s) {
  const v = clip(s, 300).replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(v) ? v : '';
}

export function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

export function newKey() {
  return randomBytes(24).toString('base64url');
}

function newId() {
  return randomBytes(6).toString('hex');
}

export const MODES = ['quick', 'fixed'];

/** A Cloudflare named tunnel's name (or id), or ''. */
export function cleanTunnelName(s) {
  const v = clip(s, 64);
  return /^[\w.-]+$/.test(v) ? v : '';
}

export function normalizeTeam(t = {}) {
  const fixedUrl = cleanUrl(t.fixedUrl);
  return {
    enabled: t.enabled === true,
    // quick: a Cloudflare quick tunnel (new address on every start); fixed: an address that stays the same
    mode: MODES.includes(t.mode) ? t.mode : fixedUrl ? 'fixed' : 'quick',
    sharing: t.sharing === true, // sharing was on when Test Run last stopped: start it again
    fixedUrl,
    tunnelName: cleanTunnelName(t.tunnelName),
    hostedUrl: cleanUrl(t.hostedUrl),
    publish: t.publish === true,
    gist: clip(t.gist, 64).replace(/[^0-9a-f]/gi, ''),
    publishedAt: clip(t.publishedAt, 40),
    publishedUrl: cleanUrl(t.publishedUrl),
    publishError: clip(t.publishError, 400),
    // the owner's own link, for full control from another computer
    admin: t.admin && /^[0-9a-f]{64}$/.test(String(t.admin.hash || '')) ? {
      hash: String(t.admin.hash),
      key: /^[\w-]{16,200}$/.test(String(t.admin.key || '')) && hashKey(t.admin.key) === String(t.admin.hash) ? String(t.admin.key) : '',
      created: clip(t.admin.created, 40),
      lastSeen: clip(t.admin.lastSeen, 40),
    } : null,
    people: (Array.isArray(t.people) ? t.people : [])
      .filter((p) => p && /^[0-9a-f]{64}$/.test(String(p.hash || '')))
      .map((p) => ({
        id: clip(p.id, 20) || newId(),
        name: clip(p.name, 80) || 'Teammate',
        role: ROLES.includes(p.role) ? p.role : 'tester',
        hash: String(p.hash),
        // the key, so the link can be copied again (kept only if it matches the hash)
        key: /^[\w-]{16,200}$/.test(String(p.key || '')) && hashKey(p.key) === String(p.hash) ? String(p.key) : '',
        created: clip(p.created, 40),
        lastSeen: clip(p.lastSeen, 40),
        books: cleanBooks(p.books), // null: every workbook
      })),
  };
}

/**
 * The workbooks a person may open: null for all of them (also for 'all', '' or nothing),
 * else a list of workbook file names (an empty list opens none).
 */
export function cleanBooks(v) {
  if (v == null || v === '' || v === 'all') return null;
  return (Array.isArray(v) ? v : [v]).map((n) => String(n)).filter((n) => /\.xlsx$/i.test(n) && !/[\\/:\0]/.test(n) && n.length <= 200).slice(0, 50);
}

/** The person holding this key (team.admin for the owner's admin link), or null. Constant-time compare of the hashes. */
export function personForKey(team, key) {
  if (!team || !team.enabled || !key) return null;
  const want = Buffer.from(hashKey(key), 'hex');
  if (team.admin) {
    const have = Buffer.from(team.admin.hash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) return team.admin;
  }
  for (const p of team.people) {
    const have = Buffer.from(p.hash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) return p;
  }
  return null;
}

/** Add a person; returns { person, key } (the key is shown to the owner once). */
export function addPerson(team, { name, role, books }, now = '') {
  const key = newKey();
  const person = { id: newId(), name: clip(name, 80) || 'Teammate', role: ROLES.includes(role) ? role : 'tester', hash: hashKey(key), key, created: now, lastSeen: '', books: cleanBooks(books) };
  team.people.push(person);
  return { person, key };
}

/** A new key for a person (the old link stops working). */
export function rotateKey(person) {
  const key = newKey();
  person.hash = hashKey(key);
  person.key = key;
  return key;
}

/** A new admin link key for the owner (the old one stops working). */
export function newAdminKey(team, now = '') {
  const key = newKey();
  team.admin = { hash: hashKey(key), key, created: now, lastSeen: '' };
  return key;
}

/** What the page shows about the admin link (never the key or hash). */
export function publicAdmin(team) {
  return team.admin ? { exists: true, canCopy: !!team.admin.key, created: team.admin.created, lastSeen: team.admin.lastSeen } : { exists: false };
}

/** What the page shows about people (never keys or hashes; canCopy: the link can be copied again). */
export function publicPeople(team) {
  return team.people.map(({ id, name, role, created, lastSeen, key, books }) => ({ id, name, role, created, lastSeen, canCopy: !!key, books: books || null }));
}

/**
 * The link a person opens. With a hosted page (GitHub Pages) that is live, the
 * link opens there and names the server through the gist (when the address is
 * kept in one) or directly. Otherwise it points straight at the server.
 * Returns { link, warning }; link is '' when nothing could lead it to this laptop yet.
 */
export function inviteLink(team, address, key, { hostedLive = true } = {}) {
  const join = `join=${encodeURIComponent(key)}`;
  if (team.hostedUrl && !hostedLive && address) {
    return { link: `${address}/#${join}`, warning: `The hosted page is not live yet, so this link names this laptop's address directly.${team.mode === 'fixed' ? '' : ' It stops working when the quick tunnel restarts with a new address.'}` };
  }
  if (team.hostedUrl && hostedLive) {
    const base = team.hostedUrl.replace(/\/?$/, '/');
    if (team.publish && team.gist) return { link: `${base}#${join}&gist=${team.gist}`, warning: '' };
    if (address) {
      return {
        link: `${base}#${join}&server=${encodeURIComponent(address)}`,
        warning: team.publish ? 'The gist is not ready yet, so this link names the current address. It stops working if the address changes.' : '',
      };
    }
    return { link: '', warning: 'There is no address yet: start sharing, or set a fixed address, before making links.' };
  }
  if (address) {
    return { link: `${address}/#${join}`, warning: team.mode === 'fixed' ? '' : 'This link names the current quick tunnel address, which changes when sharing restarts. Use a fixed address, or a live hosted page with the gist, so links last.' };
  }
  return { link: '', warning: 'There is no address yet: start sharing, or set a fixed address, before making links.' };
}

const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-real-ip', 'true-client-ip', 'tailscale-user-login'];

/**
 * Is this request from the laptop itself (not through a tunnel)? Its Host must
 * name 127.0.0.1/localhost and no proxy header may be present: tunnels add
 * them (and keep the public host name), so a tunnelled request is never local.
 */
export function isLocalRequest(req, port) {
  const host = String(req.headers.host || '');
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return false;
  return !FORWARD_HEADERS.some((h) => req.headers[h] != null);
}

/** The bearer key of a request ('' if none). */
export function bearer(req) {
  const m = /^Bearer\s+([\w-]{16,200})$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}

/** https://github.com/Owner/Repo(.git) -> https://owner.github.io/Repo/test-run/ (the Pages workflow's address). */
export function pagesUrlFromRemote(remote) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(remote || '').trim());
  return m ? `https://${m[1].toLowerCase()}.github.io/${m[2]}/test-run/` : '';
}
