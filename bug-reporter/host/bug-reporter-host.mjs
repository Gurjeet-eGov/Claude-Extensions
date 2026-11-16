// eGov Bug Reporter — local helper (Chrome native messaging host).
// Runs a fixed set of commands with the user's own gh and Claude Code logins.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readMessages, writeMessage } from './lib/protocol.mjs';
import { loadConfig, resolveSkillPath, HOST_VERSION, BUNDLED_SKILL } from './lib/config.mjs';
import { run } from './lib/exec.mjs';
import { ghDiagnose, inspectBoard, projectMeta, findDuplicates, createIssue, setFields, fieldCommands, getIssue, updateIssue, finishUpdate } from './lib/gh.mjs';
import { buildDraftPrompt, buildCommentPrompt, runDraft, claudeEnv } from './lib/claude.mjs';
import { stageFile, reportDir, removeReport, purgeOld, safeName, safeReportId, cacheRoot } from './lib/files.mjs';

// stdout carries the protocol; nothing else may write there.
const LOG_DIR = platform() === 'darwin' ? join(homedir(), 'Library', 'Logs', 'egov-bug-reporter') : join(homedir(), '.cache', 'egov-bug-reporter');
function log(...a) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'host.log'), `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  } catch {}
}
console.log = (...a) => log(...a);
console.info = console.log;
console.warn = console.log;

async function claudeDiagnose() {
  const cfg = loadConfig();
  const out = { found: false, path: null, version: null, loggedIn: false, authMethod: null, apiProvider: null, subscriptionType: null, apiKeyInEnv: false, fix: [] };
  if (!cfg.claude) {
    out.fix.push('Install Claude Code, then run: claude auth login');
    return out;
  }
  out.found = true;
  out.path = cfg.claude;
  const env = claudeEnv(process.env, cfg.extraPath);
  const v = await run(cfg.claude, ['--version'], { env, timeoutMs: 20000 });
  out.version = (v.stdout.match(/[\d]+\.[\d.]+/) || [])[0] || null;
  const st = await run(cfg.claude, ['auth', 'status', '--json'], { env, timeoutMs: 20000 });
  try {
    const j = JSON.parse(st.stdout);
    out.loggedIn = Boolean(j.loggedIn);
    out.authMethod = j.authMethod ?? null;
    out.apiProvider = j.apiProvider ?? null;
    out.subscriptionType = j.subscriptionType ?? j.subscription ?? null;
  } catch {}
  out.apiKeyInEnv = Boolean(process.env.ANTHROPIC_API_KEY); // removed before every Claude call
  if (!out.loggedIn) out.fix.push('claude auth login');
  return out;
}

const handlers = {
  async ping() {
    return { ok: true, version: HOST_VERSION };
  },

  async diagnose(p) {
    if (p?.tempDays) await purgeOld(p.tempDays);
    const [ghInfo, claudeInfo] = await Promise.all([ghDiagnose(), claudeDiagnose()]);
    let skillPath = null;
    let skillOk = false;
    try {
      skillPath = resolveSkillPath(p?.skillPath);
      skillOk = existsSync(skillPath);
    } catch (e) {
      skillPath = p?.skillPath;
    }
    return {
      host: { version: HOST_VERSION, node: process.version, platform: platform() },
      gh: ghInfo,
      claude: claudeInfo,
      skill: { path: skillPath, ok: skillOk, bundled: skillPath === BUNDLED_SKILL },
      cacheDir: cacheRoot(),
    };
  },

  async inspectBoard(p) {
    return inspectBoard(p.url);
  },

  async projectMeta(p) {
    return projectMeta({ boardUrl: p.boardUrl, repo: p.repo });
  },

  async stageFile(p) {
    return stageFile(p);
  },

  async draftText(p, progress) {
    const cfg = loadConfig();
    if (!cfg.claude) throw Object.assign(new Error('Claude Code is not installed on this machine.'), { code: 'CLAUDE_NOT_INSTALLED', fix: ['Install Claude Code, then run: claude auth login'] });
    if (p.tempDays) await purgeOld(p.tempDays);
    const skillPath = resolveSkillPath(p.skillPath);
    const dir = reportDir(safeReportId(p.reportId));
    mkdirSync(dir, { recursive: true });
    let screenshot = null;
    if (p.allowScreenshot && p.screenshotName && existsSync(join(dir, safeName(p.screenshotName)))) screenshot = `./${safeName(p.screenshotName)}`;
    const prompt = buildDraftPrompt({ ...p, screenshot });
    const model = p.model || 'sonnet';
    const effort = p.effort || 'low';
    progress?.(`Asking Claude (${model}, effort ${effort})…`);
    const res = await runDraft({
      claudePath: cfg.claude,
      cwd: dir,
      prompt,
      skillPath,
      model,
      effort,
      allowRead: Boolean(screenshot),
      env: claudeEnv(process.env, cfg.extraPath, { maxOutputTokens: p.detail === 'concise' ? 1200 : 2000 }),
    });
    log('draft', { model: res.usage.model, in: res.usage.totalInput, out: res.usage.outputTokens, thinking: res.usage.thinkingTokens, turns: res.usage.turns, ms: res.usage.durationMs, fellBack: Boolean(res.usage.fellBack) });
    return { ...res, requested: { model, effort, detail: p.detail === 'concise' ? 'concise' : 'detailed', screenshot: Boolean(screenshot) } };
  },

  async findDuplicates(p) {
    return findDuplicates(p);
  },

  async fileIssue(p, progress) {
    if (p.tempDays) await purgeOld(p.tempDays);
    const created = await createIssue(p, progress);
    if (created.dryRun) {
      return { ...created, commands: [...created.commands, ...(p.board ? fieldCommands({ ...p.board, issueUrl: '<issue-url>' }) : [])] };
    }
    let fields = { done: [], failed: [] };
    if (p.board) {
      try {
        fields = await setFields({ ...p.board, issueUrl: created.url }, progress);
      } catch (e) {
        fields.failed.push({ field: 'board', message: e.message, code: e.code, fix: e.fix || [] });
      }
    }
    await removeReport(p.reportId).catch(() => {});
    return { ...created, fields };
  },

  async setFields(p, progress) {
    return setFields(p, progress);
  },

  // ---- Update Issue ----
  async getIssue(p) {
    return getIssue(p);
  },

  async updateIssue(p, progress) {
    if (p.tempDays) await purgeOld(p.tempDays);
    const res = await updateIssue(p, progress);
    if (!res.dryRun) await removeReport(p.reportId).catch(() => {});
    return res;
  },

  async finishUpdate(p, progress) {
    return finishUpdate(p, progress);
  },

  async draftComment(p, progress) {
    const cfg = loadConfig();
    if (!cfg.claude) throw Object.assign(new Error('Claude Code is not installed on this machine.'), { code: 'CLAUDE_NOT_INSTALLED', fix: ['Install Claude Code, then run: claude auth login'] });
    const skillPath = resolveSkillPath(p.skillPath);
    const dir = reportDir(safeReportId(p.reportId));
    mkdirSync(dir, { recursive: true });
    const model = p.model || 'sonnet';
    const effort = p.effort || 'low';
    progress?.(`Asking Claude to polish the comment (${model}, effort ${effort})…`);
    const res = await runDraft({
      claudePath: cfg.claude,
      cwd: dir,
      prompt: buildCommentPrompt(p),
      skillPath,
      model,
      effort,
      allowRead: false,
      kind: 'comment',
      env: claudeEnv(process.env, cfg.extraPath, { maxOutputTokens: p.detail === 'concise' ? 1200 : 2000 }),
    });
    log('comment', { model: res.usage.model, in: res.usage.totalInput, out: res.usage.outputTokens, turns: res.usage.turns, ms: res.usage.durationMs });
    return { ...res, requested: { model, effort, detail: p.detail === 'concise' ? 'concise' : 'detailed' } };
  },

  async discardReport(p) {
    await removeReport(p.reportId);
    return { ok: true };
  },

  async purge(p) {
    return { removed: await purgeOld(p.tempDays) };
  },
};

async function main() {
  for await (const msg of readMessages(process.stdin)) {
    const id = msg?.id;
    const cmd = msg?.cmd;
    const progress = (message) => writeMessage({ id, type: 'progress', message });
    const handler = Object.prototype.hasOwnProperty.call(handlers, cmd) ? handlers[cmd] : null;
    if (!handler) {
      writeMessage({ id, type: 'error', error: { code: 'UNKNOWN_COMMAND', message: `Unknown command: ${cmd}` } });
      continue;
    }
    try {
      const data = await handler(msg.params || {}, progress);
      writeMessage({ id, type: 'result', data });
    } catch (e) {
      if (cmd !== 'stageFile') log('error', cmd, e?.code, e?.message, e?.detail || '');
      writeMessage({ id, type: 'error', error: { code: e?.code || 'ERROR', message: e?.message || String(e), fix: e?.fix || [], detail: e?.detail } });
    }
  }
}

main().catch((e) => {
  log('fatal', e?.stack || String(e));
  process.exit(1);
});
