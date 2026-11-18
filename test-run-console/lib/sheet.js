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
    cycles: cycles, extras: extras, lastRow: lastRow, lastCol: lastCol
  };
}

function tr_cases_(m) {
  return TRCore.buildCases(m.values.slice(m.headerRow), m.fields, m.cycles, {
    firstRow: m.headerRow + 1,
    headers: m.headers,
    extras: m.extras,
    fillDown: m.tcfg.fillDown !== false
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
    if (name === exceptTab || name === TR_META || name === TR_SUMMARY) return;
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
  return TRCore.hashRaw(JSON.stringify(m.values));
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
    return n !== TR_META && n !== TR_SUMMARY;
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
    issueBase: (cfg && cfg.issueBase) || '',
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
    var issueBase = TRCore.cleanText(setup.issueBase, 300);
    if (issueBase && !/^https:\/\//i.test(issueBase)) throw tr_err_('BAD_INPUT', 'The issue link must start with https://');
    var cfg = { version: 1, claude: setup.claude === true, issueBase: issueBase, tabs: {} };
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

/** Per-tab preferences changed from the Plan screen: current cycle, release in scope. */
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
      sh.getRange(m.headerRow + 1, m.fields.scenario + 1, dataRows, 1).copyTo(sh.getRange(m.headerRow + 1, at + 1, dataRows, add.length), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    sh.getRange(m.headerRow, at + 1, 1, add.length).setValues([labels]);
    add.forEach(function (f, i) { cfg.tabs[tabName].columns[f] = labels[i]; });
    tr_metaPut_('config', 'global', cfg);
    return { ok: true, added: add };
  });
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
    if (!cy) throw tr_err_('NO_CYCLE', 'This tab has no status column yet. Start a cycle on the Plan screen.');
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
    if (req.issue != null && m.fields.linkedIssue >= 0) {
      out.issue = TRCore.cleanText(req.issue, 300);
      if (out.issue !== String(row[m.fields.linkedIssue] || '').trim()) sh.getRange(r, m.fields.linkedIssue + 1).setValue(TRCore.cellSafe(out.issue));
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
  var f = m.fields;
  if (f.scenario < 0) throw tr_err_('NOT_SET_UP', 'This tab has no Scenario column mapped. Open Setup.');
  items = (items || []).map(tr_cleanItem_);
  if (!items.length) return { ok: true, added: [] };
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
    put('linkedIssue', it.issue);
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
  }
  dest.setValues(rows);
  var added = rows.map(function (r, i) { return { id: newIds[i] || '', row: lastData + 1 + i, scenario: items[i].scenario }; });
  items.forEach(function (it, i) {
    if (it.fromFinding) tr_setFindingState_(it.fromFinding, 'written', added[i].id || ('row ' + added[i].row));
  });
  return { ok: true, added: added };
}

function tr_addCases(tabName, items, cycleLabel) {
  return tr_withLock_(function () { return tr_addCases_(tabName, items, cycleLabel); });
}

/** Change fields of one existing case. No lock: callers hold it. */
function tr_editCase_(tabName, key, sh, rowHint, fields) {
  var m = tr_open_(tabName);
  var r = tr_findRow_(m, key, sh, rowHint);
  var written = [];
  var skipped = [];
  TRCore.EDITABLE.forEach(function (f) {
    if (!fields || fields[f] == null) return;
    if (m.fields[f] < 0) { skipped.push(f); return; }
    var v = f === 'expected'
      ? TRCore.formatExpected(Array.isArray(fields[f]) ? fields[f].map(function (b) { return TRCore.cleanText(b, 800); }) : TRCore.parseExpected(TRCore.cleanText(fields[f], 6000)))
      : TRCore.cleanText(fields[f], f === 'scenario' ? 400 : 3000);
    if (f === 'scenario' && !v) return;
    m.sheet.getRange(r, m.fields[f] + 1).setValue(TRCore.cellSafe(v));
    written.push(f);
  });
  return { ok: true, row: r, written: written, skipped: skipped };
}

function tr_editCase(tabName, key, sh, rowHint, fields) {
  return tr_withLock_(function () { return tr_editCase_(tabName, key, sh, rowHint, fields); });
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
    var scope = opts.onlyUntested && ci >= 0 ? cases.filter(function (c) { return TRCore.classifyStatus(c.statuses[ci]) === 'none'; }) : cases;
    if (!scope.length) throw tr_err_('EMPTY', 'There are no cases to plan.');
    return { ok: true, text: TRPrompts.planPaths({ tab: m.tab, cases: scope, focus: TRCore.cleanText(opts.focus, 400) }), count: scope.length };
  }
  var wanted = opts.findingKeys || [];
  var findings = tr_listFindings().findings.filter(function (f) { return wanted.indexOf(f.key) >= 0; });
  if (!findings.length) throw tr_err_('EMPTY', 'Select at least one finding.');
  var related = [];
  findings.forEach(function (f) {
    var area = String(f.area || '').toLowerCase();
    cases.forEach(function (c) {
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
    res.items.forEach(function (it) { it.duplicates = TRCore.duplicatesFor(it.scenario, cases); it.state = 'open'; });
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
    issueBase: data.issueBase,
    summary: s
  };
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
    s.failures.forEach(function (f) { add([f.id, f.scenario, f.comment, f.issue, f.group]); });
    var failEnd = rows.length;
    if (s.comparison) {
      add([]);
      marks.section.push(add(['Compared with ' + (res.prevCycle || 'the previous cycle')]));
      add(['Newly failing', s.comparison.newlyFailing.length]);
      add(['Fixed', s.comparison.fixed.length]);
      add(['Still failing', s.comparison.stillFailing]);
    }
    sh.getRange(1, 1, rows.length, W).setValues(rows);
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
