# Prompt: plan test paths

Built when a tester clicks **Copy for Claude** under Test paths on the Plan screen. It carries one line per case: ID, feature, sub feature, test type, pre condition and scenario.

Generated from `lib/prompts.js` by `npm run prompts`. Do not edit by hand.

Words in `{{double braces}}` are filled in by the console from the selected items only.

````text
You are helping a QA tester plan a manual test cycle for the "{{tab}}" tab of a test case workbook.

Group the test cases below into ordered test paths. A path is something one tester runs in a single pass:
- one persona and login (for example CSR, GRO, LME, citizen, admin), so the tester does not keep switching accounts;
- one piece of test data carried through its states (for example one complaint created, then assigned, then resolved), so setup is reused;
- steps in the order they would actually be performed.
Put cases that need the same pre condition next to each other. Keep paths to roughly 5-25 cases.
Every case ID must appear exactly once across all paths. Use the IDs exactly as given.{{focus}}

Test cases (ID | feature | sub feature | test type | pre condition | scenario):
{{cases}}

Reply with exactly one JSON code block and nothing else, in this shape:
```json
{"type":"paths","paths":[{"name":"CSR: create and assign","persona":"CSR","setup":"Log in as CSR; one complaint type with sub-types exists","steps":[{"label":"Create with mandatory fields only","cases":["CMS/03","CMS/04"]}]}]}
```
````
