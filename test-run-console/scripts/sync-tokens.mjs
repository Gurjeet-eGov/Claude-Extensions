// Copies the console's colour tokens (the two :root blocks at the top of ui/styles.css) into
// each extension's styles/tokens.css. Unpacked extensions can only load files inside their own
// folder, so they keep copies; tests fail when a copy differs.
//   node scripts/sync-tokens.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const HEADER =
  '/* Colour tokens: a copy of the :root blocks at the top of test-run-console/ui/styles.css\n' +
  '   (see DESIGN.md). Do not edit here: change the console, then run\n' +
  '   node test-run-console/scripts/sync-tokens.mjs */\n';

/** The token blocks of a stylesheet: from the start to the end of the dark-mode :root block. */
export function tokenBlocks(css) {
  const i = css.indexOf('@media (prefers-color-scheme: dark)');
  if (!css.startsWith(':root {') || i < 0) throw new Error('styles.css should start with the :root token blocks');
  return css.slice(0, css.indexOf('\n}\n', i) + 3);
}

export const TARGETS = [join(ROOT, 'extension', 'styles', 'tokens.css'), join(ROOT, '..', 'bug-reporter', 'extension', 'styles', 'tokens.css')];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = HEADER + tokenBlocks(readFileSync(join(ROOT, 'ui', 'styles.css'), 'utf8'));
  for (const file of TARGETS) {
    if (!existsSync(join(file, '..', '..'))) continue; // Bug Reporter not checked out next to the console
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log('wrote', file);
  }
}
