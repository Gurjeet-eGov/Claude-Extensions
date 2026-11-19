# Test Run console

A small app for **manual test runs on your test case workbooks** (`.xlsx`). It shows you what to test next, colour coded, and you mark results with one click or one key. Each result is saved straight into the workbook on your computer. Managers get a clean summary page you can print or send.

The workbooks stay on your laptop, in `sheets/`, which git ignores. To test as a team, share your Test Run: teammates open an invite link and mark results at the same time, and managers follow the summary (see [Sharing with your team](#sharing-with-your-team)). To let anyone read the reports, even when your laptop is off, and to let someone else carry on from a clone, publish them (see [Publishing the reports](#publishing-the-reports)).

| Run | Summary for management |
|---|---|
| ![Run screen](docs/screenshots/run.png) | ![Summary page](docs/screenshots/summary.png) |

## Start it

You need Node.js 18 or later.

```bash
cd test-run-console
npm install
```

```bash
npm start
```

That opens http://127.0.0.1:5178. Put your workbooks in `test-run-console/sheets/`, or use **Import** in the console. Stop it with Ctrl+C in that terminal.

Want to look around first? Run `npm run demo`. It uses a throwaway copy of a sample workbook.

## What it does

Five screens: **Run**, **Known issues**, **Findings**, **Summary** and **Setup**.

- **Workbooks.** Keep one workbook per environment (or however you work). **Import** (top right, for the person running Test Run) takes one or several `.xlsx` files at once. **Workbook** (top right) switches between them, for everyone, including teammates with View only links. Each browser remembers its own choice.
- **Top right, for everyone signed in:** your name. Hover over it to see your role (Host, Admin, Update status or View only) and **Sign out**, which forgets the access link in this browser; you need the link again to come back. On the laptop itself you are always the host, so it offers **Change your name** instead.
- **Test suites and cycles.** Under the screen names, the **Test suites** row has a button for each test case tab of the workbook (a module, say PGR or Trade License) and **Test cycle** picks the cycle. The row, with the progress bar, stays in view while you scroll.
- **Run.** Cases are grouped into *test paths*, by Feature then Sub feature.
  - The filters sit in a column on the left that stays in view: Search, Show (To do, Failed, All, Retired) and Test type. **Collapse**, **Expand** and **?** (shortcuts) are at the top right of the list.
  - Each case is one line: a status dot, the ID, the scenario, its test type as a tag, and badges.
  - **+ Add a test case here**, at the end of each section, adds a scenario you found while testing, with the section's feature and sub feature filled in. It goes after the last row of the workbook, with the next ID.
  - Click a case to see its pre condition, test data and expected result as bullets.
  - Mark it with **P**, **F**, **N** or a button. The next case in the list opens, and **U** undoes.
  - **Comment and issue link:** type them before or after choosing the result. Pressing a result saves all three and opens the next case. A failure with nothing typed yet stays open so you can describe it; press the result again (or **Save note**, or Enter) once you have.
  - **Clear a result:** press the chosen button again with nothing new typed (or **0**, or **Clear result**). The case goes back to not run, so you can come back to it.
- **Issue links.** Paste the issue's link (GitHub, GitLab, Jira or any `https://` page) in **Issue link**. Several are fine, separated by commas.
  - The workbook shows a short reference such as `#123`, linked to the issue, in the *Linked issue* column. If the tab has no such column, the first link adds one at the right of the table.
  - A cell can hold only one link in Excel, so a cell with several issues links to the first. Every issue keeps its own link in **Known issues** and its sheet.
- **Known issues.** Every issue in the workbook: from Issue links on test cases, and bugs Bug Reporter or **Add issue** added as findings (not in the test cases yet).
  - Each shows its title, priority, state (open or closed) and its test cases. Click a case to open it in Run.
  - Titles, states and priorities of GitHub issues are filled in from GitHub, with the `gh` login on the laptop running Test Run. Priority comes from the issue's project board (a *Priority* field) or a label such as `P1`. **Refresh from GitHub** gets the latest. You can also type a title or priority with **✎**.
  - **+ Add issue** (for everyone but View only) notes an issue that was logged outside Test Run, for example straight on GitHub or in another tracker: its link, a title (read from GitHub when left blank for a GitHub issue), a priority and the test suite.
    - With a **test case**, the issue goes in that case's *Linked issue* cell, and **Mark it failed in cycle …** (on by default) also marks the case failed with a comment line, as Bug Reporter does.
    - Without one, it is kept as a finding until it is linked to a case. Either way it is listed here.
  - **Download** adds them to the workbook as a **Known issues** sheet: the issue (linked), title, priority, state, test cases and when it was added. The file in `sheets/` is not changed.
- **Colour and symbol together.** ✓ pass, ✗ fail, – other, ○ not run, so results stay readable for colour-blind readers and on paper.
- **Risk first.** Sections with cases that are new in this release, or failed last cycle, come first, and those cases are tagged.
- **Automation badges.** If the workbook has the automation sign-off tab, cases whose comment names a spec (e.g. `inbox-search.spec`) show its latest result: **Auto ✓**, **Auto ✗** or **Auto ~**.
- **Cycles.** Each cycle is a pair of columns, `Test Status` and `Comment`, as your sheets already have.
  - **Setup → Workbook → Start new cycle** adds the next pair beside the last one, with the same header style, dropdown and formatting.
  - Earlier cycles stay, so you can compare. **Test cycle**, next to the test suites, switches between them.
  - **×** on a cycle in Setup removes it, to keep the workbook and the reports tidy: its two columns are deleted from the workbook, with their results. A pop-up says first that this cannot be undone (today's backup in `sheets/.testrun/backups/` still has it). The cycle leaves the Test cycle list, Summary and downloads, and the published reports at the next publish. A tab's last cycle stays.
- **Release in scope** (Setup → Workbook, on a tab with a *Release* column) is the release you are testing, for example `2.20.1`. Cases whose Release column says it are tagged **New in 2.20.1** and come first in Run. A cycle is different: it is one round of results (a status and comment column pair), and a release can take several cycles, for example a first run and a retest.
- **Fix cases while you run.** Under the result buttons of an open case:
  - **✎ Edit case** (or **E**) changes the scenario, pre condition, test data, expected result or test type in the workbook. An optional note is added to the cycle's comment as `Updated: …`.
  - **⧉ Duplicate of…** picks the case to keep (similar ones are suggested). This one is struck out and its comment starts with `Duplicate of CMS/12: …`.
  - **⊘ Deprecate** asks why the case is no longer needed. The case is struck out and its comment starts with `Deprecated: …`.
  - Nothing is deleted: the text stays in the workbook, struck out, with the reason in the Comment of the current cycle. Status cells are left as they are.
  - Retired cases leave the to-do list and the progress bar. The **Retired** filter in Run lists them (with their count next to the progress bar), and **Restore to the run** removes the strikethrough and the note.
  - They are left out of the reports: Summary (its figures, its print or PDF, the summary page and the published reports) and the workbook you **Download** (also from the published reports).
    - The download has no retired rows. A blank Feature or Sub feature on the case below keeps the value it filled down from a removed row.
    - Its **Known issues** sheet does not name them, and an old *Retired cases* section in a *Test Run Summary* tab is left out. In Test Run, **Known issues** still shows an issue's retired case, tagged *retired*.
  - The workbook in `sheets/` keeps them, struck out, so they can be restored. The strikethrough on the Scenario cell is what marks a case as retired, and a row someone strikes out by hand is treated the same way.
- **Findings.** Bugs and scenarios found while testing that are not in the test cases yet, from every test suite of the workbook. They are what gets added to the final workbook.
  - They arrive from Bug Reporter (tick *Also add this to Test Run* and leave the test case empty), or you add one with **+ Add finding**, choosing its test suite.
  - Each finding lists up to three similar test cases already in its suite. **Covered by this** moves it to **Done** in one click.
  - **Write up as test case** opens the case, prefilled from the bug, right there. **Add to workbook** appends it to the finding's suite with the next ID (`CMS/183`) and the last row's formatting.
  - **Already covered…** links it to an existing case by its ID instead.
  - **+ New test case** adds a case that has no finding behind it, to the test suite you pick in the form.
  - On the left: **Open** or **Done**, and a filter by test suite.
- **Summary.** Shows when it was updated, percent executed, pass rate, a colour strip per feature, open failures with issue links, and a comparison with the previous cycle. **Download** saves the workbook (with its Known issues sheet); **Print / PDF** prints it, with a title line on paper.
  - **Automation**, at the end of the Test suites row on Summary, is an overall summary of the automated test results: totals and pass rate, results per test file, the failing tests with their notes, and how many manual cases are linked to automation. Its **Test cycle** shows which status column the results come from (each automation tab's latest).
- **Setup** has three parts, on the left: **Workbook** (each tab: what it holds, its test cycles first, then its columns, folded once saved), **Sharing** (your name and the team) and **Publish**.
  - **Save** keeps you on Setup, with a *Setup saved.* message.
  - **✎ Rename** next to a tab's name renames that tab in the workbook (up to 31 characters, Excel's limit). Its setup, findings and plans move with it. A name that looks cut short at 31 characters (for example ending in an open bracket, as Google Sheets does when it saves a long tab name as .xlsx) gets a note offering this.
  - **Delete**, next to **Cancel** and **Save** at the bottom of Setup → Workbook (the host only, here or with the admin link), removes the open workbook for everyone: the file in `sheets/` and its Test Run data (setup, findings, known issues). A pop-up says first that this cannot be undone. The daily backups in `sheets/.testrun/backups/` stay, and copies already published to GitHub stay until the next publish.
- **Cells on several lines.** Legacy sheets often have several lines in one cell. The console reads them the way a person would:
  - lines become a list (bullet marks dropped, numbers like `1.` or `2,` kept);
  - a line that carries on the one before (a closing quote, lower case, or after "Dear Citizen,") stays with it;
  - a first line ending in `:` sits above its list.
  - In the case list a scenario on several lines reads `details: Type · Date · Status`. Editing a case shows the cell as it is, and saves it in the cell's own style.
- **Rows that fit their text.** Google Sheets downloads every row one line high, so wrapped cells show only their last line once the file is opened or uploaded again. Each save, and **Download**, grows rows to fit their wrapped text. Rows are only ever made taller.
- **Any layout.** Columns are found by header name, including headers on two lines such as `Test Status` / `v2.12`. Setup lets you fix anything it got wrong.

## Sharing with your team

Test Run runs on one laptop, yours. To share it, turn on **Setup → Sharing → Team**. Other testers can then mark results at the same time, and managers can follow the run and the summary. Teammates install nothing: they open their invite link.

### 1. How your team reaches your laptop

Test Run only listens on your laptop, so a tunnel gives it an internet address. **Setup → Sharing → Team** offers two ways:

| | Quick tunnel | Fixed address |
|---|---|---|
| Setup | `brew install cloudflared`, then **Start sharing** | Once: Tailscale Funnel, or a Cloudflare named tunnel |
| Address | New on every start, e.g. `https://words.trycloudflare.com` | Always the same, e.g. `https://my-mac.tail1234.ts.net` |
| Invite links | Last only with the hosted page and gist (below) | Always last |
| Best for | Trying it out | A team, every day |

**Quick tunnel.** `npm run share` (or **Start sharing**) opens a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), with no account.

- If it drops (sleep, a Wi-Fi change), Test Run opens it again by itself and says so in Setup.
- Sharing also starts again when you restart Test Run (`npm start`), until you press **Stop sharing**.
- Each start gets a new address. For invite links to survive that, you need both:
  - **Hosted page:** this console on GitHub Pages, `https://<owner>.github.io/<repo>/test-run/`. Invite links open there. It holds no data; it only talks to your laptop. To put it there, once:
    1. In the repository on GitHub: **Settings → Pages → Source: GitHub Actions**.
    2. Merge into `master`. The workflow [`.github/workflows/test-run-pages.yml`](../.github/workflows/test-run-pages.yml) publishes the console.
    3. In **Setup → Sharing → Team**, use the suggested address and press **Check**. It must say *Live*. (A `github.com/…/tree/…` address is the repository page, not GitHub Pages, and is refused.)
  - **Keep the current address in a secret gist:** Test Run writes its address to a gist with your `gh` login, and the hosted page looks it up there.
- Until the hosted page is live, invite links name the current tunnel address. They stop working when it changes, and you make new ones (**New link**).

**Fixed address.** An address that never changes, so links always work and no hosted page or gist is needed.

- **[Tailscale Funnel](https://tailscale.com/kb/1223/funnel)** (free, no domain needed):
  1. Install Tailscale on your Mac (`brew install --cask tailscale`, or the App Store) and sign in.
  2. Run `tailscale funnel --bg 5178`. The first time, it gives you a link to allow Funnel for your account. It keeps running after restarts.
  3. Your address is `https://<this-mac>.<tailnet>.ts.net` (`tailscale funnel status` shows it). In **Setup → Sharing → Team → Fixed address**, enter it (Test Run offers it when Tailscale is signed in) and press **Check**.
- **Cloudflare named tunnel** (needs a domain you manage in Cloudflare):
  1. `cloudflared tunnel login`
  2. `cloudflared tunnel create test-run`
  3. `cloudflared tunnel route dns test-run testrun.your-domain.org`
  4. In **Setup → Sharing → Team**, enter `https://testrun.your-domain.org` as the fixed address and `test-run` as the tunnel name, then **Start tunnel**. Test Run runs it while sharing and starts it again if it drops.

**Check** fetches the address and confirms it reaches this Test Run (not another laptop's).

### 2. Invite people

In **Setup → Sharing → Team**, add each person and choose their **Access** (it starts blank, on *Choose*):

| Access | Who | What they can do |
|---|---|---|
| Update status | testers | Run: mark, clear, edit, deprecate and mark duplicates. Known issues: type titles and priorities, **+ Add issue**. Findings: write them up. Summary. *Tested by* shows their name. |
| View only | managers | Run, Known issues and Summary, read-only. |

- Each person gets their own invite link. Send it to them privately.
- **Add and make a link**, **Copy link** and **New link** put the link on your clipboard (a message confirms it). Paste it to the person.
- **Copy link** gives you the same link again if they lose it, with the current address. **New link** replaces it; the old one stops working. (People added before Copy link existed need one **New link** first.)
- Opening the link signs them in. Their browser keeps it, so they bookmark the page.
- **Remove** someone, or make them a **New link**: the old link stops working at once.
- Setup, cycles, workbooks and the team stay with you, at the laptop.

**While sharing:** your laptop must stay on and awake, and Test Run running. Everyone works on the same workbook. Marks are saved one at a time, and a mark that collides with someone else's is refused, with what they marked. Each page picks up others' changes every 10 seconds.

**How access works:**
- Requests from your own laptop (http://127.0.0.1:5178) need no key, as before.
- Everything that comes through the tunnel must carry an invite key.
- Keys are checked against a stored hash. The keys themselves are kept in `sheets/.testrun/app.json` so links can be copied again: on your laptop only, never in git, and readable only by your user account.
- The page itself is public; the live workbook, issues, findings and summary are not. (What you publish is: see below.)

### 3. Your admin link

**Setup → Sharing → Team → Your admin link** gives you, the host, everything the laptop can do (testing, Setup, Sharing, Import, Publish) from another computer or network, through the same address as your team, while the laptop runs Test Run.

- **Make my admin link** copies it; open it on the other computer. Bug Reporter takes it like any invite link.
- It works like a password: keep it to yourself. **New admin link** replaces it; **Remove** turns it off.
- From the other computer, stopping sharing or changing the way in cuts that browser off, so Test Run asks first.
- Laptop paths (the sheets folder) and the export files on disk stay on the laptop.

## Publishing the reports

The host can publish the reports to the GitHub repository, so they can be read on the GitHub Pages site by anyone, even when no Test Run is running, and so someone else can carry on from a clone.

> **Published workbooks are public.** This repository is public: anyone can read what you publish (test cases, results, comments, findings, tester names and issue links) on GitHub and on the Pages site. It stays in the repository's history even if you stop publishing it. Invite keys and team settings (`sheets/.testrun/app.json`), backups and exports are never published.

**Setup → Publish** (the host only; testers and viewers cannot publish):
- **Workbooks to publish:** tick the ones that may go out.
- **When:** every day at **17:00** (change the time there) while Test Run runs, and **when Test Run stops** (Ctrl+C). These start after your first **Publish now**, which asks once that you know it is public. **Publish** on Summary does the same.
- **What a publish is:** one commit on the default branch, made through your `gh` login, in `test-run-console/published/`:
  - `workbooks/`: each ticked workbook and its sidecar file (setup, findings, issue list), exactly as saved;
  - `reports/`: the summary of every test suite and cycle, and the automation summary, which the Pages site shows.
- Your local checkout is not touched (the commit is made on GitHub directly), and nothing is committed when nothing changed.
- Teammates' results are already saved on the host's laptop, so there is one copy, and that is what is published.
- If someone else published after you last published or got the data, Test Run says so and does not overwrite theirs unless you choose to. **Get it** brings theirs in (a copy of what you had is kept in `sheets/.testrun/backups/`).

**The Pages site** (`https://<owner>.github.io/<repo>/test-run/`) shows the published reports to everyone: pick the workbook (top right), the test suite (or **Automation**) and the cycle; **Download** gets that workbook as published, and **Print / PDF** prints the report. A card at the top takes an access link (**Sign in**), which opens the live Test Run. When someone's Test Run is offline, they see the published reports with a note. **Preview here** in Setup → Publish shows the same from your laptop.

### Carrying on from a clone (hand over)

1. The current host publishes (or it happens at 17:00 or when their Test Run stops).
2. The next host clones the repository, then `cd test-run-console`, `npm install` and `npm start`.
3. With no workbooks yet, Test Run offers **Start from the published data**: the published workbooks and their sidecar files are copied into `sheets/`.
4. They turn on **Setup → Sharing** and add people (invite links belong to each host's laptop), and publish from then on.

One host at a time: if two hosts work at once, the second to publish is warned before replacing the first one's copy.

## With Bug Reporter

When Test Run is reachable, Bug Reporter's **Report Issue** form has a Test Run box, above the Claude options:

- **Also add this to Test Run:** tick it to add the bug once it is filed. The choice is remembered.
- **Test suite:** the workbook › tab. It starts on the one you picked last, else the one open in Test Run.
- **Test case (optional):** type an ID or a few words and pick from the list.
  - **With a test case:** that case is marked failed in the current cycle, the issue is linked to it, and its comment gets `Bug #123: <title>`. A case already failing keeps its result.
  - **Without one:** the bug becomes a finding in that suite, with the title, issue link, drafted Actual and Expected text and module, ready to **Write up as test case**.
  - Either way, the issue is listed in **Known issues** with the title and priority you filed it with.
- The review screen repeats what will happen in Test Run, next to **File issue**.
- **Settings:** Bug Reporter options → **Test Run**: the on/off switch; **Test Run address** (empty for Test Run on this computer); **Invite link** (paste the link your test lead sent; when the shared address changes, Bug Reporter finds the new one through the gist); **Check now**.

Loading this branch's Bug Reporter: in `chrome://extensions`, remove the Bug Reporter you have loaded, then **Load unpacked** this worktree's `bug-reporter/extension` folder. Both copies have the same extension ID, so only one can be loaded at a time; the native helper keeps working without reinstalling.

## Your workbooks

- **Where they live:** `sheets/*.xlsx`, never committed (only what you publish goes to GitHub, as a copy in `test-run-console/published/`). Settings and findings for a workbook are kept beside it in `sheets/.testrun/<workbook>.json`, so the workbook itself only holds test data. Your name and the team are in `sheets/.testrun/app.json`.
- **What changes in the workbook:**
  - the status, comment and issue cells you mark (the first issue link adds a *Linked issue* column if the tab has none);
  - case text you edit, and the strikethrough on cases you deprecate or mark as duplicates;
  - and only when you ask: new cycle columns (and removing a cycle's columns), added rows, the optional *Tested by*, *Tested on* and *Release* columns, and the *Test Run Summary* tab.
- **Safe saving:** each change is written to a temporary file first, which then replaces the workbook. The first save each day also keeps a copy in `sheets/.testrun/backups/` (14 days).
- **Excel:** if you edit the workbook in Excel and save, Test Run reloads it and never overwrites a cell that changed. While Excel has it open, a banner reminds you to close it there.
- **Publishing:** **Download** the workbook and upload it to Google Drive. If you keep it there as an `.xlsx` file, *Manage versions → Upload new version* keeps the same link.

## Running a cycle well

1. **Setup:** start the cycle (e.g. `v2.20.1`). If you tag cases by release, set the release in scope. Sharing? Start sharing and send the invite links.
2. **Work path by path.** Stay on one login and reuse the same complaint while it moves through its states.
3. **Take the Focus order:** new in this release first, then what failed last time. Glance at or skip **Auto ✓** cases.
4. **A failure:** paste the issue link with the result. Filing it with Bug Reporter? Tick *Also add this to Test Run* and pick the test case: it is marked failed with the link for you.
5. **Unplanned failure:** file it with Bug Reporter with no test case picked (it becomes a finding), or note a finding by hand.
6. **End of day:**
   1. **Findings:** write each one up, or mark it as already covered.
   2. **Known issues:** check titles and priorities.
   3. **Summary:** print it, or **Download** the workbook (with its Known issues sheet), or publish it.

## Development

```
server.mjs     the server (listens on 127.0.0.1 only; teammates come through a tunnel)
lib/
  core.js        pure logic: columns, statuses, IDs, risk order, paths, retired cases, summary
  sheet.js       reads and writes a workbook through a small sheet API
  api.js         the api_* functions the page calls
  xlsx-book.mjs  that sheet API on real .xlsx files (exceljs)
  books.mjs      the sheets folder: open, reload, safe save, backups, import
  store.mjs      the sidecar file beside each workbook
  team.mjs       invite keys, roles, local vs tunnelled requests, invite links
  share.mjs      the Cloudflare tunnel (quick or named), and the gist that keeps its address
  issues.mjs     GitHub issue titles, states and priorities, through gh
  publish.mjs    publishing to the repository: one commit through gh (Git Data API)
  prompts.js     prompts from the Claude drafting there was (off for now; kept for later)
  runtime.mjs    loads the logic for the server and the tests
ui/            the console and summary pages (also what GitHub Pages serves)
published/     what the host published (workbooks, sidecar files, reports); written by publishing, not by hand
dev/           in-memory sheet API, sample workbook (made-up cases), fake cloudflared and gh (fake-gh.cjs: a small fake GitHub)
test/          unit tests, HTTP and team tests, and browser tests (console; Bug Reporter + Test Run)
```

```bash
npm test          # everything; the browser tests skip without Playwright
npm run prompts   # regenerate prompts/*.md after editing lib/prompts.js
```

- **The two back ends must agree.** The server tests run against both the in-memory sheet API and real `.xlsx` files.
- **Browser tests** look for Playwright in `PLAYWRIGHT_DIR`, or in the CCRS `tests/integration-tests` checkout.

### Safety notes

- **Who can call it:**
  - The server listens on 127.0.0.1 only.
  - API calls must carry an `X-Test-Run` header.
  - Without a key, only the laptop itself is let in: the Host must be 127.0.0.1 or localhost, no proxy headers, and the call must come from the console's own page or the Bug Reporter extension (its ID comes from the manifest key). Other web pages are refused.
  - Everyone else needs an invite key (`Authorization: Bearer …`), checked against stored hashes. Testers and viewers each get a fixed list of api_* functions (`lib/team.mjs`).
  - CORS is open to any page, because no cookies are used and the key is the only credential.
- **What it writes:** text that looks like a formula (`=…`, `+…`) is stored as text; imports must be real `.xlsx` files; workbook names cannot leave the sheets folder.
- **Claude drafting** is switched off in the console for now. The prompt and reply checks in `lib/` stay, with their tests, for when it comes back.
