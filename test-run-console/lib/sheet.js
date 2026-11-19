/**
 * Test Run console: everything that reads or writes a workbook.
 *
 * The host (server.mjs, or the tests) provides three globals:
 * - SpreadsheetApp.getActiveSpreadsheet(): the open workbook, through a small
 *   sheet API (lib/xlsx-book.mjs on real .xlsx files, dev/fake-sheets.mjs in tests);
 * - TRStore: the workbook's sidecar store for settings, findings, inbox drafts
 *   and path plans (sheets/.testrun/<workbook>.json), so the workbook itself
 *   only ever holds test data;
 * - Session / Utilities / LockService: who is testing, dates, and a lock.
 */

var TR_META = '_testrun'; // tab name used by the earlier Google Sheets version; always hidden from the console
var TR_SUMMARY = 'Test Run Summary';
var TR_ISSUES = 'Known issues'; // written into downloaded copies only
var TR_ROLES = ['manual', 'automation', 'ignore'];

function tr_err_(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function tr_ss_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw tr_err_('NO_SHEET', 'No workbook is open. Pick one, or add an .xlsx file to the sheets folder.');
  return ss;
}

function tr_user_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function tr_now_() {
  return Utilities.formatDate(new Date(), tr_ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
}

function tr_lock_() {
  var lock = null;
  try { lock = LockService.getDocumentLock(); } catch (e) { lock = null; }
  if (!lock) lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw tr_err_('BUSY', 'Another save is in progress. Try again in a moment.');
  return lock;
}

function tr_withLock_(fn) {
  var lock = tr_lock_();
  try { return fn(); } finally { lock.releaseLock(); }
}

// -----------------------------------------------------------------------------
// Sidecar store (TRStore): { list(kind), get(kind, key), put(kind, key, value, meta), remove(kind, key) }
// -----------------------------------------------------------------------------

function tr_metaGet_(kind, key) {
  return TRStore.get(kind, key);
}

function tr_metaList_(kind) {
  return TRStore.list(kind);
}

function tr_metaPut_(kind, key, value) {
  TRStore.put(kind, key, value, { updated: tr_now_(), by: tr_user_() });
}

function tr_metaDelete_(kind, key) {
  TRStore.remove(kind, key);
}

// -----------------------------------------------------------------------------
// Config and tab model
// -----------------------------------------------------------------------------

function tr_config_() {
  return tr_metaGet_('config', 'global');
}

function tr_topRows_(sh, n) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (!lastRow || !lastCol) return [];
  return sh.getRange(1, 1, Math.min(lastRow, n || 10), lastCol).getDisplayValues();
}

/** What Setup proposes for a tab nobody has configured yet. */
function tr_detectTab_(sh, top) {
  top = top || tr_topRows_(sh, 10);
  var hr0 = TRCore.detectHeaderRow(top);
  var headers = top[hr0] || [];
  var det = TRCore.detectColumns(headers);
  var role = 'ignore';
  if (TRCore.detectSpecColumn(headers) >= 0 && det.cycles.length) role = 'automation';
  else if (det.fields.scenario >= 0) role = 'manual';
  var cycle = det.cycles.length ? det.cycles[det.cycles.length - 1].label : '';
  return {
    role: role,
    headerRow: hr0 + 1,
    columns: TRCore.columnsByHeader(headers, det.fields),
    fillDown: true,
    cycle: cycle,
    release: ''
  };
}

function tr_open_(tabName, cfg) {
  if (cfg === undefined) cfg = tr_config_();
  var sh = tr_ss_().getSheetByName(String(tabName || ''));
  if (!sh) throw tr_err_('NO_TAB', 'The tab "' + tabName + '" was not found. It may have been renamed; open Setup.');
  var tcfg = (cfg && cfg.tabs && cfg.tabs[sh.getName()]) || tr_detectTab_(sh);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var values = lastRow && lastCol ? sh.getRange(1, 1, lastRow, lastCol).getDisplayValues() : [];
  var hr = Math.max(1, parseInt(tcfg.headerRow, 10) || 1);
  var headers = values[hr - 1] || [];
  var res = TRCore.resolveColumns(headers, tcfg.columns || {});
  var cycles = TRCore.detectCycles(headers);
  var used = {};
  TRCore.FIELDS.forEach(function (f) { if (res.fields[f] >= 0) used[res.fields[f]] = true; });
  cycles.forEach(function (c) { used[c.status] = true; if (c.comment >= 0) used[c.comment] = true; });
  var extras = [];
  for (var i = 0; i < headers.length; i++) if (!used[i] && String(headers[i]).trim()) extras.push(i);
  return {
    sheet: sh, tab: sh.getName(), cfg: cfg, tcfg: tcfg, values: values,
    headerRow: hr, headers: headers, fields: res.fields, missing: res.missing,
    cycles: cycles, extras: extras, lastRow: lastRow, lastCol: lastCol,
    struck: tr_struck_(sh, hr, lastRow, res.fields.scenario),
    issueLinks: tr_columnLinks_(sh, hr, lastRow, res.fields.linkedIssue)
  };
}

/** The hyperlink of each data row's cell in one column ('' when none). */
function tr_columnLinks_(sh, headerRow, lastRow, col) {
  var n = lastRow - headerRow;
  if (col < 0 || n <= 0) return [];
  return sh.getRange(headerRow + 1, col + 1, n, 1).getLinkUrls().map(function (r) { return r[0] || ''; });
}

/** One flag per data row: is its Scenario cell struck out (a retired case)? */
function tr_struck_(sh, headerRow, lastRow, scenarioCol) {
  var n = lastRow - headerRow;
  if (scenarioCol < 0 || n <= 0) return [];
  return sh.getRange(headerRow + 1, scenarioCol + 1, n, 1).getFontLines().map(function (r) { return r[0] === 'line-through'; });
}

function tr_cases_(m) {
  return TRCore.buildCases(m.values.slice(m.headerRow), m.fields, m.cycles, {
    firstRow: m.headerRow + 1,
    headers: m.headers,
    extras: m.extras,
    fillDown: m.tcfg.fillDown !== false,
    struck: m.struck,
    issueLinks: m.issueLinks,
    issueRefs: tr_issueRefs_()
  });
}

/** Index of a cycle by label; falls back to the saved current cycle, then the last one. */
function tr_findCycle_(m, label, lenient) {
  var want = label != null && label !== '' ? String(label) : (m.tcfg.cycle || '');
  for (var i = 0; i < m.cycles.length; i++) {
    if (m.cycles[i].label.toLowerCase() === want.toLowerCase()) return i;
  }
  if (label != null && label !== '' && !lenient) throw tr_err_('NO_CYCLE', 'The cycle "' + label + '" is not in this tab any more. Refresh.');
  return m.cycles.length - 1;
}

function tr_dvValues_(dv) {
  if (!dv) return null;
  var type = String(dv.getCriteriaType());
  var args = dv.getCriteriaValues() || [];
  if (type === String(SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST)) {
    return (args[0] || []).map(function (v) { return String(v); });
  }
  if (type === String(SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) && args[0] && args[0].getDisplayValues) {
    var out = [];
    args[0].getDisplayValues().forEach(function (r) { r.forEach(function (v) { if (String(v).trim()) out.push(String(v)); }); });
    return out;
  }
  return null;
}

/** Status options from the column's own dropdown; falls back to values seen, then defaults. */
function tr_statusOptions_(m, cy) {
  if (!cy) return TRCore.statusOptions(null);
  var n = Math.min(Math.max(m.lastRow - m.headerRow, 0), 60);
  if (n > 0) {
    var dvs = m.sheet.getRange(m.headerRow + 1, cy.status + 1, n, 1).getDataValidations();
    for (var i = 0; i < dvs.length; i++) {
      var vals = tr_dvValues_(dvs[i][0]);
      if (vals && vals.length) return TRCore.statusOptions(vals);
    }
  }
  var seen = [];
  for (var r = m.headerRow; r < m.values.length; r++) {
    var v = String(m.values[r][cy.status] || '').trim();
    if (v && seen.indexOf(v) < 0) seen.push(v);
  }
  return TRCore.statusOptions(seen.concat(TRCore.DEFAULT_STATUSES));
}

function tr_automationIndex_(cfg, exceptTab) {
  var index = {};
  var ss = tr_ss_();
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name === exceptTab || name === TR_META || name === TR_SUMMARY || name === TR_ISSUES) return;
    var tcfg = cfg && cfg.tabs && cfg.tabs[name];
    if (tcfg && tcfg.role !== 'automation') return;
    if (!tcfg && tr_detectTab_(sh).role !== 'automation') return;
    var m = tr_open_(name, cfg);
    var specCol = TRCore.detectSpecColumn(m.headers);
    if (specCol < 0 || !m.cycles.length) return;
    var statusCol = m.cycles[m.cycles.length - 1].status;
    var idx = TRCore.automationIndex(m.values.slice(m.headerRow), specCol, statusCol);
    Object.keys(idx).forEach(function (k) {
      var e = index[k] || (index[k] = { pass: 0, fail: 0, other: 0, total: 0 });
      e.pass += idx[k].pass; e.fail += idx[k].fail; e.other += idx[k].other; e.total += idx[k].total;
    });
  });
  return index;
}

function tr_versionOf_(m) {
  return TRCore.hashRaw(JSON.stringify(m.values) + '|' + m.struck.map(function (x) { return x ? 1 : 0; }).join('') + '|' + m.issueLinks.join(' '));
}

/** Find a case's row by key, checking the scenario text has not changed underneath. */
function tr_findRow_(m, key, sh, rowHint) {
  var idCol = m.fields.id;
  var scCol = m.fields.scenario;
  var baseKey = String(key || '').replace(/@\d+$/, '');
  function matches(r) {
    var row = m.values[r - 1];
    if (!row) return false;
    var id = idCol >= 0 ? String(row[idCol] || '').trim() : '';
    var scen = scCol >= 0 ? String(row[scCol] || '').trim() : '';
    var k = id || ('#' + TRCore.hash(scen));
    return k === baseKey && TRCore.hash(scen) === sh;
  }
  var hint = parseInt(rowHint, 10);
  if (hint > m.headerRow && matches(hint)) return hint;
  for (var r = m.headerRow + 1; r <= m.values.length; r++) if (matches(r)) return r;
  throw tr_err_('MOVED', 'This case changed in the sheet (its ID or scenario text is different now). The list has been refreshed; check it and try again.');
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

function tr_bootstrap() {
  var ss = tr_ss_();
  var cfg = tr_config_();
  var tabs = ss.getSheets().filter(function (sh) {
    var n = sh.getName();
    return n !== TR_META && n !== TR_SUMMARY && n !== TR_ISSUES;
  }).map(function (sh) {
    var saved = (cfg && cfg.tabs && cfg.tabs[sh.getName()]) || null;
    var top = tr_topRows_(sh, Math.max(10, saved ? saved.headerRow : 0));
    var det = tr_detectTab_(sh, top);
    var hr = saved ? saved.headerRow : det.headerRow;
    return {
      name: sh.getName(),
      hidden: sh.isSheetHidden(),
      rows: Math.max(sh.getLastRow() - hr, 0),
      top: top,
      detected: det,
      saved: saved
    };
  });
  var url = null;
  try { url = ScriptApp.getService().getUrl(); } catch (e) { url = null; }
  return {
    ok: true,
    email: tr_user_(),
    sheetName: ss.getName(),
    timeZone: ss.getSpreadsheetTimeZone(),
    appUrl: url,
    config: cfg,
    tabs: tabs,
    fields: TRCore.FIELDS,
    labels: TRCore.FIELD_LABELS,
    tiers: TRCore.TIERS
  };
}

/** Re-detect columns from a chosen header row (Setup's "Detect columns again"). Reads only. */
function tr_detectAt(tabName, headerRow) {
  var sh = tr_ss_().getSheetByName(String(tabName || ''));
  if (!sh) throw tr_err_('NO_TAB', 'The tab "' + tabName + '" was not found.');
  var hr = Math.min(Math.max(parseInt(headerRow, 10) || 1, 1), 50);
  var top = tr_topRows_(sh, Math.max(10, hr));
  var headers = top[hr - 1] || [];
  var det = TRCore.detectColumns(headers);
  return { ok: true, columns: TRCore.columnsByHeader(headers, det.fields), top: top };
}

function tr_loadTab(tabName, cycleLabel) {
  var cfg = tr_config_();
  var m = tr_open_(tabName, cfg);
  var cases = tr_cases_(m);
  var ci = tr_findCycle_(m, cycleLabel, true);
  var pi = ci > 0 ? ci - 1 : -1;
  var auto = tr_automationIndex_(cfg, m.tab);
  var release = m.tcfg.release || '';
  cases.forEach(function (c) {
    c.auto = TRCore.automationBadge(c, auto);
    c.tier = TRCore.riskTier(c, { release: release, prevIdx: pi });
  });
  var plan = tr_metaGet_('paths', m.tab);
  var info = plan ? TRCore.applyPathPlan(cases, plan) : { paths: TRCore.autoPaths(cases), unknown: [], leftover: 0 };
  return {
    ok: true,
    tab: m.tab,
    role: m.tcfg.role || 'manual',
    configured: !!(cfg && cfg.tabs && cfg.tabs[m.tab]),
    headerRow: m.headerRow,
    fields: m.fields,
    missing: m.missing,
    cycles: m.cycles.map(function (c) { return { label: c.label, hasComment: c.comment >= 0 }; }),
    cycleIdx: ci,
    prevIdx: pi,
    statusOptions: tr_statusOptions_(m, m.cycles[ci]),
    release: release,
    cases: cases,
    paths: info.paths,
    plan: plan ? { source: 'plan', savedAt: plan.savedAt || '', savedBy: plan.savedBy || '', unknown: info.unknown, leftover: info.leftover } : { source: 'auto' },
    hasAutomation: Object.keys(auto).length > 0,
    issueInfo: tr_issueInfo_(),
    claude: !!(cfg && cfg.claude),
    version: tr_versionOf_(m)
  };
}

function tr_version(tabName) {
  var m = tr_open_(tabName);
  return { ok: true, version: tr_versionOf_(m) };
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

function tr_saveSetup(setup) {
  setup = setup || {};
  return tr_withLock_(function () {
    var ss = tr_ss_();
    var prev = tr_config_() || {};
    var cfg = { version: 1, claude: setup.claude === true, tabs: {} };
    (setup.tabs || []).forEach(function (t) {
      if (!t || !ss.getSheetByName(String(t.name))) return;
      var prevTab = (prev.tabs && prev.tabs[t.name]) || {};
      var columns = {};
      TRCore.FIELDS.forEach(function (f) {
        var h = t.columns && t.columns[f];
        if (h) columns[f] = TRCore.cleanText(h, 300);
      });
      cfg.tabs[t.name] = {
        role: TR_ROLES.indexOf(t.role) >= 0 ? t.role : 'ignore',
        headerRow: Math.min(Math.max(parseInt(t.headerRow, 10) || 1, 1), 50),
        columns: columns,
        fillDown: t.fillDown !== false,
        cycle: TRCore.cleanText(t.cycle != null ? t.cycle : (prevTab.cycle || ''), 40),
        release: TRCore.cleanText(t.release != null ? t.release : (prevTab.release || ''), 40)
      };
    });
    tr_metaPut_('config', 'global', cfg);
    return { ok: true, config: cfg };
  });
}

/**
 * Remove a test cycle of a tab: its status and comment columns are deleted from the
 * workbook, with the results in them. header: its status column's header, as Setup shows
 * it. The last cycle of a tab stays. If it was the current cycle, the latest one left is.
 */
function tr_removeCycle(tabName, header) {
  var want = String(header == null ? '' : header).replace(/\s+/g, ' ').trim().toLowerCase();
  return tr_withLock_(function () {
    var cfg = tr_config_();
    if (!cfg || !cfg.tabs || !cfg.tabs[tabName]) throw tr_err_('NOT_SET_UP', 'Save Setup for this tab first.');
    var m = tr_open_(tabName, cfg);
    var ci = -1;
    m.cycles.forEach(function (c, i) { if (String(m.headers[c.status]).replace(/\s+/g, ' ').trim().toLowerCase() === want) ci = i; });
    if (ci < 0) throw tr_err_('NO_CYCLE', 'That test cycle is not in ' + m.tab + ' any more. Refresh.');
    if (m.cycles.length < 2) throw tr_err_('LAST_CYCLE', 'This is the only test cycle of ' + m.tab + ', so it stays. Start a new cycle first.');
    var cy = m.cycles[ci];
    var cols = [cy.status];
    if (cy.comment >= 0) cols.push(cy.comment);
    cols.sort(function (a, b) { return b - a; }).forEach(function (c) { m.sheet.deleteColumn(c + 1); });
    var t = cfg.tabs[tabName];
    var left = m.cycles.filter(function (c, i) { return i !== ci; });
    if (String(t.cycle || '').toLowerCase() === cy.label.toLowerCase()) {
      t.cycle = left[left.length - 1].label;
      tr_metaPut_('config', 'global', cfg);
    }
    return { ok: true, tab: m.tab, removed: cy.label, cycles: left.map(function (c) { return c.label; }) };
  });
}

/** Per-tab preferences changed from the console: current cycle, release in scope. */
function tr_setTabPrefs(tabName, prefs) {
  prefs = prefs || {};
  return tr_withLock_(function () {
    var cfg = tr_config_();
    if (!cfg || !cfg.tabs || !cfg.tabs[tabName]) throw tr_err_('NOT_SET_UP', 'Save Setup for this tab first.');
    if (prefs.cycle != null) cfg.tabs[tabName].cycle = TRCore.cleanText(prefs.cycle, 40);
    if (prefs.release != null) cfg.tabs[tabName].release = TRCore.cleanText(prefs.release, 40);
    tr_metaPut_('config', 'global', cfg);
    return { ok: true };
  });
}

/** Add opt-in columns (Tested by, Tested on, Release) at the right of the table. */
function tr_addColumns(tabName, fields) {
  return tr_withLock_(function () {
    var cfg = tr_config_();
    if (!cfg || !cfg.tabs || !cfg.tabs[tabName]) throw tr_err_('NOT_SET_UP', 'Save Setup for this tab first.');
    return tr_addColumns_(tabName, fields, cfg);
  });
}

/**
 * The tab with a Linked issue column, added at the right of the table if it has none
 * (a tab nobody saved in Setup gets its detected settings saved). No lock: callers hold it.
 */
function tr_ensureIssueColumn_(m) {
  if (m.fields.linkedIssue >= 0) return m;
  var cfg = tr_config_() || { version: 1, claude: false, tabs: {} };
  cfg.tabs = cfg.tabs || {};
  if (!cfg.tabs[m.tab]) cfg.tabs[m.tab] = JSON.parse(JSON.stringify(m.tcfg));
  cfg.tabs[m.tab].columns = cfg.tabs[m.tab].columns || {};
  tr_addColumns_(m.tab, ['linkedIssue'], cfg);
  return tr_open_(m.tab);
}

function tr_addColumns_(tabName, fields, cfg, save) {
  {
    var m = tr_open_(tabName, cfg);
    var allowed = ['testedBy', 'testedOn', 'release', 'linkedIssue', 'automatedBy'];
    var add = (fields || []).filter(function (f) { return allowed.indexOf(f) >= 0 && m.fields[f] < 0; });
    if (!add.length) return { ok: true, added: [] };
    var sh = m.sheet;
    var at = m.lastCol;
    sh.insertColumnsAfter(at, add.length);
    var labels = add.map(function (f) { return TRCore.FIELD_LABELS[f]; });
    sh.getRange(m.headerRow, at, 1, 1).copyTo(sh.getRange(m.headerRow, at + 1, 1, add.length), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    var dataRows = Math.max(m.lastRow - m.headerRow, 0);
    if (dataRows > 0 && m.fields.scenario >= 0) {
      var newCells = sh.getRange(m.headerRow + 1, at + 1, dataRows, add.length);
      sh.getRange(m.headerRow + 1, m.fields.scenario + 1, dataRows, 1).copyTo(newCells, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      newCells.setFontLine('none'); // a retired row's strikethrough is not copied into new columns
    }
    sh.getRange(m.headerRow, at + 1, 1, add.length).setValues([labels]);
    add.forEach(function (f, i) { cfg.tabs[tabName].columns[f] = labels[i]; });
    if (save !== false) tr_metaPut_('config', 'global', cfg);
    return { ok: true, added: add };
  }
}

/**
 * Every test suite tab has Tested by and Tested on: found by their headers when the tab
 * has them, else added at the right of the table (for a newly imported workbook). A tab
 * not saved in Setup yet stays unsaved: Setup finds the new columns by their headers.
 */
function tr_requireTestedColumns() {
  return tr_withLock_(function () {
    var cfg = tr_config_();
    var added = [];
    tr_manualTabs_(cfg).forEach(function (tab) {
      var saved = !!(cfg && cfg.tabs && cfg.tabs[tab]);
      var c = saved ? cfg : { version: 1, tabs: {} };
      if (!saved) {
        c.tabs[tab] = JSON.parse(JSON.stringify(tr_open_(tab, cfg).tcfg));
        c.tabs[tab].columns = c.tabs[tab].columns || {};
      }
      var r = tr_addColumns_(tab, ['testedBy', 'testedOn'], c, saved);
      if (r.added.length) added.push({ tab: tab, added: r.added });
    });
    return { ok: true, added: added };
  });
}

/**
 * The evidence line in a case's cycle comment: "Evidence: <file name>", replacing an
 * earlier one; file '' removes it. req: { tab, key, cycle, file }
 */
function tr_setEvidenceNote(req) {
  req = req || {};
  return tr_withLock_(function () {
    var m = tr_open_(req.tab);
    var c = tr_cases_(m).filter(function (x) { return x.key === req.key || (x.id && x.id === req.key); })[0];
    if (!c) throw tr_err_('NO_CASE', 'There is no test case "' + req.key + '" in ' + m.tab + ' any more.');
    var ci = tr_findCycle_(m, req.cycle || '', true);
    var cy = m.cycles[ci];
    if (!cy || cy.comment < 0) return { ok: true, comment: null };
    var before = String(c.comments[ci] || '');
    var lines = before.split(/\r?\n/).filter(function (l) { return !/^Evidence:\s/.test(l.trim()); });
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    var file = TRCore.cleanText(req.file, 200);
    if (file) lines.push('Evidence: ' + file);
    var after = lines.join('\n');
    if (after !== before) m.sheet.getRange(c.row, cy.comment + 1).setValue(TRCore.cellSafe(after));
    return { ok: true, comment: after };
  });
}

// -----------------------------------------------------------------------------
// Issues: the Linked issue cell, and the workbook's issue list (sidecar, kind 'issue')
// -----------------------------------------------------------------------------

/** { ref (lower case): [url, ...] } from the issue list, to give "#123" back its link. */
function tr_issueRefs_() {
  var byRef = {};
  tr_metaList_('issue').forEach(function (r) {
    var v = r.value || {};
    if (!v.url) return;
    [TRCore.issueRef(v.url), TRCore.issueRef(v.url, true)].forEach(function (ref) {
      var k = ref.toLowerCase();
      var list = byRef[k] || (byRef[k] = []);
      if (list.indexOf(v.url) < 0) list.push(v.url);
    });
  });
  return byRef;
}

/** { key (lower case): { title, priority, state } } for showing issues next to cases. */
function tr_issueInfo_() {
  var out = {};
  tr_metaList_('issue').forEach(function (r) {
    var v = r.value || {};
    if (v.title || v.priority || v.state) out[String(r.key).toLowerCase()] = { title: v.title || '', priority: v.priority || '', state: v.state || '' };
  });
  return out;
}

/** Add issues to the list (or fill in what is missing). items: [{ url|ref, title?, priority?, source?, number? }] */
function tr_noteIssues_(items) {
  (items || []).forEach(function (it) {
    var key = it.url || it.ref;
    if (!key) return;
    var prev = tr_metaGet_('issue', key);
    var v = prev ? JSON.parse(JSON.stringify(prev)) : { url: it.url || '', ref: it.url ? TRCore.issueRef(it.url) : it.ref, added: tr_now_(), addedBy: tr_user_() };
    var changed = !prev;
    ['title', 'priority', 'source'].forEach(function (f) {
      var val = TRCore.cleanText(it[f], f === 'title' ? 300 : 60);
      if (val && v[f] !== val && (f !== 'source' || !v.source)) { v[f] = val; changed = true; }
    });
    if (changed) tr_metaPut_('issue', key, v);
  });
}

/**
 * Write a case's Linked issue cell: references as text ("#12, #15"), linked to the
 * first issue's page, and note each link in the issue list. Returns the issues.
 */
function tr_writeIssueCell_(sh, r, col, value, extra) {
  var list = TRCore.parseIssues(value, '', tr_issueRefs_());
  var range = sh.getRange(r, col + 1);
  range.setValue(TRCore.cellSafe(TRCore.issueCellText(list)));
  var first = list.filter(function (i) { return i.url; })[0];
  range.setLinkUrl(first ? first.url : '');
  tr_noteIssues_(list.filter(function (i) { return i.url; }).map(function (i) {
    var e = { url: i.url, ref: i.ref };
    if (extra && extra.url === i.url) { e.title = extra.title; e.priority = extra.priority; e.source = extra.source; }
    return e;
  }));
  return list;
}

// -----------------------------------------------------------------------------
// Marking
// -----------------------------------------------------------------------------

/**
 * Mark one case. Compare-and-set: req.expect is the status the tester last
 * saw; if the cell holds something else, nothing is written and CONFLICT is
 * returned with what is there now.
 * req: { tab, key, sh, row, cycle, expect, status, comment?, issue? }
 */
function tr_mark(req) {
  req = req || {};
  return tr_withLock_(function () {
    var m = tr_open_(req.tab);
    var ci = tr_findCycle_(m, req.cycle);
    var cy = m.cycles[ci];
    if (!cy) throw tr_err_('NO_CYCLE', 'This tab has no status column yet. Start a cycle in Setup.');
    var r = tr_findRow_(m, req.key, req.sh, req.row);
    var row = m.values[r - 1];
    var cur = String(row[cy.status] || '').trim();
    var expect = String(req.expect == null ? '' : req.expect).trim();
    if (cur !== expect) {
      return {
        ok: false, code: 'CONFLICT', row: r, current: cur,
        comment: cy.comment >= 0 ? String(row[cy.comment] || '') : '',
        by: m.fields.testedBy >= 0 ? String(row[m.fields.testedBy] || '') : ''
      };
    }
    var status = req.status == null ? cur : String(req.status).trim();
    if (status) {
      var opts = tr_statusOptions_(m, cy);
      if (!opts.some(function (o) { return o.value === status; })) throw tr_err_('BAD_STATUS', '"' + status + '" is not one of this column\'s values.');
    }
    var sh = m.sheet;
    var out = { ok: true, row: r, status: status };
    if (status !== cur) sh.getRange(r, cy.status + 1).setValue(TRCore.cellSafe(status));
    if (req.comment != null && cy.comment >= 0) {
      out.comment = TRCore.cleanText(req.comment, 5000);
      if (out.comment !== String(row[cy.comment] || '').trim()) sh.getRange(r, cy.comment + 1).setValue(TRCore.cellSafe(out.comment));
    }
    if (req.issue != null) {
      var want = TRCore.parseIssues(TRCore.cleanText(req.issue, 2000), '', tr_issueRefs_());
      var had = m.fields.linkedIssue >= 0 ? TRCore.parseIssues(row[m.fields.linkedIssue], m.issueLinks[r - m.headerRow - 1], tr_issueRefs_()) : [];
      if (TRCore.issueValue(want) !== TRCore.issueValue(had)) {
        var hadColumn = m.fields.linkedIssue >= 0;
        if (want.length) m = tr_ensureIssueColumn_(m);
        if (m.fields.linkedIssue >= 0) want = tr_writeIssueCell_(sh, r, m.fields.linkedIssue, TRCore.issueValue(want));
        if (!hadColumn && m.fields.linkedIssue >= 0) out.addedIssueColumn = m.headers.length ? m.headers[m.fields.linkedIssue] : 'Linked issue';
      }
      out.issues = want;
      out.issue = TRCore.issueValue(want);
    }
    if (status !== cur) {
      if (m.fields.testedBy >= 0) { out.testedBy = status ? tr_user_() : ''; sh.getRange(r, m.fields.testedBy + 1).setValue(TRCore.cellSafe(out.testedBy)); }
      if (m.fields.testedOn >= 0) { out.testedOn = status ? tr_now_() : ''; sh.getRange(r, m.fields.testedOn + 1).setValue(out.testedOn); }
    }
    return out;
  });
}

/** Add a status + comment column pair for a new cycle, copying the dropdown and formatting. */
function tr_startCycle(tabName, label) {
  label = TRCore.cleanText(label, 40);
  if (!label) throw tr_err_('BAD_INPUT', 'Give the cycle a name, for example v2.20.1.');
  return tr_withLock_(function () {
    var cfg = tr_config_();
    if (!cfg || !cfg.tabs || !cfg.tabs[tabName]) throw tr_err_('NOT_SET_UP', 'Save Setup for this tab first.');
    var m = tr_open_(tabName, cfg);
    m.cycles.forEach(function (c) {
      if (c.label.toLowerCase() === label.toLowerCase()) throw tr_err_('EXISTS', 'A cycle called "' + label + '" already exists.');
    });
    var sh = m.sheet;
    var hr = m.headerRow;
    var dataRows = Math.max(m.lastRow - hr, 0);
    var tpl = m.cycles.length ? m.cycles[m.cycles.length - 1] : null;
    var P = SpreadsheetApp.CopyPasteType;
    var statusHeader;
    var commentHeader;
    var at;
    if (tpl) {
      var sHead = String(m.headers[tpl.status]).trim();
      var cHead = tpl.comment >= 0 ? String(m.headers[tpl.comment]).trim() : '';
      statusHeader = tpl.label ? sHead.replace(tpl.label, label) : sHead + ' / ' + label;
      commentHeader = cHead ? (tpl.label ? cHead.replace(tpl.label, label) : cHead + ' / ' + label) : 'Comment / ' + label;
      at = Math.max(tpl.status, tpl.comment) + 1;
      sh.insertColumnsAfter(at, 2);
      var srcS = tpl.status + 1;
      var srcC = tpl.comment >= 0 ? tpl.comment + 1 : tpl.status + 1;
      sh.getRange(hr, srcS).copyTo(sh.getRange(hr, at + 1), P.PASTE_FORMAT, false);
      sh.getRange(hr, srcC).copyTo(sh.getRange(hr, at + 2), P.PASTE_FORMAT, false);
      if (dataRows > 0) {
        sh.getRange(hr + 1, srcS, dataRows, 1).copyTo(sh.getRange(hr + 1, at + 1, dataRows, 1), P.PASTE_FORMAT, false);
        sh.getRange(hr + 1, srcS, dataRows, 1).copyTo(sh.getRange(hr + 1, at + 1, dataRows, 1), P.PASTE_DATA_VALIDATION, false);
        sh.getRange(hr + 1, srcC, dataRows, 1).copyTo(sh.getRange(hr + 1, at + 2, dataRows, 1), P.PASTE_FORMAT, false);
      }
    } else {
      statusHeader = 'Test Status / ' + label;
      commentHeader = 'Comment / ' + label;
      at = Math.max(m.lastCol, 1);
      sh.insertColumnsAfter(at, 2);
      sh.getRange(hr, at).copyTo(sh.getRange(hr, at + 1, 1, 2), P.PASTE_FORMAT, false);
      if (dataRows > 0) {
        var rule = SpreadsheetApp.newDataValidation().requireValueInList(TRCore.DEFAULT_STATUSES, true).setAllowInvalid(false).build();
        sh.getRange(hr + 1, at + 1, dataRows, 1).setDataValidation(rule);
      }
    }
    sh.getRange(hr, at + 1, 1, 2).setValues([[TRCore.cellSafe(statusHeader), TRCore.cellSafe(commentHeader)]]);
    cfg.tabs[tabName].cycle = label;
    tr_metaPut_('config', 'global', cfg);
    return { ok: true, label: label };
  });
}

// -----------------------------------------------------------------------------
// Adding and editing cases
// -----------------------------------------------------------------------------

function tr_cleanItem_(it) {
  var c = TRCore.validateReply({ type: 'scenarios', items: [it || {}] }, {}).items[0];
  c.status = TRCore.cleanText(it && it.status, 60);
  c.comment = TRCore.cleanText(it && it.comment, 5000);
  return c;
}

/** Append cases below the last one, with the next IDs and the last row's formatting. No lock: callers hold it. */
function tr_addCases_(tabName, items, cycleLabel) {
  var m = tr_open_(tabName);
  if (m.fields.scenario < 0) throw tr_err_('NOT_SET_UP', 'This tab has no Scenario column mapped. Open Setup.');
  items = (items || []).map(tr_cleanItem_);
  if (!items.length) return { ok: true, added: [] };
  if (items.some(function (it) { return it.issue; })) m = tr_ensureIssueColumn_(m);
  var f = m.fields;
  var cases = tr_cases_(m);
  var ids = f.id >= 0 ? m.values.slice(m.headerRow).map(function (r) { return r[f.id]; }).filter(function (v) { return String(v).trim(); }) : [];
  var newIds = f.id >= 0 ? TRCore.nextIds(ids, items.length) : [];
  var lastData = cases.length ? cases[cases.length - 1].row : m.headerRow;
  var cy = m.cycles.length ? m.cycles[tr_findCycle_(m, cycleLabel, true)] : null;
  var opts = cy ? tr_statusOptions_(m, cy) : [];
  var width = Math.max(m.lastCol, 1);
  var who = tr_user_();
  var when = tr_now_();
  var rows = items.map(function (it, i) {
    var row = [];
    for (var k = 0; k < width; k++) row.push('');
    function put(field, v) { if (f[field] >= 0 && v != null && String(v) !== '') row[f[field]] = TRCore.cellSafe(v); }
    put('id', newIds[i]);
    put('scenario', it.scenario);
    put('feature', it.feature);
    put('subFeature', it.subFeature);
    put('testType', it.testType);
    put('testData', it.testData);
    put('preCondition', it.preCondition);
    put('expected', TRCore.formatExpected(it.expected));
    put('release', it.release);
    if (cy && it.status) {
      if (!opts.some(function (o) { return o.value === it.status; })) throw tr_err_('BAD_STATUS', '"' + it.status + '" is not one of this column\'s values.');
      row[cy.status] = it.status;
      if (cy.comment >= 0 && it.comment) row[cy.comment] = TRCore.cellSafe(it.comment);
      put('testedBy', who);
      put('testedOn', when);
    }
    return row;
  });
  var sh = m.sheet;
  sh.insertRowsAfter(lastData, rows.length);
  var dest = sh.getRange(lastData + 1, 1, rows.length, width);
  if (lastData > m.headerRow) {
    var src = sh.getRange(lastData, 1, 1, width);
    src.copyTo(dest, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    src.copyTo(dest, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    dest.setFontLine('none'); // if the last case is retired, new cases must not come out struck
  }
  dest.setValues(rows);
  items.forEach(function (it, i) { if (it.issue && f.linkedIssue >= 0) tr_writeIssueCell_(sh, lastData + 1 + i, f.linkedIssue, it.issue); });
  var added = rows.map(function (r, i) { return { id: newIds[i] || '', row: lastData + 1 + i, scenario: items[i].scenario }; });
  items.forEach(function (it, i) {
    if (it.fromFinding) tr_setFindingState_(it.fromFinding, 'written', added[i].id || ('row ' + added[i].row));
  });
  return { ok: true, added: added };
}

function tr_addCases(tabName, items, cycleLabel) {
  return tr_withLock_(function () { return tr_addCases_(tabName, items, cycleLabel); });
}

/**
 * Change fields of one existing case. No lock: callers hold it.
 * opts.asTyped: text is written as typed (multi-line kept); an expected result is
 * only turned into "• " bullets when the cell already used them. Otherwise
 * expected results are always written in house style.
 */
function tr_editCase_(tabName, key, sh, rowHint, fields, opts) {
  var m = tr_open_(tabName);
  var r = tr_findRow_(m, key, sh, rowHint);
  var asTyped = !!(opts && opts.asTyped);
  var written = [];
  var skipped = [];
  TRCore.EDITABLE.forEach(function (f) {
    if (!fields || fields[f] == null) return;
    if (m.fields[f] < 0) { skipped.push(f); return; }
    var v;
    if (f === 'expected' && (!asTyped || Array.isArray(fields[f]) || TRCore.isBulleted(m.values[r - 1][m.fields[f]]))) {
      v = TRCore.formatExpected(Array.isArray(fields[f]) ? fields[f].map(function (b) { return TRCore.cleanText(b, 800); }) : TRCore.parseExpected(TRCore.cleanText(fields[f], 6000)));
    } else {
      v = TRCore.tidyText(TRCore.cleanText(fields[f], f === 'scenario' ? 400 : f === 'expected' ? 6000 : 3000));
    }
    if (f === 'scenario' && !v) return;
    if (f === 'linkedIssue') tr_writeIssueCell_(m.sheet, r, m.fields[f], v);
    else m.sheet.getRange(r, m.fields[f] + 1).setValue(TRCore.cellSafe(v));
    written.push(f);
  });
  return { ok: true, row: r, written: written, skipped: skipped };
}

function tr_editCase(tabName, key, sh, rowHint, fields) {
  return tr_withLock_(function () { return tr_editCase_(tabName, key, sh, rowHint, fields); });
}

// -----------------------------------------------------------------------------
// Case upkeep while running: update, deprecate, duplicate, restore
// -----------------------------------------------------------------------------

/** The case at sheet row r, as the console sees it (fresh read). */
function tr_caseAt_(tabName, r) {
  var m = tr_open_(tabName);
  return tr_cases_(m).filter(function (c) { return c.row === r; })[0] || null;
}

/** The current cycle with a comment column, or an error saying why the note has nowhere to go. */
function tr_noteCycle_(m, label) {
  var cy = m.cycles[tr_findCycle_(m, label)];
  if (!cy) throw tr_err_('NO_CYCLE', 'This tab has no status column yet. Start a cycle in Setup.');
  if (cy.comment < 0) throw tr_err_('NO_COMMENT', 'Cycle "' + (cy.label || 'Status') + '" has no Comment column, so the reason has nowhere to go. Add a Comment column next to its status column first.');
  return cy;
}

/** Strike out (or restore) the cells that describe the case; results and comments stay readable. */
function tr_strikeCase_(m, r, on) {
  TRCore.STRUCK_FIELDS.forEach(function (f) {
    if (m.fields[f] >= 0) m.sheet.getRange(r, m.fields[f] + 1).setFontLine(on ? 'line-through' : 'none');
  });
}

/**
 * Change a case's text while testing. req: { tab, key, sh, row, cycle, fields, note? }
 * A note goes into the cycle's comment as "Updated: <note>".
 */
function tr_updateCase(req) {
  req = req || {};
  return tr_withLock_(function () {
    var m = tr_open_(req.tab);
    var note = TRCore.cleanText(req.note, 500);
    var cy = note ? tr_noteCycle_(m, req.cycle) : null;
    var fields = {};
    TRCore.EDITABLE.forEach(function (f) { if (req.fields && req.fields[f] != null) fields[f] = req.fields[f]; });
    if (fields.scenario != null && !TRCore.cleanText(fields.scenario, 400)) throw tr_err_('BAD_INPUT', 'The scenario cannot be empty.');
    var res = tr_editCase_(req.tab, req.key, req.sh, req.row, fields, { asTyped: true });
    var out = { ok: true, row: res.row, written: res.written, skipped: res.skipped };
    if (cy) {
      var cur = String(m.values[res.row - 1][cy.comment] || '');
      out.comment = TRCore.withUpdateNote(cur, note);
      m.sheet.getRange(res.row, cy.comment + 1).setValue(TRCore.cellSafe(out.comment));
    }
    var c = tr_caseAt_(req.tab, res.row);
    if (c) { out.key = c.key; out.sh = c.sh; }
    return out;
  });
}

/**
 * Take a case out of the run without deleting it: its row is struck out and
 * the cycle's comment starts with why.
 * req: { tab, key, sh, row, cycle, kind: 'deprecated'|'duplicate', of (case kept, for duplicates), reason }
 */
function tr_retireCase(req) {
  req = req || {};
  var kind = String(req.kind || '');
  if (TRCore.RETIRE_KINDS.indexOf(kind) < 0) throw tr_err_('BAD_INPUT', 'Choose Deprecated or Duplicate.');
  var reason = TRCore.cleanText(req.reason, 500);
  if (kind === 'deprecated' && !reason) throw tr_err_('BAD_INPUT', 'Say why this case is no longer needed; it goes into the comment.');
  return tr_withLock_(function () {
    var m = tr_open_(req.tab);
    var cy = tr_noteCycle_(m, req.cycle);
    var r = tr_findRow_(m, req.key, req.sh, req.row);
    var of = '';
    if (kind === 'duplicate') {
      var want = TRCore.cleanText(req.of, 400).toLowerCase();
      if (!want) throw tr_err_('BAD_INPUT', 'Pick the case that is kept.');
      var cases = tr_cases_(m);
      var kept = cases.filter(function (c) { return (c.id && c.id.toLowerCase() === want) || c.key.toLowerCase() === want; })[0];
      if (!kept) throw tr_err_('BAD_INPUT', 'Case "' + req.of + '" is not in this tab.');
      if (kept.row === r) throw tr_err_('BAD_INPUT', 'A case cannot be a duplicate of itself.');
      if (kept.retired) throw tr_err_('BAD_INPUT', (kept.id || 'That case') + ' is retired itself. Pick the case that is kept.');
      of = kept.id || kept.scenario.slice(0, 120);
    }
    var note = TRCore.retireNote(kind, of, reason);
    var before = String(m.values[r - 1][cy.comment] || '');
    // The reason is often what the tester already typed as the comment ("Not applicable anymore"): say it once.
    var rest = TRCore.stripRetireNote(before).replace(/\s+/g, ' ').trim().toLowerCase();
    var comment = rest && rest === reason.replace(/\s+/g, ' ').trim().toLowerCase() ? note : TRCore.withRetireNote(before, note);
    m.sheet.getRange(r, cy.comment + 1).setValue(TRCore.cellSafe(comment));
    tr_strikeCase_(m, r, true);
    return { ok: true, row: r, comment: comment, retired: { kind: kind, of: of, reason: TRCore.parseRetireNote(note).reason, cycle: cy.label } };
  });
}

/** Bring a retired case back into the run: no strikethrough, and the note leaves this cycle's comment. req: { tab, key, sh, row, cycle } */
function tr_restoreCase(req) {
  req = req || {};
  return tr_withLock_(function () {
    var m = tr_open_(req.tab);
    var r = tr_findRow_(m, req.key, req.sh, req.row);
    var out = { ok: true, row: r };
    var cy = m.cycles[tr_findCycle_(m, req.cycle)];
    if (cy && cy.comment >= 0) {
      var cur = String(m.values[r - 1][cy.comment] || '');
      out.comment = TRCore.stripRetireNote(cur);
      if (out.comment !== cur.trim()) m.sheet.getRange(r, cy.comment + 1).setValue(TRCore.cellSafe(out.comment));
    }
    tr_strikeCase_(m, r, false);
    return out;
  });
}

// -----------------------------------------------------------------------------
// Findings
// -----------------------------------------------------------------------------

function tr_listFindings() {
  var list = tr_metaList_('finding').map(function (r) {
    var v = r.value || {};
    v.key = r.key;
    return v;
  });
  list.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  return { ok: true, findings: list };
}

function tr_saveFinding(input) {
  input = input || {};
  var text = TRCore.cleanText(input.text, 1000);
  if (!text) throw tr_err_('BAD_INPUT', 'Write one line about what you found.');
  return tr_withLock_(function () {
    var rows = tr_metaList_('finding');
    var prev = null;
    var max = 0;
    rows.forEach(function (r) {
      if (r.key === input.key) prev = r.value || {};
      var n = parseInt(String(r.key).replace(/\D+/g, ''), 10);
      if (n > max) max = n;
    });
    var key = prev ? input.key : 'F-' + ('00' + (max + 1)).slice(-3);
    var v = {
      text: text,
      issue: TRCore.cleanText(input.issue, 160),
      tab: TRCore.cleanText(input.tab, 160),
      area: TRCore.cleanText(input.area, 160),
      details: TRCore.cleanText(input.details, 5000),
      source: TRCore.cleanText(input.source || (prev && prev.source) || '', 40),
      url: /^https?:\/\//i.test(String(input.url || '')) ? TRCore.cleanText(input.url, 500) : ((prev && prev.url) || ''),
      state: (prev && prev.state) || 'open',
      caseId: (prev && prev.caseId) || '',
      by: (prev && prev.by) || tr_user_(),
      at: (prev && prev.at) || tr_now_()
    };
    tr_metaPut_('finding', key, v);
    // issueTitle: the issue's own title when it differs from the finding's line ('' leaves it to GitHub)
    if (v.url) tr_noteIssues_([{ url: v.url, title: input.issueTitle != null ? input.issueTitle : text, priority: input.priority, source: v.source }]);
    v.key = key;
    return { ok: true, finding: v };
  });
}

function tr_setFindingState_(key, state, caseId) {
  var v = tr_metaGet_('finding', key);
  if (!v) return;
  v.state = state;
  if (caseId) v.caseId = caseId;
  tr_metaPut_('finding', key, v);
}

function tr_setFindingState(key, state, caseId) {
  if (['open', 'written', 'covered'].indexOf(state) < 0) throw tr_err_('BAD_INPUT', 'Unknown state.');
  return tr_withLock_(function () { tr_setFindingState_(key, state, TRCore.cleanText(caseId, 80)); return { ok: true }; });
}

function tr_deleteFinding(key) {
  return tr_withLock_(function () { tr_metaDelete_('finding', String(key)); return { ok: true }; });
}

// -----------------------------------------------------------------------------
// Known issues
// -----------------------------------------------------------------------------

/**
 * A bug filed against a test case (from Bug Reporter, or added in Test Run): mark the
 * case failed in the current cycle (unless markFailed is false), add the bug to its
 * Linked issue cell, and note "Bug #12: title" in the cycle's comment.
 * req: { tab, key, url, title, priority, cycle?, markFailed? }
 */
function tr_linkBug(req) {
  req = req || {};
  var url = TRCore.cleanLink(req.url);
  if (!url) throw tr_err_('BAD_INPUT', 'The bug needs its link (https://…).');
  return tr_withLock_(function () {
    var m = tr_open_(req.tab);
    var c = tr_cases_(m).filter(function (x) { return x.key === req.key || (x.id && x.id === req.key); })[0];
    if (!c) throw tr_err_('NO_CASE', 'There is no test case "' + req.key + '" in ' + m.tab + ' any more.');
    if (c.retired) throw tr_err_('RETIRED', c.id + ' is retired (struck out), so it cannot be marked. Restore it first, or note the bug as a finding.');
    var ci = tr_findCycle_(m, req.cycle, true);
    var cy = m.cycles[ci];
    var markFailed = req.markFailed !== false; // false: only link the issue, leave the result as it is
    if (!cy && markFailed) throw tr_err_('NO_CYCLE', m.tab + ' has no cycle to mark yet. Start one in Setup.');
    var fail = cy ? tr_statusOptions_(m, cy).filter(function (o) { return o.cls === 'fail'; })[0] : null;
    if (!fail && markFailed) throw tr_err_('NO_FAIL', 'The status column of cycle "' + cy.label + '" has no failing value to mark.');
    var title = TRCore.cleanText(req.title, 300);
    var sh = m.sheet;
    var r = c.row;
    var prev = cy ? c.statuses[ci] || '' : '';
    if (markFailed && TRCore.classifyStatus(prev) !== 'fail') {
      sh.getRange(r, cy.status + 1).setValue(TRCore.cellSafe(fail.value));
      if (m.fields.testedBy >= 0) sh.getRange(r, m.fields.testedBy + 1).setValue(TRCore.cellSafe(tr_user_()));
      if (m.fields.testedOn >= 0) sh.getRange(r, m.fields.testedOn + 1).setValue(tr_now_());
    }
    var ref = TRCore.issueRef(url);
    if (markFailed && cy.comment >= 0) {
      var comment = String(c.comments[ci] || '').trim();
      if (comment.indexOf(url) < 0 && !new RegExp('(^|\\W)' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\W|$)').test(comment)) {
        var line = 'Bug ' + ref + (title ? ': ' + title : '');
        sh.getRange(r, cy.comment + 1).setValue(TRCore.cellSafe(comment ? comment + '\n' + line : line));
      }
    }
    m = tr_ensureIssueColumn_(m);
    var list = tr_writeIssueCell_(sh, r, m.fields.linkedIssue, TRCore.issueValue(c.issues.concat([{ ref: ref, url: url }])),
      { url: url, title: title, priority: req.priority, source: TRCore.cleanText(req.source, 40) || 'bug-reporter' });
    return { ok: true, key: c.key, id: c.id, row: r, tab: m.tab, cycle: cy ? cy.label : '', status: !markFailed || TRCore.classifyStatus(prev) === 'fail' ? prev : fail.value, previous: prev, issues: list };
  });
}

/** Manual tabs of the workbook (saved as manual in Setup, or detected as such). */
function tr_manualTabs_(cfg) {
  return tr_ss_().getSheets().filter(function (sh) {
    var n = sh.getName();
    if (n === TR_META || n === TR_SUMMARY || n === TR_ISSUES) return false;
    var t = cfg && cfg.tabs && cfg.tabs[n];
    return (t ? t.role : tr_detectTab_(sh).role) === 'manual';
  }).map(function (sh) { return sh.getName(); });
}

/**
 * Every issue the workbook knows: linked to test cases (any manual tab), or noted as
 * open findings (bugs with no test case yet), with what the issue list says about it.
 */
function tr_listIssues() {
  var cfg = tr_config_();
  var tabs = tr_manualTabs_(cfg);
  var byKey = {};
  var order = [];
  function entry(it) {
    var k = (it.url || it.ref).toLowerCase();
    if (!byKey[k]) { byKey[k] = { key: it.url || it.ref, ref: it.ref, url: it.url, cases: [], findings: [] }; order.push(k); }
    return byKey[k];
  }
  tabs.forEach(function (tab) {
    var m = tr_open_(tab, cfg);
    if (m.fields.linkedIssue < 0) return;
    var ci = m.cycles.length ? tr_findCycle_(m, '', true) : -1;
    tr_cases_(m).forEach(function (c) {
      c.issues.forEach(function (it) {
        var status = ci >= 0 ? c.statuses[ci] || '' : '';
        entry(it).cases.push({ tab: tab, key: c.key, id: c.id, scenario: c.scenario, status: status, cls: TRCore.classifyStatus(status), cycle: ci >= 0 ? m.cycles[ci].label : '', retired: !!c.retired });
      });
    });
  });
  tr_metaList_('finding').forEach(function (r) {
    var f = r.value || {};
    if (f.state && f.state !== 'open') return;
    TRCore.parseIssues(f.url || '', '', null).concat(f.url ? [] : TRCore.parseIssues(f.issue || '', '', tr_issueRefs_())).forEach(function (it) {
      entry(it).findings.push({ key: r.key, text: f.text, tab: f.tab || '' });
    });
  });
  var meta = {};
  tr_metaList_('issue').forEach(function (r) { meta[String(r.key).toLowerCase()] = r.value || {}; });
  var issues = order.map(function (k) {
    var e = byKey[k];
    var v = meta[k] || {};
    e.title = v.title || '';
    e.priority = v.priority || '';
    e.state = v.state || '';
    e.labels = v.labels || [];
    e.source = v.source || '';
    e.added = v.added || '';
    e.addedBy = v.addedBy || '';
    e.fetchedAt = v.fetchedAt || '';
    e.fetchError = v.fetchError || '';
    return e;
  });
  issues.sort(function (a, b) {
    var ca = a.state === 'closed' ? 1 : 0;
    var cb = b.state === 'closed' ? 1 : 0;
    if (ca !== cb) return ca - cb;
    var pa = TRCore.priorityRank(a.priority);
    var pb = TRCore.priorityRank(b.priority);
    if (pa !== pb) return pa - pb;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
  return { ok: true, issues: issues, tabs: tabs, sheetName: tr_ss_().getName() };
}

/**
 * Change what the issue list says about issues. items: [{ key, title?, priority?, state?,
 * labels?, fetchedAt?, fetchError? }]; a field left out (null) is kept.
 */
function tr_saveIssueMeta(items) {
  return tr_withLock_(function () {
    var n = 0;
    (items || []).forEach(function (it) {
      var key = String((it && it.key) || '').trim();
      if (!key) return;
      var url = TRCore.cleanLink(key);
      var v = tr_metaGet_('issue', key) || { url: url, ref: url ? TRCore.issueRef(url) : TRCore.cleanText(key, 160), added: tr_now_(), addedBy: tr_user_() };
      if (it.title != null) v.title = TRCore.cleanText(it.title, 300);
      if (it.priority != null) v.priority = TRCore.cleanText(it.priority, 40);
      if (it.state != null) v.state = ['open', 'closed', ''].indexOf(String(it.state).toLowerCase()) >= 0 ? String(it.state).toLowerCase() : '';
      if (Array.isArray(it.labels)) v.labels = it.labels.slice(0, 20).map(function (l) { return TRCore.cleanText(l, 60); });
      if (it.fetchedAt != null) v.fetchedAt = TRCore.cleanText(it.fetchedAt, 40);
      if (it.fetchError != null) v.fetchError = TRCore.cleanText(it.fetchError, 300);
      tr_metaPut_('issue', key, v);
      n++;
    });
    return { ok: true, saved: n };
  });
}

/**
 * For a downloaded copy only: leave out the retired cases. Their rows are deleted from each
 * test suite (a blank Feature or Sub feature below one keeps the value it filled down from
 * it), and an old Retired cases section in the Test Run Summary tab goes too. The workbook
 * in the sheets folder keeps them, struck out, so they can be restored.
 */
function tr_dropRetired() {
  var cfg = tr_config_();
  var removed = 0;
  tr_manualTabs_(cfg).forEach(function (tab) {
    var m = tr_open_(tab, cfg);
    var cases = tr_cases_(m);
    var gone = cases.filter(function (c) { return c.retired; }).map(function (c) { return c.row; });
    if (!gone.length) return;
    var sh = m.sheet;
    if (m.tcfg.fillDown !== false) {
      // What each kept case would read once the rows are gone; write what it read before where that differs.
      var lf = '', ls = '';
      cases.forEach(function (c) {
        if (c.retired) return;
        var f = c.feature, s = c.subFeature;
        if (m.fields.feature >= 0 && !f && c.group1 && lf !== c.group1) { f = c.group1; sh.getRange(c.row, m.fields.feature + 1).setValue(TRCore.cellSafe(f)); }
        if (f) { lf = f; if (!s) ls = ''; }
        if (m.fields.subFeature >= 0 && !s && c.group2 && ls !== c.group2) { s = c.group2; sh.getRange(c.row, m.fields.subFeature + 1).setValue(TRCore.cellSafe(s)); }
        if (s) ls = s;
      });
    }
    gone.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
    removed += gone.length;
  });
  var sum = tr_ss_().getSheetByName(TR_SUMMARY);
  if (sum && sum.getLastRow()) {
    var col = sum.getRange(1, 1, sum.getLastRow(), 1).getDisplayValues().map(function (r) { return String(r[0]); });
    var start = -1;
    for (var i = 0; i < col.length; i++) if (/^Retired cases, not counted above/.test(col[i])) { start = i; break; }
    if (start >= 0) {
      var end = start;
      while (end + 1 < col.length && col[end + 1] !== '') end++;
      if (start > 0 && col[start - 1] === '') start--; // the blank line before the section
      for (var r = end; r >= start; r--) sum.deleteRow(r + 1);
    }
  }
  return { ok: true, removed: removed };
}

/** Text for an issue's test cases in the Known issues sheet. */
function tr_issueCasesText_(e, manyTabs) {
  // retired cases are not in the downloaded workbook, so the sheet does not name them
  var lines = e.cases.filter(function (c) { return !c.retired; }).map(function (c) {
    return (manyTabs ? c.tab + ' \u203a ' : '') + (c.id || 'Row') + ' \u2013 ' + c.scenario + (c.status ? ' (' + c.status + ')' : ' (not run)');
  });
  e.findings.forEach(function (f) { lines.push('Not in the test cases yet (finding ' + f.key + ': ' + f.text + ')'); });
  return lines.join('\n');
}

/**
 * Add a "Known issues" sheet listing every issue (for downloads: the server runs this
 * on a copy of the workbook, never on the file itself). Returns how many were listed.
 */
function tr_writeIssuesSheet() {
  var data = tr_listIssues();
  if (!data.issues.length) return { ok: true, rows: 0 };
  var ss = tr_ss_();
  var name = TR_ISSUES;
  var existing = ss.getSheetByName(name);
  if (existing) {
    var a1 = String(existing.getRange(1, 1).getDisplayValues()[0][0] || '');
    if (a1 === 'Known issues') existing.clear(); else { name = TR_ISSUES + ' (Test Run)'; existing = ss.getSheetByName(name); if (existing) existing.clear(); }
  }
  var sh = existing || ss.insertSheet(name);
  var manyTabs = data.tabs.length > 1;
  var head = ['Issue', 'Title', 'Priority', 'State', 'Linked test cases', 'Added'];
  var W = head.length;
  var rows = [
    ['Known issues', '', '', '', '', ''],
    [data.sheetName + ' \u00b7 ' + data.issues.length + ' issue' + (data.issues.length === 1 ? '' : 's') + ' \u00b7 listed ' + tr_now_(), '', '', '', '', ''],
    ['', '', '', '', '', ''],
    head
  ];
  data.issues.forEach(function (e) {
    rows.push([e.ref, e.title, e.priority, e.state ? e.state.charAt(0).toUpperCase() + e.state.slice(1) : '', tr_issueCasesText_(e, manyTabs), [e.added, e.addedBy].filter(Boolean).join(' \u00b7 ')].map(TRCore.cellSafe));
  });
  sh.getRange(1, 1, rows.length, W).setValues(rows);
  data.issues.forEach(function (e, i) { if (e.url) sh.getRange(5 + i, 1).setLinkUrl(e.url); });
  sh.getRange(1, 1, rows.length, W).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('top').setWrap(true);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(4, 1, 1, W).setFontWeight('bold').setBackground('#C9DAF8');
  sh.getRange(4, 1, rows.length - 3, W).setBorder(true, true, true, true, true, true);
  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 320);
  sh.setColumnWidth(3, 70);
  sh.setColumnWidth(4, 70);
  sh.setColumnWidth(5, 380);
  sh.setColumnWidth(6, 150);
  sh.setFrozenRows(4);
  return { ok: true, rows: data.issues.length, sheet: name };
}

// -----------------------------------------------------------------------------
// Claude prompts and pasted replies
// -----------------------------------------------------------------------------

function tr_distinct_(cases, field) {
  var out = [];
  cases.forEach(function (c) { var v = String(c[field] || '').trim(); if (v && out.indexOf(v) < 0) out.push(v); });
  return out;
}

/**
 * Build the text for "Copy for Claude". Only what the tester selected goes in.
 * kind 'draft': opts.findingKeys; kind 'paths': opts.onlyUntested, opts.focus.
 */
function tr_buildPrompt(kind, tabName, opts) {
  opts = opts || {};
  var m = tr_open_(tabName);
  var cases = tr_cases_(m);
  if (kind === 'paths') {
    var ci = tr_findCycle_(m, opts.cycle, true);
    var active = TRCore.activeCases(cases);
    var scope = opts.onlyUntested && ci >= 0 ? active.filter(function (c) { return TRCore.classifyStatus(c.statuses[ci]) === 'none'; }) : active;
    if (!scope.length) throw tr_err_('EMPTY', 'There are no cases to plan.');
    return { ok: true, text: TRPrompts.planPaths({ tab: m.tab, cases: scope, focus: TRCore.cleanText(opts.focus, 400) }), count: scope.length };
  }
  var wanted = opts.findingKeys || [];
  var findings = tr_listFindings().findings.filter(function (f) { return wanted.indexOf(f.key) >= 0; });
  if (!findings.length) throw tr_err_('EMPTY', 'Select at least one finding.');
  var related = [];
  findings.forEach(function (f) {
    var area = String(f.area || '').toLowerCase();
    TRCore.activeCases(cases).forEach(function (c) {
      var inArea = area && ((c.group1 && c.group1.toLowerCase() === area) || (c.group2 && c.group2.toLowerCase() === area));
      if ((inArea || TRCore.similarity(f.text, c.scenario) >= 0.25) && related.indexOf(c) < 0) related.push(c);
    });
  });
  related = related.slice(0, 80);
  var fieldList = ['scenario', 'feature', 'subFeature', 'testType', 'testData', 'preCondition', 'expected', 'linkedIssue', 'release']
    .filter(function (f) { return m.fields[f] >= 0; })
    .map(function (f) { return (f === 'linkedIssue' ? 'issue' : f) + ' (' + m.headers[m.fields[f]] + ')'; });
  return {
    ok: true,
    text: TRPrompts.draftScenarios({
      tab: m.tab,
      fields: fieldList,
      features: tr_distinct_(cases, 'group1'),
      subFeatures: tr_distinct_(cases, 'group2'),
      testTypes: tr_distinct_(cases, 'testType'),
      existing: related,
      findings: findings
    }),
    count: findings.length,
    related: related.length
  };
}

/** Validate a pasted reply and keep it in the Inbox for review. Nothing is written to the tab here. */
function tr_parseReply(tabName, text) {
  var m = tr_open_(tabName);
  var cases = tr_cases_(m);
  var res = TRCore.validateReply(TRCore.extractJson(text), { caseIds: cases.map(function (c) { return c.id || c.key; }) });
  if (res.type === 'scenarios') {
    res.items.forEach(function (it) { it.duplicates = TRCore.duplicatesFor(it.scenario, TRCore.activeCases(cases)); it.state = 'open'; });
    res.covered.forEach(function (cv) { cv.state = 'open'; });
  }
  if (res.type === 'edits') {
    res.items.forEach(function (it) {
      var c = cases.filter(function (x) { return (x.id || x.key) === it.caseId; })[0];
      it.current = {};
      Object.keys(it.fields).forEach(function (f) { it.current[f] = f === 'linkedIssue' ? c.linkedIssue : c[f]; });
      it.state = 'open';
    });
  }
  var entry = {
    tab: m.tab, type: res.type, items: res.items || [], covered: res.covered || [],
    paths: res.paths || [], unknown: res.unknown || [], errors: res.errors || [],
    at: tr_now_(), by: tr_user_()
  };
  var key = 'I-' + new Date().getTime().toString(36);
  tr_withLock_(function () { tr_metaPut_('inbox', key, entry); });
  entry.key = key;
  return { ok: true, entry: entry };
}

function tr_listInbox() {
  return {
    ok: true,
    inbox: tr_metaList_('inbox').map(function (r) { var v = r.value || {}; v.key = r.key; return v; })
  };
}

function tr_openCount_(entry) {
  return (entry.items || []).filter(function (i) { return i.state === 'open'; }).length +
    (entry.covered || []).filter(function (c) { return c.state === 'open'; }).length;
}

/**
 * Accept or reject one inbox item. For scenarios, accept appends the
 * (possibly edited) row; for edits, accept writes the changed fields.
 * list: 'items' or 'covered'. extra: { item (edited), cycle, status, comment }.
 */
function tr_resolveInbox(key, list, index, action, extra) {
  extra = extra || {};
  return tr_withLock_(function () {
    var entry = tr_metaGet_('inbox', key);
    if (!entry) throw tr_err_('GONE', 'This inbox entry was already handled, maybe by someone else. Refresh.');
    var arr = list === 'covered' ? entry.covered : entry.items;
    var it = arr && arr[index];
    if (!it || it.state !== 'open') throw tr_err_('GONE', 'This item was already handled. Refresh.');
    var result = {};
    if (action === 'reject') {
      it.state = 'rejected';
    } else if (list === 'covered') {
      if (it.fromFinding) tr_setFindingState_(it.fromFinding, 'covered', it.caseId);
      it.state = 'accepted';
    } else if (entry.type === 'scenarios') {
      var src = extra.item || it;
      var draft = {};
      for (var k in src) draft[k] = src[k];
      draft.fromFinding = it.fromFinding;
      draft.status = extra.status || '';
      draft.comment = extra.comment || '';
      result = tr_addCases_(entry.tab, [draft], extra.cycle);
      it.state = 'added';
      it.addedId = result.added[0] && (result.added[0].id || ('row ' + result.added[0].row));
    } else if (entry.type === 'edits') {
      var m = tr_open_(entry.tab);
      var c = tr_cases_(m).filter(function (x) { return (x.id || x.key) === it.caseId; })[0];
      if (!c) throw tr_err_('MOVED', 'Case ' + it.caseId + ' is no longer in this tab.');
      result = tr_editCase_(entry.tab, c.key, c.sh, c.row, extra.item && extra.item.fields ? extra.item.fields : it.fields);
      it.state = 'applied';
    } else {
      throw tr_err_('BAD_INPUT', 'Use "Use this plan" for path plans.');
    }
    if (tr_openCount_(entry) === 0) tr_metaDelete_('inbox', key);
    else tr_metaPut_('inbox', key, entry);
    entry.key = key;
    return { ok: true, entry: entry, result: result };
  });
}

function tr_usePathPlan(key) {
  return tr_withLock_(function () {
    var entry = tr_metaGet_('inbox', key);
    if (!entry || entry.type !== 'paths') throw tr_err_('GONE', 'This plan was already handled. Refresh.');
    tr_metaPut_('paths', entry.tab, { paths: entry.paths, savedAt: tr_now_(), savedBy: tr_user_() });
    tr_metaDelete_('inbox', key);
    return { ok: true, tab: entry.tab };
  });
}

function tr_deleteInbox(key) {
  return tr_withLock_(function () { tr_metaDelete_('inbox', String(key)); return { ok: true }; });
}

function tr_clearPathPlan(tabName) {
  return tr_withLock_(function () { tr_metaDelete_('paths', String(tabName)); return { ok: true }; });
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

function tr_summary(tabName, cycleLabel) {
  var data = tr_loadTab(tabName, cycleLabel);
  var ci = data.cycleIdx;
  var hasG1 = data.cases.some(function (c) { return c.group1; });
  var s = TRCore.summarize(data.cases, { cycleIdx: ci, prevIdx: data.prevIdx, groupBy: hasG1 ? 'group1' : 'group2' });
  return {
    ok: true,
    sheetName: tr_ss_().getName(),
    tab: data.tab,
    cycle: ci >= 0 ? data.cycles[ci].label : '',
    prevCycle: data.prevIdx >= 0 ? data.cycles[data.prevIdx].label : '',
    cycles: data.cycles,
    release: data.release,
    groupLabel: hasG1 ? 'Feature' : 'Sub feature',
    generatedAt: tr_now_(),
    issueInfo: data.issueInfo,
    summary: s
  };
}

/**
 * The automation results tabs (role automation): for each, the latest status column's
 * figures, the figures per test file, and the failing tests. Reads only.
 */
function tr_automationSummary() {
  var cfg = tr_config_();
  var ss = tr_ss_();
  var out = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name === TR_META || name === TR_SUMMARY || name === TR_ISSUES) return;
    var tcfg = cfg && cfg.tabs && cfg.tabs[name];
    if ((tcfg ? tcfg.role : tr_detectTab_(sh).role) !== 'automation') return;
    var m = tr_open_(name, cfg);
    var cy = m.cycles[m.cycles.length - 1];
    if (!cy) { out.push({ tab: name, cycle: '', error: 'No status column found in this tab.' }); return; }
    var norm = m.headers.map(TRCore.normalizeHeader);
    var col = function (re) { for (var i = 0; i < norm.length; i++) if (re.test(norm[i])) return i; return -1; };
    var specCol = TRCore.detectSpecColumn(m.headers);
    var testCol = col(/playwright|test case id|test name|^test$|^title$/);
    var scenCol = col(/scenario/);
    var groupCol = col(/^suite$|functionality|feature|module/);
    var noteCol = cy.comment >= 0 ? cy.comment : col(/^notes?$|^comments?$/);
    var cell = function (row, i) { return i >= 0 ? String(row[i] == null ? '' : row[i]).trim() : ''; };
    var counts = { pass: 0, fail: 0, other: 0, none: 0, total: 0 };
    var files = {};
    var order = [];
    var failures = [];
    m.values.slice(m.headerRow).forEach(function (row) {
      var file = cell(row, specCol);
      var test = cell(row, testCol) || cell(row, scenCol);
      if (!file && !test) return;
      var status = cell(row, cy.status);
      var cls = TRCore.classifyStatus(status);
      counts[cls] += 1;
      counts.total += 1;
      var key = file || '(no test file)';
      if (!files[key]) { files[key] = { file: key, pass: 0, fail: 0, other: 0, none: 0, total: 0 }; order.push(key); }
      files[key][cls] += 1;
      files[key].total += 1;
      if (cls === 'fail') failures.push({ file: file, test: test, group: cell(row, groupCol), note: cell(row, noteCol), status: status });
    });
    var ran = counts.pass + counts.fail;
    out.push({
      tab: name,
      cycle: cy.label,
      counts: counts,
      executedPct: counts.total ? Math.round(((counts.total - counts.none) / counts.total) * 100) : null,
      passRate: ran ? Math.round((counts.pass / ran) * 100) : null,
      files: order.map(function (k) { return files[k]; }).sort(function (a, b) { return (b.fail - a.fail) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0); }),
      failures: failures
    });
  });
  return { ok: true, tabs: out, sheetName: ss.getName(), generatedAt: tr_now_() };
}

/** Write the summary into a visible "Test Run Summary" tab, so the published sheet carries it. */
function tr_writeSummaryTab(tabName, cycleLabel) {
  var res = tr_summary(tabName, cycleLabel);
  return tr_withLock_(function () {
    var ss = tr_ss_();
    var sh = ss.getSheetByName(TR_SUMMARY) || ss.insertSheet(TR_SUMMARY);
    sh.clear();
    var s = res.summary;
    var W = 8;
    var rows = [];
    var marks = { header: [], section: [] };
    function add(cells) {
      var r = [];
      for (var i = 0; i < W; i++) r.push(cells[i] == null ? '' : TRCore.cellSafe(cells[i]));
      rows.push(r);
      return rows.length;
    }
    function pct(v) { return v == null ? '-' : v + '%'; }
    add(['Test Run Summary']);
    add([res.tab + ' \u00b7 cycle ' + (res.cycle || '-') + ' \u00b7 generated ' + res.generatedAt + (tr_user_() ? ' by ' + tr_user_() : '')]);
    add([]);
    marks.header.push(add([res.groupLabel, 'Total', 'Pass', 'Fail', 'Other', 'Not run', 'Executed', 'Pass rate']));
    var c = s.counts;
    var totalRow = add(['All cases', c.total, c.pass, c.fail, c.other, c.none, pct(s.executedPct), pct(s.passRate)]);
    s.groups.forEach(function (g) {
      add([g.name, g.counts.total, g.counts.pass, g.counts.fail, g.counts.other, g.counts.none, pct(g.executedPct), pct(g.passRate)]);
    });
    var tableEnd = rows.length;
    add([]);
    marks.section.push(add(['Open failures (' + s.failures.length + ')']));
    var failHeader = add(['ID', 'Scenario', 'Comment', 'Linked issue', res.groupLabel]);
    marks.header.push(failHeader);
    var links = [];
    s.failures.forEach(function (f) {
      var r = add([f.id, f.scenario, f.comment, TRCore.issueCellText(f.issues || []), f.group]);
      var u = (f.issues || []).filter(function (i) { return i.url; })[0];
      if (u) links.push([r, u.url]);
    });
    var failEnd = rows.length;
    if (s.comparison) {
      add([]);
      marks.section.push(add(['Compared with ' + (res.prevCycle || 'the previous cycle')]));
      add(['Newly failing', s.comparison.newlyFailing.length]);
      add(['Fixed', s.comparison.fixed.length]);
      add(['Still failing', s.comparison.stillFailing]);
    }
    sh.getRange(1, 1, rows.length, W).setValues(rows);
    links.forEach(function (l) { sh.getRange(l[0], 4).setLinkUrl(l[1]); });
    var all = sh.getRange(1, 1, rows.length, W);
    all.setFontFamily('Arial').setFontSize(10).setVerticalAlignment('top').setWrap(true);
    sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
    marks.header.forEach(function (r) { sh.getRange(r, 1, 1, W).setFontWeight('bold').setBackground('#C9DAF8'); });
    marks.section.forEach(function (r) { sh.getRange(r, 1).setFontWeight('bold'); });
    sh.getRange(totalRow, 1, 1, W).setFontWeight('bold');
    sh.getRange(marks.header[0], 1, tableEnd - marks.header[0] + 1, W).setBorder(true, true, true, true, true, true);
    sh.getRange(failHeader, 1, failEnd - failHeader + 1, 5).setBorder(true, true, true, true, true, true);
    sh.getRange(marks.header[0] + 1, 3, tableEnd - marks.header[0], 1).setBackground('#E6F4EA');
    sh.getRange(marks.header[0] + 1, 4, tableEnd - marks.header[0], 1).setBackground('#FCE8E6');
    sh.setColumnWidth(1, 240);
    sh.setColumnWidth(2, 320);
    sh.setColumnWidth(3, 240);
    return { ok: true, sheet: TR_SUMMARY, rows: rows.length };
  });
}
