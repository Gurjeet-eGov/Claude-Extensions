// The one GitHub client. Everything Test Run asks GitHub goes through request(), a documented
// REST path (or POST /graphql), never gh's own high-level commands, so the way requests are sent
// (the transport) can change without any caller changing:
//
//   ghTransport({ ghPath })        today: `gh api <REST path>` with the host's own gh login
//   fetchTransport({ token })      later: fetch('https://api.github.com' + path) with a token
//
// A transport is one function: ({ method, path, query, body, binary, accept, timeoutMs }) ->
// the parsed JSON (null for an empty answer), or the bytes when binary. It rejects with a
// GithubError { status, body, code }: status is GitHub's HTTP status when known (0 when not),
// body the answer GitHub sent with the error (a GraphQL answer with errors, say).
//
// Permissions a token will need (written down so the move is a settings change):
//   suite repositories: Actions read and write (start, follow, cancel runs; artifacts), Contents read (workflow files)
//   this repository:    Contents read and write (the test-run-data branch), Actions write (the Pages workflow)
//   the account:        Gists read and write (the address gist)
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** Full path of a command, looking in PATH and the usual Homebrew folders; null if missing. */
export function findCommand(name, explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const dirs = String(process.env.PATH || '').split(delimiter).concat(EXTRA_PATH);
  for (const d of dirs) {
    if (!d) continue;
    const f = join(d, name);
    if (existsSync(f)) return f;
  }
  return null;
}

export class GithubError extends Error {
  constructor(message, { status = 0, body = null, code = '' } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code || (status === 401 ? 'GH_AUTH' : status === 404 ? 'GH_NOT_FOUND' : status === 403 ? 'GH_FORBIDDEN' : 'GH_FAILED');
  }
}

/** '/repos/o/r' or 'repos/o/r', plus { per_page: 20 } -> 'repos/o/r?per_page=20' (no leading slash). */
export function pathWithQuery(path, query) {
  let p = String(path || '').replace(/^\/+/, '');
  const q = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (q.length) p += (p.includes('?') ? '&' : '?') + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return p;
}

/** Each part of a path encoded on its own: 'a b/c.yml' -> 'a%20b/c.yml'. */
export const encPath = (path) => String(path).split('/').map(encodeURIComponent).join('/');
const seg = (v) => encodeURIComponent(String(v));

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * `gh api` as the transport: execFile (no shell), the JSON body on stdin (--input -), the answer on
 * stdout; raw bytes for binary answers (an artifact's zip, which gh downloads through GitHub's redirect).
 * exec: execFile, replaceable in tests (they check the arguments, and never run gh).
 */
export function ghTransport({ ghPath, timeoutMs = 60000, maxBuffer = 256 * 1024 * 1024, exec = execFile } = {}) {
  const send = ({ method = 'GET', path, query, body, binary = false, accept, timeoutMs: t } = {}) => new Promise((resolve, reject) => {
    const cmd = findCommand('gh', ghPath);
    if (!cmd) { reject(new GithubError('The GitHub CLI (gh) is not installed. Install it and run: gh auth login', { code: 'NO_GH' })); return; }
    const args = ghArgs({ method, path, query, body, accept });
    const child = exec(cmd, args, { timeout: t || timeoutMs, maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
      if (err) {
        const text = String(stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || err.message;
        const m = /HTTP (\d{3})/.exec(text);
        let parsed = null;
        try { parsed = JSON.parse(out.toString('utf8') || 'null'); } catch { parsed = null; }
        const auth = /gh auth login|not logged in|authentication/i.test(String(stderr || ''));
        reject(new GithubError(text.replace(/^gh:\s*/, ''), { status: m ? Number(m[1]) : 0, body: parsed, code: auth ? 'GH_AUTH' : err.killed ? 'GH_TIMEOUT' : '' }));
        return;
      }
      if (binary) { resolve(out); return; }
      const s = out.toString('utf8');
      if (!s.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(s)); } catch { reject(new GithubError('GitHub sent something that is not JSON.')); }
    });
    if (body != null && child && child.stdin) child.stdin.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  send.kind = 'gh';
  return send;
}

/** The arguments for `gh api` (exported for the tests): api [-X METHOD] path?query [-H Accept] [--input -]. */
export function ghArgs({ method = 'GET', path, query, body, accept } = {}) {
  const args = ['api'];
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') args.push('-X', m);
  args.push(pathWithQuery(path, query));
  if (accept) args.push('-H', `Accept: ${accept}`);
  if (body != null) args.push('--input', '-');
  return args;
}

/**
 * fetch as the transport, with a token (a fine-grained token or a GitHub App's). Binary answers
 * (artifact zips) are a redirect to a short-lived download link, followed by hand so the token is
 * never sent to the storage host. fetchImpl: replaceable in tests.
 */
export function fetchTransport({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, timeoutMs = 60000, userAgent = 'test-run' } = {}) {
  const send = async ({ method = 'GET', path, query, body, binary = false, accept, timeoutMs: t } = {}) => {
    if (!token) throw new GithubError('No GitHub token is set.', { code: 'GH_AUTH' });
    const url = `${baseUrl.replace(/\/+$/, '')}/${pathWithQuery(path, query)}`;
    const headers = {
      Accept: accept || 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
    };
    if (body != null) headers['Content-Type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), t || timeoutMs);
    try {
      let res = await fetchImpl(url, { method: String(method).toUpperCase(), headers, body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, redirect: binary ? 'manual' : 'follow', signal: ctl.signal });
      if (binary && res.status >= 300 && res.status < 400) {
        const to = res.headers.get('location');
        if (!to) throw new GithubError('GitHub sent a download redirect with no address.', { status: res.status });
        res = await fetchImpl(to, { method: 'GET', headers: { 'User-Agent': userAgent }, redirect: 'follow', signal: ctl.signal }); // no token to the storage host
      }
      if (!res.ok) {
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        throw new GithubError((parsed && parsed.message) || `GitHub answered ${res.status}.`, { status: res.status, body: parsed });
      }
      if (binary) return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      if (!text.trim()) return null;
      try { return JSON.parse(text); } catch { throw new GithubError('GitHub sent something that is not JSON.', { status: res.status }); }
    } catch (e) {
      if (e && e.name === 'AbortError') throw new GithubError('GitHub did not answer in time.', { code: 'GH_TIMEOUT' });
      if (e instanceof GithubError) throw e;
      throw new GithubError(`Could not reach GitHub: ${e.message}`, { code: 'GH_OFFLINE' });
    } finally {
      clearTimeout(timer);
    }
  };
  send.kind = 'fetch';
  return send;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * o: { transport } (any transport), or { token } (fetch), else { ghPath } (gh api, the default).
 * Every helper takes owner and repo apart ('owner', 'repo'); paths are GitHub's REST paths.
 */
export function createGithub(o = {}) {
  const send = o.transport || (o.token ? fetchTransport({ token: o.token, fetchImpl: o.fetchImpl }) : ghTransport({ ghPath: o.ghPath, timeoutMs: o.timeoutMs }));
  const request = (method, path, opts = {}) => send({ method, path, ...opts });
  const repoPath = (owner, repo) => `/repos/${seg(owner)}/${seg(repo)}`;

  const gh = {
    kind: send.kind || 'custom',
    request,

    /** POST /graphql: resolves GitHub's whole answer { data, errors }, also when gh exits non-zero over errors in it. */
    async graphql(query, variables = {}, opts = {}) {
      try {
        return await request('POST', '/graphql', { body: { query, variables }, ...opts });
      } catch (e) {
        if (e && e.body && typeof e.body === 'object' && (e.body.data !== undefined || e.body.errors)) return e.body;
        throw e;
      }
    },

    /** The signed-in account: GET /user ({ login, name }). */
    getUser: () => request('GET', '/user'),

    getRepo: (owner, repo) => request('GET', repoPath(owner, repo)),
    listBranches: (owner, repo, { perPage = 100 } = {}) => request('GET', `${repoPath(owner, repo)}/branches`, { query: { per_page: perPage } }),
    listEnvironments: (owner, repo) => request('GET', `${repoPath(owner, repo)}/environments`, { query: { per_page: 100 } }),
    listWorkflows: (owner, repo) => request('GET', `${repoPath(owner, repo)}/actions/workflows`, { query: { per_page: 100 } }),
    getWorkflow: (owner, repo, id) => request('GET', `${repoPath(owner, repo)}/actions/workflows/${seg(id)}`),

    /** A file's bytes from the contents API (base64 in its JSON answer), or null when it is not there. */
    async getFile(owner, repo, path, ref) {
      try {
        const r = await request('GET', `${repoPath(owner, repo)}/contents/${encPath(path)}`, { query: { ref } });
        if (!r || Array.isArray(r) || r.type === 'dir') return null;
        if (r.encoding === 'base64' || r.content) return Buffer.from(String(r.content || '').replace(/\s+/g, ''), 'base64');
        return null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    /**
     * Start a workflow, as its Run workflow button does: POST …/workflows/{id}/dispatches. Resolves
     * { runId, runUrl } when GitHub's answer names the new run, else {} (it is then found with listRuns).
     */
    async dispatchWorkflow(owner, repo, workflowId, ref, inputs, { returnRunDetails = false } = {}) {
      const body = { ref };
      if (inputs && Object.keys(inputs).length) body.inputs = inputs;
      if (returnRunDetails) body.return_run_details = true;
      const r = await request('POST', `${repoPath(owner, repo)}/actions/workflows/${seg(workflowId)}/dispatches`, { body });
      const runId = r && (r.workflow_run_id || r.id);
      return runId ? { runId: Number(runId), runUrl: r.html_url || '' } : {};
    },

    /** A workflow's runs (workflowId), or the repository's: { workflow_runs, total_count }. q: event, branch, status, created, actor, per_page. */
    listRuns: (owner, repo, { workflowId, ...q } = {}) => request('GET', workflowId ? `${repoPath(owner, repo)}/actions/workflows/${seg(workflowId)}/runs` : `${repoPath(owner, repo)}/actions/runs`, { query: { per_page: 20, ...q } }),
    getRun: (owner, repo, runId) => request('GET', `${repoPath(owner, repo)}/actions/runs/${seg(runId)}`),
    listJobs: (owner, repo, runId) => request('GET', `${repoPath(owner, repo)}/actions/runs/${seg(runId)}/jobs`, { query: { per_page: 50 } }),
    listArtifacts: (owner, repo, runId) => request('GET', `${repoPath(owner, repo)}/actions/runs/${seg(runId)}/artifacts`, { query: { per_page: 100 } }),
    /** An artifact's zip (bytes). GitHub answers with a redirect to a short-lived link; both transports follow it. */
    downloadArtifact: (owner, repo, artifactId, opts = {}) => request('GET', `${repoPath(owner, repo)}/actions/artifacts/${seg(artifactId)}/zip`, { binary: true, timeoutMs: opts.timeoutMs || 180000 }),
    cancelRun: (owner, repo, runId) => request('POST', `${repoPath(owner, repo)}/actions/runs/${seg(runId)}/cancel`),

    // Git data (what Publish uses: blobs, a tree, a commit, then the branch moved)
    getRef: (owner, repo, branch) => request('GET', `${repoPath(owner, repo)}/git/ref/heads/${encPath(branch)}`),
    getCommit: (owner, repo, sha) => request('GET', `${repoPath(owner, repo)}/git/commits/${seg(sha)}`),
    getTree: (owner, repo, sha, { recursive = true } = {}) => request('GET', `${repoPath(owner, repo)}/git/trees/${seg(sha)}`, { query: recursive ? { recursive: 1 } : {} }),
    createBlob: (owner, repo, content) => request('POST', `${repoPath(owner, repo)}/git/blobs`, { body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' } }),
    createTree: (owner, repo, tree, baseTree) => request('POST', `${repoPath(owner, repo)}/git/trees`, { body: baseTree ? { base_tree: baseTree, tree } : { tree } }),
    createCommit: (owner, repo, { message, tree, parents = [] }) => request('POST', `${repoPath(owner, repo)}/git/commits`, { body: { message, tree, parents } }),
    updateRef: (owner, repo, branch, sha, { force = false } = {}) => request('PATCH', `${repoPath(owner, repo)}/git/refs/heads/${encPath(branch)}`, { body: { sha, force } }),
    createRef: (owner, repo, branch, sha) => request('POST', `${repoPath(owner, repo)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } }),

    // Gists (where the shared Test Run is)
    createGist: (body, opts = {}) => request('POST', '/gists', { body, ...opts }),
    updateGist: (id, body, opts = {}) => request('PATCH', `/gists/${seg(id)}`, { body, ...opts }),
  };
  return gh;
}

/** 'owner/name' (or a github.com link) -> { owner, repo }; null when it isn't one. */
export function splitRepo(full) {
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(String(full || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
