# Test Run console

A small app for **manual test runs on your test case workbooks** (`.xlsx`). It shows what to test next, colour coded, and you mark results with one click or one key. Each result is saved straight into the workbook on the computer running Test Run. Testers can join from their own browsers, managers get a summary page, and the reports can be published for anyone to read.

**[Test Run Extension](extension/)**, in this folder, lets testers mark cases from Chrome's toolbar while they test, with a screenshot or a screen recording as evidence. It only works with this console.

| Run | Summary for management |
|---|---|
| ![Run screen](docs/screenshots/run.png) | ![Summary page](docs/screenshots/summary.png) |

**Contents:** [Quick start](#quick-start) · [How it works](#how-it-works) · [The screens](#the-screens) · [Sharing with your team](#sharing-with-your-team) · [Publishing the reports](#publishing-the-reports) · [Test Run Extension](#test-run-extension) · [With Bug Reporter](#with-bug-reporter) · [Automation results](#automation-results) · [Your workbooks and data](#your-workbooks-and-data) · [Running a cycle well](#running-a-cycle-well) · [Options](#options) · [Updating](#updating) · [Troubleshooting](#troubleshooting) · [Development](#development)

## Quick start

**You need:**

| | Needed for | Install |
|---|---|---|
| Node.js 18 or later | running Test Run | [nodejs.org](https://nodejs.org) or `brew install node` |
| Git | getting the code; your name in Test Run comes from `git config user.name` | usually already there |
| GitHub CLI (`gh`), signed in | optional: issue titles and states in Known issues, the gist that keeps a quick tunnel's address, publishing | `brew install gh`, then `gh auth login` |
| `cloudflared` or Tailscale | optional: sharing with your team | see [Sharing with your team](#sharing-with-your-team) |

It's used on macOS; Linux should work too, but isn't tested. Testers and managers who join through a link need only a browser.

**Try it with a sample workbook** (a throwaway copy; nothing you do is kept):

```bash
git clone https://github.com/Gurjeet-eGov/Claude-Extensions.git
cd Claude-Extensions/test-run-console
npm install
npm run demo
```

**Use it with your own workbooks:**

```bash
npm start
```

It opens http://127.0.0.1:5178 (on macOS it opens the browser for you; elsewhere, open that address). Put your workbooks in `test-run-console/sheets/`, or use **Import** in the console. Stop it with Ctrl+C in that terminal.

Clone the whole repository, not just this folder: Test Run also reads Bug Reporter's manifest, when it's there, to let that extension in.

## How it works

- **Workbook › test suite › cycle › case.** A **workbook** is one `.xlsx` file (often one per environment). Each tab with test cases is a **test suite** (a module, such as PGR). A **cycle** is one round of results: a pair of columns, *Test Status* and *Comment*, side by side with earlier cycles. A **case** is one row.
- **One host.** Test Run runs on one computer, the host's. The workbooks, results, screenshots and recordings stay there, in `sheets/`, which git ignores.
- **People.** On the host's computer you're the **host**: everything is open to you. Others join with an invite link that gives them **Update status** (testers: mark results, add issues and findings) or **View only** (managers: follow the run and the summary). The host's **admin link** gives full access from another computer.
- **Reaching the host.** Test Run only listens on the host's own computer. For a team, a tunnel (Cloudflare or Tailscale) gives it an internet address; invite links point there.
- **Publishing.** The host can publish the reports, and the ticked workbooks, to this repository, where the GitHub Pages site shows them to anyone. **What's published is public.**

## The screens

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
  - **✎** on a cycle renames it: the name changes in both its column headers (results and comments stay), and its evidence and the current-cycle setting follow. A name without a digit is written as `Test Status / name`, so it still reads as a cycle.
  - Earlier cycles stay, so you can compare. **Test cycle**, next to the test suites, switches between them.
  - **×** on a cycle in Setup removes it, to keep the workbook and the reports tidy: its two columns are deleted from the workbook, with their results. A pop-up says first that this cannot be undone (today's backup in `sheets/.testrun/backups/` still has it). The cycle leaves the Test cycle list, Summary and downloads, and the published reports at the next publish. A tab's last cycle stays.
- **Release in scope** (Setup → Workbook, on a tab with a *Release* column) is the release you are testing, for example `2.20.1`. Cases whose Release column says it are tagged **New in 2.20.1** and come first in Run. A cycle is different: it is one round of results (a status and comment column pair), and a release can take several cycles, for example a first run and a retest.
- **Fix cases while you run.** Under the result buttons of an open case:
  - **✎ Edit case** (or **E**) changes the scenario, pre condition, test data, expected result or test type in the workbook. An optional note is added to the cycle's comment as `Updated: …`.
  - **⧉ Duplicate of…** picks the case to keep (similar ones are suggested). This one is struck out and its comment starts with `Duplicate of CMS/12: …`.
  - **⊘ Deprecate** asks why the case is no longer needed. The case is struck out and its comment starts with `Deprecated: …`.
  - Nothing is deleted: the text stays in the workbook, struck out, with the reason in the Comment of the current cycle. Status cells are left as they are.
  - Retired cases leave the to-do list and the progress bar. The **Retired** filter in Run lists them (with their count next to the progress bar), and **Restore to the run** removes the strikethrough and the note.
  - They are left out of Summary: its figures, its print or PDF, the summary page and the published report figures.
  - They stay in the workbook, in `sheets/` and in the workbook you **Download** (also from the published reports): struck out, with `Deprecated: <reason>` (or `Duplicate of …`) in the comment. So the workbook still shows what was dropped and why, and the case can be restored. The strikethrough on the Scenario cell is what marks a case as retired, and a row someone strikes out by hand is treated the same way.
  - The download's **Known issues** sheet names a retired case with *(Deprecated)* or *(Duplicate of …)* in place of its status; in Test Run, **Known issues** tags it the same way.
- **Findings.** Bugs and scenarios found while testing that are not in the test cases yet, from every test suite of the workbook. They are what gets added to the final workbook.
  - They arrive from Bug Reporter (tick *Also add this to Test Run* and leave the test case empty), or you add one with **+ Add finding**, choosing its test suite.
  - Each finding lists up to three similar test cases already in its suite. **Covered by this** moves it to **Done** in one click.
  - **Write up as test case** opens the case, prefilled from the bug, right there. **Add to workbook** appends it to the finding's suite with the next ID (`CMS/183`) and the last row's formatting.
  - **Already covered…** links it to an existing case by its ID instead.
  - A finding with an issue link (a bug filed with Bug Reporter, say) takes its bug along when it is mapped to a case, by **Covered by this**, **Already covered…** or **Write up as test case**: the case gets the issue in its *Linked issue* column, is marked failed in the current cycle with `Bug #68: <title>` in its comment, and shows in Summary's Open failures. (A suite with no cycle yet only gets the link.)
  - **+ New test case** adds a case that has no finding behind it, to the test suite you pick in the form.
  - On the left: **Open** or **Done**, and a filter by test suite.
- **Summary.** Shows when it was updated, percent executed, pass rate, a colour strip per feature, open failures with issue links (including bugs filed as findings in that suite, not in the test cases yet), and a comparison with the previous cycle. A browser refresh stays on the screen you are on. **Download** saves the workbook (with its Known issues sheet); **Print / PDF** prints it, with a title line on paper.
  - **Automation**, at the end of the Test suites row on Summary, is an overall summary of the automated test results: totals and pass rate, results per test file, the failing tests with their notes, and how many manual cases are linked to automation. Its **Test cycle** shows which status column the results come from (each automation tab's latest).
- **Setup** has four parts, on the left: **Workbook** (each tab: what it holds, its test cycles first, then its columns, folded once saved), **Sharing** (your name and the team), **Publish** and **Media** (limits for Test Run Extension's screenshots and recordings).
  - **Save** keeps you on Setup, with a *Setup saved.* message.
  - **Delete**, next to **Cancel** and **Save** at the bottom of Setup → Workbook (the host only, here or with the admin link), removes the open workbook for everyone: the file in `sheets/` and its Test Run data (setup, findings, known issues). A pop-up says first that this cannot be undone. The daily backups in `sheets/.testrun/backups/` stay, and copies already published to GitHub stay until the next publish.
- **Cells on several lines.** Legacy sheets often have several lines in one cell. The console reads them the way a person would:
  - lines become a list (bullet marks dropped, numbers like `1.` or `2,` kept);
  - a line that carries on the one before (a closing quote, lower case, or after "Dear Citizen,") stays with it;
  - a first line ending in `:` sits above its list.
  - In the case list a scenario on several lines reads `details: Type · Date · Status`. Editing a case shows the cell as it is, and saves it in the cell's own style.
- **Rows that fit their text.** Google Sheets downloads every row one line high, so wrapped cells show only their last line once the file is opened or uploaded again. Each save, and **Download**, grows rows to fit their wrapped text. Rows are only ever made taller.
- **Any layout.** Columns are found by header name, including headers on two lines such as `Test Status` / `v2.12`. Setup lets you fix anything it got wrong.

## Sharing with your team

Test Run runs on one laptop, yours. To share it, turn on **Share with my team** in **Setup → Sharing → Team**. Other testers can then mark results at the same time, and managers can follow the run and the summary. Teammates install nothing: they open their invite link.

The Team card has three parts: **Connection** (how the team reaches your laptop, with the hosted page and gist under **Link settings**), **Your admin link**, and **People**.

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

In **Setup → Sharing → Team → People**, add each person, choose their **Access** (it starts blank, on *Select access*) and the **Workbooks** they can open: **All workbooks** (the default) or one of them. Someone given one workbook sees only that one in Test Run, its downloads, Bug Reporter and Test Run Extension; the others are refused. Change either one at any time in their row.

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
- **Workbooks to publish:** tick the ones that may go out. With none ticked, publishing takes every published report off the site (the commit removes them; earlier versions stay in the history).
- **When:** every day at **17:00** (change the time there) while Test Run runs. It starts after your first publish. **Publish** on Summary publishes too. Stopping Test Run (Ctrl+C) does not publish.
- **Save preferences** applies your changes; it is greyed out until something changed (**Discard** drops them). A change to the ticked workbooks asks first, in a pop-up that says what goes on or comes off the public site, then publishes right away. **Cancel** there undoes the change to the workbooks.
- **What a publish is:** one commit on the default branch, made through your `gh` login, in `test-run-console/published/`:
  - `workbooks/`: each ticked workbook and its sidecar file (setup, findings, issue list), exactly as saved;
  - `reports/`: the summary of every test suite and cycle, and the automation summary, which the Pages site shows.
- Your local checkout is not touched (the commit is made on GitHub directly), and nothing is committed when nothing changed.
- Teammates' results are already saved on the host's laptop, so there is one copy, and that is what is published.
- If someone else published after you last published or got the data, Test Run says so and does not overwrite theirs unless you choose to. **Get it** brings theirs in (a copy of what you had is kept in `sheets/.testrun/backups/`).

**The Pages site** (`https://<owner>.github.io/<repo>/test-run/`) shows the published reports to everyone: pick the workbook (top right), the test suite (or **Automation**) and the cycle; **Download** gets that workbook as published, and **Print / PDF** prints the report. A card at the top takes an access link (**Sign in**), which opens the live Test Run. When someone's Test Run is offline, they see the published reports with a note. With nothing published, the summary shows – in its figures and *No data available* in its tables. **Preview here** in Setup → Publish shows the same from your laptop.

### Carrying on from a clone (hand over)

1. The current host publishes (or it happens at 17:00).
2. The next host clones the repository, then `cd test-run-console`, `npm install` and `npm start`.
3. With no workbooks yet, Test Run offers **Start from the published data**: the published workbooks and their sidecar files are copied into `sheets/`.
4. They turn on **Setup → Sharing** and add people (invite links belong to each host's laptop), and publish from then on.

One host at a time: if two hosts work at once, the second to publish is warned before replacing the first one's copy.

## Test Run Extension

[Test Run Extension](extension/) is a Chrome extension for marking cases while you test, with a screenshot or a screen recording as evidence. It works with this Test Run, on the laptop or through an access link. To install it, see [its README](extension/README.md).

- **Signing in:** it only asks for the access link your test lead sent (the host can paste `http://127.0.0.1:5178`, or their admin link). Nothing else shows until it is signed in. A **View only** link shows *Only view access, click here for summary*, which opens the Summary.
- **What you are testing:** **Choose Workbook/Suite** opens Test Run. The workbook, suite, cycle and case you have open there are what the extension shows, and it follows as you move. **‹ ›** and **Find a case by ID** move within the suite. Closed and opened again, it carries on where it was (after marking, the next case), unless you picked another case in Test Run meanwhile.
- **Results:** Pass, Fail, NA, Skip (the suite's own result values), and a comment. Marking moves on to the next case.
- **Evidence:**
  - **Screenshot** takes the page you are on, scaled to fit 1920×1080, as a PNG. **Record** opens a small Recorder window: **Choose what to record** (Chrome asks which screen, window or tab, and whether to share audio). Once it records, that window minimises itself, and in the popup **Pause** (then **Resume**) and **Stop** take Record's place, half each. Stop attaches the recording.
  - One screenshot and one recording per case and cycle (a new one replaces the one of the same kind), kept on the laptop running Test Run, in `sheets/.testrun/evidence/<workbook>/<suite>/<cycle>/`, named like `CMS-07_v2.12_2026-11-20_14-32-05.png`. **They are never published.**
  - The file name goes in the cycle's comment: `Evidence: CMS-07_v2.12_….png`.
  - The first time, evidence is optional. Once a result has evidence, it can only change with new evidence: a screenshot or recording added since the result was saved. If there is one, the new result is just saved; if not, the extension asks for one first. The new file then backs the new result, and the old result's other file is deleted (it showed the old result). The same rule applies in Run.
  - The case ID in the extension is a link: it opens Test Run on that case (`?case=` in the address).
  - Anyone who can mark results can remove a case's files, one at a time (✕ in the extension, **Remove** in Run). A removed file is deleted from the laptop for good and leaves the comment line; with no files left, the result can change freely.
- **Run** shows a case's screenshot and recording next to its result, each with **View** and **Remove**.

### Setup → Media (host)

The limits everyone records with. Testers can't change them.

| Setting | Choices |
|---|---|
| Video quality | **720p** (about 1 min 50 s per clip) or **1080p** (about 1 min, the default); always 30 fps |
| Each file | up to 20 MB; a recording stops by itself just before |
| Photos | up to 1920×1080, PNG |
| Audio | as picked in Chrome's share window |
| Keep a Complete Report | 15 min, 30 min or **1 hr** (the default) |

The 20 MB cap keeps every upload well under the 100 MB a Cloudflare tunnel accepts. The panel also shows how much space the evidence takes.

### Download for the host: Summary Report or Complete Report

For the host (on the laptop or with the admin link), **Download** (top right and on Summary) is a menu:

- **Summary Report:** the workbook (.xlsx), right away, as before.
- **Complete Report:** a popup with **Generate New** and **Download Existing**. Generate New makes a zip in the background, one at a time, of the workbook and the screenshots and recordings of every suite, in `Evidence/<suite>/<cycle>/<case>/`. A message says how long it will take, and **Download is ready, click here** shows at the bottom right when it is done.
  - The zip is kept for the time set in Media, then deleted from the laptop. Until then, Generate New is greyed out with **Wait for mm:ss**, and Download Existing says when it was created.

Others keep the plain **Download** (the workbook).

## With Bug Reporter

When Test Run is reachable, Bug Reporter's **Report Issue** form has a Test Run box, above the Claude options:

- **Also add this to Test Run:** tick it to add the bug once it is filed. The choice is remembered.
- **Workbook** and **Test suite:** where the bug goes. They start on the ones you picked last, else the ones open in Test Run. Someone given one workbook sees only that one.
- **Test case (optional):** type an ID or a few words and pick from the list.
  - **With a test case:** that case is marked failed in the current cycle, the issue is linked to it, and its comment gets `Bug #123: <title>`. A case already failing keeps its result.
  - **Without one:** the bug becomes a finding in that suite, with the title, issue link, drafted Actual and Expected text and module, ready to **Write up as test case**.
  - Either way, the issue is listed in **Known issues** with the title and priority you filed it with.
- The review screen repeats what will happen in Test Run, next to **File issue**.
- **Settings:** Bug Reporter options → **Test Run**: the on/off switch; **Test Run address** (empty for Test Run on this computer); **Invite link** (paste the link your test lead sent; when the shared address changes, Bug Reporter finds the new one through the gist); **Check now**.

Bug Reporter is a separate product with its own setup: see [its README](../bug-reporter/README.md).

## Automation results

Automated test results come in through the workbook today: set a tab to **Automation results** in Setup › Workbook (it needs a spec-file column and a status column per cycle; the sample workbook from `npm run demo` has one).
- **Summary › Automation** shows the totals, results per test file and the failing tests.
- Manual cases whose comment or *Automated by* column names a spec (e.g. `inbox-search.spec`) show its latest result in Run: **Auto ✓**, **Auto ✗** or **Auto ~**.

Running automated suites from Test Run against a chosen environment, and publishing their own reports, is planned: see [automation/](../automation/README.md).

## Your workbooks and data

- **Where they live:** `sheets/*.xlsx`, never committed (only what you publish goes to GitHub, as a copy in `test-run-console/published/`). Settings and findings for a workbook are kept beside it in `sheets/.testrun/<workbook>.json`, so the workbook itself only holds test data. Your name and the team are in `sheets/.testrun/app.json`.
- **What changes in the workbook:**
  - the status, comment and issue cells you mark (the first issue link adds a *Linked issue* column if the tab has none);
  - case text you edit, and the strikethrough on cases you deprecate or mark as duplicates;
  - and only when you ask: new cycle columns (and renaming or removing a cycle's columns), added rows, the optional *Release* column, and the *Test Run Summary* tab.
  - *Tested by* and *Tested on* are required: **Import** adds them at the right of each test suite tab that has none (and uses them where they are already there). For a workbook added another way, Setup → Workbook has **Add Tested by + Tested on columns**.
  - an `Evidence: <file>` line in a cycle's comment, while that case has evidence from Test Run Extension.
- **Safe saving:** each change is written to a temporary file first, which then replaces the workbook. The first save each day also keeps a copy in `sheets/.testrun/backups/` (14 days).
- **Excel:** if you edit the workbook in Excel and save, Test Run reloads it and never overwrites a cell that changed. While Excel has it open, a banner reminds you to close it there.
- **Publishing:** **Download** the workbook and upload it to Google Drive. If you keep it there as an `.xlsx` file, *Manage versions → Upload new version* keeps the same link.

**Where everything is kept** (all under `sheets/` unless you start with `--sheets`; none of it is committed):

| What | Where |
|---|---|
| Workbooks | `sheets/*.xlsx` |
| Each workbook's setup, findings and issue list | `sheets/.testrun/<workbook>.json` |
| Your name, the team with its invite keys, publish and media settings | `sheets/.testrun/app.json` (readable only by your user account) |
| Daily backups, kept 14 days | `sheets/.testrun/backups/` |
| Screenshots and recordings from Test Run Extension | `sheets/.testrun/evidence/<workbook>/<suite>/<cycle>/` |
| Complete Report zips, deleted after the keep time | `sheets/.testrun/complete-reports/` |
| HTML summaries you save | `sheets/exports/` |

What leaves the computer: GitHub issue lookups and the gist (through your `gh` login), the tunnel while sharing, and what you publish.

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

## Options

| Flag | Environment variable | What it does |
|---|---|---|
| `--port <n>` | `PORT` | Listen on another port (default 5178). On the host's computer, the extensions then need that address (`http://127.0.0.1:<port>`) instead of the default. |
| `--sheets <folder>` | `TEST_RUN_SHEETS` | Use another sheets folder. |
| `--no-open` | | Don't open the browser on start (macOS). |
| `--share` | | Start sharing straight away (`npm run share`). |
| `--demo` | | Use a throwaway copy of the sample workbook (`npm run demo`). |
| | `TEST_RUN_GH` | Use another `gh` (development: `dev/fake-gh.cjs`, so nothing is published for real). |

## Updating

```bash
git pull
cd test-run-console
npm install
```

Then stop Test Run (Ctrl+C) and start it again. Testers reload Test Run Extension in `chrome://extensions` (unpacked extensions never update by themselves). Your workbooks and data in `sheets/` are untouched.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Port 5178 is already in use` | Test Run is probably already running in another terminal. Otherwise start it with `--port <another>`, and give the extensions that address. |
| The browser doesn't open | Only macOS opens it by itself; open http://127.0.0.1:5178. |
| "This workbook is open in Excel." | Close it in Excel; results can't be saved while Excel has it. |
| Known issues have no titles or states | Sign in to `gh` (`gh auth login`) on the host's computer, then **Refresh from GitHub**. |
| Invite links stopped working after a restart | With a quick tunnel the address changes. Set up the hosted page and gist, or a fixed address: see [Sharing with your team](#sharing-with-your-team). |
| An invite link was shared by mistake | In Setup › Sharing › Team, **New link** for that person (the old one stops working at once), or **Remove** them. |
| Publishing fails | Publishing commits to the repository in this clone's `origin`, through `gh`. You need push rights there, or publish from your own fork. |
| Test Run Extension can't reach Test Run | Is Test Run running? On the host's computer the extension uses `http://127.0.0.1:5178`; through an invite link, the host must be sharing. |

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
  evidence.mjs   Test Run Extension's evidence (kept on the laptop), the media limits, the Complete Report zip
  prompts.js     prompts from the Claude drafting there was (off for now; kept for later)
  runtime.mjs    loads the logic for the server and the tests
ui/            the console and summary pages (also what GitHub Pages serves)
extension/     Test Run Extension (Chrome, Manifest V3, no build step): see extension/README.md
published/     what the host published (workbooks, sidecar files, reports); written by publishing, not by hand
dev/           in-memory sheet API, sample workbook (made-up cases), fake cloudflared and gh (fake-gh.cjs: a small fake GitHub)
test/          unit tests, HTTP and team tests, and browser tests (console; Test Run Extension; Bug Reporter + Test Run)
skill/, prompts/  parked with Claude drafting, which is switched off: kept for when it comes back
```

```bash
npm test          # everything, Test Run Extension's tests included; the browser tests skip without Playwright
npm run prompts   # regenerate prompts/*.md after editing lib/prompts.js
```

- **The two back ends must agree.** The server tests run against both the in-memory sheet API and real `.xlsx` files.
- **Browser tests** need Playwright: point `PLAYWRIGHT_DIR` at an installed copy (a `node_modules/playwright` folder), for example `PLAYWRIGHT_DIR=~/some-project/node_modules/playwright npm test`. Without it they look in `~/Documents/Citizen-Complaint-Resolution-System/tests/integration-tests`, else they're skipped. They load both extensions from this repository.

### Safety notes

- **Who can call it:**
  - The server listens on 127.0.0.1 only.
  - API calls must carry an `X-Test-Run` header.
  - Without a key, only the laptop itself is let in: the Host must be 127.0.0.1 or localhost, no proxy headers, and the call must come from the console's own page, Bug Reporter or Test Run Extension (their IDs come from their manifest keys). Other web pages are refused.
  - A valid key always says who is calling, on the laptop too (a teammate trying their own link there acts as that teammate, not as the host).
  - Everyone else needs an invite key (`Authorization: Bearer …`), checked against stored hashes. Testers and viewers each get a fixed list of api_* functions (`lib/team.mjs`).
  - CORS is open to any page, because no cookies are used and the key is the only credential.
- **Evidence:** only PNG photos and WebM or MP4 recordings are taken (checked by their first bytes, not their name), at most 20 MB each; View only links can't add or remove any. Files stay in `sheets/.testrun/evidence/` and are never published; a removed or replaced file is deleted. The Complete Report zip is for the host only and is deleted after the keep time.
- **What it writes:** text that looks like a formula (`=…`, `+…`) is stored as text; imports must be real `.xlsx` files; workbook names cannot leave the sheets folder.
- **Claude drafting** is switched off in the console for now. The prompt and reply checks in `lib/` stay, with their tests, for when it comes back.
