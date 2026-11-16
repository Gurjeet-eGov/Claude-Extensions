import { originPattern } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
let state = null;
let tabId = null;

function fmtBytes(n) {
  if (!n) return '0 MB';
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  state = await send('popup-state', { tabId });
  const pattern = originPattern(tab?.url);
  const host = pattern ? new URL(tab.url).host : '';
  $('siteOn').classList.toggle('hidden', !(pattern && state.enabled));
  $('siteOff').classList.toggle('hidden', !(pattern && !state.enabled));
  $('siteNa').classList.toggle('hidden', Boolean(pattern));
  $('host1').textContent = host;
  $('host2').textContent = host;
  if (state.stats) {
    const s = state.stats;
    $('stats').textContent = `${s.calls} API calls captured · ${s.failed} failed · ${s.console} console errors`;
  }

  const rec = state.rec || { state: 'idle' };
  const st = rec.state;
  $('recDot').className = 'dot ' + (st === 'recording' ? 'rec' : st === 'paused' ? 'paused' : '');
  $('recLabel').textContent =
    { recording: 'Recording', paused: 'Paused', stopped: 'Stopped (clip still available for a report)' }[st] ||
    (rec.windowOpen ? 'Recorder window is open: choose window or screen there' : 'Not recording');
  $('recInfo').textContent = st === 'idle' ? '' : `${fmtDur(rec.elapsedMs || 0)} · ${fmtBytes(rec.bytes)} buffered`;
  $('recStart').classList.toggle('hidden', st === 'recording' || st === 'paused');
  $('recStart').textContent = st === 'stopped' ? '● New recording' : rec.windowOpen ? '● Show Recorder window' : '● Start recording';
  $('recPause').classList.toggle('hidden', st !== 'recording');
  $('recResume').classList.toggle('hidden', st !== 'paused');
  $('recStop').classList.toggle('hidden', !(st === 'recording' || st === 'paused'));
  $('recError').classList.toggle('hidden', !rec.error);
  $('recError').textContent = rec.error || '';
  $('tray').textContent = state.tray ? `(${state.tray})` : '';
}

$('enable').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pattern = originPattern(tab?.url);
  if (!pattern) return;
  // Must be called from the click: Chrome shows its permission prompt for this site only.
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) return;
  await send('site-enable', { pattern, tabId: tab.id });
  await refresh();
});

$('recStart').addEventListener('click', async () => {
  $('recLabel').textContent = 'Opening the Recorder window…';
  const r = await send('rec-start');
  if (r && !r.ok && r.error && r.error !== 'cancelled') {
    $('recError').textContent = r.error;
    $('recError').classList.remove('hidden');
  }
  refresh();
});
$('recPause').addEventListener('click', () => send('rec-pause').then(refresh));
$('recResume').addEventListener('click', () => send('rec-resume').then(refresh));
$('recStop').addEventListener('click', () => send('rec-stop').then(refresh));
$('snap').addEventListener('click', () => send('snapshot', { tabId }).then(refresh));
$('report').addEventListener('click', async () => {
  await send('halt', { tabId });
  window.close();
});
$('update').addEventListener('click', async () => {
  await send('halt', { tabId, mode: 'update' });
  window.close();
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'rec-state') refresh();
});

chrome.storage.local.get('lastDiagnose').then(({ lastDiagnose }) => {
  const d = lastDiagnose;
  const ok = d && d.gh?.loggedIn && d.gh?.hasProjectScope && d.claude?.loggedIn;
  $('helper').innerHTML = d
    ? `<span class="pill ${ok ? 'ok' : 'warn'}">${ok ? 'Helper ready' : 'Helper needs attention'}</span>`
    : '<span class="pill">Helper not checked</span>';
});

refresh();
setInterval(refresh, 1000);
