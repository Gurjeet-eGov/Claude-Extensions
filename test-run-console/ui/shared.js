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

  // ---------------------------------------------------------------------------
  // Which Test Run server, and who you are on it
  // ---------------------------------------------------------------------------
  //
  // The page runs in two places:
  // - served by a Test Run server (http://127.0.0.1:5178 on the laptop, or that
  //   server's shared address): it talks to the server it came from;
  // - hosted somewhere else (GitHub Pages): it talks to the server named by an
  //   invite link, #join=<key>&gist=<id> or #join=<key>&server=<address>.
  //   A shared laptop's address can change (a quick tunnel gets a new one on
  //   every start); the server writes its current address to a gist, and the
  //   page looks there whenever the address it knew stops answering.
  // The key and the address are kept in this browser only (localStorage).

  var CONN_KEY = 'testrun.connection';
  var conn = { server: '', token: '', gist: '' }; // server '' = the page's own origin

  function loadConn() {
    try {
      var c = JSON.parse(window.localStorage.getItem(CONN_KEY) || 'null');
      if (c) { conn.server = cleanServer(c.server); conn.token = String(c.token || ''); conn.gist = String(c.gist || ''); }
    } catch (e) { /* storage unavailable */ }
  }
  function saveConn() {
    try { window.localStorage.setItem(CONN_KEY, JSON.stringify(conn)); } catch (e) { /* storage unavailable */ }
  }

  function cleanServer(s) {
    s = String(s || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(s) ? s : '';
  }

  /** An invite link (or only its #… part) as { token, server, gist }. */
  function parseInvite(text) {
    var s = String(text || '').trim();
    var i = s.indexOf('#');
    var p = new URLSearchParams(i >= 0 ? s.slice(i + 1) : s);
    var out = { token: String(p.get('join') || '').replace(/[^\w-]/g, ''), server: cleanServer(p.get('server')), gist: String(p.get('gist') || '').replace(/[^0-9a-f]/gi, '') };
    // A link straight to a server (https://its-address/#join=…): the server is where the link points.
    if (out.token && !out.server && !out.gist && i > 0) {
      try {
        var u = new URL(s.slice(0, i));
        if (/^https?:$/.test(u.protocol)) out.server = cleanServer(u.origin + u.pathname.replace(/\/[^/]*$/, ''));
      } catch (e) { /* not a link */ }
    }
    return out;
  }

  function authHeaders(extra) {
    var h = { 'X-Test-Run': '1' };
    if (conn.token) h.Authorization = 'Bearer ' + conn.token;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function ping(server) {
    return fetch(server + '/api/status', { headers: authHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return j && j.app === 'test-run' ? j : null; })
      .catch(function () { return null; });
  }

  /** The address a shared server last wrote to its gist ('' if none). */
  function addressFromGist(id) {
    if (!id) return Promise.resolve('');
    return fetch('https://api.github.com/gists/' + encodeURIComponent(id), { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (g) {
        var f = g && g.files && g.files['test-run.json'];
        var info = f && f.content ? JSON.parse(f.content) : null;
        return info && info.app === 'test-run' ? cleanServer(info.url) : '';
      })
      .catch(function () { return ''; });
  }

  function verdict(st) {
    if (st.auth === 'required') return { ok: false, code: conn.token ? 'BAD_KEY' : 'NEED_KEY', status: st };
    return { ok: true, status: st, server: conn.server, remote: conn.server !== '' || !!(st.me && !st.me.local) };
  }

  /** Look for the server's current address in its gist; resolves the server's status or null. */
  function rediscover() {
    return addressFromGist(conn.gist).then(function (url) {
      if (!url) return null;
      return ping(url).then(function (st) {
        if (st) { conn.server = url; saveConn(); }
        return st;
      });
    });
  }

  var connecting = null;
  /**
   * Find the server once per page load. Resolves { ok, status, remote } or
   * { ok: false, code: NO_SERVER | UNREACHABLE | NEED_KEY | BAD_KEY }.
   */
  function connect() {
    if (connecting) return connecting;
    loadConn();
    var inv = parseInvite(window.location.hash);
    if (inv.token || inv.server || inv.gist) {
      if (inv.token) conn.token = inv.token;
      if (inv.server || inv.gist) { conn.server = inv.server; conn.gist = inv.gist; }
      saveConn();
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* keep the hash */ }
    }
    var known = conn.server;
    conn.server = '';
    connecting = ping('').then(function (st) {
      if (st) return verdict(st); // served by a Test Run server: talk to it
      conn.server = known;
      if (!known && !conn.gist) return { ok: false, code: 'NO_SERVER' };
      return (known ? ping(known) : Promise.resolve(null)).then(function (st2) {
        return st2 || rediscover();
      }).then(function (st3) {
        return st3 ? verdict(st3) : { ok: false, code: 'UNREACHABLE', server: conn.server };
      });
    });
    return connecting;
  }

  /** Use an invite link pasted on the Connect screen, then connect again. */
  function useInvite(text) {
    var inv = parseInvite(text);
    if (!inv.token) return Promise.resolve({ ok: false, code: 'BAD_LINK' });
    conn.token = inv.token;
    if (inv.server || inv.gist) { conn.server = inv.server; conn.gist = inv.gist; }
    saveConn();
    connecting = null;
    return connect();
  }

  /** Find the server again (after "Try again"). */
  function reconnect() { connecting = null; return connect(); }

  /** Forget the key and address kept in this browser. */
  function forget() {
    conn.server = ''; conn.token = ''; conn.gist = '';
    try { window.localStorage.removeItem(CONN_KEY); } catch (e) { /* storage unavailable */ }
    connecting = null;
  }

  function offline(e) {
    return { ok: false, code: 'OFFLINE', error: conn.server
      ? 'The shared Test Run is not answering. The laptop running it may be asleep or offline. (' + ((e && e.message) || e) + ')'
      : 'Test Run is not answering. Is it still running in the terminal? (' + ((e && e.message) || e) + ')' };
  }

  /** Talk to the server; always resolves with { ok, ... }. raw: send body as-is (file upload). */
  function http(method, path, body, raw, retried) {
    var opts = { method: method, headers: authHeaders() };
    if (body !== undefined) {
      if (raw) opts.body = body;
      else { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    return fetch(conn.server + path, opts)
      .then(function (r) {
        return r.json().then(function (j) {
          if (r.status === 401) state.authFailed = true;
          return j || { ok: false, code: 'ERROR', error: 'Empty response' };
        });
      })
      .catch(function (e) {
        // The shared address may have changed since the page loaded: look it up once, then retry.
        if (retried || !conn.gist) return offline(e);
        var before = conn.server;
        return rediscover().then(function (st) {
          return st && conn.server !== before ? http(method, path, body, raw, true) : offline(e);
        });
      });
  }

  /** Download a file from the server (with the invite key), saved under name. */
  function download(path, name) {
    return fetch(conn.server + path, { headers: authHeaders() }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { return { ok: false, error: (j && j.error) || 'Download failed.' }; }, function () { return { ok: false, error: 'Download failed (' + r.status + ').' }; });
      return r.blob().then(function (b) { saveBlob(b, name); return { ok: true }; });
    }, function (e) { return offline(e); });
  }

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
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

  // Issues as the server lists them: [{ ref: '#123', url: 'https://…' }] (url '' for a bare reference).

  /** The issues in typed text, as lower-case keys (links, or the words between commas). */
  function issueKeys(text) {
    var s = String(text == null ? '' : text);
    var keys = [];
    var links = s.match(/https?:\/\/[^\s<>"',;]+/gi) || [];
    links.forEach(function (u) { keys.push(u.replace(/[).\]]+$/, '').toLowerCase()); });
    s.replace(/https?:\/\/[^\s<>"',;]+/gi, '\n').split(/[\n,;]+/).forEach(function (t) {
      t = t.trim();
      if (t && (!links.length || (/\d/.test(t) && t.length <= 40))) keys.push(t.toLowerCase());
    });
    return keys.filter(function (k, i) { return keys.indexOf(k) === i; }).sort();
  }

  /** Does the typed text name the same issues as the list? */
  function sameIssues(text, list) {
    var a = issueKeys(text);
    var b = (list || []).map(function (i) { return String(i.url || i.ref).toLowerCase(); }).sort();
    return a.join('\n') === b.join('\n');
  }

  /** Issues as links ("#123 ↗"), comma separated. */
  function issueLinks(list) {
    return (list || []).map(function (i) {
      return /^https?:\/\//i.test(i.url || '') ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(i.ref) + '</a>' : esc(i.ref);
    }).join(', ');
  }

  function pct(v) { return v == null ? '–' : v + '%'; }

  // ---------------------------------------------------------------------------
  // Text on several lines in one cell (legacy sheets are full of it)
  // ---------------------------------------------------------------------------

  var BULLET_RE = /^\s*(?:[•●▪◦*–—]|-(?=\s))\s*/;
  var NUMBER_RE = /^\s*\d{1,2}\s*[.),]\s*/;

  /** Lines of a cell: right-trimmed, without blank lines at either end, runs of blank lines kept as one. */
  /**
   * A tab name as shown: one Excel cut at its 31-character limit (it ends mid-way, on an
   * open bracket, a dash or a space) shows as "CMS Sign Off - CMS Automation…".
   */
  function tabLabel(name) {
    var n = String(name == null ? '' : name);
    if (n.length !== 31) return n;
    var open = (n.match(/[(\[]/g) || []).length;
    var close = (n.match(/[)\]]/g) || []).length;
    if (open <= close && !/[\s\-–(\[]$/.test(n)) return n;
    return n.replace(/[\s\-–(\[]+$/, '') + '…';
  }

  function cellLines(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').map(function (l) { return l.replace(/[ \t ]+$/, ''); });
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.filter(function (l, i) { return l.trim() || (i > 0 && lines[i - 1].trim()); });
  }

  /**
   * Read a cell as an optional intro and a list of items, the way a person would:
   * - "• a", "- a", "1. a", "2, a" start items (bullet marks are dropped, numbers kept);
   * - a line starting in lower case or with closing punctuation carries on the line
   *   before it ('…later.\n" message shall…'), as does anything after a line ending
   *   in a comma ("Dear Citizen,\nYour complaint…");
   * - a first line ending in ":" introduces the items after it.
   * Returns { intro, items: [{ text, num }] }, where text may still hold line breaks.
   */
  function cellItems(text) {
    var items = [];
    cellLines(text).forEach(function (line) {
      if (!line.trim()) return;
      var bullet = BULLET_RE.test(line);
      var num = !bullet && NUMBER_RE.test(line);
      var body = bullet ? line.replace(BULLET_RE, '') : line.trim();
      var prev = items[items.length - 1];
      if (prev && !bullet && !num) {
        if (/^["'”’)\]}.,;:!?]/.test(body)) { prev.text += body; return; }
        if (/^[a-z]/.test(body)) { prev.text += ' ' + body; return; }
        if (/,$/.test(prev.text)) { prev.text += '\n' + body; return; }
      }
      items.push({ text: body, num: num });
    });
    var intro = '';
    if (items.length > 2 && /:$/.test(items[0].text) && !items[0].num) intro = items.shift().text;
    return { intro: intro, items: items };
  }

  function itemList(items) {
    return '<ul class="bullets">' + items.map(function (it) {
      return '<li' + (it.num ? ' class="num"' : '') + '><span class="ml">' + esc(it.text) + '</span></li>';
    }).join('') + '</ul>';
  }

  /**
   * A cell as HTML. asList: always bullets (expected results); otherwise one line
   * stays plain text and several lines become a list.
   */
  function cellHtml(text, asList) {
    var r = cellItems(text);
    if (!r.items.length && !r.intro) return '';
    if (r.intro) {
      var sub = itemList(r.items);
      return asList ? '<ul class="bullets"><li><div><span class="ml">' + esc(r.intro) + '</span>' + sub + '</div></li></ul>' : '<div class="ml">' + esc(r.intro) + '</div>' + sub;
    }
    if (r.items.length === 1 && !asList) return '<span class="ml">' + esc(r.items[0].text) + '</span>';
    return itemList(r.items);
  }

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
        h.push('<tr><td class="mono">' + esc(f.id) + '</td><td><span class="ml">' + esc(f.scenario) + '</span><div class="small faint">' + esc(f.group) + '</div></td><td class="ml">' + esc(cellLines(f.comment).join('\n')) + '</td><td>' + issueLinks(f.issues) + '</td></tr>');
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
    setTimeout(function () { el.remove(); }, kind === 'bad' || kind === 'long' ? 7000 : 3200); // 'long': a normal message with more to read
  }

  var store = {
    get: function (k) { try { return window.localStorage.getItem('testrun.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem('testrun.' + k, v); } catch (e) { /* storage unavailable */ } }
  };

  return {
    SYM: SYM, CLS_LABEL: CLS_LABEL, esc: esc, api: api, http: http, state: state, classify: classify, counts: counts, bar: bar,
    dot: dot, issueKeys: issueKeys, sameIssues: sameIssues, issueLinks: issueLinks, pct: pct, summaryHtml: summaryHtml,
    cellLines: cellLines, cellItems: cellItems, cellHtml: cellHtml,
    tabLabel: tabLabel, connect: connect, reconnect: reconnect, useInvite: useInvite, forget: forget, parseInvite: parseInvite, download: download, saveBlob: saveBlob,
    conn: function () { return { server: conn.server, gist: conn.gist, hasKey: !!conn.token }; },
    legend: legend, toast: toast, store: store
  };
})();
