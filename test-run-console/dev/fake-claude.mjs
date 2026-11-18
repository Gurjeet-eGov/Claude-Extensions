// A stand-in for the `claude` CLI, for tests: answers `claude -p ... --output-format json`
// the way Claude Code does, and logs the arguments it was given (model, effort...).
// The reply is built from the prompt: test cases for each finding, or one path
// per sub feature for a path plan.
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const prompt = at('-p') || '';
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG || __LOG__, JSON.stringify({ model: at('--model'), effort: at('--effort'), tools: at('--tools'), system: at('--system-prompt-file'), prompt }) + '\\n');
let reply;
if (/plan a manual test cycle/.test(prompt)) {
  const ids = [...prompt.matchAll(/^- ([^|\\n]+?) \\|/gm)].map((m) => m[1].trim());
  reply = { type: 'paths', paths: [{ name: 'Planned path A', persona: 'CSR', setup: 'Log in as CSR', steps: [{ label: 'First half', cases: ids.slice(0, Math.ceil(ids.length / 2)) }] }, { name: 'Planned path B', persona: 'GRO', steps: [{ label: 'Second half', cases: ids.slice(Math.ceil(ids.length / 2)) }] }] };
} else {
  const findings = [...prompt.matchAll(/^- (F-\\d+): (.+?)(?: \\(bug (#\\d+)\\))?(?: \\[area: [^\\]]+\\])?$/gm)];
  reply = { type: 'scenarios', items: findings.map((m) => ({ fromFinding: m[1], edgeCase: false, scenario: 'Verify that ' + m[2].charAt(0).toLowerCase() + m[2].slice(1), subFeature: 'Citizen UI', testType: 'Functional', expected: ['It shall work as described in ' + m[1]], issue: m[3] || '' })), covered: [] };
}
const model = at('--model') || 'claude-sonnet-5-5';
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Here you go:\\n\\u0060\\u0060\\u0060json\\n' + JSON.stringify(reply) + '\\n\\u0060\\u0060\\u0060', duration_ms: 1234, num_turns: 1, modelUsage: { [model]: { inputTokens: 2900, outputTokens: 240, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\\n');
`;

/** Writes the fake CLI into dir; returns { bin, log }. */
export function makeFakeClaude(dir) {
  const bin = join(dir, 'claude');
  const log = join(dir, 'claude-calls.jsonl');
  writeFileSync(bin, SCRIPT.replace('__LOG__', JSON.stringify(log)));
  chmodSync(bin, 0o755);
  writeFileSync(log, '');
  return { bin, log };
}
