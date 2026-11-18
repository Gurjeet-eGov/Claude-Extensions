/* Test Run console: the page. Talks only to the local Test Run server (TR.api / TR.http). */
(function () {
  'use strict';

  var esc = TR.esc;
  var api = TR.api;
  var PARAMS = {};
  new URLSearchParams(location.search).forEach(function (v, k) { PARAMS[k] = v; });
  var VIEWS = [
    { id: 'run', label: 'Run' },
    { id: 'plan', label: 'Plan' },
    { id: 'findings', label: 'Findings' },
    { id: 'inbox', label: 'Inbox' },
    { id: 'summary', label: 'Summary' },
    { id: 'setup', label: 'Setup' }
  ];

  var S = {
    app: null,
    boot: null,
    cfg: null,
    excelOpen: false,
    claudeBusy: null,
    claudeStarted: 0,
    usage: {},
    claudeError: {},
    tab: null,
    model: null,
    byKey: {},
    view: 'run',
    loading: true,
    filters: { show: 'todo', tiers: [], type: '', search: '' },
    keep: {},
    collapsed: {},
    selected: null,
    scrollToSel: false,
    pending: {},
    undo: [],
    drafts: {},
    form: {},
    readOnly: false,
    findings: [],
    findingSel: {},
    inbox: [],
    manual: [],
    summary: null,
    setup: null,
    writes: 0,
    selfDirty: false
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function toast(msg, kind) { TR.toast(msg, kind); }
  function cur() { return S.model && S.model.cycleIdx >= 0 ? S.model.cycles[S.model.cycleIdx] : null; }
  function cycleLabel() { var c = cur(); return c ? c.label : ''; }
  function clsOf(c) { return TR.classify(S.model && S.model.cycleIdx >= 0 ? c.statuses[S.model.cycleIdx] : ''); }
  function claudeOn() { return !!(S.app && S.app.settings.claude.enabled); }
  function claudeReady() { return claudeOn() && !!S.app.claude.available; }
  function book() { return TR.state.book; }
  function hasField(f) { return !!(S.model && S.model.fields && S.model.fields[f] >= 0); }
  function roleOf(t) { return (t.saved && t.saved.role) || t.detected.role; }
  function runTabs() { return S.boot ? S.boot.tabs.filter(function (t) { return roleOf(t) === 'manual'; }) : []; }
  function opt(value, label, selected) { return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function pill(cls, text, title) { return '<span class="pill ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  function val(path, fallback) { return Object.prototype.hasOwnProperty.call(S.form, path) ? S.form[path] : (fallback == null ? '' : fallback); }

  function parseExpected(text) {
    return String(text == null ? '' : text)
      .split(/\r?\n|\s(?=•\s)/)
      .map(function (s) { return s.replace(/^\s*(?:•|[-*]|\d+[.)])\s*/, '').trim(); })
      .filter(function (s) { return s; });
  }

  function distinct(field) {
    var out = [];
    if (!S.model) return out;
    S.model.cases.forEach(function (c) { var v = String(c[field] || '').trim(); if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }

  var writeChain = Promise.resolve();
  /** Writes run one after another, so each one's compare-and-set sees the previous result. */
  function queueWrite(fn) {
    S.writes++;
    var p = writeChain.then(fn, fn);
    writeChain = p.then(function () {}, function () {});
    return p.then(function (r) {
      S.writes--;
      if (r && r.ok) S.selfDirty = true;
      return r;
    });
  }

  function writeError(r) {
    if (!r) return;
    if (r.code === 'READONLY') {
      S.readOnly = true;
      toast('This workbook file is read-only on this computer, so nothing can be saved.', 'bad');
    } else if (r.code === 'MOVED' || r.code === 'GONE' || r.code === 'NO_CYCLE' || r.code === 'NO_TAB') {
      toast(r.error, 'bad');
      loadTab(cycleLabel(), true);
      loadSide();
    } else if (r.code === 'BUSY') {
      toast('Another save is in progress. Try again in a moment.', 'bad');
    } else {
      toast(r.error || 'Something went wrong.', 'bad');
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  function init() {
    render();
    TR.http('GET', '/api/app').then(function (a) {
      if (!a.ok) { S.loading = false; S.fatal = a.error; render(); return; }
      S.app = a;
      var names = a.books.map(function (b) { return b.name; });
      var want = names.indexOf(PARAMS.book) >= 0 ? PARAMS.book : (names.indexOf(a.last.book) >= 0 ? a.last.book : names[0]);
      TR.state.book = want || null;
      if (!want) { S.loading = false; render(); return; }
      boot(PARAMS.tab || TR.store.get('tab:' + want) || a.last.tab, PARAMS.cycle || '');
    });
    setInterval(checkVersion, 10000);
    window.addEventListener('focus', checkVersion);
  }

  /** Read the open workbook's tabs, then load one. */
  function boot(wantTab, cycle) {
    S.boot = null;
    S.model = null;
    S.loading = true;
    render();
    return api('api_bootstrap').then(function (b) {
      if (!b.ok) { S.loading = false; S.fatal = b.error; render(); return; }
      S.fatal = null;
      S.boot = b;
      S.cfg = b.config;
      S.excelOpen = !!b.excelOpen;
      var tabs = runTabs();
      S.tab = tabs.some(function (t) { return t.name === wantTab; }) ? wantTab : (tabs[0] ? tabs[0].name : null);
      if (!S.cfg) S.view = 'setup';
      else if (PARAMS.view && VIEWS.some(function (v) { return v.id === PARAMS.view; })) S.view = PARAMS.view;
      loadSide();
      if (S.tab) loadTab(cycle || ''); else { S.loading = false; render(); }
    });
  }

  function refreshApp() {
    return TR.http('GET', '/api/app').then(function (a) { if (a.ok) { S.app = a; render(); } return a; });
  }

  function loadTab(cycle, quiet) {
    if (!S.tab) return Promise.resolve();
    if (!quiet) { S.loading = true; render(); }
    return api('api_loadTab', S.tab, cycle || '').then(function (m) {
      S.loading = false;
      if (!m.ok) { toast(m.error, 'bad'); render(); return; }
      S.model = m;
      S.byKey = {};
      m.cases.forEach(function (c) { S.byKey[c.key] = c; });
      if (S.selected && !S.byKey[S.selected]) S.selected = null;
      S.summary = null;
      S.excelOpen = !!m.excelOpen;
      if (m.reloaded) toast('The workbook changed on disk, so it was reloaded.');
      TR.store.set('tab:' + book(), S.tab);
      render();
    });
  }

  /** Findings and inbox live beside the workbook; redraw only when they changed. */
  var sideSeen = { findings: null, inbox: null };
  function loadSide() {
    var first = sideSeen.findings === null;
    api('api_listFindings').then(function (r) {
      if (!r.ok) return;
      var sig = JSON.stringify(r.findings);
      if (sig === sideSeen.findings) return;
      var known = {};
      S.findings.forEach(function (f) { known[f.key] = true; });
      var fresh = first ? [] : r.findings.filter(function (f) { return !known[f.key] && f.source === 'bug-reporter'; });
      sideSeen.findings = sig;
      S.findings = r.findings;
      fresh.forEach(function (f) { toast('New finding from Bug Reporter: ' + f.key + ' ' + f.text.slice(0, 60)); });
      render();
    });
    api('api_listInbox').then(function (r) {
      if (!r.ok) return;
      var sig = JSON.stringify(r.inbox);
      if (sig === sideSeen.inbox) return;
      sideSeen.inbox = sig;
      S.inbox = r.inbox;
      render();
    });
  }

  function checkVersion() {
    if (!S.model || S.writes > 0 || document.hidden) return;
    var ae = document.activeElement;
    if (ae && ae.matches && ae.matches('input, textarea') && ae.value) return;
    loadSide();
    api('api_version', S.tab).then(function (r) {
      if (!r.ok || !S.model || r.version === S.model.version) return;
      var mine = S.selfDirty;
      S.selfDirty = false;
      loadTab(cycleLabel(), true).then(function () { if (!mine) toast('Updated with the latest changes in the workbook.'); });
      loadSide();
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    var app = $('app');
    if (!app) return;
    var ae = document.activeElement;
    var focus = ae && ae.id ? { id: ae.id, start: ae.selectionStart, end: ae.selectionEnd } : null;
    app.innerHTML = topbar() + '<main id="main">' + body() + '</main>';
    if (focus) {
      var el = $(focus.id);
      if (el) {
        el.focus();
        try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch (e) { /* not a text field */ }
      }
    }
    if (S.scrollToSel) {
      S.scrollToSel = false;
      var sel = document.querySelector('.case.sel');
      if (sel) { sel.scrollIntoView({ block: 'nearest' }); if (!focus) sel.focus({ preventScroll: true }); }
    }
  }

  function topbar() {
    var b = S.boot;
    var m = S.model;
    var h = '<header class="topbar"><div class="topbar-row"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Test Run</span></div><span class="grow"></span><div class="pickers">';
    if (S.app) {
      h += '<label class="sr" for="bookPick">Workbook</label><select id="bookPick" data-change="book" title="Workbook (in the sheets folder)">' +
        (S.app.books.length ? S.app.books.map(function (x) { return opt(x.name, x.name.replace(/\.xlsx$/i, ''), x.name === book()); }).join('') : '<option value="">No workbooks yet</option>') + '</select>' +
        '<button class="ghost" data-action="import" title="Add an .xlsx workbook to the sheets folder">Import</button>' +
        (book() ? '<a class="btn ghost" href="/api/books/download?name=' + encodeURIComponent(book()) + '" title="Download this workbook, e.g. to upload it to Google Sheets">Download</a>' : '');
    }
    var tabs = runTabs();
    if (tabs.length) {
      h += '<label class="sr" for="tabPick">Tab</label><select id="tabPick" data-change="tab" title="Test case tab">' +
        tabs.map(function (t) { return opt(t.name, t.name, t.name === S.tab); }).join('') + '</select>';
    }
    if (m && m.cycles.length) {
      h += '<label class="sr" for="cyclePick">Cycle</label><select id="cyclePick" data-change="cycle" title="Test cycle (status column)">' +
        m.cycles.map(function (c, i) { return opt(i, c.label ? 'Cycle ' + c.label : 'Status', i === m.cycleIdx); }).join('') + '</select>';
    }
    h += '</div>' + (S.app && S.app.settings.user ? '<span class="who" title="Results are marked as tested by this name (change it in Setup)">' + esc(S.app.settings.user) + '</span>' : '') + '</div>';
    if (m && m.cases.length && m.cycles.length) {
      var c = TR.counts(m.cases.map(clsOf));
      var done = Math.round(((c.total - c.none) / (c.total || 1)) * 100);
      h += '<div class="topbar-row progress-wrap">' + TR.bar(c) + TR.legend(c) + '<span class="small muted"><b>' + done + '%</b> done</span></div>';
    }
    h += '<nav class="nav" aria-label="Screens">' + VIEWS.map(function (v) {
      var n = 0;
      if (v.id === 'inbox') n = openInboxCount();
      if (v.id === 'findings') n = S.findings.filter(function (f) { return f.state === 'open'; }).length;
      return '<button data-action="view" data-view="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '>' + v.label + (n ? ' <span class="count">' + n + '</span>' : '') + '</button>';
    }).join('') + '</nav></header>';
    return h;
  }

  function openInboxCount() {
    var n = S.manual.length;
    S.inbox.forEach(function (e) {
      if (e.type === 'paths') { n += 1; return; }
      (e.items || []).forEach(function (i) { if (i.state === 'open') n++; });
      (e.covered || []).forEach(function (i) { if (i.state === 'open') n++; });
    });
    return n;
  }

  function body() {
    if (S.fatal) return '<div class="banner bad"><div><b>The console could not start.</b><div class="small">' + esc(S.fatal) + '</div></div></div>';
    if (S.app && !S.app.books.length) {
      return '<div class="empty card"><h3>No workbooks yet</h3><p>Put your test case <b>.xlsx</b> files in<br><span class="mono">' + esc(S.app.sheetsDir) + '</span><br>or import one here. They stay on this computer and are never committed to git.</p><p style="margin-top:14px"><button class="primary" data-action="import">Import a workbook</button></p></div>';
    }
    if (!S.boot) return '<div class="loading">Loading the workbook…</div>';
    var banners = '';
    if (S.readOnly) banners += '<div class="banner warn"><b>View only.</b><span class="muted">This workbook file is read-only on this computer, so results cannot be saved.</span></div>';
    if (S.excelOpen) banners += '<div class="banner warn"><b>This workbook is open in Excel.</b><span class="muted">Close it there while you test: saving from Excel would overwrite results marked here.</span></div>';
    if (S.view === 'setup') return banners + viewSetup();
    if (!S.tab) return banners + '<div class="empty card"><h3>No test case tab found</h3><p>Open Setup and mark which tabs hold test cases.</p><p style="margin-top:12px"><button class="primary" data-action="view" data-view="setup">Open Setup</button></p></div>';
    if (S.loading && !S.model) return '<div class="loading">Loading ' + esc(S.tab) + '…</div>';
    if (!S.model) return '';
    var m = S.model;
    if (!m.configured) banners += '<div class="banner"><span>Columns for this tab were detected automatically.</span><span class="grow"></span><button data-action="view" data-view="setup">Check Setup</button></div>';
    if (m.missing && m.missing.length) banners += '<div class="banner bad"><span>These columns were renamed or removed in the workbook: <b>' + esc(m.missing.map(function (f) { return S.boot.labels[f]; }).join(', ')) + '</b>.</span><span class="grow"></span><button data-action="view" data-view="setup">Fix in Setup</button></div>';
    switch (S.view) {
      case 'plan': return banners + viewPlan();
      case 'findings': return banners + viewFindings();
      case 'inbox': return banners + viewInbox();
      case 'summary': return banners + viewSummary();
      default: return banners + viewRun();
    }
  }

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  function passes(c, ignoreTier) {
    var f = S.filters;
    if (S.keep[c.key]) return true;
    var k = clsOf(c);
    if (f.show === 'todo' && k !== 'none') return false;
    if (f.show === 'failed' && k !== 'fail') return false;
    if (!ignoreTier && f.tiers.length && f.tiers.indexOf(c.tier) < 0) return false;
    if (f.type && c.testType !== f.type) return false;
    var q = f.search.trim().toLowerCase();
    if (q && [c.id, c.scenario, c.group1, c.group2, c.testType, c.linkedIssue].join(' ').toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  function visiblePaths() {
    var m = S.model;
    var out = [];
    m.paths.forEach(function (p, idx) {
      var all = [];
      p.steps.forEach(function (s) { all = all.concat(s.cases); });
      var counts = TR.counts(all.map(function (k) { return clsOf(S.byKey[k]); }));
      var steps = p.steps.map(function (s) {
        return { label: s.label, keys: s.cases.filter(function (k) { return passes(S.byKey[k]); }) };
      }).filter(function (s) { return s.keys.length; });
      if (!steps.length) return;
      // Order by the riskiest case in the path, whatever its status, so paths
      // do not jump around while cases are being marked.
      var minTier = 9;
      all.forEach(function (k) { var c = S.byKey[k]; if (c.tier < minTier) minTier = c.tier; });
      out.push({ p: p, idx: idx, counts: counts, steps: steps, minTier: minTier });
    });
    if (m.plan.source === 'auto') out.sort(function (a, b) { return a.minTier - b.minTier || a.idx - b.idx; });
    return out;
  }

  function visibleOrder() {
    var keys = [];
    visiblePaths().forEach(function (vp) {
      if (S.collapsed[vp.p.id]) return;
      vp.steps.forEach(function (s) { keys = keys.concat(s.keys); });
    });
    return keys;
  }

  function viewRun() {
    var m = S.model;
    if (!m.cycles.length) {
      return '<div class="empty card"><h3>This tab has no status column yet</h3><p>Start a cycle to add a <i>Test Status</i> and <i>Comment</i> column pair.</p><p style="margin-top:12px"><button class="primary" data-action="view" data-view="plan">Start a cycle</button></p></div>';
    }
    var f = S.filters;
    var tierCounts = {};
    m.cases.forEach(function (c) { if (passes(c, true)) tierCounts[c.tier] = (tierCounts[c.tier] || 0) + 1; });
    var types = distinct('testType');
    var h = '<div class="toolbar">' +
      '<label class="sr" for="search">Search</label><input type="search" id="search" placeholder="Search ID, scenario, feature…  ( / )" value="' + esc(f.search) + '">' +
      '<div class="row" role="group" aria-label="Show">' +
      ['todo', 'failed', 'all'].map(function (s) {
        var label = { todo: 'To do', failed: 'Failed', all: 'All' }[s];
        return '<button class="chip" data-action="show" data-show="' + s + '" aria-pressed="' + (f.show === s) + '">' + label + '</button>';
      }).join('') + '</div>' +
      (types.length > 1 ? '<label class="sr" for="typePick">Test type</label><select id="typePick" data-change="type"><option value="">All types</option>' + types.map(function (t) { return opt(t, t, t === f.type); }).join('') + '</select>' : '') +
      '<span class="grow"></span>' +
      '<button class="ghost" data-action="collapse-all" title="Collapse all paths">Collapse</button><button class="ghost" data-action="expand-all" title="Expand all paths">Expand</button>' +
      '<button class="ghost" data-action="help" title="Keyboard shortcuts"><kbd>?</kbd></button></div>';
    h += '<div class="toolbar" role="group" aria-label="Risk filter"><span class="small muted">Focus:</span>' + S.boot.tiers.map(function (t) {
      var on = f.tiers.indexOf(t.id) >= 0;
      var label = t.id === 0 && m.release ? 'New in ' + m.release : t.label;
      return '<button class="chip" data-action="tier" data-tier="' + t.id + '" aria-pressed="' + on + '">' + esc(label) + ' <span class="n">' + (tierCounts[t.id] || 0) + '</span></button>';
    }).join('') + '</div>';

    var vps = visiblePaths();
    if (!vps.length) {
      var all = TR.counts(m.cases.map(clsOf));
      var msg = f.show === 'todo' && all.none === 0 ? '<h3>Everything in this cycle has a result 🎉</h3><p>Switch to <b>All</b> to review, or open the Summary.</p>' : '<h3>Nothing matches</h3><p>Clear the search or the focus filters.</p>';
      return h + '<div class="empty card">' + msg + '</div>';
    }
    vps.forEach(function (vp) {
      var p = vp.p;
      var left = vp.counts.none;
      var collapsed = !!S.collapsed[p.id];
      var meta = [p.persona, p.setup].filter(Boolean).join(' · ');
      h += '<section class="card path' + (collapsed ? ' collapsed' : '') + '">' +
        '<button class="path-head" data-action="toggle-path" data-path="' + esc(p.id) + '" aria-expanded="' + !collapsed + '">' +
        '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/></svg>' +
        '<span class="grow"><span class="path-title">' + esc(p.name) + '</span>' + (meta ? '<span class="path-meta"> · ' + esc(meta) + '</span>' : '') + '</span>' +
        TR.bar(vp.counts, true) +
        '<span class="path-left' + (left ? '' : ' done') + '">' + (left ? left + ' of ' + vp.counts.total + ' left' : '✓ done') + '</span></button>';
      if (!collapsed) {
        h += '<div class="path-body">';
        vp.steps.forEach(function (s) {
          if (s.label) h += '<div class="step">' + esc(s.label) + '</div>';
          s.keys.forEach(function (k) { h += caseRow(S.byKey[k]); });
        });
        h += '</div>';
      }
      h += '</section>';
    });
    return h;
  }

  function autoPill(a) {
    var map = { pass: ['pass', 'Auto ✓'], fail: ['fail', 'Auto ✗'], skip: ['other', 'Auto –'], partial: ['other', 'Auto ~'], unknown: ['none', 'Auto ?'] };
    var x = map[a.state] || map.unknown;
    var title = 'Automation: ' + a.refs.join(', ') + (a.counts && a.counts.total ? ' (' + a.counts.pass + ' pass, ' + a.counts.fail + ' fail, ' + a.counts.other + ' skipped)' : ' (no results found)');
    return pill(x[0], x[1], title);
  }

  function caseRow(c) {
    var k = clsOf(c);
    var sel = S.selected === c.key;
    var badges = [];
    if (c.tier === 0) badges.push(pill('accent', S.model.release ? 'New in ' + S.model.release : 'New'));
    if (c.tier === 1) badges.push(pill('fail', 'Failed last'));
    if (c.auto) badges.push(autoPill(c.auto));
    if (c.linkedIssue) badges.push(pill('outline', c.linkedIssue));
    return '<div class="case' + (sel ? ' sel' : '') + '" role="button" tabindex="0" data-action="select" data-key="' + esc(c.key) + '" aria-expanded="' + sel + '">' +
      TR.dot(k, S.pending[c.key]) + '<span class="sr">' + TR.CLS_LABEL[k] + '. </span>' +
      '<span class="cid">' + esc(c.id) + '</span>' +
      '<span class="title"' + (sel ? '' : ' title="' + esc(c.scenario) + '"') + '>' + esc(c.scenario) + '</span>' +
      '<span class="badges">' + badges.join('') + '</span></div>' + (sel ? detail(c) : '');
  }

  function field(label, html) {
    return '<div><div class="field-label">' + esc(label) + '</div><div class="field-value">' + html + '</div></div>';
  }

  function detail(c) {
    var m = S.model;
    var ci = m.cycleIdx;
    var now = c.statuses[ci] || '';
    var f = [];
    var where = [c.id, c.group1, c.group2 && c.group2 !== c.group1 ? c.group2 : '', c.testType].filter(Boolean).join(' · ');
    if (where) f.push('<div class="small muted">' + esc(where) + '</div>');
    if (c.preCondition) f.push(field('Pre condition', esc(c.preCondition)));
    if (c.testData) f.push(field('Test data', esc(c.testData)));
    var bl = parseExpected(c.expected);
    if (bl.length) f.push(field('Expected result', '<ul class="bullets">' + bl.map(function (b) { return '<li><span>' + esc(b) + '</span></li>'; }).join('') + '</ul>'));
    c.extras.forEach(function (x) { f.push(field(x.label, esc(x.value))); });
    if (c.auto) f.push(field('Automation', esc(c.auto.refs.join(', ')) + ' ' + autoPill(c.auto)));
    if (m.prevIdx >= 0 && c.statuses[m.prevIdx]) {
      var pk = TR.classify(c.statuses[m.prevIdx]);
      f.push(field('Last cycle (' + (m.cycles[m.prevIdx].label || 'previous') + ')', '<span class="sym-' + pk + '">' + TR.SYM[pk] + '</span> ' + esc(c.statuses[m.prevIdx]) + (c.comments[m.prevIdx] ? ' – ' + esc(c.comments[m.prevIdx]) : '')));
    }
    if (f.length <= 1) f.push('<p class="muted">The sheet has no more details for this case.</p>');

    var dis = S.readOnly ? ' disabled' : '';
    var btns = m.statusOptions.map(function (o) {
      var on = o.value === now;
      return '<button class="sbtn ' + o.cls + (on ? ' on' : '') + '" data-action="mark" data-value="' + esc(o.value) + '" aria-pressed="' + on + '"' + dis + '>' +
        TR.SYM[o.cls] + ' ' + esc(o.value) + (o.key ? ' <kbd>' + o.key.toUpperCase() + '</kbd>' : (o.num ? ' <kbd>' + o.num + '</kbd>' : '')) + '</button>';
    }).join('');
    var d = S.drafts[c.key] || {};
    var a = '<div class="status-btns" role="group" aria-label="Result">' + btns + '</div>';
    if (cur().hasComment) {
      a += '<div><label for="comment">Comment' + (TR.classify(now) === 'fail' ? ' (what went wrong)' : '') + '</label><textarea id="comment" data-comment rows="2" placeholder="Optional. Enter saves, Shift+Enter for a new line"' + dis + '>' + esc(d.comment != null ? d.comment : (c.comments[ci] || '')) + '</textarea></div>';
    }
    if (hasField('linkedIssue')) {
      a += '<div><label for="issue">Linked issue</label><input id="issue" data-issue placeholder="#123 or a link" value="' + esc(d.issue != null ? d.issue : c.linkedIssue) + '"' + dis + '></div>';
    }
    a += '<div class="row">' + (cur().hasComment || hasField('linkedIssue') ? '<button data-action="save-note"' + dis + '>Save note</button>' : '') +
      '<span class="grow"></span>' + (S.undo.length ? '<button class="ghost" data-action="undo" title="Undo last mark (U)">Undo</button>' : '') + '</div>';
    var who = [c.testedBy, c.testedOn].filter(Boolean).join(' · ');
    if (who) a += '<div class="meta-line">Last marked: ' + esc(who) + '</div>';
    a += '<div class="meta-line faint">Row ' + c.row + ' in the workbook</div>';
    return '<div class="detail"><div class="fields">' + f.join('') + '</div><div class="actions">' + a + '</div></div>';
  }

  function select(key, scroll) {
    S.selected = S.selected === key ? null : key;
    S.scrollToSel = !!scroll;
    render();
  }

  function move(delta) {
    var order = visibleOrder();
    if (!order.length) return;
    var i = order.indexOf(S.selected);
    var next = i < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(Math.max(i + delta, 0), order.length - 1);
    S.selected = order[next];
    S.scrollToSel = true;
    render();
  }

  function advance(fromKey) {
    var order = visibleOrder();
    var i = order.indexOf(fromKey);
    for (var n = 1; n < order.length; n++) {
      var k = order[(i + n + order.length) % order.length];
      if (k !== fromKey && clsOf(S.byKey[k]) === 'none') { S.selected = k; S.scrollToSel = true; return; }
    }
    toast('Nothing left to test in this view.');
  }

  function mark(key, value) {
    if (S.readOnly) { toast('View only: you need edit access to mark results.', 'bad'); return; }
    var c = S.byKey[key];
    var cy = cur();
    if (!c || !cy) return;
    var ci = S.model.cycleIdx;
    var prev = c.statuses[ci] || '';
    if (prev === value) return;
    var prevComment = c.comments[ci] || '';
    c.statuses[ci] = value;
    S.keep[key] = true;
    S.pending[key] = true;
    S.undo.push({ key: key, prev: prev, next: value, prevComment: prevComment });
    if (S.undo.length > 50) S.undo.shift();
    var failing = TR.classify(value) === 'fail';
    if (!failing && value) advance(key);
    render();
    if (failing) focusComment();
    queueWrite(function () {
      return api('api_mark', { tab: S.tab, key: key, sh: c.sh, row: c.row, cycle: cy.label, expect: prev, status: value });
    }).then(function (r) { afterMark(c, ci, r, prev, prevComment); });
  }

  function focusComment() {
    var t = $('comment');
    if (!t) return;
    t.focus();
    if (t.value && !/\s$/.test(t.value)) {
      t.value += '\n';
      var d = S.drafts[S.selected] || (S.drafts[S.selected] = {});
      d.comment = t.value;
    }
    var end = t.value.length;
    try { t.setSelectionRange(end, end); } catch (e) { /* not a text field */ }
  }

  function afterMark(c, ci, r, prev, prevComment) {
    delete S.pending[c.key];
    if (r.ok) {
      c.row = r.row;
      if (r.testedBy != null) c.testedBy = r.testedBy;
      if (r.testedOn != null) c.testedOn = r.testedOn;
      if (r.comment != null) c.comments[ci] = r.comment;
      if (r.issue != null) c.linkedIssue = r.issue;
      render();
      return;
    }
    if (r.code === 'CONFLICT') {
      c.statuses[ci] = r.current;
      c.comments[ci] = r.comment;
      S.undo = S.undo.filter(function (u) { return u.key !== c.key; });
      toast((c.id || 'This case') + ' was just marked "' + (r.current || 'not run') + '"' + (r.by ? ' by ' + r.by : '') + ' in the workbook. Showing that result; mark again if you need to.', 'bad');
      render();
      return;
    }
    c.statuses[ci] = prev;
    c.comments[ci] = prevComment;
    writeError(r);
  }

  function saveNote() {
    var c = S.byKey[S.selected];
    var cy = cur();
    if (!c || !cy) return;
    var ci = S.model.cycleIdx;
    var t = $('comment');
    var i = $('issue');
    var req = { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, expect: c.statuses[ci] || '', status: c.statuses[ci] || '' };
    if (t) req.comment = t.value;
    if (i) req.issue = i.value;
    S.pending[c.key] = true;
    render();
    queueWrite(function () { return api('api_mark', req); }).then(function (r) {
      if (r.ok) { delete S.drafts[c.key]; toast('Saved.'); }
      afterMark(c, ci, r, c.statuses[ci], c.comments[ci]);
    });
  }

  function undo() {
    var u = S.undo.pop();
    if (!u) return;
    var c = S.byKey[u.key];
    var cy = cur();
    if (!c || !cy) return;
    var ci = S.model.cycleIdx;
    var now = c.statuses[ci] || '';
    c.statuses[ci] = u.prev;
    c.comments[ci] = u.prevComment;
    S.pending[c.key] = true;
    S.selected = c.key;
    S.scrollToSel = true;
    render();
    queueWrite(function () {
      return api('api_mark', { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, expect: now, status: u.prev, comment: cy.hasComment ? u.prevComment : null });
    }).then(function (r) {
      if (r.ok) toast('Undone: ' + (c.id || 'case') + ' is back to "' + (u.prev || 'not run') + '".');
      afterMark(c, ci, r, now, c.comments[ci]);
    });
  }

  // ---------------------------------------------------------------------------
  // Plan
  // ---------------------------------------------------------------------------

  function viewPlan() {
    var m = S.model;
    var todo = m.cases.filter(function (c) { return clsOf(c) === 'none'; });
    var tierCounts = {};
    todo.forEach(function (c) { tierCounts[c.tier] = (tierCounts[c.tier] || 0) + 1; });
    var dis = S.readOnly ? ' disabled' : '';
    var h = '<div class="grid">';

    h += '<section class="card card-pad stack"><h2>Cycle</h2><p class="small muted">A cycle is one pair of columns in the workbook: <i>Test Status / name</i> and <i>Comment / name</i>. Earlier cycles stay as they are, so you can compare.</p>';
    if (m.cycles.length) h += '<div class="small">Current: <b>' + esc(cycleLabel() || 'Status') + '</b>' + (m.prevIdx >= 0 ? ' · previous: ' + esc(m.cycles[m.prevIdx].label || 'Status') : '') + '</div>';
    h += '<div class="row"><label class="sr" for="newCycle">New cycle name</label><input id="newCycle" data-bind="newCycle" placeholder="New cycle, e.g. v2.20.1" value="' + esc(val('newCycle')) + '"' + dis + '><button class="primary" data-action="start-cycle"' + dis + '>Start new cycle</button></div>' +
      '<p class="small faint">Adds the two columns next to the latest cycle and copies its dropdown and formatting.</p></section>';

    h += '<section class="card card-pad stack"><h2>Focus: what to test first</h2><p class="small muted">Untested cases, in the order worth running them:</p><table><tbody>';
    S.boot.tiers.forEach(function (t) {
      var label = t.id === 0 && m.release ? 'New in ' + m.release : t.label;
      var on = S.filters.tiers.indexOf(t.id) >= 0;
      h += '<tr><td><label class="check"><input type="checkbox" data-action="tier" data-tier="' + t.id + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label><div class="small faint">' + esc(tierHelp(t.id)) + '</div></td><td class="num"><b>' + (tierCounts[t.id] || 0) + '</b></td></tr>';
    });
    h += '</tbody></table>';
    if (hasField('release')) {
      h += '<div class="row"><label for="release">Release in scope</label><input id="release" data-bind="release" placeholder="e.g. 2.20.1" value="' + esc(val('release', m.release)) + '"' + dis + '><button data-action="save-release"' + dis + '>Save</button></div>';
    } else {
      h += '<p class="small faint">To tag cases by release (for patch releases), add a Release column in Setup.</p>';
    }
    h += '<div class="row"><span class="grow"></span><button data-action="view" data-view="run">Show in Run</button></div></section>';

    h += '<section class="card card-pad stack"><h2>Test paths</h2>';
    if (m.plan.source === 'plan') {
      h += '<p class="small">Using a <b>Claude path plan</b>' + (m.plan.savedAt ? ', saved ' + esc(m.plan.savedAt) : '') + (m.plan.savedBy ? ' by ' + esc(m.plan.savedBy) : '') + '.</p>';
      if (m.plan.unknown && m.plan.unknown.length) h += '<div class="note">' + m.plan.unknown.length + ' case ID(s) in the plan are no longer in this tab.</div>';
      if (m.plan.leftover) h += '<div class="note info">' + m.plan.leftover + ' case(s) are not in the plan; they are listed last under "Not in the plan".</div>';
      h += '<div class="row"><button data-action="clear-plan"' + dis + '>Use automatic paths</button></div>';
    } else {
      h += '<p class="small muted">Automatic: grouped by Feature, then Sub feature, in sheet order. Groups holding the riskiest untested cases come first.</p>';
    }
    if (claudeOn()) {
      h += '<p class="small muted">Claude can regroup cases into paths that one person runs in a single pass: one login and one piece of test data carried through its states. The plan lands in the Inbox for you to check first.</p>' +
        '<label class="check"><input type="checkbox" data-bind="planTodo"' + (val('planTodo', true) ? ' checked' : '') + '> Only untested cases</label>' +
        '<input data-bind="planFocus" id="planFocus" placeholder="Optional note for Claude, e.g. GRO and LME are the same person here" value="' + esc(val('planFocus')) + '">' +
        claudeControls('paths') +
        '<div class="row">' + claudeButton('paths', 'Plan paths with Claude', 'claude-paths', false) + '<button class="ghost" data-action="copy-paths" title="Copy the prompt to use Claude somewhere else">Copy prompt</button></div>' +
        claudeStatusLine('paths');
    } else {
      h += '<p class="small faint">Turn on Claude help in Setup to get paths planned for you.</p>';
    }
    h += '</section>';

    h += '<section class="card card-pad stack"><h2>Running a cycle well</h2><ul class="bullets small">' +
      '<li><span>Work path by path. Stay on one login and reuse the same complaint while it moves through its states.</span></li>' +
      '<li><span>Start with <b>Focus</b>: what is new in this release, then what failed last time.</span></li>' +
      '<li><span>Skip or only glance at cases marked <b>Auto ✓</b>; automation already checked them this cycle.</span></li>' +
      '<li><span>Found something unplanned? Log the bug, then add a one-line <b>Finding</b>. Write it up later.</span></li>' +
      '</ul></section>';
    return h + '</div>';
  }

  function tierHelp(id) {
    return ['Release column matches the release in scope', 'Failed in the previous cycle', 'No passing automation', 'Automation passed; a quick look is enough'][id] || '';
  }

  // ---------------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------------

  function areas() {
    var out = [];
    distinct('group1').concat(distinct('group2')).forEach(function (a) { if (out.indexOf(a) < 0) out.push(a); });
    return out;
  }

  function viewFindings() {
    var dis = S.readOnly ? ' disabled' : '';
    var h = '<section class="card card-pad stack"><h2>Note a finding</h2><p class="small muted">Something unplanned failed? Log the bug as usual, then note it here in one line. Write it up as a test case later, by hand or with Claude.</p>' +
      '<div class="form-grid"><div class="wide"><label for="fText">What did you find?</label><input id="fText" data-bind="fText" placeholder="e.g. Citizen cannot reopen a complaint resolved 4 days ago" value="' + esc(val('fText')) + '"' + dis + '></div>' +
      '<div><label for="fIssue">Bug</label><input id="fIssue" data-bind="fIssue" placeholder="#123 (optional)" value="' + esc(val('fIssue')) + '"' + dis + '></div>' +
      '<div><label for="fArea">Area</label><select id="fArea" data-bind="fArea"' + dis + '><option value="">Not sure</option>' + areas().map(function (a) { return opt(a, a, val('fArea') === a); }).join('') + '</select></div>' +
      '<div class="wide"><label for="fDetails">Details (optional, e.g. steps or the bug text)</label><textarea id="fDetails" data-bind="fDetails" rows="2"' + dis + '>' + esc(val('fDetails')) + '</textarea></div></div>' +
      '<div class="row"><span class="grow"></span><button class="primary" data-action="add-finding"' + dis + '>Save finding</button></div></section>';

    var list = S.findings.filter(function (f) { return !f.tab || f.tab === S.tab; });
    var open = list.filter(function (f) { return f.state === 'open'; });
    var selected = open.filter(function (f) { return S.findingSel[f.key]; });
    h += '<div class="row section"><h2>Findings in ' + esc(S.tab) + '</h2><span class="grow"></span>';
    h += '</div>';
    if (claudeOn() && open.length) {
      h += '<section class="card card-pad stack"><div class="row"><b>Write up with Claude</b><span class="small muted">Tick findings below, then draft test cases from them. Drafts land in the Inbox for review.</span></div>' +
        claudeControls('draft') +
        '<div class="row">' + claudeButton('draft', selected.length ? 'Draft ' + selected.length + ' with Claude' : 'Draft with Claude', 'claude-draft', !selected.length) +
        '<button class="ghost" data-action="copy-findings"' + (selected.length ? '' : ' disabled') + ' title="Copy the prompt to use Claude somewhere else">Copy prompt</button></div>' +
        claudeStatusLine('draft') + '</section>';
    }
    if (!list.length) return h + '<div class="empty card"><p>No findings yet.</p></div>';
    h += '<div class="card table-wrap"><table><thead><tr><th style="width:28px"></th><th>Finding</th><th>Bug</th><th>State</th><th></th></tr></thead><tbody>';
    list.forEach(function (f) {
      var st = { open: pill('other', 'To write up'), written: pill('pass', 'Written up' + (f.caseId ? ' · ' + f.caseId : '')), covered: pill('none', 'Already covered' + (f.caseId ? ' · ' + f.caseId : '')) }[f.state] || '';
      h += '<tr><td>' + (f.state === 'open' ? '<input type="checkbox" aria-label="Select ' + esc(f.key) + '" data-action="pick-finding" data-key="' + esc(f.key) + '"' + (S.findingSel[f.key] ? ' checked' : '') + '>' : '') + '</td>' +
        '<td><span class="mono faint">' + esc(f.key) + '</span> ' + esc(f.text) + (f.source === 'bug-reporter' ? ' <span class="pill accent" title="Noted from the Bug Reporter extension when the issue was filed">from Bug Reporter</span>' : '') + (f.area ? '<div class="small muted">' + esc(f.area) + '</div>' : '') + (f.details ? '<div class="small faint" style="white-space:pre-line">' + esc(f.details) + '</div>' : '') + '<div class="small faint">' + esc([f.by, f.at].filter(Boolean).join(' · ')) + '</div></td>' +
        '<td>' + (f.url ? '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.issue || 'issue') + '</a>' : TR.issueLink(f.issue, S.model.issueBase)) + '</td><td>' + st + '</td>' +
        '<td class="num"><div class="row" style="justify-content:flex-end">' + (f.state === 'open' ? '<button data-action="writeup" data-key="' + esc(f.key) + '"' + dis + '>Write up</button>' : '') +
        '<button class="ghost danger" data-action="del-finding" data-key="' + esc(f.key) + '" title="Delete"' + dis + '>Delete</button></div></td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  var DRAFT_FIELDS = [
    { f: 'scenario', label: 'Scenario', col: 'scenario', wide: true, rows: 2 },
    { f: 'feature', label: 'Feature', col: 'feature', list: 'group1' },
    { f: 'subFeature', label: 'Sub feature', col: 'subFeature', list: 'group2' },
    { f: 'testType', label: 'Test type', col: 'testType', list: 'testType' },
    { f: 'issue', label: 'Linked issue', col: 'linkedIssue' },
    { f: 'release', label: 'Release', col: 'release' },
    { f: 'testData', label: 'Test data', col: 'testData', wide: true, rows: 2 },
    { f: 'preCondition', label: 'Pre condition', col: 'preCondition', wide: true, rows: 2 },
    { f: 'expected', label: 'Expected result (one per line)', col: 'expected', wide: true, rows: 3 }
  ];

  function draftValue(prefix, it, f) {
    var base = it[f];
    if (f === 'expected' && Array.isArray(base)) base = base.join('\n');
    return val(prefix + ':' + f, base == null ? '' : base);
  }

  function collectDraft(prefix, it) {
    var out = {};
    DRAFT_FIELDS.forEach(function (d) { out[d.f] = draftValue(prefix, it, d.f); });
    out.expected = String(out.expected).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    out.status = val(prefix + ':status', defaultStatus(it));
    out.comment = val(prefix + ':comment', '');
    out.fromFinding = it.fromFinding || '';
    return out;
  }

  function defaultStatus(it) {
    if (!it.issue) return '';
    var fail = S.model.statusOptions.filter(function (o) { return o.cls === 'fail'; })[0];
    return fail ? fail.value : '';
  }

  function scenarioEditor(it, prefix, actionsHtml) {
    var dis = S.readOnly ? ' disabled' : '';
    var h = '<div class="form-grid">';
    var unmapped = [];
    DRAFT_FIELDS.forEach(function (d) {
      var v = draftValue(prefix, it, d.f);
      if (!hasField(d.col)) { if (String(v).trim()) unmapped.push(d.label.replace(/ \(.*\)$/, '') + ': "' + String(v).slice(0, 60) + '"'); return; }
      var id = prefix.replace(/[^\w-]/g, '_') + '_' + d.f;
      var listId = d.list ? 'dl_' + d.list : '';
      h += '<div' + (d.wide ? ' class="wide"' : '') + '><label for="' + id + '">' + esc(d.label) + '</label>' +
        (d.rows ? '<textarea id="' + id + '" data-bind="' + esc(prefix + ':' + d.f) + '" rows="' + d.rows + '"' + dis + '>' + esc(v) + '</textarea>'
          : '<input id="' + id + '" data-bind="' + esc(prefix + ':' + d.f) + '" value="' + esc(v) + '"' + (listId ? ' list="' + listId + '"' : '') + dis + '>') + '</div>';
    });
    if (cur()) {
      var st = val(prefix + ':status', defaultStatus(it));
      h += '<div><label for="' + prefix.replace(/[^\w-]/g, '_') + '_status">Result in cycle ' + esc(cycleLabel() || '') + '</label><select id="' + prefix.replace(/[^\w-]/g, '_') + '_status" data-bind="' + esc(prefix + ':status') + '"' + dis + '><option value="">Not run yet</option>' +
        S.model.statusOptions.map(function (o) { return opt(o.value, o.value, o.value === st); }).join('') + '</select></div>';
      if (cur().hasComment) h += '<div><label>Comment</label><input data-bind="' + esc(prefix + ':comment') + '" value="' + esc(val(prefix + ':comment', '')) + '"' + dis + '></div>';
    }
    h += '</div>';
    var notes = '';
    var tags = (it.edgeCase ? '<span class="pill accent">Edge case</span>' : '') + (it.fromFinding ? '<span class="pill outline">From ' + esc(it.fromFinding) + '</span>' : '');
    if (tags) notes += '<div class="row">' + tags + '</div>';
    if (it.hint) notes += '<div class="note info">Finding ' + esc(it.fromFinding || '') + ': ' + esc(it.hint) + '</div>';
    if (it.duplicates && it.duplicates.length) {
      notes += '<div class="note">Looks similar to ' + it.duplicates.map(function (d) { return '<b>' + esc(d.id || d.key) + '</b> (' + esc(d.scenario.slice(0, 90)) + ')'; }).join(', ') + '. Check it is not a duplicate.</div>';
    }
    if (unmapped.length) notes += '<div class="note info">This tab has no column for: ' + esc(unmapped.join('; ')) + '. That part will not be saved.</div>';
    return '<div class="item">' + (notes ? '<div class="stack" style="margin-bottom:8px">' + notes + '</div>' : '') + h + '<div class="row" style="margin-top:10px"><span class="grow"></span>' + actionsHtml + '</div></div>';
  }

  function datalists() {
    return ['group1', 'group2', 'testType'].map(function (k) {
      return '<datalist id="dl_' + k + '">' + distinct(k).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>';
    }).join('');
  }

  function viewInbox() {
    var dis = S.readOnly ? ' disabled' : '';
    var h = datalists();
    if (claudeOn()) {
      h += '<details class="card card-pad"' + (val('replyOpen') ? ' open' : '') + '><summary class="small"><b>Paste a reply from Claude used elsewhere</b> <span class="muted">(after "Copy prompt")</span></summary>' +
        '<div class="stack" style="margin-top:8px"><p class="small muted">Paste the whole reply, including the <span class="mono">```json</span> block. It is checked and listed below for review.</p>' +
        '<label class="sr" for="reply">Reply</label><textarea id="reply" data-bind="reply" rows="4" placeholder="Paste here">' + esc(val('reply')) + '</textarea>' +
        '<div class="row"><span class="grow"></span><button class="primary" data-action="read-reply"' + dis + '>Read reply</button></div></div></details>';
    }
    h += '<div class="row section"><h2>To review</h2><span class="grow"></span><button data-action="new-manual"' + dis + '>+ Write a test case by hand</button></div>';
    var any = false;
    S.manual.forEach(function (it, i) {
      any = true;
      h += '<div class="section"><div class="small muted" style="margin-bottom:4px">Written by hand</div>' +
        scenarioEditor(it, 'man:' + i, '<button class="ghost" data-action="discard-manual" data-index="' + i + '">Discard</button><button class="primary" data-action="add-manual" data-index="' + i + '"' + dis + '>Add to workbook</button>') + '</div>';
    });
    S.inbox.forEach(function (e) {
      if (e.tab !== S.tab) return;
      any = true;
      h += entryCard(e);
    });
    var elsewhere = S.inbox.filter(function (e) { return e.tab !== S.tab; });
    if (elsewhere.length) h += '<p class="small muted section">' + elsewhere.length + ' more inbox entr' + (elsewhere.length === 1 ? 'y is' : 'ies are') + ' waiting in other tabs: ' + esc(elsewhere.map(function (e) { return e.tab; }).join(', ')) + '.</p>';
    if (!any) h += '<div class="empty card"><p>Nothing to review.' + (claudeOn() ? ' Draft test cases from your findings on the Findings screen; they land here.' : '') + '</p></div>';
    return h;
  }

  function entryCard(e) {
    var dis = S.readOnly ? ' disabled' : '';
    var head = '<div class="row" style="margin-bottom:8px"><b>' + esc({ scenarios: 'New test cases', edits: 'Suggested edits', paths: 'Path plan' }[e.type] || e.type) + '</b><span class="small muted">pasted ' + esc(e.at) + (e.by ? ' by ' + esc(e.by) : '') + '</span><span class="grow"></span><button class="ghost" data-action="discard-entry" data-entry="' + esc(e.key) + '"' + dis + '>Discard all</button></div>';
    var warn = (e.errors || []).map(function (x) { return '<div class="note">' + esc(x) + '</div>'; }).join('');
    var h = '<section class="section card card-pad">' + head + (warn ? '<div class="stack" style="margin-bottom:8px">' + warn + '</div>' : '');
    if (e.type === 'paths') {
      var n = 0;
      e.paths.forEach(function (p) { p.steps.forEach(function (s) { n += s.cases.length; }); });
      h += '<p class="small">' + e.paths.length + ' paths covering ' + n + ' cases.</p><ol class="small">' + e.paths.map(function (p) {
        var k = 0; p.steps.forEach(function (s) { k += s.cases.length; });
        return '<li><b>' + esc(p.name) + '</b>' + (p.persona ? ' · ' + esc(p.persona) : '') + ' – ' + k + ' cases in ' + p.steps.length + ' steps</li>';
      }).join('') + '</ol><div class="row"><span class="grow"></span><button class="primary" data-action="use-plan" data-entry="' + esc(e.key) + '"' + dis + '>Use this plan</button></div>';
      return h + '</section>';
    }
    (e.items || []).forEach(function (it, i) {
      var done = it.state !== 'open';
      if (e.type === 'scenarios') {
        if (done) { h += '<div class="item done small">' + esc(it.scenario) + ' – <b>' + esc(it.state === 'added' ? 'added as ' + (it.addedId || 'a new row') : it.state) + '</b></div>'; return; }
        h += scenarioEditor(it, 'it:' + e.key + ':' + i,
          '<button class="ghost" data-action="reject-item" data-entry="' + esc(e.key) + '" data-index="' + i + '"' + dis + '>Reject</button>' +
          '<button class="primary" data-action="accept-item" data-entry="' + esc(e.key) + '" data-index="' + i + '"' + dis + '>Add to workbook</button>');
      } else if (e.type === 'edits') {
        if (done) { h += '<div class="item done small">' + esc(it.caseId) + ' – <b>' + esc(it.state) + '</b></div>'; return; }
        var rows = Object.keys(it.fields).map(function (f) {
          var nv = Array.isArray(it.fields[f]) ? it.fields[f].map(function (b) { return '• ' + b; }).join('\n') : it.fields[f];
          var ov = it.current ? it.current[f] : '';
          return '<tr><td>' + esc(S.boot.labels[f] || f) + '</td><td class="diff-old">' + esc(ov) + '</td><td class="diff-new">' + esc(nv) + '</td></tr>';
        }).join('');
        h += '<div class="item"><div class="row"><b class="mono">' + esc(it.caseId) + '</b><span class="small muted">' + esc(it.reason) + '</span></div><div class="table-wrap"><table><thead><tr><th>Field</th><th>Now</th><th>Suggested</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
          '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="ghost" data-action="reject-item" data-entry="' + esc(e.key) + '" data-index="' + i + '"' + dis + '>Reject</button><button class="primary" data-action="accept-item" data-entry="' + esc(e.key) + '" data-index="' + i + '"' + dis + '>Apply</button></div></div>';
      }
    });
    (e.covered || []).forEach(function (cv, i) {
      if (cv.state !== 'open') return;
      h += '<div class="item"><div class="row"><span>' + (cv.fromFinding ? '<span class="mono">' + esc(cv.fromFinding) + '</span> ' : '') + 'is already covered by <b class="mono">' + esc(cv.caseId) + '</b>' + (cv.known ? '' : ' <span class="pill other">not found in this tab</span>') + '</span></div>' +
        (cv.note ? '<div class="small muted">' + esc(cv.note) + '</div>' : '') +
        '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="ghost" data-action="reject-covered" data-entry="' + esc(e.key) + '" data-index="' + i + '"' + dis + '>Dismiss</button><button data-action="accept-covered" data-entry="' + esc(e.key) + '" data-index="' + i + '"' + dis + '>Mark finding as covered</button></div></div>';
    });
    return h + '</section>';
  }

  function replaceEntry(entry) {
    var open = (entry.items || []).some(function (i) { return i.state === 'open'; }) || (entry.covered || []).some(function (c) { return c.state === 'open'; });
    S.inbox = S.inbox.filter(function (x) { return x.key !== entry.key; });
    if (open) S.inbox.push(entry);
  }

  function resolveItem(el, list, action) {
    var key = el.getAttribute('data-entry');
    var idx = parseInt(el.getAttribute('data-index'), 10);
    var entry = S.inbox.filter(function (x) { return x.key === key; })[0];
    if (!entry) return;
    var extra = { cycle: cycleLabel() };
    if (action === 'accept' && list === 'items' && entry.type === 'scenarios') {
      var d = collectDraft('it:' + key + ':' + idx, entry.items[idx]);
      if (!d.scenario.trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
      extra.item = d;
      extra.status = d.status;
      extra.comment = d.comment;
    }
    el.disabled = true;
    queueWrite(function () { return api('api_resolveInbox', key, list, idx, action, extra); }).then(function (r) {
      if (!r.ok) { el.disabled = false; writeError(r); return; }
      replaceEntry(r.entry);
      var it = list === 'items' ? r.entry.items[idx] : null;
      if (it && it.state === 'added') toast('Added to the workbook as ' + (it.addedId || 'a new row') + '.');
      else if (it && it.state === 'applied') toast('Edit applied.');
      if (action === 'accept') { loadTab(cycleLabel(), true); loadSide(); }
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  function viewSummary() {
    var label = cycleLabel();
    if (!S.summary || S.summary.tab !== S.tab || S.summary.cycle !== label) {
      if (!S.summaryLoading) {
        S.summaryLoading = true;
        api('api_summary', S.tab, label).then(function (r) {
          S.summaryLoading = false;
          if (!r.ok) { toast(r.error, 'bad'); return; }
          S.summary = r;
          render();
        });
      }
      return '<div class="loading">Working out the figures…</div>';
    }
    var r = S.summary;
    var url = '/summary.html?book=' + encodeURIComponent(book()) + '&tab=' + encodeURIComponent(S.tab) + '&cycle=' + encodeURIComponent(label);
    var h = '<div class="summary-head"><h1>' + esc(r.tab) + '</h1><span class="muted">cycle ' + esc(r.cycle || '–') + (r.release ? ' · release ' + esc(r.release) : '') + ' · as of ' + esc(r.generatedAt) + '</span><span class="grow"></span>' +
      '<div class="row no-print"><a class="btn" href="' + esc(url) + '" target="_blank" rel="noopener">Open summary page</a>' +
      '<button data-action="export-summary" title="Save this summary as one HTML file you can send or attach">Export summary</button>' +
      '<button data-action="write-summary"' + (S.readOnly ? ' disabled' : '') + ' title="Write these figures into a visible tab of the workbook">Update summary tab</button><button data-action="print">Print / PDF</button></div></div>';
    if (S.exported) h += '<div class="banner no-print"><span>Saved <span class="mono">' + esc(S.exported.file) + '</span></span><span class="grow"></span><a class="btn" href="' + esc(S.exported.url) + '" target="_blank" rel="noopener">Open it</a></div>';
    return h + TR.summaryHtml(r);
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  function setupDraft() {
    if (S.setup) return S.setup;
    var cfg = S.cfg || {};
    S.setup = {
      issueBase: cfg.issueBase || '',
      tabs: S.boot.tabs.map(function (t) {
        var src = t.saved || t.detected;
        return { name: t.name, role: src.role, headerRow: src.headerRow, columns: JSON.parse(JSON.stringify(src.columns || {})), fillDown: src.fillDown !== false, top: t.top, rows: t.rows, saved: !!t.saved };
      })
    };
    return S.setup;
  }

  var STATUS_HEAD = /^(?:test )?(?:execution )?(?:status|result)s?(?:\s*[\/|:\-–]\s*(.+)|\s+(\S*\d.*))?$/i;
  function isStatusHeader(x) { return STATUS_HEAD.test(String(x == null ? '' : x).replace(/\s+/g, ' ').trim()); }

  // ---------------------------------------------------------------------------
  // Claude (local Claude Code, like Bug Reporter): defaults from Setup, changeable per draft
  // ---------------------------------------------------------------------------

  function claudeChoice(kind) {
    var d = S.app.settings.claude[kind];
    return { model: val('cl:' + kind + ':model', d.model), effort: val('cl:' + kind + ':effort', d.effort) };
  }

  function modelOptions(selected) {
    return Object.keys(S.app.claude.models).map(function (k) { return opt(k, S.app.claude.models[k], k === selected); }).join('');
  }

  function effortOptions(selected) {
    return S.app.claude.efforts.map(function (e) { return opt(e, e.charAt(0).toUpperCase() + e.slice(1), e === selected); }).join('');
  }

  function claudeControls(kind) {
    var c = claudeChoice(kind);
    var dis = S.claudeBusy ? ' disabled' : '';
    return '<div class="claude-opts"><span class="small"><b>Claude for this ' + (kind === 'paths' ? 'plan' : 'draft') + '</b> <span class="muted">(defaults from Setup)</span></span>' +
      '<div class="row small"><label class="row">Model <select data-bind="cl:' + kind + ':model"' + dis + '>' + modelOptions(c.model) + '</select></label>' +
      '<label class="row">Effort <select data-bind="cl:' + kind + ':effort"' + dis + '>' + effortOptions(c.effort) + '</select></label></div></div>';
  }

  function claudeButton(kind, label, action, disabled) {
    var busy = S.claudeBusy === kind;
    var off = disabled || !!S.claudeBusy || S.readOnly || !S.app.claude.available;
    return '<button class="primary" data-action="' + action + '"' + (off ? ' disabled' : '') + '>' + (busy ? 'Asking Claude…' : esc(label)) + '</button>';
  }

  function prettyModel(id) {
    var m = String(id || '');
    var k = Object.keys(S.app.claude.models).filter(function (x) { return x !== 'default' && m.indexOf(x) >= 0; })[0];
    return k ? S.app.claude.models[k] : (m || 'unknown model');
  }

  function kTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0); }

  function usageLine(u) {
    return esc(prettyModel(u.model)) + ' · effort ' + esc(u.requested.effort) + ' · ' + kTok(u.totalInput) + ' in / ' + kTok(u.outputTokens) + ' out · ' +
      (u.durationMs / 1000).toFixed(1) + ' s · ' + esc(u.costText) + ' API-equivalent' + (u.fellBack ? ' · used the CLI\'s model name' : '');
  }

  function claudeStatusLine(kind) {
    if (!S.app.claude.available) {
      return '<div class="note bad">Claude Code was not found on this computer. Install it, run <span class="mono">claude auth login</span>, then restart Test Run. You can still use <b>Copy prompt</b>.</div>';
    }
    if (S.claudeBusy === kind) {
      var c = claudeChoice(kind);
      return '<div class="small muted">Asking Claude (' + esc(S.app.claude.models[c.model]) + ', effort ' + esc(c.effort) + ')… <span id="claudeElapsed">' + Math.round((Date.now() - S.claudeStarted) / 1000) + ' s</span>. You can keep testing meanwhile.</div>';
    }
    var e = S.claudeError[kind];
    if (e) return '<div class="note bad">' + esc(e.error) + (e.fix && e.fix.length ? ' Try: <span class="mono">' + esc(e.fix.join(' ; ')) + '</span>' : '') + '</div>';
    var u = S.usage[kind];
    return u ? '<div class="small muted">Last run: ' + usageLine(u) + '</div>' : '';
  }

  var elapsedTimer = null;
  function runClaude(kind, payload) {
    var c = claudeChoice(kind);
    S.claudeBusy = kind;
    S.claudeStarted = Date.now();
    delete S.claudeError[kind];
    render();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(function () {
      var el = $('claudeElapsed');
      if (el) el.textContent = Math.round((Date.now() - S.claudeStarted) / 1000) + ' s';
    }, 1000);
    var body = { kind: kind, book: book(), tab: S.tab, model: c.model, effort: c.effort };
    Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });
    TR.http('POST', '/api/claude', body).then(function (r) {
      clearInterval(elapsedTimer);
      S.claudeBusy = null;
      if (r.usage) S.usage[kind] = r.usage;
      if (!r.ok) {
        S.claudeError[kind] = r;
        toast(r.error || 'Claude could not draft this.', 'bad');
        render();
        return;
      }
      S.inbox.push(r.entry);
      if (kind === 'draft') S.findingSel = {};
      var n = r.entry.type === 'paths' ? r.entry.paths.length + ' paths' : (r.entry.items || []).length + ' test case(s)';
      toast('Claude drafted ' + n + '. Review them in the Inbox.');
      S.view = 'inbox';
      render();
      window.scrollTo(0, 0);
    });
  }

  function appSettingsCard() {
    var st = S.app.settings;
    var cl = S.app.claude;
    return '<section class="card card-pad stack"><h2>You and Claude <span class="small muted">(this computer, all workbooks)</span></h2>' +
      '<div class="form-grid"><div><label for="appUser">Your name (fills <i>Tested by</i>)</label><input id="appUser" data-bind="app:user" value="' + esc(val('app:user', st.user)) + '"></div></div>' +
      '<label class="check"><input type="checkbox" data-bind="app:enabled"' + (val('app:enabled', st.claude.enabled) ? ' checked' : '') + '> Claude help</label>' +
      '<p class="small muted" style="margin-left:24px">Drafts test cases from your findings and plans test paths, through your own Claude Code login (no API key), the same way Bug Reporter does. Only the findings you tick and related scenario titles are sent, and everything lands in the Inbox for review first. ' +
      (cl.available ? '<span class="pill pass">Claude Code found</span>' : '<span class="pill fail">Claude Code not found</span> Install it and run <span class="mono">claude auth login</span>.') + '</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Default for</th><th>Model</th><th>Effort</th></tr></thead><tbody>' +
      '<tr><td>Writing up findings</td><td><select aria-label="Model for writing up" data-bind="app:draft.model">' + modelOptions(val('app:draft.model', st.claude.draft.model)) + '</select></td><td><select aria-label="Effort for writing up" data-bind="app:draft.effort">' + effortOptions(val('app:draft.effort', st.claude.draft.effort)) + '</select></td></tr>' +
      '<tr><td>Planning test paths</td><td><select aria-label="Model for planning" data-bind="app:paths.model">' + modelOptions(val('app:paths.model', st.claude.paths.model)) + '</select></td><td><select aria-label="Effort for planning" data-bind="app:paths.effort">' + effortOptions(val('app:paths.effort', st.claude.paths.effort)) + '</select></td></tr>' +
      '</tbody></table></div><p class="small faint">You can still change the model and effort for any single draft.</p>' +
      '<div class="row"><span class="grow"></span><button data-action="save-app">Save</button></div></section>';
  }

  function viewSetup() {
    var d = setupDraft();
    var dis = S.readOnly ? ' disabled' : '';
    var h = '';
    if (!S.cfg) h += '<div class="banner"><div><b>Welcome.</b> Check how each tab of <b>' + esc(S.boot.sheetName) + '</b> was read, then save. Settings are kept beside the workbook in <span class="mono">sheets/.testrun/</span>; the workbook itself does not change.</div></div>';
    h += appSettingsCard();
    h += '<section class="section card card-pad stack"><h2>This workbook</h2>' +
      '<div class="form-grid"><div class="wide"><label for="issueBase">Issue link address (optional)</label><input id="issueBase" type="url" data-setup="issueBase" placeholder="https://github.com/org/repo/issues" value="' + esc(d.issueBase) + '"' + dis + '><span class="small faint">Turns "#123" in the workbook into a link.</span></div></div></section>';

    d.tabs.forEach(function (t, ti) {
      var headers = (t.top && t.top[t.headerRow - 1]) || [];
      h += '<section class="section card card-pad stack"><div class="row"><h2>' + esc(t.name) + '</h2><span class="small muted">' + t.rows + ' rows</span><span class="grow"></span>' +
        '<label for="role' + ti + '" class="sr">Role</label><select id="role' + ti + '" data-setup-tab="' + ti + '" data-key="role"' + dis + '>' +
        opt('manual', 'Test cases', t.role === 'manual') + opt('automation', 'Automation results', t.role === 'automation') + opt('ignore', 'Ignore', t.role === 'ignore') + '</select></div>';
      if (t.role === 'ignore') { h += '<p class="small faint">Not used by the console.</p></section>'; return; }
      if (t.role === 'automation') {
        h += '<p class="small muted">Results here feed the <b>Auto</b> badges on manual cases. Manual cases link to a spec when their comment or an <i>Automated by</i> column names it (e.g. <span class="mono">inbox-search.spec</span>).</p></section>';
        return;
      }
      var cycles = headers.filter(isStatusHeader);
      h += '<div class="row"><label for="hr' + ti + '">Header row</label><input id="hr' + ti + '" type="text" inputmode="numeric" size="3" data-setup-tab="' + ti + '" data-key="headerRow" value="' + esc(t.headerRow) + '"' + dis + '>' +
        '<button class="ghost" data-action="redetect" data-index="' + ti + '"' + dis + '>Detect columns again</button>' +
        '<span class="grow"></span><label class="check"><input type="checkbox" data-setup-tab="' + ti + '" data-key="fillDown"' + (t.fillDown ? ' checked' : '') + dis + '> Blank Feature / Sub feature continues the row above</label></div>';
      if (!headers.length) h += '<div class="note">No headers in row ' + esc(t.headerRow) + '.</div>';
      h += '<div class="table-wrap"><table><thead><tr><th>Console field</th><th>Column in this tab</th></tr></thead><tbody>';
      S.boot.fields.forEach(function (f) {
        var chosen = t.columns[f] || '';
        h += '<tr><td>' + esc(S.boot.labels[f]) + '</td><td><select aria-label="' + esc(S.boot.labels[f]) + ' column" data-setup-tab="' + ti + '" data-key="col" data-field="' + f + '"' + dis + '><option value="">— not in this tab —</option>' +
          headers.filter(function (x) { return String(x).trim(); }).map(function (x) { return opt(x, x, x === chosen); }).join('') + '</select></td></tr>';
      });
      h += '</tbody></table></div>';
      h += '<div class="small">Status columns (one per cycle): ' + (cycles.length ? cycles.map(function (x) { return '<span class="pill outline">' + esc(x) + '</span>'; }).join(' ') : '<span class="faint">none yet; start a cycle on the Plan screen</span>') + '</div>';
      if (t.saved) {
        var missing = ['testedBy', 'testedOn'].filter(function (f) { return !t.columns[f]; });
        var adds = [];
        if (missing.length) adds.push('<button data-action="add-cols" data-tab="' + esc(t.name) + '" data-fields="testedBy,testedOn"' + dis + '>Add Tested by + Tested on columns</button>');
        if (!t.columns.release) adds.push('<button data-action="add-cols" data-tab="' + esc(t.name) + '" data-fields="release"' + dis + '>Add Release column</button>');
        if (!t.columns.linkedIssue) adds.push('<button data-action="add-cols" data-tab="' + esc(t.name) + '" data-fields="linkedIssue"' + dis + '>Add Linked issue column</button>');
        if (adds.length) h += '<div class="row"><span class="small muted">Optional columns, added at the right of the table:</span>' + adds.join('') + '</div>';
      }
      h += '</section>';
    });
    h += '<div class="row section"><span class="grow"></span>' + (S.cfg ? '<button data-action="view" data-view="run">Cancel</button>' : '') + '<button class="primary" data-action="save-setup"' + dis + '>Save setup</button></div>';
    return h;
  }

  // ---------------------------------------------------------------------------
  // Modal and clipboard
  // ---------------------------------------------------------------------------

  function openModal(html) {
    var m = $('modal');
    m.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true">' + html + '</div>';
    m.classList.remove('hidden');
    var first = m.querySelector('textarea, button.primary, button');
    if (first) first.focus();
  }

  function closeModal() {
    var m = $('modal');
    m.classList.add('hidden');
    m.innerHTML = '';
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  function copyForClaude(kind, opts) {
    api('api_buildPrompt', kind, S.tab, opts).then(function (r) {
      if (!r.ok) { toast(r.error, 'bad'); return; }
      var what = kind === 'paths' ? r.count + ' test cases (ID, feature, type, pre condition, scenario)' : r.count + ' finding(s) and ' + r.related + ' related scenario titles for the duplicate check';
      openModal('<h2>Copy for Claude</h2><p class="small muted" style="margin:6px 0 10px">This is exactly what will be copied: ' + esc(what) + '. Nothing leaves this page until you paste it somewhere. Edit or trim it if you like.</p>' +
        '<label class="sr" for="promptText">Text to copy</label><textarea id="promptText" rows="16">' + esc(r.text) + '</textarea>' +
        '<div class="row" style="margin-top:10px"><span class="small faint">Then paste Claude\'s reply into the Inbox.</span><span class="grow"></span><button data-action="modal-close">Close</button><button class="primary" data-action="copy-prompt">Copy</button></div>');
    });
  }

  function helpModal() {
    var keys = [['J / ↓', 'Next case'], ['K / ↑', 'Previous case'], ['Enter', 'Open or close the case'], ['P', 'Pass'], ['F', 'Fail (then type a comment, Enter saves)'], ['N', 'NA / other'], ['1–9', 'Any status by position'], ['C', 'Comment'], ['U', 'Undo the last mark'], ['/', 'Search'], ['Esc', 'Close / leave a field']];
    openModal('<h2>Keyboard shortcuts</h2><table style="margin-top:10px"><tbody>' + keys.map(function (k) { return '<tr><td><kbd>' + esc(k[0]) + '</kbd></td><td>' + esc(k[1]) + '</td></tr>'; }).join('') + '</tbody></table><div class="row" style="margin-top:12px"><span class="grow"></span><button class="primary" data-action="modal-close">Close</button></div>');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  var ACTIONS = {
    view: function (el) {
      S.view = el.getAttribute('data-view');
      if (S.view === 'setup') S.setup = null;
      render();
      window.scrollTo(0, 0);
    },
    select: function (el) { select(el.getAttribute('data-key')); },
    mark: function (el) { if (S.selected) mark(S.selected, el.getAttribute('data-value')); },
    'save-note': saveNote,
    undo: undo,
    show: function (el) { S.filters.show = el.getAttribute('data-show'); S.keep = {}; render(); },
    tier: function (el) {
      var t = parseInt(el.getAttribute('data-tier'), 10);
      var i = S.filters.tiers.indexOf(t);
      if (i >= 0) S.filters.tiers.splice(i, 1); else S.filters.tiers.push(t);
      S.keep = {};
      render();
    },
    'toggle-path': function (el) { var id = el.getAttribute('data-path'); S.collapsed[id] = !S.collapsed[id]; render(); },
    'collapse-all': function () { S.model.paths.forEach(function (p) { S.collapsed[p.id] = true; }); render(); },
    'expand-all': function () { S.collapsed = {}; render(); },
    help: helpModal,
    'modal-close': closeModal,
    'copy-prompt': function () {
      var t = $('promptText');
      copyText(t ? t.value : '').then(function (ok) {
        if (ok) { closeModal(); toast('Copied. Paste it into Claude, then paste the reply into the Inbox.'); }
        else { t.select(); toast('Press Ctrl+C (Cmd+C on a Mac) to copy the selected text.'); }
      });
    },
    'start-cycle': function () {
      var label = String(val('newCycle')).trim();
      if (!label) { toast('Name the cycle first, for example v2.20.1.'); return; }
      queueWrite(function () { return api('api_startCycle', S.tab, label); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.form.newCycle = '';
        S.keep = {};
        toast('Cycle ' + label + ' started.');
        loadTab(label);
      });
    },
    'save-release': function () {
      var rel = String(val('release', S.model.release)).trim();
      queueWrite(function () { return api('api_setTabPrefs', S.tab, { release: rel }); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        delete S.form.release;
        toast(rel ? 'Release in scope: ' + rel : 'Release cleared.');
        loadTab(cycleLabel(), true);
      });
    },
    'claude-paths': function () { runClaude('paths', { onlyUntested: !!val('planTodo', true), focus: val('planFocus'), cycle: cycleLabel() }); },
    'claude-draft': function () {
      var keys = Object.keys(S.findingSel).filter(function (k) { return S.findingSel[k]; });
      if (keys.length) runClaude('draft', { findingKeys: keys });
    },
    'save-app': function () {
      var st = S.app.settings;
      var body = {
        user: String(val('app:user', st.user)).trim(),
        claude: {
          enabled: !!val('app:enabled', st.claude.enabled),
          draft: { model: val('app:draft.model', st.claude.draft.model), effort: val('app:draft.effort', st.claude.draft.effort) },
          paths: { model: val('app:paths.model', st.claude.paths.model), effort: val('app:paths.effort', st.claude.paths.effort) }
        }
      };
      TR.http('POST', '/api/app', body).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.app = r;
        Object.keys(S.form).forEach(function (k) { if (k.indexOf('app:') === 0 || k.indexOf('cl:') === 0) delete S.form[k]; });
        toast('Saved.');
        render();
      });
    },
    import: function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var send = function (overwrite) {
          return TR.http('POST', '/api/books/import?name=' + encodeURIComponent(f.name) + (overwrite ? '&overwrite=1' : ''), f, true);
        };
        send(false).then(function (r) {
          if (!r.ok && r.code === 'EXISTS' && window.confirm(r.error + ' Replace it with the file you picked?')) return send(true);
          return r;
        }).then(function (r) {
          if (!r) return;
          if (!r.ok) { toast(r.error, 'bad'); return; }
          toast('Imported ' + r.name + '.');
          switchBook(r.name);
        });
      });
      input.click();
    },
    'export-summary': function () {
      TR.http('POST', '/api/export-summary', { book: book(), tab: S.tab, cycle: cycleLabel() }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.exported = r;
        toast('Summary saved as a file you can send.');
        render();
      });
    },
    'copy-paths': function () { copyForClaude('paths', { onlyUntested: !!val('planTodo', true), focus: val('planFocus'), cycle: cycleLabel() }); },
    'clear-plan': function () {
      queueWrite(function () { return api('api_clearPathPlan', S.tab); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        toast('Back to automatic paths.');
        loadTab(cycleLabel(), true);
      });
    },
    'add-finding': function () {
      var text = String(val('fText')).trim();
      if (!text) { toast('Write one line about what you found.'); var f = $('fText'); if (f) f.focus(); return; }
      var input = { text: text, issue: val('fIssue'), area: val('fArea'), details: val('fDetails'), tab: S.tab };
      queueWrite(function () { return api('api_saveFinding', input); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.findings.push(r.finding);
        ['fText', 'fIssue', 'fDetails'].forEach(function (k) { delete S.form[k]; });
        toast('Saved as ' + r.finding.key + '.');
        render();
      });
    },
    'pick-finding': function (el) { var k = el.getAttribute('data-key'); S.findingSel[k] = !S.findingSel[k]; render(); },
    'copy-findings': function () {
      var keys = Object.keys(S.findingSel).filter(function (k) { return S.findingSel[k]; });
      if (!keys.length) return;
      copyForClaude('draft', { findingKeys: keys });
    },
    'del-finding': function (el) {
      var k = el.getAttribute('data-key');
      if (!window.confirm('Delete finding ' + k + '?')) return;
      queueWrite(function () { return api('api_deleteFinding', k); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.findings = S.findings.filter(function (f) { return f.key !== k; });
        render();
      });
    },
    writeup: function (el) {
      var f = S.findings.filter(function (x) { return x.key === el.getAttribute('data-key'); })[0];
      if (!f) return;
      S.manual.push({ scenario: '', issue: f.issue || '', fromFinding: f.key, subFeature: f.area || '', testData: '', preCondition: '', expected: [], hint: f.text });
      S.view = 'inbox';
      render();
      toast('Draft started from ' + f.key + ': "' + f.text.slice(0, 60) + '"');
    },
    'new-manual': function () { S.manual.push({ scenario: '', expected: [] }); render(); },
    'discard-manual': function (el) { S.manual.splice(parseInt(el.getAttribute('data-index'), 10), 1); render(); },
    'add-manual': function (el) {
      var i = parseInt(el.getAttribute('data-index'), 10);
      var d = collectDraft('man:' + i, S.manual[i]);
      if (!d.scenario.trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
      el.disabled = true;
      queueWrite(function () { return api('api_addCases', S.tab, [d], cycleLabel()); }).then(function (r) {
        if (!r.ok) { el.disabled = false; writeError(r); return; }
        S.manual.splice(i, 1);
        Object.keys(S.form).forEach(function (k) { if (k.indexOf('man:') === 0) delete S.form[k]; });
        toast('Added to the workbook as ' + (r.added[0].id || 'row ' + r.added[0].row) + '.');
        loadTab(cycleLabel(), true);
        loadSide();
      });
    },
    'read-reply': function () {
      var text = String(val('reply'));
      if (!text.trim()) { toast('Paste Claude\'s reply first.'); return; }
      api('api_parseReply', S.tab, text).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        delete S.form.reply;
        S.inbox.push(r.entry);
        render();
        toast('Reply read. Review the items below.');
      });
    },
    'accept-item': function (el) { resolveItem(el, 'items', 'accept'); },
    'reject-item': function (el) { resolveItem(el, 'items', 'reject'); },
    'accept-covered': function (el) { resolveItem(el, 'covered', 'accept'); },
    'reject-covered': function (el) { resolveItem(el, 'covered', 'reject'); },
    'use-plan': function (el) {
      var key = el.getAttribute('data-entry');
      queueWrite(function () { return api('api_usePathPlan', key); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.inbox = S.inbox.filter(function (x) { return x.key !== key; });
        S.view = 'run';
        toast('Path plan saved. Run now follows it.');
        loadTab(cycleLabel(), true);
      });
    },
    'discard-entry': function (el) {
      var key = el.getAttribute('data-entry');
      if (!window.confirm('Discard everything in this pasted reply?')) return;
      queueWrite(function () { return api('api_deleteInbox', key); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.inbox = S.inbox.filter(function (x) { return x.key !== key; });
        render();
      });
    },
    'write-summary': function () {
      queueWrite(function () { return api('api_writeSummaryTab', S.tab, cycleLabel()); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        toast('The "' + r.sheet + '" tab in the workbook is up to date.');
      });
    },
    print: function () { window.print(); },
    redetect: function (el) {
      var ti = parseInt(el.getAttribute('data-index'), 10);
      var t = S.setup.tabs[ti];
      api('api_detectTab', t.name, t.headerRow).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        t.columns = r.columns;
        t.top = r.top;
        render();
        toast('Columns detected from row ' + t.headerRow + '.');
      });
    },
    'add-cols': function (el) {
      var tab = el.getAttribute('data-tab');
      var fields = el.getAttribute('data-fields').split(',');
      queueWrite(function () { return api('api_addColumns', tab, fields); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        toast(r.added.length ? 'Added: ' + r.added.map(function (f) { return S.boot.labels[f]; }).join(', ') + '.' : 'Those columns already exist.');
        refreshBoot();
      });
    },
    'save-setup': function () {
      var d = S.setup;
      var payload = {
        issueBase: d.issueBase,
        tabs: d.tabs.map(function (t) { return { name: t.name, role: t.role, headerRow: t.headerRow, columns: t.columns, fillDown: t.fillDown }; })
      };
      if (!payload.tabs.some(function (t) { return t.role === 'manual' && t.columns.scenario; })) {
        toast('Mark at least one tab as Test cases, with a Scenario column.', 'bad');
        return;
      }
      queueWrite(function () { return api('api_saveSetup', payload); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.cfg = r.config;
        toast('Setup saved.');
        refreshBoot(true);
      });
    }
  };

  function refreshBoot(goRun) {
    api('api_bootstrap').then(function (b) {
      if (!b.ok) { toast(b.error, 'bad'); return; }
      S.boot = b;
      S.cfg = b.config;
      S.setup = null;
      var tabs = runTabs();
      if (!tabs.some(function (t) { return t.name === S.tab; })) S.tab = tabs[0] ? tabs[0].name : null;
      if (goRun) { S.view = 'run'; window.scrollTo(0, 0); }
      if (S.tab) loadTab(cycleLabel()); else render();
    });
  }

  function switchBook(name) {
    return TR.http('POST', '/api/books/select', { name: name }).then(function (a) {
      if (!a.ok) { toast(a.error, 'bad'); return; }
      S.app = a;
      TR.state.book = name;
      S.selected = null;
      S.keep = {};
      S.undo = [];
      S.findings = [];
      S.inbox = [];
      sideSeen = { findings: null, inbox: null };
      S.manual = [];
      S.setup = null;
      S.summary = null;
      S.exported = null;
      S.filters.type = '';
      S.view = 'run';
      boot(TR.store.get('tab:' + name), '');
    });
  }

  var CHANGES = {
    book: function (el) { if (el.value) switchBook(el.value); },
    tab: function (el) {
      S.tab = el.value;
      TR.store.set('tab:' + book(), S.tab);
      S.selected = null;
      S.keep = {};
      S.undo = [];
      S.model = null;
      S.filters.type = '';
      loadTab('');
    },
    cycle: function (el) {
      var c = S.model.cycles[parseInt(el.value, 10)];
      if (!c) return;
      S.keep = {};
      S.undo = [];
      if (S.model.configured && !S.readOnly) api('api_setTabPrefs', S.tab, { cycle: c.label });
      loadTab(c.label);
    },
    type: function (el) { S.filters.type = el.value; render(); }
  };

  document.addEventListener('click', function (e) {
    var modal = $('modal');
    if (modal && e.target === modal) { closeModal(); return; }
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') { ACTIONS[el.getAttribute('data-action')](el, e); return; }
    var fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.hasAttribute('data-change')) { CHANGES[el.getAttribute('data-change')](el); return; }
    if (el.hasAttribute('data-bind')) { S.form[el.getAttribute('data-bind')] = el.type === 'checkbox' ? el.checked : el.value; return; }
    if (el.hasAttribute('data-setup')) {
      var k = el.getAttribute('data-setup');
      S.setup[k] = el.type === 'checkbox' ? el.checked : el.value;
      return;
    }
    if (el.hasAttribute('data-setup-tab')) {
      var t = S.setup.tabs[parseInt(el.getAttribute('data-setup-tab'), 10)];
      var key = el.getAttribute('data-key');
      if (key === 'col') { var f = el.getAttribute('data-field'); if (el.value) t.columns[f] = el.value; else delete t.columns[f]; }
      else if (key === 'fillDown') t.fillDown = el.checked;
      else if (key === 'headerRow') { t.headerRow = Math.min(Math.max(parseInt(el.value, 10) || 1, 1), 50); render(); }
      else if (key === 'role') { t.role = el.value; render(); }
    }
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'search') { S.filters.search = el.value; S.keep = {}; render(); return; }
    if (el.hasAttribute('data-bind') && el.type !== 'checkbox') S.form[el.getAttribute('data-bind')] = el.value;
    if (el.hasAttribute('data-setup') && el.type !== 'checkbox') S.setup[el.getAttribute('data-setup')] = el.value;
    if ((el.hasAttribute('data-comment') || el.hasAttribute('data-issue')) && S.selected) {
      var d = S.drafts[S.selected] || (S.drafts[S.selected] = {});
      if (el.hasAttribute('data-comment')) d.comment = el.value; else d.issue = el.value;
    }
  });

  document.addEventListener('keydown', function (e) {
    var modalOpen = !$('modal').classList.contains('hidden');
    if (e.key === 'Escape' && modalOpen) { closeModal(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || modalOpen) return;
    var t = e.target && e.target.matches ? e.target : document.body;
    if (t.matches('input, textarea, select')) {
      if (e.key === 'Escape') { t.blur(); return; }
      if (e.key === 'Enter' && !e.shiftKey && (t.hasAttribute('data-comment') || t.hasAttribute('data-issue'))) { e.preventDefault(); t.blur(); saveNote(); }
      if (e.key === 'Enter' && t.id === 'fText') { e.preventDefault(); ACTIONS['add-finding'](); }
      return;
    }
    if (S.view !== 'run' || !S.model) return;
    var k = e.key;
    if ((k === 'Enter' || k === ' ') && t.classList && t.classList.contains('case')) { e.preventDefault(); select(t.getAttribute('data-key'), true); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (k === '/') { e.preventDefault(); var s = $('search'); if (s) s.focus(); return; }
    if (k === '?') { helpModal(); return; }
    if (k === 'u') { undo(); return; }
    if (k === 'Escape') { S.selected = null; render(); return; }
    if (!S.selected) return;
    if (k === 'c') { if ($('comment')) { e.preventDefault(); focusComment(); } return; }
    var o = S.model.statusOptions.filter(function (x) { return x.key === k.toLowerCase() || x.num === k; })[0];
    if (o) { e.preventDefault(); mark(S.selected, o.value); }
  });

  window.__TR_STATE = S; // for the browser tests
  init();
})();
