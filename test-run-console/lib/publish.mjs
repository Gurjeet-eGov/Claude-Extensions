// Publishing to the repository on GitHub, so the reports can be read when no
// Test Run is running, and someone else can carry on from a clone.
//
// Everything Test Run publishes lives on its own branch, test-run-data, with no
// history: each publish replaces the branch with ONE commit that has no parent
// (the "replace" mode of publishFiles), holding workbooks/ (the workbooks and
// their sidecar files) and reports/ (the summaries the GitHub Pages site shows).
// So the repository stops growing, whatever is taken down really leaves the
// branch, and the code history on the default branch stays clean. Then the
// Pages workflow is started, and builds the site from the default branch (the
// page) plus that branch (the data).
//
// Only `gh api <REST path>` is used (GitHub's Git Data API: blobs, a tree, a
// commit, then the branch moved), never gh's own commands, so moving to plain
// REST calls later changes only ghApi(). The local checkout, and any
// uncommitted work in it, is never touched. Only the host publishes, with their
// own gh login.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { findCommand } from './share.mjs';

/** Git's id for file contents: sha1("blob <size>\0" + contents). Equal ids mean equal files. */
export function blobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

/** https://github.com/Owner/Repo(.git) or git@github.com:Owner/Repo.git -> { owner, repo } */
export function repoFromRemote(remote) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A file-name-safe, stable id for a workbook: "cms-sign-off-staging-3f2a9c". */
export function slugFor(name) {
  const base = String(name || '').replace(/\.xlsx$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workbook';
  return `${base}-${createHash('sha1').update(String(name)).digest('hex').slice(0, 6)}`;
}

export const newPublishId = () => randomBytes(8).toString('hex');

const enc = (path) => String(path).split('/').map(encodeURIComponent).join('/');

/** Run `gh api ...`; resolves the parsed JSON (or the raw bytes), rejects with { status, message }. */
function ghApi(cmd, args, { input, raw = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, ['api', ...args], { timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || err.message;
        const m = /HTTP (\d{3})/.exec(text);
        reject(Object.assign(new Error(text.replace(/^gh:\s*/, '')), { status: m ? Number(m[1]) : 0 }));
        return;
      }
      if (raw) { resolve(stdout); return; }
      try { resolve(JSON.parse(stdout.toString('utf8') || 'null')); } catch { reject(new Error('GitHub sent something that is not JSON.')); }
    });
    if (input != null) child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

/** The gh command, or a readable error. */
export function ghCommand(ghPath) {
  const cmd = findCommand('gh', ghPath);
  if (!cmd) throw Object.assign(new Error('The GitHub CLI (gh) is not installed. Install it and run: gh auth login'), { code: 'NO_GH' });
  return cmd;
}

/** { defaultBranch, private, url } of the repository. */
export async function repoInfo({ cmd, owner, repo }) {
  const r = await ghApi(cmd, [`repos/${owner}/${repo}`]);
  return { defaultBranch: r.default_branch || 'master', private: !!r.private, url: r.html_url || `https://github.com/${owner}/${repo}` };
}

/** The commit a branch points at (GET /git/ref/heads/{branch}, an exact match), or null when there is no such branch. */
export async function readRef({ cmd, owner, repo, branch }) {
  try {
    const ref = await ghApi(cmd, [`repos/${owner}/${repo}/git/ref/heads/${enc(branch)}`]);
    return (ref && ref.object && ref.object.sha) || null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Someone else published to the branch while this was being built: refuse, as with a newer publish. */
const newerRemote = (branch) => Object.assign(new Error(`Someone else published to ${branch} while this host-server was publishing.`), { code: 'NEWER_REMOTE' });

/**
 * Commit files ([{ path, content }]) in one commit on branch.
 *
 * Default mode: the commit goes on top of the branch. Files already there unchanged are
 * not uploaded; anything else under prefix is removed. If someone moved the branch
 * meanwhile, it tries once more on the new tip.
 *
 * replace: true: the branch becomes exactly these files, in one commit with no parent,
 * and the branch is force-moved to it (or created: POST /git/refs). Blobs of files that
 * are on the branch already, unchanged, are reused rather than uploaded again. Anything
 * not in files leaves the branch (prefix is not used). It refuses (code NEWER_REMOTE)
 * when the branch is not at expectHead (the tip the caller last read; null: no branch;
 * undefined: no expectation), or when it moves while the commit is being built.
 *
 * Either way nothing is committed when only "minor" files changed (minor(path) true, e.g.
 * reports that only differ by their time stamp) and nothing was removed.
 * Resolves { commit, url, changed: [paths], removed: [paths], created } (commit null: nothing to do).
 */
export async function publishFiles({ cmd, owner, repo, branch, prefix, files, message, minor = () => false, replace = false, expectHead }) {
  if (replace) return replaceBranch({ cmd, owner, repo, branch, files, message, minor, expectHead });
  const base = `repos/${owner}/${repo}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await ghApi(cmd, [`${base}/git/ref/heads/${enc(branch)}`]);
    const head = ref.object.sha;
    const commit = await ghApi(cmd, [`${base}/git/commits/${head}`]);
    const tree = await ghApi(cmd, [`${base}/git/trees/${commit.tree.sha}?recursive=1`]);
    const existing = {};
    if (!tree.truncated) for (const e of tree.tree || []) if (e.type === 'blob' && e.path.startsWith(`${prefix}/`)) existing[e.path] = e.sha;
    const changed = files.filter((f) => tree.truncated || existing[f.path] !== blobSha(f.content));
    const removed = Object.keys(existing).filter((p) => !files.some((f) => f.path === p));
    if (!changed.some((f) => !minor(f.path)) && !removed.length) return { commit: null, changed: [], removed: [] };
    const entries = [];
    for (const f of changed) {
      const blob = await ghApi(cmd, ['-X', 'POST', `${base}/git/blobs`, '--input', '-'], { input: { content: Buffer.from(f.content).toString('base64'), encoding: 'base64' } });
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const p of removed) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
    const newTree = await ghApi(cmd, ['-X', 'POST', `${base}/git/trees`, '--input', '-'], { input: { base_tree: commit.tree.sha, tree: entries } });
    const newCommit = await ghApi(cmd, ['-X', 'POST', `${base}/git/commits`, '--input', '-'], { input: { message, tree: newTree.sha, parents: [head] } });
    try {
      await ghApi(cmd, ['-X', 'PATCH', `${base}/git/refs/heads/${enc(branch)}`, '--input', '-'], { input: { sha: newCommit.sha, force: false } });
      return { commit: newCommit.sha, url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`, changed: changed.map((f) => f.path), removed };
    } catch (e) {
      if (e.status === 422 && attempt === 0) continue; // the branch moved under us: build on the new tip
      throw e;
    }
  }
  throw new Error('The branch kept moving while publishing. Try again.');
}

async function replaceBranch({ cmd, owner, repo, branch, files, message, minor, expectHead }) {
  const base = `repos/${owner}/${repo}`;
  if (!files.length) throw new Error('There is nothing to publish.');
  const head = await readRef({ cmd, owner, repo, branch });
  if (expectHead !== undefined && head !== expectHead) throw newerRemote(branch);
  // What the branch holds now (path -> blob id): to reuse unchanged blobs, and to tell what leaves
  const existing = {};
  let truncated = false;
  if (head) {
    const commit = await ghApi(cmd, [`${base}/git/commits/${head}`]);
    const tree = await ghApi(cmd, [`${base}/git/trees/${commit.tree.sha}?recursive=1`]);
    truncated = !!tree.truncated; // too big to list: upload everything
    for (const e of tree.tree || []) if (e.type === 'blob') existing[e.path] = e.sha;
  }
  const changed = files.filter((f) => truncated || existing[f.path] !== blobSha(f.content));
  const removed = Object.keys(existing).filter((p) => !files.some((f) => f.path === p));
  if (head && !changed.some((f) => !minor(f.path)) && !removed.length) return { commit: null, changed: [], removed: [] };
  const fresh = new Set(changed.map((f) => f.path));
  const entries = [];
  for (const f of files) {
    let sha = fresh.has(f.path) ? '' : existing[f.path];
    if (!sha) sha = (await ghApi(cmd, ['-X', 'POST', `${base}/git/blobs`, '--input', '-'], { input: { content: Buffer.from(f.content).toString('base64'), encoding: 'base64' } })).sha;
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }
  const newTree = await ghApi(cmd, ['-X', 'POST', `${base}/git/trees`, '--input', '-'], { input: { tree: entries } }); // no base_tree: these files only
  const newCommit = await ghApi(cmd, ['-X', 'POST', `${base}/git/commits`, '--input', '-'], { input: { message, tree: newTree.sha, parents: [] } });
  // A forced move does not check the tip it replaces, so look again just before it
  if ((await readRef({ cmd, owner, repo, branch })) !== head) throw newerRemote(branch);
  if (head) {
    await ghApi(cmd, ['-X', 'PATCH', `${base}/git/refs/heads/${enc(branch)}`, '--input', '-'], { input: { sha: newCommit.sha, force: true } });
  } else {
    try {
      await ghApi(cmd, ['-X', 'POST', `${base}/git/refs`, '--input', '-'], { input: { ref: `refs/heads/${branch}`, sha: newCommit.sha } });
    } catch (e) {
      if (e.status === 422) throw newerRemote(branch); // someone else created it meanwhile
      throw e;
    }
  }
  return { commit: newCommit.sha, url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`, changed: changed.map((f) => f.path), removed, created: !head };
}

/** Start a workflow, as its Run workflow button does: POST /actions/workflows/{file}/dispatches, on ref. */
export async function dispatchWorkflow({ cmd, owner, repo, workflow, ref, inputs }) {
  await ghApi(cmd, ['-X', 'POST', `repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, '--input', '-'], { input: inputs ? { ref, inputs } : { ref } });
}

/** A file from the repository on GitHub (raw bytes), or null if it is not there. ref: a branch, or a commit id. */
export async function readRemoteFile({ cmd, owner, repo, branch, ref = branch, path }) {
  try {
    return await ghApi(cmd, ['-H', 'Accept: application/vnd.github.raw', `repos/${owner}/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`], { raw: true });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
