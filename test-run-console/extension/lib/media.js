// The media limits Test Run sets (Setup → Media) and what follows from them.

/** The size a w×h picture is scaled to so it fits within maxW×maxH (never made larger). */
export function fitWithin(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/** "412 KB", "6.3 MB", "20 MB" */
export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024) { const mb = n / (1024 * 1024); return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`; }
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "about 1 min", "about 1 min 50 s" */
export function fmtClip(sec) {
  let m = Math.floor(sec / 60);
  let r = Math.round((sec % 60) / 10) * 10;
  if (r === 60) { m++; r = 0; }
  return `about ${[m ? `${m} min` : '', r ? `${r} s` : ''].filter(Boolean).join(' ')}`;
}

/** "00:42" */
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** One line for the limits: "Video 1080p · 30 fps · up to about 1 min" */
export function limitsLine(l) {
  return `Video ${l.quality} · ${l.fps} fps · up to ${fmtClip(l.maxSeconds)}`;
}

/**
 * When a recording must stop so the file stays under the limit: a little room is kept
 * for what is still being encoded (about two seconds at the bitrate, plus audio).
 */
export function stopAtBytes(maxBytes, bitrate) {
  return Math.max(maxBytes / 2, maxBytes - Math.ceil((bitrate / 8) * 2) - 64 * 1024);
}

/** The recording format: MP4 where Chrome can make it (plays everywhere), else WebM. */
export function pickMime(isTypeSupported, withAudio) {
  const list = withAudio
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((t) => { try { return isTypeSupported(t); } catch { return false; } }) || '';
}

/** Comments: what a tester sees and edits leaves out the evidence line (Test Run keeps it). */
export function withoutEvidenceLine(comment) {
  return String(comment || '').split(/\r?\n/).filter((l) => !/^Evidence:\s/.test(l.trim())).join('\n').replace(/\s+$/, '');
}

/** How long a recording has run, without its pauses: { t0, pausedMs, pausedAt } -> ms. */
export function elapsedMs(r, now) {
  if (!r || !r.t0) return 0;
  return Math.max(0, now - r.t0 - (r.pausedMs || 0) - (r.pausedAt ? now - r.pausedAt : 0));
}
