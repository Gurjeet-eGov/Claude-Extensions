# Test Run console

A small console for **manual testing on top of your existing Google Sheet of test cases**. You see what to test next, colour coded, and mark results with one click or one key. Every click is written straight into the sheet you already publish, so the sheet stays the only copy and its link never changes. Managers get a clean summary page they can open or print.

It is a Google Apps Script attached to the sheet: nothing to install, no server, no API keys.

| Run | Summary for management |
|---|---|
| ![Run screen](docs/screenshots/run.png) | ![Summary page](docs/screenshots/summary.png) |

## What it does

- **Run.** Cases are grouped into *test paths* (by Feature, then Sub feature, or a plan Claude made). Each case is one line: a status dot, the ID, the scenario and badges. Click it to see the pre condition, test data and expected result as bullets. Mark it with **P**, **F**, **N** or a button. Focus moves to the next untested case. **U** undoes.
- **Colour and symbol together.** ✓ pass, ✗ fail, – other, ○ not run, so results stay readable for colour-blind readers and on paper.
- **Focus on risk.** Untested cases sort into: new in this release, failed last cycle, manual only, automation already passing.
- **Automation badges.** If the workbook has the automation sign-off tab, cases whose comment names a spec (e.g. `inbox-search.spec`) show its latest result: **Auto ✓**, **Auto ✗** or **Auto ~**.
- **Cycles.** Each cycle is a pair of columns, `Test Status / v2.20.1` and `Comment / v2.20.1`, as the sheets already do. **Start new cycle** adds the pair and copies the dropdown and formatting. Earlier cycles stay, so you can compare.
- **Findings.** Found something unplanned? Log the bug as usual, then note it in one line with the bug number. Write it up as a test case later.
- **Inbox.** New test cases are reviewed here before they touch the sheet, whether written by hand or drafted by Claude. They are appended with the sheet's next ID (`CMS/183`) and the last row's formatting.
- **Summary.** Shows percent executed, pass rate, a colour strip per feature, open failures with issue links, a comparison with the previous cycle, and manual vs automated coverage. It is also available as a shareable page, a printable PDF, or a `Test Run Summary` tab in the sheet.
- **Any layout.** Columns are found by header name. Setup lets you fix anything it got wrong. The two manual layouts, the automation tab and the KPI tab of the CMS sign-off workbook all work as they are.
- **Several testers.** Each save checks that the cell still holds what you last saw. If someone else changed it, you get a notice instead of overwriting their result. Optional `Tested by` / `Tested on` columns record who did what.

## What it can and cannot touch

- **One sheet only.** The script is attached to one sheet and declares `@OnlyCurrentDoc`, so Google gives it the `spreadsheets.currentonly` permission: *see and edit this spreadsheet*. It has no Google Drive access and cannot open any other file.
- **Each person acts as themselves.** The sheet's normal sharing decides who can do what: editors can mark results, viewers only see.
- **Claude is never connected.** "Copy for Claude" shows you the exact text first (only the findings you selected and related scenario titles), and you paste it into whichever Claude you use. Claude's reply comes back only when you paste it into the Inbox, where it is checked and shown for review. Turn Claude help off in Setup and every Claude button disappears.
- **What it changes in the sheet:**
  - status, comment and linked-issue cells when you mark;
  - a hidden `_testrun` tab for settings, findings, inbox drafts and path plans.
- **What it changes only when you click for it:**
  - **Start new cycle** adds two columns;
  - **Add to sheet** adds rows;
  - **Add … column** in Setup adds a column;
  - **Update summary tab** writes the `Test Run Summary` tab.

## Set up (about 5 minutes, once per sheet)

1. Open the test case sheet, then **Extensions → Apps Script**.
2. In **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**.
3. In the editor, create these files and paste in the contents of `apps-script/`.
   - **Script files** (`+` → Script), named without `.gs`: `Code` (replace the default contents), `core`, `prompts`, `sheet`.
   - **HTML files** (`+` → HTML), named without `.html`: `console`, `summary`, `styles`, `shared`, `client`.
   - **`appsscript.json`:** replace its contents with ours.
4. Save, then reload the sheet. A **Test Run** menu appears. Choose **Open console (sidebar)** and allow access. The request should list only *this spreadsheet*, *display content in Google apps* and *your email address*.
5. For the full-width console and the management link, go to **Deploy → New deployment → Web app**. Set **Execute as: User accessing the web app** and **Who has access: Anyone within your organisation**, then click **Deploy**. Share the URL:
   - with testers, as is;
   - with management, with `?view=summary` added.
6. The first time, the console opens on **Setup**. Check how each tab was read and save.

**New projects:** keep one "template" sheet with the script in it. *File → Make a copy* copies the script too (redo step 5 in the copy).

**Updating the code later:** paste the changed files again, then **Deploy → Manage deployments → edit → Version: New version**. Or use [clasp](https://github.com/google/clasp) with this folder's `apps-script/` as the root (`clasp push`).

## Running a cycle well

1. **Plan:** start the cycle (e.g. `v2.20.1`). If you tag cases by release, set the release in scope.
2. Open the console beside the app under test (Chrome split view, or the sidebar).
3. **Work path by path.** Stay on one login and reuse the same complaint while it moves through its states.
4. **Take the Focus order:** new in this release first, then what failed last time. Glance at or skip **Auto ✓** cases.
5. **Unplanned failure:** log the bug, then add a one-line **Finding** with the bug number.
6. **End of day:**
   1. In **Findings**, select them and click **Copy for Claude**.
   2. Paste into Claude, then paste the reply into the **Inbox**.
   3. Review, then **Add to sheet**. Or write them up by hand.
7. Share the **Summary**, print it, or click **Update summary tab** before you publish the sheet.

### Optional: test paths from Claude

**Plan → Copy for Claude** sends one line per case (ID, feature, type, pre condition, scenario). Claude groups the cases into paths that one person runs in a single pass. Paste the reply into the Inbox and choose **Use this plan**. **Use automatic paths** switches back.

### Optional: Claude Code skill

`skill/test-run/SKILL.md` gives Claude Code the same drafting rules, and can read the GitHub issue behind a finding with `gh`. Install it by copying `skill/test-run` to `~/.claude/skills/test-run`. Plain claude.ai chat works without it, because the copied text carries the rules. The exact prompt texts are in [`prompts/`](prompts/).

## Development

```
apps-script/   the Apps Script project (what you paste into the sheet)
  core.gs        pure logic: columns, statuses, IDs, risk order, paths, reply checks, summary
  prompts.gs     the "Copy for Claude" texts
  sheet.gs       reads and writes the sheet
  Code.gs        entry points (doGet, menu, api_* functions)
  *.html         console, summary page, styles, shared helpers, client app
dev/           an in-memory fake of SpreadsheetApp and a sample workbook (made-up cases)
demo/          local demo server: real pages + real .gs code against the sample
test/          unit tests (Node) and a browser test (Playwright)
prompts/       generated copies of the prompt texts, for review
skill/         optional Claude Code skill
```

```bash
npm test          # unit tests + browser test (browser test skips without Playwright)
npm run demo      # http://127.0.0.1:5178 with sample data, nothing touches Google
npm run prompts   # regenerate prompts/*.md after editing prompts.gs
```

The browser test looks for Playwright in `PLAYWRIGHT_DIR`, or in the CCRS `tests/integration-tests` checkout.

## Status

Built and tested against an in-memory copy of the Sheets API (`dev/fake-sheets.mjs`) and in Chromium. It has **not yet been run inside Google Apps Script**. Before relying on it, check the following on a *copy* of a real sheet:

- the permission screen asks for this spreadsheet only;
- marking writes the exact dropdown values;
- a second editor gets the conflict notice and a viewer cannot write;
- the web app finds its sheet. If it reports that it cannot, use the sidebar from the sheet's **Test Run** menu; it runs the same pages.
