# Bug Reporter: setup guide

Allow about 10 minutes, once per computer. You need **macOS or Linux** and **Google Chrome 116 or later**. Chrome Beta, Chromium, Brave and Edge also work.

Bug Reporter stands on its own: you don't need Test Run or anything else from this repository.

When you're done you'll have:
- the **extension** in Chrome
- a small **helper** program on your computer. The helper uses *your own* GitHub and Claude logins; nothing is shared and no API keys are needed.

---

## Step 1: Install the tools

You need Node.js, the GitHub CLI and Claude Code. On a Mac, use [Homebrew](https://brew.sh).

```bash
brew install node gh
```

Already have them? Make sure the GitHub CLI is recent: version **2.104 or newer** can upload screenshots and videos.

```bash
brew upgrade gh
```

On **Linux**, install Node.js 18 or later from [nodejs.org](https://nodejs.org) (or your distribution's `nodejs` package, if it's recent enough), and the GitHub CLI from [cli.github.com](https://github.com/cli/cli/blob/trunk/docs/install_linux.md), which lists the commands for Debian, Ubuntu, Fedora and others.

Install **Claude Code** by following the instructions at <https://claude.com/claude-code>. You only need it for drafting with Claude; everything else works without it.

## Step 2: Sign in

Sign in to GitHub:

```bash
gh auth login
```

Give the GitHub CLI access to project boards. Without this, Status, Priority and Iteration can't be set.

```bash
gh auth refresh -s project,read:project
```

Sign in to Claude Code with your Claude subscription:

```bash
claude auth login
```

## Step 3: Get the code

```bash
git clone https://github.com/Gurjeet-eGov/Claude-Extensions.git
```

Or download it: on GitHub, click **Code → Download ZIP** and unzip it.

> **Tip:** the installer copies the helper out of this folder (to `~/Library/Application Support/egov-bug-reporter/` on macOS), so it can live anywhere. Chrome still loads the extension from this folder: if it's on your Desktop or in Documents, macOS may ask once whether Chrome may read it; click **Allow**.

## Step 4: Install the helper

```bash
cd Claude-Extensions/bug-reporter/host
```

```bash
./install.sh
```

The installer checks everything from steps 1–2. A good run looks like this:

```
  ✓ Node v24.x
  ✓ gh 2.104.0
  ✓ gh is logged in with the 'project' scope
  ✓ Claude Code 2.x
  ✓ Claude Code is signed in
  ✓ Helper copied to ~/Library/Application Support/egov-bug-reporter
  ✓ Helper registered for: Chrome …
```

If a line shows **✗**, run the command printed under it, then run `./install.sh` again.

## Step 5: Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder `Claude-Extensions/bug-reporter/extension`.
4. Click the puzzle-piece icon in the toolbar and **pin** "eGov Bug Reporter".

The extension's **Settings** page opens by itself.

## Step 6: Check the Setup tab

On the **Setup** tab, every row should be green.
- If a row is red, it shows the exact command to fix it. Copy it into Terminal, then click **Re-check**.
- "Not allowed in Incognito" is optional. See [Incognito](#incognito).

## Step 7: Add your project boards

Open the **Projects** tab, click **Add project**, and fill in:

1. **GitHub project board link:** paste the board's address, e.g. `https://github.com/orgs/eGov-Global/projects/17`, then click **Read board**.
2. **Repository for issues:** pick the repo issues should go to. If it isn't listed, choose **Other repository…** and type `owner/repo`, e.g. `egovernments/Citizen-Complaint-Resolution-System`. Don't paste the full link.
3. **Env Prefix** (optional): goes at the start of titles, e.g. `Bomet` gives `Bomet: Citizen: …`.
4. **Default assignee** and **Initial Status:** pick from the lists.
5. **Environment URL(s)** (optional): the app's address, e.g. `https://bgrm.bomet.go.ke`. When you report from that site, this project is chosen for you.

Click **Save project**. Repeat for each board you log issues to.

## Step 8: Allow screen recording (macOS)

The first time you record, macOS asks whether Chrome may record the screen. If it doesn't ask, or recording shows a black video:

1. Open **System Settings → Privacy & Security → Screen Recording**.
2. Switch on **Google Chrome**.
3. Quit and reopen Chrome.

---

## Try it (2 minutes)

1. Open the web app you test. Click the Bug Reporter icon, then **Enable on this site**. Reload the page once.
2. Press **⌥⇧R** (Option+Shift+R). In the Recorder window, click **Record a window** and pick your Chrome window.
3. Click around, then press **⌥⇧B** (Option+Shift+B). The report form opens next to your tab.
4. To practise without creating anything on GitHub, add `&dry=1` to the end of the report tab's address and press Enter. **File issue** then only shows the commands it would run.

| Shortcut | What it does |
|---|---|
| ⌥⇧R | Start / pause / resume recording |
| ⌥⇧B | Halt and report a new bug |
| ⌥⇧S | Take a snapshot (recording continues) |
| ⌥⇧X | Stop recording |
| *(set your own)* | Halt and update an existing issue: set a key at `chrome://extensions/shortcuts`, or use **Update Issue** in the popup |

To collect untranslated text instead, click **Track localizations** in the popup, browse the app, then click **■ Stop & save list** and pick where to save the CSV. See the [Track Localizations guide](TRACK-LOCALIZATIONS.md).

The [README](../README.md) explains every part of the form.

---

## Updating to a new version

From the `Claude-Extensions` folder, get the latest code:

```bash
git pull
```

Re-install the helper (it copies the new version into place):

```bash
cd bug-reporter/host && ./install.sh
```

Then, in `chrome://extensions`, click the **reload** arrow on eGov Bug Reporter.

## Troubleshooting

| What you see | What to do |
|---|---|
| Setup tab: **Helper not installed** | Run `./install.sh` in `bug-reporter/host`, then click **Re-check**. If you moved the folder, run it again. |
| **gh login is missing the project scope** | `gh auth refresh -s project,read:project` |
| **Claude Code is not signed in** / "Draft failed" | `claude auth login`. **Skip Claude** still works meanwhile. |
| **this gh version can't upload screenshots/videos** | `brew upgrade gh` |
| Recording doesn't start, or the video is black | See [Step 8](#step-8-allow-screen-recording-macos) (Screen Recording permission), then restart Chrome. |
| The report shows **no API calls** | Click **Enable on this site** in the popup, then reload the app's tab. Calls made before that aren't captured. |
| **Could not load board** in the form | Check you can open the board on github.com with the same account, then click **↻** next to Project. |
| Assignee isn't in the list | Only people GitHub lets you assign in that repo are listed. Ask a repo admin to give them access. |
| The video is **over the size cap** | Move the clip slider to a shorter length, or untick **Attach clip**. GitHub allows 10 MB on free plans. |
| A shortcut does nothing | Check or change it at `chrome://extensions/shortcuts`. Another app may be using the same keys. |
| Nothing works in **Incognito** | See [Incognito](#incognito). |

## Incognito

Chrome only runs extensions in Incognito if you allow it:
1. Open `chrome://extensions`.
2. Click **Details** on eGov Bug Reporter.
3. Switch on **Allow in Incognito**.

The report form opens in a normal window. API calls captured in Incognito are deleted when the last Incognito window closes.

## Uninstall

```bash
cd Claude-Extensions/bug-reporter/host && ./uninstall.sh
```

Then click **Remove** on eGov Bug Reporter in `chrome://extensions`.
