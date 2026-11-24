// Automated results, framework-agnostic (lib/automation/results.mjs): JUnit XML from Playwright,
// pytest, Maven surefire, Robot and Cypress, CTRF JSON, and a zip of several; masking; failure
// signatures and grouping by cause; the comparisons the run view shows; the size kept per 1,000 tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import {
  parseResults, detectFormat, maskText, compileMasking, compileCasePattern, signature, groupCauses, buildRun, cleanAttach,
  previousRun, compareRuns, historyOf, lineOf, byFile, passRate, metaOf, filesFromMultipart, splitFailure, RUN_ID,
} from '../lib/automation/results.mjs';

const fx = (name) => readFileSync(new URL(`./fixtures/automation/${name}`, import.meta.url));
const parse = (name, opts = {}) => parseResults([{ name, buf: fx(name) }], opts);
const byTitle = (r, t) => r.tests.find((x) => x.title.includes(t));
const ATTACH = { book: 'CMS Sign Off.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.12' };

test('the format is found from the content, never the file name', async () => {
  assert.equal(detectFormat(fx('playwright-junit.xml')), 'junit');
  assert.equal(detectFormat(fx('surefire.xml')), 'junit', 'a lone <testsuite>');
  assert.equal(detectFormat(fx('ctrf-report.json')), 'ctrf');
  assert.equal(detectFormat(Buffer.from('{"results":{"tests":[]}}')), 'ctrf');
  assert.equal(detectFormat(Buffer.from('\uFEFF<?xml version="1.0"?><testsuites></testsuites>')), 'junit', 'a byte-order mark first');
  assert.equal(detectFormat(Buffer.from('{"stats":{}}')), null, 'some other JSON');
  assert.equal(detectFormat(Buffer.from('<html><body>report</body></html>')), null, 'an HTML report');
  assert.equal(detectFormat(Buffer.from('PASS 12 tests')), null);
  await assert.rejects(parseResults([{ name: 'notes.txt', buf: Buffer.from('all good') }]), (e) => e.code === 'BAD_FORMAT' && /JUnit XML or CTRF JSON/.test(e.message));
  await assert.rejects(parseResults([{ name: 'broken.xml', buf: Buffer.from('<testsuites><testsuite><testcase name="a"></testsuites>') }]), (e) => e.code === 'BAD_FORMAT' && /broken\.xml/.test(e.message));
});

test('Playwright JUnit: statuses, file, tags and case IDs from the title, the real error (not the location), attachments ignored', async () => {
  const r = await parse('playwright-junit.xml', { casePattern: 'CMS/\\d+' });
  assert.equal(r.format, 'junit');
  assert.deepEqual(r.totals, { passed: 2, failed: 2, skipped: 1, flaky: 0, total: 5 });
  assert.equal(r.startedAt, '2026-11-24T04:53:00.000Z');
  assert.equal(r.durationMs, 61234);
  const t = byTitle(r, 'GRO assigns');
  assert.equal(t.status, 'fail');
  assert.equal(t.file, 'pgr/assign.spec.ts');
  assert.equal(t.suite, '', 'the file is not repeated as a suite');
  assert.equal(t.durationMs, 30000);
  assert.deepEqual(t.tags, ['@CMS/02', '@area:pgr']);
  assert.deepEqual(t.caseIds, ['CMS/02']);
  assert.match(t.message, /^Error: locator\.click: Test timeout of 30000ms exceeded\./, 'from the text, not "assign.spec.ts:18:5 GRO assigns"');
  assert.match(t.message, /waiting for getByRole/);
  assert.ok(!/\u001b|\[chromium\]/.test(t.message + t.stack), 'no colour codes, no runner header');
  assert.ok(t.stack.split('\n').length <= 10);
  assert.match(t.stack, /assign\.page\.ts:41:22/);
  assert.ok(!/ATTACHMENT|trace\.zip|\.png/.test(JSON.stringify(r.tests)), 'system-out attachments are not kept');
  assert.equal(t.id.length, 12);
  const photo = byTitle(r, 'files a complaint');
  assert.equal(photo.status, 'pass');
  assert.deepEqual(photo.tags, ['@smoke', '@CMS/01'], 'a <property name="tag"> and a title tag');
  assert.equal(byTitle(r, 'date range').status, 'other', '<skipped/>');
  assert.equal(byTitle(r, 'date range').caseIds.length, 0);
});

test('pytest JUnit: classname as suite, file when given, failure, error and skipped, markers as tags', async () => {
  const r = await parse('pytest-junit.xml', { casePattern: 'NOTIF/\\d+' });
  assert.deepEqual(r.totals, { passed: 2, failed: 2, skipped: 1, flaky: 0, total: 5 });
  const sms = byTitle(r, 'test_send_sms');
  assert.equal(sms.suite, 'tests.test_sms.TestSms');
  assert.equal(sms.file, '', 'no file attribute, and a dotted classname is not a path');
  assert.deepEqual(sms.caseIds, ['NOTIF/01'], 'a case ID in a parametrised name');
  const rep = byTitle(r, 'test_delivery_report');
  assert.equal(rep.file, 'tests/test_sms.py');
  assert.equal(rep.status, 'fail');
  assert.match(rep.message, /^AssertionError: assert 500 == 200\n \+ +where 500/, 'the message attribute, its &#10; read as a new line');
  assert.match(rep.stack, /password=\*\*\*&id=7/, 'a password in a URL in the traceback is masked');
  assert.equal(rep.masked, true);
  const err = byTitle(r, 'test_template');
  assert.equal(err.status, 'fail', '<error> is a failure');
  assert.match(err.message, /ConnectionError: smtp\.example\.com:25/);
  const skip = byTitle(r, 'test_otp');
  assert.equal(skip.status, 'other');
  assert.equal(skip.message, 'needs the SMS gateway');
  assert.deepEqual(byTitle(r, 'test_subject').tags, ['smoke', 'email']);
});

test('Maven surefire: flakyFailure passes on a retry, rerunFailure keeps failing, suite properties are not tags', async () => {
  const r = await parse('surefire.xml');
  assert.deepEqual(r.totals, { passed: 2, failed: 2, skipped: 0, flaky: 1, total: 4 });
  const otp = byTitle(r, 'loginWithOtp');
  assert.deepEqual([otp.status, otp.flaky, otp.retries], ['pass', true, 1]);
  assert.equal(otp.message, '', 'a pass keeps no message');
  const pwd = byTitle(r, 'loginWithPassword');
  assert.deepEqual([pwd.status, pwd.flaky, pwd.retries], ['fail', false, 2]);
  assert.equal(pwd.message, 'expected: <Dashboard> but was: <Login>');
  assert.match(pwd.stack, /^org\.opentest4j\.AssertionFailedError/);
  assert.equal(pwd.suite, 'org.egov.pgr.LoginTest');
  assert.equal(byTitle(r, 'resetPassword').status, 'fail');
  assert.ok(r.tests.every((t) => !t.tags.length), 'java.version and the suite-level tag are not test tags');
  assert.equal(r.startedAt, '', 'no timestamp in the file');
});

test('Robot xunit and Cypress JUnit: nested suites, the spec file from the Root Suite', async () => {
  const rb = await parse('robot-xunit.xml', { casePattern: 'CMS/\\d+' });
  assert.deepEqual(rb.totals, { passed: 1, failed: 1, skipped: 1, flaky: 0, total: 3 });
  assert.equal(byTitle(rb, 'Valid Login').suite, 'Tests.Login');
  assert.deepEqual(byTitle(rb, 'Valid Login').caseIds, ['CMS/11'], 'from a tag');
  assert.equal(byTitle(rb, 'Invalid Password').message, 'Element \'id:error\' did not appear in 5 seconds.');
  assert.equal(byTitle(rb, 'Locked Account').status, 'other');
  const cy = await parse('cypress-junit.xml');
  assert.deepEqual(cy.totals, { passed: 1, failed: 1, skipped: 1, flaky: 0, total: 3 });
  for (const t of cy.tests) assert.equal(t.file, 'cypress/e2e/citizen/track.cy.js');
  assert.equal(byTitle(cy, 'Resolved').suite, 'Track complaint', 'the describe block, not mocha\'s classname (the test title)');
  assert.match(byTitle(cy, 'Resolved').message, /^Timed out retrying after 4000ms/);
});

test('CTRF JSON: statuses, flaky and retries, message and trace, tags, file, suite as text or list, branch and commit', async () => {
  const r = await parse('ctrf-report.json', { casePattern: 'NOTIF/\\d+' });
  assert.equal(r.format, 'ctrf');
  assert.equal(r.tool, 'pytest 8.3');
  assert.deepEqual(r.totals, { passed: 3, failed: 1, skipped: 2, flaky: 1, total: 6 }, 'pending and skipped are both skipped');
  assert.deepEqual([r.branch, r.sha, r.env], ['develop', 'c81e09d', 'staging']);
  assert.equal(r.startedAt, '2026-11-23T15:12:00.000Z');
  assert.equal(r.durationMs, 38000);
  const first = byTitle(r, 'sends an SMS');
  assert.deepEqual(first.tags, ['smoke', 'NOTIF/01'], '"@NOTIF/01" in the title is the NOTIF/01 tag already there');
  assert.deepEqual(first.caseIds, ['NOTIF/01']);
  assert.equal(first.file, 'tests/test_sms.py');
  const retry = byTitle(r, 'retries');
  assert.deepEqual([retry.status, retry.flaky, retry.retries, retry.suite], ['pass', true, 2, 'SMS › Retries']);
  const rep = byTitle(r, 'delivery report');
  assert.equal(rep.status, 'fail');
  assert.equal(rep.message, 'Request failed with status 500 for https://admin:***@sms.example.com/report?api_key=***');
  assert.match(rep.stack, /Traceback/);
  assert.equal(byTitle(r, 'email digest').status, 'other');
});

test('a zip of two files, or several files in one upload, make one run', async () => {
  const zip = new JSZip();
  zip.file('reports/junit.xml', fx('playwright-junit.xml'));
  zip.file('reports/ctrf.json', fx('ctrf-report.json'));
  zip.file('reports/index.html', '<html>the suite\'s own report</html>');
  zip.file('__MACOSX/._junit.xml', 'junk');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await parseResults([{ name: 'test-results.zip', buf }]);
  assert.equal(r.format, 'mixed');
  assert.equal(r.tests.length, 11);
  assert.deepEqual(r.files.map((f) => [f.name, f.format, f.tests]).sort(), [['test-results.zip › reports/ctrf.json', 'ctrf', 6], ['test-results.zip › reports/junit.xml', 'junit', 5]]);
  assert.deepEqual(r.ignored, ['test-results.zip › reports/index.html']);
  assert.equal(new Set(r.tests.map((t) => t.id)).size, 11, 'IDs stay apart');
  // the same file twice (two browsers, two shards): kept apart too
  const twice = await parseResults([{ name: 'a.xml', buf: fx('robot-xunit.xml') }, { name: 'b.xml', buf: fx('robot-xunit.xml') }]);
  assert.equal(twice.tests.length, 6);
  assert.equal(new Set(twice.tests.map((t) => t.id)).size, 6);
  // a multipart upload, as the page sends several files
  const body = Buffer.concat([
    Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="files"; filename="robot.xml"\r\nContent-Type: text/xml\r\n\r\n'), fx('robot-xunit.xml'),
    Buffer.from('\r\n--XyZ\r\nContent-Disposition: form-data; name="files"; filename="ctrf.json"\r\nContent-Type: application/json\r\n\r\n'), fx('ctrf-report.json'),
    Buffer.from('\r\n--XyZ--\r\n'),
  ]);
  const files = filesFromMultipart(body, 'multipart/form-data; boundary=XyZ');
  assert.deepEqual(files.map((f) => f.name), ['robot.xml', 'ctrf.json']);
  assert.deepEqual(files[0].buf, fx('robot-xunit.xml'));
  assert.equal((await parseResults(files)).tests.length, 9);
});

test('masking: tokens, passwords, Authorization headers and JWTs always; a suite\'s own rules too', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const cases = [
    ['Authorization: Bearer abc.def.ghi', 'Authorization: ***'],
    ['sent Bearer 0123456789abcdef to the API', 'sent Bearer *** to the API'],
    [`token was ${jwt}`, 'token was ***'],
    ['GET /login?user=gro&password=hunter2&next=/inbox', 'GET /login?user=gro&password=***&next=/inbox'],
    ['pwd=abc123 secret: s3cr3t', 'pwd=*** secret: ***'],
    ['api_key=AKfoo123 apiKey: "zz-9" api-key=q', 'api_key=*** apiKey: "***" api-key=***'],
    ['{"password":"p@ss","user":"gro"}', '{"password":"***","user":"gro"}'],
    ['auth-token: 1c2f3e4d-aaaa', 'auth-token: ***'],
    ['x-api-key: live_12345', 'x-api-key: ***'],
    ['clone https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo', 'clone https://bot:***@github.com/org/repo'],
    ['AWS key AKIAABCDEFGHIJKLMNOP leaked', 'AWS key *** leaked'],
  ];
  for (const [input, want] of cases) assert.equal(maskText(input).text, want, input);
  assert.deepEqual(maskText('expected 200 but got 500'), { text: 'expected 200 but got 500', masked: false }, 'ordinary text is left alone');
  assert.equal(maskText('Unexpected token }').text, 'Unexpected token }');
  // the suite's own rules: plain text, or a /pattern/
  assert.equal(maskText('otp=482913 sent to 9876543210', ['/otp=\\d{6}/', '9876543210']).text, '*** sent to ***');
  assert.equal(maskText('a.b.c', ['a.b']).text, '***.c', 'plain text is not a pattern');
  const bad = compileMasking(['/(unclosed/', '/a*/', 'ok']);
  assert.equal(bad.rules.length, 1);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[1], /matches an empty text/);
});

test('masking happens before anything is kept, and the test says so', async () => {
  const xml = '<testsuite name="s"><testcase name="login as gro" classname="api"><failure message="401 for token=abcdef123456">at login (api.ts:3)\nAuthorization: Basic Z3JvOnB3</failure></testcase></testsuite>';
  const r = await parseResults([{ name: 'r.xml', buf: Buffer.from(xml) }], { masking: ['gro'] });
  const t = r.tests[0];
  assert.equal(t.message, '401 for token=***');
  assert.match(t.stack, /Authorization: \*\*\*/);
  assert.equal(t.title, 'login as ***', 'a suite rule masks titles too');
  assert.equal(t.masked, true);
  assert.ok(!JSON.stringify(r).includes('abcdef123456') && !JSON.stringify(r).includes('Z3JvOnB3'));
});

test('case-ID patterns: checked when saved', () => {
  assert.equal(compileCasePattern(''), null);
  assert.ok(compileCasePattern('CMS/\\d+') instanceof RegExp);
  assert.ok(compileCasePattern('/cms-\\d+/i').test('CMS-12'));
  assert.throws(() => compileCasePattern('CMS/(\\d+'), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => compileCasePattern('\\d*'), (e) => e.code === 'BAD_INPUT' && /empty/.test(e.message));
});

test('failure signatures take out numbers, IDs and quoted values, so the same break groups together', () => {
  assert.equal(signature('Timeout 30000ms exceeded waiting for getByRole(\'button\', { name: \'Assign\' })\n  at x'), 'Timeout {n}ms exceeded waiting for getByRole(\'…\', { name: \'…\' })');
  assert.equal(signature('Timeout 5000ms exceeded waiting for getByRole(\'link\', { name: \'Reassign\' })'), 'Timeout {n}ms exceeded waiting for getByRole(\'…\', { name: \'…\' })');
  assert.equal(signature('Request failed with status 500: POST /pgr-services/v2/request/_search'), 'Request failed with status {n}: POST /pgr-services/v{n}/request/_search');
  assert.equal(signature('Complaint 1c2f3e4d-aaaa-bbbb-cccc-1234567890ab not found (trace a33208c9f1)'), 'Complaint {id} not found (trace {id})');
  assert.equal(signature('Expected: "Resolved" Received: "In progress"'), 'Expected: "…" Received: "…"');
  assert.equal(signature('It doesn\'t show the timeline'), 'It doesn\'t show the timeline', 'an apostrophe is not a quote');
  assert.equal(signature(''), '(no message)');
  assert.equal(signature('\u001b[31mError: boom 42\u001b[39m'), 'Error: boom {n}');
});

test('grouping by cause: biggest first, new failures counted, one-offs put together behind the real causes', () => {
  const f = (id, message) => ({ id, status: 'fail', message });
  const tests = [
    f('a', 'Timeout 30000ms exceeded waiting for getByRole(\'button\', { name: \'Assign\' })'),
    f('b', 'Timeout 5000ms exceeded waiting for getByRole(\'button\', { name: \'Resolve\' })'),
    f('c', 'Timeout 1000ms exceeded waiting for getByRole(\'tab\', { name: \'Inbox\' })'),
    f('d', 'Request failed with status 500'),
    f('e', 'Request failed with status 502'),
    f('f', 'Boundary list is empty'),
    f('g', 'KPI tile shows NaN'),
    { id: 'h', status: 'pass', message: '' },
  ];
  const g = groupCauses(tests, ['a', 'f']);
  assert.deepEqual(g.map((x) => [x.count, x.newCount]), [[3, 1], [2, 0], [2, 1]]);
  assert.equal(g[0].signature, 'Timeout {n}ms exceeded waiting for getByRole(\'…\', { name: \'…\' })');
  assert.deepEqual(g[0].tests, ['a', 'b', 'c']);
  assert.equal(g[2].signature, 'Other messages (each seen once)');
  assert.equal(g[2].other, true);
  assert.deepEqual(g[2].tests.sort(), ['f', 'g']);
  // only one-offs: each stays its own cause
  assert.equal(groupCauses([f('x', 'one'), f('y', 'two')]).length, 2);
});

test('a run is refused without its workbook › test suite › cycle', async () => {
  const parsed = await parse('robot-xunit.xml');
  const suite = { id: 'cms-automation', name: 'CMS Automation' };
  for (const attach of [undefined, null, {}, { book: 'b.xlsx', tab: 'T' }, { book: '', tab: 'T', cycle: 'v1' }, { book: 'b.xlsx', tab: ' ', cycle: 'v1' }]) {
    assert.throws(() => buildRun(parsed, { suite, attach }), (e) => e.code === 'NO_ATTACH', JSON.stringify(attach));
  }
  assert.throws(() => buildRun(parsed, { attach: ATTACH }), (e) => e.code === 'NO_SUITE');
  assert.deepEqual(cleanAttach({ book: 'b.xlsx', tab: 'T', cycle: '' }), { book: 'b.xlsx', tab: 'T', cycle: '' }, 'an unnamed Status column is a cycle');
  const run = buildRun(parsed, { suite, attach: ATTACH, source: { kind: 'upload', fileName: 'robot.xml', runUrl: 'javascript:alert(1)' }, branch: 'master', env: 'net_two', by: 'Priya', now: new Date('2026-11-24T10:23:00Z') });
  assert.match(run.id, RUN_ID);
  assert.deepEqual(run.attach, ATTACH);
  assert.deepEqual(run.totals, { passed: 1, failed: 1, skipped: 1, flaky: 0, total: 3 });
  assert.equal(run.source.runUrl, '', 'only https links');
  assert.equal(run.source.format, 'junit');
  assert.deepEqual([run.branch, run.env, run.by, run.suiteName], ['master', 'net_two', 'Priya', 'CMS Automation']);
  assert.equal(run.startedAt, parsed.startedAt);
  assert.equal(metaOf(run).tests, undefined);
});

test('comparing runs: previous run of the same suite on the same test suite; new, still failing, fixed, flaky; history', () => {
  const t = (id, status, extra) => ({ id, title: id, file: `${id[0]}.spec.ts`, suite: '', tags: [], caseIds: [], status, durationMs: 1, retries: 0, flaky: false, message: status === 'fail' ? 'boom' : '', stack: '', ...extra });
  const mk = (id, startedAt, tests, attach = ATTACH, suiteId = 's1') => ({ id, suiteId, startedAt, importedAt: startedAt, attach, totals: {}, tests });
  const r1 = mk('20261119-094000-aaaaaa', '2026-11-19T09:40:00Z', [t('a1', 'fail'), t('b1', 'fail'), t('c1', 'pass'), t('d1', 'pass')]);
  const r2 = mk('20261122-180500-bbbbbb', '2026-11-22T18:05:00Z', [t('a1', 'fail'), t('b1', 'fail'), t('c1', 'pass'), t('d1', 'pass')], { ...ATTACH, cycle: 'v2.11' });
  const r3 = mk('20261124-102300-cccccc', '2026-11-24T10:23:00Z', [t('a1', 'fail'), t('b1', 'pass'), t('c1', 'fail'), t('d1', 'pass', { flaky: true, retries: 1 }), t('e1', 'fail')]);
  const other = mk('20261123-120000-dddddd', '2026-11-23T12:00:00Z', [], { ...ATTACH, tab: 'Notifications' });
  const otherSuite = mk('20261123-130000-eeeeee', '2026-11-23T13:00:00Z', [], ATTACH, 's2');
  const index = [r3, otherSuite, other, r2, r1].map(metaOf);
  assert.equal(previousRun(index, r3).id, r2.id, 'the latest earlier run on the same workbook and test suite, in any cycle');
  assert.equal(previousRun(index, r1), null);
  assert.deepEqual(lineOf(index, r3).map((x) => x.id), [r1.id, r2.id, r3.id]);
  const c = compareRuns(r3, r2);
  assert.deepEqual(c, { newFailures: ['c1', 'e1'], stillFailing: ['a1'], fixed: ['b1'], flaky: ['d1'] }, 'a test not in the previous run failing is new');
  assert.deepEqual(compareRuns(r1, null), { newFailures: [], stillFailing: [], fixed: [], flaky: [] }, 'nothing to compare with');
  const h = historyOf([r1, r2, r3], r3);
  assert.deepEqual(h.runs.map((x) => x.id), [r1.id, r2.id, r3.id]);
  assert.deepEqual(h.byTest.a1, ['fail', 'fail', 'fail']);
  assert.deepEqual(h.byTest.c1, ['pass', 'pass', 'fail']);
  assert.deepEqual(h.byTest.e1, ['none', 'none', 'fail']);
  assert.deepEqual(byFile(r3.tests).map((f) => [f.file, f.total, f.failed]), [['a.spec.ts', 1, 1], ['c.spec.ts', 1, 1], ['e.spec.ts', 1, 1], ['b.spec.ts', 1, 0], ['d.spec.ts', 1, 0]]);
  assert.equal(passRate({ passed: 218, failed: 24, skipped: 12 }), 90, 'passed out of passed and failed');
  assert.equal(passRate({ passed: 0, failed: 0, skipped: 3 }), null);
});

test('splitting a failure: Playwright\'s location-only message attribute is not the message', () => {
  const s = splitFailure('a.spec.ts:3:5 does a thing', '  [chromium] › a.spec.ts:3:5 › does a thing\n\n    Error: expect(received).toHaveText(expected)\n\n    Expected: "Resolved"\n    Received: "In progress"\n\n      at a.spec.ts:9:1');
  assert.equal(s.message, 'Error: expect(received).toHaveText(expected)\nExpected: "Resolved"\nReceived: "In progress"');
  assert.equal(s.stack, 'at a.spec.ts:9:1');
});

test('stored size: 1,000 tests with failures fit in well under 80 KB compressed', async () => {
  const cases = [];
  for (let i = 0; i < 1000; i++) {
    const fail = i % 10 === 0;
    cases.push(`<testcase name="Scenario ${i} › citizen does step ${i % 37} @CMS/${String(i % 120).padStart(2, '0')}" classname="area${i % 25}/flow${i % 7}.spec.ts" time="${(i % 13) + 0.5}">` +
      (fail ? `<failure message="x.spec.ts:1:1 x"><![CDATA[Error: Timeout ${1000 + i}ms exceeded waiting for getByRole('button', { name: 'Step ${i}' })\n  at Page.step (pages/p${i % 9}.ts:${i}:5)\n  at area/flow.spec.ts:${i}:3]]></failure>` : '') + '</testcase>');
  }
  const xml = `<testsuites><testsuite name="all" timestamp="2026-11-24T10:00:00Z" time="900">${cases.join('')}</testsuite></testsuites>`;
  const parsed = await parseResults([{ name: 'big.xml', buf: Buffer.from(xml) }], { casePattern: 'CMS/\\d+' });
  const run = buildRun(parsed, { suite: { id: 's', name: 'S' }, attach: ATTACH });
  const gz = gzipSync(Buffer.from(JSON.stringify(run)));
  assert.equal(run.tests.length, 1000);
  assert.ok(gz.length < 80 * 1024, `${gz.length} bytes`);
  assert.equal(groupCauses(run.tests)[0].count, 100, 'every timeout is one cause');
});
