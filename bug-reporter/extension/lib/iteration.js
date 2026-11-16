// Picks the current iteration of a GitHub Projects v2 iteration field.
// An iteration covers [startDate, startDate + duration days). Ordering and titles
// are not trusted: boards carry future iterations alongside the live one.

const DAY = 86400000;

function dayNumber(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

export function todayNumber(now = new Date()) {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY);
}

export function iterationRange(it) {
  const start = dayNumber(it.startDate);
  return { start, end: start + Number(it.duration || 0) };
}

export function endDateOf(it) {
  const { end } = iterationRange(it);
  return new Date((end - 1) * DAY).toISOString().slice(0, 10);
}

/** @returns {object|null} the iteration whose range contains today */
export function currentIteration(iterations, now = new Date()) {
  const today = todayNumber(now);
  return (iterations || []).find((it) => {
    const { start, end } = iterationRange(it);
    return start <= today && today < end;
  }) || null;
}

/** Current and upcoming iterations, sorted by start date. */
export function selectableIterations(iterations, now = new Date()) {
  const today = todayNumber(now);
  return (iterations || [])
    .filter((it) => iterationRange(it).end > today)
    .sort((a, b) => iterationRange(a).start - iterationRange(b).start);
}
