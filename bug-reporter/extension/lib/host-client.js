// Talks to the local helper over Chrome native messaging.
// Each session opens one helper process; requests on it run in order.

import { HOST_NAME } from './settings.js';

export class HostError extends Error {
  constructor(error) {
    super(error?.message || 'Helper error');
    this.code = error?.code || 'HOST_ERROR';
    this.fix = error?.fix || [];
    this.data = error?.data;
  }
}

const NOT_INSTALLED = /not found|Specified native messaging host not found|Access to the specified native messaging host is forbidden/i;

export class HostSession {
  constructor() {
    this.port = chrome.runtime.connectNative(HOST_NAME);
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    this.port.onMessage.addListener((msg) => {
      const p = this.pending.get(msg?.id);
      if (!p) return;
      if (msg.type === 'progress') return p.onProgress?.(msg.message, msg);
      this.pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.data);
      else p.reject(new HostError(msg.error));
    });
    this.port.onDisconnect.addListener(() => {
      this.closed = true;
      const lastError = chrome.runtime.lastError?.message || 'The helper stopped unexpectedly.';
      const err = NOT_INSTALLED.test(lastError)
        ? new HostError({
            code: 'HOST_NOT_INSTALLED',
            message: 'The local helper is not installed (or not registered for this extension ID).',
            fix: ['cd <bug-reporter folder>/host && ./install.sh'],
          })
        : new HostError({ code: 'HOST_DISCONNECTED', message: lastError });
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  request(cmd, params = {}, onProgress) {
    if (this.closed) return Promise.reject(new HostError({ code: 'HOST_DISCONNECTED', message: 'Helper connection closed.' }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        this.port.postMessage({ id, cmd, params });
      } catch (e) {
        this.pending.delete(id);
        reject(new HostError({ code: 'HOST_DISCONNECTED', message: String(e?.message || e) }));
      }
    });
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      try {
        this.port.disconnect();
      } catch {}
    }
  }
}

/** One-shot request on its own helper process. */
export async function callHost(cmd, params = {}, onProgress) {
  const s = new HostSession();
  try {
    return await s.request(cmd, params, onProgress);
  } finally {
    s.close();
  }
}

/** Sends a Blob to the helper in pieces (Chrome limits the size of one message). */
export async function stageBlob(session, reportId, name, blob, onProgress) {
  const CHUNK = 4 * 1024 * 1024;
  const total = blob.size;
  let offset = 0;
  let seq = 0;
  do {
    const part = blob.slice(offset, Math.min(total, offset + CHUNK));
    const b64 = await blobToBase64(part);
    offset += part.size;
    await session.request('stageFile', { reportId, name, seq: seq++, last: offset >= total, data: b64 });
    onProgress?.(offset, total);
  } while (offset < total);
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < buf.length; i += step) bin += String.fromCharCode.apply(null, buf.subarray(i, i + step));
  return btoa(bin);
}
