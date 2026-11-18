// Claude for Test Run, the same way Bug Reporter uses it: one lean
// `claude -p` call through the user's own Claude Code login (never an API key),
// no tools, no MCP servers, no saved session. Reuses Bug Reporter's runner.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDraft, claudeEnv } from '../../bug-reporter/host/lib/claude.mjs';
import { loadConfig } from '../../bug-reporter/host/lib/config.mjs';
import { costOfUsageRecord, formatUsd } from '../../bug-reporter/extension/lib/pricing.js';
import { ROOT } from './runtime.mjs';

export const SKILL = join(ROOT, 'skill', 'test-run', 'SKILL.md');
export const MODELS = ['sonnet', 'haiku', 'opus', 'default'];
export const MODEL_LABELS = { sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5', opus: 'Opus 5.5', default: 'Claude Code default' };
export const EFFORTS = ['low', 'medium', 'high'];
const OUTPUT_CAP = { draft: 4000, paths: 8000 };

function claudeBinary(override) {
  return override || process.env.TEST_RUN_CLAUDE || loadConfig().claude || null;
}

export function claudeStatus(override) {
  const path = claudeBinary(override);
  return { available: !!path, path };
}

/**
 * kind: 'draft' (write up findings) | 'paths' (plan test paths)
 * Returns { text, usage } where usage carries model, tokens, time and the API-equivalent cost.
 */
export async function askClaude({ kind, prompt, model, effort, claudePath, timeoutMs = 180000 }) {
  const m = MODELS.includes(model) ? model : 'sonnet';
  const e = EFFORTS.includes(effort) ? effort : 'low';
  const bin = claudeBinary(claudePath);
  if (!bin) {
    throw Object.assign(new Error('Claude Code is not installed on this computer.'), { code: 'CLAUDE_NOT_INSTALLED', fix: ['Install Claude Code, then run: claude auth login'] });
  }
  const cwd = mkdtempSync(join(tmpdir(), 'testrun-claude-'));
  try {
    const res = await runDraft({
      claudePath: bin,
      cwd,
      prompt,
      skillPath: SKILL,
      model: m,
      effort: e,
      allowRead: false,
      env: claudeEnv(process.env, loadConfig().extraPath, { maxOutputTokens: OUTPUT_CAP[kind] || 4000 }),
      timeoutMs,
      kind: 'raw',
    });
    const cost = costOfUsageRecord(res.usage);
    return {
      text: res.draft,
      usage: { ...res.usage, requested: { model: m, effort: e }, cost: cost.usd, costText: formatUsd(cost.usd) },
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
