// Test Run Extension's popup. Signed out, it only asks for the access link. Signed in, it
// shows what you have open in Test Run (workbook, suite, cycle, case), lets you take a
// screenshot or record the screen as evidence, and mark the result. A result that has
// evidence can only change with new evidence (or after the file is removed).
import { parseLink, request, consoleUrl, Offline } from '../lib/testrun.js';
import { fitWithin, fmtBytes, fmtTime, limitsLine, withoutEvidenceLine, elapsedMs } from '../lib/media.js';

const S = {
  screen: 'loading', // signin | loading | offline | viewonly | choose | testing
  conn: null,
  me: null,
  limits: null,
  current: null, // what Test Run has open for you
  suite: null,
  caseKey: '',
  draft: null, // comment being typed (null: not edited)
  pending: '', // a result waiting for new evidence
  confirmRemove: '', // 'photo' | 'video': asking before deleting it
  rec: null, // the recording in progress (from the Recorder window, through storage.session)
  busy: '',
  error: '',
  flash: null,
  linkText: '',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = () => document.getElementById('app');

async function saveConn() { await chrome.storage.local.set({ conn: S.conn }); }
function call(method, path, opts = {}) {
  return request(S.conn, method, path, { ...opts, onMove: async () => saveConn() });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function init() {
  const { rec } = await chrome.storage.session.get('rec');
  if (rec && ['recording', 'paused'].includes(rec.state)) {
    try { const a = await chrome.runtime.sendMessage({ target: 'recorder', type: 'status' }); S.rec = a && a.ok ? rec : null; } catch { S.rec = null; }
    if (!S.rec) await chrome.storage.session.remove('rec');
  } else if (rec) S.rec = rec;
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.rec) onRec(changes.rec.newValue); });
  setInterval(() => {
    const clock = document.getElementById('recClock');
    if (clock && S.rec) clock.textContent = fmtTime(elapsedMs(S.rec, Date.now()) / 1000);
  }, 500);
  const { conn } = await chrome.storage.local.get('conn');
  if (!conn) { S.screen = 'signin'; render(); return; }
  S.conn = conn;
  await connect();
  if (S.rec && S.rec.state === 'done') onRec(S.rec); // finished while the popup was closed
}

async function connect() {
  S.screen = 'loading';
  render();
  try {
    const st = await call('GET', '/api/status');
    if (!st.ok || st.app !== 'test-run') throw new Offline('That address is not a Test Run.');
    if (!st.me) {
      await signOut('Your access link no longer works. Ask your test lead for a new one.');
      return;
    }
    S.me = st.me;
    if (S.me.role === 'viewer') { S.screen = 'viewonly'; render(); return; }
    const lim = await call('GET', '/api/media');
    S.limits = lim.ok ? lim : null;
    await follow(true);
    // Every 2 s: what Test Run has open; every 6 s: the suite's results and evidence (others mark too).
    let tick = 0;
    setInterval(() => {
      if (S.screen !== 'choose' && S.screen !== 'testing') return;
      tick++;
      follow(false).then(() => (tick % 3 === 0 ? refreshSuite() : null)).catch(() => {});
    }, 2000);
  } catch (e) {
    S.screen = 'offline';
    S.error = e instanceof Offline ? e.message : String(e.message || e);
    render();
  }
}

/** Follow what Test Run has open for you. first: load it all; later: only when it changed. */
async function follow(first) {
  const r = await call('GET', '/api/current');
  if (!r.ok) return;
  const cur = r.current;
  const changed = first || !S.current || !cur || cur.at !== S.current.at;
  if (!changed) return;
  const was = S.current;
  // where the extension was when it was last open (read before loading the suite moves it)
  const { pos } = first ? await chrome.storage.local.get('pos') : {};
  S.current = cur;
  if (!cur || !cur.book || !cur.tab) { S.suite = null; S.screen = 'choose'; render(); return; }
  if (first || !was || !S.suite || cur.book !== S.suite.book || cur.tab !== S.suite.tab || cur.cycle !== S.suite.cycle) await loadSuite();
  // Reopened: carry on where the extension was (after a mark it moved on), unless a case
  // was picked in Test Run since then.
  const resume = pos && pos.at === cur.at && pos.book === cur.book && pos.tab === cur.tab && (pos.cycle || '') === (cur.cycle || '') && S.suite && S.suite.cases.some((x) => x.key === pos.caseKey);
  if (resume) openCase(pos.caseKey);
  else if (cur.caseKey && (first || !was || cur.caseKey !== was.caseKey)) openCase(cur.caseKey);
  S.screen = 'testing';
  render();
}

/** The suite again, quietly: redrawn only when its results or evidence changed. */
async function refreshSuite(force) {
  if (!S.suite || !S.current || (!force && (S.busy || S.confirmRemove))) return;
  const before = JSON.stringify(S.suite);
  const was = S.suite;
  await loadSuite();
  if (S.suite && S.suite !== was && JSON.stringify(S.suite) !== before) render();
}

async function loadSuite() {
  const c = S.current;
  const r = await call('GET', `/api/ext/suite?book=${encodeURIComponent(c.book)}&tab=${encodeURIComponent(c.tab)}&cycle=${encodeURIComponent(c.cycle || '')}`);
  if (!r.ok) { S.suite = null; S.error = r.error; return; }
  S.error = '';
  S.suite = r;
  if (!S.suite.cases.some((x) => x.key === S.caseKey)) openCase((S.suite.cases.find((x) => !x.status) || S.suite.cases[0] || {}).key || '');
}

function openCase(key) {
  if (key === S.caseKey) return;
  S.caseKey = key;
  S.draft = null;
  S.pending = '';
  S.confirmRemove = '';
  // where the extension is, for the next time it opens (tied to what Test Run had picked then)
  if (key && S.current && S.current.book) chrome.storage.local.set({ pos: { book: S.current.book, tab: S.current.tab, cycle: S.current.cycle || '', caseKey: key, at: S.current.at } }).catch(() => {});
}

const theCase = () => (S.suite ? S.suite.cases.find((x) => x.key === S.caseKey) : null);
/** A case's attachments, screenshot first: [{ kind, name, size, usedFor, … }]. */
const filesOf = (c) => ['photo', 'video'].filter((k) => c && c.evidence && c.evidence[k]).map((k) => c.evidence[k]);
const recLive = () => !!(S.rec && ['recording', 'paused', 'saving'].includes(S.rec.state));
const clsOf = (value) => { const o = S.suite && S.suite.statusOptions.find((x) => x.value === value); return o ? o.cls : value ? 'other' : 'none'; };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function header() {
  const who = S.me && S.screen !== 'signin' ? `<span class="who" title="${esc(S.me.name)}"><span class="av">${esc((S.me.name.trim()[0] || '?').toUpperCase())}</span><span>${esc(S.me.name)}</span></span>` : '';
  return `<div class="hd"><span class="mk" aria-hidden="true"></span><span class="title">Test Run Extension</span><span class="grow"></span>${who}</div>`;
}

function footer() {
  if (!S.conn) return '';
  return `<div class="foot"><span class="faint grow ellipsis">${S.limits ? esc(limitsLine(S.limits)) : ''}</span><button class="link" data-action="sign-out">Sign out</button></div>`;
}

function render() {
  const ae = document.activeElement;
  const focus = ae && ae.id ? { id: ae.id, start: ae.selectionStart, end: ae.selectionEnd } : null;
  let h = header();
  if (S.screen === 'loading') h += '<div class="loading">Connecting to Test Run…</div>';
  else if (S.screen === 'signin') h += signInHtml();
  else if (S.screen === 'offline') h += `<div class="box center"><b>Test Run is not answering</b><div class="muted">${esc(S.error)}</div></div><button class="primary" data-action="retry">Try again</button>${footer()}`;
  else if (S.screen === 'viewonly') h += `<div class="center" style="padding:22px 8px"><div style="font-size:22px;color:var(--muted)" aria-hidden="true">◉</div><div style="margin-top:6px">Only view access, click <a href="#" data-action="open-summary">here</a> for summary</div></div>${footer()}`;
  else if (S.screen === 'choose') h += chooseHtml();
  else h += testingHtml();
  app().innerHTML = h;
  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) { el.focus(); try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch { /* not text */ } }
  }
}

function signInHtml() {
  return `<div class="sign-in"><b>Sign in to Test Run</b><span class="muted">Paste the access link your test lead sent you.</span></div>
    <label class="sr" for="link">Access link</label><input id="link" placeholder="https://…/test-run/#join=…" value="${esc(S.linkText)}" autocomplete="off">
    ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
    <button class="primary" data-action="sign-in" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Signing in…' : 'Sign in'}</button>
    <div class="faint">Nothing else shows until you're signed in.</div>`;
}

function limitsBox() {
  const l = S.limits;
  if (!l) return '';
  return `<div class="box muted"><div class="lb">Set by your test lead</div>${esc(limitsLine(l))}<br>Photos up to ${l.photo.width}×${l.photo.height} · each file up to ${fmtBytes(l.maxBytes)}</div>`;
}

function chooseHtml() {
  return `<div class="box center" style="padding:16px 10px"><div style="font-weight:600">Choose what you're testing</div><div class="muted">Pick it in Test Run; it shows here.</div></div>
    <button class="primary" data-action="choose">Choose Workbook/Suite</button>
    ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
    ${limitsBox()}
    <div class="foot"><span class="grow"></span><button class="link" data-action="sign-out">Sign out</button></div>`;
}

function testingHtml() {
  const s = S.suite;
  if (!s) return `<div class="err">${esc(S.error || 'This suite could not be read.')}</div><button class="primary" data-action="choose">Choose Workbook/Suite</button>${footer()}`;
  const done = s.cases.filter((c) => c.status).length;
  let h = `<div class="box"><div class="row"><div class="grow"><div class="lb">Workbook</div><div class="ellipsis" title="${esc(s.book)}">${esc(s.book.replace(/\.xlsx$/i, ''))}</div></div><button class="link" data-action="choose">Change</button></div>
    <div class="row" style="margin-top:4px"><div class="grow" style="flex:2"><div class="lb">Suite</div><div class="ellipsis">${esc(s.tab)}</div></div><div class="grow"><div class="lb">Cycle</div>${esc(s.cycle || 'Status')}</div><div class="muted">${done} of ${s.cases.length}</div></div></div>`;
  if (!s.hasCycle) return `${h}<div class="warn">${esc(s.tab)} has no test cycle yet. Your test lead starts one in Setup.</div>${footer()}`;
  if (!s.cases.length) return `${h}<div class="muted">This suite has no test cases.</div>${footer()}`;
  const c = theCase() || s.cases[0];
  if (c.key !== S.caseKey) openCase(c.key);
  const i = s.cases.indexOf(c);
  const cls = clsOf(c.status);
  h += `<div class="row"><button class="icon" data-action="prev" aria-label="Previous case" ${i <= 0 ? 'disabled' : ''}>‹</button>
    <div class="grow"><div class="lb">${esc(c.id || `Row ${c.row}`)} · ${c.status ? `<span class="pill ${cls}">${esc(c.status)}</span>${filesOf(c).some((f) => f.usedFor) ? ' with evidence' : ''}` : 'not run'}</div><div class="scenario" title="${esc(c.scenario)}">${esc(c.scenario)}</div></div>
    <button class="icon" data-action="next" aria-label="Next case" ${i >= s.cases.length - 1 ? 'disabled' : ''}>›</button></div>
    <label class="sr" for="find">Find a case by ID</label><input id="find" list="ids" placeholder="Find a case by ID" autocomplete="off"><datalist id="ids">${s.cases.map((x) => `<option value="${esc(x.id || x.key)}">${esc(x.scenario.slice(0, 80))}</option>`).join('')}</datalist>`;
  if (S.pending) {
    const old = filesOf(c).filter((f) => f.usedFor && f.usedFor !== S.pending);
    h += `<div class="warn">To change this result to <b>${esc(S.pending)}</b>, attach new evidence: a screenshot or a recording.${old.length ? ` The files for ${esc(old[0].usedFor)} are replaced, or deleted once ${esc(S.pending)} is saved.` : ''} <button class="link" data-action="cancel-pending">Cancel</button></div>`;
  }
  const r = S.rec;
  const live = recLive();
  h += `<div class="cap-btns"><button data-action="screenshot" ${S.busy ? 'disabled' : ''}>◱ Screenshot</button>${live
    ? `<div class="split"><button data-action="${r.state === 'paused' ? 'rec-resume' : 'rec-pause'}" ${r.state === 'saving' ? 'disabled' : ''}>${r.state === 'paused' ? '▶ Resume' : '❚❚ Pause'}</button><button class="stop" data-action="rec-stop" ${r.state === 'saving' ? 'disabled' : ''}>■ Stop</button></div>`
    : `<button data-action="record" ${S.busy ? 'disabled' : ''}>● Record</button>`}</div>`;
  if (live) {
    const other = r.key !== c.key || r.tab !== s.tab ? ` · for ${esc(r.id || r.key)}` : '';
    h += r.state === 'saving'
      ? `<div class="rec-line">${esc(r.msg || 'Attaching the recording…')}</div>`
      : `<div class="rec-line"><span class="dot${r.state === 'paused' ? ' paused' : ''}" aria-hidden="true"></span><b>${r.state === 'paused' ? 'Paused' : 'Recording'}</b> <span id="recClock">${fmtTime(elapsedMs(r, Date.now()) / 1000)}</span> <span class="muted">· <span id="recSize">~${fmtBytes(r.bytes)} of ${fmtBytes(r.maxBytes)}</span>${other}</span></div>`;
  }
  for (const f of filesOf(c)) {
    h += S.confirmRemove === f.kind
      ? `<div class="box file"><span class="grow">Delete <b>${esc(f.name)}</b> for good?</span><button data-action="remove-yes" data-kind="${f.kind}" class="primary" style="background:var(--fail);border-color:var(--fail)">Delete</button><button data-action="remove-no">Keep</button></div>`
      : `<div class="box file"><span aria-hidden="true" title="${f.kind === 'video' ? 'Recording' : 'Screenshot'}">${f.kind === 'video' ? '▶' : '▣'}</span><span class="name" title="${esc(f.name)}">${esc(f.name)}</span><span class="faint">${fmtBytes(f.size)}</span><button class="link" data-action="remove" data-kind="${f.kind}" aria-label="Remove ${esc(f.name)}" title="Remove (deletes it from Test Run for good)">✕</button></div>`;
  }
  const shown = S.draft != null ? S.draft : withoutEvidenceLine(c.comment);
  h += `<label class="sr" for="comment">Comment</label><textarea id="comment" rows="2" placeholder="Comment (optional)">${esc(shown)}</textarea>`;
  h += `<div class="st" role="group" aria-label="Result">${s.statusOptions.map((o) => `<button class="${o.cls}${o.value === c.status ? ' on' : ''}${o.value === S.pending ? ' want' : ''}" data-action="mark" data-value="${esc(o.value)}" ${S.busy ? 'disabled' : ''} aria-pressed="${o.value === c.status}">${esc(o.value)}</button>`).join('')}</div>`;
  if (S.pending) h += `<div class="muted">${esc(S.pending)} is saved when the screenshot or recording is attached.</div>`;
  if (S.busy) h += `<div class="muted">${esc(S.busy)}</div>`;
  if (S.flash) h += `<div class="flash${S.flash.bad ? ' bad' : ''}">${esc(S.flash.text)}</div>`;
  return h + footer();
}

function flash(text, bad) {
  S.flash = { text, bad: !!bad };
  render();
  const mine = S.flash;
  setTimeout(() => { if (S.flash === mine) { S.flash = null; render(); } }, bad ? 6000 : 3000);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function signIn() {
  const text = (document.getElementById('link') || {}).value || '';
  S.linkText = text;
  const conn = parseLink(text);
  if (!conn) { S.error = 'That is not an access link. It ends in #join=… : copy the whole link.'; render(); return; }
  S.busy = 'signing in';
  S.error = '';
  render();
  S.conn = conn;
  try {
    const st = await call('GET', '/api/status');
    if (!st.ok || st.app !== 'test-run') throw new Offline('That address is not a Test Run.');
    if (!st.me) { S.conn = null; S.busy = ''; S.error = 'That access link does not work (any more). Ask your test lead for a new one.'; render(); return; }
    await saveConn();
    S.busy = '';
    S.linkText = '';
    await connect();
  } catch (e) {
    S.conn = null;
    S.busy = '';
    S.error = e instanceof Offline ? `${e.message} Check that Test Run is running and shared.` : String(e.message || e);
    render();
  }
}

async function signOut(why) {
  await chrome.storage.local.remove(['conn', 'pos']);
  Object.assign(S, { conn: null, me: null, current: null, suite: null, caseKey: '', limits: null, pending: '', screen: 'signin', error: why || '' });
  render();
}

function open(view) {
  chrome.tabs.create({ url: consoleUrl(S.conn, view) });
  window.close();
}

async function mark(value) {
  const c = theCase();
  if (!c || S.busy) return;
  const commentEdited = S.draft != null && S.draft !== withoutEvidenceLine(c.comment);
  if (value === c.status && !commentEdited) return;
  // A result backed by evidence changes only with new evidence.
  const files = filesOf(c);
  if (value !== c.status && files.some((f) => f.usedFor && f.usedFor !== value) && !files.some((f) => !f.usedFor)) {
    S.pending = value;
    render();
    return;
  }
  await saveMark(c, value, commentEdited);
}

async function saveMark(c, value, commentEdited) {
  S.busy = 'Saving…';
  render();
  const req = { tab: S.suite.tab, key: c.key, sh: c.sh, row: c.row, cycle: S.suite.cycle, expect: c.status, status: value };
  const backing = filesOf(c).filter((f) => f.usedFor && f.usedFor === c.status).map((f) => f.name);
  if (commentEdited) req.comment = S.draft + (backing.length ? `\nEvidence: ${backing.join(', ')}` : '');
  let r;
  try { r = await call('POST', '/api/call/api_mark', { body: { book: S.suite.book, args: [req] } }); } catch (e) { r = { ok: false, error: e.message }; }
  S.busy = '';
  if (r.ok) {
    c.status = r.status;
    if (r.comment != null) c.comment = r.comment;
    if (r.evidence) c.evidence = Object.keys(r.evidence).length ? r.evidence : null;
    S.draft = null;
    S.pending = '';
    const i = S.suite.cases.indexOf(c);
    flash(`${c.id || 'The case'}: ${value || 'not run'}${r.evidence && Object.keys(r.evidence).length ? ', with evidence' : ''}.${r.removedEvidence ? ` Deleted the old ${r.removedEvidence.length === 1 ? 'file' : 'files'}.` : ''}`);
    if (i >= 0 && i < S.suite.cases.length - 1) openCase(S.suite.cases[i + 1].key);
    render();
    return;
  }
  if (r.code === 'EVIDENCE') { S.pending = value; render(); return; }
  if (r.code === 'CONFLICT') {
    await loadSuite();
    flash(`${c.id || 'This case'} was just marked "${r.current || 'not run'}"${r.by ? ` by ${r.by}` : ''}. Showing that; mark again if you need to.`, true);
    return;
  }
  flash(r.error || 'Could not save.', true);
}

/** The visible tab as a PNG, scaled to fit the photo limit. */
async function capturePng() {
  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const fit = fitWithin(bmp.width, bmp.height, S.limits.photo.width, S.limits.photo.height);
  if (fit.scale === 1) return blob;
  const canvas = new OffscreenCanvas(fit.width, fit.height);
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, fit.width, fit.height);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function screenshot() {
  const c = theCase();
  if (!c || !S.limits || S.busy) return;
  S.busy = 'Taking a screenshot…';
  render();
  let png;
  try { png = await capturePng(); } catch (e) {
    S.busy = '';
    flash(`This page can't be captured (${String(e.message || e).replace(/\.$/, '')}). Open the page you are testing, then try again.`, true);
    return;
  }
  if (png.size > S.limits.maxBytes) { S.busy = ''; flash(`That screenshot is ${fmtBytes(png.size)}, over the ${fmtBytes(S.limits.maxBytes)} limit.`, true); return; }
  S.busy = 'Attaching…';
  render();
  const forStatus = S.pending;
  let r;
  try {
    r = await call('POST', `/api/evidence?book=${encodeURIComponent(S.suite.book)}&tab=${encodeURIComponent(S.suite.tab)}&cycle=${encodeURIComponent(S.suite.cycle)}&key=${encodeURIComponent(c.key)}&forStatus=${encodeURIComponent(forStatus)}`, { body: png, raw: true });
  } catch (e) { r = { ok: false, error: e.message }; }
  S.busy = '';
  if (!r.ok) { flash(r.error || 'Could not attach it.', true); return; }
  c.evidence = r.evidence;
  if (forStatus) { await saveMark(c, forStatus, S.draft != null && S.draft !== withoutEvidenceLine(c.comment)); return; }
  flash(`Screenshot attached to ${c.id || 'the case'} (${fmtBytes(r.added.size)}).`);
}

async function record() {
  const c = theCase();
  if (!c || S.busy) return;
  const q = new URLSearchParams({ book: S.suite.book, tab: S.suite.tab, cycle: S.suite.cycle, key: c.key, id: c.id || '', scenario: c.scenario.slice(0, 200), forStatus: S.pending });
  await chrome.windows.create({ url: chrome.runtime.getURL(`recorder/recorder.html?${q}`), type: 'popup', width: 440, height: 430, focused: true });
  window.close();
}

async function removeEvidence(kind) {
  const c = theCase();
  if (!c || !c.evidence || !c.evidence[kind]) return;
  S.busy = 'Deleting…';
  S.confirmRemove = '';
  render();
  let r;
  try { r = await call('POST', '/api/evidence/remove', { body: { book: S.suite.book, tab: S.suite.tab, cycle: S.suite.cycle, key: c.key, kind } }); } catch (e) { r = { ok: false, error: e.message }; }
  S.busy = '';
  if (!r.ok) { flash(r.error, true); return; }
  c.evidence = r.evidence && Object.keys(r.evidence).length ? r.evidence : null;
  if (!c.evidence) { c.comment = withoutEvidenceLine(c.comment); S.pending = ''; }
  flash(`Deleted ${r.removed}.`);
}

/** The Recorder window's buttons, from here. */
async function recCommand(type) {
  try {
    const r = await chrome.runtime.sendMessage({ target: 'recorder', type });
    if (!r || !r.ok) throw new Error('no answer');
  } catch {
    await chrome.storage.session.remove('rec'); // its window was closed
    S.rec = null;
    flash('The recording window was closed, so the recording stopped.', true);
  }
}

/** The recording's state changed (the Recorder window writes it). */
async function onRec(rec) {
  const was = S.rec;
  S.rec = rec || null;
  // the same recording, still going: just its size (the clock ticks by itself)
  if (was && rec && was.state === rec.state && was.key === rec.key && ['recording', 'paused'].includes(rec.state)) {
    const size = document.getElementById('recSize');
    if (size) size.textContent = `~${fmtBytes(rec.bytes)} of ${fmtBytes(rec.maxBytes)}`;
    return;
  }
  if (rec && rec.state === 'done') {
    await chrome.storage.session.remove('rec');
    S.rec = null;
    flash(rec.msg || 'Recording attached.');
    await refreshSuite(true);
    return;
  }
  if (rec && rec.state === 'error') flash(rec.msg || 'The recording could not be attached.', true);
  render();
}

function findCase(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || !S.suite) return;
  const c = S.suite.cases.find((x) => (x.id && x.id.toLowerCase() === t) || x.key.toLowerCase() === t);
  if (!c) { flash(`No case "${text}" in ${S.suite.tab}.`, true); return; }
  openCase(c.key);
  render();
}

const ACTIONS = {
  'sign-in': signIn,
  'sign-out': () => signOut(''),
  retry: connect,
  choose: () => open('run'),
  'open-summary': () => open('summary'),
  prev: () => { const i = S.suite.cases.findIndex((x) => x.key === S.caseKey); if (i > 0) { openCase(S.suite.cases[i - 1].key); render(); } },
  next: () => { const i = S.suite.cases.findIndex((x) => x.key === S.caseKey); if (i < S.suite.cases.length - 1) { openCase(S.suite.cases[i + 1].key); render(); } },
  mark: (el) => mark(el.getAttribute('data-value')),
  'cancel-pending': () => { S.pending = ''; render(); },
  screenshot,
  record,
  remove: (el) => { S.confirmRemove = el.getAttribute('data-kind'); render(); },
  'remove-no': () => { S.confirmRemove = ''; render(); },
  'remove-yes': (el) => removeEvidence(el.getAttribute('data-kind')),
  'rec-pause': () => recCommand('pause'),
  'rec-resume': () => recCommand('resume'),
  'rec-stop': () => recCommand('stop'),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  e.preventDefault();
  const fn = ACTIONS[el.getAttribute('data-action')];
  if (fn) Promise.resolve(fn(el)).catch((err) => flash(String(err.message || err), true));
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'comment') S.draft = e.target.value;
  if (e.target.id === 'link') S.linkText = e.target.value;
});
document.addEventListener('change', (e) => { if (e.target.id === 'find') findCase(e.target.value); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'link') { e.preventDefault(); signIn(); }
  if (e.key === 'Enter' && e.target.id === 'find') { e.preventDefault(); findCase(e.target.value); }
});

init();
