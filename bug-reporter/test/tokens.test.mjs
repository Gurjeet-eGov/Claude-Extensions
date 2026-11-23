// Bug Reporter uses the Test Run console's colour tokens (DESIGN.md) from a copy in styles/tokens.css.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const consoleCss = new URL('../../test-run-console/ui/styles.css', import.meta.url);

test('styles/tokens.css matches the console\'s :root blocks', { skip: !existsSync(consoleCss) && 'the Test Run console is not checked out next to Bug Reporter' }, () => {
  const css = readFileSync(consoleCss, 'utf8');
  const i = css.indexOf('@media (prefers-color-scheme: dark)');
  const blocks = css.slice(0, css.indexOf('\n}\n', i) + 3);
  assert.ok(read('../extension/styles/tokens.css').endsWith(blocks), 'differs: run node test-run-console/scripts/sync-tokens.mjs');
});

test('every page loads the tokens first, and the stylesheets use tokens, not colour values', () => {
  for (const page of ['popup/popup.html', 'options/options.html', 'report/report.html', 'recorder/recorder.html']) {
    const html = read(`../extension/${page}`);
    assert.ok(html.indexOf('../styles/tokens.css') > 0 && html.indexOf('../styles/tokens.css') < html.indexOf('../styles/common.css'), `${page} loads tokens.css before common.css`);
  }
  for (const css of ['styles/common.css', 'popup/popup.css', 'options/options.css', 'recorder/recorder.css']) {
    const text = read(`../extension/${css}`);
    assert.doesNotMatch(text, /:root\s*\{/, `${css} defines its own tokens`);
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b/i, `${css} has a colour value instead of a token`);
  }
  // report.css keeps two that aren't theme colours: the video's black letterbox and the zoom scrim.
  const report = read('../extension/report/report.css').replace('background: #000;', '').replace('rgba(0, 0, 0, 0.7)', '');
  assert.doesNotMatch(report, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'report.css has a colour value instead of a token');
});
