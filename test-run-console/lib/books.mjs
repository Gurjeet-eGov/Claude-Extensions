// The workbooks in the sheets folder: listing, opening (and reopening when the
// file changes on disk), saving safely, daily backups, and importing.
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, unlinkSync, accessSync, constants } from 'node:fs';
import { join, basename } from 'node:path';
import { XBook } from './xlsx-book.mjs';
import { createFileStore } from './store.mjs';

const KEEP_BACKUPS = 14;

export function isWorkbookName(name) {
  const n = String(name || '');
  return /\.xlsx$/i.test(n) && n === basename(n) && !n.startsWith('.') && !n.startsWith('~$') && !/[\\/:\0]/.test(n);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class Library {
  constructor(dir) {
    this.dir = dir;
    this.metaDir = join(dir, '.testrun');
    this.open = new Map();
    mkdirSync(this.metaDir, { recursive: true });
  }

  list() {
    let files = [];
    try { files = readdirSync(this.dir); } catch { files = []; }
    return files
      .filter(isWorkbookName)
      .map((name) => {
        const st = statSync(join(this.dir, name));
        return { name, size: st.size, modified: st.mtime.toISOString(), excelOpen: this.excelOpen(name) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Excel (and LibreOffice) leave a lock file next to a workbook while it is open. */
  excelOpen(name) {
    return existsSync(join(this.dir, `~$${name}`)) || existsSync(join(this.dir, `.~lock.${name}#`));
  }

  storeFile(name) {
    return join(this.metaDir, `${name.replace(/\.xlsx$/i, '')}.json`);
  }

  /** Open a workbook; reopen it if the file changed on disk since it was loaded or saved. */
  async get(name) {
    if (!isWorkbookName(name)) throw Object.assign(new Error(`Not a workbook name: ${name}`), { code: 'BAD_INPUT' });
    const file = join(this.dir, name);
    if (!existsSync(file)) throw Object.assign(new Error(`"${name}" is not in the sheets folder any more.`), { code: 'NO_BOOK' });
    const st = statSync(file);
    let entry = this.open.get(name);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      const book = await XBook.fromFile(file, name.replace(/\.xlsx$/i, ''));
      try { accessSync(file, constants.W_OK); } catch { book.readOnly = true; }
      entry = { name, file, book, mtimeMs: st.mtimeMs, size: st.size, store: (entry && entry.store) || createFileStore(this.storeFile(name)), reloaded: !!entry };
      this.open.set(name, entry);
    } else {
      entry.reloaded = false;
    }
    return entry;
  }

  /** Save a workbook if it changed: back up first (once a day), then write a temp file and rename it over the original. */
  async save(entry) {
    entry.store.flush();
    if (!entry.book.dirty) return false;
    this.backup(entry);
    const buf = await entry.book.toBuffer();
    const tmp = join(this.dir, `.${entry.name}.${process.pid}.tmp`);
    writeFileSync(tmp, Buffer.from(buf));
    renameSync(tmp, entry.file);
    const st = statSync(entry.file);
    entry.mtimeMs = st.mtimeMs;
    entry.size = st.size;
    entry.book.dirty = false;
    return true;
  }

  backup(entry) {
    const dir = join(this.metaDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const base = entry.name.replace(/\.xlsx$/i, '');
    const target = join(dir, `${base} ${today()}.xlsx`);
    if (!existsSync(target) && existsSync(entry.file)) copyFileSync(entry.file, target);
    const mine = readdirSync(dir).filter((f) => f.startsWith(`${base} `) && /\d{4}-\d{2}-\d{2}\.xlsx$/.test(f)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) unlinkSync(join(dir, old));
  }

  /** Add a workbook from uploaded bytes. Refuses non-xlsx data and, unless overwrite, existing names. */
  async importFile(name, buf, { overwrite = false } = {}) {
    const clean = basename(String(name || '')).replace(/[\\/:\0]/g, '_');
    if (!isWorkbookName(clean)) throw Object.assign(new Error('Choose an .xlsx file.'), { code: 'BAD_INPUT' });
    if (!buf || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw Object.assign(new Error('That file is not an .xlsx workbook.'), { code: 'BAD_INPUT' });
    await XBook.fromBuffer(buf, clean); // must open cleanly
    const file = join(this.dir, clean);
    if (existsSync(file) && !overwrite) throw Object.assign(new Error(`"${clean}" is already in the sheets folder.`), { code: 'EXISTS' });
    const tmp = join(this.dir, `.${clean}.${process.pid}.tmp`);
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
    this.open.delete(clean);
    return clean;
  }

  path(name) {
    if (!isWorkbookName(name)) throw Object.assign(new Error(`Not a workbook name: ${name}`), { code: 'BAD_INPUT' });
    return join(this.dir, name);
  }
}
