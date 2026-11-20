// Evidence from Test Run Extension: screenshots and screen recordings attached to test
// cases: one screenshot and one recording per case and cycle. They stay on the host, in sheets/.testrun/evidence/
// (never published), with an index per workbook. Also the media limits everyone records
// with (set by the host in Setup → Media), and the Complete Report zip: the workbook
// plus every suite's evidence.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import archiver from 'archiver';

export const MB = 1024 * 1024;
/** Every file, photo or video, is at most this big. */
export const MAX_FILE_BYTES = 20 * MB;
export const FPS = 30;
/** Video quality: the largest size a recording is scaled to fit, and its bitrate. */
export const QUALITIES = {
  '720p': { width: 1280, height: 720, bitrate: 1500000 },
  '1080p': { width: 1920, height: 1080, bitrate: 2500000 },
};
export const PHOTO = { width: 1920, height: 1080, type: 'image/png' };
/** How long a Complete Report zip is kept (minutes). */
export const KEEP_OPTIONS = [15, 30, 60];

export function normalizeMedia(m = {}) {
  return {
    quality: QUALITIES[m && m.quality] ? m.quality : '1080p',
    keepMinutes: KEEP_OPTIONS.includes(Number(m && m.keepMinutes)) ? Number(m.keepMinutes) : 60,
  };
}

/** What everyone records with: the host's choice plus the fixed limits. */
export function mediaLimits(media) {
  const q = QUALITIES[media.quality];
  return {
    quality: media.quality,
    qualities: Object.keys(QUALITIES),
    width: q.width,
    height: q.height,
    fps: FPS,
    bitrate: q.bitrate,
    maxBytes: MAX_FILE_BYTES,
    maxSeconds: Math.floor((MAX_FILE_BYTES * 8) / q.bitrate), // about; recording stops by size
    photo: PHOTO,
    keepMinutes: media.keepMinutes,
    keepOptions: KEEP_OPTIONS,
  };
}

/** What a file is, from its first bytes: a PNG photo, or a WebM or MP4 video. null for anything else. */
export function evidenceType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { kind: 'photo', ext: 'png' };
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', ext: 'webm' };
  if (buf.toString('latin1', 4, 8) === 'ftyp') return { kind: 'video', ext: 'mp4' };
  return null;
}

/** A name safe as one file or folder name on every system: "CMS/07" -> "CMS-07". */
export function safeName(s, fallback = 'item') {
  const v = String(s == null ? '' : s)
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
  return v || fallback;
}

const pad = (n) => String(n).padStart(2, '0');
/** 2026-11-20_14-32-05, local time. */
export function fileStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export const KINDS = ['photo', 'video'];
const keyOf = (tab, cycle, caseKey, kind) => `${tab}\u0001${cycle || ''}\u0001${caseKey}\u0001${kind}`;

function walkBytes(dir) {
  let n = 0;
  let list = [];
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += walkBytes(p);
    else if (e.isFile()) { try { n += statSync(p).size; } catch { /* gone */ } }
  }
  return n;
}

export class EvidenceStore {
  constructor(sheetsDir) {
    this.root = join(sheetsDir, '.testrun', 'evidence');
  }

  dirOf(book) { return join(this.root, safeName(String(book).replace(/\.xlsx$/i, ''), 'workbook')); }
  indexFile(book) { return join(this.dirOf(book), 'index.json'); }

  read(book) {
    let idx;
    try { idx = JSON.parse(readFileSync(this.indexFile(book), 'utf8')); } catch { idx = null; }
    if (!idx || !idx.items || typeof idx.items !== 'object') return { version: 2, items: {} };
    // version 1 kept one file per case: key it by its kind now
    const items = {};
    for (const it of Object.values(idx.items)) if (it && KINDS.includes(it.kind)) items[keyOf(it.tab, it.cycle, it.caseKey, it.kind)] = it;
    return { version: 2, items };
  }

  write(book, idx) {
    const file = this.indexFile(book);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 1));
    renameSync(tmp, file);
  }

  get(book, tab, cycle, caseKey, kind) {
    return this.read(book).items[keyOf(tab, cycle, caseKey, kind)] || null;
  }

  /** A case's files in a cycle: { photo?, video? }. */
  forCase(book, tab, cycle, caseKey) {
    const out = {};
    for (const kind of KINDS) { const it = this.get(book, tab, cycle, caseKey, kind); if (it) out[kind] = it; }
    return out;
  }

  /** The evidence of one suite and cycle: { caseKey: { photo?, video? } }. */
  forCycle(book, tab, cycle) {
    const out = {};
    for (const it of Object.values(this.read(book).items)) if (it.tab === tab && (it.cycle || '') === (cycle || '')) (out[it.caseKey] = out[it.caseKey] || {})[it.kind] = it;
    return out;
  }

  /** Every item of a workbook (every suite and cycle). */
  all(book) {
    return Object.values(this.read(book).items);
  }

  /**
   * Attach a file to a case and cycle: one screenshot and one recording each. An earlier
   * file of the same kind is deleted for good. usedFor: the result it backs ('' until a
   * result is marked with it).
   */
  put(book, { tab, cycle, caseKey, caseId, buf, type, by, usedFor = '' }) {
    const idx = this.read(book);
    const k = keyOf(tab, cycle, caseKey, type.kind);
    const old = idx.items[k];
    const folder = join(safeName(tab, 'suite'), safeName(cycle, 'status'));
    mkdirSync(join(this.dirOf(book), folder), { recursive: true });
    const base = `${safeName(caseId || caseKey, 'case')}_${safeName(cycle, 'status')}_${fileStamp()}`;
    let name = `${base}.${type.ext}`;
    for (let i = 2; existsSync(join(this.dirOf(book), folder, name)); i++) name = `${base}-${i}.${type.ext}`;
    const rel = join(folder, name);
    const tmp = join(this.dirOf(book), `${rel}.${process.pid}.tmp`);
    writeFileSync(tmp, buf);
    renameSync(tmp, join(this.dirOf(book), rel));
    const item = { tab, cycle: cycle || '', caseKey, caseId: caseId || '', file: rel, name, kind: type.kind, ext: type.ext, size: buf.length, by: by || '', at: new Date().toISOString(), usedFor };
    idx.items[k] = item;
    this.write(book, idx);
    if (old) this.unlinkItem(book, old);
    return item;
  }

  setUsed(book, tab, cycle, caseKey, kind, status) {
    const idx = this.read(book);
    const it = idx.items[keyOf(tab, cycle, caseKey, kind)];
    if (!it) return null;
    it.usedFor = status;
    this.write(book, idx);
    return it;
  }

  /** Detach and delete one of a case's files for good. Returns the removed item, or null. */
  remove(book, tab, cycle, caseKey, kind) {
    const idx = this.read(book);
    const k = keyOf(tab, cycle, caseKey, kind);
    const it = idx.items[k];
    if (!it) return null;
    delete idx.items[k];
    this.write(book, idx);
    this.unlinkItem(book, it);
    return it;
  }

  unlinkItem(book, it) {
    try { unlinkSync(join(this.dirOf(book), it.file)); } catch { /* already gone */ }
  }

  pathOf(book, it) { return join(this.dirOf(book), it.file); }

  /** A workbook is deleted: its evidence goes too. */
  removeBook(book) {
    rmSync(this.dirOf(book), { recursive: true, force: true });
  }

  usedBytes() { return walkBytes(this.root); }
  bookBytes(book) { return this.all(book).reduce((n, it) => n + (it.size || 0), 0); }
}

/** About how long a Complete Report takes (seconds): copying is the work, the files are already compressed. */
export function reportSeconds(bytes) {
  return Math.ceil(3 + bytes / (60 * MB));
}

/**
 * Write the Complete Report zip: the workbook, and each evidence file under
 * Evidence/<suite>/<cycle>/<case>/. Stored, not compressed again (photos and videos
 * already are). Resolves the zip's size.
 */
export function writeCompleteZip({ out, xlsx, xlsxName, items, store }) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.part`;
    const ws = createWriteStream(tmp);
    const zip = archiver('zip', { store: true });
    const fail = (e) => { try { unlinkSync(tmp); } catch { /* none */ } reject(e); };
    ws.on('close', () => { try { renameSync(tmp, out); resolve(statSync(out).size); } catch (e) { reject(e); } });
    ws.on('error', fail);
    zip.on('error', fail);
    zip.pipe(ws);
    zip.append(xlsx, { name: xlsxName });
    for (const it of items) {
      const src = store.pathOf(it.book, it);
      if (!existsSync(src)) continue;
      zip.file(src, { name: `Evidence/${safeName(it.tab, 'suite')}/${safeName(it.cycle, 'Status')}/${safeName(it.caseId || it.caseKey, 'case')}/${it.name}` });
    }
    zip.finalize();
  });
}
