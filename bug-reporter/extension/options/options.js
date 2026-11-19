import { getSettings, saveSettings, getProjects, saveProjects, getEnabledSites } from '../lib/settings.js';
import { callHost } from '../lib/host-client.js';
import { getAll, openDb } from '../lib/idb.js';
import { escapeHtml as esc } from '../lib/markdown.js';
import { buildTitle } from '../lib/title.js';
import { currentIteration } from '../lib/iteration.js';
import { costOfUsageRecord, formatUsd, PRICING_SOURCE, PRICING_AS_OF } from '../lib/pricing.js';
import { assigneeOptionsHtml } from '../lib/people.js';
import { testRunStatus, testRunBase, isLocalBase, parseInvite, addressFromGist, whereLabel } from '../lib/testrun.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('hidden', s.id !== `tab-${name}`);
  history.replaceState(null, '', `#${name}`);
  if (name === 'usage') renderUsage();
  if (name === 'capture') renderSites();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- copy buttons ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const el = document.getElementById(btn.dataset.copy);
  const text = el ? el.textContent : btn.dataset.copy;
  navigator.clipboard.writeText(text).then(() => {
    const t = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = t), 1200);
  });
});

function fixBlock(cmds) {
  return (cmds || [])
    .map((c, i) => {
      const id = `fix-${Math.random().toString(36).slice(2)}-${i}`;
      return /^[a-z]/.test(c)
        ? `<div class="fixcmd"><code id="${id}">${esc(c)}</code><button data-copy="${id}">Copy</button></div>`
        : `<div class="small">${esc(c)}</div>`;
    })
    .join('');
}

// ---------- setup / diagnostics ----------
function row(status, title, detail = '', fix = []) {
  const icon = { ok: '✓', bad: '✗', warn: '!' }[status];
  return `<div class="check-row ${status}"><div class="icon">${icon}</div><div><b>${esc(title)}</b>${detail ? `<div class="muted small">${detail}</div>` : ''}${fixBlock(fix)}</div></div>`;
}

async function incognitoRow() {
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  return allowed
    ? row('ok', 'Allowed in Incognito', 'Capture, recording and reports also work in Incognito windows. Data captured there is deleted when the last Incognito window closes.')
    : row(
        'warn',
        'Not allowed in Incognito (optional)',
        `To use it in Incognito windows, open the extension's details and switch on <b>Allow in Incognito</b>. <button class="link" id="openExtDetails">Open extension details</button>`,
      );
}
document.addEventListener('click', (e) => {
  if (e.target.id === 'openExtDetails') chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

async function diagnose() {
  $('diag').innerHTML = '<div class="muted">Checking…</div>';
  $('installHelp').classList.add('hidden');
  $('setupNext').classList.add('hidden');
  $('extId').textContent = chrome.runtime.id;
  try {
    const d = await callHost('diagnose', { skillPath: settings.claude.skillPath, tempDays: settings.housekeeping.tempDays });
    await chrome.storage.local.set({ lastDiagnose: { gh: d.gh, claude: { loggedIn: d.claude.loggedIn, authMethod: d.claude.authMethod }, at: Date.now() } });
    const rows = [];
    rows.push(row('ok', 'Helper connected', `version ${esc(d.host.version)} · Node ${esc(d.host.node)}`));
    if (!d.gh.found) rows.push(row('bad', 'GitHub CLI (gh) not found', '', d.gh.fix));
    else {
      rows.push(row(d.gh.hasAttach ? 'ok' : 'warn', `gh ${esc(d.gh.version || '')}`, d.gh.hasAttach ? 'Can upload screenshots and video.' : 'This version cannot upload screenshots/video.', d.gh.hasAttach ? [] : ['brew upgrade gh']));
      rows.push(
        d.gh.loggedIn && d.gh.hasProjectScope
          ? row('ok', 'gh is logged in with the project scope')
          : row('bad', d.gh.loggedIn ? 'gh login is missing the project scope' : 'gh is not logged in', 'Needed to read boards and set Status, Priority and Iteration.', d.gh.fix.filter((f) => f !== 'brew upgrade gh')),
      );
    }
    if (!d.claude.found) rows.push(row('bad', 'Claude Code not found', 'Needed only for drafting with Claude; "Skip Claude" still works.', d.claude.fix));
    else if (!d.claude.loggedIn) rows.push(row('bad', `Claude Code ${esc(d.claude.version || '')} is not signed in`, 'Sign in once in Terminal. Drafts then use your Claude subscription.', d.claude.fix));
    else {
      const method = String(d.claude.authMethod || '');
      const apiKey = /api.?key|console/i.test(method);
      rows.push(
        row(
          apiKey ? 'warn' : 'ok',
          `Claude Code ${esc(d.claude.version || '')} is signed in`,
          apiKey
            ? `Signed in with <b>${esc(method)}</b>: usage is billed to that API account. Run <code>claude auth login</code> with your Claude subscription to avoid separate billing.`
            : `Auth: ${esc(method || 'subscription')}${d.claude.subscriptionType ? ` (${esc(d.claude.subscriptionType)})` : ''}. Drafts count against your plan's usage limits; no separate bill.`,
        ),
      );
    }
    rows.push(d.skill.ok ? row('ok', 'Drafting skill found', `<code>${esc(d.skill.path)}</code>${d.skill.bundled ? ' (bundled)' : ''}`) : row('bad', 'Drafting skill file not found', `<code>${esc(d.skill.path || '')}</code>`, ['Fix the skill path in the Claude tab, or leave it empty.']));
    rows.push(await incognitoRow());
    $('diag').innerHTML = rows.join('');
    const ready = d.gh.loggedIn && d.gh.hasProjectScope;
    if (ready && !(await getProjects()).length) $('setupNext').classList.remove('hidden');
  } catch (e) {
    if (e.code === 'HOST_NOT_INSTALLED') {
      $('diag').innerHTML = row('bad', 'Helper not installed', 'The extension cannot reach the local helper yet.');
      $('installHelp').classList.remove('hidden');
    } else {
      $('diag').innerHTML = row('bad', 'Helper error', esc(e.message), e.fix);
    }
  }
}
$('recheck').addEventListener('click', diagnose);

// ---------- settings binding ----------
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setPath(obj, path, v) {
  const ks = path.split('.');
  ks.slice(0, -1).reduce((o, k) => (o[k] ||= {}), obj)[ks.at(-1)] = v;
}
for (const el of document.querySelectorAll('[data-set]')) {
  const v = getPath(settings, el.dataset.set);
  if (el.type === 'checkbox') el.checked = Boolean(v);
  else el.value = String(v ?? '');
  el.addEventListener('change', async () => {
    let val = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || (el.tagName === 'SELECT' && /^\d+$/.test(val))) {
      val = Number(val);
      if (el.min && val < Number(el.min)) val = Number(el.min);
      if (el.max && val > Number(el.max)) val = Number(el.max);
      el.value = String(val);
    }
    setPath(settings, el.dataset.set, val);
    await saveSettings(settings);
  });
}
$('openShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------- Test Run ----------
function showTestRun() {
  const t = settings.testRun || {};
  // An address set before addresses could be typed in: a port on this computer.
  $('trUrl').value = t.url || (t.port && Number(t.port) !== 5178 ? `http://127.0.0.1:${t.port}` : '');
  $('trInviteState').textContent = t.key ? `Invite saved (key …${String(t.key).slice(-4)})${t.gist ? '; the address is looked up in the gist when it changes' : ''}.` : '';
}
showTestRun();
$('trUrl').addEventListener('change', async () => {
  const v = $('trUrl').value.trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(v)) { $('trState').textContent = 'The address must start with http:// or https://.'; return; }
  settings.testRun = { ...settings.testRun, url: v };
  await saveSettings(settings);
  $('trState').textContent = 'Saved.';
});
$('trUseInvite').addEventListener('click', async () => {
  const inv = parseInvite($('trInvite').value);
  if (!inv.key) { $('trInviteState').textContent = 'That is not an invite link: it should end in #join=… . Copy the whole link.'; return; }
  let url = inv.server;
  if (!url && inv.gist) {
    $('trInviteState').textContent = 'Looking up the address…';
    url = await addressFromGist(inv.gist);
  }
  settings.testRun = { ...settings.testRun, enabled: true, key: inv.key, gist: inv.gist, url: url || settings.testRun?.url || '' };
  await saveSettings(settings);
  $('trInvite').value = '';
  showTestRun();
  if (!url) $('trInviteState').textContent += ' The shared Test Run is not reachable right now; its address is looked up again when you file a bug.';
  $('trCheck').click();
});
$('trCheck').addEventListener('click', async () => {
  $('trState').textContent = 'Checking…';
  const s = await testRunStatus(settings, { timeoutMs: 4000 });
  if (s && s.base !== testRunBase(settings)) { settings.testRun.url = s.base; await saveSettings(settings); showTestRun(); }
  const base = s?.base || testRunBase(settings);
  $('trState').textContent = settings.testRun?.enabled === false
    ? 'Switched off above.'
    : !s
      ? (isLocalBase(base) ? 'Not running. Start it with npm start in test-run-console.' : `Not reachable at ${base}. The laptop that runs it may be asleep or offline.`)
      : s.needsKey
        ? (settings.testRun?.key ? 'Connected, but the invite key no longer works. Ask for a new link.' : 'This Test Run is shared by invite: paste your invite link above.')
        : s.me?.role === 'viewer'
          ? `Connected as ${s.me.name}, view only: bugs cannot be added with this invite.`
          : `Connected${s.me && !s.me.local ? ` as ${s.me.name}` : ''}: ${whereLabel(s) || 'no workbook open yet'}.`;
});

// ---------- projects ----------
let editing = null; // project being edited
let inspected = null; // board details from the helper
let repoInfo = null;

const PRIORITY_TEXT = {
  board: (p) => `Priority is a board field (<b>${esc(p.fieldName)}</b>).`,
  issueField: (p) => `Priority is the org-level issue field <b>${esc(p.fieldName)}</b>. P0–P3 are mapped to its options:`,
  title: () => `This board has no Priority field. Priority goes at the front of the title instead, e.g. <code>[P1] …</code>.`,
};

async function renderProjects() {
  const projects = await getProjects();
  if (!projects.length) {
    $('projectList').innerHTML = '<div class="notice">No projects yet. Click <b>Add project</b> and paste a GitHub project board link.</div>';
    return;
  }
  $('projectList').innerHTML = projects
    .map(
      (p) => `<div class="project">
        <div><b>${esc(p.boardTitle)}</b> <span class="muted">→ ${esc(p.repo)}</span></div>
        <div class="actions"><button data-edit="${esc(p.id)}">Edit</button><button class="danger" data-del="${esc(p.id)}">Remove</button></div>
        <div class="meta">Title: <code>${esc(buildTitle({ priority: 'P1', priorityMode: p.priority.mode, envPrefix: p.envPrefix, module: 'Citizen', shortTitle: 'Example title' }))}</code>
        · Assignee: ${esc(p.defaultAssignee || '—')} · Status: ${esc(p.initialStatus?.name || '—')} · ${p.iterationFieldId ? 'Iteration: current' : 'No iterations'}
        ${p.envUrls?.length ? `· Env: ${p.envUrls.map(esc).join(', ')}` : ''}</div>
      </div>`,
    )
    .join('');
}

$('projectList').addEventListener('click', async (e) => {
  const projects = await getProjects();
  const ed = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-del]');
  if (ed) openForm(projects.find((p) => p.id === ed.dataset.edit));
  if (del) {
    const p = projects.find((x) => x.id === del.dataset.del);
    if (p && confirm(`Remove "${p.boardTitle}" from this extension? (Nothing changes on GitHub.)`)) {
      await saveProjects(projects.filter((x) => x.id !== p.id));
      renderProjects();
    }
  }
});

function openForm(project = null) {
  editing = project;
  inspected = null;
  repoInfo = null;
  $('projectForm').classList.remove('hidden');
  $('pfTitle').textContent = project ? `Edit ${project.boardTitle}` : 'Add project';
  $('pfBoard').value = project?.boardUrl || '';
  $('pfErr').classList.add('hidden');
  $('pfDetails').classList.add('hidden');
  $('projectForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (project) readBoard();
  else $('pfBoard').focus();
}
$('addProject').addEventListener('click', () => openForm(null));
$('pfCancel').addEventListener('click', () => $('projectForm').classList.add('hidden'));

async function readBoard() {
  const url = $('pfBoard').value.trim();
  $('pfErr').classList.add('hidden');
  $('pfRead').disabled = true;
  $('pfRead').textContent = 'Reading…';
  try {
    inspected = await callHost('inspectBoard', { url });
    fillForm();
  } catch (e) {
    $('pfErr').innerHTML = esc(e.message) + fixBlock(e.fix);
    $('pfErr').classList.remove('hidden');
  } finally {
    $('pfRead').disabled = false;
    $('pfRead').textContent = 'Read board';
  }
}
$('pfRead').addEventListener('click', readBoard);
$('pfBoard').addEventListener('keydown', (e) => e.key === 'Enter' && readBoard());

function fillForm() {
  const b = inspected;
  const cur = b.iteration ? currentIteration(b.iteration.iterations) : null;
  $('pfSummary').innerHTML = `<b>${esc(b.title)}</b> · Status options: ${esc((b.status?.options || []).map((o) => o.name).join(', ') || 'none')} · ${
    b.iteration ? `Iterations: ${cur ? `current is <b>${esc(cur.title)}</b>` : 'none active today'}` : 'No iteration field'
  }`;
  // repo
  const repos = b.repos.map((r) => r.nameWithOwner);
  const current = editing?.repo || repos[0] || '';
  $('pfRepoSel').innerHTML =
    repos.map((r) => `<option ${r === current ? 'selected' : ''}>${esc(r)}</option>`).join('') + `<option value="__other" ${current && !repos.includes(current) ? 'selected' : ''}>Other repository…</option>`;
  if (!repos.length) $('pfRepoSel').value = '__other';
  $('pfRepo').value = current && !repos.includes(current) ? current : '';
  $('pfRepo').classList.toggle('hidden', $('pfRepoSel').value !== '__other');
  // status
  const statusOpts = b.status?.options || [];
  const initial = editing?.initialStatus?.optionId;
  $('pfStatus').innerHTML = statusOpts.map((o) => `<option value="${esc(o.id)}" ${o.id === initial || (!initial && /^todo$/i.test(o.name)) ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  $('pfPrefix').value = editing?.envPrefix ?? '';
  $('pfEnvs').value = (editing?.envUrls || []).join('\n');
  renderPriority();
  updatePreview();
  $('pfDetails').classList.remove('hidden');
  loadRepo();
}

function renderPriority() {
  const p = inspected.priority;
  let html = `<div>${PRIORITY_TEXT[p.mode](p)}</div>`;
  if (p.mode !== 'title') {
    const saved = editing?.priority?.mode === p.mode ? editing.priority.mapping : null;
    html += `<div class="map">${['P0', 'P1', 'P2', 'P3']
      .map((k) => {
        const sel = saved?.[k]?.id || p.mapping?.[k]?.id;
        return `<b>${k}</b><select data-prio="${k}"><option value="">— not set —</option>${p.options
          .map((o) => `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)}</option>`)
          .join('')}</select>`;
      })
      .join('')}</div>`;
  }
  $('pfPriority').innerHTML = html;
}

function selectedRepo() {
  return $('pfRepoSel').value === '__other' ? $('pfRepo').value.trim() : $('pfRepoSel').value;
}

async function loadRepo() {
  const repo = selectedRepo();
  const keep = $('pfAssignee').value || editing?.defaultAssignee || '';
  $('pfAssignee').innerHTML = '<option value="">Loading people…</option>';
  repoInfo = null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return;
  try {
    const meta = await callHost('projectMeta', { boardUrl: inspected.url || $('pfBoard').value.trim(), repo });
    repoInfo = meta.repo;
    $('pfAssignee').innerHTML = assigneeOptionsHtml({ assignees: repoInfo.assignees, boardAssignees: meta.boardAssignees || [], repo, selected: keep });
  } catch (e) {
    $('pfErr').innerHTML = `Repository: ${esc(e.message)}`;
    $('pfErr').classList.remove('hidden');
  }
}
$('pfRepoSel').addEventListener('change', () => {
  $('pfRepo').classList.toggle('hidden', $('pfRepoSel').value !== '__other');
  loadRepo();
});
$('pfRepo').addEventListener('change', loadRepo);

function updatePreview() {
  $('pfPreview').textContent = buildTitle({
    priority: 'P1',
    priorityMode: inspected?.priority?.mode,
    envPrefix: $('pfPrefix').value,
    module: 'Citizen',
    shortTitle: 'Payment receipt not generated',
  });
}
$('pfPrefix').addEventListener('input', updatePreview);

$('pfSave').addEventListener('click', async () => {
  const repo = selectedRepo();
  const err = (m) => {
    $('pfErr').textContent = m;
    $('pfErr').classList.remove('hidden');
  };
  if (!inspected) return err('Read the board first.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return err('Choose the repository issues should be created in (owner/repo).');
  const assignee = $('pfAssignee').value.trim();
  if (assignee && repoInfo && !repoInfo.assignees.some((a) => a.login.toLowerCase() === assignee.toLowerCase())) {
    return err(`"${assignee}" can't be assigned issues in ${repo}.`);
  }
  const statusOpt = (inspected.status?.options || []).find((o) => o.id === $('pfStatus').value);
  const p = inspected.priority;
  const mapping = {};
  for (const sel of document.querySelectorAll('[data-prio]')) {
    const o = p.options?.find((x) => x.id === sel.value);
    if (o) mapping[sel.dataset.prio] = { id: o.id, name: o.name };
  }
  const project = {
    id: editing?.id || `p${Date.now().toString(36)}`,
    boardUrl: inspected.url || $('pfBoard').value.trim(),
    boardTitle: inspected.title,
    owner: inspected.owner,
    ownerType: inspected.ownerType,
    number: inspected.number,
    projectId: inspected.projectId,
    repo,
    envPrefix: $('pfPrefix').value.trim(),
    envUrls: $('pfEnvs')
      .value.split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean),
    defaultAssignee: assignee,
    statusFieldId: inspected.status?.fieldId || null,
    initialStatus: statusOpt ? { optionId: statusOpt.id, name: statusOpt.name } : null,
    priority: p.mode === 'title' ? { mode: 'title' } : { mode: p.mode, fieldId: p.fieldId, fieldName: p.fieldName, mapping },
    iterationFieldId: inspected.iteration?.fieldId || null,
  };
  const projects = await getProjects();
  const i = projects.findIndex((x) => x.id === project.id);
  if (i >= 0) projects[i] = project;
  else projects.push(project);
  await saveProjects(projects);
  await chrome.storage.local.remove(`meta:${project.id}`);
  $('projectForm').classList.add('hidden');
  renderProjects();
});

// ---------- sites ----------
async function renderSites() {
  const sites = await getEnabledSites();
  $('sites').innerHTML = sites.length
    ? sites.map((s) => `<div class="row"><code class="grow">${esc(s)}</code><button data-site="${esc(s)}" class="danger">Stop capturing</button></div>`).join('')
    : '<div class="muted">None yet. Use “Enable on this site” in the toolbar popup on your app’s tab.</div>';
}
$('sites').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-site]');
  if (!b) return;
  await chrome.runtime.sendMessage({ type: 'site-disable', pattern: b.dataset.site });
  renderSites();
});

// ---------- usage ----------
async function renderUsage() {
  const rows = (await getAll('usage')).sort((a, b) => b.ts - a.ts);
  for (const r of rows) r.cost = costOfUsageRecord(r);
  const weekAgo = Date.now() - 7 * 86400000;
  const week = rows.filter((r) => r.ts >= weekAgo);
  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  const sumUsd = (arr) => arr.reduce((s, r) => s + (r.cost.usd || 0), 0);
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  $('usageTotals').innerHTML = `
    <div><b>${week.length}</b><span class="muted small">drafts this week</span></div>
    <div><b>${k(sum(week, 'totalInput'))} / ${k(sum(week, 'outputTokens'))}</b><span class="muted small">tokens in / out this week</span></div>
    <div><b>${formatUsd(sumUsd(week))}</b><span class="muted small">this week</span></div>
    <div><b>${week.length ? formatUsd(sumUsd(week) / week.length) : '—'}</b><span class="muted small">average per draft</span></div>
    <div><b>${formatUsd(sumUsd(rows))}</b><span class="muted small">all time (${rows.length} drafts)</span></div>`;
  $('usageRows').innerHTML = rows.length
    ? rows
        .slice(0, 100)
        .map(
          (r) => `<tr><td>${esc(new Date(r.ts).toLocaleString())}</td><td>${esc(r.project || '')}</td><td>${esc(r.modelLabel || r.model)}${r.detail ? ` · ${esc(r.detail)}` : ''}</td><td>${esc(r.effort)}</td>
            <td class="num">${k(r.totalInput || 0)}</td><td class="num">${k(r.outputTokens || 0)}</td><td class="num">${r.turns ?? '—'}</td><td class="num">${((r.durationMs || 0) / 1000).toFixed(1)} s</td>
            <td class="num" title="${r.cost.estimated ? 'Estimated: logged before cache detail was recorded' : 'Exact from token counts'}">${r.cost.estimated && r.cost.usd != null ? '≈' : ''}${formatUsd(r.cost.usd)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="9" class="muted">No drafts yet.</td></tr>';
  $('costNote').innerHTML = `Cost is the API-equivalent price of the tokens used, at Anthropic's <a href="${PRICING_SOURCE}" target="_blank" rel="noopener">official per-million-token prices</a> (as of ${PRICING_AS_OF}): input, cache writes, cached reads and output priced separately, per model. Effort changes how many tokens are used, not the price per token. On a Claude subscription, drafts count against your plan's usage limits and are not billed per token. Tokens in include cached input.`;
}
$('clearUsage').addEventListener('click', async () => {
  if (!confirm('Clear the Claude usage log?')) return;
  const db = await openDb();
  db.transaction('usage', 'readwrite').objectStore('usage').clear();
  setTimeout(renderUsage, 100);
});

// ---------- init ----------
renderProjects();
diagnose();
const initial = location.hash.slice(1);
if (initial && $(`tab-${initial}`)) showTab(initial);
