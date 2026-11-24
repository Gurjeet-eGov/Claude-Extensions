// Where automation results live on the laptop: sheets/.testrun/automation/
//   suites.json          { suites: [{ id, name, repo, workflow, artifact, envInput, casePattern, masking[], format, linkedBy, linkedAt,
//                                     workflowId, workflowPath, inputs[], defaultBranch }] }
//                        (workflow is the GitHub workflow's name; workflowId, workflowPath and inputs, its Run
//                         workflow form, come with the GitHub link: lib/automation/github-runs.mjs)
//   index.json           { version: 1, runs: [run without its tests, plus bytes] }
//   runs/<id>.json.gz    one run, tests and all (gzip)
// Every file is written to a temporary name and renamed over the old one. Only the last N runs
// of each suite › workbook › test suite › test cycle are kept (N: app.json automation.keep,
// default 2); a run pushed out is deleted for good, and the caller is told which.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { metaOf, RUN_ID, compileMasking, compileCasePattern, cleanAttach } from './results.mjs';

export const DEFAULT_KEEP = 2;
export const SUITE_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

const err = (code, message) => Object.assign(new Error(message), { code });
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** app.json's automation block: { keep } (host only). */
export function normalizeAutomationSettings(a = {}) {
  const keep = Math.round(Number(a && a.keep));
  return { keep: keep >= 1 && keep <= 20 ? keep : DEFAULT_KEEP };
}

/** A GitHub repository link (or owner/name) -> 'owner/name'; '' for none; throws for anything else. */
export function cleanRepo(v) {
  const s = clip(v, 300).replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!s) return '';
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(s);
  if (!m || /^https?:\/\//i.test(s) && !/github\.com/i.test(s)) throw err('BAD_INPUT', 'Paste the suite\'s GitHub repository link, like https://github.com/owner/repo.');
  return `${m[1]}/${m[2]}`;
}

export const INPUT_TYPES = ['string', 'choice', 'boolean', 'environment', 'number'];

/**
 * A workflow's Run workflow inputs, as kept: [{ name, type, description, required, default, options }].
 * Values are text, as GitHub's dispatch API takes them ('true' / 'false' for a boolean).
 */
export function normalizeInputs(list) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object') continue;
    const name = clip(x.name, 100);
    if (!name || seen.has(name) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) continue;
    seen.add(name);
    const type = INPUT_TYPES.includes(x.type) ? x.type : 'string';
    const options = type === 'choice' ? (Array.isArray(x.options) ? x.options : []).map((o) => clip(o, 200)).filter((o) => o !== '').slice(0, 100) : [];
    let dflt = x.default == null ? '' : typeof x.default === 'boolean' ? String(x.default) : clip(x.default, 500);
    if (type === 'boolean') dflt = dflt === 'true' ? 'true' : 'false';
    out.push({ name, type, description: clip(x.description, 300), required: x.required === true, default: dflt, options });
    if (out.length >= 25) break;
  }
  return out;
}

/** What the GitHub link adds to a suite (empty when it has none). */
const NO_GITHUB = { workflow: '', workflowId: 0, workflowPath: '', inputs: [], artifact: '', envInput: '', defaultBranch: '' };

function normalizeSuite(s) {
  if (!s || typeof s !== 'object' || !SUITE_ID.test(String(s.id || ''))) return null;
  const workflowId = Math.round(Number(s.workflowId));
  return {
    id: String(s.id),
    name: clip(s.name, 80) || 'Automated suite',
    repo: clip(s.repo, 140),
    workflow: clip(s.workflow, 140),
    artifact: clip(s.artifact, 140),
    envInput: clip(s.envInput, 80),
    casePattern: clip(s.casePattern, 120),
    masking: (Array.isArray(s.masking) ? s.masking : []).map((x) => clip(x, 200)).filter(Boolean).slice(0, 20),
    format: ['junit', 'ctrf', 'mixed'].includes(s.format) ? s.format : '',
    linkedBy: clip(s.linkedBy, 80),
    linkedAt: clip(s.linkedAt, 40),
    workflowId: workflowId > 0 ? workflowId : 0,
    workflowPath: clip(s.workflowPath, 300),
    inputs: normalizeInputs(s.inputs),
    defaultBranch: clip(s.defaultBranch, 250),
  };
}

const slug = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'suite';
const groupKey = (m) => JSON.stringify([m.suiteId, m.attach.book, m.attach.tab, m.attach.cycle]);
const when = (r) => `${r.startedAt || ''}|${r.importedAt || ''}`;
const newestFirst = (a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0);

export class AutomationStore {
  constructor(sheetsDir) {
    this.dir = join(sheetsDir, '.testrun', 'automation');
    this.runsDir = join(this.dir, 'runs');
    this.suitesFile = join(this.dir, 'suites.json');
    this.indexFile = join(this.dir, 'index.json');
    this.cache = null; // the index, read once
  }

  write(file, data) {
    mkdirSync(this.runsDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  }

  // ------------------------------------------------------------------ suites

  suites() {
    try {
      const j = JSON.parse(readFileSync(this.suitesFile, 'utf8'));
      return (Array.isArray(j.suites) ? j.suites : []).map(normalizeSuite).filter(Boolean);
    } catch {
      return [];
    }
  }

  suite(id) {
    return this.suites().find((s) => s.id === id) || null;
  }

  writeSuites(list) {
    this.write(this.suitesFile, JSON.stringify({ suites: list }, null, 2));
  }

  /**
   * Link a suite, or change one (input.id). input: { id?, name, repo, casePattern, masking: [] | text (one per line) }.
   * Throws BAD_INPUT with a message to show. Returns the suite as saved.
   */
  saveSuite(input, { by = '', now = new Date() } = {}) {
    const list = this.suites();
    const was = input.id ? list.find((s) => s.id === input.id) : null;
    if (input.id && !was) throw err('GONE', 'That suite is not linked any more.');
    const name = clip(input.name, 80);
    if (!name) throw err('BAD_INPUT', 'Give the suite a name, as people should see it in Test Run.');
    if (list.some((s) => s !== was && s.name.toLowerCase() === name.toLowerCase())) throw err('BAD_INPUT', `A suite called “${name}” is already linked. Choose another name.`);
    const repo = cleanRepo(input.repo);
    const casePattern = clip(input.casePattern, 120);
    compileCasePattern(casePattern); // throws BAD_INPUT
    const masking = (Array.isArray(input.masking) ? input.masking : String(input.masking || '').split(/\r?\n/)).map((x) => clip(x, 200)).filter(Boolean);
    const mk = compileMasking(masking);
    if (mk.errors.length) throw err('BAD_INPUT', mk.errors[0]);
    if (masking.length > 20) throw err('BAD_INPUT', 'At most 20 masking rules.');
    let id = was ? was.id : slug(name);
    while (!was && list.some((s) => s.id === id)) id = `${slug(name)}-${randomBytes(2).toString('hex')}`;
    const suite = normalizeSuite({
      ...(was || { ...NO_GITHUB, format: '', linkedBy: by, linkedAt: now.toISOString() }),
      ...(was && was.repo !== repo ? NO_GITHUB : {}), // another repository: its workflow link no longer fits
      id, name, repo, casePattern, masking,
    });
    this.writeSuites(was ? list.map((s) => (s === was ? suite : s)) : list.concat([suite]));
    return suite;
  }

  /**
   * Link a suite to its GitHub workflow (or unlink it: link null). link: { workflowId, workflowPath,
   * workflow (its name), inputs, artifact, envInput, defaultBranch }. Returns the suite as saved, or null.
   */
  setGithub(id, link) {
    const list = this.suites();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const l = link || NO_GITHUB;
    const next = normalizeSuite({
      ...list[i],
      workflow: l.workflow, workflowId: l.workflowId, workflowPath: l.workflowPath, inputs: l.inputs,
      artifact: l.artifact, envInput: l.envInput, defaultBranch: l.defaultBranch,
    });
    list[i] = next;
    this.writeSuites(list);
    return next;
  }

  /** Note the results format a suite's imports use (shown on its page). */
  noteFormat(id, format) {
    const list = this.suites();
    const s = list.find((x) => x.id === id);
    if (!s || s.format === format) return;
    s.format = format;
    this.writeSuites(list);
  }

  /** Unlink a suite; its runs are deleted with it. Returns { suite, runs: [meta] } or null. */
  removeSuite(id) {
    const list = this.suites();
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    const gone = this.index().filter((m) => m.suiteId === id);
    for (const m of gone) this.dropFile(m.id);
    this.saveIndex(this.index().filter((m) => m.suiteId !== id));
    this.writeSuites(list.filter((x) => x !== s));
    return { suite: s, runs: gone };
  }

  // ------------------------------------------------------------------ runs

  runFile(id) {
    if (!RUN_ID.test(String(id || ''))) throw err('BAD_INPUT', 'Not a run ID.');
    return join(this.runsDir, `${id}.json.gz`);
  }

  /** Every kept run without its tests, newest first. */
  index() {
    if (!this.cache) this.cache = this.loadIndex();
    return this.cache.slice();
  }

  loadIndex() {
    let runs = null;
    try {
      const j = JSON.parse(readFileSync(this.indexFile, 'utf8'));
      if (j && Array.isArray(j.runs)) runs = j.runs.filter((m) => m && RUN_ID.test(String(m.id)) && m.attach && existsSync(join(this.runsDir, `${m.id}.json.gz`)));
    } catch { /* missing or damaged: read the runs themselves */ }
    if (!runs) {
      runs = [];
      let files = [];
      try { files = readdirSync(this.runsDir); } catch { files = []; }
      for (const f of files) {
        const id = f.replace(/\.json\.gz$/, '');
        if (!RUN_ID.test(id)) continue;
        const run = this.run(id);
        if (run && run.attach) runs.push({ ...metaOf(run), bytes: statSync(join(this.runsDir, f)).size });
      }
      if (runs.length || existsSync(this.indexFile)) this.writeIndexFile(runs);
    }
    return runs.sort(newestFirst);
  }

  writeIndexFile(runs) {
    this.write(this.indexFile, JSON.stringify({ version: 1, runs }, null, 1));
  }

  saveIndex(runs) {
    this.cache = runs.slice().sort(newestFirst);
    this.writeIndexFile(this.cache);
  }

  meta(id) {
    return this.index().find((m) => m.id === id) || null;
  }

  /** One run, tests and all, or null. */
  run(id) {
    let file;
    try { file = this.runFile(id); } catch { return null; }
    if (!existsSync(file)) return null;
    try { return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')); } catch { return null; }
  }

  dropFile(id) {
    try { unlinkSync(this.runFile(id)); } catch { /* already gone */ }
  }

  /** The runs kept with this one: same suite, workbook, test suite and cycle; newest first. */
  group(m) {
    const k = groupKey(m);
    return this.index().filter((x) => groupKey(x) === k);
  }

  /** Which kept runs a run joining this group would push out, newest first kept. Throws TOO_OLD when it would be the one to go. */
  wouldRemove(m, keep) {
    const n = normalizeAutomationSettings({ keep }).keep;
    const all = this.group(m).filter((x) => x.id !== m.id).concat([m]).sort(newestFirst);
    const out = all.slice(n);
    if (out.some((x) => x.id === m.id)) {
      throw err('TOO_OLD', `This run is older than the ${n} already kept for ${m.attach.tab} › ${m.attach.cycle || 'Status'}, so it would be removed straight away. Delete one of those first, or attach it to another cycle.`);
    }
    return out;
  }

  /** Keep a new run. Returns { meta, removed: [meta] } (runs pushed out by the retention rule, deleted). */
  add(run, keep = DEFAULT_KEEP) {
    if (!run || !RUN_ID.test(String(run.id))) throw err('BAD_INPUT', 'Not a run.');
    cleanAttach(run.attach); // never a run without its workbook › test suite › cycle
    const meta = metaOf(run);
    const removed = this.wouldRemove(meta, keep);
    const gz = gzipSync(Buffer.from(JSON.stringify(run)));
    this.write(this.runFile(run.id), gz);
    meta.bytes = gz.length;
    for (const m of removed) this.dropFile(m.id);
    const gone = new Set(removed.map((m) => m.id));
    this.saveIndex(this.index().filter((m) => !gone.has(m.id)).concat([meta]));
    return { meta, removed };
  }

  /** Delete a run for good. Returns its meta, or null when it was not there. */
  remove(id) {
    const m = this.meta(id);
    if (!m) return null;
    this.dropFile(id);
    this.saveIndex(this.index().filter((x) => x.id !== id));
    return m;
  }

  /** Attach a run to another workbook › test suite › cycle. Returns { meta, removed }. */
  reattach(id, attach, keep = DEFAULT_KEEP) {
    const run = this.run(id);
    if (!run) throw err('GONE', 'That run is not in Test Run any more.');
    run.attach = cleanAttach(attach);
    const meta = { ...metaOf(run), bytes: (this.meta(id) || {}).bytes || 0 };
    const removed = this.wouldRemove(meta, keep);
    const gz = gzipSync(Buffer.from(JSON.stringify(run)));
    this.write(this.runFile(id), gz);
    meta.bytes = gz.length;
    for (const m of removed) this.dropFile(m.id);
    const gone = new Set(removed.map((m) => m.id));
    this.saveIndex(this.index().filter((m) => m.id !== id && !gone.has(m.id)).concat([meta]));
    return { meta, removed };
  }
}
