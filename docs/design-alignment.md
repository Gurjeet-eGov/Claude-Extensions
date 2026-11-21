# Plan: bring the extensions in line with the design guide

[DESIGN.md](../DESIGN.md) describes the design, taken from the Test Run console. Test Run Extension started as a copy of the console's styles and has drifted. Bug Reporter has its own palette and token names. This is the plan to make all three consistent. **It's a plan only: nothing here has been changed yet.**

## Where things stand

| Area | Console (the reference) | Test Run Extension | Bug Reporter |
|---|---|---|---|
| Token names | `--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--faint`, `--accent(-weak, -text)`, `--pass`, `--fail`, `--other`, `--none` (with `-bg`) | Most of the console's names, but `--bg` means the surface; no `--surface`, `--none`, `--accent-text` | Its own: `--bg-soft`, `--bg-sunk`, `--fg`, `--fg-muted`, `--accent-fg`, `--ok`, `--danger`, `--warn`, `--rec` |
| Accent | `#2456d3` (dark `#7aa2ff`) | same | `#0b57d0` (dark `#8ab4f8`) |
| Pass, fail, other | `#1d7a43`, `#c62f2a`, `#946200` | same | `#137333`, `#c5221f`, `#b06000`; Test Run green hard-coded `#188038` |
| Dark values | — | drift by a few units from the console's | different palette |
| Body text | 14px | 13px | 13px |
| Labels | 12px `--muted` above the field | 11.5px muted | weight 600 in text colour |
| Control corners | 6px | 8px | 6px |
| Default button | white, hover fills | white, hover fills | grey fill, hover darkens the border |
| Text on primary | `--accent-text` (dark: near-black) | `#fff` (about 2.5:1 in dark mode) | `--accent-fg` |
| Status | ✓ ✗ – ○ with colour | colour only on the status buttons and pill | ✓ ✗ ! on setup checks; emoji in the verification options |
| Messages | coloured text: green, or red for errors (3.2 s, errors 7 s) | inline flash on a tinted box (3 s / 6 s) | notices that stay; `alert()` |
| Confirming | popup (see DESIGN.md) | inline Delete / Keep | `confirm()` |
| Casing | sentence case | "Choose Workbook/Suite" | "Update Issue", "Report Issue" (title), "Env Prefix", "Initial Status" |
| Focus | `:focus-visible` on every control | `:focus` on inputs only, not `select` | `:focus` on inputs and selects |
| Reduced motion | not handled | — | handled |

## Step 1: fix the console first

The console is the reference, so its own gaps go first (listed in [DESIGN.md › Known gaps](../DESIGN.md#known-gaps)). Done: the browser `confirm()` boxes, the emoji, the dark-mode red and text-only messages. Left:
- sentence case for "Generate New", "Download Existing", "Summary Report", "Complete Report";
- a `prefers-reduced-motion` rule for the pulsing dot.

## Step 2: one tokens file, copied into each extension

1. Move the console's `:root` blocks (light and dark) from `test-run-console/ui/styles.css` into `test-run-console/ui/tokens.css`. Load it before `styles.css` in `index.html` and `summary.html`, and add it to:
   - the `STATIC` list in `server.mjs` (the server only serves listed files);
   - `summaryPage()` in `server.mjs`, which inlines the CSS into the standalone summary export;
   - nothing in the Pages workflow (it already copies `ui/*.css`).
2. Copy it to `test-run-console/extension/styles/tokens.css` and `bug-reporter/extension/styles/tokens.css`. Unpacked extensions can only load files inside their own folder, so they need copies.
3. Add a check that fails when a copy differs from the console's: a test in `test-run-console/test/` for the extension copy, and one in `bug-reporter/test/` that compares its copy with `../test-run-console/ui/tokens.css` when that file exists (Bug Reporter is used without the console too, so the check skips when it isn't there).

## Step 3: Test Run Extension

Files: `test-run-console/extension/popup/popup.css`, `popup/popup.js`, `recorder/recorder.html`, `recorder/recorder.js`.

1. Load `styles/tokens.css` and delete the extension's own `:root` blocks. Where the popup used `--bg` for its background, use `--surface`.
2. Status buttons and the status pill show the symbol: "✓ Pass", "✗ Fail", "– NA (Skipped)" (use the same symbols as the console's `SYM`).
3. A chosen status is filled with the status colour, with `--surface` text, like the console's `.sbtn.on`.
4. Primary buttons use `--accent-text`, not `#fff`.
5. Replace the inline red style on the Delete confirm with a `danger-fill` class.
6. Controls: 6px corners, 30px minimum height, `:focus-visible` on buttons, inputs, selects and text areas.
7. Body 14px where the popup has room; labels 12px `--muted`. `.muted` and `.faint` set colour only, not size.
8. Messages: keep them inline in the popup (a floating message would cover the buttons in a 360px window), as coloured text like the console's (green, or red for errors, no tinted box), with the console's timings: 3.2 s, errors 7 s.
9. Casing: "Choose workbook/suite".
10. Recorder badge colours from the tokens (`--fail` for REC, `--other` for paused) instead of hex values.

## Step 4: Bug Reporter

Files: `bug-reporter/extension/styles/common.css`, `popup/popup.css`, `report/report.css`, `options/options.css`, `recorder/recorder.css`, and the HTML and JS that set colours or labels.

1. Load `styles/tokens.css` and map Bug Reporter's tokens onto the console's, then remove its own `:root` blocks:

   | Bug Reporter | Becomes |
   |---|---|
   | `--bg` | `--surface` |
   | `--bg-soft` | `--bg` |
   | `--bg-sunk` | `--surface-2` |
   | `--fg` / `--fg-muted` | `--text` / `--muted` |
   | `--accent`, `--accent-fg`, `--accent-soft` | `--accent`, `--accent-text`, `--accent-weak` |
   | `--ok` / `--ok-soft` | `--pass` / `--pass-bg` |
   | `--danger` / `--danger-soft` | `--fail` / `--fail-bg` |
   | `--warn` / `--warn-soft` | `--other` / `--other-bg` |
   | `--rec` | `--fail` |

2. **Keep one extra token** for Track localizations, which uses purple to stand apart from pass and fail: add `--loc` and `--loc-bg` (light and dark) to the tokens file, so the console knows about it too. Replace the hard-coded `#7e22ce`, `#f3e8ff`, `#2e1f3d` and `#c4a1f0`.
3. Replace the other hard-coded and undefined colours: `#188038` (Test Run green) → `--pass`; `#b06000`, `#b3261e` → `--other`, `--fail`; `var(--muted, #888)`, `var(--bad, …)`, `var(--tr-accent, …)` → real tokens.
4. Buttons: default buttons white (`--surface`) with a `--surface-2` hover; `danger-fill` (with `--fail-fill`) for destructive confirms; 6px corners.
5. Fields: labels 12px `--muted` above the field, like the console.
6. Settings tables: upper-case 11.5px headers on `--surface-2`, like the console's tables.
7. Replace `alert()` and `confirm()` (in `report/report.js` and `options/options.js`) with a popup following DESIGN.md's pattern (560px, buttons right-aligned, Escape cancels), like the console's `askConfirm()`. A small shared helper in `bug-reporter/extension/lib/` keeps it in one place.
8. Result messages (the `.notice` blocks) that report a finished action become coloured text like the console's; notices that must stay on screen (a setup problem, say) stay as banners.
9. Replace emoji with the guide's symbols: 📸 on Snapshot, ✅ ❌ ⚠️ in the verification options.
10. Sentence case: "Report issue" (page title and button), "Update issue", "Env prefix", "Initial status".
11. Settings tabs: set `aria-selected` on the open tab.
12. Keep Bug Reporter's own icon and name: it's a separate product. It shares the palette, components and writing rules, not the brand.

## Step 5: check and ship

- Run each product's tests: `cd test-run-console && npm test` (includes the extension, and the browser tests when Playwright is found), `cd bug-reporter && npm test`.
- Take before-and-after screenshots of every screen of both extensions, in light and dark mode, and compare them side by side.
- Check contrast of any new colour pair: 4.5:1 for text, 3:1 for borders and focus rings.
- Bug Reporter users will notice the new colours: mention it in the commit and the README's "What's new" note.

## Order and size

| Step | Size | Depends on |
|---|---|---|
| 1. Console gaps | small | — |
| 2. Tokens file and copies | small | 1 |
| 3. Test Run Extension | medium | 2 |
| 4. Bug Reporter | medium to large (most screens) | 2 |
| 5. Check and ship | small per product | 3, 4 |

Steps 3 and 4 touch different folders and can be done separately.
