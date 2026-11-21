# Test Run Extension

A Chrome extension for marking [Test Run](../) cases while you test, with a screenshot or a screen recording as evidence. Results go straight into the workbook on the computer running Test Run (the host's); the evidence files stay on that computer and are never published.

**It only works with Test Run.** Test Run must be running, on your computer or a teammate's shared one, and you need an access link from the person running it (or `http://127.0.0.1:5178` on the host's own computer).

## Before you start

- **Google Chrome 116 or later** (Chromium-based browsers that load unpacked extensions, such as Brave or Edge, work too).
- **On macOS, for recordings:** allow Chrome under **System Settings → Privacy & Security → Screen Recording** (Chrome asks the first time; restart Chrome after allowing it).
- An **access link** from your test lead, or Test Run running on this computer.

## Install (once per computer)

1. Get the code, if you don't have it: `git clone https://github.com/Gurjeet-eGov/Claude-Extensions.git`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. **Load unpacked**, and choose the `test-run-console/extension` folder.
4. Pin **Test Run Extension** (the puzzle-piece menu → pin) so its button stays in the toolbar.

The extension has a fixed ID (from the `key` in `manifest.json`), wherever the folder is loaded from, so Test Run on the host's computer recognises it.

> **Loaded it before from the old `test-run-extension` folder?** That folder moved to `test-run-console/extension`. In `chrome://extensions`, **Remove** the old Test Run Extension, then **Load unpacked** the new folder. Paste your access link again when it asks.

## Use it

1. **Sign in:** click the button and paste the access link your test lead sent you (the host can paste `http://127.0.0.1:5178`, or their admin link). Nothing else shows until you're signed in. A View only link shows a link to the Summary instead.
2. **Choose Workbook/Suite:** opens Test Run. Pick the workbook, test suite and cycle there, and click a case. The extension shows the same, and follows as you move. **‹ ›** and **Find a case by ID** move within the suite. Closed and opened again, it carries on where it was (after marking, the next case), unless you picked another case in Test Run meanwhile.
3. **Evidence (optional the first time):**
   - **Screenshot:** the page you are on, as a PNG that fits 1920×1080.
   - **Record:** a small Recorder window opens. **Choose what to record** (Chrome asks for a screen, window or tab, and whether to share audio). The window then minimises itself, and in the popup **Pause** (then **Resume**) and **Stop** take the Record button's place. Stop attaches the recording. It stops by itself just before the size limit.
   - A case can have one screenshot and one recording in each cycle; a new one replaces the one of the same kind.
4. **Mark the result:** Pass, Fail, NA or Skip (the suite's own values), with a comment if you like. It moves on to the next case. The case ID (in blue) opens Test Run on that case.

**Changing a result that has evidence:** pick the new result. If you added a screenshot or recording since the result was saved, it is saved straight away; if not, the extension asks you to add one, then saves the result with it. The old result's other file is deleted then, as it showed the old result. Or remove the files first (✕, one at a time): they are deleted from Test Run for good, and the result can then change freely.

The limits (720p or 1080p at 30 fps, 20 MB a file, photos up to 1920×1080) are set by the host in Test Run's **Setup → Media**, and shown at the bottom of the popup.

## Roles

| Access link | What the extension does |
|---|---|
| Update status (testers), the admin link, or the host's own `http://127.0.0.1:5178` | Everything above |
| View only | Shows *Only view access* with a link to the Summary; no marking, no evidence |

## What it keeps and sends

- **Stored in Chrome** (this browser only): the access link and where you were. **Sign out** at the bottom of the popup, or removing the extension, forgets them. A link the host has replaced or removed signs you out by itself.
- **Sent:** only to the Test Run you signed in to (results, comments, screenshots and recordings), and to `api.github.com` to look up a shared Test Run's current address in its gist when it moved.
- **Permissions:** `storage` and `activeTab` (for the screenshot of the page you're on), plus the host's own address (`127.0.0.1`, `localhost`).

## Updating and removing

- **Update:** `git pull`, then click **↻** on Test Run Extension in `chrome://extensions`. Unpacked extensions never update by themselves.
- **Remove:** **Remove** in `chrome://extensions`. Evidence already sent stays in Test Run on the host's computer.

## Troubleshooting

| What you see | What to do |
|---|---|
| It can't reach Test Run | Is Test Run running? Through an invite link, the host must be sharing (Setup › Sharing). On the host's computer, use `http://127.0.0.1:5178`. |
| "Your access link no longer works." | The host replaced or removed it. Ask your test lead for a new one. |
| **Record** shows nothing to pick, or a black video | On macOS, allow Chrome under Screen Recording (see [Before you start](#before-you-start)) and restart Chrome. |
| A result won't change | It has evidence: add a new screenshot or recording first, or remove the old files (✕). |
| Only a Summary link shows | Your link is View only. |

## Files

```
manifest.json      Manifest V3: storage and activeTab only (plus the host's own address)
popup/             the toolbar popup: sign in, choose, test, mark, evidence
recorder/          the Recorder window (screen recording needs a real window to pick from)
lib/testrun.js     access links, requests to Test Run with the key, finding a moved address
lib/media.js       the media limits: photo size, recording format and when to stop, sizes
icons/             Test Run's mark
test/              the logic tests; the browser test is test-run-console/test/extension.e2e.test.mjs
```

Run the tests from `test-run-console` (`npm test` runs these too), or here:

```bash
npm test
```
