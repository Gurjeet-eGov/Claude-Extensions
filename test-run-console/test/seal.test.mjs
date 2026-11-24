// Locked automated results (lib/automation/seal.mjs): identities derived from invite keys, the
// same in Node and in the browser copy (ui/vendor/age.js); who a run is locked to; a sealed run
// opens for its recipients only; a re-locked run doesn't open with a revoked key; the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newKey, normalizeTeam, hashKey } from '../lib/team.mjs';
import { identityFromKey, recipientOf, recipientsFor, sealRun, openRun, sealRuns, SealCache, keyBytes, IDENTITY, cleanLock, newIdentity, isAutomationPath } from '../lib/automation/seal.mjs';

const browserAge = await import('../ui/vendor/age.js');

const person = (id, extra = {}) => { const key = newKey(); return { id, name: id, role: 'tester', hash: hashKey(key), key, ...extra }; };
const RUN = { id: '20261124-101500-abcdef', suiteId: 'cms', attach: { book: 'CMS.xlsx', tab: 'CMS 2.20.1', cycle: 'v2.12' } };
const filesOf = (out, id) => Object.fromEntries(out.files.filter((f) => f.path.startsWith(`automation/${id}/`)).map((f) => [f.path.split('/').pop(), f.content]));

test('an invite key gives the same age identity in Node and in the browser copy', async () => {
  const keys = [newKey(), newKey(), newKey(), 'an-older_key-of-another-length', 'x'.repeat(40)];
  for (const k of keys) {
    const node = identityFromKey(k);
    assert.match(node, IDENTITY);
    assert.equal(browserAge.identityFromKey(k), node, `the same identity for ${k.length}-character keys`);
    assert.equal(await browserAge.identityToRecipient(node), await recipientOf(node));
  }
  assert.equal(keyBytes(keys[0]).length, 24, 'the usual key is 24 raw bytes');
  assert.notEqual(identityFromKey(keys[0]), identityFromKey(keys[1]));
  assert.throws(() => identityFromKey(''));
  // a known vector, so the derivation can't drift: HKDF-SHA256(24 zero bytes, "test-run", "automation results v1")
  assert.equal(identityFromKey('A'.repeat(32)), 'AGE-SECRET-KEY-1VEXRT2FV0TNGYA4FFNFQ47NSFFJFPXUHSTL0X9M8HC453LKJDJ6QKYAN6G');
  assert.equal(browserAge.identityFromKey('A'.repeat(32)), 'AGE-SECRET-KEY-1VEXRT2FV0TNGYA4FFNFQ47NSFFJFPXUHSTL0X9M8HC453LKJDJ6QKYAN6G');
  assert.match(cleanLock({ identity: await newIdentity() }).identity, IDENTITY);
  assert.deepEqual(cleanLock({ identity: 'nope' }), {});
});

test('recipients: host, admin, and people with the workbook and the suite; viewers included; removed people and keyless links not', async () => {
  const host = await newIdentity();
  const all = person('all');
  const viewer = person('viewer', { role: 'viewer' });
  const otherBook = person('otherBook', { books: ['Other.xlsx'] });
  const thisBook = person('thisBook', { books: ['CMS.xlsx'] });
  const noSuites = person('noSuites', { automationSuites: 'none' });
  const otherSuite = person('otherSuite', { automationSuites: ['notif'] });
  const thisSuite = person('thisSuite', { automationSuites: ['cms'] });
  const keyless = { ...person('keyless'), key: '' };
  const adminKey = newKey();
  const team = normalizeTeam({ enabled: true, admin: { hash: hashKey(adminKey), key: adminKey }, people: [all, viewer, otherBook, thisBook, noSuites, otherSuite, thisSuite, keyless] });
  const who = await recipientsFor(RUN, { team, hostIdentity: host });
  assert.deepEqual(who.map((r) => r.who).sort(), ['admin', 'all', 'host', 'thisBook', 'thisSuite', 'viewer'].sort());
  const byWho = Object.fromEntries(who.map((r) => [r.who, r.recipient]));
  assert.equal(byWho.viewer, await recipientOf(identityFromKey(viewer.key)));
  assert.equal(byWho.admin, await recipientOf(identityFromKey(adminKey)));
  assert.equal(byWho.host, await recipientOf(host));
  // removed: no longer a recipient
  team.people = team.people.filter((p) => p.id !== 'viewer');
  assert.ok(!(await recipientsFor(RUN, { team, hostIdentity: host })).some((r) => r.who === 'viewer'));
});

test('a sealed run opens for its recipients only; the run key is its own; a re-locked run does not open with a revoked key', async () => {
  const a = newKey();
  const b = newKey();
  const outsider = newKey();
  const meta = { v: 1, summary: { suiteName: 'CMS Automation' } };
  const detail = { run: { id: RUN.id, tests: [{ id: 't1', title: 'GRO assigns' }] } };
  const files = await sealRun({ meta, detail }, [await recipientOf(identityFromKey(a)), await recipientOf(identityFromKey(b))]);
  assert.deepEqual(Object.keys(files).sort(), ['key.age', 'meta.age', 'run.age']);
  for (const k of [a, b]) {
    const got = await openRun(files, identityFromKey(k));
    assert.deepEqual(got, { meta, detail });
  }
  assert.equal(await openRun(files, identityFromKey(outsider)), null, 'not invited: it does not open');
  assert.ok(!files['meta.age'].toString('latin1').includes('CMS Automation'), 'nothing readable in the files');
  // in the browser copy too
  const key = await browserAge.open(files['key.age'], browserAge.identityFromKey(a));
  assert.ok(key);
  const plain = await browserAge.open(files['meta.age'], new TextDecoder().decode(key));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), meta);
  assert.equal(await browserAge.open(files['key.age'], browserAge.identityFromKey(outsider)), null);

  // b's link is renewed (or b removed): the next publish locks the run again, under a new run key
  const cache = new SealCache(join(mkdtempSync(join(tmpdir(), 'testrun-seal-')), 'sealed'));
  const item = (recips) => ({ id: RUN.id, slug: 'cms-abc123', meta, detail, recipients: recips });
  const first = await sealRuns([item([await recipientOf(identityFromKey(a)), await recipientOf(identityFromKey(b))])], { cache });
  const oldFiles = filesOf(first, RUN.id);
  const oldRunKey = (await openRun(oldFiles, identityFromKey(b))) && (await (await import('../lib/automation/seal.mjs')).unseal(oldFiles['key.age'], identityFromKey(b))).toString();
  const relocked = await sealRuns([item([await recipientOf(identityFromKey(a))])], { cache });
  assert.equal(relocked.sealed, 1, 'sealed again');
  const newFiles = filesOf(relocked, RUN.id);
  assert.ok(await openRun(newFiles, identityFromKey(a)), 'a still opens it');
  assert.equal(await openRun(newFiles, identityFromKey(b)), null, 'the revoked key does not');
  const { unseal } = await import('../lib/automation/seal.mjs');
  assert.equal(await unseal(newFiles['meta.age'], oldRunKey), null, 'nor does the old run key it once opened');
});

test('sealRuns: the cache gives the same bytes while nothing changes; new content or recipients seal again; runs nobody may open are left out', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'testrun-seal-')), 'sealed');
  const cache = new SealCache(dir);
  const r = await recipientOf(identityFromKey(newKey()));
  const items = [
    { id: '20261124-101500-aaaaaa', slug: 'cms-1', meta: { n: 1 }, detail: { d: 1 }, recipients: [r] },
    { id: '20261124-101400-bbbbbb', slug: 'cms-1', meta: { n: 2 }, detail: { d: 2 }, recipients: [] },
  ];
  const one = await sealRuns(items, { cache, prefix: 'data/' });
  assert.equal(one.sealed, 1);
  assert.deepEqual(one.index.runs.map((x) => [x.id, x.book]), [['20261124-101500-aaaaaa', 'cms-1']], 'the run nobody may open is not published');
  assert.deepEqual(one.files.map((f) => f.path).sort(), ['data/automation/20261124-101500-aaaaaa/key.age', 'data/automation/20261124-101500-aaaaaa/meta.age', 'data/automation/20261124-101500-aaaaaa/run.age', 'data/automation/index.json']);
  assert.ok(one.index.runs[0].bytes > 0 && one.index.runs[0].publishedAt);
  const two = await sealRuns(items, { cache, prefix: 'data/' });
  assert.equal(two.sealed, 0, 'from the cache');
  assert.deepEqual(two.files.map((f) => f.content.toString('base64')), one.files.map((f) => f.content.toString('base64')), 'byte for byte');
  items[0].meta = { n: 3 };
  assert.equal((await sealRuns(items, { cache })).sealed, 1, 'what is inside changed');
  items[0].recipients = [r, await recipientOf(identityFromKey(newKey()))];
  assert.equal((await sealRuns(items, { cache })).sealed, 1, 'who it is for changed');
  assert.deepEqual((await sealRuns([], { cache })).files, [], 'no runs: no files at all');
  assert.ok(!existsSync(join(dir, '20261124-101500-aaaaaa')), 'a run not published any more leaves the cache');
  assert.ok(isAutomationPath('automation/index.json') && isAutomationPath('automation/20261124-101500-aaaaaa/run.age'));
  assert.ok(!isAutomationPath('automation/../app.json') && !isAutomationPath('automation/x/run.age'));
});
