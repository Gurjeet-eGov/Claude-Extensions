// Automated results for one workbook › test suite › test cycle: the Summary's Automated view, the
// Auto ✓ / ✗ / – badges on Run, and what a published run carries (meta.age and run.age, see seal.mjs).
//
//   GET /api/automation/cycle?book=&tab=&cycle=
//     { ok, attach, generatedAt, keep,
//       latest:   the newest kept run attached there that this person may see (runSummary), or null,
//       runs:     every kept run attached there that they may see, newest first (runBrief),
//       cases:    { 'CMS/02': 'fail', … } each manual case ID's latest automated result there,
//       coverage: { total, covered, passing, failing, skipped } over the tab's live cases }
//
// Case IDs are matched without regard to case ("cms/02" is CMS/02). A case's result in a run is
// failed if any of its tests failed, else passed if any passed, else skipped; across the runs kept
// for the cycle, the newest run that has the case decides.
import { previousRun, compareRuns, groupCauses, passRate, lineOf, historyOf, byFile } from './results.mjs';
import { canSeeSuite } from './access.mjs';

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

export const caseKey = (id) => String(id == null ? '' : id).trim().toUpperCase();
const sameCycle = (m, a) => m.attach.book === a.book && m.attach.tab === a.tab && m.attach.cycle === a.cycle;
const RANK = { fail: 3, pass: 2, other: 1 };

/** The kept runs attached to a workbook › test suite › cycle, newest first (the index's order). */
export function cycleRunsOf(index, attach) {
  return index.filter((m) => sameCycle(m, attach));
}

/** Each manual case ID named by a run's tests, with its result in that run. only: the IDs to keep (all when left out). */
export function caseResults(run, only) {
  const want = only ? new Set([...only].map(caseKey)) : null;
  const out = {};
  for (const t of run.tests || []) {
    for (const id of t.caseIds || []) {
      const k = caseKey(id);
      if (!k || (want && !want.has(k))) continue;
      if (!out[k] || (RANK[t.status] || 0) > (RANK[out[k]] || 0)) out[k] = t.status;
    }
  }
  return out;
}

/** Each case's result in the newest run that has it. maps: caseResults of each run, newest first. */
export function latestCases(maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) if (!(k in out)) out[k] = v;
  return out;
}

/** "Manual cases also run by automation": of the tab's live case IDs, how many automation covers, and how they did. */
export function coverageOf(cases, tabCaseIds) {
  const ids = [...new Set((tabCaseIds || []).map(caseKey).filter(Boolean))];
  const out = { total: ids.length, covered: 0, passing: 0, failing: 0, skipped: 0 };
  for (const k of ids) {
    const v = cases[k];
    if (!v) continue;
    out.covered++;
    if (v === 'pass') out.passing++; else if (v === 'fail') out.failing++; else out.skipped++;
  }
  return out;
}

const testName = (t) => (t ? (t.file ? `${t.file} › ` : t.suite ? `${t.suite} › ` : '') + t.title : '');
const prevOf = (m) => (m ? { id: m.id, startedAt: m.startedAt, totals: m.totals, passRate: passRate(m.totals) } : null);

/**
 * A run as the Automated summary shows it: its figures and the previous run's (for "↑ from 84%"),
 * what changed (counts), and the top causes of failure with a few of their tests.
 */
export function runSummary(run, prev, { causes = 2, names = 3 } = {}) {
  const compare = compareRuns(run, prev);
  const all = groupCauses(run.tests, compare.newFailures);
  const byId = new Map(run.tests.map((t) => [t.id, t]));
  const src = run.source || {};
  return {
    id: run.id,
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    startedAt: run.startedAt,
    importedAt: run.importedAt,
    durationMs: run.durationMs,
    branch: run.branch,
    sha: run.sha,
    env: run.env,
    options: run.options || {},
    by: run.by,
    source: { kind: src.kind, format: src.format, runUrl: src.runUrl || '' },
    attach: run.attach,
    totals: run.totals,
    passRate: passRate(run.totals),
    previous: prev ? prevOf(prev) : null,
    changed: { newFailures: compare.newFailures.length, stillFailing: compare.stillFailing.length, fixed: compare.fixed.length, flaky: compare.flaky.length },
    causes: all.slice(0, causes).map((g) => ({
      signature: g.signature, other: !!g.other, count: g.count, newCount: g.newCount,
      tests: g.tests.slice(0, names).map((id) => testName(byId.get(id))), more: Math.max(0, g.tests.length - names),
    })),
    causeCount: all.length,
  };
}

/** A kept run in "Runs for this cycle" (no tests needed). */
export function runBrief(m, prevMeta) {
  const src = m.source || {};
  return {
    id: m.id, suiteId: m.suiteId, suiteName: m.suiteName, startedAt: m.startedAt, branch: m.branch, sha: m.sha, env: m.env, options: m.options || {},
    source: { kind: src.kind, runUrl: src.runUrl || '' }, attach: m.attach, totals: m.totals, passRate: passRate(m.totals),
    prevPassRate: prevMeta ? passRate(prevMeta.totals) : null,
  };
}

/**
 * A run's view, as GET /api/automation/run gives it, without anything that depends on who asks:
 * what a published run.age holds. run and prev: the runs themselves (loaded by the caller).
 */
export function runDetailData(store, m, run, prev) {
  const index = store.index();
  const prevMeta = previousRun(index, m);
  const compare = compareRuns(run, prev);
  const loaded = new Map([[run.id, run]].concat(prev ? [[prev.id, prev]] : []));
  const recent = lineOf(index, m).slice(-3).map((x) => loaded.get(x.id) || store.run(x.id)).filter(Boolean);
  const suite = store.suite(run.suiteId);
  const rate = (x) => (x ? { ...x, passRate: passRate(x.totals) } : null);
  return {
    run: { ...run, passRate: passRate(run.totals) },
    suite: suite ? { id: suite.id, name: suite.name, repo: suite.repo, format: suite.format } : null,
    previous: rate(prevMeta),
    compare,
    causes: groupCauses(run.tests, compare.newFailures),
    files: byFile(run.tests),
    history: historyOf(recent, run),
    kept: store.group(m).map(rate),
    canAct: false,
  };
}

/**
 * What a published run's meta.age holds: the run as the Automated summary shows it, as a row of
 * "Runs for this cycle", and its case results (only the tab's case IDs), with how many cases the tab has.
 */
export function publishedMeta(store, m, run, prev, tabCaseIds) {
  return {
    v: 1,
    summary: runSummary(run, prev),
    brief: runBrief(m, previousRun(store.index(), m)),
    cases: caseResults(run, tabCaseIds),
    tabCases: [...new Set((tabCaseIds || []).map(caseKey).filter(Boolean))].length,
  };
}

/** The live, unretired case IDs of a loaded tab (api_loadTab). */
export const liveCaseIds = (m) => (m && m.ok && Array.isArray(m.cases) ? m.cases.filter((c) => !c.retired && c.id).map((c) => c.id) : []);

/**
 * GET /api/automation/cycle. ctx: createAutomation's ({ lib, callApi, mayOpen, keep }); store: its AutomationStore.
 * Returns { code, json }.
 */
export async function cycleRoute(ctx, store, url, person, keep) {
  const ok = (obj) => ({ code: 200, json: { ok: true, ...obj } });
  const book = clip(url.searchParams.get('book'), 260);
  const tab = clip(url.searchParams.get('tab'), 160);
  const cycle = clip(url.searchParams.get('cycle'), 60);
  if (!book || !tab) return { code: 200, json: { ok: false, code: 'NO_ATTACH', error: 'Choose the workbook, test suite and test cycle.' } };
  if (!ctx.lib.list().some((b) => b.name === book)) return { code: 200, json: { ok: false, code: 'NO_BOOK', error: 'That workbook is not in Test Run any more.' } };
  if (!ctx.mayOpen(person, book)) return { code: 403, json: { ok: false, code: 'FORBIDDEN', error: 'This workbook is not shared with you. Ask your test lead.' } };
  const attach = { book, tab, cycle };
  const index = store.index();
  const metas = cycleRunsOf(index, attach).filter((m) => canSeeSuite(person, m.suiteId));
  const base = { attach, generatedAt: stamp(), keep };
  if (!metas.length) return ok({ ...base, latest: null, runs: [], cases: {}, coverage: null });
  const runs = metas.map((m) => store.run(m.id)).filter(Boolean);
  if (!runs.length) return ok({ ...base, latest: null, runs: [], cases: {}, coverage: null });
  const latest = runs[0];
  const prevMeta = previousRun(index, latest);
  const prev = prevMeta ? store.run(prevMeta.id) : null;
  const cases = latestCases(runs.map((r) => caseResults(r)));
  const tabModel = await ctx.callApi('api_loadTab', [tab, cycle], book, { ...person, remember: false });
  return ok({
    ...base,
    latest: runSummary(latest, prev),
    runs: metas.map((m) => runBrief(m, previousRun(index, m))),
    cases,
    coverage: coverageOf(cases, liveCaseIds(tabModel)),
  });
}
