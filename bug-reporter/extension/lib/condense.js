// Shrinks a captured request/response so Claude can read what matters (errors,
// IDs, statuses, the fields that were sent) without paying for whole payloads.
// The issue body still gets the full cURL and response; this is only Claude's view.

import { parseJSON } from './digit-errors.js';

const DEFAULTS = { maxArray: 3, maxString: 300, maxDepth: 6 };

export function condenseValue(value, opts = {}, depth = 0) {
  const o = { ...DEFAULTS, ...opts };
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > o.maxString ? value.slice(0, o.maxString) + `…(+${value.length - o.maxString} chars)` : value;
  if (depth >= o.maxDepth) return Array.isArray(value) ? `[…${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, o.maxArray).map((v) => condenseValue(v, o, depth + 1));
    if (value.length > o.maxArray) head.push(`…(+${value.length - o.maxArray} more)`);
    return head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = condenseValue(v, o, depth + 1);
  return out;
}

/**
 * DIGIT's RequestInfo is boilerplate (apiId, msgId, ts, authToken…). Keep only what can
 * explain a failure: the user's type, tenant and role codes.
 */
export function slimRequestInfo(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const key = Object.keys(body).find((k) => /^requestinfo$/i.test(k));
  if (!key) return body;
  const ri = body[key] || {};
  const u = ri.userInfo || ri.userinfo;
  const slim = {};
  if (u) {
    slim.userInfo = {
      type: u.type,
      userName: u.userName,
      tenantId: u.tenantId,
      roles: [...new Set((u.roles || []).map((r) => (r.tenantId ? `${r.code}@${r.tenantId}` : r.code)))],
    };
  }
  const { [key]: _drop, ...rest } = body;
  return Object.keys(slim).length ? { [key]: slim, ...rest } : rest;
}

function render(text, kind) {
  const parsed = parseJSON(text);
  if (parsed === undefined) {
    const t = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > 600 ? t.slice(0, 600) + '…' : t;
  }
  let v = kind === 'request' ? slimRequestInfo(parsed) : parsed;
  // Keep error arrays whole (they are the point); condense everything else.
  if (kind === 'response' && v && typeof v === 'object' && (v.Errors || v.errors)) {
    const errs = v.Errors || v.errors;
    const { Errors: _e, errors: _e2, ...others } = v;
    v = { Errors: condenseValue(errs, { maxArray: 10, maxString: 600 }), ...condenseValue(others) };
  } else v = condenseValue(v);
  return JSON.stringify(v);
}

/**
 * One attached call as Claude sees it in "detailed" mode.
 * @returns {string} a few lines: request line, condensed request body, condensed response
 */
export function condenseCall(call, { maxChars = 3000 } = {}) {
  let url = call.url;
  try {
    const u = new URL(call.url);
    url = u.pathname + u.search;
  } catch {}
  const lines = [];
  if (call.reqBodyKind === 'formdata') {
    lines.push(`Request form fields: ${(call.reqFormData || []).map((e) => (e.file ? `${e.name}=<file ${e.file.name}, ${e.file.size} bytes>` : `${e.name}=${String(e.value).slice(0, 120)}`)).join(', ')}`);
  } else if (call.reqBody) {
    lines.push(`Request body: ${render(call.reqBody, 'request')}`);
  }
  if (call.error) lines.push(`Response: none (${call.error})`);
  else if (call.resBody != null && call.resBody !== '') lines.push(`Response ${call.status}: ${render(call.resBody, 'response')}`);
  else lines.push(`Response ${call.status}: (empty${call.resBodyOmitted ? `; ${call.resBodyOmitted}` : ''})`);
  let text = `${call.method || 'GET'} ${url}\n` + lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…(truncated)';
  return text;
}
