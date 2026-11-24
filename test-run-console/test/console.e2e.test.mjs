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
import { makeFakeGh } from '../dev/fake-tools.mjs';

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
  // a fake GitHub: nothing is published for real; it knows the issues the steps below link
  const gh = makeFakeGh(mkdtempSync(join(tmpdir(), 'testrun-gh-')), { issues: {
    'https://github.com/org/repo/issues/812': { title: 'Pincode labels missing', priority: 'P1' },
    'https://github.com/org/repo/issues/930': { title: 'Reject reasons list is empty', labels: ['P2'] },
  } });
  const server = createServer({ sheetsDir: sheets, ghPath: gh.bin, repo: { owner: 'org', repo: 'tools' }, publishPrefix: 'test-run-console/', dataBranch: 'test-run-data', publishedDir: join(sheets, 'no-published-data'), cloneDir: join(sheets, 'no-clone') });
  const base = await server.listenOn(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const disk = async (path = file, tab = TAB) => (await XBook.fromFile(path, 'x')).getSheetByName(tab).getDataRange().getDisplayValues();
  const row = (rows, id) => rows.find((r) => r[0] === id);
  // The console's dropdowns (dropdown() in ui/client.js): a button that reads the choice, and a list under it.
  const ddValue = (p, id) => p.locator(`#${id} > .grow`).textContent();
  const ddPick = async (p, id, label) => {
    await p.locator(`#${id}`).click();
    await p.locator('.multi-pop .dd-item', { has: p.locator('.dd-label').getByText(label, { exact: true }) }).click();
  };
  const ddOptions = async (p, id) => {
    await p.locator(`#${id}`).click();
    const all = await p.locator('.multi-pop .dd-item .dd-label').allTextContents();
    await p.keyboard.press('Escape');
    return all;
  };

  try {
    await t.test('first run opens Setup; Save stays on Setup with a message; Run shows paths', async () => {
      await page.goto(base);
      await page.getByText('Welcome.').waitFor();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.toast', { hasText: 'Setup saved.' }).waitFor();
      await page.locator('.nav [data-view=setup][aria-current=page]').waitFor();
      await page.getByText('Welcome.').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.subtab[aria-selected=true]', { hasText: 'Workbook' }).count(), 1, 'still on Setup → Workbook');
      await page.locator('.nav [data-view=run]').click();
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
      await page.locator('.toast', { hasText: 'Test status cleared for CMS/09.' }).first().waitFor();
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
      await page.locator('[data-action=save-case]', { hasText: 'Save' }).click();
      await eventually(async () => {
        const r = row(await disk(), 'CMS/10');
        return r[1] === 'Verify if the LME is able to resolve an assigned complaint, with or without a photo' && r[8] === 'Updated: Photo is optional from 2.20';
      });
      await page.locator('.case.sel', { hasText: 'with or without a photo' }).waitFor();

      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.getByRole('button', { name: '⧉ Mark Duplicate' }).click();
      await page.locator('#dupOf').fill('CMS/10');
      await page.locator('#dupPreview', { hasText: 'Keeps CMS/10' }).waitFor();
      await page.getByRole('button', { name: 'Mark as duplicate' }).click();
      await eventually(async () => row(await disk(), 'CMS/12')[8] === 'Duplicate of CMS/10' && struck('CMS/12'));
      await page.locator('.case.retired', { hasText: 'CMS/12' }).locator('.pill', { hasText: 'Duplicate of CMS/10' }).waitFor();
      await page.locator('.progress-wrap', { hasText: '1 retired' }).waitFor();
      assert.equal(await struck('CMS/10'), false, 'the kept case is not struck');

      await page.locator('.case', { hasText: 'CMS/13' }).click();
      await page.getByRole('button', { name: '⊘ Deprecated' }).click();
      await page.locator('#retireReason').fill('Rating moved to the feedback survey');
      await page.locator('button[data-action=retire]').click();
      await eventually(async () => row(await disk(), 'CMS/13')[8] === 'Deprecated: Rating moved to the feedback survey' && struck('CMS/13'));
      assert.equal(row(await disk(), 'CMS/13')[1], 'Verify if the citizen can rate a resolved complaint', 'the text stays in the workbook');

      const s = await browser.newPage();
      await s.goto(`${base}summary.html?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await s.locator('.kpi', { hasText: 'executed' }).waitFor();
      assert.equal(await s.getByText('Rating moved to the feedback survey').count(), 0, 'retired cases are left out of the summary');
      assert.equal(await s.getByText(/retired/i).count(), 0);
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
      await page.locator('.finding', { hasText: 'F-001' }).getByRole('button', { name: 'Create test case' }).click();
      const scen = page.locator('.writeup textarea').first();
      assert.equal(await scen.inputValue(), 'Citizen cannot reopen a complaint resolved 4 days ago', 'starts from the finding');
      await scen.fill('Verify that citizen can reopen a complaint resolved 4 days ago');
      await page.locator('.writeup .issue-chip', { hasText: '#77' }).waitFor(); // the finding's bug, as a tag
      await page.locator('[data-action=writeup-add]', { hasText: 'Save' }).click();
      await page.locator('.toast', { hasText: `F-001 added to ${TAB} as CMS/19` }).waitFor();
      const r = row(await disk(), 'CMS/19');
      assert.equal(r[1], 'Verify that citizen can reopen a complaint resolved 4 days ago');
      assert.equal(r[6], '• Reopen offered', 'the expected result Bug Reporter noted');
      assert.equal(r[7], 'Fail', 'a finding with a bug number starts as Fail');
      const hdr = (await disk())[0];
      assert.equal(r[hdr.indexOf('Linked issue')], '#77', 'its bug, in a Linked issue column added for it');
      await page.locator('[data-action=findings-show][data-show=done]', { hasText: 'Done 1' }).waitFor();
    });

    await t.test('start a new cycle from Setup', async () => {
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('#newCycle0').fill('v2.20.1');
      await page.locator('[data-action=start-cycle][data-index="0"]').click();
      await page.locator('.toast', { hasText: 'v2.20.1' }).first().waitFor();
      await page.locator('.nav [data-view=run]').click();
      await page.locator('#cyclePick > .grow', { hasText: 'Cycle v2.20.1' }).waitFor();
      assert.deepEqual((await disk())[0].slice(7, 11), ['Test Status / v2.12', 'Comment / v2.12', 'Test Status / v2.20.1', 'Comment / v2.20.1']);
      // ✎ renames a cycle (both its columns); then back, as the later steps use v2.12
      await page.locator('.nav [data-view=setup]').click();
      for (const [from, to] of [['v2.12', 'v2.12 retest'], ['v2.12 retest', 'v2.12']]) {
        await page.locator(`.cycle-chip:has-text("Test Status / ${from}") [data-action=cycle-rename]`).first().click();
        await page.locator('#cycRename').fill(to);
        await page.locator('#cycRename').press('Enter');
        await page.locator('.toast', { hasText: `Renamed the cycle ${from} to ${to}` }).waitFor();
        await eventually(async () => (await disk())[0][7] === `Test Status / ${to}` && (await disk())[0][8] === `Comment / ${to}`);
      }
      await page.locator('.nav [data-view=run]').click();
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
        await mate.locator('.access-card', { hasText: 'Sign in to Test Run' }).waitFor();
        await api('/api/team', { enabled: true, mode: 'fixed', fixedUrl: base.replace(/\/$/, ''), hostedUrl: hosted });
        await api('/api/call/api_addColumns', { book: BOOK, args: [TAB, ['testedBy']] });
        const inv = await api('/api/team/people', { name: 'John Doe (QA)', role: 'tester' });
        assert.match(inv.link, new RegExp(`^${hosted}#join=[\\w-]+&server=`));
        await mate.goto(inv.link);
        await mate.locator('.user-btn[title="John Doe (QA) · Updates status"]').waitFor();
        assert.equal(new URL(mate.url()).hash, '', 'the key leaves the address bar');
        assert.equal(await mate.locator('.nav [data-view=setup]').count(), 0, 'Setup is the owner\'s');
        await mate.locator('[data-action=show][data-show=all]').click();
        await mate.locator('.case', { hasText: 'CMS/14' }).click();
        await mate.keyboard.press('p');
        await eventually(async () => {
          const rows = await disk();
          const r = row(rows, 'CMS/14');
          return r[rows[0].indexOf('Test Status / v2.20.1')] === 'Pass' && r[rows[0].indexOf('Tested by')] === 'John Doe (QA)';
        });
        await mate.reload();
        await mate.locator('.user-btn', { hasText: 'John Doe (QA)' }).waitFor(); // the invite is kept in this browser
        // Hovering the name shows the role and Sign out; signing out forgets the link in this browser
        await mate.locator('.user-btn').hover();
        await mate.locator('.user-pop', { hasText: 'Updates status' }).waitFor();
        // Test Run asks in its own popup (not the browser's box); Escape cancels, Sign out goes ahead
        await mate.locator('.user-pop [data-action=sign-out]').click();
        await mate.locator('#modal .modal-box.confirm h2', { hasText: 'Sign out of Test Run in this browser?' }).waitFor();
        await mate.keyboard.press('Escape');
        await mate.locator('#modal').waitFor({ state: 'hidden' });
        assert.equal(await mate.locator('.user-btn', { hasText: 'John Doe (QA)' }).count(), 1, 'Escape keeps you signed in');
        await mate.locator('.user-btn').hover();
        await mate.locator('.user-pop [data-action=sign-out]').click();
        await mate.locator('#modal [data-action=confirm-yes]', { hasText: 'Sign out' }).click();
        await mate.locator('.access-card', { hasText: 'You are signed out' }).waitFor();
        await mate.reload();
        await mate.locator('.access-card', { hasText: 'Sign in to Test Run' }).waitFor();
        assert.equal(await mate.locator('.user-btn').count(), 0, 'still signed out after a reload');
        await mate.goto(inv.link);
        await mate.locator('.user-btn', { hasText: 'John Doe (QA)' }).waitFor();
        // The owner copies John Doe's link again from Setup → Team: the same, working link, straight to the clipboard.
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') });
        const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
        await page.reload();
        await page.locator('.nav [data-view=setup]').click();
        await page.locator('[data-action=setup-part][data-part=sharing]').click();
        const johnDoeRow = page.locator('#team tr', { hasText: 'John Doe (QA)' });
        assert.equal(await johnDoeRow.locator('[data-change=team-role] option:checked').textContent(), 'Update status');
        assert.equal(await page.locator('#team th', { hasText: 'Access' }).count(), 1, 'the column is Access');
        // Adding someone: their access starts blank ("Select access") and must be chosen; workbooks start at All
        assert.equal(await page.locator('#teamRole option:checked').textContent(), 'Select access');
        assert.equal(await page.locator('#teamBooks option:checked').textContent(), 'All workbooks');
        assert.equal(await page.locator('#team th', { hasText: 'Workbooks' }).count(), 1);
        assert.equal(await johnDoeRow.locator('[data-change=team-books] option:checked').textContent(), 'All workbooks');
        await page.locator('#teamName').fill('Nobody yet');
        await page.getByRole('button', { name: 'Add and make a link' }).click();
        await page.locator('.toast', { hasText: 'Choose their access first.' }).waitFor();
        await page.locator('#teamName').fill('');
        await johnDoeRow.getByRole('button', { name: 'Copy link' }).click();
        await page.locator('.toast', { hasText: "John Doe (QA)'s invite link is copied" }).waitFor();
        assert.equal(await clipboard(), inv.link);
        assert.equal(await page.locator('#teamLink').count(), 0, 'no link box: it is on the clipboard');
        // New link: made, copied, toast; the old link stops working
        await johnDoeRow.getByRole('button', { name: 'New link' }).click();
        await page.locator('#modal h2', { hasText: 'Make a new link for John Doe (QA)?' }).waitFor();
        await page.locator('#modal [data-action=confirm-yes]', { hasText: 'Make new link' }).click();
        const made = page.locator('.toast', { hasText: 'New link made' });
        await made.waitFor();
        await made.locator('.toast-x').click(); // ✕ closes a message straight away
        await made.waitFor({ state: 'detached' });
        const fresh = await clipboard();
        assert.ok(fresh.startsWith(hosted) && fresh !== inv.link, fresh);
        assert.equal(await page.locator('#teamLink').count(), 0);
        const boss = await api('/api/team/people', { name: 'Manager', role: 'viewer' });
        await mate.goto(boss.link);
        await mate.locator('.banner', { hasText: 'View only.' }).waitFor();
        await mate.locator('.nav [data-view=summary]').click();
        await mate.locator('.kpi', { hasText: 'executed' }).waitFor();
        await api('/api/team/people/remove', { id: (await fetch(base + 'api/team', { headers: { 'X-Test-Run': '1' } }).then((x) => x.json())).people.find((p) => p.name === 'Manager').id });
        await mate.reload();
        await mate.locator('.access-card', { hasText: 'Your access link no longer works' }).waitFor();
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

    await t.test('Known issues: opening it gets the latest from GitHub (title, state, priority); each issue lists its test cases', async () => {
      await page.locator('.nav [data-view=issues]').click();
      const tr = page.locator('table.issues tr', { hasText: '#812' });
      await tr.locator('[data-action=open-case]', { hasText: 'CMS/02' }).waitFor();
      assert.equal(await tr.locator('a', { hasText: '#812' }).getAttribute('href'), 'https://github.com/org/repo/issues/812');
      await page.locator('table.issues tr', { hasText: 'Pincode labels missing' }).locator('.pill', { hasText: 'P1' }).waitFor();
      await page.locator('.spin-wrap.busy').waitFor({ state: 'detached' }); // the table is greyed out under a spinner meanwhile
      assert.ok(readFileSync(gh.log, 'utf8').includes('"graphql":"https://github.com/org/repo/issues/812"'), 'GitHub was asked');
      assert.equal(await page.locator('[data-action=issue-edit]').count(), 0, 'nothing to type here: it comes from GitHub');
      await tr.locator('[data-action=open-case]', { hasText: 'CMS/02' }).click();
      await page.locator('.case.sel', { hasText: 'CMS/02' }).waitFor();
      // on the case, an issue tag shows the issue number only; the title shows on hover
      const chip = page.locator('.detail .issue-chip', { hasText: '#812' });
      await chip.waitFor();
      assert.equal(await chip.locator('a').getAttribute('title'), '#812: Pincode labels missing');
      assert.equal(await page.locator('.detail .issue-chip', { hasText: 'Pincode labels missing' }).count(), 0);
      await page.locator('[data-action=show][data-show=todo]').click();
    });

    await t.test('a case can have several issues: Enter adds the link as a tag, ✕ removes it', async () => {
      await page.locator('[data-action=show][data-show=all]').click();
      await page.locator('.case', { hasText: 'CMS/03' }).click();
      const linked = async () => { const rows = await disk(); return row(rows, 'CMS/03')[rows[0].indexOf('Linked issue')]; };
      for (const n of [812, 900]) {
        await page.locator('#issue').fill(`https://github.com/org/repo/issues/${n}`);
        await page.locator('#issue').press('Enter');
        await page.locator('.detail .issue-chip', { hasText: `#${n}` }).waitFor();
      }
      assert.equal(await page.locator('#issue').inputValue(), '', 'the field empties for the next one');
      await eventually(async () => (await linked()) === '#812, #900');
      await page.locator('.detail [data-action=issue-unlink][data-ref="https://github.com/org/repo/issues/812"]').click();
      await page.locator('.toast', { hasText: 'Removed #812 from CMS/03.' }).waitFor();
      await eventually(async () => (await linked()) === '#900');
      await page.locator('[data-action=show][data-show=todo]').click();
    });

    await t.test('+ Add issue on Known issues: an issue logged elsewhere goes on a test case, or is kept as a finding', async () => {
      assert.equal(await page.locator('.topbar [data-action=add-issue]').count(), 0, 'not in the top bar');
      await page.locator('.nav [data-view=issues]').click();
      await page.locator('.section-head', { hasText: 'Known issues' }).getByRole('button', { name: '+ Add issue' }).click();
      await page.locator('.card h3', { hasText: 'New issue' }).waitFor();
      await page.locator('[data-action=add-issue-save]').click();
      await page.locator('.toast', { hasText: 'Please enter issue’s link before saving' }).waitFor();
      assert.equal(await page.locator('#aiTitle, #aiPriority').count(), 0, 'no title or priority to type: they come from GitHub');
      await page.locator('#aiUrl').fill('https://github.com/org/repo/issues/930');
      // one issue on several test cases: the Test cases dropdown takes more than one
      await page.locator('#aiCasesBtn').click();
      for (const id of ['CMS/09', 'CMS/10']) {
        await page.locator('#ddQ').fill(id);
        await page.locator('.multi-pop label.check', { hasText: id }).click();
      }
      await page.keyboard.press('Escape');
      assert.equal(await ddValue(page, 'aiCasesBtn'), '2 Selected');
      assert.deepEqual(await page.locator('.filter-tag').allTextContents(), ['CMS/09✕', 'CMS/10✕']);
      const markIt = page.locator('input[data-bind=aiFail]');
      assert.equal(await markIt.isChecked(), true, 'marking them failed is the default');
      await page.locator('[data-action=add-issue-save]').click();
      await page.locator('.toast', { hasText: 'Linked to CMS/09, CMS/10 and marked failed' }).waitFor();
      await eventually(async () => {
        const rows = await disk();
        return ['CMS/09', 'CMS/10'].every((id) => row(rows, id)[rows[0].indexOf('Test Status / v2.20.1')] === 'Fail' && /#930/.test(row(rows, id)[rows[0].indexOf('Linked issue')]));
      });
      // Without a test case it is kept as a finding (any tracker's link)
      await page.locator('.section-head [data-action=add-issue]').click();
      await page.locator('#aiUrl').fill('https://tracker.example.org/browse/CMS-55');
      await page.locator('[data-action=add-issue-save]').click();
      await page.locator('.toast', { hasText: /Kept as finding F-\d+/ }).waitFor();
      assert.equal(await page.locator('#aiUrl').count(), 0, 'the form closes');
      // a form left open closes when you go to another page, and what was typed goes
      await page.locator('.section-head [data-action=add-issue]').click();
      await page.locator('#aiUrl').fill('https://github.com/org/repo/issues/999');
      await page.locator('.nav [data-view=run]').click();
      await page.locator('.nav [data-view=issues]').click();
      assert.equal(await page.locator('#aiUrl').count(), 0, 'closed after leaving the page');
      await page.locator('table.issues tr', { hasText: 'Reject reasons list is empty' }).locator('[data-action=open-case]', { hasText: 'CMS/09' }).waitFor();
      await page.locator('table.issues tr', { hasText: 'CMS-55' }).waitFor();
      await page.locator('.nav [data-view=run]').click();
    });

    await t.test('Run shows the test type on each case, and adds a test case at the end of a section', async () => {
      await page.locator('.nav [data-view=run]').click();
      await page.locator('[data-action=show][data-show=all]').click();
      assert.equal(await page.locator('.case[data-key="CMS/01"] .pill.type').textContent(), 'UI');
      const section = page.locator('section.path', { hasText: 'CMS/01' });
      await section.getByRole('button', { name: '+ Add', exact: true }).click();
      const editor = section.locator('.add-here.open');
      await editor.locator('.tool-title', { hasText: 'New test case' }).waitFor();
      assert.equal(await editor.locator('.multi[data-dd$=":subFeature"] .multi-btn > .grow').textContent(), 'CSR Employee', 'starts in this section');
      assert.equal(await editor.getByText('Result in current test cycle').count(), 1);
      await editor.locator('textarea[data-bind$=":scenario"]').fill('Verify if the CSR sees a hint under the mobile number field');
      await editor.locator('[data-tags$=":issue"]').fill('https://github.com/org/repo/issues/931');
      await editor.locator('[data-tags$=":issue"]').press('Enter');
      await editor.locator('.issue-chip', { hasText: '#931' }).waitFor();
      await editor.locator('[data-action=add-here-save]', { hasText: 'Save' }).click();
      await page.locator('.toast', { hasText: 'Added to the workbook as CMS/' }).waitFor();
      await eventually(async () => (await disk()).some((r, i, all) => r[1] === 'Verify if the CSR sees a hint under the mobile number field' && r[2] === 'CSR Employee' && r[all[0].indexOf('Linked issue')] === '#931'));
      await page.locator('.case', { hasText: 'hint under the mobile number' }).waitFor();
      await page.locator('[data-action=show][data-show=todo]').click();
    });

    await t.test('Findings: Add finding, similar test cases suggested, covered in one click', async () => {
      await page.locator('.nav [data-view=findings]').click();
      assert.equal(await page.locator('.context').count(), 0, 'Findings lists every suite: no suite strip');
      // The Test suite filter: nothing chosen means every suite (it reads "Select"); ↻ clears a choice
      assert.equal(await ddValue(page, 'findingsSuite'), 'Select');
      assert.equal(await page.locator('[data-action=findings-suite-reset]').isDisabled(), true);
      assert.deepEqual(await ddOptions(page, 'findingsSuite'), [TAB, 'CMS 2.20.1 Features', 'Dashboard KPI'], 'no "All test suites" option');
      await ddPick(page, 'findingsSuite', 'Dashboard KPI');
      await page.locator('#findingsSuite > .grow', { hasText: 'Dashboard KPI' }).waitFor();
      await page.locator('[data-action=findings-suite-reset]').click();
      await page.locator('#findingsSuite > .grow', { hasText: 'Select' }).waitFor();
      await page.getByRole('button', { name: '+ Add finding' }).click();
      assert.equal(await ddValue(page, 'fTab'), TAB, 'the form asks which test suite');
      await page.locator('#fText').fill('The employee can clear a search from the inbox only once');
      await page.locator('[data-action=add-finding]', { hasText: 'Save' }).click();
      const card = page.locator('.finding', { hasText: 'clear a search from the inbox only once' });
      await card.locator('.similar-row', { hasText: 'CMS/07' }).waitFor();
      await card.locator('.similar-row', { hasText: 'CMS/07' }).getByRole('button', { name: 'Covered by this' }).click();
      await page.locator('.toast', { hasText: 'covered by CMS/07' }).waitFor();
      await page.locator('[data-action=findings-show][data-show=done]').click();
      await page.locator('.finding.done', { hasText: 'Covered by CMS/07' }).waitFor();
      await page.locator('[data-action=findings-show][data-show=open]').click();
      // One form at a time: opening another closes the first and drops what was typed in it
      await page.getByRole('button', { name: '+ Add finding' }).click();
      await page.locator('#fText').fill('Half typed');
      await page.getByRole('button', { name: '+ New test case' }).click();
      assert.equal(await page.locator('#fText').count(), 0, 'Add finding closed');
      await page.getByRole('button', { name: '+ New test case' }).click();
      await page.getByRole('button', { name: '+ Add finding' }).click();
      assert.equal(await page.locator('#fText').inputValue(), '', 'what was typed is gone');
      await page.getByRole('button', { name: '+ Add finding' }).click();
      // + New test case opens one form; pressed again, it closes
      const newCase = page.getByRole('button', { name: '+ New test case' });
      await newCase.click();
      await newCase.click();
      assert.equal(await page.locator('h3', { hasText: 'New test case' }).count(), 0);
      await newCase.click();
      assert.equal(await page.locator('h3', { hasText: 'New test case' }).count(), 1);
      // ... for any test suite: the form follows the suite picked
      await ddPick(page, 'manTab', 'Dashboard KPI');
      await page.locator('.loading').first().waitFor({ state: 'detached' }).catch(() => {});
      await page.locator('#manTab > .grow', { hasText: 'Dashboard KPI' }).waitFor();
      await page.locator('[data-bind="man:0:scenario"]').waitFor();
      await newCase.click();
    });

    await t.test('Setup has Workbook and Sharing parts; cycles come before the columns', async () => {
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('[data-action=setup-part][data-part=workbook]').click();
      const card = page.locator('section.card', { hasText: 'Test cycles' }).first();
      const order = await card.evaluate((el) => [...el.querySelectorAll('h3, details.columns > summary')].map((x) => x.textContent.trim().split(' ')[0]));
      assert.deepEqual(order.slice(0, 2), ['Test', 'Columns'], 'cycles first, then the folded columns');
      assert.equal(await card.locator('details.columns').evaluate((d) => d.open), false, 'columns folded once saved');
      assert.equal(await page.locator('#team').count(), 0);
      await page.locator('[data-action=setup-part][data-part=sharing]').click();
      await page.locator('#team').waitFor();
      await page.locator('[data-action=setup-part][data-part=workbook]').click();
      await page.locator('.nav [data-view=run]').click();
    });

    await t.test('the host publishes; anyone sees the published reports on the hosted page, with a bar for their access link', async () => {
      // Publish from Setup → Publish
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('[data-action=setup-part][data-part=publish]').click();
      await page.locator('#publish .note.warn', { hasText: 'Published workbooks are public' }).waitFor();
      // Choices apply once saved; a change to the workbooks asks first
      const save = page.getByRole('button', { name: 'Save preferences' });
      assert.equal(await save.isDisabled(), true, 'nothing changed yet');
      const tick = page.locator(`#publish [data-action=publish-book][data-name="${BOOK}"]`);
      await tick.check();
      assert.equal(await save.isDisabled(), false);
      assert.equal(await page.getByRole('button', { name: 'Publish now' }).isDisabled(), true, 'save first');
      await save.click();
      await page.locator('.modal-box', { hasText: 'Update the published reports?' }).waitFor();
      await page.locator('.modal-box').getByRole('button', { name: 'Cancel' }).click();
      assert.equal(await tick.isChecked(), false, 'Cancel undoes the change');
      assert.equal(await save.isDisabled(), true);
      await tick.check();
      await save.click();
      await page.locator('.modal-box', { hasText: 'The workbooks you ticked are published' }).waitFor();
      assert.equal(await page.locator('.modal-box', { hasText: 'CMS Sign Off' }).count(), 0, 'no workbook names');
      await page.locator('.modal-box').getByRole('button', { name: 'Save and update the site' }).click();
      await page.locator('.toast', { hasText: 'Published to GitHub' }).waitFor();
      assert.equal(await save.isDisabled(), true, 'saved');
      assert.ok(gh.readRepo('test-run-data').files['reports/index.json'], 'the reports are on the data branch');
      // Space on GitHub Pages, measured from what was published
      await page.locator('#publish .space-meter .space-bar[role=img]').waitFor();
      await page.locator('#publish .space-meter', { hasText: /\d+ (KB|MB) of 1 GB · workbooks \d+ (KB|MB) · reports \d+ (KB|MB)/ }).waitFor();
      assert.equal(await page.locator('#publish .space-meter .note.warn').count(), 0, 'far below the limit');
      await page.locator('#publish', { hasText: 'one commit, replaced at each publish' }).waitFor();
      // The hosted page (another origin), serving the published reports like GitHub Pages
      const ui = new URL('../ui/', import.meta.url).pathname;
      const reportsDir = join(sheets, '.testrun', 'published');
      const pages = http.createServer((req, res) => {
        const p = req.url.split('?')[0].replace(/^\//, '') || 'index.html';
        const f = p.startsWith('reports/') ? join(reportsDir, p.slice('reports/'.length)) : join(ui, p);
        if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'text/html' });
        res.end(readFileSync(f));
      });
      await new Promise((r) => pages.listen(0, '127.0.0.1', r));
      const hosted = `http://127.0.0.1:${pages.address().port}/`;
      const visitor = await (await browser.newContext()).newPage();
      visitor.on('pageerror', (e) => errors.push(e.message));
      try {
        await visitor.goto(hosted);
        await visitor.locator('.access-card', { hasText: 'Sign in to Test Run' }).waitFor();
        await visitor.locator('.topbar #rBook > .grow', { hasText: 'CMS Sign Off (sample)' }).waitFor();
        assert.equal(await visitor.locator('.topbar .nav').count(), 0, 'no screen tabs without an access link');
        assert.equal(await visitor.locator('.rail-content h1, main h1').count(), 0, 'no second title: the suite is picked above');
        await visitor.locator('.report-tools .updated', { hasText: /^Updated on: / }).waitFor();
        await visitor.locator('.topbar #rCycle').waitFor();
        const dl = visitor.locator('.report-tools a[download]', { hasText: 'Download' });
        assert.match(await dl.getAttribute('href'), /^reports\/.+\.xlsx$/);
        const [download] = await Promise.all([visitor.waitForEvent('download'), dl.click()]);
        assert.match(download.suggestedFilename(), /^CMS Sign Off \(sample\)\.xlsx$/);
        assert.equal(await visitor.getByText('Back to Test Run').count(), 0);
        await visitor.locator('.kpi', { hasText: 'executed' }).waitFor();
        await visitor.locator('.ctx-tab', { hasText: 'CMS 2.20.1 Features' }).click();
        await visitor.locator('.ctx-tab.on', { hasText: 'CMS 2.20.1 Features' }).waitFor();
        await visitor.locator('.kpi', { hasText: 'executed (3 of 7)' }).waitFor();
        // A link whose Test Run is offline: the published reports, and a note
        const api = (path, body) => fetch(base + path.slice(1), { method: 'POST', headers: { 'X-Test-Run': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
        await visitor.goto(`${hosted}#join=${'k'.repeat(32)}&server=${encodeURIComponent('http://127.0.0.1:9')}`);
        await visitor.locator('.access-card', { hasText: 'Your Test Run is offline' }).waitFor();
        await visitor.locator(`.ctx-tab[data-tab="${TAB}"]`).click();
        await visitor.locator('.kpi', { hasText: 'executed' }).waitFor();
        // Pasting a working access link opens Test Run
        await api('/api/team', { enabled: true, mode: 'fixed', fixedUrl: base.replace(/\/$/, '') });
        const inv = await api('/api/team/people', { name: 'Visitor', role: 'viewer' });
        await visitor.locator('#inviteLink').fill(inv.link.replace(/^https?:\/\/[^/]+\//, hosted));
        await visitor.getByRole('button', { name: 'Sign in', exact: true }).click();
        await visitor.locator('.user-btn[title="Visitor · View only"]').waitFor();
        await visitor.locator('.nav [data-view=issues]').click();
        await visitor.locator('.section-head h2', { hasText: 'Known issues' }).waitFor();
        assert.equal(await visitor.locator('[data-action=add-issue]').count(), 0, 'viewers do not add issues');
        await api('/api/team', { enabled: false });
      } finally {
        await visitor.close();
        pages.close();
      }
      // The host can preview what anyone sees, from the laptop
      const preview = await browser.newPage();
      await preview.goto(`${base}?reports=1`);
      await preview.locator('.access-card').waitFor();
      await preview.locator('.kpi', { hasText: 'executed' }).waitFor();
      await preview.close();
      await page.locator('.nav [data-view=run]').click();
    });

    await t.test('Publish: other choices save at once; with nothing ticked the reports come down and the page shows no data', async () => {
      await page.locator('.nav [data-view=setup]').click();
      await page.locator('[data-action=setup-part][data-part=publish]').click();
      const save = page.getByRole('button', { name: 'Save preferences' });
      assert.equal(await page.getByText('When Test Run stops').count(), 0, 'no publishing on stop');
      await page.locator('#publishTime').fill('18:30');
      await save.click();
      await page.locator('.toast', { hasText: 'Preferences saved.' }).waitFor();
      assert.equal(await page.locator('#modal .modal-box').count(), 0, 'no pop-up for these');
      await page.locator(`#publish [data-action=publish-book][data-name="${BOOK}"]`).uncheck();
      await page.locator('#publish', { hasText: 'None ticked: publishing takes every published report off the site.' }).waitFor();
      await save.click();
      await page.locator('.modal-box', { hasText: 'Every published report is taken off the site.' }).waitFor();
      await page.locator('.modal-box').getByRole('button', { name: 'Save and update the site' }).click();
      await page.locator('.toast', { hasText: 'taken off GitHub' }).waitFor();
      assert.deepEqual(Object.keys(gh.readRepo('test-run-data').files), ['reports/index.json']);
      const preview = await browser.newPage();
      await preview.goto(`${base}?reports=1`);
      await preview.locator('.report-tools .updated', { hasText: 'Updated on: –' }).waitFor();
      assert.deepEqual(await preview.locator('.kpi .v').allTextContents(), ['–', '–', '–', '–']);
      assert.equal(await preview.locator('td.no-data', { hasText: 'No data available' }).count(), 2);
      await preview.close();
      await page.locator('.nav [data-view=run]').click();
    });

    await t.test('summary: updated on, Download and Print / PDF', async () => {
      const s = await browser.newPage();
      await s.goto(`${base}summary.html?book=${encodeURIComponent(BOOK)}&tab=${encodeURIComponent(TAB)}&cycle=v2.12`);
      await s.locator('.kpi', { hasText: 'executed' }).waitFor();
      await s.getByText('Open failures').waitFor();
      await s.close();
      await page.locator('.nav [data-view=summary]').click();
      await page.locator('.report-tools .updated', { hasText: /^Updated on: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/ }).waitFor();
      // a browser refresh stays on Summary
      assert.match(page.url(), /[?&]view=summary/);
      await page.reload();
      await page.locator('.nav [data-view=summary][aria-current=page]').waitFor();
      await page.locator('.report-tools .updated').waitFor();
      for (const gone of ['Open summary page', 'Export summary', 'Update summary tab']) assert.equal(await page.getByText(gone).count(), 0, gone);
      // CMS/13 is still deprecated: Summary has nothing about retired cases, here or in the top bar
      assert.equal(await page.locator('main', { hasText: /retired/i }).count(), 0, 'no Retired cases section');
      assert.equal(await page.locator('.context', { hasText: /retired/i }).count(), 0, 'no retired count on Summary');
      const tools = page.locator('main .report-tools');
      await tools.getByRole('button', { name: 'Download' }).click(); // for the host, a menu
      const [download] = await Promise.all([page.waitForEvent('download'), tools.locator('.dl-menu [data-action=download]', { hasText: 'Summary Report' }).click()]);
      assert.equal(await tools.locator('.dl-menu').count(), 0, 'the menu closes');
      assert.equal(download.suggestedFilename(), BOOK);
      const ids = (await XBook.fromFile(await download.path(), 'dl')).getSheetByName(TAB).getDataRange().getDisplayValues().map((r) => r[0]);
      assert.ok(ids.includes('CMS/13'), 'the downloaded workbook keeps the deprecated case, struck out');
      assert.ok(row(await disk(), 'CMS/13'), 'the workbook on disk keeps it');
      await tools.getByRole('button', { name: 'Print / PDF' }).waitFor();
    });

    await t.test('test case tabs are buttons under the screens, next to the test cycle', async () => {
      await page.locator('.nav [data-view=run]').click();
      const tabs = await page.locator('.context .ctx-tab').allTextContents();
      assert.deepEqual(tabs, [TAB, 'CMS 2.20.1 Features', 'Dashboard KPI']);
      assert.equal(await page.locator('.rail #search').count(), 1, 'filters in the left column');
      assert.equal(await page.locator('.rail [data-action=tier]').count(), 0, 'no Focus filter');
      assert.equal(await page.locator('.ctx-tab.on').textContent(), TAB);
      await page.locator('.ctx-tab', { hasText: 'Dashboard KPI' }).click();
      await page.locator('.ctx-tab.on', { hasText: 'Dashboard KPI' }).waitFor();
      await page.locator('.case').first().waitFor();
      await page.locator('.ctx-tab', { hasText: TAB }).first().click();
      await page.locator(`.ctx-tab.on[data-tab="${TAB}"]`).waitFor();
      await page.locator('.topbar .context #cyclePick').waitFor(); // the cycle sits with the tabs, in the sticky header
      assert.equal(await page.locator('.topbar [data-action=import], .topbar [data-action=dl-menu], .topbar [data-action=download]').count(), 0, 'no Import or Download at the top');
      await page.locator('.nav [data-view=issues]').click();
      assert.equal(await page.locator('.context').count(), 0, 'Known issues spans the whole workbook: no tab strip');
      await page.locator('.nav [data-view=run]').click();
    });

    await t.test('import several workbooks at once (one per environment), then switch between them', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'testrun-imp-'));
      const files = ['Bomet Test Cases.xlsx', 'Mozambique Test Cases.xlsx'].map((n) => join(dir, n));
      for (const f of files) writeFileSync(f, await buildSampleXlsx());
      await page.locator('.nav [data-view=setup]').click(); // Import is in Setup › Workbook
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('main').getByRole('button', { name: 'Import' }).click()]);
      assert.equal(chooser.isMultiple(), true);
      await chooser.setFiles(files);
      await page.locator('#bookPick > .grow', { hasText: 'Bomet Test Cases' }).waitFor();
      await page.getByText('Welcome.').waitFor();
      assert.ok(existsSync(join(sheets, 'Bomet Test Cases.xlsx')) && existsSync(join(sheets, 'Mozambique Test Cases.xlsx')));
      assert.equal((await ddOptions(page, 'bookPick')).length, 3);
      assert.match(await page.locator('#bookPick .dd-prefix').textContent(), /Workbook\s*3/);
    });

    await t.test('the host deletes a workbook from Setup, after a pop-up saying it cannot be undone', async () => {
      await ddPick(page, 'bookPick', 'Mozambique Test Cases');
      await page.locator('#bookPick > .grow', { hasText: 'Mozambique Test Cases' }).waitFor();
      await page.locator('.nav [data-view=setup]').click();
      const del = page.getByRole('button', { name: 'Delete', exact: true });
      assert.equal(await del.locator('xpath=..').getByRole('button', { name: 'Save', exact: true }).count(), 1, 'beside Save');
      await del.click();
      await page.locator('.modal-box', { hasText: 'This cannot be undone.' }).waitFor();
      await page.locator('.modal-box').getByRole('button', { name: 'Cancel' }).click();
      assert.ok(existsSync(join(sheets, 'Mozambique Test Cases.xlsx')), 'Cancel keeps it');
      await del.click();
      await page.locator('.modal-box').getByRole('button', { name: 'Delete workbook' }).click();
      await page.locator('.toast', { hasText: 'Deleted Mozambique Test Cases' }).waitFor();
      assert.equal(existsSync(join(sheets, 'Mozambique Test Cases.xlsx')), false);
      await eventually(async () => (await page.locator('#bookPick .dd-prefix').textContent()).includes('2'));
      assert.deepEqual((await ddOptions(page, 'bookPick')).filter((x) => /Mozambique/.test(x)), []);
    });

    await t.test('a read-only workbook file says so', async () => {
      await ddPick(page, 'bookPick', BOOK.replace(/\.xlsx$/, ''));
      await page.locator('.path-title').first().waitFor();
      chmodSync(file, 0o444);
      server.library.open.delete(BOOK);
      await page.locator('[data-action=show][data-show=all]').click();
      await page.locator('.case', { hasText: 'CMS/12' }).click();
      await page.keyboard.press('p');
      await page.locator('.banner', { hasText: 'View only.' }).waitFor();
      chmodSync(file, 0o644);
    });

    await t.test('Setup: × removes an earlier test cycle, after a pop-up saying it cannot be undone', async () => {
      server.library.open.delete(BOOK); // writable again
      await page.reload();
      await page.locator('.nav [data-view=setup]').click();
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: TAB, exact: true }) });
      await card.locator('.cycle-chip', { hasText: 'v2.12' }).locator('[data-action=cycle-remove]').click();
      await page.locator('.modal-box', { hasText: 'This cannot be undone.' }).waitFor();
      await page.locator('.modal-box').getByRole('button', { name: 'Remove cycle' }).click();
      await page.locator('.toast', { hasText: 'Removed the cycle' }).waitFor();
      await eventually(async () => !(await disk())[0].some((h) => /v2\.12/.test(h)));
      await card.locator('.cycle-chip', { hasText: 'v2.20.1' }).waitFor();
      assert.equal(await card.locator('.cycle-chip').count(), 1);
      assert.equal(await card.locator('[data-action=cycle-remove]').count(), 0, 'the last cycle stays');
      await page.locator('.nav [data-view=run]').click();
      assert.deepEqual(await ddOptions(page, 'cyclePick'), ['Cycle v2.20.1']);
    });

    await t.test('a tab name Excel cut at 31 characters shows with …', async () => {
      const shown = await page.evaluate(() => [
        'CMS Sign Off - CMS Automation (', // cut mid-way: the open bracket is left
        'Inbox - search and filters for ', // cut on a space
        'Inbox (employee) search filters', // 31 characters, but complete
        'CMS 2.20.1',
      ].map((n) => window.TR.tabLabel(n)));
      assert.deepEqual(shown, ['CMS Sign Off - CMS Automation…', 'Inbox - search and filters for…', 'Inbox (employee) search filters', 'CMS 2.20.1']);
      assert.equal(await page.locator('[data-action=tab-rename]').count(), 0, 'no Rename');
    });

    await t.test('the Workbook picker keeps one width, whatever the names', async () => {
      // measured once the page has settled (a redraw can replace the picker mid-measure)
      const width = async () => {
        await page.waitForFunction(() => { const e = document.querySelector('#bookPick'); return e && e.isConnected && e.getBoundingClientRect().width > 0; });
        return page.locator('#bookPick').evaluate((e) => Math.round(e.getBoundingClientRect().width));
      };
      const w1 = await width();
      await ddPick(page, 'bookPick', 'Bomet Test Cases');
      await page.locator('#bookPick > .grow', { hasText: 'Bomet Test Cases' }).waitFor();
      await page.getByText('Welcome.').waitFor(); // its Setup has opened
      assert.deepEqual([w1, await width()], [340, 340]);
      // its list is as wide as the field
      await page.locator('#bookPick').click();
      const pop = await page.locator('.multi-pop').evaluate((e) => Math.round(e.getBoundingClientRect().width));
      await page.keyboard.press('Escape');
      assert.equal(pop, 340);
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
