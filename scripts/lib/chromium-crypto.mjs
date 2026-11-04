// Chromium/Electron "v10" encryption on macOS, as used by the Claude desktop app for its
// cookies and its safeStorage token cache.
//
//   key        = PBKDF2-HMAC-SHA1(<Keychain "Claude Safe Storage" password>, "saltysalt", 1003, 16 bytes)
//   ciphertext = "v10" + AES-128-CBC(key, IV = 16 spaces, PKCS7)
//   cookies    : from cookie DB version 24 the plaintext is SHA-256(host_key) + value
//
// The Keychain password is read in-process and turned into the key. Nothing here prints
// or stores either of them.
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IV = Buffer.alloc(16, 0x20);
const PREFIX = Buffer.from('v10');

// Reading the item makes macOS ask the user to allow access.
export async function readSafeStorageKey({ service = 'Claude Safe Storage', account = 'Claude Key' } = {}) {
  let stdout;
  try {
    ({ stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 120_000 }));
  } catch (e) {
    throw new Error(
      /could not be found/i.test(e.stderr || '')
        ? `no "${service}" item in the Keychain. Open the Claude app once on this Mac, quit it, and try again.`
        : 'could not read the Keychain item (access denied or timed out)',
    );
  }
  const password = stdout.replace(/\n$/, '');
  if (!password) throw new Error('the Keychain item is empty');
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

export function decryptV10(buf, key) {
  if (buf.length < 3 + 16 || !buf.subarray(0, 3).equals(PREFIX)) throw new Error('not a v10 value');
  const d = createDecipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([d.update(buf.subarray(3)), d.final()]);
}

export function encryptV10(plain, key) {
  const c = createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([PREFIX, c.update(plain), c.final()]);
}

const hostHash = (hostKey) => createHash('sha256').update(hostKey).digest();

// Returns the cookie value bytes; null for an empty encrypted_value.
export function decryptCookie(encrypted, hostKey, key, dbVersion) {
  if (!encrypted || encrypted.length === 0) return null;
  const plain = decryptV10(Buffer.from(encrypted), key);
  if (dbVersion < 24) return plain;
  if (!plain.subarray(0, 32).equals(hostHash(hostKey))) throw new Error(`cookie for ${hostKey} fails its host check`);
  return plain.subarray(32);
}

export function encryptCookie(value, hostKey, key, dbVersion) {
  const plain = dbVersion < 24 ? value : Buffer.concat([hostHash(hostKey), value]);
  return encryptV10(plain, key);
}
