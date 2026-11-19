// The sheet API that lib/sheet.js uses, on a real .xlsx workbook (exceljs).
// It must behave like dev/fake-sheets.mjs; test/server.test.mjs runs the same
// tests against both.
//
// What exceljs does not do and this file adds:
// - inserting rows or columns also moves data validations (dropdowns),
//   merged ranges and conditional-format ranges;
// - display text the way Sheets shows it (merged follower cells are empty,
//   dates as yyyy-mm-dd, formulas show their result);
// - a leading apostrophe means "text" and is not stored;
// - every write marks the workbook dirty so the host knows to save it.
import ExcelJS from 'exceljs';

export const CopyPasteType = {
  PASTE_NORMAL: 'PASTE_NORMAL',
  PASTE_FORMAT: 'PASTE_FORMAT',
  PASTE_DATA_VALIDATION: 'PASTE_DATA_VALIDATION',
};

export const DataValidationCriteria = {
  VALUE_IN_LIST: 'VALUE_IN_LIST',
  VALUE_IN_RANGE: 'VALUE_IN_RANGE',
  OTHER: 'OTHER',
};

const clone = (v) => (v == null ? v : structuredClone(v));
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numToCol(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseCell(a) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a).trim());
  return m ? { col: colToNum(m[1]), row: Number(m[2]) } : null;
}

const cellRef = (col, row) => `${numToCol(col)}${row}`;

/**
 * One address or range "A1" / "A1:C9" after `row` is deleted: rows below move up, a range
 * through it shrinks, and what was only on that row is gone (null). A range left one
 * cell big comes back as that cell ("C3").
 */
function dropRowRef(ref, row) {
  const cells = String(ref).split(':').map(parseCell);
  if (cells.some((c) => !c)) return ref;
  const top = Math.min(...cells.map((c) => c.row));
  const bottom = Math.max(...cells.map((c) => c.row));
  if (top === row && bottom === row) return null;
  const t = top > row ? top - 1 : top;
  const b = bottom >= row ? bottom - 1 : bottom;
  const left = Math.min(...cells.map((c) => c.col));
  const right = Math.max(...cells.map((c) => c.col));
  return t === b && left === right ? cellRef(left, t) : `${cellRef(left, t)}:${cellRef(right, b)}`;
}

/** Shift one address or range "A1" / "A1:C9" for an insert of n rows/cols after `after`. */
function shiftRef(ref, axis, after, n) {
  const parts = String(ref).split(':');
  const cells = parts.map(parseCell);
  if (cells.some((c) => !c)) return ref;
  const moved = cells.map((c) => {
    const v = axis === 'row' ? c.row : c.col;
    if (v <= after) return c;
    return axis === 'row' ? { ...c, row: c.row + n } : { ...c, col: c.col + n };
  });
  // A range that spans the insertion point grows (its end moves, its start does not).
  return moved.map((c) => cellRef(c.col, c.row)).join(':');
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

function parseList(formula) {
  const f = String(formula || '').trim();
  if (!/^".*"$/s.test(f)) return null;
  return f.slice(1, -1).split(',').map((s) => s.trim()).filter((s) => s);
}

class XValidation {
  constructor(model, book) {
    this.model = clone(model);
    this.book = book;
  }
  getCriteriaType() {
    if (this.model.type !== 'list') return DataValidationCriteria.OTHER;
    return parseList(this.model.formulae && this.model.formulae[0]) ? DataValidationCriteria.VALUE_IN_LIST : DataValidationCriteria.VALUE_IN_RANGE;
  }
  getCriteriaValues() {
    const f = this.model.formulae && this.model.formulae[0];
    const list = parseList(f);
    if (list) return [list, true];
    const book = this.book;
    return [{ getDisplayValues: () => (book ? book.resolveRange(f) : []) }, true];
  }
}

class ValidationBuilder {
  constructor() { this.values = []; this.allowInvalid = true; }
  requireValueInList(values) { this.values = values.map(String); return this; }
  setAllowInvalid(v) { this.allowInvalid = !!v; return this; }
  build() {
    return new XValidation({ type: 'list', allowBlank: true, showErrorMessage: !this.allowInvalid, formulae: [`"${this.values.join(',')}"`] });
  }
}

export const XSheetsApi = {
  CopyPasteType,
  DataValidationCriteria,
  newDataValidation: () => new ValidationBuilder(),
};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function formatDate(d) {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

function displayOf(v) {
  if (v == null) return '';
  if (v instanceof Date) return formatDate(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('formula' in v || 'sharedFormula' in v) return displayOf(v.result);
    if (v.text != null) return displayOf(v.text);
    if (v.error) return String(v.error);
    return '';
  }
  return String(v);
}

function linkOf(v) {
  if (!v || typeof v !== 'object') return '';
  if (typeof v.hyperlink === 'string' && /^https?:\/\//i.test(v.hyperlink)) return v.hyperlink;
  const m = /^\s*=?\s*HYPERLINK\(\s*"([^"]+)"/i.exec(String(v.formula || v.sharedFormula || ''));
  return m && /^https?:\/\//i.test(m[1]) ? m[1] : '';
}

function displayText(cell) {
  if (cell.isMerged && cell.master && cell.master !== cell) return '';
  return displayOf(cell.value);
}

function hasValue(cell) {
  return displayText(cell) !== '';
}

/** Write the way Sheets reads typed input: '' clears, a leading ' forces text, plain numbers become numbers. */
function writeValue(cell, v) {
  const s = v == null ? '' : String(v);
  if (s === '') cell.value = null;
  else if (s.startsWith("'")) cell.value = s.slice(1);
  else if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s)) cell.value = Number(s);
  else cell.value = s;
  // Text on several lines only shows as lines when the cell wraps.
  if (s.includes('\n') && !(cell.alignment && cell.alignment.wrapText)) {
    restyle(cell, (st) => { st.alignment = { ...(st.alignment || {}), wrapText: true }; });
  }
}

function restyle(cell, fn) {
  const st = clone(cell.style || {}) || {};
  fn(st);
  cell.style = st;
}

// ---------------------------------------------------------------------------
// Row heights
// ---------------------------------------------------------------------------
//
// A .xlsx file stores each row's height; it does not re-measure wrapped text
// when opened. Google Sheets in particular downloads every row at one line's
// height (15.75pt, marked custom), so a cell on several lines shows only its
// last line once the file is opened or uploaded again. fitRowHeights() grows
// each row to fit its wrapped text, measured with Arial-like character widths.
// It only ever makes rows taller, so rows someone sized by hand are kept.

// Arial advance widths in em, by character class.
function charEm(ch) {
  if (ch === ' ') return 0.278;
  if ('iljI.,:;\'|!'.includes(ch)) return 0.25;
  if ('ftr()[]-/'.includes(ch)) return 0.333;
  if ('mwMW@%'.includes(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.7;
  return 0.556;
}

function textPx(s, emPx) {
  let w = 0;
  for (const ch of s) w += charEm(ch) * emPx;
  return w;
}

/** How many lines a text takes in a column maxPx wide (greedy word wrap, like Sheets and Excel). */
export function wrappedLines(text, maxPx, emPx) {
  let lines = 0;
  for (const para of String(text).split(/\r?\n/)) {
    let n = 1;
    let used = 0;
    for (const word of para.split(/(?<= )/)) { // keep the trailing space with each word
      let w = textPx(word, emPx);
      if (used > 0 && used + textPx(word.trimEnd(), emPx) > maxPx) { n++; used = 0; }
      while (w > maxPx) { n++; w -= maxPx; } // a word longer than the column breaks anywhere
      used += w;
    }
    lines += n;
  }
  return lines;
}

/** Points of row height for a number of lines of text at a font size. */
const rowPt = (lines, sizePt) => Math.min(409, Math.ceil((lines * sizePt * 1.3 + 3) * 4) / 4);

/** Grow rows of one worksheet to fit their wrapped text. Returns how many rows changed. */
function fitWorksheet(ws) {
  const defaultWidth = (ws.properties && ws.properties.defaultColWidth) || 8.43;
  const defaultHeight = (ws.properties && ws.properties.defaultRowHeight) || 15;
  const colPx = new Map();
  const widthOf = (c) => {
    if (!colPx.has(c)) {
      const col = ws.getColumn(c);
      colPx.set(c, col.hidden ? 0 : Math.round((col.width || defaultWidth) * 7 + 5) - 6); // minus cell padding
    }
    return colPx.get(c);
  };
  let changed = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (row.hidden) return;
    let need = 0;
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (cell.isMerged) return;
      const text = displayText(cell);
      if (!text) return;
      const multi = text.includes('\n');
      if (multi && !(cell.alignment && cell.alignment.wrapText)) {
        restyle(cell, (st) => { st.alignment = { ...(st.alignment || {}), wrapText: true }; });
      }
      if (!multi && !(cell.alignment && cell.alignment.wrapText)) return; // overflows sideways, never taller
      const px = widthOf(c);
      if (px <= 0) return;
      const font = cell.font || {};
      const size = font.size || (font.name && font.name !== 'Calibri' ? 10 : 11);
      const emPx = size * (96 / 72) * (font.bold ? 1.07 : 1);
      const lines = wrappedLines(text.replace(/\s+$/, ''), px, emPx);
      if (lines > 1) need = Math.max(need, rowPt(lines, size));
    });
    const now = row.height || defaultHeight;
    if (need > now + 0.5) { row.height = need; changed++; }
  });
  return changed;
}

const argb = (hex) => `FF${String(hex).replace('#', '').toUpperCase()}`;

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

class XRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    if (!(row >= 1 && col >= 1 && numRows >= 1 && numCols >= 1)) throw new Error(`Invalid range ${row},${col},${numRows},${numCols}`);
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  get ws() { return this.sheet.ws; }
  cell(i, j) { return this.ws.getCell(this.row + i, this.col + j); }
  each(fn) {
    for (let i = 0; i < this.numRows; i++) for (let j = 0; j < this.numCols; j++) fn(this.cell(i, j), i, j);
  }
  write() { this.sheet.book.markDirty(); }

  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }

  getDisplayValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) line.push(displayText(this.cell(i, j)));
      out.push(line);
    }
    return out;
  }
  getValues() { return this.getDisplayValues(); }
  getValue() { return this.getDisplayValues()[0][0]; }

  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`setValues: data is ${values.length}x${values[0] && values[0].length}, range is ${this.numRows}x${this.numCols}`);
    }
    this.write();
    this.each((cell, i, j) => writeValue(cell, values[i][j]));
    return this;
  }
  setValue(v) {
    this.write();
    this.each((cell) => writeValue(cell, v));
    return this;
  }

  getDataValidations() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) {
        const m = this.cell(i, j).dataValidation;
        line.push(m ? new XValidation(m, this.sheet.book) : null);
      }
      out.push(line);
    }
    return out;
  }
  setDataValidation(rule) {
    this.write();
    this.each((cell) => {
      if (rule) cell.dataValidation = clone(rule.model);
      else delete this.ws.dataValidations.model[cell.address];
    });
    return this;
  }

  copyTo(dest, type) {
    this.write();
    dest.each((dcell, i, j) => {
      const scell = this.cell(i % this.numRows, j % this.numCols);
      if (type !== CopyPasteType.PASTE_DATA_VALIDATION) dcell.style = clone(scell.style || {});
      if (type !== CopyPasteType.PASTE_FORMAT) {
        const dv = scell.dataValidation;
        if (dv) dcell.dataValidation = clone(dv);
        else delete dest.ws.dataValidations.model[dcell.address];
      }
      if (type === CopyPasteType.PASTE_NORMAL || type == null) dcell.value = clone(scell.value);
    });
    return this;
  }

  // Formatting used by the summary tab.
  setFontWeight(w) { this.write(); this.each((c) => restyle(c, (s) => { s.font = { ...(s.font || {}), bold: w === 'bold' }; })); return this; }
  setFontFamily(f) { this.write(); this.each((c) => restyle(c, (s) => { s.font = { ...(s.font || {}), name: f }; })); return this; }
  setFontSize(n) { this.write(); this.each((c) => restyle(c, (s) => { s.font = { ...(s.font || {}), size: n }; })); return this; }
  setFontColor(hex) { this.write(); this.each((c) => restyle(c, (s) => { s.font = { ...(s.font || {}), color: { argb: argb(hex) } }; })); return this; }
  setFontStyle(st) { this.write(); this.each((c) => restyle(c, (s) => { s.font = { ...(s.font || {}), italic: st === 'italic' }; })); return this; }
  setBackground(hex) {
    this.write();
    this.each((c) => restyle(c, (s) => { s.fill = hex ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } } : undefined; }));
    return this;
  }
  setWrap(on) { this.write(); this.each((c) => restyle(c, (s) => { s.alignment = { ...(s.alignment || {}), wrapText: !!on }; })); return this; }
  setVerticalAlignment(v) { this.write(); this.each((c) => restyle(c, (s) => { s.alignment = { ...(s.alignment || {}), vertical: v === 'center' ? 'middle' : v }; })); return this; }
  setHorizontalAlignment(h) { this.write(); this.each((c) => restyle(c, (s) => { s.alignment = { ...(s.alignment || {}), horizontal: h }; })); return this; }
  setNumberFormat(f) { this.write(); this.each((c) => restyle(c, (s) => { s.numFmt = f; })); return this; }

  /** Each cell's hyperlink ('' when none): a link on the cell, or a =HYPERLINK("…") formula. */
  getLinkUrls() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) line.push(linkOf(this.cell(i, j).value));
      out.push(line);
    }
    return out;
  }
  /** Link every cell in the range to url, keeping its text ('' removes the link). Linked text is blue and underlined. */
  setLinkUrl(url) {
    this.write();
    const u = /^https?:\/\/\S+$/i.test(String(url || '')) ? String(url) : '';
    this.each((c) => {
      const text = displayText(c);
      if (u && text) c.value = { text, hyperlink: u };
      else c.value = text === '' ? null : text;
      restyle(c, (s) => {
        const font = { ...(s.font || {}) };
        delete font.underline;
        if (u && text) { font.underline = true; font.color = { argb: 'FF1155CC' }; } else if (font.color && font.color.argb === 'FF1155CC') delete font.color;
        s.font = font;
      });
    });
    return this;
  }
  // Font line, as Sheets names it: 'line-through' (strikethrough), 'underline' or 'none'.
  getFontLines() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) {
        const f = (this.cell(i, j).style || {}).font || {};
        line.push(f.strike ? 'line-through' : f.underline ? 'underline' : 'none');
      }
      out.push(line);
    }
    return out;
  }
  setFontLine(line) {
    this.write();
    this.each((c) => {
      const f = (c.style || {}).font || {};
      const strike = line === 'line-through';
      const underline = line === 'underline';
      if (!!f.strike === strike && !!f.underline === underline) return; // nothing to change: keep the style untouched
      restyle(c, (s) => {
        const font = { ...(s.font || {}) };
        delete font.strike;
        delete font.underline;
        if (strike) font.strike = true;
        if (underline) font.underline = true;
        s.font = font;
      });
    });
    return this;
  }
  setBorder(top, left, bottom, right, vertical, horizontal) {
    this.write();
    const thin = { style: 'thin', color: { argb: 'FF000000' } };
    const last = { r: this.numRows - 1, c: this.numCols - 1 };
    this.each((c, i, j) => restyle(c, (s) => {
      const b = { ...(s.border || {}) };
      if ((i === 0 && top) || (i > 0 && horizontal)) b.top = thin;
      if ((i === last.r && bottom) || (i < last.r && horizontal)) b.bottom = thin;
      if ((j === 0 && left) || (j > 0 && vertical)) b.left = thin;
      if ((j === last.c && right) || (j < last.c && vertical)) b.right = thin;
      s.border = b;
    }));
    return this;
  }
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

class XSheet {
  constructor(book, ws) {
    this.book = book;
    this.ws = ws;
  }
  getName() { return this.ws.name; }
  getSheetId() { return this.ws.id; }

  getLastRow() {
    let last = 0;
    this.ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n <= last) return;
      let any = false;
      row.eachCell({ includeEmpty: false }, (cell) => { if (!any && hasValue(cell)) any = true; });
      if (any) last = n;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, col) => { if (col > last && hasValue(cell)) last = col; });
    });
    return last;
  }
  getMaxRows() { return this.ws.rowCount; }
  getMaxColumns() { return this.ws.columnCount; }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') throw new Error('A1 notation is not supported');
    return new XRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }

  /** Move validations, merges and conditional formats for an insert of n rows/cols after `after`. */
  shiftExtras(axis, after, n) {
    const ws = this.ws;
    const dv = ws.dataValidations.model;
    const moved = {};
    for (const [addr, v] of Object.entries(dv)) {
      if (!v) continue;
      moved[parseCell(addr) ? shiftRef(addr, axis, after, n) : addr] = v;
    }
    ws.dataValidations.model = moved;
    for (const cf of ws.conditionalFormattings || []) {
      if (cf && cf.ref) cf.ref = String(cf.ref).split(/\s+/).map((r) => shiftRef(r, axis, after, n)).join(' ');
    }
  }

  takeMerges() {
    const ranges = Object.values(this.ws._merges || {}).map((r) => r.range || (r.model && `${cellRef(r.model.left, r.model.top)}:${cellRef(r.model.right, r.model.bottom)}`)).filter(Boolean);
    for (const r of ranges) this.ws.unMergeCells(r);
    return ranges;
  }

  insertColumnsAfter(col, n) {
    this.book.markDirty();
    const merges = this.takeMerges();
    this.ws.spliceColumns(col + 1, 0, ...Array.from({ length: n }, () => []));
    this.shiftExtras('col', col, n);
    for (const r of merges) this.ws.mergeCells(shiftRef(r, 'col', col, n));
    return this;
  }
  insertRowsAfter(row, n) {
    this.book.markDirty();
    const merges = this.takeMerges();
    this.ws.spliceRows(row + 1, 0, ...Array.from({ length: n }, () => []));
    this.shiftExtras('row', row, n);
    for (const r of merges) this.ws.mergeCells(shiftRef(r, 'row', row, n));
    return this;
  }
  /** Remove one row: what is below moves up with its dropdowns, merges and conditional formats. */
  deleteRow(row) {
    this.book.markDirty();
    const ws = this.ws;
    const merges = this.takeMerges();
    // A merge starting on this row (a Feature written once over several rows) keeps its
    // value on the row that takes its place.
    const carry = [];
    for (const r of merges) {
      const [a, b] = String(r).split(':').map(parseCell);
      if (a && b && a.row === row && b.row > row) carry.push({ col: a.col, value: ws.getCell(row, a.col).value });
    }
    ws.spliceRows(row, 1);
    for (const c of carry) {
      const cell = ws.getCell(row, c.col);
      if (cell.value == null || cell.value === '') cell.value = c.value;
    }
    const dv = ws.dataValidations.model;
    const moved = {};
    for (const [addr, v] of Object.entries(dv)) {
      const c = parseCell(addr);
      if (!v || (c && c.row === row)) continue;
      moved[c && c.row > row ? cellRef(c.col, c.row - 1) : addr] = v;
    }
    ws.dataValidations.model = moved;
    if (ws.conditionalFormattings) {
      for (const cf of ws.conditionalFormattings) {
        if (cf && cf.ref) cf.ref = String(cf.ref).split(/\s+/).map((r) => dropRowRef(r, row)).filter(Boolean).join(' ');
      }
      ws.conditionalFormattings = ws.conditionalFormattings.filter((cf) => !cf || cf.ref !== '');
    }
    for (const r of merges) {
      const m = dropRowRef(r, row);
      if (m && m.includes(':')) ws.mergeCells(m);
    }
    return this;
  }
  hideSheet() { this.book.markDirty(); this.ws.state = 'hidden'; return this; }
  showSheet() { this.book.markDirty(); this.ws.state = 'visible'; return this; }
  isSheetHidden() { return this.ws.state !== 'visible' && this.ws.state != null; }
  clear() {
    // Replace the worksheet: simplest way to drop values, styles, merges and validations.
    this.book.markDirty();
    const name = this.ws.name;
    this.book.wb.removeWorksheet(this.ws.id);
    this.ws = this.book.wb.addWorksheet(name);
    return this;
  }
  setColumnWidth(col, px) { this.book.markDirty(); this.ws.getColumn(col).width = Math.round((px / 7) * 100) / 100; return this; }
  setFrozenRows(n) { this.book.markDirty(); this.ws.views = [{ state: 'frozen', ySplit: n }]; return this; }
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

export class XBook {
  constructor(wb, name) {
    this.wb = wb;
    this.name = name;
    this.dirty = false;
    this.readOnly = false;
    this.sheets = new Map();
  }
  static async fromFile(file, name) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    return new XBook(wb, name);
  }
  static async fromBuffer(buf, name) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return new XBook(wb, name);
  }
  toBuffer() { return this.wb.xlsx.writeBuffer(); }
  /** Grow every row to fit its wrapped or multi-line text (see fitWorksheet). Returns rows changed. */
  fitRowHeights() {
    let n = 0;
    for (const ws of this.wb.worksheets) n += fitWorksheet(ws);
    return n;
  }
  markDirty() {
    if (this.readOnly) throw new Error('This workbook is read-only (you do not have permission to edit it).');
    this.dirty = true;
  }

  wrap(ws) {
    let s = this.sheets.get(ws.id);
    if (!s || s.ws !== ws) { s = new XSheet(this, ws); this.sheets.set(ws.id, s); }
    return s;
  }
  getName() { return this.name; }
  getId() { return this.name; }
  getSpreadsheetTimeZone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  getSheets() { return this.wb.worksheets.map((ws) => this.wrap(ws)); }
  getSheetByName(name) {
    const ws = this.wb.worksheets.find((w) => w.name === name);
    return ws ? this.wrap(ws) : null;
  }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    this.markDirty();
    return this.wrap(this.wb.addWorksheet(name));
  }

  /** Display values of a range formula like 'Lists'!$A$1:$A$3 (for range-based dropdowns). */
  resolveRange(formula) {
    const m = /^(?:'?(.+?)'?!)?(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+))?$/.exec(String(formula || '').trim());
    if (!m) return [];
    const sheet = m[1] ? this.getSheetByName(m[1]) : null;
    if (!sheet) return [];
    const a = parseCell(m[2]);
    const b = m[3] ? parseCell(m[3]) : a;
    return sheet.getRange(a.row, a.col, b.row - a.row + 1, b.col - a.col + 1).getDisplayValues();
  }
}
