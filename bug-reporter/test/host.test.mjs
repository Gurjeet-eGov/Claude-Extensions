import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBoardUrl, parseRepo, interpretBoard, defaultPriorityMapping, findBacklogOption } from '../host/lib/board.mjs';
import { buildDraftArgs, buildDraftPrompt, parseClaudeOutput, claudeEnv } from '../host/lib/claude.mjs';
import { safeName } from '../host/lib/files.mjs';

test('board URL and repo parsing', () => {
  assert.deepEqual(parseBoardUrl('https://github.com/orgs/eGov-Global/projects/17/views/2'), { ownerType: 'organization', owner: 'eGov-Global', number: 17 });
  assert.deepEqual(parseBoardUrl('https://github.com/users/someone/projects/3'), { ownerType: 'user', owner: 'someone', number: 3 });
  assert.equal(parseBoardUrl('https://github.com/eGov-Global/CMS-KENYA'), null);
  assert.equal(parseRepo('https://github.com/eGov-Global/CMS-KENYA.git').nameWithOwner, 'eGov-Global/CMS-KENYA');
  assert.equal(parseRepo('nope'), null);
});

const project = (fields, repos = [{ nameWithOwner: 'o/r', visibility: 'PRIVATE' }]) => ({
  id: 'PVT_1',
  title: 'Board',
  url: 'https://github.com/orgs/o/projects/1',
  repositories: { nodes: repos },
  fields: { nodes: fields },
});

test('board interpretation: board priority field', () => {
  const b = interpretBoard(
    project([
      { id: 'F1', name: 'Status', options: [{ id: 's1', name: 'Backlog' }, { id: 's2', name: 'Todo' }] },
      { id: 'F2', name: 'Priority', options: [{ id: 'p0', name: 'P0' }, { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }] },
      { id: 'F3', name: 'Iteration', configuration: { iterations: [{ id: 'i1', title: 'S1', startDate: '2026-11-10', duration: 14 }] } },
      { id: 'F4', name: 'Title', dataType: 'TITLE' },
    ]),
    null,
  );
  assert.equal(b.priority.mode, 'board');
  assert.equal(b.priority.mapping.P2.id, 'p2');
  assert.equal(b.status.fieldId, 'F1');
  assert.equal(b.iteration.fieldId, 'F3');
  assert.equal(findBacklogOption(b.status.options).id, 's1');
});

test('board interpretation: empty board priority falls back to org issue field, then title', () => {
  const fields = [
    { id: 'F1', name: 'Status', options: [{ id: 's1', name: 'Todo' }] },
    { id: 'F2', name: 'Priority', options: [] },
  ];
  const withOrg = interpretBoard(project(fields), [
    { id: 'IF', name: 'Priority', options: [{ id: 'u', name: 'Urgent' }, { id: 'h', name: 'High' }, { id: 'm', name: 'Medium' }, { id: 'l', name: 'Low' }] },
  ]);
  assert.equal(withOrg.priority.mode, 'issueField');
  assert.deepEqual(Object.fromEntries(Object.entries(withOrg.priority.mapping).map(([k, v]) => [k, v.name])), { P0: 'Urgent', P1: 'High', P2: 'Medium', P3: 'Low' });
  assert.equal(withOrg.iteration, null);

  const none = interpretBoard(project(fields), []);
  assert.equal(none.priority.mode, 'title');
  assert.equal(findBacklogOption(none.status.options), null);
});

test('priority mapping falls back to order for four unnamed options', () => {
  const m = defaultPriorityMapping([{ id: 'a', name: '🔥' }, { id: 'b', name: '⬆️' }, { id: 'c', name: '➡️' }, { id: 'd', name: '⬇️' }]);
  assert.equal(m.P0.id, 'a');
  assert.equal(m.P3.id, 'd');
  const hi = defaultPriorityMapping([{ id: 'x', name: 'Highest' }, { id: 'y', name: 'High' }, { id: 'z', name: 'Medium' }, { id: 'w', name: 'Low' }]);
  assert.equal(hi.P0.id, 'x');
  assert.equal(hi.P1.id, 'y');
});

test('lean claude args: no tools, no MCP, no skills, json schema, model/effort', () => {
  const a = buildDraftArgs({ prompt: 'hi', skillPath: '/s.md', model: 'haiku', effort: 'low' });
  const i = a.indexOf('--tools');
  assert.equal(a[i + 1], '');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--safe-mode']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('--json-schema'), 'schema off by default: it caused a second turn');
  assert.equal(a[a.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(buildDraftArgs({ prompt: 'x', skillPath: '/s' }).at(buildDraftArgs({ prompt: 'x', skillPath: '/s' }).indexOf('--model') + 1), 'claude-sonnet-5-5');
  const fb = buildDraftArgs({ prompt: 'x', skillPath: '/s', model: 'sonnet', modelOverride: 'sonnet' });
  assert.equal(fb[fb.indexOf('--model') + 1], 'sonnet');
  assert.equal(a[a.indexOf('--effort') + 1], 'low');
  assert.ok(!a.includes('--bare'));
  const d = buildDraftArgs({ prompt: 'x', skillPath: '/s', model: 'default', effort: 'weird', allowRead: true });
  assert.ok(!d.includes('--model'));
  assert.equal(d[d.indexOf('--effort') + 1], 'low');
  assert.equal(d[d.indexOf('--tools') + 1], 'Read');
});

test('draft prompt carries summaries only', () => {
  const p = buildDraftPrompt({
    projectTitle: 'Bomet board',
    repo: 'o/r',
    module: 'Employee',
    notes: { actual: 'assign fails', expected: '' },
    selectedApis: [{ id: 'a1', summary: 'POST /pgr/_update → 400 · X: y' }],
    otherFailures: [{ id: 'a2', summary: 'GET /mdms → 500' }],
  });
  assert.match(p, /Attached API calls[^\n]*\n\[a1\] POST \/pgr\/_update/);
  assert.match(p, /Unattached failed calls - ONLY for choosing relatedApiIds\. Never mention these[^\n]*\n\[a2\]/);
  assert.doesNotMatch(p, /What should have happened/);
});

test('claude output parsing: structured output, usage, auth errors', () => {
  const ok = parseClaudeOutput(JSON.stringify({
    type: 'result',
    is_error: false,
    duration_ms: 3800,
    num_turns: 1,
    structured_output: { title: 'Assign fails', description: 'd', actual: 'a', expected: '', keywords: ['assign', 'GRO'], relatedApiIds: ['a1'], question: '' },
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 1360, outputTokens: 18 },
      'claude-sonnet-5-5': { inputTokens: 2, outputTokens: 310, cacheReadInputTokens: 2900, cacheCreationInputTokens: 0, thinkingTokens: 0 },
    },
  }));
  assert.equal(ok.draft.title, 'Assign fails');
  assert.equal(ok.usage.model, 'claude-sonnet-5-5', 'the main model is the one that wrote the most');
  assert.equal(ok.usage.totalInput, 4262);
  assert.equal(ok.usage.outputTokens, 328);
  assert.equal(ok.usage.thinkingTokens, 0);
  assert.equal(ok.usage.turns, 1);

  const fallback = parseClaudeOutput(JSON.stringify({ is_error: false, result: '```json\n{"title":"T","description":"","actual":"","expected":"","keywords":[],"relatedApiIds":[],"question":""}\n```' }));
  assert.equal(fallback.draft.title, 'T');

  assert.throws(
    () => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })),
    (e) => e.code === 'CLAUDE_AUTH' && e.fix[0] === 'claude auth login',
  );
});

test('claude env never carries an API key', () => {
  const env = claudeEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/h' }, ['/opt/bin']);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 't');
  assert.equal(env.PATH, '/opt/bin:/usr/bin');
  assert.equal(env.MAX_THINKING_TOKENS, '0');
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '2000');
  assert.equal(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS, '1');
});

test('staged file names are sanitized', () => {
  assert.equal(safeName('snapshot-1.png'), 'snapshot-1.png');
  assert.throws(() => safeName('../etc/passwd'));
  assert.throws(() => safeName('a/b.png'));
  assert.throws(() => safeName('x.exe'));
});
