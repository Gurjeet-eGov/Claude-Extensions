/* Test Run summary page: read-only figures for one tab and cycle. */
(function () {
  'use strict';
  var esc = TR.esc;
  var P = {};
  new URLSearchParams(location.search).forEach(function (v, k) { P[k] = v; });
  TR.state.book = P.book || null;
  var state = { tab: null, cycle: P.cycle || '' };
  var main = document.getElementById('main');

  function load() {
    main.innerHTML = '<div class="loading">Working out the figures&hellip;</div>';
    TR.api('api_summary', state.tab, state.cycle).then(function (r) {
      if (!r.ok) { main.innerHTML = '<div class="banner bad">' + esc(r.error) + '</div>'; return; }
      state.cycle = r.cycle;
      var cp = document.getElementById('cyclePick');
      cp.innerHTML = r.cycles.map(function (c) { return '<option value="' + esc(c.label) + '"' + (c.label === r.cycle ? ' selected' : '') + '>' + esc(c.label ? 'Cycle ' + c.label : 'Status') + '</option>'; }).join('');
      cp.classList.toggle('hidden', r.cycles.length < 2);
      document.title = 'Test Run summary: ' + r.tab;
      main.innerHTML = '<div class="summary-head"><h1>' + esc(r.tab) + '</h1><span class="muted">cycle ' + esc(r.cycle || '–') +
        (r.release ? ' · release ' + esc(r.release) : '') + ' · as of ' + esc(r.generatedAt) + '</span></div>' + TR.summaryHtml(r);
    });
  }

  TR.connect().then(function (c) {
    if (!c.ok) {
      // No Test Run to ask: the published reports are on the console's page, for anyone.
      main.innerHTML = '<div class="banner"><span>' + (c.code === 'UNREACHABLE' ? 'The Test Run server is not answering.' : 'This page shows live figures from a Test Run you have an access link for.') +
        '</span><span class="grow"></span><a class="btn" href="./">See the published reports</a></div>';
      return null;
    }
    return TR.api('api_bootstrap');
  }).then(function (b) {
    if (!b) return;
    if (!b.ok) { main.innerHTML = '<div class="banner bad">' + esc(b.error) + '</div>'; return; }
    TR.state.book = b.book || TR.state.book;
    document.getElementById('sheetName').textContent = b.sheetName;
    var tabs = b.tabs.filter(function (t) { return ((t.saved && t.saved.role) || t.detected.role) === 'manual'; });
    if (!tabs.length) { main.innerHTML = '<div class="empty card"><p>No test case tabs yet.</p></div>'; return; }
    state.tab = tabs.some(function (t) { return t.name === P.tab; }) ? P.tab : tabs[0].name;
    var tp = document.getElementById('tabPick');
    tp.innerHTML = tabs.map(function (t) { return '<option' + (t.name === state.tab ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
    tp.classList.toggle('hidden', tabs.length < 2);
    load();
  });

  document.getElementById('tabPick').addEventListener('change', function (e) { state.tab = e.target.value; state.cycle = ''; load(); });
  document.getElementById('cyclePick').addEventListener('change', function (e) { state.cycle = e.target.value; load(); });
  document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
})();
