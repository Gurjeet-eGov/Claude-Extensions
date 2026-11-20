# Test Run Extension

A Chrome extension for marking [Test Run](../test-run-console/) cases while you test, with a screenshot or a screen recording as evidence. Results go straight into the workbook on the laptop running Test Run; the evidence files stay on that laptop and are never published.

## Install (once per computer)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. **Load unpacked**, and choose this `test-run-extension` folder.
3. Pin **Test Run Extension** (the puzzle-piece menu → pin) so its button stays in the toolbar.

The extension has a fixed ID (from the `key` in `manifest.json`), so Test Run on the laptop recognises it.

## Use it

1. **Sign in:** click the button and paste the access link your test lead sent you (the host can paste `http://127.0.0.1:5178`). Nothing else shows until you're signed in. A View only link shows a link to the Summary instead.
2. **Choose Workbook/Suite:** opens Test Run. Pick the workbook, test suite and cycle there, and click a case. The extension shows the same, and follows as you move. **‹ ›** and **Find a case by ID** move within the suite. Closed and opened again, it carries on where it was (after marking, the next case), unless you picked another case in Test Run meanwhile.
3. **Evidence (optional the first time):**
   - **Screenshot:** the page you are on, as a PNG that fits 1920×1080.
   - **Record:** a small Recorder window opens. **Choose what to record** (Chrome asks for a screen, window or tab, and whether to share audio). The window then minimises itself, and in the popup **Pause** (then **Resume**) and **Stop** take the Record button's place. Stop attaches the recording. It stops by itself just before the size limit.
   - A case can have one screenshot and one recording in each cycle; a new one replaces the one of the same kind.
4. **Mark the result:** Pass, Fail, NA or Skip, with a comment if you like. It moves on to the next case.

**Changing a result that has evidence:** pick the new result; the extension asks for new evidence (a screenshot or a recording) and then saves the result with it. The old result's other file is deleted then, as it showed the old result. Or remove the files first (✕, one at a time): they are deleted from Test Run for good, and the result can then change freely.

The limits (720p or 1080p at 30 fps, 20 MB a file, photos up to 1920×1080) are set by the host in Test Run's **Setup → Media**, and shown at the bottom of the popup.

## Files

```
manifest.json      Manifest V3: storage and activeTab only (plus the laptop's own address)
popup/             the toolbar popup: sign in, choose, test, mark, evidence
recorder/          the Recorder window (screen recording needs a real window to pick from)
lib/testrun.js     access links, requests to Test Run with the key, finding a moved address
lib/media.js       the media limits: photo size, recording format and when to stop, sizes
icons/             Test Run's mark
test/              the logic tests (npm test); the browser test is in test-run-console/test/extension.e2e.test.mjs (after Bug Reporter's)
```

```bash
npm test
```
