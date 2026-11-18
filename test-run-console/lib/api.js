/**
 * Test Run console: the functions the page calls (POST /api/call/<name>).
 *
 * Every api_* function returns { ok: true, ... } or
 * { ok: false, code, error }, so the page handles every outcome the same way.
 */

function tr_errCode_(e) {
  var msg = String((e && e.message) || e);
  if (/permission|not have access|read.?only|view.?only|access denied|not authori[sz]ed to edit/i.test(msg)) return 'READONLY';
  if (/lock|timed out|too many/i.test(msg)) return 'BUSY';
  return 'ERROR';
}

function tr_call_(fn) {
  try {
    var r = fn();
    if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'ok')) return r;
    return { ok: true, data: r };
  } catch (e) {
    var code = (e && e.code) || tr_errCode_(e);
    if (code === 'ERROR' && tr_errCode_(e) === 'READONLY') code = 'READONLY';
    return { ok: false, code: code, error: String((e && e.message) || e) };
  }
}

function api_bootstrap() { return tr_call_(function () { return tr_bootstrap(); }); }
function api_saveSetup(setup) { return tr_call_(function () { return tr_saveSetup(setup); }); }
function api_setTabPrefs(tab, prefs) { return tr_call_(function () { return tr_setTabPrefs(tab, prefs); }); }
function api_addColumns(tab, fields) { return tr_call_(function () { return tr_addColumns(tab, fields); }); }
function api_detectTab(tab, headerRow) { return tr_call_(function () { return tr_detectAt(tab, headerRow); }); }
function api_loadTab(tab, cycle) { return tr_call_(function () { return tr_loadTab(tab, cycle); }); }
function api_version(tab) { return tr_call_(function () { return tr_version(tab); }); }
function api_mark(req) { return tr_call_(function () { return tr_mark(req); }); }
function api_startCycle(tab, label) { return tr_call_(function () { return tr_startCycle(tab, label); }); }
function api_addCases(tab, items, cycle) { return tr_call_(function () { return tr_addCases(tab, items, cycle); }); }
function api_editCase(tab, key, sh, row, fields) { return tr_call_(function () { return tr_editCase(tab, key, sh, row, fields); }); }
function api_listFindings() { return tr_call_(function () { return tr_listFindings(); }); }
function api_saveFinding(f) { return tr_call_(function () { return tr_saveFinding(f); }); }
function api_setFindingState(key, state, caseId) { return tr_call_(function () { return tr_setFindingState(key, state, caseId); }); }
function api_deleteFinding(key) { return tr_call_(function () { return tr_deleteFinding(key); }); }
function api_buildPrompt(kind, tab, opts) { return tr_call_(function () { return tr_buildPrompt(kind, tab, opts); }); }
function api_parseReply(tab, text) { return tr_call_(function () { return tr_parseReply(tab, text); }); }
function api_listInbox() { return tr_call_(function () { return tr_listInbox(); }); }
function api_resolveInbox(key, list, index, action, extra) { return tr_call_(function () { return tr_resolveInbox(key, list, index, action, extra); }); }
function api_usePathPlan(key) { return tr_call_(function () { return tr_usePathPlan(key); }); }
function api_deleteInbox(key) { return tr_call_(function () { return tr_deleteInbox(key); }); }
function api_clearPathPlan(tab) { return tr_call_(function () { return tr_clearPathPlan(tab); }); }
function api_summary(tab, cycle) { return tr_call_(function () { return tr_summary(tab, cycle); }); }
function api_writeSummaryTab(tab, cycle) { return tr_call_(function () { return tr_writeSummaryTab(tab, cycle); }); }
