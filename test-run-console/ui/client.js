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
    connect: null, // why the page could not reach a server ({ code }), shown as the Connect screen
    writeUp: {}, // finding key -> draft test case being written up
    covering: null, // finding key being marked as already covered
    issues: null, // Known issues: { issues, tabs, fetching, github } from the server
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
        var want = names.indexOf(PARAMS.book) >= 0 ? PARAMS.book : (names.indexOf(a.last.book) >= 0 ? a.last.book : names[0]);
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
    var m = S.model;
    var h = '<header class="topbar"><div class="topbar-row"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Test Run</span></div><span class="grow"></span><div class="pickers">';
    if (S.app) {
      h += '<label class="sr" for="bookPick">Workbook</label><select id="bookPick" data-change="book" title="Workbook">' +
        (S.app.books.length ? S.app.books.map(function (x) { return opt(x.name, x.name.replace(/\.xlsx$/i, ''), x.name === book()); }).join('') : '<option value="">No workbooks yet</option>') + '</select>' +
        (isOwner() ? '<button class="ghost" data-action="import" title="Add an .xlsx workbook to the sheets folder">Import</button>' : '') +
        (book() ? '<button class="ghost" data-action="download" title="Download this workbook, e.g. to upload it to Google Sheets">Download</button>' : '');
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
    var who = me();
    h += '</div>' + (who.name ? '<span class="who" title="' + (who.local ? 'Results are marked as tested by this name (change it in Setup)' : 'Signed in with your invite link') + '">' + esc(who.name) +
      (who.local ? '' : ' · ' + (who.role === 'viewer' ? 'viewer' : 'tester')) + '</span>' : '') + '</div>';
    if (m && m.cases.length && m.cycles.length) {
      var live = liveCases();
      var c = TR.counts(live.map(clsOf));
      var done = Math.round(((c.total - c.none) / (c.total || 1)) * 100);
      var nRet = m.cases.length - live.length;
      h += '<div class="topbar-row progress-wrap">' + TR.bar(c) + TR.legend(c) +
        (nRet ? '<span class="small muted" title="Deprecated or duplicate cases: struck out in the workbook and left out of these figures"><span class="sym-none">⊘</span> <b>' + nRet + '</b> retired</span>' : '') +
        '<span class="small muted"><b>' + done + '%</b> done</span></div>';
    }
    h += '<nav class="nav" aria-label="Screens">' + VIEWS.filter(function (v) { return !v.owner || isOwner(); }).map(function (v) {
      var n = v.id === 'findings' ? S.findings.filter(function (f) { return f.state === 'open' && (!f.tab || f.tab === S.tab); }).length
        : v.id === 'issues' && S.issues && S.issues.issues ? S.issues.issues.filter(function (e) { return e.state !== 'closed'; }).length : 0;
      return '<button data-action="view" data-view="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '>' + v.label + (n ? ' <span class="count">' + n + '</span>' : '') + '</button>';
    }).join('') + '</nav></header>';
    return h;
  }

  /** Shown when the page cannot reach a Test Run server, or needs an invite link to. */
  function viewConnect() {
    var c = S.connect;
    var conn = TR.conn();
    var msg = {
      NO_SERVER: ['Connect to a Test Run', 'Open the invite link your test lead sent you, or paste it below.'],
      NEED_KEY: ['This Test Run is shared by invite', 'Paste the invite link your test lead sent you.'],
      BAD_KEY: ['Your invite link no longer works', 'It may have been replaced or removed. Ask your test lead for a new link and paste it below.'],
      UNREACHABLE: ['The Test Run server is not answering', 'The laptop that runs it may be asleep, offline or restarting. This page keeps your invite, so try again in a moment.' + (conn.gist ? ' Its new address is picked up by itself once it is back.' : ' If its address changed, paste the new link below.')],
      BAD_LINK: ['That is not an invite link', 'An invite link ends in #join=… . Copy the whole link.']
    }[c.code] || ['Cannot connect', c.error || ''];
    return '<div class="empty card connect"><h3>' + esc(msg[0]) + '</h3><p>' + esc(msg[1]) + '</p>' +
      '<div class="row" style="margin-top:14px;justify-content:center"><label class="sr" for="inviteLink">Invite link</label><input id="inviteLink" data-bind="inviteLink" placeholder="https://…#join=…" value="' + esc(val('inviteLink')) + '" style="min-width:min(460px,100%)">' +
      '<button class="primary" data-action="use-invite">Connect</button></div>' +
      (c.code === 'UNREACHABLE' ? '<p style="margin-top:10px"><button data-action="retry-connect">Try again</button></p>' : '') +
      (conn.hasKey ? '<p class="small faint" style="margin-top:14px"><button class="ghost small-btn" data-action="forget-invite">Forget the invite kept in this browser</button></p>' : '') +
      '<p class="small faint" style="margin-top:10px">Running Test Run on this computer yourself? Open <span class="mono">http://127.0.0.1:5178</span> instead.</p></div>';
  }

  function body() {
    if (S.connect) return viewConnect();
    if (S.fatal) return '<div class="banner bad"><div><b>The console could not start.</b><div class="small">' + esc(S.fatal) + '</div></div></div>';
    if (S.app && !S.app.books.length) {
      if (!isOwner()) return '<div class="empty card"><h3>No workbooks yet</h3><p>Your test lead has not added a workbook to this Test Run yet.</p></div>';
      return '<div class="empty card"><h3>No workbooks yet</h3><p>Put your test case <b>.xlsx</b> files in<br><span class="mono">' + esc(S.app.sheetsDir) + '</span><br>or import one here. They stay on this computer and are never committed to git.</p><p style="margin-top:14px"><button class="primary" data-action="import">Import a workbook</button></p></div>';
    }
    if (!S.boot) return '<div class="loading">Loading the workbook…</div>';
    var banners = '';
    if (S.readOnly) banners += me().role === 'viewer'
      ? '<div class="banner"><b>View only.</b><span class="muted">You can follow the run and the summary. Results are marked by testers.</span></div>'
      : '<div class="banner warn"><b>View only.</b><span class="muted">This workbook file is read-only on this computer, so results cannot be saved.</span></div>';
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
    var tierCounts = {};
    m.cases.forEach(function (c) { if (passes(c, true)) tierCounts[c.tier] = (tierCounts[c.tier] || 0) + 1; });
    var types = distinct('testType');
    var nRetired = m.cases.length - liveCases().length;
    var h = '<div class="toolbar">' +
      '<label class="sr" for="search">Search</label><input type="search" id="search" placeholder="Search ID, scenario, feature…  ( / )" value="' + esc(f.search) + '">' +
      '<div class="row" role="group" aria-label="Show">' +
      ['todo', 'failed', 'all'].concat(nRetired || f.show === 'retired' ? ['retired'] : []).map(function (s) {
        var label = { todo: 'To do', failed: 'Failed', all: 'All', retired: 'Retired <span class="n">' + nRetired + '</span>' }[s];
        var tip = s === 'retired' ? ' title="Deprecated and duplicate cases: struck out in the workbook, left out of the run"' : '';
        return '<button class="chip" data-action="show" data-show="' + s + '" aria-pressed="' + (f.show === s) + '"' + tip + '>' + label + '</button>';
      }).join('') + '</div>' +
      (types.length > 1 ? '<label class="sr" for="typePick">Test type</label><select id="typePick" data-change="type"><option value="">All types</option>' + types.map(function (t) { return opt(t, t, t === f.type); }).join('') + '</select>' : '') +
      '<span class="grow"></span>' +
      '<button class="ghost" data-action="collapse-all" title="Collapse all paths">Collapse</button><button class="ghost" data-action="expand-all" title="Expand all paths">Expand</button>' +
      '<button class="ghost" data-action="help" title="Keyboard shortcuts"><kbd>?</kbd></button></div>';
    h += '<div class="toolbar" role="group" aria-label="Risk filter"><span class="small muted" title="Untested cases, in the order worth running them">Focus:</span>' + S.boot.tiers.map(function (t) {
      var on = f.tiers.indexOf(t.id) >= 0;
      var label = t.id === 0 && m.release ? 'New in ' + m.release : t.label;
      return '<button class="chip" data-action="tier" data-tier="' + t.id + '" aria-pressed="' + on + '" title="' + esc(tierHelp(t.id)) + '">' + esc(label) + ' <span class="n">' + (tierCounts[t.id] || 0) + '</span></button>';
    }).join('') + '</div>';
    if (m.plan.source === 'plan') {
      h += '<div class="banner"><span>Paths follow a saved path plan' + (m.plan.savedAt ? ' from ' + esc(m.plan.savedAt) : '') + '.</span><span class="grow"></span>' +
        (isOwner() ? '<button data-action="clear-plan">Use automatic paths</button>' : '') + '</div>';
    }

    var vps = visiblePaths();
    if (!vps.length) {
      var all = TR.counts(liveCases().map(clsOf));
      var msg = f.show === 'todo' && all.none === 0 ? '<h3>Everything in this cycle has a result 🎉</h3><p>Switch to <b>All</b> to review, or open the Summary.</p>'
        : f.show === 'retired' && !nRetired ? '<h3>No retired cases</h3><p>Cases you deprecate or mark as a duplicate show up here, struck out.</p>'
        : '<h3>Nothing matches</h3><p>Clear the search or the focus filters.</p>';
      return h + '<div class="empty card">' + msg + '</div>';
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

  function casesDatalist() {
    return '<datalist id="dl_cases">' + liveCases().map(function (x) { return '<option value="' + esc(x.id || x.key) + '">' + esc(x.scenario.slice(0, 120)) + '</option>'; }).join('') + '</datalist>';
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
        esc((many ? c.tab + ' › ' : '') + (c.id || 'Row')) + '</button> <span class="small muted">' + esc(c.scenario.length > 70 ? c.scenario.slice(0, 68) + '…' : c.scenario) + '</span>' +
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
    var h = '<div class="toolbar"><label class="sr" for="issueQ">Search issues</label><input type="search" id="issueQ" data-bind="issueQ" data-live="1" placeholder="Search issue, title, test case…" value="' + esc(val('issueQ', '')) + '">' +
      '<div class="row" role="group" aria-label="Show">' +
      '<button class="chip" data-action="issue-show" data-show="open" aria-pressed="' + (show === 'open') + '">Open <span class="n">' + nOpen + '</span></button>' +
      '<button class="chip" data-action="issue-show" data-show="all" aria-pressed="' + (show === 'all') + '">All <span class="n">' + all.length + '</span></button></div>' +
      '<span class="grow"></span>' +
      (r.fetching ? '<span class="small muted">Getting titles from GitHub…</span>' : '') +
      (r.github && !S.readOnly && all.some(function (e) { return /^https:\/\/github\.com\//i.test(e.url); }) ? '<button class="ghost" data-action="issues-refresh"' + (r.fetching ? ' disabled' : '') + ' title="Get the latest title, state and priority of every GitHub issue">Refresh from GitHub</button>' : '') + '</div>';
    if (!all.length) {
      return h + '<div class="empty card"><h3>No known issues yet</h3><p>Paste an issue link on a test case in <b>Run</b>, or tick <b>Also add to Test Run</b> in Bug Reporter when you file a bug.<br>Each issue shows here with its title, priority and test cases.</p></div>';
    }
    if (!list.length) return h + '<div class="empty card"><h3>Nothing matches</h3><p>' + (show === 'open' && nOpen === 0 ? 'Every known issue is closed. Choose <b>All</b> to see them.' : 'Clear the search.') + '</p></div>';
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
    h += '</tbody></table></div></div>';
    h += '<p class="small faint section">Downloading the workbook adds these as a <b>Known issues</b> sheet. ' +
      (r.github ? 'Titles, states and priorities of GitHub issues come from GitHub, through the <span class="mono">gh</span> login on the laptop running Test Run; you can also type them.' : 'Type titles and priorities here, or install the GitHub CLI (<span class="mono">gh</span>) on the laptop running Test Run to fill them in from GitHub.') + '</p>';
    return h;
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
  function draftFromFinding(f) {
    var expected = [];
    String(f.details || '').split(/\r?\n/).forEach(function (l) {
      var m = l.match(/^Expected:\s*(.+)$/);
      if (m) expected.push(m[1].trim());
    });
    var area = String(f.area || '');
    var sub = distinct('group2').filter(function (x) { return x.toLowerCase() === area.toLowerCase(); })[0] || '';
    var feat = distinct('group1').filter(function (x) { return x.toLowerCase() === area.toLowerCase(); })[0] || '';
    return { scenario: f.text, issue: f.url || f.issue || '', fromFinding: f.key, subFeature: sub, feature: feat, testData: '', preCondition: '', expected: expected };
  }

  function findingCard(f, dis) {
    var h = '<div class="item finding"><div class="row"><span class="mono faint">' + esc(f.key) + '</span><b class="grow">' + esc(f.text) + '</b>' +
      (f.source === 'bug-reporter' ? '<span class="pill accent" title="Noted by the Bug Reporter extension when the issue was filed">from Bug Reporter</span>' : '') +
      (f.url ? '<a class="pill outline" href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.issue || 'issue') + ' ↗</a>' : (f.issue ? '<span class="pill outline">' + esc(f.issue) + '</span>' : '')) + '</div>' +
      (f.area ? '<div class="small muted">' + esc(f.area) + '</div>' : '') +
      (f.details ? '<div class="small ml finding-details">' + esc(TR.cellLines(f.details).join('\n')) + '</div>' : '') +
      '<div class="small faint">' + esc([f.by, f.at].filter(Boolean).join(' · ')) + '</div>';
    var draft = S.writeUp[f.key];
    if (draft) {
      return h + '<div class="writeup">' + scenarioEditor(draft, 'wu:' + f.key,
        '<button class="ghost" data-action="writeup-cancel" data-key="' + esc(f.key) + '">Cancel</button><button class="primary" data-action="writeup-add" data-key="' + esc(f.key) + '"' + dis + '>Add to workbook</button>') + '</div></div>';
    }
    if (S.covering === f.key) {
      return h + '<div class="row" style="margin-top:8px"><label for="covId">Already covered by case</label><input id="covId" list="dl_cases" data-bind="cov:' + esc(f.key) + '" placeholder="e.g. ' + esc((liveCases()[0] || {}).id || 'CMS/12') + '" value="' + esc(val('cov:' + f.key)) + '">' +
        '<button class="ghost" data-action="cover-cancel">Cancel</button><button class="primary" data-action="cover-save" data-key="' + esc(f.key) + '"' + dis + '>Mark covered</button></div></div>';
    }
    if (S.readOnly) return h + '</div>';
    return h + '<div class="row" style="margin-top:8px"><button class="primary" data-action="writeup" data-key="' + esc(f.key) + '"' + dis + '>Write up as test case</button>' +
      '<button data-action="cover" data-key="' + esc(f.key) + '"' + dis + '>Already covered…</button><span class="grow"></span>' +
      '<button class="ghost danger" data-action="del-finding" data-key="' + esc(f.key) + '"' + dis + '>Delete</button></div></div>';
  }

  /**
   * Findings: bugs and scenarios found while testing that are not in the test
   * cases yet (noted by hand or by Bug Reporter). Each is written up here as a
   * test case, which adds it to the workbook, or marked as already covered.
   */
  function viewFindings() {
    var dis = S.readOnly ? ' disabled' : '';
    var list = S.findings.filter(function (f) { return !f.tab || f.tab === S.tab; });
    var open = list.filter(function (f) { return f.state === 'open'; });
    var done = list.filter(function (f) { return f.state !== 'open'; });
    var h = datalists() + casesDatalist();
    h += '<div class="row section-head"><div class="grow"><h2>Findings in ' + esc(S.tab) + '</h2><p class="small muted">Bugs and scenarios found while testing that are not in the test cases yet. Write each one up: it is added to the workbook as a test case. Or mark it as already covered.</p></div>' +
      (S.readOnly ? '' : '<button data-action="new-case"' + dis + '>+ New test case</button>') + '</div>';
    S.manual.forEach(function (it, i) {
      h += '<div class="section"><div class="small muted" style="margin-bottom:4px">New test case</div>' +
        scenarioEditor(it, 'man:' + i, '<button class="ghost" data-action="discard-manual" data-index="' + i + '">Discard</button><button class="primary" data-action="add-manual" data-index="' + i + '"' + dis + '>Add to workbook</button>') + '</div>';
    });
    if (!S.readOnly) {
      h += '<details class="card card-pad section"' + (val('noteOpen') ? ' open' : '') + '><summary class="small"><b>Note a finding by hand</b> <span class="muted">(Bug Reporter adds them for you when you tick the Test Run box while filing)</span></summary>' +
        '<div class="form-grid" style="margin-top:10px"><div class="wide"><label for="fText">What did you find?</label><input id="fText" data-bind="fText" placeholder="e.g. Citizen cannot reopen a complaint resolved 4 days ago" value="' + esc(val('fText')) + '"' + dis + '></div>' +
        '<div><label for="fIssue">Issue link <span class="faint">(optional)</span></label><input id="fIssue" data-bind="fIssue" placeholder="https://…/issues/123" value="' + esc(val('fIssue')) + '"' + dis + '></div>' +
        '<div><label for="fArea">Area</label><select id="fArea" data-bind="fArea"' + dis + '><option value="">Not sure</option>' + areas().map(function (a) { return opt(a, a, val('fArea') === a); }).join('') + '</select></div>' +
        '<div class="wide"><label for="fDetails">Details (optional)</label><textarea id="fDetails" data-bind="fDetails" rows="2"' + dis + '>' + esc(val('fDetails')) + '</textarea></div></div>' +
        '<div class="row" style="margin-top:8px"><span class="grow"></span><button class="primary" data-action="add-finding"' + dis + '>Save finding</button></div></details>';
    }
    h += '<div class="section stack">';
    if (!open.length) h += '<div class="empty card"><p>Nothing waiting. Findings from Bug Reporter show up here.</p></div>';
    open.forEach(function (f) { h += findingCard(f, dis); });
    h += '</div>';
    if (done.length) {
      h += '<details class="section"><summary class="small muted">Done: ' + done.length + ' written up or already covered</summary><div class="card table-wrap" style="margin-top:8px"><table><tbody>' +
        done.map(function (f) {
          var st = f.state === 'written' ? pill('pass', 'Written up' + (f.caseId ? ' as ' + f.caseId : '')) : pill('none', 'Covered' + (f.caseId ? ' by ' + f.caseId : ''));
          return '<tr><td class="mono faint">' + esc(f.key) + '</td><td>' + esc(f.text) + '</td><td>' + st + '</td><td class="num">' + (S.readOnly ? '' : '<button class="ghost" data-action="reopen-finding" data-key="' + esc(f.key) + '">Reopen</button>') + '</td></tr>';
        }).join('') + '</tbody></table></div></details>';
    }
    var elsewhere = S.findings.filter(function (f) { return f.tab && f.tab !== S.tab && f.state === 'open'; });
    if (elsewhere.length) h += '<p class="small muted section">' + elsewhere.length + ' more open finding' + (elsewhere.length === 1 ? ' is' : 's are') + ' in other tabs.</p>';
    return h;
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
      if (!d.always && !hasField(d.col)) { if (String(v).trim()) unmapped.push(d.label.replace(/ \(.*\)$/, '') + ': "' + String(v).slice(0, 60) + '"'); return; }
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
    var url = 'summary.html?book=' + encodeURIComponent(book()) + '&tab=' + encodeURIComponent(S.tab) + '&cycle=' + encodeURIComponent(label);
    var h = '<div class="summary-head"><h1>' + esc(r.tab) + '</h1><span class="muted">cycle ' + esc(r.cycle || '–') + (r.release ? ' · release ' + esc(r.release) : '') + ' · as of ' + esc(r.generatedAt) + '</span><span class="grow"></span>' +
      '<div class="row no-print"><a class="btn" href="' + esc(url) + '" target="_blank" rel="noopener">Open summary page</a>' +
      '<button data-action="export-summary" title="Save this summary as one HTML file you can send or attach">Export summary</button>' +
      (S.readOnly ? '' : '<button data-action="write-summary" title="Write these figures into a visible tab of the workbook">Update summary tab</button>') + '<button data-action="print">Print / PDF</button></div></div>';
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

  function checkLine(c, okText) {
    if (!c) return '';
    return '<div class="check-line ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '✓ ' + esc(okText || c.message) : '✗ ' + esc(c.message)) + ' <span class="faint">(' + esc(c.at) + ')</span></div>';
  }

  /** Setup → Team: who may use this Test Run, and how they reach this laptop. */
  function teamCard() {
    if (!S.app.me.local) return '';
    var r = S.team;
    var h = '<section class="section card card-pad stack" id="team"><h2>Team</h2>' +
      '<p class="small muted">Lets other testers mark results here at the same time, and managers follow the run and the summary. Each person opens their own invite link and installs nothing. Your laptop runs Test Run for everyone, so it must be on and awake while they work.</p>';
    if (!r) { loadTeam(); return h + '<div class="loading">Loading…</div></section>'; }
    var t = r.team;
    var a = r.address;
    h += '<label class="check"><input type="checkbox" data-action="team-enable"' + (t.enabled ? ' checked' : '') + '> Share this Test Run with my team</label>';
    if (!t.enabled) return h + '<p class="small faint">Off: only this computer can open Test Run.</p></section>';

    // 1. The way in
    h += '<div class="subsection"><h3>1. How your team reaches this laptop</h3>';
    h += '<div class="way-choice" role="radiogroup" aria-label="Way in">' +
      '<label class="way' + (t.mode === 'quick' ? ' on' : '') + '"><input type="radio" name="teamMode" data-action="team-mode" value="quick"' + (t.mode === 'quick' ? ' checked' : '') + '><span><b>Quick tunnel</b><span class="small muted">Free, no account. Gets a <b>new address every time it starts</b>, so links only last with the hosted page below.</span></span></label>' +
      '<label class="way' + (t.mode === 'fixed' ? ' on' : '') + '"><input type="radio" name="teamMode" data-action="team-mode" value="fixed"' + (t.mode === 'fixed' ? ' checked' : '') + '><span><b>Fixed address</b> <span class="pill accent">best for a team</span><span class="small muted">An address that never changes, so invite links keep working. Needs a one-time setup (Tailscale or a Cloudflare named tunnel).</span></span></label></div>';

    if (t.mode === 'quick') {
      if (a.tunnel.running || a.tunnel.reconnectIn != null) {
        h += '<div class="row"><span class="pill ' + (a.tunnel.url ? 'pass' : 'other') + '">' + (a.tunnel.url ? 'Shared' : a.tunnel.reconnectIn != null ? 'Reconnecting' : 'Starting') + '</span>' +
          '<span class="mono">' + esc(a.tunnel.url || (a.tunnel.reconnectIn != null ? 'trying again in ' + a.tunnel.reconnectIn + ' s' : 'opening the tunnel…')) + '</span><span class="grow"></span><button data-action="team-share" data-on="0">Stop sharing</button></div>';
      } else if (a.tunnel.available) {
        h += '<div class="row"><button class="primary" data-action="team-share" data-on="1">Start sharing over the internet</button><span class="small muted">Opens a Cloudflare quick tunnel to this laptop.</span></div>';
      } else {
        h += '<div class="note info">Install <span class="mono">cloudflared</span> first: <span class="mono">brew install cloudflared</span>. Then press Start here, or run <span class="mono">npm run share</span>.</div>';
      }
      if (a.tunnel.error) h += '<div class="note ' + (a.tunnel.reconnectIn != null ? 'info' : 'bad') + '">' + esc(a.tunnel.error) + '</div>';
      h += '<p class="small faint">If the tunnel drops (sleep, Wi-Fi change), Test Run opens it again by itself. Sharing also starts again when you restart Test Run, until you press Stop.</p>';

      // Links that outlive the address
      var hc = r.checks.hosted;
      var live = !!(hc && hc.ok);
      h += '<div class="stack-s"><h4>Keep invite links working when the address changes</h4>' +
        '<p class="small muted">Invite links open the console on GitHub Pages (the hosted page). Test Run keeps its current address in a secret GitHub gist, and the hosted page looks it up there each time. Without both, a link stops working when the address changes and you send new links.</p>' +
        '<label class="check"><input type="checkbox" data-action="team-publish"' + (t.publish ? ' checked' : '') + '> Keep the current address in a secret gist <span class="faint">(uses your <span class="mono">gh</span> login)</span></label>' +
        (t.gist ? '<div class="small muted" style="margin-left:24px">Gist <a href="https://gist.github.com/' + esc(t.gist) + '" target="_blank" rel="noopener" class="mono">' + esc(t.gist.slice(0, 8)) + '…</a>' + (t.publishedUrl ? ' points at <span class="mono">' + esc(t.publishedUrl) + '</span>' : '') + (t.publishedAt ? ', updated ' + esc(t.publishedAt) : '') + '.</div>' : '') +
        (t.publishError ? '<div class="note bad">' + esc(t.publishError) + '</div>' : '') +
        '<div class="form-grid"><div class="wide"><label for="teamHosted">Hosted page</label><div class="row"><input id="teamHosted" class="grow" type="url" data-bind="team:hostedUrl" placeholder="' + esc(r.suggest.hostedUrl || 'https://you.github.io/repo/test-run/') + '" value="' + esc(val('team:hostedUrl', t.hostedUrl)) + '">' +
        (r.suggest.hostedUrl && r.suggest.hostedUrl !== t.hostedUrl ? '<button class="ghost" data-action="team-use" data-field="hostedUrl" data-value="' + esc(r.suggest.hostedUrl) + '" title="This repository\'s GitHub Pages address">Use ' + esc(r.suggest.hostedUrl.replace(/^https:\/\//, '')) + '</button>' : '') +
        '<button data-action="team-save">Save</button></div>' + checkLine(hc, 'Live: invite links open there.') + '</div></div>';
      if (t.hostedUrl && hc && !hc.ok) {
        h += '<div class="note info stack-s"><div><b>To put the console on GitHub Pages</b> (once):</div><ol class="small"><li>In the repository on GitHub: <b>Settings → Pages → Source: GitHub Actions</b>.</li><li>Merge this branch into <span class="mono">master</span>. The <i>Test Run Pages</i> workflow then publishes the console at <span class="mono">' + esc(r.suggest.hostedUrl || 'https://<owner>.github.io/<repo>/test-run/') + '</span>.</li><li>Press <b>Check</b> here. Until it is live, new invite links name the current tunnel address instead.</li></ol><div><button data-action="team-check">Check</button></div></div>';
      }
      h += '<div class="links-verdict small">' + (t.publish && t.gist && live ? '✓ Invite links keep working when the address changes.' : 'Invite links name the current address: when the tunnel restarts, they stop working and you make new ones' + (t.publish && live ? ' (until the gist is written).' : '.')) + '</div></div>';
    } else {
      var fc = r.checks.fixed;
      h += '<div class="form-grid"><div class="wide"><label for="teamFixed">Fixed address</label><div class="row"><input id="teamFixed" class="grow" type="url" data-bind="team:fixedUrl" placeholder="https://my-mac.tail1234.ts.net" value="' + esc(val('team:fixedUrl', t.fixedUrl)) + '">' +
        (r.suggest.tailscaleUrl && r.suggest.tailscaleUrl !== t.fixedUrl ? '<button class="ghost" data-action="team-use" data-field="fixedUrl" data-value="' + esc(r.suggest.tailscaleUrl) + '" title="This Mac\'s Tailscale address">Use ' + esc(r.suggest.tailscaleUrl.replace(/^https:\/\//, '')) + '</button>' : '') +
        '<button data-action="team-check"' + (t.fixedUrl ? '' : ' disabled') + '>Check</button></div>' + checkLine(fc) + '</div>' +
        '<div class="wide"><label for="teamTunnel">Cloudflare named tunnel <span class="faint">(optional: Test Run runs it while sharing, and starts it again if it drops)</span></label><input id="teamTunnel" data-bind="team:tunnelName" placeholder="e.g. test-run" value="' + esc(val('team:tunnelName', t.tunnelName)) + '"></div></div>' +
        '<div class="row"><span class="grow"></span><button data-action="team-save">Save</button></div>';
      if (t.tunnelName) {
        h += a.tunnel.running || a.tunnel.reconnectIn != null
          ? '<div class="row"><span class="pill ' + (a.tunnel.url ? 'pass' : 'other') + '">' + (a.tunnel.url ? 'Tunnel running' : 'Reconnecting') + '</span><span class="mono">' + esc(t.tunnelName) + '</span><span class="grow"></span><button data-action="team-share" data-on="0">Stop the tunnel</button></div>'
          : '<div class="row"><button class="primary" data-action="team-share" data-on="1"' + (a.tunnel.available ? '' : ' disabled') + '>Start tunnel ' + esc(t.tunnelName) + '</button></div>';
        if (a.tunnel.error) h += '<div class="note ' + (a.tunnel.reconnectIn != null ? 'info' : 'bad') + '">' + esc(a.tunnel.error) + '</div>';
      }
      var port = r.suggest.port || 5178;
      h += '<details class="how"' + (t.fixedUrl ? '' : ' open') + '><summary class="small"><b>How to get a fixed address</b></summary><div class="small stack-s">' +
        '<div><b>Tailscale Funnel</b> (free, no domain needed)<ol><li>Install Tailscale on this Mac (<span class="mono">brew install --cask tailscale</span>, or from the App Store) and sign in.</li><li>In Terminal: <span class="mono">tailscale funnel --bg ' + port + '</span>. The first time, it gives you a link to allow Funnel for your account.</li><li>Your address is <span class="mono">https://&lt;this-mac&gt;.&lt;tailnet&gt;.ts.net</span> (<span class="mono">tailscale funnel status</span> shows it). Enter it above and press Check. It keeps working after restarts.</li></ol></div>' +
        '<div><b>Cloudflare named tunnel</b> (needs a domain you manage in Cloudflare)<ol><li><span class="mono">cloudflared tunnel login</span></li><li><span class="mono">cloudflared tunnel create test-run</span></li><li><span class="mono">cloudflared tunnel route dns test-run testrun.your-domain.org</span></li><li>Enter <span class="mono">https://testrun.your-domain.org</span> above and <span class="mono">test-run</span> as the tunnel name, then Start.</li></ol></div>' +
        '<div class="faint">Teammates need nothing installed for either: they just open their invite link.</div></div></details>';
    }
    h += '<div class="small muted">Now reached at: ' + (a.effective ? '<span class="mono">' + esc(a.effective) + '</span>' : '<b>no address yet</b>') + '</div></div>';

    // 2. People
    h += '<div class="subsection"><h3>2. People</h3>';
    if (S.teamLink) {
      h += '<div class="note info stack-s"><span>Invite link for <b>' + esc(S.teamLink.name) + '</b>. Send it to them privately. If they lose it, <b>Copy link</b> in the list gives you the same link again.</span>' +
        '<div class="row"><input id="teamLink" readonly value="' + esc(S.teamLink.link) + '" class="grow mono"><button class="primary" data-action="copy-link">Copy</button><button class="ghost" data-action="hide-link">Done</button></div>' +
        (S.teamLink.warn ? '<span class="small">' + esc(S.teamLink.warn) + '</span>' : '') + '</div>';
    }
    if (r.people.length) {
      h += '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Can</th><th>Last seen</th><th></th></tr></thead><tbody>' + r.people.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td><select aria-label="What ' + esc(p.name) + ' can do" data-change="team-role" data-id="' + esc(p.id) + '">' +
          opt('tester', 'Mark results', p.role === 'tester') + opt('viewer', 'View only', p.role === 'viewer') + '</select></td>' +
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
    h += '<div class="row"><label class="sr" for="teamName">Name</label><input id="teamName" data-bind="team:name" placeholder="Name, e.g. Priya (QA)" value="' + esc(val('team:name')) + '"' + off + '>' +
      '<label class="sr" for="teamRole">Can</label><select id="teamRole" data-bind="team:role"' + off + '>' + opt('tester', 'Mark results', val('team:role', 'tester') === 'tester') + opt('viewer', 'View only (managers)', val('team:role', 'tester') === 'viewer') + '</select>' +
      '<button data-action="team-add"' + off + '>Add and make a link</button></div>' +
      (r.canInvite ? '' : '<p class="small faint">Links need an address first: ' + (t.mode === 'quick' ? 'start sharing above.' : 'enter your fixed address above.') + '</p>') + '</div>';
    return h + '</section>';
  }

  /** Setup for one test case tab: the current cycle, starting a new one, the release in scope. */
  function cycleSetup(t, ti) {
    var saved = (S.cfg && S.cfg.tabs && S.cfg.tabs[t.name]) || {};
    var headers = (t.top && t.top[t.headerRow - 1]) || [];
    var cycles = headers.filter(isStatusHeader);
    var h = '<div class="subsection"><h3>Test cycles</h3><p class="small muted">A cycle is a pair of columns: <i>Test Status / name</i> and <i>Comment / name</i>. Earlier cycles stay, so you can compare.</p>' +
      '<div class="small">Status columns: ' + (cycles.length ? cycles.map(function (x) { return '<span class="pill outline">' + esc(String(x).replace(/\s+/g, ' ')) + '</span>'; }).join(' ') : '<span class="faint">none yet</span>') + '</div>';
    if (!t.saved) return h + '<p class="small faint">Save setup first to start cycles here.</p></div>';
    h += '<div class="row"><label class="sr" for="newCycle' + ti + '">New cycle name</label><input id="newCycle' + ti + '" data-bind="newCycle:' + ti + '" placeholder="New cycle, e.g. v2.20.1" value="' + esc(val('newCycle:' + ti)) + '">' +
      '<button data-action="start-cycle" data-tab="' + esc(t.name) + '" data-index="' + ti + '">Start new cycle</button><span class="small faint">Adds the two columns next to the latest cycle, with its dropdown and formatting.</span></div>';
    if (t.columns.release) {
      h += '<div class="row"><label for="release' + ti + '">Release in scope</label><input id="release' + ti + '" data-bind="release:' + ti + '" placeholder="e.g. 2.20.1" value="' + esc(val('release:' + ti, saved.release || '')) + '">' +
        '<button data-action="save-release" data-tab="' + esc(t.name) + '" data-index="' + ti + '">Save</button><span class="small faint">Cases whose Release column matches come first, as <b>New in release</b>.</span></div>';
    }
    return h + '</div>';
  }

  function viewSetup() {
    var d = setupDraft();
    var dis = S.readOnly ? ' disabled' : '';
    var h = '';
    if (!S.cfg) h += '<div class="banner"><div><b>Welcome.</b> Check how each tab of <b>' + esc(S.boot.sheetName) + '</b> was read, then save. Settings are kept beside the workbook in <span class="mono">sheets/.testrun/</span>; the workbook itself does not change.</div></div>';
    h += youCard() + teamCard();

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
      h += cycleSetup(t, ti) + '</section>';
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
        TR.saveBlob(new Blob([r.html], { type: 'text/html' }), r.name);
        toast('Summary saved as ' + r.name + ', one file you can send.');
      });
    },
    download: function () {
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
      var input = { text: text, issue: link ? '' : typed, url: link, area: val('fArea'), details: val('fDetails'), tab: S.tab };
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
      S.writeUp[f.key] = draftFromFinding(f);
      S.covering = null;
      render();
      var first = document.querySelector('.writeup textarea, .writeup input');
      if (first) first.focus();
    },
    'writeup-cancel': function (el) { var k = el.getAttribute('data-key'); delete S.writeUp[k]; clearForm('wu:' + k + ':'); render(); },
    'writeup-add': function (el) {
      var k = el.getAttribute('data-key');
      var d = collectDraft('wu:' + k, S.writeUp[k]);
      if (!String(d.scenario).trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
      el.disabled = true;
      queueWrite(function () { return api('api_addCases', S.tab, [d], cycleLabel()); }).then(function (r) {
        if (!r.ok) { el.disabled = false; writeError(r); return; }
        delete S.writeUp[k];
        clearForm('wu:' + k + ':');
        toast(k + ' added to the workbook as ' + (r.added[0].id || 'row ' + r.added[0].row) + '.');
        loadTab(cycleLabel(), true);
        loadSide();
      });
    },
    cover: function (el) { S.covering = el.getAttribute('data-key'); render(); var i = $('covId'); if (i) i.focus(); },
    'cover-cancel': function () { S.covering = null; render(); },
    'cover-save': function (el) {
      var k = el.getAttribute('data-key');
      var c = findCase(val('cov:' + k));
      if (!c) { toast('Type the ID of a case in this tab, e.g. ' + ((liveCases()[0] || {}).id || 'CMS/12') + '.', 'bad'); return; }
      queueWrite(function () { return api('api_setFindingState', k, 'covered', c.id || c.key); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        S.covering = null;
        delete S.form['cov:' + k];
        toast(k + ' is covered by ' + caseLabel(c) + '.');
        loadSide();
      });
    },
    'reopen-finding': function (el) {
      var k = el.getAttribute('data-key');
      queueWrite(function () { return api('api_setFindingState', k, 'open', ''); }).then(function (r) { if (!r.ok) writeError(r); else loadSide(); });
    },
    'new-case': function () { S.manual.unshift({ scenario: '', expected: [] }); render(); var f = document.querySelector('[id^="man_0_"]'); if (f) f.focus(); },
    'discard-manual': function (el) { S.manual.splice(parseInt(el.getAttribute('data-index'), 10), 1); render(); },
    'add-manual': function (el) {
      var i = parseInt(el.getAttribute('data-index'), 10);
      var d = collectDraft('man:' + i, S.manual[i]);
      if (!d.scenario.trim()) { toast('The scenario cannot be empty.', 'bad'); return; }
      el.disabled = true;
      queueWrite(function () { return api('api_addCases', S.tab, [d], cycleLabel()); }).then(function (r) {
        if (!r.ok) { el.disabled = false; writeError(r); return; }
        S.manual.splice(i, 1);
        clearForm('man:');
        toast('Added to the workbook as ' + (r.added[0].id || 'row ' + r.added[0].row) + '.');
        loadTab(cycleLabel(), true);
        loadSide();
      });
    },
    'write-summary': function () {
      queueWrite(function () { return api('api_writeSummaryTab', S.tab, cycleLabel()); }).then(function (r) {
        if (!r.ok) { writeError(r); return; }
        toast('The "' + r.sheet + '" tab in the workbook is up to date.');
      });
    },
    print: function () { window.print(); },
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
    'team-enable': function (el) { teamCall('/api/team', { enabled: el.checked }); },
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
    'team-mode': function (el) { teamCall('/api/team', { mode: el.value }); },
    'team-use': function (el) {
      var body = {};
      body[el.getAttribute('data-field')] = el.getAttribute('data-value');
      clearForm('team:' + el.getAttribute('data-field'));
      teamCall('/api/team', body, function () { toast('Saved.'); });
    },
    'team-check': function (el) { el.disabled = true; teamCall('/api/team/check'); },
    'team-share': function (el) {
      var on = el.getAttribute('data-on') === '1';
      el.disabled = true;
      if (on) toast(S.team.team.mode === 'fixed' ? 'Starting the tunnel…' : 'Opening a tunnel… this takes a few seconds.');
      teamCall('/api/team/share', { on: on });
    },
    'team-add': function () {
      var name = String(val('team:name')).trim();
      if (!name) { toast('Type their name first.'); var n = $('teamName'); if (n) n.focus(); return; }
      teamCall('/api/team/people', { name: name, role: val('team:role', 'tester') }, function (r) {
        S.teamLink = { name: name, link: r.link, warn: r.linkWarning };
        clearForm('team:name');
      });
    },
    'team-copy': function (el) {
      var id = el.getAttribute('data-id');
      var p = S.team.people.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      TR.http('POST', '/api/team/people/link', { id: id }).then(function (r) {
        if (!r.ok) { toast(r.error, 'bad'); return; }
        S.team = r;
        copyText(r.link).then(function (ok) {
          // Shown as well, in case copying is blocked or the warning matters
          S.teamLink = { name: p.name, link: r.link, warn: r.linkWarning };
          render();
          if (ok) toast(p.name + '\'s link is copied.');
          else { var t = $('teamLink'); if (t) t.select(); toast('Press Cmd+C (Ctrl+C) to copy the selected link.'); }
        });
      });
    },
    'team-rotate': function (el) {
      var id = el.getAttribute('data-id');
      var p = S.team.people.filter(function (x) { return x.id === id; })[0];
      if (!p || !window.confirm('Make a new link for ' + p.name + '? Their current link stops working.')) return;
      teamCall('/api/team/people/update', { id: id, rotate: true }, function (r) { S.teamLink = { name: p.name, link: r.link, warn: r.linkWarning }; });
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
        refreshBoot(true);
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

  var CHANGES = {
    book: function (el) { if (el.value) switchBook(el.value); },
    tab: function (el) {
      S.tab = el.value;
      TR.store.set('tab:' + book(), S.tab);
      S.selected = null;
      S.caseTool = null;
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
      if (S.model.configured && isOwner() && !S.readOnly) api('api_setTabPrefs', S.tab, { cycle: c.label });
      loadTab(c.label);
    },
    type: function (el) { S.filters.type = el.value; render(); },
    'team-role': function (el) { teamCall('/api/team/people/update', { id: el.getAttribute('data-id'), role: el.value }); }
  };

  document.addEventListener('click', function (e) {
    var modal = $('modal');
    if (modal && e.target === modal) { closeModal(); return; }
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { ACTIONS[el.getAttribute('data-action')](el, e); return; }
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
