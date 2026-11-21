// Which sites the network/console capture runs on. Only sites you enabled,
// each granted through Chrome's permission prompt.

import { getEnabledSites, saveEnabledSites } from '../lib/settings.js';
import { serial, replaceScripts } from './script-registry.js';

const HOOK_ID = 'egov-br-hook';
const RELAY_ID = 'egov-br-relay';

export async function grantedPatterns() {
  const sites = await getEnabledSites();
  const out = [];
  for (const p of sites) {
    try {
      if (await chrome.permissions.contains({ origins: [p] })) out.push(p);
    } catch {}
  }
  return out;
}

const syncQueue = serial();

/** Capture runs on the enabled, granted sites. One sync at a time, so two can't both register the scripts. */
export function syncContentScripts() {
  return syncQueue(async () => {
    const patterns = await grantedPatterns();
    await replaceScripts([RELAY_ID, HOOK_ID], patterns.length ? [
      { id: RELAY_ID, js: ['content/relay.js'], matches: patterns, runAt: 'document_start', allFrames: true, persistAcrossSessions: true },
      { id: HOOK_ID, js: ['content/net-hook.main.js'], matches: patterns, runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true },
    ] : []);
  });
}

export async function enableSite(pattern, tabId) {
  const sites = await getEnabledSites();
  if (!sites.includes(pattern)) await saveEnabledSites([...sites, pattern]);
  await syncContentScripts();
  if (tabId != null) {
    // Start capturing in the open tab right away (calls made before this moment are missed).
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/relay.js'] });
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/net-hook.main.js'], world: 'MAIN' });
    } catch {}
  }
}

export async function disableSite(pattern) {
  const sites = await getEnabledSites();
  await saveEnabledSites(sites.filter((s) => s !== pattern));
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {}
  await syncContentScripts();
}

export async function isEnabled(pattern) {
  if (!pattern) return false;
  const sites = await getEnabledSites();
  if (!sites.includes(pattern)) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}
