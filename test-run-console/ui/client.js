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
    { id: 'automation', label: 'Automation' },
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
    filters: { show: 'todo', tiers: [], type: [], search: '' }, // type: the test types ticked; none = all
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
    issuesDue: true, // opening Known issues gets the latest from GitHub once
    ddOpen: null, // the dropdown that is open (its bind), and what is typed in its search box
    ddQ: '',
    teamLink: null, // { name, link } just made in Setup › Access, shown once
    team: null, // Setup › Access, for the owner
    summary: null,
    setup: null,
    writes: 0,
    selfDirty: false,
    // Automation: the data from /api/automation, which suite and screen ('runs' | 'run' | 'import' | 'start'),
    // the open run (?run=<id> in the address) and what the run view shows; linkOpen: the Link a suite popup
    auto: {
      data: null, loading: false, error: '', suite: '', screen: PARAMS.run ? 'run' : 'runs', runId: PARAMS.run || '', editing: false, linkOpen: false,
      detail: null, detailLoading: false, filter: 'failed', q: '', sel: '', open: {}, allFiles: false, moving: false,
      file: null, busy: false, targets: {}, targetsLoading: {},
      // GitHub Actions: the runs going (and lately finished) from /api/automation/jobs, shown on the
      // suite's page (In GitHub Actions), the Run form's branches ('start'), Link a suite's GitHub steps,
      // and Import results › GitHub run
      jobs: null, jobsBusy: false, jobsTimer: null, runForm: null, starting: false,
      gh: { check: null, checking: false, checkError: '', arts: null, artsFor: '', artsLoading: false, artsError: '', importing: false, imported: null },
      ghRuns: null, ghRunsFor: '', ghRunsLoading: false, setupGh: null, setupGhLoading: false
    },
    // Summary › Manual | Automated (kept for this browser session), and the automated results attached to
    // the open workbook › test suite › cycle (/api/automation/cycle: the Automated view and Run's Auto badges)
    sumView: readSumView(),
    autoCycle: null, // { key: book\ntab\ncycle, data }
    sumOpen: { 0: true }, // which top failure causes are open
    // The published site's locked automated results: automation/index.json, each workbook unlocked with
    // this browser's invite key ({ slug: { token, state, opened: [{ id, identity, meta }] } }), the run open
    pubAuto: { index: undefined, indexLoading: false, unlock: {}, run: null, runLoading: false }
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
        // Who this key is: the published site says "Unlocked for <name>" with it (it keeps the key's last 4 characters to match it)
        var tk = TR.inviteKey();
        if (tk && a.me && !a.me.local && a.me.name) TR.store.set('who', JSON.stringify({ k: tk.slice(-4), name: a.me.name }));
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
      // ?case=CMS/07 (from Test Run Extension): open on that case, once
      if (PARAMS.case) {
        var want = findCase(PARAMS.case);
        PARAMS.case = '';
        if (want) { S.view = 'run'; ACTIONS['goto-case']({ getAttribute: function () { return want.key; } }); return; }
      }
      render();
    });
  }

  /** Findings live beside the workbook; redraw only when they changed. */
  var sideSeen = { findings: null };
  function loadSide() {
    var first = sideSeen.findings === null;
    if (!S.issues && !S.issuesLoading && book()) loadIssues(); // the Known issues count shows from the start, not only once opened
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
    app.innerHTML = topbar() + '<main id="main"' + (S.wide ? ' class="wide"' : '') + '>' + b + '</main>' + readyBubble() + auLinkPopup();
    shareSelection();
    keepViewInUrl();
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

  /** The screen is in the address (?view=summary), so a browser refresh comes back to it. */
  function keepViewInUrl() {
    if (!S.app || !S.boot || S.connect || S.reportsMode) return;
    try {
      var u = new URL(window.location.href);
      var run = S.view === 'automation' && S.auto.screen === 'run' ? S.auto.runId : ''; // the run open in Automation
      if (!PARAMS.case && u.searchParams.has('case')) u.searchParams.delete('case'); // opened on it once; a refresh need not jump back
      else if (u.searchParams.get('view') === S.view && (u.searchParams.get('run') || '') === run) return;
      u.searchParams.set('view', S.view);
      if (run) u.searchParams.set('run', run); else u.searchParams.delete('run');
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) { /* keep the address as it is */ }
  }

  /** Test Run Extension follows what this person has open: workbook, suite, cycle and case. */
  var selSent = '';
  function shareSelection() {
    if (!S.app || S.connect || S.reportsMode || !S.model || S.model.tab !== S.tab) return;
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
      // The workbook (one per environment, say): anyone signed in can switch. Import is in Setup › Workbook, Download in Summary.
      h += dropdown({
        bind: 'top:book', id: 'bookPick', cls: 'top-dd book-dd', change: 'book', value: cur, placeholder: 'No workbooks yet', disabled: !books.length,
        prefix: '<span class="dd-prefix">Workbook' + (books.length > 1 ? ' <span class="n">' + books.length + '</span>' : '') + '</span>',
        options: books.map(function (x) { return { value: x.name, label: x.name.replace(/\.xlsx$/i, '') }; })
      });
    }
    h += userMenu() + '</div>';
    if (S.app && S.auto.jobs === null && !S.auto.jobsBusy) auJobsLoad(); // runs going in GitHub Actions: the count on Automation
    h += '<nav class="nav" aria-label="Screens">' + VIEWS.filter(function (v) { return (!v.owner || isOwner()) && (v.id !== 'automation' || auHere()); }).map(function (v) {
      var n = v.id === 'findings' ? S.findings.filter(function (f) { return f.state === 'open'; }).length
        : v.id === 'issues' && S.issues && S.issues.issues ? S.issues.issues.filter(function (e) { return e.state !== 'closed'; }).length
          : v.id === 'automation' ? auActiveJobs().filter(auJobHere).length : 0;
      var tip = v.id === 'automation' && n ? ' title="' + (n === 1 ? 'A run is going' : n + ' runs are going') + ' in GitHub Actions"' : '';
      return '<button data-action="view" data-view="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '>' + v.label + (n ? ' <span class="count"' + tip + '>' + n + '</span>' : '') + '</button>';
    }).join('') + '</nav>';
    return h + contextBar() + '</header>';
  }

  /** Who is signed in, top right; hovering (or focusing) it shows the role and Sign out. */
  function userMenu() {
    var who = me();
    if (!S.app || !who.name) return '';
    var role = who.local ? 'Host, on the host-server' : who.admin ? 'Admin (your admin link)' : who.role === 'viewer' ? 'View only' : 'Updates status';
    var initial = (String(who.name).trim()[0] || '?').toUpperCase();
    return '<div class="user-menu"><button class="user-btn" aria-haspopup="menu" title="' + esc(who.name + ' · ' + role) + '"><span class="avatar" aria-hidden="true">' + esc(initial) + '</span><span class="user-name">' + esc(who.name) + '</span><span class="caret" aria-hidden="true">▾</span></button>' +
      '<div class="user-pop" role="menu"><div class="user-head"><b>' + esc(who.name) + '</b><span class="small muted">' + esc(role) + '</span></div>' +
      (who.local
        ? '<button role="menuitem" data-action="user-rename">Change your name</button><div class="user-note small faint">On this host-server you are always signed in as the host.</div>'
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
    h += '<span class="ctx-label" id="tabsLabel">Test suites</span><div class="ctx-tabs" role="tablist" aria-labelledby="tabsLabel">' + tabs.map(function (t) {
      var on = t.name === S.tab;
      return '<button class="ctx-tab' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-action="pick-tab" data-tab="' + esc(t.name) + '" title="' + esc(t.name) + '">' + esc(TR.tabLabel(t.name)) + '</button>';
    }).join('') +
      '</div><span class="grow"></span>';
    if (m && m.cycles.length) {
      h += dropdown({
        bind: 'top:cycle', id: 'cyclePick', cls: 'top-dd cycle-dd', change: 'cycle', value: String(m.cycleIdx), prefix: '<span class="dd-prefix">Test cycle</span>',
        title: 'Test cycle (a status and comment column pair)',
        options: m.cycles.map(function (c, i) { return { value: String(i), label: c.label ? 'Cycle ' + c.label : 'Status' }; })
      });
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

  /** What the reports view shows now: the workbook, its report, the suite and cycle. */
  function reportPick() {
    var idx = S.reports && S.reports.index;
    if (!idx) return null;
    var slug = val('rBook', '');
    var w = idx.workbooks.filter(function (x) { return x.slug === slug; })[0] || idx.workbooks[0];
    var d = reportBook(w.slug);
    var out = { idx: idx, w: w, d: d };
    if (!d || d.error) return out;
    out.suites = d.suites || [];
    var sname = val('rSuite:' + w.slug, '');
    out.suite = out.suites.filter(function (x) { return x.tab === sname; })[0] || out.suites[0] || null;
    out.cyc = out.suite ? val('rCycle:' + w.slug + ':' + out.suite.tab, out.suite.current) : '';
    out.sum = out.suite ? (out.suite.summaries[out.cyc] || out.suite.summaries[out.suite.current]) : null;
    return out;
  }

  /** The top bar of the reports view: like every screen, with the workbook picker top right. */
  function reportsTopbar(h) {
    var pk = reportPick();
    if (pk) {
      var n = pk.idx.workbooks.length;
      h += dropdown({
        bind: 'top:rBook', id: 'rBook', cls: 'top-dd book-dd', change: 'r-book', value: pk.w.slug,
        prefix: '<span class="dd-prefix">Workbook' + (n > 1 ? ' <span class="n">' + n + '</span>' : '') + '</span>',
        options: pk.idx.workbooks.map(function (x) { return { value: x.slug, label: x.title }; })
      });
    }
    h += '</div>';
    if (pk && pk.d && !pk.d.error && pk.suites.length) {
      h += '<div class="context"><div class="context-row"><span class="ctx-label">Test suites</span><div class="ctx-tabs" role="tablist">' +
        pk.suites.map(function (x) { var on = pk.suite && x.tab === pk.suite.tab; return '<button class="ctx-tab' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-action="r-suite" data-tab="' + esc(x.tab) + '" title="' + esc(x.tab) + '">' + esc(TR.tabLabel(x.tab)) + '</button>'; }).join('') +
        '</div><span class="grow"></span>';
      if (pk.suite && pk.suite.cycles.length) {
        h += dropdown({ bind: 'top:rCycle', id: 'rCycle', cls: 'top-dd cycle-dd', change: 'r-cycle', value: pk.cyc, prefix: '<span class="dd-prefix">Test cycle</span>',
          options: pk.suite.cycles.map(function (cl) { return { value: cl, label: cl ? 'Cycle ' + cl : 'Status' }; }) });
      }
      h += '</div>';
      var c = pk.sum ? pk.sum.summary.counts : null;
      if (c && c.total) {
        var done = Math.round(((c.total - c.none) / c.total) * 100);
        h += '<div class="progress-wrap">' + TR.bar(c) + TR.legend(c) + '<span class="small muted"><b>' + done + '%</b> done</span></div>';
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
      UNREACHABLE: 'Your Test Run is offline right now (its host-server may be asleep or restarting). These are the last published reports.',
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
    if (!S.reports) { loadReports(); return h + '<div class="loading section">Loading the published reports</div>'; }
    var pk = reportPick();
    if (!pk) return h + '<div class="section">' + emptyReport() + '</div>';
    if (!pk.d) return h + '<div class="loading section">Loading ' + esc(pk.w.title) + '</div>';
    if (pk.d.error) return h + '<div class="banner bad section">' + esc(pk.d.error) + '</div>';
    // Manual | Automated: Manual is public; Automated shows its figures to everyone, and the rest with the visitor's invite link
    var aIdx = pubAutoIndex(), ev = pubEveryone();
    var hasAuto = !!(pk.suite && ((aIdx && pubRunsFor(pk.w.slug).length) || (ev && ev.cycles.some(function (x) { return x.book === pk.w.slug; }))));
    var sw = hasAuto ? sumSwitch(true) : ''; // a workbook without automated results: Manual only, no switch
    if (hasAuto && S.sumView === 'automated') return h + '<div class="section">' + pubAutoView(pk, sw) + '</div>';
    // The suite and cycle are picked above, so no title here; on paper, one line says what it is.
    var published = 'published ' + pk.idx.publishedAt + (pk.idx.by ? ' by ' + pk.idx.by : '');
    var tools = '<div class="report-tools no-print">' + sw + '<span class="updated grow">Updated on: ' + esc(pk.idx.publishedAt) + '</span>' + (pk.w.xlsx ? '<a class="btn" href="reports/' + encodeURIComponent(pk.w.slug) + '.xlsx" download="' + esc(pk.w.title) + '.xlsx" title="The workbook as published, with a Known issues sheet"><span aria-hidden="true">⤓</span> Download</a>' : '') +
      '<button data-action="print">Print / PDF</button></div>';
    if (!pk.suite) return h + '<div class="empty card section"><p>This workbook has no test suites.</p></div>';
    if (!pk.sum) return h + '<div class="empty card section"><p>No summary for this cycle.</p></div>';
    var sum = pk.sum;
    return h + '<div class="section">' + tools + '<div class="print-only print-title">' + esc(pk.w.title) + ' · ' + esc(sum.tab) + ' · cycle ' + esc(sum.cycle || '–') + ' · ' + esc(published) + '</div>' + TR.summaryHtml(sum) + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Published site › Automated: the locked automated results (lib/automation/seal.mjs). This
  // browser's invite key gives the visitor's age identity (ui/vendor/age.js, loaded only here); it
  // opens each run's key.age it is a recipient of, then that run's summary (meta.age) and, when
  // opened, its results (run.age). Nothing leaves the browser.
  // ---------------------------------------------------------------------------

  /** automation/index.json (per run: id, workbook slug, when, size), or undefined while it's read. */
  function pubAutoIndex() {
    var P = S.pubAuto;
    if (P.index !== undefined || P.indexLoading) return P.index;
    P.indexLoading = true;
    fetch('automation/index.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) { P.indexLoading = false; P.index = j && Array.isArray(j.runs) ? j : { runs: [] }; render(); });
    return undefined;
  }
  function pubRunsFor(slug) { var i = S.pubAuto.index; return i ? i.runs.filter(function (r) { return r.book === slug; }) : []; }

  /** automation/everyone.json: the Automated figures anyone may see, signed in or not (summary.mjs › everyoneSummary); undefined while it's read, null when not published. */
  function pubEveryone() {
    var P = S.pubAuto;
    if (P.everyone !== undefined || P.everyoneLoading) return P.everyone;
    P.everyoneLoading = true;
    fetch('automation/everyone.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) { P.everyoneLoading = false; P.everyone = j && Array.isArray(j.cycles) ? j : null; render(); });
    return undefined;
  }
  /** What everyone sees for a workbook › test suite › cycle: { latest, runs, coverage, guest: true }, or null. */
  function pubEveryoneData(slug, tab, cycle) {
    var ev = S.pubAuto.everyone;
    var g = ev ? ev.cycles.filter(function (x) { return x.book === slug && x.tab === tab && x.cycle === cycle; })[0] : null;
    return g && g.latest ? { latest: g.latest, runs: g.runs || [], coverage: g.coverage || null, guest: true } : null;
  }

  var agePromise = null;
  function loadAge() {
    if (!agePromise) agePromise = import('./vendor/age.js').catch(function (e) { agePromise = null; throw e; });
    return agePromise;
  }
  function fetchBytes(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('Not published: ' + path);
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
  }
  function textOf(bytes) { return new TextDecoder().decode(bytes); }
  function gunzipText(bytes) {
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }

  /** Open a workbook's published runs with this browser's invite key: each run's key, then its summary. */
  function pubUnlock(slug, token) {
    var u = S.pubAuto.unlock[slug] = { token: token, state: 'unlocking', opened: [] };
    loadAge().then(function (age) {
      var me = age.identityFromKey(token);
      return Promise.all(pubRunsFor(slug).map(function (x) {
        var base = 'automation/' + encodeURIComponent(x.id) + '/';
        return fetchBytes(base + 'key.age').then(function (k) { return age.open(k, me); }).then(function (key) {
          if (!key) return null; // not one of this run's recipients
          var identity = textOf(key);
          return fetchBytes(base + 'meta.age').then(function (m) { return age.open(m, identity); }).then(function (plain) {
            return plain ? { id: x.id, identity: identity, meta: JSON.parse(textOf(plain)) } : null;
          });
        }).catch(function () { return null; });
      }));
    }).then(function (list) {
      if (S.pubAuto.unlock[slug] !== u) return;
      u.opened = list.filter(Boolean);
      u.state = 'done';
      render();
    }, function () {
      if (S.pubAuto.unlock[slug] !== u) return;
      u.state = 'error';
      render();
    });
    return u;
  }

  /** The visitor's name, when this browser signed in with the same key before. */
  function pubWho(token) {
    try { var w = JSON.parse(TR.store.get('who') || 'null'); return w && w.k === token.slice(-4) ? String(w.name || '') : ''; } catch (e) { return ''; }
  }

  /** What the Automated view shows for a test suite and cycle, from the runs this visitor opened: as /api/automation/cycle gives it live. */
  function pubAutoData(u, tab, cycle) {
    var when = function (x) { return (x.meta.summary.startedAt || '') + '|' + (x.meta.summary.importedAt || ''); };
    var list = u.opened.filter(function (x) { var a = x.meta.summary.attach; return a.tab === tab && a.cycle === cycle; })
      .sort(function (a, b) { return when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0; });
    if (!list.length) return null;
    var cases = {};
    list.forEach(function (x) { var m = x.meta.cases || {}; Object.keys(m).forEach(function (k) { if (!(k in cases)) cases[k] = m[k]; }); });
    var cv = { total: list[0].meta.tabCases || 0, covered: 0, passing: 0, failing: 0 };
    Object.keys(cases).forEach(function (k) { cv.covered++; if (cases[k] === 'pass') cv.passing++; else if (cases[k] === 'fail') cv.failing++; });
    return { latest: list[0].meta.summary, runs: list.map(function (x) { return x.meta.brief; }), coverage: cv };
  }
  function pubOpened(id) {
    var found = null;
    Object.keys(S.pubAuto.unlock).forEach(function (k) { (S.pubAuto.unlock[k].opened || []).forEach(function (x) { if (x.id === id) found = x; }); });
    return found;
  }

  /**
   * Published site › Automated, for the workbook, test suite and cycle picked above. An invite key that
   * opens the cycle's runs shows everything (top failure causes, ↗ Git Report, Open); anyone else sees
   * the figures everyone may see (everyone.json): no failures, Git Report or Open.
   */
  function pubAutoView(pk, sw) {
    var P = S.pubAuto;
    var token = TR.inviteKey();
    var where = TR.tabLabel(pk.suite.tab) + ' › ' + cycleText(pk.cyc);
    var tools = function (extra) { return '<div class="report-tools no-print">' + sw + '<span class="updated grow">Published ' + esc(pk.idx.publishedAt) + ' · ' + esc(where) + '</span>' + (extra || '') + '</div>'; };
    var paper = '<div class="print-only print-title">' + esc(pk.w.title) + ' · ' + esc(pk.suite.tab) + ' · cycle ' + esc(pk.cyc || '–') + ' · automated · published ' + esc(pk.idx.publishedAt) + '</div>';
    var spin = function (text) { return '<div class="spin-page"><div class="stack" style="align-items:center"><div class="spinner" aria-hidden="true"></div><p class="muted" role="status">' + esc(text) + '</p></div></div>'; };
    var print = '<button data-action="print">Print / PDF</button>';
    var g = pubEveryoneData(pk.w.slug, pk.suite.tab, pk.cyc);
    // what everyone sees: the figures, ⤓ Download (them, as .csv) and Print / PDF
    var guest = function (before) {
      return tools('<button data-action="pub-guest-csv" title="The automated figures as a spreadsheet (.csv)"><span aria-hidden="true">⤓</span> Download</button>' + print) + (before || '') + paper + autoSummaryHtml(g, { guest: true });
    };
    var none = function () { return tools() + '<div class="empty card"><h3>No automated run for this cycle</h3><p>No automated run is published for ' + esc(where) + '. Pick another test suite or cycle above.</p></div>'; };
    var reading = S.pubAuto.everyone === undefined; // everyone.json is still being read
    if (!token) {
      if (g) return guest();
      if (reading) return tools() + spin('Loading the automated results');
      if (S.pubAuto.everyone) return none();
      return tools() + '<div class="empty card"><h3>Automated results are for invited people</h3><p>Open your Test Run invite link once in this browser, then come back. The manual results are open to everyone.</p>' +
        '<p style="margin-top:12px"><button data-action="pub-have-link">I Have an Invite Link</button></p></div>';
    }
    var u = P.unlock[pk.w.slug];
    if (!u || u.token !== token) u = pubUnlock(pk.w.slug, token);
    if (u.state === 'unlocking') return tools() + spin('Unlocking the automated results with your invite link');
    var failed = '<div class="banner bad"><span>The automated results could not be unlocked in this browser.</span><span class="grow"></span><button data-action="pub-retry">Try Again</button></div>';
    if (u.state === 'error') return g ? guest(failed) : tools() + failed;
    if (!u.opened.length) {
      if (g) return guest();
      if (reading) return tools() + spin('Loading the automated results');
      return tools() + '<div class="empty card"><h3>These results are locked</h3><p>Your invite link doesn\'t open “' + esc(pk.w.title) + '”. Ask the host for access to this workbook, or for a new link.</p></div>';
    }
    if (P.run) {
      if (P.runLoading || !S.auto.detail || !pubOpened(P.run)) return tools() + spin('Opening the run');
      return tools() + auRunView(S.auto.detail, { published: true });
    }
    var d = pubAutoData(u, pk.suite.tab, pk.cyc);
    if (!d) return g ? guest() : reading ? tools() + spin('Loading the automated results') : none();
    var r = d.latest;
    var actions = '<button data-action="pub-csv" data-id="' + esc(r.id) + '" title="The automated results as a spreadsheet (.csv)"><span aria-hidden="true">⤓</span> Download</button>' + print +
      auGitReport(r, 'sum-full-report', '') + auReportTip(r);
    return tools(actions) + paper + autoSummaryHtml(d, { open: 'pub-open', unlockedFor: pubWho(token) });
  }

  /** A published run's results (run.age), opened with its run key, for the read-only run view. */
  function pubRunDetail(id) {
    var x = pubOpened(id);
    if (!x) return Promise.reject(new Error('locked'));
    if (x.detail) return Promise.resolve(x.detail);
    return Promise.all([loadAge(), fetchBytes('automation/' + encodeURIComponent(id) + '/run.age')]).then(function (v) {
      return v[0].open(v[1], x.identity);
    }).then(function (plain) {
      if (!plain) throw new Error('locked');
      return gunzipText(plain);
    }).then(function (text) { x.detail = JSON.parse(text); return x.detail; });
  }

  /** One CSV cell: quoted when needed, and never read as a formula. */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** The figures everyone sees (everyone.json) as CSV: the runs kept for the cycle, newest first. */
  function everyoneCsv(g) {
    var rows = [['When', 'Suite', 'Environment', 'Options', 'Passed', 'Failed', 'Skipped', 'Flaky', 'Total', 'Pass rate (%)']].concat(g.runs.map(function (x) {
      var t = x.totals || {};
      return [auStamp(x.startedAt).replace(/ (\d\d)-(\d\d)$/, ' $1:$2'), x.suiteName, x.env, auOptions(x), t.passed, t.failed, t.skipped, t.flaky, t.total, x.passRate == null ? '' : x.passRate];
    }));
    return '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  /** A run's tests as CSV (opens in Excel), made in this browser from the unlocked results. */
  function resultsCsv(run) {
    var word = { pass: 'Passed', fail: 'Failed', other: 'Skipped' };
    var rows = [['Suite', 'File', 'Test', 'Tags', 'Case IDs', 'Status', 'Duration (s)', 'Retries', 'Message']].concat(run.tests.map(function (x) {
      return [x.suite, x.file, x.title, (x.tags || []).join(', '), (x.caseIds || []).join(', '), (word[x.status] || x.status) + (x.flaky ? ' (flaky)' : ''), Math.round((x.durationMs || 0) / 10) / 100, x.retries || 0, x.message];
    }));
    return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
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
    if (!S.boot) return '<div class="loading">Loading the workbook</div>';
    var banners = '';
    if (S.readOnly) banners += me().role === 'viewer'
      ? '<div class="banner"><b>View only.</b><span class="muted">You can follow the run and the summary. Results are marked by testers.</span></div>'
      : '<div class="banner warn"><b>View only.</b><span class="muted">This workbook file is read-only on this computer, so results cannot be saved.</span></div>';
    if (S.excelOpen) banners += '<div class="banner warn"><b>This workbook is open in Excel.</b><span class="muted">Close it there while you test: saving from Excel would overwrite results marked here.</span></div>';
    if (S.view === 'setup' && isOwner()) return banners + viewSetup();
    if (S.view === 'automation' && !auHere()) S.view = 'run'; // this workbook has no automated suite
    if (S.view === 'automation') return banners + viewAutomation(); // the workbook's suites: no test suite needed
    if (!S.tab) return banners + (isOwner()
      ? '<div class="empty card"><h3>No test case tab found</h3><p>Open Setup and mark which tabs hold test cases.</p><p style="margin-top:12px"><button class="primary" data-action="view" data-view="setup">Open Setup</button></p></div>'
      : '<div class="empty card"><h3>No test case tab yet</h3><p>Your test lead has not set up this workbook yet.</p></div>');
    if (S.loading && !S.model) return '<div class="loading">Loading ' + esc(S.tab) + '</div>';
    if (!S.model) return '';
    var m = S.model;
    if (!m.configured && isOwner()) banners += '<div class="banner"><span>Columns for this tab were detected automatically.</span><span class="grow"></span><button data-action="view" data-view="setup">Check Setup</button></div>';
    if (m.missing && m.missing.length) banners += '<div class="banner bad"><span>These columns were renamed or removed in the workbook: <b>' + esc(m.missing.map(function (f) { return S.boot.labels[f]; }).join(', ')) + '</b>.</span><span class="grow"></span>' + (isOwner() ? '<button data-action="view" data-view="setup">Fix in Setup</button>' : '') + '</div>';
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

  // ---------------------------------------------------------------------------
  // Dropdowns, in the design of Run › Test Type
  // - multiple choice: a list of checkboxes; the button reads "Select" or "4 Selected" and the
  //   choices show below it as tags, each with ✕;
  // - single choice: the button reads the choice ("Select" before one is made), no tags.
  // A long list opens with a search box at the top and scrolls within a fixed height.
  // ---------------------------------------------------------------------------

  /** A circular arrow: resets a filter. */
  var RESET_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.25 8.5A5.25 5.25 0 1 1 11.7 4.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12.2 1.5v3.3H8.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** Where a dropdown keeps its choice: S.form[bind], or the Test Type filter. */
  function ddGet(bind) { return bind === 'filter:type' ? S.filters.type : S.form[bind]; }
  function ddSet(bind, v) {
    if (bind === 'filter:type') { S.filters.type = v; S.keep = {}; return; }
    S.form[bind] = v;
    var au = /^au:(\w+):(book|tab)$/.exec(bind); // Automation's attach pickers: a new workbook or test suite resets what follows it
    if (au) auPicked(au[1], au[2]);
    if (bind === 'au:l:wf') auWorkflowPicked(); // Link a suite: a workflow chosen, its artifacts and options follow
    if (bind === 'au:l:books' && S.form['au:lk:book'] != null && auLinkBooks().indexOf(S.form['au:lk:book']) < 0) { // Try it: a workbook still ticked
      S.form['au:lk:book'] = auLinkBooks()[0] || '';
      auPicked('lk', 'book');
    }
  }

  /**
   * o: { bind, id (for a <label for>), options: [{ value, label, hint }] or strings,
   *      value (single choice) | values (multiple choice), change (single: a CHANGES handler to call
   *      with the value, instead of keeping it in S.form), free (single: a value typed in the search box
   *      may be used), prefix (HTML before the value, e.g. "Workbook"), cls (on the wrapper),
   *      placeholder ('Select'), tagLabel(v), tagTitle(v), title, disabled,
   *      label (its name when no <label for> can carry it, e.g. in a table row: read out before the value) }
   * The search box shows from 9 options up, and always where a new value may be typed (free).
   */
  function dropdown(o) {
    var multi = !!o.values;
    var opts = (o.options || []).map(function (x) { return typeof x === 'string' ? { value: x, label: x } : x; });
    var open = S.ddOpen === o.bind && !o.disabled;
    var picked = multi ? o.values : (o.value == null ? '' : String(o.value));
    var labelOf = function (v) { var hit = opts.filter(function (x) { return x.value === v; })[0]; return hit ? hit.label : v; };
    var text = multi ? (picked.length ? picked.length + ' Selected' : '') : labelOf(picked);
    var dd = esc(o.bind);
    var h = '<div class="multi' + (o.cls ? ' ' + o.cls : '') + '" data-dd="' + dd + '">' +
      '<button type="button" class="multi-btn"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + ' data-action="dd-open" data-dd="' + dd + '" aria-haspopup="true" aria-expanded="' + open + '"' +
      (o.title || text ? ' title="' + esc(o.title || text) + '"' : '') + (o.label ? ' aria-label="' + esc(o.label + ': ' + (text || o.placeholder || 'Select')) + '"' : '') +
      (o.disabled ? ' disabled' : '') + '>' + (o.prefix || '') +
      '<span class="grow' + (text ? '' : ' dd-ph') + '">' + esc(text || o.placeholder || 'Select') + '</span>' + CHEVRON + '</button>';
    if (open) {
      var search = !!o.free || opts.length > 8; // a list that takes new values always has it: that's where a new one is typed
      var q = search ? String(S.ddQ || '').trim().toLowerCase() : '';
      var hits = opts.filter(function (x) { return !q || (x.label + ' ' + (x.hint || '')).toLowerCase().indexOf(q) >= 0; });
      h += '<div class="multi-pop">';
      // the search box stays put at the top; only the list below it scrolls
      if (search) h += '<input type="search" class="dd-search" id="ddQ" data-dd-q="' + dd + '" value="' + esc(S.ddQ || '') + '" placeholder="' + (o.free ? 'Search, or type a new one' : 'Search') + '" autocomplete="off" aria-label="Search the list">';
      h += '<div class="dd-list" role="' + (multi ? 'group' : 'listbox') + '">' + hits.map(function (x) {
        var on = multi ? picked.indexOf(x.value) >= 0 : x.value === picked;
        var body = '<span class="dd-label">' + esc(x.label) + '</span>' + (x.hint ? ' <span class="dd-hint">' + esc(x.hint) + '</span>' : '');
        return multi
          ? '<label class="check dd-opt"><input type="checkbox" data-action="dd-toggle" data-dd="' + dd + '" data-value="' + esc(x.value) + '"' + (on ? ' checked' : '') + '> <span>' + body + '</span></label>'
          : '<button type="button" class="dd-opt dd-item' + (on ? ' on' : '') + '" role="option" aria-selected="' + on + '" data-action="dd-pick" data-dd="' + dd + '"' + (o.change ? ' data-change-to="' + esc(o.change) + '"' : '') + ' data-value="' + esc(x.value) + '">' + body + '</button>';
      }).join('');
      var typed = String(S.ddQ || '').trim();
      var exact = opts.some(function (x) { return x.label.toLowerCase() === q; });
      if (o.free && q && !exact) h += '<button type="button" class="dd-opt dd-item dd-free" data-action="dd-pick" data-dd="' + dd + '" data-value="' + esc(typed) + '">Use “' + esc(typed) + '”</button>';
      else if (!hits.length) h += '<div class="small faint dd-none">Nothing matches</div>';
      h += '</div></div>';
    }
    h += '</div>';
    if (multi && picked.length) h += '<div class="filter-tags">' + picked.map(function (v) {
      var l = o.tagLabel ? o.tagLabel(v) : labelOf(v);
      return '<span class="filter-tag"' + (o.tagTitle ? ' title="' + esc(o.tagTitle(v)) + '"' : '') + '>' + esc(l) +
        '<button type="button" data-action="dd-remove" data-dd="' + dd + '" data-value="' + esc(v) + '" aria-label="Remove ' + esc(l) + '">✕</button></span>';
    }).join('') + '</div>';
    return h;
  }

  /**
   * Close every form that adds or changes something (Add issue, Add finding, New test case,
   * Create test case, Already covered, + Add, Edit), dropping what was typed in it. Called when
   * leaving a page, and before opening one of them, so only one is open at a time.
   */
  function closeBlocks() {
    S.addHere = null; clearForm('ah:');
    S.caseTool = null; clearForm('ce:');
    S.manual = []; clearForm('man:');
    S.writeUp = {}; clearForm('wu:');
    S.covering = null; clearForm('cov:');
    S.form.noteOpen = false; ['fText', 'fIssue', 'fArea', 'fDetails', 'fTab'].forEach(function (k) { delete S.form[k]; });
    clearForm('ai'); // Add issue: aiOpen, aiUrl, aiCases, aiSuite, aiFail
    if (S.auto.screen === 'import' || S.auto.screen === 'start') S.auto.screen = 'runs'; // Automation's Import results, Run, Change cycle
    S.auto.linkOpen = false; // the Link a suite popup
    S.auto.file = null; S.auto.moving = false; S.auto.editing = false;
    S.auto.gh = auGhFresh();
    clearForm('au:l:'); clearForm('au:im:'); clearForm('au:mv:'); clearForm('au:rn:'); clearForm('au:in:'); clearForm('au:lk:'); clearForm('au:gh:');
    delete S.form['au:branch']; delete S.form['au:env'];
    S.ddOpen = null; S.ddQ = '';
  }

  /** The Test Type filter: none ticked = every type. */
  function typeFilter(types, picked) {
    return '<div class="rail-group"><span class="rail-title">Test Type</span>' + dropdown({ bind: 'filter:type', options: types, values: picked }) + '</div>';
  }

  /** The different values of a field (group1, group2, testType) over these cases, in order of first use. */
  function valuesIn(cases, k) {
    var out = [];
    (cases || []).forEach(function (c) { var v = String(c[k] || '').trim(); if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }

  function passes(c, ignoreTier) {
    var f = S.filters;
    if (S.keep[c.key]) return true;
    if (f.show === 'retired') { if (!c.retired) return false; }
    else if (c.retired && f.show !== 'all') return false;
    var k = clsOf(c);
    if (f.show === 'todo' && k !== 'none') return false;
    if (f.show === 'failed' && k !== 'fail') return false;
    if (!ignoreTier && f.tiers.length && f.tiers.indexOf(c.tier) < 0) return false;
    if (f.type.length && f.type.indexOf(c.testType) < 0) return false;
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
    autoCycle(); // the Auto ✓ / ✗ badges: read once for this suite and cycle
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
    var rail = '<div class="rail-group"><label class="rail-title" for="search">Search</label><input type="search" id="search" placeholder="ID, scenario, feature  ( / )" value="' + esc(f.search) + '"></div>' +
      '<div class="rail-group" role="group" aria-label="Test status"><span class="rail-title">Test Status</span>' +
      ['all', 'todo', 'failed'].concat(nRetired || f.show === 'retired' ? ['retired'] : []).map(function (s) {
        var label = { todo: 'To do', failed: 'Failed', all: 'All', retired: 'Deprecated' }[s];
        var tip = s === 'retired' ? ' title="Deprecated and duplicate cases: struck out in the workbook, left out of the run"' : '';
        return '<button class="chip" data-action="show" data-show="' + s + '" aria-pressed="' + (f.show === s) + '"' + tip + '>' + label + ' <span class="n">' + showN[s] + '</span></button>';
      }).join('') + '</div>' +
      (types.length > 1 ? typeFilter(types, f.type) : '');
    // One button: arrows pointing in while a path is open (a click collapses them all), pointing out once all are closed (a click expands them).
    var anyOpen = m.paths.some(function (p) { return !S.collapsed[p.id]; });
    var foldTip = anyOpen ? 'Collapse all paths' : 'Expand all paths';
    var h = '<div class="content-bar"><button class="help-btn" data-action="toggle-all" title="' + foldTip + '" aria-label="' + foldTip + '">' +
      '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="' + (anyOpen ? 'M3.5 1.5 7 5 10.5 1.5M3.5 12.5 7 9 10.5 12.5' : 'M3.5 5 7 1.5 10.5 5M3.5 9 7 12.5 10.5 9') +
      '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      helpButton() + '</div>';
    if (m.plan.source === 'plan') {
      h += '<div class="banner"><span>Paths follow a saved path plan' + (m.plan.savedAt ? ' from ' + esc(m.plan.savedAt) : '') + '.</span><span class="grow"></span>' +
        (isOwner() ? '<button data-action="clear-plan">Use automatic paths</button>' : '') + '</div>';
    }

    var vps = visiblePaths();
    if (!vps.length) {
      var all = TR.counts(liveCases().map(clsOf));
      var msg = f.show === 'todo' && all.none === 0 ? '<h3>Test cycle completed</h3><p>Switch to <b>All</b> to review, or open the Summary.</p>'
        : f.show === 'retired' && !nRetired ? '<h3>No deprecated cases</h3><p>Cases you deprecate or mark as a duplicate show up here, struck out.</p>'
        : '<h3>Nothing matches</h3><p>Clear the search, or pick another filter on the left.</p>';
      return withRail(rail, h + '<div class="empty card">' + msg + '</div>');
    }
    if (S.caseTool) h += casesDatalist();
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
      return '<div class="add-here"><button class="ghost" data-action="add-here" data-path="' + esc(id) + '" title="A scenario you found while testing this section: add it to the workbook as a test case">+ Add</button></div>';
    }
    var dis = S.readOnly ? ' disabled' : '';
    return '<div class="add-here open"><div class="tool-title" title="In ' + esc(vp.p.name) + '">New test case</div>' +
      scenarioEditor(S.addHere.draft, 'ah:' + id, '<span class="small faint grow">Added after the last case in the workbook, with the next ID.</span><button class="ghost" data-action="add-here-cancel">Cancel</button><button class="primary" data-action="add-here-save"' + dis + '>Save</button>') + '</div>';
  }

  function caseRow(c) {
    var k = clsOf(c);
    var sel = S.selected === c.key;
    var badges = [];
    if (c.testType) badges.push('<span class="pill type" title="Test type">' + esc(c.testType) + '</span>');
    if (c.retired) badges.push(pill('none', '⊘ ' + retiredLabel(c.retired), c.retired.reason || 'Struck out in the workbook'));
    if (c.tier === 0 && !c.retired) badges.push(pill('accent', S.model.release ? 'New in ' + S.model.release : 'New'));
    if (c.tier === 1) badges.push(pill('fail', 'Failed last'));
    if (c.issues && c.issues.length) badges.push(pill('outline', c.issues.map(function (i) { return i.ref; }).join(', ')));
    var auto = autoBadge(c);
    if (auto) badges.push(auto);
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

  /** The case's issues, links in full (a reference where there is no link). */
  function issueList(c) { return (c.issues || []).map(function (i) { return i.url || i.ref; }); }

  /** What the issue list knows about an issue: { title, priority, state } or {}. */
  function issueInfo(i) { return ((S.model && S.model.issueInfo) || {})[String(i.url || i.ref).toLowerCase()] || {}; }

  /** The case's issues as tags: the issue number only (its title shows on hover); removable: a ✕ on each. */
  function issueChips(list, removable) {
    if (!list || !list.length) return '';
    return '<div class="issue-chips">' + list.map(function (i) {
      return issueTag(i.ref, i.url || '', issueInfo(i).title || '', removable ? 'data-action="issue-unlink" data-ref="' + esc(i.url || i.ref) + '"' : '');
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
        TR.SYM[o.cls] + ' ' + esc(o.value) + '</button>';
    }).join('');
    var d = S.drafts[c.key] || {};
    var a = '<div class="status-btns" role="group" aria-label="Result">' + btns + '</div>';
    var ev = (m.evidence && m.evidence[c.key]) || {};
    var files = ['photo', 'video'].filter(function (k) { return ev[k]; });
    files.forEach(function (k) {
      var f = ev[k];
      a += '<div class="evidence-row"><span class="small"><span class="muted">' + (k === 'photo' ? 'Screenshot' : 'Recording') + (f.usedFor ? ' for ' + esc(f.usedFor) : '') + ':</span> <span class="mono">' + esc(f.name) + '</span> <span class="faint">' + fmtBytes(f.size) + (f.by ? ' · ' + esc(f.by) : '') + '</span></span>' +
        '<span class="grow"></span><button class="link-btn" data-action="ev-view" data-key="' + esc(c.key) + '" data-kind="' + k + '">View</button>' +
        (S.readOnly ? '' : '<button class="link-btn danger" data-action="ev-remove" data-key="' + esc(c.key) + '" data-kind="' + k + '" title="Delete the file for good">Remove</button>') + '</div>';
    });
    if (files.some(function (k) { return ev[k].usedFor && !ev[k].fresh; }) && !files.some(function (k) { return ev[k].fresh; }) && !S.readOnly) a += '<div class="small faint">To change this result, add a new screenshot or screen recording with Test Run Extension, or remove the files first.</div>';
    var failing = TR.classify(now) === 'fail';
    // Issue links: Enter adds the one typed as a tag below; ✕ on a tag removes it. Both save at once.
    a += '<div><label for="issue" class="note-label">Issue link' + (failing ? '' : ' <span class="faint">(optional)</span>') + '</label><input id="issue" data-issue autocomplete="off" placeholder="Paste the issue link, e.g. https://github.com/org/repo/issues/123" title="Press Enter to link it; a case can have several" value="' + esc(d.issue || '') + '"' + dis + '>' +
      issueChips(c.issues, !S.readOnly) + '</div>';
    if (cur().hasComment) {
      a += '<div><label for="comment" class="note-label">Comment <span class="faint">' + (failing ? '(what went wrong)' : '(optional)') + '</span></label><textarea id="comment" data-comment rows="' + rowsFor(d.comment != null ? d.comment : c.comments[ci], 2, 8, 46) + '" placeholder="Enter saves, Shift+Enter for a new line."' + dis + '>' + esc(d.comment != null ? d.comment : (c.comments[ci] || '')) + '</textarea></div>';
      a += '<div class="row"><button data-action="save-note"' + dis + ' title="Save the comment without changing the result">Save</button></div>';
    }
    a += '<div class="case-tools" role="group" aria-label="Change this test case">' +
      '<button data-action="case-tool" data-mode="edit" title="Change the scenario, steps or expected result (E)"' + dis + '>✎ Edit</button>' +
      '<button data-action="case-tool" data-mode="duplicate" title="Another case already covers this: strike this one out and keep that one"' + dis + '>⧉ Mark Duplicate</button>' +
      '<button data-action="clear-result" title="Clear the result: the case goes back to not run (0, or U to undo)"' + (now && !S.readOnly ? '' : ' disabled') + '>↺ Clear Status</button>' +
      '<button data-action="case-tool" data-mode="deprecate" title="No longer needed: strike it out, with the reason in the comment"' + dis + '>⊘ Deprecated</button></div>';
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
          : dropdown({ bind: pre + d.f, id: id, options: valuesIn(S.model.cases, d.list), value: v, free: true, disabled: S.readOnly })) + '</div>';
    });
    if (cur() && cur().hasComment) {
      h += '<div><label for="ce_note">What changed and why (optional; added to the comment as “Updated: …”)</label>' +
        '<input id="ce_note" data-bind="' + esc(pre + 'note') + '" placeholder="e.g. Pincode now comes from the boundary, not the map" value="' + esc(val(pre + 'note', '')) + '"' + dis + '></div>';
    }
    h += '<div class="row"><span class="small faint">Writes straight into row ' + c.row + ' of the workbook.</span><span class="grow"></span><button class="ghost" data-action="case-tool-cancel">Cancel</button><button class="primary" data-action="save-case"' + dis + '>Save</button></div></div>';
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
    closeBlocks(); // only one form open at a time
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
    if (d.issue != null && String(d.issue).trim()) out.issue = issueList(c).concat([String(d.issue).trim()]).join('\n'); // a link typed but not added yet
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
    if (!value) toast('Test status cleared for ' + (c.id || 'the case') + '.');
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

  /**
   * Save (a case's comment): the comment as it is in the field; moveOn: then open the next case.
   * (Pressing the chosen result again does this too, with a link typed but not added yet.)
   */
  function saveNote(moveOn) {
    var c = S.byKey[S.selected];
    var cy = cur();
    if (!c || !cy) return;
    if (S.readOnly) { toast('View only: you need edit access to save comments.', 'bad'); return; }
    var ci = S.model.cycleIdx;
    var t = $('comment');
    var d = S.drafts[c.key] || {};
    var req = { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, expect: c.statuses[ci] || '', status: c.statuses[ci] || '' };
    if (t) req.comment = t.value; else if (d.comment != null) req.comment = d.comment;
    if (moveOn === true) { var note = unsavedNote(c); if (note && note.issue != null) req.issue = note.issue; }
    if (req.comment == null && req.issue == null) return;
    S.pending[c.key] = true;
    if (moveOn === true) advance(c.key);
    render();
    queueWrite(function () { return api('api_mark', req); }).then(function (r) {
      if (r.ok) {
        if (moveOn === true) delete S.drafts[c.key]; else delete d.comment;
        toast(moveOn === true ? (c.id || 'Case') + ' saved.' : 'Comment saved for ' + (c.id || 'the case') + '.');
      }
      afterMark(c, ci, r, c.statuses[ci], c.comments[ci]);
    });
  }

  /** The case's issue links become `list` (links or references), saved at once; then done(r). */
  function saveIssues(c, list, done) {
    var cy = cur();
    if (!c || !cy) return;
    if (S.readOnly) { toast('View only: you need edit access to link issues.', 'bad'); return; }
    var ci = S.model.cycleIdx;
    var req = { tab: S.tab, key: c.key, sh: c.sh, row: c.row, cycle: cy.label, expect: c.statuses[ci] || '', status: c.statuses[ci] || '', issue: list.join('\n') };
    S.pending[c.key] = true;
    render();
    queueWrite(function () { return api('api_mark', req); }).then(function (r) {
      if (r.ok && done) done(r);
      afterMark(c, ci, r, c.statuses[ci], c.comments[ci]);
    });
  }

  /** Enter in an issue field of a form: the link typed becomes a tag below it (focus stays in the field). */
  function addTag(input) {
    var b = input.getAttribute('data-tags');
    var t = String(input.value).trim();
    if (!t) return;
    if (!looksLikeIssue(t)) { toast('Please enter the issue’s link, starting with https://', 'bad'); return; }
    var list = splitLinks(val(b, ''));
    if (list.map(function (x) { return x.toLowerCase(); }).indexOf(t.toLowerCase()) < 0) list.push(t);
    S.form[b] = list.join('\n');
    S.form[b + ':typing'] = '';
    render();
  }

  /** Enter in the Issue link field: the link typed joins the case's issues, as a tag below. */
  function addIssueLink() {
    var c = S.byKey[S.selected];
    var i = $('issue');
    var text = String(i ? i.value : '').trim();
    if (!c || !text) return;
    if (!/^https?:\/\/\S+$/i.test(text) && !/^#?\d+$|^[A-Z][A-Z0-9_]+-\d+$/i.test(text)) { toast('Please enter the issue’s link, starting with https://', 'bad'); return; }
    var before = (c.issues || []).length;
    saveIssues(c, issueList(c).concat([text]), function (r) {
      var d = S.drafts[c.key];
      if (d) delete d.issue;
      if ((r.issues || []).length === before) toast('That issue is already linked to ' + (c.id || 'this case') + '.');
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
      if (r.ok) toast(u.prev ? 'Test status for ' + (c.id || 'the case') + ' is back to "' + u.prev + '".' : 'Test status cleared for ' + (c.id || 'the case') + '.');
      afterMark(c, ci, r, now, c.comments[ci]);
    });
  }

  function tierHelp(id) {
    return ['Release column matches the release in scope', 'Failed in the previous cycle', 'Everything else'][id] || '';
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
      if (!r.ok && S.view === 'issues') toast(r.error || 'Server error: could not load the known issues.', 'bad');
      if (r.ok) keepIssueInfo(r);
      render();
      clearTimeout(issuePoll);
      if (r.ok && r.fetching && S.view === 'issues') issuePoll = setTimeout(loadIssues, 2500);
    });
  }

  /** Keep the titles shown next to issue links in Run up to date. */
  function keepIssueInfo(r) {
    if (!S.model) return;
    S.model.issueInfo = S.model.issueInfo || {};
    r.issues.forEach(function (e) { S.model.issueInfo[String(e.key).toLowerCase()] = { title: e.title, priority: e.priority, state: e.state }; });
  }

  /**
   * Get the latest title, state and priority of every GitHub issue: Refresh from GitHub, and
   * once each time Known issues is opened. The table is greyed out under a spinner meanwhile.
   */
  function refreshIssues() {
    if (S.readOnly) { loadIssues(); return; } // view-only: the list as it is
    S.issuesRefreshing = true;
    render();
    TR.http('POST', '/api/issues/refresh', { book: book() }).then(function (r) {
      S.issuesRefreshing = false;
      if (!r.ok) { toast(r.error || 'Server error: could not get the latest from GitHub.', 'bad'); render(); return; }
      S.issues = r;
      keepIssueInfo(r);
      render();
      clearTimeout(issuePoll);
      if (r.fetching && S.view === 'issues') issuePoll = setTimeout(loadIssues, 2500);
    });
  }

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
        (c.retired ? ' <span class="pill none">⊘ ' + esc(c.retired) + '</span>' : '') + '</div>';
    });
    e.findings.forEach(function (f) {
      parts.push('<div class="issue-case"><span class="pill accent">Not in the test cases yet</span> <button class="linkish" data-action="view" data-view="findings">Finding ' + esc(f.key) + '</button></div>');
    });
    return parts.join('') || '<span class="faint">–</span>';
  }

  function viewIssues() {
    var r = S.issues;
    // Opening Known issues gets the latest from GitHub once: titles, states and priorities.
    if (S.issuesDue && !S.issuesRefreshing && !S.issuesLoading) { S.issuesDue = false; S.issuesRefreshing = !S.readOnly; setTimeout(refreshIssues, 0); }
    if (!r) { if (!S.issuesRefreshing) loadIssues(); return '<div class="spin-page" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr">Loading known issues</span></div>'; }
    if (r.error) return '<div class="empty card"><h3>Known issues could not be loaded</h3><p style="margin-top:10px"><button data-action="issues-reload">Try again</button></p></div>';
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
    var rail = '<div class="rail-group"><label class="rail-title" for="issueQ">Search</label><input type="search" id="issueQ" data-bind="issueQ" data-live="1" placeholder="Issue, title, test case" value="' + esc(val('issueQ', '')) + '"></div>' +
      '<div class="rail-group" role="group" aria-label="Show"><span class="rail-title">Show</span>' +
      '<button class="chip" data-action="issue-show" data-show="open" aria-pressed="' + (show === 'open') + '">Open <span class="n">' + nOpen + '</span></button>' +
      '<button class="chip" data-action="issue-show" data-show="all" aria-pressed="' + (show === 'all') + '">All <span class="n">' + all.length + '</span></button></div>';
    var formOpen = !S.readOnly && !!val('aiOpen') && runTabs().length > 0;
    var busy = !!(S.issuesRefreshing || r.fetching);
    var h = '<div class="row section-head"><div class="grow"><h2>Known issues</h2><p class="small muted">Every issue linked to a test case or noted as a finding, with its title, priority and state.</p></div>' +
      (r.github && !S.readOnly && all.some(function (e) { return /^https:\/\/github\.com\//i.test(e.url); }) ? '<button class="ghost" data-action="issues-refresh"' + (busy ? ' disabled' : '') + ' title="Get the latest title, state and priority of every GitHub issue">Refresh from GitHub</button>' : '') +
      (S.readOnly || !runTabs().length ? '' : '<button data-action="add-issue" aria-expanded="' + formOpen + '" title="Note an issue that was logged outside Test Run, for example straight on GitHub">+ Add issue</button>') + '</div>';
    if (formOpen) h += addIssueCard();
    h += '<div class="section">';
    if (!all.length) {
      return withRail(rail, h + '<div class="empty card"><h3>No known issues yet</h3><p>Paste an issue link on a test case in <b>Run</b>, add one with <b>+ Add issue</b>, or tick <b>Also add to Test Run</b> in Bug Reporter when you file a bug.<br>Each issue shows here with its title, priority and test cases.</p></div></div>');
    }
    if (!list.length) return withRail(rail, h + '<div class="empty card"><h3>Nothing matches</h3><p>' + (show === 'open' && nOpen === 0 ? 'Every known issue is closed. Choose <b>All</b> to see them.' : 'Clear the search.') + '</p></div></div>');
    // While GitHub is being asked: the table greyed out, a spinner in the middle.
    h += '<div class="card spin-wrap' + (busy ? ' busy' : '') + '"' + (busy ? ' aria-busy="true"' : '') + '><div class="table-wrap"><table class="issues"><thead><tr><th>Issue</th><th>Title</th><th>Priority</th><th>State</th><th>Test cases</th></tr></thead><tbody>';
    list.forEach(function (e) {
      var ref = e.url ? '<a class="mono" href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.ref) + ' ↗</a>' : '<span class="mono">' + esc(e.ref) + '</span>';
      var title = e.title ? esc(e.title) : '<span class="faint">' + (e.fetchError ? 'No title: ' + esc(e.fetchError) : busy && /github\.com/.test(e.url) ? 'Getting it from GitHub' : 'No title yet') + '</span>';
      h += '<tr' + (e.state === 'closed' ? ' class="closed"' : '') + '><td class="nowrap">' + ref + '</td><td>' + title + '</td><td>' + priorityPill(e.priority) + '</td>' +
        '<td>' + (e.state ? '<span class="pill ' + (e.state === 'closed' ? 'pass' : 'outline') + '">' + (e.state === 'closed' ? 'Closed' : 'Open') + '</span>' : '<span class="faint">–</span>') + '</td>' +
        '<td>' + issueCasesHtml(e, many) + '</td></tr>';
    });
    h += '</tbody></table></div>' + (busy ? '<div class="spin-overlay" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr">Getting the latest from GitHub</span></div>' : '') + '</div></div>';
    h += '<p class="small faint section">Downloading the workbook adds these as a <b>Known issues</b> sheet. ' +
      (r.github ? 'Titles, states and priorities of GitHub issues come from GitHub, through the <span class="mono">gh</span> login on the host-server running Test Run.' : 'Install the GitHub CLI (<span class="mono">gh</span>) on the host-server running Test Run to fill in titles, states and priorities from GitHub.') + '</p>';
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
  /** " marked Fail, with #68 linked" (what a finding's bug did to its case), or ''. */
  function linkedText(l) {
    if (!l) return '';
    var refs = (l.issues || []).map(function (i) { return i.ref; }).filter(Boolean);
    var changed = l.status && l.status !== l.previous;
    return (changed ? ', marked ' + l.status + (l.cycle ? ' in cycle ' + l.cycle : '') : '') + (refs.length ? ', with ' + refs[refs.length - 1] + ' linked' : '');
  }

  /** After a finding's bug went onto a case: Run and Known issues show it. */
  function afterLinked(tab) {
    if (tab === S.tab) loadTab(cycleLabel(), true); else delete S.suites[tab];
    loadIssues();
  }

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
    if (!sm) return h + '<div class="small faint" style="margin-top:6px">Reading ' + esc(tab) + '</div></div>';
    var draft = S.writeUp[f.key];
    if (draft) {
      return h + '<div class="writeup">' + scenarioEditor(draft, 'wu:' + f.key,
        '<span class="small faint grow">Added to ' + esc(tab) + '.</span><button class="ghost" data-action="writeup-cancel" data-key="' + esc(f.key) + '">Cancel</button><button class="primary" data-action="writeup-add" data-key="' + esc(f.key) + '"' + dis + '>Save</button>', sm) + '</div></div>';
    }
    if (S.covering === f.key) {
      return h + '<div class="row cover-row" style="margin-top:8px"><label for="covId">Already covered by case</label>' +
        dropdown({ bind: 'cov:' + f.key, id: 'covId', cls: 'cover-dd', value: val('cov:' + f.key, ''),
          options: sm.cases.filter(function (x) { return !x.retired; }).map(function (x) { return { value: x.id || x.key, label: x.id || 'Row ' + x.row, hint: oneLine(x.scenario).slice(0, 110) }; }) }) +
        '<button class="ghost" data-action="cover-cancel">Cancel</button><button class="primary" data-action="cover-save" data-key="' + esc(f.key) + '"' + dis + '>Save</button></div></div>';
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
    return h + '<div class="row" style="margin-top:8px"><button class="primary" data-action="writeup" data-key="' + esc(f.key) + '"' + dis + '>Create test case</button>' +
      '<button data-action="cover" data-key="' + esc(f.key) + '"' + dis + '>Already covered</button><span class="grow"></span>' +
      '<button class="ghost danger" data-action="del-finding" data-key="' + esc(f.key) + '"' + dis + '>Delete</button></div></div>';
  }

  /** A test suite dropdown for a form (which suite a new finding or case goes to). */
  function suitePicker(id, bind, value, change) {
    return '<div class="suite-pick"><label for="' + id + '">Test suite</label>' +
      dropdown({ bind: change ? 'pick:' + id : bind, id: id, cls: 'top-dd suite-dd', change: change, value: value, options: runTabs().map(function (t) { return { value: t.name, label: TR.tabLabel(t.name) }; }) }) + '</div>';
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
      // Nothing chosen = every test suite (the field reads "Select"); ↻ on the title's row clears the choice.
      (tabs.length > 1 ? '<div class="rail-group"><div class="rail-head"><label class="rail-title" for="findingsSuite">Test suite</label>' +
        '<button type="button" class="help-btn" data-action="findings-suite-reset" title="Show every test suite" aria-label="Reset the test suite filter"' + (only ? '' : ' disabled') + '>' + RESET_ICON + '</button></div>' +
        dropdown({ bind: 'findingsSuite', id: 'findingsSuite', change: 'findings-suite', value: only, options: tabs.map(function (t) { return { value: t.name, label: TR.tabLabel(t.name) }; }) }) + '</div>' : '');
    var h = '<div class="row section-head"><div class="grow"><h2>Findings</h2><p class="small muted">Things found while testing that are not test cases yet. Write each one up as a test case, or mark it covered by one.</p></div>' +
      (S.readOnly ? '' : '<button data-action="note-toggle" aria-expanded="' + !!val('noteOpen') + '" title="Note something you found, to write up later (Bug Reporter adds them when you tick its Test Run box)"' + dis + '>+ Add finding</button>' +
        '<button data-action="new-case" aria-expanded="' + (S.manual.length > 0) + '" title="Add a test case to the workbook now"' + dis + '>+ New test case</button>') + '</div>';
    if (S.manual.length) {
      var mtab = val('man:tab', only || S.tab);
      var msm = suiteOf(mtab);
      h += '<div class="card card-pad section"><div class="row" style="margin-bottom:8px"><h3 class="grow">New test case</h3>' + suitePicker('manTab', 'man:tab', mtab, 'man-suite') + '</div>' +
        (msm ? scenarioEditor(S.manual[0], 'man:0', '<button class="ghost" data-action="discard-manual">Cancel</button><button class="primary" data-action="add-manual" data-index="0"' + dis + '>Save</button>', msm)
          : '<div class="loading">Reading ' + esc(mtab) + '</div>') + '</div>';
    }
    if (!S.readOnly && val('noteOpen')) {
      h += '<div class="card card-pad section"><div class="row"><h3 class="grow">New finding</h3>' + suitePicker('fTab', 'fTab', val('fTab', only || S.tab)) + '</div>' +
        '<div class="form-grid" style="margin-top:8px"><div class="wide"><label for="fText">What did you find?</label><input id="fText" data-bind="fText" placeholder="e.g. Citizen cannot reopen a complaint resolved 4 days ago" value="' + esc(val('fText')) + '"' + dis + '></div>' +
        '<div><label for="fIssue">Issue link <span class="faint">(optional)</span></label><input id="fIssue" data-bind="fIssue" placeholder="https://…/issues/123" value="' + esc(val('fIssue')) + '"' + dis + '></div>' +
        '<div><label for="fArea">Area</label>' + dropdown({ bind: 'fArea', id: 'fArea', value: val('fArea', ''), free: true, placeholder: 'Not sure', options: valuesIn((suiteOf(val('fTab', only || S.tab)) || {}).cases, 'group2'), disabled: S.readOnly }) + '</div>' +
        '<div class="wide"><label for="fDetails">Details (optional)</label><textarea id="fDetails" data-bind="fDetails" rows="2"' + dis + '>' + esc(val('fDetails')) + '</textarea></div></div>' +
        '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="ghost" data-action="note-toggle">Cancel</button><button class="primary" data-action="add-finding"' + dis + '>Save</button></div></div>';
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
    var typing = String(val(prefix + ':issue:typing', '')).trim(); // a link typed but not added with Enter yet
    if (typing) out.issue = splitLinks(out.issue).concat([typing]).join('\n');
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
      if (d.f === 'issue') { h += '<div><label for="' + id + '">' + esc(d.label) + '</label>' + issueTagsField(prefix + ':issue', id, v) + '</div>'; return; }
      h += '<div' + (d.wide ? ' class="wide"' : '') + '><label for="' + id + '">' + esc(d.label) + '</label>' +
        (d.rows ? '<textarea id="' + id + '" data-bind="' + esc(prefix + ':' + d.f) + '" rows="' + d.rows + '"' + dis + '>' + esc(v) + '</textarea>'
          // the values already in the suite, one to pick; a new one can be typed in the search box
          : d.list ? dropdown({ bind: prefix + ':' + d.f, id: id, options: valuesIn(sm.cases, d.list), value: v, free: true, disabled: S.readOnly })
          : '<input id="' + id + '" data-bind="' + esc(prefix + ':' + d.f) + '" value="' + esc(v) + '"' + dis + '>') + '</div>';
    });
    if (sm.hasCycle) {
      var st = val(prefix + ':status', defaultStatus(it, sm));
      var sid = prefix.replace(/[^\w-]/g, '_') + '_status';
      h += '<div><label for="' + sid + '" title="' + esc(sm.cycle ? 'Cycle ' + sm.cycle : 'Status') + '">Result in current test cycle</label>' +
        dropdown({ bind: prefix + ':status', id: sid, options: [{ value: '', label: 'Not run yet' }].concat(sm.statusOptions.map(function (o) { return { value: o.value, label: o.value }; })), value: st, search: false, disabled: S.readOnly }) + '</div>';
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

  // Issue links typed into a form: Enter adds the link as a tag below the field (the issue number
  // only, a link to it, and a ✕ that removes it). The tags are kept in S.form[bind], one per line.

  /** The links in a value: one per line or comma separated. */
  function splitLinks(v) { return String(v || '').split(/[\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean); }

  /** What an issue tag shows: "#65" for GitHub and GitLab, "CCRS-12" for Jira, else the link's site. */
  function shortRef(link) {
    var u = String(link || '').trim();
    var m = /\/(?:issues|pull|pulls|merge_requests)\/(\d+)/i.exec(u);
    if (m) return '#' + m[1];
    m = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/i.exec(u) || /^([A-Z][A-Z0-9_]+-\d+)$/i.exec(u);
    if (m) return m[1].toUpperCase();
    m = /^#?(\d+)$/.exec(u);
    if (m) return '#' + m[1];
    m = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(u);
    return m ? m[1] : u.slice(0, 24);
  }

  /** Is this something an issue tag can be made of: a link, "#123" or "ABC-12"? */
  function looksLikeIssue(t) { return /^https?:\/\/\S+$/i.test(t) || /^#?\d+$|^[A-Z][A-Z0-9_]+-\d+$/i.test(t); }

  /** A tag for one issue: the number (a link when there is one), ↗, and a ✕ when removeAction is given. */
  function issueTag(ref, url, title, removeAttrs) {
    var body = url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(title ? ref + ': ' + title : 'Open ' + ref) + '"><b>' + esc(ref) + '</b> ↗</a>' : '<span' + (title ? ' title="' + esc(title) + '"' : '') + '><b>' + esc(ref) + '</b></span>';
    return '<span class="issue-chip' + (removeAttrs ? ' removable' : '') + '">' + body +
      (removeAttrs ? '<button type="button" class="chip-x" ' + removeAttrs + ' aria-label="Remove ' + esc(ref) + '" title="Remove ' + esc(ref) + '">✕</button>' : '') + '</span>';
  }

  function issueTagsField(bind, id, value) {
    if (!Object.prototype.hasOwnProperty.call(S.form, bind)) S.form[bind] = value || ''; // the draft's link (a finding's issue), as the first tag
    var list = splitLinks(S.form[bind]);
    return '<input id="' + esc(id) + '" data-tags="' + esc(bind) + '" data-bind="' + esc(bind + ':typing') + '" autocomplete="off" placeholder="Paste the issue link, press Enter" value="' + esc(val(bind + ':typing', '')) + '"' + (S.readOnly ? ' disabled' : '') + '>' +
      (list.length ? '<div class="issue-chips">' + list.map(function (l, i) {
        return issueTag(shortRef(l), /^https?:/i.test(l) ? l : '', '', S.readOnly ? '' : 'data-action="tags-remove" data-tags="' + esc(bind) + '" data-i="' + i + '"');
      }).join('') + '</div>' : '');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  /** Summary of the test suite and cycle open: the manual results, or the automated ones attached to the cycle. */
  function viewSummary() {
    var d = autoCycle();
    return d && d.latest && S.sumView === 'automated' && auHere() ? viewAutoSummary(d) : viewManualSummary(d);
  }

  function readSumView() {
    try { return window.sessionStorage.getItem('testrun.sumView') === 'automated' ? 'automated' : 'manual'; } catch (e) { return 'manual'; }
  }
  function setSumView(v) {
    S.sumView = v === 'automated' ? 'automated' : 'manual';
    try { window.sessionStorage.setItem('testrun.sumView', S.sumView); } catch (e) { /* storage unavailable: kept on this page only */ }
  }

  /** Manual | Automated, the same size (template screen 8). Automated is off while nothing is attached to the cycle. */
  function sumSwitch(enabled, offTitle) {
    var on = enabled && S.sumView === 'automated';
    return '<span class="seg same" role="group" aria-label="Results to show">' +
      '<button data-action="sum-view" data-v="manual" aria-pressed="' + !on + '">Manual</button>' +
      '<button data-action="sum-view" data-v="automated" aria-pressed="' + on + '"' + (enabled ? '' : ' disabled title="' + esc(offTitle || '') + '"') + '>Automated</button></span>';
  }
  var SUM_NOTE = '<p class="small muted no-print sum-note">Automated results show here once a run is attached to this test suite and cycle.</p>';

  /** The automated results attached to the open workbook › test suite › cycle, or null while they're read. */
  function autoCycle() {
    if (!S.tab || !S.model || !book()) return null;
    var key = book() + '\n' + S.tab + '\n' + cycleLabel();
    if (S.autoCycle && S.autoCycle.key === key) return S.autoCycle.data;
    var mine = S.autoCycle = { key: key, data: null };
    TR.http('GET', '/api/automation/cycle?book=' + enc(book()) + '&tab=' + enc(S.tab) + '&cycle=' + enc(cycleLabel())).then(function (r) {
      if (S.autoCycle !== mine) return;
      mine.data = r.ok ? r : { error: r.error || 'The automated results could not be read.', latest: null, runs: [], cases: {} };
      render();
    });
    return null;
  }

  /** Run: "Auto ✓ / ✗ / –" on a case whose ID automated tests name, in the runs kept for this cycle. */
  function autoBadge(c) {
    var d = S.autoCycle && S.autoCycle.data;
    if (!d || !d.cases || !c.id || c.retired || S.autoCycle.key !== book() + '\n' + S.tab + '\n' + cycleLabel()) return '';
    var st = d.cases[String(c.id).trim().toUpperCase()];
    if (!st) return '';
    var cls = st === 'pass' || st === 'fail' ? st : 'other';
    return '<span class="pill ' + cls + '" title="Latest automated result attached to this cycle">Auto ' + TR.SYM[cls] +
      '<span class="sr">, automated test ' + { pass: 'passed', fail: 'failed', other: 'skipped' }[cls] + '</span></span>';
  }

  /** Summary › Automated: the latest run attached to the test suite and cycle, and the runs kept for it. */
  function viewAutoSummary(d) {
    var r = d.latest;
    var tools = '<div class="report-tools no-print">' + sumSwitch(true) + '<span class="updated grow">Updated on: ' + esc(d.generatedAt) + '</span>' +
      '<button data-action="sum-excel" data-id="' + esc(r.id) + '" title="The automated results as a workbook (.xlsx)"><span aria-hidden="true">⤓</span> Download</button><button data-action="print">Print / PDF</button>' +
      // Publish, as on the Manual summary: the host only, between Print / PDF and Git Report
      (isOwner() ? '<button data-action="publish-now" title="Publish the reports to the GitHub Pages site (Setup → Publish)"' + (S.publishBusy ? ' disabled' : '') + '>Publish</button>' : '') +
      auGitReport(r, 'sum-full-report', '') + auReportTip(r) + '</div>' +
      '<div class="print-only print-title">' + esc(bookTitle(book())) + ' · ' + esc(TR.tabLabel(S.tab)) + ' · cycle ' + esc(cycleLabel() || '–') + ' · automated · updated on ' + esc(d.generatedAt) + '</div>';
    return tools + autoSummaryHtml(d, { open: 'sum-open', keep: d.keep });
  }

  /**
   * The Automated view, live and on the published site: the latest run (figures with the previous
   * run's, what changed, top causes), the runs kept for the cycle, and the manual cases automation
   * also runs. d: { latest, runs, coverage }; o: { open (the action that opens a run), keep, unlockedFor,
   * guest (the published site without an invite key that opens the runs: no top failure causes, and nothing opens a run) }.
   */
  function autoSummaryHtml(d, o) {
    var r = d.latest, t = r.totals, prev = r.previous, pt = prev ? prev.totals : null, c = r.changed;
    var open = function (id, f) { return ' data-action="' + o.open + '" data-id="' + esc(id) + '"' + (f ? ' data-f="' + f + '"' : ''); };
    var tag = o.guest ? 'div' : 'button'; // a guest's "What changed" cards don't open the run
    var h = '<section class="card card-pad stack"><div class="auto-head"><div class="grow"><h2>Latest run · ' + esc(r.suiteName) + '</h2>' +
      '<p class="small muted">' + esc([auDate(r.startedAt), auCommit(r), r.env, auOptions(r)].filter(Boolean).join(' · ')) + '</p></div>' +
      (o.unlockedFor != null ? '<span class="pill pass">' + esc(o.unlockedFor ? 'Unlocked for ' + o.unlockedFor : 'Unlocked with your invite link') + '</span>' : '') + '</div>' +
      '<div class="kpis" style="margin-bottom:0">' +
      auKpi(r.passRate == null ? '–' : r.passRate + '%', 'pass rate', auFrom(r.passRate, prev && prev.passRate, '%'), '', 'Passed out of passed and failed; skipped tests are left out') +
      auKpi(t.passed, 'passed', auFrom(t.passed, pt && pt.passed), 'pass') + auKpi(t.failed, 'failed', auFrom(t.failed, pt && pt.failed, '', true), 'fail') +
      auKpi(t.skipped, 'skipped') + auKpi(t.flaky, 'flaky', '', '', 'Passed on a retry') + '</div>' +
      '<div class="progress-wrap">' + TR.bar(auCounts(t)) + '<div class="legend"><span><span class="sym-pass">' + TR.SYM.pass + '</span> <b>' + t.passed + '</b> passed</span><span><span class="sym-fail">' + TR.SYM.fail + '</span> <b>' + t.failed + '</b> failed</span><span><span class="sym-other">' + TR.SYM.other + '</span> <b>' + t.skipped + '</b> skipped</span></div>' +
      '<span class="small muted">' + (prev ? 'previous run: ' + esc(auDate(prev.startedAt)) : 'no earlier run to compare with') + '</span></div></section>';

    function card(n, l, sub, f) { return '<' + tag + (o.guest ? ' class="chg"' : open(r.id, f)) + '><span class="v">' + n + '</span><span class="l"><b>' + l + '</b>' + (sub ? ' · ' + sub : '') + '</span></' + tag + '>'; }
    h += '<section class="card card-pad stack"><h2>What changed since the previous run</h2>' + (prev
      ? '<div class="changed">' + card(c.newFailures, 'new failures', 'passed last time', 'newfail') + card(c.stillFailing, 'still failing', '', 'still') + card(c.fixed, 'fixed', 'failed last time', 'fixed') + card(c.flaky, 'flaky', 'passed on a retry', 'flaky') + '</div>'
      : '<p class="small muted">This is the first run of ' + esc(r.suiteName) + ' kept for ' + esc(r.attach.tab) + ', so there is nothing to compare it with yet.</p>') + '</section>';

    if (!o.guest) h += '<section class="card card-pad stack"><div class="row"><h2 class="grow">Top failure causes</h2>' + (r.causeCount ? '<button class="link-btn"' + open(r.id, 'failed') + '>All causes ›</button>' : '') + '</div><div>' +
      (r.causes.length ? r.causes.map(function (g, i) {
        var isOpen = !!S.sumOpen[i];
        return '<div class="cause' + (isOpen ? '' : ' collapsed') + '"><button class="cause-head" data-action="sum-cause" data-i="' + i + '" aria-expanded="' + isOpen + '"><span class="chev" aria-hidden="true">▾</span><span class="' + (g.other ? '' : 'mono') + '">' + esc(g.signature) + '</span>' +
          '<span class="nowrap"><b>' + g.count + '</b> ' + (g.count === 1 ? 'test' : 'tests') + (g.newCount ? ' <span class="pill fail">' + g.newCount + ' new</span>' : '') + '</span></button>' +
          '<div class="cause-body">' + g.tests.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join('') + (g.more ? '<span class="muted">… ' + g.more + ' more</span>' : '') + '</div></div>';
      }).join('') : '<p class="small muted">Nothing failed in this run.</p>') + '</div></section>';

    h += '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>Runs for this cycle</h2>' + (o.keep ? '<p class="small muted">' + auKeepText(o.keep) + ' for each automated suite.</p>' : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>When</th><th>Result</th><th class="num">Pass rate</th>' + (o.guest ? '' : '<th><span class="sr">Open</span></th>') + '</tr></thead><tbody>' +
      d.runs.map(function (x) {
        return '<tr><td class="nowrap">' + esc(auDate(x.startedAt)) + '<div class="small muted">' + esc([x.suiteName, x.env, auOptions(x)].filter(Boolean).join(' · ')) + '</div></td>' +
          '<td style="min-width:150px">' + auResult(x.totals) + '</td>' +
          '<td class="num nowrap">' + (x.passRate == null ? '–' : '<b>' + x.passRate + '%</b><div>' + auFrom(x.passRate, x.prevPassRate, '%') + '</div>') + '</td>' +
          (o.guest ? '' : '<td class="num"><button class="small-btn"' + open(x.id) + ' aria-label="Open the run from ' + esc(auDate(x.startedAt)) + '">Open</button></td>') + '</tr>';
      }).join('') + '</tbody></table></div></section>';

    var cv = d.coverage;
    if (cv && cv.total) {
      h += '<p class="small muted">Manual cases also run by automation: <b>' + cv.covered + '</b> of ' + cv.total +
        (cv.covered ? ' · automation passing on <b>' + cv.passing + '</b>, failing on <b>' + cv.failing + '</b>' : '') + '.</p>';
    }
    return '<div class="stack">' + h + '</div>';
  }

  function viewManualSummary(auto) {
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
      return '<div class="loading">Working out the figures</div>';
    }
    var r = S.summary;
    // Manual | Automated first (Automated is off until a run is attached to this suite and cycle)
    var hasAuto = !!(auto && auto.latest);
    var offTitle = !auto ? 'Looking for automated runs' : auto.error ? auto.error : 'No automated run is attached to ' + TR.tabLabel(r.tab) + ' › ' + cycleText(r.cycle) + ' yet';
    // The suite and cycle are picked above; on paper, one line says what it is.
    var here = auHere(); // a workbook without an automated suite: Manual only, no switch
    var h = '<div class="report-tools no-print">' + (here ? sumSwitch(hasAuto, offTitle) : '') + '<span class="updated grow">Updated on: ' + esc(r.generatedAt) + '</span>' +
      downloadButton('summary', '', '<span aria-hidden="true">⤓</span> Download', 'The workbook, with a Known issues sheet') + '<button data-action="print">Print / PDF</button>' +
      (isOwner() ? '<button data-action="publish-now" title="Publish the reports to the GitHub Pages site (Setup → Publish)"' + (S.publishBusy ? ' disabled' : '') + '>Publish</button>' : '') + '</div>' +
      (here && auto && !hasAuto ? SUM_NOTE : '') +
      '<div class="print-only print-title">' + esc(String(book() || '').replace(/\.xlsx$/i, '')) + ' · ' + esc(TR.tabLabel(r.tab)) + ' · cycle ' + esc(r.cycle || '–') + ' · updated on ' + esc(r.generatedAt) + '</div>';
    return h + TR.summaryHtml(r);
  }

  // ---------------------------------------------------------------------------
  // Automation: automated suites, their runs, and each run's results
  // (lib/automation/ on the server). Screens: suite and runs, run results, import results (a file
  // or a GitHub run), link a suite (with its GitHub workflow), Run (start one in GitHub Actions)
  // and Running (follow it until its results come in).
  // ---------------------------------------------------------------------------

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** "24 Nov, 10:23" (or "24 Nov" without the time), in this computer's time. */
  function auDate(iso, withTime) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '–';
    var day = d.getDate() + ' ' + MONTHS[d.getMonth()];
    return withTime === false ? day : day + ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function auStamp(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()); }
  /** A test's time ("30.0 s"), or a run's ("38 min"). */
  function auSecs(ms) { return ms ? (ms / 1000).toFixed(1) + ' s' : '–'; }
  function auLength(ms) {
    if (!ms) return '';
    if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + ' s';
    var m = Math.round(ms / 60000);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function enc(v) { return encodeURIComponent(v == null ? '' : v); }
  function bookTitle(b) { return String(b || '').replace(/\.xlsx$/i, ''); }
  function cycleText(c) { return c ? 'Cycle ' + c : 'Status'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function auKeepText(n) { return n === 1 ? 'The last run is kept' : 'The last ' + n + ' runs are kept'; }
  function attachText(a) { return bookTitle(a.book) + ' › ' + a.tab + ' › ' + cycleText(a.cycle); }
  function auCounts(t) { return { pass: t.passed, fail: t.failed, other: t.skipped, none: 0, total: t.total }; }
  function auOptions(r) { var o = r.options || {}; return Object.keys(o).map(function (k) { return o[k]; }).filter(Boolean).join(' · '); }
  function auHow(r) {
    var s = r.source || {};
    return s.kind === 'github' ? 'from GitHub' : 'imported' + (s.format === 'ctrf' ? ' (CTRF file)' : s.format === 'junit' ? ' (JUnit file)' : '');
  }
  function auCommit(r) { return r.branch || r.sha ? (r.branch || '–') + (r.sha ? ' @ ' + r.sha.slice(0, 7) : '') : ''; }
  /** A run in a sentence: "24 Nov · master · net_two · smoke", or its date and time when nothing else tells it apart. */
  function auLabel(r) {
    var parts = [auDate(r.startedAt, false), r.branch, r.env, auOptions(r)].filter(Boolean);
    return parts.length > 1 ? parts.join(' · ') : auDate(r.startedAt);
  }
  /** The previous run's figure beside this one: "↑ from 84%", green when it got better. */
  function auFrom(cur, prev, unit, lowerIsBetter) {
    if (prev == null || cur == null || prev === cur) return '';
    var up = cur > prev, good = lowerIsBetter ? !up : up;
    return '<span class="delta ' + (good ? 'good' : 'bad') + '" title="Previous run: ' + prev + (unit || '') + '">' + (up ? '↑' : '↓') + ' from ' + prev + (unit || '') + '</span>';
  }
  function auResult(t) {
    return '<div class="stack-s">' + TR.bar(auCounts(t), true) + '<span class="small"><span class="sym-pass">' + TR.SYM.pass + '</span> ' + t.passed + ' &nbsp;<span class="sym-fail">' + TR.SYM.fail + '</span> ' + t.failed + ' &nbsp;<span class="sym-other">' + TR.SYM.other + '</span> ' + t.skipped + '</span></div>';
  }
  function auHist(list) {
    var word = { pass: 'passed', fail: 'failed', other: 'skipped', none: 'not in that run' };
    return '<span class="hist" aria-label="Last runs: ' + esc(list.map(function (c) { return word[c]; }).join(', ')) + '">' + list.map(function (c) { return TR.dot(c); }).join('') + '</span>';
  }
  function auKpi(v, l, extra, cls, title) {
    return '<div class="card kpi' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="v">' + esc(v) + '</div><div class="l">' + esc(l) + (extra ? ' · ' + extra : '') + '</div></div>';
  }
  /** A form field: its name (with an optional circled i holding reference text), the control, a short hint under it. */
  function auField(id, label, control, hint, info) {
    var name = '<label class="note-label" for="' + id + '">' + label + '</label>';
    if (info) name = '<span class="kv-label">' + name + infoTip(id + 'Tip', label.replace(/<[^>]*>/g, '').trim(), info) + '</span>';
    return '<div>' + name + control + (hint ? '<span class="small muted">' + hint + '</span>' : '') + '</div>';
  }
  function maskedHtml(s) { return esc(s).replace(/\*\*\*/g, '<span class="masked">***</span>'); }

  function auLoad() {
    var A = S.auto;
    A.loading = true;
    return TR.http('GET', '/api/automation').then(function (r) {
      A.loading = false;
      if (!r.ok) { A.error = r.error || 'The automated results could not be read.'; render(); return r; }
      A.data = r;
      A.error = '';
      var ids = auBookSuites().map(function (s) { return s.id; });
      if (ids.indexOf(A.suite) < 0) A.suite = ids[0] || '';
      render();
      return r;
    });
  }
  function auSuite(id) {
    var d = S.auto.data;
    var want = id || S.auto.suite;
    return d ? d.suites.filter(function (s) { return s.id === want; })[0] || null : null;
  }
  /** Does the workbook open have an automated suite (for this person)? The Automation tab shows only then. */
  function auHere() {
    var a = S.app && S.app.automationBooks;
    return !a || a.indexOf(book() || '') >= 0;
  }
  /** Does this suite belong to the workbook open? (One linked before suites had workbooks belongs to all.) */
  function auInBook(s, b) { return !!s && (!s.books || s.books.indexOf(b == null ? book() : b) >= 0); }
  /** The suites of the workbook open. */
  function auBookSuites() { var d = S.auto.data; return d ? d.suites.filter(function (s) { return auInBook(s); }) : []; }
  /** A run going in GitHub Actions whose results come to the workbook open. */
  function auJobHere(j) { return !!j && !!j.attach && j.attach.book === book(); }
  /** A suite's kept runs attached to the workbook open (all: in every workbook, for Setup). */
  function auRunsOf(id, all) { return S.auto.data.runs.filter(function (r) { return r.suiteId === id && (all || r.attach.book === book()); }); }
  function auShownRuns(id) {
    var env = val('au:f:env', ''), branch = val('au:f:branch', '');
    return auRunsOf(id).filter(function (r) { return (!env || r.env === env) && (!branch || r.branch === branch); });
  }
  function distinctOf(list, k) {
    var out = [];
    list.forEach(function (r) { if (r[k] && out.indexOf(r[k]) < 0) out.push(r[k]); });
    return out.sort();
  }

  /** A workbook's test suites and their cycles, for the attach pickers (read once per form). */
  function auTargets(b, then) {
    var A = S.auto;
    if (!b) return;
    if (A.targets[b]) { if (then) then(A.targets[b]); return; }
    if (A.targetsLoading[b]) return;
    A.targetsLoading[b] = true;
    TR.http('GET', '/api/automation/targets?book=' + enc(b)).then(function (r) {
      delete A.targetsLoading[b];
      if (!r.ok) { toast(r.error, 'bad'); render(); return; }
      A.targets[b] = r;
      if (then) then(r);
      render();
    });
  }
  /** Fill in a test suite and cycle that fit the chosen workbook: the one open in Run when it's there, else the first; its current cycle. */
  function auDefaults(prefix) {
    var bk = 'au:' + prefix + ':book', tk = 'au:' + prefix + ':tab', ck = 'au:' + prefix + ':cycle';
    var b = S.form[bk];
    var tg = b && S.auto.targets[b];
    if (!tg) return;
    var tabs = tg.tabs;
    var here = b === book();
    if (!tabs.some(function (t) { return t.name === S.form[tk]; })) S.form[tk] = here && tabs.some(function (t) { return t.name === S.tab; }) ? S.tab : tabs[0] ? tabs[0].name : '';
    var t = tabs.filter(function (x) { return x.name === S.form[tk]; })[0];
    if (!t) { delete S.form[ck]; return; }
    var have = S.form[ck];
    if (!(have && have.indexOf('c:') === 0 && t.cycles.indexOf(have.slice(2)) >= 0)) {
      S.form[ck] = 'c:' + (here && t.name === S.tab && t.cycles.indexOf(cycleLabel()) >= 0 ? cycleLabel() : t.current);
    }
  }
  /** A picked workbook or test suite: what depends on it starts again. */
  function auPicked(prefix, what) {
    if (what === 'book') { delete S.form['au:' + prefix + ':tab']; delete S.form['au:' + prefix + ':cycle']; auTargets(S.form['au:' + prefix + ':book'], function () { auDefaults(prefix); }); }
    else delete S.form['au:' + prefix + ':cycle'];
    auDefaults(prefix);
  }
  /** The chosen workbook › test suite › test cycle, or null while one is missing. */
  function auAttachChosen(prefix) {
    var b = S.form['au:' + prefix + ':book'], t = S.form['au:' + prefix + ':tab'], c = S.form['au:' + prefix + ':cycle'];
    var tg = b && S.auto.targets[b];
    var tab = tg && tg.tabs.filter(function (x) { return x.name === t; })[0];
    if (!tab || !c || c.indexOf('c:') !== 0 || tab.cycles.indexOf(c.slice(2)) < 0) return null;
    return { book: b, tab: t, cycle: c.slice(2) };
  }
  /** Workbook › Test suite › Test cycle, each a dropdown (a cycle's value is "c:<label>", so an unnamed Status column can be picked too). */
  function auAttachPickers(prefix, required, bare) {
    var b = val('au:' + prefix + ':book', '');
    var tg = b ? S.auto.targets[b] : null;
    var tabs = tg ? tg.tabs : [];
    var t = val('au:' + prefix + ':tab', '');
    var tab = tabs.filter(function (x) { return x.name === t; })[0];
    var keep = S.auto.data.keep;
    return '<div class="stack-s">' + (bare ? '' : '<label class="note-label" for="au_' + prefix + '_book">' + (prefix === 'mv' ? 'Attach the run to' : 'Attach the results to') + (required ? ' <span class="faint">(required)</span>' : '') + '</label>') + '<div class="link-path">' +
      dropdown({ bind: 'au:' + prefix + ':book', id: 'au_' + prefix + '_book', cls: 'top-dd', value: b, prefix: '<span class="dd-prefix">Workbook</span>', title: 'Workbook',
        options: auAllowedBooks(prefix).map(function (x) { return { value: x, label: bookTitle(x) }; }) }) +
      dropdown({ bind: 'au:' + prefix + ':tab', id: 'au_' + prefix + '_tab', cls: 'top-dd', value: t, prefix: '<span class="dd-prefix">Test suite</span>', title: 'Test suite', disabled: !tg, placeholder: b && !tg ? 'Loading' : 'Select',
        options: tabs.map(function (x) { return { value: x.name, label: TR.tabLabel(x.name) }; }) }) +
      dropdown({ bind: 'au:' + prefix + ':cycle', id: 'au_' + prefix + '_cycle', cls: 'top-dd', value: val('au:' + prefix + ':cycle', ''), prefix: '<span class="dd-prefix">Test cycle</span>', title: 'Test cycle', disabled: !tab,
        options: tab ? tab.cycles.map(function (c) { return { value: 'c:' + c, label: cycleText(c) }; }) : [] }) +
      '</div>' + (bare ? '' : '<span class="small muted">' + auAttachNote(keep) + '</span>') + '</div>';
  }
  function auAttachNote(keep) {
    return 'Only people who can open this workbook can see the results. Test Run keeps the last ' + (keep === 1 ? 'run' : keep + ' runs') + ' for each test suite and cycle.';
  }
  /** "Notifications › Cycle v2.12 already has 2 runs. Importing this one removes the oldest (20 Nov, 11:02)." */
  function auFullWarning(prefix, suiteId, runId) {
    var a = auAttachChosen(prefix);
    if (!a) return '';
    var d = S.auto.data;
    var group = d.runs.filter(function (r) { return r.suiteId === suiteId && r.id !== runId && r.attach.book === a.book && r.attach.tab === a.tab && r.attach.cycle === a.cycle; });
    if (group.length < d.keep) return '';
    var goes = group.slice(d.keep - 1); // newest first: the oldest ones are pushed out
    return '<div class="note warn">' + esc(a.tab + ' › ' + cycleText(a.cycle)) + ' already has ' + plural(group.length, 'run') + '. ' +
      (prefix === 'mv' ? 'Moving this one there' : 'Importing this one') + ' removes the oldest (' + esc(goes.map(function (r) { return auDate(r.startedAt); }).join(', ')) + ').</div>';
  }
  function auRemovedText(removed, keep) {
    if (!removed || !removed.length) return '';
    return ' The run' + (removed.length > 1 ? 's' : '') + ' from ' + removed.map(function (r) { return auDate(r.startedAt); }).join(' and ') + (removed.length > 1 ? ' were' : ' was') + ' removed: ' + (keep === 1 ? '1 is' : keep + ' are') + ' kept.';
  }

  /** Send results files: one as it is (its name in ?name=), several as a form. */
  function auUpload(path, files) {
    if (files.length === 1) return TR.http('POST', path + (path.indexOf('?') >= 0 ? '&' : '?') + 'name=' + enc(files[0].name), files[0], true);
    var fd = new FormData();
    files.forEach(function (f) { fd.append('files', f, f.name); });
    return TR.http('POST', path, fd, true);
  }
  /** Files picked or dropped on Import results: read at once (format and counts), kept on the page until Import Results. */
  function auChoose(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length || S.auto.screen !== 'import') return;
    var size = files.reduce(function (n, f) { return n + f.size; }, 0);
    if (size > 20 * 1024 * 1024) { toast('That is too large: results files can be at most 20 MB together.', 'bad'); return; }
    var mine = { files: files, label: files.length === 1 ? files[0].name : files.length + ' files', size: size, busy: true, preview: null, error: '' };
    S.auto.file = mine;
    render();
    auUpload('/api/automation/preview?suite=' + enc(S.auto.suite), files).then(function (r) {
      if (S.auto.file !== mine) return;
      mine.busy = false;
      if (!r.ok) mine.error = r.error;
      else {
        mine.preview = r;
        if (!String(val('au:branch', '')).trim() && r.branch) S.form['au:branch'] = r.branch;
        if (!String(val('au:env', '')).trim() && r.env) S.form['au:env'] = r.env;
      }
      render();
    });
  }

  function viewAutomation() {
    var A = S.auto;
    if (!A.data) {
      if (!A.loading && !A.error) auLoad();
      return A.error ? '<div class="banner bad"><span>' + esc(A.error) + '</span><span class="grow"></span><button data-action="au-reload">Try Again</button></div>' : '<div class="loading">Loading the automated results</div>';
    }
    var mine = auBookSuites();
    if (!mine.some(function (x) { return x.id === A.suite; })) A.suite = mine.length ? mine[0].id : ''; // another workbook: its first suite
    if (A.screen === 'run' && A.runId) {
      var det = auDetail();
      if (det && det.run.attach.book !== book()) { A.screen = 'runs'; A.runId = ''; A.detail = null; return viewAutomation(); } // a run of another workbook
      return withRail(auRail(det ? det.run.suiteId : A.suite), det ? auRunView(det) : '<div class="loading">Loading the run</div>');
    }
    var s = auSuite();
    if (!s) {
      return withRail(auRail(''), '<div class="empty card"><h3>No automated suites yet</h3>' + (isOwner()
        ? '<p>Please add it from <button class="linkish" data-action="view" data-view="setup" data-part="automation">Setup › Automation</button></p>'
        : '<p>Your test lead has not linked an automated suite yet, or not shared one with you.</p>') + '</div>');
    }
    if (A.screen === 'import' && A.data.canAct) return withRail(auRail(s.id), auImport(s));
    if (A.screen === 'start' && A.data.canAct && s.workflowId) return withRail(auRail(s.id), auStart(s));
    return withRail(auRail(s.id), auRunsList(s));
  }

  /** Left: the linked suites (linked in Setup › Automation), and the Environment and Branch filters (DESIGN.md › Dropdowns › As a filter). */
  function auRail(active) {
    var d = S.auto.data;
    var h = '<div class="rail-group subtabs" role="tablist" aria-label="Automated suites"><span class="rail-title">Automated suites</span>' +
      auBookSuites().map(function (s) { return '<button role="tab" class="subtab" data-action="au-suite" data-id="' + esc(s.id) + '" aria-selected="' + (active === s.id) + '">' + esc(s.name) + '</button>'; }).join('') + '</div>';
    if (active && S.auto.screen === 'runs') {
      var runs = auRunsOf(active);
      var envs = distinctOf(runs, 'env'), branches = distinctOf(runs, 'branch');
      if (envs.length || val('au:f:env', '')) h += auFilter('au:f:env', 'Environment', envs);
      if (branches.length || val('au:f:branch', '')) h += auFilter('au:f:branch', 'Branch', branches);
    }
    return h + '<p class="small muted rail-note">Each suite runs in its own repository\'s GitHub Actions. Test Run reads its results file (JUnit XML or CTRF JSON), whatever the framework.</p>';
  }
  /** A single-choice filter: nothing chosen = everything (the field reads Select); ↻ on its title's row clears it. */
  function auFilter(bind, title, options) {
    var on = !!val(bind, '');
    var id = bind.replace(/\W/g, '_');
    var low = title.toLowerCase();
    return '<div class="rail-group"><div class="rail-head"><label class="rail-title" for="' + id + '">' + esc(title) + '</label>' +
      '<button type="button" class="help-btn" data-action="au-filter-reset" data-dd="' + esc(bind) + '" title="Show every ' + low + '" aria-label="Reset the ' + low + ' filter"' + (on ? '' : ' disabled') + '>' + RESET_ICON + '</button></div>' +
      dropdown({ bind: bind, id: id, value: val(bind, ''), options: options }) + '</div>';
  }

  /** The suite's card: name, repository, results format; its actions on the right. */
  function auHead(s, actions) {
    var d = S.auto.data;
    var meta = [];
    if (s.repo) meta.push('<a href="https://github.com/' + esc(s.repo) + '" target="_blank" rel="noopener">' + esc(s.repo) + ' ↗</a>');
    if (s.workflow) meta.push('workflow ' + esc(s.workflow));
    meta.push(s.format ? 'results: ' + esc(d.formats[s.format] || s.format) + (s.artifact ? ' in artifact <span class="mono">' + esc(s.artifact) + '</span>' : '') : 'no results imported yet');
    if (s.casePattern) meta.push('case IDs <span class="mono">' + esc(s.casePattern) + '</span>');
    // ▶ Run (GitHub Actions) is the primary button once the suite is linked to its workflow; until then ⤒ Import Results is
    if (actions == null) {
      actions = !d.canAct ? '' : '<button data-action="au-edit">✎ Edit</button>' + (s.workflowId
        ? '<button data-action="au-import">⤒ Import Results</button><button class="primary" data-action="au-run">▶ Run</button>'
        : '<button class="primary" data-action="au-import">⤒ Import Results</button>');
    }
    return '<section class="card card-pad"><div class="auto-head"><div class="grow"><h2>' + esc(s.name) + '</h2><p class="small muted">' + meta.join(' · ') + '</p></div>' +
      (actions ? '<div class="row">' + actions + '</div>' : '') + '</div></section>';
  }

  /** Screen 1: the suite and its kept runs. */
  function auRunsList(s) {
    var d = S.auto.data;
    var all = auRunsOf(s.id);
    var rows = auShownRuns(s.id);
    var h = auHead(s) + auJobsCard(s) + '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>Runs</h2><p class="small muted">' + auKeepText(d.keep) + ' for each test suite and cycle.</p></div>' +
      '<div class="table-wrap"><table><thead><tr><th>When</th><th>What ran</th><th>Result</th><th class="num">Pass rate</th><th>Attached to</th><th><span class="sr">Open</span></th></tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="6" class="no-data">' + (all.length ? 'No runs match the filters' : 'No runs yet' + (d.canAct ? '. Bring one in with ⤒ Import Results.' : '')) + '</td></tr>';
    rows.forEach(function (r) {
      var what = auCommit(r);
      var sub = [r.env, auOptions(r)].filter(Boolean).join(' · ');
      h += '<tr><td class="nowrap">' + esc(auDate(r.startedAt)) + '<div class="small muted">' + esc([r.by, auHow(r)].filter(Boolean).join(' · ')) + '</div></td>' +
        '<td>' + (what ? '<span class="mono">' + esc(what) + '</span>' : '<span class="faint">–</span>') + (sub ? '<div class="small muted">' + esc(sub) + '</div>' : '') + '</td>' +
        '<td style="min-width:150px">' + auResult(r.totals) + '</td>' +
        '<td class="num nowrap">' + (r.passRate == null ? '–' : '<b>' + r.passRate + '%</b><div>' + auFrom(r.passRate, r.prev && r.prev.passRate, '%') + '</div>') + '</td>' +
        '<td><span class="small">' + esc(attachText(r.attach)) + '</span></td>' +
        '<td class="num"><button class="small-btn" data-action="au-open" data-id="' + esc(r.id) + '" aria-label="Open the run from ' + esc(auDate(r.startedAt)) + '">Open</button></td></tr>';
    });
    return '<div class="stack">' + h + '</tbody></table></div></section></div>';
  }

  /** One run with its comparison, causes and history (read once, when opened). */
  function auDetail() {
    var A = S.auto;
    if (A.detail && A.detail.run.id === A.runId) return A.detail;
    if (!A.detailLoading) {
      A.detailLoading = true;
      TR.http('GET', '/api/automation/run?id=' + enc(A.runId)).then(function (r) {
        A.detailLoading = false;
        if (!r.ok) { toast(r.error, 'bad'); A.runId = ''; A.screen = 'runs'; render(); return; }
        A.detail = r;
        A.suite = r.run.suiteId;
        A.open = { 0: true };
        A.filter = A.wantFilter || (r.run.totals.failed ? 'failed' : 'all'); // wantFilter: a What changed card on Summary
        A.wantFilter = '';
        A.q = '';
        A.allFiles = false;
        A.moving = false;
        var firstFail = r.run.tests.filter(function (t) { return t.status === 'fail'; })[0];
        A.sel = firstFail ? firstFail.id : '';
        render();
      });
    }
    return null;
  }

  /** The tests the All tests list shows, for its chips and search. */
  function auTestsShown(det) {
    var A = S.auto, c = det.compare;
    var sets = { newfail: c.newFailures, still: c.stillFailing, fixed: c.fixed };
    var inSet = sets[A.filter] ? {} : null;
    if (inSet) sets[A.filter].forEach(function (id) { inSet[id] = true; });
    var q = String(A.q || '').trim().toLowerCase();
    return det.run.tests.filter(function (t) {
      if (A.filter === 'failed' && t.status !== 'fail') return false;
      if (A.filter === 'skipped' && t.status !== 'other') return false;
      if (A.filter === 'flaky' && !t.flaky) return false;
      if (inSet && !inSet[t.id]) return false;
      return !q || [t.title, t.file, t.suite, t.tags.join(' '), t.caseIds.join(' '), t.message].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  /** "8 Dec 2026", in this computer's time ('' when it isn't a date). */
  function auDay(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  /**
   * How long GitHub keeps a run's artifacts: the date it gave for the results artifact when the run
   * was imported (source.expiresAt), or, without one, the most it keeps them.
   */
  function auKeptText(src) {
    var until = src && src.expiresAt ? auDay(src.expiresAt) : '';
    if (!until) return 'Available on GitHub for a limited time after the run, at most 90 days.';
    return Date.parse(src.expiresAt) < Date.now() ? 'Was available until ' + until + '.' : 'Available until ' + until + '.';
  }
  /** Where ↗ Git Report goes: the suite's own published report when the run gave one (report-link), else the run on GitHub; '' for neither. */
  function auReportUrl(src) {
    var web = function (u) { return typeof u === 'string' && /^https?:\/\//i.test(u); };
    return src && web(src.reportUrl) ? src.reportUrl : src && web(src.runUrl) ? src.runUrl : '';
  }
  /**
   * ↗ Git Report, when the run has somewhere to open. action: au-full-report (the run's page) or
   * sum-full-report (Summary › Automated, with data-url). cls: the button's class ('small-btn' unless given; '' on Summary, as Download).
   */
  function auGitReport(r, action, cls) {
    var src = r.source || {}, u = auReportUrl(src);
    if (!u) return '';
    cls = cls == null ? 'small-btn' : cls;
    return '<button' + (cls ? ' class="' + cls + '"' : '') + ' data-action="' + action + '"' + (action === 'sum-full-report' ? ' data-url="' + esc(u) + '"' : '') +
      ' title="' + (u === src.reportUrl ? 'Opens the suite\'s published report' : 'Opens the run on GitHub') + '">↗ Git Report</button>';
  }
  /** The Git report tooltip (DESIGN.md › Tooltips): where the suite's own report is, and how long it stays. */
  function auReportTip(r) {
    var text = r.source && r.source.runUrl
      ? 'The suite\'s own report, traces, videos and logs, on its GitHub Actions run. ' + auKeptText(r.source) + ' The results on this page stay in Test Run.'
      : 'This run was imported from a results file, so Test Run has no link to the suite\'s own report: it stays wherever the run was done. The results on this page stay in Test Run.';
    return helpButton({ id: 'frTip', label: 'About the Git report', title: 'Git report', html: '<span>' + esc(text) + '</span>' });
  }

  /** Screen 4: a run's results, the management view. o.published: on the published site, read only (unlocked there). */
  function auRunView(det, o) {
    o = o || {};
    var A = S.auto, r = det.run, t = r.totals, prev = det.previous;
    var can = !o.published && det.canAct && !!S.app && S.app.books.some(function (b) { return b.name === r.attach.book; });
    var state = t.failed ? 'fail' : t.passed ? 'pass' : 'other';
    var by = r.by ? (r.source.kind === 'github' ? 'started by ' : 'imported by ') + r.by : '';
    var meta = [auDate(r.startedAt), auCommit(r), r.env, auOptions(r), by, auLength(r.durationMs)].filter(Boolean);
    // One row above the title: ‹ Back on the left; Change Cycle, Delete, ⤓ Download, ↗ Git Report and its ? on the right
    var h = '<section class="card card-pad stack"><div class="run-actions">' +
      (o.published ? '<button class="small-btn" data-action="pub-back">‹ Back</button>' : '<button class="small-btn" data-action="au-back">‹ Back</button>') + '<span class="grow"></span>' +
      (can ? '<button class="small-btn" data-action="au-move" aria-expanded="' + !!A.moving + '">Change Cycle</button><button class="small-btn danger-outline" data-action="au-delete">Delete</button>' : '') +
      (o.published
        ? '<button class="small-btn" data-action="pub-csv" data-id="' + esc(r.id) + '" title="The results as a spreadsheet (.csv)"><span aria-hidden="true">⤓</span> Download</button>'
        : '<button class="small-btn" data-action="au-excel" title="The results as a workbook (.xlsx)"><span aria-hidden="true">⤓</span> Download</button>') +
      auGitReport(r, 'au-full-report') + auReportTip(r) + '</div>';
    // Change Cycle opens its form under the row it is in
    if (A.moving && can) {
      h += '<div class="item stack"><div class="tool-title">Change cycle</div><p class="small muted">Attach this run to another workbook, test suite or test cycle.</p>' + auAttachPickers('mv') + auFullWarning('mv', r.suiteId, r.id) +
        '<div class="row" style="justify-content:flex-end"><button class="ghost" data-action="au-move-cancel">Cancel</button><button class="primary" data-action="au-move-save">Save</button></div></div>';
    }
    h += '<div class="auto-head"><div class="grow"><h2 class="row">' + TR.dot(state) + '<span class="sr">' + TR.CLS_LABEL[state] + '.</span> ' + esc(r.suiteName) + ' · ' + (t.failed ? t.failed + ' failed' : t.passed ? 'all passed' : 'nothing passed or failed') + '</h2>' +
      '<p class="small muted">' + esc(meta.join(' · ')) + '</p><span class="small">' + esc(attachText(r.attach)) + '</span></div></div>';
    var pt = prev ? prev.totals : null;
    h += '<div class="kpis" style="margin-bottom:0">' +
      auKpi(r.passRate == null ? '–' : r.passRate + '%', 'pass rate', auFrom(r.passRate, prev && prev.passRate, '%'), '', 'Passed out of passed and failed; skipped tests are left out') +
      auKpi(t.passed, 'passed', auFrom(t.passed, pt && pt.passed), 'pass') + auKpi(t.failed, 'failed', auFrom(t.failed, pt && pt.failed, '', true), 'fail') +
      auKpi(t.skipped, 'skipped') + auKpi(t.flaky, 'flaky', '', '', 'Passed on a retry') + '</div>' +
      '<div class="progress-wrap">' + TR.bar(auCounts(t)) + '<div class="legend"><span><span class="sym-pass">' + TR.SYM.pass + '</span> <b>' + t.passed + '</b> passed</span><span><span class="sym-fail">' + TR.SYM.fail + '</span> <b>' + t.failed + '</b> failed</span><span><span class="sym-other">' + TR.SYM.other + '</span> <b>' + t.skipped + '</b> skipped</span></div>' +
      '<span class="small muted">' + (prev ? 'previous run: ' + esc(auDate(prev.startedAt)) : 'no earlier run to compare with') + '</span></div></section>';

    // What changed: each card sets the tests list below
    var c = det.compare;
    function card(n, l, sub, f) { return '<button data-action="au-filter" data-f="' + f + '"><span class="v">' + n + '</span><span class="l"><b>' + l + '</b>' + (sub ? ' · ' + sub : '') + '</span></button>'; }
    h += '<section class="card card-pad stack"><h2>What changed since the previous run</h2>' + (prev
      ? '<div class="changed">' + card(c.newFailures.length, 'new failures', 'passed last time', 'newfail') + card(c.stillFailing.length, 'still failing', '', 'still') + card(c.fixed.length, 'fixed', 'failed last time', 'fixed') + card(c.flaky.length, 'flaky', 'passed on a retry', 'flaky') + '</div>'
      : '<p class="small muted">This is the first run of ' + esc(r.suiteName) + ' kept for ' + esc(bookTitle(r.attach.book) + ' › ' + r.attach.tab) + ', so there is nothing to compare it with yet.</p>') + '</section>';

    // Failures by cause
    var byId = {};
    r.tests.forEach(function (x) { byId[x.id] = x; });
    var name = function (x) { return (x.file ? x.file + ' › ' : x.suite ? x.suite + ' › ' : '') + x.title; };
    h += '<section class="card card-pad stack"><div><h2>Failures by cause</h2><p class="small muted">Failure messages with the numbers, IDs and quoted values taken out, so tests that broke the same way sit together.</p></div><div>' +
      (det.causes.length ? det.causes.map(function (g, i) {
        var open = !!A.open[i];
        var list = g.tests.slice(0, 8).map(function (id) { var x = byId[id]; return x ? '<button class="linkish" data-action="au-test" data-id="' + esc(id) + '">' + esc(name(x)) + '</button>' : ''; }).join('');
        return '<div class="cause' + (open ? '' : ' collapsed') + '"><button class="cause-head" data-action="au-cause" data-i="' + i + '" aria-expanded="' + open + '"><span class="chev" aria-hidden="true">▾</span><span class="' + (g.other ? '' : 'mono') + '">' + esc(g.signature) + '</span>' +
          '<span class="nowrap"><b>' + g.count + '</b> ' + (g.count === 1 ? 'test' : 'tests') + (g.newCount ? ' <span class="pill fail">' + g.newCount + ' new</span>' : '') + '</span></button>' +
          '<div class="cause-body">' + list + (g.tests.length > 8 ? '<span class="muted">… ' + (g.tests.length - 8) + ' more</span>' : '') + '</div></div>';
      }).join('') : '<p class="small muted">Nothing failed in this run.</p>') + '</div></section>';

    // By test file
    var files = A.allFiles ? det.files : det.files.slice(0, 10);
    h += '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>By test file</h2></div><div class="table-wrap"><table><thead><tr><th>File</th><th class="num">Tests</th>' +
      '<th class="num"><span aria-hidden="true">' + TR.SYM.pass + '</span><span class="sr">Passed</span></th><th class="num"><span aria-hidden="true">' + TR.SYM.fail + '</span><span class="sr">Failed</span></th><th class="num"><span aria-hidden="true">' + TR.SYM.other + '</span><span class="sr">Skipped</span></th><th>Result</th></tr></thead><tbody>' +
      (files.length ? files.map(function (f) {
        return '<tr><td class="mono">' + esc(f.file) + '</td><td class="num">' + f.total + '</td><td class="num">' + f.passed + '</td><td class="num">' + f.failed + '</td><td class="num">' + f.skipped + '</td><td style="min-width:120px">' + TR.bar({ pass: f.passed, fail: f.failed, other: f.skipped, none: 0, total: f.total }, true) + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="no-data">No data available</td></tr>') +
      (det.files.length > 10 && !A.allFiles ? '<tr><td colspan="6" class="small muted">… ' + plural(det.files.length - 10, 'more file') + ' <button class="linkish" data-action="au-all-files">Show All</button></td></tr>' : '') + '</tbody></table></div></section>';

    // All tests, with search, chips and the test panel
    var counts = { all: t.total, failed: t.failed, newfail: c.newFailures.length, still: c.stillFailing.length, fixed: c.fixed.length, flaky: t.flaky, skipped: t.skipped };
    var chips = [['all', 'All'], ['failed', 'Failed'], ['newfail', 'New failures'], ['still', 'Still failing'], ['fixed', 'Fixed'], ['flaky', 'Flaky'], ['skipped', 'Skipped']]
      .filter(function (x) { return x[0] === 'all' || x[0] === 'failed' || counts[x[0]] || A.filter === x[0]; });
    var shown = auTestsShown(det);
    var isNew = {}, isFixed = {};
    c.newFailures.forEach(function (id) { isNew[id] = true; });
    c.fixed.forEach(function (id) { isFixed[id] = true; });
    var hist = det.history.byTest;
    var LIMIT = 200;
    h += '<section class="card card-pad stack" id="auTests"><h2>All tests</h2><div class="toolbar" style="margin:0"><label class="sr" for="auQ">Search tests</label><input id="auQ" type="search" placeholder="Search title, file or tag" value="' + esc(A.q) + '">' +
      chips.map(function (x) { return '<button class="chip" data-action="au-chip" data-f="' + x[0] + '" aria-pressed="' + (A.filter === x[0]) + '">' + x[1] + ' <span class="n">' + counts[x[0]] + '</span></button>'; }).join('') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th><span class="sr">Result</span></th><th>Test</th><th>Last ' + det.history.runs.length + ' run' + (det.history.runs.length === 1 ? '' : 's') + '</th><th class="num">Time</th></tr></thead><tbody>' +
      (shown.length ? shown.slice(0, LIMIT).map(function (x) {
        return '<tr class="test-row' + (x.id === A.sel ? ' sel' : '') + '" tabindex="0" data-action="au-test" data-id="' + esc(x.id) + '"><td>' + TR.dot(x.status) + '<span class="sr">' + TR.CLS_LABEL[x.status] + '</span></td>' +
          '<td>' + esc(x.title) + (isNew[x.id] ? ' <span class="pill fail">new</span>' : '') + (isFixed[x.id] ? ' <span class="pill pass">fixed</span>' : '') + (x.flaky ? ' <span class="pill other">flaky</span>' : '') +
          (x.file || x.suite ? '<div class="small muted mono">' + esc(x.file || x.suite) + '</div>' : '') + '</td><td>' + auHist(hist[x.id] || [x.status]) + '</td><td class="num nowrap">' + esc(auSecs(x.durationMs)) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="no-data">Nothing matches</td></tr>') + '</tbody></table></div>' +
      (shown.length > LIMIT ? '<p class="small muted">Showing ' + LIMIT + ' of ' + shown.length + '. Search to narrow them down.</p>' : '');
    var sel = byId[A.sel];
    if (sel) h += auTestPanel(sel, det);
    return '<div class="stack">' + h + '</section></div>';
  }

  /** The test picked in All tests: its message, where it broke, and its last runs. */
  function auTestPanel(x, det) {
    var list = det.history.byTest[x.id] || [x.status];
    var since = '';
    if (x.status === 'fail' && list.length > 1) {
      if (list[list.length - 2] !== 'fail') since = 'First failure: this run.';
      else {
        var k = list.length - 1;
        while (k > 0 && list[k - 1] === 'fail') k--;
        since = 'Failing since ' + auDate(det.history.runs[k].startedAt, false) + '.';
      }
    }
    var info = [x.file ? '<span class="mono">' + esc(x.file) + '</span>' : '', x.suite && x.suite !== x.file ? esc(x.suite) : '', esc(auSecs(x.durationMs)),
      x.retries ? plural(x.retries, 'retry', 'retries') : '', x.tags.length ? 'tags <span class="mono">' + esc(x.tags.join(' ')) + '</span>' : '',
      x.caseIds.length ? 'manual case' + (x.caseIds.length > 1 ? 's' : '') + ' <b>' + esc(x.caseIds.join(', ')) + '</b>' : ''].filter(Boolean);
    return '<div class="item stack" id="auTestPanel"><div class="row"><b class="grow">' + esc(x.title) + '</b>' + TR.dot(x.status) + '<span class="sr">' + TR.CLS_LABEL[x.status] + '</span></div>' +
      '<div class="small muted">' + info.join(' · ') + '</div>' +
      (x.message ? '<div><div class="field-label">Message</div><pre class="trace">' + maskedHtml(x.message) + '</pre>' + (x.masked ? '<span class="small muted">A token or password was masked before it was saved.</span>' : '') + '</div>' : '') +
      (x.stack ? '<div><div class="field-label">Where</div><pre class="trace">' + maskedHtml(x.stack) + '</pre></div>' : '') +
      '<div class="row"><span class="small muted">Last ' + plural(list.length, 'run') + '</span>' + auHist(list) + (since ? '<span class="small muted">' + since + '</span>' : '') + '</div></div>';
  }

  /** Screen 5: Import results, attached to a workbook › test suite › test cycle. */
  function auImport(s) {
    var A = S.auto, f = A.file;
    var h = auHead(s, '<button class="ghost" data-action="au-back">Back</button>');
    h += '<section class="card card-pad stack"><div><h2>Import results</h2><p class="small muted">For a run done outside Test Run: on a host-server, another CI, or a GitHub run started there. JUnit XML or CTRF JSON; several files, or a .zip of them, make one run.</p></div>';
    var fromGh = !!s.workflowId && val('au:im:src', 'file') === 'github';
    if (s.workflowId) {
      h += '<span class="seg" role="group" aria-label="Where the results come from"><button data-action="au-im-src" data-src="file" aria-pressed="' + !fromGh + '">Results File</button>' +
        '<button data-action="au-im-src" data-src="github" aria-pressed="' + fromGh + '">GitHub Run</button></span>';
    }
    if (fromGh) {
      var ready2 = auAttachChosen('im') && val('au:gh:run', '') && !A.busy;
      h += auGhRunPicker(s) + auAttachPickers('im', true) + auFullWarning('im', s.id, '') +
        '<div class="row" style="justify-content:flex-end"><button class="ghost" data-action="au-back">Cancel</button><button class="primary" data-action="au-gh-import"' + (ready2 ? '' : ' disabled') + '>' + (A.busy ? 'Importing' : 'Import Results') + '</button></div></section>';
      return '<div class="stack">' + h + '</div>';
    }
    if (f) {
      var p = f.preview;
      h += '<div class="item row"><span class="file-chosen grow">' + (p ? '<span class="sym-pass" aria-hidden="true">✓</span>' : f.error ? '<span class="sym-fail" aria-hidden="true">✗</span>' : '') +
        '<span class="mono">' + esc(f.label) + '</span><span class="faint">' + fmtBytes(f.size) + '</span></span>' +
        (p ? '<span class="small">' + esc(p.formatLabel) + ' · <b>' + p.totals.total + '</b> tests · <span class="sym-pass">' + TR.SYM.pass + '</span> ' + p.totals.passed + ' <span class="sym-fail">' + TR.SYM.fail + '</span> ' + p.totals.failed + ' <span class="sym-other">' + TR.SYM.other + '</span> ' + p.totals.skipped + (p.tool ? ' · from ' + esc(p.tool) : '') + '</span>'
          : f.busy ? '<span class="small muted">Reading</span>' : '') +
        '<button class="link-btn danger" data-action="au-file-clear" aria-label="Remove ' + esc(f.label) + '">✕</button></div>';
      if (f.error) h += '<div class="bad-text small">' + esc(f.error) + '</div>';
      if (p && p.ignored && p.ignored.length) h += '<div class="note warn">Not results files, so left out: ' + esc(p.ignored.join(', ')) + '.</div>';
    } else {
      h += '<div class="drop" id="auDrop"><b>Drop the results file here</b><span class="small muted">or</span><button data-action="au-file">⤒ Choose Files</button></div>';
    }
    h += '<div class="form-grid">' +
      auField('auBranch', 'Branch <span class="faint">(optional)</span>', '<input id="auBranch" data-bind="au:branch" value="' + esc(val('au:branch', '')) + '">', 'Read from the file when it says') +
      auField('auEnv', 'Environment <span class="faint">(optional)</span>', '<input id="auEnv" data-bind="au:env" value="' + esc(val('au:env', '')) + '">') + '</div>';
    h += auAttachPickers('im', true) + auFullWarning('im', s.id, '');
    var ready = f && f.preview && auAttachChosen('im') && !A.busy;
    h += '<div class="row" style="justify-content:flex-end"><button class="ghost" data-action="au-back">Cancel</button><button class="primary" data-action="au-import-save"' + (ready ? '' : ' disabled') + '>' + (A.busy ? 'Importing' : 'Import Results') + '</button></div></section>';
    return '<div class="stack">' + h + '</div>';
  }

  /**
   * Link a suite (or change one), in a popup over the page it was opened from (Setup › Automation's
   * + Add, a suite's name there, or ✎ Edit on Automation): the repository checked on GitHub, its
   * workflow, results artifact and environment option, then a try. It is part of the page, so it
   * redraws with it; Escape, a click outside or Cancel closes it, dropping what was typed.
   */
  function auLinkPopup() {
    if (!S.auto.linkOpen || !S.auto.data) return '';
    return '<div class="modal sheet au-link-pop"><div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="auLinkTitle">' + auLinkForm() + '</div></div>';
  }
  function auLinkForm() {
    var A = S.auto, s = A.editing ? auSuite() : null, G = A.gh;
    var v = function (k, dflt) { return val('au:l:' + k, dflt == null ? '' : dflt); };
    var h = '<div class="stack"><div><h2 id="auLinkTitle">' + (s ? 'Edit “' + esc(s.name) + '”' : 'Link a suite') + '</h2><p class="small muted">Once per repository. The suite\'s workflow must write a JUnit XML or CTRF JSON results file and upload it as an artifact. <a href="' + AU_GUIDE + '" target="_blank" rel="noopener">How, for each framework ↗</a></p></div>';
    // 1 · Repository, checked on GitHub
    var c = G.check;
    h += '<div class="subsection"><div class="step-title"><span class="step-n">1</span>Repository</div><div class="row"><label class="sr" for="auRepo">Repository link</label>' +
      '<input id="auRepo" type="url" style="flex:1 1 360px" data-bind="au:l:repo" placeholder="https://github.com/owner/repo" value="' + esc(v('repo', s ? (s.repo ? 'https://github.com/' + s.repo : '') : '')) + '">' +
      '<button data-action="au-gh-check"' + (G.checking ? ' disabled' : '') + '>' + (G.checking ? 'Checking' : 'Check') + '</button></div>' +
      (G.checkError ? '<div class="check-line bad">' + esc(G.checkError) + '</div>'
        : c ? '<div class="check-line ok">✓ ' + esc(c.repo.fullName) + ' · ' + (c.repo.private ? 'private' : 'public') + ' · ' + plural(c.counts.total, 'workflow') + ', ' + c.counts.dispatch + ' you can start by hand</div>'
          : '<div class="small muted">Any repository Test Run\'s GitHub access can read. Check it to pick its workflow, so ▶ Run can start it; without that, results come in with ⤒ Import Results.</div>') + '</div>';
    // 2 · Name, workflow and results: greyed out under a spinner while GitHub is read
    var reading = G.checking || G.artsLoading;
    h += '<div class="subsection"><div class="step-title"><span class="step-n">2</span>' + (c ? 'Workflow and results' : 'Name') + '</div>' +
      '<div class="spin-wrap' + (reading ? ' busy' : '') + '"' + (reading ? ' aria-busy="true"' : '') + '><div class="form-grid' + (c ? '' : ' narrow') + '">' +
      auField('auName', 'Name in Test Run', '<input id="auName" data-bind="au:l:name" placeholder="e.g. CMS Automation" value="' + esc(v('name', s ? s.name : '')) + '">') +
      auField('au_l_books', 'Workbooks', dropdown({ bind: 'au:l:books', id: 'au_l_books', values: auLinkBooks(), title: 'Workbooks',
        options: S.app.books.map(function (b) { return { value: b.name, label: bookTitle(b.name) }; }) }), '', 'Its results show only in these workbooks.');
    var wf = c ? auLinkWorkflow() : null;
    if (c) {
      var can = c.workflows.filter(function (w) { return w.dispatch && w.active; });
      var notListed = c.workflows.filter(function (w) { return !(w.dispatch && w.active); }).map(function (w) { return w.name; });
      h += auField('au_l_wf', 'Workflow', dropdown({ bind: 'au:l:wf', id: 'au_l_wf', value: v('wf', ''), title: 'Workflow', placeholder: can.length ? 'Select' : 'None can be started by hand',
        disabled: !can.length, options: can.map(function (w) { return { value: String(w.id), label: w.name, hint: w.path.split('/').pop() }; }) }), '',
        'Only workflows you can start by hand (they have a Run workflow button on GitHub) are listed, since Test Run starts runs the same way.' + (notListed.length ? ' Not listed: ' + notListed.join(', ') + '.' : ''));
      var arts = G.arts && G.artsFor === v('wf', '') ? G.arts : null;
      var artOpts = arts ? arts.artifacts.map(function (a) { return { value: a.name, label: a.name, hint: a.results ? a.results.formatLabel + ' · ' + plural(a.results.tests, 'test') : a.note }; }) : [];
      var artHint = !wf ? 'Choose the workflow first.' : arts && arts.run ? 'Found in the latest run (' + auDate(arts.run.createdAt, false) + '). You can also type the name it will have.' : 'The file the workflow uploads its results in. With no finished run yet, type its name (test-results by default).';
      // help in the i; an error from GitHub stays in plain sight, in red
      h += auField('au_l_art', 'Results artifact', dropdown({ bind: 'au:l:art', id: 'au_l_art', value: v('art', ''), title: 'Results artifact', free: true, disabled: !wf || G.artsLoading, placeholder: G.artsLoading ? 'Loading' : 'Select', options: artOpts }),
        G.artsError ? '<span class="bad-text">' + esc(G.artsError) + '</span>' : '', artHint);
      var envOpts = [{ value: '', label: 'None' }].concat(wf ? wf.inputs.map(function (x) { return { value: x.name, label: x.name, hint: x.description }; }) : []);
      h += auField('au_l_env', 'Environment option <span class="faint">(optional)</span>', dropdown({ bind: 'au:l:env', id: 'au_l_env', value: v('env', ''), title: 'Environment option', disabled: !wf, options: envOpts }), '', 'Runs are grouped by it, and the run form names its GitHub environment.');
    }
    h += '</div>' + (reading ? '<div class="spin-overlay" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr">Reading the repository on GitHub</span></div>' : '') + '</div></div>';
    // 3 · Attach Workbook: where ⤒ Import Results (in the bottom row) puts the latest run's results
    var n = 3;
    if (wf) {
      h += '<div class="subsection"><div class="step-title"><span class="step-n">' + (n++) + '</span>Attach Workbook' + infoTip('auAttachTip', 'Attach Workbook', auAttachNote(S.auto.data.keep)) + '</div>' + auAttachPickers('lk', true, true) + '</div>';
    }
    // 4 · Extras
    h += '<div class="subsection"><div class="step-title"><span class="step-n">' + n + '</span>Extras <span class="faint small" style="font-weight:400">(optional)</span></div><div class="form-grid">' +
      auField('auPattern', 'Case-ID pattern', '<input id="auPattern" class="mono" data-bind="au:l:pattern" placeholder="e.g. CMS/\\d+" value="' + esc(v('pattern', s ? s.casePattern : '')) + '">', '', 'Finds manual case IDs in test titles or tags.') + '</div></div>';
    // the bottom row: De-link on the left; ⤒ Import Results, Cancel and Save on the right
    var im = G.imported;
    if (wf && im) h += '<div class="check-line ' + (im.ok ? 'ok' : 'bad') + '" style="margin:0">' + esc(im.text) + '</div>';
    h += '<div class="au-foot">' + (s && S.auto.data.isOwner ? '<button class="danger-outline" data-action="au-suite-remove">De-link</button>' : '') + '<span class="grow"></span>' +
      (wf ? '<button data-action="au-gh-import-latest" title="Saves, then brings in the latest finished run"' + (G.importing || !auAttachChosen('lk') ? ' disabled' : '') + '><span aria-hidden="true">⤒</span> ' + (G.importing ? 'Importing' : 'Import Results') + '</button>' : '') +
      '<button class="ghost" data-action="au-link-close">Cancel</button><button class="primary" data-action="au-link-save">Save</button></div></div>';
    return h;
  }

  /** The workbooks ticked in Link a suite (those still in Test Run). */
  function auLinkBooks() {
    var names = S.app.books.map(function (b) { return b.name; });
    return (S.form['au:l:books'] || []).filter(function (b) { return names.indexOf(b) >= 0; });
  }
  /** The workbooks a run of this form may attach to: those ticked in Link a suite, or the suite's own. */
  function auAllowedBooks(prefix) {
    var all = S.app.books.map(function (b) { return b.name; });
    if (prefix === 'lk') return auLinkBooks();
    var s = auSuite();
    return s && s.books ? all.filter(function (b) { return s.books.indexOf(b) >= 0; }) : all;
  }
  /** Closes the Link a suite popup, dropping what was typed in it. */
  function auLinkClose() {
    var A = S.auto;
    A.linkOpen = false; A.editing = false; A.gh = auGhFresh();
    clearForm('au:l:'); clearForm('au:lk:');
    S.ddOpen = null; S.ddQ = '';
    render();
  }
  /** Focus inside the popup: the repository link, or Save when it is already filled in. */
  function auLinkFocus() {
    var f = $('auRepo');
    if (f && !f.value) f.focus();
    else { var b = document.querySelector('.au-link-pop button.primary'); if (b) b.focus(); }
  }
  function auGhFresh() { return { check: null, checking: false, checkError: '', arts: null, artsFor: '', artsLoading: false, artsError: '', importing: false, imported: null }; }
  var AU_GUIDE = 'https://github.com/Gurjeet-eGov/Claude-Extensions/blob/master/test-run-console/docs/automation.md';
  var AU_CONNECT_GUIDE = 'https://github.com/Gurjeet-eGov/Claude-Extensions/blob/master/test-run-console/docs/connect-a-suite.md';
  /** The workflow chosen on Link a suite (from the check), or null. */
  function auLinkWorkflow() {
    var c = S.auto.gh.check, id = val('au:l:wf', '');
    return c && id ? c.workflows.filter(function (w) { return String(w.id) === id; })[0] || null : null;
  }
  function auRepoTyped() {
    var s = S.auto.editing ? auSuite() : null;
    return String(val('au:l:repo', s && s.repo ? 'https://github.com/' + s.repo : '')).trim();
  }
  /** Check: the repository and its workflows, read from GitHub. */
  function auGhCheck() {
    var A = S.auto, G = A.gh, s = A.editing ? auSuite() : null;
    var repo = auRepoTyped();
    if (!repo) { toast('Paste the suite\'s GitHub repository link first.', 'bad'); return; }
    G.checking = true; G.checkError = ''; G.check = null; G.arts = null; G.artsFor = ''; G.imported = null;
    render();
    TR.http('POST', '/api/automation/github/check', { repo: repo, id: s ? s.id : '' }).then(function (r) {
      G.checking = false;
      if (!r.ok) { G.checkError = r.error; render(); return; }
      G.check = r;
      var can = r.workflows.filter(function (w) { return w.dispatch && w.active; });
      var keepWf = val('au:l:wf', s && s.workflowId ? String(s.workflowId) : '');
      if (!can.some(function (w) { return String(w.id) === keepWf; })) keepWf = can.length === 1 ? String(can[0].id) : '';
      if (S.form['au:l:art'] == null && s && s.artifact) S.form['au:l:art'] = s.artifact;
      if (S.form['au:l:env'] == null && s) S.form['au:l:env'] = s.envInput || '';
      S.form['au:l:wf'] = keepWf;
      if (keepWf) auWorkflowPicked(); else render();
    });
  }
  /** A workflow chosen: its options for the environment, and the latest run's artifacts (which hold results). */
  function auWorkflowPicked() {
    var A = S.auto, G = A.gh, wf = auLinkWorkflow(), s = A.editing ? auSuite() : null;
    if (!wf) return;
    if (val('au:l:env', '') && !wf.inputs.some(function (x) { return x.name === val('au:l:env', ''); })) S.form['au:l:env'] = '';
    if (!S.form['au:l:env'] && S.form['au:l:env'] !== '' ) {
      var guess = wf.inputs.filter(function (x) { return x.type === 'environment' || /^(env|environment|target|stage)$/i.test(x.name); })[0];
      S.form['au:l:env'] = guess ? guess.name : '';
    }
    var id = String(wf.id);
    if (G.artsFor === id && (G.arts || G.artsLoading)) return;
    G.artsFor = id; G.arts = null; G.artsError = ''; G.artsLoading = true;
    if (!S.form['au:lk:book']) {
      var names = auLinkBooks(); // Try it attaches to one of the suite's workbooks
      S.form['au:lk:book'] = names.indexOf(book()) >= 0 ? book() : names[0] || '';
      auTargets(S.form['au:lk:book'], function () { auDefaults('lk'); });
    }
    TR.http('POST', '/api/automation/github/artifacts', { repo: auRepoTyped(), workflowId: wf.id, id: s ? s.id : '' }).then(function (r) {
      if (G.artsFor !== id) return;
      G.artsLoading = false;
      if (!r.ok) { G.artsError = r.error; render(); return; }
      G.arts = r;
      if (!val('au:l:art', '')) {
        var hit = r.artifacts.filter(function (a) { return a.results; })[0];
        S.form['au:l:art'] = hit ? hit.name : r.artifacts.some(function (a) { return a.name === 'test-results'; }) || !r.artifacts.length ? 'test-results' : '';
      }
      render();
    });
    render();
  }
  /** What Link a suite sends: its fields, and (once checked) its workflow. */
  function auLinkBody() {
    var s = S.auto.editing ? auSuite() : null, wf = S.auto.gh.check ? auLinkWorkflow() : null;
    return {
      id: s ? s.id : '',
      name: String(val('au:l:name', s ? s.name : '')).trim(),
      repo: auRepoTyped(),
      casePattern: String(val('au:l:pattern', s ? s.casePattern : '')).trim(),
      masking: String(val('au:l:mask', s ? s.masking.join('\n') : '')),
      books: auLinkBooks(),
      workflowId: wf ? wf.id : 0,
      artifact: String(val('au:l:art', '')).trim(),
      envInput: val('au:l:env', '')
    };
  }

  // ---------------------------------------------------------------------------
  // Automation › GitHub Actions: runs going, the Run form, the Running view
  // ---------------------------------------------------------------------------

  var AU_ACTIVE = { waiting: true, queued: true, in_progress: true, importing: true };
  function auActiveJobs() { return (S.auto.jobs || []).filter(function (j) { return AU_ACTIVE[j.state]; }); }
  function auJob(id) { return (S.auto.jobs || []).filter(function (j) { return j.id === id; })[0] || null; }

  /** The runs going (and those finished lately) this person may see; read again every few seconds while one is going. */
  function auJobsLoad() {
    var A = S.auto;
    if (A.jobsBusy || S.connect || S.reportsMode) return;
    A.jobsBusy = true;
    TR.http('GET', '/api/automation/jobs').then(function (r) {
      A.jobsBusy = false;
      var before = A.jobs || [];
      if (!r.ok) { if (A.jobs === null) A.jobs = []; return; }
      var same = JSON.stringify(before) === JSON.stringify(r.jobs);
      A.jobs = r.jobs;
      auJobsFinished(before, r.jobs);
      clearTimeout(A.jobsTimer);
      if (auActiveJobs().length) A.jobsTimer = setTimeout(auJobsLoad, 3000);
      if (!same) render();
    });
  }

  /**
   * Runs that finished since the last look: whoever started one, or has its suite open, hears of it, and the
   * Runs table is read again (the new run shows there). One GitHub never showed: "Unable to find the GitHub job".
   */
  function auJobsFinished(before, after) {
    var A = S.auto, was = {};
    before.forEach(function (j) { was[j.id] = j.state; });
    after.forEach(function (j) {
      if (!AU_ACTIVE[was[j.id]] || AU_ACTIVE[j.state]) return;
      var here = S.view === 'automation' && auJobHere(j) && A.suite === j.suiteId;
      if (here || j.by === me().name) {
        if (j.state === 'imported') toast('Imported ' + (j.totals ? plural(j.totals.total, 'test') : 'the results') + ' from ' + j.suiteName + '.' + auRemovedText(j.removed, A.data ? A.data.keep : 2));
        else if (j.notFound) toast('Unable to find the GitHub job', 'bad');
        else if (j.state !== 'cancelled') toast('The run of “' + j.suiteName + '” ended without results. Automation says why.', 'bad');
      }
      if (S.view === 'automation') auLoad();
    });
  }

  /**
   * On a suite's page: its runs going in GitHub Actions, each with the time so far, ↗ GitHub Log (greyed out
   * until GitHub has given the run's address) and Cancel Run; and finished ones that brought nothing in.
   */
  function auJobsCard(s) {
    var list = (S.auto.jobs || []).filter(function (j) { return j.suiteId === s.id && j.state !== 'imported' && auJobHere(j); });
    if (!list.length) return '';
    var can = S.auto.data && S.auto.data.canAct;
    return '<section class="card card-pad stack"><h2>In GitHub Actions</h2>' + list.map(function (j) {
      var active = AU_ACTIVE[j.state];
      var since = Date.parse(j.startedAt) || j.dispatchedAt;
      var log = '<button class="small-btn" data-action="au-gh-log" data-id="' + esc(j.id) + '"' + (j.runUrl ? '' : ' disabled') + '>↗ GitHub Log</button>';
      return '<div class="item row job-line">' + auJobDot(j) + '<span class="grow"><b>' + esc(auJobTitle(j)) + '</b><div class="small muted">' + esc(auJobMeta(j)) +
        (active ? ' · Elapsed time <b class="au-elapsed" data-since="' + since + '">' + auClock(Date.now() - since) + '</b>' : '') + '</div>' +
        (active && j.lastError ? '<div class="small muted">' + esc(j.lastError) + ' Trying again.</div>' : '') +
        (!active && j.message ? '<div class="small bad-text">' + esc(j.message) + '</div>' : '') + '</span>' +
        '<span class="job-actions">' + (active
          ? log + (can && j.state !== 'importing' ? '<button class="small-btn danger-outline" data-action="au-job-cancel" data-id="' + esc(j.id) + '"' + (j.cancelWanted ? ' disabled' : '') + '>' + (j.cancelWanted ? 'Cancelling…' : 'Cancel Run') + '</button>' : '')
          : (j.runUrl ? log : '') + '<button class="small-btn" data-action="au-job-dismiss" data-id="' + esc(j.id) + '">Dismiss</button>') + '</span></div>';
    }).join('') + '</section>';
  }

  function auJobTitle(j) {
    return { waiting: 'Starting in GitHub Actions', queued: 'Queued in GitHub Actions', in_progress: 'Running in GitHub Actions', importing: 'Bringing the results in',
      imported: 'Results imported', no_results: 'Finished without results', cancelled: 'Cancelled', failed: 'The results did not come in' }[j.state] || 'In GitHub Actions';
  }
  /** A run (or step) under way in GitHub Actions: a yellow circle fading in and out (DESIGN.md › Status). */
  var AU_GOING = '<span class="dot going" aria-hidden="true"></span>';
  function auJobDot(j) {
    if (AU_ACTIVE[j.state]) return AU_GOING + '<span class="sr">Going.</span>';
    var c = j.state === 'imported' ? 'pass' : j.state === 'cancelled' ? 'other' : 'fail';
    return TR.dot(c) + '<span class="sr">' + TR.CLS_LABEL[c] + '.</span>';
  }
  /** "master @ 9629653 · net_two · smoke · started by Gurjeet from Test Run at 10:23" */
  function auJobMeta(j) {
    var d = new Date(j.dispatchedAt);
    var opts = Object.keys(j.inputs || {}).filter(function (k) { return k !== auEnvInput(j.suiteId) && j.inputs[k] && j.inputs[k] !== 'false'; })
      .map(function (k) { return j.inputs[k] === 'true' ? k : j.inputs[k]; });
    return [j.branch + (j.sha ? ' @ ' + j.sha.slice(0, 7) : ''), j.env].concat(opts).filter(Boolean).join(' · ') +
      ' · started by ' + j.by + ' from Test Run at ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + (j.runNumber ? ' · run #' + j.runNumber : '');
  }
  function auEnvInput(suiteId) { var s = auSuite(suiteId); return s ? s.envInput : ''; }
  /** "06:42", "1:02:05" */
  function auClock(ms) {
    var t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(sec);
  }
  /** The Run form's branches (and the repository's environments), read once per form; then the chosen branch's fields. */
  function auRunFormLoad(s) {
    var A = S.auto;
    A.runForm = { suite: s.id, loading: true };
    TR.http('GET', '/api/automation/github/branches?suite=' + enc(s.id)).then(function (r) {
      if (!A.runForm || A.runForm.suite !== s.id) return;
      if (!r.ok) { A.runForm = { suite: s.id, error: r.error }; render(); return; }
      A.runForm = { suite: s.id, branches: r.branches, environments: r.environments || [], defaultBranch: r.defaultBranch };
      if (!S.form['au:rn:branch']) S.form['au:rn:branch'] = r.defaultBranch || (r.branches[0] && r.branches[0].name) || '';
      auRunFieldsLoad(s, S.form['au:rn:branch']);
      render();
    });
  }
  /**
   * The run form's fields on a branch, from that branch's own workflow file (each branch can have its
   * own form, and GitHub refuses fields the branch doesn't have). What was typed for a field the branch
   * still has is kept; a choice it no longer offers goes back to the default.
   */
  function auRunFieldsLoad(s, branch) {
    var A = S.auto, rf = A.runForm;
    if (!rf || rf.suite !== s.id || !branch) return;
    rf.fields = { branch: branch, loading: true };
    TR.http('GET', '/api/automation/github/form?suite=' + enc(s.id) + '&branch=' + enc(branch)).then(function (r) {
      var now = A.runForm;
      if (!now || now.suite !== s.id || !now.fields || now.fields.branch !== branch) return; // another branch was picked meanwhile
      if (!r.ok) { now.fields = { branch: branch, inputs: s.inputs || [], environments: now.environments || [], error: r.error, dispatch: true }; render(); return; }
      now.fields = { branch: branch, inputs: r.inputs, environments: r.environments || [], noEnvironments: !!r.noEnvironments, note: r.note || '', from: r.from, dispatch: r.dispatch !== false };
      r.inputs.forEach(function (d) {
        var k = 'au:in:' + d.name, v = S.form[k];
        if (v == null) return;
        var drop = d.type === 'boolean' ? typeof v !== 'boolean'
          : typeof v === 'boolean' || (d.type === 'choice' && d.options.indexOf(String(v)) < 0) || (d.type === 'environment' && r.environments.length && r.environments.indexOf(String(v)) < 0);
        if (drop) delete S.form[k];
      });
      if (r.refreshed) { var kept = auSuite(s.id); if (kept) { kept.inputs = r.inputs; kept.envInput = r.envInput; } } // the default branch's form changed: the saved copy was refreshed
      render();
    });
  }
  /** The fields of the run form for the branch chosen: null while they are being read. */
  function auRunFields(s) {
    var rf = S.auto.runForm, b = val('au:rn:branch', '');
    var f = rf && rf.suite === s.id && rf.fields && rf.fields.branch === b ? rf.fields : null;
    return f && f.inputs ? f : null;
  }
  /** An input's value on the Run form: what was typed or picked, else its default. */
  function auInputVal(d) {
    var k = 'au:in:' + d.name;
    if (d.type === 'boolean') return Object.prototype.hasOwnProperty.call(S.form, k) ? !!S.form[k] : d.default === 'true';
    return String(val(k, d.default));
  }

  /** Screen 2: Start a run: branch, the workflow's own options (on that branch), and where its results attach. */
  function auStart(s) {
    var A = S.auto, rf = A.runForm && A.runForm.suite === s.id ? A.runForm : null;
    var fl = auRunFields(s), defs = fl ? fl.inputs : [];
    var branch = val('au:rn:branch', '');
    var h = auHead(s, '<button class="ghost" data-action="au-back">Back</button>');
    h += '<section class="card card-pad stack"><div><h2>Start a run</h2><p class="small muted">Runs the workflow <b>' + esc(s.workflow || 'workflow') + '</b> in GitHub Actions, in ' + esc(s.repo) + '. The options below come from that workflow, as it is on the branch you choose.</p></div>';
    if (rf && rf.error) h += '<div class="note bad">' + esc(rf.error) + '</div>';
    if (fl && fl.error) h += '<div class="note warn">' + esc(fl.error) + ' The options below are the ones saved when the suite was linked.</div>';
    if (fl && fl.note) h += '<div class="note warn">' + esc(fl.note) + '</div>';
    var branches = rf && rf.branches ? rf.branches : null;
    h += '<div class="form-grid run-inputs">' + auField('au_rn_branch', 'Branch', dropdown({ bind: 'au:rn:branch', id: 'au_rn_branch', value: branch, title: 'Branch', disabled: !branches || !!(rf && rf.loading), change: 'au-run-branch',
      placeholder: rf && rf.loading ? 'Loading' : 'Select', options: (branches || []).map(function (b) { return { value: b.name, label: b.name, hint: b.default ? 'default' : '' }; }) }));
    if (!fl && branch) h += '<p class="small muted wide">Reading the run form on ' + esc(branch) + '</p>';
    defs.forEach(function (d) {
      var id = 'au_in_' + d.name.replace(/\W/g, '_'), bind = 'au:in:' + d.name, hint = esc(d.description);
      var opt = !d.required && (d.type === 'string' || d.type === 'number') ? ' <span class="faint">(optional)</span>' : '';
      if (d.type === 'boolean') {
        h += '<div><label class="note-label" for="' + id + '">' + esc(d.name) + '</label><label class="check"><input type="checkbox" id="' + id + '" data-bind="' + esc(bind) + '"' + (auInputVal(d) ? ' checked' : '') + '> ' + (hint || 'On') + '</label></div>';
        return;
      }
      var envs = d.type === 'environment' ? fl.environments || [] : [];
      var control = d.type === 'choice' || envs.length
        ? dropdown({ bind: bind, id: id, value: auInputVal(d), title: d.name, options: d.type === 'choice' ? d.options : envs })
        : '<input id="' + id + '" data-bind="' + esc(bind) + '"' + (d.type === 'number' ? ' inputmode="decimal"' : '') + ' value="' + esc(auInputVal(d)) + '">';
      // an environment field, but no GitHub environment to pick (after the host's exclusions): how to add one
      if (d.type === 'environment' && fl.noEnvironments) {
        hint = '<span class="no-envs">This repository has no GitHub environments yet. <a href="' + esc(AU_CONNECT_GUIDE) + '" target="_blank" rel="noopener">How to add one ↗</a></span>';
      }
      h += auField(id, esc(d.name) + opt, control, hint);
    });
    h += '</div>' + auAttachPickers('rn', true) + auFullWarning('rn', s.id, '');
    var envDef = defs.filter(function (x) { return x.name === s.envInput; })[0] || defs.filter(function (x) { return x.type === 'environment'; })[0];
    var envName = envDef ? auInputVal(envDef) : '';
    var ready = branch && fl && fl.dispatch !== false && auAttachChosen('rn') && !A.starting;
    h += '<div class="row"><span class="small muted secrets-note">' + (envName ? 'Secrets come from the repository\'s GitHub environment <span class="mono">' + esc(envName) + '</span>; nothing to upload.' : 'Secrets come from the repository\'s GitHub settings; nothing to upload.') + '</span>' +
      '<button class="ghost" data-action="au-back">Cancel</button><button class="primary" data-action="au-run-start"' + (ready ? '' : ' disabled') + '>' + (A.starting ? 'Starting' : 'Start Run') + '</button></div></section>';
    return '<div class="stack">' + h + '</div>';
  }

  /** Import results › GitHub run: a finished run of the suite's workflow, picked from the latest ones. */
  function auGhRunPicker(s) {
    var A = S.auto;
    if (A.ghRunsFor !== s.id && !A.ghRunsLoading) {
      A.ghRunsLoading = true; A.ghRunsFor = s.id; A.ghRuns = null;
      TR.http('GET', '/api/automation/github/runs?suite=' + enc(s.id)).then(function (r) {
        A.ghRunsLoading = false;
        A.ghRuns = r.ok ? r.runs : { error: r.error };
        if (r.ok && !val('au:gh:run', '')) { var first = r.runs.filter(function (x) { return !x.kept; })[0]; if (first) S.form['au:gh:run'] = String(first.id); }
        render();
      });
    }
    var list = A.ghRuns;
    if (list && list.error) return '<div class="note bad">' + esc(list.error) + '</div>';
    var word = { success: 'passed', failure: 'failed', cancelled: 'cancelled', timed_out: 'timed out', skipped: 'skipped' };
    return auField('au_gh_run', 'GitHub run', dropdown({ bind: 'au:gh:run', id: 'au_gh_run', cls: 'cover-dd', value: val('au:gh:run', ''), title: 'GitHub run', disabled: !list || !list.length,
      placeholder: !list ? 'Loading' : list.length ? 'Select' : 'No finished runs yet',
      options: (list || []).map(function (x) {
        return { value: String(x.id), label: '#' + x.number + ' · ' + x.branch + ' · ' + auDate(x.createdAt) + ' · ' + (x.event === 'workflow_dispatch' ? 'started by hand' : x.event),
          hint: (word[x.conclusion] || x.conclusion || '') + (x.kept ? ' · already in Test Run' : '') };
      }) }), 'Finished runs of “' + esc(s.workflow) + '”, newest first. Its results artifact is read from GitHub.');
  }

  // ---------------------------------------------------------------------------
  // Setup › Automation (the host only)
  // ---------------------------------------------------------------------------

  function auSetupCard() {
    var A = S.auto;
    if (!A.data) { if (!A.loading && !A.error) auLoad(); return A.error ? '<div class="banner bad">' + esc(A.error) + '</div>' : '<div class="loading">Loading the automation settings</div>'; }
    if (!A.setupGh && !A.setupGhLoading) {
      A.setupGhLoading = true;
      TR.http('GET', '/api/automation/github/status').then(function (r) { A.setupGhLoading = false; A.setupGh = r; render(); });
    }
    var g = A.setupGh;
    var via = g && (g.transport === 'gh' ? 'gh' : g.transport === 'fetch' ? 'a GitHub token' : g.transport === 'fake' ? 'a pretend GitHub (demo)' : 'GitHub');
    var access = !g ? '<span class="small muted">Checking</span>'
      : g.ok ? '<span class="check-line ok" style="margin:0">✓ ' + esc(via) + ', signed in as ' + esc(g.login || 'unknown') + '</span>'
        : '<span class="check-line bad" style="margin:0">' + esc(g.error) + '</span>';
    var keep = A.data.keep;
    var keeps = ['1', '2', '3', '5'];
    if (keeps.indexOf(String(keep)) < 0) keeps.push(String(keep));
    var suites = A.data.suites;
    var h = '<section class="card card-pad stack"><div><h2>Automation</h2><p class="small muted">Suites run in their own repositories\' GitHub Actions. Test Run keeps their results; GitHub keeps the full reports. Who can see and run them is in <button class="linkish" data-action="setup-part" data-part="access">Access › Users</button>.</p></div><div class="kv-grid kv-wide">' +
      '<span class="kv-k">GitHub access</span><span class="stack-s">' + access + (g && !g.ok ? '<span class="small muted">On this host-server, run <span class="mono">gh auth login</span>, then open this page again.</span>' : '') + '</span>' +
      '<span class="kv-k kv-label"><label for="auKeep">Runs kept</label>' + infoTip('auKeepTip', 'Runs kept', 'For each test suite and cycle. The oldest goes when a new one comes in.') + '</span>' +
      '<span>' + dropdown({ bind: 'set:au:keep', id: 'auKeep', cls: 'keep-dd', change: 'au-keep', value: String(keep), title: 'Runs kept', options: keeps }) + '</span>' +
      '<span class="kv-k kv-label"><label for="auEvery">Check running runs every</label>' + infoTip('auEveryTip', 'Check running runs every', 'How often Test Run asks GitHub how a run is doing. 1 minute uses five times more of GitHub\'s 5,000 requests an hour.') + '</span>' +
      '<span>' + dropdown({ bind: 'set:au:every', id: 'auEvery', cls: 'every-dd', change: 'au-check-every', value: String(A.data.checkEvery || 5), title: 'Check running runs every',
        options: [{ value: '5', label: '5 minutes', hint: 'default' }, { value: '1', label: '1 minute', hint: 'while debugging' }] }) + '</span>' +
      auExcludeField() +
      '</div></section>';
    // + Add sits at the right of the card's title, whether or not suites are linked yet; ✎ Edit on a row opens it to change
    h += '<section class="card"><div class="card-pad card-title-row"><h2>Linked suites</h2><button data-action="au-link">+ Add</button></div><div class="table-wrap"><table><thead><tr><th>Suite</th><th>Workbooks</th><th>Repository</th><th>Results</th><th>Linked</th><th><span class="sr">Actions</span></th></tr></thead><tbody>' +
      (suites.length ? suites.map(function (s) {
        var res = (s.format ? A.data.formats[s.format] || s.format : s.workflowId ? 'Not read yet' : 'Imported files') + (s.workflowId && s.artifact ? ' in <span class="mono">' + esc(s.artifact) + '</span>' : '');
        return '<tr><td><b>' + esc(s.name) + '</b>' + (s.workflow ? '<div class="small muted">workflow ' + esc(s.workflow) + '</div>' : '') + '</td>' +
          '<td class="small">' + (s.books ? (s.books.length ? s.books.map(function (b) { return esc(bookTitle(b)); }).join('<br>') : '<span class="faint">None</span>') : '<span class="muted">All workbooks</span>') + '</td><td class="mono">' + (s.repo ? esc(s.repo) : '<span class="faint">–</span>') + '</td><td>' + res + '</td>' +
          '<td class="small muted">' + esc([s.linkedBy, s.linkedAt ? auDate(s.linkedAt, false) : ''].filter(Boolean).join(' · ') || '–') + '</td>' +
          '<td class="num"><span class="row-actions"><button class="small-btn" data-action="au-edit" data-id="' + esc(s.id) + '" title="Change “' + esc(s.name) + '”"><span aria-hidden="true">✎</span> Edit</button>' +
          '<button class="small-btn danger" data-action="au-setup-remove" data-id="' + esc(s.id) + '">De-link</button></span></td></tr>';
      }).join('') : '<tr><td colspan="6" class="no-data">No suites linked yet. + Add links one: any framework whose workflow writes JUnit XML or CTRF JSON.</td></tr>') + '</tbody></table></div></section>';
    return '<div class="stack">' + h + '</div>';
  }

  /**
   * Setup › Automation › Exclude environments: GitHub environments the run form leaves out (a name
   * typed, then Enter; ✕ on a tag removes it). Each change is saved at once.
   */
  function auExcludeField() {
    var list = (S.auto.data && S.auto.data.excludeEnvironments) || [];
    return '<span class="kv-k kv-label kv-top"><label for="auExclude">Exclude environments</label>' +
      infoTip('auExcludeTip', 'Exclude environments', 'Left out of the run form\'s environment list. GitHub makes github-pages by itself when Pages is switched on; no tests run there.') + '</span><span class="stack-s">' +
      '<input id="auExclude" class="exclude-input" data-bind="set:au:exclude" autocomplete="off" maxlength="100" placeholder="Type name and press Enter" value="' + esc(val('set:au:exclude', '')) + '">' +
      (list.length ? '<div class="filter-tags">' + list.map(function (n) {
        return '<span class="filter-tag mono">' + esc(n) + '<button type="button" data-action="au-exclude-remove" data-value="' + esc(n) + '" aria-label="Remove ' + esc(n) + '" title="Remove ' + esc(n) + '">✕</button></span>';
      }).join('') + '</div>' : '') + '</span>';
  }
  /**
   * Save the environments to exclude, and say so (or why not). The list changes on the page at once
   * and the field empties for the next name; saves go one after another, so quick changes all count.
   */
  var auExcludeQueue = null;
  function auExcludeSave(list) {
    var A = S.auto, before = (A.data && A.data.excludeEnvironments) || [];
    if (A.data) A.data.excludeEnvironments = list;
    delete S.form['set:au:exclude'];
    render();
    var f = $('auExclude');
    if (f) f.focus();
    var send = function () {
      return TR.http('POST', '/api/automation/settings', { excludeEnvironments: list }).then(function (r) {
        var latest = A.data && A.data.excludeEnvironments === list; // nothing changed on the page since
        if (!r.ok) { if (latest) A.data.excludeEnvironments = before; toast(r.error, 'bad'); render(); return; }
        if (latest) A.data.excludeEnvironments = r.excludeEnvironments;
        toast(r.excludeEnvironments.length ? 'Saved. The run form leaves out ' + r.excludeEnvironments.join(', ') + '.' : 'Saved. The run form lists every environment.');
      });
    };
    auExcludeQueue = auExcludeQueue ? auExcludeQueue.then(send, send) : send();
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
        toast('Copying was blocked: copy the link shown under Users.', 'bad');
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
      else { S.teamLink = { name: 'your admin link', link: r.link, warn: r.linkWarning }; toast('Copying was blocked: copy the link shown under Users.', 'bad'); }
      render();
    });
  }

  function checkLine(c, okText) {
    if (!c) return '';
    return '<div class="check-line ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '✓ ' + esc(okText || c.message) : '✗ ' + esc(c.message)) + ' <span class="faint">(' + esc(c.at) + ')</span></div>';
  }

  /** Setup › Access › Online access: whether the team can reach this laptop, and how. */
  function onlineCard() {
    if (!isOwner()) return '';
    var r = S.team;
    var h = '<section class="section card card-pad stack team-card" id="online">';
    var head = function (on) {
      return '<div class="row team-head"><div class="grow"><h2>Online access</h2><p class="small muted">Testers and managers open Test Run in their own browser with an invite link; nothing to install. This host-server must stay on while they work.</p></div>' +
        (on == null ? '' : '<label class="check team-switch"><input type="checkbox" data-action="team-enable"' + (on ? ' checked' : '') + '> Share online</label>') + '</div>';
    };
    if (!r) { loadTeam(); return h + head(null) + '<div class="loading">Loading</div></section>'; }
    var t = r.team;
    var a = r.address;
    h += head(t.enabled);
    if (!t.enabled) return h + '<p class="small faint">Off: only this computer can open Test Run.</p></section>';

    // Online link: how the team reaches this laptop
    h += '<div class="team-block"><h3>Online link</h3>';
    h += '<div class="way-choice" role="radiogroup" aria-label="Way in">' +
      '<label class="way' + (t.mode === 'quick' ? ' on' : '') + '"><input type="radio" name="teamMode" data-action="team-mode" value="quick"' + (t.mode === 'quick' ? ' checked' : '') + '><span><b>Quick tunnel</b><span class="small muted">Free, no account. A new address each time it starts.</span></span></label>' +
      '<label class="way' + (t.mode === 'fixed' ? ' on' : '') + '"><input type="radio" name="teamMode" data-action="team-mode" value="fixed"' + (t.mode === 'fixed' ? ' checked' : '') + '><span><b>Fixed address</b> <span class="pill accent">best for a team</span><span class="small muted">Never changes. A one-time setup (Tailscale or Cloudflare).</span></span></label></div>';

    if (t.mode === 'quick') {
      if (a.tunnel.running || a.tunnel.reconnectIn != null) {
        h += '<div class="row conn-status"><span class="pill ' + (a.tunnel.url ? 'pass' : 'other') + '">' + (a.tunnel.url ? 'Shared' : a.tunnel.reconnectIn != null ? 'Reconnecting' : 'Starting') + '</span>' +
          '<span class="mono grow">' + esc(a.tunnel.url || (a.tunnel.reconnectIn != null ? 'trying again in ' + a.tunnel.reconnectIn + ' s' : 'opening the tunnel')) + '</span><button data-action="team-share" data-on="0">Stop Sharing</button></div>';
      } else if (a.tunnel.available) {
        h += '<div class="row conn-status"><button class="primary" data-action="team-share" data-on="1">Start Sharing Over the Internet</button><span class="small muted">Opens a Cloudflare quick tunnel to this host-server.</span></div>';
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
        '<p class="small muted">Invite links open the console on GitHub Pages (the hosted page), which looks up this host-server’s current address in a secret GitHub gist. If the tunnel drops (sleep, Wi-Fi change), Test Run opens it again by itself and updates the gist.</p>' +
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
          ? '<div class="row conn-status"><span class="pill ' + (a.tunnel.url ? 'pass' : 'other') + '">' + (a.tunnel.url ? 'Tunnel running' : 'Reconnecting') + '</span><span class="mono grow">' + esc(t.tunnelName) + '</span><button data-action="team-share" data-on="0">Stop the Tunnel</button></div>'
          : '<div class="row"><button class="primary" data-action="team-share" data-on="1"' + (a.tunnel.available ? '' : ' disabled') + '>Start Tunnel ' + esc(t.tunnelName) + '</button></div>';
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
        ? '<button data-action="admin-copy"' + (ad.canCopy ? aoff : ' disabled') + '>Copy Link</button><button class="ghost" data-action="admin-new"' + aoff + ' title="Make a new admin link; the old one stops working">New Link</button><button class="ghost danger" data-action="admin-remove">Remove</button>' +
          '<span class="small faint">' + (ad.lastSeen ? 'Last used ' + esc(ad.lastSeen) : 'Not used yet') + '</span>'
        : '<button data-action="admin-new"' + aoff + '>Make My Admin Link</button>') + '</div>' +
      (r.canInvite ? '' : '<p class="small faint">Links need an address first: ' + (t.mode === 'quick' ? 'start sharing above.' : 'enter your fixed address above.') + '</p>') + '</div>';

    return h + '</section>';
  }

  var ROLE_OPTIONS = [{ value: 'tester', label: 'Update status' }, { value: 'viewer', label: 'View only' }];

  /** "today", "yesterday" or "20 Nov" (with the year when it isn't this one), from "2026-11-24 10:23". */
  function seenWhen(stamp) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp || ''));
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var days = Math.round((today - d) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + (d.getFullYear() === today.getFullYear() ? '' : ' ' + d.getFullYear());
  }

  /** A person's Automated suites as one choice: 'all', 'none', 's:<id>', or 'multi' (several, set elsewhere). Suites unlinked since are left out. */
  function suitesChoice(p, names) {
    var s = p.automationSuites;
    if (s === 'none') return { value: 'none', ids: [] };
    if (!Array.isArray(s)) return { value: 'all', ids: [] };
    var ids = s.filter(function (id) { return names[id] != null; });
    return { value: !ids.length ? 'none' : ids.length === 1 ? 's:' + ids[0] : 'multi', ids: ids };
  }

  /** Setup › Access › Users: each person's invite link, what they can open, and what they can do with automation. */
  function usersCard() {
    if (!isOwner() || !S.team) return '';
    var r = S.team;
    var t = r.team;
    var canAdd = t.enabled && r.canInvite;
    var why = !t.enabled ? 'Turn on Share online above to make links.' : 'Links need an address first: ' + (t.mode === 'quick' ? 'start sharing above.' : 'enter your fixed address above.');
    var h = '<section class="section card card-pad stack" id="users"><div><h2>Users</h2><p class="small muted">Each person\'s invite link, what they can open, and what they can do with automation.</p></div>';
    if (!t.enabled && r.people.length) h += '<div class="note info">Share online is off, so these links do not open Test Run until it is on again.</div>';
    if (S.teamLink) {
      h += '<div class="note info stack-s"><span>This browser did not let Test Run copy the link for <b>' + esc(S.teamLink.name) + '</b>. Copy it from here and send it to them privately.</span>' +
        '<div class="row"><input id="teamLink" readonly value="' + esc(S.teamLink.link) + '" class="grow mono"><button class="primary" data-action="copy-link">Copy</button><button class="ghost" data-action="hide-link">Done</button></div>' +
        (S.teamLink.warn ? '<span class="small">' + esc(S.teamLink.warn) + '</span>' : '') + '</div>';
    }
    var books = (S.app && S.app.books || []).map(function (b) { return b.name; });
    var suites = r.suites || [];
    var names = {};
    suites.forEach(function (x) { names[x.id] = x.name; });
    if (r.people.length) {
      h += '<div class="table-wrap"><table class="people"><thead><tr><th>Name</th><th>Access</th><th>Workbooks</th><th>Automated suites</th><th>Start runs</th><th></th></tr></thead><tbody>' + r.people.map(function (p) {
        var viewer = p.role === 'viewer';
        var book = p.books && p.books.length ? p.books[0] : '';
        var bookOpts = [{ value: 'all', label: 'All workbooks' }].concat(books.map(function (n) { return { value: n, label: n.replace(/\.xlsx$/i, '') }; }),
          book && books.indexOf(book) < 0 ? [{ value: book, label: book.replace(/\.xlsx$/i, '') + ' (deleted)' }] : []);
        var sc = suitesChoice(p, names);
        var suiteOpts = [{ value: 'all', label: 'All suites' }].concat(
          sc.value === 'multi' ? [{ value: 'multi', label: sc.ids.map(function (id) { return names[id]; }).join(', ') }] : [],
          suites.map(function (x) { return { value: 's:' + x.id, label: x.name }; }),
          [{ value: 'none', label: 'None', hint: 'no automated results' }]);
        var copyTip = !p.canCopy ? 'This link was made before links could be copied again: use New Link once' : !canAdd ? why : 'Copy ' + p.name + '\'s link again (it keeps working)';
        return '<tr><td>' + esc(p.name) + '<div class="small muted"' + (p.lastSeen ? ' title="Last seen ' + esc(p.lastSeen) + '"' : '') + '>' + (p.lastSeen ? 'seen ' + esc(seenWhen(p.lastSeen) || p.lastSeen) : 'not seen yet') + '</div></td>' +
          '<td class="u-role">' + dropdown({ bind: 'u:role:' + p.id, id: 'uRole-' + p.id, change: 'team-role', value: p.role, options: ROLE_OPTIONS, label: 'Access for ' + p.name }) + '</td>' +
          '<td class="u-books">' + dropdown({ bind: 'u:books:' + p.id, id: 'uBooks-' + p.id, change: 'team-books', value: book || 'all', options: bookOpts, label: 'Workbooks ' + p.name + ' can open' }) + '</td>' +
          '<td class="u-suites">' + dropdown({ bind: 'u:suites:' + p.id, id: 'uSuites-' + p.id, change: 'team-suites', value: sc.value, options: suiteOpts, label: 'Automated suites ' + p.name + ' sees' }) + '</td>' +
          '<td class="u-runs">' + (viewer ? '<span class="faint" title="View only can read results but not start runs">–<span class="sr">View only never starts runs</span></span>'
            : '<input type="checkbox" data-action="team-runs" data-id="' + esc(p.id) + '" aria-label="' + esc(p.name) + ' can start runs and import results"' + (p.startRuns ? ' checked' : '') + '>') + '</td>' +
          '<td class="num"><div class="row" style="justify-content:flex-end">' +
          '<button class="small-btn" data-action="team-copy" data-id="' + esc(p.id) + '"' + (p.canCopy && canAdd ? '' : ' disabled') + ' title="' + esc(copyTip) + '">Copy Link</button>' +
          '<button class="small-btn" data-action="team-rotate" data-id="' + esc(p.id) + '"' + (canAdd ? '' : ' disabled') + ' title="' + esc(canAdd ? 'Make a new link; the old one stops working' : why) + '">New Link</button>' +
          '<button class="small-btn danger" data-action="team-remove" data-id="' + esc(p.id) + '">Remove</button></div></td></tr>';
      }).join('') + '</tbody></table></div>';
    } else {
      h += '<p class="small faint">Nobody yet.</p>';
    }
    var off = canAdd ? '' : ' disabled';
    h += '<div class="row add-person"><label class="sr" for="teamName">Name</label><input id="teamName" data-bind="team:name" placeholder="Name, e.g. John Doe (QA)" value="' + esc(val('team:name')) + '"' + off + '>' +
      // No access chosen for them until you choose one
      '<label class="sr" for="teamRole">Access</label>' + dropdown({ bind: 'team:role', id: 'teamRole', cls: 'u-new', value: val('team:role'), placeholder: 'Select access', options: ROLE_OPTIONS, disabled: !canAdd }) +
      '<button class="small-btn" data-action="team-add"' + off + '>+ Add and Make a Link</button></div>' +
      (canAdd ? '' : '<p class="small faint">' + esc(why) + '</p>') +
      '<ul class="bullets small muted"><li><span><b>Automated suites:</b> whose results they see, in Automation, Summary and the published site (still only for workbooks they can open).</span></li>' +
      '<li><span><b>Start runs:</b> can press ▶ Run and ⤒ Import Results for those suites. View only never can.</span></li></ul>';
    return h + '</section>';
  }

  /** Setup for one test case tab: the current cycle, starting a new one, the release in scope. */
  function cycleSetup(t, ti) {
    var saved = (S.cfg && S.cfg.tabs && S.cfg.tabs[t.name]) || {};
    var headers = (t.top && t.top[t.headerRow - 1]) || [];
    var cycles = headers.filter(isStatusHeader);
    // An earlier cycle can be removed (×) to keep the workbook and the reports tidy; the last one stays.
    var canRemove = t.saved && cycles.length > 1 && !S.readOnly;
    var canRename = t.saved && !S.readOnly;
    var editing = S.form.cycRen && S.form.cycRen.tab === t.name ? S.form.cycRen.header : null;
    var h = '<div class="subsection"><h3>Test cycles</h3><p class="small muted">A cycle is a pair of columns: <i>Test Status / name</i> and <i>Comment / name</i>. Earlier cycles stay, so you can compare' + (canRemove ? ', until you remove one with <b>×</b>' : '') + '.</p>' +
      '<div class="small cycle-chips">Status columns: ' + (cycles.length ? cycles.map(function (x) {
        var name = String(x).replace(/\s+/g, ' ').trim();
        if (editing === name) {
          return '<span class="cycle-edit"><label class="sr" for="cycRename">New name for ' + esc(name) + '</label><input id="cycRename" data-bind="cycRen:label" value="' + esc(val('cycRen:label', cycleName(name))) + '" size="14" autocomplete="off">' +
            '<button class="primary" data-action="cycle-rename-save">Save</button><button class="ghost" data-action="cycle-rename-cancel">Cancel</button></span>';
        }
        return '<span class="pill outline cycle-chip">' + esc(name) +
          (canRename ? '<button class="chip-edit" data-action="cycle-rename" data-tab="' + esc(t.name) + '" data-header="' + esc(name) + '" aria-label="Rename the cycle ' + esc(name) + '" title="Rename this cycle">✎</button>' : '') + (canRemove ? '<button class="chip-x" data-action="cycle-remove" data-tab="' + esc(t.name) + '" data-header="' + esc(name) + '" aria-label="Remove the cycle ' + esc(name) + '" title="Remove this cycle and its results">×</button>' : '') + '</span>';
      }).join(' ') : '<span class="faint">none yet</span>') + '</div>';
    if (!t.saved) return h + '<p class="note info fit">Save the setup first, with <b>Save</b> at the bottom of the page. Then you can start test cycles here.</p></div>';
    h += '<div class="row"><label class="sr" for="newCycle' + ti + '">New cycle name</label><input id="newCycle' + ti + '" data-bind="newCycle:' + ti + '" placeholder="New cycle, e.g. v2.20.1" value="' + esc(val('newCycle:' + ti)) + '">' +
      '<button data-action="start-cycle" data-tab="' + esc(t.name) + '" data-index="' + ti + '">Start new cycle</button><span class="small faint">Adds the two columns next to the latest cycle, with its dropdown and formatting.</span></div>';
    if (t.columns.release) {
      h += '<div class="row"><label for="release' + ti + '">Release in scope</label><input id="release' + ti + '" data-bind="release:' + ti + '" placeholder="e.g. 2.20.1" value="' + esc(val('release:' + ti, saved.release || '')) + '">' +
        '<button data-action="save-release" data-tab="' + esc(t.name) + '" data-index="' + ti + '">Save</button><span class="small faint">The release you are testing. Cases whose <i>' + esc(t.columns.release) + '</i> column says it are tagged <b>New in</b> it and come first in Run. Cycles are rounds of results; a release can take several.</span></div>';
    }
    return h + '</div>';
  }

  /** The cycle's own name in its status header: "Test Status / v2.12" -> "v2.12". */
  function cycleName(header) {
    var m = /^(?:test )?(?:execution )?(?:status|result)s?(?:\s*[\/|:\-\u2013]\s*(.+)|\s+(\S*\d.*))?$/i.exec(String(header || '').replace(/\s+/g, ' ').trim());
    return m ? (m[1] || m[2] || '').trim() : '';
  }

  function renameCycle() {
    var r = S.form.cycRen;
    if (!r) return;
    var label = String(val('cycRen:label', cycleName(r.header))).trim();
    if (!label) { toast('Give the cycle a name, for example v2.20.1.', 'bad'); return; }
    if (label === cycleName(r.header)) { delete S.form.cycRen; delete S.form['cycRen:label']; render(); return; }
    queueWrite(function () { return api('api_renameCycle', r.tab, r.header, label); }).then(function (x) {
      if (!x.ok) { writeError(x); var i = $('cycRename'); if (i) i.focus(); return; }
      delete S.form.cycRen;
      delete S.form['cycRen:label'];
      toast('Renamed the cycle ' + x.from + ' to ' + x.to + ' in ' + x.tab + '.');
      S.keep = {};
      S.summary = null;
      if (r.tab === S.tab) S.model = null;
      refreshBoot(false, null);
    });
  }

  /** Setup, in parts: Workbook (test suites, cycles, columns), Access (you, online access and users), Publish, Media, Automation. */
  function viewSetup() {
    var part = S.cfg ? val('setupPart', 'workbook') : 'workbook'; // a workbook not set up yet opens on its tabs
    if (part === 'sharing') part = 'access'; // Access was called Sharing: older links and state still open it
    if (!S.team && isOwner()) loadTeam(); // so Access shows on or off from the start, not only once it has been opened
    var shareState = S.team && S.team.team ? (S.team.team.enabled ? ' <span class="pill pass">on</span>' : ' <span class="pill fail">off</span>') : '';
    var rail = '<div class="rail-group subtabs" role="tablist" aria-label="Setup"><span class="rail-title">Setup</span>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="workbook" aria-selected="' + (part === 'workbook') + '">Workbook</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="access" aria-selected="' + (part === 'access') + '">Access' + shareState + '</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="publish" aria-selected="' + (part === 'publish') + '">Publish</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="media" aria-selected="' + (part === 'media') + '">Media</button>' +
      '<button role="tab" class="subtab" data-action="setup-part" data-part="automation" aria-selected="' + (part === 'automation') + '">Automation</button></div>' +
      (part === 'workbook' ? '<p class="small muted rail-note">This sets up the workbook chosen in <b>Workbook</b> at the top right. To set up another one, choose it there first.</p>'
        : part === 'access' ? '<p class="small muted rail-note">Who can use this Test Run, and how they reach this host-server. Applies to all workbooks.</p>'
          : part === 'media' ? '<p class="small muted rail-note">Media is for everyone using Test Run Extension: their screenshots and recordings follow these limits.</p>'
            : part === 'automation' ? '<p class="small muted rail-note">Each suite belongs to the workbooks it tests: its results show only there. Only the host sees this.</p>'
            : '<p class="small muted rail-note">Publishing puts the reports on the GitHub Pages site, for anyone, even when this host-server is off. It also lets someone else carry on from a clone of the repository.</p>');
    return withRail(rail, part === 'access' ? youCard() + onlineCard() + usersCard() : part === 'publish' ? publishCard() : part === 'media' ? mediaCard() : part === 'automation' ? auSetupCard() : setupWorkbook());
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
    if (!md) { loadMedia(); return '<div class="loading">Loading the media settings</div>'; }
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
      '<label class="kv-k" for="mediaKeep">Keep a Complete Report</label><span class="row"><select id="mediaKeep" data-change="media-keep">' + keep + '</select><span class="small muted">then it\'s deleted from this host-server</span></span>' +
      '</div>' +
      '<p class="small muted media-foot">Evidence stays on this host-server' + (md.used != null ? ' (' + fmtBytes(md.used) + ' used' + (me().local ? ', in <span class="mono">sheets/.testrun/evidence/</span>' : '') + ')' : '') + '. It is never published.</p></section>';
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
    toast('Publishing to GitHub');
    render();
    TR.http('POST', '/api/publish/now', extra || {}).then(function (r) {
      S.publishBusy = false;
      if (r.repo != null) S.publish = r;
      render();
      if (r.code === 'CONFIRM_PUBLIC') {
        askConfirm({
          title: 'Publish to the public repository?',
          banner: 'Anyone can read what you publish, and keep a copy of it.', bannerKind: 'warn',
          items: ['The ticked workbooks, their findings and their reports go to the public repository.', 'Screenshots and recordings are never published.'],
          yes: 'Publish now'
        }, function () { publishNow(Object.assign({}, extra, { confirmPublic: true })); });
        return;
      }
      if (r.code === 'NEWER_REMOTE') {
        var rem = r.remote || {};
        askConfirm({
          title: 'Replace the newer published copy?',
          banner: rem.at ? esc((rem.by || 'Someone') + ' published at ' + rem.at + ', after this host-server last published or got the data.') : esc(r.error), bannerKind: 'bad',
          items: ['Publishing now replaces their copy with this host-server’s.', 'To keep their changes, get their copy first, then publish.'],
          extra: { label: 'Get their copy first', fn: function () { ACTIONS['publish-get'](null); } },
          yes: 'Publish anyway', danger: true
        }, function () { publishNow(Object.assign({}, extra, { force: true })); });
        return;
      }
      if (!r.ok) { toast(r.error || 'Could not publish.', 'bad'); return; }
      var down = r.books && !r.books.some(function (b) { return b.on; });
      var res = r.result || {};
      if (res.pagesError) { toast((res.committed ? 'Published to GitHub, but the site was not updated.' : 'Nothing changed, and the site still was not updated.') + ' Setup › Publish says why.', 'bad'); return; }
      toast(!res.committed ? 'Nothing changed since the last publish.' : down ? 'The published reports are taken off GitHub. The site updates in about a minute.' : 'Published to GitHub. The site updates in about a minute.', 'long');
    });
  }

  /** The publish choices being edited (saved ones until something is changed). */
  function pubDraft() {
    var r = S.publish;
    if (!S.pubDraft) {
      var books = {};
      r.books.forEach(function (b) { books[b.name] = !!b.on; });
      S.pubDraft = { books: books, nightly: !!r.settings.nightly, time: r.settings.time };
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
      other: d.nightly !== !!st.nightly || d.time !== st.time
    };
  }
  function pubDirty() { var c = pubChanges(); return c.books.length > 0 || c.other; }

  function savePublishPrefs(publishAfter) {
    var d = S.pubDraft;
    var body = { books: d.books, nightly: d.nightly, time: d.time };
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
      '<li>Each publish replaces the last one, so what comes off leaves the repository. Anyone may already have a copy.</li></ul>' +
      '<div class="row" style="margin-top:14px"><span class="grow"></span><button data-action="publish-cancel-books">Cancel</button>' +
      '<button class="primary" data-action="publish-confirm">Save and update the site</button></div>');
  }

  function publishCard() {
    var r = S.publish;
    var h = '<section class="card card-pad stack" id="publish"><div class="card-title-row"><h2>Publish to GitHub</h2>' +
      helpButton({ id: 'publishTip', label: 'Who can read what is published', title: 'Published workbooks are public',
        html: '<span>Anyone can read them on GitHub and on the GitHub Pages site: test cases, results, comments, findings, tester names and issue links, and anyone may keep a copy. Invite keys and team settings are never published.</span>' }) + '</div>';
    if (!r) { loadPublish(); return h + '<div class="loading">Loading</div></section>'; }
    if (r.error && r.repo == null) return h + '<div class="note bad">' + esc(r.error) + '</div></section>';
    if (r.problem) h += '<div class="note bad">' + esc(r.problem) + '</div>';
    else h += '<div class="small muted">Goes to <a href="https://github.com/' + esc(r.repo) + '" target="_blank" rel="noopener" class="mono">' + esc(r.repo) + '</a>' + (r.isPrivate === false ? ' (a public repository)' : '') + '.</div>';
    var d = pubDraft();
    var dirty = pubDirty();
    h += '<div class="subsection"><h3>Workbooks to publish</h3>' + (r.books.length ? r.books.map(function (b) {
      return '<label class="check"><input type="checkbox" data-action="publish-book" data-name="' + esc(b.name) + '"' + (d.books[b.name] ? ' checked' : '') + '> ' + esc(b.name.replace(/\.xlsx$/i, '')) + '</label>';
    }).join('') : '<p class="small faint">No workbooks yet.</p>') +
      (r.books.length && !r.books.some(function (b) { return d.books[b.name]; }) ? '<p class="small muted">None ticked: publishing takes every published report off the site.</p>' : '') +
      (r.automation && r.automation.runs ? '<p class="small muted">With them go their <b>' + plural(r.automation.runs, 'automated run') + '</b>. Anyone on the site sees their figures in Summary › Automated; the failures and the runs themselves are locked: only invited people who may see a run open them, with their own invite link. New Link, Remove or a change of access locks them again at the next publish.</p>' : '') + '</div>';
    h += '<div class="subsection"><h3>When</h3>' +
      '<div class="row"><label class="check"><input type="checkbox" data-action="publish-nightly"' + (d.nightly ? ' checked' : '') + '> Every day at</label><input type="time" id="publishTime" data-change="publish-time" value="' + esc(d.time) + '"' + (d.nightly ? '' : ' disabled') + '><span class="small faint">while Test Run is running</span></div>' +
      (r.acknowledged ? '' : '<p class="small faint">This starts after your first Publish now.</p>') + '</div>';
    // Changes above apply only once saved
    h += '<div class="row"><button class="primary" data-action="publish-save"' + (dirty ? '' : ' disabled') + ' title="' + (dirty ? 'Save these choices' : 'Nothing changed') + '">Save</button>' +
      (dirty ? '<span class="small muted">Unsaved changes</span><button class="ghost" data-action="publish-discard">Discard</button>' : '') + '</div>';
    var l = r.last || {};
    h += '<div class="row publish-row"><button data-action="publish-now"' + (S.publishBusy || r.problem || dirty ? ' disabled' : '') + (dirty ? ' title="Save your changes first"' : '') + '>' + (S.publishBusy ? 'Publishing' : 'Publish now') + '</button>' +
      '<span class="small muted grow">' + (l.at ? 'Last published ' + esc(l.at) + (l.by ? ' by ' + esc(l.by) : '') + (l.commit ? ' · <a href="' + esc(l.url) + '" target="_blank" rel="noopener" class="mono">' + esc(l.commit.slice(0, 7)) + '</a>' : '') + (l.note ? ' · ' + esc(l.note) : '') : 'Not published from this host-server yet.') + '</span>' +
      '<a class="btn" href="?reports=1" target="_blank" rel="noopener" title="The last published reports, as anyone sees them, served from this host-server">Preview here</a>' +
      '</div>' +
      (l.error ? '<div class="note bad">' + esc(l.error) + '</div>' : '') +
      (!l.error && l.pagesError ? '<div class="note warn">' + esc(l.pagesError) + '</div>' : '');
    return h + '</section>';
  }

  /** Each tab of the workbook: what it holds, its test cycles first, then its columns (set once, folded away). */
  function setupWorkbook() {
    var d = setupDraft();
    var dis = S.readOnly ? ' disabled' : '';
    var h = '';
    // Adding workbooks lives here for now (it was at the top right).
    if (isOwner()) h += '<section class="section card card-pad"><div class="row"><div class="grow"><h2>Workbooks</h2><p class="small muted">Add one or more <b>.xlsx</b> workbooks, for example one per environment. Switch between them with <b>Workbook</b> at the top right.</p></div>' +
      '<button data-action="import" title="Add one or more .xlsx workbooks"' + dis + '><span aria-hidden="true">⤒</span> Import</button></div></section>';
    if (!S.cfg) h += '<div class="banner section"><div><b>Welcome.</b> Check how each tab of <b>' + esc(S.boot.sheetName) + '</b> was read (open <b>Columns</b> on a tab to see), then <b>Save</b> at the bottom.</div></div>';
    d.tabs.forEach(function (t, ti) {
      var headers = (t.top && t.top[t.headerRow - 1]) || [];
      h += '<section class="section card card-pad stack"><div class="row"><h2 title="' + esc(t.name) + '">' + esc(TR.tabLabel(t.name)) + '</h2><span class="small muted">' + t.rows + ' rows</span>' +
        '<span class="grow"></span>' +
        '<label for="role' + ti + '" class="sr">Role</label><select id="role' + ti + '" data-setup-tab="' + ti + '" data-key="role"' + dis + '>' +
        opt('manual', 'Test suite (manual cases)', t.role === 'manual') + opt('ignore', 'Ignore', t.role === 'ignore') + '</select></div>';
      if (t.role === 'ignore') { h += '<p class="small faint">Not used by the console.</p></section>'; return; }
      h += cycleSetup(t, ti);
      var mapped = S.boot.fields.filter(function (f) { return t.columns[f]; }).length;
      // Folded by default, a new workbook too; a tab whose columns weren't read well opens by itself and says why
      var problem = !headers.length ? 'No headers in row ' + t.headerRow : !t.columns.scenario ? 'No Scenario column' : '';
      var openCols = val('colsOpen:' + ti, !!problem);
      h += '<details class="columns"' + (openCols ? ' open' : '') + ' data-cols="' + ti + '"><summary><b>Columns</b> <span class="small muted">' + mapped + ' of ' + S.boot.fields.length + ' fields found · header row ' + esc(t.headerRow) + '</span>' +
        (problem ? ' <span class="pill other">– ' + esc(problem) + '</span>' : '') + '</summary><div class="stack" style="margin-top:10px">';
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
    // A bar that stays at the bottom of the window, so Save is in reach however many tabs the workbook has.
    // All on the right: what is unsaved, then Delete (it asks first: it cannot be undone), Cancel and Save.
    h += '<div class="setup-bar" role="group" aria-label="Workbook setup actions"><span class="grow"></span>' +
      (S.cfg ? '' : '<span class="small muted bar-note">Not saved yet. Save to start test cycles.</span>') +
      '<button class="danger-outline" data-action="book-delete" title="Delete ' + esc(book().replace(/\.xlsx$/i, '')) + ' for everyone, with its setup, findings and known issues (asks first)">Delete</button>' +
      (S.cfg ? '<button class="ghost" data-action="view" data-view="run">Cancel</button>' : '') + '<button class="primary" data-action="save-setup"' + dis + '>Save</button></div>';
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
    var picked = val('aiCases', []);
    // Title, state and priority come from GitHub once it is saved; there is nothing to type for them.
    return '<div class="card card-pad section"><div class="row"><h3 class="grow">New issue</h3>' + suitePicker('aiSuite', 'aiSuite', tab, 'ai-suite') + '</div>' +
      '<p class="small muted" style="margin-top:2px">For an issue logged outside Test Run, for example straight on GitHub or in another tracker.</p>' +
      '<div class="form-grid narrow" style="margin-top:8px">' +
      '<div class="wide"><label for="aiUrl">Issue link</label><input id="aiUrl" data-bind="aiUrl" type="url" placeholder="https://github.com/owner/repo/issues/123" value="' + esc(val('aiUrl')) + '" autocomplete="off"></div>' +
      '<div class="wide"><label for="aiCasesBtn">Test cases <span class="faint">(optional)</span></label>' +
      (s ? dropdown({
        bind: 'aiCases', id: 'aiCasesBtn', values: picked, search: true,
        options: s.cases.filter(function (x) { return !x.retired; }).map(function (x) { return { value: x.key, label: x.id || 'Row ' + x.row, hint: oneLine(x.scenario).slice(0, 110) }; }),
        tagLabel: function (k) { var x = s.cases.filter(function (y) { return y.key === k; })[0]; return x ? x.id || 'Row ' + x.row : k; },
        tagTitle: function (k) { var x = s.cases.filter(function (y) { return y.key === k; })[0]; return x ? oneLine(x.scenario) : ''; }
      }) : '<div class="small muted">Reading the test cases</div>') + '</div>' +
      '<div class="wide small">' + aiCaseNote(s, picked) + '</div></div>' +
      '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="ghost" data-action="add-issue">Cancel</button><button class="primary" data-action="add-issue-save">Save</button></div></div>';
  }

  /** Under the test cases: whether they will be marked failed, or what happens without one. */
  function aiCaseNote(s, picked) {
    if (!picked.length) return '<span class="muted">Without a test case, it is kept under <b>Findings</b> until it is linked to one.</span>';
    if (!s) return '<span class="muted">Reading the test cases</span>';
    return s.hasCycle ? '<label class="check"><input type="checkbox" data-bind="aiFail"' + (val('aiFail', true) ? ' checked' : '') + '> Mark ' + (picked.length > 1 ? 'them' : 'it') + ' failed in cycle ' + esc(s.cycle || 'Status') + '</label>'
      : '<span class="faint">This suite has no test cycle yet, so the issue is only linked.</span>';
  }

  /** Asks before removing a test cycle: its two columns and their results leave the workbook. */
  function removeCycleModal(tab, header) {
    openModal('<h2>Remove the cycle “' + esc(header) + '”?</h2>' +
      '<p class="banner bad" style="margin-top:10px"><b>This cannot be undone.</b></p>' +
      '<ul class="modal-list"><li>Its status and comment columns are deleted from <b>' + esc(tab) + '</b> in the workbook, with every result and comment in them.</li>' +
      '<li>It leaves the Test cycle list, Summary and the downloads; the published reports drop it at the next publish.</li>' +
      '<li>Today’s copy of the workbook in <span class="mono">sheets/.testrun/backups/</span> still has it.</li></ul>' +
      '<div class="modal-actions"><button data-action="modal-close">Cancel</button>' +
      '<button class="danger-fill" data-action="cycle-remove-confirm" data-tab="' + esc(tab) + '" data-header="' + esc(header) + '">Remove cycle</button></div>', 'confirm');
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
    if (!i) return head + '<div class="loading" style="padding:20px">Checking</div>';
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
      '<div class="cr-opts">' + opt2(gen, 'Generate New', 'cr-generate', true) + opt2(dl, '<span aria-hidden="true">⤓</span> Download Existing', 'cr-download', true) + '</div>';
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
      '<ul class="modal-list"><li>The workbook file is deleted from this host-server’s sheets folder, for everyone using this Test Run.</li>' +
      '<li>Its Test Run setup, findings and known issues are deleted with it, and its screenshots and recordings.</li>' +
      '<li>Copies published to GitHub stay until the next publish.</li></ul>' +
      '<div class="modal-actions"><button data-action="modal-close">Cancel</button>' +
      '<button class="danger-fill" data-action="book-delete-confirm" data-name="' + esc(name) + '">Delete workbook</button></div>', 'confirm');
  }

  // ---------------------------------------------------------------------------
  // Modal and clipboard
  // ---------------------------------------------------------------------------

  /** Opens the popup. cls 'confirm' gives the narrow width every question popup shares. */
  function openModal(html, cls) {
    var m = $('modal');
    m.innerHTML = '<div class="modal-box' + (cls ? ' ' + cls : '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    m.classList.remove('hidden');
    var first = m.querySelector('textarea, button.primary, button');
    if (first) first.focus();
  }

  /** Closes the popup. A question still waiting (askConfirm) counts as Cancel: Escape, a click outside, ✕. */
  function closeModal() {
    var m = $('modal');
    m.classList.add('hidden');
    m.innerHTML = '';
    var q = S.confirm;
    S.confirm = null;
    if (q && q.no) q.no();
  }

  /**
   * Asks before an action, in Test Run's own popup (never the browser's confirm box).
   * opts: { title, banner, bannerKind: 'bad' | 'warn', items: [html], yes: 'Delete finding', danger, extra: { label, fn } }.
   * title, banner and items are HTML: escape names in them. onYes runs on the action button, onNo on Cancel or closing.
   */
  function askConfirm(opts, onYes, onNo) {
    S.confirm = null;
    openModal('<h2>' + opts.title + '</h2>' +
      (opts.banner ? '<p class="banner ' + (opts.bannerKind || 'bad') + '" style="margin-top:10px"><b>' + opts.banner + '</b></p>' : '') +
      (opts.items && opts.items.length ? '<ul class="modal-list">' + opts.items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="modal-actions"><button data-action="confirm-no">Cancel</button>' +
      (opts.extra ? '<button data-action="confirm-extra">' + esc(opts.extra.label) + '</button>' : '') +
      '<button class="' + (opts.danger ? 'danger-fill' : 'primary') + '" data-action="confirm-yes">' + esc(opts.yes) + '</button></div>', 'confirm');
    S.confirm = { yes: onYes, no: onNo || null, extra: opts.extra ? opts.extra.fn : null };
  }

  /** Answers the open question: 'yes', 'extra' or 'no'. The popup closes first, so the answer can open another. */
  function answerConfirm(which) {
    var q = S.confirm;
    S.confirm = null;
    closeModal();
    var fn = q && q[which];
    if (fn) fn();
  }

  /** Forgets the access link in this browser and shows the sign-in screen. */
  function signOut() {
    TR.forget();
    if (document.activeElement) document.activeElement.blur();
    S.app = null; S.boot = null; S.model = null; S.cfg = null; S.findings = []; sideSeen = { findings: null };
    S.issues = null; S.team = null; S.selected = null; S.view = 'run';
    S.connect = { code: 'SIGNED_OUT' };
    render();
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

  var HELP_KEYS = [['J / ↓', 'Next case'], ['K / ↑', 'Previous case'], ['Enter', 'Open or close the case'], ['P', 'Pass'], ['F', 'Fail (then type a comment, Enter saves)'], ['N', 'NA / other'], ['1–9', 'Any status by position'], ['0', 'Clear the result (back to not run)'], ['C', 'Comment'], ['E', 'Edit the open case (Duplicate and Deprecate are next to it)'], ['U', 'Undo the last mark'], ['/', 'Search'], ['Esc', 'Close / leave a field']];

  /**
   * The ? and its tooltip (DESIGN.md › Tooltips): shown on hover and focus, pinned by a click or the ? key.
   * The keyboard shortcuts by default; o: { id, label (the button's), title, html } for other reference text
   * (Automation's Full report). One per screen: setHelp() works on the first.
   */
  function helpButton(o) {
    o = o || { id: 'keysTip', label: 'Keyboard shortcuts', title: 'Keyboard shortcuts',
      html: '<div class="tip-keys">' + HELP_KEYS.map(function (k) { return '<kbd>' + esc(k[0]) + '</kbd><span>' + esc(k[1]) + '</span>'; }).join('') + '</div>' };
    return '<span class="help-wrap' + (S.helpOpen ? ' open' : '') + '">' +
      '<button class="help-btn" data-action="help" aria-label="' + esc(o.label) + '" aria-describedby="' + esc(o.id) + '" aria-expanded="' + !!S.helpOpen + '">?</button>' +
      '<div id="' + esc(o.id) + '" role="tooltip" class="tip"><div class="tip-title">' + esc(o.title) + '</div>' + o.html + '</div></span>';
  }
  /**
   * The circled i (DESIGN.md › Tooltips › Info): reference text for a setting, next to its name, shown on
   * hover and keyboard focus, left-aligned under the i. Several can share a screen (unlike the ?).
   */
  function infoTip(id, label, text) {
    return '<span class="info-wrap"><button type="button" class="info-btn" aria-label="About ' + esc(label) + '" aria-describedby="' + esc(id) + '">i</button>' +
      '<span id="' + esc(id) + '" role="tooltip" class="tip">' + esc(text) + '</span></span>';
  }
  /** Pins the shortcuts open (or closes them) without redrawing the page. */
  function setHelp(open) {
    S.helpOpen = open;
    var w = document.querySelector('.help-wrap');
    if (!w) return;
    w.classList.toggle('open', open);
    if (!open) w.classList.add('shut'); // a hovered or focused ? stays hidden until left
    var b = w.querySelector('.help-btn');
    if (b) b.setAttribute('aria-expanded', String(open));
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  var ACTIONS = {
    view: function (el) {
      var from = S.view;
      S.view = el.getAttribute('data-view');
      if (S.view === 'findings') S.suites = {}; // read the other suites afresh
      if (S.view === 'setup') S.setup = null;
      if (S.view === 'setup' && el.getAttribute('data-part')) { S.form.setupPart = el.getAttribute('data-part'); S.auto.setupGh = null; S.auto.data = null; S.auto.error = ''; }
      if (S.view === 'automation') { S.auto.data = null; S.auto.error = ''; S.auto.detail = null; } // read afresh
      if (S.view === 'run' || S.view === 'summary') S.autoCycle = null; // the automated results attached to the cycle, read afresh
      if (S.view !== from) closeBlocks(); // a form left open on the page you leave closes, and what was typed in it goes
      if (S.view === 'issues') S.issuesDue = true; // viewIssues asks GitHub once
      render();
      window.scrollTo(0, 0);
    },
    select: function (el) { select(el.getAttribute('data-key')); },
    mark: function (el) { if (S.selected) mark(S.selected, el.getAttribute('data-value')); },
    'save-note': function () { saveNote(); },
    'tags-remove': function (el) {
      var b = el.getAttribute('data-tags');
      var list = splitLinks(val(b, ''));
      list.splice(parseInt(el.getAttribute('data-i'), 10), 1);
      S.form[b] = list.join('\n');
      render();
    },
    'issue-unlink': function (el) {
      var c = S.byKey[S.selected];
      if (!c) return;
      var k = String(el.getAttribute('data-ref')).toLowerCase();
      var gone = (c.issues || []).filter(function (i) { return String(i.url || i.ref).toLowerCase() === k; })[0];
      saveIssues(c, issueList(c).filter(function (v) { return String(v).toLowerCase() !== k; }), function () {
        toast('Removed ' + (gone ? gone.ref : 'the issue') + ' from ' + (c.id || 'the case') + '.');
      });
    },
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
    'dd-open': function (el) {
      var b = el.getAttribute('data-dd');
      S.ddOpen = S.ddOpen === b ? null : b;
      S.ddQ = '';
      render();
      var q = S.ddOpen && $('ddQ');
      if (q) q.focus();
    },
    'dd-pick': function (el) {
      var to = el.getAttribute('data-change-to');
      S.ddOpen = null;
      S.ddQ = '';
      if (to) { CHANGES[to]({ value: el.getAttribute('data-value'), bind: el.getAttribute('data-dd') }); render(); return; } // e.g. switch the workbook
      ddSet(el.getAttribute('data-dd'), el.getAttribute('data-value'));
      render();
    },
    'dd-toggle': function (el) {
      var b = el.getAttribute('data-dd');
      var v = el.getAttribute('data-value');
      var list = (ddGet(b) || []).slice();
      var i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1); else list.push(v);
      ddSet(b, list);
      var pop = el.closest('.dd-list');
      var top = pop ? pop.scrollTop : 0;
      render(); // the list stays open where it was
      var np = document.querySelector('.dd-list');
      if (np) np.scrollTop = top;
    },
    'dd-remove': function (el) {
      var b = el.getAttribute('data-dd');
      var v = el.getAttribute('data-value');
      ddSet(b, (ddGet(b) || []).filter(function (x) { return x !== v; }));
      render();
    },
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
    'toggle-all': function () {
      if (S.model.paths.some(function (p) { return !S.collapsed[p.id]; })) ACTIONS['collapse-all'](); else ACTIONS['expand-all']();
    },
    help: function () { setHelp(!S.helpOpen); if (S.helpOpen) { var w = document.querySelector('.help-wrap'); if (w) w.classList.remove('shut'); } },
    'modal-close': closeModal,
    'confirm-yes': function () { answerConfirm('yes'); },
    'confirm-no': function () { answerConfirm('no'); },
    'confirm-extra': function () { answerConfirm('extra'); },
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
            if (r.ok || r.code !== 'EXISTS') return r;
            return new Promise(function (resolve) {
              askConfirm({
                title: 'Replace “' + esc(f.name.replace(/\.xlsx$/i, '')) + '”?',
                banner: 'This cannot be undone.', bannerKind: 'bad',
                items: ['“' + esc(f.name) + '” is already in the sheets folder.', 'The file you picked replaces it, with every result and comment in it.'],
                yes: 'Replace workbook', danger: true
              }, function () { resolve(send(true)); }, function () { resolve(r); });
            });
          }).then(function (r) {
            if (r && r.ok) {
              done.push(r.name);
              if (r.addedColumns && r.addedColumns.length) toast('Added Tested by and Tested on to ' + r.addedColumns.map(function (a) { return a.tab; }).join(', ') + ' in ' + r.name.replace(/\.xlsx$/i, '') + '.');
            }
            else if (r && r.code !== 'EXISTS') failed.push(f.name + ': ' + r.error);
          });
        };
        if (files.length > 1) toast('Importing ' + files.length + ' workbooks');
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
      askConfirm({
        title: 'Delete finding ' + esc(k) + '?',
        banner: 'This cannot be undone.', bannerKind: 'bad',
        items: ['It is removed from Findings for everyone using this Test Run.'],
        yes: 'Delete finding', danger: true
      }, function () {
        queueWrite(function () { return api('api_deleteFinding', k); }).then(function (r) {
          if (!r.ok) { writeError(r); return; }
          S.findings = S.findings.filter(function (f) { return f.key !== k; });
          render();
        });
      });
    },
    writeup: function (el) {
      var f = S.findings.filter(function (x) { return x.key === el.getAttribute('data-key'); })[0];
      if (!f) return;
      closeBlocks();
      S.writeUp[f.key] = draftFromFinding(f, suiteOf(f.tab || S.tab));
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
        toast(k + ' added to ' + tab + ' as ' + (r.added[0].id || 'row ' + r.added[0].row) + linkedText(r.added[0].linked) + '.');
        afterLinked(tab);
        loadSide();
      });
    },
    cover: function (el) { closeBlocks(); S.covering = el.getAttribute('data-key'); render(); var i = $('covId'); if (i) i.focus(); },
    'cover-cancel': function () { S.covering = null; render(); },
    'cover-save': function (el) {
      var k = el.getAttribute('data-key');
      var fd = S.findings.filter(function (x) { return x.key === k; })[0] || {};
      var csm = suiteOf(fd.tab || S.tab);
      var c = findIn(csm ? csm.cases : [], val('cov:' + k));
      if (!c) { toast('Choose the test case that covers it.', 'bad'); return; }
      queueWrite(function () { return api('api_setFindingState', k, 'covered', c.id || c.key); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.covering = null;
        delete S.form['cov:' + k];
        toast(k + ' is covered by ' + caseLabel(c) + linkedText(r.linked) + '.');
        if (r.linked) afterLinked(fd.tab || S.tab);
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
      closeBlocks();
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
    'setup-part': function (el) {
      S.form.setupPart = el.getAttribute('data-part');
      if (S.form.setupPart === 'automation') { S.auto.setupGh = null; S.auto.data = null; S.auto.error = ''; } // GitHub access and the suites, read afresh
      render(); window.scrollTo(0, 0);
    },
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
      TR.fetchBlob('/api/evidence/file?book=' + encodeURIComponent(book()) + '&tab=' + encodeURIComponent(S.tab) + '&cycle=' + encodeURIComponent(cycleLabel()) + '&key=' + encodeURIComponent(k) + '&kind=' + encodeURIComponent(el.getAttribute('data-kind') || '')).then(function (r) {
        if (!r.ok) { if (w) w.close(); toast(r.error, 'bad'); return; }
        if (w) w.location = URL.createObjectURL(r.blob); else TR.saveBlob(r.blob, k);
      });
    },
    'ev-remove': function (el) {
      var k = el.getAttribute('data-key');
      var kind = el.getAttribute('data-kind');
      var ev = S.model.evidence && S.model.evidence[k] && S.model.evidence[k][kind];
      if (!ev) return;
      var tab = S.tab, cycle = cycleLabel();
      askConfirm({
        title: 'Delete “' + esc(ev.name) + '”?',
        banner: 'This cannot be undone.', bannerKind: 'bad',
        items: ['The file is deleted from this host-server and can’t be brought back.'],
        yes: 'Delete file', danger: true
      }, function () {
        TR.http('POST', '/api/evidence/remove', { book: book(), tab: tab, cycle: cycle, key: k, kind: kind }).then(function (r) {
          if (!r.ok) { toast(r.error, 'bad'); return; }
          toast('Deleted ' + r.removed + '.');
          loadTab(cycleLabel(), true);
        });
      });
    },
    'cycle-remove': function (el) { removeCycleModal(el.getAttribute('data-tab'), el.getAttribute('data-header')); },
    'cycle-rename': function (el) {
      S.form.cycRen = { tab: el.getAttribute('data-tab'), header: el.getAttribute('data-header') };
      delete S.form['cycRen:label'];
      render();
      var i = $('cycRename');
      if (i) { i.focus(); i.select(); }
    },
    'cycle-rename-save': function () { renameCycle(); },
    'cycle-rename-cancel': function () { delete S.form.cycRen; delete S.form['cycRen:label']; render(); },
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
      closeBlocks();
      S.form.aiOpen = open;
      render();
      var u = open && $('aiUrl');
      if (u) u.focus();
    },
    'add-issue-save': function (el) {
      var url = String(val('aiUrl')).trim();
      var u = $('aiUrl');
      if (!url) { toast('Please enter issue’s link before saving', 'bad'); if (u) u.focus(); return; }
      if (!/^https?:\/\/\S+$/i.test(url)) { toast('The issue’s link must start with https://', 'bad'); if (u) u.focus(); return; }
      var tab = val('aiSuite', S.tab);
      var s = suiteOf(tab);
      var keys = val('aiCases', []);
      if (keys.length && !s) { toast('Still reading the test cases of ' + tab + '. Try again in a moment.'); return; }
      var cases = keys.map(function (k) { return s.cases.filter(function (x) { return x.key === k; })[0]; }).filter(Boolean);
      var fail = !!(cases.length && s.hasCycle && val('aiFail', true));
      el.disabled = true;
      // One test case after the other; the first that fails stops the rest.
      function link(i) {
        if (i >= cases.length) return Promise.resolve({ ok: true });
        return queueWrite(function () { return api('api_linkBug', { tab: tab, key: cases[i].key, url: url, markFailed: fail, source: 'manual' }); })
          .then(function (r) { return r.ok ? link(i + 1) : r; });
      }
      var done = cases.length ? link(0)
        : queueWrite(function () { return api('api_saveFinding', { text: 'Issue ' + url.replace(/^https?:\/\/(www\.)?/i, '').replace(/^github\.com\//i, ''), url: url, tab: tab, source: 'manual' }); });
      done.then(function (r) {
        el.disabled = false;
        if (!r.ok) { writeError(r); return; }
        clearForm('ai');
        if (cases.length) {
          var ids = cases.map(function (c) { return c.id || 'row ' + c.row; });
          toast('Linked to ' + (ids.length > 3 ? ids.length + ' test cases' : ids.join(', ')) + (fail ? ' and marked failed' : '') + '.');
          if (tab === S.tab) loadTab(cycleLabel(), true); else delete S.suites[tab];
        } else {
          S.findings.push(r.finding);
          toast('Kept as finding ' + r.finding.key + '.');
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
        S.boot = null; S.model = null; S.cfg = null; S.setup = null; S.findings = []; S.issues = null;
        S.view = 'run';
        render();
      });
    },
    'findings-suite-reset': function () { S.form.findingsSuite = ''; render(); },
    'findings-show': function (el) { S.form.findingsShow = el.getAttribute('data-show'); render(); },
    'note-toggle': function () { var open = !val('noteOpen'); closeBlocks(); S.form.noteOpen = open; render(); var t = open && $('fText'); if (t) t.focus(); },
    'cover-with': function (el) {
      var k = el.getAttribute('data-key');
      var id = el.getAttribute('data-case');
      var cf = S.findings.filter(function (x) { return x.key === k; })[0] || {};
      queueWrite(function () { return api('api_setFindingState', k, 'covered', id); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        toast(k + ' is covered by ' + id + linkedText(r.linked) + '. It is under Done.');
        if (r.linked) afterLinked(cf.tab || S.tab);
        loadSide();
      });
    },
    'reopen-finding': function (el) {
      var k = el.getAttribute('data-key');
      queueWrite(function () { return api('api_setFindingState', k, 'open', ''); }).then(function (r) { if (!r.ok) writeError(r); else loadSide(); });
    },
    'new-case': function () {
      var open = !S.manual.length; // pressed again: close it
      closeBlocks();
      if (!open) { render(); return; }
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
    'issues-refresh': function () { refreshIssues(); },
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
      S.selected = null; S.caseTool = null; S.keep = {}; S.undo = []; S.model = null; S.filters.type = [];
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
    'forget-invite': function () { TR.forget(); S.pubAuto.unlock = {}; S.pubAuto.run = null; S.connect = { code: 'NO_SERVER' }; render(); },
    'sign-out': function () {
      askConfirm({
        title: 'Sign out of Test Run in this browser?',
        items: ['To come back you need your access link again.'],
        yes: 'Sign out'
      }, signOut);
    },
    'user-rename': function () {
      if (document.activeElement) document.activeElement.blur();
      S.view = 'setup'; S.form.setupPart = 'access';
      render();
      window.scrollTo(0, 0);
      var n = $('appUser');
      if (n) n.focus();
    },
    'team-enable': function (el) {
      if (!el.checked && !me().local) {
        askConfirm({
          title: 'Stop sharing?',
          banner: 'You are connected through it, so this browser loses Test Run.', bannerKind: 'warn',
          items: ['Someone has to turn it back on at the host-server.'],
          yes: 'Stop Sharing', danger: true
        }, function () { teamCall('/api/team', { enabled: false }); }, function () { el.checked = true; });
        return;
      }
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
      var mode = el.value;
      if (!me().local) {
        askConfirm({
          title: 'Change the way in?',
          items: ['You are connected through the current one, so this browser may lose Test Run.'],
          yes: 'Change way in'
        }, function () { teamCall('/api/team', { mode: mode }); }, render);
        return;
      }
      teamCall('/api/team', { mode: mode });
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
      var go = function () {
        el.disabled = true;
        if (on) toast(S.team.team.mode === 'fixed' ? 'Starting the tunnel' : 'Opening a tunnel. This takes a few seconds.');
        teamCall('/api/team/share', { on: on });
      };
      if (!on && !me().local) {
        askConfirm({
          title: 'Stop sharing?',
          banner: 'You are connected through it, so this browser loses Test Run.', bannerKind: 'warn',
          items: ['It has to be started again at the host-server.'],
          yes: 'Stop Sharing', danger: true
        }, go);
        return;
      }
      go();
    },
    // Hidden from view: a fresh or copied link goes to the clipboard, with a toast.
    'team-add': function () {
      var name = String(val('team:name')).trim();
      if (!name) { toast('Type their name first.'); var n = $('teamName'); if (n) n.focus(); return; }
      var role = val('team:role');
      if (role !== 'tester' && role !== 'viewer') { toast('Choose their access first.'); var sel = $('teamRole'); if (sel) sel.focus(); return; }
      teamCall('/api/team/people', { name: name, role: role }, function (r) {
        clearForm('team:name');
        clearForm('team:role');
        deliverLink(name, r.link, r.linkWarning, 'Added. ');
      });
    },
    'publish-now': function () { publishNow(); },
    'r-suite': function (el) { var w = currentReportSlug(); S.form['rSuite:' + w] = el.getAttribute('data-tab'); S.pubAuto.run = null; render(); },
    'publish-get': function (el) {
      askConfirm({
        title: 'Replace the workbooks here with the published ones?',
        banner: 'A copy of each workbook here is kept first.', bannerKind: 'warn',
        items: ['The published workbooks replace the ones on this host-server.', 'The copies are in <span class="mono">sheets/.testrun/backups/</span>.'],
        yes: 'Get published data', danger: true
      }, function () {
        if (el) el.disabled = true;
        TR.http('POST', '/api/publish/get-latest', {}).then(function (r) {
          if (r.repo != null) S.publish = r;
          if (!r.ok) { toast(r.error, 'bad'); render(); return; }
          toast('Got the data published by ' + (r.result.by || 'someone') + ' at ' + r.result.at + '.', 'long');
          if (S.app) S.app.publishNotice = null;
          refreshApp().then(function () { boot(S.tab, cycleLabel()); });
        });
      });
    },
    'publish-book': function (el) { pubDraft().books[el.getAttribute('data-name')] = el.checked; render(); },
    'publish-nightly': function (el) { pubDraft().nightly = el.checked; render(); },
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
      var go = function () {
        TR.http('POST', '/api/team/admin', { action: 'new' }).then(function (r) {
          if (!r.ok) { toast(r.error, 'bad'); return; }
          S.team = r;
          copyAdminLink(r);
        });
      };
      if (!had) { go(); return; }
      askConfirm({
        title: 'Make a new admin link?',
        banner: 'The old one stops working' + (me().admin ? ', including in this browser.' : '.'), bannerKind: 'bad',
        yes: 'Make New Link', danger: true
      }, go);
    },
    'admin-remove': function () {
      askConfirm({
        title: 'Remove your admin link?',
        banner: 'It stops working at once' + (me().admin ? ', including in this browser.' : '.'), bannerKind: 'bad',
        yes: 'Remove Admin Link', danger: true
      }, function () { teamCall('/api/team/admin', { action: 'remove' }, function () { toast('Admin link removed.'); }); });
    },
    'team-runs': function (el) { teamCall('/api/team/people/automation', { id: el.getAttribute('data-id'), startRuns: el.checked }); },
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
      if (!p) return;
      askConfirm({
        title: 'Make a new link for ' + esc(p.name) + '?',
        banner: 'Their current link stops working.', bannerKind: 'bad',
        items: ['The new link goes to your clipboard, to send to them.'],
        yes: 'Make New Link', danger: true
      }, function () {
        teamCall('/api/team/people/update', { id: id, rotate: true }, function (r) { deliverLink(p.name, r.link, r.linkWarning, 'New link made; the old one no longer works. '); });
      });
    },
    'team-remove': function (el) {
      var id = el.getAttribute('data-id');
      var p = S.team.people.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      askConfirm({
        title: 'Remove ' + esc(p.name) + '?',
        banner: 'Their link stops working at once.', bannerKind: 'bad',
        yes: 'Remove', danger: true
      }, function () { teamCall('/api/team/people/remove', { id: id }); });
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
    },

    // Summary › Manual | Automated (and the same switch on the published site)
    'sum-view': function (el) { setSumView(el.getAttribute('data-v')); S.pubAuto.run = null; render(); },
    'sum-cause': function (el) { var i = el.getAttribute('data-i'); S.sumOpen[i] = !S.sumOpen[i]; render(); },
    /** A run from Summary › Automated: its run view in Automation (with a What changed card's filter). */
    'sum-open': function (el) {
      var A = S.auto;
      S.view = 'automation';
      A.data = null; A.error = ''; A.detail = null; A.screen = 'run'; A.runId = el.getAttribute('data-id'); A.wantFilter = el.getAttribute('data-f') || '';
      A.moving = false; A.editing = false; S.helpOpen = false;
      closeBlocks();
      render();
      window.scrollTo(0, 0);
    },
    'sum-excel': function (el) {
      var d = S.autoCycle && S.autoCycle.data, r = d && d.latest;
      if (!r) return;
      var name = ((r.suiteName || 'Automated run') + ' - ' + auStamp(r.startedAt) + ' - results.xlsx').replace(/[\\/:*?"<>|]/g, '_');
      TR.download('/api/automation/excel?id=' + enc(el.getAttribute('data-id')), name).then(function (x) { if (!x.ok) toast(x.error, 'bad'); });
    },
    'sum-full-report': function (el) {
      var u = el.getAttribute('data-url') || '';
      if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
    },
    // Published site › Automated
    'pub-have-link': function () {
      var i = $('inviteLink');
      if (!i) return;
      i.scrollIntoView({ block: 'center' });
      i.focus();
    },
    'pub-retry': function () { S.pubAuto.unlock = {}; render(); },
    'pub-open': function (el) {
      var id = el.getAttribute('data-id'), f = el.getAttribute('data-f') || '';
      var P = S.pubAuto, A = S.auto;
      P.run = id; P.runLoading = true; A.detail = null; S.helpOpen = false;
      render();
      window.scrollTo(0, 0);
      pubRunDetail(id).then(function (det) {
        if (P.run !== id) return;
        P.runLoading = false;
        A.detail = det; A.open = { 0: true }; A.q = ''; A.allFiles = false; A.moving = false;
        A.filter = f || (det.run.totals.failed ? 'failed' : 'all');
        var firstFail = det.run.tests.filter(function (t) { return t.status === 'fail'; })[0];
        A.sel = firstFail ? firstFail.id : '';
        render();
      }, function () {
        if (P.run !== id) return;
        P.run = null; P.runLoading = false;
        toast('That run could not be opened in this browser.', 'bad');
        render();
      });
    },
    'pub-guest-csv': function () {
      var pk = reportPick(), g = pk && pk.suite ? pubEveryoneData(pk.w.slug, pk.suite.tab, pk.cyc) : null;
      if (!g) return;
      TR.saveBlob(new Blob([everyoneCsv(g)], { type: 'text/csv;charset=utf-8' }), (pk.w.title + ' - ' + pk.suite.tab + (pk.cyc ? ' - cycle ' + pk.cyc : '') + ' - automated.csv').replace(/[\\/:*?"<>|]/g, '_'));
    },
    'pub-back': function () { S.pubAuto.run = null; S.auto.detail = null; render(); window.scrollTo(0, 0); },
    'pub-csv': function (el) {
      var id = el.getAttribute('data-id');
      pubRunDetail(id).then(function (det) {
        var r = det.run;
        TR.saveBlob(new Blob([resultsCsv(r)], { type: 'text/csv;charset=utf-8' }), ((r.suiteName || 'Automated run') + ' - ' + auStamp(r.startedAt) + ' - results.csv').replace(/[\\/:*?"<>|]/g, '_'));
      }, function () { toast('That run could not be opened in this browser.', 'bad'); });
    },

    // Automation
    'au-reload': function () { S.auto.error = ''; S.auto.data = null; render(); },
    'au-suite': function (el) {
      var A = S.auto;
      A.suite = el.getAttribute('data-id');
      A.screen = 'runs'; A.runId = ''; A.detail = null; A.file = null; A.moving = false; A.editing = false;
      clearForm('au:f:');
      render();
      window.scrollTo(0, 0);
    },
    // Link a suite: a popup, from Setup › Automation's + Add
    'au-link': function () {
      S.auto.linkOpen = true; S.auto.editing = false; clearForm('au:l:'); clearForm('au:lk:');
      S.form['au:l:books'] = book() ? [book()] : [];
      S.auto.gh = auGhFresh(); S.ddOpen = null;
      render(); auLinkFocus();
    },
    // Change a suite, in the same popup: ✎ Edit on Automation, or the suite's name in Setup › Automation
    'au-edit': function (el) {
      var id = el && el.getAttribute('data-id');
      if (id) S.auto.suite = id;
      S.auto.linkOpen = true; S.auto.editing = true; clearForm('au:l:'); clearForm('au:lk:');
      var s0 = auSuite();
      S.form['au:l:books'] = s0 && s0.books ? s0.books.slice() : S.app.books.map(function (b) { return b.name; }); // linked before workbooks: all of them
      S.auto.gh = auGhFresh(); S.ddOpen = null;
      render(); auLinkFocus();
      var s = auSuite();
      if (s && s.workflowId) auGhCheck(); // a linked suite: its workflows are read again, so they can be changed
    },
    'au-link-close': function () { auLinkClose(); },
    'au-gh-check': function () { auGhCheck(); },
    'au-gh-import-latest': function () {
      var A = S.auto, G = A.gh, body = auLinkBody(), a = auAttachChosen('lk');
      if (!body.name) { toast('Give the suite a name, as people should see it in Test Run.', 'bad'); var n0 = $('auName'); if (n0) n0.focus(); return; }
      if (!body.books.length) { toast('Choose the workbooks this suite belongs to: its results show only there.', 'bad'); return; }
      if (!a) { toast('Choose the workbook, test suite and test cycle the results belong to.', 'bad'); return; }
      G.importing = true; G.imported = null;
      render();
      TR.http('POST', '/api/automation/github/link', body).then(function (r) {
        if (!r.ok) { G.importing = false; G.imported = { ok: false, text: r.error }; render(); return; }
        A.editing = true; A.suite = r.suite.id; // saved: Save now changes it
        TR.http('POST', '/api/automation/github/import', { suite: r.suite.id, book: a.book, tab: a.tab, cycle: a.cycle }).then(function (x) {
          G.importing = false;
          if (!x.ok) { G.imported = { ok: false, text: x.error }; auLoad(); return; }
          var t = x.run.totals;
          G.imported = { ok: true, text: '✓ Read ' + plural(t.total, 'test') + ' from run #' + x.githubRun.number + ' (' + auDate(x.run.startedAt, false) + '): ✓ ' + t.passed + ' ✗ ' + t.failed + ' – ' + t.skipped };
          toast((r.created ? 'Linked “' : 'Saved “') + r.suite.name + '” and imported its latest run into ' + a.tab + ' › ' + cycleText(a.cycle) + '.' + auRemovedText(x.removed, A.data.keep));
          auLoad(); refreshApp();
        });
      });
    },
    'au-run': function () {
      var A = S.auto, s = auSuite();
      if (!s) return;
      A.screen = 'start'; A.starting = false; A.targets = {};
      clearForm('au:rn:'); clearForm('au:in:');
      var names = S.app.books.map(function (b) { return b.name; });
      S.form['au:rn:book'] = names.indexOf(book()) >= 0 ? book() : names[0] || '';
      auTargets(S.form['au:rn:book'], function () { auDefaults('rn'); });
      auRunFormLoad(s);
      render();
      window.scrollTo(0, 0);
    },
    'au-run-start': function () {
      var A = S.auto, s = auSuite(), a = auAttachChosen('rn');
      if (!s) return;
      if (!a) { toast('Choose the workbook, test suite and test cycle the results belong to.', 'bad'); return; }
      var fl = auRunFields(s);
      if (!fl) { toast('Wait for the run form of the branch to load.', 'bad'); return; }
      var inputs = {};
      var missing = '';
      fl.inputs.forEach(function (d) { // only the fields the branch's form has
        var v = auInputVal(d);
        inputs[d.name] = d.type === 'boolean' ? !!v : String(v).trim();
        if (d.required && d.type !== 'boolean' && !inputs[d.name] && !missing) missing = d.name;
      });
      if (missing) { toast('Fill in ' + missing + ': the workflow needs it.', 'bad'); return; }
      A.starting = true;
      render();
      TR.http('POST', '/api/automation/github/run', { suite: s.id, branch: val('au:rn:branch', ''), inputs: inputs, book: a.book, tab: a.tab, cycle: a.cycle }).then(function (r) {
        A.starting = false;
        if (!r.ok) { toast(r.error, 'bad'); render(); return; }
        A.jobs = (A.jobs || []).filter(function (j) { return j.id !== r.job.id; }).concat([r.job]);
        A.screen = 'runs'; A.runForm = null; // the run shows under In GitHub Actions
        toast('Starting in GitHub Actions');
        clearForm('au:rn:'); clearForm('au:in:');
        clearTimeout(A.jobsTimer);
        A.jobsTimer = setTimeout(auJobsLoad, 2000);
        render();
        window.scrollTo(0, 0);
      });
    },
    'au-exclude-add': function () {
      var name = String(val('set:au:exclude', '')).trim(), list = (S.auto.data && S.auto.data.excludeEnvironments) || [];
      if (!name) { toast('Type the environment\'s name first.', 'bad'); return; }
      if (list.some(function (x) { return x.toLowerCase() === name.toLowerCase(); })) { toast('“' + name + '” is already left out.', 'bad'); return; }
      auExcludeSave(list.concat([name]));
    },
    'au-exclude-remove': function (el) {
      var name = el.getAttribute('data-value');
      auExcludeSave(((S.auto.data && S.auto.data.excludeEnvironments) || []).filter(function (x) { return x !== name; }));
    },
    'au-gh-log': function (el) {
      var j = auJob(el.getAttribute('data-id'));
      if (j && j.runUrl) window.open(j.runUrl, '_blank', 'noopener');
    },
    'au-job-cancel': function (el) {
      var j = auJob(el.getAttribute('data-id'));
      if (!j) return;
      askConfirm({
        title: 'Cancel the run of “' + esc(j.suiteName) + '”?',
        banner: 'You can start it again, but it begins from the start.', bannerKind: 'warn',
        items: ['GitHub stops the run (' + esc(j.branch) + (j.env ? ' · ' + esc(j.env) : '') + ').', 'Results it uploads before stopping are still brought in; without them, nothing is added to ' + esc(attachText(j.attach)) + '.'],
        yes: 'Cancel Run', danger: true
      }, function () {
        TR.http('POST', '/api/automation/job/cancel', { id: j.id }).then(function (r) {
          if (!r.ok) { toast(r.error, 'bad'); return; }
          S.auto.jobs = (S.auto.jobs || []).map(function (x) { return x.id === r.job.id ? r.job : x; });
          toast('Asked GitHub to cancel the run.');
          render();
          auJobsLoad();
        });
      });
    },
    'au-job-dismiss': function (el) {
      var id = el.getAttribute('data-id');
      TR.http('POST', '/api/automation/job/dismiss', { id: id }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        var A = S.auto;
        A.jobs = (A.jobs || []).filter(function (j) { return j.id !== id; });
        render();
      });
    },
    'au-im-src': function (el) { S.form['au:im:src'] = el.getAttribute('data-src'); S.auto.ghRunsFor = ''; render(); },
    'au-gh-import': function () {
      var A = S.auto, a = auAttachChosen('im'), runId = val('au:gh:run', '');
      if (!runId) { toast('Choose the GitHub run to bring in.', 'bad'); return; }
      if (!a) { toast('Choose the workbook, test suite and test cycle the results belong to.', 'bad'); return; }
      A.busy = true;
      render();
      TR.http('POST', '/api/automation/github/import', { suite: A.suite, runId: Number(runId), book: a.book, tab: a.tab, cycle: a.cycle }).then(function (r) {
        A.busy = false;
        if (!r.ok) { toast(r.error, 'bad'); render(); return; }
        A.screen = 'runs'; A.ghRunsFor = '';
        clearForm('au:im:'); clearForm('au:gh:'); clearForm('au:f:');
        toast('Imported ' + plural(r.run.totals.total, 'test') + ' from run #' + r.githubRun.number + ' into ' + a.tab + ' › ' + cycleText(a.cycle) + '.' + auRemovedText(r.removed, A.data.keep));
        auLoad();
        window.scrollTo(0, 0);
      });
    },
    'au-setup-remove': function (el) {
      var A = S.auto, s = A.data && A.data.suites.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
      if (!s) return;
      var n = auRunsOf(s.id, true).length;
      askConfirm({
        title: 'De-link “' + esc(s.name) + '”?',
        banner: 'This cannot be undone.', bannerKind: 'bad',
        items: [n ? 'Its ' + plural(n, 'kept run') + ' and their results leave Test Run.' : 'It has no kept runs.', 'The suite\'s repository, and its reports on GitHub, aren\'t touched.'],
        yes: 'De-link', danger: true
      }, function () {
        TR.http('POST', '/api/automation/suites/remove', { id: s.id }).then(function (r) {
          if (!r.ok) { toast(r.error, 'bad'); return; }
          refreshApp();
          toast('De-linked “' + s.name + '”.' + (r.runs ? ' ' + plural(r.runs, 'run') + (r.runs === 1 ? ' was' : ' were') + ' deleted with it.' : ''));
          if (A.suite === s.id) A.suite = '';
          auLoad();
        });
      });
    },

    'au-import': function () {
      var A = S.auto;
      A.screen = 'import'; A.file = null; A.busy = false; A.targets = {};
      clearForm('au:im:'); delete S.form['au:branch']; delete S.form['au:env'];
      var names = S.app.books.map(function (b) { return b.name; });
      S.form['au:im:book'] = names.indexOf(book()) >= 0 ? book() : names[0] || '';
      auTargets(S.form['au:im:book'], function () { auDefaults('im'); });
      render();
      window.scrollTo(0, 0);
    },
    'au-back': function () {
      var A = S.auto;
      A.screen = 'runs'; A.runId = ''; A.file = null; A.moving = false; A.editing = false; A.runForm = null;
      A.gh = auGhFresh();
      clearForm('au:l:'); clearForm('au:mv:'); clearForm('au:rn:'); clearForm('au:in:'); clearForm('au:lk:'); clearForm('au:gh:');
      render();
      window.scrollTo(0, 0);
    },
    'au-open': function (el) {
      var A = S.auto;
      A.runId = el.getAttribute('data-id'); A.screen = 'run'; A.detail = null; S.helpOpen = false;
      render();
      window.scrollTo(0, 0);
    },
    'au-filter-reset': function (el) { delete S.form[el.getAttribute('data-dd')]; render(); },
    'au-cause': function (el) { var i = el.getAttribute('data-i'); S.auto.open[i] = !S.auto.open[i]; render(); },
    'au-all-files': function () { S.auto.allFiles = true; render(); },
    'au-chip': function (el) { S.auto.filter = el.getAttribute('data-f'); render(); },
    'au-filter': function (el) {
      S.auto.filter = el.getAttribute('data-f');
      render();
      var t = $('auTests');
      if (t) t.scrollIntoView({ block: 'start' });
    },
    'au-test': function (el) {
      S.auto.sel = el.getAttribute('data-id');
      render();
      var p = $('auTestPanel');
      if (p) p.scrollIntoView({ block: 'nearest' });
    },
    'au-full-report': function () {
      var d = S.auto.detail, u = d ? auReportUrl(d.run.source) : '';
      if (u) window.open(u, '_blank', 'noopener');
    },
    'au-excel': function () {
      var r = S.auto.detail && S.auto.detail.run;
      if (!r) return;
      var name = ((r.suiteName || 'Automated run') + ' - ' + auStamp(r.startedAt) + ' - results.xlsx').replace(/[\\/:*?"<>|]/g, '_');
      TR.download('/api/automation/excel?id=' + enc(r.id), name).then(function (x) { if (!x.ok) toast(x.error, 'bad'); });
    },
    'au-file': function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.xml,.json,.zip,application/xml,text/xml,application/json,application/zip';
      input.addEventListener('change', function () { auChoose(input.files); });
      input.click();
    },
    'au-file-clear': function () { S.auto.file = null; render(); },
    'au-import-save': function () {
      var A = S.auto, f = A.file, a = auAttachChosen('im');
      if (!f || !f.preview) { toast('Choose a results file first.', 'bad'); return; }
      if (!a) { toast('Choose the workbook, test suite and test cycle the results belong to.', 'bad'); return; }
      var q = '?suite=' + enc(A.suite) + '&book=' + enc(a.book) + '&tab=' + enc(a.tab) + '&cycle=' + enc(a.cycle) +
        '&branch=' + enc(String(val('au:branch', '')).trim()) + '&env=' + enc(String(val('au:env', '')).trim());
      A.busy = true;
      render();
      auUpload('/api/automation/import' + q, f.files).then(function (r) {
        A.busy = false;
        if (!r.ok) { toast(r.error, 'bad'); render(); return; }
        A.file = null; A.screen = 'runs';
        clearForm('au:im:'); delete S.form['au:branch']; delete S.form['au:env']; clearForm('au:f:');
        toast('Imported ' + plural(r.run.totals.total, 'test') + ' into ' + a.tab + ' › ' + cycleText(a.cycle) + '.' + auRemovedText(r.removed, A.data.keep));
        auLoad();
        window.scrollTo(0, 0);
      });
    },
    'au-link-save': function () {
      var A = S.auto;
      var body = auLinkBody();
      if (!body.name) { toast('Give the suite a name, as people should see it in Test Run.', 'bad'); var n = $('auName'); if (n) n.focus(); return; }
      if (!body.books.length) { toast('Choose the workbooks this suite belongs to: its results show only there.', 'bad'); return; }
      // checked on GitHub with a workflow chosen: saved with its workflow; else as a suite whose results are imported
      TR.http('POST', body.workflowId ? '/api/automation/github/link' : '/api/automation/suites', body).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        auLinkClose();
        A.suite = r.suite.id;
        toast((r.created ? 'Linked “' : 'Saved “') + r.suite.name + '”.');
        auLoad(); refreshApp(); // the Automation tab shows in its workbooks
      });
    },
    'au-suite-remove': function () {
      var s = auSuite();
      if (!s) return;
      var n = auRunsOf(s.id, true).length;
      askConfirm({
        title: 'De-link “' + esc(s.name) + '”?',
        banner: 'This cannot be undone.', bannerKind: 'bad',
        items: [n ? 'Its ' + plural(n, 'kept run') + ' and their results leave Test Run.' : 'It has no kept runs.', 'The suite\'s repository, and its reports on GitHub, aren\'t touched.'],
        yes: 'De-link', danger: true
      }, function () {
        TR.http('POST', '/api/automation/suites/remove', { id: s.id }).then(function (r) {
          if (!r.ok) { toast(r.error, 'bad'); return; }
          auLinkClose();
          S.auto.screen = 'runs'; S.auto.suite = '';
          refreshApp();
          toast('De-linked “' + s.name + '”.' + (r.runs ? ' ' + plural(r.runs, 'run') + (r.runs === 1 ? ' was' : ' were') + ' deleted with it.' : ''));
          auLoad();
        });
      });
    },
    'au-delete': function () {
      var det = S.auto.detail;
      if (!det) return;
      var r = det.run;
      var others = det.kept.filter(function (x) { return x.id !== r.id; });
      askConfirm({
        title: 'Delete “' + esc(auLabel(r)) + '”?',
        banner: 'This cannot be undone.', bannerKind: 'bad',
        items: [
          'Its results leave Test Run now.',
          esc(r.attach.tab + ' › ' + cycleText(r.attach.cycle)) + (others.length ? ' keeps ' + plural(others.length, 'run') + ' (' + esc(others.map(function (x) { return auDate(x.startedAt); }).join(', ')) + ').' : ' keeps no runs.'),
          r.source.runUrl ? 'The full report on GitHub isn\'t touched; GitHub keeps it until it expires.' : 'The results file it was imported from isn\'t touched.'
        ],
        yes: 'Delete Run', danger: true
      }, function () {
        TR.http('POST', '/api/automation/delete', { id: r.id }).then(function (x) {
          if (!x.ok) { toast(x.error, 'bad'); return; }
          S.auto.screen = 'runs'; S.auto.runId = ''; S.auto.detail = null;
          toast('Deleted the run from ' + auDate(r.startedAt) + '.');
          auLoad();
        });
      });
    },
    'au-move': function () {
      var A = S.auto, r = A.detail && A.detail.run;
      if (!r) return;
      A.moving = !A.moving;
      clearForm('au:mv:');
      if (A.moving) {
        A.targets = {};
        S.form['au:mv:book'] = r.attach.book; S.form['au:mv:tab'] = r.attach.tab; S.form['au:mv:cycle'] = 'c:' + r.attach.cycle;
        auTargets(r.attach.book, function () { auDefaults('mv'); });
      }
      render();
    },
    'au-move-cancel': function () { S.auto.moving = false; clearForm('au:mv:'); render(); },
    'au-move-save': function () {
      var A = S.auto, r = A.detail && A.detail.run, a = auAttachChosen('mv');
      if (!r) return;
      if (!a) { toast('Choose the workbook, test suite and test cycle to attach the run to.', 'bad'); return; }
      if (a.book === r.attach.book && a.tab === r.attach.tab && a.cycle === r.attach.cycle) { A.moving = false; clearForm('au:mv:'); render(); return; }
      TR.http('POST', '/api/automation/reattach', { id: r.id, book: a.book, tab: a.tab, cycle: a.cycle }).then(function (x) {
        if (!x.ok) { toast(x.error, 'bad'); return; }
        A.moving = false; A.detail = null;
        clearForm('au:mv:');
        toast('Moved the run to ' + bookTitle(a.book) + ' › ' + a.tab + ' › ' + cycleText(a.cycle) + '.' + auRemovedText(x.removed, A.data.keep));
        auLoad();
      });
    }
  };

  setInterval(function () { // Automation › In GitHub Actions: each run's elapsed time
    var els = document.querySelectorAll('.au-elapsed');
    for (var i = 0; i < els.length; i++) els[i].textContent = auClock(Date.now() - Number(els[i].getAttribute('data-since')));
  }, 1000);

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
      S.suites = {};
      S.selected = null;
      S.keep = {};
      S.undo = [];
      S.findings = [];
      S.issues = null;
      S.issuesDue = true;
      sideSeen = { findings: null };
      S.manual = [];
      S.writeUp = {};
      S.covering = null;
      S.setup = null;
      S.summary = null;
      S.filters.type = [];
      S.view = 'run';
      PARAMS.view = ''; // a new workbook opens on Run, whatever the address said when the page loaded
      boot(TR.store.get('tab:' + name), '');
    });
  }

  /** Open another test case tab (a module) of this workbook. */
  function pickTab(name) {
    if (!name || name === S.tab) return;
    S.tab = name;
    TR.store.set('tab:' + book(), S.tab);
    S.addHere = null;
    S.selected = null;
    S.caseTool = null;
    S.keep = {};
    S.undo = [];
    S.model = null;
    S.filters.type = [];
    loadTab('');
  }

  var CHANGES = {
    book: function (el) { if (el.value) switchBook(el.value); },
    tab: function (el) { pickTab(el.value); },
    'findings-suite': function (el) { S.form.findingsSuite = el.value; render(); },
    'man-suite': function (el) { S.form['man:tab'] = el.value; render(); },
    'r-book': function (el) { S.form.rBook = el.value; S.pubAuto.run = null; render(); },
    'r-cycle': function (el) {
      var w = currentReportSlug();
      var d = S.reports && S.reports.data[w];
      var sname = val('rSuite:' + w, '');
      var suite = d && (d.suites.filter(function (x) { return x.tab === sname; })[0] || d.suites[0]);
      if (suite) S.form['rCycle:' + w + ':' + suite.tab] = el.value;
      S.pubAuto.run = null;
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
    'ai-suite': function (el) { S.form.aiSuite = el.value; delete S.form.aiCases; render(); },
    'media-keep': function (el) { setMedia({ keepMinutes: Number(el.value) }); },
    // ▶ Run: another branch, and so that branch's own run form
    'au-run-branch': function (el) {
      var s = auSuite();
      S.form['au:rn:branch'] = el.value;
      if (s && el.value) auRunFieldsLoad(s, el.value);
    },
    // Setup › Automation: runs kept per test suite and cycle
    'au-check-every': function (el) {
      TR.http('POST', '/api/automation/settings', { checkEvery: Number(el.value) }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        if (S.auto.data) S.auto.data.checkEvery = r.checkEvery;
        toast('Saved. Test Run checks on running runs every ' + (r.checkEvery === 1 ? 'minute' : r.checkEvery + ' minutes') + '.');
        render();
      });
    },
    'au-keep': function (el) {
      TR.http('POST', '/api/automation/settings', { keep: Number(el.value) }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        if (S.auto.data) S.auto.data.keep = r.keep;
        toast('Saved. Test Run keeps the last ' + (r.keep === 1 ? 'run' : r.keep + ' runs') + ' for each test suite and cycle, from the next run that comes in.');
        render();
      });
    },
    // Setup › Access › Users: a row's dropdowns (their bind is u:<what>:<person id>)
    'team-role': function (el) { teamCall('/api/team/people/update', { id: personOf(el), role: el.value }); },
    'team-books': function (el) { teamCall('/api/team/people/update', { id: personOf(el), books: el.value && el.value !== 'all' ? [el.value] : 'all' }); },
    'team-suites': function (el) {
      if (el.value === 'multi') return; // several suites, set elsewhere: kept as they are
      teamCall('/api/team/people/automation', { id: personOf(el), automationSuites: el.value === 'all' || el.value === 'none' ? el.value : [el.value.replace(/^s:/, '')] });
    }
  };
  function personOf(el) { return String(el.bind || '').split(':').slice(2).join(':'); }

  document.addEventListener('click', function (e) {
    var modal = $('modal');
    if (modal && e.target === modal) { closeModal(); return; }
    if (e.target.classList && e.target.classList.contains('au-link-pop')) { auLinkClose(); return; } // a click outside the Link a suite popup
    if (S.dlMenu && !e.target.closest('.dl-wrap')) { S.dlMenu = null; render(); }
    if (S.ddOpen && !e.target.closest('.multi')) { S.ddOpen = null; S.ddQ = ''; render(); }
    if (S.helpOpen && !e.target.closest('.help-wrap')) setHelp(false);
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { ACTIONS[el.getAttribute('data-action')](el, e); return; }
    var fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  // A ? hidden with Escape shows again once the pointer or focus has left it.
  ['mouseout', 'focusout'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var w = e.target.closest && e.target.closest('.help-wrap, .info-wrap');
      if (w && !w.contains(e.relatedTarget)) w.classList.remove('shut');
    });
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

  // The left column sticks under the header: keep its height right when the window is resized.
  window.addEventListener('resize', function () {
    var tb = document.querySelector('.topbar');
    if (tb) document.documentElement.style.setProperty('--header-h', tb.offsetHeight + 'px');
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'search') { S.filters.search = el.value; S.keep = {}; render(); return; }
    if (el.id === 'auQ') { S.auto.q = el.value; render(); return; }
    if (el.hasAttribute('data-dd-q')) { S.ddQ = el.value; render(); return; }
    if (el.hasAttribute('data-bind') && el.type !== 'checkbox') S.form[el.getAttribute('data-bind')] = el.value;
    if (el.hasAttribute('data-live')) { render(); return; }
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
    var hw = document.querySelector('.help-wrap');
    if (e.key === 'Escape' && hw && (S.helpOpen || hw.matches(':hover, :focus-within'))) { setHelp(false); return; }
    if (e.key === 'Escape' && S.dlMenu) { S.dlMenu = null; render(); return; }
    if (e.key === 'Escape' && S.ddOpen) { var ddb = document.querySelector('.multi-btn[data-dd="' + S.ddOpen + '"]'); S.ddOpen = null; S.ddQ = ''; render(); if (ddb && ddb.id) { var nb = $(ddb.id); if (nb) nb.focus(); } return; }
    var iw = e.key === 'Escape' && document.activeElement && document.activeElement.closest && document.activeElement.closest('.info-wrap');
    if (iw) { iw.classList.add('shut'); return; } // a focused i: its tooltip hides until focus leaves
    if (e.key === 'Escape' && S.auto.linkOpen) { auLinkClose(); return; } // the Link a suite popup
    if (e.key === 'Enter' && e.target && e.target.hasAttribute && e.target.hasAttribute('data-dd-q')) {
      // Enter in the search box: take the first match (single choice), or the typed value
      e.preventDefault();
      var first = e.target.closest('.multi-pop').querySelector('.dd-list button.dd-item');
      if (first) first.click();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || modalOpen) return;
    var t = e.target && e.target.matches ? e.target : document.body;
    if (t.matches('input, textarea, select')) {
      if (t.id === 'cycRename' && e.key === 'Enter') { e.preventDefault(); renameCycle(); return; }
      if (t.id === 'cycRename' && e.key === 'Escape') { delete S.form.cycRen; delete S.form['cycRen:label']; render(); return; }
      if (e.key === 'Escape') { t.blur(); return; }
      if (e.key === 'Enter' && !e.shiftKey && t.hasAttribute('data-comment')) { e.preventDefault(); t.blur(); saveNote(); }
      if (e.key === 'Enter' && t.hasAttribute('data-issue')) { e.preventDefault(); addIssueLink(); }
      if (e.key === 'Enter' && t.hasAttribute('data-tags')) { e.preventDefault(); addTag(t); }
      if (e.key === 'Enter' && t.id === 'fText') { e.preventDefault(); ACTIONS['add-finding'](); }
      if (e.key === 'Enter' && t.id === 'auExclude') { e.preventDefault(); ACTIONS['au-exclude-add'](); }
      if (e.key === 'Enter' && !e.shiftKey && (t.id === 'retireReason' || t.id === 'dupReason')) { e.preventDefault(); t.blur(); retireCase(t.id === 'dupReason' ? 'duplicate' : 'deprecated'); }
      return;
    }
    if (S.view === 'automation' && (e.key === 'Enter' || e.key === ' ') && t.matches('tr[data-action="au-test"]')) { e.preventDefault(); ACTIONS['au-test'](t); return; }
    if (S.view !== 'run' || !S.model) return;
    var k = e.key;
    if ((k === 'Enter' || k === ' ') && t.classList && t.classList.contains('case')) { e.preventDefault(); select(t.getAttribute('data-key'), true); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (k === '/') { e.preventDefault(); var s = $('search'); if (s) s.focus(); return; }
    if (k === '?') { ACTIONS.help(); return; }
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

  // Automation › Import results: results files dropped on the drop area
  document.addEventListener('dragover', function (e) {
    var d = e.target.closest && e.target.closest('#auDrop');
    if (!d) return;
    e.preventDefault();
    d.classList.add('over');
  });
  document.addEventListener('dragleave', function (e) {
    var d = e.target.closest && e.target.closest('#auDrop');
    if (d && !d.contains(e.relatedTarget)) d.classList.remove('over');
  });
  document.addEventListener('drop', function (e) {
    var d = e.target.closest && e.target.closest('#auDrop');
    if (!d) return;
    e.preventDefault();
    auChoose(e.dataTransfer && e.dataTransfer.files);
  });

  window.__TR_STATE = S; // for the browser tests
  init();
})();
