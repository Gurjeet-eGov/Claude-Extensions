# Design guide

How the interfaces in this repo look, read and behave. It's written down from what **Test Run's console** does today, so anything new (a screen, a feature, an extension page) looks and works like what's already there.

- **The reference:** the Test Run console's UI, [`test-run-console/ui/styles.css`](test-run-console/ui/styles.css), [`shared.js`](test-run-console/ui/shared.js) and [`client.js`](test-run-console/ui/client.js). If this guide and the console disagree, the console wins and this guide gets fixed.
- **Applies to:** the console, Test Run Extension ([`test-run-console/extension/`](test-run-console/extension/)) and Bug Reporter ([`bug-reporter/extension/`](bug-reporter/extension/)). The two extensions don't fully follow it yet; [docs/design-alignment.md](docs/design-alignment.md) is the plan to bring them in line.
- **The DIGIT Design System** was tried out separately and hasn't been adopted. Until that's decided, this guide is the design for this repo. (Claude's `digit-design` skill reads a project's DESIGN.md first, so it follows this file here.)

## Principles

1. **Colour and a symbol, together.** A status is never shown by colour alone: ✓ pass, ✗ fail, – other, ○ not run. People with colour-blindness, and anyone printing in black and white, can still read it.
2. **Keyboard first for repeated work.** Marking a result is one key (P, F, N), moving is J and K, and undo is U. Anything done many times a day has a key; every control is reachable with Tab and shows a focus ring.
3. **One obvious next step.** Each view has at most one primary (blue) button. After an action, Test Run moves you on (marking a result opens the next case).
4. **Plain words.** Sentence case, second person, short. Messages say what happened and what to do next.
5. **Calm and dense.** It's a work tool used all day: small type, tight spacing, light borders, very little shadow, no decoration.
6. **Follows the computer's light or dark setting.** Every colour is a token with a light and a dark value.
7. **No build step, no dependencies in the page.** Plain HTML, CSS and JavaScript; Unicode symbols instead of an icon font; the system font.

## Colour tokens

Every colour comes from these tokens (the `:root` block at the top of `styles.css`). Don't write a colour value anywhere else.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#f5f6f8` | `#121417` | Page background |
| `--surface` | `#ffffff` | `#1a1d21` | Cards, top bar, inputs, buttons |
| `--surface-2` | `#f0f2f5` | `#22262b` | Hover, table headers, quiet boxes |
| `--border` | `#e1e4e8` | `#2e3339` | Card and table lines |
| `--border-strong` | `#c9ced6` | `#3d434a` | Control borders (buttons, inputs, chips) |
| `--text` | `#1b1f24` | `#e6e8eb` | Body text |
| `--muted` | `#5d636b` | `#a2a8b0` | Labels, secondary text |
| `--faint` | `#8a9099` | `#7b828b` | Hints, placeholders, upper-case micro labels (non-essential only) |
| `--accent` | `#2456d3` | `#7aa2ff` | Primary buttons, links, selected things, focus ring |
| `--accent-weak` | `#e9eefc` | `#1f2b47` | Selected backgrounds (chips, a selected case) |
| `--accent-text` | `#ffffff` | `#0d1220` | Text on `--accent` |
| `--pass` / `--pass-bg` | `#1d7a43` / `#e2f3e8` | `#5cc98a` / `#173323` | Pass ✓, success text |
| `--pass-fill` / `--on-pass-fill` | `#1d7a43` / `#ffffff` | `#238636` / `#ffffff` | Green messages at the bottom: a fill deep enough for white text in both modes |
| `--fail` / `--fail-bg` | `#c62f2a` / `#fbe6e5` | `#ff7b72` / `#3d1a19` | Fail ✗, error text, delete |
| `--fail-fill` / `--on-fail-fill` | `#c62f2a` / `#ffffff` | `#da3633` / `#ffffff` | Red buttons (`danger-fill`) and red messages at the bottom: a fill deep enough for white text in both modes |
| `--other` / `--other-bg` | `#946200` / `#fbf0d9` | `#e3b341` / `#36290e` | NA and other results –, warnings |
| `--none` / `--none-bg` | `#98a0a8` / `#eceff2` | `#6e7681` / `#262a30` | Not run ○, retired ⊘ |

Other tokens: `--radius: 8px`; `--shadow` (a soft two-layer card shadow, none in dark mode); `--font` (the system font stack: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`); `--mono` (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`).

Rules:
- **Text on a coloured fill** uses the matching "on" colour, never a hard-coded `#fff`: `--accent-text` on `--accent`, `--on-pass-fill` on `--pass-fill`, `--on-fail-fill` on `--fail-fill`, `--surface` on a status button. Text on any fill stays at 4.5:1 or more in both modes.
- **Tints** for hover on coloured buttons are mixed from tokens (`color-mix(in srgb, var(--fail) 8%, var(--surface))`), not new values.
- **Contrast:** body text at least 4.5:1; borders and focus rings at least 3:1. `--faint` is only for text people can do without.

## Type

One family (the system font), one monospace family.

| Use | Size | Weight |
|---|---|---|
| Body | 14px, line height 1.45 | 400 |
| Controls (buttons, inputs, tables) | 13px | 400; primary and danger buttons 600 |
| `h1` (Summary title) | 22px | 650 |
| `h2` (section) | 16px | 650 |
| `h3` (card, empty state) | 14px | 650 |
| Labels above fields, `.small` | 12px, `--muted` | 400 |
| Micro labels (table headers, field names in a case, rail titles) | 11–11.5px, upper case, letter-spaced .03–.05em | 700 |
| Pills, counts | 11px | 650–700 |
| Case IDs, file names, paths | 12–12.5px `--mono` | 400 |
| KPI figures | 26px, tabular numbers | 750 |

Numbers that line up (tables, KPIs) use tabular figures, and table number columns are right-aligned (`.num`).

## Space, corners, depth, focus

- **Spacing** uses small steps: 2, 4, 6, 8, 10, 12, 14, 16, 18px. Cards are padded `14px 16px`; gaps between cards 14px; controls in a row 8px apart.
- **Corners:** 6px on buttons and inputs; 8px (`--radius`) on cards, banners and items; 10px on popups and pills; 999px on the pill-shaped suite tabs and user button.
- **Depth:** cards have `--shadow`. Only things that float get a stronger shadow: popups, menus, toasts and the "ready" bubble.
- **Focus:** `:focus-visible` gives a 2px `--accent` outline, offset 1px, on buttons, inputs, selects, text areas and cases. Boxed pickers (workbook, cycle) put one ring on the box instead of on the select inside.

## Layout

- **Top bar** (sticky, `--surface`): the brand mark (a 26px square, half `--pass` and half `--accent`, split on the diagonal) and "Test Run", the **Workbook** dropdown and the user menu (Import is in Setup › Workbook, Download in Summary). Under it, the screen tabs (Run, Known issues, Findings, Summary, Setup) as underlined tabs, and on Run the context row (suite tabs as pills, the **Test cycle** dropdown, progress).
- **Page width:** content up to 1180px; screens with a filter column up to 1720px, with a 230px sticky rail on the left.
- **Breakpoints:** 900px (the rail stacks above the content), 760px (tighter padding; case details in one column; the case ID column hides), 360px (case badges hide).
- **Print:** navigation, toasts and pickers are hidden; cards lose their shadow.

## Components

### Buttons

| Kind | Looks like | When |
|---|---|---|
| Default | `--surface`, `--accent` border and text, weight 600; hover fills `--accent-weak` | Most actions |
| Primary (`.primary`) | `--accent` fill, `--accent-text`, weight 600 | The one main action of a view or popup |
| Ghost (`.ghost`) | Same as default (blue outline and text) | Cancel, Back, secondary actions next to a primary |
| Round icon (`.help-btn`) | A 26px circle, 1.5px `--accent` border, `--accent` symbol, weight 700; hover fills `--accent-weak` | **?** (keyboard shortcuts), and expand/collapse all: two chevrons stacked, pointing in while something is open (a click collapses all), pointing out once all are closed (a click expands all) |
| Link (`.linkish`, `.link-btn`) | Accent text, no box | Inline actions inside text |
| Danger (`.danger`) | Red text only | A destructive action in a list of tools |
| Danger outline (`.danger-outline`) | Red border and text | A destructive action on a page, such as Delete workbook |
| Danger fill (`.danger-fill`) | `--fail-fill` with `--on-fail-fill` text, weight 600; hover darkens | The confirm button of a destructive popup only |
| Small (`.small-btn`) | 12px, 26px high | Secondary actions next to content |
| Status (`.sbtn`) | Status-coloured border and text, 36px high; when chosen, filled with the status colour | Pass, Fail, NA on a case |

Sizes: 30px high by default, 13px text, padding `5px 11px`. Disabled is 50% opacity with a not-allowed cursor.

**Every clickable button and every dropdown field has the blue outline** (`--accent`), with blue text on buttons. Inside a dropdown field the text and the arrow keep their own colours. Exceptions: destructive buttons stay red; status buttons keep their status colour; text fields (search, comment, link) keep the grey `--border-strong`.

**Cancel and Save side by side are the same size** (at least 84px wide, text centred), wherever a button sits next to the primary one in a form.

**A row of tools** (`.case-tools`: ✎ Edit, ⧉ Mark Duplicate, ↺ Clear Status, ⊘ Deprecated) is a grid of buttons of the same size: four in a row, two by two when the column is narrow.

### Status

- **Symbols:** ✓ pass, ✗ fail, – other (NA, Skipped, Blocked…), ○ not run, ⊘ retired. Defined once in `shared.js` (`SYM`, `CLS_LABEL`); use those, don't retype them.
- **Shapes:** `.dot` (a 20px circle with the symbol; not run is a hollow ring), `.pill` (11px, tinted), `.bar` (8px progress bar in pass, fail and other segments over `--none-bg`), `.legend` (symbol, count and word).
- **Status buttons** show the symbol and the value: "✓ Pass". The keys are listed under **?**, not on the buttons.
- **Automation badges** on cases: "Auto ✓", "Auto ✗", "Auto –".

### Fields

- Inputs and selects: `--surface`, `--border-strong` border, 6px corners, 30px high, 13px text.
- Labels sit above the field, 12px `--muted`. Checkboxes use `label.check` (inline, `--text`).
- On a case, a note field's name is bold in `--text` with what follows in normal weight (`label.note-label`): **Issue link** (optional), **Comment** (optional).
- Selects have the `--accent` border, like buttons.
- A select still on its placeholder shows `--faint` text (`select.choose`).
- Help goes under the field in `.small`/`.muted`; errors are a `.note.bad` or a toast, worded as what to do.

### Dropdowns

The model is **Run › Test Type**; `dropdown()` in `client.js` draws every one.

- **Multiple choice:** a list of checkboxes. The field reads **Select** while nothing is ticked and **4 Selected** once four are. The ticked options show under the field as tags, each with a ✕. In a filter, nothing ticked means all.
- **Single choice:** the same field and list, minus the tags. The field reads the option chosen (**Select** before one is chosen).
- **Options** are rows of 13px text, 6px 8px padding (about 30px high), tinted `--accent-weak` on hover; the chosen one is tinted with `--accent` text.
- **Long lists** (more than 8 options) get a search box at the top, which stays put: only the options below it scroll, at most 240px high.
- **Where a new value is allowed** (Feature, Sub feature, Test type, Area) the search box is always there, however short the list: typing a value that isn't in it offers **Use “…”**.
- **The list is as wide as its field**, never wider; long options wrap. Give the field the width its options need (the Workbook picker is 340px, "Already covered by case" 520px).
- **With its name inside** (the top bar's **Workbook** and **Test cycle**, a form's **Test suite**): the name in 12px bold `--accent` before the value.
- The list opens over what's below it, tags included. It is never cut off by the card or the scrolling column around it. A click outside or Escape closes it; Enter in the search box takes the first match.
- Not for text that is typed freely; that is an input.

### Chips, tabs and toggles

- **Single-choice filter list** (`.chip`; Run › Test Status, Known issues › Show): stacked full-width pills, the label on the left and the count on the right, all with the blue outline. The one chosen is filled `--accent-weak` with `--accent` text (`aria-pressed`). Order: All first, then the narrower ones (To do, Failed, Deprecated).
- **Issue fields** (a case's Issue link, a new test case's Issue link): paste a link and press Enter, and it becomes a tag under the field; the field empties for the next one. An issue tag shows **the issue number only** (`#65 ↗`, `CCRS-12 ↗`), a link to the issue, with its title on hover and a ✕ to remove it.
- **Tags** (`.filter-tag`, `.issue-chip`): pill-shaped, `--accent-weak` fill for a choice made in a dropdown, a 20px round ✕ at the end that removes it (hover tints it). **Clickable text inside a tag is blue** (`--accent`), as an issue link on a case is.
- **Screen tabs** (`.nav`): underlined; `aria-current="page"` on the open one.
- **Suite tabs** (`.ctx-tab`): pill buttons; the open one is filled `--accent`.
- **Segmented toggle** (`.seg`): joined buttons, `aria-pressed`; chosen is `--accent-weak`.
- **Setup parts** (`.subtab`): full-width buttons with a › chevron; `aria-selected`.

### Cards, banners and notes

- **Card** (`.card`, `.card-pad`): `--surface`, `--border`, `--radius`, `--shadow`.
- **Banner** (`.banner`): a card with a 4px left border, accent by default, `.warn` (other) or `.bad` (fail). For a message that stays on screen: "View only.", "This workbook is open in Excel.", "This cannot be undone."
- **Note** (`.note`, `.info`, `.bad`): a small tinted line inside a form or card.

### Tables

Full width, 13px cells padded `7px 10px`, a bottom border per row. Headers are 11.5px upper case `--muted` on `--surface-2`. Number columns are right-aligned with tabular figures. An empty table says "No data available".

**A link in a table** (an issue in Known issues): monospace, `--accent`, followed by ↗, opens in a new tab: `#2835 ↗`. Links to a place inside Test Run (a test case) are `--accent` monospace buttons (`.linkish`) without the arrow.

### Messages

Two kinds, by where they appear:

**At the bottom of the page** (toasts, `TR.toast()` in `shared.js`), for news after an action:
- Bottom centre, stacked, `aria-live="polite"`; `role="alert"` for errors.
- **Filled:** `--pass-fill` (green) when something worked, `--fail-fill` (red) for an error, with white text (`--on-pass-fill`, `--on-fail-fill`), 13px, weight 500; 8px corners, a soft shadow; up to 640px wide.
- **ⓘ first:** an info icon (a circle with an i, inline SVG, 18px) at the start, for green and red alike.
- **✕ last:** after a gap, a white ✕ in a 28px square that closes the message straight away (`aria-label="Close this message"`). Hovering darkens the square slightly (`rgba(0, 0, 0, .18)` over the fill).
- They close themselves after **5 seconds**, green and red alike.
- **At most 3** at once (the oldest goes); a message already showing isn't shown twice, its 5 seconds start again.
- Examples: "Saved.", "Admin link removed.", "Couldn't save: the workbook is open in Excel." Anything the person must act on later doesn't go in a message.

**Right under a button or a field**, for a short warning or success about that control: **coloured text only**, no box: `--fail` for a problem (`.bad-text`), `--pass` for success, as in setup checks (`.check-line`). Example: "Invalid username or password." under the password field.

### The "ready" bubble

Bottom right, stays until closed: used when something finished in the background and has a link to follow (the Complete Report download). A toast would vanish before it's used.

### Forms that open in a page

Add issue, Add finding, New test case, Create test case, Already covered, + Add and Edit open a form in the page (a card, or a box under a case).
- **One at a time.** Opening one closes any other, and what was typed in it is dropped.
- **Leaving the page closes it**, dropping what was typed. Only a comment or link typed on a case is kept.
- **Width:** a short form (one or two fields, such as New issue) keeps its fields to about 680px instead of the card's full width; the card keeps its width.
- **Buttons** at the bottom right: Cancel, then Save, the same size.

### Popups

- `openModal()` in `client.js`: a dimmed overlay (`rgba(10, 12, 16, .45)`), a box up to 760px wide, 10px corners, 18px padding, `role="dialog"`, `aria-modal`, focus on the first button. Escape or a click outside closes it.
- **Questions** (`askConfirm()` in `client.js`) are always 560px wide (`.modal-box.confirm`), with the buttons right-aligned on one row (`.modal-actions`). Never the browser's own `confirm()` or `alert()`.
- **Asking before an action** follows one pattern:
  1. a question as the heading, naming the thing in curly quotes: Delete “CMS Sign Off”?
  2. a `.banner.bad` saying "This cannot be undone." (or a `.banner.warn` when it can be recovered);
  3. a short list (`.modal-list`) of what happens;
  4. Cancel, then the action button on the right, named after the action ("Delete workbook", "Remove cycle"): `danger-fill` when it deletes or replaces something, `primary` otherwise. An in-between choice goes between them ("Get their copy first").
  5. Escape or a click outside counts as Cancel.

### Menus

- **Download menu** (`.dl-menu`): `role="menu"`, 300px; each item a bold title over a 12px `--muted` line saying what you get.
- **User menu**: opens on hover or focus; name, role, then actions.

### Empty and loading states

- **Empty** (`.empty`): centred, an `h3` saying what's empty and a line saying what to do, often with the one button that fixes it. Example: "Nothing matches" / "Clear the search, or pick another filter on the left."
- **Loading** (`.loading`): text with an ellipsis, "Loading the workbook…". A pending result pulses (`.dot.pending`).
- **Waiting on an outside service** (GitHub, in Known issues): the table greys out (`.spin-wrap.busy`: 40% opacity, no clicks) under a 34px `--accent` spinner (`.spinner`) in its middle. On the page's first load the spinner shows alone. Not for anything Test Run does itself.

### Icons

Unicode symbols, not an icon font or images: ✓ ✗ – ○ ⊘ (status), ✎ edit, ⧉ duplicate, ⤒ import, ⤓ download, ▾ menu, ✕ close, ↗ opens elsewhere, › more. No emoji.

## Writing

- **Sentence case** for text, labels and headings.
- **Button labels in Title Case** (DIGIT's rule), as in the case tools: "Save Comment", "Mark Duplicate", "Clear Status". One word where it is clear: "Save", "+ Add". Older sentence-case buttons are listed under Known gaps.
- **Buttons say what they do**, as a verb: "Publish now", not "OK".
- **"+ "** starts a label that adds something: "+ Add issue", "+ New test case".
- **"…"** ends a label that asks for more before acting: "Duplicate of…", "Already covered…". It also marks work in progress: "Saving…".
- **Tool labels** carry their symbol: "✎ Edit", "⧉ Mark Duplicate", "↺ Clear Status", "⊘ Deprecated".
- **Messages** say what happened and what to do, with no "Error:" prefix: "Test Run is not answering. Is it still running in the terminal?", "View only: you need edit access to mark results."
- **Separators:** "·" between items on a line ("Priya · 20 Nov"); "–" for an empty value; curly quotes around names.
- **Toasts** are full sentences with a full stop.

## Accessibility checklist

- Every control works with the keyboard and shows the focus ring.
- Icon-only buttons have an `aria-label`; status symbols have text next to them or a label.
- Popups set `role="dialog"` and `aria-modal`, and put focus inside.
- Messages are announced (`aria-live`); errors use `role="alert"`; the ✕ on a message has an `aria-label`.
- Text contrast is at least 4.5:1 in light and dark; status is never colour alone.

## Extensions

The extensions use the same tokens, type and components, sized for their windows:
- **Popups** are 360px wide; the **recorder window** is 440px.
- Unpacked extensions can only load files inside their own folder, so each extension keeps a copy of the tokens; the copies must match the console's.
- An extension has its own icon, but the same palette, button styles, status symbols and writing rules.

## Known gaps

Places where the code doesn't follow this guide yet. Don't copy them; fix them when you're nearby.

| Where | Gap |
|---|---|
| Console | Sentence-case buttons from before the Title Case rule: "Restore to the run", "Start new cycle", "Refresh from GitHub" and others |
| Console | Selects that are still the browser's own instead of `dropdown()`: Setup (a tab's role, Columns, Media, Team) |
| Console | Import sits in Setup › Workbook for now (it left the top bar); its place is still to be decided |
| Console | No `prefers-reduced-motion` rule for the pulsing dot |
| Test Run Extension, Bug Reporter | See [docs/design-alignment.md](docs/design-alignment.md) |
