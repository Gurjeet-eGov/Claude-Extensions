#!/usr/bin/env node
// Builds ui/vendor/age.js: age (the age-encryption package, typage, with its @noble and @scure
// dependencies) and the invite-key derivation, as ONE browser ES module, plus ui/vendor/age.LICENSE.txt
// with the licences of everything inside. The page itself has no build step: this runs once, when
// age-encryption is updated, and both files are committed.
//
//   cd test-run-console && npm install && node scripts/build-age-vendor.mjs
//
// It runs esbuild through npx (nothing is added to package.json).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESBUILD = 'esbuild@0.24.2';
const out = join(ROOT, 'ui', 'vendor', 'age.js');
mkdirSync(dirname(out), { recursive: true });

const pkg = (name) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
const inside = ['age-encryption', '@noble/ciphers', '@noble/curves', '@noble/hashes', '@scure/base'];
const versions = inside.map((n) => `${n}@${pkg(n).version}`).join(', ');

execFileSync('npx', ['--yes', ESBUILD, join(ROOT, 'scripts', 'age-vendor-entry.mjs'),
  '--bundle', '--format=esm', '--platform=browser', '--target=es2020', '--legal-comments=none', `--outfile=${out}`], { cwd: ROOT, stdio: 'inherit' });

const head = `/*! age for Test Run's published site, built by scripts/build-age-vendor.mjs from scripts/age-vendor-entry.mjs.
 * Inside: ${versions}. Licences: age.LICENSE.txt next to this file. Do not edit; build it again. */\n`;
writeFileSync(out, head + readFileSync(out, 'utf8'));

const licence = inside.map((n) => `${n} ${pkg(n).version}\n${'='.repeat(n.length + 1 + pkg(n).version.length)}\n\n${readFileSync(join(ROOT, 'node_modules', n, 'LICENSE'), 'utf8').trim()}\n`).join('\n\n');
writeFileSync(join(ROOT, 'ui', 'vendor', 'age.LICENSE.txt'), `Licences of the code bundled in age.js\n\n${licence}`);
console.log(`Built ui/vendor/age.js (${versions}).`);
