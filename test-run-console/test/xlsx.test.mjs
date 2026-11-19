// What only the .xlsx back end does: moving dropdowns, merges and column
// widths on insert; saving safely; backups; reloading after an outside edit;
// import checks; the sidecar store file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { XBook } from '../lib/xlsx-book.mjs';
import { Library, isWorkbookName } from '../lib/books.mjs';
import { createFileStore } from '../lib/store.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'testrun-'));

async function bookWith(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return XBook.fromBuffer(Buffer.from(await wb.xlsx.writeBuffer()), 'T');
}

async function reload(book) {
  return XBook.fromBuffer(Buffer.from(await book.toBuffer()), book.name);
}

const dvAt = (book, tab, addr) => book.getSheetByName(tab).ws.getCell(addr).dataValidation;

test('inserting columns moves dropdowns, merges and column widths to the right', async () => {
  const book = await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getRow(1).values = ['ID', 'Scenario', 'Status', 'Notes', 'Owner'];
    ws.getRow(2).values = ['1', 'a', 'Pass', 'n', 'me'];
    ws.getCell('C2').dataValidation = { type: 'list', formulae: ['"Pass,Fail"'] };
    ws.getCell('E2').dataValidation = { type: 'list', formulae: ['"me,you"'] };
    ws.getColumn(5).width = 33;
    ws.mergeCells('D4:E4');
    ws.getCell('D4').value = 'merged note';
  });
  const sh = book.getSheetByName('S');
  sh.insertColumnsAfter(4, 2);
  const again = await reload(book);
  assert.deepEqual(again.getSheetByName('S').getRange(1, 1, 1, 7).getDisplayValues()[0], ['ID', 'Scenario', 'Status', 'Notes', '', '', 'Owner']);
  assert.deepEqual(dvAt(again, 'S', 'C2').formulae, ['"Pass,Fail"'], 'dropdown before the insert stays');
  assert.deepEqual(dvAt(again, 'S', 'G2').formulae, ['"me,you"'], 'dropdown after the insert moves with its column');
  assert.equal(dvAt(again, 'S', 'E2'), undefined, 'nothing left behind in the new columns');
  assert.equal(again.getSheetByName('S').ws.getColumn(7).width, 33, 'column width moves too');
  const merges = again.getSheetByName('S').ws.model.merges;
  assert.deepEqual(merges, ['D4:G4'], 'a merge spanning the insert point grows');
  assert.equal(book.dirty, true);
});

test('inserting rows moves dropdowns below and keeps rows above', async () => {
  const book = await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getRow(1).values = ['ID', 'Status'];
    for (let r = 2; r <= 5; r++) {
      ws.getRow(r).values = [`T-${r}`, ''];
      ws.getCell(r, 2).dataValidation = { type: 'list', formulae: ['"Pass,Fail"'] };
    }
  });
  book.getSheetByName('S').insertRowsAfter(3, 2);
  const again = await reload(book);
  const sh = again.getSheetByName('S');
  assert.deepEqual(sh.getRange(1, 1, 8, 1).getDisplayValues().map((r) => r[0]), ['ID', 'T-2', 'T-3', '', '', 'T-4', 'T-5', '']);
  assert.ok(dvAt(again, 'S', 'B3'));
  assert.equal(dvAt(again, 'S', 'B4'), undefined);
  assert.ok(dvAt(again, 'S', 'B6') && dvAt(again, 'S', 'B7'), 'dropdowns moved down with their rows');
});

test('deleting a row moves dropdowns, merges and conditional formats up; a merge starting there keeps its value', async () => {
  const book = await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getRow(1).values = ['ID', 'Status', 'Feature'];
    for (let r = 2; r <= 7; r++) {
      ws.getRow(r).values = [`T-${r}`, ''];
      ws.getCell(r, 2).dataValidation = { type: 'list', formulae: ['"Pass,Fail"'] };
    }
    ws.getCell('C3').value = 'Inbox';
    ws.mergeCells('C3:C5'); // Feature merged over three rows, its value on the first
    ws.getCell('C6').value = 'Search';
    ws.mergeCells('C6:C7');
    ws.addConditionalFormatting({ ref: 'B2:B7', rules: [{ type: 'containsText', operator: 'containsText', text: 'Fail', style: { font: { bold: true } }, priority: 1 }] });
  });
  const sh = book.getSheetByName('S');
  sh.deleteRow(3);
  const again = await reload(book);
  const s2 = again.getSheetByName('S');
  assert.deepEqual(s2.getRange(1, 1, 7, 1).getDisplayValues().map((r) => r[0]), ['ID', 'T-2', 'T-4', 'T-5', 'T-6', 'T-7', '']);
  assert.deepEqual(s2.ws.model.merges.sort(), ['C3:C4', 'C5:C6'], 'a merge starting on the row shrinks; one below moves up');
  assert.equal(s2.getRange(3, 3).getValue(), 'Inbox', 'the merged Feature value is kept');
  assert.ok(dvAt(again, 'S', 'B6'));
  assert.equal(dvAt(again, 'S', 'B7'), undefined, 'dropdowns moved up with their rows');
  assert.equal(s2.ws.conditionalFormattings[0].ref, 'B2:B6');
});

test('display text follows Sheets: dates, formulas, rich text, merged followers, apostrophes', async () => {
  const book = await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = new Date(Date.UTC(2026, 10, 18));
    ws.getCell('A2').value = { formula: 'B2*2', result: 14 };
    ws.getCell('A3').value = { richText: [{ text: 'Verify ' }, { text: 'bold', font: { bold: true } }] };
    ws.getCell('A4').value = 'top';
    ws.mergeCells('A4:B4');
    ws.getCell('A5').value = { text: 'link', hyperlink: 'https://x.y' };
  });
  const sh = book.getSheetByName('S');
  assert.deepEqual(sh.getRange(1, 1, 5, 2).getDisplayValues(), [['2026-11-18', ''], ['14', ''], ['Verify bold', ''], ['top', ''], ['link', '']]);
  sh.getRange(6, 1).setValue("'=SUM(A1)");
  sh.getRange(7, 1).setValue('42');
  const again = await reload(book);
  const ws = again.getSheetByName('S').ws;
  assert.equal(ws.getCell('A6').value, '=SUM(A1)', 'a leading apostrophe means text: no formula is created');
  assert.equal(ws.getCell('A6').formula, undefined);
  assert.equal(ws.getCell('A7').value, 42, 'plain numbers are stored as numbers');
});

test('the real sample keeps everything it did not touch across a save', async () => {
  const buf = await buildSampleXlsx();
  const before = await XBook.fromBuffer(buf, 's');
  const book = await XBook.fromBuffer(buf, 's');
  book.getSheetByName('CMS 2.20.1').getRange(5, 8).setValue('Pass');
  const after = await reload(book);
  for (const sheet of before.getSheets()) {
    const name = sheet.getName();
    const a = sheet.getDataRange().getDisplayValues();
    const b = after.getSheetByName(name).getDataRange().getDisplayValues();
    if (name === 'CMS 2.20.1') { a[4][7] = 'Pass'; }
    assert.deepEqual(b, a, `values of ${name}`);
    const sa = sheet.ws.getCell('A1').style;
    const sb = after.getSheetByName(name).ws.getCell('A1').style;
    assert.deepEqual(sb.fill || null, sa.fill || null, `header fill of ${name}`);
  }
  assert.equal(Object.keys(after.getSheetByName('CMS 2.20.1').ws.dataValidations.model).length, 18);
});

test('strikethrough is read and written as the font line, and survives a save', async () => {
  const book = await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getRow(1).values = ['ID', 'Scenario'];
    ws.getRow(2).values = ['1', 'a'];
    ws.getRow(3).values = ['2', 'b'];
    ws.getCell('B3').font = { name: 'Arial', strike: true, color: { argb: 'FF990000' } };
  });
  const sh = book.getSheetByName('S');
  assert.deepEqual(sh.getRange(2, 2, 2, 1).getFontLines(), [['none'], ['line-through']], 'strike set in Excel or Google Sheets is seen');
  sh.getRange(2, 1, 1, 2).setFontLine('line-through');
  sh.getRange(3, 2).setFontLine('none');
  const again = (await reload(book)).getSheetByName('S');
  assert.deepEqual(again.getRange(2, 1, 2, 2).getFontLines(), [['line-through', 'line-through'], ['none', 'none']]);
  assert.deepEqual(again.ws.getCell('B3').font, { name: 'Arial', color: { argb: 'FF990000' } }, 'the rest of the font is kept');
});

test('rows grow to fit wrapped and multi-line text (a Google Sheets download keeps them one line high)', async () => {
  const book = await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.properties.defaultColWidth = 12.63;
    ws.getColumn(2).width = 24.88;
    const wrap = { vertical: 'bottom', wrapText: true };
    const put = (addr, v, align = wrap) => { const c = ws.getCell(addr); c.value = v; c.font = { name: 'Arial' }; c.alignment = align; };
    put('A1', 'ID'); put('B1', 'Pre Condition');
    put('A2', 'T-1'); put('B2', 'Phone number\nName\nComplaint type\nSub-type\nLocality fields (all from the boundary data)\nDescription');
    put('A3', 'T-2'); put('B3', 'Valid and invalid numbers, both of them');
    put('A4', 'T-3'); put('B4', 'Short');
    put('A5', 'T-4'); put('B5', 'Two\nlines', { vertical: 'bottom' }); // line break but no wrap set
    put('A6', 'T-5'); put('B6', 'A sentence long enough to wrap if only this cell wrapped', { vertical: 'bottom' });
    put('A7', 'T-6'); put('B7', 'Line one\nLine two');
    for (let r = 1; r <= 6; r++) ws.getRow(r).height = 15.75;
    ws.getRow(7).height = 120; // sized by hand: kept
  });
  const sh = book.getSheetByName('S');
  const ht = (r) => sh.ws.getRow(r).height;
  const changed = book.fitRowHeights();
  assert.ok(ht(2) >= 80, `six lines and one wrapped line need about 7 lines (got ${ht(2)})`);
  assert.ok(ht(3) >= 28 && ht(3) < 45, `a long line in a narrow column wraps to 2 lines (got ${ht(3)})`);
  assert.equal(ht(4), 15.75, 'one line: untouched');
  assert.ok(ht(5) >= 28, 'line breaks count even without wrap set ...');
  assert.equal(sh.ws.getCell('B5').alignment.wrapText, true, '... and wrap is turned on so they show');
  assert.equal(ht(6), 15.75, 'text that does not wrap overflows sideways; the row stays');
  assert.equal(ht(7), 120, 'never made shorter');
  assert.equal(changed, 3);
  assert.equal(book.fitRowHeights(), 0, 'nothing more to do the second time');
  const again = (await reload(book)).getSheetByName('S').ws;
  assert.equal(again.getRow(2).height, ht(2), 'kept in the saved file');
});

test('a written value on several lines wraps', async () => {
  const book = await bookWith((wb) => { wb.addWorksheet('S').getCell('A1').value = 'x'; });
  const sh = book.getSheetByName('S');
  sh.getRange(1, 1).setValue('Deprecated: old\nFailed once');
  assert.equal(sh.ws.getCell('A1').alignment.wrapText, true);
});

test('library: every save fits row heights', async () => {
  const dir = tmp();
  const lib = new Library(dir);
  writeFileSync(join(dir, 'B.xlsx'), Buffer.from(await (await bookWith((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'a\nb\nc';
    ws.getCell('A1').alignment = { wrapText: true };
    ws.getRow(1).height = 15.75;
  })).toBuffer()));
  const entry = await lib.get('B.xlsx');
  entry.book.getSheetByName('S').getRange(2, 1).setValue('x');
  await lib.save(entry);
  const saved = await XBook.fromFile(join(dir, 'B.xlsx'), 'B');
  assert.ok(saved.getSheetByName('S').ws.getRow(1).height >= 40);
});

test('library: lists workbooks, ignores lock and temp files', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'A.xlsx'), await buildSampleXlsx());
  writeFileSync(join(dir, '~$A.xlsx'), 'lock');
  writeFileSync(join(dir, '.A.xlsx.1.tmp'), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const lib = new Library(dir);
  assert.deepEqual(lib.list().map((b) => [b.name, b.excelOpen]), [['A.xlsx', true]]);
  assert.equal(isWorkbookName('../x.xlsx'), false);
  assert.equal(isWorkbookName('a/b.xlsx'), false);
  await assert.rejects(lib.get('../A.xlsx'), /Not a workbook name/);
});

test('library: saves by replacing the file, backs up once a day, writes the sidecar', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'A.xlsx'), await buildSampleXlsx());
  const lib = new Library(dir);
  const e = await lib.get('A.xlsx');
  assert.equal(await lib.save(e), false, 'nothing to save yet');
  e.book.getSheetByName('CMS 2.20.1').getRange(5, 8).setValue('Pass');
  e.store.put('finding', 'F-001', { text: 'x' }, {});
  assert.equal(await lib.save(e), true);
  const backups = readdirSync(join(dir, '.testrun', 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^A \d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.ok(existsSync(join(dir, '.testrun', 'A.json')));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  e.book.getSheetByName('CMS 2.20.1').getRange(6, 8).setValue('Fail');
  await lib.save(e);
  assert.equal(readdirSync(join(dir, '.testrun', 'backups')).length, 1, 'one backup per day');
  const fresh = await new Library(dir).get('A.xlsx');
  assert.deepEqual(fresh.book.getSheetByName('CMS 2.20.1').getRange(5, 8, 2, 1).getDisplayValues(), [['Pass'], ['Fail']]);
  assert.equal(fresh.store.get('finding', 'F-001').text, 'x');
});

test('library: reopens a workbook that was changed on disk (e.g. saved from Excel)', async () => {
  const dir = tmp();
  const file = join(dir, 'A.xlsx');
  writeFileSync(file, await buildSampleXlsx());
  const lib = new Library(dir);
  const e1 = await lib.get('A.xlsx');
  const outside = await XBook.fromBuffer(readFileSync(file), 'A');
  outside.getSheetByName('CMS 2.20.1').getRange(5, 9).setValue('edited in Excel');
  writeFileSync(file, Buffer.from(await outside.toBuffer()));
  const later = new Date(statSync(file).mtimeMs + 5000);
  utimesSync(file, later, later);
  const e2 = await lib.get('A.xlsx');
  assert.notEqual(e2.book, e1.book);
  assert.equal(e2.reloaded, true);
  assert.equal(e2.book.getSheetByName('CMS 2.20.1').getRange(5, 9).getValue(), 'edited in Excel');
  assert.equal(e2.store, e1.store, 'the sidecar store is kept');
});

test('library: import accepts only real .xlsx files and does not overwrite by accident', async () => {
  const dir = tmp();
  const lib = new Library(dir);
  const good = await buildSampleXlsx();
  assert.equal(await lib.importFile('My Sheet.xlsx', good), 'My Sheet.xlsx');
  await assert.rejects(lib.importFile('My Sheet.xlsx', good), /already in the sheets folder/);
  assert.equal(await lib.importFile('My Sheet.xlsx', good, { overwrite: true }), 'My Sheet.xlsx');
  await assert.rejects(lib.importFile('evil.xlsx', Buffer.from('<html>')), /not an .xlsx/);
  await assert.rejects(lib.importFile('notes.csv', good), /Choose an .xlsx/);
  assert.equal(await lib.importFile('../../escape.xlsx', good), 'escape.xlsx', 'path parts are dropped');
  assert.ok(existsSync(join(dir, 'escape.xlsx')));
});

test('read-only files report a clear error on write', async () => {
  const book = await XBook.fromBuffer(await buildSampleXlsx(), 's');
  book.readOnly = true;
  assert.throws(() => book.getSheetByName('CMS 2.20.1').getRange(2, 8).setValue('Pass'), /read-only/);
});

test('file store survives a restart and refuses a damaged file', () => {
  const dir = tmp();
  const f = join(dir, 'x.json');
  const s = createFileStore(f);
  s.put('inbox', 'I-1', { a: 1 }, { by: 'me' });
  assert.equal(s.flush(), true);
  assert.equal(s.flush(), false, 'nothing new to write');
  assert.deepEqual(createFileStore(f).list('inbox'), [{ key: 'I-1', value: { a: 1 }, updated: '', by: 'me' }]);
  writeFileSync(f, '{broken');
  assert.throws(() => createFileStore(f), /damaged/);
});
