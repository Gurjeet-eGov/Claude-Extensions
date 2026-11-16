// API-equivalent cost of a draft, from Anthropic's official per-million-token prices.
// On a Claude subscription, Claude Code usage counts against plan limits and is not
// billed per token; this is what the same tokens would cost on the API.

export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICING_AS_OF = '2026-11-15';

// USD per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output.
const PRICES = {
  'claude-opus-5-5': { in: 4, cw5: 5, cw1h: 8, cr: 0.2, out: 20 },
  'claude-sonnet-5-5': { in: 2, cw5: 2.5, cw1h: 4, cr: 0.1, out: 10 },
  'claude-haiku-5-5': { in: 0.1, cw5: 0.125, cw1h: 0.2, cr: 0.01, out: 0.5 },
  'claude-haiku-5-5@long': { in: 0.5, cw5: 0.625, cw1h: 1, cr: 0.05, out: 2.5 }, // prompts over 100K tokens
  'claude-haiku-4-5': { in: 1, cw5: 1.25, cw1h: 2, cr: 0.1, out: 5 },
  'claude-sonnet-5': { in: 2, cw5: 2.5, cw1h: 4, cr: 0.2, out: 10 },
  'claude-opus-4-8': { in: 5, cw5: 6.25, cw1h: 10, cr: 0.5, out: 25 },
};

/** "claude-haiku-4-5-20251001" → "claude-haiku-4-5" */
export function normalizeModel(id) {
  return String(id || '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
}

export function priceFor(model, promptTokens = 0) {
  const id = normalizeModel(model);
  if (id === 'claude-haiku-5-5' && promptTokens > 100000) return PRICES['claude-haiku-5-5@long'];
  return PRICES[id] || null;
}

/**
 * @param {Record<string,{input:number,output:number,cacheRead:number,cacheWrite:number,cacheWrite1h?:number}>} models
 * @returns {{usd:number|null, unknown:string[]}}  usd is null when no model had a known price
 */
export function costOfModels(models) {
  let usd = 0;
  let known = 0;
  const unknown = [];
  for (const [model, u] of Object.entries(models || {})) {
    const prompt = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    const p = priceFor(model, prompt);
    if (!p) {
      unknown.push(model);
      continue;
    }
    known++;
    const cw1h = Math.min(u.cacheWrite1h || 0, u.cacheWrite || 0);
    const cw5 = (u.cacheWrite || 0) - cw1h;
    usd += ((u.input || 0) * p.in + cw5 * p.cw5 + cw1h * p.cw1h + (u.cacheRead || 0) * p.cr + (u.output || 0) * p.out) / 1e6;
  }
  return { usd: known ? usd : null, unknown };
}

export function formatUsd(usd) {
  if (usd == null) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Cost of one usage-log row. Rows logged before per-model detail existed are
 * estimated from the total (all input priced as uncached) and flagged.
 */
export function costOfUsageRecord(r) {
  if (r.models && Object.keys(r.models).length) {
    const models = { ...r.models };
    // 1-hour cache writes are reported once per call; apply them to the main model.
    if (r.cacheWrite1h && models[r.model]) models[r.model] = { ...models[r.model], cacheWrite1h: r.cacheWrite1h };
    return { ...costOfModels(models), estimated: false };
  }
  const p = priceFor(r.model, r.totalInput || 0);
  if (!p) return { usd: null, estimated: true, unknown: [r.model] };
  return { usd: ((r.totalInput || 0) * p.in + (r.outputTokens || 0) * p.out) / 1e6, estimated: true, unknown: [] };
}
