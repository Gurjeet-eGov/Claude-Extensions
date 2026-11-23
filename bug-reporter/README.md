# eGov Bug Reporter

A Chrome extension and a small local helper for logging defects while you test a web app. You don't have to switch between Chrome, DevTools and the Claude app.

- **Record** the Chrome window (docked DevTools included) or your entire screen, from a small Recorder window. Pause, resume and stop any time.
- **Track localizations:** collect every raw localization key the app shows while you test, and save the list as a CSV.
- **Halt** with a shortcut (⌥⇧B). This pauses the recording, takes a screenshot, and freezes the API and console log at that instant.
- **Captured automatically:** every fetch/XHR call on the sites you enable, with failures flagged. That includes DIGIT `Errors[]` responses that come back with HTTP 200. Console errors are captured too.
- **Report form:**
  - Project, assignee, status, iteration and priority load straight from your GitHub board.
  - Pick any of the failed calls; each becomes a cURL + response block.
  - The video is trimmed to the last N seconds and kept under GitHub's size limit.
- **Claude** writes only the title and the Description / Actual / Expected text, in one short call. Everything else is filed with `gh`: the issue, attachments, board, Status, Priority and Iteration.

The helper uses **your own** `gh` and Claude Code logins on your machine. No API keys are involved. Drafts count against your Claude plan's normal usage, with no separate bill. The Settings page shows exactly what each draft used.

**It stands on its own.** You don't need anything else from this repository to use it. If your team uses the [Test Run console](../test-run-console/), Bug Reporter can also add each filed bug there ([Adding the bug to Test Run](#adding-the-bug-to-test-run)), but that's optional.

| You need | For |
|---|---|
| Google Chrome 116 or later (or Chrome Beta, Dev, Canary, Chromium, Brave, Edge) | the extension |
| macOS or Linux | the helper (a small Node program Chrome talks to) |
| Node.js 18 or later | the helper |
| GitHub CLI 2.104 or later, signed in with the `project` scope | filing issues, the board dropdowns, Update Issue |
| Claude Code, signed in with your Claude subscription | **Draft with Claude** and **Polish with Claude** only |

**Without the helper**, Track localizations still works (it needs neither the helper nor Claude). Everything that talks to GitHub or Claude needs it.

---

## Setup

**Follow the step-by-step [setup guide](docs/SETUP.md).** It takes about 10 minutes, once per computer, and ends with a troubleshooting table. In short:

1. Install Node.js, GitHub CLI 2.104+ and Claude Code, then sign in: `gh auth login`, `gh auth refresh -s project,read:project`, `claude auth login`.
2. `git clone https://github.com/Gurjeet-eGov/Claude-Extensions.git`, then run `Claude-Extensions/bug-reporter/host/install.sh`. Add `--install-skill` to also link the drafting rules into `~/.claude/skills/log-issue-extension`, so you can use them in Claude Code too.
3. In `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `bug-reporter/extension`.
4. In the Settings page that opens, check the **Setup** tab is green, then add your boards under **Projects**.
5. On macOS, allow Chrome under **System Settings → Privacy & Security → Screen Recording**.

## Daily use

1. Open the app you're testing. In the toolbar popup, click **Enable on this site** to start capturing its API calls. You only need to do this once per site.
2. Press **⌥⇧R**, or click **● Start recording** in the popup. A small **Recorder** window opens.
   - Click **Record a window** and pick your Chrome window, or **Record entire screen** if DevTools is undocked or you test across apps.
   - The Recorder window then minimises itself. Keep it open while you test: closing it ends the recording.
3. Test as usual. **⌥⇧S** takes extra screenshots. **⌥⇧R** pauses and resumes.
4. When you hit a defect, press **⌥⇧B**. The report form opens next to your tab.
   - **API calls** are listed newest first, with the time before the halt and the DIGIT error code. The latest failure is already ticked; tick any others that matter.
   - **Clip:** move the slider to choose how many seconds before the halt to attach. The size is shown against the cap.
   - Choose the **Priority** (required) and check the other fields. **Assignee** lists the people already working on this board first, then everyone else who can be assigned in the repo.
   - Write a line about what happened and what should have happened.
   - Under **Claude for this issue**, change the model, effort or detail for this one issue if you need to. They start from your Settings and don't change them.
   - Click **Draft with Claude**, or **Skip Claude** to use your own words.
   - Check the preview and any possible duplicates, then click **File issue** to get the link.
5. After filing, **Resume recording** appears only if a recording is actually paused. It takes you back to your app tab, and the toolbar badge shows **REC**.

| Shortcut | Action |
|---|---|
| ⌥⇧R | Start / pause / resume recording |
| ⌥⇧B | Halt & report |
| ⌥⇧S | Screenshot (recording continues) |
| ⌥⇧X | Stop recording |

You can change these at `chrome://extensions/shortcuts`.

## Keeping Claude usage low

- One call, one turn: no tools, no MCP servers, no CLAUDE.md, no skills list, no thinking, and output capped at 2,000 tokens (1,200 for concise). The only instructions Claude gets are `skill/log-issue-extension/SKILL.md`.
- **Detail** (Settings → Claude): *Detailed* (default) also gives Claude a condensed copy of the attached calls' request and response: errors kept whole, long lists and strings shortened, `RequestInfo` reduced to the user's type and roles. That's what lets it write descriptions with the actual values and a `Note:` when the data contradicts itself. *Concise* sends one-line summaries only.
- Typical costs on **Sonnet 5.5 at low effort**, at API-equivalent prices: about **$0.02** for the first detailed draft in an hour (Claude Code writes the instructions to its 1-hour cache), then about **$0.006–0.01** per draft; concise drafts cost about $0.005. Each draft takes 3–5 seconds.
- **Settings → Usage** shows the cost of every draft and the weekly and all-time totals, from Anthropic's official per-model prices (input, cache writes, cached reads and output priced separately). On a Claude subscription this is what the tokens would cost on the API; drafts count against your plan's limits rather than being billed.
- Claude never sees full payloads: one-line summaries, plus the condensed request/response in *Detailed* mode. The full cURL and response blocks are pasted into the issue by the extension, not written by Claude.
- The screenshot is only sent if you tick **Let Claude see the screenshot**.
- **Let Claude read the ticked API calls** (on by default; the default is in Settings → Claude). Untick it and Claude gets no API calls at all: the ticked calls still go into the issue under API Details, exactly as captured. Use it when a response holds data you don't want to send, or to save tokens.
- The duplicate search, dropdowns and filing never use Claude.
- The default is **Sonnet 5.5 at effort low**, using exact model IDs. Haiku 5.5 uses less but writes plainer text; change it in **Settings → Claude**. **Settings → Usage** logs every draft with its model, effort, tokens and turns.

## Updating an existing issue (re-testing a bug)

1. Record while you re-test, exactly as for a new bug.
2. In the popup, click **Update Issue**. You can also bind a key to "Halt & update" at `chrome://extensions/shortcuts`; Chrome allows only four default shortcuts and they're taken. Halting works the same as for a new bug: the recording pauses, a screenshot is taken, and the API log freezes.
3. In the form:
   - **Project:** pre-selected from the site you're on.
   - **Issue:** `215`, `#215` or the issue link, then press Enter. A card shows the issue's title, Open/Closed state, current board Status and assignee, so you can check it's the right bug.
   - **Verification result** (optional): ✅ Verified fixed, ❌ Still failing or ⚠️ Partly fixed. It becomes the first line of the comment, e.g. `✅ **Verified fixed** on Bomet`.
   - **Status** (blank = no change): changes the issue's Status on the board. The issue is added to the board first if it isn't on it.
   - **Comment:** your text. **Polish with Claude** (optional) rewrites it using the ticked API calls; **Undo polish** restores your text.
   - **Preview:** shows the comment exactly as it will be posted, with the ticked API calls, console errors, screenshots and the clip below your text.
4. Click **Comment**, or **Close with comment** (as completed, or as not planned). Close is disabled if the issue is already closed.

If the Status change or closing fails after the comment is posted, **Retry** redoes only that step. The comment is never posted twice. Add `&dry=1` to the tab's URL to see the `gh` commands without posting.

## Track localizations (finding untranslated text)

Use this while you click through workflows, to collect every place the app shows a raw localization key instead of translated text. Full guide: **[docs/TRACK-LOCALIZATIONS.md](docs/TRACK-LOCALIZATIONS.md)**.

1. On your app's tab, open the popup and click **Track localizations**. The toolbar badge shows **LOC**, unless a recording is running.
2. Test as usual, in as many tabs and pages of that site as you like. You can record at the same time.
3. Click **■ Stop & save list**. Chrome's **Save as** dialog opens so you can pick the folder.

You get one CSV per site, named after it: `bgrm.bomet.go.ke` gives `bgrm_bomet_go_ke.csv`. Columns:

| Code | Page |
|---|---|
| `CS_COMMON_SUBMIT` | `digit-ui/employee/pgr/inbox-v2` |

The CSV opens in Excel, Numbers, Google Sheets and LibreOffice on Mac, Windows and Ubuntu.

**What counts as a missing localization:**
- A raw key anywhere in the text: `\b[A-Z][A-Z0-9&]+(?:_[A-Za-z0-9&]+)+\b`. For example `CS_COMMON_SUBMIT`, `DSS_W&S_TOTAL_COLLECTION`, or `WARD_1` in "Azad Nagar - WARD_1".
- Or a whole string that's a raw tenant code: `^[a-z]{2}(?:\.[a-z0-9_]+)+$`, e.g. `ke.bomet`.
- Not flagged: icon names (`arrow_drop_down`), complaint numbers, emails, URLs, amounts, dates, plain words, or keys without an underscore (`SUBMIT`).

**Dropdowns, drill-downs and pages that load later:**
- When tracking starts and on every page load, the whole page is checked, *including hidden parts* already in the page, such as a dropdown's options before you open it.
- After that, anything that appears is checked the moment it appears: custom dropdowns, expanded rows, drill-down tables, modals, toasts, lazily loaded rows, and the next page in single-page apps.
- Placeholder text, tooltips (`title`) and screen-reader labels are checked too.
- Content the app only fetches when you click is found once you open it, so click through what you want covered.

**Long sessions:** only unique *Code + Page* pairs are kept (a few dozen bytes each), never page text, so a day-long session stays tiny. Tracking survives page reloads and Chrome restarts until you stop it.

- **Save so far** saves the list without stopping.
- After stopping, the popup shows the last list and offers **Save again**.
- Starting a new list replaces the last one; you're warned if it wasn't saved.

## Adding the bug to Test Run

When the [Test Run console](../test-run-console/) is reachable, the **Report Issue** form has a Test Run box, above the Claude options. It is tinted and carries Test Run's mark, since it comes from that app. Test Run can be on this computer, or a teammate's shared Test Run.

- **Also add this to Test Run:** tick it, and once the issue is filed it is added to Test Run.
- **Workbook** and **Test suite:** the workbook, then the test case tab of it to add the bug to. Someone given one workbook in Test Run sees only that one.
- **Test case (optional):** type an ID or a few words and pick from the list.
  - **With a test case:** that case is marked failed in the current cycle, with the issue linked to it and `Bug #123: <title>` added to its comment.
  - **Without one:** the bug becomes a finding in that suite, with the title, the issue link, the Description / Actual / Expected text and the module, to be written up as a test case there.
  - Either way, Test Run lists the issue under **Known issues** with its title and the priority you chose.
- **The checkbox and the suite** start from your last choice (else the suite open in Test Run). When Test Run isn't reachable, the box doesn't appear.
- **The review screen** repeats what will happen in Test Run, next to **File issue**.
- **If the note fails,** you get a warning only: the issue itself is already filed.
- **Settings:** options → **Test Run**:
  - a status line at the top (green when connected, with whom and what is open there), checked when you open the tab, and **Check now**;
  - **Offer to add filed bugs to Test Run**: the on/off switch;
  - **Connection**: the **Invite link** for a teammate's shared Test Run (it fills in the address and keeps your key; a view-only invite can't add bugs), and, folded under it, the **Test Run address**: empty for Test Run on this computer (`http://127.0.0.1:5178`), or another address.
- **A shared Test Run that moved:** its address can change, for example a quick tunnel after a restart. It keeps the current address in a gist, and Bug Reporter looks there when the saved address stops answering.
- **Network:** only the Test Run address you set (by default `127.0.0.1`), and for a shared Test Run its gist on `api.github.com`.

## Incognito

Chrome only runs extensions in Incognito windows if you allow it: go to `chrome://extensions` → eGov Bug Reporter → **Details** → switch on **Allow in Incognito**. The Setup tab shows whether it's on.

- Capture, recording, screenshots and halt all work in Incognito tabs.
- The report form opens in a regular Chrome window, because Chrome doesn't allow extension pages inside Incognito windows.
- API calls and console errors captured in Incognito are deleted when the last Incognito window closes. Screenshots and clips you've already put in a report follow the normal 3-day clean-up.

## Where the dropdowns come from

Nothing in the form uses Claude except **Draft with Claude**.

- Status, Iteration, Assignee and Priority options come from GitHub through the helper's `gh api graphql` calls, using your `gh` login.
- They're cached for 1 hour. The **↻** button next to Project fetches them again straight away.
- The current iteration is worked out in the extension: the one whose start date + duration covers today.

## Notes

- **Video size:** GitHub accepts videos up to 10 MB on free plans and 100 MB on paid plans. The default cap is 10 MB. Raise it in **Settings → Recording** only if your org is on a paid plan.
- **Nothing is redacted.** Requests and responses go into the issue as captured, like a DevTools copy-paste. DIGIT requests carry a live `authToken` in `RequestInfo`, so be careful when filing to a **public** repo.
- **Temporary files:** attachments are staged in `~/Library/Caches/egov-bug-reporter/` (or `~/.cache/…` on Linux) and deleted after filing. Leftovers are purged after 3 days, which you can change in **Settings → Capture & storage**.
- **Dry run:** add `&dry=1` to the report tab's URL. **File issue** then prints the `gh` commands instead of running them.
- **Updating:** `git pull`, re-run `host/install.sh`, then reload the extension in `chrome://extensions`. The installer copies the helper out of the repository (see below), so a pull alone doesn't update it.
- **Uninstall:** run `host/uninstall.sh`, then remove the extension from `chrome://extensions`.

## Where things are kept

| What | macOS | Linux |
|---|---|---|
| The helper's settings (paths to node, gh and claude, the repository) | `~/.config/egov-bug-reporter/config.json` | same |
| The helper itself, copied there by `install.sh` (so macOS doesn't ask for access to Documents or Desktop) | `~/Library/Application Support/egov-bug-reporter/` | `~/.local/share/egov-bug-reporter/` |
| The helper's log | `~/Library/Logs/egov-bug-reporter/host.log` | `~/.cache/egov-bug-reporter/host.log` |
| Attachments staged for filing, purged after 3 days | `~/Library/Caches/egov-bug-reporter/` | `~/.cache/egov-bug-reporter/` |
| Captured calls, settings, the localization list | Chrome's storage for the extension | same |

Chrome finds the helper through a native messaging host named `com.egov.bug_reporter`, registered by `install.sh` for each Chromium browser it finds, and allowed only for this extension's fixed ID (from the `key` in `manifest.json`). `host/uninstall.sh` removes all of it.

## Project layout

```
extension/   Chrome extension (Manifest V3, no build step)
  background/  service worker: shortcuts, halt, capture store, recorder control
  recorder/    Recorder window: window/screen capture, WebCodecs H.264 → MP4 via bundled mp4-muxer (MIT)
  content/     fetch/XHR/console hook (page world) + relay; localization tracker + rules
  popup/ report/ options/  UI
  lib/         shared logic (cURL, failure detection, title/body assembly, iterations)
host/        local helper (Node, no dependencies): gh + Claude Code, install.sh
skill/       drafting rules Claude follows (copy of log-issue, trimmed)
docs/        SETUP.md (setup + troubleshooting), TRACK-LOCALIZATIONS.md
test/        unit tests: npm test
```

Developer helpers:

```bash
npm test
node host/dev-cli.mjs diagnose
node host/dev-cli.mjs inspect https://github.com/orgs/<org>/projects/<n>
node host/dev-cli.mjs draft test/fixtures/draft.json
node host/dev-cli.mjs file --dry-run test/fixtures/file.json
```
