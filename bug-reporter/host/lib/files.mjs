// Staging folder for one report's attachments, plus clean-up.

import { mkdir, appendFile, writeFile, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|gif|mp4|webm|mov|md)$/i;

export function safeName(name) {
  const n = String(name || '');
  if (!ALLOWED.test(n) || n.includes('..')) throw Object.assign(new Error(`Invalid file name: ${n}`), { code: 'BAD_INPUT' });
  return n;
}

export function safeReportId(id) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(s)) throw Object.assign(new Error('Invalid report id'), { code: 'BAD_INPUT' });
  return s;
}

export function cacheRoot() {
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'egov-bug-reporter')
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'egov-bug-reporter');
}

export function reportDir(reportId) {
  return join(cacheRoot(), safeReportId(reportId));
}

export async function stageFile({ reportId, name, seq, data }) {
  const dir = reportDir(reportId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, safeName(name));
  const buf = Buffer.from(String(data || ''), 'base64');
  if (Number(seq) === 0) await writeFile(file, buf);
  else await appendFile(file, buf);
  return { bytes: buf.length };
}

export async function writeReportFile(reportId, name, content) {
  const dir = reportDir(reportId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, safeName(name)), content, 'utf8');
  return join(dir, name);
}

export async function removeReport(reportId) {
  await rm(reportDir(reportId), { recursive: true, force: true });
}

/** Deletes staged reports older than `days` (default 3). */
export async function purgeOld(days = 3) {
  const root = cacheRoot();
  const maxAge = Math.max(0, Number(days) || 3) * 86400000;
  let removed = 0;
  let entries = [];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const e of entries) {
    try {
      const p = join(root, e);
      const s = await stat(p);
      if (Date.now() - s.mtimeMs > maxAge) {
        await rm(p, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

/** Copies attachments GitHub rejected to ~/Downloads/bug-reporter/<issue#>/ for manual drag-and-drop. */
export async function saveToDownloads(reportId, issueNumber, names) {
  const target = join(homedir(), 'Downloads', 'bug-reporter', String(issueNumber || reportId));
  await mkdir(target, { recursive: true });
  for (const n of names) await copyFile(join(reportDir(reportId), safeName(n)), join(target, n));
  return target;
}
