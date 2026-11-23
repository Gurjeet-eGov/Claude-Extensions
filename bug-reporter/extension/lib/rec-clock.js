// The recording clock: how long has been recorded, leaving out pauses, and frozen once stopped.

/**
 * Microseconds recorded at `now` (a performance.now() reading, in ms).
 * s: { state, startPerf, pausedTotal, pauseStart, stopPerf } (times in ms).
 */
export function elapsedUs(s, now) {
  if (!s || !s.startPerf) return 0;
  const end = s.state === 'stopped' && s.stopPerf ? s.stopPerf : now;
  const pausedNow = s.state === 'paused' ? end - s.pauseStart : 0;
  return Math.max(0, (end - s.startPerf - (s.pausedTotal || 0) - pausedNow) * 1000);
}
