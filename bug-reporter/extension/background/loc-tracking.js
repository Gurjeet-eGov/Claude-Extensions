// Track Localizations (service-worker side): turns tracking on/off, stores each unique
// (host, page, code) found by content/loc-tracker.js, and saves the list as a CSV through
// Chrome's "Save as" dialog. Only unique pairs are kept (a few dozen bytes each), so even
// very long sessions stay small.

import '../content/loc-rules.js'; // defines globalThis.EgovLocRules
import { addNew, clearStore, getAll, newId } from '../lib/idb.js';
import { grantedPatterns } from './site-access.js';
import { serial, replaceScripts } from './script-registry.js';
import { updateBadge } from './recorder-control.js';

const R = globalThis.EgovLocRules;
const SCRIPT_ID = 'egov-br-loc';
const FILES = ['content/loc-rules.js', 'content/loc-tracker.js'];
const MAX_ROWS = 100000; // safety stop; real sessions are far below this

export async function locState() {
  const { locTracking } = await chrome.storage.local.get('locTracking');
  return locTracking || { active: false };
}

async function setState(patch) {
  const next = { ...(await locState()), ...patch };
  await chrome.storage.local.set({ locTracking: next });
  return next;
}

async function refreshBadge() {
  const { recState } = await chrome.storage.session.get('recState');
  await updateBadge(recState || 'idle');
}

const syncQueue = serial();

/** The tracker runs on the sites you enabled, only while tracking is on. One sync at a time. */
export function syncLocScripts() {
  return syncQueue(async () => {
    const st = await locState();
    const patterns = st.active ? await grantedPatterns() : [];
    await replaceScripts([SCRIPT_ID], patterns.length ? [
      { id: SCRIPT_ID, js: FILES, matches: patterns, runAt: 'document_idle', allFrames: true, persistAcrossSessions: true },
    ] : []);
  });
}

export async function startLoc({ tabUrl } = {}) {
  await clearStore('locs');
  let startHost = '';
  try {
    startHost = new URL(tabUrl).host;
  } catch {}
  const st = await setState({ active: true, sessionId: newId('l'), startedAt: Date.now(), stoppedAt: null, saved: false, startHost, full: false });
  await syncLocScripts();
  // Start right away in tabs that are already open (no reload needed).
  const patterns = await grantedPatterns();
  if (patterns.length) {
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const t of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: FILES });
      } catch {}
    }
  }
  await refreshBadge();
  return { ok: true, ...st };
}

export async function storeFound(host, items) {
  const st = await locState();
  if (!st.active || st.full || !Array.isArray(items) || !host) return { ok: false };
  const now = Date.now();
  const rows = items
    .filter((i) => i && typeof i.code === 'string' && typeof i.page === 'string' && i.code.length <= 200 && i.page.length <= 500)
    .map((i) => ({ id: `${host}|${i.page}|${i.code}`, host, page: i.page, code: i.code, firstSeen: now }));
  const added = await addNew('locs', rows);
  if (added) {
    const all = await getAll('locs');
    if (all.length >= MAX_ROWS) await setState({ full: true });
  }
  return { ok: true, added };
}

export async function locStatus() {
  const st = await locState();
  const rows = await getAll('locs');
  const pages = new Set(rows.map((r) => `${r.host}|${r.page}`));
  return { ...st, count: rows.length, pages: pages.size, hosts: [...new Set(rows.map((r) => r.host))] };
}

/** One CSV per site (normally just one): { 'bgrm_bomet_go_ke': 'Code,Page\r\n…' } */
export async function exportCsv() {
  const st = await locState();
  const rows = await getAll('locs');
  const byHost = new Map();
  for (const r of rows) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }
  if (!byHost.size) byHost.set(st.startHost || 'localizations', []); // nothing found: still give a file
  const files = {};
  for (const [host, list] of byHost) files[R.fileBaseForHost(host)] = R.toCsv(list);
  return files;
}

function toDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:text/csv;charset=utf-8;base64,${btoa(bin)}`;
}

/** Opens Chrome's "Save as" dialog for each file, so you choose the folder. */
export async function saveLoc() {
  const files = await exportCsv();
  const ids = [];
  for (const [base, csv] of Object.entries(files)) {
    ids.push(await chrome.downloads.download({ url: toDataUrl(csv), filename: `${base}.csv`, saveAs: true, conflictAction: 'uniquify' }));
  }
  await setState({ saved: true });
  return { ok: true, files: Object.keys(files).map((b) => `${b}.csv`), downloadIds: ids };
}

export async function stopLoc({ save = true } = {}) {
  await setState({ active: false, stoppedAt: Date.now() });
  await syncLocScripts();
  await refreshBadge();
  return save ? saveLoc() : { ok: true };
}
