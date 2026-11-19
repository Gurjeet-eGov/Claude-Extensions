import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, plain } from '../lib/runtime.mjs';
import { MANUAL_HEADERS, FEATURE_HEADERS, AUTOMATION_HEADERS, KPI_HEADERS } from '../dev/sample-workbook.mjs';

const { TRCore } = loadCore();
const P = (fn) => (...a) => plain(fn(...a));
const detect = P(TRCore.detectColumns);

test('header detection: manual layout without a Feature column', () => {
  const d = detect(MANUAL_HEADERS);
  assert.equal(d.fields.id, 0);
  assert.equal(d.fields.scenario, 1);
  assert.equal(d.fields.feature, -1);
  assert.equal(d.fields.subFeature, 2);
  assert.equal(d.fields.testType, 3);
  assert.equal(d.fields.testData, 4);
  assert.equal(d.fields.preCondition, 5);
  assert.equal(d.fields.expected, 6);
  assert.deepEqual(d.cycles, [{ label: 'v2.12', status: 7, comment: 8 }]);
  assert.deepEqual(d.extras, []);
});

test('header detection: feature layout with a Linked issue column', () => {
  const d = detect(FEATURE_HEADERS);
  assert.equal(d.fields.feature, 2);
  assert.equal(d.fields.subFeature, 3);
  assert.equal(d.fields.linkedIssue, 10);
  assert.deepEqual(d.cycles, [{ label: 'v2.20', status: 8, comment: 9 }]);
});

test('header detection: automation sign-off tab', () => {
  const d = detect(AUTOMATION_HEADERS);
  assert.equal(d.fields.feature, 0, 'Suite is the feature');
  assert.equal(d.fields.subFeature, 1, 'Functionality is the sub feature');
  assert.equal(d.fields.id, 3);
  assert.equal(d.fields.scenario, 4);
  assert.equal(d.fields.preCondition, 6);
  assert.equal(d.fields.expected, 7);
  assert.equal(d.fields.linkedIssue, 8);
  assert.deepEqual(d.cycles, [{ label: '', status: 9, comment: 10 }]);
  assert.equal(TRCore.detectSpecColumn(AUTOMATION_HEADERS), 2);
  assert.deepEqual(d.extras, [2, 5], 'Test File and Test Summary stay visible as extra fields');
});

test('header detection: KPI tab has no ID and pairs Status with Notes', () => {
  const d = detect(KPI_HEADERS);
  assert.equal(d.fields.id, -1);
  assert.equal(d.fields.scenario, 0);
  assert.deepEqual(d.cycles, [{ label: '', status: 3, comment: 4 }]);
  assert.deepEqual(d.extras, [1, 2]);
});

test('cycles pair on label and keep header order', () => {
  const cycles = plain(TRCore.detectCycles(['Scenario', 'Test Status / v2.12', 'Comment / v2.12', 'Test Status / v2.20', 'Comments - v2.20', 'Test Summary']));
  assert.deepEqual(cycles, [
    { label: 'v2.12', status: 1, comment: 2 },
    { label: 'v2.20', status: 3, comment: 4 },
  ]);
});

test('cycle labels on their own line (as Google Sheets exports wrapped headers) are found', () => {
  const cycles = plain(TRCore.detectCycles(['S .No', 'Scenario', 'Test Status\nv2.12', 'Comment\nv2.12', 'Test Status\r\nv2.20', 'Comments v2.20', 'Status of fix', 'Notes']));
  assert.deepEqual(cycles, [
    { label: 'v2.12', status: 2, comment: 3 },
    { label: 'v2.20', status: 4, comment: 5 },
  ]);
  assert.deepEqual(plain(TRCore.detectCycles(['Status', 'Notes'])), [{ label: '', status: 0, comment: 1 }]);
  assert.deepEqual(plain(TRCore.detectCycles(['Test Status R1', 'Comment R1'])), [{ label: 'R1', status: 0, comment: 1 }]);
});

test('header row is found below a title row', () => {
  const rows = [['CMS sign-off', '', ''], ['', '', ''], ['S .No', 'Scenario', 'Test Status / v1']];
  assert.equal(TRCore.detectHeaderRow(rows), 2);
});

test('stored mapping resolves by header text and reports renamed headers', () => {
  const r = plain(TRCore.resolveColumns(['ID', 'Title', 'Result'], { id: 'ID', scenario: 'Scenario' }));
  assert.equal(r.fields.id, 0);
  assert.equal(r.fields.scenario, -1);
  assert.deepEqual(r.missing, ['scenario']);
});

test('status options: pass, fail, others; P/F/N shortcuts', () => {
  const o = plain(TRCore.statusOptions(['Fail', 'NA (Skipped)', 'Pass']));
  assert.deepEqual(o.map((x) => [x.value, x.cls, x.key, x.num]), [
    ['Pass', 'pass', 'p', '1'],
    ['Fail', 'fail', 'f', '2'],
    ['NA (Skipped)', 'other', 'n', '3'],
  ]);
  const k = plain(TRCore.statusOptions(['Fail', 'Need more data', 'Pass']));
  assert.equal(k[2].value, 'Need more data');
  assert.equal(k[2].key, 'n');
  assert.equal(TRCore.classifyStatus(''), 'none');
  assert.equal(TRCore.classifyStatus('Passed'), 'pass');
  assert.equal(TRCore.classifyStatus('Blocked'), 'other');
});

test('cases: blank Sub feature continues the group above', () => {
  const d = detect(MANUAL_HEADERS);
  const rows = [
    ['CMS/01', 'A', 'CSR Employee', '', '', '', '', 'Pass', ''],
    ['CMS/02', 'B', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['CMS/03', 'C', 'Inbox', '', '', '', '', '', ''],
  ];
  const cases = plain(TRCore.buildCases(rows, d.fields, d.cycles, { firstRow: 2 }));
  assert.deepEqual(cases.map((c) => [c.key, c.row, c.group2, c.subFeature]), [
    ['CMS/01', 2, 'CSR Employee', 'CSR Employee'],
    ['CMS/02', 3, 'CSR Employee', ''],
    ['CMS/03', 5, 'Inbox', 'Inbox'],
  ]);
  assert.deepEqual(cases[0].statuses, ['Pass']);
});

test('cases without an ID column are keyed by scenario text', () => {
  const d = detect(KPI_HEADERS);
  const cases = plain(TRCore.buildCases([['Open Complaints', 'def', 'formula', 'Pass', '']], d.fields, d.cycles, { firstRow: 2, headers: KPI_HEADERS, extras: d.extras }));
  assert.match(cases[0].key, /^#/);
  assert.deepEqual(cases[0].extras, [{ label: 'Definition', value: 'def' }, { label: 'Formula', value: 'formula' }]);
});

test('next IDs follow the sheet pattern and width', () => {
  assert.deepEqual(plain(TRCore.nextIds(['CMS/01', 'CMS/02', 'CMS/182'], 2)), ['CMS/183', 'CMS/184']);
  assert.deepEqual(plain(TRCore.nextIds(['CMS/001', 'CMS/053'])), ['CMS/054']);
  assert.deepEqual(plain(TRCore.nextIds(['TC-9'])), ['TC-10']);
  assert.deepEqual(plain(TRCore.nextIds([])), ['TC-001']);
});

test('spec references are found in free text and file names', () => {
  assert.deepEqual(plain(TRCore.extractSpecRefs('inbox-search.spec (by number) skipped; see complaints.spec.ts too')), ['inbox-search', 'complaints']);
  assert.deepEqual(plain(TRCore.extractSpecRefs('api-helpers.spec.ts')), ['api-helpers']);
  assert.deepEqual(plain(TRCore.extractSpecRefs('no specs here, specification only')), []);
});

test('automation badge aggregates results of every referenced spec', () => {
  const rows = [
    ['inbox-search.spec.ts', 'Pass'], ['inbox-search.spec.ts', 'NA (Skipped)'],
    ['complaints.spec.ts', 'Pass'], ['assign.spec.ts', 'Fail'],
  ];
  const idx = TRCore.automationIndex(rows, 0, 1);
  const badge = (text) => plain(TRCore.automationBadge({ automatedBy: '', comments: [text] }, idx));
  assert.equal(badge('complaints.spec').state, 'pass');
  assert.equal(badge('inbox-search.spec').state, 'partial');
  assert.equal(badge('assign.spec and complaints.spec').state, 'fail');
  assert.equal(badge('ghost.spec').state, 'unknown');
  assert.equal(badge('nothing'), null);
  assert.equal(plain(TRCore.automationBadge({ automatedBy: 'complaints', comments: [] }, idx)).state, 'pass');
});

test('risk tier: new in release, failed last cycle, manual, automation passing', () => {
  const ctx = { release: 'v2.20.1', prevIdx: 0 };
  assert.equal(TRCore.riskTier({ release: '2.20.1', statuses: ['Pass'] }, ctx), 0);
  assert.equal(TRCore.riskTier({ release: '', statuses: ['Fail'] }, ctx), 1);
  assert.equal(TRCore.riskTier({ release: '', statuses: ['Pass'], auto: null }, ctx), 2);
  assert.equal(TRCore.riskTier({ release: '', statuses: ['Pass'], auto: { state: 'pass' } }, ctx), 3);
});

test('auto paths group by Feature then Sub feature; a plan keeps its order and collects leftovers', () => {
  const cases = [
    { key: 'A1', id: 'A1', group1: '', group2: 'Inbox' },
    { key: 'A2', id: 'A2', group1: '', group2: 'Workflow' },
    { key: 'A3', id: 'A3', group1: '', group2: 'Inbox' },
  ];
  const auto = plain(TRCore.autoPaths(cases));
  assert.deepEqual(auto.map((p) => [p.name, p.steps[0].cases]), [['Inbox', ['A1', 'A3']], ['Workflow', ['A2']]]);
  const plan = plain(TRCore.applyPathPlan(cases, { paths: [{ name: 'GRO path', steps: [{ label: 'assign', cases: ['a2', 'X9'] }] }] }));
  assert.deepEqual(plan.paths.map((p) => [p.name, p.steps.map((s) => s.cases)]), [['GRO path', [['A2']]], ['Not in the plan', [['A1', 'A3']]]]);
  assert.deepEqual(plan.unknown, ['X9']);
});

test('cell values that Sheets would read as formulas are written as text', () => {
  assert.equal(TRCore.cellSafe('=IMPORTXML("http://x")'), '\'=IMPORTXML("http://x")');
  assert.equal(TRCore.cellSafe('+1 555'), "'+1 555");
  assert.equal(TRCore.cellSafe('-5 MB'), "'-5 MB");
  assert.equal(TRCore.cellSafe('@here'), "'@here");
  assert.equal(TRCore.cellSafe('• Complaint shall move'), '• Complaint shall move');
});

test('expected results split into bullets and back', () => {
  assert.deepEqual(plain(TRCore.parseExpected('• One\n• Two')), ['One', 'Two']);
  assert.deepEqual(plain(TRCore.parseExpected('• One • Two')), ['One', 'Two']);
  assert.deepEqual(plain(TRCore.parseExpected('1. One\n- Two')), ['One', 'Two']);
  assert.equal(TRCore.formatExpected(['One', '• Two', '']), '• One\n• Two');
});

test('pasted replies: JSON is found inside a fenced block with chatter around it', () => {
  const text = 'Sure! Here you go:\n```json\n{"type":"scenarios","items":[{"scenario":"Verify if X","expected":["A shall B"]}]}\n```\nAnything else?';
  const r = plain(TRCore.validateReply(TRCore.extractJson(text), {}));
  assert.equal(r.type, 'scenarios');
  assert.equal(r.items[0].scenario, 'Verify if X');
  assert.deepEqual(r.items[0].expected, ['A shall B']);
});

test('pasted replies: hostile or malformed content is cleaned or refused', () => {
  assert.throws(() => TRCore.extractJson('no json at all'), /No JSON object/);
  assert.throws(() => TRCore.extractJson('{"type": nope}'), /could not be read/);
  assert.throws(() => TRCore.validateReply([], {}), /one JSON object/);
  assert.throws(() => TRCore.validateReply({ type: 'delete_everything' }, {}), /Unknown reply type/);
  const r = plain(TRCore.validateReply({
    type: 'scenarios',
    items: [
      { scenario: 'Verify if ok\u0007', feature: { nested: true }, expected: 'one\ntwo', extra: 'ignored', __proto__: { polluted: 1 } },
      { scenario: '' },
      'not an object',
      { scenario: 'x'.repeat(5000), expected: Array(40).fill('b') },
    ],
  }, {}));
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].scenario, 'Verify if ok', 'control characters removed');
  assert.equal(r.items[0].feature, '', 'objects are not accepted as text');
  assert.deepEqual(r.items[0].expected, ['one', 'two']);
  assert.equal(r.items[0].extra, undefined, 'unknown keys dropped');
  assert.equal(r.items[1].scenario.length, 400, 'long text capped');
  assert.equal(r.items[1].expected.length, 15, 'bullet count capped');
  assert.equal(r.errors.length, 2);
  assert.equal(({}).polluted, undefined);
});

test('pasted replies: path plans report unknown IDs; edits only touch known cases and editable fields', () => {
  const ctx = { caseIds: ['CMS/01', 'CMS/02'] };
  const p = plain(TRCore.validateReply({ type: 'paths', paths: [{ name: 'P', steps: [{ label: 's', cases: ['cms/01', 'CMS/99'] }] }] }, ctx));
  assert.deepEqual(p.paths[0].steps[0].cases, ['CMS/01', 'CMS/99']);
  assert.deepEqual(p.unknown, ['CMS/99']);
  const e = plain(TRCore.validateReply({ type: 'edits', items: [
    { caseId: 'CMS/02', fields: { expected: ['a'], testedBy: 'mallory', row: 1 } },
    { caseId: 'CMS/77', fields: { scenario: 'x' } },
  ] }, ctx));
  assert.equal(e.items.length, 1);
  assert.deepEqual(e.items[0].fields, { expected: ['a'] });
  assert.equal(e.errors.length, 1);
});

test('summary figures: counts, rates, failures, comparison, testers', () => {
  const cases = [
    { key: '1', id: '1', scenario: 'a', group1: 'F1', statuses: ['Pass', 'Pass'], comments: ['', ''], testedBy: 'x@e.org' },
    { key: '2', id: '2', scenario: 'b', group1: 'F1', statuses: ['Pass', 'Fail'], comments: ['', 'broke'], linkedIssue: '#5', testedBy: 'x@e.org' },
    { key: '3', id: '3', scenario: 'c', group1: 'F2', statuses: ['Fail', 'Pass'], comments: ['', ''] },
    { key: '4', id: '4', scenario: 'd', group1: 'F2', statuses: ['', 'NA (Skipped)'], comments: ['', ''] },
    { key: '5', id: '5', scenario: 'e', group1: 'F2', statuses: ['', ''], comments: ['', ''], auto: { state: 'pass' } },
  ];
  const s = plain(TRCore.summarize(cases, { cycleIdx: 1, prevIdx: 0 }));
  assert.deepEqual(s.counts, { pass: 2, fail: 1, other: 1, none: 1, total: 5 });
  assert.equal(s.executedPct, 80);
  assert.equal(s.passRate, 67);
  assert.deepEqual(s.failures.map((f) => [f.id, f.comment, f.issue]), [['2', 'broke', '#5']]);
  assert.deepEqual(s.comparison.newlyFailing.map((x) => x.id), ['2']);
  assert.deepEqual(s.comparison.fixed.map((x) => x.id), ['3']);
  assert.deepEqual(s.groups.map((g) => [g.name, g.counts.total]), [['F1', 2], ['F2', 3]]);
  assert.deepEqual(s.automation, { linked: 1, pass: 1, fail: 0, other: 0 });
  assert.deepEqual(s.testers, [{ name: 'x@e.org', count: 2 }]);
});

test('issue links: references, cell links, the issue list', () => {
  const P = (...a) => plain(TRCore.parseIssues(...a));
  const gh = 'https://github.com/org/repo/issues/812';
  assert.equal(TRCore.issueRef(gh), '#812');
  assert.equal(TRCore.issueRef(gh, true), 'repo#812');
  assert.equal(TRCore.issueRef('https://acme.atlassian.net/browse/ccrs-44'), 'CCRS-44');
  assert.equal(TRCore.issueRef('https://gitlab.com/g/p/-/issues/7'), '#7');
  assert.equal(TRCore.issueRef('https://tracker.example.org/x/y'), 'tracker.example.org');
  // A typed link, a reference with the cell's link, words left as they are
  assert.deepEqual(P(gh), [{ ref: '#812', url: gh }]);
  assert.deepEqual(P('#812', gh), [{ ref: '#812', url: gh }]);
  assert.deepEqual(P('Blocked by login issue'), [{ ref: 'Blocked by login issue', url: '' }]);
  assert.deepEqual(P(`Bug: ${gh}.`), [{ ref: '#812', url: gh }]);
  // The cell's link goes to the reference it names; the issue list gives the others theirs
  const other = 'https://github.com/org/repo/issues/9';
  assert.deepEqual(P('#9, #812', gh, { '#9': [other] }), [{ ref: '#9', url: other }, { ref: '#812', url: gh }]);
  assert.deepEqual(P('#9', '', { '#9': [other, 'https://github.com/org/web/issues/9'] }), [{ ref: '#9', url: '' }]); // two links have it: left bare
  // Only http(s) links are kept
  assert.deepEqual(P('javascript:alert(1)'), [{ ref: 'javascript:alert(1)', url: '' }]);
  assert.equal(TRCore.cleanLink('file:///etc/passwd'), '');
  // Writing: references, with the repo when two clash; editing: links in full
  const two = TRCore.parseIssues('https://github.com/a/x/issues/5 https://github.com/a/y/issues/5');
  assert.equal(TRCore.issueCellText(two), 'x#5, y#5');
  assert.equal(TRCore.issueValue(two), 'https://github.com/a/x/issues/5\nhttps://github.com/a/y/issues/5');
  assert.deepEqual([TRCore.priorityRank('P1'), TRCore.priorityRank('High'), TRCore.priorityRank('critical'), TRCore.priorityRank('')], [1, 1, 0, 9]);
});

test('similarity flags near-duplicate scenarios', () => {
  const cases = [{ key: 'C1', id: 'C1', scenario: 'Verify if the GRO is able to assign a complaint pending for assignment' }];
  const d = plain(TRCore.duplicatesFor('Verify that GRO can assign complaints pending assignment', cases));
  assert.equal(d[0].id, 'C1');
  assert.deepEqual(plain(TRCore.duplicatesFor('Verify if the dashboard KPI tiles load', cases)), []);
});

test('retire notes: written on one line, read back, replaced rather than stacked', () => {
  assert.equal(TRCore.retireNote('deprecated', '', ' Not\napplicable  anymore '), 'Deprecated: Not applicable anymore');
  assert.equal(TRCore.retireNote('duplicate', 'CMS/12', ''), 'Duplicate of CMS/12');
  assert.deepEqual({ ...TRCore.parseRetireNote('Duplicate of CMS/12: same check: other words\nolder comment') }, { kind: 'duplicate', of: 'CMS/12', reason: 'same check: other words' });
  assert.deepEqual({ ...TRCore.parseRetireNote('deprecated') }, { kind: 'deprecated', of: '', reason: '' });
  assert.equal(TRCore.parseRetireNote('Deprecated feature still shown in menu'), null, 'ordinary comments are not notes');
  assert.equal(TRCore.parseRetireNote('Block level missing\nDeprecated: x'), null, 'only the first line counts');
  assert.equal(TRCore.withRetireNote('Deprecated: old\nkept text', 'Duplicate of CMS/1'), 'Duplicate of CMS/1\nkept text');
  assert.equal(TRCore.stripRetireNote('Deprecated: old\nkept text'), 'kept text');
  assert.equal(TRCore.stripRetireNote('just a comment'), 'just a comment');
  assert.equal(TRCore.withUpdateNote('', 'typo'), 'Updated: typo');
  assert.equal(TRCore.withUpdateNote('Failed once', 'typo'), 'Updated: typo\nFailed once');
});

test('struck rows are retired; duplicates are linked both ways; summary leaves them out', () => {
  const fields = { id: 0, scenario: 1 };
  const cycles = [{ label: 'v1', status: 2, comment: 3 }, { label: 'v2', status: 4, comment: 5 }];
  const rows = [
    ['T-1', 'Verify a', 'Pass', '', '', ''],
    ['T-2', 'Verify a again', '', 'Duplicate of T-1: same', '', ''],
    ['T-3', 'Verify c', '', '', 'Fail', ''],
    ['T-4', 'Verify d', '', '', '', ''],
  ];
  const cases = TRCore.buildCases(rows, fields, cycles, { struck: [false, true, false, true] });
  assert.equal(cases[0].retired, null);
  assert.deepEqual({ ...cases[1].retired }, { kind: 'duplicate', of: 'T-1', reason: 'same', cycle: 'v1', ofKey: 'T-1' });
  assert.deepEqual([...cases[0].duplicates], ['T-2']);
  assert.equal(cases[3].retired.kind, 'struck', 'struck in the workbook by hand, no note');
  const s = TRCore.summarize(cases, { cycleIdx: 1, prevIdx: 0 });
  assert.deepEqual({ ...s.counts }, { pass: 0, fail: 1, other: 0, none: 1, total: 2 });
  assert.equal(s.retired, undefined, 'and are not listed: retired cases are in no report');
});
