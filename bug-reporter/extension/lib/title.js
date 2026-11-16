// Assembles the issue title in the house format without Claude:
//   [P1] <Env Prefix>: <Module>: <Short title>
// The [P?] part is only added when the board has no Priority field (mode "title").

export function titleCase(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function cleanShortTitle(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/[.\s]+$/, '');
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

export function buildTitle({ priority, priorityMode, envPrefix, module, shortTitle }) {
  const prefix = priorityMode === 'title' && priority ? `[${priority}] ` : '';
  const segs = [];
  if (envPrefix && envPrefix.trim()) segs.push(envPrefix.trim());
  if (module && module.trim()) segs.push(titleCase(module));
  const short = cleanShortTitle(shortTitle);
  if (short) segs.push(short);
  return prefix + segs.join(': ');
}

// Removes a prefix Claude may have added despite instructions ("Bomet: Citizen: …").
export function stripKnownPrefix(shortTitle, { envPrefix, module } = {}) {
  let t = String(shortTitle || '').trim().replace(/^\[P[0-3]\]\s*/i, '');
  for (const p of [envPrefix, module]) {
    if (!p) continue;
    const re = new RegExp('^' + p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*', 'i');
    t = t.replace(re, '');
  }
  return t;
}
