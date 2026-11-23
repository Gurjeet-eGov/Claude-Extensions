// Recorder window: you pick a window or the entire screen here (a real click, so
// Chrome reliably shows its picker). Encodes H.264 with WebCodecs into a rolling
// in-memory buffer and muxes clips to MP4 on demand (no re-encoding, cut at a
// keyframe). Also grabs full-resolution snapshots. Closing the window ends recording.

import { Muxer, ArrayBufferTarget } from '../lib/mp4-muxer.js';
import { put, newId } from '../lib/idb.js';
import { getSettings } from '../lib/settings.js';
import { elapsedUs } from '../lib/rec-clock.js';

const CODECS = ['avc1.640034', 'avc1.4d0034', 'avc1.42e034', 'avc1.640033', 'avc1.640028', 'avc1.42e028', 'avc1.42001f'];

const S = {
  state: 'idle', // idle | recording | paused | stopped
  error: null,
  settings: null,
  stream: null,
  track: null,
  reader: null,
  encoder: null,
  canvas: null,
  ctx: null,
  W: 0,
  H: 0,
  codec: null,
  decoderConfig: null,
  chunks: [], // { ts (µs), dur, key, data, wall }
  bytes: 0,
  startPerf: 0,
  pausedTotal: 0,
  pauseStart: 0,
  stopPerf: 0, // when Stop was pressed: the clock stays there
  lastEncodedTs: -Infinity,
  lastKeyTs: -Infinity,
  forceKey: true,
  latestFrame: null,
  wallByTs: new Map(),
  startedWall: 0,
};

function notify() {
  chrome.runtime.sendMessage({ type: 'rec-state', ...publicStatus() }).catch(() => {});
  render();
}

function publicStatus() {
  const last = S.chunks[S.chunks.length - 1];
  const first = S.chunks[0];
  return {
    state: S.state,
    error: S.error,
    bytes: S.bytes,
    bufferedMs: last && first ? Math.round((last.ts - first.ts) / 1000) : 0,
    elapsedMs: S.startPerf ? Math.round(currentTs() / 1000) : 0,
    width: S.W,
    height: S.H,
    codec: S.codec,
    startedWall: S.startedWall,
    surface: S.surface || null,
    windowOpen: true,
  };
}

function currentTs() {
  return elapsedUs(S, performance.now());
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

async function setupEncoder(frame) {
  const s = S.settings;
  const w0 = frame.displayWidth;
  const h0 = frame.displayHeight;
  const scale = Math.min(1, s.maxWidth / w0);
  S.W = even(w0 * scale);
  S.H = even(h0 * scale);
  S.canvas = new OffscreenCanvas(S.W, S.H);
  S.ctx = S.canvas.getContext('2d', { alpha: false });
  const base = {
    width: S.W,
    height: S.H,
    bitrate: s.bitrateKbps * 1000,
    bitrateMode: 'variable',
    framerate: s.fps,
    avc: { format: 'avc' },
  };
  for (const codec of CODECS) {
    try {
      const sup = await VideoEncoder.isConfigSupported({ ...base, codec });
      if (sup.supported) {
        S.codec = codec;
        break;
      }
    } catch {}
  }
  if (!S.codec) throw new Error(`No H.264 encoder available for ${S.W}×${S.H}.`);
  S.encoder = new VideoEncoder({
    output: onChunk,
    error: (e) => {
      S.error = `Encoder error: ${e?.message || e}`;
      notify();
    },
  });
  S.encoder.configure({ ...base, codec: S.codec });
}

function onChunk(chunk, meta) {
  if (meta?.decoderConfig) {
    const dc = meta.decoderConfig;
    const d = dc.description;
    S.decoderConfig = {
      codec: dc.codec,
      codedWidth: dc.codedWidth,
      codedHeight: dc.codedHeight,
      description: d ? (d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))) : undefined,
    };
  }
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const wall = S.wallByTs.get(chunk.timestamp) ?? Date.now();
  S.wallByTs.delete(chunk.timestamp);
  S.chunks.push({ ts: chunk.timestamp, dur: chunk.duration || Math.round(1e6 / S.settings.fps), key: chunk.type === 'key', data, wall });
  S.bytes += data.byteLength;
  prune();
}

function prune() {
  const keepUs = S.settings.bufferMinutes * 60e6;
  const last = S.chunks[S.chunks.length - 1];
  if (!last) return;
  const cutoff = last.ts - keepUs;
  let i = 0;
  while (i < S.chunks.length && S.chunks[i].ts < cutoff) i++;
  if (i === 0) return;
  while (i < S.chunks.length && !S.chunks[i].key) i++; // keep the buffer starting on a keyframe
  for (let j = 0; j < i; j++) S.bytes -= S.chunks[j].data.byteLength;
  S.chunks.splice(0, i);
}

function drawFit(frame) {
  const ctx = S.ctx;
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  const scale = Math.min(S.W / fw, S.H / fh);
  const w = fw * scale;
  const h = fh * scale;
  if (Math.abs(w - S.W) > 1 || Math.abs(h - S.H) > 1) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S.W, S.H);
  }
  ctx.drawImage(frame, (S.W - w) / 2, (S.H - h) / 2, w, h);
}

async function maybeEncode(frame) {
  const s = S.settings;
  const t = currentTs();
  const frameUs = 1e6 / s.fps;
  if (t - S.lastEncodedTs < frameUs - 4000) return;
  if (!S.encoder) await setupEncoder(frame);
  if (S.encoder.state !== 'configured' || S.encoder.encodeQueueSize > 6) return; // drop a frame rather than lag
  drawFit(frame);
  const ts = Math.round(t);
  const vf = new VideoFrame(S.canvas, { timestamp: ts, duration: Math.round(frameUs) });
  const key = S.forceKey || t - S.lastKeyTs >= s.keyIntervalSec * 1e6;
  S.wallByTs.set(ts, Date.now());
  S.encoder.encode(vf, { keyFrame: key });
  vf.close();
  if (key) {
    S.lastKeyTs = t;
    S.forceKey = false;
  }
  S.lastEncodedTs = t;
}

async function pump() {
  const reader = S.reader;
  while (reader === S.reader) {
    let res;
    try {
      res = await reader.read();
    } catch {
      break;
    }
    if (res.done) break;
    const frame = res.value;
    try {
      if (S.latestFrame) S.latestFrame.close();
      S.latestFrame = frame.clone();
      if (S.state === 'recording') await maybeEncode(frame);
    } catch (e) {
      S.error = String(e?.message || e);
      notify();
    } finally {
      frame.close();
    }
  }
}

// Synthetic moving pattern, used only by the self-test ("rec-start-test") to check
// encoding and MP4 output without a screen-recording permission.
function testPatternStream(fps) {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const ctx = c.getContext('2d');
  let n = 0;
  const draw = () => {
    n++;
    ctx.fillStyle = `hsl(${(n * 4) % 360} 60% 40%)`;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText(`Bug Reporter self-test · frame ${n}`, 60, 120);
    ctx.fillRect(60 + ((n * 12) % 1100), 300, 120, 120);
  };
  draw();
  const timer = setInterval(draw, 1000 / fps);
  const stream = c.captureStream(fps);
  stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
  return stream;
}

/** source: 'window' | 'monitor' | '__test_pattern__' */
async function getStream(source, fps) {
  if (source === '__test_pattern__') return testPatternStream(fps);
  return navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: source === 'monitor' ? 'monitor' : 'window', frameRate: { ideal: fps, max: fps } },
    audio: false,
    selfBrowserSurface: 'exclude', // this recorder window itself isn't offered
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
}

async function start({ source, settings }) {
  if (S.state === 'recording' || S.state === 'paused') return publicStatus();
  await teardown();
  Object.assign(S, {
    settings,
    error: null,
    chunks: [],
    bytes: 0,
    decoderConfig: null,
    codec: null,
    encoder: null,
    W: 0,
    H: 0,
    pausedTotal: 0,
    stopPerf: 0,
    lastEncodedTs: -Infinity,
    lastKeyTs: -Infinity,
    forceKey: true,
    wallByTs: new Map(),
  });
  let stream;
  try {
    stream = await getStream(source, settings.fps);
  } catch (e) {
    S.state = 'idle';
    S.error = e?.name === 'NotAllowedError' ? 'Recording was cancelled, or Chrome is not allowed to record the screen (System Settings → Privacy & Security → Screen Recording).' : String(e?.message || e);
    notify();
    throw new Error(S.error);
  }
  S.stream = stream;
  S.track = stream.getVideoTracks()[0];
  S.surface = S.track.getSettings?.().displaySurface || source;
  S.track.addEventListener('ended', () => {
    // User clicked Chrome's "Stop sharing".
    if (S.state === 'recording' || S.state === 'paused') stop().then(notify);
  });
  const processor = new MediaStreamTrackProcessor({ track: S.track });
  S.reader = processor.readable.getReader();
  S.startPerf = performance.now();
  S.startedWall = Date.now();
  S.state = 'recording';
  pump();
  notify();
  return publicStatus();
}

function pause() {
  if (S.state !== 'recording') return publicStatus();
  S.state = 'paused';
  S.pauseStart = performance.now();
  notify();
  return publicStatus();
}

function resume() {
  if (S.state !== 'paused') return publicStatus();
  S.pausedTotal += performance.now() - S.pauseStart;
  S.state = 'recording';
  S.forceKey = true;
  notify();
  return publicStatus();
}

async function teardown() {
  const reader = S.reader;
  S.reader = null;
  try {
    await reader?.cancel();
  } catch {}
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  S.track = null;
  try {
    if (S.encoder && S.encoder.state === 'configured') await S.encoder.flush();
  } catch {}
  try {
    S.encoder?.close();
  } catch {}
  S.encoder = null;
  S.latestFrame?.close();
  S.latestFrame = null;
}

async function stop() {
  if (S.state === 'idle' || S.state === 'stopped') return publicStatus();
  S.stopPerf = performance.now();
  if (S.state === 'paused') S.pausedTotal += S.stopPerf - S.pauseStart;
  S.state = 'stopped';
  await teardown();
  notify();
  return publicStatus();
}

async function snapshot() {
  const f = S.latestFrame;
  if (!f) throw new Error('No frame captured yet.');
  const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
  c.getContext('2d').drawImage(f, 0, 0);
  let blob = await c.convertToBlob({ type: 'image/png' });
  let mime = 'image/png';
  if (blob.size > 9 * 1024 * 1024) {
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    mime = 'image/jpeg';
  }
  const id = newId('m');
  await put('media', { id, kind: 'image', mime, blob, size: blob.size, createdAt: Date.now(), width: f.displayWidth, height: f.displayHeight, source: 'recording' });
  return { mediaId: id, size: blob.size };
}

function markHalt() {
  const last = S.chunks[S.chunks.length - 1];
  return { videoTs: last ? last.ts : 0, wall: Date.now() };
}

/** Keyframe positions up to endTs with the bytes from each keyframe to endTs. */
function clipIndex({ endTs }) {
  const end = endTs ?? Infinity;
  const keys = [];
  let acc = 0;
  for (const c of S.chunks) {
    if (c.ts > end) break;
    if (c.key) keys.push({ ts: c.ts, wall: c.wall, before: acc });
    acc += c.data.byteLength;
  }
  const lastTs = S.chunks.filter((c) => c.ts <= end).pop()?.ts ?? 0;
  return { keys: keys.map((k) => ({ ts: k.ts, wall: k.wall, bytes: acc - k.before })), endTs: lastTs, total: acc };
}

async function makeClip({ startTs, endTs }) {
  if (!S.chunks.length || !S.decoderConfig) throw new Error('Nothing recorded yet.');
  const end = endTs ?? Infinity;
  // Start on the last keyframe at or before startTs (or the first keyframe).
  let i = -1;
  for (let k = 0; k < S.chunks.length; k++) {
    if (S.chunks[k].ts > (startTs ?? -Infinity)) break;
    if (S.chunks[k].key) i = k;
  }
  if (i < 0) i = S.chunks.findIndex((c) => c.key);
  if (i < 0) throw new Error('No keyframe in the buffer yet.');
  const picked = [];
  for (let k = i; k < S.chunks.length && S.chunks[k].ts <= end; k++) picked.push(S.chunks[k]);
  if (!picked.length) throw new Error('Clip range is empty.');
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: S.W, height: S.H, frameRate: S.settings.fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  const meta = { decoderConfig: { ...S.decoderConfig } };
  picked.forEach((c, idx) => {
    const next = picked[idx + 1];
    const dur = next ? Math.max(1, next.ts - c.ts) : c.dur;
    muxer.addVideoChunkRaw(c.data, c.key ? 'key' : 'delta', c.ts, dur, idx === 0 ? meta : undefined);
  });
  muxer.finalize();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  const id = newId('m');
  const durationMs = Math.round((picked[picked.length - 1].ts - picked[0].ts + picked[picked.length - 1].dur) / 1000);
  await put('media', { id, kind: 'video', mime: 'video/mp4', blob, size: blob.size, createdAt: Date.now(), durationMs, width: S.W, height: S.H, startWall: picked[0].wall });
  return { mediaId: id, size: blob.size, durationMs, startWall: picked[0].wall, startTs: picked[0].ts };
}

async function handle(msg) {
  switch (msg.type) {
    case 'status':
      return publicStatus();
    case 'start':
      // Only the self-test can start from a message; real recordings start from a click here.
      if (msg.source !== '__test_pattern__') throw new Error('Start recording from the Recorder window.');
      return start(msg);
    case 'pause':
      return pause();
    case 'resume':
      return resume();
    case 'stop':
      return stop();
    case 'snapshot':
      return snapshot();
    case 'mark-halt':
      return markHalt();
    case 'clip-index':
      return clipIndex(msg);
    case 'make-clip':
      return makeClip(msg);
    case 'discard':
      await teardown();
      Object.assign(S, { state: 'idle', chunks: [], bytes: 0, decoderConfig: null });
      notify();
      return publicStatus();
    default:
      throw new Error(`Unknown recorder command: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'recorder') return false;
  handle(msg).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => {
      S.error = String(e?.message || e);
      sendResponse({ ok: false, error: S.error, ...publicStatus() });
    },
  );
  return true;
});

// ---------- window UI ----------
const $ = (id) => document.getElementById(id);
let recSettings = null;
getSettings().then((s) => (recSettings = s.recording));

const fmtDur = (ms) => {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const fmtMB = (n) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function render() {
  if (!$('idle')) return;
  const st = S.state;
  const live = st === 'recording' || st === 'paused';
  $('idle').classList.toggle('hidden', live);
  $('active').classList.toggle('hidden', !live);
  $('stopped').classList.toggle('hidden', st !== 'stopped');
  $('dot').className = 'dot ' + (st === 'recording' ? 'rec' : st === 'paused' ? 'paused' : '');
  $('state').textContent = { recording: 'Recording', paused: 'Paused', stopped: 'Stopped', idle: 'Not recording' }[st];
  $('surface').textContent = live ? (S.surface === 'monitor' ? 'Entire screen' : S.surface === 'browser' ? 'A tab' : 'A window') : '';
  $('timer').textContent = live || st === 'stopped' ? `${fmtDur(publicStatus().elapsedMs)} · ${fmtMB(S.bytes)} buffered` : '';
  $('pause').classList.toggle('hidden', st !== 'recording');
  $('resume').classList.toggle('hidden', st !== 'paused');
  $('err').textContent = S.error || '';
  $('err').classList.toggle('hidden', !S.error);
  document.title = st === 'recording' ? '● REC · Bug Reporter' : st === 'paused' ? '❚❚ Paused · Bug Reporter' : 'Bug Reporter Recorder';
}

async function startFromClick(source) {
  S.error = null;
  try {
    await start({ source, settings: recSettings || (await getSettings()).recording });
    // Keep this window out of the way (and out of an entire-screen recording).
    setTimeout(async () => {
      try {
        const w = await chrome.windows.getCurrent();
        await chrome.windows.update(w.id, { state: 'minimized' });
      } catch {}
    }, 800);
  } catch {
    render();
  }
}

if ($('idle')) {
  $('recWindow').addEventListener('click', () => startFromClick('window'));
  $('recScreen').addEventListener('click', () => startFromClick('monitor'));
  $('pause').addEventListener('click', pause);
  $('resume').addEventListener('click', resume);
  $('stop').addEventListener('click', () => stop());
  window.addEventListener('beforeunload', (e) => {
    if (S.state === 'recording' || S.state === 'paused') {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  render();
  setInterval(render, 1000);
}
