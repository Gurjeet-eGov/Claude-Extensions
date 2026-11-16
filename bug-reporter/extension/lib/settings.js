// Settings, projects and site list, stored in chrome.storage.local.

export const HOST_NAME = 'com.egov.bug_reporter';

export const DEFAULT_SETTINGS = {
  recording: {
    fps: 15,
    maxWidth: 1920,
    bitrateKbps: 1000,
    keyIntervalSec: 2,
    clipSeconds: 60,
    capMB: 10,
    bufferMinutes: 15,
  },
  claude: {
    model: 'sonnet', // sonnet | haiku | opus | default (pinned to exact model IDs by the helper)
    effort: 'low', // low | medium | high
    detail: 'detailed', // detailed: Claude also reads condensed request/response of attached calls | concise
    sendScreenshot: false,
    skillPath: '', // empty = skill bundled with the helper
  },
  network: {
    maxCalls: 500,
    retentionMinutes: 30,
    truncateKB: 8,
  },
  housekeeping: {
    tempDays: 3,
  },
};

export const MODEL_LABELS = {
  haiku: 'Haiku 5.5',
  sonnet: 'Sonnet 5.5',
  opus: 'Opus 5.5',
  default: 'Claude Code default',
};

function merge(defaults, saved) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v, ...(saved?.[k] || {}) } : saved?.[k] ?? v;
  }
  return out;
}

const SETTINGS_VERSION = 2;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = merge(DEFAULT_SETTINGS, settings);
  // v2: the default model moved from Haiku to Sonnet 5.5 (pinned IDs, thinking off).
  if (settings && (settings.version || 1) < SETTINGS_VERSION) {
    merged.claude.model = 'sonnet';
    merged.version = SETTINGS_VERSION;
    await chrome.storage.local.set({ settings: merged });
  }
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: { ...settings, version: SETTINGS_VERSION } });
}

export async function getProjects() {
  const { projects } = await chrome.storage.local.get('projects');
  return Array.isArray(projects) ? projects : [];
}

export async function saveProjects(projects) {
  await chrome.storage.local.set({ projects });
}

export async function getEnabledSites() {
  const { enabledSites } = await chrome.storage.local.get('enabledSites');
  return Array.isArray(enabledSites) ? enabledSites : [];
}

export async function saveEnabledSites(enabledSites) {
  await chrome.storage.local.set({ enabledSites });
}

// "https://bgrm.bomet.go.ke/digit-ui/employee" -> "https://bgrm.bomet.go.ke/*"
// Chrome match patterns without a port match every port.
export function originPattern(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Finds the project whose environment URL matches the page URL (longest match wins). */
export function matchProject(projects, pageUrl) {
  if (!pageUrl) return null;
  let best = null;
  let bestLen = -1;
  for (const p of projects) {
    for (const env of p.envUrls || []) {
      const e = String(env).trim().replace(/\/+$/, '');
      if (!e) continue;
      let ok = false;
      try {
        const eu = new URL(/^https?:\/\//.test(e) ? e : `https://${e}`);
        const pu = new URL(pageUrl);
        ok = pu.hostname === eu.hostname && (eu.pathname === '/' || pu.pathname.startsWith(eu.pathname));
      } catch {}
      if (ok && e.length > bestLen) {
        best = p;
        bestLen = e.length;
      }
    }
  }
  return best;
}

export function guessModule(pageUrl) {
  try {
    const p = new URL(pageUrl).pathname.toLowerCase();
    if (/\/citizen(\/|$)/.test(p)) return 'Citizen';
    if (/\/employee(\/|$)/.test(p)) return 'Employee';
    if (/configurator|\/config(\/|$)|workbench|\/mdms/.test(p)) return 'Configurator';
  } catch {}
  return '';
}
