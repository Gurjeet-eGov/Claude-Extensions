// Runs the console's logic (lib/core.js, prompts.js, sheet.js, api.js) in a
// vm context: one shared global scope, files loaded in order. The host supplies
// the open workbook (a sheet API: lib/xlsx-book.mjs or dev/fake-sheets.mjs) and
// its sidecar store (lib/store.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIB = join(ROOT, 'lib');
export const LOGIC_FILES = ['core.js', 'prompts.js', 'sheet.js', 'api.js'];

export function loadScripts(files, globals = {}) {
  const ctx = vm.createContext({ console, ...globals });
  for (const f of files) vm.runInContext(readFileSync(join(LIB, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

/** Pure logic only (core + prompts). */
export function loadCore() {
  const ctx = loadScripts(['core.js', 'prompts.js']);
  return { TRCore: ctx.TRCore, TRPrompts: ctx.TRPrompts };
}

/** Values from the vm realm as plain JSON (undefined dropped, like a JSON API). */
export function plain(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The whole logic layer.
 *   sheetsApi: { CopyPasteType, DataValidationCriteria, newDataValidation } of the back end
 *   getBook(): the open workbook;  getStore(): its sidecar store
 *   env: { user, now }  (now: a fixed time, for tests)
 * Returns { ctx, state, call(name, ...args) }; state.user and state.now can change between calls.
 */
export function createRuntime({ sheetsApi, getBook, getStore, env = {} }) {
  const state = { user: env.user || '', now: env.now || null };
  const lock = { tryLock: () => true, waitLock: () => {}, releaseLock: () => {} };
  const globals = {
    SpreadsheetApp: { ...sheetsApi, getActiveSpreadsheet: () => getBook(), getActive: () => getBook(), flush: () => {} },
    TRStore: {
      list: (kind) => getStore().list(kind),
      get: (kind, key) => getStore().get(kind, key),
      put: (kind, key, value, meta) => getStore().put(kind, key, value, meta),
      remove: (kind, key) => getStore().remove(kind, key),
    },
    LockService: { getDocumentLock: () => lock, getScriptLock: () => lock },
    Session: { getActiveUser: () => ({ getEmail: () => state.user }) },
    Utilities: {
      formatDate: (d) => {
        const t = state.now ? new Date(state.now) : d;
        return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
      },
    },
    Logger: { log: () => {} },
  };
  const ctx = loadScripts(LOGIC_FILES, globals);
  const call = (name, ...args) => {
    if (!/^api_\w+$/.test(name) || typeof ctx[name] !== 'function') throw new Error(`No such function: ${name}`);
    return plain(ctx[name](...plain(args)));
  };
  return { ctx, state, call };
}
