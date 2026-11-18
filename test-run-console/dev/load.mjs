// Load the Apps Script files into a Node vm context, the same way Apps Script
// loads them: one shared global scope, files run in order.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeGlobals } from './fake-sheets.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = join(ROOT, 'apps-script');
export const SERVER_FILES = ['core.gs', 'prompts.gs', 'sheet.gs', 'Code.gs'];

export function loadScripts(files, globals = {}) {
  const ctx = vm.createContext({ console, ...globals });
  for (const f of files) vm.runInContext(readFileSync(join(SRC, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

/** Pure logic only. */
export function loadCore() {
  const ctx = loadScripts(['core.gs', 'prompts.gs']);
  return { TRCore: ctx.TRCore, TRPrompts: ctx.TRPrompts };
}

/** The whole server against a FakeSpreadsheet. Returns { ctx, state, call } where call('api_x', ...args) returns a plain object. */
export function loadServer(ss, env) {
  const { globals, state } = makeGlobals(ss, env);
  const ctx = loadScripts(SERVER_FILES, globals);
  const call = (name, ...args) => {
    if (typeof ctx[name] !== 'function') throw new Error(`No server function ${name}`);
    // Round-trip through JSON like google.script.run does.
    return plain(ctx[name](...plain(args)));
  };
  return { ctx, state, call };
}

/** Values from the vm realm, as plain JSON (also strips undefined like google.script.run). */
export function plain(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}
