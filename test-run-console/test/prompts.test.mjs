import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCore, ROOT } from '../dev/load.mjs';
import { renderPromptDocs } from '../scripts/export-prompts.mjs';

const { TRPrompts, TRCore } = loadCore();

test('prompts/*.md match apps-script/prompts.gs (run npm run prompts after editing)', () => {
  for (const [name, text] of Object.entries(renderPromptDocs())) {
    assert.equal(readFileSync(join(ROOT, 'prompts', name), 'utf8'), text, `prompts/${name} is out of date`);
  }
});

test('the draft prompt lists the findings and asks for the JSON the inbox reads', () => {
  const text = TRPrompts.draftScenarios({
    tab: 'CMS 2.20.1',
    fields: ['scenario (Scenario)'],
    features: [],
    subFeatures: ['Citizen UI', 'Citizen UI', ''],
    testTypes: ['Functional'],
    existing: [{ id: 'CMS/14', scenario: 'Verify if the citizen can reopen' }],
    findings: [{ key: 'F-001', text: 'Reopen missing\nafter 4 days', issue: '#77', area: 'Citizen UI', details: '' }],
  });
  assert.match(text, /- F-001: Reopen missing after 4 days \(bug #77\) \[area: Citizen UI\]/);
  assert.match(text, /Sub feature values already used: Citizen UI\n/);
  assert.match(text, /Feature values already used: \(none yet\)/);
  assert.match(text, /- CMS\/14 \| Verify if the citizen can reopen/);
  assert.doesNotMatch(text, /\{\{/);
  // The example reply in the prompt is itself a valid reply.
  const example = TRCore.validateReply(TRCore.extractJson(text.slice(text.lastIndexOf('```json'))), { caseIds: ['CMS/045'] });
  assert.equal(example.type, 'scenarios');
});

test('the path prompt has one line per case and an example the inbox accepts', () => {
  const text = TRPrompts.planPaths({ tab: 'T', cases: [{ id: 'CMS/03', group1: '', group2: 'Workflow', testType: 'Functional', preCondition: 'GRO logged in', scenario: 'Verify if X' }], focus: 'GRO and LME are one person' });
  assert.match(text, /- CMS\/03 \|  \| Workflow \| Functional \| GRO logged in \| Verify if X/);
  assert.match(text, /GRO and LME are one person/);
  const example = TRCore.validateReply(TRCore.extractJson(text.slice(text.lastIndexOf('```json'))), { caseIds: ['CMS/03', 'CMS/04'] });
  assert.equal(example.type, 'paths');
});
