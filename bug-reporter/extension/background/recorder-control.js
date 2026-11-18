// Service-worker side of recording. Recording runs in a small Recorder window
// (extension page): picking a window/screen needs a real click there, which is
// what makes Chrome's picker show reliably. This module opens/focuses that window,
// forwards commands to it and mirrors its state on the toolbar badge.

import { getSettings } from '../lib/settings.js';

const RECORDER_PATH = 'recorder/recorder.html';
const recorderUrl = () => chrome.runtime.getURL(RECORDER_PATH);

/** The open Recorder window's context ({tabId, windowId}) or null. */
export async function findRecorder() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [recorderUrl()] });
  return ctx[0] || null;
}

export async function openRecorder({ focus = true } = {}) {
  const existing = await findRecorder();
  if (existing) {
    if (focus) await chrome.windows.update(existing.windowId, { focused: true, state: 'normal' });
    return existing;
  }
  const w = await chrome.windows.create({ url: recorderUrl(), type: 'popup', width: 440, height: 380, focused: focus });
  await chrome.storage.session.set({ recorderWindowId: w.id });
  // Wait until the page answers, so callers can send it commands.
  for (let i = 0; i < 40; i++) {
    const r = await recorderCall('status');
    if (r.ok) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  return findRecorder();
}

export async function recorderCall(type, payload = {}) {
  if (!(await findRecorder())) return { ok: false, error: 'not-running', state: 'idle', windowOpen: false };
  try {
    const res = await chrome.runtime.sendMessage({ target: 'recorder', type, ...payload });
    return res || { ok: false, error: 'no-response', state: 'idle' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), state: 'idle' };
  }
}

export async function recStatus() {
  const r = await recorderCall('status');
  if (!r.ok) return { state: 'idle', windowOpen: r.windowOpen !== false && r.error !== 'not-running' };
  return r;
}

/** Opens (or focuses) the Recorder window; you choose window or entire screen there. */
export async function startRecording() {
  const status = await recStatus();
  if (status.state === 'recording' || status.state === 'paused') {
    return { ok: true, already: true, ...status };
  }
  await openRecorder({ focus: true });
  return { ok: true, opened: true, state: 'idle' };
}

/** Self-test: records a synthetic pattern instead of the screen (no picker, no permission). */
export async function startTestRecording() {
  const { recording } = await getSettings();
  await openRecorder({ focus: false });
  const res = await recorderCall('start', { source: '__test_pattern__', settings: recording });
  await updateBadge(res.ok ? 'recording' : 'idle');
  return res;
}

export async function pauseRecording() {
  const r = await recorderCall('pause');
  if (r.ok) await updateBadge('paused');
  return r;
}

export async function resumeRecording() {
  const r = await recorderCall('resume');
  if (r.ok) await updateBadge(r.state);
  return r;
}

export async function stopRecording() {
  const r = await recorderCall('stop');
  if (r.ok) await updateBadge('stopped');
  return r;
}

export async function toggleRecording() {
  const s = await recStatus();
  if (s.state === 'recording') return pauseRecording();
  if (s.state === 'paused') return resumeRecording();
  return startRecording();
}

export async function updateBadge(state) {
  const map = {
    recording: { text: 'REC', color: '#d93025' },
    paused: { text: '❚❚', color: '#e37400' },
  };
  let b = map[state] || { text: '', color: '#5f6368' };
  if (!b.text) {
    // Not recording: show that Track Localizations is on.
    const { locTracking } = await chrome.storage.local.get('locTracking');
    if (locTracking?.active) b = { text: 'LOC', color: '#7e22ce' };
  }
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.storage.session.set({ recState: state });
}

export async function flashBadge(text, ms = 900) {
  const { recState } = await chrome.storage.session.get('recState');
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  setTimeout(() => updateBadge(recState || 'idle'), ms);
}

// Closing the Recorder window ends the recording.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { recorderWindowId } = await chrome.storage.session.get('recorderWindowId');
  if (windowId === recorderWindowId) {
    await chrome.storage.session.remove('recorderWindowId');
    await updateBadge('idle');
  }
});
