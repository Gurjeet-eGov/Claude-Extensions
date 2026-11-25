// Automated test results, whatever the framework: a results file (JUnit XML or CTRF JSON,
// or a .zip holding several) becomes one run model. Plain code only: detection by content,
// masking of secrets before anything is kept, failure signatures for "failures by cause",
// and the comparisons the run view shows (previous run, what changed, history).
//
// A test:  { id, title, file, suite, tags[], caseIds[], status: 'pass'|'fail'|'other',
//            durationMs, retries, flaky, message, stack, masked? }
// A run:   { id, suiteId, suiteName, source: { kind, fileName, format, tool, repo, workflow, runId, runUrl, reportUrl, expiresAt },
//            branch, sha, env, options, by, startedAt, importedAt, durationMs,
//            attach: { book, tab, cycle }, totals: { passed, failed, skipped, flaky, total }, tests[] }
import { createHash, randomBytes } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import JSZip from 'jszip';

export const LIMITS = { message: 2048, stack: 2048, stackLines: 10, title: 500, file: 300, suite: 300, tag: 80, tags: 30, caseIds: 20 };
export const FORMAT_LABEL = { junit: 'JUnit XML', ctrf: 'CTRF JSON', mixed: 'JUnit XML and CTRF JSON' };
const ZIP_MAX_FILES = 500;
const ZIP_MAX_BYTES = 200 * 1024 * 1024; // what a zip may unpack to, all files together

const err = (code, message) => Object.assign(new Error(message), { code });
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI, '');
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------
// Masking: secrets out before anything is stored
// ---------------------------------------------------------------------------

const SECRET_KEYS = 'password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|session[_-]?id';
/** Always masked: tokens, passwords, Authorization headers, JWTs, keys in URLs. Order matters (headers before key=value). */
const BUILT_IN = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***'],
  [/\b((?:proxy-)?authorization|x-auth-token|auth-token|x-access-token|x-api-key|api-key|cookie|set-cookie)(\s*:\s*)([^\r\n]+)/gi, '$1$2***'],
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer ***'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '***'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '***'],
  [/(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, '$1$2:***@'],
  [new RegExp(`\\b(${SECRET_KEYS})(["']?\\s*[=:]\\s*)(["']?)([^\\s&"',;)}\\]]+)`, 'gi'), '$1$2$3***'],
];

/**
 * A suite's extra masking rules, checked: each a plain text, or a /pattern/flags.
 * Returns { rules: [RegExp], errors: [message] }.
 */
export function compileMasking(list) {
  const rules = [];
  const errors = [];
  for (const raw of arr(list).slice(0, 20)) {
    const r = String(raw == null ? '' : raw).trim();
    if (!r) continue;
    if (r.length > 200) { errors.push(`The masking rule “${r.slice(0, 30)}…” is too long (at most 200 characters).`); continue; }
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(r);
    let re;
    try {
      re = m ? new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`) : new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    } catch (e) {
      errors.push(`The masking pattern ${r} doesn't work: ${e.message}.`);
      continue;
    }
    if (new RegExp(re.source, re.flags.replace('g', '')).test('')) { errors.push(`The masking pattern ${r} matches an empty text; make it match the secret itself.`); continue; }
    rules.push(re);
  }
  return { rules, errors };
}

/** A masker for one suite: text -> { text, masked }. */
export function masker(extra) {
  const rules = (extra && extra.rules) || compileMasking(extra).rules;
  return (text) => {
    const s = String(text == null ? '' : text);
    if (!s) return { text: s, masked: false };
    let out = s;
    for (const [re, to] of BUILT_IN) out = out.replace(re, to);
    for (const re of rules) out = out.replace(re, '***');
    return { text: out, masked: out !== s };
  };
}

/** Mask one text with the built-in rules plus extra ones (plain texts or /patterns/). */
export function maskText(text, extra) {
  return masker(extra)(text);
}

// ---------------------------------------------------------------------------
// Case IDs: a suite's pattern (e.g. CMS/\d+) over each test's title and tags
// ---------------------------------------------------------------------------

/** The case-ID pattern as a RegExp, or null for none. Throws BAD_INPUT when it doesn't compile. */
export function compileCasePattern(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return null;
  if (s.length > 120) throw err('BAD_INPUT', 'The case-ID pattern is too long (at most 120 characters).');
  const m = /^\/(.+)\/([imsu]*)$/.exec(s);
  let re;
  try { re = new RegExp(m ? m[1] : s, `${m ? m[2] : ''}g`); } catch (e) { throw err('BAD_INPUT', `The case-ID pattern doesn't work: ${e.message}.`); }
  if (new RegExp(re.source, re.flags.replace('g', '')).test('')) throw err('BAD_INPUT', 'The case-ID pattern matches an empty text; make it match an ID, e.g. CMS/\\d+.');
  return re;
}

function caseIdsIn(re, text) {
  if (!re) return [];
  const out = [];
  re.lastIndex = 0;
  for (const m of String(text).matchAll(re)) {
    const v = clip(m[0], 60);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= LIMITS.caseIds) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Messages and stacks
// ---------------------------------------------------------------------------

const lines = (s) => stripAnsi(s).replace(/\r\n?/g, '\n').split('\n');
const ERROR_LINE = /^\s*(?:[\w.$]*(?:Error|Exception|Failure)\b|E {2,}|Timeout\b|Timed out\b|expect\()/;
const STACK_LINE = /^\s*(?:at\s|File "|\S+\.\w+:\d+(?::\d+)?(?:\s|$)|>?\s*\d+\s*\|)/;
/** Playwright's message attribute is "file:line:col title", not the error. */
const LOCATION_ONLY = /^\S+\.\w+:\d+(?::\d+)?\s/;

function capText(s, max) {
  const t = String(s || '').replace(/\s+$/, '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** From a failure's message attribute and its text: the message (a few lines) and the top of the stack. */
export function splitFailure(attr, text) {
  const a = stripAnsi(attr).trim();
  const ls = lines(text);
  const python = /Traceback \(most recent call last\)/.test(text || '') || ls.some((l) => /^E {2,}\S/.test(l));
  let msg = '';
  let rest = ls;
  const useAttr = a && !LOCATION_ONLY.test(a);
  if (!useAttr) {
    const i = ls.findIndex((l) => ERROR_LINE.test(l));
    if (i >= 0) {
      const block = [];
      let blank = 0;
      let j = i;
      for (; j < ls.length && block.length < 8; j++) {
        const l = ls[j];
        if (!l.trim()) { blank++; if (blank > 1) break; continue; }
        if (j > i && (STACK_LINE.test(l) || (python && !/^E {2,}/.test(l)))) break;
        blank = 0;
        block.push(python ? l.replace(/^E {2,}/, '') : l.trim());
      }
      msg = block.join('\n');
      rest = python ? ls.slice(0, i).concat(ls.slice(j)) : ls.slice(j); // before the error: a runner's header line
    } else {
      msg = a || (ls.find((l) => l.trim()) || '').trim();
    }
  } else {
    msg = a;
  }
  const kept = rest.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  // the top of a stack; Python tracebacks read the other way, so their last lines
  const top = python ? kept.slice(-LIMITS.stackLines) : kept.slice(0, LIMITS.stackLines);
  const indent = top.length ? Math.min(...top.map((l) => /^\s*/.exec(l)[0].length)) : 0;
  return { message: msg, stack: top.map((l) => l.slice(indent)).join('\n') };
}

// ---------------------------------------------------------------------------
// Failure signatures: "failures by cause"
// ---------------------------------------------------------------------------

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The first line of a message with numbers, IDs and quoted values taken out, so tests that broke the same way match. */
export function signature(message) {
  const first = lines(message).map((l) => l.trim()).find(Boolean) || '';
  if (!first) return '(no message)';
  return first
    .replace(UUID, '{id}')
    .replace(/\b0x[0-9a-f]+\b/gi, '{id}')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '{id}')
    .replace(/"[^"\n]*"/g, '"…"')
    .replace(/(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])/g, '\'…\'')
    .replace(/`[^`\n]*`/g, '`…`')
    .replace(/\d+(?:[.,]\d+)?/g, '{n}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Failed tests grouped by signature, biggest first; signatures seen once are put together
 * at the end ("Other messages (each seen once)") when there are several.
 * newIds: the tests that are new failures (for the "x new" count).
 */
export function groupCauses(tests, newIds = []) {
  const isNew = new Set(newIds);
  const groups = new Map();
  for (const t of tests) {
    if (t.status !== 'fail') continue;
    const sig = signature(t.message);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(t.id);
  }
  let list = [...groups].map(([sig, ids]) => ({ signature: sig, count: ids.length, newCount: ids.filter((id) => isNew.has(id)).length, tests: ids }));
  list.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  const singles = list.filter((g) => g.count === 1);
  // put the one-offs together only when there are real causes to read first, or many lines
  if (singles.length >= 2 && (singles.length < list.length || list.length > 8)) {
    list = list.filter((g) => g.count > 1);
    const ids = singles.flatMap((g) => g.tests);
    list.push({ signature: 'Other messages (each seen once)', other: true, count: ids.length, newCount: ids.filter((id) => isNew.has(id)).length, tests: ids });
  }
  return list;
}

// ---------------------------------------------------------------------------
// One test, as kept
// ---------------------------------------------------------------------------

const testId = (suite, file, title) => createHash('sha1').update(`${suite}\n${file}\n${title}`).digest('hex').slice(0, 12);

function cleanTags(list) {
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const v = clip(String(t).replace(/\s+/g, ' '), LIMITS.tag);
    const k = v.replace(/^@/, '').toLowerCase(); // "@smoke" in a title and "smoke" in the tags are one tag
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

/** raw: { title, file, suite, tags, status, durationMs, retries, flaky, message, stack } -> the kept test (masked, trimmed). */
function makeTest(raw, ctx) {
  let masked = false;
  const m = (s, n) => {
    const r = ctx.mask(stripAnsi(s).slice(0, 16384)); // masked first, then cut: a secret is never cut in half and kept
    if (r.masked) masked = true;
    return capText(r.text, n);
  };
  const title = m(String(raw.title || '').replace(/\s+/g, ' '), LIMITS.title) || '(untitled)';
  const file = m(raw.file, LIMITS.file);
  const suite = m(raw.suite, LIMITS.suite);
  const tags = cleanTags([...arr(raw.tags), ...(title.match(/(?<!\S)@[^\s@]+/g) || [])].map((t) => m(t, LIMITS.tag)));
  const status = raw.status === 'fail' ? 'fail' : raw.status === 'other' ? 'other' : 'pass';
  const t = {
    id: testId(suite, file, title),
    title,
    file,
    suite,
    tags,
    caseIds: caseIdsIn(ctx.casePattern, `${title} ${tags.join(' ')}`),
    status,
    durationMs: Math.max(0, Math.round(Number(raw.durationMs) || 0)),
    retries: Math.max(0, Math.min(99, Math.round(Number(raw.retries) || 0))),
    flaky: raw.flaky === true && status === 'pass',
    message: m(raw.message, LIMITS.message),
    stack: m(stackTop(raw.stack), LIMITS.stack),
  };
  if (masked) t.masked = true;
  return t;
}

function stackTop(s) {
  const kept = lines(s).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  return kept.slice(0, LIMITS.stackLines).join('\n');
}

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

const MANY = new Set(['testsuites', 'testsuite', 'testcase', 'property', 'failure', 'error', 'skipped', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true, // numeric references such as &#10; too
  allowBooleanAttributes: true,
  isArray: (name) => MANY.has(name),
});

const attr = (n, k) => (n && typeof n === 'object' && n[`@_${k}`] != null ? String(n[`@_${k}`]) : '');
const text = (n) => (n == null ? '' : typeof n === 'object' ? String(n['#text'] == null ? '' : n['#text']) : String(n));
const seconds = (s) => { const v = parseFloat(String(s || '').replace(/,/g, '')); return Number.isFinite(v) && v >= 0 ? v * 1000 : 0; };
const isoOf = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };
const PATHLIKE = /^[^\s]+[/\\][^\s]+$/;

function parseJunit(src, ctx) {
  const body = src.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, ''); // no DOCTYPE entities, ever
  const valid = XMLValidator.validate(body, { allowBooleanAttributes: true });
  if (valid !== true) {
    const e = valid.err || {};
    throw err('BAD_FORMAT', `“${ctx.fileName}” isn't valid XML${e.line ? ` (line ${e.line}: ${e.msg})` : ''}.`);
  }
  let doc;
  try {
    doc = xml.parse(body);
  } catch (e) {
    throw err('BAD_FORMAT', `“${ctx.fileName}” isn't valid XML (${String(e.message).split('\n')[0]}).`);
  }
  const raws = [];
  const state = { lastFile: '', startedAt: '', durationMs: 0 };
  const walk = (node, path, inheritedFile, top) => {
    const name = attr(node, 'name').trim();
    const ownFile = attr(node, 'file');
    if (ownFile) state.lastFile = ownFile;
    const file = ownFile || inheritedFile;
    const stamp = isoOf(attr(node, 'timestamp'));
    if (stamp && (!state.startedAt || stamp < state.startedAt)) state.startedAt = stamp;
    if (top) state.durationMs += seconds(attr(node, 'time'));
    const here = name && name !== 'Root Suite' ? path.concat([name]) : path;
    for (const tc of arr(node.testcase)) raws.push(junitCase(tc, here, file || state.lastFile));
    for (const child of arr(node.testsuite)) walk(child, here, file, false);
  };
  const roots = arr(doc.testsuites);
  let topTime = 0;
  for (const group of roots) {
    topTime += seconds(attr(group, 'time'));
    for (const ts of arr(group.testsuite)) walk(ts, [], '', true);
    for (const inner of arr(group.testsuites)) for (const ts of arr(inner.testsuite)) walk(ts, [], '', true);
  }
  for (const ts of arr(doc.testsuite)) walk(ts, [], '', true);
  if (!roots.length && !arr(doc.testsuite).length) throw err('BAD_FORMAT', `“${ctx.fileName}” has no <testsuites> or <testsuite>.`);
  const tests = raws.map((r) => makeTest(r, ctx));
  return { tests, tool: '', startedAt: state.startedAt, durationMs: Math.round(topTime || state.durationMs || tests.reduce((n, t) => n + t.durationMs, 0)), branch: '', sha: '', env: '' };
}

function junitCase(tc, path, suiteFile) {
  const title = attr(tc, 'name');
  const cls = attr(tc, 'classname');
  const file = attr(tc, 'file') || suiteFile || (PATHLIKE.test(cls) ? cls : '');
  const suitePath = path.filter((p) => p !== file);
  const suite = cls && cls !== title && !title.endsWith(cls) && cls !== file ? cls : suitePath.join(' › ');
  const fails = arr(tc.failure).concat(arr(tc.error));
  const skipped = arr(tc.skipped);
  const flakies = arr(tc.flakyFailure).concat(arr(tc.flakyError));
  const reruns = arr(tc.rerunFailure).concat(arr(tc.rerunError));
  let status = 'pass';
  let message = '';
  let stack = '';
  if (fails.length) {
    status = 'fail';
    const f = fails[0];
    const body = text(f) || text(f && f.stackTrace && arr(f.stackTrace)[0]);
    ({ message, stack } = splitFailure(attr(f, 'message'), body));
  } else if (skipped.length) {
    status = 'other';
    message = attr(skipped[0], 'message') || text(skipped[0]).trim();
  }
  const tags = [];
  for (const p of arr(tc.properties && tc.properties.property)) {
    if (/^(tags?|labels?|markers?|categor(y|ies))$/i.test(attr(p, 'name'))) tags.push(...(attr(p, 'value') || text(p)).split(/[,\s]+/).filter(Boolean));
  }
  return { title, file, suite, tags, status, durationMs: seconds(attr(tc, 'time')), retries: flakies.length + reruns.length, flaky: !fails.length && flakies.length > 0, message, stack };
}

// ---------------------------------------------------------------------------
// CTRF JSON (https://ctrf.io)
// ---------------------------------------------------------------------------

function parseCtrf(j, ctx) {
  const r = j.results || {};
  const tool = r.tool && r.tool.name ? `${clip(r.tool.name, 40)}${r.tool.version ? ` ${clip(r.tool.version, 20)}` : ''}` : '';
  const tests = arr(r.tests).filter((t) => t && typeof t === 'object').map((t) => {
    const st = String(t.status || '').toLowerCase();
    const status = st === 'failed' ? 'fail' : st === 'passed' ? 'pass' : 'other';
    const suite = Array.isArray(t.suite) ? t.suite.map(String).join(' › ') : String(t.suite || '');
    let message = String(t.message || '');
    let stack = String(t.trace || '');
    if (status === 'fail' && !message && stack) ({ message, stack } = splitFailure('', stack));
    return makeTest({
      title: t.name, file: t.filePath || '', suite, tags: arr(t.tags), status,
      durationMs: Number(t.duration) || (Number(t.stop) - Number(t.start)) || 0,
      retries: t.retries, flaky: t.flaky === true, message, stack,
    }, ctx);
  });
  const s = r.summary || {};
  const env = r.environment || {};
  const start = Number(s.start);
  const stop = Number(s.stop);
  return {
    tests,
    tool,
    startedAt: start > 0 ? isoOf(start) : '',
    durationMs: start > 0 && stop >= start ? stop - start : tests.reduce((n, t) => n + t.durationMs, 0),
    branch: clip(env.branchName, 120),
    sha: clip(env.commit, 64),
    env: clip(env.testEnvironment, 80),
  };
}

// ---------------------------------------------------------------------------
// Files: detection by content, zips, uploads with several files
// ---------------------------------------------------------------------------

const isZip = (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** 'junit' | 'ctrf' | 'zip' | null, from the file's content (never its name). */
export function detectFormat(buf) {
  return sniff(buf).format;
}

function sniff(buf) {
  if (!buf || !buf.length) return { format: null };
  if (isZip(buf)) return { format: 'zip' };
  const s = buf.toString('utf8').replace(/^﻿/, '');
  const head = s.trimStart();
  if (head.startsWith('<')) return /<testsuites?[\s>/]/.test(s) ? { format: 'junit', text: s } : { format: null };
  if (head.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && j.results && Array.isArray(j.results.tests)) return { format: 'ctrf', json: j };
    } catch { /* not JSON */ }
  }
  return { format: null };
}

/** The files in an upload: one file, or each file inside a zip. -> [{ name, buf }] */
export async function expandFiles(input) {
  const out = [];
  for (const f of arr(input)) {
    if (!isZip(f.buf)) { out.push(f); continue; }
    let zip;
    try { zip = await JSZip.loadAsync(f.buf); } catch (e) { throw err('BAD_FORMAT', `“${f.name}” isn't a readable .zip (${e.message}).`); }
    const entries = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX\/|\.)/.test(e.name));
    if (entries.length > ZIP_MAX_FILES) throw err('TOO_BIG', `“${f.name}” holds more than ${ZIP_MAX_FILES} files.`);
    let total = 0;
    for (const e of entries) {
      const size = e._data && e._data.uncompressedSize;
      if (size) { total += size; if (total > ZIP_MAX_BYTES) throw err('TOO_BIG', `“${f.name}” unpacks to more than ${ZIP_MAX_BYTES / 1048576} MB.`); }
      const buf = await e.async('nodebuffer');
      if (!size) { total += buf.length; if (total > ZIP_MAX_BYTES) throw err('TOO_BIG', `“${f.name}” unpacks to more than ${ZIP_MAX_BYTES / 1048576} MB.`); }
      if (isZip(buf)) continue; // no zips inside zips
      out.push({ name: `${f.name} › ${e.name}`, buf });
    }
  }
  return out;
}

/** A multipart/form-data body -> [{ name, buf }] (each part that is a file). */
export function filesFromMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!m) throw err('BAD_INPUT', 'The upload has no boundary.');
  const sep = Buffer.from(`--${m[1] || m[2]}`);
  const out = [];
  let at = body.indexOf(sep);
  while (at >= 0) {
    const start = at + sep.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(sep, start);
    if (next < 0) break;
    const part = body.slice(start + 2, next - 2); // past CRLF, before the CRLF ahead of the next boundary
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const head = part.slice(0, split).toString('utf8');
      const fname = /filename\*?=(?:UTF-8'')?"?([^";\r\n]*)"?/i.exec(head);
      if (fname) {
        let name = fname[1];
        try { name = decodeURIComponent(name); } catch { /* as sent */ }
        out.push({ name: clip(name.split(/[\\/]/).pop(), 200) || 'results', buf: part.slice(split + 4) });
      }
    }
    at = next;
  }
  return out;
}

/**
 * Parse an upload into the tests of one run.
 * input: [{ name, buf }] (files, zips among them). opts: { casePattern, masking }.
 * Returns { format, formatLabel, tool, files: [{ name, format, tests }], ignored: [name], tests, totals,
 *           startedAt, durationMs, branch, sha, env }.
 */
export async function parseResults(input, opts = {}) {
  const ctxBase = {
    casePattern: opts.casePattern instanceof RegExp ? opts.casePattern : compileCasePattern(opts.casePattern),
    mask: masker(opts.masking),
  };
  const files = await expandFiles(input);
  const parts = [];
  const ignored = [];
  for (const f of files) {
    const sn = sniff(f.buf);
    if (!sn.format || sn.format === 'zip') { ignored.push(f.name); continue; }
    const ctx = { ...ctxBase, fileName: f.name };
    const p = sn.format === 'junit' ? parseJunit(sn.text, ctx) : parseCtrf(sn.json, ctx);
    parts.push({ name: f.name, format: sn.format, ...p });
  }
  if (!parts.length) {
    const names = files.map((f) => `“${f.name}”`).join(', ') || 'The upload';
    throw err('BAD_FORMAT', `${names}: Test Run reads JUnit XML or CTRF JSON results (or a .zip of them), and found none here.`);
  }
  const tests = [];
  const seen = new Map();
  for (const p of parts) {
    for (const t of p.tests) {
      const n = (seen.get(t.id) || 0) + 1; // the same test twice (another browser, a re-run file): kept apart
      seen.set(t.id, n);
      tests.push(n > 1 ? { ...t, id: `${t.id}-${n}` } : t);
    }
  }
  const formats = [...new Set(parts.map((p) => p.format))];
  const format = formats.length > 1 ? 'mixed' : formats[0];
  const starts = parts.map((p) => p.startedAt).filter(Boolean).sort();
  let durationMs = parts.reduce((n, p) => n + p.durationMs, 0);
  if (parts.length > 1 && starts.length === parts.length) {
    const end = Math.max(...parts.map((p) => Date.parse(p.startedAt) + p.durationMs));
    durationMs = Math.max(0, end - Date.parse(starts[0]));
  }
  const first = (k) => (parts.find((p) => p[k]) || {})[k] || '';
  return {
    format,
    formatLabel: FORMAT_LABEL[format],
    tool: first('tool'),
    files: parts.map((p) => ({ name: p.name, format: p.format, tests: p.tests.length })),
    ignored,
    tests,
    totals: totalsOf(tests),
    startedAt: starts[0] || '',
    durationMs,
    branch: first('branch'),
    sha: first('sha'),
    env: first('env'),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function totalsOf(tests) {
  const t = { passed: 0, failed: 0, skipped: 0, flaky: 0, total: tests.length };
  for (const x of tests) {
    if (x.status === 'pass') t.passed++; else if (x.status === 'fail') t.failed++; else t.skipped++;
    if (x.flaky) t.flaky++;
  }
  return t;
}

/** Passed out of passed and failed (skipped left out, as in the manual Summary), or null. */
export function passRate(totals) {
  const n = (totals.passed || 0) + (totals.failed || 0);
  return n ? Math.round((totals.passed / n) * 100) : null;
}

export function newRunId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${iso}-${randomBytes(3).toString('hex')}`;
}

export const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/** A clean attach target, or throws NO_ATTACH: every run belongs to a workbook › test suite › test cycle. */
export function cleanAttach(a) {
  const ok = a && typeof a === 'object' && clip(a.book, 260) && clip(a.tab, 160) && typeof a.cycle === 'string';
  if (!ok) throw err('NO_ATTACH', 'Choose the workbook, test suite and test cycle these results belong to.');
  return { book: clip(a.book, 260), tab: clip(a.tab, 160), cycle: clip(a.cycle, 60) };
}

export const MAX_REPORT_URL = 500;
// eslint-disable-next-line no-control-regex
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * The suite's own published report, as a run's report-link artifact names it: kept only when it is an
 * absolute http(s) address of at most 500 characters, with no spaces or control characters and no
 * user name or password in it. Anything else is ''.
 */
export function cleanReportUrl(v) {
  const s = typeof v === 'string' ? v : '';
  if (!s || s.length > MAX_REPORT_URL || SPACE_OR_CONTROL.test(s) || !/^https?:\/\//i.test(s)) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || u.username || u.password) return '';
  return s;
}

/** A date as ISO text, or '' when it isn't one. */
const isoOrEmpty = (v) => { const t = Date.parse(String(v || '')); return Number.isNaN(t) ? '' : new Date(t).toISOString(); };

/**
 * The run as kept. parsed: from parseResults. o: { suite, attach (required), source, branch, sha, env, options, by, now }.
 */
export function buildRun(parsed, o = {}) {
  const attach = cleanAttach(o.attach);
  if (!o.suite || !o.suite.id) throw err('NO_SUITE', 'Choose the automated suite these results belong to.');
  const now = o.now || new Date();
  const src = o.source || {};
  const options = {};
  for (const [k, v] of Object.entries(o.options || {}).slice(0, 30)) if (clip(k, 60)) options[clip(k, 60)] = clip(v, 200);
  return {
    id: newRunId(now),
    suiteId: o.suite.id,
    suiteName: clip(o.suite.name, 120),
    source: {
      kind: src.kind === 'github' ? 'github' : 'upload',
      fileName: clip(src.fileName, 200),
      format: parsed.format,
      tool: clip(parsed.tool, 80),
      repo: clip(src.repo, 140),
      workflow: clip(src.workflow, 140),
      runId: clip(src.runId, 40),
      runUrl: /^https:\/\//i.test(String(src.runUrl || '')) ? clip(src.runUrl, 400) : '',
      reportUrl: cleanReportUrl(src.reportUrl), // the suite's published report, when the run gave one ('' otherwise)
      expiresAt: isoOrEmpty(src.expiresAt), // when GitHub deletes the run's results artifact ('' when not known)
    },
    branch: clip(o.branch || parsed.branch, 120),
    sha: clip(o.sha || parsed.sha, 64),
    env: clip(o.env || parsed.env, 80),
    options,
    by: clip(o.by, 80),
    startedAt: parsed.startedAt || now.toISOString(),
    importedAt: now.toISOString(),
    durationMs: Math.max(0, Math.round(parsed.durationMs || 0)),
    attach,
    totals: totalsOf(parsed.tests),
    tests: parsed.tests,
  };
}

/** A run without its tests (what the index keeps). */
export function metaOf(run) {
  const { tests, ...meta } = run;
  return meta;
}

// ---------------------------------------------------------------------------
// Comparing runs
// ---------------------------------------------------------------------------

const when = (r) => `${r.startedAt || ''}|${r.importedAt || ''}`;
const sameLine = (a, b) => a.suiteId === b.suiteId && a.attach.book === b.attach.book && a.attach.tab === b.attach.tab;

/** The runs of the same suite attached to the same workbook and test suite (any cycle), oldest first, up to and including run. */
export function lineOf(index, run) {
  return index.filter((r) => sameLine(r, run) && (r.id === run.id || when(r) < when(run)))
    .sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
}

/** The latest earlier run of the same suite attached to the same workbook and test suite, or null. */
export function previousRun(index, run) {
  const line = lineOf(index, run).filter((r) => r.id !== run.id);
  return line.length ? line[line.length - 1] : null;
}

/** What changed since the previous run: lists of test IDs. */
export function compareRuns(run, prev) {
  const before = new Map(prev ? prev.tests.map((t) => [t.id, t.status]) : []);
  const out = { newFailures: [], stillFailing: [], fixed: [], flaky: [] };
  for (const t of run.tests) {
    const was = before.get(t.id);
    if (t.status === 'fail') {
      if (!prev) continue;
      (was === 'fail' ? out.stillFailing : out.newFailures).push(t.id);
    } else if (t.status === 'pass' && was === 'fail') out.fixed.push(t.id);
    if (t.flaky) out.flaky.push(t.id);
  }
  return out;
}

/** Each test's status over runs (oldest first, ending with this run): { runs: [{ id, startedAt }], byTest: { id: [status|'none'] } }. */
export function historyOf(runs, run) {
  const maps = runs.map((r) => new Map(r.tests.map((t) => [t.id, t.status])));
  const byTest = {};
  for (const t of run.tests) byTest[t.id] = maps.map((m) => m.get(t.id) || 'none');
  return { runs: runs.map((r) => ({ id: r.id, startedAt: r.startedAt })), byTest };
}

/** Tests by file (or by suite when the file isn't known): most failures first. */
export function byFile(tests) {
  const m = new Map();
  for (const t of tests) {
    const k = t.file || t.suite || '(no file)';
    const g = m.get(k) || { file: k, total: 0, passed: 0, failed: 0, skipped: 0 };
    g.total++;
    if (t.status === 'pass') g.passed++; else if (t.status === 'fail') g.failed++; else g.skipped++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.failed - a.failed || a.file.localeCompare(b.file));
}
