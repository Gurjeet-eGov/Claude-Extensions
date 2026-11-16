// Assembles the issue body. Claude writes only Description / Actual / Expected;
// API details, console errors, screenshots and the recording are added here
// verbatim, so Claude never has to re-type them.

import { toCurl } from './curl.js';
import { parseJSON } from './digit-errors.js';

const GITHUB_BODY_LIMIT = 65536;
const SAFE_LIMIT = 60000;

export function fence(content, lang = '') {
  const text = String(content ?? '');
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}

export function prettyResponse(resBody) {
  const parsed = parseJSON(resBody);
  if (parsed !== undefined) return { text: JSON.stringify(parsed, null, 2), lang: 'json' };
  return { text: String(resBody ?? ''), lang: 'text' };
}

export function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  const kb = (n) => (n / 1024).toFixed(n < 10240 ? 1 : 0);
  return {
    text: s.slice(0, maxChars) + `\n… truncated (${kb(s.length)} KB total)`,
    truncated: true,
  };
}

function apiBlock(call, maxChars) {
  const status = call.error ? `failed: ${call.error}` : `${call.status}${call.statusText ? ' ' + call.statusText : ''}`;
  const lines = [`**${call.method || 'GET'}** \`${call.url}\` → **${status}**`];
  lines.push('', fence(truncate(toCurl(call), Math.max(maxChars, 4000)).text, 'bash'));
  if (call.resBody != null && call.resBody !== '') {
    const pretty = prettyResponse(call.resBody);
    lines.push('', fence(truncate(pretty.text, maxChars).text, pretty.lang));
  } else if (call.resBodyOmitted) {
    lines.push('', `_Response body not captured (${call.resBodyOmitted})._`);
  }
  return lines.join('\n');
}

function consoleBlock(entries) {
  const text = entries
    .map((e) => {
      const time = new Date(e.ts).toISOString().slice(11, 19);
      return `[${time}] ${e.level || 'error'}: ${e.message}${e.stack ? '\n' + e.stack : ''}`;
    })
    .join('\n');
  return fence(text, 'text');
}

/**
 * @param {object} p
 * @param {string} p.description
 * @param {string} p.actual
 * @param {string} [p.expected]
 * @param {Array} [p.apiCalls]        captured calls to include
 * @param {Array} [p.consoleEntries]  console errors to include
 * @param {string[]} [p.screenshots]  file names, e.g. ["snapshot-1.png"]
 * @param {string|null} [p.video]     file name, e.g. "recording.mp4"
 * @param {number} [p.truncateKB]
 * @returns {{body:string, warnings:string[]}}
 */
export function buildBody(p) {
  const warnings = [];
  let maxChars = Math.max(1, Number(p.truncateKB || 8)) * 1024;
  let body = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    body = render(p, maxChars);
    if (body.length <= SAFE_LIMIT) break;
    maxChars = Math.floor(maxChars / 2);
    if (attempt === 0) warnings.push('Responses were shortened further to fit GitHub\'s issue size limit.');
  }
  if (body.length > GITHUB_BODY_LIMIT) {
    warnings.push('The body is still longer than GitHub allows; untick some API calls or console errors.');
  }
  return { body, warnings };
}

function render(p, maxChars) {
  const out = [];
  const add = (heading, text) => {
    const t = String(text ?? '').trim();
    if (t) out.push(`### ${heading}\n${t}`);
  };
  // Update Issue comments start with free text (result line + comment) instead of headings.
  if (p.lead && String(p.lead).trim()) out.push(String(p.lead).trim());
  add('Description', p.description);
  add('Actual Behavior', p.actual);
  add('Expected Behavior', p.expected);
  if (p.apiCalls?.length) {
    out.push('### API Details\n' + p.apiCalls.map((c) => apiBlock(c, maxChars)).join('\n\n'));
  }
  if (p.consoleEntries?.length) {
    out.push('### Console Errors\n' + consoleBlock(p.consoleEntries));
  }
  if (p.screenshots?.length) {
    out.push('### Screenshots\n' + p.screenshots.map((n, i) => `![Screenshot ${i + 1}](./${n})`).join('\n\n'));
  }
  if (p.video) {
    // A video reference alone in its paragraph renders as a player on GitHub.
    out.push(`### Screen Recording\n![](./${p.video})`);
  }
  return out.join('\n\n') + '\n';
}
