# Track Localizations

Find every place a web app shows a **raw localization key** (for example `CS_COMMON_SUBMIT`) instead of translated text. Do this while you test normally. You get a CSV listing each key and the page it appeared on, so whoever fixes localizations can work through it.

You need the extension installed (see the [setup guide](SETUP.md)). The local helper and Claude aren't needed for this feature.

---

## Quick start

1. Open the web app you're testing in Chrome.
2. Click the Bug Reporter icon in the toolbar, then **Track localizations**.
   - If the site isn't enabled yet, Chrome asks for permission once. Click **Allow**.
   - The toolbar badge shows **LOC** while tracking is on (a recording's **REC** badge takes priority).
3. Work through your workflows as usual: open pages, dropdowns, tables, tabs, modals. Use as many tabs of the same site as you like. You can record a video at the same time.
4. When you're done, click **■ Stop & save list**. Chrome's **Save as** dialog opens, so you pick the folder.

While tracking, the popup shows a live count, e.g. *Tracking localizations · 11 codes on 2 pages*.
- **Save so far:** saves the list without stopping.
- **Save again:** appears after you stop, if you need another copy.

---

## The file

- **One CSV per website**, named after its address: `https://bgrm.bomet.go.ke/…` gives **`bgrm_bomet_go_ke.csv`**.
- **Columns:**

  | Code | Page |
  |---|---|
  | `CS_COMMON_SUBMIT` | `digit-ui/employee/pgr/inbox-v2` |
  | `WARD_1` | `digit-ui/employee/pgr/inbox-v2` |
  | `ke.bomet` | `digit-ui/employee/pgr/complaint-details/PGR-2026-11-16-001234` |

  - **Code:** the untranslated key or code found on screen.
  - **Page:** the page's path, without the domain, `?query` or `#fragment`.
- **Each Code + Page pair appears once**, however many times you saw it. Rows are sorted by page, then code.
- **CSV (UTF-8)** opens directly in Excel, Numbers, Google Sheets and LibreOffice, on Mac, Windows and Ubuntu.

> Pages that include an ID in their address (like a complaint-details page) count as a separate page for each ID. The same missing key can therefore appear once per record you opened.

---

## What counts as a missing localization

A piece of text is reported when either rule matches.

**Rule 1: raw key, anywhere in the text**

```regex
\b[A-Z][A-Z0-9&]+(?:_[A-Za-z0-9&]+)+\b
```

| Text on page | Reported code |
|---|---|
| `CS_COMMON_SUBMIT` | `CS_COMMON_SUBMIT` |
| `DSS_W&S_TOTAL_COLLECTION` | `DSS_W&S_TOTAL_COLLECTION` |
| `DSS_TB_PT (In Lac)` | `DSS_TB_PT` |
| `DSS_FROM Apr, 01 2026 DSS_TO Aug, 04 2026` | `DSS_FROM`, `DSS_TO` |
| `Azad Nagar - WARD_1` | `WARD_1` |
| `DSS_TB_City` | `DSS_TB_City` |

**Rule 2: raw tenant code, the whole text**

```regex
^[a-z]{2}(?:\.[a-z0-9_]+)+$
```

| Text on page | Reported code |
|---|---|
| `pb.testing`, `pb.amritsar`, `ke.bomet` | the same text |
| `Assigned to ke.bomet` | *(not reported: the tenant code isn't the whole text)* |

Text is split on line breaks and tabs before the rules are applied, but not on spaces.

**Not reported:**
- icon names (`arrow_drop_down`, `expand_more`) and `Azad_Nagar`, `A_B`
- `e.g.`, `Rs.100`, emails, web addresses, numbers, amounts, dates
- complaint numbers like `PGR-2026-11-16-001234`
- plain words, including uppercase words without an underscore (`SUBMIT`)

---

## What gets checked

**When tracking starts, and on every page load**, the whole page is checked, including parts that are in the page but hidden:
- a dropdown's options before you open it
- collapsed rows, inactive tabs, hidden panels

The visible text isn't the only thing checked. These are checked too:
- placeholder text in inputs
- tooltips (`title`) and screen-reader labels (`aria-label`, `alt`)
- button-style inputs
- the browser tab's title

**After that, anything that appears is checked the moment it appears:**
- custom dropdowns and menus that are built when you click
- expanded rows and drill-down tables
- modals, toasts and side panels
- rows that load later (lazy loading, pagination)
- the next page in single-page apps such as DIGIT, which change pages without reloading
- frames and web components on the same site

**What you still need to do:** content the app only fetches from the server when you click is found once you open it. Open the dropdowns, tabs and drill-downs you want covered.

---

## Long sessions and storage

- **Only unique pairs are kept:** one row per unique *Code + Page* pair, a few dozen bytes each. Page text, screenshots and history are never stored, so a full day of testing stays tiny.
- **Where it's stored:** in the extension's own storage (IndexedDB) on your computer. Nothing is sent anywhere.
- **Tracking keeps going** through page reloads, closed tabs and Chrome restarts, until you click **Stop & save list**.
- **Starting a new list** replaces the previous one. If the previous list wasn't saved, you're asked first.
- **Safety stop:** at 100,000 rows; a normal session is far below that.

---

## Tips

- Track one environment per session, so each file covers one site. If you visit several enabled sites, you get one file per site.
- Switch the app's language first (e.g. to Kiswahili) to find keys missing in that locale's translations.
- Use **Save so far** before a long break, so you have a copy in case something goes wrong.

## Known limits

- A raw key **without an underscore** (e.g. `SUBMIT`) isn't caught, because it can't be told apart from a real uppercase label.
- **English text on a translated page** isn't caught; these rules only find raw keys and codes. For that, use a screenshot-based localization audit.
- Tenant codes are assumed to start with a **2-letter** prefix (`pb.`, `ke.`).
- Only sites you've enabled in the extension are tracked.

## Troubleshooting

| What you see | What to do |
|---|---|
| **Track localizations** is greyed out | Open your app's tab first. It doesn't work on `chrome://` pages or the Chrome Web Store. |
| The count stays at 0 on a page you know has keys | Reload the tab once. Also check that the site shows "Capturing APIs on …" in the popup. |
| Nothing is found in Incognito | Allow the extension in Incognito: `chrome://extensions` → eGov Bug Reporter → **Details** → **Allow in Incognito**. |
| The **Save as** dialog didn't appear | Click **Save again** in the popup. If Chrome is set to save downloads without asking, the file is in your Downloads folder. |
| Excel shows odd characters | Open the file with **File → Open** (or **Data → From Text/CSV**) rather than pasting it; the file is UTF-8. |

---

## For developers

| File | What it does |
|---|---|
| `extension/content/loc-rules.js` | The two rules, the text splitting, page path, file name and CSV format. Shared by the page script, the service worker and the tests. |
| `extension/content/loc-tracker.js` | Runs on enabled sites while tracking: full scan plus a MutationObserver, and sends only new pairs. |
| `extension/background/loc-tracking.js` | Start/stop, storage (IndexedDB store `locs`, one row per `host\|page\|code`), CSV export and save via `chrome.downloads` (Save as). |
| `test/loc.test.mjs` | The 33 documented cases, splitting, file name and CSV format. |
| `test/fixtures/loc-playground.html` | A test page with hidden options, a click-only menu, a late-loading row and an SPA page change. Served at `/digit-ui/employee/pgr/inbox-v2` by `node test/fixtures/server.mjs`. |
