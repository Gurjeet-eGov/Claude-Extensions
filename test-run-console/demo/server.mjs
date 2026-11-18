// Local demo: the real console pages and the real .gs server code, running
// against an in-memory sample workbook. Nothing touches Google.
//
//   npm run demo            -> http://127.0.0.1:5178
//   PORT=6000 npm run demo
//
// The page's google.script.run calls are forwarded to /api/<function>.
// /__admin/* endpoints let tests act as "another tester" editing the sheet.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServer, SRC } from '../dev/load.mjs';
import { buildSample } from '../dev/sample-workbook.mjs';

const SHIM = `
window.google = { script: { run: (function make(h) {
  return new Proxy({}, { get: function (_, prop) {
    if (prop === 'withSuccessHandler') return function (fn) { return make(Object.assign({}, h, { ok: fn })); };
    if (prop === 'withFailureHandler') return function (fn) { return make(Object.assign({}, h, { fail: fn })); };
    return function () {
      var args = Array.prototype.slice.call(arguments);
      fetch('/api/' + String(prop), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.__thrown) { if (h.fail) h.fail(new Error(res.message)); }
          else if (h.ok) h.ok(res);
        }, function (err) { if (h.fail) h.fail(err); });
    };
  } });
})({}) } };
`;

export function createDemo({ email = 'you@example.org', latency = Number(process.env.DEMO_LATENCY || 250) } = {}) {
  let ss;
  let srv;
  function reset() {
    ss = buildSample();
    srv = loadServer(ss, { email, url: null });
  }
  reset();

  function page(view, params) {
    let html = readFileSync(join(SRC, `${view}.html`), 'utf8');
    html = html.replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, n) => readFileSync(join(SRC, `${n}.html`), 'utf8'));
    html = html.replace(/<\?!=\s*params\s*\?>/g, JSON.stringify(params).replace(/</g, '\\u003c'));
    html = html.replace(/<\?!=\s*JSON\.stringify\(mode\)\s*\?>/g, '"demo"');
    return html.replace('<body>', '<body>\n<script src="/__shim.js"></script>');
  }

  async function readJson(req) {
    let body = '';
    for await (const chunk of req) body += chunk;
    return body ? JSON.parse(body) : null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/exec')) {
        const params = Object.fromEntries(url.searchParams);
        return send(200, 'text/html; charset=utf-8', page(params.view === 'summary' ? 'summary' : 'console', params));
      }
      if (req.method === 'GET' && url.pathname === '/__shim.js') return send(200, 'application/javascript', SHIM);
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const fn = url.pathname.slice(5);
        if (!/^api_\w+$/.test(fn)) return send(404, 'application/json', '{}');
        const args = (await readJson(req)) || [];
        if (latency) await new Promise((r) => setTimeout(r, latency));
        let out;
        try { out = srv.call(fn, ...args); } catch (e) { out = { __thrown: true, message: e.message }; }
        return send(200, 'application/json', JSON.stringify(out === undefined ? null : out));
      }
      if (req.method === 'POST' && url.pathname === '/__admin/reset') { reset(); srv.state.url = server.appUrl; return send(200, 'application/json', '{"ok":true}'); }
      if (req.method === 'POST' && url.pathname === '/__admin/set') {
        const { tab, row, col, value } = await readJson(req);
        ss.getSheetByName(tab).getRange(row, col).setValue(value);
        return send(200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/__admin/user') {
        const { email: e, readOnly } = await readJson(req);
        if (e) srv.state.email = e;
        if (readOnly != null) ss.readOnly = !!readOnly;
        return send(200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'GET' && url.pathname === '/__admin/dump') {
        const sh = ss.getSheetByName(url.searchParams.get('tab'));
        return send(200, 'application/json', JSON.stringify(sh ? sh.dump() : null));
      }
      return send(404, 'text/plain', 'Not found');
    } catch (e) {
      return send(500, 'text/plain', String(e.stack || e));
    }
  });

  server.listenOn = (port = 0) => new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      server.appUrl = `http://127.0.0.1:${addr.port}/exec`;
      srv.state.url = server.appUrl;
      resolve(`http://127.0.0.1:${addr.port}/`);
    });
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = createDemo();
  demo.listenOn(Number(process.env.PORT || 5178)).then((u) => {
    console.log(`Test Run demo: ${u}`);
    console.log('Sample data only. Ctrl+C to stop.');
  });
}
