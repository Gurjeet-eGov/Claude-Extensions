/**
 * Test Run console: the text that "Copy for Claude" puts on the clipboard.
 *
 * Nothing here is sent anywhere by the console. The tester previews the text,
 * may trim it, and pastes it into whichever Claude they use. Claude's reply
 * comes back only when the tester pastes it into the Inbox, where it is
 * validated (TRCore.validateReply) and reviewed before anything is written.
 *
 * prompts/*.md in the repo are generated from TEMPLATES by
 * `npm run prompts`; a unit test fails if they drift.
 */
var TRPrompts = (function () {
  'use strict';

  var HOUSE_STYLE = [
    'House style for test cases:',
    '- Scenario: one line starting "Verify if" or "Verify that", naming the actor (use this deployment\'s own role names) and the observable behaviour.',
    '- Expected result: a list of short bullets, one verification each, stating the observable outcome ("Complaint shall move to RESOLVED"), not the click. Name concrete states, labels and messages where known. A single check still gets one bullet.',
    '- Test data: the specific values that make the case runnable (boundary values, invalid inputs, file sizes). Leave it empty if none are needed; never write "N/A".',
    '- Pre condition: configuration or state that must exist first (a role assigned, a complaint in a given state, master data seeded).',
    '- Feature: the capability a manager would recognise, never naming a surface ("Complaint creation", not "Complaint creation - Citizen"). Never start it with < or >.',
    '- Sub feature: the surface the tester runs it on. Reuse a value from the lists below whenever one fits.',
    '- Test type: reuse a value from the list below.',
    '- Do not merge different business rules into one case; a positive case and a negative or boundary case are separate cases.'
  ].join('\n');

  var TEMPLATES = {
    draftScenarios: [
      'You are helping a QA tester turn quick findings into manual test cases for the "{{tab}}" tab of a Google Sheet.',
      '',
      '{{houseStyle}}',
      '',
      'Columns this sheet has (fill only these; leave the others out): {{fields}}',
      'Feature values already used: {{features}}',
      'Sub feature values already used: {{subFeatures}}',
      'Test type values already used: {{testTypes}}',
      '',
      'Existing scenarios in the same area (ID | scenario). Do not duplicate them; if a finding is already covered, list it under "covered" instead:',
      '{{existing}}',
      '',
      'Findings to write up:',
      '{{findings}}',
      '',
      'For each finding, write one test case. Then suggest up to {{edgeCases}} edge cases for it that are not already covered, each as its own item with "edgeCase": true and the same "fromFinding".',
      'Set "issue" to the finding\'s bug number when it has one.',
      '',
      'Reply with exactly one JSON code block and nothing else, in this shape:',
      '```json',
      '{"type":"scenarios","items":[{"fromFinding":"F-001","edgeCase":false,"scenario":"Verify if ...","feature":"","subFeature":"","testType":"","testData":"","preCondition":"","expected":["... shall ..."],"issue":"#123","release":""}],"covered":[{"fromFinding":"F-002","caseId":"CMS/045","note":"why it is already covered"}]}',
      '```'
    ].join('\n'),

    planPaths: [
      'You are helping a QA tester plan a manual test cycle for the "{{tab}}" tab of a Google Sheet.',
      '',
      'Group the test cases below into ordered test paths. A path is something one tester runs in a single pass:',
      '- one persona and login (for example CSR, GRO, LME, citizen, admin), so the tester does not keep switching accounts;',
      '- one piece of test data carried through its states (for example one complaint created, then assigned, then resolved), so setup is reused;',
      '- steps in the order they would actually be performed.',
      'Put cases that need the same pre condition next to each other. Keep paths to roughly 5-25 cases.',
      'Every case ID must appear exactly once across all paths. Use the IDs exactly as given.{{focus}}',
      '',
      'Test cases (ID | feature | sub feature | test type | pre condition | scenario):',
      '{{cases}}',
      '',
      'Reply with exactly one JSON code block and nothing else, in this shape:',
      '```json',
      '{"type":"paths","paths":[{"name":"CSR: create and assign","persona":"CSR","setup":"Log in as CSR; one complaint type with sub-types exists","steps":[{"label":"Create with mandatory fields only","cases":["CMS/03","CMS/04"]}]}]}',
      '```'
    ].join('\n')
  };

  function render(tpl, vars) {
    return tpl.replace(/\{\{(\w+)\}\}/g, function (_, k) {
      return vars[k] == null ? '' : String(vars[k]);
    });
  }

  function oneLine(s, max) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return max && t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
  }

  function list(values) {
    var out = [];
    (values || []).forEach(function (v) {
      var s = oneLine(v, 80);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out.length ? out.join('; ') : '(none yet)';
  }

  /**
   * ctx: { tab, fields: [labels], features, subFeatures, testTypes,
   *        existing: [{id, scenario}], findings: [{key, text, issue, area, details}], edgeCases }
   */
  function draftScenarios(ctx) {
    var existing = (ctx.existing || []).map(function (c) { return '- ' + oneLine(c.id || c.key, 40) + ' | ' + oneLine(c.scenario, 200); });
    var findings = (ctx.findings || []).map(function (f) {
      var line = '- ' + f.key + ': ' + oneLine(f.text, 400);
      if (f.issue) line += ' (bug ' + oneLine(f.issue, 60) + ')';
      if (f.area) line += ' [area: ' + oneLine(f.area, 120) + ']';
      if (f.details) line += '\n  Details: ' + oneLine(f.details, 1500);
      return line;
    });
    return render(TEMPLATES.draftScenarios, {
      tab: oneLine(ctx.tab, 80),
      houseStyle: HOUSE_STYLE,
      fields: (ctx.fields || []).join(', '),
      features: list(ctx.features),
      subFeatures: list(ctx.subFeatures),
      testTypes: list(ctx.testTypes),
      existing: existing.length ? existing.join('\n') : '(none)',
      findings: findings.join('\n'),
      edgeCases: ctx.edgeCases == null ? 3 : ctx.edgeCases
    });
  }

  /** ctx: { tab, cases: [{id, group1, group2, testType, preCondition, scenario}], focus } */
  function planPaths(ctx) {
    var rows = (ctx.cases || []).map(function (c) {
      return '- ' + [oneLine(c.id || c.key, 40), oneLine(c.group1, 60), oneLine(c.group2, 60), oneLine(c.testType, 30), oneLine(c.preCondition, 140), oneLine(c.scenario, 200)].join(' | ');
    });
    return render(TEMPLATES.planPaths, {
      tab: oneLine(ctx.tab, 80),
      focus: ctx.focus ? '\n' + oneLine(ctx.focus, 400) : '',
      cases: rows.join('\n')
    });
  }

  return {
    HOUSE_STYLE: HOUSE_STYLE,
    TEMPLATES: TEMPLATES,
    render: render,
    draftScenarios: draftScenarios,
    planPaths: planPaths
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TRPrompts;
