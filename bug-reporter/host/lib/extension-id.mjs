// Prints the Chrome extension ID derived from the "key" in manifest.json.
// Usage: node extension-id.mjs path/to/manifest.json

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!manifest.key) {
    console.error('manifest.json has no "key"');
    process.exit(1);
  }
  process.stdout.write(extensionIdFromKey(manifest.key) + '\n');
}
