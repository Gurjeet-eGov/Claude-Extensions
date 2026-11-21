import test from 'node:test';
import assert from 'node:assert/strict';

// A fake chrome.scripting that behaves like Chrome's: registering an id that is there fails with
// "Duplicate script ID", unregistering one that isn't fails with "Nonexistent script ID", and every
// call takes a moment, so overlapping calls interleave.
function fakeScripting({ hidden = [] } = {}) {
  const reg = new Map();
  for (const id of hidden) reg.set(id, { id }); // held by Chrome but not listed yet (after a reload)
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    reg,
    async getRegisteredContentScripts(filter = {}) {
      await tick();
      return [...reg.values()].filter((s) => !hidden.includes(s.id) && (!filter.ids || filter.ids.includes(s.id)));
    },
    async registerContentScripts(scripts) {
      await tick();
      for (const s of scripts) if (reg.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
      for (const s of scripts) reg.set(s.id, s);
      hidden.length = 0;
    },
    async unregisterContentScripts({ ids }) {
      await tick();
      for (const id of ids) if (!reg.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
      for (const id of ids) reg.delete(id);
    },
  };
}

const { serial, replaceScripts } = await import('../extension/background/script-registry.js');
const IDS = ['egov-br-relay', 'egov-br-hook'];
const scripts = (m) => IDS.map((id) => ({ id, js: [id + '.js'], matches: [m] }));

test('content scripts: syncs that overlap (install while a site is enabled) run one at a time, no duplicate', async () => {
  globalThis.chrome = { scripting: fakeScripting() };
  const queue = serial();
  await Promise.all([
    queue(() => replaceScripts(IDS, scripts('https://a.example/*'))),
    queue(() => replaceScripts(IDS, scripts('https://b.example/*'))),
    queue(() => replaceScripts(IDS, scripts('https://c.example/*'))),
  ]);
  const reg = globalThis.chrome.scripting.reg;
  assert.deepEqual([...reg.keys()].sort(), [...IDS].sort());
  assert.deepEqual(reg.get('egov-br-relay').matches, ['https://c.example/*'], 'the last sync wins');
});

test('content scripts: without the queue, overlapping syncs hit "Duplicate script ID" (the bug)', async () => {
  globalThis.chrome = { scripting: fakeScripting() };
  const old = async (m) => { // the code before the fix
    const there = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => IDS.includes(id));
    if (there.length) await chrome.scripting.unregisterContentScripts({ ids: there });
    await chrome.scripting.registerContentScripts(scripts(m));
  };
  await assert.rejects(Promise.all([old('https://a.example/*'), old('https://b.example/*')]), /Duplicate script ID/);
});

test('content scripts: a script Chrome still holds from before a reload is replaced, not a duplicate', async () => {
  globalThis.chrome = { scripting: fakeScripting({ hidden: ['egov-br-relay'] }) };
  await replaceScripts(IDS, scripts('https://a.example/*'));
  assert.deepEqual([...globalThis.chrome.scripting.reg.keys()].sort(), [...IDS].sort());
});

test('content scripts: no sites left removes them; a failed job does not stop the next', async () => {
  globalThis.chrome = { scripting: fakeScripting() };
  const queue = serial();
  await queue(() => replaceScripts(IDS, scripts('https://a.example/*')));
  await assert.rejects(queue(async () => { throw new Error('boom'); }), /boom/);
  await queue(() => replaceScripts(IDS, []));
  assert.equal(globalThis.chrome.scripting.reg.size, 0);
});
