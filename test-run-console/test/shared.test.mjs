// The page helpers in ui/shared.js that read cells written on several lines.
// Every text below is made up; the shapes are the ones legacy sheets use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../ui/shared.js', import.meta.url), 'utf8'), ctx);
const TR = ctx.TR;
const items = (t) => JSON.parse(JSON.stringify(TR.cellItems(t)));

test('lines: trailing spaces and blank edges go, a run of blank lines stays one', () => {
  assert.deepEqual([...TR.cellLines('\n\n a  \r\n\n\n b \n\n')], [' a', '', ' b']);
});

test('one item per line when each line is its own statement', () => {
  assert.deepEqual(items('Field A shall show a hint \nField B shall show Required'), {
    intro: '', items: [{ text: 'Field A shall show a hint', num: false }, { text: 'Field B shall show Required', num: false }],
  });
});

test('bullets and numbers start items; bullet marks go, numbers stay', () => {
  assert.deepEqual(items('• one\n- two\n* three').items.map((i) => i.text), ['one', 'two', 'three']);
  assert.deepEqual(items('Then:\n1.Rate\n2,Reopen\n3) Close'), {
    intro: 'Then:', items: [{ text: '1.Rate', num: true }, { text: '2,Reopen', num: true }, { text: '3) Close', num: true }],
  });
  assert.equal(items('-5 degrees is refused').items[0].text, '-5 degrees is refused', 'a minus sign is not a bullet');
});

test('a line that carries on the one before it is not a new item', () => {
  assert.deepEqual(items('"Could not save, try again later.\n" message shall be shown').items.map((i) => i.text), ['"Could not save, try again later." message shall be shown'], 'closing quote');
  assert.deepEqual(items('The list shall show complaints\nassigned to the user').items.map((i) => i.text), ['The list shall show complaints assigned to the user'], 'lower case');
  assert.deepEqual(items('Hello Citizen, \nYour request <id> was received.').items.map((i) => i.text), ['Hello Citizen,\nYour request <id> was received.'], 'a letter keeps its line break');
});

test('an intro ending in ":" is kept above its items, only when there are several', () => {
  assert.deepEqual(items('The user can open:\nInbox\nReports\nSettings').intro, 'The user can open:');
  assert.equal(items('Note:\nOnly one line').intro, '', 'two lines are just two items');
});

test('html: one line stays text, several become a list, expected results are always bullets', () => {
  assert.equal(TR.cellHtml('Logged in as GRO'), '<span class="ml">Logged in as GRO</span>');
  assert.match(TR.cellHtml('Phone\nName'), /^<ul class="bullets"><li><span class="ml">Phone<\/span><\/li><li>/);
  assert.match(TR.cellHtml('Shown', true), /^<ul class="bullets">/);
  assert.match(TR.cellHtml('Opens:\nA\nB', true), /<li><div><span class="ml">Opens:<\/span><ul class="bullets">/);
  assert.equal(TR.cellHtml('  \n '), '');
  assert.doesNotMatch(TR.cellHtml('<b>x</b>\ny'), /<b>/, 'escaped');
});
