# Claude Extensions

Tools that bring Claude into everyday QA work.

| Tool | What it does |
|---|---|
| [**Bug Reporter**](bug-reporter/) | Chrome extension. Record your Chrome window while you test a web app, halt on a defect, and file a GitHub issue in one go. The issue includes a screenshot, a trimmed video, the failing API calls (cURL + response) and the project board fields. Claude writes the description. You can also post re-test results as a comment on an existing issue, and [track missing localizations](bug-reporter/docs/TRACK-LOCALIZATIONS.md) while you test, saved as a CSV. While Test Run is open, the review screen can also note the bug as a test scenario. |
| [**Test Run console**](test-run-console/) | A local app for manual test runs. A colour-coded console on top of your test case workbooks (`.xlsx` files kept on your computer): shows what to test next, marks results with one click or one key, writes them into the workbook, and gives management a summary page. Claude drafts test cases and test plans through your own Claude Code login. Two commands to start: `npm install`, then `npm start`. |
| [**Test Run Extension**](test-run-extension/) | Chrome extension for Test Run. Sign in with your access link, pick the workbook and suite in Test Run, then mark each case from the toolbar while you test, with a screenshot or a screen recording as evidence. Evidence stays on the laptop running Test Run; the host can download it all with the workbook as a Complete Report. |

## Get started with Bug Reporter

1. Follow the step-by-step **[Bug Reporter setup guide](bug-reporter/docs/SETUP.md)** (about 10 minutes, once per computer).
2. Read the **[Bug Reporter README](bug-reporter/README.md)** for how the report form, Update Issue and Claude usage work.

## Requirements at a glance

- macOS or Linux, with Google Chrome (or Chrome Beta, Chromium, Brave, Edge)
- Node.js 18+, GitHub CLI 2.104+ and Claude Code, each signed in with your own account

No API keys are needed. Claude drafts use your Claude subscription through your own Claude Code login.
