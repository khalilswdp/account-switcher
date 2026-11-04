// The three login helpers, the Vault listing and the encrypted backup, end to end in scratch
// folders with a fake Keychain and the file Vault (see helpers.mjs). The values are obviously
// fake, and every test checks that the scripts never print them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { cliService, exists, makeCookieDb, node, safeKey, scratch, world } from './helpers.mjs';
import { decryptCookie } from '../scripts/lib/chromium-crypto.mjs';

test('desktop-vault: push stores only the session cookie, decrypted; pull and load encrypt it again', async () => {
  const { dir, env, support } = await world('desktop');
  const key = safeKey();
  const cookies = path.join(support, 'Claude', 'Cookies');
  makeCookieDb(cookies, key, [
    { host: 'claude.ai', name: 'sessionKey', value: 'sk-ant-sid01-FAKEVALUE' },
    { host: 'claude.ai', name: 'anthropic-consent-preferences', value: '{"consent":1}' },
  ]);

  let r = await node('desktop-vault.mjs', ['push', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out + r.err, /FAKEVALUE/);
  const envelope = JSON.parse(await fs.readFile(path.join(dir, 'vault', 'desktop', 'fake.json'), 'utf8'));
  assert.deepEqual(envelope.items, ['Cookies']);
  const items = JSON.parse(gunzipSync(Buffer.from(envelope.payload, 'base64')).toString());
  const values = Object.values(items.Cookies.values).map((b) => Buffer.from(b, 'base64').toString());
  assert.deepEqual(values, ['sk-ant-sid01-FAKEVALUE']); // the consent cookie is left out on purpose

  r = await node('desktop-vault.mjs', ['push', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Already up to date/);

  r = await node('desktop-vault.mjs', ['status', 'fake', '--json'], { env });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).vault.items, ['Cookies']);

  // pull: a parked folder for another name, readable with this Mac's key
  r = await node('desktop-vault.mjs', ['pull', 'fake', '--as', 'other'], { env });
  assert.equal(r.code, 0, r.err);
  const pulled = new DatabaseSync(path.join(support, 'Claude.other', 'Cookies'), { readOnly: true });
  const rows = pulled.prepare('select host_key, name, encrypted_value from cookies').all();
  pulled.close();
  assert.equal(rows.length, 1);
  assert.equal(decryptCookie(rows[0].encrypted_value, rows[0].host_key, key, 24).toString(), 'sk-ant-sid01-FAKEVALUE');
  r = await node('desktop-vault.mjs', ['pull', 'fake', '--as', 'other'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to overwrite/);

  // load: merged into the existing cookie file, the other cookie stays
  const db = new DatabaseSync(cookies);
  db.exec("update cookies set encrypted_value = x'00' where name = 'sessionKey'");
  db.close();
  r = await node('desktop-vault.mjs', ['load', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  const merged = new DatabaseSync(cookies, { readOnly: true });
  const all = merged.prepare('select name, host_key, encrypted_value from cookies order by name').all();
  merged.close();
  assert.deepEqual(all.map((c) => c.name), ['anthropic-consent-preferences', 'sessionKey']);
  const sk = all.find((c) => c.name === 'sessionKey');
  assert.equal(decryptCookie(sk.encrypted_value, sk.host_key, key, 24).toString(), 'sk-ant-sid01-FAKEVALUE');

  // forget: the vault entry goes, the folders stay
  r = await node('desktop-vault.mjs', ['forget', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Deleted/);
  assert.equal(await exists(path.join(dir, 'vault', 'desktop', 'fake.json')), false);
  assert.equal(await exists(cookies), true);
  r = await node('desktop-vault.mjs', ['forget', 'fake'], { env });
  assert.match(r.out, /Nothing in the vault/);
  r = await node('desktop-vault.mjs', ['forget', 'zzz'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Nothing in the vault/);
});

test('desktop-vault: the allow-list and a Vault changed from elsewhere', async () => {
  const { dir, env, support } = await world('desktop-guard');
  makeCookieDb(path.join(support, 'Claude', 'Cookies'), safeKey(), [{ host: 'claude.ai', name: 'sessionKey', value: 'v1' }]);
  let r = await node('desktop-vault.mjs', ['push', 'nope'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /no folder/);
  r = await node('desktop-vault.mjs', ['push', 'fake'], { env });
  assert.equal(r.code, 0, r.err);

  // another Mac pushed since: refused without --force
  const file = path.join(dir, 'vault', 'desktop', 'fake.json');
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  Object.assign(envelope, { pushedAt: '2030-01-01T00:00:00.000Z', fp: 'different', host: 'other-mac' });
  await fs.writeFile(file, JSON.stringify(envelope));
  makeCookieDb(path.join(support, 'Claude', 'Cookies'), safeKey(), [{ host: 'claude.ai', name: 'sessionKey', value: 'v2' }]);
  r = await node('desktop-vault.mjs', ['push', 'fake'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /updated .*other-mac.*--force/);
  r = await node('desktop-vault.mjs', ['push', 'fake', '--force'], { env });
  assert.equal(r.code, 0, r.err);
  assert.notEqual(JSON.parse(await fs.readFile(file, 'utf8')).host, 'other-mac');
});

test('cli-vault: push reads the Keychain item; pull writes one and never overwrites without --replace', async () => {
  const { dir, env, stubs } = await world('cli');
  const configDir = path.join(dir, 'claude-fake');
  const credential = JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE-ACCESS', refreshToken: 'FAKE-REFRESH' } });
  await stubs.seedKeychain(cliService(configDir), env.USER, credential);

  let r = await node('cli-vault.mjs', ['status', 'fake', '--json'], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).local.present, true);
  assert.equal(JSON.parse(r.out).vault, null);

  r = await node('cli-vault.mjs', ['push', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out + r.err, /FAKE-/);
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'vault', 'cli', 'fake.json'), 'utf8'));
  assert.equal(stored.credential, credential);
  r = await node('cli-vault.mjs', ['push', 'fake'], { env });
  assert.match(r.out, /Already up to date/);

  r = await node('cli-vault.mjs', ['pull', 'fake'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists/);
  const second = path.join(dir, 'claude-second');
  r = await node('cli-vault.mjs', ['pull', 'fake', '--config', second], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await stubs.readKeychain(cliService(second), env.USER), credential);
  assert.equal(await exists(second), true);
  r = await node('cli-vault.mjs', ['pull', 'fake', '--replace'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Replaced/);
  r = await node('cli-vault.mjs', ['push', 'zzz'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /no CLI login found/);
  r = await node('cli-vault.mjs', ['status', 'zzz', '--json'], { env });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { local: { present: false }, vault: null });

  // forget: the vault entry; forget-keychain: this Mac's item. Each leaves the other alone.
  r = await node('cli-vault.mjs', ['forget', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Deleted/);
  assert.equal(await exists(path.join(dir, 'vault', 'cli', 'fake.json')), false);
  assert.equal(await stubs.readKeychain(cliService(configDir), env.USER), credential);
  r = await node('cli-vault.mjs', ['forget-keychain', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Deleted/);
  await assert.rejects(stubs.readKeychain(cliService(configDir), env.USER));
  assert.equal(await stubs.readKeychain(cliService(second), env.USER), credential); // the other folder's item stays
  r = await node('cli-vault.mjs', ['forget-keychain', 'fake'], { env });
  assert.match(r.out, /No CLI login/);
});

test('vault-list: which accounts and parts exist, and never a value', async () => {
  const { dir, env } = await world('list');
  const put = (rel, obj) => fs.mkdir(path.dirname(path.join(dir, 'vault', rel)), { recursive: true })
    .then(() => fs.writeFile(path.join(dir, 'vault', rel), JSON.stringify(obj)));
  await put('desktop/fake.json', { pushedAt: '2026-01-01T00:00:00.000Z', host: 'mac-a', payload: 'SECRET-PAYLOAD' });
  await put('cli/other.json', { pushedAt: '2026-01-02T00:00:00.000Z', host: 'mac-b', credential: 'SECRET-CRED' });
  await put('cli/nope.json', { pushedAt: '2026-01-03T00:00:00.000Z', host: 'mac-c', credential: 'SECRET-CRED' });
  await put('stale.json', { pushedAt: '2026-01-04T00:00:00.000Z', host: 'mac-d', state: { cookies: [] } }); // an old browser entry
  await fs.writeFile(path.join(dir, 'vault', 'desktop', 'broken.json'), 'not json at all'); // written by hand, wrongly
  await put('cli/nodate.json', { host: 'mac-e' }); // no save time: not an envelope
  await put('desktop/_tmp.json', { pushedAt: '2026-01-05T00:00:00.000Z' }); // "_" names are skipped silently
  const r = await node('vault-list.mjs', [], { env });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /SECRET|_tmp/);
  assert.deepEqual(JSON.parse(r.out), {
    accounts: {
      fake: { desktop: { pushedAt: '2026-01-01T00:00:00.000Z', host: 'mac-a' }, cli: null },
      other: { desktop: null, cli: { pushedAt: '2026-01-02T00:00:00.000Z', host: 'mac-b' } },
      nope: { desktop: null, cli: { pushedAt: '2026-01-03T00:00:00.000Z', host: 'mac-c' } },
    },
    unreadable: ['cli/nodate', 'desktop/broken'],
    ignored: ['stale'],
  });
});

test('backup.mjs: backup, verify, inspect, additive apply; a wrong passphrase or damage is refused', async () => {
  const { dir, env, support, stubs } = await world('backup');
  // the three logins
  makeCookieDb(path.join(support, 'Claude', 'Cookies'), safeKey(), [{ host: 'claude.ai', name: 'sessionKey', value: 'DESKTOP-FAKE' }]);
  await stubs.seedKeychain(cliService(path.join(dir, 'claude-fake')), env.USER, '{"token":"CLI-FAKE"}');
  // files that cannot be re-downloaded, plus caches that must be left out
  const cfg = path.join(dir, 'claude-fake');
  await fs.mkdir(path.join(cfg, 'projects', 'p1'), { recursive: true });
  await fs.mkdir(path.join(cfg, 'cache'), { recursive: true });
  await fs.writeFile(path.join(cfg, 'projects', 'p1', 'history.jsonl'), 'line\n');
  const old = new Date('2025-01-02T03:04:05Z');
  await fs.utimes(path.join(cfg, 'projects', 'p1', 'history.jsonl'), old, old);
  await fs.writeFile(path.join(cfg, 'settings.json'), '{"mine":true}');
  await fs.writeFile(path.join(cfg, 'cache', 'big.bin'), 'x'.repeat(1000));
  await fs.writeFile(path.join(support, 'Claude', 'config.json'), '{"app":true}');
  await fs.mkdir(path.join(support, 'Claude', 'Cache'));
  await fs.writeFile(path.join(support, 'Claude', 'Cache', 'c'), 'c');

  const out = path.join(dir, 'out');
  const pass = 'correct horse battery staple';
  let r = await node('backup.mjs', ['backup', 'fake', '--to', out], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const result = JSON.parse(r.out.trim().split('\n').pop());
  assert.deepEqual(result.logins, { desktop: 'saved', cli: 'saved' });
  assert.doesNotMatch(r.out + r.err, /FAKE|staple/);
  const raw = await fs.readFile(result.file);
  assert.equal(raw.subarray(0, 4).toString(), 'CSBK');
  assert.doesNotMatch(raw.toString('latin1'), /DESKTOP-FAKE|CLI-FAKE|history|manifest/); // encrypted

  r = await node('backup.mjs', ['verify', result.file], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /intact/);
  assert.match(r.out, /desktop login: saved/);

  r = await node('backup.mjs', ['inspect', result.file], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const info = JSON.parse(r.out);
  assert.equal(info.account, 'fake');
  assert.deepEqual(info.vault.sort(), ['cli/fake', 'desktop/fake']);
  assert.equal(info.hasConfig, true);
  assert.equal(info.hasDesktop, true);

  r = await node('backup.mjs', ['verify', result.file], { env, input: 'not the passphrase\n' });
  assert.equal(r.code, 1);
  assert.match(r.err, /wrong passphrase/);
  const damaged = path.join(dir, 'damaged.csbk');
  const copy = Buffer.from(raw);
  copy[Math.floor(copy.length / 2)] ^= 0xff;
  await fs.writeFile(damaged, copy);
  r = await node('backup.mjs', ['verify', damaged], { env, input: `${pass}\n` });
  assert.equal(r.code, 1);
  assert.match(r.err, /wrong passphrase, or the file is damaged/);

  // a second backup never reuses a name; --replace removes the older one only after the new one opens
  r = await node('backup.mjs', ['backup', 'fake', '--to', out, '--replace'], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const second = JSON.parse(r.out.trim().split('\n').pop());
  assert.notEqual(second.file, result.file);
  assert.deepEqual(second.replaced, [path.basename(result.file)]);
  assert.equal(await exists(result.file), false);

  // apply on a "new Mac": empty Vault, a config folder with one file already there, no app data yet
  const dir2 = await scratch('restore');
  const env2 = {
    ...env,
    VAULT_FILE_DIR: path.join(dir2, 'vault'),
    ACCOUNTS_FILE: path.join(dir2, 'accounts.json'),
    SUPPORT_DIR: path.join(dir2, 'support'),
    SWAP_STATE_DIR: path.join(dir2, 'state'),
  };
  await fs.writeFile(env2.ACCOUNTS_FILE, JSON.stringify([{ id: 'fake', cliConfigDir: path.join(dir2, 'claude-fake') }]));
  await fs.mkdir(path.join(dir2, 'claude-fake'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'claude-fake', 'settings.json'), 'KEEP ME'); // must not be overwritten
  r = await node('backup.mjs', ['apply', second.file, '--parts', 'vault,config,desktop'], { env: env2, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const applied = JSON.parse(r.out);
  assert.equal(applied.account, 'fake');
  assert.deepEqual(applied.parts.vault, { written: 2, kept: 0 });
  assert.equal(applied.parts.config.copied, 1);
  assert.equal(applied.parts.config.skipped, 1);
  assert.equal(await fs.readFile(path.join(dir2, 'claude-fake', 'settings.json'), 'utf8'), 'KEEP ME');
  const restoredHistory = path.join(dir2, 'claude-fake', 'projects', 'p1', 'history.jsonl');
  assert.equal(await fs.readFile(restoredHistory, 'utf8'), 'line\n');
  assert.equal((await fs.stat(restoredHistory)).mtime.toISOString(), old.toISOString()); // history order survives
  assert.equal(await exists(path.join(dir2, 'claude-fake', 'cache')), false);
  assert.equal(await fs.readFile(path.join(dir2, 'support', 'Claude.fake', 'config.json'), 'utf8'), '{"app":true}');
  assert.equal(await exists(path.join(dir2, 'support', 'Claude.fake', 'Cookies')), false); // the login comes back via the Vault
  assert.equal(await exists(path.join(dir2, 'support', 'Claude.fake', 'Cache')), false);
  const restoredVault = JSON.parse(await fs.readFile(path.join(dir2, 'vault', 'desktop', 'fake.json'), 'utf8'));
  assert.equal(restoredVault.format, 'gzip-base64-json');

  // the restored Vault entry is usable: load it into a parked folder on the "new Mac"
  await fs.mkdir(path.join(dir2, 'state'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'state', 'active'), 'someone-else\n');
  r = await node('desktop-vault.mjs', ['load', 'fake'], { env: env2 });
  assert.equal(r.code, 0, r.err);
  const db = new DatabaseSync(path.join(dir2, 'support', 'Claude.fake', 'Cookies'), { readOnly: true });
  const row = db.prepare("select host_key, encrypted_value from cookies where name = 'sessionKey'").get();
  db.close();
  assert.equal(decryptCookie(row.encrypted_value, row.host_key, safeKey(), 24).toString(), 'DESKTOP-FAKE');

  // applying again changes nothing
  r = await node('backup.mjs', ['apply', second.file, '--parts', 'vault,config'], { env: env2, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const again = JSON.parse(r.out);
  assert.deepEqual(again.parts.vault, { written: 0, kept: 2 });
  assert.equal(again.parts.config.copied, 0);
});
