import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeCall, digitError, summarizeCall, relTime } from '../extension/lib/digit-errors.js';
import { toCurl, shellQuote } from '../extension/lib/curl.js';
import { currentIteration, selectableIterations, endDateOf } from '../extension/lib/iteration.js';
import { buildTitle, stripKnownPrefix } from '../extension/lib/title.js';
import { buildBody, fence } from '../extension/lib/body.js';
import { renderMarkdown } from '../extension/lib/markdown.js';
import { matchProject, guessModule, originPattern } from '../extension/lib/settings.js';

test('analyzeCall: HTTP errors, DIGIT body errors and network errors', () => {
  const e400 = analyzeCall({ status: 400, resBody: JSON.stringify({ Errors: [{ code: 'INVALID_TENANT_ID', message: 'Invalid tenant id' }] }) });
  assert.deepEqual(e400, { failed: true, errCode: 'INVALID_TENANT_ID', errMsg: 'Invalid tenant id' });

  const ok200err = analyzeCall({ status: 200, resBody: '{"ResponseInfo":{"status":"failed"}}' });
  assert.equal(ok200err.failed, true);
  assert.equal(ok200err.errCode, 'RESPONSE_FAILED');

  const ok = analyzeCall({ status: 200, resBody: '{"ResponseInfo":{"status":"successful"},"ServiceWrappers":[]}' });
  assert.equal(ok.failed, false);

  const net = analyzeCall({ status: 0, error: 'Failed to fetch', errorKind: 'NETWORK_ERROR' });
  assert.equal(net.failed, true);
  assert.equal(net.errMsg, 'Failed to fetch');

  const html500 = analyzeCall({ status: 500, statusText: '', resBody: '<html><body><h1>Internal Server Error</h1></body></html>' });
  assert.equal(html500.errCode, '500');
  assert.equal(html500.errMsg, 'Internal Server Error');

  assert.equal(digitError({ Errors: [] }), null);
  assert.equal(digitError(null), null);
});

test('summarizeCall and relTime', () => {
  assert.equal(relTime(-12000), '−0:12');
  assert.equal(relTime(75000), '+1:15');
  const s = summarizeCall(
    { ts: 1000, url: 'https://x.org/pgr-services/v2/request/_create?tenantId=ke', method: 'POST', status: 400, failed: true, errCode: 'X', errMsg: 'bad' },
    { haltWall: 13000 },
  );
  assert.equal(s, '−0:12 POST /pgr-services/v2/request/_create?tenantId=ke → 400 · X: bad');
});

test('toCurl mirrors DevTools style', () => {
  const c = toCurl({
    method: 'POST',
    url: 'https://x.org/api/_search',
    reqHeaders: { 'content-type': 'application/json', 'auth-token': 'abc' },
    reqBody: '{"RequestInfo":{"authToken":"abc"},"q":"it\'s"}',
  });
  assert.equal(
    c,
    "curl 'https://x.org/api/_search' \\\n  -H 'content-type: application/json' \\\n  -H 'auth-token: abc' \\\n  --data-raw '{\"RequestInfo\":{\"authToken\":\"abc\"},\"q\":\"it'\\''s\"}'",
  );
  assert.equal(toCurl({ method: 'GET', url: 'https://x.org/a' }), "curl 'https://x.org/a'");
  assert.equal(toCurl({ method: 'DELETE', url: 'https://x.org/a' }), "curl 'https://x.org/a' \\\n  -X 'DELETE'");
  assert.match(toCurl({ method: 'PUT', url: 'https://x', reqBody: 'a' }), /-X 'PUT'/);
  assert.equal(shellQuote('a\nb'), "$'a\\nb'");
  const form = toCurl({
    method: 'POST',
    url: 'https://x/upload',
    reqHeaders: { 'Content-Type': 'multipart/form-data; boundary=x' },
    reqBodyKind: 'formdata',
    reqFormData: [{ name: 'tenantId', value: 'ke' }, { name: 'file', file: { name: 'a.png', type: 'image/png' } }],
  });
  assert.doesNotMatch(form, /boundary/);
  assert.match(form, /-F 'file=@a.png;type=image\/png'/);
});

test('iteration selection uses date ranges, not order', () => {
  const its = [
    { id: 'c', title: 'Sprint 12', startDate: '2026-11-24', duration: 14 },
    { id: 'b', title: 'Sprint 11', startDate: '2026-11-10', duration: 14 },
    { id: 'a', title: 'Sprint 10', startDate: '2026-10-27', duration: 14 },
  ];
  const now = new Date(2026, 10, 14); // 14 Nov 2026 local
  assert.equal(currentIteration(its, now).id, 'b');
  assert.deepEqual(selectableIterations(its, now).map((i) => i.id), ['b', 'c']);
  // last day of an iteration is still inside it; the day after is not
  assert.equal(currentIteration(its, new Date(2026, 10, 23)).id, 'b');
  assert.equal(currentIteration(its, new Date(2026, 10, 24)).id, 'c');
  assert.equal(endDateOf(its[1]), '2026-11-23');
  // gap between iterations
  const gap = [{ id: 'x', startDate: '2026-11-01', duration: 7 }, { id: 'y', startDate: '2026-11-20', duration: 7 }];
  assert.equal(currentIteration(gap, now), null);
});

test('title assembly', () => {
  assert.equal(
    buildTitle({ priority: 'P1', priorityMode: 'board', envPrefix: 'Moz', module: 'citizen', shortTitle: 'payment receipt not generated.' }),
    'Moz: Citizen: Payment receipt not generated',
  );
  assert.equal(
    buildTitle({ priority: 'P0', priorityMode: 'title', envPrefix: 'Bomet', module: 'Employee', shortTitle: 'Search returns nothing' }),
    '[P0] Bomet: Employee: Search returns nothing',
  );
  assert.equal(buildTitle({ priority: 'P2', priorityMode: 'issueField', envPrefix: '', module: 'Configurator', shortTitle: 'Blank toast' }), 'Configurator: Blank toast');
  assert.equal(stripKnownPrefix('Bomet: Citizen: OTP not received', { envPrefix: 'Bomet', module: 'Citizen' }), 'OTP not received');
  assert.equal(stripKnownPrefix('[P1] Citizen: OTP', { module: 'Citizen' }), 'OTP');
});

test('body assembly: only filled sections, API blocks, media references', () => {
  const { body } = buildBody({
    description: 'Complaint create fails for GRO.',
    actual: 'Error toast "Something went wrong".',
    expected: '',
    apiCalls: [{ method: 'POST', url: 'https://x/pgr/_create', status: 400, statusText: 'Bad Request', reqBody: '{"a":1}', resBody: '{"Errors":[{"code":"X"}]}' }],
    screenshots: ['snapshot-1.png'],
    video: 'recording.mp4',
  });
  assert.match(body, /^### Description\nComplaint create fails for GRO\./);
  assert.doesNotMatch(body, /Expected Behavior/);
  assert.match(body, /### API Details\n\*\*POST\*\* `https:\/\/x\/pgr\/_create` → \*\*400 Bad Request\*\*/);
  assert.match(body, /```bash\ncurl 'https:\/\/x\/pgr\/_create'/);
  assert.match(body, /```json\n\{\n  "Errors": \[/);
  assert.match(body, /!\[Screenshot 1\]\(\.\/snapshot-1\.png\)/);
  assert.match(body, /### Screen Recording\n!\[\]\(\.\/recording\.mp4\)/);
});

test('body assembly truncates long responses and keeps fences safe', () => {
  const big = JSON.stringify({ data: 'x'.repeat(30000) });
  const { body } = buildBody({ description: 'd', actual: 'a', apiCalls: [{ method: 'GET', url: 'https://x', status: 500, resBody: big }], truncateKB: 1 });
  assert.match(body, /truncated \(29\.\d KB total\)|truncated \(29 KB total\)/);
  assert.ok(body.length < 8000);
  assert.equal(fence('a ``` b', 'text'), '````text\na ``` b\n````');
});

test('markdown preview escapes HTML and resolves media', () => {
  const html = renderMarkdown('### Title\n<script>x</script>\n\n![](./clip.mp4)\n\n```json\n{"a":"<b>"}\n```', {
    resolveMedia: (src) => (src === './clip.mp4' ? 'blob:1' : null),
  });
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<video class="md-video" src="blob:1" controls>/);
  assert.match(html, /<pre><code>\{&quot;a&quot;:&quot;&lt;b&gt;&quot;\}<\/code><\/pre>/);
});

test('project matching by environment URL, module guess, origin pattern', () => {
  const projects = [
    { id: 'a', envUrls: ['https://bgrm.bomet.go.ke'] },
    { id: 'b', envUrls: ['https://unified-dev.digit.org/digit-ui/employee'] },
    { id: 'c', envUrls: ['unified-dev.digit.org'] },
  ];
  assert.equal(matchProject(projects, 'https://bgrm.bomet.go.ke/digit-ui/citizen/home').id, 'a');
  assert.equal(matchProject(projects, 'https://unified-dev.digit.org/digit-ui/employee/pgr').id, 'b');
  assert.equal(matchProject(projects, 'https://unified-dev.digit.org/digit-ui/citizen').id, 'c');
  assert.equal(matchProject(projects, 'https://other.org/'), null);
  assert.equal(guessModule('https://x/digit-ui/citizen/pgr/create'), 'Citizen');
  assert.equal(guessModule('https://x/digit-ui/employee/pgr/inbox'), 'Employee');
  assert.equal(originPattern('http://localhost:3000/a?b'), 'http://localhost/*');
  assert.equal(originPattern('chrome://extensions'), null);
});

import { isStatic } from '../extension/lib/static-files.js';

test('static files are recognised (map tiles, fonts, sprites, build info), APIs are not', () => {
  const s = (method, url, extra = {}) => isStatic({ method, url, status: 200, ...extra });
  assert.equal(s('GET', 'https://tiles.example.org/fonts/Noto%20Sans%20Bold/0-255.pbf'), true);
  assert.equal(s('GET', 'https://tiles.example.org/sprites/ofm_f384/ofm@2x.png'), true);
  assert.equal(s('GET', 'https://tiles.example.org/sprites/ofm_f384/ofm@2x.json'), true);
  assert.equal(s('GET', 'https://tiles.example.org/planet'), true);
  assert.equal(s('GET', 'https://tiles.example.org/styles/liberty'), true);
  assert.equal(s('GET', 'https://x.org/digit-ui/build-info.json?t=1794735211906'), true);
  assert.equal(s('GET', 'https://x.org/img', { resHeaders: { 'content-type': 'image/png' } }), true);
  assert.equal(s('POST', 'https://x.org/boundary-service/boundary/_search?tenantId=nb&codes=WARD_017'), false);
  assert.equal(s('POST', 'https://x.org/mdms-v2/v1/_search?tenantId=nb'), false);
  assert.equal(s('GET', 'https://x.org/egov-hrms/employees/_search?tenantId=nb'), false);
  assert.equal(isStatic({ method: 'GET', url: 'https://x.org/fonts/a.pbf', status: 404, failed: true }), false, 'failed calls always show');
});

test('recording clock: pauses left out, frozen once stopped', async () => {
  const { elapsedUs } = await import('../extension/lib/rec-clock.js');
  const s = { state: 'recording', startPerf: 1000, pausedTotal: 0, pauseStart: 0, stopPerf: 0 };
  assert.equal(elapsedUs(s, 11000), 10e6, 'recording: 10 s');
  Object.assign(s, { state: 'paused', pauseStart: 11000 });
  assert.equal(elapsedUs(s, 16000), 10e6, 'paused: the pause does not count');
  Object.assign(s, { state: 'recording', pausedTotal: 5000 });
  assert.equal(elapsedUs(s, 18000), 12e6, 'resumed: 10 s + 2 s');
  Object.assign(s, { state: 'stopped', stopPerf: 18000 });
  assert.equal(elapsedUs(s, 18000), 12e6);
  assert.equal(elapsedUs(s, 60000), 12e6, 'stopped: the time stays still');
  const p = { state: 'stopped', startPerf: 1000, pauseStart: 5000, pausedTotal: 3000, stopPerf: 8000 }; // stopped while paused (stop() adds that pause)
  assert.equal(elapsedUs(p, 99000), 4e6);
  assert.equal(elapsedUs({ state: 'idle', startPerf: 0 }, 5000), 0, 'not started');
});
