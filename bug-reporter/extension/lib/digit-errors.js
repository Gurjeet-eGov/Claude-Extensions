// Decides whether a captured API call failed, and pulls out a short error code
// and message for the report's API list. Pure functions: also used by unit tests.

export function parseJSON(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// DIGIT services report errors in an `Errors` array (sometimes with HTTP 200),
// or set ResponseInfo.status to "failed". GraphQL-style `errors` also counts.
export function digitError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const errs = Array.isArray(body.Errors) ? body.Errors : Array.isArray(body.errors) ? body.errors : null;
  if (errs && errs.length) {
    const e = errs[0] && typeof errs[0] === 'object' ? errs[0] : { message: String(errs[0]) };
    return {
      code: String(e.code ?? e.errorCode ?? e.type ?? '').trim(),
      message: String(e.message ?? e.description ?? e.msg ?? e.localizedMessage ?? '').trim(),
      count: errs.length,
    };
  }
  const info = body.ResponseInfo || body.responseInfo;
  const status = info && typeof info.status === 'string' ? info.status : '';
  if (/^(failed|failure|error)$/i.test(status)) {
    return { code: 'RESPONSE_FAILED', message: `ResponseInfo.status = ${status}`, count: 1 };
  }
  return null;
}

function firstLine(text, max = 140) {
  if (typeof text !== 'string') return '';
  const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > max ? stripped.slice(0, max - 1) + '…' : stripped;
}

/**
 * @param {{status?:number,statusText?:string,error?:string,errorKind?:string,resBody?:string}} call
 * @returns {{failed:boolean, errCode:string, errMsg:string}}
 */
export function analyzeCall(call) {
  const out = { failed: false, errCode: '', errMsg: '' };
  if (!call) return out;
  if (call.error) {
    out.failed = true;
    out.errCode = call.errorKind || 'NETWORK_ERROR';
    out.errMsg = String(call.error);
    return out;
  }
  const status = Number(call.status) || 0;
  if (status === 0) {
    out.failed = true;
    out.errCode = 'NETWORK_ERROR';
    out.errMsg = call.statusText || 'No response (network, CORS or aborted)';
    return out;
  }
  const digit = digitError(parseJSON(call.resBody));
  if (status >= 400) {
    out.failed = true;
    out.errCode = digit?.code || String(status);
    out.errMsg = digit?.message || call.statusText || firstLine(call.resBody);
    return out;
  }
  if (digit) {
    out.failed = true;
    out.errCode = digit.code || 'ERROR_IN_BODY';
    out.errMsg = digit.message;
  }
  return out;
}

// One line used in the API list and in Claude's compact summary.
export function summarizeCall(call, { haltWall } = {}) {
  let path = call.url || '';
  try {
    const u = new URL(call.url);
    path = u.pathname + (u.search.length > 60 ? u.search.slice(0, 57) + '…' : u.search);
  } catch {}
  const rel = haltWall ? relTime(call.ts - haltWall) + ' ' : '';
  const status = call.error ? 'ERR' : String(call.status ?? '');
  const err = call.failed ? ` · ${[call.errCode, call.errMsg].filter(Boolean).join(': ')}` : '';
  return `${rel}${call.method || 'GET'} ${path} → ${status}${err}`;
}

export function relTime(ms) {
  const sign = ms < 0 ? '−' : '+';
  const s = Math.round(Math.abs(ms) / 1000);
  const m = Math.floor(s / 60);
  return `${sign}${m}:${String(s % 60).padStart(2, '0')}`;
}
