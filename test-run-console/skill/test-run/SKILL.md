---
name: test-run
description: Draft manual test cases or test-path plans for the Test Run console (the local manual-testing console for .xlsx test case workbooks), as one JSON block the console reads into its Inbox. Test Run uses this file as Claude's instructions when the tester clicks "Draft with Claude" or "Plan paths with Claude". Also use it when the user pastes text that starts "You are helping a QA tester turn quick findings into manual test cases" or "You are helping a QA tester plan a manual test cycle", or asks to "write up my findings / today's bugs as test cases for Test Run" or "plan test paths for this tab". Never opens or edits workbooks; the tester reviews everything in the console before it is written.
---

# Test Run drafting

You are drafting for Test Run, a console that keeps manual test cases in
`.xlsx` workbooks on the tester's computer. Your reply is read by the console,
checked, and shown in its **Inbox**, where the tester edits, accepts or rejects
each item. Nothing reaches the workbook until they click **Add to workbook**.
Your whole job is to return one correct JSON block.

## Hard rules

- **Reply with exactly one ```json block.** A short sentence before it is fine;
  the console ignores anything outside the block.
- Do not open, read or edit workbooks or any other files, and do not use any
  connector. Everything you need is in the message.
- Use case IDs exactly as given. Never invent IDs for new cases; the console
  assigns them.
- Fill only the fields the message lists under "Columns this sheet has". Leave
  the others out.

## Drafting test cases (`"type": "scenarios"`)

Follow the house style in the message. In short:

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
- Findings noted from Bug Reporter carry the bug's Actual / Expected text in
  their details; use it for precise expected results.

```json
{"type":"scenarios","items":[{"fromFinding":"F-001","edgeCase":false,"scenario":"Verify if ...","feature":"","subFeature":"","testType":"","testData":"","preCondition":"","expected":["... shall ..."],"issue":"#123","release":""}],"covered":[{"fromFinding":"F-002","caseId":"CMS/045","note":"why"}]}
```

## Planning test paths (`"type": "paths"`)

A path is what one tester runs in one pass: one persona and login, one piece of
test data carried through its states, steps in the order performed, roughly
5 to 25 cases. Group cases with the same pre condition. Every case ID from the
message appears exactly once.

```json
{"type":"paths","paths":[{"name":"CSR: create and search","persona":"CSR","setup":"Log in as CSR","steps":[{"label":"Create with mandatory fields only","cases":["CMS/03","CMS/04"]}]}]}
```

## Suggesting edits to existing cases (`"type": "edits"`)

Only when asked to improve existing cases (e.g. split an expected result into
bullets). Editable fields: scenario, feature, subFeature, testType, testData,
preCondition, expected, linkedIssue, release, automatedBy.

```json
{"type":"edits","items":[{"caseId":"CMS/18","fields":{"expected":["SLA days shall be shown","Breached SLA shall turn red"]},"reason":"one check per bullet"}]}
```

## When used in a chat (not from the console)

If the user pasted a prompt from Test Run's **Copy prompt**, reply the same
way and tell them in one line to paste your reply into **Test Run → Inbox →
Paste a reply from Claude used elsewhere**.
