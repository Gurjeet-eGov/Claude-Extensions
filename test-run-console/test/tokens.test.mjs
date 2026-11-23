// The extensions keep copies of the console's colour tokens (DESIGN.md); they must match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { HEADER, tokenBlocks, TARGETS } from '../scripts/sync-tokens.mjs';

const console = tokenBlocks(readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8'));

test('each extension\'s styles/tokens.css is the console\'s :root blocks', () => {
  for (const file of TARGETS) {
    if (!existsSync(file)) continue; // Bug Reporter not checked out next to the console
    assert.equal(readFileSync(file, 'utf8'), HEADER + console, `${file} differs: run node scripts/sync-tokens.mjs`);
  }
});

test('the extensions use tokens, not their own colour values', () => {
  const pages = ['../extension/popup/popup.css', '../extension/popup/popup.html', '../extension/recorder/recorder.html'];
  for (const p of pages) {
    const text = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /:root\s*\{/, `${p} defines its own tokens`);
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b/i, `${p} has a colour value instead of a token`);
  }
});
