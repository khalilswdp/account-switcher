import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { decryptCookie, decryptV10, encryptCookie, encryptV10 } from '../scripts/lib/chromium-crypto.mjs';

const key = pbkdf2Sync('a password', 'saltysalt', 1003, 16, 'sha1');

test('v10 values round-trip and carry the prefix', () => {
  const enc = encryptV10(Buffer.from('hello'), key);
  assert.equal(enc.subarray(0, 3).toString(), 'v10');
  assert.equal(decryptV10(enc, key).toString(), 'hello');
  assert.throws(() => decryptV10(Buffer.from('nope'), key), /not a v10 value/);
});

test('cookies from database version 24 are bound to their host', () => {
  const enc = encryptCookie(Buffer.from('sk-value'), 'claude.ai', key, 24);
  assert.equal(decryptCookie(enc, 'claude.ai', key, 24).toString(), 'sk-value');
  assert.throws(() => decryptCookie(enc, 'other.example', key, 24), /host check/);
  assert.equal(decryptCookie(Buffer.alloc(0), 'claude.ai', key, 24), null);
});

test('older cookie databases have no host prefix', () => {
  const enc = encryptCookie(Buffer.from('v'), 'claude.ai', key, 23);
  assert.equal(decryptV10(enc, key).toString(), 'v');
  assert.equal(decryptCookie(enc, 'anything', key, 23).toString(), 'v');
});

test('a wrong key does not decrypt', () => {
  const enc = encryptCookie(Buffer.from('sk-value'), 'claude.ai', key, 24);
  const other = pbkdf2Sync('other', 'saltysalt', 1003, 16, 'sha1');
  assert.throws(() => decryptCookie(enc, 'claude.ai', other, 24));
});
