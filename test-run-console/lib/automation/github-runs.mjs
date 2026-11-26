// Automated suites that run in their own repository's GitHub Actions: linking a suite to its
// workflow, starting runs, following them, and bringing their results in. Every GitHub call goes
// through lib/github.mjs (REST paths only), so moving from gh to a token changes nothing here.
//
//   POST /api/automation/github/check {repo}                 the repository, and its workflows with their Run workflow inputs
//   POST /api/automation/github/artifacts {repo, workflowId}  the latest run's artifacts, and which hold a results file
//   POST /api/automation/github/link {id?, name, repo, workflowId, artifact, envInput, casePattern, masking}
//   GET  /api/automation/github/branches?suite=               the run form: branches and the repository's environments
//   GET  /api/automation/github/form?suite=&branch=           the run form's fields on that branch (its own workflow file)
//   GET  /api/automation/github/runs?suite=                   recent finished runs of the suite's workflow (Import from GitHub)
//   POST /api/automation/github/import {suite, runId?, book, tab, cycle}   bring one in (the latest finished one without runId)
//   POST /api/automation/github/run {suite, branch, inputs, book, tab, cycle}   start a run; a job follows it
//   GET  /api/automation/jobs        the runs going (and those finished in the last day) this person may see
//   GET  /api/automation/job?id=     one of them
//   POST /api/automation/job/cancel {id}    POST /api/automation/job/dismiss {id}
//   GET  /api/automation/github/status      (the host) which GitHub access Test Run has
//   POST /api/automation/settings {keep?, checkEvery?, excludeEnvironments?}  (the host) runs kept per test
//        suite and cycle; minutes between looks at a run Test Run follows (1 or 5); GitHub environments
//        the run form leaves out (github-pages by default)
//
// A started run is a job, kept in sheets/.testrun/automation/jobs.json so it survives a restart:
// { id, suiteId, attach, branch, inputs, by, githubRunId, state, … }. state: waiting (started,
// GitHub's run not found yet) → queued / in_progress → importing → imported | no_results |
// cancelled | failed. The run is found after starting it from the workflow's workflow_dispatch
// runs on that branch, created since just before it was started, that weren't there before,
// started by the same GitHub account when that's known: whether or not GitHub's answer names it.
//
// A run may also say where the suite published its own report: an artifact named report-link
// holding report-url.txt, one line, the report's address. A run brought in keeps it (source.reportUrl,
// an http(s) address only), and ↗ Git Report opens it instead of the run on GitHub. Without one, or
// with one that can't be read, the import goes on as before.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import YAML from 'yaml';
import JSZip from 'jszip';
import { maySeeSuite, mayStartRuns } from '../team.mjs';
import { canAct } from './access.mjs';
import { splitRepo } from '../github.mjs';
import { parseResults, buildRun, passRate, cleanReportUrl } from './results.mjs';
import { cleanRepo, normalizeInputs, normalizeAutomationSettings, CHECK_EVERY, MAX_EXCLUDE_ENVIRONMENTS, MAX_ENVIRONMENT_NAME } from './store.mjs';

const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const ACTIVE = new Set(['waiting', 'queued', 'in_progress', 'importing']);
const KEEP_FINISHED_MS = 24 * 3600 * 1000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // a results artifact is small; a full report with videos isn't one
const CHECK_ARTIFACT_BYTES = 50 * 1024 * 1024; // larger ones aren't downloaded just to look inside
const MAX_ENTRIES = 2000;
const MAX_RESULT_BYTES = 200 * 1024 * 1024;
export const REPORT_LINK = 'report-link'; // the artifact that says where the suite's own report is
const MAX_REPORT_LINK_BYTES = 64 * 1024; // a zip of one short line; anything bigger isn't read
const isReportLink = (a) => String((a && a.name) || '').toLowerCase() === REPORT_LINK;

// ---------------------------------------------------------------------------
// Workflow files
// ---------------------------------------------------------------------------

/**
 * A workflow file -> { name, dispatch (can it be started by hand), inputs: [{ name, type, description,
 * required, default, options }] } from on.workflow_dispatch.inputs. Throws BAD_WORKFLOW for unreadable YAML.
 */
export function parseWorkflowInputs(text) {
  let doc;
  try {
    doc = YAML.parse(String(text || ''), { maxAliasCount: 100, prettyErrors: false });
  } catch (e) {
    throw err('BAD_WORKFLOW', `The workflow file isn't readable YAML (${String(e.message).split('\n')[0]}).`);
  }
  if (!doc || typeof doc !== 'object') return { name: '', dispatch: false, inputs: [] };
  const on = Object.prototype.hasOwnProperty.call(doc, 'on') ? doc.on : doc.true; // YAML 1.1 readers turn `on:` into true
  let dispatch = false;
  let raw = null;
  if (typeof on === 'string') dispatch = on === 'workflow_dispatch';
  else if (Array.isArray(on)) dispatch = on.includes('workflow_dispatch');
  else if (on && typeof on === 'object' && Object.prototype.hasOwnProperty.call(on, 'workflow_dispatch')) {
    dispatch = true;
    raw = on.workflow_dispatch && typeof on.workflow_dispatch === 'object' ? on.workflow_dispatch.inputs : null;
  }
  const inputs = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, def] of Object.entries(raw)) {
      const d = def && typeof def === 'object' ? def : {};
      inputs.push({
        name,
        type: d.type || 'string',
        description: d.description == null ? '' : String(d.description),
        required: d.required === true,
        default: d.default,
        options: Array.isArray(d.options) ? d.options.map((x) => (x == null ? '' : String(x))) : [],
      });
    }
  }
  return { name: typeof doc.name === 'string' ? doc.name : '', dispatch, inputs: normalizeInputs(inputs) };
}

/**
 * The values to send for a suite's inputs, checked against its Run workflow form. given: { name: value }.
 * Booleans go as 'true' / 'false'; a choice must be one of its options; a required one can't be empty
 * (its default fills it when one is set). Throws BAD_INPUT naming the field.
 */
export function inputValues(defs, given = {}) {
  const out = {};
  for (const d of defs || []) {
    let v = given[d.name];
    if (d.type === 'boolean') {
      out[d.name] = v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : (d.default === 'true' ? 'true' : 'false');
      continue;
    }
    v = v == null ? '' : clip(v, 1000);
    if (v === '' && d.default !== '') v = d.default;
    if (d.type === 'choice' && v !== '' && d.options.length && !d.options.includes(v)) throw err('BAD_INPUT', `“${v}” isn't one of the choices for ${d.name}.`);
    if (d.type === 'number' && v !== '' && !Number.isFinite(Number(v))) throw err('BAD_INPUT', `${d.name} takes a number.`);
    if (d.required && v === '') throw err('BAD_INPUT', `Fill in ${d.name}: the workflow needs it.`);
    if (v !== '') out[d.name] = v;
  }
  return out;
}

/**
 * Which field of a Run workflow form says where the tests run: keep (the one chosen) while the form
 * still has it, else the form's field of type environment, else none ('').
 */
export function envFieldOf(inputs, keep = '') {
  const list = inputs || [];
  if (keep && list.some((x) => x.name === keep)) return keep;
  const e = list.find((x) => x.type === 'environment');
  return e ? e.name : '';
}

/**
 * The run a dispatch made, from a list of the workflow's runs (GitHub's JSON): event workflow_dispatch,
 * on the branch, created at or after since (less a minute for the clocks), not among known (ids seen
 * before starting) or claimed (ids other jobs follow), by actor when known. The newest that fits, or null.
 */
export function findRunAfterDispatch(runs, { since, branch, actor, known = [], claimed = [] } = {}) {
  const skip = new Set([...known, ...claimed].map(String));
  const from = Number(since || 0) - 60000;
  const fits = (r) => r && r.event === 'workflow_dispatch' && (!branch || r.head_branch === branch) && !skip.has(String(r.id)) && Date.parse(r.created_at) >= from;
  const by = (r) => !actor || [r.actor && r.actor.login, r.triggering_actor && r.triggering_actor.login].includes(actor);
  const list = (runs || []).filter((r) => fits(r) && by(r));
  list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  return list[0] || null;
}

// ---------------------------------------------------------------------------
// Results inside an artifact
// ---------------------------------------------------------------------------

/** The .xml and .json files inside an artifact's zip (anything else, a report's pictures say, is left out). */
export async function resultFilesIn(zipBuf, label = 'artifact') {
  let zip;
  try { zip = await JSZip.loadAsync(zipBuf); } catch (e) { throw err('BAD_FORMAT', `The ${label} isn't a readable .zip (${e.message}).`); }
  const entries = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX\/|\.)/.test(e.name));
  if (entries.length > MAX_ENTRIES) throw err('TOO_BIG', `The ${label} holds more than ${MAX_ENTRIES} files. Upload the results file in an artifact of its own.`);
  const out = [];
  let total = 0;
  for (const e of entries.filter((x) => /\.(xml|json)$/i.test(x.name))) {
    const buf = await e.async('nodebuffer');
    total += buf.length;
    if (total > MAX_RESULT_BYTES) throw err('TOO_BIG', `The results files in the ${label} come to more than ${MAX_RESULT_BYTES / 1048576} MB.`);
    out.push({ name: `${label} › ${e.name}`, buf });
  }
  return out;
}

/**
 * The first non-empty line, trimmed, of report-url.txt (in any folder) inside a report-link artifact's
 * zip: '' when there is no such file, or it is empty or too large. Throws BAD_FORMAT for an unreadable zip.
 */
export async function reportUrlIn(zipBuf) {
  let zip;
  try { zip = await JSZip.loadAsync(zipBuf); } catch (e) { throw err('BAD_FORMAT', `The ${REPORT_LINK} artifact isn't a readable .zip (${e.message}).`); }
  const e = Object.values(zip.files).find((x) => !x.dir && !/(^|\/)__MACOSX\//.test(x.name) && /(^|\/)report-url\.txt$/i.test(x.name));
  if (!e) return '';
  const size = e._data && e._data.uncompressedSize; // JSZip's own record of the file's size, so a huge one isn't unpacked
  if (typeof size === 'number' && size > MAX_REPORT_LINK_BYTES) return '';
  const text = await e.async('string');
  return text.split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
}

// ---------------------------------------------------------------------------
// Jobs, kept on disk
// ---------------------------------------------------------------------------

class JobFile {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'jobs.json');
    this.list = [];
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      if (j && Array.isArray(j.jobs)) this.list = j.jobs.filter((x) => x && typeof x.id === 'string' && x.attach && x.suiteId);
    } catch { /* none yet */ }
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, jobs: this.list }, null, 1));
    renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/**
 * ctx: { sheetsDir, store (AutomationStore), github (lib/github.mjs client), checkAttach(q, person, suite?),
 *        checkBooks(given, person) (a suite's workbooks from a request),
 *        keep(), setKeep(n), checkEvery() (minutes: 1 or 5), setCheckEvery(n), excludeEnvironments() (names
 *        the run form leaves out), setExcludeEnvironments(list), mayOpen(person, book),
 *        isOwner(person), jsonBody(req), log, pollMs (fixed ms, for tests: overrides checkEvery),
 *        findTimeoutMs (how long to look for a started run, 1 min), now() (ms) }
 */
export function createGithubRuns(ctx) {
  const { store, checkAttach, mayOpen, jsonBody } = ctx;
  const github = ctx.github;
  const log = ctx.log || (() => {});
  const now = ctx.now || (() => Date.now());
  // How often GitHub is asked about a run Test Run follows: the host's setting, 5 minutes
  // normally or 1 while debugging. Finding a run just started is quicker (every 10 s, for up
  // to findTimeoutMs), so ▶ Run shows it within moments.
  const pollMs = () => ctx.pollMs || normalizeAutomationSettings({ checkEvery: ctx.checkEvery ? ctx.checkEvery() : undefined }).checkEvery * 60000;
  const FIND_MS = 10000;
  const nextDelay = () => (jobs.list.some((j) => ACTIVE.has(j.state) && !j.githubRunId) ? Math.min(pollMs(), FIND_MS) : pollMs());
  const findTimeoutMs = ctx.findTimeoutMs || 60000; // then the job fails as notFound: the page says "Unable to find the GitHub job"
  const isOwner = ctx.isOwner || ((p) => !!p && p.role === 'owner');
  const keep = () => normalizeAutomationSettings({ keep: ctx.keep ? ctx.keep() : undefined }).keep;
  /** The environments the run form leaves out, lower case (the host's setting; github-pages by default). */
  const excluded = () => new Set(normalizeAutomationSettings({ excludeEnvironments: ctx.excludeEnvironments ? ctx.excludeEnvironments() : undefined }).excludeEnvironments.map((x) => x.toLowerCase()));
  const jobs = new JobFile(join(ctx.sheetsDir, '.testrun', 'automation'));
  let timer = null;
  let ticking = false;
  let stopped = false;
  let login = null; // the GitHub account, once asked (null: not asked yet; '' unknown)

  const okJson = (obj) => ({ code: 200, json: { ok: true, ...obj } });
  const fail = (code, error, extra) => ({ code: 200, json: { ok: false, code, error, ...(extra || {}) } });
  const forbid = (error) => ({ code: 403, json: { ok: false, code: 'FORBIDDEN', error } });
  const noRuns = (person) => forbid(person.role === 'viewer' ? 'View only: you can read automated results, not start runs or import them.' : 'Your test lead has not let you start runs or import results for this suite.');
  const withRate = (m) => (m ? { ...m, passRate: passRate(m.totals) } : null);
  const ownerAs = (name) => ({ role: 'owner', name: name || 'Test Run', local: false, remember: false });
  const repoOf = (full) => {
    const r = splitRepo(full);
    if (!r) throw err('BAD_INPUT', 'Paste the suite\'s GitHub repository link, like https://github.com/owner/repo.');
    return r;
  };
  const runsPage = (full) => `https://github.com/${full}/actions`;

  /** A GitHub problem in plain words. what: what was being done ("read the repository"). */
  function ghProblem(e, full, what) {
    if (e && /^(BAD_|TOO_|NO_ATTACH|NO_BOOK|NO_TAB|NO_CYCLE|FORBIDDEN|GONE|ALREADY)/.test(e.code || '') && !e.status) return e;
    const msg = String((e && e.message) || e || 'no answer');
    if (e && e.code === 'NO_GH') return err('NO_GH', 'The GitHub CLI (gh) is not installed. Install it and run: gh auth login');
    if (e && (e.code === 'GH_AUTH' || e.status === 401)) return err('GH_AUTH', `GitHub didn't accept Test Run's access (${msg}). On the host-server, run: gh auth login`);
    if (e && e.status === 404) return err('GH_NOT_FOUND', `Test Run can't ${what}${full ? ` in ${full}` : ''}: GitHub says it isn't there, or Test Run's GitHub access can't see it.`);
    if (e && e.status === 403) return err('GH_FORBIDDEN', `GitHub refused to let Test Run ${what}${full ? ` in ${full}` : ''} (${msg}). Its GitHub access needs Actions write and Contents read there.`);
    if (e && e.code === 'GH_TIMEOUT') return err('GH_TIMEOUT', `GitHub didn't answer in time when Test Run tried to ${what}. Try again.`);
    return err('GH_FAILED', `Test Run couldn't ${what}${full ? ` in ${full}` : ''}: ${msg}`);
  }

  async function whoAmI() {
    if (login !== null) return login;
    try { const u = await github.getUser(); login = (u && u.login) || ''; } catch { login = ''; }
    return login;
  }

  // ------------------------------------------------------------------ link a suite

  /** The repository and its workflows; those that can be started by hand come with their inputs. */
  async function check(body) {
    const full = cleanRepo(body.repo);
    if (!full) throw err('BAD_INPUT', 'Paste the suite\'s GitHub repository link, like https://github.com/owner/repo.');
    const { owner, repo } = repoOf(full);
    let info;
    try { info = await github.getRepo(owner, repo); } catch (e) { throw ghProblem(e, full, 'read the repository'); }
    let wf;
    try { wf = await github.listWorkflows(owner, repo); } catch (e) { throw ghProblem(e, full, 'list the workflows'); }
    const ref = info.default_branch || 'main';
    const list = ((wf && wf.workflows) || []).filter((w) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(String(w.path || ''))).slice(0, 40);
    const workflows = [];
    for (const w of list) {
      const out = { id: w.id, name: w.name || w.path.split('/').pop(), path: w.path, active: w.state === 'active', dispatch: false, inputs: [], error: '' };
      try {
        const file = await github.getFile(owner, repo, w.path, ref);
        if (!file) out.error = `${w.path} isn't on ${ref}.`;
        else Object.assign(out, (({ dispatch, inputs }) => ({ dispatch, inputs }))(parseWorkflowInputs(file.toString('utf8'))));
      } catch (e) {
        out.error = e.code === 'BAD_WORKFLOW' ? e.message : ghProblem(e, full, `read ${w.path}`).message;
      }
      workflows.push(out);
    }
    return {
      repo: { fullName: info.full_name || full, private: !!info.private, defaultBranch: ref, url: info.html_url || `https://github.com/${full}`, archived: !!info.archived },
      workflows,
      counts: { total: workflows.length, dispatch: workflows.filter((w) => w.dispatch && w.active).length },
    };
  }

  /** One workflow of a repository, read now: { id, name, path, inputs, defaultBranch }. Throws BAD_INPUT when it can't be started by hand. */
  async function workflowOf(full, workflowId) {
    const { owner, repo } = repoOf(full);
    let info, w;
    try {
      info = await github.getRepo(owner, repo);
      w = await github.getWorkflow(owner, repo, workflowId);
    } catch (e) { throw ghProblem(e, full, 'read the workflow'); }
    const ref = info.default_branch || 'main';
    let file;
    try { file = await github.getFile(owner, repo, w.path, ref); } catch (e) { throw ghProblem(e, full, `read ${w.path}`); }
    if (!file) throw err('BAD_INPUT', `${w.path} isn't on ${ref} in ${full}.`);
    const p = parseWorkflowInputs(file.toString('utf8'));
    if (!p.dispatch) throw err('BAD_INPUT', `“${w.name}” can't be started by hand: add workflow_dispatch to the on: block of ${w.path}.`);
    return { id: Number(w.id), name: w.name || p.name || w.path, path: w.path, inputs: p.inputs, defaultBranch: ref };
  }

  /** The latest finished run (of the last few) with artifacts, and which of them hold a results file. */
  async function artifacts(body) {
    const full = cleanRepo(body.repo);
    const { owner, repo } = repoOf(full);
    const workflowId = Number(body.workflowId);
    if (!workflowId) throw err('BAD_INPUT', 'Choose the workflow first.');
    let runs;
    try { runs = await github.listRuns(owner, repo, { workflowId, status: 'completed', per_page: 5 }); } catch (e) { throw ghProblem(e, full, 'list the workflow\'s runs'); }
    const list = (runs && runs.workflow_runs) || [];
    if (!list.length) return { run: null, artifacts: [] };
    let chosen = null;
    let arts = [];
    for (const r of list) {
      let a;
      try { a = await github.listArtifacts(owner, repo, r.id); } catch (e) { throw ghProblem(e, full, 'list the run\'s artifacts'); }
      arts = ((a && a.artifacts) || []).filter((x) => !x.expired);
      chosen = r;
      if (arts.length) break;
    }
    const out = [];
    for (const a of arts.slice(0, 8)) {
      const item = { id: a.id, name: a.name, size: a.size_in_bytes || 0, results: null, note: '' };
      if (item.size > CHECK_ARTIFACT_BYTES) item.note = 'too large to look inside';
      else {
        try {
          const files = await resultFilesIn(await github.downloadArtifact(owner, repo, a.id), `artifact “${a.name}”`);
          const parsed = files.length ? await parseResults(files).catch(() => null) : null;
          if (parsed) {
            item.results = { format: parsed.format, formatLabel: parsed.formatLabel, files: parsed.files.length, tests: parsed.totals.total, tool: parsed.tool };
            // the results files themselves (not the rest of the artifact), to spot the same ones in another artifact of the run
            const used = new Set(parsed.files.map((x) => x.name));
            const h = createHash('sha256');
            for (const f of files.filter((x) => used.has(x.name)).map((x) => x.buf.toString('base64')).sort()) h.update(f).update('\n');
            item.digest = h.digest('hex');
          } else item.note = 'no results file';
        } catch (e) {
          item.note = e.code === 'TOO_BIG' || e.code === 'BAD_FORMAT' ? e.message : 'could not be read';
        }
      }
      out.push(item);
    }
    // A run may upload the same results twice: in its whole output (results-<environment>) and in a
    // results-only artifact (test-results). Offer them once, in the smallest artifact that holds them.
    const smallest = new Map();
    for (const x of out) if (x.digest && (!smallest.has(x.digest) || x.size < smallest.get(x.digest).size)) smallest.set(x.digest, x);
    const shown = out.filter((x) => !x.digest || smallest.get(x.digest) === x).map(({ digest, ...x }) => x);
    return { run: { id: chosen.id, number: chosen.run_number, createdAt: chosen.created_at, branch: chosen.head_branch, conclusion: chosen.conclusion, htmlUrl: chosen.html_url }, artifacts: shown };
  }

  /** Save a suite with its GitHub workflow. */
  async function link(body, person) {
    const full = cleanRepo(body.repo);
    if (!full) throw err('BAD_INPUT', 'Paste the suite\'s GitHub repository link, like https://github.com/owner/repo.');
    const w = await workflowOf(full, Number(body.workflowId));
    let envInput = clip(body.envInput, 100);
    if (envInput && !w.inputs.some((x) => x.name === envInput)) throw err('BAD_INPUT', `“${w.name}” has no option called ${envInput}.`);
    if (!envInput) envInput = envFieldOf(w.inputs, ''); // none chosen: the workflow's environment field, when it has one
    const id = body.id ? String(body.id) : '';
    const saved = store.saveSuite({ id, name: body.name, repo: full, casePattern: body.casePattern, masking: body.masking, books: ctx.checkBooks ? ctx.checkBooks(body.books, person) : undefined }, { by: person.name });
    const suite = store.setGithub(saved.id, { workflowId: w.id, workflowPath: w.path, workflow: w.name, inputs: w.inputs, artifact: clip(body.artifact, 140) || 'test-results', envInput, defaultBranch: w.defaultBranch });
    return { suite, created: !id };
  }

  // ------------------------------------------------------------------ bring a run in

  /** A linked suite this person may run, with its repository split. */
  function runnable(id, person) {
    const suite = store.suite(String(id || ''));
    if (!suite || !maySeeSuite(person, suite.id)) throw err('NO_SUITE', 'That suite is not linked any more.');
    if (!mayStartRuns(person, suite.id)) throw err('FORBIDDEN', person.role === 'viewer' ? 'View only: you can read automated results, not start runs or import them.' : 'Your test lead has not let you start runs or import results for this suite.');
    if (!suite.repo || !suite.workflowId) throw err('NOT_LINKED', `“${suite.name}” isn't linked to a GitHub workflow yet. Link it in ✎ Edit.`);
    return { suite, ...repoOf(suite.repo) };
  }

  /** A kept run of this suite, from this GitHub run, attached here: the meta, or null. */
  const alreadyKept = (suiteId, runId, attach) => store.index().find((m) => m.suiteId === suiteId && m.source && String(m.source.runId) === String(runId) &&
    (!attach || (m.attach.book === attach.book && m.attach.tab === attach.tab && m.attach.cycle === attach.cycle))) || null;

  /**
   * Download a finished GitHub run's results artifact, read it, and keep it as a run attached to attach.
   * ghRun: GitHub's JSON for the run. o: { by, branch, inputs, flags (the yes/no fields of the form it was started with) }. Returns { meta, removed, summary, artifact },
   * or throws NO_RESULTS (no such artifact, or no results file in it) and the rest as they come.
   */
  async function importRun(suite, owner, repo, ghRun, attach, o = {}) {
    const full = `${owner}/${repo}`;
    let list;
    try { list = ((await github.listArtifacts(owner, repo, ghRun.id)) || {}).artifacts || []; } catch (e) { throw ghProblem(e, full, 'list the run\'s artifacts'); }
    const named = suite.artifact ? list.filter((a) => a.name === suite.artifact) : list.filter((a) => !isReportLink(a));
    const live = named.filter((a) => !a.expired);
    if (!named.length) {
      throw err('NO_RESULTS', list.length
        ? `The run has no artifact named “${suite.artifact}” (it has ${list.map((a) => `“${a.name}”`).join(', ')}). Change the results artifact in ✎ Edit, or upload the results as “${suite.artifact}”.`
        : `The run finished without uploading any artifact, so there are no results to bring in. Check that the workflow uploads “${suite.artifact || 'test-results'}” with if: always().`);
    }
    if (!live.length) throw err('NO_RESULTS', `The artifact “${named[0].name}” has expired on GitHub, so its results can't be brought in any more.`);
    let files = [];
    let used = null;
    for (const a of live) {
      if ((a.size_in_bytes || 0) > MAX_ARTIFACT_BYTES) throw err('TOO_BIG', `The artifact “${a.name}” is ${Math.round(a.size_in_bytes / 1048576)} MB: too large for a results file. Upload the JUnit or CTRF file in an artifact of its own.`);
      let zip;
      try { zip = await github.downloadArtifact(owner, repo, a.id); } catch (e) { throw ghProblem(e, full, `download the artifact “${a.name}”`); }
      files = await resultFilesIn(zip, `artifact “${a.name}”`);
      used = a;
      if (files.length) break;
    }
    let parsed;
    try {
      if (!files.length) throw err('BAD_FORMAT', 'none');
      parsed = await parseResults(files, { casePattern: suite.casePattern, masking: suite.masking });
    } catch (e) {
      if (e.code === 'BAD_FORMAT') throw err('NO_RESULTS', `The artifact “${used ? used.name : suite.artifact}” holds no JUnit XML or CTRF JSON results file, so there are no results to bring in.`);
      throw e;
    }
    if (!parsed.startedAt && ghRun.run_started_at) parsed.startedAt = ghRun.run_started_at;
    const reportUrl = await reportLinkOf(owner, repo, ghRun, list);
    const inputs = o.inputs || {};
    const env = suite.envInput && inputs[suite.envInput] ? inputs[suite.envInput] : '';
    const options = {};
    const defs = suite.inputs || [];
    // the yes/no fields: those of the form the run was started with (its branch's), else the saved form's
    const isFlag = (k) => (Array.isArray(o.flags) ? o.flags.includes(k) : (defs.find((x) => x.name === k) || {}).type === 'boolean');
    for (const [k, v] of Object.entries(inputs)) {
      if (k === suite.envInput || v === '' || v == null) continue;
      if (isFlag(k)) { if (v === 'true') options[k] = k; continue; }
      options[k] = v;
    }
    const run = buildRun(parsed, {
      suite, attach,
      // expiresAt: when GitHub deletes the results artifact (its retention-days), for the Full report's ?
      source: { kind: 'github', repo: full, workflow: suite.workflow || String(suite.workflowId), runId: String(ghRun.id), runUrl: ghRun.html_url, reportUrl, fileName: used ? used.name : '', expiresAt: used ? used.expires_at : '' },
      branch: o.branch || ghRun.head_branch || '', sha: ghRun.head_sha || '', env, options, by: o.by,
    });
    const { meta, removed } = store.add(run, keep());
    store.noteFormat(suite.id, parsed.format);
    // the manual suite: Automation column, and the status of cases nobody marked (routes.mjs writeAutomated)
    const marks = ctx.writeAutomated ? await ctx.writeAutomated(run, o.by) : null;
    return { meta, removed, marks, artifact: used ? used.name : '', summary: { format: parsed.format, formatLabel: parsed.formatLabel, tool: parsed.tool, totals: parsed.totals, files: parsed.files, ignored: parsed.ignored } };
  }

  /**
   * Where the suite published its own report for this run: the address in its report-link artifact
   * (report-url.txt), when it is an http(s) address (cleanReportUrl), else ''. list: the run's artifacts.
   * Never throws: a missing, expired, unreadable or bad link is logged and left out.
   */
  async function reportLinkOf(owner, repo, ghRun, list) {
    const a = (list || []).find((x) => isReportLink(x) && !x.expired);
    if (!a) return '';
    const where = `${owner}/${repo} run ${ghRun.id}`;
    if ((a.size_in_bytes || 0) > MAX_REPORT_LINK_BYTES) { log(`${REPORT_LINK} of ${where} is ${a.size_in_bytes} bytes: too large for a link, left out`); return ''; }
    let line;
    try {
      line = await reportUrlIn(await github.downloadArtifact(owner, repo, a.id));
    } catch (e) {
      log(`${REPORT_LINK} of ${where} could not be read, left out: ${(e && e.message) || e}`);
      return '';
    }
    const url = cleanReportUrl(line);
    if (!url) log(`${REPORT_LINK} of ${where} ${line ? 'is not an http(s) address of at most 500 characters' : 'has no address in report-url.txt'}, left out`);
    return url;
  }

  /** Import from GitHub: a finished run of the suite's workflow (the latest without runId), attached where asked. */
  async function importOne(body, person) {
    const { suite, owner, repo } = runnable(body.suite, person);
    const full = `${owner}/${repo}`;
    let ghRun;
    try {
      if (body.runId) ghRun = await github.getRun(owner, repo, Number(body.runId));
      else ghRun = (((await github.listRuns(owner, repo, { workflowId: suite.workflowId, status: 'completed', per_page: 1 })) || {}).workflow_runs || [])[0];
    } catch (e) { throw ghProblem(e, full, 'read the run'); }
    if (!ghRun) throw err('NO_RUN', `“${suite.workflow}” has no finished run on GitHub yet.`);
    if (Number(ghRun.workflow_id) !== Number(suite.workflowId)) throw err('BAD_INPUT', `That run is not a run of “${suite.workflow}”.`);
    if (ghRun.status !== 'completed') throw err('NOT_DONE', `Run #${ghRun.run_number} is still ${ghRun.status === 'queued' ? 'queued' : 'running'} on GitHub. Bring it in once it has finished.`);
    const at = await checkAttach(body, person, suite);
    if (!at.ok) throw err(at.code, at.error);
    const had = alreadyKept(suite.id, ghRun.id, at.attach);
    if (had) throw err('ALREADY', `Run #${ghRun.run_number} is already in Test Run, attached to ${at.attach.tab} › ${at.attach.cycle ? `Cycle ${at.attach.cycle}` : 'Status'}.`);
    const r = await importRun(suite, owner, repo, ghRun, at.attach, { by: person.name });
    return { run: withRate(r.meta), removed: r.removed, kept: store.group(r.meta).map(withRate), summary: r.summary, marks: r.marks, githubRun: { id: ghRun.id, number: ghRun.run_number, htmlUrl: ghRun.html_url } };
  }

  /** Recent finished runs of the suite's workflow, newest first, with those already kept marked. */
  async function recentRuns(id, person) {
    const { suite, owner, repo } = runnable(id, person);
    let r;
    try { r = await github.listRuns(owner, repo, { workflowId: suite.workflowId, status: 'completed', per_page: 15 }); } catch (e) { throw ghProblem(e, `${owner}/${repo}`, 'list the workflow\'s runs'); }
    const kept = new Set(store.index().filter((m) => m.suiteId === suite.id && m.source && m.source.runId).map((m) => String(m.source.runId)));
    return ((r && r.workflow_runs) || []).map((x) => ({
      id: x.id, number: x.run_number, branch: x.head_branch, sha: x.head_sha, event: x.event, actor: (x.actor && x.actor.login) || '',
      conclusion: x.conclusion, createdAt: x.created_at, htmlUrl: x.html_url, title: x.display_title || '', kept: kept.has(String(x.id)),
    }));
  }

  async function branches(id, person) {
    const { suite, owner, repo } = runnable(id, person);
    const full = `${owner}/${repo}`;
    let list, info;
    try {
      [list, info] = await Promise.all([github.listBranches(owner, repo), github.getRepo(owner, repo)]);
    } catch (e) { throw ghProblem(e, full, 'list the branches'); }
    let envs = [];
    if ((suite.inputs || []).some((x) => x.type === 'environment')) {
      try { envs = await environmentsOf(owner, repo); } catch { envs = []; }
    }
    const dflt = (info && info.default_branch) || suite.defaultBranch || '';
    const names = (list || []).map((b) => b.name).filter(Boolean);
    names.sort((a, b) => (a === dflt ? -1 : b === dflt ? 1 : a.localeCompare(b)));
    return { branches: names.map((name) => ({ name, default: name === dflt })), defaultBranch: dflt, environments: envs };
  }

  /** The repository's GitHub environments, less those the host excludes (Setup › Automation). Throws as GitHub does. */
  async function environmentsOf(owner, repo) {
    const out = excluded();
    return (((await github.listEnvironments(owner, repo)) || {}).environments || []).map((e) => e && e.name).filter((n) => n && !out.has(String(n).toLowerCase()));
  }

  /**
   * The Run workflow form of the suite's workflow on a branch, read from that branch's own workflow
   * file (each branch can have its own form, and GitHub refuses fields the branch's file doesn't have):
   * { branch, inputs, from: 'branch' | 'saved', dispatch, note, suite }. When GitHub can't be read, or
   * the file isn't on the branch, it is the copy saved when the suite was linked (from 'saved', with a
   * note saying why). The default branch's form, when it differs from the saved copy, replaces it.
   */
  async function formOf(suite, owner, repo, branch) {
    const saved = { branch, inputs: suite.inputs || [], from: 'saved', dispatch: true, note: '', suite };
    if (!suite.workflowPath || !branch) return saved;
    const full = `${owner}/${repo}`;
    let file;
    try { file = await github.getFile(owner, repo, suite.workflowPath, branch); } catch (e) {
      return { ...saved, note: `${ghProblem(e, full, `read ${suite.workflowPath} on ${branch}`).message} The form below is the one saved when the suite was linked.` };
    }
    if (!file) return { ...saved, dispatch: false, note: `${suite.workflowPath} isn't on ${branch}, so GitHub can't run “${suite.workflow}” there. Choose another branch.` };
    let p;
    try { p = parseWorkflowInputs(file.toString('utf8')); } catch (e) {
      return { ...saved, note: `${suite.workflowPath} on ${branch}: ${e.message} The form below is the one saved when the suite was linked.` };
    }
    let now = suite;
    if (branch === suite.defaultBranch && JSON.stringify(p.inputs) !== JSON.stringify(suite.inputs || [])) {
      now = store.setGithub(suite.id, { ...suite, inputs: p.inputs, envInput: envFieldOf(p.inputs, suite.envInput) }) || suite;
    }
    return {
      branch, inputs: p.inputs, from: 'branch', dispatch: p.dispatch, suite: now,
      note: p.dispatch ? '' : `“${suite.workflow}” can't be started by hand on ${branch}: its workflow file there has no workflow_dispatch.`,
    };
  }

  /** The run form on a branch, as the ▶ Run page shows it, with the environments for its environment field. */
  async function form(id, branch, person) {
    const { suite, owner, repo } = runnable(id, person);
    const b = clip(branch, 250);
    if (!b) throw err('BAD_INPUT', 'Choose the branch to run.');
    const f = await formOf(suite, owner, repo, b);
    const hasEnv = f.inputs.some((x) => x.type === 'environment');
    let environments = [];
    let envError = '';
    if (hasEnv) {
      try { environments = await environmentsOf(owner, repo); } catch (e) { envError = ghProblem(e, `${owner}/${repo}`, 'list the environments').message; }
    }
    return {
      branch: b, inputs: f.inputs, from: f.from, dispatch: f.dispatch, note: f.note,
      envInput: f.suite.envInput, refreshed: f.suite !== suite,
      environments,
      // the workflow asks for an environment, but the repository has none (after the host's exclusions)
      noEnvironments: hasEnv && !envError && !environments.length,
    };
  }

  // ------------------------------------------------------------------ start and follow runs

  const jobOut = (j) => {
    const { known, cancelSent, misses, ...rest } = j;
    return rest;
  };
  const seesJob = (person, j) => maySeeSuite(person, j.suiteId) && mayOpen(person, j.attach.book);
  const findJob = (id) => jobs.list.find((j) => j.id === id) || null;

  function prune() {
    const t = now();
    const before = jobs.list.length;
    jobs.list = jobs.list.filter((j) => ACTIVE.has(j.state) || !j.finishedAt || t - j.finishedAt < KEEP_FINISHED_MS).slice(-100);
    return jobs.list.length !== before;
  }

  async function start(body, person) {
    const { suite, owner, repo } = runnable(body.suite, person);
    const full = `${owner}/${repo}`;
    const branch = clip(body.branch, 250);
    if (!branch) throw err('BAD_INPUT', 'Choose the branch to run.');
    // the branch's own form, read again now: only its fields are sent (GitHub refuses any others)
    const f = await formOf(suite, owner, repo, branch);
    const inputs = inputValues(f.inputs, body.inputs && typeof body.inputs === 'object' ? body.inputs : {});
    const envInput = f.suite.envInput;
    const at = await checkAttach(body, person, suite);
    if (!at.ok) throw err(at.code, at.error);
    // the runs there before this one, so the new one can be told apart
    let known = [];
    try { known = ((((await github.listRuns(owner, repo, { workflowId: suite.workflowId, event: 'workflow_dispatch', branch, per_page: 30 })) || {}).workflow_runs) || []).map((r) => r.id); } catch { known = []; }
    const actor = await whoAmI();
    const dispatchedAt = now();
    let started;
    try {
      started = await github.dispatchWorkflow(owner, repo, suite.workflowId, branch, inputs);
    } catch (e) {
      if (e.status === 422) throw err('BAD_INPUT', /No ref found/i.test(e.message) ? `There is no branch “${branch}” in ${full}.` : `GitHub didn't start the run: ${e.message}`);
      throw ghProblem(e, full, 'start the workflow');
    }
    const job = {
      id: `j${dispatchedAt.toString(36)}${randomBytes(3).toString('hex')}`,
      suiteId: suite.id, suiteName: suite.name, repo: full, workflowId: suite.workflowId, workflow: suite.workflow,
      attach: at.attach, branch, inputs, flags: f.inputs.filter((x) => x.type === 'boolean').map((x) => x.name),
      env: envInput ? inputs[envInput] || '' : '', by: person.name, actor,
      dispatchedAt, githubRunId: started.runId || null, runUrl: started.runUrl || '', runNumber: null, sha: '',
      state: 'waiting', status: '', conclusion: '', jobs: [], message: '', lastError: '', startedAt: '', finishedAt: 0,
      importedRunId: '', totals: null, removed: [], cancelWanted: false, known,
    };
    jobs.list.push(job);
    prune();
    jobs.save();
    schedule(Math.min(pollMs(), 1500));
    return job;
  }

  function finish(job, state, message = '') {
    job.state = state;
    job.message = message;
    job.finishedAt = now();
    job.lastError = '';
  }

  /** One look at a job's run: find it, follow it, bring its results in when it's done. */
  async function step(job) {
    const { owner, repo } = repoOf(job.repo);
    const full = job.repo;
    if (!job.githubRunId) {
      let list = [];
      try {
        list = ((await github.listRuns(owner, repo, { workflowId: job.workflowId, event: 'workflow_dispatch', branch: job.branch, created: `>=${new Date(job.dispatchedAt - 120000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`, per_page: 20 })) || {}).workflow_runs || [];
      } catch (e) {
        job.lastError = ghProblem(e, full, 'look for the run').message;
        return;
      }
      const claimed = jobs.list.filter((j) => j !== job && j.githubRunId).map((j) => j.githubRunId);
      const found = findRunAfterDispatch(list, { since: job.dispatchedAt, branch: job.branch, actor: job.actor, known: job.known || [], claimed });
      if (!found) {
        if (now() - job.dispatchedAt > findTimeoutMs) {
          const within = findTimeoutMs >= 120000 ? `${Math.round(findTimeoutMs / 60000)} minutes` : 'a minute';
          finish(job, 'failed', `Unable to find the GitHub job within ${within}. Look for it on the workflow's Actions page; when it's done, bring its results in with ⤒ Import Results › GitHub Run.`);
          job.notFound = true;
          // ↗ GitHub Log opens the workflow's runs, where the run may be found
          const wfFile = String((store.suite(job.suiteId) || {}).workflowPath || '').split('/').pop();
          job.runUrl = job.runUrl || (wfFile ? `${runsPage(full)}/workflows/${encodeURIComponent(wfFile)}` : runsPage(full));
        }
        return;
      }
      job.githubRunId = found.id;
      job.runUrl = found.html_url || job.runUrl;
      job.runNumber = found.run_number || null;
    }
    let run;
    try {
      run = await github.getRun(owner, repo, job.githubRunId);
    } catch (e) {
      if (e.status === 404) { finish(job, 'failed', `The run is not on GitHub any more (deleted there?).`); return; }
      job.lastError = ghProblem(e, full, 'follow the run').message;
      job.misses = (job.misses || 0) + 1;
      if (job.misses * pollMs() > 15 * 60000 && job.misses >= 3) finish(job, 'failed', `Test Run lost touch with GitHub while following the run: ${job.lastError}`);
      return;
    }
    job.misses = 0;
    job.lastError = '';
    job.status = run.status || '';
    job.conclusion = run.conclusion || '';
    job.sha = run.head_sha || job.sha;
    job.runUrl = run.html_url || job.runUrl;
    job.runNumber = run.run_number || job.runNumber;
    job.startedAt = run.run_started_at || job.startedAt;
    try {
      const j = await github.listJobs(owner, repo, job.githubRunId);
      job.jobs = ((j && j.jobs) || []).slice(0, 20).map((x) => ({
        name: clip(x.name, 200), status: x.status || '', conclusion: x.conclusion || '',
        steps: (x.steps || []).slice(0, 60).map((s) => ({ name: clip(s.name, 200), status: s.status || '', conclusion: s.conclusion || '' })),
      }));
    } catch { /* the steps are a nicety; the run's own state is what counts */ }
    if (job.cancelWanted && !job.cancelSent && run.status !== 'completed') {
      try { await github.cancelRun(owner, repo, job.githubRunId); job.cancelSent = true; } catch (e) { job.lastError = ghProblem(e, full, 'cancel the run').message; }
    }
    if (run.status !== 'completed') { job.state = run.status === 'in_progress' ? 'in_progress' : 'queued'; return; }
    job.state = 'importing';
    jobs.save();
    const suite = store.suite(job.suiteId);
    if (!suite) { finish(job, 'failed', `“${job.suiteName}” was unlinked while it ran, so its results weren't brought in.`); return; }
    const had = alreadyKept(job.suiteId, job.githubRunId, job.attach);
    if (had) { finish(job, 'imported'); job.importedRunId = had.id; job.totals = had.totals; return; } // brought in before a restart
    const at = await checkAttach({ book: job.attach.book, tab: job.attach.tab, cycle: job.attach.cycle }, ownerAs(job.by));
    if (!at.ok) { finish(job, 'failed', `The run finished, but its results couldn't be attached: ${at.error} Bring them in with ⤒ Import Results › GitHub Run.`); return; }
    try {
      const r = await importRun(suite, owner, repo, run, at.attach, { by: job.by, branch: job.branch, inputs: job.inputs, flags: job.flags });
      finish(job, 'imported');
      job.importedRunId = r.meta.id;
      job.totals = r.meta.totals;
      job.removed = r.removed.map((m) => ({ id: m.id, startedAt: m.startedAt }));
      job.marks = r.marks || null;
    } catch (e) {
      if (job.conclusion === 'cancelled' && e.code === 'NO_RESULTS') finish(job, 'cancelled', 'The run was cancelled before it uploaded its results.');
      else if (e.code === 'NO_RESULTS') finish(job, 'no_results', e.message);
      else finish(job, 'failed', `The run finished, but its results couldn't be brought in: ${e.message}`);
    }
  }

  async function tick() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (ticking || stopped) return;
    ticking = true;
    try {
      for (const job of jobs.list.filter((j) => ACTIVE.has(j.state))) {
        if (stopped) break;
        if (job.state === 'importing') job.state = 'in_progress'; // cut short by a restart: look again
        const before = JSON.stringify(job);
        try { await step(job); } catch (e) { log(e); job.lastError = String(e.message || e); }
        if (JSON.stringify(job) !== before) jobs.save();
      }
      if (prune()) jobs.save();
    } finally {
      ticking = false;
      if (!stopped && jobs.list.some((j) => ACTIVE.has(j.state))) schedule(nextDelay());
    }
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { tick().catch(log); }, ms);
    if (timer.unref) timer.unref();
  }

  // runs that were going when Test Run stopped are followed again
  if (jobs.list.some((j) => ACTIVE.has(j.state))) schedule(Math.min(pollMs(), 1000));

  async function cancel(body, person) {
    const job = findJob(String(body.id || ''));
    if (!job || !seesJob(person, job)) throw err('GONE', 'That run is not going any more.');
    if (!mayStartRuns(person, job.suiteId)) throw err('FORBIDDEN', 'Your test lead has not let you start or cancel runs for this suite.');
    if (!ACTIVE.has(job.state) || job.state === 'importing') throw err('DONE', 'That run has already finished.');
    job.cancelWanted = true;
    if (job.githubRunId) {
      const { owner, repo } = repoOf(job.repo);
      try {
        await github.cancelRun(owner, repo, job.githubRunId);
        job.cancelSent = true;
      } catch (e) {
        if (e.status !== 409) throw ghProblem(e, job.repo, 'cancel the run'); // 409: it finished meanwhile
      }
    }
    jobs.save();
    schedule(Math.min(pollMs(), 1000));
    return job;
  }

  // ------------------------------------------------------------------ requests

  /** One request: { code, json }, or null when the path isn't ours. Not being allowed is a 403. */
  async function handle(method, path, url, req, person) {
    try {
      return await route(method, path, url, req, person);
    } catch (e) {
      if (e && e.code === 'FORBIDDEN' && e.status == null) return forbid(e.message);
      throw e;
    }
  }

  async function route(method, path, url, req, person) {
    const q = (k) => String(url.searchParams.get(k) || '');
    if (method === 'GET') {
      if (path === '/api/automation/jobs') return okJson({ jobs: jobs.list.filter((j) => seesJob(person, j)).map(jobOut) });
      if (path === '/api/automation/job') {
        const j = findJob(q('id'));
        return j && seesJob(person, j) ? okJson({ job: jobOut(j) }) : fail('GONE', 'That run is not in Test Run any more.');
      }
      if (path === '/api/automation/github/status') {
        if (!isOwner(person)) return forbid('Only the host sees Test Run\'s GitHub access.');
        try {
          const u = await github.getUser();
          login = (u && u.login) || '';
          return okJson({ transport: github.kind, login });
        } catch (e) {
          const p = ghProblem(e, '', 'reach GitHub');
          return fail(p.code, p.message, { transport: github.kind });
        }
      }
      if (path === '/api/automation/github/branches') return okJson(await branches(q('suite'), person));
      if (path === '/api/automation/github/form') return okJson(await form(q('suite'), q('branch'), person));
      if (path === '/api/automation/github/runs') return okJson({ runs: await recentRuns(q('suite'), person) });
      return null;
    }
    if (method !== 'POST') return null;
    const ours = ['/api/automation/github/check', '/api/automation/github/artifacts', '/api/automation/github/link', '/api/automation/github/import',
      '/api/automation/github/run', '/api/automation/job/cancel', '/api/automation/job/dismiss', '/api/automation/settings'];
    if (!ours.includes(path)) return null;
    const body = await jsonBody(req);
    if (path === '/api/automation/settings') {
      if (!isOwner(person)) return forbid('Only the host changes the automation settings.');
      const out = {};
      if (body.keep != null) {
        const n = Math.round(Number(body.keep));
        if (!(n >= 1 && n <= 20)) return fail('BAD_INPUT', 'Keep between 1 and 20 runs.');
        out.keep = ctx.setKeep ? ctx.setKeep(n) : n;
      }
      if (body.checkEvery != null) {
        const m = Number(body.checkEvery);
        if (!CHECK_EVERY.includes(m)) return fail('BAD_INPUT', 'Check every 1 or 5 minutes.');
        out.checkEvery = ctx.setCheckEvery ? ctx.setCheckEvery(m) : m;
        schedule(Math.min(pollMs(), 1000)); // the new pace applies to runs already being followed
      }
      if (body.excludeEnvironments != null) {
        const list = body.excludeEnvironments;
        if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) return fail('BAD_INPUT', 'Send the environments to exclude as a list of names.');
        const names = list.map((x) => x.trim());
        if (names.some((x) => !x)) return fail('BAD_INPUT', 'An environment to exclude needs a name.');
        if (names.some((x) => x.length > MAX_ENVIRONMENT_NAME)) return fail('BAD_INPUT', `An environment's name is at most ${MAX_ENVIRONMENT_NAME} characters.`);
        if (names.length > MAX_EXCLUDE_ENVIRONMENTS) return fail('BAD_INPUT', `Exclude at most ${MAX_EXCLUDE_ENVIRONMENTS} environments.`);
        out.excludeEnvironments = ctx.setExcludeEnvironments ? ctx.setExcludeEnvironments(names) : normalizeAutomationSettings({ excludeEnvironments: names }).excludeEnvironments;
      }
      if (!Object.keys(out).length) return fail('BAD_INPUT', 'Nothing to change.');
      return okJson(out);
    }
    if (path === '/api/automation/github/check' || path === '/api/automation/github/artifacts' || path === '/api/automation/github/link') {
      // linking: who may link suites; changing a linked one: who may run it
      const id = body.id ? String(body.id) : '';
      if (id ? !(store.suite(id) && maySeeSuite(person, id) && mayStartRuns(person, id)) : !canAct(person)) return noRuns(person);
      if (path === '/api/automation/github/check') return okJson(await check(body));
      if (path === '/api/automation/github/artifacts') return okJson(await artifacts(body));
      return okJson(await link(body, person));
    }
    if (path === '/api/automation/github/import') return okJson(await importOne(body, person));
    if (path === '/api/automation/github/run') return okJson({ job: jobOut(await start(body, person)) });
    if (path === '/api/automation/job/cancel') return okJson({ job: jobOut(await cancel(body, person)) });
    if (path === '/api/automation/job/dismiss') {
      const j = findJob(String(body.id || ''));
      if (!j || !seesJob(person, j)) return fail('GONE', 'That run is not in Test Run any more.');
      if (ACTIVE.has(j.state)) return fail('RUNNING', 'That run is still going. Cancel it first.');
      jobs.list = jobs.list.filter((x) => x !== j);
      jobs.save();
      return okJson({ dismissed: j.id });
    }
    return null;
  }

  return {
    handle,
    /** Every job, as kept (for tests and the server). */
    jobs: () => jobs.list.map(jobOut),
    /** Look at the runs going now (tests drive this instead of waiting for the timer). */
    tick,
    /** Wait until no job is going, or ms pass (tests). */
    async settle(ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end && jobs.list.some((j) => ACTIVE.has(j.state))) { await tick(); await new Promise((r) => setTimeout(r, 5)); }
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
