// Update Issue: the comment posted on an existing issue. Result line + your comment,
// then the same evidence sections as a new issue (API details, console, screenshots, video).

import { buildBody } from './body.js';

export const RESULTS = {
  fixed: { icon: '✅', text: 'Verified fixed' },
  failing: { icon: '❌', text: 'Still failing' },
  partial: { icon: '⚠️', text: 'Partly fixed' },
};

export function resultLine(result, envPrefix) {
  const r = RESULTS[result];
  if (!r) return '';
  return `${r.icon} **${r.text}**${envPrefix && envPrefix.trim() ? ` on ${envPrefix.trim()}` : ''}`;
}

/** @returns {{body:string, warnings:string[]}} */
export function buildComment({ result, envPrefix, comment, ...evidence }) {
  const lead = [resultLine(result, envPrefix), String(comment || '').trim()].filter(Boolean).join('\n\n');
  return buildBody({ lead, ...evidence });
}
