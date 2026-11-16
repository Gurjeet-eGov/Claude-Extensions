// Locates node, gh and claude. Chrome starts the helper with a minimal PATH,
// so install.sh records absolute paths in ~/.config/egov-bug-reporter/config.json.

import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_DIR = dirname(HOST_DIR);
export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'egov-bug-reporter');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const BUNDLED_SKILL = join(REPO_DIR, 'skill', 'log-issue-extension', 'SKILL.md');
export const HOST_VERSION = '0.1.0';

const SEARCH_DIRS = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(homedir(), '.npm-global', 'bin')];

function executable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function find(name) {
  for (const d of [...(process.env.PATH || '').split(':'), ...SEARCH_DIRS]) {
    if (d && executable(join(d, name))) return join(d, name);
  }
  return null;
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const pick = (key, name) => (saved[key] && executable(saved[key]) ? saved[key] : find(name));
  const cfg = {
    node: process.execPath,
    gh: pick('gh', 'gh'),
    claude: pick('claude', 'claude'),
  };
  cfg.extraPath = [...new Set([cfg.node, cfg.gh, cfg.claude].filter(Boolean).map((p) => dirname(p)))];
  cached = cfg;
  return cfg;
}

export function resolveSkillPath(custom) {
  const p = String(custom || '').trim();
  if (!p) return BUNDLED_SKILL;
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  if (!/\.md$/i.test(expanded) || !existsSync(expanded)) {
    throw Object.assign(new Error(`Skill file not found: ${p}`), { code: 'SKILL_NOT_FOUND', fix: ['Fix the skill path in Settings → Claude, or leave it empty to use the bundled skill.'] });
  }
  return expanded;
}

export function subprocessEnv() {
  const cfg = loadConfig();
  return { ...process.env, PATH: [...cfg.extraPath, process.env.PATH || '/usr/bin:/bin'].join(':'), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
}
