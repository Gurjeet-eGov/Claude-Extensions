// Locked automated results on the published site. Each published run is encrypted with age
// (https://age-encryption.org; the age-encryption package is typage, its reference TypeScript
// implementation). On the data branch, beside workbooks/ and reports/:
//
//   automation/index.json     public: per run only { id, book (the workbook's slug), publishedAt, bytes }
//   automation/<id>/key.age   the run's own random age identity, encrypted to everyone who may open the run
//   automation/<id>/meta.age  what the Automated summary needs (JSON), encrypted to the run's identity
//   automation/<id>/run.age   the run view's data (gzipped JSON), encrypted to the run's identity
//
// Who may open a run (its recipients): the host (a random identity kept in app.json, readable by
// the host only), the admin link, and every person whose workbooks include the run's workbook and
// whose automated suites include the run's suite. A person's age identity is derived from their
// invite key, so there is nothing more to remember:
//
//   HKDF-SHA256(ikm = the key's 24 raw bytes, salt "test-run", info "automation results v1", 32 bytes)
//   -> an age X25519 secret key, "AGE-SECRET-KEY-1…" (bech32)
//
// A key that isn't the usual 32 base64url characters is used as its UTF-8 bytes. The published page
// runs the same derivation in the browser (ui/vendor/age.js, from the key kept in this browser).
//
// Sealing is cached per run, keyed by (run id, a hash of what goes inside, a hash of the recipients),
// so a publish with nothing new makes the same bytes and no new commit. When the recipients change
// (New Link, Remove, a change of access) the next publish locks the run again under a NEW run
// identity: whoever opened the old key.age learns nothing about the new files.
import { Encrypter, Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { bech32 } from '@scure/base';
import { hkdfSync, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanBooks, maySeeSuite } from '../team.mjs';
import { RUN_ID } from './results.mjs';

export const KDF = { salt: 'test-run', info: 'automation results v1' };
export const FILES = ['key.age', 'meta.age', 'run.age'];
/** An age X25519 identity as age writes it (bech32, upper case). */
export const IDENTITY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** An invite key's bytes: the 24 raw bytes of the usual 32-character base64url key, else its UTF-8 text. */
export function keyBytes(key) {
  const k = String(key == null ? '' : key);
  return /^[A-Za-z0-9_-]{32}$/.test(k) ? Buffer.from(k, 'base64url') : Buffer.from(k, 'utf8');
}

/** The age identity an invite key (or the admin link's key) opens results with. */
export function identityFromKey(key) {
  if (!key) throw new Error('No key to derive an identity from.');
  const okm = Buffer.from(hkdfSync('sha256', keyBytes(key), KDF.salt, KDF.info, 32));
  return bech32.encodeFromBytes('AGE-SECRET-KEY-', okm).toUpperCase();
}

/** The public half of an identity: "age1…". */
export const recipientOf = (identity) => identityToRecipient(identity);

/** A new random identity (the host's, or a run's). */
export const newIdentity = () => generateIdentity();

/** app.json's lock block: { identity } (the host's own age identity) when there is a good one. */
export function cleanLock(l) {
  const id = l && typeof l.identity === 'string' ? l.identity.trim() : '';
  return IDENTITY.test(id) ? { identity: id } : {};
}

// Deriving a recipient costs a scalar multiplication; people's keys change rarely.
const derived = new Map();
async function recipientForKey(key) {
  const k = sha256(`key:${key}`);
  if (!derived.has(k)) {
    if (derived.size > 500) derived.clear();
    derived.set(k, await recipientOf(identityFromKey(key)));
  }
  return derived.get(k);
}

/**
 * Who may open a run: [{ who: 'host' | 'admin' | <person id>, name, recipient }], one entry per
 * recipient. run: a run or its meta ({ suiteId, attach: { book } }). team: app.team (normalized).
 * A person whose link can't be copied again (no key kept) can't be derived, so isn't included.
 */
export async function recipientsFor(run, { team, hostIdentity } = {}) {
  const out = [];
  if (hostIdentity) out.push({ who: 'host', name: 'Host', recipient: await recipientOf(hostIdentity) });
  if (team && team.admin && team.admin.key) out.push({ who: 'admin', name: 'Admin link', recipient: await recipientForKey(team.admin.key) });
  for (const p of (team && team.people) || []) {
    if (!p || !p.key) continue;
    const books = cleanBooks(p.books);
    if (books && !books.includes(run.attach.book)) continue;
    if (!maySeeSuite({ role: p.role, automationSuites: p.automationSuites }, run.suiteId)) continue;
    out.push({ who: p.id, name: p.name, recipient: await recipientForKey(p.key) });
  }
  const seen = new Set();
  return out.filter((r) => !seen.has(r.recipient) && seen.add(r.recipient));
}

/** Encrypt to these recipients ("age1…"). */
export async function seal(plain, recipients) {
  if (!recipients.length) throw new Error('Nobody to lock it for.');
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return Buffer.from(await e.encrypt(typeof plain === 'string' ? plain : new Uint8Array(plain)));
}

/** Decrypt with an identity; null when it isn't one of the file's recipients. */
export async function unseal(cipher, identity) {
  const d = new Decrypter();
  d.addIdentity(identity);
  try {
    return Buffer.from(await d.decrypt(new Uint8Array(cipher)));
  } catch (e) {
    if (/no identity matched/i.test(String(e && e.message))) return null;
    throw e;
  }
}

/** One run's three files, locked under a new run identity: { 'key.age', 'meta.age', 'run.age' } (Buffers). */
export async function sealRun({ meta, detail }, recipients) {
  const runIdentity = await newIdentity();
  const runRecipient = await recipientOf(runIdentity);
  return {
    'key.age': await seal(runIdentity, recipients),
    'meta.age': await seal(JSON.stringify(meta), [runRecipient]),
    'run.age': await seal(gzipSync(Buffer.from(JSON.stringify(detail))), [runRecipient]),
  };
}

/** What a sealed run holds, for this identity: { meta, detail } (detail null without run.age), or null when it doesn't open it. */
export async function openRun(files, identity) {
  const key = await unseal(files['key.age'], identity);
  if (!key) return null;
  const runIdentity = key.toString('utf8');
  const meta = JSON.parse((await unseal(files['meta.age'], runIdentity)).toString('utf8'));
  const detail = files['run.age'] ? JSON.parse(gunzipSync(await unseal(files['run.age'], runIdentity)).toString('utf8')) : null;
  return { meta, detail };
}

/**
 * Sealed runs kept on the laptop (sheets/.testrun/automation/sealed/<id>/: the three files and
 * stamp.json { content, recipients, sealedAt }), so an unchanged run publishes the same bytes.
 */
export class SealCache {
  constructor(dir) { this.dir = dir; }

  get(id, content, recipients) {
    if (!RUN_ID.test(String(id))) return null;
    const d = join(this.dir, id);
    try {
      const st = JSON.parse(readFileSync(join(d, 'stamp.json'), 'utf8'));
      if (st.content !== content || st.recipients !== recipients) return null;
      const files = {};
      for (const f of FILES) files[f] = readFileSync(join(d, f));
      return { files, sealedAt: String(st.sealedAt || '') };
    } catch {
      return null;
    }
  }

  put(id, content, recipients, files, sealedAt) {
    if (!RUN_ID.test(String(id))) return;
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${id}.${process.pid}.${randomBytes(3).toString('hex')}`);
    mkdirSync(tmp);
    for (const f of FILES) writeFileSync(join(tmp, f), files[f]);
    writeFileSync(join(tmp, 'stamp.json'), JSON.stringify({ content, recipients, sealedAt }));
    rmSync(join(this.dir, id), { recursive: true, force: true });
    renameSync(tmp, join(this.dir, id));
  }

  /** Forget runs that are not published any more. */
  prune(keep) {
    let names = [];
    try { names = readdirSync(this.dir); } catch { return; }
    for (const n of names) if (!keep.has(n)) rmSync(join(this.dir, n), { recursive: true, force: true });
  }
}

/** Hashes that say when a run must be sealed again: what goes inside, and who it is for. */
export const contentHash = (meta, detail) => sha256(`${JSON.stringify(meta)}\n${JSON.stringify(detail)}`);
export const recipientsHash = (list) => sha256([...new Set(list)].sort().join('\n'));

/**
 * The automation/ files of a publish. items: [{ id, slug, meta, detail, recipients: ['age1…'] }],
 * newest first. Runs nobody may open are left out. Returns { files: [{ path, content }], index, sealed }
 * (sealed: how many were locked anew rather than taken from the cache). No runs: no files at all.
 */
export async function sealRuns(items, { cache = null, prefix = '', now = new Date() } = {}) {
  const files = [];
  const index = { version: 1, runs: [] };
  let sealed = 0;
  const kept = new Set();
  for (const it of items) {
    if (!it.recipients.length) continue;
    const content = contentHash(it.meta, it.detail);
    const rcpt = recipientsHash(it.recipients);
    let hit = cache ? cache.get(it.id, content, rcpt) : null;
    if (!hit) {
      hit = { files: await sealRun(it, it.recipients), sealedAt: now.toISOString() };
      if (cache) cache.put(it.id, content, rcpt, hit.files, hit.sealedAt);
      sealed++;
    }
    kept.add(it.id);
    let bytes = 0;
    for (const f of FILES) {
      files.push({ path: `${prefix}automation/${it.id}/${f}`, content: hit.files[f] });
      bytes += hit.files[f].length;
    }
    index.runs.push({ id: it.id, book: it.slug, publishedAt: hit.sealedAt, bytes });
  }
  if (cache) cache.prune(kept);
  if (index.runs.length) files.push({ path: `${prefix}automation/index.json`, content: Buffer.from(JSON.stringify(index, null, 1)) });
  return { files, index, sealed };
}

/** Is this a path of the published automation/ folder (index.json, or a run's .age file)? */
export function isAutomationPath(p) {
  return p === 'automation/index.json' || /^automation\/\d{8}-\d{6}-[0-9a-f]{6}\/(key|meta|run)\.age$/.test(p);
}

