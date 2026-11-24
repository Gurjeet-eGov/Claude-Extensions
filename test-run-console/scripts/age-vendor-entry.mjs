// What ui/vendor/age.js holds: age (the age-encryption package, typage) for the published site,
// plus the derivation of a person's identity from their invite key. Bundled into one file by
// scripts/build-age-vendor.mjs; the page loads it with import() when it unlocks automated results.
//
// identityFromKey must give exactly what lib/automation/seal.mjs gives on the server
// (test/seal.test.mjs checks both on the same keys):
//   HKDF-SHA256(ikm = the key's 24 raw bytes, salt "test-run", info "automation results v1", 32 bytes)
//   -> "AGE-SECRET-KEY-1…" (bech32, upper case); a key that isn't 32 base64url characters is used as its UTF-8 bytes.
import { Decrypter, identityToRecipient } from 'age-encryption';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bech32 } from '@scure/base';

export const KDF = { salt: 'test-run', info: 'automation results v1' };

function keyBytes(key) {
  const k = String(key == null ? '' : key);
  if (/^[A-Za-z0-9_-]{32}$/.test(k)) {
    const bin = atob(k.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  return new TextEncoder().encode(k);
}

/** The age identity an invite key opens results with. */
export function identityFromKey(key) {
  if (!key) throw new Error('No key to derive an identity from.');
  return bech32.encodeFromBytes('AGE-SECRET-KEY-', hkdf(sha256, keyBytes(key), KDF.salt, KDF.info, 32)).toUpperCase();
}

/** Decrypt with an identity: the bytes, or null when the file isn't for it. */
export async function open(cipher, identity) {
  const d = new Decrypter();
  d.addIdentity(identity);
  try {
    return await d.decrypt(cipher instanceof Uint8Array ? cipher : new Uint8Array(cipher));
  } catch (e) {
    if (/no identity matched/i.test(String(e && e.message))) return null;
    throw e;
  }
}

export { Decrypter, identityToRecipient };
