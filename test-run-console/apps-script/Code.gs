/**
 * Test Run console: entry points.
 *
 * @OnlyCurrentDoc
 *
 * The annotation above, and the "spreadsheets.currentonly" scope in
 * appsscript.json, mean this script can open only the sheet it is attached
 * to. It has no access to Google Drive or to any other file.
 *
 * Every api_* function returns { ok: true, ... } or
 * { ok: false, code, error } so the page handles every outcome the same way.
 */

function doGet(e) {
  var params = (e && e.parameter) || {};
  var view = params.view === 'summary' ? 'summary' : 'console';
  return tr_page_(view, params, 'webapp')
    .setTitle(view === 'summary' ? 'Test Run summary' : 'Test Run')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Test Run')
    .addItem('Open console (sidebar)', 'tr_openSidebar')
    .addItem('Open summary', 'tr_openSummaryDialog')
    .addToUi();
}

function tr_openSidebar() {
  SpreadsheetApp.getUi().showSidebar(tr_page_('console', {}, 'sidebar').setTitle('Test Run'));
}

function tr_openSummaryDialog() {
  SpreadsheetApp.getUi().showModalDialog(tr_page_('summary', {}, 'dialog').setWidth(1100).setHeight(760), 'Test Run summary');
}

function tr_page_(view, params, mode) {
  var t = HtmlService.createTemplateFromFile(view);
  t.params = tr_jsonForScript_(params);
  t.mode = mode;
  return t.evaluate();
}

/** Inline another HTML file (styles, shared helpers) into a page. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** JSON that is safe to place inside a <script> element. */
function tr_jsonForScript_(o) {
  return JSON.stringify(o || {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

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
