// Stores captured API calls and console errors per tab (IndexedDB ring buffer).

import { putMany, pruneTab, deleteOlderThan, deleteFlagged } from '../lib/idb.js';
import { analyzeCall } from '../lib/digit-errors.js';
import { getSettings } from '../lib/settings.js';

const insertsSincePrune = new Map();

export async function storeEvents(tabId, frameId, events, { incognito = false } = {}) {
  if (tabId == null || tabId < 0 || !Array.isArray(events)) return;
  const calls = [];
  const logs = [];
  for (const ev of events) {
    const d = ev?.data;
    if (!d || typeof d !== 'object') continue;
    if (ev.kind === 'call') {
      const a = analyzeCall(d);
      calls.push({ ...d, id: `${tabId}:${d.id}`, tabId, frameId, incognito, failed: a.failed, errCode: a.errCode, errMsg: a.errMsg });
    } else if (ev.kind === 'console') {
      logs.push({ ...d, id: `${tabId}:${d.id}`, tabId, frameId, incognito });
    }
  }
  await putMany('calls', calls);
  await putMany('consoleLogs', logs);

  // Running counters for the popup (cheap to read every second).
  const key = `stats:${tabId}`;
  const cur = (await chrome.storage.session.get(key))[key] || { calls: 0, failed: 0, console: 0 };
  cur.calls += calls.length;
  cur.failed += calls.filter((c) => c.failed).length;
  cur.console += logs.length;
  await chrome.storage.session.set({ [key]: cur });

  const n = (insertsSincePrune.get(tabId) || 0) + calls.length + logs.length;
  if (n >= 50) {
    insertsSincePrune.set(tabId, 0);
    const { network } = await getSettings();
    const minTs = Date.now() - network.retentionMinutes * 60000;
    await pruneTab('calls', tabId, network.maxCalls, minTs);
    await pruneTab('consoleLogs', tabId, 300, minTs);
  } else insertsSincePrune.set(tabId, n);
}

export async function tabStats(tabId) {
  const key = `stats:${tabId}`;
  return (await chrome.storage.session.get(key))[key] || { calls: 0, failed: 0, console: 0 };
}

export async function pruneAll() {
  const { network } = await getSettings();
  const minTs = Date.now() - network.retentionMinutes * 60000;
  await deleteOlderThan('calls', 'ts', minTs);
  await deleteOlderThan('consoleLogs', 'ts', minTs);
}

/** Incognito: once the last Incognito window closes, captured calls and console errors from it are deleted. */
export async function forgetIncognito() {
  await deleteFlagged('calls', 'incognito');
  await deleteFlagged('consoleLogs', 'incognito');
}
