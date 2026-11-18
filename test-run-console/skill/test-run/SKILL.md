---
name: test-run
description: Draft manual test cases or test-path plans for the Test Run console (the Google Sheets manual-testing console), as one JSON block the tester pastes into the console's Inbox. Use this when the user pastes text that starts "You are helping a QA tester turn quick findings into manual test cases" or "You are helping a QA tester plan a manual test cycle", or asks to "write up my findings / today's bugs as test cases for Test Run", "draft test cases for the inbox", or "plan test paths for this tab". Never connects to Google Drive or the sheet; the tester reviews everything in the console before it is written.
---

# Test Run drafting

The Test Run console keeps manual test cases in a Google Sheet. Claude is never
connected to that sheet or to Google Drive. The tester copies a prompt out of
the console, and pastes Claude's reply back into the console's **Inbox**, where
it is validated and reviewed before anything is added. Your whole job is to
return one correct JSON block.

## Hard rules

- **Do not use Google Drive, Sheets or any document connector**, even if one is
  available. Everything you need is in the pasted prompt or in the conversation.
- **Reply with exactly one ```json block.** A short sentence before it is fine.
  The console ignores anything outside the block.
- Use case IDs exactly as given. Never invent IDs for new cases; the console
  assigns them.
- Fill only the fields the prompt lists under "Columns this sheet has". Leave
  the others out.

## Drafting test cases (`"type": "scenarios"`)

Follow the house style in the pasted prompt. If the user asks without a
pasted prompt, also read the taxonomy in the `test-case-manager` skill's
`references/taxonomy.md` (read only, never edit it). In short:

- Scenario: one line, "Verify if" / "Verify that", the actor (the deployment's
  own role names) and the observable behaviour.
- Expected: an array of short bullets, one check each, as outcomes
  ("Complaint shall move to RESOLVED"), with concrete states and messages.
- Test data only when values matter; never "N/A".
- Reuse existing Feature, Sub feature and Test type values.
- One case per finding, then up to 3 edge cases per finding
  (`"edgeCase": true`, same `"fromFinding"`), only ones not already covered.
- A finding that an existing case already covers goes under `"covered"` with
  that case's ID and a one-line reason, not as a new item.
- Set `"issue"` to the finding's bug number when it has one.

If the user gives bug numbers rather than a pasted prompt, you may read those
issues with `gh issue view <n> --repo <repo>` (read only) to get the actual and
expected behaviour. Ask which repo if it is not clear. Do not comment on,
label or edit issues.

```json
{"type":"scenarios","items":[{"fromFinding":"F-001","edgeCase":false,"scenario":"Verify if ...","feature":"","subFeature":"","testType":"","testData":"","preCondition":"","expected":["... shall ..."],"issue":"#123","release":""}],"covered":[{"fromFinding":"F-002","caseId":"CMS/045","note":"why"}]}
```

## Planning test paths (`"type": "paths"`)

A path is what one tester runs in one pass: one persona and login, one piece of
test data carried through its states, steps in the order performed, roughly
5 to 25 cases. Group cases with the same pre condition. Every case ID from the
prompt appears exactly once.

```json
{"type":"paths","paths":[{"name":"CSR: create and search","persona":"CSR","setup":"Log in as CSR","steps":[{"label":"Create with mandatory fields only","cases":["CMS/03","CMS/04"]}]}]}
```

## Suggesting edits to existing cases (`"type": "edits"`)

Only when the user asks to improve existing cases (e.g. split an expected
result into bullets). Editable fields: scenario, feature, subFeature, testType,
testData, preCondition, expected, linkedIssue, release, automatedBy.

```json
{"type":"edits","items":[{"caseId":"CMS/18","fields":{"expected":["SLA days shall be shown","Breached SLA shall turn red"]},"reason":"one check per bullet"}]}
```

## After replying

Tell the user in one line to paste the reply into **Test Run, Inbox, Paste
Claude's reply**, and that nothing is added until they click **Add to sheet**.
