// The sidecar store: settings, findings, inbox drafts and path plans for one
// workbook, kept next to it as sheets/.testrun/<workbook>.json so the workbook
// itself only ever holds test data.
//
// Interface used by lib/sheet.js (as the TRStore global):
//   list(kind) -> [{ key, value, updated, by }]
//   get(kind, key) -> value | null
//   put(kind, key, value, { updated, by })
//   remove(kind, key)
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export function createMemoryStore(initial) {
  const data = initial ? clone(initial) : { version: 1, kinds: {} };
  const store = {
    dirty: false,
    data,
    list(kind) {
      const items = data.kinds[kind] || {};
      return Object.keys(items).map((key) => ({ key, value: clone(items[key].value), updated: items[key].updated || '', by: items[key].by || '' }));
    },
    get(kind, key) {
      const items = data.kinds[kind] || {};
      return Object.prototype.hasOwnProperty.call(items, key) ? clone(items[key].value) : null;
    },
    put(kind, key, value, meta = {}) {
      const items = data.kinds[kind] || (data.kinds[kind] = {});
      items[String(key)] = { value: clone(value), updated: meta.updated || '', by: meta.by || '' };
      store.dirty = true;
    },
    remove(kind, key) {
      const items = data.kinds[kind];
      if (items && Object.prototype.hasOwnProperty.call(items, key)) {
        delete items[key];
        store.dirty = true;
      }
    },
  };
  return store;
}

/** A store backed by a JSON file; call flush() after changes (written atomically). */
export function createFileStore(file) {
  let initial = null;
  if (existsSync(file)) {
    try {
      initial = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw Object.assign(new Error(`The console's data file for this workbook is damaged: ${file} (${e.message}). Move it aside to start fresh.`), { code: 'STORE_BROKEN' });
    }
    if (!initial || typeof initial !== 'object' || !initial.kinds) initial = null;
  }
  const store = createMemoryStore(initial);
  store.file = file;
  store.flush = () => {
    if (!store.dirty) return false;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store.data, null, 2));
    renameSync(tmp, file);
    store.dirty = false;
    return true;
  };
  return store;
}
