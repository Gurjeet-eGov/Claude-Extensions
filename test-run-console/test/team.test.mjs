// Sharing Test Run with a team: invite keys, what testers and viewers may do,
// requests through a tunnel, CORS for the hosted page, the quick tunnel and
// the gist that keeps its address findable. Fake cloudflared and gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';
import { makeFakeCloudflared, makeFakeGh } from '../dev/fake-tools.mjs';
import { inviteLink, normalizeTeam, addPerson, personForKey, isLocalRequest, mayCall, pagesUrlFromRemote, cleanUrl } from '../lib/team.mjs';

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';
const TUNNEL_HOST = 'quick-brown-fox.trycloudflare.com';

/** A stand-in for the console on GitHub Pages: /test-run/ serves a page with the console's marker; anything else is 404. */
async function hostedPage() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/test-run/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><meta name="test-run-console" content="1"><title>Test Run</title>'); return; }
    res.writeHead(404); res.end('Not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${srv.address().port}`;
  return { url: `${root}/test-run/`, missing: `${root}/not-deployed/`, close: () => srv.close() };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function start({ ghFail = false, cloudflared = {}, sheets: given, restartDelays } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testrun-team-'));
  const sheets = given || join(dir, 'sheets');
  const tools = mkdtempSync(join(tmpdir(), 'testrun-tools-'));
  const cf = makeFakeCloudflared(tools, cloudflared);
  const gh = makeFakeGh(tools, { fail: ghFail });
  const server = createServer({ sheetsDir: sheets, tunnelBin: cf.bin, ghPath: gh.bin, tailscaleBin: '/nope/tailscale', restartDelays });
  if (!given) writeFileSync(join(sheets, BOOK), await buildSampleXlsx());
  const base = await server.listenOn(0);
  const port = new URL(base).port;
  /** A request as it arrives through a tunnel: the public host name and a forwarding header. */
  const remote = (method, path, { key, body, origin, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { 'X-Test-Run': '1', Host: TUNNEL_HOST, 'X-Forwarded-For': '203.0.113.7', ...headers };
    if (key) h.Authorization = `Bearer ${key}`;
    if (origin) h.Origin = origin;
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = { text: b }; } resolve({ status: res.statusCode, headers: res.headers, ...j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const local = async (method, path, body) => {
    const r = await fetch(base + path.replace(/^\//, ''), { method, headers: { 'X-Test-Run': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };
  const call = (fn, args = [], who = {}) => (who.key
    ? remote('POST', `/api/call/${fn}`, { key: who.key, body: { book: BOOK, args } })
    : local('POST', `/api/call/${fn}`, { book: BOOK, args }));
  if (!given) {
    const boot = await call('api_bootstrap');
    await call('api_saveSetup', [{ tabs: boot.tabs.map((t) => ({ name: t.name, ...t.detected })) }]);
    await call('api_addColumns', [TAB, ['testedBy']]);
  }
  // A fixed address that reaches this very server (so "Check" works without the internet).
  const fixed = base.replace(/\/$/, '');
  return { server, base, fixed, sheets, remote, local, call, cf, gh, close: () => server.close() };
}

const keyOf = (link) => new URLSearchParams(link.split('#')[1]).get('join');

test('without an invite key, a request through a tunnel learns nothing and changes nothing', async () => {
  const s = await start();
  try {
    const st = await s.remote('GET', '/api/status');
    assert.deepEqual([st.ok, st.app, st.auth], [true, 'test-run', 'required']);
    assert.equal(st.book, undefined, 'no workbook names');
    const app = await s.remote('GET', '/api/app');
    assert.deepEqual([app.status, app.code], [401, 'AUTH']);
    assert.match(app.error, /not shared/, 'sharing is off by default');
    assert.equal((await s.remote('POST', '/api/call/api_loadTab', { body: { book: BOOK, args: [TAB] } })).status, 401);
    assert.equal((await s.remote('GET', '/api/app', { key: 'x'.repeat(32) })).status, 401, 'a made-up key');
    const spoof = await s.remote('GET', '/api/app', { headers: { Host: `127.0.0.1:${new URL(s.base).port}` } });
    assert.equal(spoof.status, 401, 'a tunnel that rewrites Host to 127.0.0.1 is still not the owner (forwarding header)');
  } finally { s.close(); }
});

test('testers mark results under their own name; viewers only look; Setup stays with the owner', async () => {
  const s = await start();
  try {
    const on = await s.local('POST', '/api/team', { enabled: true, mode: 'fixed', fixedUrl: s.fixed });
    assert.equal(on.ok, true, on.error);
    assert.deepEqual([on.checks.fixed.ok, on.checks.fixed.message], [true, 'Reaches this Test Run.'], 'saving a fixed address checks it reaches this Test Run');
    const priya = await s.local('POST', '/api/team/people', { name: 'Priya (QA)', role: 'tester' });
    assert.equal(priya.ok, true, priya.error);
    assert.equal(priya.linkWarning, '', 'a fixed address lasts');
    assert.ok(priya.link.startsWith(`${s.fixed}/#join=`));
    const boss = await s.local('POST', '/api/team/people', { name: 'Manager', role: 'viewer' });
    const tester = { key: keyOf(priya.link) };
    const viewer = { key: keyOf(boss.link) };
    assert.equal(/hash|"key"/.test(JSON.stringify(priya.people)), false, 'keys and hashes never leave the server in listings');
    assert.equal(statSync(join(s.sheets, '.testrun', 'app.json')).mode & 0o777, 0o600, 'the file holding the keys is readable by the owner only');

    const me = await s.remote('GET', '/api/app', { key: tester.key });
    assert.deepEqual(me.me, { name: 'Priya (QA)', role: 'tester', local: false });
    assert.equal(me.sheetsDir, '', 'no laptop paths for remote people');
    const d = await s.call('api_loadTab', [TAB, ''], tester);
    const c = d.cases.find((x) => x.id === 'CMS/04');
    const m = await s.call('api_mark', [{ tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: '', status: 'Pass' }], tester);
    assert.equal(m.ok, true, m.error);
    assert.equal(m.testedBy, 'Priya (QA)', 'Tested by is the teammate, not the laptop owner');
    assert.equal((await s.call('api_saveSetup', [{ tabs: [] }], tester)).status, 403, 'Setup is the owner\'s');
    assert.equal((await s.call('api_startCycle', [TAB, 'v9'], tester)).status, 403, 'so are cycles');
    assert.equal((await s.remote('GET', '/api/team', { key: tester.key })).status, 403);
    assert.equal((await s.remote('POST', '/api/app', { key: tester.key, body: { user: 'x' } })).status, 403);

    assert.equal((await s.call('api_summary', [TAB, ''], viewer)).ok, true, 'viewers see the summary');
    const vm = await s.call('api_mark', [{ tab: TAB, key: c.key, sh: c.sh, row: c.row, cycle: 'v2.12', expect: 'Pass', status: '' }], viewer);
    assert.deepEqual([vm.status, vm.code], [403, 'FORBIDDEN']);
    assert.equal((await s.remote('POST', '/api/note-bug', { key: viewer.key, body: { title: 'x' } })).status, 403);
    const dl = await s.remote('GET', `/api/books/download?name=${encodeURIComponent(BOOK)}`, { key: viewer.key });
    assert.equal(dl.status, 200, 'anyone invited may download the workbook');

    const status = await s.remote('GET', '/api/status', { key: tester.key });
    assert.equal(status.consoleUrl, `${s.fixed}/`, 'Bug Reporter is told where to open the console');
    const seen = await s.local('GET', '/api/team');
    assert.ok(seen.people.find((p) => p.name === 'Priya (QA)').lastSeen, 'last seen is kept');

    // A lost link can be copied again: the same link, still working.
    const id = seen.people.find((p) => p.name === 'Priya (QA)').id;
    assert.equal(seen.people.find((p) => p.id === id).canCopy, true);
    const again = await s.local('POST', '/api/team/people/link', { id });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.link, priya.link, 'the same link as when they were added');
    assert.equal((await s.remote('POST', '/api/team/people/link', { key: tester.key, body: { id } })).status, 403, 'only the owner, at the laptop');
    // A new link replaces the old one; removing someone shuts them out at once.
    const rot = await s.local('POST', '/api/team/people/update', { id, rotate: true });
    assert.equal((await s.remote('GET', '/api/app', { key: tester.key })).status, 401, 'old link stops working');
    assert.equal((await s.local('POST', '/api/team/people/link', { id })).link, rot.link, 'Copy link now gives the new one');
    assert.equal((await s.remote('GET', '/api/app', { key: keyOf(rot.link) })).status, 200, 'new link works');
    await s.local('POST', '/api/team/people/update', { id, role: 'viewer' });
    assert.equal((await s.remote('GET', '/api/app', { key: keyOf(rot.link) })).me.role, 'viewer', 'role changes apply at once');
    await s.local('POST', '/api/team/people/remove', { id });
    assert.equal((await s.remote('GET', '/api/app', { key: keyOf(rot.link) })).status, 401);
    await s.local('POST', '/api/team', { enabled: false });
    assert.equal((await s.remote('GET', '/api/app', { key: viewer.key })).status, 401, 'turning sharing off shuts everyone out');
  } finally { s.close(); }
});

test('the hosted page may call it cross-origin (CORS), with the key as the only credential', async () => {
  const s = await start();
  try {
    await s.local('POST', '/api/team', { enabled: true, mode: 'fixed', fixedUrl: s.fixed });
    const p = await s.local('POST', '/api/team/people', { name: 'A', role: 'tester' });
    const pre = await s.remote('OPTIONS', '/api/app', { origin: 'https://owner.github.io', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-test-run' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://owner.github.io');
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
    const r = await s.remote('GET', '/api/app', { key: keyOf(p.link), origin: 'https://owner.github.io' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], 'https://owner.github.io');
    assert.equal(r.headers['access-control-allow-credentials'], undefined, 'no cookies, ever');
    const page = await fetch(s.base);
    assert.equal(page.status, 200);
  } finally { s.close(); }
});

test('sharing: a quick tunnel gives the address, the gist keeps it, links point at the hosted page', async () => {
  const s = await start();
  const hp = await hostedPage();
  try {
    const saved = await s.local('POST', '/api/team', { enabled: true, publish: true, hostedUrl: hp.url });
    assert.deepEqual([saved.checks.hosted.ok, saved.checks.hosted.code], [true, 'LIVE'], 'the hosted page is checked when saved');
    const early = await s.local('POST', '/api/team/people', { name: 'Too early', role: 'tester' });
    assert.deepEqual([early.code, early.ok], ['NO_ADDRESS', false], 'no link is made that cannot find the laptop');
    assert.equal((await s.local('GET', '/api/team')).people.length, 0, 'and nobody is added');
    const on = await s.local('POST', '/api/team/share', { on: true });
    assert.equal(on.ok, true, on.error);
    assert.equal(on.canInvite, true);
    assert.equal(on.address.tunnel.url, s.cf.url);
    assert.equal(on.address.effective, s.cf.url);
    assert.deepEqual(JSON.parse(readFileSync(s.cf.log, 'utf8').trim()).slice(-2), ['--url', `http://127.0.0.1:${new URL(s.base).port}`], 'the tunnel points at this server');
    assert.equal(on.team.gist, s.gh.id, 'a gist was made');
    const gh = JSON.parse(readFileSync(s.gh.log, 'utf8').trim().split('\n')[0]);
    assert.deepEqual(gh.args.slice(0, 4), ['api', '-X', 'POST', 'gists']);
    assert.equal(gh.body.public, false, 'a secret gist');
    assert.deepEqual(JSON.parse(gh.body.files['test-run.json'].content).url, s.cf.url);

    const p = await s.local('POST', '/api/team/people', { name: 'Ravi', role: 'tester' });
    assert.ok(p.link.startsWith(`${hp.url}#join=`), p.link);
    assert.match(p.link, /&gist=0123456789abcdef/);
    assert.equal(p.linkWarning, '');

    const off = await s.local('POST', '/api/team/share', { on: false });
    assert.equal(off.address.tunnel.running, false);
    await s.local('POST', '/api/team/share', { on: true });
    const lines = readFileSync(s.gh.log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'same address: the gist is not rewritten');
  } finally { s.close(); hp.close(); }
});

test('a hosted page that is not live is reported, and links name the address meanwhile', async () => {
  const s = await start();
  const hp = await hostedPage();
  try {
    const repo = await s.local('POST', '/api/team', { enabled: true, publish: true, hostedUrl: 'https://github.com/Owner/Repo/tree/branch/test-run-console' });
    assert.equal(repo.code, 'BAD_INPUT', 'a github.com repository page is refused');
    assert.match(repo.error, /GitHub Pages address/);
    const missing = await s.local('POST', '/api/team', { hostedUrl: hp.missing });
    assert.deepEqual([missing.checks.hosted.ok, missing.checks.hosted.code], [false, 'NOT_LIVE']);
    await s.local('POST', '/api/team/share', { on: true });
    const p = await s.local('POST', '/api/team/people', { name: 'Ravi', role: 'tester' });
    assert.equal(p.link.split('#')[0], `${s.cf.url}/`, 'the link opens the console on the laptop directly');
    assert.match(p.linkWarning, /not live yet/);
    const fixedUp = await s.local('POST', '/api/team', { hostedUrl: hp.url });
    assert.equal(fixedUp.checks.hosted.ok, true);
    const p2 = await s.local('POST', '/api/team/people', { name: 'Asha', role: 'viewer' });
    assert.ok(p2.link.startsWith(hp.url), 'once live, links open the hosted page');
  } finally { s.close(); hp.close(); }
});

test('a dropped tunnel comes back by itself with its new address in the gist; sharing resumes when Test Run restarts', async () => {
  const urls = ['https://first-try.trycloudflare.com', 'https://second-try.trycloudflare.com'];
  const s = await start({ cloudflared: { urls, exitAfterMs: 1500 }, restartDelays: [100] });
  let s2 = null;
  try {
    await s.local('POST', '/api/team', { enabled: true, publish: true });
    const on = await s.local('POST', '/api/team/share', { on: true });
    assert.equal(on.address.tunnel.url, urls[0]);
    assert.equal(on.team.sharing, true);
    // cloudflared exits: Test Run notices, says so, and starts it again
    const gistWrites = () => readFileSync(s.gh.log, 'utf8').trim().split('\n').length;
    const back = await until(async () => { const t = await s.local('GET', '/api/team'); return t.address.tunnel.url === urls[1] && gistWrites() === 2 && t; });
    assert.equal(back.address.effective, urls[1]);
    const gists = readFileSync(s.gh.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(gists.map((g) => JSON.parse(g.body.files['test-run.json'].content).url), urls, 'the gist follows the new address');
    assert.deepEqual(gists[1].args.slice(0, 3), ['api', '-X', 'PATCH'], 'the same gist is updated');
    // Test Run stops (Ctrl+C) and starts again: sharing comes back on
    await s.local('POST', '/api/team/share', { on: false });
    assert.equal(s.server.share.wanted(), false, 'Stop means stop');
    await s.local('POST', '/api/team/share', { on: true });
    s.server.share.stop({ forget: false });
    s.close();
    s2 = await start({ sheets: s.sheets });
    assert.equal(s2.server.share.wanted(), true, 'a restarted Test Run shares again');
  } finally { s.close(); if (s2) s2.close(); }
});

test('a fixed address through a Cloudflare named tunnel: Test Run runs it', async () => {
  const s = await start();
  try {
    const bad = await s.local('POST', '/api/team', { enabled: true, mode: 'fixed', tunnelName: 'no spaces allowed' });
    assert.equal(bad.code, 'BAD_INPUT');
    await s.local('POST', '/api/team', { mode: 'fixed', fixedUrl: s.fixed, tunnelName: 'test-run' });
    const on = await s.local('POST', '/api/team/share', { on: true });
    assert.equal(on.ok, true, on.error);
    assert.deepEqual([on.address.tunnel.kind, on.address.tunnel.running, on.address.effective], ['named', true, s.fixed]);
    assert.deepEqual(JSON.parse(readFileSync(s.cf.log, 'utf8').trim()), ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${new URL(s.base).port}`, 'test-run']);
    assert.equal(on.checks.fixed.ok, true);
    const off = await s.local('POST', '/api/team/share', { on: false });
    assert.equal(off.address.tunnel.running, false);
  } finally { s.close(); }
});

test('sharing problems are reported, not thrown', async () => {
  const s = await start({ ghFail: true });
  const hp = await hostedPage();
  try {
    await s.local('POST', '/api/team', { enabled: true, publish: true, hostedUrl: hp.url });
    const on = await s.local('POST', '/api/team/share', { on: true });
    assert.equal(on.address.tunnel.url, s.cf.url, 'the tunnel still works');
    assert.match(on.team.publishError, /Bad credentials/);
    const p = await s.local('POST', '/api/team/people', { name: 'Ravi', role: 'tester' });
    assert.match(p.link, /&server=https%3A%2F%2Fquick-brown-fox/, 'without the gist, the link names the address');
    assert.match(p.linkWarning, /gist is not ready/);
    assert.equal((await s.local('POST', '/api/team', { fixedUrl: 'ftp://x' })).code, 'BAD_INPUT');
  } finally { s.close(); hp.close(); }
  const srv = createServer({ sheetsDir: mkdtempSync(join(tmpdir(), 'testrun-team-')), tunnelBin: '/nope/cloudflared' });
  await srv.listenOn(0);
  try {
    srv.share.enable();
    await srv.share.start();
    assert.match(srv.share.info().address.tunnel.error, /brew install cloudflared/);
  } finally { srv.close(); }
});

test('team helpers: invite links, keys, local requests, permissions, the Pages address', () => {
  const team = normalizeTeam({ enabled: true });
  const { person, key } = addPerson(team, { name: 'A', role: 'nonsense' });
  assert.equal(person.role, 'tester', 'unknown roles become tester');
  assert.equal(personForKey(team, key), person);
  assert.equal(normalizeTeam({ enabled: true, people: [{ ...person }] }).people[0].key, key, 'the key is kept when it matches its hash');
  assert.equal(normalizeTeam({ enabled: true, people: [{ ...person, key: 'x'.repeat(32) }] }).people[0].key, '', 'a key that does not match is dropped');
  const { key: _k, ...older } = person;
  assert.equal(normalizeTeam({ enabled: true, people: [older] }).people[0].key, '', 'people added before keys were kept: no copy, New link once');
  assert.equal(personForKey(team, key + 'x'), null);
  assert.equal(personForKey({ ...team, enabled: false }, key), null);
  assert.deepEqual(inviteLink(team, 'https://a.example', 'K'), { link: 'https://a.example/#join=K', warning: inviteLink(team, 'https://a.example', 'K').warning });
  assert.match(inviteLink(team, 'https://a.example', 'K').warning, /changes when sharing restarts/);
  assert.equal(inviteLink({ ...team, mode: 'fixed', fixedUrl: 'https://a.example' }, 'https://a.example', 'K').warning, '', 'a fixed address lasts');
  assert.equal(normalizeTeam({ fixedUrl: 'https://a.example' }).mode, 'fixed', 'an existing fixed address keeps working after the upgrade');
  assert.equal(normalizeTeam({}).mode, 'quick');
  const hosted = { ...team, hostedUrl: 'https://o.github.io/r/test-run', publish: true, gist: 'abc' };
  assert.equal(inviteLink(hosted, 'https://a.example', 'K', { hostedLive: false }).link, 'https://a.example/#join=K', 'not live: straight to the laptop');
  assert.equal(inviteLink({ ...team, hostedUrl: 'https://o.github.io/r/test-run', publish: true, gist: 'abc' }, '', 'K').link, 'https://o.github.io/r/test-run/#join=K&gist=abc');
  assert.deepEqual([inviteLink(team, '', 'K').link, /no address yet/.test(inviteLink(team, '', 'K').warning)], ['', true]);
  assert.equal(inviteLink({ ...team, hostedUrl: 'https://o.github.io/r/test-run' }, '', 'K').link, '', 'a hosted page alone cannot find the laptop');
  const req = (host, extra = {}) => ({ headers: { host, ...extra } });
  assert.equal(isLocalRequest(req('127.0.0.1:5178'), 5178), true);
  assert.equal(isLocalRequest(req('localhost:5178'), 5178), true);
  assert.equal(isLocalRequest(req('127.0.0.1:5178', { 'cf-connecting-ip': '1.2.3.4' }), 5178), false);
  assert.equal(isLocalRequest(req('x.trycloudflare.com'), 5178), false);
  assert.equal(mayCall({ role: 'viewer' }, 'api_summary'), true);
  assert.equal(mayCall({ role: 'viewer' }, 'api_mark'), false);
  assert.equal(mayCall({ role: 'tester' }, 'api_mark'), true);
  assert.equal(mayCall({ role: 'tester' }, 'api_saveSetup'), false);
  assert.equal(mayCall({ role: 'owner' }, 'api_saveSetup'), true);
  assert.equal(pagesUrlFromRemote('https://github.com/Gurjeet-eGov/Claude-Extensions.git'), 'https://gurjeet-egov.github.io/Claude-Extensions/test-run/');
  assert.equal(pagesUrlFromRemote('git@github.com:Org/repo.git'), 'https://org.github.io/repo/test-run/');
  assert.equal(cleanUrl('https://x.example/path/'), 'https://x.example/path');
  assert.equal(cleanUrl('javascript:alert(1)'), '');
});
