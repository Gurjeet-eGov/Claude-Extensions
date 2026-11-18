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
