/**
 * Test Run console: pure logic.
 *
 * Nothing in this file touches a Google service, so the same code runs in
 * Apps Script and in the Node unit tests (test/*.test.mjs load it with vm).
 * Keep it that way: plain functions, no SpreadsheetApp, no optional chaining.
 */
var TRCore = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------------

  /** Logical fields the console understands, in display order. */
  var FIELDS = [
    'id', 'scenario', 'feature', 'subFeature', 'testType', 'testData',
    'preCondition', 'expected', 'linkedIssue', 'automatedBy', 'release',
    'testedBy', 'testedOn'
  ];

  var FIELD_LABELS = {
    id: 'ID',
    scenario: 'Scenario',
    feature: 'Feature',
    subFeature: 'Sub feature',
    testType: 'Test type',
    testData: 'Test data',
    preCondition: 'Pre condition',
    expected: 'Expected result',
    linkedIssue: 'Linked issue',
    automatedBy: 'Automated by',
    release: 'Release',
    testedBy: 'Tested by',
    testedOn: 'Tested on'
  };

  /** Header aliases, already normalised (see normalizeHeader). First match wins. */
  var ALIASES = {
    id: ['s no', 'sno', 'sl no', 'sr no', 'serial no', 'id', 'test id', 'test case id',
      'tc id', 'case id', 'tc no', 'test case no', 'test case id playwright path'],
    scenario: ['scenario', 'test scenario', 'test case', 'test case title', 'test case name',
      'title', 'test title', 'kpi', 'check'],
    feature: ['feature', 'module', 'suite', 'area', 'epic'],
    subFeature: ['sub feature', 'subfeature', 'sub module', 'submodule', 'functionality',
      'component', 'sub area'],
    testType: ['test type', 'type', 'category'],
    testData: ['test data', 'data', 'input', 'inputs'],
    preCondition: ['pre condition', 'precondition', 'pre conditions', 'preconditions',
      'pre requisites', 'prerequisites', 'pre requisite', 'prerequisite'],
    expected: ['expected result', 'expected results', 'expected', 'expected outcome',
      'acceptance criteria', 'expected behaviour', 'expected behavior'],
    linkedIssue: ['linked issue', 'linked issues', 'issue', 'issues', 'issue ref',
      'issue story ref', 'bug', 'bug id', 'defect', 'defect id', 'jira', 'ticket'],
    automatedBy: ['automated by', 'automation', 'automation ref', 'spec', 'automated'],
    release: ['release', 'introduced in', 'version', 'fix version', 'since release'],
    testedBy: ['tested by', 'tester', 'executed by'],
    testedOn: ['tested on', 'executed on', 'test date', 'date tested', 'execution date']
  };

  /** Spec-file column of an automation results tab. */
  var SPEC_ALIASES = ['test file', 'spec', 'spec file', 'file', 'test spec'];

  var STATUS_RE = /^\s*(?:test\s*)?(?:execution\s*)?(?:status|result)s?\s*(?:[\/|:\-\u2013]\s*(.*))?$/i;
  var COMMENT_RE = /^\s*(?:comments?|notes?|remarks?)\s*(?:[\/|:\-\u2013]\s*(.*))?$/i;

  function normalizeHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function normLabel(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  /**
   * Status / comment column pairs ("cycles"), in header order.
   * "Test Status / v2.12" + "Comment / v2.12" pair on their label; a bare
   * "Status" pairs with a bare "Comment" or "Notes".
   */
  function detectCycles(headers) {
    var statuses = [];
    var comments = [];
    for (var i = 0; i < headers.length; i++) {
      var raw = String(headers[i] == null ? '' : headers[i]);
      if (!raw.trim()) continue;
      var m = raw.match(STATUS_RE);
      if (m) { statuses.push({ label: (m[1] || '').trim(), status: i }); continue; }
      var c = raw.match(COMMENT_RE);
      if (c) comments.push({ label: (c[1] || '').trim(), col: i, used: false });
    }
    return statuses.map(function (s) {
      var pair = null;
      for (var j = 0; j < comments.length; j++) {
        if (!comments[j].used && normLabel(comments[j].label) === normLabel(s.label)) { pair = comments[j]; break; }
      }
      if (pair) pair.used = true;
      return { label: s.label, status: s.status, comment: pair ? pair.col : -1 };
    });
  }

  /**
   * Auto-detect logical columns from a header row.
   * Returns { fields: {field: index|-1}, cycles: [...], extras: [index...] }.
   */
  function detectColumns(headers) {
    var norm = headers.map(normalizeHeader);
    var cycles = detectCycles(headers);
    var taken = {};
    cycles.forEach(function (c) { taken[c.status] = true; if (c.comment >= 0) taken[c.comment] = true; });
    var fields = {};
    FIELDS.forEach(function (f) {
      fields[f] = -1;
      var aliases = ALIASES[f];
      for (var a = 0; a < aliases.length && fields[f] < 0; a++) {
        for (var i = 0; i < norm.length; i++) {
          if (!taken[i] && norm[i] === aliases[a]) { fields[f] = i; taken[i] = true; break; }
        }
      }
    });
    var extras = [];
    for (var i = 0; i < headers.length; i++) {
      if (!taken[i] && norm[i]) extras.push(i);
    }
    return { fields: fields, cycles: cycles, extras: extras };
  }

  /** Index of an automation tab's spec-file column, or -1. */
  function detectSpecColumn(headers) {
    var norm = headers.map(normalizeHeader);
    for (var a = 0; a < SPEC_ALIASES.length; a++) {
      var i = norm.indexOf(SPEC_ALIASES[a]);
      if (i >= 0) return i;
    }
    return -1;
  }

  /** First row (0-based) among the first 10 that looks like a header row. */
  function detectHeaderRow(rows) {
    var limit = Math.min(rows.length, 10);
    for (var r = 0; r < limit; r++) {
      var d = detectColumns(rows[r] || []);
      var hits = d.cycles.length;
      FIELDS.forEach(function (f) { if (d.fields[f] >= 0) hits++; });
      if (hits >= 2) return r;
    }
    return 0;
  }

  /**
   * Turn a stored mapping {field: headerText} into indices for this header row.
   * Missing headers are reported so Setup can ask for a fix.
   */
  function resolveColumns(headers, columns) {
    var out = {};
    var missing = [];
    FIELDS.forEach(function (f) {
      out[f] = -1;
      var want = columns && columns[f];
      if (!want) return;
      var idx = -1;
      for (var i = 0; i < headers.length; i++) {
        if (String(headers[i]).trim() === String(want).trim()) { idx = i; break; }
      }
      if (idx < 0) missing.push(f);
      out[f] = idx;
    });
    return { fields: out, missing: missing };
  }

  /** Mapping by header text, for storage, from detected indices. */
  function columnsByHeader(headers, fields) {
    var out = {};
    FIELDS.forEach(function (f) {
      if (fields[f] >= 0 && headers[fields[f]] != null) out[f] = String(headers[fields[f]]);
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Statuses
  // ---------------------------------------------------------------------------

  var DEFAULT_STATUSES = ['Pass', 'Fail', 'NA (Skipped)'];

  function classifyStatus(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return 'none';
    if (/^(pass|passed|ok|done)\b/i.test(s)) return 'pass';
    if (/^(fail|failed)\b/i.test(s)) return 'fail';
    return 'other';
  }

  /**
   * Status values in display order (pass, fail, others), each with a class
   * and keyboard shortcuts: P / F / N for the first of each class, 1..9 for all.
   */
  function statusOptions(values) {
    var list = [];
    var seen = {};
    (values && values.length ? values : DEFAULT_STATUSES).forEach(function (v) {
      var s = String(v).trim();
      if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = true; list.push(s); }
    });
    var rank = { pass: 0, fail: 1, other: 2 };
    list = list
      .map(function (v, i) { return { value: v, cls: classifyStatus(v), i: i }; })
      .sort(function (a, b) { return rank[a.cls] - rank[b.cls] || a.i - b.i; });
    var letter = { pass: 'p', fail: 'f', other: 'n' };
    var used = {};
    return list.map(function (o, i) {
      var key = null;
      if (!used[o.cls]) { used[o.cls] = true; key = letter[o.cls]; }
      return { value: o.value, cls: o.cls, key: key, num: i < 9 ? String(i + 1) : null };
    });
  }

  // ---------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------

  /** Small, stable fingerprint of a scenario's text (whitespace and case ignored). */
  function hash(s) {
    var str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  /** Exact fingerprint (nothing normalised), used to notice any change to a tab. */
  function hashRaw(s) {
    var str = String(s == null ? '' : s);
    var h1 = 5381;
    var h2 = 52711;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + ch) | 0;
      h2 = ((h2 << 5) + h2 ^ ch) | 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + str.length.toString(36);
  }

  function cell(row, idx) {
    if (idx == null || idx < 0) return '';
    var v = row[idx];
    return v == null ? '' : String(v);
  }

  /**
   * Build case objects from data rows (everything below the header row).
   * opts: { firstRow (sheet row number of rows[0]), headers, fillDown }
   */
  function buildCases(rows, fields, cycles, opts) {
    opts = opts || {};
    var firstRow = opts.firstRow || 2;
    var headers = opts.headers || [];
    var extras = opts.extras || [];
    var fillDown = opts.fillDown !== false;
    var lastFeature = '';
    var lastSub = '';
    var cases = [];
    var seenKeys = {};
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || [];
      var id = cell(row, fields.id).trim();
      var scenario = cell(row, fields.scenario).trim();
      if (!id && !scenario) continue;
      var feature = cell(row, fields.feature).trim();
      var sub = cell(row, fields.subFeature).trim();
      if (feature) { lastFeature = feature; if (!sub) lastSub = ''; }
      if (sub) lastSub = sub;
      var key = id || ('#' + hash(scenario));
      if (seenKeys[key]) key = key + '@' + (firstRow + r);
      seenKeys[key] = true;
      var c = {
        key: key,
        id: id,
        row: firstRow + r,
        scenario: scenario,
        sh: hash(scenario),
        feature: feature,
        subFeature: sub,
        group1: fillDown ? (feature || lastFeature) : feature,
        group2: fillDown ? (sub || lastSub) : sub,
        testType: cell(row, fields.testType).trim(),
        testData: cell(row, fields.testData),
        preCondition: cell(row, fields.preCondition),
        expected: cell(row, fields.expected),
        linkedIssue: cell(row, fields.linkedIssue).trim(),
        automatedBy: cell(row, fields.automatedBy).trim(),
        release: cell(row, fields.release).trim(),
        testedBy: cell(row, fields.testedBy).trim(),
        testedOn: cell(row, fields.testedOn).trim(),
        statuses: cycles.map(function (cy) { return cell(row, cy.status).trim(); }),
        comments: cycles.map(function (cy) { return cell(row, cy.comment); }),
        extras: []
      };
      extras.forEach(function (i) {
        var v = cell(row, i);
        if (v.trim()) c.extras.push({ label: String(headers[i] || ''), value: v });
      });
      cases.push(c);
    }
    return cases;
  }

  /** Split an expected-result cell into bullet strings. */
  function parseExpected(text) {
    return String(text == null ? '' : text)
      .split(/\r?\n|\s(?=\u2022\s)/)
      .map(function (s) { return s.replace(/^\s*(?:\u2022|[-*]|\d+[.)])\s*/, '').trim(); })
      .filter(function (s) { return s; });
  }

  /** Bullets back into one cell, house style: "\u2022 " per line. */
  function formatExpected(list) {
    if (!Array.isArray(list)) list = parseExpected(list);
    return list
      .map(function (s) { return String(s).replace(/^\s*(?:\u2022|[-*])\s*/, '').trim(); })
      .filter(function (s) { return s; })
      .map(function (s) { return '\u2022 ' + s; })
      .join('\n');
  }

  /**
   * Make a string safe to write into a cell: a leading = + - @ would be read
   * by Sheets as a formula, so it is written as text with a leading apostrophe.
   */
  function cellSafe(v) {
    var s = v == null ? '' : String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }

  // ---------------------------------------------------------------------------
  // IDs
  // ---------------------------------------------------------------------------

  /** Next n IDs following the sheet's own pattern (CMS/182 -> CMS/183, TC-009 -> TC-010). */
  function nextIds(ids, n) {
    n = n || 1;
    var parsed = [];
    (ids || []).forEach(function (raw) {
      var s = String(raw == null ? '' : raw).trim();
      var m = s.match(/^(.*?)(\d+)\s*$/);
      if (m) parsed.push({ prefix: m[1], num: parseInt(m[2], 10), width: m[2].length });
    });
    if (!parsed.length) {
      var out0 = [];
      for (var k = 1; k <= n; k++) out0.push('TC-' + pad(k, 3));
      return out0;
    }
    var prefix = parsed[parsed.length - 1].prefix;
    var max = -1;
    var width = 1;
    parsed.forEach(function (p) {
      if (p.prefix === prefix && p.num >= max) { max = p.num; width = p.width; }
    });
    var out = [];
    for (var i = 1; i <= n; i++) out.push(prefix + pad(max + i, width));
    return out;
  }

  function pad(num, width) {
    var s = String(num);
    while (s.length < width) s = '0' + s;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Automation
  // ---------------------------------------------------------------------------

  /** Spec names mentioned in free text: "inbox-search.spec (by number)" -> ["inbox-search"]. */
  function extractSpecRefs(text) {
    var out = [];
    var re = /([A-Za-z0-9_][A-Za-z0-9_.\-]*?)\.spec(?:\.[cm]?[tj]s)?(?![A-Za-z0-9_])/g;
    var m;
    var s = String(text == null ? '' : text);
    while ((m = re.exec(s))) {
      var name = m[1].toLowerCase();
      if (out.indexOf(name) < 0) out.push(name);
    }
    return out;
  }

  /** Index of automation results by spec name: {spec: {pass, fail, other, total}}. */
  function automationIndex(rows, specCol, statusCol) {
    var idx = {};
    if (specCol < 0 || statusCol < 0) return idx;
    (rows || []).forEach(function (row) {
      var refs = extractSpecRefs(cell(row, specCol));
      if (!refs.length) {
        var bare = cell(row, specCol).trim().toLowerCase();
        if (bare) refs = [bare];
      }
      var cls = classifyStatus(cell(row, statusCol));
      if (cls === 'none') return;
      refs.forEach(function (r) {
        var e = idx[r] || (idx[r] = { pass: 0, fail: 0, other: 0, total: 0 });
        e[cls] += 1;
        e.total += 1;
      });
    });
    return idx;
  }

  /** Badge for one manual case: state pass | fail | skip | partial | unknown, or null. */
  function automationBadge(c, index) {
    var text = [c.automatedBy].concat(c.comments || []).join(' ');
    var refs = extractSpecRefs(text);
    if (c.automatedBy && !refs.length) {
      c.automatedBy.split(/[,;\n]+/).forEach(function (s) {
        var t = s.trim().toLowerCase();
        if (t && refs.indexOf(t) < 0) refs.push(t);
      });
    }
    if (!refs.length) return null;
    var agg = { pass: 0, fail: 0, other: 0, total: 0 };
    var found = [];
    refs.forEach(function (r) {
      var e = index && index[r];
      if (!e) return;
      found.push(r);
      agg.pass += e.pass; agg.fail += e.fail; agg.other += e.other; agg.total += e.total;
    });
    var state;
    if (!found.length) state = 'unknown';
    else if (agg.fail > 0) state = 'fail';
    else if (agg.pass > 0 && agg.other === 0) state = 'pass';
    else if (agg.pass === 0) state = 'skip';
    else state = 'partial';
    return { state: state, refs: refs, found: found, counts: agg };
  }

  // ---------------------------------------------------------------------------
  // Risk order and paths
  // ---------------------------------------------------------------------------

  var TIERS = [
    { id: 0, key: 'new', label: 'New in release' },
    { id: 1, key: 'failedLast', label: 'Failed last cycle' },
    { id: 2, key: 'manual', label: 'Manual only' },
    { id: 3, key: 'autoPass', label: 'Automation passing' }
  ];

  function normRelease(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/^v(?=\d)/, '');
  }

  /** Risk tier of a case: 0 new in release, 1 failed last cycle, 2 manual, 3 automation passing. */
  function riskTier(c, ctx) {
    ctx = ctx || {};
    if (ctx.release && c.release && normRelease(c.release) === normRelease(ctx.release)) return 0;
    if (ctx.prevIdx != null && ctx.prevIdx >= 0 && classifyStatus(c.statuses[ctx.prevIdx]) === 'fail') return 1;
    if (!c.auto || c.auto.state !== 'pass') return 2;
    return 3;
  }

  /** Paths built without Claude: Feature, then Sub feature, in sheet order. */
  function autoPaths(cases) {
    var order = [];
    var map = {};
    cases.forEach(function (c) {
      var name = c.group1 && c.group2 ? (c.group1 + ' \u00b7 ' + c.group2) : (c.group1 || c.group2 || 'Ungrouped');
      var k = normLabel(name);
      if (!map[k]) { map[k] = { id: 'auto-' + order.length, name: name, persona: '', setup: '', steps: [{ label: '', cases: [] }], source: 'auto' }; order.push(map[k]); }
      map[k].steps[0].cases.push(c.key);
    });
    return order;
  }

  /**
   * Apply a saved Claude path plan. Case IDs that no longer exist are reported;
   * cases the plan left out go into a final "Not in the plan" path.
   */
  function applyPathPlan(cases, plan) {
    var byId = {};
    cases.forEach(function (c) { byId[normLabel(c.id || c.key)] = c.key; });
    var placed = {};
    var unknown = [];
    var paths = [];
    ((plan && plan.paths) || []).forEach(function (p, i) {
      var steps = [];
      (p.steps || []).forEach(function (s) {
        var keys = [];
        (s.cases || []).forEach(function (id) {
          var key = byId[normLabel(id)];
          if (!key) { if (unknown.indexOf(id) < 0) unknown.push(id); return; }
          if (placed[key]) return;
          placed[key] = true;
          keys.push(key);
        });
        if (keys.length) steps.push({ label: s.label || '', cases: keys });
      });
      if (steps.length) paths.push({ id: 'plan-' + i, name: p.name || ('Path ' + (i + 1)), persona: p.persona || '', setup: p.setup || '', steps: steps, source: 'plan' });
    });
    var leftover = cases.filter(function (c) { return !placed[c.key]; }).map(function (c) { return c.key; });
    if (leftover.length) paths.push({ id: 'plan-rest', name: 'Not in the plan', persona: '', setup: '', steps: [{ label: '', cases: leftover }], source: 'plan' });
    return { paths: paths, unknown: unknown, leftover: leftover.length };
  }

  // ---------------------------------------------------------------------------
  // Similarity (duplicate hints)
  // ---------------------------------------------------------------------------

  var STOP = ('verify if that whether the a an of in on for and or to is are be able user users ' +
    'shall should when with by from it its as at this then').split(' ');

  function tokens(s) {
    var out = {};
    normalizeHeader(s).split(' ').forEach(function (t) {
      if (t && STOP.indexOf(t) < 0) out[t.replace(/s$/, '')] = true;
    });
    return out;
  }

  function similarity(a, b) {
    var ta = tokens(a);
    var tb = tokens(b);
    var inter = 0;
    var union = 0;
    var k;
    for (k in ta) { union++; if (tb[k]) inter++; }
    for (k in tb) { if (!ta[k]) union++; }
    return union ? inter / union : 0;
  }

  function duplicatesFor(scenario, cases, threshold) {
    threshold = threshold == null ? 0.5 : threshold;
    return cases
      .map(function (c) { return { key: c.key, id: c.id, scenario: c.scenario, score: similarity(scenario, c.scenario) }; })
      .filter(function (d) { return d.score >= threshold; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 3);
  }

  // ---------------------------------------------------------------------------
  // Pasted Claude replies (always treated as data)
  // ---------------------------------------------------------------------------

  var LIMITS = { short: 160, scenario: 400, long: 3000, bullet: 800, bullets: 15, items: 60, paths: 100, steps: 300, stepCases: 300 };

  function cleanText(v, max) {
    if (v == null) return '';
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
    var s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  /** Pull the JSON object out of a pasted reply (fenced block or bare object). */
  function extractJson(text) {
    var s = String(text == null ? '' : text);
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    var body = fence ? fence[1] : s;
    var a = body.indexOf('{');
    var b = body.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('No JSON object found. Paste Claude\'s whole reply, including the ```json block.');
    try {
      return JSON.parse(body.slice(a, b + 1));
    } catch (e) {
      throw new Error('The pasted JSON could not be read (' + e.message + '). Ask Claude to reply with one valid JSON block.');
    }
  }

  function cleanScenario(it) {
    var expected = it.expected;
    if (typeof expected === 'string') expected = parseExpected(expected);
    if (!Array.isArray(expected)) expected = [];
    expected = expected.map(function (b) { return cleanText(b, LIMITS.bullet).replace(/^\s*(?:\u2022|[-*])\s*/, ''); })
      .filter(function (b) { return b; }).slice(0, LIMITS.bullets);
    return {
      scenario: cleanText(it.scenario, LIMITS.scenario),
      feature: cleanText(it.feature, LIMITS.short),
      subFeature: cleanText(it.subFeature, LIMITS.short),
      testType: cleanText(it.testType, LIMITS.short),
      testData: cleanText(it.testData, LIMITS.long),
      preCondition: cleanText(it.preCondition, LIMITS.long),
      expected: expected,
      issue: cleanText(it.issue, LIMITS.short),
      release: cleanText(it.release, 40),
      fromFinding: cleanText(it.fromFinding, 40),
      edgeCase: it.edgeCase === true
    };
  }

  var EDITABLE = ['scenario', 'feature', 'subFeature', 'testType', 'testData', 'preCondition', 'expected', 'linkedIssue', 'release', 'automatedBy'];

  /**
   * Validate a parsed reply. ctx: { caseIds: [ids], findingIds: [ids] }.
   * Returns { type, items|paths, covered, errors } with every string cleaned.
   */
  function validateReply(obj, ctx) {
    ctx = ctx || {};
    var errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('The reply must be one JSON object.');
    var type = String(obj.type || '').toLowerCase();
    if (!type) {
      if (Array.isArray(obj.paths)) type = 'paths';
      else if (Array.isArray(obj.items)) type = 'scenarios';
    }
    var caseIds = {};
    (ctx.caseIds || []).forEach(function (id) { caseIds[normLabel(id)] = id; });

    if (type === 'scenarios') {
      var items = Array.isArray(obj.items) ? obj.items : [];
      if (items.length > LIMITS.items) errors.push('Only the first ' + LIMITS.items + ' items were read.');
      var out = [];
      items.slice(0, LIMITS.items).forEach(function (it, i) {
        if (!it || typeof it !== 'object') { errors.push('Item ' + (i + 1) + ' is not an object; skipped.'); return; }
        var c = cleanScenario(it);
        if (!c.scenario) { errors.push('Item ' + (i + 1) + ' has no scenario; skipped.'); return; }
        out.push(c);
      });
      var covered = [];
      (Array.isArray(obj.covered) ? obj.covered : []).slice(0, LIMITS.items).forEach(function (cv) {
        if (!cv || typeof cv !== 'object') return;
        var id = cleanText(cv.caseId, LIMITS.short);
        covered.push({ fromFinding: cleanText(cv.fromFinding, 40), caseId: caseIds[normLabel(id)] || id, known: !!caseIds[normLabel(id)], note: cleanText(cv.note, LIMITS.long) });
      });
      if (!out.length && !covered.length) throw new Error('The reply has no usable scenarios.');
      return { type: 'scenarios', items: out, covered: covered, errors: errors };
    }

    if (type === 'edits') {
      var edits = [];
      (Array.isArray(obj.items) ? obj.items : []).slice(0, LIMITS.items).forEach(function (it, i) {
        if (!it || typeof it !== 'object') return;
        var id = cleanText(it.caseId, LIMITS.short);
        if (!caseIds[normLabel(id)]) { errors.push('Edit ' + (i + 1) + ': case "' + id + '" is not in this tab; skipped.'); return; }
        var fields = {};
        var src = it.fields && typeof it.fields === 'object' ? it.fields : {};
        EDITABLE.forEach(function (f) {
          if (src[f] == null) return;
          if (f === 'expected') fields.expected = cleanScenario({ expected: src.expected }).expected;
          else fields[f] = cleanText(src[f], f === 'scenario' ? LIMITS.scenario : LIMITS.long);
        });
        if (!Object.keys(fields).length) { errors.push('Edit ' + (i + 1) + ' changes nothing; skipped.'); return; }
        edits.push({ caseId: caseIds[normLabel(id)], fields: fields, reason: cleanText(it.reason, LIMITS.long) });
      });
      if (!edits.length) throw new Error('The reply has no usable edits.');
      return { type: 'edits', items: edits, errors: errors };
    }

    if (type === 'paths') {
      var paths = [];
      var unknown = [];
      (Array.isArray(obj.paths) ? obj.paths : []).slice(0, LIMITS.paths).forEach(function (p, i) {
        if (!p || typeof p !== 'object') return;
        var steps = [];
        (Array.isArray(p.steps) ? p.steps : []).slice(0, LIMITS.steps).forEach(function (s) {
          if (!s || typeof s !== 'object') return;
          var ids = (Array.isArray(s.cases) ? s.cases : []).slice(0, LIMITS.stepCases).map(function (x) { return cleanText(x, LIMITS.short); }).filter(function (x) { return x; });
          ids = ids.map(function (x) {
            var known = caseIds[normLabel(x)];
            if (!known && unknown.indexOf(x) < 0) unknown.push(x);
            return known || x;
          });
          if (ids.length) steps.push({ label: cleanText(s.label, LIMITS.scenario), cases: ids });
        });
        if (steps.length) paths.push({ name: cleanText(p.name, LIMITS.short) || ('Path ' + (i + 1)), persona: cleanText(p.persona, LIMITS.short), setup: cleanText(p.setup, LIMITS.long), steps: steps });
      });
      if (!paths.length) throw new Error('The reply has no usable paths.');
      if (unknown.length) errors.push(unknown.length + ' case ID(s) in the plan are not in this tab: ' + unknown.slice(0, 8).join(', ') + (unknown.length > 8 ? ', ...' : ''));
      return { type: 'paths', paths: paths, unknown: unknown, errors: errors };
    }

    throw new Error('Unknown reply type "' + type + '". Expected "scenarios", "edits" or "paths".');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  function emptyCounts() { return { pass: 0, fail: 0, other: 0, none: 0, total: 0 }; }

  function rates(c) {
    var executed = c.pass + c.fail + c.other;
    return {
      executed: executed,
      executedPct: c.total ? Math.round((executed / c.total) * 100) : 0,
      passRate: (c.pass + c.fail) ? Math.round((c.pass / (c.pass + c.fail)) * 100) : null
    };
  }

  /**
   * Figures for the management summary.
   * ctx: { cycleIdx, prevIdx, groupBy: 'group1'|'group2' }
   */
  function summarize(cases, ctx) {
    ctx = ctx || {};
    var ci = ctx.cycleIdx;
    var pi = ctx.prevIdx;
    var groupBy = ctx.groupBy || 'group1';
    var total = emptyCounts();
    var groups = [];
    var gmap = {};
    var failures = [];
    var newlyFailing = [];
    var fixed = [];
    var stillFailing = 0;
    var auto = { linked: 0, pass: 0, fail: 0, other: 0 };
    var testers = {};
    cases.forEach(function (c) {
      var cls = classifyStatus(c.statuses[ci]);
      total[cls] += 1; total.total += 1;
      var gname = c[groupBy] || c.group1 || 'Ungrouped';
      var g = gmap[gname];
      if (!g) { g = gmap[gname] = { name: gname, counts: emptyCounts() }; groups.push(g); }
      g.counts[cls] += 1; g.counts.total += 1;
      if (cls === 'fail') {
        failures.push({ key: c.key, id: c.id, scenario: c.scenario, comment: c.comments[ci] || '', issue: c.linkedIssue || '', group: gname });
      }
      if (pi != null && pi >= 0) {
        var prev = classifyStatus(c.statuses[pi]);
        if (cls === 'fail' && prev === 'pass') newlyFailing.push({ key: c.key, id: c.id, scenario: c.scenario });
        else if (cls === 'pass' && prev === 'fail') fixed.push({ key: c.key, id: c.id, scenario: c.scenario });
        else if (cls === 'fail' && prev === 'fail') stillFailing++;
      }
      if (c.auto && c.auto.state !== 'unknown') {
        auto.linked++;
        if (c.auto.state === 'pass') auto.pass++;
        else if (c.auto.state === 'fail') auto.fail++;
        else auto.other++;
      }
      if (c.testedBy && cls !== 'none') testers[c.testedBy] = (testers[c.testedBy] || 0) + 1;
    });
    groups.forEach(function (g) { var r = rates(g.counts); g.executedPct = r.executedPct; g.passRate = r.passRate; });
    var r = rates(total);
    return {
      counts: total,
      executed: r.executed,
      executedPct: r.executedPct,
      passRate: r.passRate,
      groups: groups,
      failures: failures,
      comparison: (pi != null && pi >= 0) ? { newlyFailing: newlyFailing, fixed: fixed, stillFailing: stillFailing } : null,
      automation: auto,
      testers: Object.keys(testers).map(function (k) { return { name: k, count: testers[k] }; }).sort(function (a, b) { return b.count - a.count; })
    };
  }

  /** "#123" -> base + "123"; full URLs are kept; anything else returns null. */
  function issueUrl(issue, base) {
    var s = String(issue == null ? '' : issue).trim();
    if (/^https?:\/\//i.test(s)) return s;
    var m = s.match(/#?(\d{1,7})\b/);
    if (!m || !base) return null;
    return String(base).replace(/\/?$/, '/') + m[1];
  }

  return {
    FIELDS: FIELDS,
    FIELD_LABELS: FIELD_LABELS,
    TIERS: TIERS,
    DEFAULT_STATUSES: DEFAULT_STATUSES,
    EDITABLE: EDITABLE,
    normalizeHeader: normalizeHeader,
    detectCycles: detectCycles,
    detectColumns: detectColumns,
    detectSpecColumn: detectSpecColumn,
    detectHeaderRow: detectHeaderRow,
    resolveColumns: resolveColumns,
    columnsByHeader: columnsByHeader,
    classifyStatus: classifyStatus,
    statusOptions: statusOptions,
    hash: hash,
    hashRaw: hashRaw,
    buildCases: buildCases,
    parseExpected: parseExpected,
    formatExpected: formatExpected,
    cellSafe: cellSafe,
    nextIds: nextIds,
    extractSpecRefs: extractSpecRefs,
    automationIndex: automationIndex,
    automationBadge: automationBadge,
    normRelease: normRelease,
    riskTier: riskTier,
    autoPaths: autoPaths,
    applyPathPlan: applyPathPlan,
    similarity: similarity,
    duplicatesFor: duplicatesFor,
    cleanText: cleanText,
    extractJson: extractJson,
    validateReply: validateReply,
    summarize: summarize,
    issueUrl: issueUrl
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TRCore;
