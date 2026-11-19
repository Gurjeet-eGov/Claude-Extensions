// Runs ONE lean Claude Code call that drafts the issue text.
// Lean = no Claude Code system prompt, no tools (unless the screenshot is shared),
// no MCP servers, no skills list, no plugins/hooks, no saved session.

import { readFileSync } from 'node:fs';
import { run } from './exec.mjs';

export const DRAFT_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/draft.json', import.meta.url), 'utf8'));

// Exact model IDs: the CLI's short names can point at older models
// (e.g. "haiku" ran as Haiku 4.5).
export const MODEL_IDS = {
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  opus: 'claude-opus-5-5',
};
const EFFORTS = new Set(['low', 'medium', 'high']);

// Structured output (--json-schema) is off by default: the skill already asks for
// one JSON object, and parseClaudeOutput reads plain JSON text.
export const USE_JSON_SCHEMA = false;

export function resolveModel(model) {
  if (model === 'default') return null;
  return MODEL_IDS[model] || MODEL_IDS.sonnet;
}

export function buildDraftArgs({ prompt, skillPath, model = 'sonnet', effort = 'low', allowRead = false, useSchema = USE_JSON_SCHEMA, modelOverride }) {
  const args = [
    '-p', prompt,
    '--system-prompt-file', skillPath,
    '--tools', allowRead ? 'Read' : '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--safe-mode',
    '--output-format', 'json',
  ];
  if (useSchema) args.push('--json-schema', JSON.stringify(DRAFT_SCHEMA));
  const m = modelOverride || resolveModel(model);
  if (m) args.push('--model', m);
  args.push('--effort', EFFORTS.has(effort) ? effort : 'low');
  return args;
}

function clip(s, max) {
  const t = String(s ?? '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Compact user message. Only one-line API summaries are sent, never full payloads.
 */
export function buildDraftPrompt(p) {
  const lines = [];
  const detailed = p.detail !== 'concise';
  lines.push('Draft the issue text for this report. Reply with the JSON object only.');
  lines.push(`Detail level: ${detailed ? 'detailed' : 'concise'}`);
  lines.push('');
  lines.push(`Project: ${clip(p.projectTitle, 120)}${p.repo ? ` (${p.repo})` : ''}`);
  if (p.module) lines.push(`Module: ${clip(p.module, 40)}`);
  lines.push(`Type: ${p.label === 'enhancement' ? 'enhancement' : 'bug'}`);
  if (p.pageUrl) lines.push(`Page: ${clip(p.pageUrl, 300)}`);
  lines.push('');
  lines.push('Reporter notes:');
  lines.push(`- What happened: ${clip(p.notes?.actual, 2000) || '(not given)'}`);
  if (p.notes?.expected?.trim()) lines.push(`- What should have happened: ${clip(p.notes.expected, 1500)}`);
  if (p.notes?.extra?.trim()) lines.push(`- Other notes: ${clip(p.notes.extra, 1500)}`);
  if (p.selectedApis?.length) {
    lines.push('');
    lines.push('Attached API calls (the full cURL and response are added under API Details by the extension):');
    for (const a of p.selectedApis.slice(0, 10)) lines.push(`[${a.id}] ${clip(a.summary, 300)}`);
  }
  const details = (p.apiDetails || []).filter((d) => d && d.text);
  if (details.length) {
    lines.push('');
    lines.push('Condensed request/response of the attached calls (long arrays and strings shortened; RequestInfo reduced to the user\'s type and roles). Use the facts in them; do not paste them:');
    let budget = 10000;
    for (const d of details.slice(0, 5)) {
      const t = clip(d.text, Math.min(3500, budget));
      budget -= t.length;
      lines.push(`--- [${d.id}]`);
      lines.push(t);
      if (budget <= 0) break;
    }
  }
  if (p.otherFailures?.length) {
    lines.push('');
    lines.push('Unattached failed calls - ONLY for choosing relatedApiIds. Never mention these in title, description, actual or expected:');
    for (const a of p.otherFailures.slice(0, 15)) lines.push(`[${a.id}] ${clip(a.summary, 160)}`);
  }
  if (p.consoleErrors?.length) {
    lines.push('');
    lines.push('Console errors the reporter attached:');
    for (const c of p.consoleErrors.slice(0, 10)) lines.push(`- ${clip(c, 300)}`);
  }
  if (p.screenshot) {
    lines.push('');
    lines.push(`Screenshot of the moment the defect was seen: ${p.screenshot} (read it with the Read tool).`);
  }
  return lines.join('\n');
}

/** Prompt for "Polish with Claude" on an Update Issue comment. */
export function buildCommentPrompt(p) {
  const lines = [];
  lines.push('Task: update comment. Rewrite the reporter\'s notes as a GitHub comment for an existing issue. Reply with the JSON object {"comment": "..."} only.');
  lines.push(`Detail level: ${p.detail === 'concise' ? 'concise' : 'detailed'}`);
  lines.push('');
  lines.push(`Project: ${clip(p.projectTitle, 120)}${p.repo ? ` (${p.repo})` : ''}`);
  if (p.issue) lines.push(`Issue: #${p.issue.number} "${clip(p.issue.title, 200)}" (${String(p.issue.state || '').toLowerCase()})`);
  if (p.pageUrl) lines.push(`Page tested: ${clip(p.pageUrl, 300)}`);
  if (p.result) lines.push(`Verification result chosen by the reporter: ${p.result} (the extension adds this as the first line; don't repeat it)`);
  lines.push('');
  lines.push(`Reporter notes: ${clip(p.notes, 3000) || '(none)'}`);
  if (p.selectedApis?.length) {
    lines.push('');
    lines.push('Attached API calls (full cURL and response are added below the comment by the extension):');
    for (const a of p.selectedApis.slice(0, 10)) lines.push(`[${a.id}] ${clip(a.summary, 300)}`);
  }
  const details = (p.apiDetails || []).filter((d) => d && d.text);
  if (details.length) {
    lines.push('');
    lines.push('Condensed request/response of the attached calls. Use the facts in them; do not paste them:');
    let budget = 10000;
    for (const d of details.slice(0, 5)) {
      const t = clip(d.text, Math.min(3500, budget));
      budget -= t.length;
      lines.push(`--- [${d.id}]`);
      lines.push(t);
      if (budget <= 0) break;
    }
  }
  if (p.consoleErrors?.length) {
    lines.push('');
    lines.push('Console errors the reporter attached:');
    for (const c of p.consoleErrors.slice(0, 10)) lines.push(`- ${clip(c, 300)}`);
  }
  return lines.join('\n');
}

function stripFences(s) {
  return String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

/** Parses `claude -p --output-format json` stdout into {draft, usage} or throws a helpful error. */
export function parseClaudeOutput(stdout, kind = 'draft') {
  let out;
  try {
    out = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).pop());
  } catch {
    throw Object.assign(new Error('Claude returned something that is not JSON.'), { code: 'CLAUDE_BAD_OUTPUT', detail: String(stdout).slice(0, 500) });
  }
  if (out.is_error) {
    const msg = String(out.result || out.error || 'Claude call failed');
    if (/authenticat|log ?in|oauth|credential|api key/i.test(msg)) {
      throw Object.assign(new Error(`Claude Code is not signed in: ${msg}`), { code: 'CLAUDE_AUTH', fix: ['claude auth login'] });
    }
    throw Object.assign(new Error(msg), { code: 'CLAUDE_ERROR' });
  }
  // kind 'raw' (used by Test Run): hand back Claude's text unchanged; the caller parses it.
  let draft = kind === 'raw' ? String(out.result ?? '') : out.structured_output;
  if (kind !== 'raw' && (!draft || typeof draft !== 'object')) {
    try {
      draft = JSON.parse(stripFences(out.result));
    } catch {
      throw Object.assign(new Error('Claude did not return the expected JSON draft.'), { code: 'CLAUDE_BAD_OUTPUT', detail: String(out.result).slice(0, 500) });
    }
  }
  const modelUsage = out.modelUsage || {};
  const models = Object.keys(modelUsage);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let thinkingTokens = Number(out.usage?.output_tokens_details?.thinking_tokens || 0);
  if (models.length) {
    thinkingTokens = 0;
    for (const m of models) {
      const u = modelUsage[m] || {};
      inputTokens += Number(u.inputTokens || 0);
      outputTokens += Number(u.outputTokens || 0);
      cacheRead += Number(u.cacheReadInputTokens || 0);
      cacheWrite += Number(u.cacheCreationInputTokens || 0);
      thinkingTokens += Number(u.thinkingTokens || 0);
    }
  } else if (out.usage) {
    inputTokens = Number(out.usage.input_tokens || 0);
    outputTokens = Number(out.usage.output_tokens || 0);
    cacheRead = Number(out.usage.cache_read_input_tokens || 0);
    cacheWrite = Number(out.usage.cache_creation_input_tokens || 0);
  }
  return {
    draft: kind === 'raw' ? draft : kind === 'comment' ? { comment: typeof draft.comment === 'string' ? draft.comment.trim() : '' } : normalizeDraft(draft),
    usage: {
      // Claude Code may make a tiny side call on another model; the draft's model
      // is the one that wrote the most output.
      model: models.sort((a, b) => Number(modelUsage[b].outputTokens || 0) - Number(modelUsage[a].outputTokens || 0))[0] || 'unknown',
      models: Object.fromEntries(
        models.map((m) => [
          m,
          {
            input: Number(modelUsage[m].inputTokens || 0),
            output: Number(modelUsage[m].outputTokens || 0),
            cacheRead: Number(modelUsage[m].cacheReadInputTokens || 0),
            cacheWrite: Number(modelUsage[m].cacheCreationInputTokens || 0),
          },
        ]),
      ),
      cacheWrite1h: Number(out.usage?.cache_creation?.ephemeral_1h_input_tokens || 0),
      inputTokens,
      outputTokens,
      cacheRead,
      cacheWrite,
      totalInput: inputTokens + cacheRead + cacheWrite,
      thinkingTokens,
      durationMs: Number(out.duration_ms || 0),
      turns: Number(out.num_turns || 1),
    },
  };
}

function normalizeDraft(d) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    title: str(d.title),
    description: str(d.description),
    actual: str(d.actual),
    expected: str(d.expected),
    keywords: arr(d.keywords).slice(0, 5),
    relatedApiIds: arr(d.relatedApiIds),
    question: str(d.question),
  };
}

/** Environment for the claude process: never an API key, so usage stays on the subscription login. */
export function claudeEnv(baseEnv, extraPath = [], { maxOutputTokens = 2000 } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
    // Never inherit a parent Claude Code session's wiring; a long-lived token from
    // `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) is still allowed through.
    if ((k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN') || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  env.PATH = [...extraPath, env.PATH || '/usr/bin:/bin'].filter(Boolean).join(':');
  // Short, plain answer: no hidden thinking, and a hard cap on output.
  env.MAX_THINKING_TOKENS = '0';
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  // Skip Claude Code's optional side calls (they would show up as extra usage).
  env.DISABLE_NON_ESSENTIAL_MODEL_CALLS = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

const MODEL_UNAVAILABLE = /model.*(not found|not available|unavailable|does not exist|invalid|not supported)|(invalid|unknown) model/i;

export async function runDraft({ claudePath, cwd, prompt, skillPath, model, effort, allowRead, env, timeoutMs = 180000, useSchema, kind = 'draft' }) {
  try {
    return await runOnce({ claudePath, cwd, env, timeoutMs, kind, args: buildDraftArgs({ prompt, skillPath, model, effort, allowRead, useSchema }) });
  } catch (e) {
    // The pinned model isn't available to this account: fall back to the CLI's short name.
    if (model !== 'default' && MODEL_IDS[model] && MODEL_UNAVAILABLE.test(e.message)) {
      const res = await runOnce({ claudePath, cwd, env, timeoutMs, kind, args: buildDraftArgs({ prompt, skillPath, model, effort, allowRead, useSchema, modelOverride: model }) });
      res.usage.fellBack = true;
      return res;
    }
    throw e;
  }
}

async function runOnce({ claudePath, cwd, env, timeoutMs, args, kind = 'draft' }) {
  const r = await run(claudePath, args, { cwd, env, timeoutMs });
  if (r.timedOut) throw Object.assign(new Error('Claude took too long to answer (over 3 minutes).'), { code: 'CLAUDE_TIMEOUT' });
  if (!r.stdout.trim()) {
    const err = r.stderr.trim();
    if (/unknown option.*safe-mode/i.test(err)) {
      // Older Claude Code without --safe-mode: retry without it.
      const args2 = args.filter((a) => a !== '--safe-mode');
      const r2 = await run(claudePath, args2, { cwd, env, timeoutMs });
      return parseClaudeOutput(r2.stdout || r2.stderr, kind);
    }
    throw Object.assign(new Error(err || `claude exited with code ${r.code}`), { code: 'CLAUDE_ERROR' });
  }
  return parseClaudeOutput(r.stdout, kind);
}
