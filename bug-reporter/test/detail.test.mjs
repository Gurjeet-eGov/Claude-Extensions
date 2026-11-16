import test from 'node:test';
import assert from 'node:assert/strict';

import { condenseCall, condenseValue, slimRequestInfo } from '../extension/lib/condense.js';
import { costOfModels, costOfUsageRecord, normalizeModel, priceFor, formatUsd } from '../extension/lib/pricing.js';
import { buildDraftPrompt, claudeEnv } from '../host/lib/claude.mjs';

test('pricing: official per-MTok rates, cache split, dated model ids', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  // Sonnet 5.5: $2 in, $0.10 cache read, $2.50 5m write, $10 out
  const s = costOfModels({ 'claude-sonnet-5-5': { input: 2, output: 308, cacheRead: 2908, cacheWrite: 0 } });
  assert.ok(Math.abs(s.usd - 0.0033748) < 1e-9);
  const w = costOfModels({ 'claude-sonnet-5-5': { input: 1000, output: 0, cacheRead: 0, cacheWrite: 4000, cacheWrite1h: 1000 } });
  assert.ok(Math.abs(w.usd - (1000 * 2 + 3000 * 2.5 + 1000 * 4) / 1e6) < 1e-12);
  // Haiku 5.5 long-prompt tier above 100K
  assert.equal(priceFor('claude-haiku-5-5', 50000).in, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', 150000).in, 0.5);
  assert.equal(costOfModels({ 'claude-unknown-9': { input: 1 } }).usd, null);
  const legacy = costOfUsageRecord({ model: 'claude-haiku-4-5-20251001', totalInput: 3924, outputTokens: 4876 });
  assert.equal(legacy.estimated, true);
  assert.ok(Math.abs(legacy.usd - (3924 * 1 + 4876 * 5) / 1e6) < 1e-12);
  assert.equal(formatUsd(0.0033748), '$0.0034');
  assert.equal(formatUsd(0.0123), '$0.012');
});

test('condense: RequestInfo slimmed to user type and roles, arrays and strings shortened, Errors kept', () => {
  const body = {
    RequestInfo: { apiId: 'Rainmaker', authToken: 'secret', msgId: 'x', userInfo: { type: 'EMPLOYEE', userName: 'GRO1', tenantId: 'ke', roles: [{ code: 'GRO', tenantId: 'ke.bomet' }, { code: 'GRO', tenantId: 'ke.bomet' }, { code: 'EMPLOYEE' }] } },
    service: { tenantId: 'ke.bomet', serviceCode: 'StreetLight' },
    workflow: { action: 'ASSIGN', assignes: ['u-1'] },
  };
  const slim = slimRequestInfo(body);
  assert.deepEqual(slim.RequestInfo, { userInfo: { type: 'EMPLOYEE', userName: 'GRO1', tenantId: 'ke', roles: ['GRO@ke.bomet', 'EMPLOYEE'] } });
  assert.equal(JSON.stringify(slim).includes('secret'), false);
  assert.deepEqual(condenseValue([1, 2, 3, 4, 5]), [1, 2, 3, '…(+2 more)']);

  const text = condenseCall({
    method: 'POST',
    url: 'https://bgrm.bomet.go.ke/pgr-services/v2/request/_update?tenantId=ke.bomet',
    status: 400,
    reqBody: JSON.stringify(body),
    resBody: JSON.stringify({ ResponseInfo: null, Errors: [{ code: 'INVALID_ASSIGNEE', message: 'Assignee is not an employee of the department' }] }),
  });
  assert.match(text, /^POST \/pgr-services\/v2\/request\/_update\?tenantId=ke\.bomet\n/);
  assert.match(text, /"action":"ASSIGN"/);
  assert.match(text, /Response 400: \{"Errors":\[\{"code":"INVALID_ASSIGNEE"/);
  assert.doesNotMatch(text, /secret|Rainmaker/);

  const big = condenseCall({ method: 'POST', url: 'https://x/a', status: 200, resBody: JSON.stringify({ ServiceWrappers: Array.from({ length: 50 }, (_, i) => ({ id: i })) }) });
  assert.match(big, /…\(\+47 more\)/);
});

test('prompt: detail level and condensed calls; concise omits them', () => {
  const p = buildDraftPrompt({ projectTitle: 'B', notes: { actual: 'x' }, detail: 'detailed', selectedApis: [{ id: 'a1', summary: 's' }], apiDetails: [{ id: 'a1', text: 'POST /x\nResponse 400: {}' }] });
  assert.match(p, /Detail level: detailed/);
  assert.match(p, /--- \[a1\]\nPOST \/x/);
  const c = buildDraftPrompt({ projectTitle: 'B', notes: { actual: 'x' }, detail: 'concise', selectedApis: [{ id: 'a1', summary: 's' }] });
  assert.match(c, /Detail level: concise/);
  assert.doesNotMatch(c, /Condensed request/);
  assert.equal(claudeEnv({}, [], { maxOutputTokens: 2000 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '2000');
});
