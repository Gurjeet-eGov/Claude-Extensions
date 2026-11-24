// Stand-ins for `cloudflared` and `gh`, for the tests: small Node scripts that
// behave like the real commands as far as Test Run uses them, and log what
// they were asked to do.
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const FAKE_GH = fileURLToPath(new URL('./fake-gh.cjs', import.meta.url));
const fakeGh = createRequire(import.meta.url)('./fake-gh.cjs');

function script(dir, name, body) {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * cloudflared that prints a quick-tunnel address (like the real banner, on stderr) and stays up.
 * urls: a new address on each start (the last one repeats); exitAfterMs: stop by itself that long
 * after starting, like a tunnel dropped by sleep or a network change. `tunnel run <name>` (a named
 * tunnel) prints the "Registered tunnel connection" line instead.
 */
export function makeFakeCloudflared(dir, { url = 'https://quick-brown-fox.trycloudflare.com', urls, exitAfterMs = 0, log = join(dir, 'cloudflared.log') } = {}) {
  const list = urls || [url];
  const count = join(dir, 'cloudflared.count');
  const bin = script(dir, 'cloudflared', `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')) || 0; } catch {}
fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
const urls = ${JSON.stringify(list)};
const url = urls[Math.min(n, urls.length - 1)];
if (args.includes('run')) {
  setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0 location=bom01 protocol=quic\\n'), 50);
} else {
  process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n');
  setTimeout(() => process.stderr.write('INF |  Your quick Tunnel has been created! Visit it at:  |\\nINF |  ' + url + '  |\\n'), 50);
}
setInterval(() => {}, 1000);
${exitAfterMs ? `setTimeout(() => process.exit(1), ${Number(exitAfterMs)});` : ''}
process.on('SIGTERM', () => process.exit(0));`);
  return { bin, url: list[0], urls: list, log };
}

/**
 * gh whose `gh api` answers like GitHub for what Test Run asks (dev/fake-gh.cjs): gists,
 * GraphQL issue lookups ({ url: { title, state, labels, priority } }), and a repository kept
 * in a JSON file (files: its first commit, on the default branch; raceOnce: someone else
 * pushes on top just before the first fast-forward move; raceReplaceOnce: a branch name that
 * someone else replaces while the first commit is being made; failDispatch: starting a
 * workflow is refused). Logs every call. readRepo(branch) gives the files on a branch now (the
 * default branch unless named; null when there is no such branch); dispatches() the workflows
 * started, as [{ dispatch, body }].
 */
export function makeFakeGh(dir, { id = '0123456789abcdef0123456789abcdef', fail = false, issues = {}, files, raceOnce = false, raceReplaceOnce = '', failDispatch = false, log = join(dir, 'gh.log') } = {}) {
  const repo = join(dir, 'fake-repo.json');
  if (!existsSync(repo)) writeFileSync(repo, JSON.stringify(fakeGh.initialState(files)));
  const cfg = { id, fail, issues, log, repo, raceOnce, raceReplaceOnce, failDispatch };
  const bin = script(dir, 'gh', `require(${JSON.stringify(FAKE_GH)})(${JSON.stringify(cfg)});`);
  const dispatches = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.dispatch) : []);
  return { bin, id, log, repo, readRepo: (branch) => fakeGh.readFiles(repo, branch), dispatches };
}
