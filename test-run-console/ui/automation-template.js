/*
 * Automation template: a clickable mock-up of the planned Automation screens, with fake data
 * from two different frameworks and no server calls. It uses the console's own styles
 * (styles.css) and helpers (shared.js), so it looks like Test Run. Served at
 * /automation-template.html while the design is reviewed; removed when the real screens are built.
 * Anything that only exists to review the design (screen list, variants, notes) sits in the
 * strip at the top, never inside a screen.
 */
(function () {
  'use strict';
  var esc = TR.esc, SYM = TR.SYM;

  var SCREENS = [
    [1, 'Suite and runs'], [2, 'Run'], [3, 'Running'], [4, 'Run results'], [5, 'Import results'], [6, 'Link a suite'],
    [7, 'Delete popup'], [8, 'Summary'], [9, 'Run with Auto badges'], [10, 'Published site'], [11, 'Setup › Access'], [12, 'Setup › Automation']
  ];

  var S = {
    screen: Number((location.hash.match(/s=(\d+)/) || [])[1]) || 1,
    suite: 'cms',
    filter: 'failed',      // 4: tests table filter
    sel: 0,                // 4: selected test
    open: { 0: true },     // 4: expanded causes
    file: true,            // 5: file chosen
    checked: true,         // 6: repository checked
    imported: true,        // 6: latest run imported
    sumView: 'manual',     // 8 and 10: manual | automated
    hasRuns: true,         // 8: does this cycle have automated runs (template variant)
    visitor: 'open',       // 10: unlocking | open | denied | nokey (template variant)
    ddOpen: null,          // the open dropdown
    v: {}                  // dropdown values, by name
  };

  // ---------------------------------------------------------------- fake data
  var SUITES = {
    cms: { name: 'CMS Automation', repo: 'Gurjeet-eGov/CMS-Automation', wf: 'Integration tests', artifact: 'test-results', format: 'JUnit XML' },
    notif: { name: 'Notifications API', repo: 'QA-Team/notification-tests', wf: 'API tests', artifact: 'ctrf-report', format: 'CTRF JSON' }
  };
  var BOOK = 'CMS Sign Off - CMS Automation (naipepea net-two)';
  var BOOKS = [BOOK, 'Bomet UAT sign-off', 'CMS Kenya regression'];
  var TABS = ['CMS 2.20.1', 'CMS 2.20.1 Features', 'Notifications'];
  var CYCLES = ['Cycle v2.12', 'Cycle v2.11', 'Cycle v2.10'];
  var RUNS = {
    cms: [
      { when: '24 Nov, 10:23', by: 'Gurjeet', how: 'from Test Run', branch: 'master', sha: '9629653', env: 'net_two', opts: 'smoke', p: 218, f: 24, s: 12, rate: 86, prev: 84, tab: 'CMS 2.20.1', cycle: 'Cycle v2.12' },
      { when: '22 Nov, 18:05', by: 'Priya', how: 'from Test Run', branch: 'master', sha: '1f0c2ab', env: 'net_two', opts: 'smoke', p: 211, f: 27, s: 16, rate: 84, tab: 'CMS 2.20.1', cycle: 'Cycle v2.12' },
      { when: '19 Nov, 09:40', by: 'schedule', how: 'imported', branch: 'master', sha: 'a33208c', env: 'naipepea', opts: 'full', p: 231, f: 9, s: 24, rate: 96, tab: 'CMS 2.20.1', cycle: 'Cycle v2.11' }
    ],
    notif: [
      { when: '23 Nov, 15:12', by: 'Rahul', how: 'imported (CTRF file)', branch: 'develop', sha: 'c81e09d', env: 'staging', opts: 'markers: sms', p: 64, f: 3, s: 1, rate: 95, prev: 96, tab: 'Notifications', cycle: 'Cycle v2.12' }
    ]
  };
  var CAUSES = [
    { msg: 'Timeout {n}ms exceeded waiting for getByRole(\'button\', { name: \'…\' })', n: 11, isNew: 2, tests: ['pgr/assign.spec.ts › GRO assigns the complaint to an LME', 'pgr/reassign.spec.ts › LME sends it back to GRO', 'inbox/filter.spec.ts › employee filters by locality', '… 8 more'] },
    { msg: 'expect(received).toHaveText(expected) · Expected: "…" · Received: "…"', n: 6, isNew: 1, tests: ['citizen/track.spec.ts › status shows "Resolved"', 'citizen/rate.spec.ts › rating stars show after resolve', '… 4 more'] },
    { msg: 'Request failed with status {n}: POST /pgr-services/v2/request/_search', n: 4, isNew: 0, tests: ['api/search.spec.ts › search by mobile number', 'api/search.spec.ts › search by locality', '… 2 more'] },
    { msg: 'Other messages (each seen once)', n: 3, isNew: 0, tests: ['admin/boundary.spec.ts › …', 'dashboard/kpi.spec.ts › …', 'profile/edit.spec.ts › …'] }
  ];
  var TESTS = [
    { st: 'fail', title: 'GRO assigns the complaint to an LME', file: 'pgr/assign.spec.ts', dur: '30.0 s', hist: ['pass', 'pass', 'fail'], isNew: true, tags: '@CMS/02 @area:pgr', msg: 'Timeout 30000ms exceeded waiting for getByRole(\'button\', { name: \'Assign\' })', stack: 'at AssignPage.assign (tests/pages/assign.page.ts:41:22)\nat tests/pgr/assign.spec.ts:18:5' },
    { st: 'fail', title: 'Status shows "Resolved" after the LME resolves', file: 'citizen/track.spec.ts', dur: '8.4 s', hist: ['fail', 'fail', 'fail'], tags: '@CMS/03', msg: 'expect(received).toHaveText(expected)\nExpected: "Resolved"\nReceived: "In progress"', stack: 'at tests/citizen/track.spec.ts:27:41' },
    { st: 'fail', title: 'Search by mobile number', file: 'api/search.spec.ts', dur: '1.2 s', hist: ['pass', 'fail', 'fail'], tags: '@api', msg: 'Request failed with status 500: POST /pgr-services/v2/request/_search\nauth-token: ***', stack: 'at ApiClient.post (tests/utils/api.ts:63:11)', masked: true },
    { st: 'pass', title: 'Citizen files a complaint with a photo', file: 'pgr/create.spec.ts', dur: '12.3 s', hist: ['pass', 'pass', 'pass'], tags: '@CMS/01' },
    { st: 'pass', title: 'Employee inbox lists the new complaint', file: 'inbox/list.spec.ts', dur: '5.2 s', hist: ['fail', 'pass', 'pass'], flaky: true, tags: '@area:inbox' },
    { st: 'other', title: 'Citizen reopens within 5 days', file: 'citizen/reopen.spec.ts', dur: '–', hist: ['other', 'other', 'other'], tags: '@CMS/04', msg: 'Skipped: needs a complaint resolved 5 days ago' }
  ];
  var USERS = [
    { name: 'Priya (QA)', role: 'Update status', books: 'All workbooks', suites: 'All suites', run: true, seen: 'today' },
    { name: 'Rahul (QA)', role: 'Update status', books: 'CMS Sign Off', suites: 'Notifications API', run: true, seen: 'yesterday' },
    { name: 'Meera (PM)', role: 'View only', books: 'All workbooks', suites: 'All suites', run: false, seen: '20 Nov' }
  ];

  var CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---------------------------------------------------------------- the console's dropdown (DESIGN.md › Dropdowns)
  /** name: where its value is kept; options: strings or {value, label, hint}; o: { value (default), prefix, cls, label, disabled, placeholder (empty allowed: a filter) } */
  function dd(name, options, o) {
    o = o || {};
    var opts = options.map(function (x) { return typeof x === 'string' ? { value: x, label: x } : x; });
    var value = S.v[name] != null ? S.v[name] : (o.value != null ? o.value : o.placeholder ? '' : opts[0].value);
    var hit = opts.filter(function (x) { return x.value === value; })[0];
    var text = hit ? hit.label : value || o.placeholder || 'Select';
    var open = S.ddOpen === name && !o.disabled;
    var h = '<div class="multi' + (o.cls ? ' ' + o.cls : '') + '" data-dd="' + esc(name) + '"><button type="button" class="multi-btn" data-action="dd-open" data-dd="' + esc(name) + '" aria-haspopup="true" aria-expanded="' + open + '"' +
      (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + (o.disabled ? ' disabled' : '') + '>' + (o.prefix ? '<span class="dd-prefix">' + esc(o.prefix) + '</span>' : '') +
      '<span class="grow' + (hit || value ? '' : ' dd-ph') + '">' + esc(text) + '</span>' + CHEVRON + '</button>';
    if (open) {
      h += '<div class="multi-pop"><div class="dd-list" role="listbox">' + opts.map(function (x) {
        var on = x.value === value;
        return '<button type="button" class="dd-opt dd-item' + (on ? ' on' : '') + '" role="option" aria-selected="' + on + '" data-action="dd-pick" data-dd="' + esc(name) + '" data-value="' + esc(x.value) + '"><span class="dd-label">' + esc(x.label) + '</span>' + (x.hint ? ' <span class="dd-hint">' + esc(x.hint) + '</span>' : '') + '</button>';
      }).join('') + '</div></div>';
    }
    return h + '</div>';
  }

  // ---------------------------------------------------------------- small helpers
  function field(label, control, hint, wide) {
    return '<div' + (wide ? ' class="wide"' : '') + '><label class="note-label">' + label + '</label>' + control + (hint ? '<span class="small muted">' + hint + '</span>' : '') + '</div>';
  }
  function counts(r) { return { pass: r.p, fail: r.f, other: r.s, none: 0, total: r.p + r.f + r.s }; }
  /** The previous run's figure, beside this one: "↑ from 84%". Green when it got better. */
  function from(cur, prev, unit, lowerIsBetter) {
    if (prev == null || prev === cur) return '';
    var up = cur > prev, good = lowerIsBetter ? !up : up;
    return '<span class="delta ' + (good ? 'good' : 'bad') + '" title="Previous run: ' + prev + (unit || '') + '">' + (up ? '↑' : '↓') + ' from ' + prev + (unit || '') + '</span>';
  }
  function resultCell(r) {
    return '<div class="stack-s">' + TR.bar(counts(r), true) + '<span class="small"><span class="sym-pass">' + SYM.pass + '</span> ' + r.p + ' &nbsp;<span class="sym-fail">' + SYM.fail + '</span> ' + r.f + ' &nbsp;<span class="sym-other">' + SYM.other + '</span> ' + r.s + '</span></div>';
  }
  function rateCell(r) { return '<b>' + r.rate + '%</b><div>' + from(r.rate, r.prev, '%') + '</div>'; }
  function legendAuto(r) {
    return '<div class="legend"><span><span class="sym-pass">' + SYM.pass + '</span> <b>' + r.p + '</b> passed</span><span><span class="sym-fail">' + SYM.fail + '</span> <b>' + r.f + '</b> failed</span><span><span class="sym-other">' + SYM.other + '</span> <b>' + r.s + '</b> skipped</span></div>';
  }
  function linkPath(r) { return '<span class="small">CMS Sign Off › ' + esc(r.tab) + ' › ' + esc(r.cycle) + '</span>'; }
  function hist(list) { return '<span class="hist" aria-label="Last runs: ' + list.join(', ') + '">' + list.map(function (c) { return TR.dot(c); }).join('') + '</span>'; }
  function kpi(v, l, extra, cls) { return '<div class="card kpi' + (cls ? ' ' + cls : '') + '"><div class="v">' + esc(v) + '</div><div class="l">' + esc(l) + (extra ? ' · ' + extra : '') + '</div></div>'; }
  function cyclePicker(req, tab) {
    return '<div class="stack-s"><label class="note-label">Attach the results to' + (req ? ' <span class="faint">(required)</span>' : '') + '</label><div class="link-path">' +
      dd('att:book', BOOKS, { prefix: 'Workbook', label: 'Workbook' }) + dd('att:tab', TABS, { prefix: 'Test suite', label: 'Test suite', value: tab || TABS[0] }) + dd('att:cycle', CYCLES, { prefix: 'Test cycle', label: 'Test cycle' }) + '</div>' +
      '<span class="small muted">Only people who can open this workbook can see the results. Test Run keeps the last 2 runs for each test suite and cycle.</span></div>';
  }
  function downloadBtn(title) { return '<button class="small-btn" title="' + esc(title) + '"><span aria-hidden="true">⤓</span> Download</button>'; }
  var RESET_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.25 8.5A5.25 5.25 0 1 1 11.7 4.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12.2 1.5v3.3H8.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /** A single-choice filter, as on Findings: nothing chosen = everything (the field reads Select); ↻ on the title's row clears it. */
  function railFilter(name, title, options) {
    var on = !!S.v[name];
    return '<div class="rail-group"><div class="rail-head"><span class="rail-title">' + esc(title) + '</span>' +
      '<button type="button" class="help-btn" data-action="dd-reset" data-dd="' + name + '" title="Show every ' + esc(title.toLowerCase()) + '" aria-label="Reset the ' + esc(title.toLowerCase()) + ' filter"' + (on ? '' : ' disabled') + '>' + RESET_ICON + '</button></div>' +
      dd(name, options, { placeholder: 'Select', label: title }) + '</div>';
  }
  function shownRuns(k) { return RUNS[k].filter(function (r) { return (!S.v['f:env'] || r.env === S.v['f:env']) && (!S.v['f:branch'] || r.branch === S.v['f:branch']); }); }
  function fullReport() {
    return '<span class="help-wrap"><button class="small-btn">↗ Full Report</button></span>' +
      '<span class="help-wrap"><button class="help-btn" aria-describedby="frTip" aria-label="About the full report">?</button>' +
      '<span class="tip" role="tooltip" id="frTip"><span class="tip-title">Full report</span>The suite\'s own report, traces, videos and logs, on its GitHub Actions run. Kept by GitHub for up to 90 days, or until it\'s deleted there. The results on this page stay in Test Run.</span></span>';
  }

  // ---------------------------------------------------------------- the template strip (review only)
  function strip() {
    var h = '<div class="tpl-row"><span class="tpl-tag">Template</span><span class="small muted">Fake data, nothing runs.</span><span class="grow"></span>' +
      SCREENS.map(function (s) { return '<button class="chip" data-action="screen" data-n="' + s[0] + '" aria-pressed="' + (S.screen === s[0]) + '">' + s[0] + ' · ' + esc(s[1]) + '</button>'; }).join('') + '</div>';
    var v = variants();
    return h + (v ? '<div class="tpl-row tpl-variant">' + v + '</div>' : '');
  }
  function variants() {
    function chips(key, list) { return list.map(function (x) { return '<button class="chip" data-action="variant" data-key="' + key + '" data-v="' + x[0] + '" aria-pressed="' + (String(S[key]) === String(x[0])) + '">' + x[1] + '</button>'; }).join(''); }
    if (S.screen === 8) return '<span class="small muted">Try:</span>' + chips('hasRuns', [[true, 'Cycle has automated runs'], [false, 'No automated runs yet']]) + '<span class="small muted">· The Manual view is today\'s Summary, unchanged (shortened here).</span>';
    if (S.screen === 10) return '<span class="small muted">Visitor:</span>' + chips('visitor', [['unlocking', 'Unlocking'], ['open', 'Invited'], ['denied', 'Not invited'], ['nokey', 'No invite link yet']]) + '<span class="small muted">· Manual results stay public, as today.</span>';
    if (S.screen === 11) return '<span class="small muted">"Sharing" renamed to <b>Access</b>. Online link and Your admin link are unchanged; <b>Users</b> is the new part.</span>';
    if (S.screen === 9) return '<span class="small muted">Run screen as today, plus the Auto ✓ / ✗ badges.</span>';
    return '';
  }

  // ---------------------------------------------------------------- chrome
  function topbar(view, ctx) {
    var tabs = [['run', 'Run'], ['issues', 'Known issues'], ['findings', 'Findings'], ['summary', 'Summary'], ['automation', 'Automation'], ['setup', 'Setup']];
    return '<header class="topbar"><div class="topbar-row"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Test Run</span></div><span class="grow"></span>' +
      dd('top:book', BOOKS, { cls: 'top-dd book-dd', prefix: 'Workbook', label: 'Workbook' }) +
      '<div class="user-menu"><button class="user-btn" title="Gurjeet · Host, on this laptop"><span class="avatar" aria-hidden="true">G</span><span class="user-name">Gurjeet</span><span class="caret" aria-hidden="true">▾</span></button></div></div>' +
      '<nav class="nav" aria-label="Screens">' + tabs.map(function (t) {
        return '<button data-action="nav" data-view="' + t[0] + '"' + (view === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + (t[0] === 'automation' && S.screen === 3 ? ' <span class="count" title="A run is going">1</span>' : '') + '</button>';
      }).join('') + '</nav>' + (ctx || '') + '</header>';
  }
  function page(view, content, wide, ctx) { return topbar(view, ctx) + '<main' + (wide ? ' class="wide"' : '') + '>' + content + '</main>'; }
  function withRail(r, content) { return '<div class="with-rail"><aside class="rail" aria-label="Side">' + r + '</aside><div class="rail-content stack">' + content + '</div></div>'; }
  function autoRail(active) {
    return '<div class="rail-group subtabs" role="tablist" aria-label="Automated suites"><span class="rail-title">Automated suites</span>' +
      Object.keys(SUITES).map(function (k) { return '<button role="tab" class="subtab" data-action="suite" data-suite="' + k + '" aria-selected="' + (active === k) + '">' + esc(SUITES[k].name) + '</button>'; }).join('') +
      '<button class="ghost" data-action="screen" data-n="6"' + (active === 'new' ? ' aria-pressed="true"' : '') + '>+ Link Suite</button></div>' +
      (active === 'new' ? '' : railFilter('f:env', 'Environment', ['net_two', 'naipepea', 'staging']) + railFilter('f:branch', 'Branch', ['master', 'develop', 'product-suite'])) +
      '<p class="small muted rail-note">Each suite runs in its own repository\'s GitHub Actions. Test Run starts runs and reads their results file (JUnit XML or CTRF JSON), whatever the framework.</p>';
  }
  function suiteHead(k, extra) {
    var s = SUITES[k];
    return '<section class="card card-pad"><div class="auto-head"><div class="grow"><h2>' + esc(s.name) + '</h2><p class="small muted"><a href="#" data-action="none">' + esc(s.repo) + ' ↗</a> · workflow ' + esc(s.wf) + ' · results: ' + esc(s.format) + ' in artifact <span class="mono">' + esc(s.artifact) + '</span></p></div>' +
      '<div class="row">' + (extra || '<button data-action="screen" data-n="5">⤒ Import Results</button><button class="primary" data-action="screen" data-n="2">▶ Run</button>') + '</div></div></section>';
  }
  function ctxBar() {
    return '<div class="context"><div class="context-row"><span class="ctx-label">Test suites</span><div class="ctx-tabs" role="tablist">' +
      TABS.map(function (t, i) { return '<button class="ctx-tab' + (i ? '' : ' on') + '" role="tab" aria-selected="' + !i + '">' + esc(t) + '</button>'; }).join('') +
      '</div><span class="grow"></span>' + dd('top:cycle', CYCLES, { cls: 'top-dd cycle-dd', prefix: 'Test cycle', label: 'Test cycle' }) + '</div>' +
      '<div class="progress-wrap">' + TR.bar({ pass: 4, fail: 2, other: 2, none: 10, total: 18 }) + TR.legend({ pass: 4, fail: 2, other: 2, none: 10, total: 18 }) + '</div></div>';
  }

  // ---------------------------------------------------------------- 1 · Suite and runs
  function screenSuite() {
    var k = S.suite;
    var h = suiteHead(k) + '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>Runs</h2><p class="small muted">The last 2 runs are kept for each test suite and cycle.</p></div><div class="table-wrap"><table><thead><tr><th>When</th><th>What ran</th><th>Result</th><th class="num">Pass rate</th><th>Attached to</th><th></th></tr></thead><tbody>' +
      (shownRuns(k).length ? '' : '<tr><td colspan="6" class="no-data">No runs match the filters</td></tr>') + shownRuns(k).map(function (r) {
        return '<tr><td class="nowrap">' + esc(r.when) + '<div class="small muted">' + esc(r.by) + ' · ' + esc(r.how) + '</div></td>' +
          '<td><span class="mono">' + esc(r.branch) + ' @ ' + esc(r.sha) + '</span><div class="small muted">' + esc(r.env) + ' · ' + esc(r.opts) + '</div></td>' +
          '<td style="min-width:150px">' + resultCell(r) + '</td><td class="num nowrap">' + rateCell(r) + '</td>' +
          '<td>' + linkPath(r) + '</td><td class="num"><button class="small-btn" data-action="screen" data-n="4">Open</button></td></tr>';
      }).join('') + '</tbody></table></div></section>';
    return page('automation', withRail(autoRail(k), h), true);
  }

  // ---------------------------------------------------------------- 2 · Run
  function screenRunForm() {
    var h = suiteHead('cms', '<button class="ghost" data-action="screen" data-n="1">Back</button>');
    h += '<section class="card card-pad stack"><div><h2>Start a run</h2><p class="small muted">Runs the workflow <b>Integration tests</b> in GitHub Actions, in Gurjeet-eGov/CMS-Automation. The options below come from that workflow.</p></div><div class="form-grid">' +
      field('Branch', dd('run:branch', [{ value: 'master', label: 'master', hint: 'default' }, 'product-suite'], { label: 'Branch' })) +
      field('environment', dd('run:env', ['naipepea', 'net_two', 'bomet'], { value: 'net_two', label: 'environment' }), 'Deployment to test') +
      field('scope', dd('run:scope', ['profile-only', 'smoke', 'api', 'full'], { value: 'smoke', label: 'scope' }), 'Which tests') +
      field('grep <span class="faint">(optional)</span>', '<input placeholder="e.g. @area:pgr">', 'Only tests whose title or tags match') +
      '</div>' + cyclePicker(true) +
      '<div class="row"><span class="small muted grow">Secrets come from the repository\'s GitHub environment <span class="mono">net_two</span>; nothing to upload.</span><button class="ghost" data-action="screen" data-n="1">Cancel</button><button class="primary" data-action="screen" data-n="3">Start Run</button></div></section>';
    return page('automation', withRail(autoRail('cms'), h), true);
  }

  // ---------------------------------------------------------------- 3 · Running
  function screenRunning() {
    var steps = [['pass', 'Set up job'], ['pass', 'Check out master @ 9629653'], ['pass', 'Install dependencies'], ['none', 'Run the tests', true], ['none', 'Upload test-results']];
    var h = suiteHead('cms', '<button class="ghost">↗ GitHub Log</button>');
    h += '<section class="card card-pad stack"><div class="auto-head"><div class="grow"><h2 class="row">' + TR.dot('none', true) + ' Running in GitHub Actions</h2>' +
      '<p class="small muted">master @ 9629653 · net_two · smoke · started by Gurjeet from Test Run at 10:23 · <b>06:42</b> so far</p>' + linkPath(RUNS.cms[0]) + '</div>' +
      '<div class="row"><button class="danger-outline">Cancel Run</button></div></div>' +
      '<div class="stack-s"><span class="small muted">Job <b>Run tests (net_two · smoke)</b>, on a GitHub machine</span><div class="steps-list">' + steps.map(function (s) {
        return '<div>' + (s[2] ? TR.dot('none', true) : TR.dot(s[0])) + '<span' + (s[0] === 'none' && !s[2] ? ' class="muted"' : '') + '>' + esc(s[1]) + '</span></div>';
      }).join('') + '</div></div>' +
      '<p class="small muted">The results are imported by themselves when the run ends. Leaving this page doesn\'t stop the run; the full log is on GitHub.</p></section>';
    return page('automation', withRail(autoRail('cms'), h), true);
  }

  // ---------------------------------------------------------------- 4 · Run results (management view)
  function runSummaryBlock(r, actions) {
    return '<div class="kpis" style="margin-bottom:0">' +
      kpi(r.rate + '%', 'pass rate', from(r.rate, r.prev, '%')) + kpi(r.p, 'passed', from(r.p, 211), 'pass') + kpi(r.f, 'failed', from(r.f, 27, '', true), 'fail') + kpi(r.s, 'skipped') + kpi('2', 'flaky') + '</div>' +
      '<div class="progress-wrap">' + TR.bar(counts(r)) + legendAuto(r) + '<span class="small muted">previous run: 22 Nov, 18:05</span></div>' + (actions || '');
  }
  function changedCards() {
    function c(v, l, sub, f) { return '<button data-action="filter" data-f="' + f + '"><span class="v">' + v + '</span><span class="l"><b>' + l + '</b>' + (sub ? ' · ' + sub : '') + '</span></button>'; }
    return '<div class="changed">' + c('3', 'new failures', 'passed last time', 'newfail') + c('21', 'still failing', '', 'failed') + c('6', 'fixed', 'failed last time', 'all') + c('2', 'flaky', 'passed on a retry', 'flaky') + '</div>';
  }
  function causesList(limit) {
    return CAUSES.slice(0, limit || CAUSES.length).map(function (c, i) {
      var open = !!S.open[i];
      return '<div class="cause' + (open ? '' : ' collapsed') + '"><button class="cause-head" data-action="cause" data-i="' + i + '" aria-expanded="' + open + '"><span class="chev">▾</span><span class="mono">' + esc(c.msg) + '</span><span class="nowrap"><b>' + c.n + '</b> tests' + (c.isNew ? ' <span class="pill fail">' + c.isNew + ' new</span>' : '') + '</span></button>' +
        '<div class="cause-body">' + c.tests.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div></div>';
    }).join('');
  }
  function screenResults() {
    var r = RUNS.cms[0];
    var h = '<section class="card card-pad stack"><div class="auto-head"><div class="grow"><h2 class="row">' + TR.dot('fail') + ' CMS Automation · 24 failed</h2>' +
      '<p class="small muted">24 Nov, 10:23 · master @ 9629653 · net_two · smoke · started by Gurjeet from Test Run · 38 min</p>' + linkPath(r) + '</div></div>' +
      '<div class="run-actions"><button class="small-btn" data-action="screen" data-n="1">‹ Runs</button><span class="grow"></span><button class="small-btn">Change Cycle…</button>' +
      '<button class="small-btn danger-outline" data-action="screen" data-n="7">Delete…</button>' + downloadBtn('The results as a workbook (.xlsx)') + fullReport() + '</div>' + runSummaryBlock(r) + '</section>';
    h += '<section class="card card-pad stack"><h2>What changed since the previous run</h2>' + changedCards() + '</section>';
    h += '<section class="card card-pad stack"><div><h2>Failures by cause</h2><p class="small muted">Failure messages with the numbers, IDs and quoted values taken out, so tests that broke the same way sit together.</p></div><div>' + causesList() + '</div></section>';
    h += '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>By test file</h2></div><div class="table-wrap"><table><thead><tr><th>File</th><th class="num">Tests</th><th class="num">' + SYM.pass + '</th><th class="num">' + SYM.fail + '</th><th class="num">' + SYM.other + '</th><th>Result</th></tr></thead><tbody>' +
      [['pgr/assign.spec.ts', 14, 9, 5, 0], ['citizen/track.spec.ts', 22, 18, 3, 1], ['api/search.spec.ts', 31, 27, 4, 0], ['inbox/list.spec.ts', 40, 40, 0, 0]].map(function (x) {
        return '<tr><td class="mono">' + x[0] + '</td><td class="num">' + x[1] + '</td><td class="num">' + x[2] + '</td><td class="num">' + x[3] + '</td><td class="num">' + x[4] + '</td><td style="min-width:120px">' + TR.bar({ pass: x[2], fail: x[3], other: x[4], none: 0, total: x[1] }, true) + '</td></tr>';
      }).join('') + '<tr><td colspan="6" class="small muted">… 21 more files</td></tr></tbody></table></div></section>';

    var chips = [['all', 'All', 254], ['failed', 'Failed', 24], ['newfail', 'New failures', 3], ['flaky', 'Flaky', 2], ['skipped', 'Skipped', 12]];
    var rows = TESTS.filter(function (t) {
      return S.filter === 'all' || (S.filter === 'failed' && t.st === 'fail') || (S.filter === 'newfail' && t.isNew) || (S.filter === 'flaky' && t.flaky) || (S.filter === 'skipped' && t.st === 'other');
    });
    var sel = TESTS[S.sel];
    h += '<section class="card card-pad stack"><h2>All tests</h2><div class="toolbar" style="margin:0"><label class="sr" for="tq">Search tests</label><input id="tq" type="search" placeholder="Search title, file or tag">' +
      chips.map(function (c) { return '<button class="chip" data-action="filter" data-f="' + c[0] + '" aria-pressed="' + (S.filter === c[0]) + '">' + c[1] + ' <span class="n">' + c[2] + '</span></button>'; }).join('') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th></th><th>Test</th><th>Last 3 runs</th><th class="num">Time</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (t) {
        var i = TESTS.indexOf(t);
        return '<tr class="test-row' + (i === S.sel ? ' sel' : '') + '" tabindex="0" data-action="pick" data-i="' + i + '"><td>' + TR.dot(t.st) + '</td><td>' + esc(t.title) + (t.isNew ? ' <span class="pill fail">new</span>' : '') + (t.flaky ? ' <span class="pill other">flaky</span>' : '') + '<div class="small muted mono">' + esc(t.file) + '</div></td><td>' + hist(t.hist) + '</td><td class="num nowrap">' + esc(t.dur) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="no-data">Nothing matches</td></tr>') + '</tbody></table></div>';
    if (sel) {
      h += '<div class="item stack"><div class="row"><b class="grow">' + esc(sel.title) + '</b>' + TR.dot(sel.st) + '</div>' +
        '<div class="small muted"><span class="mono">' + esc(sel.file) + '</span> · ' + esc(sel.dur) + ' · tags <span class="mono">' + esc(sel.tags) + '</span>' + (/@CMS\/\d+/.test(sel.tags) ? ' · manual case <b>' + esc(sel.tags.match(/CMS\/\d+/)[0]) + '</b>' : '') + '</div>' +
        (sel.msg ? '<div><div class="field-label">Message</div><pre class="trace">' + esc(sel.msg).replace('***', '<span class="masked">***</span>') + '</pre>' + (sel.masked ? '<span class="small muted">A token was masked before it was saved.</span>' : '') + '</div>' : '') +
        (sel.stack ? '<div><div class="field-label">Where</div><pre class="trace">' + esc(sel.stack) + '</pre></div>' : '') +
        '<div class="row"><span class="small muted">Last 3 runs</span>' + hist(sel.hist) + '<span class="small muted">' + (sel.isNew ? 'First failure: this run.' : sel.st === 'fail' ? 'Failing since 19 Nov.' : '') + '</span></div></div>';
    }
    h += '</section>';
    return page('automation', withRail(autoRail('cms'), h), true);
  }

  // ---------------------------------------------------------------- 5 · Import results
  function screenImport() {
    var h = suiteHead('notif', '<button class="ghost" data-action="screen" data-n="1">Back</button>');
    h += '<section class="card card-pad stack"><div><h2>Import results</h2><p class="small muted">For a run done outside Test Run: on a laptop, another CI, or a GitHub run started there. JUnit XML or CTRF JSON; several files, or a .zip of them, make one run.</p></div>' +
      (S.file ? '<div class="item row"><span class="file-chosen grow"><span class="sym-pass">✓</span><span class="mono">ctrf-report.json</span><span class="faint">38 KB</span></span><span class="small">CTRF JSON · <b>68</b> tests · ✓ 64 ✗ 3 – 1 · from pytest 8.3</span><button class="link-btn danger" data-action="file" aria-label="Remove ctrf-report.json">✕</button></div>'
        : '<div class="drop"><b>Drop the results file here</b><span class="small muted">or</span><button data-action="file">⤒ Choose Files…</button></div>') +
      '<div class="form-grid">' + field('Branch <span class="faint">(optional)</span>', '<input value="develop">', 'Read from the file when it says') + field('Environment <span class="faint">(optional)</span>', '<input value="staging">') + '</div>' +
      cyclePicker(true, 'Notifications') +
      '<div class="note warn">Notifications › Cycle v2.12 already has 2 runs. Importing this one removes the oldest (20 Nov, 11:02).</div>' +
      '<div class="row" style="justify-content:flex-end"><button class="ghost" data-action="screen" data-n="1">Cancel</button><button class="primary" data-action="imported"' + (S.file ? '' : ' disabled') + '>Import Results</button></div></section>';
    return page('automation', withRail(autoRail('notif'), h), true);
  }

  // ---------------------------------------------------------------- 6 · Link a suite
  function screenLink() {
    var h = '<section class="card card-pad stack"><div><h2>Link a suite</h2><p class="small muted">Once per repository. The suite\'s workflow must write a JUnit XML or CTRF JSON results file and upload it as an artifact. <a href="#" data-action="none">How, for each framework ↗</a></p></div>';
    h += '<div class="subsection"><div class="step-title"><span class="step-n">1</span>Repository</div><div class="row"><label class="sr" for="repoUrl">Repository link</label><input id="repoUrl" type="url" style="flex:1 1 360px" value="https://github.com/QA-Team/notification-tests"><button data-action="check">Check</button></div>' +
      (S.checked ? '<div class="check-line ok">✓ QA-Team/notification-tests · private · 4 workflows, 2 you can start by hand</div>' : '<div class="small muted">Any repository Test Run\'s GitHub access can read.</div>') + '</div>';
    if (S.checked) {
      h += '<div class="subsection"><div class="step-title"><span class="step-n">2</span>Workflow and results</div><div class="form-grid">' +
        field('Name in Test Run', '<input value="Notifications API">') +
        field('Workflow', dd('link:wf', [{ value: 'API tests', label: 'API tests', hint: 'api-tests.yml' }, { value: 'Nightly', label: 'Nightly', hint: 'nightly.yml' }], { label: 'Workflow' }), 'Its Run workflow options become the run form') +
        field('Results artifact', dd('link:art', [{ value: 'ctrf-report', label: 'ctrf-report', hint: 'CTRF JSON' }, { value: 'coverage', label: 'coverage', hint: 'no results file' }], { label: 'Results artifact' }), 'From the latest run (23 Nov)') +
        field('Environment option <span class="faint">(optional)</span>', dd('link:env', ['target', 'markers', 'None'], { label: 'Environment option' }), 'Runs are grouped by it') +
        '</div></div>';
      h += '<div class="subsection"><div class="step-title"><span class="step-n">3</span>Extras <span class="faint small" style="font-weight:400">(optional)</span></div><div class="form-grid">' +
        field('Case-ID pattern', '<input class="mono" value="NOTIF/\\d+">', 'Finds manual case IDs in test titles or tags, for Auto ✓/✗ in Run') +
        field('Extra masking', '<input class="mono" placeholder="e.g. otp=\\d{6}">', 'Tokens, passwords and Authorization headers are always masked') +
        '</div></div>';
      h += '<div class="subsection"><div class="step-title"><span class="step-n">4</span>Try it</div><div class="row"><button data-action="imported-link">Import Latest Run</button>' +
        (S.imported ? '<span class="check-line ok" style="margin:0">✓ Read 68 tests from run #212 (23 Nov): ✓ 64 ✗ 3 – 1</span>' : '') + '</div></div>';
    }
    h += '<div class="row" style="justify-content:flex-end"><button class="ghost" data-action="screen" data-n="1">Cancel</button><button class="primary" data-action="screen" data-n="1"' + (S.checked && S.imported ? '' : ' disabled') + '>Save Suite</button></div></section>';
    return page('automation', withRail(autoRail('new'), h), true);
  }

  // ---------------------------------------------------------------- 7 · Delete popup
  function deleteModal() {
    return '<div class="modal-box confirm" role="dialog" aria-modal="true" aria-labelledby="delQ"><h2 id="delQ">Delete “24 Nov · master · net_two · smoke”?</h2>' +
      '<div class="banner bad" style="margin:12px 0 0">This cannot be undone.</div><ul class="modal-list">' +
      '<li>Its results leave Test Run now, and the published site at the next publish.</li>' +
      '<li>CMS 2.20.1 › Cycle v2.12 keeps 1 run (22 Nov, 18:05).</li>' +
      '<li>The full report on GitHub isn\'t touched; GitHub keeps it until it expires.</li></ul>' +
      '<div class="modal-actions"><button class="ghost" data-action="screen" data-n="4">Cancel</button><button class="danger-fill" data-action="deleted">Delete Run</button></div></div>';
  }

  // ---------------------------------------------------------------- 8 · Summary, with Manual / Automated
  function viewSwitch(enabled) {
    return '<span class="seg same" role="group" aria-label="Results to show">' +
      '<button data-action="sum-view" data-v="manual" aria-pressed="' + (S.sumView === 'manual' || !enabled) + '">Manual</button>' +
      '<button data-action="sum-view" data-v="automated" aria-pressed="' + (S.sumView === 'automated' && enabled) + '"' + (enabled ? '' : ' disabled title="No automated run is attached to CMS 2.20.1 › Cycle v2.12 yet"') + '>Automated</button></span>';
  }
  function manualSummary() {
    var rows = [['CSR Employee', 3, 0, 0, 1], ['Complaint Details', 0, 1, 0, 0], ['Search Complaint Employee', 0, 0, 1, 1], ['Workflow', 1, 1, 1, 8]];
    return '<div class="kpis">' + kpi('44%', 'executed (8 of 18)') + kpi('67%', 'pass rate (of Pass + Fail)', '', 'pass') + kpi('2', 'failing now', '', 'fail') + kpi('10', 'not run yet') + '</div>' +
      '<section class="card card-pad stack"><div class="row"><h2 class="grow">All cases</h2>' + TR.legend({ pass: 4, fail: 2, other: 2, none: 10, total: 18 }) + '</div><div class="progress-wrap">' + TR.bar({ pass: 4, fail: 2, other: 2, none: 10, total: 18 }) + '</div></section>' +
      '<section class="card section"><div class="card-pad" style="padding-bottom:8px"><h2>By sub feature</h2></div><div class="table-wrap"><table><thead><tr><th>Sub feature</th><th>Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Other</th><th class="num">Not run</th></tr></thead><tbody>' +
      rows.map(function (x) { var t = x[1] + x[2] + x[3] + x[4]; return '<tr><td>' + x[0] + '</td><td style="min-width:140px">' + TR.bar({ pass: x[1], fail: x[2], other: x[3], none: x[4], total: t }, true) + '</td><td class="num">' + x[1] + '</td><td class="num">' + x[2] + '</td><td class="num">' + x[3] + '</td><td class="num">' + x[4] + '</td></tr>'; }).join('') +
      '</tbody></table></div></section>';
  }
  function automatedSummary(locked) {
    var r = RUNS.cms[0];
    return '<section class="card card-pad stack"><div class="auto-head"><div class="grow"><h2>Latest run · CMS Automation</h2><p class="small muted">24 Nov, 10:23 · master @ 9629653 · net_two · smoke</p></div>' +
      (locked ? '<span class="pill pass">Unlocked for Priya</span>' : '') + '</div>' +
      runSummaryBlock(r) + '</section>' +
      '<section class="card card-pad stack"><h2>What changed since the previous run</h2>' + changedCards() + '</section>' +
      '<section class="card card-pad stack"><div class="row"><h2 class="grow">Top failure causes</h2><button class="link-btn" data-action="screen" data-n="4">All causes ›</button></div><div>' + causesList(2) + '</div></section>' +
      '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>Runs for this cycle</h2><p class="small muted">The last 2 are kept.</p></div><div class="table-wrap"><table><tbody>' +
      RUNS.cms.slice(0, 2).map(function (x) {
        return '<tr><td class="nowrap">' + esc(x.when) + '<div class="small muted">CMS Automation · ' + esc(x.env) + ' · ' + esc(x.opts) + '</div></td><td style="min-width:150px">' + resultCell(x) + '</td><td class="num nowrap">' + rateCell(x) + '</td><td class="num"><button class="small-btn" data-action="screen" data-n="4">Open</button></td></tr>';
      }).join('') + '</tbody></table></div></section>' +
      '<p class="small muted">Manual cases also run by automation: <b>9</b> of 18 · automation passing on <b>6</b>, failing on <b>3</b>.</p>';
  }
  function screenSummary() {
    var enabled = S.hasRuns;
    var showAuto = enabled && S.sumView === 'automated';
    var tools = '<div class="report-tools">' + viewSwitch(enabled) + '<span class="updated grow">Updated on 2026-11-24 11:59</span>' +
      (showAuto ? '<div class="run-actions">' + downloadBtn('The automated results as a workbook (.xlsx)') + fullReport() + '</div>'
        : '<span class="dl-wrap"><button class="small-btn" aria-haspopup="menu"><span aria-hidden="true">⤓</span> Download <span class="caret" aria-hidden="true">▾</span></button></span><button class="small-btn">Print / PDF</button><button class="small-btn">Publish</button>') + '</div>';
    var note = enabled ? '' : '<p class="small muted" style="margin:-4px 0 12px">Automated results show here once a run is attached to this test suite and cycle.</p>';
    return page('summary', tools + note + (showAuto ? automatedSummary() : manualSummary()), false, ctxBar());
  }

  // ---------------------------------------------------------------- 9 · Run with Auto badges
  function screenRunBadges() {
    var cases = [['pass', 'CMS/01', 'Citizen files a complaint with a photo', 'pass'], ['fail', 'CMS/02', 'GRO assigns the complaint to an LME', 'fail'], ['none', 'CMS/03', 'LME resolves; citizen rates the resolution', 'fail'], ['other', 'CMS/04', 'Citizen reopens within 5 days', 'other'], ['none', 'CMS/05', 'Employee searches by complaint number', '']];
    var h = '<div class="card path"><div class="path-head"><span class="chev">▾</span><div class="grow"><div class="path-title">Complaint lifecycle</div><div class="path-meta">5 cases</div></div></div><div class="path-body">' +
      cases.map(function (c) {
        var badge = c[3] ? '<span class="pill ' + c[3] + '" title="Latest automated result attached to this cycle">Auto ' + SYM[c[3]] + '</span>' : '';
        return '<div class="case">' + TR.dot(c[0]) + '<span class="cid">' + c[1] + '</span><span class="title">' + esc(c[2]) + '</span><span class="badges">' + badge + '</span></div>';
      }).join('') + '</div></div><p class="small muted">Auto ✓/✗ comes from automated tests whose title or tags name the case ID (CMS/02), in runs attached to this cycle.</p>';
    return page('run', h, false, ctxBar());
  }

  // ---------------------------------------------------------------- 10 · Published site
  function screenPublished() {
    var bar = '<header class="topbar reports"><div class="topbar-row"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Test Run</span><span class="brand-sheet">Published reports</span></div><span class="grow"></span>' +
      dd('pub:book', BOOKS, { cls: 'top-dd book-dd', prefix: 'Workbook', label: 'Workbook' }) + '</div></header>';
    var unlocked = S.sumView === 'automated' && S.visitor === 'open';
    var ctx = '<div class="report-tools">' + viewSwitch(true) + '<span class="updated grow">Published 24 Nov, 17:00 · CMS 2.20.1 › Cycle v2.12</span>' +
      (S.sumView !== 'automated' ? downloadBtn('The workbook as published, with a Known issues sheet') : unlocked ? '<div class="run-actions">' + downloadBtn('The automated results as a workbook (.xlsx)') + fullReport() + '</div>' : '') + '</div>';
    var body;
    if (S.sumView !== 'automated') body = manualSummary();
    else if (S.visitor === 'unlocking') body = '<div class="spin-page"><div class="stack" style="align-items:center"><div class="spinner" aria-hidden="true"></div><p class="muted">Unlocking the automated results with your invite link…</p></div></div>';
    else if (S.visitor === 'denied') body = '<div class="empty"><h3>These results are locked</h3><p>Your invite link doesn\'t open “CMS Sign Off”. Ask the host for access to this workbook, or for a new link.</p></div>';
    else if (S.visitor === 'nokey') body = '<div class="empty"><h3>Automated results are for invited people</h3><p>Open your Test Run invite link once in this browser, then come back. The manual results are open to everyone.</p><p style="margin-top:12px"><button>I Have an Invite Link</button></p></div>';
    else body = automatedSummary(true);
    return bar + '<main>' + ctx + body + '</main>';
  }

  // ---------------------------------------------------------------- 11 · Setup › Access (was Sharing)
  function setupRail(part) {
    return '<div class="rail-group subtabs" role="tablist" aria-label="Setup"><span class="rail-title">Setup</span>' +
      [['Workbook', 0], ['Access', 11], ['Publish', 0], ['Media', 0], ['Automation', 12]].map(function (p) {
        return '<button role="tab" class="subtab"' + (p[1] ? ' data-action="screen" data-n="' + p[1] + '"' : '') + ' aria-selected="' + (p[0] === part) + '">' + p[0] + (p[0] === 'Access' ? ' <span class="pill pass">on</span>' : '') + '</button>';
      }).join('') + '</div>' +
      (part === 'Access' ? '<p class="small muted rail-note">Who can use this Test Run, and how they reach this laptop. Applies to all workbooks.</p>' : '<p class="small muted rail-note">Automation is for all workbooks. Only the host sees this.</p>');
  }
  function screenAccess() {
    var h = '<section class="card card-pad stack team-card"><div class="row team-head"><div class="grow"><h2>Online access</h2><p class="small muted">Testers and managers open Test Run in their own browser with an invite link; nothing to install. This laptop must stay on while they work.</p></div>' +
      '<label class="check team-switch"><input type="checkbox" checked> Share online</label></div>' +
      '<div class="team-block"><h3>Online link</h3><div class="row conn-status"><span class="pill pass">Shared</span><span class="mono grow">https://fri-textbooks-essay-len.trycloudflare.com</span><button class="small-btn">Stop Sharing</button></div>' +
      '<span class="small muted">Quick tunnel, kept in your gist so invite links keep working. (Unchanged from today.)</span></div>' +
      '<div class="team-block"><div class="row"><h3>Your admin link</h3><span class="small muted grow">Full control from another computer or network. Keep it to yourself, like a password.</span><button class="small-btn">Copy Link</button></div></div></section>';
    h += '<section class="card card-pad stack"><div><h2>Users</h2><p class="small muted">Each person\'s invite link, what they can open, and what they can do with automation.</p></div>' +
      '<div class="table-wrap"><table class="people"><thead><tr><th>Name</th><th>Access</th><th>Workbooks</th><th>Automated suites</th><th>Start runs</th><th></th></tr></thead><tbody>' +
      USERS.map(function (u, i) {
        var viewer = u.role === 'View only';
        return '<tr><td>' + esc(u.name) + '<div class="small muted">seen ' + esc(u.seen) + '</div></td>' +
          '<td style="min-width:150px">' + dd('u:role:' + i, ['Update status', 'View only'], { value: u.role, label: 'Access for ' + u.name }) + '</td>' +
          '<td style="min-width:160px">' + dd('u:books:' + i, ['All workbooks', 'CMS Sign Off', 'Bomet UAT sign-off'], { value: u.books, label: 'Workbooks ' + u.name + ' can open' }) + '</td>' +
          '<td style="min-width:170px">' + dd('u:suites:' + i, [{ value: 'All suites', label: 'All suites' }, { value: 'CMS Automation', label: 'CMS Automation' }, { value: 'Notifications API', label: 'Notifications API' }, { value: 'None', label: 'None', hint: 'no automated results' }], { value: u.suites, label: 'Automated suites ' + u.name + ' sees' }) + '</td>' +
          '<td>' + (viewer ? '<span class="faint" title="View only can read results but not start runs">–</span>' : '<input type="checkbox" aria-label="' + esc(u.name) + ' can start runs and import results"' + (u.run ? ' checked' : '') + '>') + '</td>' +
          '<td class="num"><div class="row" style="justify-content:flex-end"><button class="small-btn">Copy Link</button><button class="small-btn">New Link</button><button class="small-btn danger">Remove</button></div></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="row add-person"><label class="sr" for="uName">Name</label><input id="uName" placeholder="Name, e.g. John Doe (QA)">' + dd('u:new:role', ['Select access', 'Update status', 'View only'], { label: 'Access', cls: 'u-new' }) + '<button class="small-btn">+ Add and Make a Link</button></div>' +
      '<ul class="bullets small muted"><li><span><b>Automated suites:</b> whose results they see, in Automation, Summary and the published site (still only for workbooks they can open).</span></li>' +
      '<li><span><b>Start runs:</b> can press ▶ Run and ⤒ Import Results for those suites. View only never can.</span></li></ul></section>';
    return page('setup', withRail(setupRail('Access'), h), true);
  }

  // ---------------------------------------------------------------- 12 · Setup › Automation
  function screenSetupAuto() {
    var h = '<section class="card card-pad stack"><div><h2>Automation</h2><p class="small muted">Suites run in their own repositories\' GitHub Actions. Test Run keeps their results; GitHub keeps the full reports. Who can see and run them is in <button class="linkish" data-action="screen" data-n="11">Access › Users</button>.</p></div><div class="kv-grid">' +
      '<span class="kv-k">GitHub access</span><span class="check-line ok" style="margin:0">✓ gh, signed in as Gurjeet-eGov</span>' +
      '<span class="kv-k">Runs kept</span><span class="row">' + dd('set:keep', ['1', '2', '3', '5'], { value: '2', label: 'Runs kept', cls: 'keep-dd' }) + '<span class="small muted">for each test suite and cycle; the oldest goes when a new one comes in</span></span>' +
      '<span class="kv-k">Masking</span><span class="stack-s"><span class="small">Always: tokens, passwords, Authorization headers, JWTs</span><span class="filter-tags"><span class="filter-tag mono">otp=\\d{6}<button aria-label="Remove rule">✕</button></span></span><span class="row"><label class="sr" for="mAdd">Masking rule</label><input id="mAdd" class="mono" placeholder="A text or pattern to hide"><button class="small-btn">+ Add</button></span></span>' +
      '<span class="kv-k">Space on GitHub Pages</span><span class="stack-s"><span class="space-bar" role="img" aria-label="5.2 MB of 1 GB used"><span class="wb" style="width:3%"></span><span class="au" style="width:1%"></span></span><span class="small muted">5.2 MB of 1 GB · workbooks 4.6 MB · automation results 0.6 MB</span></span>' +
      '</div></section>';
    h += '<section class="card"><div class="card-pad" style="padding-bottom:8px"><h2>Linked suites</h2></div><div class="table-wrap"><table><thead><tr><th>Suite</th><th>Repository</th><th>Results</th><th>Linked</th><th></th></tr></thead><tbody>' +
      Object.keys(SUITES).map(function (k) { var s = SUITES[k]; return '<tr><td>' + esc(s.name) + '</td><td class="mono">' + esc(s.repo) + '</td><td>' + esc(s.format) + '</td><td class="small muted">' + (k === 'cms' ? 'Gurjeet · 20 Nov' : 'Rahul · 23 Nov') + '</td><td class="num"><button class="small-btn danger">Remove</button></td></tr>'; }).join('') +
      '</tbody></table></div></section>';
    return page('setup', withRail(setupRail('Automation'), h), true);
  }

  // ---------------------------------------------------------------- render and actions
  function $(id) { return document.getElementById(id); }
  function render() {
    $('tplStrip').innerHTML = strip();
    var s = S.screen;
    $('app').innerHTML = s === 1 ? screenSuite() : s === 2 ? screenRunForm() : s === 3 ? screenRunning() : s === 4 || s === 7 ? screenResults() : s === 5 ? screenImport() :
      s === 6 ? screenLink() : s === 8 ? screenSummary() : s === 9 ? screenRunBadges() : s === 10 ? screenPublished() : s === 11 ? screenAccess() : screenSetupAuto();
    var m = $('modal');
    if (s === 7) { m.innerHTML = deleteModal(); m.classList.remove('hidden'); var b = m.querySelector('button'); if (b) b.focus(); }
    else { m.innerHTML = ''; m.classList.add('hidden'); }
    if (location.hash !== '#s=' + s) history.replaceState(null, '', '#s=' + s);
  }
  function go(n) { S.screen = n; S.ddOpen = null; render(); window.scrollTo(0, 0); }

  var ACTIONS = {
    screen: function (el) { go(Number(el.dataset.n)); },
    nav: function (el) { var v = el.dataset.view; if (v === 'automation') go(1); else if (v === 'setup') go(11); else if (v === 'summary') go(8); else if (v === 'run') go(9); },
    suite: function (el) { S.suite = el.dataset.suite; go(1); },
    'dd-open': function (el) { var n = el.dataset.dd; S.ddOpen = S.ddOpen === n ? null : n; render(); var b = document.querySelector('.multi[data-dd="' + n + '"] .dd-item.on, .multi[data-dd="' + n + '"] .dd-item'); if (b && S.ddOpen) b.focus(); },
    'dd-reset': function (el) { S.v[el.dataset.dd] = ''; render(); },
    'dd-pick': function (el) { var n = el.dataset.dd; S.v[n] = el.dataset.value; S.ddOpen = null; render(); var b = document.querySelector('.multi[data-dd="' + n + '"] .multi-btn'); if (b) b.focus(); },
    cause: function (el) { var i = el.dataset.i; S.open[i] = !S.open[i]; render(); },
    filter: function (el) { S.filter = el.dataset.f; if (S.screen !== 4) go(4); else render(); },
    pick: function (el) { S.sel = Number(el.dataset.i); render(); },
    file: function () { S.file = !S.file; render(); },
    check: function () { S.checked = !S.checked; render(); },
    'imported-link': function () { S.imported = true; render(); },
    imported: function () { S.suite = 'notif'; go(1); TR.toast('Imported 68 tests into Notifications › Cycle v2.12. The run from 20 Nov, 11:02 was removed: 2 are kept.'); },
    deleted: function () { go(1); TR.toast('Deleted the run from 24 Nov, 10:23. It leaves the published site at the next publish.'); },
    'sum-view': function (el) { S.sumView = el.dataset.v; render(); },
    variant: function (el) { var k = el.dataset.key, v = el.dataset.v; S[k] = v === 'true' ? true : v === 'false' ? false : v; if (k === 'visitor') S.sumView = 'automated'; render(); },
    none: function (el, e) { e.preventDefault(); }
  };
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (S.ddOpen && !e.target.closest('.multi[data-dd="' + S.ddOpen + '"]')) { S.ddOpen = null; if (!el) { render(); return; } }
    if (el && !el.disabled && ACTIONS[el.dataset.action]) { ACTIONS[el.dataset.action](el, e); return; }
    if (S.screen === 7 && e.target === $('modal')) go(4);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.ddOpen) { var n = S.ddOpen; S.ddOpen = null; render(); var b = document.querySelector('.multi[data-dd="' + n + '"] .multi-btn'); if (b) b.focus(); return; }
    if (e.key === 'Escape' && S.screen === 7) go(4);
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-action]')) { e.preventDefault(); ACTIONS.pick(e.target); }
  });
  window.addEventListener('hashchange', function () { var n = Number((location.hash.match(/s=(\d+)/) || [])[1]); if (n && n !== S.screen) go(n); });
  render();
})();
