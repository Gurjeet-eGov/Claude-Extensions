// Everything GitHub, through the user's own `gh` login. No Claude involved.

import { run } from './exec.mjs';
import { loadConfig, subprocessEnv } from './config.mjs';
import { parseBoardUrl, parseRepo, boardQuery, ISSUE_FIELDS_QUERY, REPO_QUERY, interpretBoard, boardItemsQuery, countBoardAssignees, parseIssueRef, ISSUE_QUERY, interpretIssue } from './board.mjs';
import { reportDir, writeReportFile, saveToDownloads, safeName } from './files.mjs';
import { platform } from 'node:os';

const SCOPE_FIX = 'gh auth refresh -s project,read:project';

function ghPath() {
  const p = loadConfig().gh;
  if (!p) {
    throw Object.assign(new Error('GitHub CLI (gh) is not installed.'), {
      code: 'GH_NOT_INSTALLED',
      fix: ['brew install gh', 'gh auth login', SCOPE_FIX],
    });
  }
  return p;
}

export function gh(args, { cwd, timeoutMs = 60000 } = {}) {
  return run(ghPath(), args, { cwd, env: subprocessEnv(), timeoutMs });
}

export function ghError(r, fallback = 'GitHub request failed') {
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (/missing required scopes|INSUFFICIENT_SCOPES|required scopes|has not been granted/i.test(text)) {
    return Object.assign(new Error('Your gh login is missing the project scope.'), { code: 'GH_SCOPE', fix: [SCOPE_FIX], detail: text.trim().slice(0, 400) });
  }
  if (/not logged in|gh auth login|authentication required|Bad credentials|HTTP 401/i.test(text)) {
    return Object.assign(new Error('gh is not logged in.'), { code: 'GH_AUTH', fix: ['gh auth login', SCOPE_FIX], detail: text.trim().slice(0, 400) });
  }
  if (/Could not resolve to|HTTP 404|NOT_FOUND/i.test(text)) {
    return Object.assign(new Error('Not found, or your GitHub account has no access to it. Check that you are a member of that org/repo.'), {
      code: 'GH_NOT_FOUND',
      detail: text.trim().slice(0, 400),
    });
  }
  return Object.assign(new Error(text.trim().split('\n').filter(Boolean).slice(-3).join(' ') || fallback), { code: 'GH_ERROR' });
}

export async function graphql(query, vars = {}, { allowPartial = false } = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  const r = await gh(args);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {}
  if (data?.data && (allowPartial || !data.errors?.length)) return data.data;
  if (data?.errors?.length) {
    const msg = data.errors.map((e) => e.message).join('; ');
    throw ghError({ stderr: msg + '\n' + r.stderr, stdout: '' });
  }
  throw ghError(r);
}

// ---------- diagnostics ----------

export async function ghDiagnose() {
  const out = { found: false, path: null, version: null, hasAttach: false, loggedIn: false, scopes: [], hasProjectScope: false, fix: [] };
  const p = loadConfig().gh;
  if (!p) {
    out.fix = ['brew install gh', 'gh auth login', SCOPE_FIX];
    return out;
  }
  out.found = true;
  out.path = p;
  const v = await gh(['--version']);
  out.version = (v.stdout.match(/gh version ([\d.]+)/) || [])[1] || null;
  const help = await gh(['issue', 'create', '--help']);
  out.hasAttach = /--attach/.test(help.stdout + help.stderr);
  const st = await gh(['auth', 'status', '--hostname', 'github.com']);
  const text = st.stdout + st.stderr;
  out.loggedIn = /Logged in to github\.com/i.test(text);
  out.scopes = ((text.match(/Token scopes: (.*)/) || [])[1] || '').split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean);
  out.hasProjectScope = out.scopes.includes('project');
  if (!out.loggedIn) out.fix.push('gh auth login', SCOPE_FIX);
  else if (!out.hasProjectScope) out.fix.push(SCOPE_FIX);
  if (!out.hasAttach) out.fix.push('brew upgrade gh');
  return out;
}

// ---------- boards and repos ----------

export async function inspectBoard(url) {
  const parsed = parseBoardUrl(url);
  if (!parsed) {
    throw Object.assign(new Error('That is not a GitHub project board link. It should look like https://github.com/orgs/<org>/projects/<number>.'), { code: 'BAD_INPUT' });
  }
  const root = parsed.ownerType === 'user' ? 'user' : 'organization';
  const data = await graphql(boardQuery(parsed.ownerType), { login: parsed.owner, num: parsed.number });
  const project = data?.[root]?.projectV2;
  let issueFields = null;
  if (parsed.ownerType === 'organization') {
    try {
      const f = await graphql(ISSUE_FIELDS_QUERY, { login: parsed.owner }, { allowPartial: true });
      issueFields = (f?.organization?.issueFields?.nodes || []).filter((n) => n && n.__typename === 'IssueFieldSingleSelect');
    } catch {
      issueFields = null; // org issue fields not available on this org/plan
    }
  }
  return { ...parsed, ...interpretBoard(project, issueFields) };
}

export async function repoMeta(repo) {
  const r = parseRepo(repo);
  if (!r) throw Object.assign(new Error(`Invalid repository: ${repo}. Use owner/name.`), { code: 'BAD_INPUT' });
  const assignees = [];
  let after = null;
  let first = null;
  for (let page = 0; page < 5; page++) {
    const d = await graphql(REPO_QUERY, { owner: r.owner, name: r.name, after });
    const repoNode = d?.repository;
    if (!repoNode) throw Object.assign(new Error(`Repository ${r.nameWithOwner} not found or not accessible.`), { code: 'GH_NOT_FOUND' });
    first = first || repoNode;
    assignees.push(...(repoNode.assignableUsers?.nodes || []).filter(Boolean));
    if (!repoNode.assignableUsers?.pageInfo?.hasNextPage) break;
    after = repoNode.assignableUsers.pageInfo.endCursor;
  }
  return {
    nameWithOwner: first.nameWithOwner,
    visibility: first.visibility,
    labels: (first.labels?.nodes || []).map((l) => l.name),
    assignees: assignees.map((a) => ({ login: a.login, name: a.name || '' })).sort((a, b) => a.login.localeCompare(b.login)),
  };
}

/** Who is assigned to items on the board (up to 300 items), most items first. */
export async function boardAssignees(boardUrl) {
  const b = parseBoardUrl(boardUrl);
  if (!b) return [];
  const root = b.ownerType === 'user' ? 'user' : 'organization';
  const nodes = [];
  let after = null;
  for (let page = 0; page < 3; page++) {
    const d = await graphql(boardItemsQuery(b.ownerType), { login: b.owner, num: b.number, after }, { allowPartial: true });
    const items = d?.[root]?.projectV2?.items;
    nodes.push(...(items?.nodes || []));
    if (!items?.pageInfo?.hasNextPage) break;
    after = items.pageInfo.endCursor;
  }
  return countBoardAssignees(nodes);
}

export async function projectMeta({ boardUrl, repo }) {
  const [board, repoInfo, onBoard] = await Promise.all([
    inspectBoard(boardUrl),
    repo ? repoMeta(repo) : Promise.resolve(null),
    boardAssignees(boardUrl).catch(() => []), // nice to have; never blocks the form
  ]);
  return { board, repo: repoInfo, boardAssignees: onBoard, fetchedAt: Date.now() };
}

// ---------- duplicates ----------

export async function findDuplicates({ repo, keywords }) {
  const r = parseRepo(repo);
  if (!r) throw Object.assign(new Error('Invalid repository'), { code: 'BAD_INPUT' });
  const kw = (keywords || []).map((k) => String(k).replace(/["\n\r]/g, ' ').trim()).filter(Boolean).slice(0, 5);
  if (!kw.length) return { candidates: [] };
  const queries = [kw.slice(0, 3).join(' ')];
  if (kw.length > 2) queries.push(kw.slice(-2).join(' '));
  const seen = new Map();
  for (const q of queries) {
    const res = await gh(['issue', 'list', '--repo', r.nameWithOwner, '--state', 'open', '--limit', '6', '--search', q, '--json', 'number,title,url,updatedAt']);
    if (res.code !== 0) throw ghError(res);
    for (const it of JSON.parse(res.stdout || '[]')) if (!seen.has(it.number)) seen.set(it.number, it);
  }
  return { candidates: [...seen.values()].slice(0, 8), queries };
}

// ---------- filing ----------

const ISSUE_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/;

function displayCmd(args) {
  return 'gh ' + args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function createArgs({ repo, title, label, assignee, attachments }) {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', 'body.md'];
  if (label) args.push('--label', label);
  if (assignee) args.push('--assignee', assignee);
  for (const a of attachments) args.push('--attach', `./${safeName(a)}`);
  return args;
}

/**
 * Creates the issue with attachments. Retries once each for a missing label (creates it)
 * and an invalid assignee (falls back to the default). Never creates a second issue once a URL exists.
 */
export async function createIssue(p, progress) {
  const repo = parseRepo(p.repo)?.nameWithOwner;
  if (!repo) throw Object.assign(new Error('Invalid repository'), { code: 'BAD_INPUT' });
  const title = String(p.title || '').trim();
  if (!title) throw Object.assign(new Error('Title is empty'), { code: 'BAD_INPUT' });
  const label = p.label === 'enhancement' ? 'enhancement' : 'bug';
  const attachments = (p.attachments || []).map(safeName);
  await writeReportFile(p.reportId, 'body.md', String(p.body || ''));
  const cwd = reportDir(p.reportId);
  const warnings = [];
  let assignee = String(p.assignee || p.defaultAssignee || '').trim();

  if (p.dryRun) {
    return { dryRun: true, commands: [displayCmd(createArgs({ repo, title, label, assignee, attachments }))], cwd };
  }

  let labelCreated = false;
  let r;
  let url = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    progress?.(attachments.length ? `Creating issue and uploading ${attachments.length} attachment(s)…` : 'Creating issue…');
    r = await gh(createArgs({ repo, title, label, assignee, attachments }), { cwd, timeoutMs: 15 * 60000 });
    url = (r.stdout.match(ISSUE_URL) || [])[0] || null;
    if (url) break;
    const err = r.stderr || '';
    if (!labelCreated && /could not add label|label.*not found/i.test(err)) {
      progress?.(`Label "${label}" doesn't exist on ${repo}; creating it…`);
      const lc = await gh(['label', 'create', label, '--repo', repo, '--color', label === 'bug' ? 'd73a4a' : 'a2eeef']);
      if (lc.code !== 0 && !/already exists/i.test(lc.stderr)) throw ghError(lc);
      labelCreated = true;
      continue;
    }
    if (/could not assign|assignee/i.test(err) && assignee && p.defaultAssignee && assignee !== p.defaultAssignee) {
      warnings.push(`"${assignee}" can't be assigned on ${repo}; assigned to ${p.defaultAssignee} instead.`);
      assignee = p.defaultAssignee;
      continue;
    }
    if (/could not assign|assignee/i.test(err) && assignee) {
      warnings.push(`"${assignee}" can't be assigned on ${repo}; the issue is unassigned.`);
      assignee = '';
      continue;
    }
    throw ghError(r, 'Could not create the issue');
  }
  if (!url) throw ghError(r, 'Could not create the issue');
  const number = Number(url.split('/').pop());

  // Some attachments failed (size or type): the issue exists; find which ones.
  let failedAttachments = [];
  let savedTo = null;
  if (r.code !== 0 && attachments.length) {
    const view = await gh(['issue', 'view', url, '--json', 'body', '--jq', '.body']);
    const body = view.stdout || '';
    failedAttachments = attachments.filter((a) => body.includes(`./${a}`) || (r.stderr || '').includes(a));
    if (!failedAttachments.length) failedAttachments = attachments.filter((a) => /\.(mp4|webm|mov)$/i.test(a));
    if (failedAttachments.length) {
      savedTo = await saveToDownloads(p.reportId, number, failedAttachments);
      await run(platform() === 'darwin' ? 'open' : 'xdg-open', [savedTo], { timeoutMs: 5000 }).catch(() => {});
      warnings.push(`GitHub rejected ${failedAttachments.join(', ')}. Saved to ${savedTo}; drag them onto the issue.`);
    }
  }
  return { url, number, assignee, warnings, failedAttachments, savedTo };
}

/**
 * Adds the issue to the board and sets Status / Priority / Iteration.
 * Each field is independent; failures are reported, never retried by creating a new issue.
 */
export async function setFields(p, progress) {
  const done = [];
  const failed = [];
  const fail = (field, e) => failed.push({ field, message: e.message, code: e.code, fix: e.fix || [] });

  let itemId = p.itemId || null;
  if (!itemId) {
    progress?.('Adding the issue to the board…');
    const r = await gh(['project', 'item-add', String(p.projectNumber), '--owner', p.owner, '--url', p.issueUrl, '--format', 'json']);
    try {
      itemId = JSON.parse(r.stdout).id;
    } catch {}
    if (!itemId) {
      fail('board', ghError(r, 'Could not add the issue to the board'));
      return { itemId: null, done, failed };
    }
    done.push('board');
  }

  const edit = async (field, extra) => {
    const r = await gh(['project', 'item-edit', '--id', itemId, '--project-id', p.projectId, ...extra]);
    if (r.code !== 0) fail(field, ghError(r));
    else done.push(field);
  };

  if (p.status?.fieldId && p.status?.optionId) {
    progress?.('Setting Status…');
    await edit('status', ['--field-id', p.status.fieldId, '--single-select-option-id', p.status.optionId]);
  }
  if (p.priority?.mode === 'board' && p.priority.fieldId && p.priority.optionId) {
    progress?.('Setting Priority…');
    await edit('priority', ['--field-id', p.priority.fieldId, '--single-select-option-id', p.priority.optionId]);
  } else if (p.priority?.mode === 'issueField' && p.priority.fieldId && p.priority.optionId) {
    progress?.('Setting Priority (org issue field)…');
    try {
      const v = await gh(['issue', 'view', p.issueUrl, '--json', 'id', '--jq', '.id']);
      const issueId = v.stdout.trim();
      if (!issueId) throw ghError(v);
      await graphql(
        `mutation($issue: ID!, $field: ID!, $opt: ID!) {
          setIssueFieldValue(input: { issueId: $issue, issueFields: [{ fieldId: $field, singleSelectOptionId: $opt }] }) { clientMutationId }
        }`,
        { issue: issueId, field: p.priority.fieldId, opt: p.priority.optionId },
      );
      done.push('priority');
    } catch (e) {
      fail('priority', e);
    }
  }
  if (p.iteration?.fieldId && p.iteration?.iterationId) {
    progress?.('Setting Iteration…');
    await edit('iteration', ['--field-id', p.iteration.fieldId, '--iteration-id', p.iteration.iterationId]);
  }
  return { itemId, done, failed };
}

export function fieldCommands(p) {
  const cmds = [displayCmd(['project', 'item-add', String(p.projectNumber), '--owner', p.owner, '--url', p.issueUrl || '<issue-url>', '--format', 'json'])];
  const base = ['project', 'item-edit', '--id', '<item-id>', '--project-id', p.projectId];
  if (p.status?.optionId) cmds.push(displayCmd([...base, '--field-id', p.status.fieldId, '--single-select-option-id', p.status.optionId]));
  if (p.priority?.mode === 'board' && p.priority.optionId) cmds.push(displayCmd([...base, '--field-id', p.priority.fieldId, '--single-select-option-id', p.priority.optionId]));
  if (p.priority?.mode === 'issueField' && p.priority.optionId) cmds.push(`gh api graphql … setIssueFieldValue(fieldId ${p.priority.fieldId}, option ${p.priority.optionId})`);
  if (p.iteration?.iterationId) cmds.push(displayCmd([...base, '--field-id', p.iteration.fieldId, '--iteration-id', p.iteration.iterationId]));
  return cmds;
}

// ---------- Update Issue: comment on an existing issue ----------

export async function getIssue({ repo, issue, projectId }) {
  const r = parseRepo(repo);
  if (!r) throw Object.assign(new Error('Invalid repository'), { code: 'BAD_INPUT' });
  const number = parseIssueRef(issue, r.nameWithOwner);
  const d = await graphql(ISSUE_QUERY, { owner: r.owner, name: r.name, num: number }, { allowPartial: true });
  const info = interpretIssue(d?.repository?.issue, projectId);
  if (!info) {
    throw Object.assign(new Error(`Issue #${number} was not found in ${r.nameWithOwner} (or it is a pull request).`), { code: 'GH_NOT_FOUND' });
  }
  return info;
}

const COMMENT_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+#issuecomment-\d+/;

function commentArgs({ repo, number, attachments }) {
  const args = ['issue', 'comment', String(number), '--repo', repo, '--body-file', 'body.md'];
  for (const a of attachments) args.push('--attach', `./${safeName(a)}`);
  return args;
}

function closeArgs({ repo, number, close }) {
  return ['issue', 'close', String(number), '--repo', repo, '--reason', close === 'not planned' ? 'not planned' : 'completed'];
}

/** Status change and closing, after the comment exists. Safe to retry: never comments again. */
export async function finishUpdate(p, progress) {
  const done = [];
  const failed = [];
  if (p.status?.optionId && p.board) {
    try {
      const f = await setFields(
        { owner: p.board.owner, projectNumber: p.board.projectNumber, projectId: p.board.projectId, itemId: p.itemId || null, issueUrl: p.issueUrl, status: { fieldId: p.board.statusFieldId, optionId: p.status.optionId } },
        progress,
      );
      if (f.failed.length) failed.push(...f.failed);
      else done.push('status');
      p.itemId = f.itemId || p.itemId;
    } catch (e) {
      failed.push({ field: 'status', message: e.message, code: e.code, fix: e.fix || [] });
    }
  }
  if (p.close) {
    progress?.(p.close === 'not planned' ? 'Closing as not planned…' : 'Closing the issue…');
    const r = await gh(closeArgs(p));
    if (r.code !== 0 && !/already closed/i.test(r.stderr)) failed.push({ field: 'close', ...pick(ghError(r, 'Could not close the issue')) });
    else done.push('closed');
  }
  return { itemId: p.itemId || null, done, failed };
}

function pick(e) {
  return { message: e.message, code: e.code, fix: e.fix || [] };
}

export async function updateIssue(p, progress) {
  const repo = parseRepo(p.repo)?.nameWithOwner;
  if (!repo) throw Object.assign(new Error('Invalid repository'), { code: 'BAD_INPUT' });
  const number = parseIssueRef(p.issue, repo);
  const attachments = (p.attachments || []).map(safeName);
  if (!String(p.body || '').trim()) throw Object.assign(new Error('The comment is empty.'), { code: 'BAD_INPUT' });
  await writeReportFile(p.reportId, 'body.md', String(p.body));
  const cwd = reportDir(p.reportId);

  if (p.dryRun) {
    const cmds = [displayCmd(commentArgs({ repo, number, attachments }))];
    if (p.status?.optionId && p.board) {
      if (!p.itemId) cmds.push(displayCmd(['project', 'item-add', String(p.board.projectNumber), '--owner', p.board.owner, '--url', `https://github.com/${repo}/issues/${number}`, '--format', 'json']));
      cmds.push(displayCmd(['project', 'item-edit', '--id', p.itemId || '<item-id>', '--project-id', p.board.projectId, '--field-id', p.board.statusFieldId, '--single-select-option-id', p.status.optionId]));
    }
    if (p.close) cmds.push(displayCmd(closeArgs({ repo, number, close: p.close })));
    return { dryRun: true, commands: cmds, cwd };
  }

  progress?.(attachments.length ? `Posting the comment and uploading ${attachments.length} attachment(s)…` : 'Posting the comment…');
  const r = await gh(commentArgs({ repo, number, attachments }), { cwd, timeoutMs: 15 * 60000 });
  const commentUrl = (r.stdout.match(COMMENT_URL) || [])[0] || null;
  if (!commentUrl && r.code !== 0) throw ghError(r, 'Could not post the comment');
  const warnings = [];
  let failedAttachments = [];
  let savedTo = null;
  if (r.code !== 0 && attachments.length) {
    failedAttachments = attachments.filter((a) => (r.stderr || '').includes(a));
    if (!failedAttachments.length) failedAttachments = attachments.filter((a) => /\.(mp4|webm|mov)$/i.test(a));
    if (failedAttachments.length) {
      savedTo = await saveToDownloads(p.reportId, number, failedAttachments);
      await run(platform() === 'darwin' ? 'open' : 'xdg-open', [savedTo], { timeoutMs: 5000 }).catch(() => {});
      warnings.push(`GitHub rejected ${failedAttachments.join(', ')}. Saved to ${savedTo}; drag them onto the comment.`);
    }
  }
  const issueUrl = `https://github.com/${repo}/issues/${number}`;
  const fields = await finishUpdate({ ...p, repo, number, issueUrl }, progress);
  return { commentUrl: commentUrl || issueUrl, issueUrl, number, warnings, failedAttachments, savedTo, fields };
}
