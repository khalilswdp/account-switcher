// Chromium/Electron "v10" value encryption, as the Claude desktop app uses it for its cookies.
//
//   macOS    key   = PBKDF2-HMAC-SHA1(<Keychain "Claude Safe Storage" password>, "saltysalt", 1003, 16 bytes)
//            value = "v10" + AES-128-CBC(key, IV = 16 spaces, PKCS7)
//   Windows  key   = 32 random bytes the app keeps in its "Local State" file, protected with DPAPI
//            value = "v10" + nonce (12 bytes) + AES-256-GCM(key, nonce) + tag (16 bytes)
//
// The key's length says which scheme: 16 bytes is the macOS one, 32 the Windows one. From cookie
// database version 24 the plaintext is SHA-256(host_key) + value on both. The keys come from
// lib/platform.mjs; nothing here prints or stores them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV = Buffer.alloc(16, 0x20);
const PREFIX = Buffer.from('v10');
const NONCE = 12;
const TAG = 16;

export function decryptV10(buf, key) {
  if (!buf.subarray(0, 3).equals(PREFIX)) throw new Error('not a v10 value');
  if (key.length === 32) {
    if (buf.length < 3 + NONCE + TAG) throw new Error('not a v10 value');
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(3, 3 + NONCE));
    d.setAuthTag(buf.subarray(buf.length - TAG));
    return Buffer.concat([d.update(buf.subarray(3 + NONCE, buf.length - TAG)), d.final()]);
  }
  if (buf.length < 3 + 16) throw new Error('not a v10 value');
  const d = createDecipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([d.update(buf.subarray(3)), d.final()]);
}

export function encryptV10(plain, key) {
  if (key.length === 32) {
    const nonce = randomBytes(NONCE);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([PREFIX, nonce, body, c.getAuthTag()]);
  }
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
