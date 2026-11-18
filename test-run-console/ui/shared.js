/* Shared by the console and the summary page: calling the server, escaping, status visuals, the summary. */
var TR = (function () {
  'use strict';

  var SYM = { pass: '✓', fail: '✗', other: '–', none: '○' };
  var CLS_LABEL = { pass: 'Pass', fail: 'Fail', other: 'Other', none: 'Not run' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Which workbook the page is working on (sent with every call). */
  var state = { book: null };

  /** Talk to the local server; always resolves with { ok, ... }. raw: send body as-is (file upload). */
  function http(method, path, body, raw) {
    var opts = { method: method, headers: { 'X-Test-Run': '1' } };
    if (body !== undefined) {
      if (raw) opts.body = body;
      else { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    return fetch(path, opts)
      .then(function (r) { return r.json(); })
      .then(function (res) { return res || { ok: false, code: 'ERROR', error: 'Empty response' }; })
      .catch(function (e) { return { ok: false, code: 'OFFLINE', error: 'Test Run is not answering. Is it still running in the terminal? (' + ((e && e.message) || e) + ')' }; });
  }

  /** Call one of the server's api_* functions on the current workbook. */
  function api(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return http('POST', '/api/call/' + fn, { book: state.book, args: args });
  }

  function classify(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return 'none';
    if (/^(pass|passed|ok|done)\b/i.test(s)) return 'pass';
    if (/^(fail|failed)\b/i.test(s)) return 'fail';
    return 'other';
  }

  function counts(list) {
    var c = { pass: 0, fail: 0, other: 0, none: 0, total: 0 };
    list.forEach(function (cls) { c[cls] += 1; c.total += 1; });
    return c;
  }

  function bar(c, thin) {
    var t = c.total || 1;
    function seg(k) { return c[k] ? '<span class="' + k + '" style="width:' + (c[k] / t * 100).toFixed(2) + '%"></span>' : ''; }
    var label = c.pass + ' pass, ' + c.fail + ' fail, ' + c.other + ' other, ' + c.none + ' not run';
    return '<div class="bar' + (thin ? ' thin' : '') + '" role="img" aria-label="' + esc(label) + '">' + seg('pass') + seg('fail') + seg('other') + '</div>';
  }

  function dot(cls, pending) {
    return '<span class="dot ' + cls + (pending ? ' pending' : '') + '" aria-hidden="true">' + (cls === 'none' ? '' : SYM[cls]) + '</span>';
  }

  function issueUrl(issue, base) {
    var s = String(issue == null ? '' : issue).trim();
    if (/^https?:\/\//i.test(s)) return s;
    var m = s.match(/#?(\d{1,7})\b/);
    if (!m || !base) return null;
    return String(base).replace(/\/?$/, '/') + m[1];
  }

  function issueLink(issue, base) {
    if (!issue) return '';
    var url = issueUrl(issue, base);
    return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(issue) + '</a>' : esc(issue);
  }

  function pct(v) { return v == null ? '–' : v + '%'; }

  /** The management summary. data is api_summary's result. */
  function summaryHtml(data) {
    var s = data.summary;
    var c = s.counts;
    var h = [];
    h.push('<div class="kpis">');
    h.push(kpi('', pct(s.executedPct), 'executed (' + s.executed + ' of ' + c.total + ')'));
    h.push(kpi('pass', pct(s.passRate), 'pass rate (of Pass + Fail)'));
    h.push(kpi('fail', String(c.fail), 'failing now'));
    h.push(kpi('', String(c.none), 'not run yet'));
    h.push('</div>');

    h.push('<div class="card card-pad"><div class="row" style="margin-bottom:8px"><h2>All cases</h2><span class="grow"></span>' + legend(c) + '</div>' + bar(c) + '</div>');

    h.push('<div class="section card"><div class="card-pad"><h2>By ' + esc(data.groupLabel.toLowerCase()) + '</h2></div><div class="table-wrap"><table>');
    h.push('<thead><tr><th>' + esc(data.groupLabel) + '</th><th style="width:30%">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Other</th><th class="num">Not run</th><th class="num">Pass rate</th></tr></thead><tbody>');
    s.groups.forEach(function (g) {
      h.push('<tr><td>' + esc(g.name) + '</td><td>' + bar(g.counts, true) + '</td><td class="num">' + g.counts.pass + '</td><td class="num">' + g.counts.fail + '</td><td class="num">' + g.counts.other + '</td><td class="num">' + g.counts.none + '</td><td class="num">' + pct(g.passRate) + '</td></tr>');
    });
    h.push('</tbody></table></div></div>');

    h.push('<div class="section card"><div class="card-pad"><h2>Open failures <span class="pill fail">' + s.failures.length + '</span></h2></div>');
    if (s.failures.length) {
      h.push('<div class="table-wrap"><table><thead><tr><th>ID</th><th>Scenario</th><th>Comment</th><th>Issue</th></tr></thead><tbody>');
      s.failures.forEach(function (f) {
        h.push('<tr><td class="mono">' + esc(f.id) + '</td><td>' + esc(f.scenario) + '<div class="small faint">' + esc(f.group) + '</div></td><td>' + esc(f.comment) + '</td><td>' + issueLink(f.issue, data.issueBase) + '</td></tr>');
      });
      h.push('</tbody></table></div>');
    } else {
      h.push('<div class="card-pad muted" style="padding-top:0">No failing cases in this cycle.</div>');
    }
    h.push('</div>');

    var side = [];
    if (s.comparison) {
      side.push('<div class="card card-pad"><h2>Compared with ' + esc(data.prevCycle || 'the previous cycle') + '</h2><table style="margin-top:8px"><tbody>' +
        '<tr><td>Newly failing</td><td class="num"><b class="sym-fail">' + s.comparison.newlyFailing.length + '</b></td></tr>' +
        '<tr><td>Fixed</td><td class="num"><b class="sym-pass">' + s.comparison.fixed.length + '</b></td></tr>' +
        '<tr><td>Still failing</td><td class="num"><b>' + s.comparison.stillFailing + '</b></td></tr></tbody></table>' +
        listIds('Newly failing', s.comparison.newlyFailing) + '</div>');
    }
    var a = s.automation;
    side.push('<div class="card card-pad"><h2>Manual and automated</h2><table style="margin-top:8px"><tbody>' +
      '<tr><td>Cases linked to automation</td><td class="num"><b>' + a.linked + '</b> of ' + c.total + '</td></tr>' +
      '<tr><td>Automation passing</td><td class="num"><b class="sym-pass">' + a.pass + '</b></td></tr>' +
      '<tr><td>Automation failing</td><td class="num"><b class="sym-fail">' + a.fail + '</b></td></tr>' +
      '<tr><td>Skipped or mixed</td><td class="num"><b>' + a.other + '</b></td></tr></tbody></table></div>');
    if (s.testers.length) {
      side.push('<div class="card card-pad"><h2>Testers</h2><table style="margin-top:8px"><tbody>' +
        s.testers.map(function (t) { return '<tr><td>' + esc(t.name) + '</td><td class="num">' + t.count + '</td></tr>'; }).join('') + '</tbody></table></div>');
    }
    h.push('<div class="section grid">' + side.join('') + '</div>');
    return h.join('');
  }

  function listIds(title, list) {
    if (!list.length) return '';
    return '<div class="small muted" style="margin-top:8px">' + esc(title) + ': ' + list.slice(0, 12).map(function (x) { return '<span class="mono">' + esc(x.id || x.key) + '</span>'; }).join(', ') + (list.length > 12 ? ', …' : '') + '</div>';
  }

  function kpi(cls, value, label) {
    return '<div class="card kpi ' + cls + '"><div class="v">' + esc(value) + '</div><div class="l">' + esc(label) + '</div></div>';
  }

  function legend(c) {
    return '<div class="legend">' +
      '<span><span class="sym-pass">' + SYM.pass + '</span> <b>' + c.pass + '</b> pass</span>' +
      '<span><span class="sym-fail">' + SYM.fail + '</span> <b>' + c.fail + '</b> fail</span>' +
      '<span><span class="sym-other">' + SYM.other + '</span> <b>' + c.other + '</b> other</span>' +
      '<span><span class="sym-none">' + SYM.none + '</span> <b>' + c.none + '</b> not run</span>' +
      '</div>';
  }

  function toast(msg, kind) {
    var box = document.getElementById('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'bad' ? ' bad' : '');
    el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'bad' ? 7000 : 3200);
  }

  var store = {
    get: function (k) { try { return window.localStorage.getItem('testrun.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem('testrun.' + k, v); } catch (e) { /* storage unavailable */ } }
  };

  return {
    SYM: SYM, CLS_LABEL: CLS_LABEL, esc: esc, api: api, http: http, state: state, classify: classify, counts: counts, bar: bar,
    dot: dot, issueUrl: issueUrl, issueLink: issueLink, pct: pct, summaryHtml: summaryHtml,
    legend: legend, toast: toast, store: store
  };
})();
