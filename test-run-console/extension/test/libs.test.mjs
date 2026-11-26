// The extension's own logic: access links, where Test Run opens, the media limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLink, consoleUrl, request, Offline } from '../lib/testrun.js';
import { fitWithin, fmtBytes, fmtClip, fmtTime, limitsLine, stopAtBytes, pickMime, withoutEvidenceLine, elapsedMs } from '../lib/media.js';

test('access links: a teammate\'s link, a gist link, a link straight to Test Run, the laptop itself', () => {
  assert.deepEqual(parseLink('https://org.github.io/repo/test-run/#join=abc_DEF-123&server=https%3A%2F%2Fx.trycloudflare.com'),
    { link: 'https://org.github.io/repo/test-run/#join=abc_DEF-123&server=https%3A%2F%2Fx.trycloudflare.com', server: 'https://x.trycloudflare.com', key: 'abc_DEF-123', gist: '', local: false });
  assert.equal(parseLink('https://org.github.io/repo/test-run/#join=k1&gist=00ff').gist, '00ff');
  assert.equal(parseLink('https://tests.example.org/#join=k2').server, 'https://tests.example.org');
  assert.deepEqual(parseLink(' http://127.0.0.1:5178/ '), { link: 'http://127.0.0.1:5178/', server: 'http://127.0.0.1:5178', key: '', gist: '', local: true });
  assert.equal(parseLink('https://example.org/page'), null, 'not a link without a key');
  assert.equal(parseLink('#join=&server=x'), null);
  assert.equal(parseLink(''), null);
});

test('Choose Workbook/Suite opens Test Run signed in, on the right screen', () => {
  const conn = parseLink('https://org.github.io/repo/test-run/#join=k1&server=https%3A%2F%2Fx.example');
  assert.equal(consoleUrl(conn, 'run'), 'https://org.github.io/repo/test-run/?view=run#join=k1&server=https%3A%2F%2Fx.example');
  assert.equal(consoleUrl(parseLink('http://127.0.0.1:5178'), 'summary'), 'http://127.0.0.1:5178/?view=summary');
  assert.equal(consoleUrl(conn, 'run', { book: 'CMS Sign Off.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.12', case: 'CMS/07' }),
    'https://org.github.io/repo/test-run/?view=run&book=CMS+Sign+Off.xlsx&tab=CMS+2.20.1&cycle=v2.12&case=CMS%2F07#join=k1&server=https%3A%2F%2Fx.example', 'the case ID opens Test Run on that case');
});

test('media: photos fit 1920×1080, sizes and lengths read well, recordings stop before the cap', () => {
  assert.deepEqual(fitWithin(2880, 1800, 1920, 1080), { width: 1728, height: 1080, scale: 0.6 });
  assert.equal(fitWithin(1280, 720, 1920, 1080).scale, 1, 'never made larger');
  assert.deepEqual([fmtBytes(412 * 1024), fmtBytes(6.3 * 1024 * 1024), fmtBytes(20 * 1024 * 1024)], ['412 KB', '6.3 MB', '20 MB']);
  assert.deepEqual([fmtClip(67), fmtClip(111), fmtTime(42)], ['about 1 min 10 s', 'about 1 min 50 s', '00:42']);
  assert.equal(limitsLine({ quality: '1080p', fps: 30, maxSeconds: 70 }), 'Video limit: 01m 10s');
  assert.equal(limitsLine({ quality: '1080p', fps: 30, maxSeconds: 67.9 }), 'Video limit: 01m 07s', 'never rounded up');
  assert.equal(limitsLine({ quality: '720p', fps: 15, maxSeconds: 605 }), 'Video limit: 10m 05s');
  const max = 20 * 1024 * 1024;
  const at = stopAtBytes(max, 2500000);
  assert.ok(at < max - 600000 && at > max - 800000, `stops ~2 s early (${max - at} bytes of room)`);
  assert.equal(pickMime((t) => t.startsWith('video/webm'), false), 'video/webm;codecs=vp9');
  assert.equal(pickMime((t) => t.startsWith('video/mp4'), true), 'video/mp4;codecs=avc1,mp4a.40.2', 'MP4 first where Chrome can make it');
  assert.equal(withoutEvidenceLine('Labels missing\nEvidence: CMS-07_v2.12.png, CMS-07_v2.12.mp4\n'), 'Labels missing');
  assert.equal(elapsedMs({ t0: 1000, pausedMs: 2000, pausedAt: 0 }, 10000), 7000, 'pauses do not count');
  assert.equal(elapsedMs({ t0: 1000, pausedMs: 2000, pausedAt: 8000 }, 10000), 5000, 'nor does the pause going on');
});

test('requests carry the key; a moved address is found through the gist once', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push([url, opts.headers.Authorization || '']);
    if (url.startsWith('https://old.example')) throw new TypeError('fetch failed');
    if (url.startsWith('https://api.github.com/gists/')) return new Response(JSON.stringify({ files: { 'test-run.json': { content: JSON.stringify({ app: 'test-run', url: 'https://new.example' }) } } }));
    return new Response(JSON.stringify({ ok: true, app: 'test-run', me: { name: 'John Doe', role: 'tester' } }));
  };
  try {
    const conn = parseLink('https://org.github.io/r/test-run/#join=key1&server=https%3A%2F%2Fold.example&gist=abc');
    let moved = '';
    const r = await request(conn, 'GET', '/api/status', { onMove: (s) => { moved = s; } });
    assert.equal(r.me.name, 'John Doe');
    assert.equal(moved, 'https://new.example');
    assert.equal(conn.server, 'https://new.example');
    assert.deepEqual(calls.map((c) => c[1]), ['Bearer key1', '', 'Bearer key1'], 'the key goes to Test Run only, not to GitHub');
    await assert.rejects(request(parseLink('https://old.example/#join=k'), 'GET', '/api/status'), Offline);
  } finally { globalThis.fetch = real; }
});

test('a tunnel that is gone (Cloudflare\'s HTML page, no JSON) counts as no answer', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.startsWith('https://gone.trycloudflare.com')) return new Response('<html>Error 1033</html>', { status: 530, headers: { 'content-type': 'text/html' } });
    if (url.startsWith('https://api.github.com/gists/')) return new Response(JSON.stringify({ files: { 'test-run.json': { content: JSON.stringify({ app: 'test-run', url: 'https://new.trycloudflare.com' }) } } }));
    return new Response(JSON.stringify({ ok: true, app: 'test-run' }));
  };
  try {
    let moved = '';
    const conn = parseLink('https://org.github.io/r/test-run/#join=k&server=https%3A%2F%2Fgone.trycloudflare.com&gist=abc');
    const r = await request(conn, 'GET', '/api/status', { onMove: (s) => { moved = s; } });
    assert.equal(r.ok, true);
    assert.equal(moved, 'https://new.trycloudflare.com', 'the gist names the new address');
    await assert.rejects(request(parseLink('https://org.github.io/r/test-run/#join=k&server=https%3A%2F%2Fgone.trycloudflare.com'), 'GET', '/api/status'), Offline);
  } finally { globalThis.fetch = real; }
});

test('the manifest: its fixed ID, and no more permissions than it needs', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.name, 'Test Run Extension');
  assert.ok(m.key && m.key.length > 300);
  assert.deepEqual(m.permissions, ['storage', 'activeTab']);
  // trycloudflare: the shared Test Run's address. With access, Chrome sends no CORS preflight,
  // so a tunnel that is gone does not log "blocked by CORS policy" on the Errors page.
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*', 'https://*.trycloudflare.com/*']);
});
