// eGov Bug Reporter — service worker.

import { storeEvents, tabStats, pruneAll, forgetIncognito } from './network-store.js';
import { syncContentScripts, enableSite, disableSite, isEnabled } from './site-access.js';
import {
  startRecording,
  startTestRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  toggleRecording,
  recStatus,
  recorderCall,
  updateBadge,
  flashBadge,
} from './recorder-control.js';
import { put, get, newId, deleteOlderThan } from '../lib/idb.js';
import { getSettings, originPattern } from '../lib/settings.js';
import { syncLocScripts, startLoc, stopLoc, saveLoc, storeFound, locStatus, exportCsv } from './loc-tracking.js';

// ---------- lifecycle ----------

/** Brings the registered content scripts in line with the settings; a failure is logged, not thrown. */
async function syncScripts() {
  try {
    await syncContentScripts();
    await syncLocScripts();
  } catch (e) {
    console.warn('Bug Reporter: could not set up the content scripts', e);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncScripts();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncScripts();
  await updateBadge('idle');
});

chrome.permissions.onRemoved.addListener(() => { syncScripts(); });

(async function housekeeping() {
  try {
    await pruneAll();
    const { housekeeping } = await getSettings();
    const minTs = Date.now() - housekeeping.tempDays * 86400000;
    await deleteOlderThan('media', 'createdAt', minTs);
    await deleteOlderThan('reports', 'createdAt', minTs);
  } catch {}
})();

// ---------- helpers ----------

/** The app tab: active tab of the last focused normal window (not DevTools). */
async function targetTab(hint) {
  if (hint?.id != null && hint.id >= 0 && !String(hint.url || '').startsWith(chrome.runtime.getURL(''))) return hint;
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
    if (t && !String(t.url || '').startsWith(chrome.runtime.getURL(''))) return t;
  } catch {}
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t;
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

/** Snapshot from the recording (full window, DevTools included), else the visible tab. */
async function takeSnapshot(tab) {
  const status = await recStatus();
  if (status.state === 'recording' || status.state === 'paused') {
    const r = await recorderCall('snapshot');
    if (r.ok) return { mediaId: r.mediaId, source: 'recording' };
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await dataUrlToBlob(dataUrl);
    const id = newId('m');
    await put('media', { id, kind: 'image', mime: 'image/png', blob, size: blob.size, createdAt: Date.now(), source: 'tab' });
    return { mediaId: id, source: 'tab' };
  } catch (e) {
    return { mediaId: null, error: String(e?.message || e) };
  }
}

async function addToTray(mediaId) {
  const { tray = [] } = await chrome.storage.session.get('tray');
  tray.push(mediaId);
  await chrome.storage.session.set({ tray });
  return tray.length;
}

async function snapshotOnly(hintTab) {
  const tab = await targetTab(hintTab);
  const r = await takeSnapshot(tab);
  if (r.mediaId) {
    const n = await addToTray(r.mediaId);
    await flashBadge(`📸${n}`);
  } else {
    await flashBadge('ERR');
  }
  return r;
}

/** Halt & report: pause recording, snapshot, freeze the log at this instant, open the form. */
async function haltAndReport(hintTab, mode = 'report') {
  const tab = await targetTab(hintTab);
  const status = await recStatus();
  const wasRecording = status.state === 'recording';
  if (wasRecording) await pauseRecording();
  const snap = await takeSnapshot(tab);
  let recording = null;
  if (status.state === 'recording' || status.state === 'paused' || status.state === 'stopped') {
    const h = await recorderCall('mark-halt');
    if (h.ok && h.videoTs) recording = { videoTs: h.videoTs, wall: h.wall, wasRecording };
  }
  const { tray = [] } = await chrome.storage.session.get('tray');
  await chrome.storage.session.set({ tray: [] });
  const media = [...tray, snap.mediaId].filter(Boolean);
  const report = {
    id: newId('r'),
    createdAt: Date.now(),
    haltWall: Date.now(),
    tabId: tab?.id ?? null,
    pageUrl: tab?.url || '',
    pageTitle: tab?.title || '',
    incognito: Boolean(tab?.incognito),
    mode: mode === 'update' ? 'update' : 'report',
    media,
    snapshotError: snap.mediaId ? null : snap.error,
    recording,
  };
  await put('reports', report);
  await openExtensionTab(`report/report.html?id=${report.id}${report.mode === 'update' ? '&mode=update' : ''}`, tab);
  return { ok: true, reportId: report.id };
}

/**
 * Opens an extension page next to the app tab. Extension pages can't open inside an
 * Incognito window, so for an Incognito tab the page opens in a regular window
 * (an existing one, or a new one).
 */
async function openExtensionTab(path, tab) {
  const url = chrome.runtime.getURL(path);
  if (tab && !tab.incognito) {
    return chrome.tabs.create({ url, index: tab.index + 1, windowId: tab.windowId, openerTabId: tab.id });
  }
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const regular = wins.find((w) => !w.incognito && w.focused) || wins.find((w) => !w.incognito);
  if (regular) {
    const t = await chrome.tabs.create({ url, windowId: regular.id, active: true });
    await chrome.windows.update(regular.id, { focused: true });
    return t;
  }
  const w = await chrome.windows.create({ url, focused: true });
  return w.tabs?.[0];
}

// Incognito: when the last Incognito window closes, forget what was captured there.
chrome.windows.onRemoved.addListener(async () => {
  try {
    const wins = await chrome.windows.getAll();
    if (!wins.some((w) => w.incognito)) await forgetIncognito();
  } catch {}
});

// ---------- shortcuts ----------

chrome.commands.onCommand.addListener((command, tab) => {
  const run = {
    'toggle-recording': () => toggleRecording(),
    'halt-report': () => haltAndReport(tab),
    'update-issue': () => haltAndReport(tab, 'update'),
    snapshot: () => snapshotOnly(tab),
    'stop-recording': () => stopRecording(),
  }[command];
  run?.().catch((e) => console.error('command failed', command, e));
});

// ---------- messages ----------

const handlers = {
  async 'net-events'(msg, sender) {
    await storeEvents(sender.tab?.id, sender.frameId, msg.events, { incognito: Boolean(sender.tab?.incognito) });
    return { ok: true };
  },
  async 'rec-state'(msg) {
    await updateBadge(msg.state === 'stopped' ? 'stopped' : msg.state);
    return { ok: true };
  },
  async 'popup-state'(msg) {
    const tab = msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : await targetTab();
    const pattern = originPattern(tab?.url);
    const [rec, stats, enabled, sess] = await Promise.all([
      recStatus(),
      tab ? tabStats(tab.id) : null,
      isEnabled(pattern),
      chrome.storage.session.get('tray'),
    ]);
    return { tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null, pattern, enabled, rec, stats, tray: (sess.tray || []).length };
  },
  async 'site-enable'(msg) {
    await enableSite(msg.pattern, msg.tabId);
    await syncLocScripts();
    return { ok: true };
  },
  async 'site-disable'(msg) {
    await disableSite(msg.pattern);
    await syncLocScripts();
    return { ok: true };
  },
  // ---- Track Localizations ----
  async 'loc-found'(msg, sender) {
    return storeFound(msg.host || (sender.tab?.url ? new URL(sender.tab.url).host : ''), msg.items);
  },
  async 'loc-start'(msg) {
    return startLoc({ tabUrl: msg.tabUrl });
  },
  async 'loc-stop'(msg) {
    return stopLoc({ save: msg.save !== false });
  },
  async 'loc-save'() {
    return saveLoc();
  },
  async 'loc-status'() {
    return { ok: true, ...(await locStatus()) };
  },
  async 'loc-export'() {
    return { ok: true, files: await exportCsv() };
  },
  async 'rec-start'() {
    return startRecording();
  },
  async 'rec-status'() {
    return { ok: true, ...(await recStatus()) };
  },
  async 'rec-start-test'() {
    return startTestRecording();
  },
  async 'rec-pause'() {
    return pauseRecording();
  },
  async 'rec-resume'() {
    return resumeRecording();
  },
  async 'rec-stop'() {
    return stopRecording();
  },
  async 'rec-discard'() {
    const r = await recorderCall('discard');
    await updateBadge('idle');
    return r;
  },
  async snapshot(msg) {
    return snapshotOnly(msg.tabId != null ? await chrome.tabs.get(msg.tabId) : null);
  },
  async halt(msg) {
    return haltAndReport(msg.tabId != null ? await chrome.tabs.get(msg.tabId) : null, msg.mode);
  },
  async 'report-get'(msg) {
    return { ok: true, report: await get('reports', msg.id) };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'recorder') return false;
  const h = handlers[msg.type];
  if (!h) return false;
  h(msg, sender).then(
    (r) => sendResponse(r),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});
