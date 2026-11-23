import { originPattern } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
let state = null;
let tabId = null;

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} KB`; // a short or still clip is small: KB, not "0.0 MB"
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
    { recording: 'Recording', paused: 'Paused' }[st] ||
    (rec.windowOpen ? 'Recorder window is open: choose window or screen there' : 'Not recording');
  $('recInfo').textContent = st === 'recording' || st === 'paused' ? `${fmtDur(rec.elapsedMs || 0)} · ${fmtBytes(rec.bytes)}` : '';
  // Stopped: no status line; the clip waiting for a report shows as a small box under the button.
  $('recRow').classList.toggle('hidden', st === 'stopped');
  $('clip').classList.toggle('hidden', st !== 'stopped');
  $('clip').textContent = st === 'stopped' ? `MP4 · ${fmtDur(rec.elapsedMs || 0)} · ${fmtBytes(rec.bytes)}` : '';
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

// ---------- Keyboard shortcuts: the ? tooltip ----------
const KEY_LABELS = {
  'toggle-recording': 'Record / pause',
  'halt-report': 'Halt and report',
  snapshot: 'Screenshot',
  'stop-recording': 'Stop',
  'update-issue': 'Update issue',
};
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Rows for the tooltip: the keys Chrome has set (they can be changed in Settings); NA where none is. */
function keyRows(commands) {
  return Object.keys(KEY_LABELS).map((name) => {
    const c = (commands || []).find((x) => x.name === name);
    return { name, key: (c && c.shortcut) || '', label: KEY_LABELS[name] };
  });
}

chrome.commands.getAll().then((commands) => {
  $('keysList').innerHTML = keyRows(commands)
    .map((r) => (r.key ? `<kbd>${escHtml(r.key)}</kbd>` : '<kbd class="na" title="No key set">NA</kbd>') + `<span>${escHtml(r.label)}</span>`)
    .join('');
});
const helpWrap = document.querySelector('.help-wrap');
const pinHelp = (on) => {
  helpWrap.classList.toggle('open', on);
  $('help').setAttribute('aria-expanded', String(on));
};
$('help').addEventListener('click', () => pinHelp(!helpWrap.classList.contains('open')));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !helpWrap.matches('.open, :hover, :focus-within')) return;
  e.preventDefault(); // keep the popup open; just hide the list
  pinHelp(false);
  helpWrap.classList.add('shut'); // hidden until the pointer or focus leaves
});
helpWrap.addEventListener('mouseleave', () => helpWrap.classList.remove('shut'));
helpWrap.addEventListener('focusout', () => helpWrap.classList.remove('shut'));
document.addEventListener('click', (e) => {
  if (!helpWrap.contains(e.target)) pinHelp(false);
});

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

// ---------- Track Localizations ----------
let loc = { active: false };

async function refreshLoc() {
  loc = (await send('loc-status')) || { active: false };
  const btn = $('loc');
  btn.classList.toggle('on', Boolean(loc.active));
  btn.textContent = loc.active ? '■ Stop & save list' : 'Track localizations';
  btn.disabled = !loc.active && !(state && state.pattern);
  btn.title = btn.disabled ? 'Open your web app tab first' : '';
  const info = $('locInfo');
  const found = `${loc.count || 0} code${loc.count === 1 ? '' : 's'} on ${loc.pages || 0} page${loc.pages === 1 ? '' : 's'}`;
  if (loc.active) {
    info.innerHTML = `<span class="dot"></span>Tracking localizations · <b>${found}</b> · <button class="link small" id="locSaveNow">Save so far</button>`;
    $('locSaveNow').addEventListener('click', () => send('loc-save'));
  } else if (loc.stoppedAt) {
    info.innerHTML = `Last list: ${found}${loc.saved ? ' · saved' : ' · <b>not saved</b>'} · <button class="link small" id="locSaveAgain">Save${loc.saved ? ' again' : ''}</button>`;
    $('locSaveAgain').addEventListener('click', () => send('loc-save'));
  } else {
    info.innerHTML = '';
  }
  info.classList.toggle('hidden', !info.innerHTML);
}

$('loc').addEventListener('click', async () => {
  if (loc.active) {
    // Chrome's "Save as" dialog opens; the popup closes, the save carries on.
    await send('loc-stop', { save: true });
    return refreshLoc();
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pattern = originPattern(tab?.url);
  if (!pattern) return;
  // Tracking runs on sites you've enabled; enable this one first if needed (Chrome asks once).
  if (!state?.enabled) {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) return;
    await send('site-enable', { pattern, tabId: tab.id });
  }
  if (loc.stoppedAt && !loc.saved && loc.count && !confirm(`Start a new list? The last list (${loc.count} codes) hasn't been saved.`)) return;
  await send('loc-start', { tabUrl: tab.url });
  await refresh();
  await refreshLoc();
});

refresh();
refreshLoc();
setInterval(() => {
  refresh();
  refreshLoc();
}, 1000);
