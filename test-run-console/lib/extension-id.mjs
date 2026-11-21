// The Chrome extension ID that a manifest's "key" gives (the ID stays the same wherever the folder is loaded from).
// A copy of bug-reporter/host/lib/extension-id.mjs, so Test Run starts without Bug Reporter's folder.

import { createHash } from 'node:crypto';

export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
