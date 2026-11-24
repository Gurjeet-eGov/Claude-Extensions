// Reaching Test Run from outside the laptop.
//
// startTunnel(): a Cloudflare quick tunnel (`cloudflared tunnel --url ...`).
// It needs no account and gives a random https://<words>.trycloudflare.com
// address, new on every start. With a name, it runs that Cloudflare named
// tunnel instead (`cloudflared tunnel run --url ... <name>`), which serves a
// fixed address on the owner's own domain.
//
// publishAddress(): writes the current address to a secret GitHub gist with
// the owner's `gh` login, through the GitHub client (lib/github.mjs: POST or
// PATCH /gists). The hosted page (GitHub Pages) reads that gist, so invite
// links keep working when the tunnel address changes.
import { spawn } from 'node:child_process';
import { findCommand, createGithub } from './github.mjs';

export { findCommand }; // where it always was, for lib/publish.mjs and the server

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const READY_RE = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

/**
 * Start a tunnel to http://127.0.0.1:<port>: a quick tunnel, or the named tunnel
 * `name` (serving `url`). Resolves { url, stop(), child } once it is up, or rejects.
 * onExit(code) is called if the tunnel stops by itself later.
 */
export function startTunnel({ port, bin, name = '', url: fixed = '', timeoutMs = 30000, onExit } = {}) {
  const cmd = findCommand('cloudflared', bin);
  if (!cmd) return Promise.reject(Object.assign(new Error('cloudflared is not installed. Install it with: brew install cloudflared'), { code: 'NO_TUNNEL' }));
  const args = name
    ? ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${port}`, name]
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    let seen = '';
    const finish = (err, url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { try { child.kill(); } catch { /* gone */ } reject(err); return; }
      resolve({ url, child, stop: () => { try { child.kill(); } catch { /* gone */ } } });
    };
    const read = (chunk) => {
      seen = (seen + chunk.toString('utf8')).slice(-8000);
      if (name) { if (READY_RE.test(seen)) finish(null, fixed); return; }
      const m = URL_RE.exec(seen);
      if (m) finish(null, m[0]);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (e) => finish(Object.assign(new Error(`Could not start cloudflared: ${e.message}`), { code: 'TUNNEL_FAILED' })));
    child.on('exit', (code) => {
      if (!done) finish(Object.assign(new Error(`cloudflared stopped before ${name ? `tunnel "${name}" connected` : 'it gave an address'} (exit ${code}). ${seen.split('\n').filter(Boolean).slice(-2).join(' ')}`.trim()), { code: 'TUNNEL_FAILED' }));
      else if (onExit) onExit(code);
    });
    const timer = setTimeout(() => finish(Object.assign(new Error(`cloudflared did not ${name ? 'connect' : 'give an address'} within ${Math.round(timeoutMs / 1000)} seconds. Check your internet connection.`), { code: 'TUNNEL_FAILED' })), timeoutMs);
  });
}

/**
 * Write { app, url, updatedAt } to the gist (created on first use, secret).
 * Resolves the gist id. Needs `gh auth login` (its default scopes include gist).
 */
export async function publishAddress({ gist, url, ghPath, github, now = new Date().toISOString() }) {
  if (!github && !findCommand('gh', ghPath)) throw Object.assign(new Error('The GitHub CLI (gh) is not installed, so the address cannot be kept in a gist. Install it and run: gh auth login'), { code: 'NO_GH' });
  const gh = github || createGithub({ ghPath });
  const content = JSON.stringify({ app: 'test-run', url, updatedAt: now }, null, 2);
  const files = { 'test-run.json': { content } };
  if (gist) {
    await gh.updateGist(gist, { files }, { timeoutMs: 20000 });
    return gist;
  }
  const out = await gh.createGist({ description: 'Test Run: where the shared Test Run is reachable (kept up to date by Test Run)', public: false, files }, { timeoutMs: 20000 });
  const id = out && out.id;
  if (!id) throw new Error('GitHub did not return a gist id.');
  return id;
}
