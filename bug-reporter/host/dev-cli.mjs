#!/usr/bin/env node
// Talks to the helper exactly like Chrome does (framed stdin/stdout), for testing.
//
//   node host/dev-cli.mjs diagnose
//   node host/dev-cli.mjs inspect https://github.com/orgs/<org>/projects/<n>
//   node host/dev-cli.mjs meta <boardUrl> <owner/repo>
//   node host/dev-cli.mjs dupes <owner/repo> keyword1 keyword2 ...
//   node host/dev-cli.mjs draft <fixture.json>          (uses Claude: one lean call)
//   node host/dev-cli.mjs file --dry-run <fixture.json> (prints gh commands, files nothing)
//   node host/dev-cli.mjs issue <owner/repo> <number> [boardUrl]   (read-only lookup)
//   node host/dev-cli.mjs update --dry-run <fixture.json>          (prints gh commands, posts nothing)

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);

function request(command, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'bug-reporter-host.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = Buffer.alloc(0);
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        if (msg.type === 'progress') process.stderr.write(`… ${msg.message}\n`);
        else {
          child.stdin.end();
          (msg.type === 'result' ? resolve : reject)(msg.type === 'result' ? msg.data : msg.error);
        }
      }
    });
    const json = Buffer.from(JSON.stringify({ id: 1, cmd: command, params }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length);
    child.stdin.write(Buffer.concat([head, json]));
  });
}

const fixture = (p) => JSON.parse(readFileSync(p, 'utf8'));

let p;
switch (cmd) {
  case 'diagnose':
    p = request('diagnose', {});
    break;
  case 'inspect':
    p = request('inspectBoard', { url: rest[0] });
    break;
  case 'meta':
    p = request('projectMeta', { boardUrl: rest[0], repo: rest[1] });
    break;
  case 'dupes':
    p = request('findDuplicates', { repo: rest[0], keywords: rest.slice(1) });
    break;
  case 'issue': {
    const board = rest[2] ? await request('inspectBoard', { url: rest[2] }) : null;
    p = request('getIssue', { repo: rest[0], issue: rest[1], projectId: board?.projectId });
    break;
  }
  case 'update': {
    const f = fixture(rest.filter((r) => r !== '--dry-run')[0]);
    p = request('updateIssue', { ...f, dryRun: rest.includes('--dry-run') || f.dryRun });
    break;
  }
  case 'draft':
    p = request('draftText', fixture(rest[0]));
    break;
  case 'file': {
    const dry = rest.includes('--dry-run');
    const f = fixture(rest.filter((r) => r !== '--dry-run')[0]);
    p = request('fileIssue', { ...f, dryRun: dry || f.dryRun });
    break;
  }
  default:
    console.error('Usage: node host/dev-cli.mjs diagnose|inspect|meta|dupes|draft|file …');
    process.exit(2);
}
p.then(
  (data) => console.log(JSON.stringify(data, null, 2)),
  (err) => {
    console.error(JSON.stringify(err, null, 2));
    process.exit(1);
  },
);
