// Drives the real console in Chromium against the real local server, on a
// temporary sheets folder with the sample .xlsx. A second page plays a
// teammate on the hosted copy of the console (another origin), with an invite.
// Every check reads the workbook back from disk. Skipped when Playwright is
// not installed (looked up in PLAYWRIGHT_DIR, else in the CCRS checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, utimesSync, statSync, chmodSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { XBook } from '../lib/xlsx-book.mjs';
import { buildSampleXlsx } from '../dev/sample-workbook.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
for (const dir of [process.env.PLAYWRIGHT_DIR, join(homedir(), 'Documents/Citizen-Complaint-Resolution-System/tests/integration-tests/node_modules/playwright')].filter(Boolean)) {
  if (existsSync(dir)) { try { ({ chromium } = require(dir)); break; } catch { /* try next */ } }
}

const BOOK = 'CMS Sign Off (sample).xlsx';
const TAB = 'CMS 2.20.1';

test('console end to end in a browser', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const sheets = mkdtempSync(join(tmpdir(), 'testrun-e2e-'));
  const file = join(sheets, BOOK);
  writeFileSync(file, await buildSampleXlsx());
  const server = createServer({ sheetsDir: sheets, ghPath: '/nope/gh' }); // never the real gh in tests
  const base = await server.listenOn(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const disk = async (path = file, tab = TAB) => (await XBook.fromFile(path, 'x')).getSheetByName(tab).getDataRange().getDisplayValues();
  const row = (rows, id) => rows.find((r) => r[0] === id);

  try {
    await t.test('first run opens Setup; saving it lands on Run with paths', async () => {
      await page.goto(base);
      await page.getByText('Welcome.').waitFor();
      await page.getByRole('button', { name: 'Save setup' }).click();
      await page.locator('.nav [data-view=run][aria-current=page]').waitFor();
      await page.locator('.path-title', { hasText: 'CSR Employee' }).waitFor();
      assert.ok(await page.locator('.case').count() >= 8);
    });

    await t.test('P marks Pass, saved in the .xlsx file, and moves on', async () => {
      await page.locator('.case', { hasText: 'CMS/04' }).click();
      await page.locator('.detail').waitFor();
      await page.keyboard.press('p');
      await page.locator('.case.sel', { hasText: 'CMS/07' }).waitFor();
      await page.locator('.case', { hasText: 'CMS/04' }).locator('.dot.pass').waitFor();
      await eventually(async () => row(await disk(), 'CMS/04')[7] === 'Pass');
    });

    await t.test('F marks Fail, focuses the comment, Enter saves it', async () => {
      await page.keyboard.press('f');
      const box = page.locator('#comment');
      await box.waitFor();
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'comment');
      await page.keyboard.type('Clear keeps the locality filter');
      await page.keyboard.press('Enter');
      await eventually(async () => {
        const r = row(await disk(), 'CMS/07');
        return r[7] === 'Fail' && r[8].endsWith('\nClear keeps the locality filter') && r[8].startsWith('Partly automated');
      });
    });

    await t.test('undo puts the previous result back', async () => {
      await page.locator('.case', { hasText: 'CMS/09' }).click();
      await page.keyboard.press('p');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === 'Pass');
      await page.keyboard.press('u');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === '');
    });

    await t.test('a marked result can be cleared: press it again, or 0', async () => {
      const openCase = async (p, id) => { if (!(await p.locator('.case.sel', { hasText: id }).count())) await p.locator('.case', { hasText: id }).click(); };
      await openCase(page, 'CMS/09');
      await page.keyboard.press('n');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === 'NA (Skipped)');
      await openCase(page, 'CMS/09');
      await page.locator('.sbtn.on', { hasText: 'NA (Skipped)' }).click();
      await eventually(async () => row(await disk(), 'CMS/09')[7] === '');
      await page.locator('.toast', { hasText: 'back to not run' }).first().waitFor();
      await page.keyboard.press('p');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === 'Pass');
      await page.locator('[data-action=show][data-show=all]').click();
      await openCase(page, 'CMS/09');
      await page.keyboard.press('0');
      await eventually(async () => row(await disk(), 'CMS/09')[7] === '');
      await page.locator('[data-action=show][data-show=todo]').click();
    });

    await t.test('while running: edit a case, mark one a duplicate, deprecate one, restore', async () => {
      const struck = async (id) => {
        const sh = (await XBook.fromFile(file, 'x')).getSheetByName(TAB);
        const r = sh.getDataRange().getDisplayValues().findIndex((x) => x[0] === id) + 1;
        return sh.getRange(r, 2).getFontLines()[0][0] === 'line-through';
      };

      await page.locator('.case', { hasText: 'CMS/10' }).click();
      await page.keyboard.press('e');
      await page.locator('#ce_scenario').fill('Verify if the LME is able to resolve an assigned complaint, with or without a photo');
      await page.locator('#ce_note').fill('Photo is optional from 2.20');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await eventually(async () => {
        const r = row(await disk(), 'CMS/10');
        return r[1] === 'Verify if the LME is able to resolve an assigned complaint, with or without a photo' && r[8] === 'Updated: Photo is optional from 2.20';
      });
      await page.locator('.case.sel', { hasText: 'with or without a photo' }).waitFor();

      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.getByRole('button', { name: '⧉ Duplicate of…' }).click();
      await page.locator('#dupOf').fill('CMS/10');
      await page.locator('#dupPreview', { hasText: 'Keeps CMS/10' }).waitFor();
      await page.getByRole('button', { name: 'Mark as duplicate' }).click();
      await eventually(async () => row(await disk(), 'CMS/12')[8] === 'Duplicate of CMS/10' && struck('CMS/12'));
      await page.locator('.case.retired', { hasText: 'CMS/12' }).locator('.pill', { hasText: 'Duplicate of CMS/10' }).waitFor();
      await page.locator('.progress-wrap', { hasText: '1 retired' }).waitFor();
      assert.equal(await struck('CMS/10'), false, 'the kept case is not struck');

      await page.locator('.case', { hasText: 'CMS/13' }).click();
      await page.getByRole('button', { name: '⊘ Deprecate' }).click();
      await page.locator('#retireReason').fill('Rating moved to the feedback survey');
      await page.locator('button[data-action=retire]').click();
      await eventually(async () => row(await disk(), 'CMS/13')[8] === 'Deprecated: Rating moved to the feedback survey' && struck('CMS/13'));
      assert.equal(row(await disk(), 'CMS/13')[1], 'Verify if the citizen can rate a resolved complaint', 'the text stays in the workbook');

      const s = await browser.newPage();
      await s.goto(`${base}summary.html?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await s.locator('tr', { hasText: 'Rating moved to the feedback survey' }).waitFor();
      await s.getByText('2 retired cases are left out of these figures').waitFor();
      await s.close();

      await page.locator('[data-action=show][data-show=retired]').click();
      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.locator('.retired-box', { hasText: 'Duplicate of CMS/10' }).waitFor();
      await page.getByRole('button', { name: 'Restore to the run' }).click();
      await eventually(async () => row(await disk(), 'CMS/12')[8] === '' && !(await struck('CMS/12')));
      await page.locator('[data-action=show][data-show=todo]').click();
      await page.locator('.case', { hasText: 'CMS/12' }).waitFor();
      assert.equal(await page.locator('.case', { hasText: 'CMS/13' }).count(), 0, 'a deprecated case leaves the to-do list');
    });

    await t.test('a change saved from Excel is picked up and never overwritten', async () => {
      const book = await XBook.fromFile(file, 'x');
      const sh = book.getSheetByName(TAB);
      const r = sh.getDataRange().getDisplayValues().findIndex((x) => x[0] === 'CMS/08') + 1;
      sh.getRange(r, 8).setValue('Pass');
      writeFileSync(file, Buffer.from(await book.toBuffer()));
      const later = new Date(statSync(file).mtimeMs + 5000);
      utimesSync(file, later, later);
      await page.locator('.case', { hasText: 'CMS/08' }).click();
      await page.keyboard.press('f');
      await page.locator('.toast', { hasText: 'was just marked "Pass"' }).waitFor();
      assert.equal(row(await disk(), 'CMS/08')[7], 'Pass');
    });

    await t.test('a bug noted from Bug Reporter shows up as a finding', async () => {
      await page.locator('.nav [data-view=findings]').click();
      await fetch(`${base}api/note-bug`, { method: 'POST', headers: { 'X-Test-Run': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Citizen cannot reopen a complaint resolved 4 days ago', number: 77, url: 'https://github.com/org/repo/issues/77', module: 'Citizen UI', actual: 'No button', expected: 'Reopen offered' }) });
      await page.locator('.toast', { hasText: 'New finding from Bug Reporter: F-001' }).waitFor({ timeout: 15000 });
      await page.locator('.finding .pill', { hasText: 'from Bug Reporter' }).waitFor();
    });

    await t.test('a finding is written up as a test case, straight into the workbook', async () => {
      await page.locator('.finding', { hasText: 'F-001' }).getByRole('button', { name: 'Write up as test case' }).click();
      const scen = page.locator('.writeup textarea').first();
      assert.equal(await scen.inputValue(), 'Citizen cannot reopen a complaint resolved 4 days ago', 'starts from the finding');
      await scen.fill('Verify that citizen can reopen a complaint resolved 4 days ago');
      await page.getByRole('button', { name: 'Add to workbook' }).click();
      await page.locator('.toast', { hasText: 'F-001 added to the workbook as CMS/19' }).waitFor();
      const r = row(await disk(), 'CMS/19');
      assert.equal(r[1], 'Verify that citizen can reopen a complaint resolved 4 days ago');
      assert.equal(r[6], '• Reopen offered', 'the expected result Bug Reporter noted');
      assert.equal(r[7], 'Fail', 'a finding with a bug number starts as Fail');
      const hdr = (await disk())[0];
      assert.equal(r[hdr.indexOf('Linked issue')], '#77', 'its bug, in a Linked issue column added for it');
      await page.getByText('Done: 1 written up or already covered').waitFor();
    });

    await t.test('start a new cycle from Setup', async () => {
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('#newCycle0').fill('v2.20.1');
      await page.locator('[data-action=start-cycle][data-index="0"]').click();
      await page.locator('#cyclePick option:checked', { hasText: 'v2.20.1' }).waitFor({ state: 'attached' });
      assert.deepEqual((await disk())[0].slice(7, 11), ['Test Status / v2.12', 'Comment / v2.12', 'Test Status / v2.20.1', 'Comment / v2.20.1']);
    });

    await t.test('a teammate joins on the hosted page with an invite link and marks results under their name', async () => {
      // The console's page on another origin, like GitHub Pages.
      const ui = new URL('../ui/', import.meta.url).pathname;
      const pages = http.createServer((req, res) => {
        const f = join(ui, (req.url.split('?')[0].replace(/^\//, '') || 'index.html'));
        if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
        res.end(readFileSync(f));
      });
      await new Promise((r) => pages.listen(0, '127.0.0.1', r));
      const hosted = `http://127.0.0.1:${pages.address().port}/`;
      const api = (path, body) => fetch(base + path.slice(1), { method: 'POST', headers: { 'X-Test-Run': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
      const mate = await browser.newPage();
      mate.on('pageerror', (e) => errors.push(e.message));
      try {
        await mate.goto(hosted);
        await mate.getByText('Connect to a Test Run').waitFor();
        await api('/api/team', { enabled: true, mode: 'fixed', fixedUrl: base.replace(/\/$/, ''), hostedUrl: hosted });
        await api('/api/call/api_addColumns', { book: BOOK, args: [TAB, ['testedBy']] });
        const inv = await api('/api/team/people', { name: 'Priya (QA)', role: 'tester' });
        assert.match(inv.link, new RegExp(`^${hosted}#join=[\\w-]+&server=`));
        await mate.goto(inv.link);
        await mate.locator('.who', { hasText: 'Priya (QA) · tester' }).waitFor();
        assert.equal(new URL(mate.url()).hash, '', 'the key leaves the address bar');
        assert.equal(await mate.locator('.nav [data-view=setup]').count(), 0, 'Setup is the owner\'s');
        await mate.locator('[data-action=show][data-show=all]').click();
        await mate.locator('.case', { hasText: 'CMS/14' }).click();
        await mate.keyboard.press('p');
        await eventually(async () => {
          const rows = await disk();
          const r = row(rows, 'CMS/14');
          return r[rows[0].indexOf('Test Status / v2.20.1')] === 'Pass' && r[rows[0].indexOf('Tested by')] === 'Priya (QA)';
        });
        await mate.reload();
        await mate.locator('.who', { hasText: 'Priya (QA)' }).waitFor(); // the invite is kept in this browser
        // The owner copies Priya's link again from Setup → Team: the same, working link.
        await page.reload();
        await page.locator('.nav [data-view=setup]').click();
        await page.locator('#team tr', { hasText: 'Priya (QA)' }).getByRole('button', { name: 'Copy link' }).click();
        await page.locator('#teamLink').waitFor();
        assert.equal(await page.locator('#teamLink').inputValue(), inv.link);
        await page.locator('[data-action=hide-link]').click();
        const boss = await api('/api/team/people', { name: 'Manager', role: 'viewer' });
        await mate.goto(boss.link);
        await mate.locator('.banner', { hasText: 'View only.' }).waitFor();
        await mate.locator('.nav [data-view=summary]').click();
        await mate.locator('.kpi', { hasText: 'executed' }).waitFor();
        await api('/api/team/people/remove', { id: (await fetch(base + 'api/team', { headers: { 'X-Test-Run': '1' } }).then((x) => x.json())).people.find((p) => p.name === 'Manager').id });
        await mate.reload();
        await mate.getByText('Your invite link no longer works').waitFor();
      } finally {
        await mate.close();
        pages.close();
        await api('/api/team', { enabled: false });
      }
    });

    await t.test('a comment and issue link typed first are saved with the result, and the next case in the list opens', async () => {
      await page.locator('.nav [data-view=run]').click();
      await page.locator('[data-action=show][data-show=all]').click();
      await page.locator('.case', { hasText: 'CMS/02' }).click();
      const order = await page.locator('.case').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
      const next = order[order.indexOf('CMS/02') + 1];
      await page.locator('#comment').fill('Labels missing on Pincode');
      await page.locator('#issue').fill('https://github.com/org/repo/issues/812');
      await page.locator('.sbtn', { hasText: 'Fail' }).click();
      await page.locator(`.case.sel[data-key="${next}"]`).waitFor();
      await eventually(async () => {
        const rows = await disk();
        const r = row(rows, 'CMS/02');
        return r[rows[0].indexOf('Test Status / v2.20.1')] === 'Fail' && r[rows[0].indexOf('Comment / v2.20.1')] === 'Labels missing on Pincode' && /#812/.test(r[rows[0].indexOf('Linked issue')]);
      });
      // Pass on the next one moves to the one after it, whatever its result
      const after = order[order.indexOf(next) + 1];
      await page.keyboard.press('p');
      await page.locator(`.case.sel[data-key="${after}"]`).waitFor();
      // A failure with nothing typed stays open for the comment; pressing it again after typing saves and moves on
      await page.keyboard.press('f');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'comment');
      await page.locator('#issue').fill('https://github.com/org/repo/issues/900');
      await page.locator('.sbtn.on', { hasText: 'Fail' }).click();
      await page.locator(`.case.sel[data-key="${order[order.indexOf(after) + 1]}"]`).waitFor();
      await eventually(async () => {
        const rows = await disk();
        const r = row(rows, after);
        return r[rows[0].indexOf('Test Status / v2.20.1')] === 'Fail' && r[rows[0].indexOf('Linked issue')] === '#900';
      });
    });

    await t.test('Known issues lists each issue with its test cases; title and priority can be typed', async () => {
      await page.locator('.nav [data-view=issues]').click();
      const tr = page.locator('table.issues tr', { hasText: '#812' });
      await tr.locator('[data-action=open-case]', { hasText: 'CMS/02' }).waitFor();
      assert.equal(await tr.locator('a', { hasText: '#812' }).getAttribute('href'), 'https://github.com/org/repo/issues/812');
      await tr.locator('[data-action=issue-edit]').click();
      await page.locator('#ieTitle').fill('Pincode labels missing');
      await page.locator('#iePriority').selectOption('P1');
      await page.locator('[data-action=issue-save]').click();
      await page.locator('table.issues tr', { hasText: 'Pincode labels missing' }).locator('.pill', { hasText: 'P1' }).waitFor();
      await page.locator('table.issues [data-action=open-case]', { hasText: 'CMS/02' }).first().click();
      await page.locator('.case.sel', { hasText: 'CMS/02' }).waitFor();
      await page.locator('.issue-chip', { hasText: 'Pincode labels missing' }).waitFor();
      await page.locator('[data-action=show][data-show=todo]').click();
    });

    await t.test('summary: page, export file, download', async () => {
      const s = await browser.newPage();
      await s.goto(`${base}summary.html?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await s.locator('.kpi', { hasText: 'executed' }).waitFor();
      await s.getByText('Open failures').waitFor();
      await s.close();
      await page.locator('.nav [data-view=summary]').click();
      const [exported] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export summary' }).click()]);
      assert.match(exported.suggestedFilename(), /\.html$/);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
      assert.equal(download.suggestedFilename(), BOOK);
    });

    await t.test('import another workbook and switch to it', async () => {
      const other = join(mkdtempSync(join(tmpdir(), 'testrun-imp-')), 'Bomet Test Cases.xlsx');
      writeFileSync(other, await buildSampleXlsx());
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import' }).first().click()]);
      await chooser.setFiles(other);
      await page.locator('#bookPick option:checked', { hasText: 'Bomet Test Cases' }).waitFor({ state: 'attached' });
      await page.getByText('Welcome.').waitFor();
      assert.ok(existsSync(join(sheets, 'Bomet Test Cases.xlsx')));
    });

    await t.test('a read-only workbook file says so', async () => {
      await page.locator('#bookPick').selectOption(BOOK);
      await page.locator('.path-title').first().waitFor();
      chmodSync(file, 0o444);
      server.library.open.delete(BOOK);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.keyboard.press('p');
      await page.locator('.banner', { hasText: 'View only.' }).waitFor();
      chmodSync(file, 0o644);
    });

    assert.deepEqual(errors, [], 'no script errors on the page');
  } finally {
    await browser.close();
    server.close();
  }
});

async function eventually(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.fail('The workbook did not reach the expected state in time');
}
