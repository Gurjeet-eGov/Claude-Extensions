// Missing-localization rules: find raw localization keys / codes shown on a page
// instead of translated text. Loaded as a content script (defines globalThis.EgovLocRules)
// and by the service worker / unit tests through the same global.
//
// Rule 1 (raw key, matches anywhere):   \b[A-Z][A-Z0-9&]+(?:_[A-Za-z0-9&]+)+\b
//   CS_COMMON_SUBMIT, DSS_W&S_TOTAL_COLLECTION, "DSS_TB_PT (In Lac)" -> DSS_TB_PT,
//   "Azad Nagar - WARD_1" -> WARD_1, DSS_TB_City
// Rule 2 (raw tenant code, whole string): ^[a-z]{2}(?:\.[a-z0-9_]+)+$
//   pb.testing, pb.amritsar, ke.bomet
// Not flagged: arrow_drop_down, Azad_Nagar, A_B, e.g., Rs.100, emails, URLs, numbers,
// dates, PGR-2026-11-16-001234, SUBMIT, plain English.
(function (root) {
  const KEY = /\b[A-Z][A-Z0-9&]+(?:_[A-Za-z0-9&]+)+\b/g;
  const TENANT = /^[a-z]{2}(?:\.[a-z0-9_]+)+$/;

  /** Splits a block of page text into strings on newlines and tabs (spaces don't split). */
  function splitText(raw) {
    return String(raw || '')
      .split(/[\n\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** The raw codes in one string: every Rule 1 key, or the string itself for Rule 2. */
  function findCodes(str) {
    const s = String(str || '').trim();
    if (!s) return [];
    const out = [];
    for (const m of s.matchAll(KEY)) out.push(m[0]);
    if (TENANT.test(s)) out.push(s);
    return out;
  }

  /** All raw codes in a block of text (split first, as the rules describe). */
  function findCodesInText(raw) {
    const out = [];
    for (const part of splitText(raw)) out.push(...findCodes(part));
    return out;
  }

  /** "https://bgrm.bomet.go.ke/digit-ui/employee/pgr/inbox-v2?x=1#y" -> "digit-ui/employee/pgr/inbox-v2" */
  function pagePath(url) {
    try {
      const p = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
      return p || '/';
    } catch {
      return '/';
    }
  }

  /** "bgrm.bomet.go.ke" -> "bgrm_bomet_go_ke" */
  function fileBaseForHost(host) {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
    return h.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'localizations';
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * CSV with columns Code, Page, sorted by page then code. Starts with a UTF-8 BOM so
   * Excel on Windows/Mac and LibreOffice on Ubuntu all open it with the right encoding.
   */
  function toCsv(rows) {
    const sorted = [...rows].sort((a, b) => (a.page === b.page ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.page < b.page ? -1 : 1));
    const lines = ['Code,Page', ...sorted.map((r) => `${csvCell(r.code)},${csvCell(r.page)}`)];
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  root.EgovLocRules = { KEY, TENANT, splitText, findCodes, findCodesInText, pagePath, fileBaseForHost, toCsv };
})(globalThis);
