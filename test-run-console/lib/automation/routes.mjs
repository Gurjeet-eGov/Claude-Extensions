// The Automation screen's server side: /api/automation/*. server.mjs hands each request here
// with the person asking; everything else (workbooks, who may open which) comes from it.
//
//   GET  /api/automation                 suites and kept runs this person may see, the settings (keep, checkEvery, excludeEnvironments)
//   GET  /api/automation/run?id=          one run, with the previous run, what changed, causes, history
//   GET  /api/automation/targets?book=    a workbook's test suites and their cycles (the attach pickers)
//   GET  /api/automation/excel?id=        the run as an .xlsx, made now and never kept
//   GET  /api/automation/cycle?book=&tab=&cycle=   the Summary's Automated view and Run's Auto badges (summary.mjs)
//   POST /api/automation/preview?suite=   a results upload read without keeping it (format and counts)
//   POST /api/automation/import?suite=&book=&tab=&cycle=&branch=&env=&name=   keep an upload as a run
//   POST /api/automation/delete {id}      POST /api/automation/reattach {id, book, tab, cycle}
//   POST /api/automation/suites {id?, name, repo, casePattern, masking, books}   (books: the workbooks it belongs to)
//   POST /api/automation/suites/remove {id}   (the host only; the suite's runs go with it)
//   /api/automation/github/*, /api/automation/job(s), /api/automation/settings: GitHub Actions runs
//   and Setup › Automation, in ./github-runs.mjs
// Uploads are a raw body (one JSON, XML or .zip file, its name in ?name=) or multipart/form-data
// with several files; either way at most 20 MB.
import ExcelJS from 'exceljs';
import { AutomationStore, normalizeAutomationSettings, suiteInBook } from './store.mjs';
import { canSeeSuite, canAct } from './access.mjs';
import { cycleRoute } from './summary.mjs';
import { parseResults, buildRun, filesFromMultipart, previousRun, compareRuns, groupCauses, historyOf, lineOf, byFile, passRate, FORMAT_LABEL, RUN_ID } from './results.mjs';
import { createGithubRuns } from './github-runs.mjs';

export const MAX_UPLOAD = 20 * 1024 * 1024;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const p2 = (n) => String(n).padStart(2, '0');
const localStamp = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

/**
 * ctx: { sheetsDir, lib (the Library), callApi(fn, args, book, person), mayOpen(person, book),
 *        isOwner(person), keep() (runs kept per suite and cycle), readBody(req, max),
 *        github (lib/github.mjs client), setKeep(n), checkEvery(), setCheckEvery(n), excludeEnvironments(),
 *        setExcludeEnvironments(list), log, pollMs }
 */
export function createAutomation(ctx) {
  const { sheetsDir, lib, callApi, mayOpen, isOwner, readBody } = ctx;
  const keep = () => normalizeAutomationSettings({ keep: ctx.keep ? ctx.keep() : undefined }).keep;
  const store = new AutomationStore(sheetsDir);

  const okJson = (obj) => ({ code: 200, json: { ok: true, ...obj } });
  const fail = (code, error, extra) => ({ code: 200, json: { ok: false, code, error, ...(extra || {}) } });
  const forbid = (error) => ({ code: 403, json: { ok: false, code: 'FORBIDDEN', error } });
  const noAct = (person) => forbid(person.role === 'viewer' ? 'View only: you can read automated results, not import or change them.' : 'Your test lead has not let you import results or change runs.');
  const quiet = (person) => ({ ...person, remember: false });
  const gone = () => fail('GONE', 'That run is not in Test Run any more.');

  /** May this person see this run: its suite, and its workbook. */
  const seesRun = (person, m) => canSeeSuite(person, m.suiteId) && mayOpen(person, m.attach.book);
  /** A suite as the page sees it: masking rules (which may name a secret) only for those who can change them. */
  const suiteOut = (s, person) => (canAct(person) ? s : { ...s, masking: [] });
  const withRate = (m) => (m ? { ...m, passRate: passRate(m.totals) } : null);

  /**
   * A workbook › test suite › test cycle that exists and that this person may open; with a suite,
   * the workbook must be one the suite belongs to.
   */
  async function checkAttach(q, person, suite) {
    const book = clip(q.book, 260);
    const tab = clip(q.tab, 160);
    if (!book || !tab || q.cycle == null) return { ok: false, code: 'NO_ATTACH', error: 'Choose the workbook, test suite and test cycle these results belong to.' };
    const cycle = clip(q.cycle, 60);
    if (!lib.list().some((b) => b.name === book)) return { ok: false, code: 'NO_BOOK', error: `“${book.replace(/\.xlsx$/i, '')}” is not in Test Run any more.` };
    if (!mayOpen(person, book)) return { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you. Ask your test lead.' };
    if (suite && !suiteInBook(suite, book)) return { ok: false, code: 'NOT_IN_BOOK', error: `“${suite.name}” isn't linked to “${book.replace(/\.xlsx$/i, '')}”. The host adds the workbook to the suite in Setup › Automation.` };
    const m = await callApi('api_loadTab', [tab, cycle], book, quiet(person));
    if (!m || !m.ok) return m && m.code ? { ok: false, code: m.code, error: m.error } : { ok: false, code: 'NO_TAB', error: `There is no test suite “${tab}” in that workbook.` };
    if (m.role !== 'manual') return { ok: false, code: 'NO_TAB', error: `“${tab}” is not a test suite in Test Run.` };
    if (!m.cycles.some((c) => c.label === cycle)) return { ok: false, code: 'NO_CYCLE', error: `${m.tab} has no test cycle “${cycle}”.` };
    return { ok: true, attach: { book, tab: m.tab, cycle } };
  }

  /**
   * The workbooks a suite is linked to, from a request: workbook file names that exist and this person
   * may open, at least one. undefined when the request names none (the suite keeps its own).
   */
  function checkBooks(given, person) {
    if (given === undefined) return undefined;
    const names = new Set(lib.list().map((b) => b.name));
    const list = [...new Set((Array.isArray(given) ? given : []).map((b) => clip(b, 260)).filter(Boolean))];
    const bad = list.find((b) => !names.has(b) || !mayOpen(person, b));
    if (bad) throw Object.assign(new Error(`“${bad.replace(/\.xlsx$/i, '')}” is not a workbook you can open in Test Run.`), { code: 'BAD_INPUT' });
    if (!list.length) throw Object.assign(new Error('Choose the workbooks this suite belongs to: its results show only there.'), { code: 'BAD_INPUT' });
    return list;
  }

  /** The workbooks with at least one suite this person may see (the Automation tab shows only there). */
  function booksWithSuites(person) {
    const suites = store.suites().filter((s) => canSeeSuite(person, s.id));
    return lib.list().map((b) => b.name).filter((b) => mayOpen(person, b) && suites.some((s) => suiteInBook(s, b)));
  }

  /** The files of an upload: a raw body (one file) or multipart/form-data (several). */
  async function uploadFiles(req, url) {
    const buf = await readBody(req, MAX_UPLOAD);
    const type = String(req.headers['content-type'] || '');
    const files = /^multipart\/form-data/i.test(type) ? filesFromMultipart(buf, type) : [{ name: clip(url.searchParams.get('name'), 200) || 'results', buf }];
    const real = files.filter((f) => f.buf && f.buf.length);
    if (!real.length) throw Object.assign(new Error('The file is empty.'), { code: 'BAD_INPUT' });
    return real;
  }

  async function jsonBody(req) {
    const b = await readBody(req, 1024 * 1024);
    try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('That request was not readable.'), { code: 'BAD_INPUT' }); }
  }

  function list(person) {
    const index = store.index();
    const runs = index.filter((m) => seesRun(person, m)).map((m) => {
      const prev = previousRun(index, m);
      return { ...withRate(m), prev: prev ? { id: prev.id, startedAt: prev.startedAt, totals: prev.totals, passRate: passRate(prev.totals) } : null };
    });
    return okJson({
      suites: store.suites().filter((s) => canSeeSuite(person, s.id)).map((s) => suiteOut(s, person)),
      runs,
      keep: keep(),
      checkEvery: normalizeAutomationSettings({ checkEvery: ctx.checkEvery ? ctx.checkEvery() : undefined }).checkEvery,
      excludeEnvironments: normalizeAutomationSettings({ excludeEnvironments: ctx.excludeEnvironments ? ctx.excludeEnvironments() : undefined }).excludeEnvironments,
      canAct: canAct(person),
      isOwner: !!isOwner(person),
      formats: FORMAT_LABEL,
    });
  }

  function runDetail(id, person) {
    const m = RUN_ID.test(id) ? store.meta(id) : null;
    if (!m || !seesRun(person, m)) return gone();
    const run = store.run(id);
    if (!run) return gone();
    const index = store.index();
    const prevMeta = previousRun(index, m);
    const prev = prevMeta ? store.run(prevMeta.id) : null;
    const compare = compareRuns(run, prev);
    const loaded = new Map([[run.id, run]].concat(prev ? [[prev.id, prev]] : []));
    const recent = lineOf(index, m).slice(-3).map((x) => loaded.get(x.id) || store.run(x.id)).filter(Boolean);
    const suite = store.suite(run.suiteId);
    return okJson({
      run: { ...run, passRate: passRate(run.totals) },
      suite: suite ? suiteOut(suite, person) : null,
      previous: withRate(prevMeta),
      compare,
      causes: groupCauses(run.tests, compare.newFailures),
      files: byFile(run.tests),
      history: historyOf(recent, run),
      kept: store.group(m).map(withRate),
      keep: keep(),
      canAct: canAct(person),
    });
  }

  async function targets(book, person) {
    if (!lib.list().some((b) => b.name === book)) return fail('NO_BOOK', 'That workbook is not in Test Run any more.');
    if (!mayOpen(person, book)) return forbid('This workbook is not shared with you. Ask your test lead.');
    const boot = await callApi('api_bootstrap', [], book, quiet(person));
    if (!boot.ok) return fail(boot.code || 'ERROR', boot.error);
    const tabs = [];
    for (const t of boot.tabs.filter((x) => ((x.saved && x.saved.role) || x.detected.role) === 'manual')) {
      const m = await callApi('api_loadTab', [t.name, ''], book, quiet(person));
      if (!m.ok) continue;
      tabs.push({ name: m.tab, cycles: m.cycles.map((c) => c.label), current: m.cycleIdx >= 0 ? m.cycles[m.cycleIdx].label : '' });
    }
    return okJson({ book, tabs });
  }

  async function excel(id, person) {
    const m = RUN_ID.test(id) ? store.meta(id) : null;
    const run = m && seesRun(person, m) ? store.run(id) : null;
    if (!run) return gone();
    const buf = await runWorkbook(run);
    const name = `${run.suiteName || 'Automated run'} - ${localStamp(run.startedAt).replace(':', '-')} - results.xlsx`.replace(/[\\/:*?"<>|\0]/g, '_');
    return {
      code: 200,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: buf,
      headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
    };
  }

  // GitHub Actions: link a suite to its workflow, start and follow runs, import them
  const github = createGithubRuns({ ...ctx, store, checkAttach, checkBooks, keep, jsonBody });

  // Suites linked before suites had workbooks: they belong to the workbooks their runs (kept, or
  // started from Test Run) are attached to. One with no run anywhere stays in every workbook until changed.
  (function workbooksForOldSuites() {
    const list = store.suites();
    if (!list.some((s) => s.books == null)) return;
    const used = new Map();
    const note = (id, b) => { if (b) { if (!used.has(id)) used.set(id, new Set()); used.get(id).add(b); } };
    for (const m of store.index()) note(m.suiteId, m.attach && m.attach.book);
    for (const j of github.jobs()) note(j.suiteId, j.attach && j.attach.book);
    let changed = false;
    for (const s of list) if (s.books == null && used.has(s.id)) { s.books = [...used.get(s.id)]; changed = true; }
    if (changed) store.writeSuites(list);
  })();

  async function post(path, url, req, person) {
    if (path === '/api/automation/suites/remove') {
      if (!isOwner(person)) return forbid('Only the host unlinks a suite.');
      const body = await jsonBody(req);
      const r = store.removeSuite(String(body.id || ''));
      if (!r) return fail('GONE', 'That suite is not linked any more.');
      return okJson({ removed: r.suite, runs: r.runs.length });
    }
    if (!canAct(person)) return noAct(person);
    if (path === '/api/automation/suites') {
      const body = await jsonBody(req);
      if (body.id && !canSeeSuite(person, String(body.id))) return forbid('That suite is not shared with you.');
      const suite = store.saveSuite({ id: body.id ? String(body.id) : '', name: body.name, repo: body.repo, casePattern: body.casePattern, masking: body.masking, books: checkBooks(body.books, person) }, { by: person.name });
      return okJson({ suite, created: !body.id });
    }
    if (path === '/api/automation/preview' || path === '/api/automation/import') {
      const files = await uploadFiles(req, url); // read first, so an answer never cuts a big upload short
      const suite = store.suite(String(url.searchParams.get('suite') || ''));
      if (!suite || !canSeeSuite(person, suite.id)) return fail('NO_SUITE', 'That suite is not linked any more.');
      const parsed = await parseResults(files, { casePattern: suite.casePattern, masking: suite.masking });
      const summary = { format: parsed.format, formatLabel: parsed.formatLabel, tool: parsed.tool, files: parsed.files, ignored: parsed.ignored, totals: parsed.totals, startedAt: parsed.startedAt, durationMs: parsed.durationMs, branch: parsed.branch, sha: parsed.sha, env: parsed.env };
      if (path === '/api/automation/preview') return okJson(summary);
      const q = Object.fromEntries(['book', 'tab', 'branch', 'env'].map((k) => [k, url.searchParams.get(k) || '']));
      q.cycle = url.searchParams.has('cycle') ? url.searchParams.get('cycle') : null;
      const at = await checkAttach(q, person, suite);
      if (!at.ok) return fail(at.code, at.error);
      const fileName = files.length === 1 ? files[0].name : `${files.length} files`;
      const run = buildRun(parsed, { suite, attach: at.attach, source: { kind: 'upload', fileName }, branch: q.branch, env: q.env, by: person.name });
      const { meta, removed } = store.add(run, keep());
      store.noteFormat(suite.id, parsed.format);
      return okJson({ run: withRate(meta), removed, kept: store.group(meta).map(withRate), summary });
    }
    const body = await jsonBody(req);
    const m = RUN_ID.test(String(body.id || '')) ? store.meta(String(body.id)) : null;
    if (!m || !seesRun(person, m)) return gone();
    if (path === '/api/automation/delete') {
      store.remove(m.id);
      return okJson({ removed: m, kept: store.group(m).map(withRate) });
    }
    if (path === '/api/automation/reattach') {
      const at = await checkAttach(body, person, store.suite(m.suiteId));
      if (!at.ok) return fail(at.code, at.error);
      const { meta, removed } = store.reattach(m.id, at.attach, keep());
      return okJson({ run: withRate(meta), removed, kept: store.group(meta).map(withRate) });
    }
    return null;
  }

  /**
   * One request: { code, json } or { code, type, body, headers }, or null when the path isn't ours.
   * Errors with a code (a bad file, an old run, a bad pattern) come back as { ok: false, code, error }.
   */
  async function handle(method, path, url, req, person) {
    if (path !== '/api/automation' && !path.startsWith('/api/automation/')) return null;
    try {
      const g = await github.handle(method, path, url, req, person);
      if (g) return g;
      if (method === 'GET') {
        if (path === '/api/automation') return list(person);
        if (path === '/api/automation/run') return runDetail(String(url.searchParams.get('id') || ''), person);
        if (path === '/api/automation/targets') return await targets(String(url.searchParams.get('book') || ''), person);
        if (path === '/api/automation/excel') return await excel(String(url.searchParams.get('id') || ''), person);
        if (path === '/api/automation/cycle') return await cycleRoute(ctx, store, url, person, keep());
        return { code: 404, json: { ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' } };
      }
      if (method !== 'POST') return { code: 405, json: { ok: false, code: 'METHOD', error: 'Use GET or POST.' } };
      return (await post(path, url, req, person)) || { code: 404, json: { ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' } };
    } catch (e) {
      if (e && e.code === 'TOO_BIG') throw e; // the server answers 413
      if (e && e.code && /^[A-Z_]+$/.test(e.code)) return fail(e.code, e.message);
      throw e;
    }
  }

  return {
    handle,
    store,
    github,
    booksWithSuites,
    stop: () => github.stop(),
    /** A workbook was deleted: its runs go with it. */
    removeBook(name) {
      const gone = store.index().filter((m) => m.attach.book === name);
      for (const m of gone) store.remove(m.id);
      return gone.length;
    },
  };
}

/** A run as a workbook: Summary (its totals) and Results (every test). */
export async function runWorkbook(run) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Test Run';
  wb.created = new Date();
  const bold = { bold: true };
  const t = run.totals;
  const rate = passRate(t);
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 22 }, { width: 70 }];
  const src = run.source || {};
  const rows = [
    ['Suite', run.suiteName],
    ['Run', localStamp(run.startedAt)],
    ['Duration (s)', Math.round((run.durationMs || 0) / 100) / 10],
    ['Source', src.kind === 'github' ? `GitHub Actions${src.runUrl ? ` (${src.runUrl})` : ''}` : `Imported file: ${src.fileName || ''}`],
    ['Results format', FORMAT_LABEL[src.format] || ''],
    ['Framework', src.tool || ''],
    ['Branch', run.branch || ''],
    ['Commit', run.sha || ''],
    ['Environment', run.env || ''],
    ['Workbook', String(run.attach.book).replace(/\.xlsx$/i, '')],
    ['Test suite', run.attach.tab],
    ['Test cycle', run.attach.cycle || 'Status'],
    ['Passed', t.passed],
    ['Failed', t.failed],
    ['Skipped', t.skipped],
    ['Flaky', t.flaky],
    ['Total', t.total],
    ['Pass rate (of passed + failed)', rate == null ? '' : rate / 100],
    ['Imported by', run.by || ''],
  ];
  for (const r of rows) sum.addRow(r);
  sum.getColumn(1).font = bold;
  const rateCell = sum.getCell(`B${rows.findIndex((r) => r[0].startsWith('Pass rate')) + 1}`);
  rateCell.numFmt = '0%';
  sum.getColumn(2).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

  const res = wb.addWorksheet('Results');
  res.columns = [
    { header: 'Suite', key: 'suite', width: 28 },
    { header: 'File', key: 'file', width: 30 },
    { header: 'Test', key: 'title', width: 60 },
    { header: 'Tags', key: 'tags', width: 20 },
    { header: 'Case IDs', key: 'caseIds', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Duration (s)', key: 'dur', width: 12 },
    { header: 'Retries', key: 'retries', width: 9 },
    { header: 'Message', key: 'message', width: 80 },
  ];
  const word = { pass: 'Passed', fail: 'Failed', other: 'Skipped' };
  for (const x of run.tests) {
    res.addRow({
      suite: x.suite, file: x.file, title: x.title, tags: x.tags.join(', '), caseIds: x.caseIds.join(', '),
      status: `${word[x.status] || x.status}${x.flaky ? ' (flaky)' : ''}`, dur: Math.round(x.durationMs / 10) / 100, retries: x.retries, message: x.message,
    });
  }
  res.getRow(1).font = bold;
  res.views = [{ state: 'frozen', ySplit: 1 }];
  res.autoFilter = { from: 'A1', to: 'I1' };
  res.getColumn('message').alignment = { vertical: 'top', wrapText: true };
  res.getColumn('title').alignment = { vertical: 'top', wrapText: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
