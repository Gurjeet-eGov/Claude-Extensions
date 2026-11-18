// A small in-memory stand-in for the parts of SpreadsheetApp the console uses,
// so the real .gs files run under Node for the unit tests and the local demo.
// Display rules that matter are copied from Sheets: a leading apostrophe makes
// text literal (and is hidden), and a leading "=" would become a formula (shown
// here as "#FORMULA!" so tests notice it).

export const CopyPasteType = {
  PASTE_NORMAL: 'PASTE_NORMAL',
  PASTE_FORMAT: 'PASTE_FORMAT',
  PASTE_DATA_VALIDATION: 'PASTE_DATA_VALIDATION',
};

export const DataValidationCriteria = {
  VALUE_IN_LIST: 'VALUE_IN_LIST',
  VALUE_IN_RANGE: 'VALUE_IN_RANGE',
};

export class FakeValidation {
  constructor(values) {
    this.values = values.slice();
  }
  getCriteriaType() {
    return DataValidationCriteria.VALUE_IN_LIST;
  }
  getCriteriaValues() {
    return [this.values.slice(), true];
  }
}

class ValidationBuilder {
  requireValueInList(values) {
    this.values = values;
    return this;
  }
  setAllowInvalid() {
    return this;
  }
  build() {
    return new FakeValidation(this.values || []);
  }
}

function display(raw) {
  const s = raw == null ? '' : String(raw);
  if (s.startsWith("'")) return s.slice(1);
  if (s.startsWith('=')) return '#FORMULA!';
  return s;
}

const STYLE_METHODS = [
  'setFontWeight', 'setBackground', 'setFontFamily', 'setFontSize', 'setWrap', 'setVerticalAlignment',
  'setHorizontalAlignment', 'setBorder', 'setFontColor', 'setNumberFormat', 'setFontStyle',
];

export class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    if (!(row >= 1 && col >= 1 && numRows >= 1 && numCols >= 1)) {
      throw new Error(`Invalid range ${row},${col},${numRows},${numCols}`);
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
    for (const m of STYLE_METHODS) {
      this[m] = () => {
        this.sheet.ss.checkWrite();
        this.each((r, c) => { this.sheet.fmt[r][c] = 'styled'; });
        return this;
      };
    }
  }
  each(fn) {
    this.sheet.ensure(this.row + this.numRows - 1, this.col + this.numCols - 1);
    for (let i = 0; i < this.numRows; i++) {
      for (let j = 0; j < this.numCols; j++) fn(this.row - 1 + i, this.col - 1 + j, i, j);
    }
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getDisplayValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) line.push(display(this.sheet.raw(this.row - 1 + i, this.col - 1 + j)));
      out.push(line);
    }
    return out;
  }
  getValues() {
    return this.getDisplayValues();
  }
  getValue() {
    return this.getDisplayValues()[0][0];
  }
  setValues(values) {
    this.sheet.ss.checkWrite();
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`setValues: data is ${values.length}x${values[0] && values[0].length}, range is ${this.numRows}x${this.numCols}`);
    }
    this.each((r, c, i, j) => { this.sheet.cells[r][c] = values[i][j] == null ? '' : String(values[i][j]); });
    this.sheet.ss.writes++;
    return this;
  }
  setValue(v) {
    this.sheet.ss.checkWrite();
    this.each((r, c) => { this.sheet.cells[r][c] = v == null ? '' : String(v); });
    this.sheet.ss.writes++;
    return this;
  }
  getDataValidations() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) {
        const r = this.row - 1 + i;
        const c = this.col - 1 + j;
        line.push((this.sheet.dv[r] && this.sheet.dv[r][c]) || null);
      }
      out.push(line);
    }
    return out;
  }
  setDataValidation(rule) {
    this.sheet.ss.checkWrite();
    this.each((r, c) => { this.sheet.dv[r][c] = rule; });
    return this;
  }
  copyTo(dest, type) {
    this.sheet.ss.checkWrite();
    const src = this;
    dest.each((r, c, i, j) => {
      const sr = src.row - 1 + (i % src.numRows);
      const sc = src.col - 1 + (j % src.numCols);
      src.sheet.ensure(sr + 1, sc + 1);
      if (type === CopyPasteType.PASTE_FORMAT) dest.sheet.fmt[r][c] = src.sheet.fmt[sr][sc];
      else if (type === CopyPasteType.PASTE_DATA_VALIDATION) dest.sheet.dv[r][c] = src.sheet.dv[sr][sc];
      else {
        dest.sheet.cells[r][c] = src.sheet.cells[sr][sc];
        dest.sheet.fmt[r][c] = src.sheet.fmt[sr][sc];
        dest.sheet.dv[r][c] = src.sheet.dv[sr][sc];
      }
    });
    return this;
  }
}

export class FakeSheet {
  constructor(ss, name, rows = [], { validations = [], formats = [] } = {}) {
    this.ss = ss;
    this.name = name;
    this.hidden = false;
    this.cells = rows.map((r) => r.map((v) => (v == null ? '' : String(v))));
    this.dv = this.cells.map((r) => r.map(() => null));
    this.fmt = this.cells.map((r) => r.map(() => null));
    this.ensure(Math.max(this.cells.length, 1), Math.max(...this.cells.map((r) => r.length), 1));
    // validations: [{ col (1-based), fromRow, toRow, values }]
    for (const v of validations) {
      const rule = new FakeValidation(v.values);
      for (let r = v.fromRow; r <= v.toRow; r++) { this.ensure(r, v.col); this.dv[r - 1][v.col - 1] = rule; }
    }
    // formats: [{ row, tag }] marks a whole row with a format tag
    for (const f of formats) {
      this.ensure(f.row, this.width());
      for (let c = 0; c < this.width(); c++) this.fmt[f.row - 1][c] = f.tag;
    }
  }
  width() {
    return Math.max(0, ...this.cells.map((r) => r.length));
  }
  ensure(rows, cols) {
    const w = Math.max(cols, this.width());
    while (this.cells.length < rows) { this.cells.push([]); this.dv.push([]); this.fmt.push([]); }
    for (let r = 0; r < this.cells.length; r++) {
      while (this.cells[r].length < w) { this.cells[r].push(''); this.dv[r].push(null); this.fmt[r].push(null); }
    }
  }
  raw(r, c) {
    return (this.cells[r] && this.cells[r][c]) || '';
  }
  getName() { return this.name; }
  getSheetId() { return this.ss.sheets.indexOf(this); }
  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) if (this.cells[r].some((v) => String(v) !== '')) return r + 1;
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this.cells) for (let c = row.length - 1; c >= 0; c--) if (String(row[c]) !== '') { last = Math.max(last, c + 1); break; }
    return last;
  }
  getMaxRows() { return this.cells.length; }
  getMaxColumns() { return this.width(); }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') throw new Error('A1 notation is not supported by the fake');
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  insertColumnsAfter(col, n) {
    this.ss.checkWrite();
    this.ensure(1, col);
    for (let r = 0; r < this.cells.length; r++) {
      this.cells[r].splice(col, 0, ...Array(n).fill(''));
      this.dv[r].splice(col, 0, ...Array(n).fill(null));
      this.fmt[r].splice(col, 0, ...Array(n).fill(null));
    }
    return this;
  }
  insertRowsAfter(row, n) {
    this.ss.checkWrite();
    const w = this.width();
    for (let i = 0; i < n; i++) {
      this.cells.splice(row, 0, Array(w).fill(''));
      this.dv.splice(row, 0, Array(w).fill(null));
      this.fmt.splice(row, 0, Array(w).fill(null));
    }
    return this;
  }
  deleteRow(row) {
    this.ss.checkWrite();
    this.cells.splice(row - 1, 1);
    this.dv.splice(row - 1, 1);
    this.fmt.splice(row - 1, 1);
    return this;
  }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  clear() {
    this.ss.checkWrite();
    this.cells = [[]];
    this.dv = [[]];
    this.fmt = [[]];
    return this;
  }
  setColumnWidth() { return this; }
  setFrozenRows() { return this; }

  /** Test helper: the display values of the used range. */
  dump() {
    return this.getDataRange().getDisplayValues();
  }
}

export class FakeSpreadsheet {
  constructor(name = 'Test sheet', { timeZone = 'Asia/Kolkata' } = {}) {
    this.name = name;
    this.timeZone = timeZone;
    this.sheets = [];
    this.readOnly = false;
    this.writes = 0;
  }
  checkWrite() {
    if (this.readOnly) throw new Error('You do not have permission to edit this spreadsheet.');
  }
  addSheet(name, rows, opts) {
    const sh = new FakeSheet(this, name, rows, opts);
    this.sheets.push(sh);
    return sh;
  }
  getName() { return this.name; }
  getId() { return 'fake-id'; }
  getSpreadsheetTimeZone() { return this.timeZone; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) {
    this.checkWrite();
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    return this.addSheet(name, [[]]);
  }
}

/** Globals the .gs files expect, backed by one FakeSpreadsheet. env.email can be changed between calls. */
export function makeGlobals(ss, env = {}) {
  const state = Object.assign({ email: 'tester.one@example.org', url: 'http://localhost/exec', now: null }, env);
  const lock = { tryLock: () => true, waitLock: () => {}, releaseLock: () => {} };
  const pad = (n) => String(n).padStart(2, '0');
  return {
    state,
    globals: {
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ss,
        getActive: () => ss,
        CopyPasteType,
        DataValidationCriteria,
        newDataValidation: () => new ValidationBuilder(),
        flush: () => {},
      },
      LockService: { getDocumentLock: () => lock, getScriptLock: () => lock },
      Session: { getActiveUser: () => ({ getEmail: () => state.email }), getScriptTimeZone: () => 'Etc/UTC' },
      Utilities: {
        formatDate: (d) => {
          const t = state.now ? new Date(state.now) : d;
          return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
        },
      },
      ScriptApp: { getService: () => ({ getUrl: () => state.url }) },
      Logger: { log: () => {} },
    },
  };
}
