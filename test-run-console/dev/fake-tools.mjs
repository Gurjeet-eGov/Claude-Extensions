// Stand-ins for `cloudflared` and `gh`, for the tests: small Node scripts that
// behave like the real commands as far as Test Run uses them, and log what
// they were asked to do.
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

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
 * gh whose `gh api` creates or updates a gist (prints {"id": ...}) and answers `gh api graphql`
 * for the issues given ({ url: { title, state, labels, priority } }); logs the method, path and body.
 */
export function makeFakeGh(dir, { id = '0123456789abcdef0123456789abcdef', fail = false, issues = {}, log = join(dir, 'gh.log') } = {}) {
  const bin = script(dir, 'gh', `
const args = process.argv.slice(2);
const fs = require('fs');
if (args[0] === 'api' && args[1] === 'graphql') {
  const url = (args.find((a) => a.startsWith('url=')) || '').slice(4);
  const withProject = args.some((a) => a.includes('projectItems'));
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ graphql: url, withProject }) + '\\n');
  const it = ${JSON.stringify(issues)}[url];
  if (${fail ? 'true' : 'false'}) { process.stderr.write('HTTP 401: Bad credentials\\n'); process.exit(1); }
  if (!it) { process.stdout.write(JSON.stringify({ data: { resource: null }, errors: [{ message: 'Could not resolve to a Resource with the URL.' }] })); process.exit(1); }
  const resource = { __typename: 'Issue', title: it.title, state: it.state || 'OPEN', labels: { nodes: (it.labels || []).map((name) => ({ name })) } };
  if (withProject) resource.projectItems = { nodes: it.priority ? [{ fieldValueByName: { name: it.priority } }] : [] };
  process.stdout.write(JSON.stringify({ data: { resource } }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body: input ? JSON.parse(input) : null }) + '\\n');
  if (${fail ? 'true' : 'false'}) { process.stderr.write('HTTP 401: Bad credentials\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ id: ${JSON.stringify(id)} }));
});`);
  return { bin, id, log };
}
