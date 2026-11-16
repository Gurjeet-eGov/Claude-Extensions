# Claude Extensions

Browser extensions that bring Claude into everyday QA work.

| Extension | What it does |
|---|---|
| [**Bug Reporter**](bug-reporter/) | Record your Chrome window while you test a web app, halt on a defect, and file a GitHub issue in one go. The issue includes a screenshot, a trimmed video, the failing API calls (cURL + response) and the project board fields. Claude writes the description. You can also post re-test results as a comment on an existing issue, and [track missing localizations](bug-reporter/docs/TRACK-LOCALIZATIONS.md) while you test, saved as a CSV. |

## Get started

1. Follow the step-by-step **[Bug Reporter setup guide](bug-reporter/docs/SETUP.md)** (about 10 minutes, once per computer).
2. Read the **[Bug Reporter README](bug-reporter/README.md)** for how the report form, Update Issue and Claude usage work.

## Requirements at a glance

- macOS or Linux, with Google Chrome (or Chrome Beta, Chromium, Brave, Edge)
- Node.js 18+, GitHub CLI 2.104+ and Claude Code, each signed in with your own account

No API keys are needed. Claude drafts use your Claude subscription through your own Claude Code login.
