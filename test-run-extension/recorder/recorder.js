// Records the screen (or a window or tab) as evidence for one test case, within the host's
// limits: the chosen quality, 30 fps, and a file under the size cap (it stops just before).
// Then it attaches the file to the case in Test Run, and saves the result that was waiting
// for it, if any. Audio is whatever is picked in Chrome's share window.
import { request, Offline } from '../lib/testrun.js';
import { fmtBytes, fmtTime, fmtClip, stopAtBytes, pickMime } from '../lib/media.js';

const q = Object.fromEntries(new URLSearchParams(location.search));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { state: 'loading', conn: null, limits: null, error: '', msg: '', bytes: 0, t0: 0, autoStopped: false };
let stream = null;
let rec = null;
let chunks = [];
let mime = '';
let discard = false;
let timer = null;

const label = `${q.id || 'Case'} · ${q.scenario || ''}`;

function render() {
  const L = S.limits;
  let h = `<div class="hd"><span class="mk" aria-hidden="true"></span><span class="title">Test Run Extension</span><span class="grow"></span><span class="muted">Recording evidence</span></div>
    <div><div class="lb">${esc(q.tab)} · cycle ${esc(q.cycle || 'Status')}</div><div class="scenario">${esc(label)}</div></div>`;
  if (q.forStatus) h += `<div class="warn">${esc(q.forStatus)} is saved when this recording is attached.</div>`;
  if (S.state === 'loading') h += '<div class="loading">Connecting to Test Run…</div>';
  else if (S.state === 'error') h += `<div class="flash bad">${esc(S.error)}</div><button data-action="close">Close</button>`;
  else if (S.state === 'ready') {
    h += `<div class="box muted">${esc(L.quality)} · ${L.fps} fps · up to ${fmtBytes(L.maxBytes)} (${esc(fmtClip(L.maxSeconds))}). Recording stops by itself just before the limit.</div>
      ${S.msg ? `<div class="muted">${esc(S.msg)}</div>` : ''}
      <button class="primary" data-action="start">Choose what to record</button>
      <div class="faint">Chrome asks which screen, window or tab. Sound is recorded only if you turn on audio there.</div>`;
  } else if (S.state === 'recording') {
    const pct = Math.min(100, (S.bytes / L.maxBytes) * 100);
    h += `<div class="row"><span class="dot" aria-hidden="true"></span><span class="big" id="clock">${fmtTime((Date.now() - S.t0) / 1000)}</span><span class="grow"></span><span class="muted" id="size">~${fmtBytes(S.bytes)} of ${fmtBytes(L.maxBytes)}</span></div>
      <div class="bar" aria-hidden="true"><i id="fill" style="width:${pct}%"></i></div>
      <div class="cap-btns"><button class="primary" data-action="stop">Stop and attach</button><button data-action="discard">Discard</button></div>`;
  } else if (S.state === 'saving') h += `<div class="loading">${esc(S.msg || 'Attaching…')}</div>`;
  else if (S.state === 'done') h += `<div class="flash">${esc(S.msg)}</div><div class="cap-btns"><button class="primary" data-action="close">Close</button><button data-action="again">Record again</button></div>`;
  document.getElementById('app').innerHTML = h;
}

async function badge(text) {
  try { await chrome.action.setBadgeText({ text }); await chrome.action.setBadgeBackgroundColor({ color: '#c62f2a' }); } catch { /* no badge */ }
}

async function init() {
  const { conn } = await chrome.storage.local.get('conn');
  if (!conn) { S.state = 'error'; S.error = 'Sign in from the Test Run Extension button first.'; render(); return; }
  S.conn = conn;
  try {
    const lim = await request(conn, 'GET', '/api/media');
    if (!lim.ok) throw new Error(lim.error);
    S.limits = lim;
    S.state = 'ready';
  } catch (e) {
    S.state = 'error';
    S.error = e instanceof Offline ? e.message : `Could not read the media limits: ${e.message}`;
  }
  render();
}

/** For the automated tests only (?test=pattern): a moving pattern instead of the screen, as no screen is there. */
function patternStream(L) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(640, L.width);
  canvas.height = Math.min(360, L.height);
  const g = canvas.getContext('2d');
  let n = 0;
  setInterval(() => { n++; g.fillStyle = `hsl(${(n * 7) % 360} 60% 50%)`; g.fillRect(0, 0, canvas.width, canvas.height); g.fillStyle = '#fff'; g.font = '32px sans-serif'; g.fillText(`frame ${n}`, 20, 60); }, 1000 / L.fps);
  return canvas.captureStream(L.fps);
}

async function start() {
  const L = S.limits;
  try {
    stream = q.test === 'pattern' ? patternStream(L) : await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: L.width }, height: { max: L.height }, frameRate: { ideal: L.fps, max: L.fps } },
      audio: true,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
    });
  } catch (e) {
    S.msg = e && e.name === 'NotAllowedError' ? 'Nothing was chosen. Try again when you are ready.' : `Recording could not start: ${e.message || e}`;
    render();
    return;
  }
  const video = stream.getVideoTracks()[0];
  try { await video.applyConstraints({ width: { max: L.width }, height: { max: L.height }, frameRate: { max: L.fps } }); } catch { /* keeps the picker's size */ }
  mime = pickMime((t) => MediaRecorder.isTypeSupported(t), stream.getAudioTracks().length > 0);
  rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: L.bitrate, audioBitsPerSecond: 64000 });
  chunks = [];
  discard = false;
  S.bytes = 0;
  S.autoStopped = false;
  const stopAt = stopAtBytes(L.maxBytes, L.bitrate);
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chunks.push(e.data);
    S.bytes += e.data.size;
    if (S.bytes >= stopAt && rec.state === 'recording') { S.autoStopped = true; rec.stop(); }
  };
  rec.onstop = finish;
  video.onended = () => { if (rec && rec.state !== 'inactive') rec.stop(); }; // Chrome's own "Stop sharing"
  rec.start(1000);
  S.t0 = Date.now();
  S.state = 'recording';
  S.msg = '';
  render();
  badge('REC');
  timer = setInterval(() => {
    const clock = document.getElementById('clock');
    if (clock) clock.textContent = fmtTime((Date.now() - S.t0) / 1000);
    const size = document.getElementById('size');
    if (size) size.textContent = `~${fmtBytes(S.bytes)} of ${fmtBytes(L.maxBytes)}`;
    const fill = document.getElementById('fill');
    if (fill) fill.style.width = `${Math.min(100, (S.bytes / L.maxBytes) * 100)}%`;
  }, 500);
}

async function finish() {
  clearInterval(timer);
  badge('');
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (discard) { S.state = 'ready'; S.msg = 'Discarded.'; render(); return; }
  const blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  chunks = [];
  if (blob.size > S.limits.maxBytes) { S.state = 'error'; S.error = `The recording came to ${fmtBytes(blob.size)}, over the ${fmtBytes(S.limits.maxBytes)} limit. Record a shorter one.`; render(); return; }
  S.state = 'saving';
  S.msg = `Attaching ${fmtBytes(blob.size)}…`;
  render();
  try {
    const path = `/api/evidence?book=${encodeURIComponent(q.book)}&tab=${encodeURIComponent(q.tab)}&cycle=${encodeURIComponent(q.cycle)}&key=${encodeURIComponent(q.key)}&forStatus=${encodeURIComponent(q.forStatus || '')}`;
    const r = await request(S.conn, 'POST', path, { body: blob, raw: true });
    if (!r.ok) throw new Error(r.error);
    let done = `Attached to ${q.id || 'the case'}: ${r.evidence.name} (${fmtBytes(r.evidence.size)}).${S.autoStopped ? ' It stopped at the size limit.' : ''}`;
    if (q.forStatus) done = await markWaiting(r.evidence);
    S.state = 'done';
    S.msg = done;
  } catch (e) {
    S.state = 'error';
    S.error = `The recording could not be attached: ${e.message || e}`;
  }
  render();
}

/** The result that was waiting for this recording. */
async function markWaiting(ev) {
  const s = await request(S.conn, 'GET', `/api/ext/suite?book=${encodeURIComponent(q.book)}&tab=${encodeURIComponent(q.tab)}&cycle=${encodeURIComponent(q.cycle)}`);
  const c = s.ok && s.cases.find((x) => x.key === q.key);
  if (!c) return `Attached ${ev.name}, but ${q.id || 'the case'} could not be found to mark it ${q.forStatus}. Mark it in Test Run.`;
  const r = await request(S.conn, 'POST', '/api/call/api_mark', { body: { book: q.book, args: [{ tab: q.tab, key: c.key, sh: c.sh, row: c.row, cycle: q.cycle, expect: c.status, status: q.forStatus }] } });
  if (!r.ok) return `Attached ${ev.name}, but ${q.forStatus} was not saved: ${r.error || (r.code === 'CONFLICT' ? `someone just marked it ${r.current || 'not run'}` : 'try again from the extension')}.`;
  return `Saved ${q.id || 'the case'} as ${q.forStatus}, with ${ev.name} as evidence.`;
}

const ACTIONS = {
  start,
  stop: () => { if (rec && rec.state !== 'inactive') rec.stop(); },
  discard: () => { discard = true; if (rec && rec.state !== 'inactive') rec.stop(); },
  close: () => window.close(),
  again: () => { q.forStatus = ''; S.state = 'ready'; S.msg = ''; render(); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.getAttribute('data-action')];
  if (fn) fn();
});
window.addEventListener('beforeunload', () => { if (rec && rec.state !== 'inactive') { discard = true; rec.stop(); } badge(''); });

init();
