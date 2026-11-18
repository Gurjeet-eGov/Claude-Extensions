# Prompt: write up findings as test cases

Built when a tester selects findings and clicks **Copy for Claude** on the Findings screen. It carries the selected findings, the scenario titles of related cases (for the duplicate check), and the Feature / Sub feature / Test type values already used in the tab. No names, emails or sheet links.

Generated from `apps-script/prompts.gs` by `npm run prompts`. Do not edit by hand.

Words in `{{double braces}}` are filled in by the console from the selected items only.

````text
You are helping a QA tester turn quick findings into manual test cases for the "{{tab}}" tab of a Google Sheet.

House style for test cases:
- Scenario: one line starting "Verify if" or "Verify that", naming the actor (use this deployment's own role names) and the observable behaviour.
- Expected result: a list of short bullets, one verification each, stating the observable outcome ("Complaint shall move to RESOLVED"), not the click. Name concrete states, labels and messages where known. A single check still gets one bullet.
- Test data: the specific values that make the case runnable (boundary values, invalid inputs, file sizes). Leave it empty if none are needed; never write "N/A".
- Pre condition: configuration or state that must exist first (a role assigned, a complaint in a given state, master data seeded).
- Feature: the capability a manager would recognise, never naming a surface ("Complaint creation", not "Complaint creation - Citizen"). Never start it with < or >.
- Sub feature: the surface the tester runs it on. Reuse a value from the lists below whenever one fits.
- Test type: reuse a value from the list below.
- Do not merge different business rules into one case; a positive case and a negative or boundary case are separate cases.

Columns this sheet has (fill only these; leave the others out): {{fields}}
Feature values already used: {{features}}
Sub feature values already used: {{subFeatures}}
Test type values already used: {{testTypes}}

Existing scenarios in the same area (ID | scenario). Do not duplicate them; if a finding is already covered, list it under "covered" instead:
{{existing}}

Findings to write up:
{{findings}}

For each finding, write one test case. Then suggest up to {{edgeCases}} edge cases for it that are not already covered, each as its own item with "edgeCase": true and the same "fromFinding".
Set "issue" to the finding's bug number when it has one.

Reply with exactly one JSON code block and nothing else, in this shape:
```json
{"type":"scenarios","items":[{"fromFinding":"F-001","edgeCase":false,"scenario":"Verify if ...","feature":"","subFeature":"","testType":"","testData":"","preCondition":"","expected":["... shall ..."],"issue":"#123","release":""}],"covered":[{"fromFinding":"F-002","caseId":"CMS/045","note":"why it is already covered"}]}
```
````
