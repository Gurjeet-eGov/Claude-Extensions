// Records the screen (or a window or tab) as evidence for one test case, within the host's
// limits: the chosen quality, 30 fps, and a file under the size cap (it stops just before).
// Once recording starts, this window minimises itself (as Bug Reporter's does); the popup
// shows the recording and has Pause / Resume and Stop. Then it attaches the file to the
// case in Test Run, and saves the result that was waiting for it, if any. Audio is
// whatever is picked in Chrome's share window.
//
// The popup follows the recording through chrome.storage.session ('rec') and sends its
// buttons here as messages ({ target: 'recorder', type: 'pause' | 'resume' | 'stop' | 'discard' | 'status' }).
import { request, Offline } from '../lib/testrun.js';
import { fmtBytes, fmtTime, fmtClip, stopAtBytes, pickMime, elapsedMs } from '../lib/media.js';

const q = Object.fromEntries(new URLSearchParams(location.search));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { state: 'loading', conn: null, limits: null, error: '', msg: '', bytes: 0, t0: 0, pausedMs: 0, pausedAt: 0, autoStopped: false };
let stream = null;
let rec = null;
let chunks = [];
let mime = '';
let discard = false;
let timer = null;

const label = `${q.id || 'Case'} · ${q.scenario || ''}`;

/** What the popup shows. */
function share() {
  const live = ['recording', 'paused', 'saving', 'done', 'error'].includes(S.state);
  const v = { state: S.state, book: q.book, tab: q.tab, cycle: q.cycle, key: q.key, id: q.id, forStatus: q.forStatus || '', t0: S.t0, pausedMs: S.pausedMs, pausedAt: S.pausedAt, bytes: S.bytes, maxBytes: S.limits ? S.limits.maxBytes : 0, msg: S.state === 'error' ? S.error : S.msg, at: Date.now() };
  return (live ? chrome.storage.session.set({ rec: v }) : chrome.storage.session.remove('rec')).catch(() => {});
}

async function myWindow(update) {
  try {
    const w = await chrome.windows.getCurrent();
    if (w.type === 'popup') await chrome.windows.update(w.id, update); // only the window the extension opened
  } catch { /* gone */ }
}

function render() {
  const L = S.limits;
  const el = elapsedMs(S, Date.now());
  let h = `<div class="hd"><span class="mk" aria-hidden="true"></span><span class="title">Test Run Extension</span><span class="grow"></span><span class="muted">Recording evidence</span></div>
    <div><div class="lb">${esc(q.tab)} · cycle ${esc(q.cycle || 'Status')}</div><div class="scenario">${esc(label)}</div></div>`;
  if (q.forStatus) h += `<div class="muted">${esc(q.forStatus)} is saved when this recording is attached.</div>`;
  if (S.state === 'loading') h += '<div class="loading">Connecting to Test Run…</div>';
  else if (S.state === 'error') h += `<div class="flash bad">${esc(S.error)}</div><button data-action="close">Close</button>`;
  else if (S.state === 'ready') {
    h += `<div class="box muted">${esc(L.quality)} · ${L.fps} fps · up to ${fmtBytes(L.maxBytes)} (${esc(fmtClip(L.maxSeconds))}). Recording stops by itself just before the limit.</div>
      ${S.msg ? `<div class="muted">${esc(S.msg)}</div>` : ''}
      <button class="primary" data-action="start">Choose what to record</button>
      <div class="faint">Chrome asks which screen, window or tab, and whether to share audio. This window then gets out of the way: pause and stop from the Test Run Extension button.</div>`;
  } else if (S.state === 'recording' || S.state === 'paused') {
    const pct = Math.min(100, (S.bytes / L.maxBytes) * 100);
    h += `<div class="row"><span class="dot${S.state === 'paused' ? ' paused' : ''}" aria-hidden="true"></span><span class="big" id="clock">${fmtTime(el / 1000)}</span><span class="muted">${S.state === 'paused' ? 'Paused' : ''}</span><span class="grow"></span><span class="muted" id="size">~${fmtBytes(S.bytes)} of ${fmtBytes(L.maxBytes)}</span></div>
      <div class="bar" aria-hidden="true"><i id="fill" style="width:${pct}%"></i></div>
      <div class="rec-btns"><button data-action="${S.state === 'paused' ? 'resume' : 'pause'}">${S.state === 'paused' ? '▶ Resume' : '❚❚ Pause'}</button><button class="primary" data-action="stop">■ Stop</button></div>
      <button class="link" data-action="discard">Discard this recording</button>`;
  } else if (S.state === 'saving') h += `<div class="loading">${esc(S.msg || 'Attaching…')}</div>`;
  else if (S.state === 'done') h += `<div class="flash">${esc(S.msg)}</div><div class="cap-btns"><button class="primary" data-action="close">Close</button><button data-action="again">Record again</button></div>`;
  document.getElementById('app').innerHTML = h;
}

async function badge(text, color = '#c62f2a') {
  try { await chrome.action.setBadgeText({ text }); await chrome.action.setBadgeBackgroundColor({ color }); } catch { /* no badge */ }
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
  Object.assign(S, { bytes: 0, autoStopped: false, pausedMs: 0, pausedAt: 0 });
  const stopAt = stopAtBytes(L.maxBytes, L.bitrate);
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chunks.push(e.data);
    S.bytes += e.data.size;
    if (S.bytes >= stopAt && rec.state !== 'inactive') { S.autoStopped = true; rec.stop(); }
  };
  rec.onstop = finish;
  video.onended = () => { if (rec && rec.state !== 'inactive') rec.stop(); }; // Chrome's own "Stop sharing"
  rec.start(1000);
  S.t0 = Date.now();
  S.state = 'recording';
  S.msg = '';
  render();
  share();
  badge('REC');
  timer = setInterval(() => {
    const clock = document.getElementById('clock');
    if (clock) clock.textContent = fmtTime(elapsedMs(S, Date.now()) / 1000);
    const size = document.getElementById('size');
    if (size) size.textContent = `~${fmtBytes(S.bytes)} of ${fmtBytes(L.maxBytes)}`;
    const fill = document.getElementById('fill');
    if (fill) fill.style.width = `${Math.min(100, (S.bytes / L.maxBytes) * 100)}%`;
    share();
  }, 1000);
  // Out of the way (and out of an entire-screen recording), as Bug Reporter does
  setTimeout(() => myWindow({ state: 'minimized' }), 800);
}

function pause() {
  if (!rec || rec.state !== 'recording') return;
  rec.pause();
  S.pausedAt = Date.now();
  S.state = 'paused';
  render();
  share();
  badge('❚❚', '#946200');
}

function resume() {
  if (!rec || rec.state !== 'paused') return;
  rec.resume();
  S.pausedMs += Date.now() - S.pausedAt;
  S.pausedAt = 0;
  S.state = 'recording';
  render();
  share();
  badge('REC');
}

function stop(withDiscard) {
  if (!rec || rec.state === 'inactive') return;
  if (withDiscard) discard = true;
  if (rec.state === 'paused') { S.pausedMs += Date.now() - S.pausedAt; S.pausedAt = 0; }
  rec.stop();
}

async function finish() {
  clearInterval(timer);
  badge('');
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (discard) { S.state = 'ready'; S.msg = 'Discarded.'; render(); share(); return; }
  const blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  chunks = [];
  if (blob.size > S.limits.maxBytes) { fail(`The recording came to ${fmtBytes(blob.size)}, over the ${fmtBytes(S.limits.maxBytes)} limit. Record a shorter one.`); return; }
  S.state = 'saving';
  S.msg = `Attaching the recording (${fmtBytes(blob.size)}) to ${q.id || 'the case'}…`;
  render();
  share();
  try {
    const path = `/api/evidence?book=${encodeURIComponent(q.book)}&tab=${encodeURIComponent(q.tab)}&cycle=${encodeURIComponent(q.cycle)}&key=${encodeURIComponent(q.key)}&forStatus=${encodeURIComponent(q.forStatus || '')}`;
    const r = await request(S.conn, 'POST', path, { body: blob, raw: true });
    if (!r.ok) throw new Error(r.error);
    let done = `Recording attached to ${q.id || 'the case'} (${fmtBytes(r.added.size)}).${S.autoStopped ? ' It stopped at the size limit.' : ''}`;
    if (q.forStatus) done = await markWaiting(r.added);
    S.state = 'done';
    S.msg = done;
    render();
    await share();
    if (q.test !== 'pattern') setTimeout(() => window.close(), 1500); // the popup says it too
  } catch (e) {
    fail(`The recording could not be attached: ${e.message || e}`);
  }
}

function fail(msg) {
  S.state = 'error';
  S.error = msg;
  render();
  share();
  myWindow({ state: 'normal', focused: true }); // back in view, to say so
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
  pause,
  resume,
  stop: () => stop(false),
  discard: () => stop(true),
  close: () => window.close(),
  again: () => { q.forStatus = ''; S.state = 'ready'; S.msg = ''; render(); share(); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.getAttribute('data-action')];
  if (fn) fn();
});
// The popup's buttons
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'recorder') return false;
  if (msg.type === 'pause') pause();
  else if (msg.type === 'resume') resume();
  else if (msg.type === 'stop') stop(false);
  else if (msg.type === 'discard') stop(true);
  reply({ ok: true, state: S.state });
  return false;
});
window.addEventListener('pagehide', () => {
  if (rec && rec.state !== 'inactive') { discard = true; rec.stop(); }
  chrome.storage.session.remove('rec');
  badge('');
});

init();
