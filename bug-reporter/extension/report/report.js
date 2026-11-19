import { getSettings, saveSettings, getProjects, matchProject, guessModule, MODEL_LABELS } from '../lib/settings.js';
import { get, put, byTab, newId } from '../lib/idb.js';
import { HostSession, callHost, stageBlob } from '../lib/host-client.js';
import { summarizeCall, relTime } from '../lib/digit-errors.js';
import { toCurl } from '../lib/curl.js';
import { buildTitle, stripKnownPrefix } from '../lib/title.js';
import { buildBody, prettyResponse, truncate } from '../lib/body.js';
import { renderMarkdown, escapeHtml as esc } from '../lib/markdown.js';
import { currentIteration, selectableIterations, endDateOf } from '../lib/iteration.js';
import { condenseCall } from '../lib/condense.js';
import { isStatic } from '../lib/static-files.js';
import { assigneeOptionsHtml } from '../lib/people.js';
import { buildComment, RESULTS } from '../lib/comment.js';
import { costOfUsageRecord, formatUsd } from '../lib/pricing.js';
import { testRunStatus, testRunBase, isLocalBase, canNote, listSuites, pickSuite, listCases, caseLabel, matchCase, consoleLink, noteBugInTestRun, buildBugNote, whereLabel } from '../lib/testrun.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reportId = params.get('id');
const DRY_RUN = params.get('dry') === '1';
const META_TTL = 3600000;

const S = {
  report: null,
  settings: null,
  projects: [],
  project: null,
  meta: null,
  shots: [], // {id, blob, url, mime, name}
  clip: { index: null, seconds: 60, keyTs: null, mediaId: null, url: null, size: 0, durationMs: 0, building: false, available: false, startWall: null },
  calls: [], // calls in the window, oldest first, with .aid
  allCalls: [],
  checked: new Set(),
  related: new Set(),
  consoleAll: [],
  consoleChecked: new Set(),
  expanded: new Set(),
  draft: null,
  usage: null,
  bodyDirty: false,
  filed: null,
};

// ---------- helpers ----------
function fail(msg) {
  $('fatal').textContent = msg;
  $('fatal').classList.remove('hidden');
}
const fmtMB = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n || 0));
function prettyModel(m) {
  const mm = String(m || '').match(/claude-([a-z]+)-(\d+)-(\d+)/i);
  return mm ? `${mm[1][0].toUpperCase()}${mm[1].slice(1)} ${mm[2]}.${mm[3]}` : m || 'unknown';
}
function fixHtml(fix) {
  return (fix || [])
    .map((c) => (/^[a-z]/.test(c) ? `<div class="fixcmd"><code>${esc(c)}</code><button data-copytext="${esc(c)}">Copy</button></div>` : `<div class="small">${esc(c)}</div>`))
    .join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copytext]');
  if (b) navigator.clipboard.writeText(b.dataset.copytext).then(() => (b.textContent = 'Copied'));
});
function moduleValue() {
  return $('module').value === '__other' ? $('moduleOther').value.trim() : $('module').value;
}
function priority() {
  return document.querySelector('input[name=prio]:checked')?.value || '';
}
function label() {
  return document.querySelector('input[name=label]:checked')?.value || 'bug';
}
function shotName(i, mime) {
  return `snapshot-${i + 1}.${/jpe?g/.test(mime) ? 'jpg' : /gif/.test(mime) ? 'gif' : 'png'}`;
}

// ---------- load ----------
async function load() {
  S.settings = await getSettings();
  S.report = reportId ? await get('reports', reportId) : null;
  if (!S.report) {
    fail('This report could not be found (it may be older than the clean-up period). Use the toolbar button or ⌥⇧B to start a new one.');
    $('main').classList.add('hidden');
    return;
  }
  const r = S.report;
  const when = new Date(r.haltWall).toLocaleTimeString();
  $('pageInfo').textContent = `Halted at ${when}${r.incognito ? ' · Incognito' : ''} · ${r.pageTitle ? r.pageTitle + ' — ' : ''}${r.pageUrl || 'unknown page'}`;
  document.title = `Report Issue · ${r.pageTitle || 'Bug Reporter'}`;

  // screenshots
  for (const id of r.media || []) {
    const m = await get('media', id);
    if (m?.blob) S.shots.push({ id, blob: m.blob, url: URL.createObjectURL(m.blob), mime: m.mime || 'image/png' });
  }
  if (r.snapshotError) $('shotNote').textContent = `Snapshot not taken automatically (${r.snapshotError}). Use “Add image” or ⌥⇧S next time.`;
  renderShots();

  // network + console
  await loadCalls();
  await loadConsole();

  // recording
  await initVideo();

  // form
  S.projects = await getProjects();
  if (isUpdateMode()) initUpdate();
  else { initForm(); refreshTestRun(); }
  $('claudeShot').checked = Boolean(S.settings.claude.sendScreenshot);
  $('claudeApis').checked = S.settings.claude.sendApis !== false;
  // Per-issue Claude choice: starts from Settings, applies to this report only.
  $('draftModel').value = S.settings.claude.model || 'sonnet';
  $('draftEffort').value = S.settings.claude.effort || 'low';
  $('draftDetail').value = S.settings.claude.detail || 'detailed';

  if (r.filed) showFiled(r.filed);
  if (r.updated) showUpdated(r.updated);
}

// ---------- screenshots ----------
function renderShots() {
  $('shots').innerHTML = S.shots.length
    ? S.shots
        .map(
          (s, i) => `<div class="shot"><img src="${s.url}" alt="Screenshot ${i + 1}" data-zoom="${i}"><div class="bar"><span>${esc(shotName(i, s.mime))} · ${fmtMB(s.blob.size)}</span><button data-rmshot="${i}" aria-label="Remove screenshot ${i + 1}">Remove</button></div></div>`,
        )
        .join('')
    : '<div class="muted">No screenshots. Add one, or press ⌥⇧S while testing.</div>';
  evidenceChanged();
}
$('shots').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rmshot]');
  if (rm) {
    S.shots.splice(Number(rm.dataset.rmshot), 1);
    renderShots();
    return;
  }
  const z = e.target.closest('[data-zoom]');
  if (z) {
    const d = document.createElement('dialog');
    d.className = 'zoom';
    d.innerHTML = `<img src="${S.shots[Number(z.dataset.zoom)].url}" alt="">`;
    d.addEventListener('click', () => d.remove());
    document.body.append(d);
    d.showModal();
  }
});
$('addImage').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    if (f.size > 10 * 1048576) {
      alert(`${f.name} is larger than GitHub's 10 MB image limit.`);
      continue;
    }
    const id = newId('m');
    await put('media', { id, kind: 'image', mime: f.type, blob: f, size: f.size, createdAt: Date.now(), source: 'upload' });
    S.shots.push({ id, blob: f, url: URL.createObjectURL(f), mime: f.type });
  }
  e.target.value = '';
  renderShots();
});

// ---------- video ----------
async function recorder(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ target: 'recorder', type, ...payload })) || { ok: false };
  } catch {
    return { ok: false };
  }
}

async function initVideo() {
  const rec = S.report.recording;
  S.clip.seconds = S.settings.recording.clipSeconds;
  if (!rec) {
    $('videoNone').textContent = 'No recording for this report. Start one from the toolbar (⌥⇧R) before you test.';
    $('videoNone').classList.remove('hidden');
    $('videoInclude').checked = false;
    $('videoInclude').disabled = true;
    return;
  }
  const idx = await recorder('clip-index', { endTs: rec.videoTs });
  if (!idx.ok || !idx.keys?.length) {
    $('videoNone').textContent = 'The recording is no longer available (the browser was restarted or a new recording was started).';
    $('videoNone').classList.remove('hidden');
    $('videoInclude').checked = false;
    $('videoInclude').disabled = true;
    return;
  }
  S.clip.index = idx;
  S.clip.available = true;
  const spanSec = (idx.endTs - idx.keys[0].ts) / 1e6;
  S.clip.noCuts = idx.keys.length === 1 && spanSec > 10;
  const maxSec = Math.max(5, Math.ceil((idx.endTs - idx.keys[0].ts) / 1e6 / 5) * 5);
  $('clipRange').max = String(Math.max(10, maxSec));
  $('clipRange').value = String(Math.min(S.clip.seconds, maxSec));
  $('videoBox').classList.remove('hidden');
  updateClipEstimate();
  // Start with the largest clip (up to the default length) that fits under the cap.
  const cap = S.settings.recording.capMB * 1048576;
  if (estimate(Number($('clipRange').value)).bytes > cap) {
    let s = Number($('clipRange').value);
    while (s > 5 && estimate(s).bytes > cap) s -= 5;
    $('clipRange').value = String(s);
    updateClipEstimate();
  }
  buildClip();
}

function estimate(seconds) {
  const idx = S.clip.index;
  const target = idx.endTs - seconds * 1e6;
  let key = idx.keys[0];
  for (const k of idx.keys) {
    if (k.ts <= target) key = k;
    else break;
  }
  return { key, bytes: Math.round(key.bytes * 1.01 + 4096), seconds: Math.round((idx.endTs - key.ts) / 1e6) };
}

function updateClipEstimate() {
  const s = Number($('clipRange').value);
  const est = estimate(s);
  S.clip.seconds = s;
  $('clipSecs').textContent = `${est.seconds} s`;
  $('clipSize').textContent = `≈ ${fmtMB(est.bytes)}`;
  const cap = S.settings.recording.capMB * 1048576;
  const over = est.bytes > cap;
  const msg = over
    ? `Over the ${S.settings.recording.capMB} MB cap. Shorten the clip, or untick “Attach clip”.`
    : S.clip.noCuts
      ? 'This recording has no cut points after its start, so it can only be attached whole.'
      : '';
  $('clipWarn').classList.toggle('hidden', !msg);
  $('clipWarn').textContent = msg;
  return est;
}

let clipTimer = null;
$('clipRange').addEventListener('input', () => {
  updateClipEstimate();
  clearTimeout(clipTimer);
  clipTimer = setTimeout(buildClip, 400);
});
$('videoInclude').addEventListener('change', () => evidenceChanged());

let clipSeq = 0;
let clipJob = null;

/**
 * Builds the clip for the current slider position. Only the newest request may update
 * the page: a slower, older build (e.g. the first full-length one) can never overwrite it.
 */
function buildClip() {
  if (!S.clip.available) return Promise.resolve();
  const est = updateClipEstimate();
  if (S.clip.keyTs === est.key.ts && S.clip.mediaId && !clipJob) return Promise.resolve();
  const seq = ++clipSeq;
  S.clip.building = true;
  $('clipState').textContent = 'Building clip…';
  const job = (async () => {
    const r = await recorder('make-clip', { startTs: est.key.ts, endTs: S.clip.index.endTs });
    if (seq !== clipSeq) return; // superseded by a newer slider position
    if (!r.ok) {
      $('clipState').textContent = `Could not build the clip: ${r.error || 'recorder not available'}`;
      return;
    }
    const m = await get('media', r.mediaId);
    if (seq !== clipSeq) return;
    if (S.clip.url) URL.revokeObjectURL(S.clip.url);
    Object.assign(S.clip, { keyTs: est.key.ts, mediaId: r.mediaId, blob: m.blob, url: URL.createObjectURL(m.blob), size: r.size, durationMs: r.durationMs, startWall: r.startWall });
    $('clipVideo').src = S.clip.url;
    $('clipSize').textContent = fmtMB(r.size);
    $('clipState').textContent = `MP4 · ${Math.round(r.durationMs / 1000)} s · ${fmtMB(r.size)}`;
    const cap = S.settings.recording.capMB * 1048576;
    $('clipWarn').classList.toggle('hidden', r.size <= cap);
    await loadCalls();
    evidenceChanged();
  })().finally(() => {
    if (seq === clipSeq) {
      S.clip.building = false;
      clipJob = null;
    }
  });
  clipJob = job;
  return job;
}

/** Waits until the attached clip is the one the slider shows (used before filing). */
async function ensureClipMatchesSlider() {
  clearTimeout(clipTimer);
  for (let i = 0; i < 5; i++) {
    if (clipJob) await clipJob;
    const est = updateClipEstimate();
    if (S.clip.mediaId && S.clip.keyTs === est.key.ts && !clipJob) return true;
    await buildClip();
  }
  return S.clip.keyTs === updateClipEstimate().key.ts;
}

$('downloadFull').addEventListener('click', async () => {
  $('clipState').textContent = 'Preparing full recording…';
  const r = await recorder('make-clip', { endTs: S.clip.index?.endTs });
  if (!r.ok) {
    $('clipState').textContent = `Could not export: ${r.error || 'recorder not available'}`;
    return;
  }
  const m = await get('media', r.mediaId);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(m.blob);
  a.download = `recording-${new Date(S.report.haltWall).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
  a.click();
  $('clipState').textContent = `Full recording saved (${fmtMB(r.size)}).`;
});

// ---------- API calls ----------
function windowRange() {
  const halt = S.report.haltWall;
  if ($('apiRange').value === 'all') return [0, Number.MAX_SAFE_INTEGER];
  const from = S.clip.startWall ? S.clip.startWall - 5000 : halt - 5 * 60000;
  return [from, halt + 2000];
}

async function loadCalls() {
  if (S.report.tabId == null) {
    S.calls = [];
    renderCalls();
    return;
  }
  const [from, to] = windowRange();
  const rows = await byTab('calls', S.report.tabId, from, to);
  rows.sort((a, b) => a.ts - b.ts);
  rows.forEach((c, i) => (c.aid = `a${i + 1}`));
  // keep checks by id across reloads of the window
  const before = new Set([...S.checked]);
  S.calls = rows;
  S.checked = new Set(rows.filter((c) => before.has(c.id)).map((c) => c.id));
  if (!S.initialChecked) {
    S.initialChecked = true;
    const lastFail = [...rows].reverse().find((c) => c.failed && c.ts <= S.report.haltWall + 2000);
    if (lastFail) S.checked.add(lastFail.id);
  }
  renderCalls();
}

function visibleCalls() {
  const q = $('apiSearch').value.trim().toLowerCase();
  const failedOnly = document.querySelector('input[name=apiShow]:checked')?.value === 'failed';
  const hideStatic = $('hideStatic').checked;
  return S.calls.filter((c) => {
    if (S.checked.has(c.id)) return true; // ticked calls always stay in view
    if (failedOnly && !c.failed) return false;
    if (hideStatic && isStatic(c)) return false;
    return !q || `${c.method} ${c.url} ${c.status} ${c.errCode} ${c.errMsg}`.toLowerCase().includes(q);
  });
}

function renderCalls() {
  const staticCount = S.calls.filter(isStatic).length;
  const hideStatic = $('hideStatic').checked;
  $('cntAll').textContent = `(${hideStatic ? S.calls.length - staticCount : S.calls.length})`;
  $('cntFailed').textContent = `(${S.calls.filter((c) => c.failed).length})`;
  $('cntStatic').textContent = `(${staticCount})`;
  $('selCount').textContent = S.checked.size ? `${S.checked.size} selected` : '';
  $('apiInfo').textContent =
    S.report.tabId == null
      ? 'No tab was captured for this report.'
      : `${S.calls.length} calls ${$('apiRange').value === 'all' ? 'captured' : 'around the halt'}. Ticked calls go into the issue as cURL + response; click a row to see its request and response.`;

  const list = visibleCalls();
  // Select-all reflects the rows currently shown.
  const shownChecked = list.filter((c) => S.checked.has(c.id)).length;
  $('selectAll').checked = list.length > 0 && shownChecked === list.length;
  $('selectAll').indeterminate = shownChecked > 0 && shownChecked < list.length;
  $('selectAll').disabled = !list.length;
  $('selectAllLabel').textContent = list.length ? `Select all shown (${list.length})` : 'Select all shown';

  if (!list.length) {
    $('apiRows').innerHTML = `<div class="empty">${S.calls.length ? 'No calls match these filters.' : 'No API calls captured in this window. Is capture enabled for this site (toolbar popup)?'}</div>`;
    return;
  }
  const halt = S.report.haltWall;
  $('apiRows').innerHTML = [...list]
    .reverse()
    .map((c) => {
      let path = c.url;
      try {
        const u = new URL(c.url);
        path = u.pathname + u.search;
      } catch {}
      const checked = S.checked.has(c.id);
      const open = S.expanded.has(c.id);
      const status = c.error ? 'ERR' : String(c.status);
      return `<div class="api ${checked ? 'checked' : ''}" data-id="${esc(c.id)}">
        <div class="line">
          <input type="checkbox" data-check="${esc(c.id)}" ${checked ? 'checked' : ''} aria-label="Include ${esc(c.method)} ${esc(path)}">
          <span class="when">${relTime(c.ts - halt)}</span>
          <span class="method">${esc(c.method)}</span>
          <span class="path" title="${esc(c.url)}">${esc(path)}</span>
          <span class="status ${c.failed ? 'bad' : 'ok'}">${esc(status)}</span>
          ${c.failed || S.related.has(c.aid) ? `<span class="err">${S.related.has(c.aid) ? '<span class="star">★ Claude: looks related</span> ' : ''}${esc([c.errCode, c.errMsg].filter(Boolean).join(': '))}</span>` : ''}
        </div>
        ${open ? detailHtml(c) : ''}
      </div>`;
    })
    .join('');
}

$('selectAll').addEventListener('change', () => {
  const list = visibleCalls();
  if ($('selectAll').checked) for (const c of list) S.checked.add(c.id);
  else for (const c of list) S.checked.delete(c.id);
  renderCalls();
  evidenceChanged();
});

function detailHtml(c) {
  const res = c.resBody != null ? prettyResponse(c.resBody) : null;
  const resText = res ? truncate(res.text, 20000).text : c.resBodyOmitted ? `(${c.resBodyOmitted})` : '(empty)';
  return `<div class="detail">
    <div class="muted small">${esc(c.kind || '')} · ${c.duration ?? '?'} ms · ${esc(new Date(c.ts).toLocaleTimeString())}${c.resBodyTruncated ? ' · response cut at 256 KB' : ''}</div>
    <b class="small">cURL</b><pre>${esc(toCurl(c))}</pre>
    <b class="small">Response</b><pre>${esc(resText)}</pre>
  </div>`;
}

$('apiRows').addEventListener('click', (e) => {
  const cb = e.target.closest('[data-check]');
  if (cb) {
    const id = cb.dataset.check;
    if (cb.checked) S.checked.add(id);
    else S.checked.delete(id);
    renderCalls();
    evidenceChanged();
    return;
  }
  const row = e.target.closest('.line');
  if (row && !e.target.closest('pre')) {
    const id = row.parentElement.dataset.id;
    if (S.expanded.has(id)) S.expanded.delete(id);
    else S.expanded.add(id);
    renderCalls();
  }
});
for (const r of document.querySelectorAll('input[name=apiShow]')) r.addEventListener('change', renderCalls);
$('hideStatic').addEventListener('change', renderCalls);
$('apiRange').addEventListener('change', loadCalls);
$('apiSearch').addEventListener('input', renderCalls);

// ---------- console ----------
async function loadConsole() {
  if (S.report.tabId == null) return renderConsole();
  const [from, to] = [S.report.haltWall - 10 * 60000, S.report.haltWall + 2000];
  S.consoleAll = (await byTab('consoleLogs', S.report.tabId, from, to)).sort((a, b) => b.ts - a.ts);
  renderConsole();
}
function renderConsole() {
  if (!S.consoleAll.length) {
    $('consoleList').innerHTML = '<div class="empty">No console errors in the last 10 minutes.</div>';
    return;
  }
  $('consoleList').innerHTML = S.consoleAll
    .map(
      (c) => `<label class="con"><input type="checkbox" data-con="${esc(c.id)}" ${S.consoleChecked.has(c.id) ? 'checked' : ''}>
      <span class="muted">${relTime(c.ts - S.report.haltWall)}</span><span class="msg" title="${esc(c.stack || '')}">${esc(c.message)}</span></label>`,
    )
    .join('');
}
$('consoleList').addEventListener('change', (e) => {
  const id = e.target.dataset.con;
  if (!id) return;
  if (e.target.checked) S.consoleChecked.add(id);
  else S.consoleChecked.delete(id);
  evidenceChanged();
});

// ---------- form ----------
function initForm() {
  if (!S.projects.length) {
    $('noProjects').classList.remove('hidden');
  }
  const match = matchProject(S.projects, S.report.pageUrl);
  $('project').innerHTML =
    `<option value="">${S.projects.length ? 'Choose project…' : 'No projects set up'}</option>` +
    S.projects.map((p) => `<option value="${esc(p.id)}" ${match?.id === p.id ? 'selected' : ''}>${esc(p.boardTitle)} → ${esc(p.repo)}</option>`).join('');
  const mod = guessModule(S.report.pageUrl);
  if (mod) $('module').value = mod;
  if (match) selectProject(match.id);
  else {
    $('iterField').classList.add('hidden');
  }
}

$('project').addEventListener('change', () => selectProject($('project').value));
$('refreshMeta').addEventListener('click', () => S.project && loadMeta(true));
$('module').addEventListener('change', () => {
  $('moduleOther').classList.toggle('hidden', $('module').value !== '__other');
  if ($('module').value === '__other') $('moduleOther').focus();
});
$('goProjects').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#projects') }));
$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function selectProject(id) {
  S.project = S.projects.find((p) => p.id === id) || null;
  S.meta = null;
  $('assignee').innerHTML = '<option value="">Loading people…</option>';
  $('status').innerHTML = '';
  $('iteration').innerHTML = '';
  const mode = S.project?.priority?.mode;
  $('prioNote').textContent = !S.project
    ? ''
    : mode === 'title'
      ? 'This board has no Priority field, so it goes in the title as [P?].'
      : mode === 'issueField'
        ? `Set as the org field ${S.project.priority.fieldName}: ${['P0', 'P1', 'P2', 'P3'].map((p) => `${p}→${S.project.priority.mapping?.[p]?.name || '?'}`).join(', ')}.`
        : '';
  if (S.project) await loadMeta(false);
  if (S.draft) refreshTitle();
}

async function loadMeta(force) {
  const p = S.project;
  const key = `meta:${p.id}`;
  $('metaState').textContent = 'Loading board…';
  try {
    let meta = (await chrome.storage.local.get(key))[key];
    if (force || !meta || Date.now() - meta.fetchedAt > META_TTL || !('boardAssignees' in meta)) {
      meta = await callHost('projectMeta', { boardUrl: p.boardUrl, repo: p.repo });
      await chrome.storage.local.set({ [key]: meta });
    }
    if (S.project !== p) return;
    S.meta = meta;
    fillMeta();
    const age = Math.round((Date.now() - meta.fetchedAt) / 60000);
    const isPublic = meta.repo?.visibility === 'PUBLIC';
    $('metaState').innerHTML = `${esc(meta.board.title)} · ${esc(meta.repo?.visibility?.toLowerCase() || '')} repo · loaded ${age ? `${age} min ago` : 'just now'}${esc(S.iterNote || '')}${
      isPublic ? '<br><span class="pill warn">Public repo</span> Anything in the issue, including request bodies and tokens, is visible to everyone.' : ''
    }`;
  } catch (e) {
    $('metaState').innerHTML = `<span class="pill bad">Could not load board</span> ${esc(e.message)}${fixHtml(e.fix)}`;
  }
}

function fillMeta() {
  const { board, repo } = S.meta;
  const p = S.project;
  $('assignee').innerHTML = assigneeOptionsHtml({ assignees: repo?.assignees || [], boardAssignees: S.meta.boardAssignees || [], repo: p.repo, selected: p.defaultAssignee || '' });
  const statusOpts = board.status?.options || [];
  const initial = p.initialStatus?.optionId;
  $('status').innerHTML = statusOpts.map((o) => `<option value="${esc(o.id)}" ${o.id === initial ? 'selected' : ''}>${esc(o.name)}</option>`).join('') || '<option value="">(no Status field)</option>';
  if (p.iterationFieldId && board.iteration) {
    $('iterField').classList.remove('hidden');
    const cur = currentIteration(board.iteration.iterations);
    const list = selectableIterations(board.iteration.iterations);
    $('iteration').innerHTML =
      list.map((it) => `<option value="${esc(it.id)}" ${cur?.id === it.id ? 'selected' : ''}>${esc(it.title)}${cur?.id === it.id ? ' (current)' : ''} · ${esc(it.startDate)} → ${esc(endDateOf(it))}</option>`).join('') +
      `<option value="" ${cur ? '' : 'selected'}>No iteration (backlog)</option>`;
    S.iterNote = cur ? '' : ' · no iteration is active today';
  } else {
    S.iterNote = '';
    $('iterField').classList.add('hidden');
    $('iteration').innerHTML = '';
  }
}

$('iteration').addEventListener('change', () => {
  if ($('iteration').value) return;
  // Backlog: move Status to "Backlog" when the board has it (you can change it back).
  const opts = S.meta?.board?.status?.options || [];
  const backlog = opts.find((o) => /^backlog$/i.test(o.name)) || opts.find((o) => /backlog/i.test(o.name));
  if (backlog) $('status').value = backlog.id;
});

for (const el of document.querySelectorAll('input[name=prio], input[name=label], #module, #moduleOther')) {
  el.addEventListener('change', () => S.draft && refreshTitle());
}

// ---------- draft ----------
function validate({ needNotes = true } = {}) {
  const errs = [];
  if (!S.project) errs.push('Choose a project.');
  if (!priority()) errs.push('Choose a priority (P0–P3).');
  if (!moduleValue()) errs.push('Choose a module.');
  if (needNotes && !$('actual').value.trim()) errs.push('Describe what happened (a line is enough).');
  if (trWanted() && $('trCase').value.trim() && !trCase()) errs.push('Pick the test case from the list in the Test Run box, or leave it empty to add a finding.');
  $('formErr').textContent = errs.join(' ');
  $('formErr').classList.toggle('hidden', !errs.length);
  return !errs.length;
}

function selectedCalls() {
  return S.calls.filter((c) => S.checked.has(c.id));
}
function selectedConsole() {
  return S.consoleAll.filter((c) => S.consoleChecked.has(c.id)).sort((a, b) => a.ts - b.ts);
}

$('draft').addEventListener('click', () => draftWithClaude());
$('regen').addEventListener('click', () => (S.draft?.skipped ? draftSkip() : draftWithClaude()));
$('skipClaude').addEventListener('click', draftSkip);

async function draftWithClaude() {
  if (!validate()) return;
  const btn = $('draft');
  btn.disabled = true;
  $('regen').disabled = true;
  const model = $('draftModel').value;
  const effort = $('draftEffort').value;
  const detail = $('draftDetail').value;
  $('draftState').textContent = `Asking Claude (${MODEL_LABELS[model] || model}, effort ${effort}, ${detail})…`;
  const session = new HostSession();
  try {
    const halt = S.report.haltWall;
    // Ticked calls always go into the issue body (buildBody). Claude reads them only when allowed.
    const apisToClaude = $('claudeApis').checked;
    const sel = apisToClaude ? selectedCalls() : [];
    let screenshotName = null;
    if ($('claudeShot').checked && S.shots[0]) {
      screenshotName = shotName(0, S.shots[0].mime);
      await stageBlob(session, S.report.id, screenshotName, S.shots[0].blob);
    }
    const res = await session.request(
      'draftText',
      {
        reportId: S.report.id,
        projectTitle: S.project.boardTitle,
        repo: S.project.repo,
        module: moduleValue(),
        label: label(),
        pageUrl: S.report.pageUrl,
        notes: { actual: $('actual').value, expected: $('expected').value, extra: $('extra').value },
        selectedApis: sel.map((c) => ({ id: c.aid, summary: summarizeCall(c, { haltWall: halt }) })),
        detail,
        apiDetails: detail === 'detailed' ? sel.map((c) => ({ id: c.aid, text: condenseCall(c) })) : [],
        otherFailures: apisToClaude ? S.calls.filter((c) => c.failed && !S.checked.has(c.id)).map((c) => ({ id: c.aid, summary: summarizeCall(c, { haltWall: halt }) })) : [],
        consoleErrors: selectedConsole().map((c) => c.message),
        allowScreenshot: Boolean(screenshotName),
        screenshotName,
        model,
        effort,
        skillPath: S.settings.claude.skillPath,
        tempDays: S.settings.housekeeping.tempDays,
      },
      (m) => ($('draftState').textContent = m),
    );
    S.draft = res.draft;
    const record = {
      ts: Date.now(),
      project: S.project.boardTitle,
      model: res.usage.model,
      modelLabel: prettyModel(res.usage.model),
      effort: res.requested.effort,
      totalInput: res.usage.totalInput,
      outputTokens: res.usage.outputTokens,
      durationMs: res.usage.durationMs,
      turns: res.usage.turns,
      thinkingTokens: res.usage.thinkingTokens,
      models: res.usage.models,
      cacheWrite1h: res.usage.cacheWrite1h,
      detail: res.requested.detail,
      screenshot: res.requested.screenshot,
    };
    await put('usage', record);
    S.usage = { ...res.usage, effort: res.requested.effort, detail: res.requested.detail, cost: costOfUsageRecord(record) };
    S.related = new Set(res.draft.relatedApiIds || []);
    renderCalls();
    showPreview();
    $('draftState').textContent = '';
    findDupes(res.draft.keywords);
  } catch (e) {
    $('draftState').innerHTML = `<span class="pill bad">Draft failed</span> ${esc(e.message)}${fixHtml(e.fix)}<div class="small muted">You can still use “Skip Claude”.</div>`;
  } finally {
    session.close();
    btn.disabled = false;
    $('regen').disabled = false;
  }
}

const STOP = new Set('the a an and or but of to in on for with when after before is are was were be it this that not no cannot cant does doesnt dont from at by as page screen error issue'.split(' '));
function keywordsFrom(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9_]{4,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 4);
}

function draftSkip() {
  if (!validate()) return;
  const actual = $('actual').value.trim();
  const extra = $('extra').value.trim();
  let first = actual.split(/(?<=[.!?;])\s|\n/)[0].replace(/[.;:,\s]+$/, '');
  if (first.length > 80) first = first.slice(0, 80).replace(/\s+\S*$/, '');
  S.draft = {
    skipped: true,
    title: first,
    // Without Claude, avoid repeating the same text under two headings.
    description: extra || actual,
    actual: extra ? actual : '',
    expected: $('expected').value.trim(),
    keywords: keywordsFrom(first),
    relatedApiIds: [],
    question: '',
  };
  S.usage = null;
  S.related = new Set();
  renderCalls();
  showPreview();
  findDupes(S.draft.keywords);
}

function refreshTitle() {
  if (!S.draft || !S.project) return;
  $('title').value = buildTitle({
    priority: priority(),
    priorityMode: S.project.priority?.mode,
    envPrefix: S.project.envPrefix,
    module: moduleValue(),
    shortTitle: stripKnownPrefix(S.draft.title, { envPrefix: S.project.envPrefix, module: moduleValue() }),
  });
}

function attachmentNames() {
  const shots = S.shots.map((s, i) => shotName(i, s.mime));
  const video = $('videoInclude').checked && S.clip.mediaId ? 'recording.mp4' : null;
  return { shots, video };
}

function rebuildBody(force = false) {
  if (!S.draft) return;
  if (S.bodyDirty && !force) {
    $('rebuild').classList.remove('hidden');
    return;
  }
  const { shots, video } = attachmentNames();
  const { body, warnings } = buildBody({
    description: S.draft.description,
    actual: S.draft.actual,
    expected: S.draft.expected,
    apiCalls: selectedCalls(),
    consoleEntries: selectedConsole(),
    screenshots: shots,
    video,
    truncateKB: S.settings.network.truncateKB,
  });
  $('body').value = body;
  if (!$('review').classList.contains('hidden')) $('filingTo').textContent = filingSummary();
  S.bodyDirty = false;
  $('rebuild').classList.add('hidden');
  $('bodyWarn').textContent = warnings.join(' ');
  $('bodyWarn').classList.toggle('hidden', !warnings.length);
  renderBody();
}

function resolveMedia(src) {
  const name = src.replace(/^\.\//, '');
  if (name === 'recording.mp4') return S.clip.url;
  const i = S.shots.findIndex((s, idx) => shotName(idx, s.mime) === name);
  return i >= 0 ? S.shots[i].url : null;
}
function renderBody() {
  const root = $('bodyRendered');
  root.innerHTML = renderMarkdown($('body').value, { resolveMedia });
  collapseApiBlocks(root);
}

/** Preview only: each API call (heading line + cURL + response) folds into a <details>. */
function collapseApiBlocks(root) {
  const h = [...root.querySelectorAll('h3')].find((x) => /^API Details$/i.test(x.textContent.trim()));
  if (!h) return;
  let node = h.nextElementSibling;
  while (node && node.tagName !== 'H3') {
    if (node.tagName === 'P') {
      const details = document.createElement('details');
      details.className = 'api-block';
      const summary = document.createElement('summary');
      summary.innerHTML = node.innerHTML;
      details.append(summary);
      let next = node.nextElementSibling;
      while (next && next.tagName === 'PRE') {
        const after = next.nextElementSibling;
        details.append(next);
        next = after;
      }
      node.replaceWith(details);
      node = next;
    } else node = node.nextElementSibling;
  }
}

function showReview() {
  $('main').classList.add('hidden');
  $('review').classList.remove('hidden');
  window.scrollTo({ top: 0 });
}
function showEdit() {
  $('review').classList.add('hidden');
  $('main').classList.remove('hidden');
}
$('back').addEventListener('click', showEdit);

function filingSummary() {
  if (!S.project) return '';
  const it = $('iteration').selectedOptions[0];
  const parts = [
    `${S.project.boardTitle} → ${S.project.repo}`,
    priority(),
    label(),
    $('assignee').value.trim() ? `@${$('assignee').value.trim()}` : 'unassigned',
    $('status').selectedOptions[0]?.textContent || '',
    !$('iterField').classList.contains('hidden') && it ? it.textContent.replace(/ ·.*$/, '') : '',
    $('videoInclude').checked && S.clip.mediaId ? `${Math.round(S.clip.durationMs / 1000)} s clip` : '',
  ].filter(Boolean);
  return `Filing to ${parts.join(' · ')}`;
}

function showPreview() {
  showReview();
  showTestRunSummary();
  $('filingTo').textContent = filingSummary();
  refreshTitle();
  S.bodyDirty = false;
  rebuildBody(true);
  $('claudeQ').classList.toggle('hidden', !S.draft.question);
  $('claudeQ').textContent = S.draft.question ? `Claude asks: ${S.draft.question} Add it to your notes and Regenerate, or file as is.` : '';
  $('usage').textContent = S.usage
    ? `${prettyModel(S.usage.model)} · ${S.usage.detail || 'detailed'} · effort ${S.usage.effort} · ${kTok(S.usage.totalInput)} in / ${kTok(S.usage.outputTokens)} out · ${S.usage.turns || 1} turn${(S.usage.turns || 1) > 1 ? 's' : ''} · ${(S.usage.durationMs / 1000).toFixed(1)} s · ${formatUsd(S.usage.cost?.usd)} API-equivalent`
    : 'Written without Claude (no tokens used)';
  $('result').classList.add('hidden');
  $('progress').innerHTML = '';
  $('file').disabled = false;
}

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('[data-view]')) x.classList.toggle('active', x === b);
    const raw = b.dataset.view === 'raw';
    $('body').classList.toggle('hidden', !raw);
    $('bodyRendered').classList.toggle('hidden', raw);
    if (!raw) renderBody();
  });
}
$('body').addEventListener('input', () => (S.bodyDirty = true));
$('rebuild').addEventListener('click', () => rebuildBody(true));

async function findDupes(keywords) {
  $('dupes').innerHTML = '';
  if (!keywords?.length || !S.project) return;
  $('dupes').innerHTML = '<div class="muted small">Checking for similar open issues…</div>';
  try {
    const r = await callHost('findDuplicates', { repo: S.project.repo, keywords });
    $('dupes').innerHTML = r.candidates.length
      ? `<div class="notice warn small"><b>Possible duplicates</b> (open issues matching “${esc(keywords.slice(0, 3).join(' '))}”) — check before filing:<ul>${r.candidates
          .map((c) => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener">#${c.number}</a> ${esc(c.title)}</li>`)
          .join('')}</ul></div>`
      : '<div class="muted small">No similar open issues found.</div>';
  } catch (e) {
    $('dupes').innerHTML = `<div class="muted small">Duplicate check skipped: ${esc(e.message)}</div>`;
  }
}

// ---------- file ----------
function boardParams() {
  const p = S.project;
  const prio = priority();
  const board = {
    owner: p.owner,
    projectNumber: p.number,
    projectId: p.projectId,
    status: p.statusFieldId && $('status').value ? { fieldId: p.statusFieldId, optionId: $('status').value } : null,
    priority:
      p.priority?.mode === 'board' || p.priority?.mode === 'issueField'
        ? { mode: p.priority.mode, fieldId: p.priority.fieldId, optionId: p.priority.mapping?.[prio]?.id || null }
        : { mode: 'title' },
    iteration: p.iterationFieldId && $('iteration').value ? { fieldId: p.iterationFieldId, iterationId: $('iteration').value } : null,
  };
  return board;
}

function logProgress(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  $('progress').append(li);
}

$('file').addEventListener('click', fileIssue);

async function fileIssue() {
  if (!validate({ needNotes: false })) return;
  const title = $('title').value.trim();
  if (!title) return alert('The title is empty.');
  const { shots, video } = attachmentNames();
  const cap = S.settings.recording.capMB * 1048576;
  if (video) {
    $('file').disabled = true;
    const ok = await ensureClipMatchesSlider();
    $('file').disabled = false;
    if (!ok) return alert('The clip could not be rebuilt to match the slider. Move the slider again, or untick “Attach clip”.');
  }
  if (video && S.clip.size > cap) return alert(`The clip is ${fmtMB(S.clip.size)}, over your ${S.settings.recording.capMB} MB cap. Shorten it or untick “Attach clip”.`);
  const prio = priority();
  if (S.project.priority?.mode !== 'title' && !S.project.priority?.mapping?.[prio]) {
    if (!confirm(`${prio} isn't mapped to an option on this board, so Priority won't be set. File anyway?`)) return;
  }
  $('file').disabled = true;
  $('progress').innerHTML = '';
  $('result').classList.add('hidden');
  const session = new HostSession();
  try {
    const total = S.shots.reduce((s, x) => s + x.blob.size, 0) + (video ? S.clip.blob.size : 0);
    if (video) logProgress(`Attaching a ${Math.round(S.clip.durationMs / 1000)} s clip (${fmtMB(S.clip.size)}).`);
    if (total) logProgress(`Handing ${fmtMB(total)} of attachments to the helper…`);
    for (let i = 0; i < S.shots.length; i++) await stageBlob(session, S.report.id, shots[i], S.shots[i].blob);
    if (video) await stageBlob(session, S.report.id, video, S.clip.blob);
    const res = await session.request(
      'fileIssue',
      {
        reportId: S.report.id,
        repo: S.project.repo,
        title,
        body: $('body').value,
        label: label(),
        assignee: $('assignee').value.trim(),
        defaultAssignee: S.project.defaultAssignee,
        attachments: [...shots, ...(video ? [video] : [])],
        board: boardParams(),
        tempDays: S.settings.housekeeping.tempDays,
        dryRun: DRY_RUN,
      },
      logProgress,
    );
    if (res.dryRun) {
      $('result').innerHTML = `<div class="notice small"><b>Dry run</b> — nothing was filed. Commands:</div><pre class="mono small">${esc(res.commands.join('\n\n'))}</pre>`;
      $('result').classList.remove('hidden');
      $('file').disabled = false;
      return;
    }
    const filed = { url: res.url, number: res.number, at: Date.now(), warnings: res.warnings, fields: res.fields, board: boardParams() };
    S.report.filed = filed;
    await put('reports', S.report);
    showFiled(filed);
    if (canNote(S.testRun) && trWanted()) noteInTestRun(filed);
  } catch (e) {
    $('result').innerHTML = `<div class="notice bad"><b>Not filed.</b> ${esc(e.message)}${fixHtml(e.fix)}</div>`;
    $('result').classList.remove('hidden');
    $('file').disabled = false;
  } finally {
    session.close();
  }
}

// ---------- Test Run ----------
// When Test Run is reachable (on this computer, or a teammate's shared one), the form offers to
// add the bug there once filed: in the test suite (workbook › tab) picked here, against a test
// case (marked failed, with the issue linked) or, with no test case, as a finding.
async function refreshTestRun() {
  const st = await testRunStatus(S.settings);
  S.testRun = st;
  if (st && st.base !== testRunBase(S.settings)) {
    // A shared Test Run answered at a new address (found in its gist): keep it for next time.
    S.settings.testRun.url = st.base;
    await saveSettings(S.settings);
  }
  const filed = !!S.report?.filed;
  $('trKey').classList.toggle('hidden', !(st && st.needsKey) || filed);
  const show = canNote(st) && !filed;
  $('trBox').classList.toggle('hidden', !show);
  if (!show) return;
  const { suites, current } = await listSuites(S.settings, st.base);
  S.trSuites = suites;
  const { testRunNote, testRunSuite } = await chrome.storage.local.get(['testRunNote', 'testRunSuite']);
  const chosen = pickSuite(suites, testRunSuite, current || st);
  // Two pickers: the workbook, then one of its test suites
  const books = [...new Set(suites.map((s) => s.book))];
  $('trBook').innerHTML = books.map((b) => `<option value="${esc(b)}"${chosen && b === chosen.book ? ' selected' : ''}>${esc(String(b).replace(/\.xlsx$/i, ''))}</option>`).join('');
  $('trBook').disabled = books.length < 2;
  fillTrSuites(chosen);
  $('trWho').textContent = isLocalBase(st.base) ? '' : `(shared${st.me?.name ? `, as ${st.me.name}` : ''})`;
  $('trNoteChk').checked = testRunNote === true;
  $('trBox').classList.toggle('off', !$('trNoteChk').checked);
  if (!suites.length) {
    $('trFields').classList.add('hidden');
    trHint('Test Run has no test suite yet: set one up in its Setup first.', true);
    return;
  }
  await loadTrCases();
}

function trWanted() {
  return !$('trBox').classList.contains('hidden') && $('trNoteChk').checked && !!S.trSuites?.length;
}
function trSuite() {
  return (S.trSuites || []).find((s) => s.book === $('trBook').value && s.tab === $('trSuite').value) || null;
}
/** The test suites of the workbook picked, with want (a suite of it) or its first one selected. */
function fillTrSuites(want) {
  const book = $('trBook').value;
  const tabs = (S.trSuites || []).filter((s) => s.book === book);
  const pick = tabs.find((s) => want && s.tab === want.tab && s.book === want.book) || tabs[0];
  $('trSuite').innerHTML = tabs.map((s) => `<option value="${esc(s.tab)}"${s === pick ? ' selected' : ''}>${esc(s.tab)}</option>`).join('');
  $('trSuite').disabled = tabs.length < 2;
}
function trCase() {
  return matchCase(S.trCases?.cases, $('trCase').value);
}
function trHint(text, bad = false) {
  $('trHint').textContent = text;
  $('trHint').classList.toggle('bad', bad);
}

/** The picked suite's test cases, for the test case picker. */
async function loadTrCases() {
  const suite = trSuite();
  S.trCases = { cases: [], cycle: '' };
  $('trCases').innerHTML = '';
  if (!suite) return;
  const seq = (S.trSeq = (S.trSeq || 0) + 1);
  const res = await listCases(S.settings, S.testRun.base, suite);
  if (seq !== S.trSeq) return; // another suite was picked meanwhile
  S.trCases = res;
  $('trCases').innerHTML = res.cases.map((c) => `<option value="${esc(caseLabel(c))}">${esc(c.status || 'not run')}</option>`).join('');
  updateTrHint();
}

function updateTrHint() {
  const text = $('trCase').value.trim();
  const c = trCase();
  const cycle = S.trCases?.cycle ? ` in cycle ${S.trCases.cycle}` : '';
  if (!text) trHint('No test case: it is added as a finding, to be written up as a test case later.');
  else if (!c) trHint(`No test case like "${text}" in this suite. Pick one from the list, or leave it empty.`, true);
  else if (/fail/i.test(c.status)) trHint(`${c.id || 'This case'} is already marked ${c.status}${cycle}; the issue is linked to it.`);
  else trHint(`${c.id || 'This case'} will be marked failed${cycle}, with the issue linked to it.`);
}

/** On the review screen, what will happen in Test Run once filed. */
function showTestRunSummary() {
  const on = trWanted() && !S.report?.filed;
  $('trSummary').classList.toggle('hidden', !on);
  if (!on) return;
  const c = trCase();
  const suite = trSuite();
  $('trSummary').textContent = c
    ? `Then in Test Run: ${c.id || 'the case'} marked failed, with this issue linked (${suite.label}).`
    : `Then in Test Run: a finding in ${suite.label}.`;
}

$('trNoteChk').addEventListener('change', () => {
  chrome.storage.local.set({ testRunNote: $('trNoteChk').checked });
  $('trBox').classList.toggle('off', !$('trNoteChk').checked);
});
function trPicked() {
  const s = trSuite();
  if (s) chrome.storage.local.set({ testRunSuite: { book: s.book, tab: s.tab } });
  $('trCase').value = '';
  loadTrCases();
}
$('trBook').addEventListener('change', () => { fillTrSuites(null); trPicked(); });
$('trSuite').addEventListener('change', trPicked);
$('trCase').addEventListener('input', updateTrHint);

async function noteInTestRun(filed) {
  $('trSummary').classList.add('hidden');
  const box = document.createElement('div');
  box.className = 'notice small';
  box.textContent = 'Adding it to Test Run…';
  $('result').appendChild(box);
  try {
    const suite = trSuite();
    const testCase = trCase();
    const note = buildBugNote({ title: $('title').value.trim(), filed, repo: S.project?.repo, draft: S.draft, extra: $('extra').value, module: moduleValue(), pageUrl: S.report.pageUrl, suite, testCase, priority: priority() });
    const res = await noteBugInTestRun(S.settings, note, { base: S.testRun.base });
    box.className = 'notice ok small';
    const open = `<a href="${esc(consoleLink(S.testRun, S.testRun.base, res.kind === 'case' ? 'issues' : 'findings'))}" target="_blank" rel="noopener">Open Test Run ↗</a>`;
    box.innerHTML = res.kind === 'case'
      ? `In Test Run, <b>${esc(res.key)}</b> is marked ${esc(res.status || 'failed')}${res.cycle ? ` in cycle ${esc(res.cycle)}` : ''}, with this issue linked (${esc(whereLabel({ book: res.book, tab: res.tab }))}). ${open}`
      : `Added to Test Run as finding <b>${esc(res.key)}</b> (${esc(whereLabel(res))}). ${open}`;
    S.report.filed.testRun = res;
    await put('reports', S.report);
  } catch (e) {
    box.className = 'notice warn small';
    box.textContent = `The issue is filed, but it could not be added to Test Run: ${e.message}`;
  }
}

function showFiled(filed) {
  showReview();
  $('file').disabled = true;
  $('file').textContent = 'Filed';
  const failed = filed.fields?.failed || [];
  const parts = [`<div class="notice ok"><a class="link-big" href="${esc(filed.url)}" target="_blank" rel="noopener">Filed #${filed.number} ↗</a></div>`];
  for (const w of filed.warnings || []) parts.push(`<div class="notice warn small">${esc(w)}</div>`);
  if (failed.length) {
    parts.push(
      `<div class="notice bad small"><b>Some board fields were not set:</b><ul>${failed.map((f) => `<li>${esc(f.field)}: ${esc(f.message)}${fixHtml(f.fix)}</li>`).join('')}</ul>
       <button id="retryFields">Retry remaining fields</button> <span class="muted">(the issue is not created again)</span></div>`,
    );
  }
  parts.push('<div class="row actions" id="recActions"><span class="grow"></span><button id="closeTab">Close</button></div><div id="recMsg" class="small"></div>');
  $('result').innerHTML = parts.join('');
  $('result').classList.remove('hidden');
  $('retryFields')?.addEventListener('click', async () => {
    $('retryFields').disabled = true;
    try {
      const r = await callHost('setFields', { ...filed.board, issueUrl: filed.url, itemId: filed.fields?.itemId || null }, logProgress);
      filed.fields = { ...r, failed: r.failed };
      S.report.filed = filed;
      await put('reports', S.report);
      showFiled(filed);
    } catch (e) {
      logProgress(`Retry failed: ${e.message}`);
      $('retryFields').disabled = false;
    }
  });
  $('closeTab').addEventListener('click', () => window.close());
  renderRecActions();
}

/** Recording buttons after filing: only offer Resume/Stop when a recording is actually live. */
async function renderRecActions() {
  const box = $('recActions');
  if (!box) return;
  box.querySelectorAll('[data-rec]').forEach((b) => b.remove());
  const st = (await chrome.runtime.sendMessage({ type: 'rec-status' }).catch(() => null)) || { state: 'idle' };
  const btn = (id, label, cls = '') => {
    const b = document.createElement('button');
    b.dataset.rec = id;
    b.className = cls;
    b.textContent = label;
    box.prepend(b);
    return b;
  };
  if (st.state === 'paused' || st.state === 'recording') {
    btn('stop', '■ Stop recording').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'rec-stop' });
      $('recMsg').textContent = 'Recording stopped.';
      renderRecActions();
    });
    if (st.state === 'paused') {
      btn('resume', '● Resume recording', 'rec').addEventListener('click', async () => {
        const r = await chrome.runtime.sendMessage({ type: 'rec-resume' });
        if (r?.ok && r.state === 'recording') {
          $('recMsg').innerHTML = '<span class="pill ok">● Recording resumed</span> The toolbar badge shows REC.';
          renderRecActions();
          // Back to the app you were testing; this tab stays open.
          if (S.report.tabId != null) {
            try {
              const t = await chrome.tabs.update(S.report.tabId, { active: true });
              await chrome.windows.update(t.windowId, { focused: true });
            } catch {}
          }
        } else {
          $('recMsg').innerHTML = `<span class="pill bad">Could not resume</span> ${esc(r?.error || 'The Recorder window is not open.')}`;
        }
      });
    } else {
      $('recMsg').innerHTML = '<span class="pill ok">● Recording</span>';
    }
  } else {
    btn('start', '● Start recording').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'rec-start' }));
  }
}


// ---------- Update Issue (comment on an existing issue) ----------
const U = { project: null, meta: null, issue: null, lookupSeq: 0, lookupKey: '', beforePolish: null };

function isUpdateMode() {
  return params.get('mode') === 'update' || S.report?.mode === 'update';
}

/** Ticked calls, console errors, screenshots or the clip changed. */
function evidenceChanged() {
  if (S.draft) rebuildBody();
  if (isUpdateMode()) renderUpdatePreview();
}

async function getMeta(p, force = false) {
  const key = `meta:${p.id}`;
  let meta = (await chrome.storage.local.get(key))[key];
  if (force || !meta || Date.now() - meta.fetchedAt > META_TTL || !('boardAssignees' in meta)) {
    meta = await callHost('projectMeta', { boardUrl: p.boardUrl, repo: p.repo });
    await chrome.storage.local.set({ [key]: meta });
  }
  return meta;
}

function initUpdate() {
  document.title = `Update Issue · ${S.report.pageTitle || 'Bug Reporter'}`;
  document.querySelector('header.top h1').textContent = 'Update issue';
  for (const c of document.querySelectorAll('.form > .card')) c.classList.toggle('hidden', c.id !== 'updateCard');
  const match = matchProject(S.projects, S.report.pageUrl);
  $('uProject').innerHTML =
    `<option value="">${S.projects.length ? 'Choose project…' : 'No projects set up: add one in Settings'}</option>` +
    S.projects.map((p) => `<option value="${esc(p.id)}" ${match?.id === p.id ? 'selected' : ''}>${esc(p.boardTitle)} → ${esc(p.repo)}</option>`).join('');
  $('uModel').value = S.settings.claude.model || 'sonnet';
  $('uEffort').value = S.settings.claude.effort || 'low';
  $('uDetail').value = S.settings.claude.detail || 'detailed';
  if (match) uSelectProject(match.id);
  setUpdateButtons();
  renderUpdatePreview();
}

async function uSelectProject(id) {
  U.project = S.projects.find((p) => p.id === id) || null;
  U.meta = null;
  U.issue = null;
  $('uIssueCard').classList.add('hidden');
  $('uStatus').innerHTML = '<option value="">No change</option>';
  setUpdateButtons();
  renderUpdatePreview();
  if (!U.project) {
    $('uMeta').textContent = '';
    return;
  }
  $('uMeta').textContent = 'Loading board…';
  try {
    const meta = await getMeta(U.project);
    if (U.project?.id !== id) return;
    U.meta = meta;
    $('uStatus').innerHTML =
      '<option value="">No change</option>' + (meta.board.status?.options || []).map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    $('uMeta').textContent = `${meta.board.title} · comments go to ${U.project.repo}`;
  } catch (e) {
    $('uMeta').innerHTML = `<span class="pill bad">Could not load board</span> ${esc(e.message)}${fixHtml(e.fix)}`;
  }
  if ($('uIssue').value.trim()) lookupIssue({ force: true });
}

async function lookupIssue({ force = false } = {}) {
  const raw = $('uIssue').value.trim();
  // Enter, then leaving the field, would look the same issue up twice and redraw the
  // card mid-click; skip a repeat lookup of the same issue for the same project.
  const key = `${U.project?.id || ''}|${raw}`;
  if (!force && raw && key === U.lookupKey) return;
  U.lookupKey = key;
  U.issue = null;
  setUpdateButtons();
  if (!raw || !U.project) {
    $('uIssueCard').classList.toggle('hidden', !raw);
    if (raw) $('uIssueCard').innerHTML = '<span class="muted">Choose the project first.</span>';
    return;
  }
  const seq = ++U.lookupSeq;
  $('uIssueCard').classList.remove('hidden');
  $('uIssueCard').innerHTML = '<span class="muted">Looking up the issue…</span>';
  try {
    const info = await callHost('getIssue', { repo: U.project.repo, issue: raw, projectId: U.project.projectId });
    if (seq !== U.lookupSeq) return;
    U.issue = info;
    const state =
      info.state === 'OPEN'
        ? '<span class="pill open">Open</span>'
        : `<span class="pill closed">Closed${info.stateReason ? ` · ${esc(info.stateReason.toLowerCase().replace(/_/g, ' '))}` : ''}</span>`;
    $('uIssueCard').innerHTML = `<div><a href="${esc(info.url)}" target="_blank" rel="noopener">#${info.number} ${esc(info.title)} ↗</a></div>
      <div class="row small">${state}<span>Status: <b>${info.status ? esc(info.status.name) : 'not on this board'}</b></span>
      <span class="muted">${info.assignees.length ? info.assignees.map((a) => '@' + esc(a)).join(', ') : 'unassigned'}</span></div>`;
  } catch (e) {
    if (seq !== U.lookupSeq) return;
    U.lookupKey = ''; // allow trying again
    $('uIssueCard').innerHTML = `<span class="pill bad">Not found</span> ${esc(e.message)}${fixHtml(e.fix)}`;
  }
  setUpdateButtons();
  renderUpdatePreview();
}

function uResult() {
  return document.querySelector('input[name=uResult]:checked')?.value || '';
}

function buildUpdateBody() {
  const { shots, video } = attachmentNames();
  return buildComment({
    result: uResult(),
    envPrefix: U.project?.envPrefix || '',
    comment: $('uText').value,
    apiCalls: selectedCalls(),
    consoleEntries: selectedConsole(),
    screenshots: shots,
    video,
    truncateKB: S.settings.network.truncateKB,
  });
}

let uPreviewTimer = null;
function renderUpdatePreview() {
  if (!isUpdateMode()) return;
  clearTimeout(uPreviewTimer);
  uPreviewTimer = setTimeout(() => {
    const { body, warnings } = buildUpdateBody();
    const root = $('uPreview');
    root.innerHTML = body.trim()
      ? renderMarkdown(body, { resolveMedia })
      : '<span class="muted">Write a comment, pick a result, or tick API calls to see the comment here.</span>';
    collapseApiBlocks(root);
    $('uWarn').textContent = warnings.join(' ');
    $('uWarn').classList.toggle('hidden', !warnings.length);
  }, 150);
}

function setUpdateButtons() {
  const ready = Boolean(U.project && U.issue) && !S.report?.updated;
  const closed = U.issue?.state === 'CLOSED';
  $('uSend').disabled = !ready;
  $('uClose').disabled = !ready || closed;
  $('uCloseReason').disabled = !ready || closed;
  $('uClose').title = closed ? 'This issue is already closed' : '';
}

function uError(msg) {
  $('uErr').innerHTML = msg || '';
  $('uErr').classList.toggle('hidden', !msg);
}

function uLog(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  $('uProgress').append(li);
}

$('uProject').addEventListener('change', () => uSelectProject($('uProject').value));
$('uIssue').addEventListener('change', () => lookupIssue());
$('uIssue').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    lookupIssue();
  }
});
$('uLookup').addEventListener('click', () => lookupIssue({ force: true }));
for (const r of document.querySelectorAll('input[name=uResult]')) r.addEventListener('change', renderUpdatePreview);
$('uText').addEventListener('input', renderUpdatePreview);
$('uSend').addEventListener('click', () => submitUpdate(null));
$('uClose').addEventListener('click', () => submitUpdate($('uCloseReason').value));

$('uPolish').addEventListener('click', async () => {
  uError('');
  if (!U.project) return uError('Choose a project first.');
  const sel = selectedCalls();
  if (!$('uText').value.trim() && !uResult() && !sel.length) return uError('Write a few words, pick a result or tick an API call first.');
  const btn = $('uPolish');
  btn.disabled = true;
  const model = $('uModel').value;
  const effort = $('uEffort').value;
  const detail = $('uDetail').value;
  $('uPolishState').textContent = `Asking Claude (${MODEL_LABELS[model] || model}, effort ${effort}, ${detail})…`;
  const session = new HostSession();
  try {
    const halt = S.report.haltWall;
    const res = await session.request(
      'draftComment',
      {
        reportId: S.report.id,
        projectTitle: U.project.boardTitle,
        repo: U.project.repo,
        issue: U.issue ? { number: U.issue.number, title: U.issue.title, state: U.issue.state } : null,
        pageUrl: S.report.pageUrl,
        result: uResult() ? RESULTS[uResult()].text : '',
        notes: $('uText').value,
        selectedApis: sel.map((c) => ({ id: c.aid, summary: summarizeCall(c, { haltWall: halt }) })),
        apiDetails: detail === 'detailed' ? sel.map((c) => ({ id: c.aid, text: condenseCall(c) })) : [],
        consoleErrors: selectedConsole().map((c) => c.message),
        detail,
        model,
        effort,
        skillPath: S.settings.claude.skillPath,
      },
      (m) => ($('uPolishState').textContent = m),
    );
    if (!res.draft.comment) throw new Error('Claude returned an empty comment.');
    U.beforePolish = $('uText').value;
    $('uText').value = res.draft.comment;
    const record = {
      ts: Date.now(),
      project: U.project.boardTitle,
      model: res.usage.model,
      modelLabel: prettyModel(res.usage.model),
      effort: res.requested.effort,
      totalInput: res.usage.totalInput,
      outputTokens: res.usage.outputTokens,
      durationMs: res.usage.durationMs,
      turns: res.usage.turns,
      models: res.usage.models,
      cacheWrite1h: res.usage.cacheWrite1h,
      detail: `${res.requested.detail} comment`,
    };
    await put('usage', record);
    const cost = costOfUsageRecord(record);
    $('uPolishState').innerHTML = `${esc(prettyModel(res.usage.model))} · effort ${esc(res.requested.effort)} · ${kTok(res.usage.totalInput)} in / ${kTok(
      res.usage.outputTokens,
    )} out · ${(res.usage.durationMs / 1000).toFixed(1)} s · ${formatUsd(cost.usd)} API-equivalent. Edit it freely before posting. <button class="link" id="uUndo">Undo polish</button>`;
    $('uUndo').addEventListener('click', () => {
      if (U.beforePolish == null) return;
      $('uText').value = U.beforePolish;
      U.beforePolish = null;
      $('uPolishState').textContent = 'Restored your original text.';
      renderUpdatePreview();
    });
    renderUpdatePreview();
  } catch (e) {
    $('uPolishState').innerHTML = `<span class="pill bad">Polish failed</span> ${esc(e.message)}${fixHtml(e.fix)}`;
  } finally {
    session.close();
    btn.disabled = false;
  }
});

function updateParams(close, statusOpt) {
  const { shots, video } = attachmentNames();
  return {
    reportId: S.report.id,
    repo: U.project.repo,
    issue: String(U.issue.number),
    attachments: [...shots, ...(video ? [video] : [])],
    close: close || null,
    status: statusOpt,
    board: {
      owner: U.project.owner,
      projectNumber: U.project.number,
      projectId: U.project.projectId,
      statusFieldId: U.meta?.board?.status?.fieldId || U.project.statusFieldId,
    },
    itemId: U.issue.boardItemId,
    tempDays: S.settings.housekeeping.tempDays,
    dryRun: DRY_RUN,
  };
}

async function submitUpdate(close) {
  uError('');
  if (!U.project) return uError('Choose a project.');
  if (!U.issue) return uError('Look up the issue first: type its number and press Enter.');
  const { shots, video } = attachmentNames();
  if (!$('uText').value.trim() && !uResult() && !selectedCalls().length && !shots.length && !video) {
    return uError('Nothing to post yet: write a comment, pick a result, or attach evidence.');
  }
  const statusOpt = $('uStatus').value ? { optionId: $('uStatus').value, name: $('uStatus').selectedOptions[0].textContent } : null;
  if (statusOpt && !(U.meta?.board?.status?.fieldId || U.project.statusFieldId)) return uError('This board has no Status field.');
  for (const b of ['uSend', 'uClose', 'uCloseReason']) $(b).disabled = true;
  $('uProgress').innerHTML = '';
  $('uResultBox').classList.add('hidden');
  const session = new HostSession();
  try {
    if (video) {
      const ok = await ensureClipMatchesSlider();
      if (!ok) throw new Error('The clip could not be rebuilt to match the slider. Move the slider again, or untick “Attach clip”.');
      const cap = S.settings.recording.capMB * 1048576;
      if (S.clip.size > cap) throw new Error(`The clip is ${fmtMB(S.clip.size)}, over your ${S.settings.recording.capMB} MB cap. Shorten it or untick “Attach clip”.`);
      uLog(`Attaching a ${Math.round(S.clip.durationMs / 1000)} s clip (${fmtMB(S.clip.size)}).`);
    }
    const { body } = buildUpdateBody();
    for (let i = 0; i < S.shots.length; i++) await stageBlob(session, S.report.id, shots[i], S.shots[i].blob);
    if (video) await stageBlob(session, S.report.id, video, S.clip.blob);
    const p = updateParams(close, statusOpt);
    const res = await session.request('updateIssue', { ...p, body }, uLog);
    if (res.dryRun) {
      $('uResultBox').innerHTML = `<div class="notice small"><b>Dry run</b>: nothing was posted. Commands:</div><pre class="mono small">${esc(res.commands.join('\n\n'))}</pre>`;
      $('uResultBox').classList.remove('hidden');
      setUpdateButtons();
      return;
    }
    const done = { ...res, at: Date.now(), statusName: statusOpt?.name || null, close: close || null, params: p };
    S.report.updated = done;
    await put('reports', S.report);
    showUpdated(done);
  } catch (e) {
    uError(`<b>Not posted.</b> ${esc(e.message)}${fixHtml(e.fix)}`);
    setUpdateButtons();
  } finally {
    session.close();
  }
}

function showUpdated(u) {
  if (!isUpdateMode()) return;
  for (const b of ['uSend', 'uClose', 'uCloseReason', 'uPolish']) $(b).disabled = true;
  const failed = u.fields?.failed || [];
  const doneList = u.fields?.done || [];
  const parts = [`<div class="notice ok"><a class="link-big" href="${esc(u.commentUrl)}" target="_blank" rel="noopener">Comment posted on #${u.number} ↗</a></div>`];
  const applied = [];
  if (u.statusName && doneList.includes('status')) applied.push(`Status → <b>${esc(u.statusName)}</b>`);
  if (u.close && doneList.includes('closed')) applied.push(`Closed ${u.close === 'not planned' ? 'as not planned' : 'as completed'}`);
  if (applied.length) parts.push(`<div class="small">${applied.join(' · ')}</div>`);
  for (const w of u.warnings || []) parts.push(`<div class="notice warn small">${esc(w)}</div>`);
  if (failed.length) {
    parts.push(
      `<div class="notice bad small"><b>Not done:</b><ul>${failed.map((f) => `<li>${esc(f.field)}: ${esc(f.message)}${fixHtml(f.fix)}</li>`).join('')}</ul>
       <button id="uRetry">Retry</button> <span class="muted">(the comment is not posted again)</span></div>`,
    );
  }
  parts.push('<div class="row actions" id="recActions"><span class="grow"></span><button id="uCloseTab">Close</button></div><div id="recMsg" class="small"></div>');
  $('uResultBox').innerHTML = parts.join('');
  $('uResultBox').classList.remove('hidden');
  $('uCloseTab').addEventListener('click', () => window.close());
  $('uRetry')?.addEventListener('click', async () => {
    $('uRetry').disabled = true;
    const failedFields = new Set(failed.map((f) => f.field));
    const p = { ...u.params, issueUrl: u.issueUrl, itemId: u.fields?.itemId || u.params.itemId };
    if (!failedFields.has('status') && !failedFields.has('board')) p.status = null;
    if (!failedFields.has('close')) p.close = null;
    try {
      const r = await callHost('finishUpdate', p, uLog);
      u.fields = { itemId: r.itemId || p.itemId, done: [...doneList, ...r.done], failed: r.failed };
      S.report.updated = u;
      await put('reports', S.report);
      showUpdated(u);
    } catch (e) {
      uLog(`Retry failed: ${e.message}`);
      $('uRetry').disabled = false;
    }
  });
  renderRecActions();
}

load().catch((e) => fail(`Could not load the report: ${e.message}`));
