// Runs a program with an argument array (never through a shell), so text from the
// report form is always passed as data and can't be interpreted as a command.

import { spawn } from 'node:child_process';

export function run(cmd, args, { cwd, env, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false, notFound: e?.code === 'ENOENT' });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(e?.message || e), timedOut, notFound: e?.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, notFound: false });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}
