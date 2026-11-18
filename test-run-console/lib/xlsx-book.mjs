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
}

function restyle(cell, fn) {
  const st = clone(cell.style || {}) || {};
  fn(st);
  cell.style = st;
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
  deleteRow(row) {
    this.book.markDirty();
    this.ws.spliceRows(row, 1);
    const dv = this.ws.dataValidations.model;
    const moved = {};
    for (const [addr, v] of Object.entries(dv)) {
      const c = parseCell(addr);
      if (!v || (c && c.row === row)) continue;
      moved[c && c.row > row ? cellRef(c.col, c.row - 1) : addr] = v;
    }
    this.ws.dataValidations.model = moved;
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
