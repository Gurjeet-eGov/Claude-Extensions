/* Test Run console: the page. Talks only to the local Test Run server (TR.api / TR.http). */
(function () {
  'use strict';

  var esc = TR.esc;
  var api = TR.api;
  var PARAMS = {};
  new URLSearchParams(location.search).forEach(function (v, k) { PARAMS[k] = v; });
  var VIEWS = [
    { id: 'run', label: 'Run' },
    { id: 'issues', label: 'Known issues' },
    { id: 'findings', label: 'Findings' },
    { id: 'summary', label: 'Summary' },
    { id: 'setup', label: 'Setup', owner: true }
  ];

  var S = {
    app: null,
    boot: null,
    cfg: null,
    excelOpen: false,
    usage: {},
    tab: null,
    model: null,
    byKey: {},
    view: 'run',
    loading: true,
    filters: { show: 'todo', tiers: [], type: '', search: '' },
    keep: {},
    collapsed: {},
    selected: null,
    caseTool: null, // { key, mode: 'edit' | 'deprecate' | 'duplicate' } open on the selected case
    scrollToSel: false,
    pending: {},
    undo: [],
    drafts: {},
    form: {},
    readOnly: false,
    findings: [],
    manual: [],
    connect: null, // why the page could not reach a server ({ code }): the published reports are shown instead
    reportsMode: PARAMS.reports === '1', // ?reports=1: show what anyone sees on the published site
    reports: null, // the published reports: { index, data: { slug: report } }
    writeUp: {}, // finding key -> draft test case being written up
    covering: null, // finding key being marked as already covered
    issues: null, // Known issues: { issues, tabs, fetching, github } from the server
    suites: {}, // other test suites of the workbook, read for Findings: tab -> { fields, statusOptions, cycle, cases, ... }
    suiteLoading: {},
    issueEdit: null, // key of the issue whose title/priority is being edited
    teamLink: null, // { name, link } just made in Setup → Team, shown once
    team: null, // Setup → Team, for the owner
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
  function me() { return (S.app && S.app.me) || { name: '', role: 'owner', local: true }; }
  /** The person running Test Run on this laptop (Setup, cycles, workbooks are theirs). */
  function isOwner() { return me().role === 'owner'; }
  function book() { return TR.state.book; }
  function hasField(f) { return !!(S.model && S.model.fields && S.model.fields[f] >= 0); }
  function roleOf(t) { return (t.saved && t.saved.role) || t.detected.role; }
  function runTabs() { return S.boot ? S.boot.tabs.filter(function (t) { return roleOf(t) === 'manual'; }) : []; }
  function opt(value, label, selected) { return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function pill(cls, text, title) { return '<span class="pill ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  function val(path, fallback) { return Object.prototype.hasOwnProperty.call(S.form, path) ? S.form[path] : (fallback == null ? '' : fallback); }

  function isTodo(c) { return !c.retired && clsOf(c) === 'none'; }
  function liveCases() { return S.model.cases.filter(function (c) { return !c.retired; }); }
  function caseLabel(c) { return c.id || ('row ' + c.row); }
  function retiredLabel(r) { return r.kind === 'duplicate' ? 'Duplicate of ' + r.of : r.kind === 'deprecated' ? 'Deprecated' : 'Struck out'; }
  /** The same note line the server writes first in the comment. */
  function isRetireNote(text) { return /^(deprecated|duplicate of\s+.+?)\s*(?::.*)?$/i.test(String(text || '').split(/\r?\n/)[0].trim()); }

  /** A case by what a tester types: its ID (any case) or its key. */
  function findCase(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q || !S.model) return null;
    return S.model.cases.filter(function (c) { return (c.id && c.id.toLowerCase() === q) || c.key.toLowerCase() === q; })[0] || null;
  }

  /**
   * What a form or a finding needs from a test suite: its columns, result values, cycle and
   * cases. The open suite comes from the page; another is read once (null until it arrives).
   */
  function suiteOf(tab) {
    if (!tab || tab === S.tab) {
      if (!S.model) return null;
      var cy = cur();
      return { tab: S.tab, fields: S.model.fields, statusOptions: S.model.statusOptions, cycle: cy ? cy.label : '', hasCycle: !!cy, hasComment: !!(cy && cy.hasComment), cases: liveCases() };
    }
    if (S.suites[tab]) return S.suites[tab];
    if (!S.suiteLoading[tab]) {
      S.suiteLoading[tab] = true;
      TR.http('GET', '/api/suite-cases?book=' + encodeURIComponent(book()) + '&tab=' + encodeURIComponent(tab)).then(function (r) {
        delete S.suiteLoading[tab];
        if (r.ok) S.suites[tab] = { tab: r.tab, fields: r.fields || {}, statusOptions: r.statusOptions || [], cycle: r.cycle || '', hasCycle: !!r.hasCycle, hasComment: !!r.hasComment, cases: r.cases || [] };
        else toast(r.error, 'bad');
        render();
      });
    }
    return null;
  }

  /** A case of a suite by its ID or key. */
  function findIn(cases, text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    return (cases || []).filter(function (c) { return (c.id && c.id.toLowerCase() === q) || c.key.toLowerCase() === q; })[0] || null;
  }

  // Similar scenarios, for "Duplicate of…" suggestions (same idea as the server's duplicate hints).
  var STOP = ('verify if that whether the a an of in on for and or to is are be able user users shall should when with by from it its as at this then').split(' ');
  function tokens(s) {
    var out = {};
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').forEach(function (t) { if (t && STOP.indexOf(t) < 0) out[t.replace(/s$/, '')] = true; });
    return out;
  }
  function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b), inter = 0, union = 0, k;
    for (k in ta) { union++; if (tb[k]) inter++; }
    for (k in tb) { if (!ta[k]) union++; }
    return union ? inter / union : 0;
  }
  /** Cases whose scenario is like this text: [{ c, score }], best first. */
  function similarIn(cases, text, n) {
    return (cases || [])
      .map(function (x) { return { c: x, score: similarity(text, x.scenario) }; })
      .filter(function (x) { return x.score >= 0.2; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, n);
  }

  function similarCases(c, n) {
    return liveCases()
      .filter(function (x) { return x !== c; })
      .map(function (x) { return { c: x, score: similarity(c.scenario, x.scenario) }; })
      .filter(function (x) { return x.score >= 0.2; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, n)
      .map(function (x) { return x.c; });
  }

  /** A scenario written on several lines, on one line for the case list: "details: Type · Date · Status". */
  function oneLine(text) {
    return TR.cellLines(text).filter(function (l) { return l.trim(); }).reduce(function (acc, l) {
      l = l.trim();
      return !acc ? l : acc + (/:$/.test(acc) ? ' ' : ' · ') + l;
    }, '');
  }

  function clearForm(prefix) { Object.keys(S.form).forEach(function (k) { if (k.indexOf(prefix) === 0) delete S.form[k]; }); }

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
    start();
    setInterval(checkVersion, 10000);
    window.addEventListener('focus', checkVersion);
    // An invite link opened in a tab that already shows the console only changes the #… part.
    window.addEventListener('hashchange', function () {
      if (!/[#&]join=/.test(window.location.hash)) return;
      TR.useInvite(window.location.hash).then(function () {
        try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* keep it */ }
        TR.state.authFailed = false;
        S.connect = null;
        S.app = null; S.boot = null; S.model = null; S.findings = []; sideSeen = { findings: null };
        start();
      });
    });
  }

  /** Find the server, then load the app and the workbook. */
  function start() {
    render();
    TR.connect().then(function (c) {
      if (!c.ok) { S.loading = false; S.connect = c; render(); return; }
      S.connect = null;
      return TR.http('GET', '/api/app').then(function (a) {
        if (!a.ok) { S.loading = false; S.fatal = a.error; render(); return; }
        S.app = a;
        S.readOnly = a.me && a.me.role === 'viewer';
        var names = a.books.map(function (b) { return b.name; });
        // The workbook this browser had open last (each person keeps their own), else the owner's.
        var mine = TR.store.get('book');
        var want = names.indexOf(PARAMS.book) >= 0 ? PARAMS.book : names.indexOf(mine) >= 0 ? mine : (names.indexOf(a.last.book) >= 0 ? a.last.book : names[0]);
        TR.state.book = want || null;
        if (!want) { S.loading = false; render(); return; }
        boot(PARAMS.tab || TR.store.get('tab:' + want) || a.last.tab, PARAMS.cycle || '');
      });
    });
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
      if (!S.cfg && isOwner()) S.view = 'setup';
      else if (PARAMS.view && VIEWS.some(function (v) { return v.id === PARAMS.view && (!v.owner || isOwner()); })) S.view = PARAMS.view;
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

  /** Findings live beside the workbook; redraw only when they changed. */
  var sideSeen = { findings: null };
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
  }

  function checkVersion() {
    if (TR.state.authFailed && !S.connect) { S.connect = { code: 'BAD_KEY' }; render(); return; }
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
      if (S.view === 'issues') loadIssues();
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
    S.wide = false;
    var b = body();
    app.innerHTML = topbar() + '<main id="main"' + (S.wide ? ' class="wide"' : '') + '>' + b + '</main>' + readyBubble();
    shareSelection();
    var tb = document.querySelector('.topbar');
    if (tb) document.documentElement.style.setProperty('--header-h', tb.offsetHeight + 'px');
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

  /** Test Run Extension follows what this person has open: workbook, suite, cycle and case. */
  var selSent = '';
  function shareSelection() {
    if (!S.app || S.connect || S.reportsMode || !S.model || S.model.tab !== S.tab || S.autoMode) return;
    var v = { book: book() || '', tab: S.tab || '', cycle: cycleLabel(), caseKey: S.selected || '' };
    var sig = JSON.stringify(v);
    if (sig === selSent) return;
    selSent = sig;
    TR.http('POST', '/api/current', v);
  }

  /** Bottom right, once a Complete Report is ready: a link that downloads it. */
  function readyBubble() {
    if (!S.crReady) return '';
    return '<div class="ready-bubble" role="status"><span class="rb-ico" aria-hidden="true">⤓</span><span>Download is ready, click <a href="#" data-action="cr-download" data-book="' + esc(S.crReady.book) + '">here</a></span>' +
      '<button class="ghost small-btn" data-action="cr-dismiss" aria-label="Dismiss">✕</button></div>';
  }

  /** Download for the host is a menu: the workbook now, or the workbook with its evidence (a zip, made in the background). */
  function downloadButton(where, cls, label, title) {
    if (!isOwner()) return '<button' + (cls ? ' class="' + cls + '"' : '') + ' data-action="download" title="' + esc(title) + '">' + label + '</button>';
    var open = S.dlMenu === where;
    return '<span class="dl-wrap"><button' + (cls ? ' class="' + cls + '"' : '') + ' data-action="dl-menu" data-where="' + where + '" aria-haspopup="menu" aria-expanded="' + open + '">' + label + ' <span class="caret" aria-hidden="true">▾</span></button>' +
      (open ? '<div class="dl-menu" role="menu">' +
        '<button role="menuitem" data-action="download"><b>Summary Report</b><span>The workbook (.xlsx), right away</span></button>' +
        '<button role="menuitem" data-action="complete-report"><b>Complete Report</b><span>Workbook and its screenshots and recordings (.zip)</span></button></div>' : '') + '</span>';
  }

  function topbar() {
    var h = '<header class="topbar' + (S.connect || S.reportsMode ? ' reports' : '') + '"><div class="topbar-row"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Test Run</span></div><span class="grow"></span>';
    if (S.connect || S.reportsMode) return reportsTopbar(h);
    if (S.app) {
      var books = S.app.books;
      var cur = book() || '';
      // The workbook (one per environment, say): anyone signed in can switch.
      h += '<div class="book-switch"><label for="bookPick">Workbook' + (books.length > 1 ? ' <span class="n">' + books.length + '</span>' : '') + '</label>' +
        '<select id="bookPick" data-change="book" title="' + esc(cur.replace(/\.xlsx$/i, '') || 'Workbook') + '">' +
        (books.length ? books.map(function (x) { return opt(x.name, x.name.replace(/\.xlsx$/i, ''), x.name === cur); }).join('') : '<option value="">No workbooks yet</option>') + '</select></div>' +
        (isOwner() ? '<button class="tb-btn" data-action="import" title="Add one or more .xlsx workbooks, for example one per environment"><span aria-hidden="true">⤒</span> Import</button>' : '') +
        (cur ? downloadButton('top', 'tb-btn', '<span aria-hidden="true">⤓</span> Download', 'Download this workbook (with a Known issues sheet), e.g. to upload it to Google Sheets') : '');
    }
    h += userMenu() + '</div>';
    h += '<nav class="nav" aria-label="Screens">' + VIEWS.filter(function (v) { return !v.owner || isOwner(); }).map(function (v) {
      var n = v.id === 'findings' ? S.findings.filter(function (f) { return f.state === 'open'; }).length
        : v.id === 'issues' && S.issues && S.issues.issues ? S.issues.issues.filter(function (e) { return e.state !== 'closed'; }).length : 0;
      return '<button data-action="view" data-view="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '>' + v.label + (n ? ' <span class="count">' + n + '</span>' : '') + '</button>';
    }).join('') + '</nav>';
    return h + contextBar() + '</header>';
  }

  /** Who is signed in, top right; hovering (or focusing) it shows the role and Sign out. */
  function userMenu() {
    var who = me();
    if (!S.app || !who.name) return '';
    var role = who.local ? 'Host, on this laptop' : who.admin ? 'Admin (your admin link)' : who.role === 'viewer' ? 'View only' : 'Updates status';
    var initial = (String(who.name).trim()[0] || '?').toUpperCase();
    return '<div class="user-menu"><button class="user-btn" aria-haspopup="menu" title="' + esc(who.name + ' · ' + role) + '"><span class="avatar" aria-hidden="true">' + esc(initial) + '</span><span class="user-name">' + esc(who.name) + '</span><span class="caret" aria-hidden="true">▾</span></button>' +
      '<div class="user-pop" role="menu"><div class="user-head"><b>' + esc(who.name) + '</b><span class="small muted">' + esc(role) + '</span></div>' +
      (who.local
        ? '<button role="menuitem" data-action="user-rename">Change your name</button><div class="user-note small faint">On this laptop you are always signed in as the host.</div>'
        : '<button role="menuitem" class="danger" data-action="sign-out">Sign out</button>') +
      '</div></div>';
  }

  /**
   * Under the screen tabs, while testing: which test case tab (a module, say PGR or
   * Trade License) and which cycle, and how far the run is. Stays in view while scrolling.
   */
  function contextBar() {
    if (!S.boot || S.connect || ['run', 'summary'].indexOf(S.view) < 0) return '';
    var tabs = runTabs();
    if (!tabs.length) return '';
    var m = S.model;
    var h = '<div class="context"><div class="context-row">';
    var hasAuto = S.view === 'summary' && S.boot.tabs.some(function (t) { return roleOf(t) === 'automation'; }); // automation is a summary, not something to run
    h += '<span class="ctx-label" id="tabsLabel">Test suites</span><div class="ctx-tabs" role="tablist" aria-labelledby="tabsLabel">' + tabs.map(function (t) {
      var on = t.name === S.tab && !S.autoMode;
      return '<button class="ctx-tab' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-action="pick-tab" data-tab="' + esc(t.name) + '" title="' + esc(t.name) + '">' + esc(TR.tabLabel(t.name)) + '</button>';
    }).join('') +
      (hasAuto ? '<span class="ctx-sep" aria-hidden="true"></span><button class="ctx-tab auto' + (S.autoMode ? ' on' : '') + '" role="tab" aria-selected="' + !!S.autoMode + '" data-action="pick-auto" title="Overall summary of the automated test results in this workbook">Automation</button>' : '') +
      '</div><span class="grow"></span>';
    if (S.autoMode) {
      var a = autoTotals();
      if (S.autoSummary && S.autoSummary.book === book()) h += autoCycleSwitch(S.autoSummary);
      h += '</div>' + (a ? '<div class="progress-wrap">' + TR.bar(a) + TR.legend(a) + '<span class="small muted"><b>' + a.total + '</b> automated tests</span></div>' : '');
      return h + '</div>';
    }
    if (m && m.cycles.length) {
      h += '<div class="cycle-switch"><label for="cyclePick">Test cycle</label><select id="cyclePick" data-change="cycle" title="Test cycle (a status and comment column pair)">' +
        m.cycles.map(function (c, i) { return opt(i, c.label ? 'Cycle ' + c.label : 'Status', i === m.cycleIdx); }).join('') + '</select></div>';
    } else if (m) {
      h += '<span class="small muted">No test cycle yet' + (isOwner() ? ': <button class="linkish" data-action="view" data-view="setup">start one in Setup</button>' : '') + '</span>';
    }
    h += '</div>';
    if (m && m.cases.length && m.cycles.length) {
      var live = liveCases();
      var c = TR.counts(live.map(clsOf));
      var done = Math.round(((c.total - c.none) / (c.total || 1)) * 100);
      var nRet = m.cases.length - live.length;
      h += '<div class="progress-wrap">' + TR.bar(c) + TR.legend(c) +
        (nRet && S.view === 'run' ? '<span class="small muted" title="Deprecated or duplicate cases: struck out in the workbook and left out of these figures"><span class="sym-none">⊘</span> <b>' + nRet + '</b> retired</span>' : '') +
        '<span class="small muted"><b>' + done + '%</b> done</span></div>';
    }
    return h + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Published reports: for anyone, with or without an access link, also when no Test Run runs
  // ---------------------------------------------------------------------------

  function loadReports() {
    if (S.reportsLoading) return;
    S.reportsLoading = true;
    fetch('reports/index.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (idx) {
        S.reportsLoading = false;
        S.reports = { index: idx && Array.isArray(idx.workbooks) && idx.workbooks.length ? idx : null, data: {} };
        render();
      });
  }

  function reportBook(slug) {
    var r = S.reports;
    if (r.data[slug]) return r.data[slug];
    if (!r.loading) {
      r.loading = slug;
      fetch('reports/' + encodeURIComponent(slug) + '.json', { cache: 'no-store' })
        .then(function (x) { return x.ok ? x.json() : null; })
        .catch(function () { return null; })
        .then(function (d) { r.loading = null; r.data[slug] = d || { error: 'This report could not be read.' }; render(); });
    }
    return null;
  }

  /** What the reports view shows now: the workbook, its report, the suite (or Automation) and cycle. */
  function reportPick() {
    var idx = S.reports && S.reports.index;
    if (!idx) return null;
    var slug = val('rBook', '');
    var w = idx.workbooks.filter(function (x) { return x.slug === slug; })[0] || idx.workbooks[0];
    var d = reportBook(w.slug);
    var out = { idx: idx, w: w, d: d };
    if (!d || d.error) return out;
    out.suites = d.suites || [];
    out.auto = !!(val('rAuto', false) && d.automation);
    var sname = val('rSuite:' + w.slug, '');
    out.suite = out.suites.filter(function (x) { return x.tab === sname; })[0] || out.suites[0] || null;
    out.cyc = out.suite ? val('rCycle:' + w.slug + ':' + out.suite.tab, out.suite.current) : '';
    out.sum = out.suite ? (out.suite.summaries[out.cyc] || out.suite.summaries[out.suite.current]) : null;
    return out;
  }

  /** The Test cycle of Automation: results are read from each automation tab's latest status column. */
  function autoCycleSwitch(r) {
    var acyc = [];
    (r && r.tabs || []).forEach(function (t) { if (t.error) return; var l = t.cycle ? 'Cycle ' + t.cycle : 'Latest results'; if (acyc.indexOf(l) < 0) acyc.push(l); });
    if (!acyc.length) return '';
    return '<div class="cycle-switch"><label for="autoCycle">Test cycle</label><select id="autoCycle" title="The latest status column of the automation results">' + acyc.map(function (l) { return opt(l, l, false); }).join('') + '</select></div>';
  }

  /** The top bar of the reports view: like every screen, with the workbook picker top right. */
  function reportsTopbar(h) {
    var pk = reportPick();
    if (pk) {
      var n = pk.idx.workbooks.length;
      h += '<div class="book-switch"><label for="rBook">Workbook' + (n > 1 ? ' <span class="n">' + n + '</span>' : '') + '</label><select id="rBook" data-change="r-book" title="' + esc(pk.w.title) + '">' +
        pk.idx.workbooks.map(function (x) { return opt(x.slug, x.title, x.slug === pk.w.slug); }).join('') + '</select></div>';
    }
    h += '</div>';
    if (pk && pk.d && !pk.d.error && (pk.suites.length || pk.d.automation)) {
      h += '<div class="context"><div class="context-row"><span class="ctx-label">Test suites</span><div class="ctx-tabs" role="tablist">' +
        pk.suites.map(function (x) { var on = !pk.auto && pk.suite && x.tab === pk.suite.tab; return '<button class="ctx-tab' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-action="r-suite" data-tab="' + esc(x.tab) + '" title="' + esc(x.tab) + '">' + esc(TR.tabLabel(x.tab)) + '</button>'; }).join('') +
        (pk.d.automation ? '<span class="ctx-sep" aria-hidden="true"></span><button class="ctx-tab auto' + (pk.auto ? ' on' : '') + '" role="tab" aria-selected="' + pk.auto + '" data-action="r-auto">Automation</button>' : '') +
        '</div><span class="grow"></span>';
      if (!pk.auto && pk.suite && pk.suite.cycles.length) {
        h += '<div class="cycle-switch"><label for="rCycle">Test cycle</label><select id="rCycle" data-change="r-cycle">' + pk.suite.cycles.map(function (cl) { return opt(cl, cl ? 'Cycle ' + cl : 'Status', cl === pk.cyc); }).join('') + '</select></div>';
      } else if (pk.auto) {
        h += autoCycleSwitch(pk.d.automation);
      }
      h += '</div>';
      var c = pk.auto ? autoTotals(pk.d.automation) : pk.sum ? pk.sum.summary.counts : null;
      if (c && c.total) {
        var done = Math.round(((c.total - c.none) / c.total) * 100);
        h += '<div class="progress-wrap">' + TR.bar(c) + TR.legend(c) + '<span class="small muted"><b>' + (pk.auto ? c.total + '</b> automated tests' : done + '%</b> done') + '</span></div>';
      }
      h += '</div>';
    }
    return h + '</header>';
  }

  /** The summary with no data (nothing is published): dashes in the figures, empty tables. */
  function emptyReport() {
    var none = function (cols) { return '<tr><td class="no-data" colspan="' + cols + '">No data available</td></tr>'; };
    var kpi = function (label) { return '<div class="card kpi"><div class="v">–</div><div class="l">' + esc(label) + '</div></div>'; };
    return '<div class="report-tools no-print"><span class="updated">Updated on: –</span><span class="grow"></span></div>' +
      '<div class="kpis">' + kpi('executed') + kpi('pass rate (of Pass + Fail)') + kpi('failing now') + kpi('not run yet') + '</div>' +
      '<div class="card card-pad"><div class="row" style="margin-bottom:8px"><h2>All cases</h2></div><div class="bar empty-bar"></div></div>' +
      '<div class="section card"><div class="card-pad"><h2>By feature</h2></div><div class="table-wrap"><table><thead><tr><th>Feature</th><th style="width:30%">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Other</th><th class="num">Not run</th><th class="num">Pass rate</th></tr></thead><tbody>' + none(7) + '</tbody></table></div></div>' +
      '<div class="section card"><div class="card-pad"><h2>Open failures</h2></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Scenario</th><th>Comment</th><th>Issue</th></tr></thead><tbody>' + none(4) + '</tbody></table></div></div>';
  }

  /** The published reports, for anyone. c: why Test Run itself is not shown (or null when asked for). */
  function viewReports(c) {
    var conn = TR.conn();
    var why = !c ? '' : {
      UNREACHABLE: 'Your Test Run is offline right now (its laptop may be asleep or restarting). These are the last published reports.',
      BAD_KEY: 'Your access link no longer works: ask your test lead for a new one. Meanwhile, these are the published reports.',
      BAD_LINK: 'That is not an access link. An access link ends in #join=… : copy the whole link.',
      SIGNED_OUT: 'You are signed out. Paste your access link to sign in again.'
    }[c.code] || '';
    var h = '<div class="access-card"><span class="access-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><circle cx="8" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12h9M18 12v3M21 12v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>' +
      '<div class="access-text"><b>Sign in to Test Run</b><span>Paste the access link your test lead sent you.</span></div>' +
      '<div class="access-form"><label class="sr" for="inviteLink">Access link</label><input id="inviteLink" data-bind="inviteLink" placeholder="Paste your access link" value="' + esc(val('inviteLink')) + '"><button class="primary" data-action="use-invite">Sign in</button></div>' +
      (why || (conn.hasKey && c) ? '<div class="access-note">' + (why ? '<span class="' + (c.code === 'BAD_LINK' ? 'bad-text' : '') + '">' + esc(why) + '</span>' : '') +
        (c && c.code === 'UNREACHABLE' ? '<button class="linkish" data-action="retry-connect">Try again</button>' : '') +
        (conn.hasKey && c ? '<button class="linkish" data-action="forget-invite">Forget the access link kept in this browser</button>' : '') + '</div>' : '') + '</div>';
    if (!S.reports) { loadReports(); return h + '<div class="loading section">Loading the published reports…</div>'; }
    var pk = reportPick();
    if (!pk) return h + '<div class="section">' + emptyReport() + '</div>';
    if (!pk.d) return h + '<div class="loading section">Loading ' + esc(pk.w.title) + '…</div>';
    if (pk.d.error) return h + '<div class="banner bad section">' + esc(pk.d.error) + '</div>';
    // The suite and cycle are picked above, so no title here; on paper, one line says what it is.
    var published = 'published ' + pk.idx.publishedAt + (pk.idx.by ? ' by ' + pk.idx.by : '');
    var tools = '<div class="report-tools no-print"><span class="updated">Updated on: ' + esc(pk.idx.publishedAt) + '</span><span class="grow"></span>' + (pk.w.xlsx ? '<a class="btn" href="reports/' + encodeURIComponent(pk.w.slug) + '.xlsx" download="' + esc(pk.w.title) + '.xlsx" title="The workbook as published, with a Known issues sheet">Download</a>' : '') +
      '<button data-action="print">Print / PDF</button></div>';
    if (pk.auto) return h + '<div class="section">' + tools + '<div class="print-only print-title">' + esc(pk.w.title) + ' · Automation · ' + esc(published) + '</div>' + automationHtml(pk.d.automation, { live: false, bare: true }) + '</div>';
    if (!pk.suite) return h + '<div class="empty card section"><p>This workbook has no test suites.</p></div>';
    if (!pk.sum) return h + '<div class="empty card section"><p>No summary for this cycle.</p></div>';
    var sum = pk.sum;
    return h + '<div class="section">' + tools + '<div class="print-only print-title">' + esc(pk.w.title) + ' · ' + esc(sum.tab) + ' · cycle ' + esc(sum.cycle || '–') + ' · ' + esc(published) + '</div>' + TR.summaryHtml(sum) + '</div>';
  }

  function body() {
    if (S.connect || S.reportsMode) return viewReports(S.connect);
    if (S.fatal) return '<div class="banner bad"><div><b>The console could not start.</b><div class="small">' + esc(S.fatal) + '</div></div></div>';
    if (S.app && !S.app.books.length) {
      if (!isOwner()) return '<div class="empty card"><h3>No workbooks yet</h3><p>Your test lead has not added a workbook to this Test Run yet.</p></div>';
      var pubd = S.app.published;
      return '<div class="empty card"><h3>No workbooks yet</h3>' +
        (pubd ? '<p>This copy has published data: <b>' + esc(pubd.workbooks.map(function (n) { return n.replace(/\.xlsx$/i, ''); }).join(', ')) + '</b>, published by ' + esc(pubd.by || 'someone') + ' at ' + esc(pubd.at) + '.</p><p style="margin-top:12px"><button class="primary" data-action="start-from-published">Start from the published data</button></p><p class="small faint" style="margin-top:14px">Or start fresh:</p>' : '') +
        '<p>Put your test case <b>.xlsx</b> files in<br><span class="mono">' + esc(S.app.sheetsDir) + '</span><br>or import one here. They stay on this computer; only what you publish goes to GitHub.</p><p style="margin-top:14px"><button class="' + (pubd ? '' : 'primary') + '" data-action="import">Import a workbook</button></p></div>';
    }
    if (!S.boot) return '<div class="loading">Loading the workbook…</div>';
    var banners = '';
    if (S.readOnly) banners += me().role === 'viewer'
      ? '<div class="banner"><b>View only.</b><span class="muted">You can follow the run and the summary. Results are marked by testers.</span></div>'
      : '<div class="banner warn"><b>View only.</b><span class="muted">This workbook file is read-only on this computer, so results cannot be saved.</span></div>';
    if (S.app && S.app.publishNotice && isOwner()) banners += '<div class="banner"><span><b>' + esc(S.app.publishNotice.by || 'Someone') + '</b> published newer data to GitHub at ' + esc(S.app.publishNotice.at) + '.</span><span class="grow"></span><button data-action="publish-get">Get it</button></div>';
    if (S.excelOpen) banners += '<div class="banner warn"><b>This workbook is open in Excel.</b><span class="muted">Close it there while you test: saving from Excel would overwrite results marked here.</span></div>';
    if (S.view === 'setup' && isOwner()) return banners + viewSetup();
    if (!S.tab) return banners + (isOwner()
      ? '<div class="empty card"><h3>No test case tab found</h3><p>Open Setup and mark which tabs hold test cases.</p><p style="margin-top:12px"><button class="primary" data-action="view" data-view="setup">Open Setup</button></p></div>'
      : '<div class="empty card"><h3>No test case tab yet</h3><p>Your test lead has not set up this workbook yet.</p></div>');
    if (S.loading && !S.model) return '<div class="loading">Loading ' + esc(S.tab) + '…</div>';
    if (!S.model) return '';
    var m = S.model;
    if (!m.configured && isOwner()) banners += '<div class="banner"><span>Columns for this tab were detected automatically.</span><span class="grow"></span><button data-action="view" data-view="setup">Check Setup</button></div>';
    if (m.missing && m.missing.length) banners += '<div class="banner bad"><span>These columns were renamed or removed in the workbook: <b>' + esc(m.missing.map(function (f) { return S.boot.labels[f]; }).join(', ')) + '</b>.</span><span class="grow"></span>' + (isOwner() ? '<button data-action="view" data-view="setup">Fix in Setup</button>' : '') + '</div>';
    if (S.autoMode && S.view === 'summary') return banners + viewAutomation();
    switch (S.view) {
      case 'issues': return banners + viewIssues();
      case 'findings': return banners + viewFindings();
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
    if (f.show === 'retired') { if (!c.retired) return false; }
    else if (c.retired && f.show !== 'all') return false;
    var k = clsOf(c);
    if (f.show === 'todo' && k !== 'none') return false;
    if (f.show === 'failed' && k !== 'fail') return false;
    if (!ignoreTier && f.tiers.length && f.tiers.indexOf(c.tier) < 0) return false;
    if (f.type && c.testType !== f.type) return false;
    var q = f.search.trim().toLowerCase();
    if (q && [c.id, c.scenario, c.group1, c.group2, c.testType, c.linkedIssue, (c.issues || []).map(function (i) { return i.ref; }).join(' ')].join(' ').toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  function visiblePaths() {
    var m = S.model;
    var out = [];
    m.paths.forEach(function (p, idx) {
      var all = [];
      p.steps.forEach(function (s) { all = all.concat(s.cases); });
      var counts = TR.counts(all.filter(function (k) { return !S.byKey[k].retired; }).map(function (k) { return clsOf(S.byKey[k]); }));
      var steps = p.steps.map(function (s) {
        return { label: s.label, keys: s.cases.filter(function (k) { return passes(S.byKey[k]); }) };
      }).filter(function (s) { return s.keys.length; });
      if (!steps.length) return;
      // Order by the riskiest case in the path, whatever its status, so paths
      // do not jump around while cases are being marked.
      var minTier = 9;
      all.forEach(function (k) { var c = S.byKey[k]; if (!c.retired && c.tier < minTier) minTier = c.tier; });
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
      return '<div class="empty card"><h3>This tab has no status column yet</h3>' + (isOwner()
        ? '<p>Start a cycle to add a <i>Test Status</i> and <i>Comment</i> column pair.</p><p style="margin-top:12px"><button class="primary" data-action="view" data-view="setup">Start a cycle in Setup</button></p>'
        : '<p>Your test lead has not started a test cycle on this tab yet.</p>') + '</div>';
    }
    var f = S.filters;
    var types = distinct('testType');
    var nRetired = m.cases.length - liveCases().length;
    var counts = TR.counts(liveCases().map(clsOf));
    var showN = { todo: counts.none, failed: counts.fail, all: liveCases().length, retired: nRetired };
    // Left: the filters, in view while scrolling. Right of the list: collapse, expand, help.
    var rail = '<div class="rail-group"><label class="rail-title" for="search">Search</label><input type="search" id="search" placeholder="ID, scenario, feature…  ( / )" value="' + esc(f.search) + '"></div>' +
      '<div class="rail-group" role="group" aria-label="Show"><span class="rail-title">Show</span>' +
      ['todo', 'failed', 'all'].concat(nRetired || f.show === 'retired' ? ['retired'] : []).map(function (s) {
        var label = { todo: 'To do', failed: 'Failed', all: 'All', retired: 'Retired' }[s];
        var tip = s === 'retired' ? ' title="Deprecated and duplicate cases: struck out in the workbook, left out of the run"' : '';
        return '<button class="chip" data-action="show" data-show="' + s + '" aria-pressed="' + (f.show === s) + '"' + tip + '>' + label + ' <span class="n">' + showN[s] + '</span></button>';
      }).join('') + '</div>' +
      (types.length > 1 ? '<div class="rail-group"><label class="rail-title" for="typePick">Test type</label><select id="typePick" data-change="type"><option value="">All types</option>' + types.map(function (t) { return opt(t, t, t === f.type); }).join('') + '</select></div>' : '');
    var h = '<div class="content-bar"><button class="ghost" data-action="collapse-all" title="Collapse all paths">Collapse</button><button class="ghost" data-action="expand-all" title="Expand all paths">Expand</button>' +
      '<button class="ghost" data-action="help" title="Keyboard shortcuts"><kbd>?</kbd></button></div>';
    if (m.plan.source === 'plan') {
      h += '<div class="banner"><span>Paths follow a saved path plan' + (m.plan.savedAt ? ' from ' + esc(m.plan.savedAt) : '') + '.</span><span class="grow"></span>' +
        (isOwner() ? '<button data-action="clear-plan">Use automatic paths</button>' : '') + '</div>';
    }

    var vps = visiblePaths();
    if (!vps.length) {
      var all = TR.counts(liveCases().map(clsOf));
      var msg = f.show === 'todo' && all.none === 0 ? '<h3>Everything in this cycle has a result 🎉</h3><p>Switch to <b>All</b> to review, or open the Summary.</p>'
        : f.show === 'retired' && !nRetired ? '<h3>No retired cases</h3><p>Cases you deprecate or mark as a duplicate show up here, struck out.</p>'
        : '<h3>Nothing matches</h3><p>Clear the search, or pick another filter on the left.</p>';
      return withRail(rail, h + '<div class="empty card">' + msg + '</div>');
    }
    if (S.caseTool) h += datalists() + casesDatalist();
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
        h += addHere(vp) + '</div>';
      }
      h += '</section>';
    });
    return withRail(rail, h);
  }

  /** A screen with its filters in a column on the left (in view while scrolling) and its content on the right. */
  function withRail(rail, content) {
    S.wide = true;
    return '<div class="with-rail"><aside class="rail" aria-label="Filters">' + rail + '</aside><div class="rail-content">' + content + '</div></div>';
  }

  /** At the end of a section: add a test case found while testing, with the section's feature and sub feature. */
  function addHere(vp) {
    if (S.readOnly) return '';
    var id = vp.p.id;
    if (!S.addHere || S.addHere.path !== id) {
      return '<div class="add-here"><button class="ghost" data-action="add-here" data-path="' + esc(id) + '" title="A scenario you found while testing this section: add it to the workbook as a test case">+ Add a test case here</button></div>';
    }
    var dis = S.readOnly ? ' disabled' : '';
    return '<div class="add-here open">' + datalists() + '<div class="tool-title">New test case in ' + esc(vp.p.name) + '</div>' +
      scenarioEditor(S.addHere.draft, 'ah:' + id, '<span class="small faint grow">Added after the last case in the workbook, with the next ID.</span><button class="ghost" data-action="add-here-cancel">Cancel</button><button class="primary" data-action="add-here-save"' + dis + '>Add to workbook</button>') + '</div>';
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
    if (c.testType) badges.push('<span class="pill type" title="Test type">' + esc(c.testType) + '</span>');
    if (c.retired) badges.push(pill('none', '⊘ ' + retiredLabel(c.retired), c.retired.reason || 'Struck out in the workbook'));
    if (c.tier === 0 && !c.retired) badges.push(pill('accent', S.model.release ? 'New in ' + S.model.release : 'New'));
    if (c.tier === 1) badges.push(pill('fail', 'Failed last'));
    if (c.auto) badges.push(autoPill(c.auto));
    if (c.issues && c.issues.length) badges.push(pill('outline', c.issues.map(function (i) { return i.ref; }).join(', ')));
    return '<div class="case' + (sel ? ' sel' : '') + (c.retired ? ' retired' : '') + '" role="button" tabindex="0" data-action="select" data-key="' + esc(c.key) + '" aria-expanded="' + sel + '">' +
      TR.dot(k, S.pending[c.key]) + '<span class="sr">' + (c.retired ? retiredLabel(c.retired) + ', struck out. ' : '') + TR.CLS_LABEL[k] + '. </span>' +
      '<span class="cid">' + esc(c.id) + '</span>' +
      '<span class="title"' + (sel ? '' : ' title="' + esc(c.scenario) + '"') + '>' + esc(sel ? c.scenario : oneLine(c.scenario)) + '</span>' +
      '<span class="badges">' + badges.join('') + '</span></div>' + (sel ? detail(c) : '');
  }

  function field(label, html) {
    return '<div><div class="field-label">' + esc(label) + '</div><div class="field-value">' + html + '</div></div>';
  }

  function detail(c) {
    var tool = S.caseTool && S.caseTool.key === c.key ? S.caseTool.mode : null;
    var left = tool === 'edit' ? editForm(c) : caseFields(c);
    var right = tool === 'deprecate' || tool === 'duplicate' ? retireForm(c, tool) : c.retired ? retiredActions(c) : runActions(c);
    return '<div class="detail' + (c.retired && tool !== 'edit' ? ' is-retired' : '') + '"><div class="fields">' + left + '</div><div class="actions">' + right + '</div></div>';
  }

  function caseFields(c) {
    var m = S.model;
    var f = [];
    var where = [c.id, c.group1, c.group2 && c.group2 !== c.group1 ? c.group2 : '', c.testType].filter(Boolean).join(' · ');
    if (where) f.push('<div class="small muted">' + esc(where) + '</div>');
    if (c.preCondition.trim()) f.push(field('Pre condition', TR.cellHtml(c.preCondition)));
    if (c.testData.trim()) f.push(field('Test data', TR.cellHtml(c.testData)));
    if (c.expected.trim()) f.push(field('Expected result', TR.cellHtml(c.expected, true)));
    c.extras.forEach(function (x) { f.push(field(x.label, TR.cellHtml(x.value))); });
    if (c.auto) f.push(field('Automation', esc(c.auto.refs.join(', ')) + ' ' + autoPill(c.auto)));
    if (m.prevIdx >= 0 && c.statuses[m.prevIdx]) {
      var pk = TR.classify(c.statuses[m.prevIdx]);
      f.push(field('Last cycle (' + (m.cycles[m.prevIdx].label || 'previous') + ')', '<span class="sym-' + pk + '">' + TR.SYM[pk] + '</span> ' + esc(c.statuses[m.prevIdx]) + (c.comments[m.prevIdx] ? ' – <span class="ml">' + esc(TR.cellLines(c.comments[m.prevIdx]).join('\n')) + '</span>' : '')));
    }
    if (c.duplicates && c.duplicates.length) {
      f.push(field('Kept for its duplicates', c.duplicates.map(function (id) {
        var d = findCase(id);
        return d ? '<button class="linkish mono" data-action="goto-case" data-key="' + esc(d.key) + '">' + esc(id) + '</button>' : '<span class="mono">' + esc(id) + '</span>';
      }).join(', ') + ' <span class="small muted">struck out as duplicates of this case</span>'));
    }
    if (f.length <= 1) f.push('<p class="muted">The sheet has no more details for this case.</p>');
    return f.join('');
  }

  function metaLines(c) {
    var who = [c.testedBy, c.testedOn].filter(Boolean).join(' · ');
    return (who ? '<div class="meta-line">Last marked: ' + esc(who) + '</div>' : '') + '<div class="meta-line faint">Row ' + c.row + ' in the workbook</div>';
  }

  /** The issue field's text: the case's issues, links in full, comma separated. */
  function issueField(c) { return (c.issues || []).map(function (i) { return i.url || i.ref; }).join(', '); }

  /** What the issue list knows about an issue: { title, priority, state } or {}. */
  function issueInfo(i) { return ((S.model && S.model.issueInfo) || {})[String(i.url || i.ref).toLowerCase()] || {}; }

  /** The case's issues as links, with their title when known. */
  function issueChips(list) {
    if (!list || !list.length) return '';
    return '<div class="issue-chips">' + list.map(function (i) {
      var info = issueInfo(i);
      var label = esc(i.ref) + (info.title ? ' <span class="muted">' + esc(info.title) + '</span>' : '') + (info.priority ? ' <span class="pill outline">' + esc(info.priority) + '</span>' : '') + (info.state === 'closed' ? ' <span class="pill">closed</span>' : '');
      return i.url ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener" class="issue-chip">' + label + ' ↗</a>' : '<span class="issue-chip">' + label + '</span>';
    }).join('') + '</div>';
  }

  /** Marking: status buttons, comment, issue; then the tools to change the case itself. */
  function runActions(c) {
    var m = S.model;
    var ci = m.cycleIdx;
    var now = c.statuses[ci] || '';
    var dis = S.readOnly ? ' disabled' : '';
    var btns = m.statusOptions.map(function (o) {
      var on = o.value === now;
      return '<button class="sbtn ' + o.cls + (on ? ' on' : '') + '" data-action="mark" data-value="' + esc(o.value) + '" aria-pressed="' + on + '"' + (on ? ' title="Marked ' + esc(o.value) + '. Press again (or 0) to clear it and leave the case not run."' : '') + dis + '>' +
        TR.SYM[o.cls] + ' ' + esc(o.value) + (o.key ? ' <kbd>' + o.key.toUpperCase() + '</kbd>' : (o.num ? ' <kbd>' + o.num + '</kbd>' : '')) + '</button>';
    }).join('');
    var d = S.drafts[c.key] || {};
    var a = '<div class="status-btns" role="group" aria-label="Result">' + btns + '</div>';
    var ev = m.evidence && m.evidence[c.key];
    if (ev) {
      a += '<div class="evidence-row"><span class="small"><span class="muted">Evidence' + (ev.usedFor ? ' for ' + esc(ev.usedFor) : '') + ':</span> <span class="mono">' + esc(ev.name) + '</span> <span class="faint">' + fmtBytes(ev.size) + (ev.by ? ' · ' + esc(ev.by) : '') + '</span></span>' +
        '<span class="grow"></span><button class="link-btn" data-action="ev-view" data-key="' + esc(c.key) + '">View</button>' +
        (S.readOnly ? '' : '<button class="link-btn danger" data-action="ev-remove" data-key="' + esc(c.key) + '" title="Delete the file for good">Remove</button>') + '</div>';
      if (ev.usedFor && !S.readOnly) a += '<div class="small faint">To change this result, attach new evidence with Test Run Extension, or remove the file first.</div>';
    }
    if (now) a += '<div class="row small"><span class="muted">Marked <b>' + esc(now) + '</b>.</span><button class="link-btn" data-action="clear-result"' + dis + ' title="Leave the case not run, to come back to it (0)">Clear result</button></div>';
    var failing = TR.classify(now) === 'fail';
    if (cur().hasComment) {
      a += '<div><label for="comment">Comment' + (failing ? ' (what went wrong)' : '') + '</label><textarea id="comment" data-comment rows="' + rowsFor(d.comment != null ? d.comment : c.comments[ci], 2, 8, 46) + '" placeholder="Optional. Enter saves, Shift+Enter for a new line"' + dis + '>' + esc(d.comment != null ? d.comment : (c.comments[ci] || '')) + '</textarea></div>';
    }
    a += '<div><label for="issue">Issue link' + (failing ? '' : ' <span class="faint">(optional)</span>') + '</label><input id="issue" data-issue autocomplete="off" placeholder="Paste the issue link, e.g. https://github.com/org/repo/issues/123" value="' + esc(d.issue != null ? d.issue : issueField(c)) + '"' + dis + '>' +
      issueChips(c.issues) + '</div>';
    a += '<div class="row"><button data-action="save-note"' + dis + ' title="Save the comment and issue link without changing the result">Save note</button>' +
      '<span class="grow"></span>' + (S.undo.length ? '<button class="ghost" data-action="undo" title="Undo last mark (U)">Undo</button>' : '') + '</div>' +
      (S.readOnly ? '' : '<div class="small faint">Typed a comment or link? Pressing a result saves them too and opens the next case.</div>');
    a += '<div class="case-tools" role="group" aria-label="Change this test case">' +
      '<button class="ghost" data-action="case-tool" data-mode="edit" title="Change the scenario, steps or expected result (E)"' + dis + '>✎ Edit case</button>' +
      '<button class="ghost" data-action="case-tool" data-mode="duplicate" title="Another case already covers this: strike this one out and keep that one"' + dis + '>⧉ Duplicate of…</button>' +
      '<button class="ghost danger" data-action="case-tool" data-mode="deprecate" title="No longer needed: strike it out, with the reason in the comment"' + dis + '>⊘ Deprecate</button></div>';
    return a + metaLines(c);
  }

  /** A retired case: why, and the way back. */
  function retiredActions(c) {
    var r = c.retired;
    var dis = S.readOnly ? ' disabled' : '';
    var kept = r.ofKey ? S.byKey[r.ofKey] : null;
    var title = r.kind === 'duplicate'
      ? 'Duplicate of ' + (kept ? '<button class="linkish mono" data-action="goto-case" data-key="' + esc(kept.key) + '" title="Open the case that is kept">' + esc(r.of) + '</button>' : '<span class="mono">' + esc(r.of) + '</span>')
      : r.kind === 'deprecated' ? 'Deprecated' : 'Struck out in the workbook';
    var h = '<div class="retired-box"><div class="retired-title">⊘ ' + title + '</div>' +
      (r.reason ? '<div>' + esc(r.reason) + '</div>' : r.kind === 'struck' ? '<div class="small">No reason found in the comments.</div>' : '') +
      (kept ? '<div class="small muted">Kept: ' + esc(kept.scenario) + '</div>' : '') +
      '<div class="small muted">' + (r.cycle ? 'Retired in cycle ' + esc(r.cycle) + '. ' : '') + 'The row stays in the workbook, struck out, and is left out of the run and the figures.</div></div>';
    h += '<div class="row"><button data-action="restore"' + dis + '>Restore to the run</button><button class="ghost" data-action="case-tool" data-mode="edit"' + dis + '>✎ Edit case</button></div>';
    return h + metaLines(c);
  }

  var EDIT_FIELDS = [
    { f: 'scenario', label: 'Scenario', rows: 2 },
    { f: 'preCondition', label: 'Pre condition', rows: 2 },
    { f: 'testData', label: 'Test data', rows: 2 },
    { f: 'expected', label: 'Expected result', rows: 3 },
    { f: 'testType', label: 'Test type', list: 'testType' }
  ];

  /** A field as it is in the cell, tidied: no trailing spaces, no blank lines at the ends. */
  function editValue(c, f) { return TR.cellLines(c[f] || '').join('\n'); }

  /** Textarea rows for a text: its lines, counting long lines as several, between min and max. */
  function rowsFor(text, min, max, perLine) {
    var n = 0;
    TR.cellLines(text).forEach(function (l) { n += Math.max(1, Math.ceil(l.length / (perLine || 60))); });
    return Math.min(Math.max(n, min), max);
  }

  /** Edit the case's own text in place. */
  function editForm(c) {
    var pre = 'ce:' + c.key + ':';
    var dis = S.readOnly ? ' disabled' : '';
    var h = '<div class="tool-title">Edit ' + esc(caseLabel(c)) + '</div><div class="edit-form">';
    EDIT_FIELDS.forEach(function (d) {
      if (!hasField(d.f)) return;
      var id = 'ce_' + d.f;
      var v = val(pre + d.f, editValue(c, d.f));
      h += '<div><label for="' + id + '">' + esc(d.label) + '</label>' +
        (d.rows ? '<textarea id="' + id + '" data-bind="' + esc(pre + d.f) + '" rows="' + rowsFor(v, d.rows, 12) + '"' + dis + '>' + esc(v) + '</textarea>'
          : '<input id="' + id + '" data-bind="' + esc(pre + d.f) + '" value="' + esc(v) + '" list="dl_' + d.list + '"' + dis + '>') + '</div>';
    });
    if (cur() && cur().hasComment) {
      h += '<div><label for="ce_note">What changed and why (optional; added to the comment as “Updated: …”)</label>' +
        '<input id="ce_note" data-bind="' + esc(pre + 'note') + '" placeholder="e.g. Pincode now comes from the boundary, not the map" value="' + esc(val(pre + 'note', '')) + '"' + dis + '></div>';
    }
    h += '<div class="row"><span class="small faint">Writes straight into row ' + c.row + ' of the workbook.</span><span class="grow"></span><button class="ghost" data-action="case-tool-cancel">Cancel</button><button class="primary" data-action="save-case"' + dis + '>Save changes</button></div></div>';
    return h;
  }

  /** The reason to suggest when deprecating: what the tester already wrote in this cycle's comment. */
  function defaultReason(c) {
    var t = String(c.comments[S.model.cycleIdx] || '').trim();
    return t && !isRetireNote(t) ? t : '';
  }

  function casesDatalist(cases) {
    return '<datalist id="dl_cases">' + (cases || liveCases()).map(function (x) { return '<option value="' + esc(x.id || x.key) + '">' + esc(x.scenario.slice(0, 120)) + '</option>'; }).join('') + '</datalist>';
  }

  function keptPreview(c, text) {
    var kept = findCase(text);
    if (!String(text || '').trim()) return '';
    if (!kept) return '<div class="note">No case "' + esc(text) + '" in this tab.</div>';
    if (kept === c) return '<div class="note">That is this case. Pick the one to keep.</div>';
    if (kept.retired) return '<div class="note">' + esc(caseLabel(kept)) + ' is retired itself (' + esc(retiredLabel(kept.retired)) + '). Pick a case that stays in the run.</div>';
    return '<div class="small">Keeps <b class="mono">' + esc(caseLabel(kept)) + '</b> ' + esc(kept.scenario) + '</div>';
  }

  /** Deprecate, or mark as a duplicate of a kept case. */
  function retireForm(c, mode) {
    var pre = 'ce:' + c.key + ':';
    var dis = S.readOnly ? ' disabled' : '';
    var cy = cur();
    var where = 'the comment for cycle <b>' + esc(cy.label || 'Status') + '</b>';
    if (!cy.hasComment) {
      return '<div class="note bad">Cycle ' + esc(cy.label || 'Status') + ' has no Comment column, so the reason has nowhere to go. Add a Comment column next to its status column first.</div>' +
        '<div class="row"><span class="grow"></span><button class="ghost" data-action="case-tool-cancel">Back</button></div>';
    }
    var h;
    if (mode === 'deprecate') {
      h = '<div class="tool-title">⊘ Deprecate ' + esc(caseLabel(c)) + '</div>' +
        '<p class="small muted">The row stays in the workbook, struck out, and the reason goes first in ' + where + ' as “Deprecated: …”. The case leaves this run and the figures; you can restore it.</p>' +
        '<div class="stack-s"><label for="retireReason">Why is it no longer needed?</label><textarea id="retireReason" data-bind="' + esc(pre + 'reason') + '" rows="2" placeholder="e.g. Pincode is no longer filled from the map pin"' + dis + '>' + esc(val(pre + 'reason', defaultReason(c))) + '</textarea></div>' +
        '<div class="row"><span class="grow"></span><button class="ghost" data-action="case-tool-cancel">Cancel</button><button class="danger-fill" data-action="retire" data-kind="deprecated"' + dis + '>Deprecate</button></div>';
      return h;
    }
    var of = val(pre + 'of', '');
    var sims = similarCases(c, 3);
    h = '<div class="tool-title">⧉ ' + esc(caseLabel(c)) + ' is a duplicate</div>' +
      '<p class="small muted">Pick the case to keep. This one is struck out and ' + where + ' starts with “Duplicate of …”. The kept case stays in the run.</p>' +
      '<div class="stack-s"><label for="dupOf">Case to keep</label><input id="dupOf" list="dl_cases" autocomplete="off" data-bind="' + esc(pre + 'of') + '" placeholder="ID, e.g. ' + esc((liveCases()[0] || {}).id || 'CMS/12') + '" value="' + esc(of) + '"' + dis + '>' +
      '<div id="dupPreview">' + keptPreview(c, of) + '</div></div>';
    if (sims.length) {
      h += '<div class="stack-s"><span class="small muted">Similar cases</span><div class="sugg">' + sims.map(function (x) {
        var on = findCase(of) === x;
        return '<button class="ghost" data-action="pick-dup" data-of="' + esc(x.id || x.key) + '" aria-pressed="' + on + '"' + dis + '><b class="mono">' + esc(caseLabel(x)) + '</b> <span>' + esc(x.scenario) + '</span></button>';
      }).join('') + '</div></div>';
    }
    h += '<div class="stack-s"><label for="dupReason">Reason (optional)</label><input id="dupReason" data-bind="' + esc(pre + 'dupReason') + '" placeholder="e.g. Same check as the map case" value="' + esc(val(pre + 'dupReason', '')) + '"' + dis + '></div>' +
      '<div class="row"><span class="grow"></span><button class="ghost" data-action="case-tool-cancel">Cancel</button><button class="primary" data-action="retire" data-kind="duplicate"' + dis + '>Mark as duplicate</button></div>';
    return h;
  }

  function openTool(mode) {
    if (!S.selected) return;
    if (S.readOnly) { toast('View only: you need edit access to change cases.', 'bad'); return; }
    S.caseTool = { key: S.selected, mode: mode };
    render();
    var el = $({ edit: 'ce_scenario', deprecate: 'retireReason', duplicate: 'dupOf' }[mode]);
    if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* not a text field */ } }
  }

  function saveCase() {
    var c = S.byKey[S.selected];
    var cy = cur();
    if (!c || !cy) return;
    var pre = 'ce:' + c.key + ':';
    var fields = {};
    var changed = 0;
    EDIT_FIELDS.forEach(function (d) {
      if (!hasField(d.f)) return;
      var orig = editValue(c, d.f);
      var v = String(val(pre + d.f, orig));
      if (TR.cellLines(v).join('\n') === orig) return;
      fields[d.f] = v;
      changed++;
    });
    var note = String(val(pre + 'note', '')).trim();
    if (fields.scenario != null && !String(fields.scenario).trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
    if (!changed && !note) { toast('Nothing changed.'); return; }
    S.pending[c.key] = true;
    render();
    queueWrite(function () {
      return api('api_updateCase', { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, fields: fields, note: note });
    }).then(function (r) {
      delete S.pending[c.key];
      if (!r.ok) { writeError(r); return; }
      clearForm(pre);
      S.caseTool = null;
      if (r.key) { S.selected = r.key; if (S.keep[c.key]) S.keep[r.key] = true; }
      toast('Saved ' + caseLabel(c) + ' in the workbook' + (note ? ', with the note in the comment.' : '.'));
      loadTab(cycleLabel(), true);
    });
  }

  function retireCase(kind) {
    var c = S.byKey[S.selected];
    var cy = cur();
    if (!c || !cy) return;
    var pre = 'ce:' + c.key + ':';
    var req = { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, kind: kind };
    var kept = null;
    if (kind === 'deprecated') {
      req.reason = String(val(pre + 'reason', defaultReason(c))).trim();
      if (!req.reason) { toast('Say why it is no longer needed; it goes into the comment.', 'bad'); var t = $('retireReason'); if (t) t.focus(); return; }
    } else {
      var of = val(pre + 'of', '');
      kept = findCase(of);
      if (!kept || kept === c || kept.retired) { toast(String(of).trim() ? 'Pick a case that stays in the run.' : 'Pick the case to keep.', 'bad'); var i = $('dupOf'); if (i) i.focus(); return; }
      req.of = kept.id || kept.key;
      req.reason = String(val(pre + 'dupReason', '')).trim();
    }
    S.pending[c.key] = true;
    render();
    queueWrite(function () { return api('api_retireCase', req); }).then(function (r) {
      delete S.pending[c.key];
      if (!r.ok) { writeError(r); return; }
      c.retired = r.retired;
      if (kept) { c.retired.ofKey = kept.key; kept.duplicates = (kept.duplicates || []).concat([c.id || c.key]); }
      c.comments[S.model.cycleIdx] = r.comment;
      delete S.drafts[c.key];
      clearForm(pre);
      S.caseTool = null;
      S.keep[c.key] = true; // stays in view, struck out, until the filter changes
      toast(kind === 'duplicate' ? caseLabel(c) + ' is now a duplicate of ' + caseLabel(kept) + ': struck out in the workbook, tagged in the comment.' : caseLabel(c) + ' deprecated: struck out in the workbook, reason in the comment.');
      advance(c.key);
      render();
      loadTab(cycleLabel(), true);
    });
  }

  function restoreCase() {
    var c = S.byKey[S.selected];
    var cy = cur();
    if (!c || !cy) return;
    S.pending[c.key] = true;
    render();
    queueWrite(function () { return api('api_restoreCase', { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label }); }).then(function (r) {
      delete S.pending[c.key];
      if (!r.ok) { writeError(r); return; }
      c.retired = null;
      if (r.comment != null) c.comments[S.model.cycleIdx] = r.comment;
      S.keep[c.key] = true;
      toast(caseLabel(c) + ' is back in the run.');
      render();
      loadTab(cycleLabel(), true);
    });
  }

  function select(key, scroll) {
    S.selected = S.selected === key ? null : key;
    S.caseTool = null;
    S.scrollToSel = !!scroll;
    render();
  }

  function move(delta) {
    var order = visibleOrder();
    if (!order.length) return;
    var i = order.indexOf(S.selected);
    var next = i < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(Math.max(i + delta, 0), order.length - 1);
    S.selected = order[next];
    S.caseTool = null;
    S.scrollToSel = true;
    render();
  }

  /** Open the case right after this one in the list (retired cases are skipped: they cannot be marked). */
  function advance(fromKey) {
    var order = visibleOrder();
    var i = order.indexOf(fromKey);
    for (var n = i + 1; n < order.length; n++) {
      var k = order[n];
      if (!S.byKey[k].retired) { S.selected = k; S.caseTool = null; S.scrollToSel = true; return; }
    }
    toast('That was the last case in this view.');
  }

  /** Comment and issue link typed in the open case and not saved yet: { comment?, issue? } or null. */
  function unsavedNote(c) {
    var d = S.drafts[c.key];
    if (!d) return null;
    var ci = S.model.cycleIdx;
    var out = {};
    if (d.comment != null && cur() && cur().hasComment && String(d.comment).trim() !== String(c.comments[ci] || '').trim()) out.comment = d.comment;
    if (d.issue != null && TR.sameIssues(d.issue, c.issues) === false) out.issue = d.issue;
    return out.comment != null || out.issue != null ? out : null;
  }

  function mark(key, value) {
    if (S.readOnly) { toast('View only: you need edit access to mark results.', 'bad'); return; }
    var c = S.byKey[key];
    var cy = cur();
    if (!c || !cy) return;
    if (c.retired) { toast(caseLabel(c) + ' is retired. Restore it to the run to mark a result.'); return; }
    var ci = S.model.cycleIdx;
    var prev = c.statuses[ci] || '';
    var note = key === S.selected ? unsavedNote(c) : null;
    // The chosen result pressed again: with a comment or link typed, save them and move on; else clear it.
    if (prev === value && note) { saveNote(true); return; }
    if (prev === value) value = '';
    if (prev === value) return;
    var prevComment = c.comments[ci] || '';
    c.statuses[ci] = value;
    if (note && note.comment != null) c.comments[ci] = note.comment;
    S.keep[key] = true;
    S.pending[key] = true;
    S.undo.push({ key: key, prev: prev, next: value, prevComment: prevComment });
    if (S.undo.length > 50) S.undo.shift();
    var failing = TR.classify(value) === 'fail';
    // A failure with nothing typed yet stays open for the comment and link; anything else moves on.
    if (value && (!failing || note)) advance(key);
    if (!value) toast((c.id || 'The case') + ' is back to not run. Press U to undo.');
    render();
    if (failing && !note) focusComment();
    queueWrite(function () {
      var req = { tab: S.tab, key: key, sh: c.sh, row: c.row, cycle: cy.label, expect: prev, status: value };
      if (note && note.comment != null) req.comment = note.comment;
      if (note && note.issue != null) req.issue = note.issue;
      return api('api_mark', req);
    }).then(function (r) {
      if (r.ok && note) delete S.drafts[key];
      afterMark(c, ci, r, prev, prevComment);
    });
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
      if (r.issue != null) { c.linkedIssue = r.issue; c.issues = r.issues || []; }
      if (r.addedIssueColumn) {
        toast('Added a "' + r.addedIssueColumn + '" column at the right of the table for issue links.');
        loadTab(cycleLabel(), true);
      }
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

  /** Save the comment and issue link as they are in the fields; moveOn: then open the next case. */
  function saveNote(moveOn) {
    var c = S.byKey[S.selected];
    var cy = cur();
    if (!c || !cy) return;
    if (S.readOnly) { toast('View only: you need edit access to save notes.', 'bad'); return; }
    var ci = S.model.cycleIdx;
    var t = $('comment');
    var i = $('issue');
    var d = S.drafts[c.key] || {};
    var req = { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, expect: c.statuses[ci] || '', status: c.statuses[ci] || '' };
    if (t) req.comment = t.value; else if (d.comment != null) req.comment = d.comment;
    if (i) req.issue = i.value; else if (d.issue != null) req.issue = d.issue;
    S.pending[c.key] = true;
    if (moveOn === true) advance(c.key);
    render();
    queueWrite(function () { return api('api_mark', req); }).then(function (r) {
      if (r.ok) { delete S.drafts[c.key]; toast(moveOn === true ? (c.id || 'Case') + ' saved.' : 'Saved.'); }
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

  function tierHelp(id) {
    return ['Release column matches the release in scope', 'Failed in the previous cycle', 'No passing automation', 'Automation passed; a quick look is enough'][id] || '';
  }

  // ---------------------------------------------------------------------------
  // Known issues
  // ---------------------------------------------------------------------------

  var issuePoll = null;
  /** The workbook's known issues; while titles are being fetched from GitHub, look again shortly. */
  function loadIssues() {
    if (S.issuesLoading) return;
    S.issuesLoading = true;
    TR.http('GET', '/api/issues?book=' + encodeURIComponent(book())).then(function (r) {
      S.issuesLoading = false;
      S.issues = r.ok ? r : { error: r.error, issues: [] };
      if (r.ok && S.model) { // keep the titles shown next to links in Run up to date
        S.model.issueInfo = S.model.issueInfo || {};
        r.issues.forEach(function (e) { S.model.issueInfo[String(e.key).toLowerCase()] = { title: e.title, priority: e.priority, state: e.state }; });
      }
      render();
      clearTimeout(issuePoll);
      if (r.ok && r.fetching && S.view === 'issues') issuePoll = setTimeout(loadIssues, 2500);
    });
  }

  var PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

  function priorityPill(p) {
    if (!p) return '<span class="faint">–</span>';
    var m = /\bp\s*([0-4])\b/i.exec(p);
    var rank = m ? Number(m[1]) : /critical|blocker|urgent|high/i.test(p) ? 1 : 2;
    return '<span class="pill ' + (rank <= 1 ? 'fail' : rank === 2 ? 'other' : 'outline') + '">' + esc(p) + '</span>';
  }

  function issueCasesHtml(e, many) {
    var parts = e.cases.map(function (c) {
      return '<div class="issue-case">' + TR.dot(c.retired ? 'none' : c.cls) + ' <button class="linkish mono" data-action="open-case" data-tab="' + esc(c.tab) + '" data-key="' + esc(c.key) + '" title="Open in Run">' +
        esc((many ? TR.tabLabel(c.tab) + ' › ' : '') + (c.id || 'Row')) + '</button> <span class="small muted">' + esc(c.scenario.length > 70 ? c.scenario.slice(0, 68) + '…' : c.scenario) + '</span>' +
        (c.retired ? ' <span class="pill none">retired</span>' : '') + '</div>';
    });
    e.findings.forEach(function (f) {
      parts.push('<div class="issue-case"><span class="pill accent">Not in the test cases yet</span> <button class="linkish" data-action="view" data-view="findings">Finding ' + esc(f.key) + '</button></div>');
    });
    return parts.join('') || '<span class="faint">–</span>';
  }

  function viewIssues() {
    var r = S.issues;
    if (!r) { loadIssues(); return '<div class="loading">Loading known issues…</div>'; }
    if (r.error) return '<div class="banner bad"><span>' + esc(r.error) + '</span><span class="grow"></span><button data-action="issues-reload">Try again</button></div>';
    var all = r.issues || [];
    var show = val('issueShow', 'open');
    var q = String(val('issueQ', '')).trim().toLowerCase();
    var list = all.filter(function (e) {
      if (show === 'open' && e.state === 'closed') return false;
      if (q && [e.ref, e.url, e.title, e.priority, e.cases.map(function (c) { return c.id + ' ' + c.scenario; }).join(' ')].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var nOpen = all.filter(function (e) { return e.state !== 'closed'; }).length;
    var many = (r.tabs || []).length > 1;
    var dis = S.readOnly ? ' disabled' : '';
    var rail = '<div class="rail-group"><label class="rail-title" for="issueQ">Search</label><input type="search" id="issueQ" data-bind="issueQ" data-live="1" placeholder="Issue, title, test case…" value="' + esc(val('issueQ', '')) + '"></div>' +
      '<div class="rail-group" role="group" aria-label="Show"><span class="rail-title">Show</span>' +
      '<button class="chip" data-action="issue-show" data-show="open" aria-pressed="' + (show === 'open') + '">Open <span class="n">' + nOpen + '</span></button>' +
      '<button class="chip" data-action="issue-show" data-show="all" aria-pressed="' + (show === 'all') + '">All <span class="n">' + all.length + '</span></button></div>';
    var formOpen = !S.readOnly && !!val('aiOpen') && runTabs().length > 0;
    var h = '<div class="row section-head"><div class="grow"><h2>Known issues</h2><p class="small muted">Every issue linked to a test case or noted as a finding, with its title, priority and state.' +
      (r.fetching ? ' <span class="faint">Getting titles from GitHub…</span>' : '') + '</p></div>' +
      (r.github && !S.readOnly && all.some(function (e) { return /^https:\/\/github\.com\//i.test(e.url); }) ? '<button class="ghost" data-action="issues-refresh"' + (r.fetching ? ' disabled' : '') + ' title="Get the latest title, state and priority of every GitHub issue">Refresh from GitHub</button>' : '') +
      (S.readOnly || !runTabs().length ? '' : '<button data-action="add-issue" aria-expanded="' + formOpen + '" title="Note an issue that was logged outside Test Run, for example straight on GitHub">+ Add issue</button>') + '</div>';
    if (formOpen) h += addIssueCard();
    h += '<div class="section">';
    if (!all.length) {
      return withRail(rail, h + '<div class="empty card"><h3>No known issues yet</h3><p>Paste an issue link on a test case in <b>Run</b>, add one with <b>+ Add issue</b>, or tick <b>Also add to Test Run</b> in Bug Reporter when you file a bug.<br>Each issue shows here with its title, priority and test cases.</p></div></div>');
    }
    if (!list.length) return withRail(rail, h + '<div class="empty card"><h3>Nothing matches</h3><p>' + (show === 'open' && nOpen === 0 ? 'Every known issue is closed. Choose <b>All</b> to see them.' : 'Clear the search.') + '</p></div></div>');
    h += '<div class="card"><div class="table-wrap"><table class="issues"><thead><tr><th>Issue</th><th>Title</th><th>Priority</th><th>State</th><th>Test cases</th><th></th></tr></thead><tbody>';
    list.forEach(function (e) {
      var ref = e.url ? '<a class="mono" href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.ref) + ' ↗</a>' : '<span class="mono">' + esc(e.ref) + '</span>';
      if (S.issueEdit === e.key) {
        var pv = val('ie:priority', e.priority);
        var opts = PRIORITIES.concat(pv && PRIORITIES.indexOf(pv) < 0 ? [pv] : []);
        h += '<tr class="editing"><td>' + ref + '</td><td><label class="sr" for="ieTitle">Title</label><input id="ieTitle" data-bind="ie:title" value="' + esc(val('ie:title', e.title)) + '" placeholder="What is wrong, in a few words"></td>' +
          '<td><label class="sr" for="iePriority">Priority</label><select id="iePriority" data-bind="ie:priority"><option value="">–</option>' + opts.map(function (p) { return opt(p, p, p === pv); }).join('') + '</select></td>' +
          '<td>' + (e.state ? esc(e.state) : '') + '</td><td>' + issueCasesHtml(e, many) + '</td>' +
          '<td class="num"><div class="row" style="justify-content:flex-end"><button class="ghost" data-action="issue-edit-cancel">Cancel</button><button class="primary" data-action="issue-save" data-key="' + esc(e.key) + '">Save</button></div></td></tr>';
        return;
      }
      var title = e.title ? esc(e.title) : '<span class="faint">' + (e.fetchError ? 'No title: ' + esc(e.fetchError) : r.fetching && /github\.com/.test(e.url) ? 'Getting it from GitHub…' : 'No title yet') + '</span>';
      h += '<tr' + (e.state === 'closed' ? ' class="closed"' : '') + '><td class="nowrap">' + ref + '</td><td>' + title + '</td><td>' + priorityPill(e.priority) + '</td>' +
        '<td>' + (e.state ? '<span class="pill ' + (e.state === 'closed' ? 'pass' : 'outline') + '">' + (e.state === 'closed' ? 'Closed' : 'Open') + '</span>' : '<span class="faint">–</span>') + '</td>' +
        '<td>' + issueCasesHtml(e, many) + '</td>' +
        '<td class="num">' + (S.readOnly ? '' : '<button class="ghost small-btn" data-action="issue-edit" data-key="' + esc(e.key) + '" title="Type the title or priority"' + dis + '>✎</button>') + '</td></tr>';
    });
    h += '</tbody></table></div></div></div>';
    h += '<p class="small faint section">Downloading the workbook adds these as a <b>Known issues</b> sheet. ' +
      (r.github ? 'Titles, states and priorities of GitHub issues come from GitHub, through the <span class="mono">gh</span> login on the laptop running Test Run; you can also type them.' : 'Type titles and priorities here, or install the GitHub CLI (<span class="mono">gh</span>) on the laptop running Test Run to fill them in from GitHub.') + '</p>';
    return withRail(rail, h);
  }

  // ---------------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------------

  function areas() {
    var out = [];
    distinct('group1').concat(distinct('group2')).forEach(function (a) { if (out.indexOf(a) < 0) out.push(a); });
    return out;
  }

  /** A first draft of the test case for a finding: its text, bug, area and the expected result Bug Reporter noted. */
  function draftFromFinding(f, sm) {
    var expected = [];
    String(f.details || '').split(/\r?\n/).forEach(function (l) {
      var m = l.match(/^Expected:\s*(.+)$/);
      if (m) expected.push(m[1].trim());
    });
    var area = String(f.area || '').toLowerCase();
    var pick = function (k) { var hit = ((sm && sm.cases) || []).filter(function (c) { return String(c[k] || '').toLowerCase() === area; })[0]; return hit ? hit[k] : ''; };
    var sub = area ? pick('group2') : '';
    var feat = area ? pick('group1') : '';
    return { scenario: f.text, issue: f.url || f.issue || '', fromFinding: f.key, subFeature: sub, feature: feat, testData: '', preCondition: '', expected: expected };
  }

  function findingCard(f, dis) {
    var tab = f.tab || S.tab;
    var sm = suiteOf(tab);
    var h = '<div class="item finding"><div class="row"><span class="mono faint">' + esc(f.key) + '</span><b class="grow">' + esc(f.text) + '</b>' +
      '<span class="pill outline" title="Test suite: ' + esc(tab) + '">' + esc(TR.tabLabel(tab)) + '</span>' +
      (f.source === 'bug-reporter' ? '<span class="pill accent" title="Noted by the Bug Reporter extension when the issue was filed">from Bug Reporter</span>' : '') +
      (f.url ? '<a class="pill outline" href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.issue || 'issue') + ' ↗</a>' : (f.issue ? '<span class="pill outline">' + esc(f.issue) + '</span>' : '')) + '</div>' +
      (f.area ? '<div class="small muted">' + esc(f.area) + '</div>' : '') +
      (f.details ? '<div class="small ml finding-details">' + esc(TR.cellLines(f.details).join('\n')) + '</div>' : '') +
      '<div class="small faint">' + esc([f.by, f.at].filter(Boolean).join(' · ')) + '</div>';
    if (!sm) return h + '<div class="small faint" style="margin-top:6px">Reading ' + esc(tab) + '…</div></div>';
    var draft = S.writeUp[f.key];
    if (draft) {
      return h + '<div class="writeup">' + datalists(sm) + scenarioEditor(draft, 'wu:' + f.key,
        '<span class="small faint grow">Added to ' + esc(tab) + '.</span><button class="ghost" data-action="writeup-cancel" data-key="' + esc(f.key) + '">Cancel</button><button class="primary" data-action="writeup-add" data-key="' + esc(f.key) + '"' + dis + '>Add to workbook</button>', sm) + '</div></div>';
    }
    if (S.covering === f.key) {
      return h + casesDatalist(sm.cases) + '<div class="row" style="margin-top:8px"><label for="covId">Already covered by case</label><input id="covId" list="dl_cases" data-bind="cov:' + esc(f.key) + '" placeholder="e.g. ' + esc((sm.cases[0] || {}).id || 'CMS/12') + '" value="' + esc(val('cov:' + f.key)) + '">' +
        '<button class="ghost" data-action="cover-cancel">Cancel</button><button class="primary" data-action="cover-save" data-key="' + esc(f.key) + '"' + dis + '>Mark covered</button></div></div>';
    }
    var sims = similarIn(sm.cases, [f.text, f.details].filter(Boolean).join(' '), 3);
    if (sims.length) {
      h += '<div class="similar"><div class="small muted">Similar test cases already in ' + esc(tab) + ':</div>' + sims.map(function (x) {
        return '<div class="similar-row"><button class="linkish mono" data-action="open-case" data-tab="' + esc(tab) + '" data-key="' + esc(x.c.key) + '" title="Open it in Run">' + esc(x.c.id || x.c.key) + '</button>' +
          '<span class="grow small">' + esc(oneLine(x.c.scenario)) + '</span><span class="small faint">' + Math.round(x.score * 100) + '% alike</span>' +
          (S.readOnly ? '' : '<button class="small-btn" data-action="cover-with" data-key="' + esc(f.key) + '" data-case="' + esc(x.c.id || x.c.key) + '" title="This finding is covered by that case: move it to Done">Covered by this</button>') + '</div>';
      }).join('') + '</div>';
    }
    if (S.readOnly) return h + '</div>';
    return h + '<div class="row" style="margin-top:8px"><button class="primary" data-action="writeup" data-key="' + esc(f.key) + '"' + dis + '>Write up as test case</button>' +
      '<button data-action="cover" data-key="' + esc(f.key) + '"' + dis + '>Already covered…</button><span class="grow"></span>' +
      '<button class="ghost danger" data-action="del-finding" data-key="' + esc(f.key) + '"' + dis + '>Delete</button></div></div>';
  }

  /** A test suite dropdown for a form (which suite a new finding or case goes to). */
  function suitePicker(id, bind, value, change) {
    var tabs = runTabs();
    return '<div class="suite-pick"><label for="' + id + '">Test suite</label><select id="' + id + '" ' + (change ? 'data-change="' + change + '"' : 'data-bind="' + bind + '"') + '>' +
      tabs.map(function (t) { return opt(t.name, TR.tabLabel(t.name), t.name === value); }).join('') + '</select></div>';
  }

  /**
   * Findings: bugs and scenarios found while testing that are not in the test
   * cases yet (noted by hand or by Bug Reporter). Each is written up here as a
   * test case, which adds it to the workbook, or marked as already covered.
   */
  function viewFindings() {
    var dis = S.readOnly ? ' disabled' : '';
    var only = val('findingsSuite', '');
    var list = S.findings.filter(function (f) { return !only || (f.tab || S.tab) === only; });
    var open = list.filter(function (f) { return f.state === 'open'; });
    var done = list.filter(function (f) { return f.state !== 'open'; });
    var show = val('findingsShow', 'open');
    var tabs = runTabs();
    var rail = '<div class="rail-group" role="group" aria-label="Show"><span class="rail-title">Show</span>' +
      '<button class="chip" data-action="findings-show" data-show="open" aria-pressed="' + (show === 'open') + '">Open <span class="n">' + open.length + '</span></button>' +
      '<button class="chip" data-action="findings-show" data-show="done" aria-pressed="' + (show === 'done') + '" title="Written up as test cases, or covered by one">Done <span class="n">' + done.length + '</span></button></div>' +
      (tabs.length > 1 ? '<div class="rail-group"><label class="rail-title" for="findingsSuite">Test suite</label><select id="findingsSuite" data-change="findings-suite"><option value="">All test suites</option>' +
        tabs.map(function (t) { return opt(t.name, TR.tabLabel(t.name), t.name === only); }).join('') + '</select></div>' : '');
    var h = '<div class="row section-head"><div class="grow"><h2>Findings</h2><p class="small muted">Things found while testing that are not test cases yet. Write each one up as a test case, or mark it covered by one.</p></div>' +
      (S.readOnly ? '' : '<button data-action="note-toggle" aria-expanded="' + !!val('noteOpen') + '" title="Note something you found, to write up later (Bug Reporter adds them when you tick its Test Run box)"' + dis + '>+ Add finding</button>' +
        '<button data-action="new-case" aria-expanded="' + (S.manual.length > 0) + '" title="Add a test case to the workbook now"' + dis + '>+ New test case</button>') + '</div>';
    if (S.manual.length) {
      var mtab = val('man:tab', only || S.tab);
      var msm = suiteOf(mtab);
      h += '<div class="card card-pad section"><div class="row" style="margin-bottom:8px"><h3 class="grow">New test case</h3>' + suitePicker('manTab', 'man:tab', mtab, 'man-suite') + '</div>' +
        (msm ? datalists(msm) + scenarioEditor(S.manual[0], 'man:0', '<button class="ghost" data-action="discard-manual">Discard</button><button class="primary" data-action="add-manual" data-index="0"' + dis + '>Add to workbook</button>', msm)
          : '<div class="loading">Reading ' + esc(mtab) + '…</div>') + '</div>';
    }
    if (!S.readOnly && val('noteOpen')) {
      h += '<div class="card card-pad section"><div class="row"><h3 class="grow">New finding</h3>' + suitePicker('fTab', 'fTab', val('fTab', only || S.tab)) + '</div>' +
        '<div class="form-grid" style="margin-top:8px"><div class="wide"><label for="fText">What did you find?</label><input id="fText" data-bind="fText" placeholder="e.g. Citizen cannot reopen a complaint resolved 4 days ago" value="' + esc(val('fText')) + '"' + dis + '></div>' +
        '<div><label for="fIssue">Issue link <span class="faint">(optional)</span></label><input id="fIssue" data-bind="fIssue" placeholder="https://…/issues/123" value="' + esc(val('fIssue')) + '"' + dis + '></div>' +
        '<div><label for="fArea">Area</label><input id="fArea" data-bind="fArea" list="dl_group2" placeholder="Not sure" value="' + esc(val('fArea')) + '"' + dis + '></div>' +
        '<div class="wide"><label for="fDetails">Details (optional)</label><textarea id="fDetails" data-bind="fDetails" rows="2"' + dis + '>' + esc(val('fDetails')) + '</textarea></div></div>' +
        datalists(suiteOf(val('fTab', only || S.tab))) +
        '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="ghost" data-action="note-toggle">Cancel</button><button class="primary" data-action="add-finding"' + dis + '>Save finding</button></div></div>';
    }
    h += '<div class="section stack">';
    if (show === 'open') {
      if (!open.length) h += '<div class="empty card"><p>Nothing waiting. Findings you add, or Bug Reporter adds, show up here.</p></div>';
      open.forEach(function (f) { h += findingCard(f, dis); });
    } else {
      if (!done.length) h += '<div class="empty card"><p>Nothing done yet. Findings written up as test cases, or covered by one, move here.</p></div>';
      done.forEach(function (f) {
        var st = f.state === 'written' ? pill('pass', 'Written up' + (f.caseId ? ' as ' + f.caseId : '')) : pill('none', 'Covered' + (f.caseId ? ' by ' + f.caseId : ''));
        h += '<div class="item finding done"><div class="row"><span class="mono faint">' + esc(f.key) + '</span><span class="grow">' + esc(f.text) + '</span><span class="pill outline">' + esc(TR.tabLabel(f.tab || S.tab)) + '</span>' + st +
          (S.readOnly ? '' : '<button class="ghost" data-action="reopen-finding" data-key="' + esc(f.key) + '">Reopen</button>') + '</div></div>';
      });
    }
    h += '</div>';
    return withRail(rail, h);
  }

  // ---------------------------------------------------------------------------
  // Writing a test case by hand
  // ---------------------------------------------------------------------------

  var DRAFT_FIELDS = [
    { f: 'scenario', label: 'Scenario', col: 'scenario', wide: true, rows: 2 },
    { f: 'feature', label: 'Feature', col: 'feature', list: 'group1' },
    { f: 'subFeature', label: 'Sub feature', col: 'subFeature', list: 'group2' },
    { f: 'testType', label: 'Test type', col: 'testType', list: 'testType' },
    { f: 'issue', label: 'Issue link', col: 'linkedIssue', always: true }, // the column is added when needed
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

  function collectDraft(prefix, it, sm) {
    var out = {};
    DRAFT_FIELDS.forEach(function (d) { out[d.f] = draftValue(prefix, it, d.f); });
    out.expected = String(out.expected).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    out.status = val(prefix + ':status', defaultStatus(it, sm));
    out.comment = val(prefix + ':comment', '');
    out.fromFinding = it.fromFinding || '';
    return out;
  }

  function defaultStatus(it, sm) {
    if (!it.issue) return '';
    var fail = ((sm || suiteOf(S.tab) || {}).statusOptions || []).filter(function (o) { return o.cls === 'fail'; })[0];
    return fail ? fail.value : '';
  }

  /** The fields of a new test case, for the suite sm (the open one by default). */
  function scenarioEditor(it, prefix, actionsHtml, sm) {
    sm = sm || suiteOf(S.tab);
    var dis = S.readOnly ? ' disabled' : '';
    var h = '<div class="form-grid">';
    var unmapped = [];
    DRAFT_FIELDS.forEach(function (d) {
      var v = draftValue(prefix, it, d.f);
      if (!d.always && !(sm.fields && sm.fields[d.col] >= 0)) { if (String(v).trim()) unmapped.push(d.label.replace(/ \(.*\)$/, '') + ': "' + String(v).slice(0, 60) + '"'); return; }
      var id = prefix.replace(/[^\w-]/g, '_') + '_' + d.f;
      var listId = d.list ? 'dl_' + d.list : '';
      h += '<div' + (d.wide ? ' class="wide"' : '') + '><label for="' + id + '">' + esc(d.label) + '</label>' +
        (d.rows ? '<textarea id="' + id + '" data-bind="' + esc(prefix + ':' + d.f) + '" rows="' + d.rows + '"' + dis + '>' + esc(v) + '</textarea>'
          : '<input id="' + id + '" data-bind="' + esc(prefix + ':' + d.f) + '" value="' + esc(v) + '"' + (listId ? ' list="' + listId + '"' : '') + dis + '>') + '</div>';
    });
    if (sm.hasCycle) {
      var st = val(prefix + ':status', defaultStatus(it, sm));
      h += '<div><label for="' + prefix.replace(/[^\w-]/g, '_') + '_status">Result' + (sm.cycle ? ' in cycle ' + esc(sm.cycle) : '') + '</label><select id="' + prefix.replace(/[^\w-]/g, '_') + '_status" data-bind="' + esc(prefix + ':status') + '"' + dis + '><option value="">Not run yet</option>' +
        sm.statusOptions.map(function (o) { return opt(o.value, o.value, o.value === st); }).join('') + '</select></div>';
      if (sm.hasComment) h += '<div><label>Comment</label><input data-bind="' + esc(prefix + ':comment') + '" value="' + esc(val(prefix + ':comment', '')) + '"' + dis + '></div>';
    }
    h += '</div>';
    var notes = '';
    var tags = (it.edgeCase ? '<span class="pill accent">Edge case</span>' : '') + (it.fromFinding ? '<span class="pill outline">From ' + esc(it.fromFinding) + '</span>' : '');
    if (tags) notes += '<div class="row">' + tags + '</div>';
    if (it.hint) notes += '<div class="note info">Finding ' + esc(it.fromFinding || '') + ': ' + esc(it.hint) + '</div>';
    if (it.duplicates && it.duplicates.length) {
      notes += '<div class="note">Looks similar to ' + it.duplicates.map(function (d) { return '<b>' + esc(d.id || d.key) + '</b> (' + esc(d.scenario.slice(0, 90)) + ')'; }).join(', ') + '. Check it is not a duplicate.</div>';
    }
    if (unmapped.length) notes += '<div class="note info">This test suite has no column for: ' + esc(unmapped.join('; ')) + '. That part will not be saved.</div>';
    return '<div class="item">' + (notes ? '<div class="stack" style="margin-bottom:8px">' + notes + '</div>' : '') + h + '<div class="row" style="margin-top:10px"><span class="grow"></span>' + actionsHtml + '</div></div>';
  }

  function datalists(sm) {
    var cases = sm ? sm.cases : (S.model ? S.model.cases : []);
    return ['group1', 'group2', 'testType'].map(function (k) {
      var vals = [];
      cases.forEach(function (c) { var v = String(c[k] || '').trim(); if (v && vals.indexOf(v) < 0) vals.push(v); });
      return '<datalist id="dl_' + k + '">' + vals.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  /** Summary of the test suite and cycle open. (Automation has its own place in the Test suites strip.) */
  function viewSummary() {
    return viewManualSummary();
  }

  /** Pass, fail, other and not-run counts over every automation tab ({..., total}), or null before they are read. */
  function autoTotals(given) {
    var r = given || S.autoSummary;
    if (!r || (!given && r.book !== book()) || r.error) return null;
    var all = { pass: 0, fail: 0, other: 0, none: 0, total: 0 };
    r.tabs.forEach(function (t) { if (!t.error) ['pass', 'fail', 'other', 'none', 'total'].forEach(function (k) { all[k] += t.counts[k]; }); });
    return all;
  }

  function autoKpi(cls, value, label) {
    return '<div class="card kpi ' + cls + '"><div class="v">' + esc(value) + '</div><div class="l">' + esc(label) + '</div></div>';
  }

  /** Automated: the latest results of each automation tab, by test file, and what is failing. */
  function viewAutomation() {
    var r = S.autoSummary;
    if (!r || r.book !== book()) {
      if (!S.autoLoading) {
        S.autoLoading = true;
        api('api_automationSummary').then(function (x) {
          S.autoLoading = false;
          S.autoSummary = x.ok ? x : { book: book(), error: x.error, tabs: [] };
          S.autoSummary.book = x.book || book();
          render();
        });
      }
      return '<div class="loading">Reading the automation results…</div>';
    }
    return automationHtml(r, { live: true });
  }

  /** The automation summary (r: tr_automationSummary's result). live: in Test Run (else a published copy). */
  function automationHtml(r, opts) {
    var live = !!(opts && opts.live);
    if (r.error) return '<div class="banner bad">' + esc(r.error) + '</div>';
    var tabs = r.tabs.filter(function (t) { return !t.error; });
    if (!r.tabs.length) {
      return '<div class="empty card"><h3>No automation results in this workbook</h3><p>' + (live && isOwner() ? 'In <b>Setup</b>, mark the tab that holds your automated test results as <b>Automation results</b>.' : 'This workbook has no tab of automated test results.') + '</p></div>';
    }
    var all = autoTotals(r);
    var ran = all.pass + all.fail;
    var h = (opts && opts.bare ? '' : '<div class="report-tools no-print"><span class="updated">Updated on: ' + esc(r.generatedAt) + '</span><span class="grow"></span>' +
        (live ? '<button data-action="auto-refresh">Refresh</button>' : '') + '<button data-action="print">Print / PDF</button></div>' +
        '<div class="print-only print-title">Automation · ' + esc(tabs.map(function (t) { return TR.tabLabel(t.tab); }).join(', ')) + ' · updated on ' + esc(r.generatedAt) + '</div>');
    h += '<div class="kpis">' + autoKpi('', String(all.total), 'automated tests') + autoKpi('pass', ran ? Math.round((all.pass / ran) * 100) + '%' : '–', 'pass rate (of Pass + Fail)') +
      autoKpi('fail', String(all.fail), 'failing') + autoKpi('', String(all.other), 'skipped or other') + '</div>';
    r.tabs.forEach(function (t) {
      if (t.error) { h += '<div class="banner warn section"><b>' + esc(TR.tabLabel(t.tab)) + ':</b> ' + esc(t.error) + '</div>'; return; }
      h += '<div class="section card"><div class="card-pad"><div class="row" style="margin-bottom:8px"><h2 title="' + esc(t.tab) + '">' + esc(TR.tabLabel(t.tab)) + '</h2><span class="small muted">' + esc(t.cycle ? 'status column ' + t.cycle : 'latest status column') + '</span><span class="grow"></span>' + TR.legend(t.counts) + '</div>' + TR.bar(t.counts) + '</div>';
      h += '<div class="table-wrap"><table><thead><tr><th>Test file</th><th style="width:28%">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Other</th><th class="num">Not run</th></tr></thead><tbody>' +
        t.files.map(function (f) {
          return '<tr><td class="mono">' + esc(f.file) + '</td><td>' + TR.bar(f, true) + '</td><td class="num">' + f.pass + '</td><td class="num">' + f.fail + '</td><td class="num">' + f.other + '</td><td class="num">' + f.none + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
      h += '<div class="section card"><div class="card-pad"><h2>Failing in ' + esc(TR.tabLabel(t.tab)) + ' <span class="pill fail">' + t.failures.length + '</span></h2></div>' +
        (t.failures.length ? '<div class="table-wrap"><table><thead><tr><th>Test file</th><th>Test</th><th>Note</th></tr></thead><tbody>' + t.failures.map(function (f) {
          return '<tr><td class="mono">' + esc(f.file) + '</td><td>' + esc(f.test) + (f.group ? '<div class="small faint">' + esc(f.group) + '</div>' : '') + '</td><td class="ml">' + esc(f.note) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card-pad muted" style="padding-top:0">No failing automated tests.</div>') + '</div>';
    });
    if (live && S.summary && S.summary.tab === S.tab && S.summary.summary && S.summary.summary.automation) {
      var a = S.summary.summary.automation;
      h += '<div class="section card card-pad"><h2>Manual cases in ' + esc(S.tab) + ' linked to automation</h2><table style="margin-top:8px"><tbody>' +
        '<tr><td>Linked to a test file</td><td class="num"><b>' + a.linked + '</b> of ' + S.summary.summary.counts.total + '</td></tr>' +
        '<tr><td>Their automation passing</td><td class="num"><b class="sym-pass">' + a.pass + '</b></td></tr>' +
        '<tr><td>Their automation failing</td><td class="num"><b class="sym-fail">' + a.fail + '</b></td></tr></tbody></table></div>';
    }
    return h;
  }

  function viewManualSummary() {
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
    // The suite and cycle are picked above; on paper, one line says what it is.
    var h = '<div class="report-tools no-print"><span class="updated">Updated on: ' + esc(r.generatedAt) + '</span><span class="grow"></span>' +
      downloadButton('summary', '', 'Download', 'The workbook, with a Known issues sheet') + '<button data-action="print">Print / PDF</button>' +
      (isOwner() ? '<button data-action="publish-now" title="Publish the reports to the GitHub Pages site (Setup → Publish)"' + (S.publishBusy ? ' disabled' : '') + '>Publish</button>' : '') + '</div>' +
      '<div class="print-only print-title">' + esc(String(book() || '').replace(/\.xlsx$/i, '')) + ' · ' + esc(TR.tabLabel(r.tab)) + ' · cycle ' + esc(r.cycle || '–') + ' · updated on ' + esc(r.generatedAt) + '</div>';
    return h + TR.summaryHtml(r);
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  function setupDraft() {
    if (S.setup) return S.setup;
    var cfg = S.cfg || {};
    S.setup = {
      tabs: S.boot.tabs.map(function (t) {
        var src = t.saved || t.detected;
        return { name: t.name, role: src.role, headerRow: src.headerRow, columns: JSON.parse(JSON.stringify(src.columns || {})), fillDown: src.fillDown !== false, top: t.top, rows: t.rows, saved: !!t.saved };
      })
    };
    return S.setup;
  }

  var STATUS_HEAD = /^(?:test )?(?:execution )?(?:status|result)s?(?:\s*[\/|:\-–]\s*(.+)|\s+(\S*\d.*))?$/i;
  function isStatusHeader(x) { return STATUS_HEAD.test(String(x == null ? '' : x).replace(/\s+/g, ' ').trim()); }

  function youCard() {
    return '<section class="card card-pad stack"><h2>You <span class="small muted">(this computer, all workbooks)</span></h2>' +
      '<div class="form-grid"><div><label for="appUser">Your name (fills <i>Tested by</i>)</label><input id="appUser" data-bind="app:user" value="' + esc(val('app:user', S.app.settings.user)) + '"></div></div>' +
      '<div class="row"><span class="grow"></span><button data-action="save-app">Save</button></div></section>';
  }

  var teamPoll = null;
  function loadTeam() {
    if (S.teamLoading) return;
    S.teamLoading = true;
    TR.http('GET', '/api/team').then(function (r) {
      S.teamLoading = false;
      if (!r.ok) { toast(r.error, 'bad'); return; }
      S.team = r;
      render();
      pollTeam();
      if (!S.teamChecked && (r.team.hostedUrl || (r.team.mode === 'fixed' && r.team.fixedUrl))) { S.teamChecked = true; teamCall('/api/team/check'); }
    });
  }

  /** While the tunnel is starting or reconnecting, look again shortly. */
  function pollTeam() {
    clearTimeout(teamPoll);
    var a = S.team && S.team.address;
    if (!a || S.view !== 'setup') return;
    if (a.tunnel.reconnectIn != null || (a.tunnel.running && !a.tunnel.url)) teamPoll = setTimeout(loadTeam, 3000);
  }

  function teamCall(path, body, done) {
    return TR.http('POST', path, body || {}).then(function (r) {
      if (!r.ok) { toast(r.error, 'bad'); render(); return r; }
      S.team = r;
      if (done) done(r);
      render();
      pollTeam();
      return r;
    });
  }

  /**
   * Put a person's invite link on the clipboard and say so. Only if the browser blocks
   * copying is the link shown on the page instead, to copy by hand.
   */
  function deliverLink(name, link, warn, lead) {
    copyText(link).then(function (ok) {
      if (ok) {
        S.teamLink = null;
        toast((lead || '') + name + '\'s invite link is copied. Send it to them privately.' + (warn ? ' ' + warn : ''), warn ? 'long' : '');
      } else {
        S.teamLink = { name: name, link: link, warn: warn };
        toast('Copying was blocked: copy the link shown under People.', 'bad');
      }
      render();
      if (!ok) { var t = $('teamLink'); if (t) t.select(); }
    });
  }

  function currentReportSlug() {
    var idx = S.reports && S.reports.index;
    if (!idx) return '';
    var slug = val('rBook', '');
    return (idx.workbooks.filter(function (x) { return x.slug === slug; })[0] || idx.workbooks[0]).slug;
  }

  function copyAdminLink(r) {
    copyText(r.link).then(function (ok) {
      if (ok) { S.teamLink = null; toast('Your admin link is copied. Open it on the other computer; keep it to yourself.' + (r.linkWarning ? ' ' + r.linkWarning : ''), 'long'); }
      else { S.teamLink = { name: 'your admin link', link: r.link, warn: r.linkWarning }; toast('Copying was blocked: copy the link shown under People.', 'bad'); }
      render();
    });
  }

  function checkLine(c, okText) {
    if (!c) return '';
    return '<div class="check-line ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '✓ ' + esc(okText || c.message) : '✗ ' + esc(c.message)) + ' <span class="faint">(' + esc(c.at) + ')</span></div>';
  }

  /** Setup → Team: who may use this Test Run, and how they reach this laptop. */
  function teamCard() {
    if (!isOwner()) return '';
    var r = S.team;
    var h = '<section class="section card card-pad stack team-card" id="team">';
    var head = function (on) {
      return '<div class="row team-head"><div class="grow"><h2>Team</h2><p class="small muted">Testers and managers open Test Run in their own browser with an invite link; nothing to install. This laptop must stay on while they work.</p></div>' +
        (on == null ? '' : '<label class="check team-switch"><input type="checkbox" data-action="team-enable"' + (on ? ' checked' : '') + '> Share with my team</label>') + '</div>';
    };
    if (!r) { loadTeam(); return h + head(null) + '<div class="loading">Loading…</div></section>'; }
    var t = r.team;
    var a = r.address;
    h += head(t.enabled);
    if (!t.enabled) return h + '<p class="small faint">Off: only this computer can open Test Run.</p></section>';

    // Connection: how the team reaches this laptop
    h += '<div class="team-block"><h3>Connection</h3>';
    h += '<div class="way-choice" role="radiogroup" aria-label="Way in">' +
      '<label class="way' + (t.mode === 'quick' ? ' on' : '') + '"><input type="radio" name="teamMode" data-action="team-mode" value="quick"' + (t.mode === 'quick' ? ' checked' : '') + '><span><b>Quick tunnel</b><span class="small muted">Free, no account. A new address each time it starts.</span></span></label>' +
      '<label class="way' + (t.mode === 'fixed' ? ' on' : '') + '"><input type="radio" name="teamMode" data-action="team-mode" value="fixed"' + (t.mode === 'fixed' ? ' checked' : '') + '><span><b>Fixed address</b> <span class="pill accent">best for a team</span><span class="small muted">Never changes. A one-time setup (Tailscale or Cloudflare).</span></span></label></div>';

    if (t.mode === 'quick') {
      if (a.tunnel.running || a.tunnel.reconnectIn != null) {
        h += '<div class="row conn-status"><span class="pill ' + (a.tunnel.url ? 'pass' : 'other') + '">' + (a.tunnel.url ? 'Shared' : a.tunnel.reconnectIn != null ? 'Reconnecting' : 'Starting') + '</span>' +
          '<span class="mono grow">' + esc(a.tunnel.url || (a.tunnel.reconnectIn != null ? 'trying again in ' + a.tunnel.reconnectIn + ' s' : 'opening the tunnel…')) + '</span><button data-action="team-share" data-on="0">Stop sharing</button></div>';
      } else if (a.tunnel.available) {
        h += '<div class="row conn-status"><button class="primary" data-action="team-share" data-on="1">Start sharing over the internet</button><span class="small muted">Opens a Cloudflare quick tunnel to this laptop.</span></div>';
      } else {
        h += '<div class="note info">Install <span class="mono">cloudflared</span> first: <span class="mono">brew install cloudflared</span>. Then press Start here, or run <span class="mono">npm run share</span>.</div>';
      }
      if (a.tunnel.error) h += '<div class="note ' + (a.tunnel.reconnectIn != null ? 'info' : 'bad') + '">' + esc(a.tunnel.error) + '</div>';

      // Links that outlive the address: the summary line, the settings folded away
      var hc = r.checks.hosted;
      var live = !!(hc && hc.ok);
      var keeps = t.publish && t.gist && live;
      h += '<div class="links-verdict small ' + (keeps ? 'ok' : 'warn') + '">' + (keeps ? '✓ Invite links keep working when the address changes.' : 'Invite links stop working when the tunnel restarts' + (t.publish && live ? ', until the gist is written.' : '. Set up the link settings below to keep them working.')) + '</div>';
      h += '<details class="how link-settings"' + (keeps ? '' : ' open') + '><summary class="small"><b>Link settings</b> <span class="muted">hosted page and secret gist</span></summary><div class="stack-s">' +
        '<p class="small muted">Invite links open the console on GitHub Pages (the hosted page), which looks up this laptop’s current address in a secret GitHub gist. If the tunnel drops (sleep, Wi-Fi change), Test Run opens it again by itself and updates the gist.</p>' +
        '<label class="check"><input type="checkbox" data-action="team-publish"' + (t.publish ? ' checked' : '') + '> Keep the current address in a secret gist <span class="faint">(uses your <span class="mono">gh</span> login)</span></label>' +
        (t.gist ? '<div class="small muted" style="margin-left:24px">Gist <a href="https://gist.github.com/' + esc(t.gist) + '" target="_blank" rel="noopener" class="mono">' + esc(t.gist.slice(0, 8)) + '…</a>' + (t.publishedAt ? ', updated ' + esc(t.publishedAt) : '') + '.</div>' : '') +
        (t.publishError ? '<div class="note bad">' + esc(t.publishError) + '</div>' : '') +
        '<div class="form-grid"><div class="wide"><label for="teamHosted">Hosted page</label><div class="row"><input id="teamHosted" class="grow" type="url" data-bind="team:hostedUrl" placeholder="' + esc(r.suggest.hostedUrl || 'https://you.github.io/repo/test-run/') + '" value="' + esc(val('team:hostedUrl', t.hostedUrl)) + '">' +
        (r.suggest.hostedUrl && r.suggest.hostedUrl !== t.hostedUrl ? '<button class="ghost" data-action="team-use" data-field="hostedUrl" data-value="' + esc(r.suggest.hostedUrl) + '" title="This repository\'s GitHub Pages address">Use ' + esc(r.suggest.hostedUrl.replace(/^https:\/\//, '')) + '</button>' : '') +
        '<button data-action="team-save">Save</button></div>' + checkLine(hc, 'Live: invite links open there.') + '</div></div>';
      if (t.hostedUrl && hc && !hc.ok) {
        h += '<div class="note info stack-s"><div><b>To put the console on GitHub Pages</b> (once):</div><ol class="small"><li>In the repository on GitHub: <b>Settings → Pages → Source: GitHub Actions</b>.</li><li>Merge this branch into <span class="mono">master</span>. The <i>Test Run Pages</i> workflow then publishes the console at <span class="mono">' + esc(r.suggest.hostedUrl || 'https://<owner>.github.io/<repo>/test-run/') + '</span>.</li><li>Press <b>Check</b> here. Until it is live, new invite links name the current tunnel address instead.</li></ol><div><button data-action="team-check">Check</button></div></div>';
      }
      h += '</div></details>';
    } else {
      var fc = r.checks.fixed;
      h += '<div class="form-grid"><div class="wide"><label for="teamFixed">Fixed address</label><div class="row"><input id="teamFixed" class="grow" type="url" data-bind="team:fixedUrl" placeholder="https://my-mac.tail1234.ts.net" value="' + esc(val('team:fixedUrl', t.fixedUrl)) + '">' +
        (r.suggest.tailscaleUrl && r.suggest.tailscaleUrl !== t.fixedUrl ? '<button class="ghost" data-action="team-use" data-field="fixedUrl" data-value="' + esc(r.suggest.tailscaleUrl) + '" title="This Mac\'s Tailscale address">Use ' + esc(r.suggest.tailscaleUrl.replace(/^https:\/\//, '')) + '</button>' : '') +
        '<button data-action="team-check"' + (t.fixedUrl ? '' : ' disabled') + '>Check</button></div>' + checkLine(fc) + '</div>' +
        '<div class="wide"><label for="teamTunnel">Cloudflare named tunnel <span class="faint">(optional: Test Run runs it while sharing, and starts it again if it drops)</span></label><input id="teamTunnel" data-bind="team:tunnelName" placeholder="e.g. test-run" value="' + esc(val('team:tunnelName', t.tunnelName)) + '"></div></div>' +
        '<div class="row"><span class="grow"></span><button data-action="team-save">Save</button></div>';
      if (t.tunnelName) {
        h += a.tunnel.running || a.tunnel.reconnectIn != null
          ? '<div class="row conn-status"><span class="pill ' + (a.tunnel.url ? 'pass' : 'other') + '">' + (a.tunnel.url ? 'Tunnel running' : 'Reconnecting') + '</span><span class="mono grow">' + esc(t.tunnelName) + '</span><button data-action="team-share" data-on="0">Stop the tunnel</button></div>'
          : '<div class="row"><button class="primary" data-action="team-share" data-on="1"' + (a.tunnel.available ? '' : ' disabled') + '>Start tunnel ' + esc(t.tunnelName) + '</button></div>';
        if (a.tunnel.error) h += '<div class="note ' + (a.tunnel.reconnectIn != null ? 'info' : 'bad') + '">' + esc(a.tunnel.error) + '</div>';
      }
      h += '<div class="small muted">Reached at: ' + (a.effective ? '<span class="mono">' + esc(a.effective) + '</span>' : '<b>no address yet</b>') + '</div>';
      var port = r.suggest.port || 5178;
      h += '<details class="how"' + (t.fixedUrl ? '' : ' open') + '><summary class="small"><b>How to get a fixed address</b></summary><div class="small stack-s">' +
        '<div><b>Tailscale Funnel</b> (free, no domain needed)<ol><li>Install Tailscale on this Mac (<span class="mono">brew install --cask tailscale</span>, or from the App Store) and sign in.</li><li>In Terminal: <span class="mono">tailscale funnel --bg ' + port + '</span>. The first time, it gives you a link to allow Funnel for your account.</li><li>Your address is <span class="mono">https://&lt;this-mac&gt;.&lt;tailnet&gt;.ts.net</span> (<span class="mono">tailscale funnel status</span> shows it). Enter it above and press Check. It keeps working after restarts.</li></ol></div>' +
        '<div><b>Cloudflare named tunnel</b> (needs a domain you manage in Cloudflare)<ol><li><span class="mono">cloudflared tunnel login</span></li><li><span class="mono">cloudflared tunnel create test-run</span></li><li><span class="mono">cloudflared tunnel route dns test-run testrun.your-domain.org</span></li><li>Enter <span class="mono">https://testrun.your-domain.org</span> above and <span class="mono">test-run</span> as the tunnel name, then Start.</li></ol></div>' +
        '<div class="faint">Teammates need nothing installed for either: they just open their invite link.</div></div></details>';
    }
    h += '</div>';

    // Your admin link: the owner, from another computer
    var ad = r.admin || { exists: false };
    var aoff = r.canInvite ? '' : ' disabled';
    h += '<div class="team-block"><div class="row"><h3>Your admin link</h3><span class="small muted grow">Full control from another computer or network. Keep it to yourself, like a password.</span></div>' +
      (me().admin ? '<div class="note info">You are using your admin link now. Stopping sharing or making a new admin link disconnects this browser.</div>' : '') +
      '<div class="row">' + (ad.exists
        ? '<button data-action="admin-copy"' + (ad.canCopy ? aoff : ' disabled') + '>Copy admin link</button><button class="ghost" data-action="admin-new"' + aoff + ' title="Make a new admin link; the old one stops working">New admin link</button><button class="ghost danger" data-action="admin-remove">Remove</button>' +
          '<span class="small faint">' + (ad.lastSeen ? 'Last used ' + esc(ad.lastSeen) : 'Not used yet') + '</span>'
        : '<button data-action="admin-new"' + aoff + '>Make my admin link</button>') + '</div>' +
      (r.canInvite ? '' : '<p class="small faint">Links need an address first: ' + (t.mode === 'quick' ? 'start sharing above.' : 'enter your fixed address above.') + '</p>') + '</div>';

    // People: each with their access and the workbooks they can open
    var books = (S.app && S.app.books || []).map(function (b) { return b.name; });
    var bookPick = function (attrs, current) {
      var cur = current && current.length ? current[0] : '';
      return '<select ' + attrs + '>' + opt('', 'All workbooks', !cur) + books.map(function (n) { return opt(n, n.replace(/\.xlsx$/i, ''), n === cur); }).join('') +
        (cur && books.indexOf(cur) < 0 ? opt(cur, cur.replace(/\.xlsx$/i, '') + ' (deleted)', true) : '') + '</select>';
    };
    h += '<div class="team-block"><h3>People</h3>';
    if (S.teamLink) {
      h += '<div class="note info stack-s"><span>This browser did not let Test Run copy the link for <b>' + esc(S.teamLink.name) + '</b>. Copy it from here and send it to them privately.</span>' +
        '<div class="row"><input id="teamLink" readonly value="' + esc(S.teamLink.link) + '" class="grow mono"><button class="primary" data-action="copy-link">Copy</button><button class="ghost" data-action="hide-link">Done</button></div>' +
        (S.teamLink.warn ? '<span class="small">' + esc(S.teamLink.warn) + '</span>' : '') + '</div>';
    }
    if (r.people.length) {
      h += '<div class="table-wrap"><table class="people"><thead><tr><th>Name</th><th>Access</th><th>Workbooks</th><th>Last seen</th><th></th></tr></thead><tbody>' + r.people.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td><select aria-label="Access for ' + esc(p.name) + '" data-change="team-role" data-id="' + esc(p.id) + '">' +
          opt('tester', 'Update status', p.role === 'tester') + opt('viewer', 'View only', p.role === 'viewer') + '</select></td>' +
          '<td>' + bookPick('aria-label="Workbooks ' + esc(p.name) + ' can open" data-change="team-books" data-id="' + esc(p.id) + '"', p.books) + '</td>' +
          '<td class="small muted">' + esc(p.lastSeen || 'not yet') + '</td>' +
          '<td class="num"><div class="row" style="justify-content:flex-end">' +
          '<button class="ghost" data-action="team-copy" data-id="' + esc(p.id) + '"' + (p.canCopy && r.canInvite ? '' : ' disabled') +
          ' title="' + (!p.canCopy ? 'This link was made before links could be copied again: use New link once' : !r.canInvite ? 'Links need an address first' : 'Copy ' + esc(p.name) + '\'s link again (it keeps working)') + '">Copy link</button>' +
          '<button class="ghost" data-action="team-rotate" data-id="' + esc(p.id) + '" title="Make a new link; the old one stops working">New link</button>' +
          '<button class="ghost danger" data-action="team-remove" data-id="' + esc(p.id) + '">Remove</button></div></td></tr>';
      }).join('') + '</tbody></table></div>';
    } else {
      h += '<p class="small faint">Nobody yet.</p>';
    }
    var off = r.canInvite ? '' : ' disabled';
    h += '<div class="row add-person"><label class="sr" for="teamName">Name</label><input id="teamName" data-bind="team:name" placeholder="Name, e.g. Priya (QA)" value="' + esc(val('team:name')) + '"' + off + '>' +
      // No access chosen for them until you choose one
      '<label class="sr" for="teamRole">Access</label><select id="teamRole" class="choose" data-bind="team:role"' + off + '>' +
      '<option value="" disabled' + (val('team:role') ? '' : ' selected') + '>Select access</option>' + opt('tester', 'Update status', val('team:role') === 'tester') + opt('viewer', 'View only', val('team:role') === 'viewer') + '</select>' +
      '<label class="sr" for="teamBooks">Workbooks</label>' + bookPick('id="teamBooks" data-bind="team:books"' + off, val('team:books') ? [val('team:books')] : null) +
      '<button data-action="team-add"' + off + '>Add and make a link</button></div>' +
      (r.canInvite ? '' : '<p class="small faint">Links need an address first: ' + (t.mode === 'quick' ? 'start sharing above.' : 'enter your fixed address above.') + '</p>') + '</div>';
    return h + '</section>';
  }

  /** Setup for one test case tab: the current cycle, starting a new one, the release in scope. */
  function cycleSetup(t, ti) {
    var saved = (S.cfg && S.cfg.tabs && S.cfg.tabs[t.name]) || {};
    var headers = (t.top && t.top[t.headerRow - 1]) || [];
    var cycles = headers.filter(isStatusHeader);
    // An earlier cycle can be removed (×) to keep the workbook and the reports tidy; the last one stays.
    var canRemove = t.saved && cycles.length > 1 && !S.readOnly;
    var h = '<div class="subsection"><h3>Test cycles</h3><p class="small muted">A cycle is a pair of columns: <i>Test Status / name</i> and <i>Comment / name</i>. Earlier cycles stay, so you can compare' + (canRemove ? ', until you remove one with <b>×</b>' : '') + '.</p>' +
      '<div class="small cycle-chips">Status columns: ' + (cycles.length ? cycles.map(function (x) {
        var name = String(x).replace(/\s+/g, ' ').trim();
        return '<span class="pill outline cycle-chip">' + esc(name) + (canRemove ? '<button class="chip-x" data-action="cycle-remove" data-tab="' + esc(t.name) + '" data-header="' + esc(name) + '" aria-label="Remove the cycle ' + esc(name) + '" title="Remove this cycle and its results">×</button>' : '') + '</span>';
      }).join(' ') : '<span class="faint">none yet</span>') + '</div>';
    if (!t.saved) return h + '<p class="small faint">Save first to start cycles here.</p></div>';
    h += '<div class="row"><label class="sr" for="newCycle' + ti + '">New cycle name</label><input id="newCycle' + ti + '" data-bind="newCycle:' + ti + '" placeholder="New cycle, e.g. v2.20.1" value="' + esc(val('newCycle:' + ti)) + '">' +
      '<button data-action="start-cycle" data-tab="' + esc(t.name) + '" data-index="' + ti + '">Start new cycle</button><span class="small faint">Adds the two columns next to the latest cycle, with its dropdown and formatting.</span></div>';
    if (t.columns.release) {
      h += '<div class="row"><label for="release' + ti + '">Release in scope</label><input id="release' + ti + '" data-bind="release:' + ti + '" placeholder="e.g. 2.20.1" value="' + esc(val('release:' + ti, saved.release || '')) + '">' +
        '<button data-action="save-release" data-tab="' + esc(t.name) + '" data-index="' + ti + '">Save</button><span class="small faint">The release you are testing. Cases whose <i>' + esc(t.columns.release) + '</i> column says it are tagged <b>New in</b> it and come first in Run. Cycles are rounds of results; a release can take several.</span></div>';
    }
    return h + '</div>';
  }

  /** Setup, in two parts: Workbook (test suites, cycles, columns) and Sharing (you and your team). */
  function viewSetup() {
    var part = S.cfg ? val('setupPart', 'workbook') : 'workbook'; // a workbook not set up yet opens on its tabs
    var rail = '<div class="rail-group subtabs" role="tablist" aria-label="Setup"><span class="rail-title">Setup</span>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="workbook" aria-selected="' + (part === 'workbook') + '">Workbook</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="sharing" aria-selected="' + (part === 'sharing') + '">Sharing' + (S.team && S.team.team && S.team.team.enabled ? ' <span class="pill pass">on</span>' : '') + '</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="publish" aria-selected="' + (part === 'publish') + '">Publish</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="media" aria-selected="' + (part === 'media') + '">Media</button></div>' +
      (part === 'workbook' ? '<p class="small muted rail-note">This sets up the workbook chosen in <b>Workbook</b> at the top right. To set up another one, choose it there first.</p>'
        : part === 'sharing' ? '<p class="small muted rail-note">Sharing is for all workbooks: your team can switch between them at the top right.</p>'
          : part === 'media' ? '<p class="small muted rail-note">Media is for everyone using Test Run Extension: their screenshots and recordings follow these limits.</p>'
            : '<p class="small muted rail-note">Publishing puts the reports on the GitHub Pages site, for anyone, even when this laptop is off. It also lets someone else carry on from a clone of the repository.</p>');
    return withRail(rail, part === 'sharing' ? youCard() + teamCard() : part === 'publish' ? publishCard() : part === 'media' ? mediaCard() : setupWorkbook());
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  /** "about 1 min", "about 1 min 50 s" */
  function fmtClip(sec) {
    var m = Math.floor(sec / 60);
    var r = Math.round((sec % 60) / 10) * 10;
    if (r === 60) { m++; r = 0; }
    return 'about ' + (m ? m + ' min' : '') + (m && r ? ' ' : '') + (r ? r + ' s' : '');
  }

  function loadMedia() {
    if (S.mediaLoading) return;
    S.mediaLoading = true;
    TR.http('GET', '/api/media').then(function (r) { S.mediaLoading = false; S.media = r.ok ? r : { error: r.error }; render(); });
  }

  function setMedia(change) {
    TR.http('POST', '/api/media', change).then(function (r) { if (r.ok) { S.media = r; toast('Saved. Test Run Extension uses it from the next recording.'); render(); } else toast(r.error, 'bad'); });
  }

  /** Setup → Media: the limits everyone records with (host only). */
  function mediaCard() {
    var md = S.media;
    if (!md) { loadMedia(); return '<div class="loading">Loading the media settings…</div>'; }
    if (md.error) return '<div class="banner bad">' + esc(md.error) + '</div>';
    var keep = md.keepOptions.map(function (k) { return opt(String(k), k === 60 ? '1 hr' : k + ' min', k === md.keepMinutes); }).join('');
    return '<section class="card card-pad stack media-card"><div><h2>Media</h2><p class="small muted">Limits for everyone\'s screenshots and recordings in Test Run Extension. Testers can\'t change them.</p></div>' +
      '<div class="kv-grid">' +
      '<span class="kv-k">Video quality</span><span class="row"><span class="seg" role="group" aria-label="Video quality">' + md.qualities.map(function (q) {
        return '<button data-action="media-quality" data-quality="' + q + '" aria-pressed="' + (q === md.quality) + '">' + q + '</button>';
      }).join('') + '</span><span class="small muted">' + md.fps + ' fps · up to ' + fmtClip(md.maxSeconds) + ' per clip</span></span>' +
      '<span class="kv-k">Each file</span><span>Up to ' + fmtBytes(md.maxBytes) + ' <span class="small muted">(recording stops just before)</span></span>' +
      '<span class="kv-k">Photos</span><span>Up to ' + md.photo.width + '×' + md.photo.height + ', PNG</span>' +
      '<span class="kv-k">Audio</span><span>As picked in Chrome\'s share window</span>' +
      '<label class="kv-k" for="mediaKeep">Keep a Complete Report</label><span class="row"><select id="mediaKeep" data-change="media-keep">' + keep + '</select><span class="small muted">then it\'s deleted from this laptop</span></span>' +
      '</div>' +
      '<p class="small muted media-foot">Evidence stays on this laptop' + (md.used != null ? ' (' + fmtBytes(md.used) + ' used' + (me().local ? ', in <span class="mono">sheets/.testrun/evidence/</span>' : '') + ')' : '') + '. It is never published.</p></section>';
  }

  // ---------------------------------------------------------------------------
  // Publishing (the host only)
  // ---------------------------------------------------------------------------

  function loadPublish(refresh) {
    if (S.publishLoading) return;
    S.publishLoading = true;
    TR.http('GET', '/api/publish' + (refresh ? '?refresh=1' : '')).then(function (r) {
      S.publishLoading = false;
      S.publish = r.ok ? r : { error: r.error };
      render();
    });
  }

  /** Publish now: asks once that it is public, and before replacing a newer publish by someone else. */
  function publishNow(extra) {
    if (S.publishBusy) return;
    S.publishBusy = true;
    toast('Publishing to GitHub…');
    render();
    TR.http('POST', '/api/publish/now', extra || {}).then(function (r) {
      S.publishBusy = false;
      if (r.repo != null) S.publish = r;
      render();
      if (r.code === 'CONFIRM_PUBLIC') {
        if (window.confirm(r.error + '\n\nPublish now?')) publishNow(Object.assign({}, extra, { confirmPublic: true }));
        return;
      }
      if (r.code === 'NEWER_REMOTE') {
        if (window.confirm(r.error + '\n\nPress OK to publish anyway (theirs is replaced), or Cancel and use Get it first.')) publishNow(Object.assign({}, extra, { force: true }));
        return;
      }
      if (!r.ok) { toast(r.error || 'Could not publish.', 'bad'); return; }
      var down = r.books && !r.books.some(function (b) { return b.on; });
      toast(!(r.result && r.result.committed) ? 'Nothing changed since the last publish.' : down ? 'The published reports are taken off GitHub. The site updates in about a minute.' : 'Published to GitHub. The site updates in about a minute.', 'long');
    });
  }

  /** The publish choices being edited (saved ones until something is changed). */
  function pubDraft() {
    var r = S.publish;
    if (!S.pubDraft) {
      var books = {};
      r.books.forEach(function (b) { books[b.name] = !!b.on; });
      S.pubDraft = { books: books, nightly: !!r.settings.nightly, time: r.settings.time, onStop: !!r.settings.onStop };
    }
    return S.pubDraft;
  }

  /** What changed from the saved choices: { books: [{ name, on }], other: bool }. */
  function pubChanges() {
    var r = S.publish;
    var d = S.pubDraft;
    if (!r || !d) return { books: [], other: false };
    var st = r.settings;
    return {
      books: r.books.filter(function (b) { return !!d.books[b.name] !== !!b.on; }).map(function (b) { return { name: b.name, on: !!d.books[b.name] }; }),
      other: d.nightly !== !!st.nightly || d.time !== st.time || d.onStop !== !!st.onStop
    };
  }
  function pubDirty() { var c = pubChanges(); return c.books.length > 0 || c.other; }

  function savePublishPrefs(publishAfter) {
    var d = S.pubDraft;
    var body = { books: d.books, nightly: d.nightly, time: d.time, onStop: d.onStop };
    TR.http('POST', '/api/publish/settings', body).then(function (r) {
      if (!r.ok) { toast(r.error, 'bad'); return; }
      S.publish = r;
      S.pubDraft = null;
      closeModal();
      render();
      if (publishAfter) publishNow({ confirmPublic: true });
      else toast('Preferences saved.');
    });
  }

  /** Before saving a change to which workbooks are published: what it does to the public site. */
  function publishConfirmModal(changes) {
    var r = S.publish;
    var d = S.pubDraft;
    var on = changes.some(function (c) { return c.on; });
    var off = changes.some(function (c) { return !c.on; });
    var none = !r.books.some(function (b) { return d.books[b.name]; });
    openModal('<h2>Update the published reports?</h2>' +
      '<p class="small muted" style="margin-top:6px">Saving publishes right away, so the GitHub Pages site matches your choice in about a minute.</p>' +
      '<ul class="modal-list">' +
      (on ? '<li><b>The workbooks you ticked are published</b>, for anyone to read.</li>' : '') +
      (none ? '<li><b>Every published report is taken off the site.</b></li>' : off ? '<li><b>The workbooks you unticked are taken off the site.</b></li>' : '') +
      '<li>Earlier versions stay in the public repository\'s history.</li></ul>' +
      '<div class="row" style="margin-top:14px"><span class="grow"></span><button data-action="publish-cancel-books">Cancel</button>' +
      '<button class="primary" data-action="publish-confirm">Save and update the site</button></div>');
  }

  function publishCard() {
    var r = S.publish;
    var h = '<section class="card card-pad stack" id="publish"><h2>Publish to GitHub</h2>';
    if (!r) { loadPublish(); return h + '<div class="loading">Loading…</div></section>'; }
    if (r.error && r.repo == null) return h + '<div class="note bad">' + esc(r.error) + '</div></section>';
    h += '<div class="note warn"><b>Published workbooks are public.</b> Anyone can read them on GitHub and on the GitHub Pages site: test cases, results, comments, findings, tester names and issue links. They stay in the repository\'s history even if you stop publishing them. Invite keys and team settings are never published.</div>';
    if (r.problem) h += '<div class="note bad">' + esc(r.problem) + '</div>';
    else h += '<div class="small muted">Goes to <a href="https://github.com/' + esc(r.repo) + '/tree/' + esc(r.branch) + '/' + esc(r.folder) + '" target="_blank" rel="noopener" class="mono">' + esc(r.repo) + '</a>, branch <span class="mono">' + esc(r.branch) + '</span>, folder <span class="mono">' + esc(r.folder) + '</span>' + (r.isPrivate === false ? ' (a public repository)' : '') + '.</div>';
    if (r.newer && r.remote) {
      h += '<div class="note info row"><span class="grow"><b>' + esc(r.remote.by || 'Someone') + '</b> published at ' + esc(r.remote.at) + ', after this laptop last published or got the data.</span><button data-action="publish-get">Get it</button></div>';
    }
    var d = pubDraft();
    var dirty = pubDirty();
    h += '<div class="subsection"><h3>Workbooks to publish</h3>' + (r.books.length ? r.books.map(function (b) {
      return '<label class="check"><input type="checkbox" data-action="publish-book" data-name="' + esc(b.name) + '"' + (d.books[b.name] ? ' checked' : '') + '> ' + esc(b.name.replace(/\.xlsx$/i, '')) + '</label>';
    }).join('') : '<p class="small faint">No workbooks yet.</p>') +
      (r.books.length && !r.books.some(function (b) { return d.books[b.name]; }) ? '<p class="small muted">None ticked: publishing takes every published report off the site.</p>' : '') + '</div>';
    h += '<div class="subsection"><h3>When</h3>' +
      '<div class="row"><label class="check"><input type="checkbox" data-action="publish-nightly"' + (d.nightly ? ' checked' : '') + '> Every day at</label><input type="time" id="publishTime" data-change="publish-time" value="' + esc(d.time) + '"' + (d.nightly ? '' : ' disabled') + '><span class="small faint">while Test Run is running</span></div>' +
      '<label class="check"><input type="checkbox" data-action="publish-onstop"' + (d.onStop ? ' checked' : '') + '> When Test Run stops (Ctrl+C in its terminal)</label>' +
      (r.acknowledged ? '' : '<p class="small faint">These start after your first Publish now.</p>') + '</div>';
    // Changes above apply only once saved
    h += '<div class="row"><button class="primary" data-action="publish-save"' + (dirty ? '' : ' disabled') + ' title="' + (dirty ? 'Save these choices' : 'Nothing changed') + '">Save preferences</button>' +
      (dirty ? '<span class="small muted">Unsaved changes</span><button class="ghost" data-action="publish-discard">Discard</button>' : '') + '</div>';
    var l = r.last || {};
    h += '<div class="row publish-row"><button data-action="publish-now"' + (S.publishBusy || r.problem || dirty ? ' disabled' : '') + (dirty ? ' title="Save your preferences first"' : '') + '>' + (S.publishBusy ? 'Publishing…' : 'Publish now') + '</button>' +
      '<span class="small muted grow">' + (l.at ? 'Last published ' + esc(l.at) + (l.by ? ' by ' + esc(l.by) : '') + (l.commit ? ' · <a href="' + esc(l.url) + '" target="_blank" rel="noopener" class="mono">' + esc(l.commit.slice(0, 7)) + '</a>' : '') + (l.note ? ' · ' + esc(l.note) : '') : 'Not published from this laptop yet.') + '</span>' +
      '<a class="btn" href="?reports=1" target="_blank" rel="noopener" title="The last published reports, as anyone sees them, served from this laptop">Preview here</a>' +
      '</div>' +
      (l.error ? '<div class="note bad">' + esc(l.error) + '</div>' : '');
    return h + '</section>';
  }

  /** Each tab of the workbook: what it holds, its test cycles first, then its columns (set once, folded away). */
  function setupWorkbook() {
    var d = setupDraft();
    var dis = S.readOnly ? ' disabled' : '';
    var h = '';
    if (!S.cfg) h += '<div class="banner"><div><b>Welcome.</b> Check how each tab of <b>' + esc(S.boot.sheetName) + '</b> was read, then save. Settings are kept beside the workbook in <span class="mono">sheets/.testrun/</span>; the workbook itself does not change.</div></div>';
    d.tabs.forEach(function (t, ti) {
      var headers = (t.top && t.top[t.headerRow - 1]) || [];
      h += '<section class="section card card-pad stack"><div class="row"><h2 title="' + esc(t.name) + '">' + esc(TR.tabLabel(t.name)) + '</h2><span class="small muted">' + t.rows + ' rows</span>' +
        '<span class="grow"></span>' +
        '<label for="role' + ti + '" class="sr">Role</label><select id="role' + ti + '" data-setup-tab="' + ti + '" data-key="role"' + dis + '>' +
        opt('manual', 'Test suite (manual cases)', t.role === 'manual') + opt('automation', 'Automation results', t.role === 'automation') + opt('ignore', 'Ignore', t.role === 'ignore') + '</select></div>';
      if (t.role === 'ignore') { h += '<p class="small faint">Not used by the console.</p></section>'; return; }
      if (t.role === 'automation') {
        h += '<p class="small muted">Results here feed <b>Automation</b> (next to the test suites, at the top), and the <b>Auto</b> badges on manual cases. Manual cases link to a test file when their comment or an <i>Automated by</i> column names it (e.g. <span class="mono">inbox-search.spec</span>).</p></section>';
        return;
      }
      h += cycleSetup(t, ti);
      var mapped = S.boot.fields.filter(function (f) { return t.columns[f]; }).length;
      var openCols = !t.saved || val('colsOpen:' + ti);
      h += '<details class="columns"' + (openCols ? ' open' : '') + ' data-cols="' + ti + '"><summary><b>Columns</b> <span class="small muted">' + mapped + ' of ' + S.boot.fields.length + ' fields found · header row ' + esc(t.headerRow) + '</span></summary><div class="stack" style="margin-top:10px">';
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
      if (t.saved) {
        var missing = ['testedBy', 'testedOn'].filter(function (f) { return !t.columns[f]; });
        var adds = [];
        if (missing.length) adds.push('<button data-action="add-cols" data-tab="' + esc(t.name) + '" data-fields="testedBy,testedOn"' + dis + '>Add Tested by + Tested on columns</button>');
        if (!t.columns.release) adds.push('<button data-action="add-cols" data-tab="' + esc(t.name) + '" data-fields="release"' + dis + '>Add Release column</button>');
        if (!t.columns.linkedIssue) adds.push('<button data-action="add-cols" data-tab="' + esc(t.name) + '" data-fields="linkedIssue"' + dis + '>Add Linked issue column</button>');
        if (adds.length) h += '<div class="row"><span class="small muted">Optional columns, added at the right of the table:</span>' + adds.join('') + '</div>';
      }
      h += '</div></details></section>';
    });
    // Delete asks first (it cannot be undone), so it can sit with Cancel and Save.
    h += '<div class="row section"><span class="grow"></span>' +
      '<button class="danger-outline" data-action="book-delete" title="Delete ' + esc(book().replace(/\.xlsx$/i, '')) + ' for everyone, with its setup, findings and known issues (asks first)">Delete</button>' +
      (S.cfg ? '<button data-action="view" data-view="run">Cancel</button>' : '') + '<button class="primary" data-action="save-setup"' + dis + '>Save</button></div>';
    return h;
  }

  /**
   * + Add issue on Known issues: note an issue logged outside Test Run, e.g. straight on GitHub.
   * With a test case it goes in that case's Linked issue cell (and can mark it failed);
   * without one it is kept as a finding. Either way it shows in Known issues.
   */
  function addIssueCard() {
    var tabs = runTabs();
    var tab = val('aiSuite', S.tab);
    if (!tabs.some(function (t) { return t.name === tab; })) tab = S.tab;
    var s = suiteOf(tab);
    var caseText = String(val('aiCase')).trim();
    var c = s && caseText ? findIn(s.cases, caseText) : null;
    return '<div class="card card-pad section"><div class="row"><h3 class="grow">New issue</h3>' + suitePicker('aiSuite', 'aiSuite', tab, 'ai-suite') + '</div>' +
      '<p class="small muted" style="margin-top:2px">For an issue logged outside Test Run, for example straight on GitHub or in another tracker.</p>' +
      '<div class="form-grid" style="margin-top:8px">' +
      '<div class="wide"><label for="aiUrl">Issue link</label><input id="aiUrl" data-bind="aiUrl" type="url" placeholder="https://github.com/owner/repo/issues/123" value="' + esc(val('aiUrl')) + '" autocomplete="off"></div>' +
      '<div class="wide"><label for="aiTitle">Title <span class="faint">(optional for GitHub issues: read from GitHub)</span></label><input id="aiTitle" data-bind="aiTitle" placeholder="What is wrong, in one line" value="' + esc(val('aiTitle')) + '" autocomplete="off"></div>' +
      '<div><label for="aiCase">Test case <span class="faint">(optional)</span></label><input id="aiCase" data-bind="aiCase" data-ai-live list="aiCases" placeholder="' + (s ? 'Test case ID, e.g. ' + esc((s.cases[0] && (s.cases[0].id || s.cases[0].key)) || 'TC-01') : 'Reading the test cases…') + '" value="' + esc(val('aiCase')) + '" autocomplete="off">' +
      '<datalist id="aiCases">' + (s ? s.cases.map(function (x) { return '<option value="' + esc(x.id || x.key) + '">' + esc(oneLine(x.scenario).slice(0, 90)) + '</option>'; }).join('') : '') + '</datalist></div>' +
      '<div><label for="aiPriority">Priority</label><select id="aiPriority" data-bind="aiPriority">' + opt('', '–', !val('aiPriority')) + PRIORITIES.map(function (p) { return opt(p, p, val('aiPriority') === p); }).join('') + '</select></div>' +
      '<div class="wide small" id="aiCaseNote">' + aiCaseNote(s, caseText, c) + '</div></div>' +
      '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="ghost" data-action="add-issue">Cancel</button><button class="primary" data-action="add-issue-save">Save issue</button></div></div>';
  }

  /** Under the case field: which case it is and whether it will be marked failed, or what happens without one. */
  function aiCaseNote(s, caseText, c) {
    if (!caseText) return '<span class="muted">Without a test case, it is kept under <b>Findings</b> until it is linked to one.</span>';
    if (!s) return '<span class="muted">Reading the test cases…</span>';
    if (!c) return '<span class="bad-text">No test case “' + esc(caseText) + '” in ' + esc(s.tab) + '.</span>';
    return '<div class="muted" style="margin-bottom:6px">' + esc(c.id || '') + ' ' + esc(oneLine(c.scenario).slice(0, 140)) + '</div>' +
      (s.hasCycle ? '<label class="check"><input type="checkbox" data-bind="aiFail"' + (val('aiFail', true) ? ' checked' : '') + '> Mark it failed in cycle ' + esc(s.cycle || 'Status') + '</label>'
        : '<span class="faint">This suite has no test cycle yet, so the issue is only linked.</span>');
  }

  /** Asks before removing a test cycle: its two columns and their results leave the workbook. */
  function removeCycleModal(tab, header) {
    openModal('<h2>Remove the cycle “' + esc(header) + '”?</h2>' +
      '<p class="banner bad" style="margin-top:10px"><b>This cannot be undone.</b></p>' +
      '<ul class="modal-list"><li>Its status and comment columns are deleted from <b>' + esc(tab) + '</b> in the workbook, with every result and comment in them.</li>' +
      '<li>It leaves the Test cycle list, Summary and the downloads; the published reports drop it at the next publish.</li>' +
      '<li>Today’s copy of the workbook in <span class="mono">sheets/.testrun/backups/</span> still has it.</li></ul>' +
      '<div class="row" style="margin-top:14px"><span class="grow"></span><button data-action="modal-close">Cancel</button>' +
      '<button class="danger-fill" data-action="cycle-remove-confirm" data-tab="' + esc(tab) + '" data-header="' + esc(header) + '">Remove cycle</button></div>');
  }

  /** "less than a minute", "2 minutes" */
  function etaText(sec) {
    return sec < 60 ? 'less than a minute' : Math.ceil(sec / 60) + ' minute' + (Math.ceil(sec / 60) === 1 ? '' : 's');
  }

  function mmss(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  /** The Complete Report popup, from its last known state (S.cr.info, read S.cr.at). */
  function crHtml() {
    var i = S.cr && S.cr.info;
    var head = '<div class="row"><h2 class="grow">Complete Report</h2><button class="ghost small-btn" data-action="modal-close" aria-label="Close">✕</button></div>' +
      '<p class="small muted" style="margin:2px 0 14px">' + esc(String(S.cr.book).replace(/\.xlsx$/i, '')) + ': the workbook and its screenshots and recordings, as one .zip.</p>';
    if (!i) return head + '<div class="loading" style="padding:20px">Checking…</div>';
    if (!i.ok) return head + '<div class="banner bad">' + esc(i.error) + '</div>';
    var gone = (Date.now() - S.cr.at) / 1000;
    var gen = { on: false, sub: '' };
    var dl = { on: false, sub: 'None yet' };
    if (i.state === 'running') gen.sub = 'Ready in about ' + etaText(Math.max(1, i.readyIn - gone)).replace('less than a minute', '1 min');
    else if (i.state === 'ready') {
      gen.sub = 'Wait for ' + mmss(i.expiresIn - gone);
      var ago = Math.floor((Date.now() - Date.parse(i.createdAt)) / 60000);
      dl = { on: true, sub: 'Created ' + (ago < 1 ? 'just now' : ago + ' min ago') };
    } else gen = { on: true, sub: 'About ' + etaText(i.estimate).replace('less than a minute', '1 min') + (i.files ? ' · ' + i.files + ' file' + (i.files === 1 ? '' : 's') : ' · no evidence yet') };
    var opt2 = function (o, label, action, primary) {
      return '<div class="cr-opt' + (o.on ? '' : ' off') + '"><button class="' + (o.on && primary ? 'primary' : '') + '" data-action="' + action + '"' + (o.on ? '' : ' disabled') + '>' + label + '</button><div class="small' + (o.on ? ' muted' : '') + '">' + esc(o.sub) + '</div></div>';
    };
    return head + (i.state === 'failed' ? '<div class="banner bad" style="margin-bottom:10px">' + esc(i.error) + '</div>' : '') +
      '<div class="cr-opts">' + opt2(gen, 'Generate New', 'cr-generate', true) + opt2(dl, 'Download Existing', 'cr-download', true) + '</div>';
  }

  var crTimer = null;
  function openCompleteReport() {
    S.cr = { book: book(), info: null, at: Date.now() };
    openModal(crHtml());
    loadCr();
    clearInterval(crTimer);
    crTimer = setInterval(function () {
      var box = document.querySelector('#modal .modal-box');
      if (!S.cr || !box || $('modal').classList.contains('hidden')) { clearInterval(crTimer); S.cr = null; return; }
      var i = S.cr.info;
      var gone = (Date.now() - S.cr.at) / 1000;
      if (i && ((i.state === 'ready' && i.expiresIn - gone <= 0) || (i.state === 'running' && gone > 3))) loadCr();
      else box.innerHTML = crHtml();
    }, 1000);
  }

  function loadCr() {
    var want = S.cr && S.cr.book;
    if (!want) return;
    TR.http('GET', '/api/complete-report?book=' + encodeURIComponent(want)).then(function (r) {
      if (!S.cr || S.cr.book !== want) return;
      S.cr.info = r;
      S.cr.at = Date.now();
      var box = document.querySelector('#modal .modal-box');
      if (box) box.innerHTML = crHtml();
    });
  }

  /** While a Complete Report is being made, check every few seconds; when it is ready, the bubble shows. */
  var crPoll = null;
  function watchReport(bookName) {
    clearTimeout(crPoll);
    crPoll = setTimeout(function () {
      TR.http('GET', '/api/complete-report?book=' + encodeURIComponent(bookName)).then(function (r) {
        if (r.ok && r.state === 'running') { watchReport(bookName); return; }
        if (r.ok && r.state === 'ready') { S.crReady = { book: bookName }; render(); return; }
        if (r.ok && r.state === 'failed') toast(r.error, 'bad');
      });
    }, 3000);
  }

  /** Asks before deleting the open workbook: it cannot be undone. */
  function deleteBookModal() {
    var name = book();
    var title = name.replace(/\.xlsx$/i, '');
    openModal('<h2>Delete “' + esc(title) + '”?</h2>' +
      '<p class="banner bad" style="margin-top:10px"><b>This cannot be undone.</b></p>' +
      '<ul class="modal-list"><li>The workbook file is deleted from this laptop’s sheets folder, for everyone using this Test Run.</li>' +
      '<li>Its Test Run setup, findings and known issues are deleted with it, and its screenshots and recordings.</li>' +
      '<li>Copies published to GitHub stay until the next publish.</li></ul>' +
      '<div class="row" style="margin-top:14px"><span class="grow"></span><button data-action="modal-close">Cancel</button>' +
      '<button class="danger-fill" data-action="book-delete-confirm" data-name="' + esc(name) + '">Delete workbook</button></div>');
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

  function helpModal() {
    var keys = [['J / ↓', 'Next case'], ['K / ↑', 'Previous case'], ['Enter', 'Open or close the case'], ['P', 'Pass'], ['F', 'Fail (then type a comment, Enter saves)'], ['N', 'NA / other'], ['1–9', 'Any status by position'], ['0', 'Clear the result (back to not run)'], ['C', 'Comment'], ['E', 'Edit the open case (Duplicate and Deprecate are next to it)'], ['U', 'Undo the last mark'], ['/', 'Search'], ['Esc', 'Close / leave a field']];
    openModal('<h2>Keyboard shortcuts</h2><table style="margin-top:10px"><tbody>' + keys.map(function (k) { return '<tr><td><kbd>' + esc(k[0]) + '</kbd></td><td>' + esc(k[1]) + '</td></tr>'; }).join('') + '</tbody></table><div class="row" style="margin-top:12px"><span class="grow"></span><button class="primary" data-action="modal-close">Close</button></div>');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  var ACTIONS = {
    view: function (el) {
      S.view = el.getAttribute('data-view');
      if (S.view !== 'summary') S.autoMode = false;
      if (S.view === 'findings') S.suites = {}; // read the other suites afresh
      if (S.view === 'setup') S.setup = null;
      if (S.view === 'issues') { S.issueEdit = null; loadIssues(); }
      render();
      window.scrollTo(0, 0);
    },
    select: function (el) { select(el.getAttribute('data-key')); },
    mark: function (el) { if (S.selected) mark(S.selected, el.getAttribute('data-value')); },
    'save-note': function () { saveNote(); },
    undo: undo,
    'case-tool': function (el) { openTool(el.getAttribute('data-mode')); },
    'case-tool-cancel': function () { S.caseTool = null; render(); },
    'save-case': saveCase,
    retire: function (el) { retireCase(el.getAttribute('data-kind')); },
    restore: restoreCase,
    'pick-dup': function (el) {
      if (!S.selected) return;
      S.form['ce:' + S.selected + ':of'] = el.getAttribute('data-of');
      render();
    },
    'goto-case': function (el) {
      var k = el.getAttribute('data-key');
      var c = S.byKey[k];
      if (!c) return;
      if (!passes(c)) S.keep[k] = true;
      S.model.paths.forEach(function (p) { p.steps.forEach(function (s) { if (s.cases.indexOf(k) >= 0) delete S.collapsed[p.id]; }); });
      S.selected = k;
      S.caseTool = null;
      S.scrollToSel = true;
      render();
    },
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
    'start-cycle': function (el) {
      var tab = el.getAttribute('data-tab');
      var key = 'newCycle:' + el.getAttribute('data-index');
      var label = String(val(key)).trim();
      if (!label) { toast('Name the cycle first, for example v2.20.1.'); return; }
      queueWrite(function () { return api('api_startCycle', tab, label); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        delete S.form[key];
        S.keep = {};
        toast('Cycle ' + label + ' started in ' + tab + '.');
        if (tab === S.tab) S.model = null;
        refreshBoot(false, tab === S.tab ? label : null);
      });
    },
    'save-release': function (el) {
      var tab = el.getAttribute('data-tab');
      var key = 'release:' + el.getAttribute('data-index');
      var rel = String(val(key, ((S.cfg.tabs || {})[tab] || {}).release || '')).trim();
      queueWrite(function () { return api('api_setTabPrefs', tab, { release: rel }); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        delete S.form[key];
        if (S.cfg.tabs && S.cfg.tabs[tab]) S.cfg.tabs[tab].release = rel;
        toast(rel ? 'Release in scope: ' + rel : 'Release cleared.');
        if (tab === S.tab) loadTab(cycleLabel(), true); else render();
      });
    },
    'save-app': function () {
      var st = S.app.settings;
      var body = { user: String(val('app:user', st.user)).trim() };
      TR.http('POST', '/api/app', body).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.app = r;
        clearForm('app:');
        toast('Saved.');
        render();
      });
    },
    import: function () {
      // One or more .xlsx files: each becomes a workbook to switch to (one per environment, say).
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return;
        var done = [];
        var failed = [];
        var one = function (f) {
          var send = function (overwrite) {
            return TR.http('POST', '/api/books/import?name=' + encodeURIComponent(f.name) + (overwrite ? '&overwrite=1' : ''), f, true);
          };
          return send(false).then(function (r) {
            if (!r.ok && r.code === 'EXISTS' && window.confirm(r.error + ' Replace it with the file you picked?')) return send(true);
            return r;
          }).then(function (r) {
            if (r && r.ok) {
              done.push(r.name);
              if (r.addedColumns && r.addedColumns.length) toast('Added Tested by and Tested on to ' + r.addedColumns.map(function (a) { return a.tab; }).join(', ') + ' in ' + r.name.replace(/\.xlsx$/i, '') + '.');
            }
            else if (r && r.code !== 'EXISTS') failed.push(f.name + ': ' + r.error);
          });
        };
        if (files.length > 1) toast('Importing ' + files.length + ' workbooks…');
        files.reduce(function (p, f) { return p.then(function () { return one(f); }); }, Promise.resolve()).then(function () {
          failed.forEach(function (m) { toast(m, 'bad'); });
          if (!done.length) return;
          toast(done.length === 1 ? 'Imported ' + done[0] + '.' : 'Imported ' + done.length + ' workbooks: ' + done.join(', ') + '. Switch between them with Workbook, top right.', done.length > 1 ? 'long' : '');
          switchBook(done[0]);
        });
      });
      input.click();
    },
    download: function () {
      if (S.dlMenu) { S.dlMenu = null; render(); }
      TR.download('/api/books/download?name=' + encodeURIComponent(book()), book()).then(function (r) { if (!r.ok) toast(r.error, 'bad'); });
    },
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
      var typed = String(val('fIssue')).trim();
      var link = /^https?:\/\/\S+$/i.test(typed) ? typed : '';
      var input = { text: text, issue: link ? '' : typed, url: link, area: val('fArea'), details: val('fDetails'), tab: val('fTab', val('findingsSuite', '') || S.tab) };
      queueWrite(function () { return api('api_saveFinding', input); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.findings.push(r.finding);
        ['fText', 'fIssue', 'fDetails'].forEach(function (k) { delete S.form[k]; });
        S.form.noteOpen = false;
        toast('Saved as ' + r.finding.key + '.');
        render();
      });
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
      S.writeUp[f.key] = draftFromFinding(f, suiteOf(f.tab || S.tab));
      S.covering = null;
      render();
      var first = document.querySelector('.writeup textarea, .writeup input');
      if (first) first.focus();
    },
    'writeup-cancel': function (el) { var k = el.getAttribute('data-key'); delete S.writeUp[k]; clearForm('wu:' + k + ':'); render(); },
    'writeup-add': function (el) {
      var k = el.getAttribute('data-key');
      var f = S.findings.filter(function (x) { return x.key === k; })[0] || {};
      var tab = f.tab || S.tab;
      var sm = suiteOf(tab);
      if (!sm) return;
      var d = collectDraft('wu:' + k, S.writeUp[k], sm);
      if (!String(d.scenario).trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
      el.disabled = true;
      queueWrite(function () { return api('api_addCases', tab, [d], sm.cycle); }).then(function (r) {
        if (!r.ok) { el.disabled = false; writeError(r); return; }
        delete S.writeUp[k];
        clearForm('wu:' + k + ':');
        toast(k + ' added to ' + tab + ' as ' + (r.added[0].id || 'row ' + r.added[0].row) + '.');
        if (tab === S.tab) loadTab(cycleLabel(), true); else delete S.suites[tab];
        loadSide();
      });
    },
    cover: function (el) { S.covering = el.getAttribute('data-key'); render(); var i = $('covId'); if (i) i.focus(); },
    'cover-cancel': function () { S.covering = null; render(); },
    'cover-save': function (el) {
      var k = el.getAttribute('data-key');
      var fd = S.findings.filter(function (x) { return x.key === k; })[0] || {};
      var csm = suiteOf(fd.tab || S.tab);
      var c = findIn(csm ? csm.cases : [], val('cov:' + k));
      if (!c) { toast('Type the ID of a case in ' + (fd.tab || S.tab) + ', e.g. ' + (((csm && csm.cases[0]) || {}).id || 'CMS/12') + '.', 'bad'); return; }
      queueWrite(function () { return api('api_setFindingState', k, 'covered', c.id || c.key); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.covering = null;
        delete S.form['cov:' + k];
        toast(k + ' is covered by ' + caseLabel(c) + '.');
        loadSide();
      });
    },
    'add-here': function (el) {
      var id = el.getAttribute('data-path');
      var p = S.model.paths.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      var keys = [];
      p.steps.forEach(function (st) { keys = keys.concat(st.cases); });
      var last = S.byKey[keys[keys.length - 1]] || {};
      clearForm('ah:');
      S.addHere = { path: id, draft: { scenario: '', feature: last.group1 || '', subFeature: last.group2 || '', testType: last.testType || '', testData: '', preCondition: '', expected: [] } };
      render();
      var f = document.querySelector('.add-here.open textarea');
      if (f) f.focus();
    },
    'add-here-cancel': function () { S.addHere = null; clearForm('ah:'); render(); },
    'add-here-save': function (el) {
      var a = S.addHere;
      if (!a) return;
      var d = collectDraft('ah:' + a.path, a.draft);
      if (!d.scenario.trim()) { toast('Write the scenario first.', 'bad'); return; }
      el.disabled = true;
      queueWrite(function () { return api('api_addCases', S.tab, [d], cycleLabel()); }).then(function (r) {
        if (!r.ok) { el.disabled = false; writeError(r); return; }
        var added = r.added[0];
        S.addHere = null;
        clearForm('ah:');
        toast('Added to the workbook as ' + (added.id || 'row ' + added.row) + '.');
        if (added.id) S.keep[added.id] = true;
        loadTab(cycleLabel(), true);
      });
    },
    'setup-part': function (el) { S.form.setupPart = el.getAttribute('data-part'); render(); window.scrollTo(0, 0); },
    'book-delete': function () { deleteBookModal(); },
    'dl-menu': function (el) { var w = el.getAttribute('data-where'); S.dlMenu = S.dlMenu === w ? null : w; render(); },
    'complete-report': function () { S.dlMenu = null; render(); openCompleteReport(); },
    'cr-generate': function (el) {
      var want = S.cr && S.cr.book;
      if (!want) return;
      el.disabled = true;
      TR.http('POST', '/api/complete-report', { book: want }).then(function (r) {
        if (!r.ok) { if (S.cr) { S.cr.info = r.state ? r : S.cr.info; } loadCr(); if (r.code !== 'WAIT') toast(r.error, 'bad'); return; }
        closeModal();
        S.crReady = null;
        toast('Your download will be ready in ' + etaText(r.readyIn || r.estimate) + '.');
        watchReport(want);
        render();
      });
    },
    'cr-download': function (el) {
      var want = el.getAttribute('data-book') || (S.cr && S.cr.book) || book();
      var name = String(want).replace(/\.xlsx$/i, '') + ' - Complete Report.zip';
      closeModal();
      S.crReady = null;
      render();
      TR.download('/api/complete-report/download?book=' + encodeURIComponent(want), name).then(function (r) { if (!r.ok) toast(r.error, 'bad'); });
    },
    'cr-dismiss': function () { S.crReady = null; render(); },
    'media-quality': function (el) { setMedia({ quality: el.getAttribute('data-quality') }); },
    'ev-view': function (el) {
      var k = el.getAttribute('data-key');
      var w = window.open('', '_blank');
      TR.fetchBlob('/api/evidence/file?book=' + encodeURIComponent(book()) + '&tab=' + encodeURIComponent(S.tab) + '&cycle=' + encodeURIComponent(cycleLabel()) + '&key=' + encodeURIComponent(k)).then(function (r) {
        if (!r.ok) { if (w) w.close(); toast(r.error, 'bad'); return; }
        if (w) w.location = URL.createObjectURL(r.blob); else TR.saveBlob(r.blob, k);
      });
    },
    'ev-remove': function (el) {
      var k = el.getAttribute('data-key');
      var ev = S.model.evidence && S.model.evidence[k];
      if (!ev || !window.confirm('Delete ' + ev.name + ' for good? It cannot be brought back.')) return;
      TR.http('POST', '/api/evidence/remove', { book: book(), tab: S.tab, cycle: cycleLabel(), key: k }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        toast('Deleted ' + r.removed + '.');
        loadTab(cycleLabel(), true);
      });
    },
    'cycle-remove': function (el) { removeCycleModal(el.getAttribute('data-tab'), el.getAttribute('data-header')); },
    'cycle-remove-confirm': function (el) {
      var tab = el.getAttribute('data-tab');
      var header = el.getAttribute('data-header');
      el.disabled = true;
      queueWrite(function () { return api('api_removeCycle', tab, header); }).then(function (r) {
        el.disabled = false;
        if (!r.ok) { closeModal(); writeError(r); return; }
        closeModal();
        toast('Removed the cycle ' + header + ' from ' + tab + '.');
        S.keep = {};
        S.summary = null;
        if (tab === S.tab) S.model = null;
        refreshBoot(false, null);
      });
    },
    'add-issue': function () {
      var open = !val('aiOpen');
      clearForm('ai');
      S.form.aiOpen = open;
      render();
      var u = open && $('aiUrl');
      if (u) u.focus();
    },
    'add-issue-save': function (el) {
      var url = String(val('aiUrl')).trim();
      if (!/^https?:\/\/\S+$/i.test(url)) { toast('Paste the issue’s link, starting with https://', 'bad'); var u = $('aiUrl'); if (u) u.focus(); return; }
      var title = String(val('aiTitle')).trim();
      var github = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/i.test(url);
      if (!title && !github) { toast('Give it a title: only GitHub issues have theirs read automatically.', 'bad'); var t = $('aiTitle'); if (t) t.focus(); return; }
      var tab = val('aiSuite', S.tab);
      var s = suiteOf(tab);
      var caseText = String(val('aiCase')).trim();
      var c = null;
      if (caseText) {
        if (!s) { toast('Still reading the test cases of ' + tab + '. Try again in a moment.'); return; }
        c = findIn(s.cases, caseText);
        if (!c) { toast('There is no test case “' + caseText + '” in ' + tab + '.', 'bad'); return; }
      }
      var fail = !!(c && s.hasCycle && val('aiFail', true));
      var pr = val('aiPriority', '');
      el.disabled = true;
      var call = c
        ? function () { return api('api_linkBug', { tab: tab, key: c.key, url: url, title: title, priority: pr, markFailed: fail, source: 'manual' }); }
        : function () { return api('api_saveFinding', { text: title || 'Issue ' + url.replace(/^https?:\/\/(www\.)?/i, '').replace(/^github\.com\//i, ''), issueTitle: title, url: url, tab: tab, source: 'manual', priority: pr }); };
      queueWrite(call).then(function (r) {
        el.disabled = false;
        if (!r.ok) { writeError(r); return; }
        clearForm('ai');
        if (c) {
          toast('Linked to ' + (c.id || 'the case') + (fail ? ' and marked failed' : '') + '. It shows in Known issues.');
          if (tab === S.tab) loadTab(cycleLabel(), true); else delete S.suites[tab];
        } else {
          S.findings.push(r.finding);
          toast('Kept as finding ' + r.finding.key + '. It shows in Known issues.');
        }
        loadIssues();
        render();
      });
    },
    'book-delete-confirm': function (el) {
      var name = el.getAttribute('data-name');
      el.disabled = true;
      TR.http('POST', '/api/books/delete', { name: name }).then(function (r) {
        if (!r.ok) { el.disabled = false; toast(r.error, 'bad'); return; }
        closeModal();
        toast('Deleted ' + name.replace(/\.xlsx$/i, '') + '.');
        S.app = r;
        var next = r.books[0] ? r.books[0].name : '';
        if (next) { switchBook(next); return; }
        TR.state.book = null;
        TR.store.set('book', '');
        S.boot = null; S.model = null; S.cfg = null; S.setup = null; S.findings = []; S.issues = null; S.autoSummary = null;
        S.view = 'run';
        render();
      });
    },
    'pick-auto': function () { S.autoMode = true; S.selected = null; S.caseTool = null; render(); window.scrollTo(0, 0); },
    'auto-refresh': function () { S.autoSummary = null; render(); },
    'findings-show': function (el) { S.form.findingsShow = el.getAttribute('data-show'); render(); },
    'note-toggle': function () { S.form.noteOpen = !val('noteOpen'); render(); var t = $('fText'); if (t) t.focus(); },
    'cover-with': function (el) {
      var k = el.getAttribute('data-key');
      var id = el.getAttribute('data-case');
      queueWrite(function () { return api('api_setFindingState', k, 'covered', id); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        toast(k + ' is covered by ' + id + '. It is under Done.');
        loadSide();
      });
    },
    'reopen-finding': function (el) {
      var k = el.getAttribute('data-key');
      queueWrite(function () { return api('api_setFindingState', k, 'open', ''); }).then(function (r) { if (!r.ok) writeError(r); else loadSide(); });
    },
    'new-case': function () {
      if (S.manual.length) { S.manual = []; render(); return; } // pressed again: close it (what was typed comes back next time)
      S.manual = [{ scenario: '', expected: [] }];
      render();
      var f = document.querySelector('[id^="man_0_"]');
      if (f) f.focus();
    },
    'discard-manual': function () { S.manual = []; clearForm('man:'); render(); },
    'add-manual': function (el) {
      var mtab = val('man:tab', val('findingsSuite', '') || S.tab);
      var msm = suiteOf(mtab);
      if (!msm) return;
      var d = collectDraft('man:0', S.manual[0], msm);
      if (!d.scenario.trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
      el.disabled = true;
      queueWrite(function () { return api('api_addCases', mtab, [d], msm.cycle); }).then(function (r) {
        if (!r.ok) { el.disabled = false; writeError(r); return; }
        S.manual = [];
        clearForm('man:');
        toast('Added to ' + mtab + ' as ' + (r.added[0].id || 'row ' + r.added[0].row) + '.');
        if (mtab === S.tab) loadTab(cycleLabel(), true); else delete S.suites[mtab];
        loadSide();
      });
    },
    print: function () { window.print(); },
    'pick-tab': function (el) { pickTab(el.getAttribute('data-tab')); },
    'issue-show': function (el) { S.form.issueShow = el.getAttribute('data-show'); render(); },
    'issues-reload': function () { S.issues = null; render(); },
    'issues-refresh': function (el) {
      el.disabled = true;
      TR.http('POST', '/api/issues/refresh', { book: book() }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); render(); return; }
        S.issues = r;
        toast('Getting the latest from GitHub…');
        render();
        clearTimeout(issuePoll);
        if (r.fetching) issuePoll = setTimeout(loadIssues, 2500);
      });
    },
    'issue-edit': function (el) { S.issueEdit = el.getAttribute('data-key'); clearForm('ie:title'); clearForm('ie:priority'); render(); var t = $('ieTitle'); if (t) t.focus(); },
    'issue-edit-cancel': function () { S.issueEdit = null; render(); },
    'issue-save': function (el) {
      var key = el.getAttribute('data-key');
      var e = (S.issues.issues || []).filter(function (x) { return x.key === key; })[0];
      if (!e) return;
      var item = { key: key, title: String(val('ie:title', e.title)).trim(), priority: String(val('ie:priority', e.priority)).trim() };
      queueWrite(function () { return api('api_saveIssueMeta', [item]); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        e.title = item.title;
        e.priority = item.priority;
        if (S.model) { S.model.issueInfo = S.model.issueInfo || {}; S.model.issueInfo[key.toLowerCase()] = { title: e.title, priority: e.priority, state: e.state }; }
        S.issueEdit = null;
        clearForm('ie:title'); clearForm('ie:priority');
        toast('Saved.');
        render();
        loadIssues();
      });
    },
    'open-case': function (el) {
      var tab = el.getAttribute('data-tab');
      var key = el.getAttribute('data-key');
      S.view = 'run';
      var go = function () {
        if (!S.byKey[key]) { toast('That case is not in ' + tab + ' any more.'); render(); return; }
        ACTIONS['goto-case']({ getAttribute: function () { return key; } });
        window.scrollTo(0, 0);
      };
      if (tab === S.tab && S.model) { go(); return; }
      S.tab = tab;
      TR.store.set('tab:' + book(), tab);
      S.selected = null; S.caseTool = null; S.keep = {}; S.undo = []; S.model = null; S.filters.type = '';
      loadTab('').then(go);
    },
    'clear-result': function () { var c = S.byKey[S.selected]; if (c && c.statuses[S.model.cycleIdx]) mark(c.key, c.statuses[S.model.cycleIdx]); },
    'use-invite': function () {
      TR.useInvite(val('inviteLink')).then(function (c) {
        if (!c.ok) { S.connect = c; render(); return; }
        delete S.form.inviteLink;
        S.connect = null;
        TR.state.authFailed = false;
        start();
      });
    },
    'retry-connect': function () { S.connect = null; S.loading = true; render(); TR.reconnect(); start(); },
    'forget-invite': function () { TR.forget(); S.connect = { code: 'NO_SERVER' }; render(); },
    'sign-out': function () {
      if (!window.confirm('Sign out of Test Run in this browser?\n\nTo come back you need your access link again.')) return;
      TR.forget();
      if (document.activeElement) document.activeElement.blur();
      S.app = null; S.boot = null; S.model = null; S.cfg = null; S.findings = []; sideSeen = { findings: null };
      S.issues = null; S.autoSummary = null; S.autoMode = false; S.team = null; S.selected = null; S.view = 'run';
      S.connect = { code: 'SIGNED_OUT' };
      render();
    },
    'user-rename': function () {
      if (document.activeElement) document.activeElement.blur();
      S.view = 'setup'; S.form.setupPart = 'sharing';
      render();
      window.scrollTo(0, 0);
      var n = $('appUser');
      if (n) n.focus();
    },
    'team-enable': function (el) {
      if (!el.checked && !me().local && !window.confirm('Stop sharing? You are connected through it, so this browser loses Test Run until someone turns it back on at the laptop.')) { el.checked = true; return; }
      teamCall('/api/team', { enabled: el.checked });
    },
    'team-publish': function (el) { teamCall('/api/team', { publish: el.checked }); },
    'team-save': function () {
      var t = S.team.team;
      var body = t.mode === 'fixed'
        ? { fixedUrl: String(val('team:fixedUrl', t.fixedUrl)).trim(), tunnelName: String(val('team:tunnelName', t.tunnelName)).trim() }
        : { hostedUrl: String(val('team:hostedUrl', t.hostedUrl)).trim() };
      teamCall('/api/team', body, function () {
        clearForm('team:fixedUrl'); clearForm('team:hostedUrl'); clearForm('team:tunnelName'); toast('Saved.');
      });
    },
    'team-mode': function (el) {
      if (!me().local && !window.confirm('Change the way in? You are connected through the current one, so this browser may lose Test Run.')) { render(); return; }
      teamCall('/api/team', { mode: el.value });
    },
    'team-use': function (el) {
      var body = {};
      body[el.getAttribute('data-field')] = el.getAttribute('data-value');
      clearForm('team:' + el.getAttribute('data-field'));
      teamCall('/api/team', body, function () { toast('Saved.'); });
    },
    'team-check': function (el) { el.disabled = true; teamCall('/api/team/check'); },
    'team-share': function (el) {
      var on = el.getAttribute('data-on') === '1';
      if (!on && !me().local && !window.confirm('Stop sharing? You are connected through it, so this browser loses Test Run until it is started again at the laptop.')) return;
      el.disabled = true;
      if (on) toast(S.team.team.mode === 'fixed' ? 'Starting the tunnel…' : 'Opening a tunnel… this takes a few seconds.');
      teamCall('/api/team/share', { on: on });
    },
    // Hidden from view: a fresh or copied link goes to the clipboard, with a toast.
    'team-add': function () {
      var name = String(val('team:name')).trim();
      if (!name) { toast('Type their name first.'); var n = $('teamName'); if (n) n.focus(); return; }
      var role = val('team:role');
      if (role !== 'tester' && role !== 'viewer') { toast('Choose their access first.'); var sel = $('teamRole'); if (sel) sel.focus(); return; }
      teamCall('/api/team/people', { name: name, role: role, books: val('team:books') ? [val('team:books')] : 'all' }, function (r) {
        clearForm('team:name');
        clearForm('team:role');
        clearForm('team:books');
        deliverLink(name, r.link, r.linkWarning, 'Added. ');
      });
    },
    'publish-now': function () { publishNow(); },
    'r-suite': function (el) { var w = currentReportSlug(); S.form['rSuite:' + w] = el.getAttribute('data-tab'); S.form.rAuto = false; render(); },
    'r-auto': function () { S.form.rAuto = true; render(); },
    'publish-get': function (el) {
      if (!window.confirm('Get the published data? It replaces the workbooks here with the published ones (a copy of each is kept in sheets/.testrun/backups).')) return;
      if (el) el.disabled = true;
      TR.http('POST', '/api/publish/get-latest', {}).then(function (r) {
        if (r.repo != null) S.publish = r;
        if (!r.ok) { toast(r.error, 'bad'); render(); return; }
        toast('Got the data published by ' + (r.result.by || 'someone') + ' at ' + r.result.at + '.', 'long');
        if (S.app) S.app.publishNotice = null;
        refreshApp().then(function () { boot(S.tab, cycleLabel()); });
      });
    },
    'publish-book': function (el) { pubDraft().books[el.getAttribute('data-name')] = el.checked; render(); },
    'publish-nightly': function (el) { pubDraft().nightly = el.checked; render(); },
    'publish-onstop': function (el) { pubDraft().onStop = el.checked; render(); },
    'publish-save': function () {
      var c = pubChanges();
      if (c.books.length) { publishConfirmModal(c.books); return; }
      if (c.other) savePublishPrefs(false);
    },
    'publish-confirm': function (el) { el.disabled = true; savePublishPrefs(true); },
    'publish-cancel-books': function () {
      // cancel the change to the workbooks; other unsaved choices stay
      var r = S.publish;
      r.books.forEach(function (b) { S.pubDraft.books[b.name] = !!b.on; });
      closeModal();
      render();
    },
    'publish-discard': function () { S.pubDraft = null; render(); },
    'start-from-published': function (el) {
      el.disabled = true;
      TR.http('POST', '/api/publish/start-from-local', {}).then(function (r) {
        if (!r.ok) { el.disabled = false; toast(r.error, 'bad'); return; }
        toast('Started from the data published by ' + (r.by || 'someone') + ' at ' + r.at + '.', 'long');
        S.app = r.app;
        TR.state.book = r.app.last.book;
        boot('', '');
      });
    },
    'admin-copy': function () {
      TR.http('POST', '/api/team/admin', { action: 'copy' }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.team = r;
        copyAdminLink(r);
      });
    },
    'admin-new': function () {
      var had = S.team && S.team.admin && S.team.admin.exists;
      if (had && !window.confirm('Make a new admin link? The old one stops working' + (me().admin ? ', including in this browser.' : '.'))) return;
      TR.http('POST', '/api/team/admin', { action: 'new' }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.team = r;
        copyAdminLink(r);
      });
    },
    'admin-remove': function () {
      if (!window.confirm('Remove your admin link? It stops working at once' + (me().admin ? ', including in this browser.' : '.'))) return;
      teamCall('/api/team/admin', { action: 'remove' }, function () { toast('Admin link removed.'); });
    },
    'team-copy': function (el) {
      var id = el.getAttribute('data-id');
      var p = S.team.people.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      TR.http('POST', '/api/team/people/link', { id: id }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.team = r;
        deliverLink(p.name, r.link, r.linkWarning, '');
      });
    },
    'team-rotate': function (el) {
      var id = el.getAttribute('data-id');
      var p = S.team.people.filter(function (x) { return x.id === id; })[0];
      if (!p || !window.confirm('Make a new link for ' + p.name + '? Their current link stops working.')) return;
      teamCall('/api/team/people/update', { id: id, rotate: true }, function (r) { deliverLink(p.name, r.link, r.linkWarning, 'New link made; the old one no longer works. '); });
    },
    'team-remove': function (el) {
      var id = el.getAttribute('data-id');
      var p = S.team.people.filter(function (x) { return x.id === id; })[0];
      if (!p || !window.confirm('Remove ' + p.name + '? Their link stops working at once.')) return;
      teamCall('/api/team/people/remove', { id: id });
    },
    'copy-link': function () {
      var t = $('teamLink');
      copyText(t ? t.value : '').then(function (ok) { if (ok) toast('Copied.'); else { t.select(); toast('Press Cmd+C (Ctrl+C) to copy the selected link.'); } });
    },
    'hide-link': function () { S.teamLink = null; render(); },
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
        refreshBoot(false); // stay on Setup
      });
    }
  };

  function refreshBoot(goRun, cycle) {
    api('api_bootstrap').then(function (b) {
      if (!b.ok) { toast(b.error, 'bad'); return; }
      S.boot = b;
      S.cfg = b.config;
      S.setup = null;
      var tabs = runTabs();
      if (!tabs.some(function (t) { return t.name === S.tab; })) S.tab = tabs[0] ? tabs[0].name : null;
      if (goRun) { S.view = 'run'; window.scrollTo(0, 0); }
      if (S.tab) loadTab(cycle || cycleLabel()); else render();
    });
  }

  function switchBook(name) {
    return TR.http('POST', '/api/books/select', { name: name }).then(function (a) {
      if (!a.ok) { toast(a.error, 'bad'); return; }
      S.app = a;
      TR.state.book = name;
      TR.store.set('book', name);
      S.addHere = null;
      S.autoSummary = null;
      S.autoMode = false;
      S.suites = {};
      S.selected = null;
      S.keep = {};
      S.undo = [];
      S.findings = [];
      S.issues = null;
      S.issueEdit = null;
      sideSeen = { findings: null };
      S.manual = [];
      S.writeUp = {};
      S.covering = null;
      S.setup = null;
      S.summary = null;
      S.filters.type = '';
      S.view = 'run';
      boot(TR.store.get('tab:' + name), '');
    });
  }

  /** Open another test case tab (a module) of this workbook. */
  function pickTab(name) {
    if (S.autoMode && name === S.tab) { S.autoMode = false; render(); return; }
    S.autoMode = false;
    if (!name || name === S.tab) return;
    S.tab = name;
    TR.store.set('tab:' + book(), S.tab);
    S.addHere = null;
    S.selected = null;
    S.caseTool = null;
    S.keep = {};
    S.undo = [];
    S.model = null;
    S.filters.type = '';
    loadTab('');
  }

  var CHANGES = {
    book: function (el) { if (el.value) switchBook(el.value); },
    tab: function (el) { pickTab(el.value); },
    'findings-suite': function (el) { S.form.findingsSuite = el.value; render(); },
    'man-suite': function (el) { S.form['man:tab'] = el.value; render(); },
    'r-book': function (el) { S.form.rBook = el.value; S.form.rAuto = false; render(); },
    'r-cycle': function (el) {
      var w = currentReportSlug();
      var d = S.reports && S.reports.data[w];
      var sname = val('rSuite:' + w, '');
      var suite = d && (d.suites.filter(function (x) { return x.tab === sname; })[0] || d.suites[0]);
      if (suite) S.form['rCycle:' + w + ':' + suite.tab] = el.value;
      render();
    },
    'publish-time': function (el) { if (/^\d{2}:\d{2}$/.test(el.value)) { pubDraft().time = el.value; render(); } },
    cycle: function (el) {
      var c = S.model.cycles[parseInt(el.value, 10)];
      if (!c) return;
      S.keep = {};
      S.undo = [];
      if (S.model.configured && isOwner() && !S.readOnly) api('api_setTabPrefs', S.tab, { cycle: c.label });
      loadTab(c.label);
    },
    type: function (el) { S.filters.type = el.value; render(); },
    'ai-suite': function (el) { S.form.aiSuite = el.value; delete S.form.aiCase; render(); },
    'media-keep': function (el) { setMedia({ keepMinutes: Number(el.value) }); },
    'team-role': function (el) { teamCall('/api/team/people/update', { id: el.getAttribute('data-id'), role: el.value }); },
    'team-books': function (el) { teamCall('/api/team/people/update', { id: el.getAttribute('data-id'), books: el.value ? [el.value] : 'all' }); }
  };

  document.addEventListener('click', function (e) {
    var modal = $('modal');
    if (modal && e.target === modal) { closeModal(); return; }
    if (S.dlMenu && !e.target.closest('.dl-wrap')) { S.dlMenu = null; render(); }
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { ACTIONS[el.getAttribute('data-action')](el, e); return; }
    var fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  // Keep a folded Columns section folded (or open) across redraws.
  document.addEventListener('toggle', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches('details[data-cols]')) S.form['colsOpen:' + el.getAttribute('data-cols')] = el.open;
  }, true);

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
    if (el.hasAttribute('data-live')) { render(); return; }
    if (el.hasAttribute('data-ai-live') && $('aiCaseNote')) {
      var ais = suiteOf(val('aiSuite', S.tab));
      var aic = String(el.value).trim();
      $('aiCaseNote').innerHTML = aiCaseNote(ais, aic, ais && aic ? findIn(ais.cases, aic) : null);
    }
    if (el.id === 'dupOf' && $('dupPreview')) $('dupPreview').innerHTML = keptPreview(S.byKey[S.selected], el.value);
    if (el.hasAttribute('data-setup') && el.type !== 'checkbox') S.setup[el.getAttribute('data-setup')] = el.value;
    if ((el.hasAttribute('data-comment') || el.hasAttribute('data-issue')) && S.selected) {
      var d = S.drafts[S.selected] || (S.drafts[S.selected] = {});
      if (el.hasAttribute('data-comment')) d.comment = el.value; else d.issue = el.value;
    }
  });

  document.addEventListener('keydown', function (e) {
    var modalOpen = !$('modal').classList.contains('hidden');
    if (e.key === 'Escape' && modalOpen) { closeModal(); return; }
    if (e.key === 'Escape' && S.dlMenu) { S.dlMenu = null; render(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || modalOpen) return;
    var t = e.target && e.target.matches ? e.target : document.body;
    if (t.matches('input, textarea, select')) {
      if (e.key === 'Escape') { t.blur(); return; }
      if (e.key === 'Enter' && !e.shiftKey && (t.hasAttribute('data-comment') || t.hasAttribute('data-issue'))) { e.preventDefault(); t.blur(); saveNote(); }
      if (e.key === 'Enter' && t.id === 'fText') { e.preventDefault(); ACTIONS['add-finding'](); }
      if (e.key === 'Enter' && t.id === 'ieTitle' && S.issueEdit) { e.preventDefault(); var sv = document.querySelector('[data-action="issue-save"]'); if (sv) ACTIONS['issue-save'](sv); }
      if (e.key === 'Enter' && !e.shiftKey && (t.id === 'retireReason' || t.id === 'dupReason')) { e.preventDefault(); t.blur(); retireCase(t.id === 'dupReason' ? 'duplicate' : 'deprecated'); }
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
    if (k === 'Escape') { if (S.caseTool) S.caseTool = null; else S.selected = null; render(); return; }
    if (!S.selected) return;
    if (k === 'e') { e.preventDefault(); openTool('edit'); return; }
    if (k === '0' || k === 'Backspace' || k === 'Delete') {
      var sc = S.byKey[S.selected];
      if (sc && sc.statuses[S.model.cycleIdx]) { e.preventDefault(); mark(S.selected, sc.statuses[S.model.cycleIdx]); }
      return;
    }
    if (k === 'c') { if ($('comment')) { e.preventDefault(); focusComment(); } return; }
    var o = S.model.statusOptions.filter(function (x) { return x.key === k.toLowerCase() || x.num === k; })[0];
    if (o) { e.preventDefault(); mark(S.selected, o.value); }
  });

  window.__TR_STATE = S; // for the browser tests
  init();
})();
