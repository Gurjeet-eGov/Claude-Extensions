// Assignee <select> options: people already working on the board first, then everyone
// GitHub lets you assign in the repo, then Unassigned. Only assignable people are listed,
// because GitHub rejects an issue assigned to anyone else.

import { escapeHtml as esc } from './markdown.js';

export function assigneeGroups({ assignees = [], boardAssignees = [], repo = '' }) {
  const byLogin = new Map(assignees.map((a) => [a.login.toLowerCase(), a]));
  const onBoard = [];
  const seen = new Set();
  for (const b of boardAssignees) {
    const a = byLogin.get(String(b.login).toLowerCase());
    if (!a && assignees.length) continue; // no longer assignable in this repo
    const person = a || { login: b.login, name: '' };
    onBoard.push({ ...person, count: b.count });
    seen.add(person.login.toLowerCase());
  }
  const others = assignees.filter((a) => !seen.has(a.login.toLowerCase())).sort((x, y) => x.login.localeCompare(y.login, undefined, { sensitivity: 'base' }));
  return { onBoard, others, repo };
}

const label = (p) => (p.name ? `${p.name} (${p.login})` : p.login);

/** HTML for the <select>; `selected` is a login ('' = Unassigned). */
export function assigneeOptionsHtml({ assignees, boardAssignees, repo, selected = '' }) {
  const { onBoard, others } = assigneeGroups({ assignees, boardAssignees, repo });
  const sel = String(selected || '').toLowerCase();
  const opt = (p, extra = '') =>
    `<option value="${esc(p.login)}" ${p.login.toLowerCase() === sel ? 'selected' : ''}>${esc(label(p))}${extra}</option>`;
  const known = new Set([...onBoard, ...others].map((p) => p.login.toLowerCase()));
  let html = '';
  if (sel && !known.has(sel)) html += `<option value="${esc(selected)}" selected>${esc(selected)} (not found in ${esc(repo || 'repo')})</option>`;
  if (onBoard.length) html += `<optgroup label="On this board">${onBoard.map((p) => opt(p, ` · ${p.count} item${p.count === 1 ? '' : 's'}`)).join('')}</optgroup>`;
  if (others.length) html += `<optgroup label="Everyone who can be assigned${repo ? ` in ${esc(repo)}` : ''}">${others.map((p) => opt(p)).join('')}</optgroup>`;
  html += `<option value="" ${sel ? '' : 'selected'}>Unassigned</option>`;
  return html;
}
