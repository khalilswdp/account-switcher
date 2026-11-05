// The PowerShell command (ps/claude-switcher.ps1) against the Node scripts, on Windows only: the
// two must agree byte for byte on what the Vault holds and on the backup file, since a login saved
// by one, on one machine, is loaded by the other. Everything runs in scratch folders with the file
// provider as the Vault and SWAP_SKIP_RUNNING_CHECK set, so no real app, login or Vault is touched.
// The cookie keys are real DPAPI keys made for the scratch folders (the PowerShell side has no fake
// mode: it is the real code path), so the Node scripts run without the stub too. Every test checks
// that no fake secret appears in any output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, baseEnv, exists, homeEnv, makeCookieDb, node, run, scratch } from './helpers.mjs';
import { decryptCookie } from '../scripts/lib/chromium-crypto.mjs';
import { ensureSafeStorageKey, readSafeStorageKey } from '../scripts/lib/platform.mjs';

const windows = process.platform === 'win32';
const CLI = path.join(ROOT, 'ps', 'claude-switcher.ps1');
const ps = (args, opts) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLI, ...args], opts);
const lastJson = (out) => JSON.parse(out.trim().split('\n').pop());
const SECRETS = /FAKEVALUE|FAKE-|CLI-FAKE|staple/;

// A scratch machine both implementations see the same way: account "fake" active in the app, its
// Claude Code folder inside the scratch dir, the file Vault. No stubs: real DPAPI for the keys.
async function world(name) {
  const dir = await scratch(name);
  const support = path.join(dir, 'support');
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  await fs.writeFile(path.join(dir, 'state', 'active'), 'fake\n');
  await fs.mkdir(path.join(dir, 'home'), { recursive: true });
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify([{ id: 'fake', label: 'Fake account', cliConfigDir: path.join(dir, 'claude-fake') }]));
  const env = {
    ...homeEnv(path.join(dir, 'home')),
    LOCALAPPDATA: process.env.LOCALAPPDATA, // the compiled shim's cache; PowerShell needs nothing else
    SUPPORT_DIR: support,
    SWAP_STATE_DIR: path.join(dir, 'state'),
    SWAP_SKIP_RUNNING_CHECK: '1',
    BACKUP_DIR: path.join(dir, 'backups'),
    ACCOUNTS_FILE: path.join(dir, 'accounts.json'),
    VAULT_PROVIDER: 'file',
    VAULT_FILE_DIR: path.join(dir, 'vault'),
    ...(process.env.SWITCHER_DEBUG ? { SWITCHER_DEBUG: '1' } : {}), // stack traces from the PowerShell side
  };
  return { dir, env, support };
}

const cookieFileIn = async (folder) => {
  for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) if (await exists(path.join(folder, rel))) return path.join(folder, rel);
  throw new Error(`no cookie file in ${folder}`);
};
async function sessionKeyIn(folder) {
  const key = await readSafeStorageKey(folder); // this folder's own DPAPI key
  const db = new DatabaseSync(await cookieFileIn(folder), { readOnly: true });
  const row = db.prepare("select host_key, encrypted_value from cookies where name = 'sessionKey'").get();
  db.close();
  return decryptCookie(row.encrypted_value, row.host_key, key, 24).toString();
}

test('PowerShell command: the account switch, same folders and state file as the Node version', { skip: !windows }, async () => {
  const dir = await scratch('ps-swap');
  const support = path.join(dir, 'support');
  const env = { ...homeEnv(path.join(dir, 'home')), LOCALAPPDATA: process.env.LOCALAPPDATA, SUPPORT_DIR: support, SWAP_STATE_DIR: path.join(dir, 'state'), SWAP_SKIP_RUNNING_CHECK: '1', ACCOUNTS_FILE: path.join(dir, 'accounts.json') };
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await fs.writeFile(path.join(support, 'Claude', 'marker'), 'A');
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify([{ id: 'a' }, { id: 'b' }]));

  let r = await ps(['use', 'b', '-Yes'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /not initialised/);
  r = await ps(['init', 'bad name'], { env });
  assert.equal(r.code, 1);
  r = await ps(['init', 'a'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tracked as 'a'/);
  r = await ps(['init', 'a'], { env });
  assert.match(r.err, /already initialised/);
  // the Node version reads the same state
  r = await node('desktop-swap.mjs', ['list'], { env });
  assert.equal(r.out, 'active a\nrunning no\n');

  r = await ps(['new', 'b', '-Yes'], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await exists(path.join(support, 'Claude')), false);
  assert.equal(await fs.readFile(path.join(support, 'Claude.a', 'marker'), 'utf8'), 'A');
  await fs.mkdir(path.join(support, 'Claude'));
  await fs.writeFile(path.join(support, 'Claude', 'marker'), 'B');
  r = await ps(['use', 'a', '-Yes'], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await fs.readFile(path.join(support, 'Claude', 'marker'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(support, 'Claude.b', 'marker'), 'utf8'), 'B');
  r = await node('desktop-swap.mjs', ['list'], { env });
  assert.equal(r.out, 'active a\nrunning no\nparked b\n');
  r = await ps(['use', 'zzz', '-Yes'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /no parked desktop account/);
  r = await ps(['use', 'a', '-Yes'], { env });
  assert.match(r.out, /already on "a"/);
  r = await ps(['status', '-Json'], { env });
  assert.equal(r.code, 0, r.err);
  const status = JSON.parse(r.out);
  assert.equal(status.desktop.active, 'a');
  assert.deepEqual(status.desktop.parked, ['b']);
  assert.equal(status.platform, 'win32');
});

test('PowerShell command: app and Claude Code logins cross over with the Node scripts, both ways', { skip: !windows }, async () => {
  const { dir, env, support } = await world('ps-vault');
  const active = path.join(support, 'Claude');
  const key = await ensureSafeStorageKey(active); // a real DPAPI key for the scratch folder
  makeCookieDb(path.join(active, 'Cookies'), key, [
    { host: 'claude.ai', name: 'sessionKey', value: 'sk-ant-sid01-FAKEVALUE' },
    { host: 'claude.ai', name: 'anthropic-consent-preferences', value: '{"consent":1}' },
  ]);

  // PowerShell saves the app login; the entry is exactly what the Node version writes
  let r = await ps(['save-app', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Pushed "fake": Cookies/);
  assert.doesNotMatch(r.out + r.err, SECRETS);
  const envelope = JSON.parse(await fs.readFile(path.join(dir, 'vault', 'desktop', 'fake.json'), 'utf8'));
  assert.equal(envelope.version, 1);
  assert.equal(envelope.format, 'gzip-base64-json');
  assert.deepEqual(envelope.items, ['Cookies']);
  const items = JSON.parse(gunzipSync(Buffer.from(envelope.payload, 'base64')).toString());
  assert.equal(items.Cookies.kind, 'cookies');
  assert.equal(items.Cookies.version, 24);
  assert.deepEqual(Object.values(items.Cookies.values).map((b) => Buffer.from(b, 'base64').toString()), ['sk-ant-sid01-FAKEVALUE']);
  r = await ps(['save-app', 'fake'], { env });
  assert.match(r.out, /Already up to date/);
  // the Node version computes the same fingerprint, so it sees nothing to push either
  r = await node('desktop-vault.mjs', ['push', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Already up to date/);
  r = await node('desktop-vault.mjs', ['status', 'fake', '--json'], { env });
  assert.deepEqual(JSON.parse(r.out).vault.items, ['Cookies']);

  // the Node version pulls what PowerShell saved, into a folder with its own key
  r = await node('desktop-vault.mjs', ['pull', 'fake', '--as', 'bynode'], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await sessionKeyIn(path.join(support, 'Claude.bynode')), 'sk-ant-sid01-FAKEVALUE');

  // the other way: the Node version saves, PowerShell pulls and loads
  r = await node('desktop-vault.mjs', ['push', 'fake', '--force'], { env });
  assert.equal(r.code, 0, r.err);
  r = await ps(['pull-app', 'fake', '-As', 'byps'], { env });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out + r.err, SECRETS);
  assert.equal(await sessionKeyIn(path.join(support, 'Claude.byps')), 'sk-ant-sid01-FAKEVALUE');
  r = await ps(['pull-app', 'fake', '-As', 'byps'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to overwrite/);
  const live = new DatabaseSync(path.join(active, 'Cookies'));
  live.exec("update cookies set encrypted_value = x'00' where name = 'sessionKey'");
  live.close();
  r = await ps(['load-app', 'fake', '-Yes'], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await sessionKeyIn(active), 'sk-ant-sid01-FAKEVALUE');
  const merged = new DatabaseSync(path.join(active, 'Cookies'), { readOnly: true });
  assert.deepEqual(merged.prepare('select name from cookies order by name').all().map((c) => c.name), ['anthropic-consent-preferences', 'sessionKey']);
  merged.close();

  // the Claude Code login: PowerShell saves, the Node version pulls; and back
  const credential = JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE-ACCESS', refreshToken: 'FAKE-REFRESH' } });
  await fs.mkdir(path.join(dir, 'claude-fake'), { recursive: true });
  await fs.writeFile(path.join(dir, 'claude-fake', '.credentials.json'), credential);
  r = await ps(['save-cli', 'fake'], { env });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out + r.err, SECRETS);
  const cliEntry = JSON.parse(await fs.readFile(path.join(dir, 'vault', 'cli', 'fake.json'), 'utf8'));
  assert.equal(cliEntry.format, 'cli-keychain');
  assert.equal(cliEntry.credential, credential);
  r = await ps(['save-cli', 'fake'], { env });
  assert.match(r.out, /Already up to date/);
  r = await node('cli-vault.mjs', ['pull', 'fake', '--config', path.join(dir, 'claude-bynode')], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await fs.readFile(path.join(dir, 'claude-bynode', '.credentials.json'), 'utf8'), credential);
  r = await node('cli-vault.mjs', ['push', 'fake', '--force'], { env });
  assert.equal(r.code, 0, r.err);
  r = await ps(['load-cli', 'fake', '-Config', path.join(dir, 'claude-byps')], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(await fs.readFile(path.join(dir, 'claude-byps', '.credentials.json'), 'utf8'), credential);
  r = await ps(['load-cli', 'fake'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to overwrite/);

  // the listings agree
  r = await ps(['vault-list'], { env });
  assert.equal(r.code, 0, r.err);
  const fromPs = JSON.parse(r.out);
  r = await node('vault-list.mjs', [], { env });
  assert.deepEqual(fromPs, JSON.parse(r.out));
  assert.doesNotMatch(JSON.stringify(fromPs), SECRETS);

  r = await ps(['forget-cli', 'fake', '-Yes'], { env });
  assert.match(r.out, /Deleted/);
  assert.equal(await exists(path.join(dir, 'vault', 'cli', 'fake.json')), false);
  r = await ps(['forget-app', 'fake', '-Yes'], { env });
  assert.match(r.out, /Deleted/);
  r = await ps(['forget-app', 'fake', '-Yes'], { env });
  assert.match(r.out, /Nothing in the vault/);
});

test('PowerShell command: a backup made by either side opens and restores with the other', { skip: !windows }, async () => {
  const { dir, env, support } = await world('ps-backup');
  const active = path.join(support, 'Claude');
  const key = await ensureSafeStorageKey(active);
  makeCookieDb(path.join(active, 'Cookies'), key, [{ host: 'claude.ai', name: 'sessionKey', value: 'DESKTOP-FAKEVALUE' }]);
  await fs.writeFile(path.join(active, 'config.json'), '{"app":true}');
  await fs.mkdir(path.join(active, 'Cache'));
  await fs.writeFile(path.join(active, 'Cache', 'c'), 'c');
  const cfg = path.join(dir, 'claude-fake');
  await fs.mkdir(path.join(cfg, 'projects', 'p1'), { recursive: true });
  await fs.mkdir(path.join(cfg, 'cache'), { recursive: true });
  await fs.writeFile(path.join(cfg, 'projects', 'p1', 'history.jsonl'), 'line\n');
  const old = new Date('2025-01-02T03:04:05Z');
  await fs.utimes(path.join(cfg, 'projects', 'p1', 'history.jsonl'), old, old);
  await fs.writeFile(path.join(cfg, 'settings.json'), '{"mine":true}');
  await fs.writeFile(path.join(cfg, 'cache', 'big.bin'), 'x'.repeat(1000));
  await fs.writeFile(path.join(cfg, '.credentials.json'), '{"token":"CLI-FAKE"}');
  const pass = 'correct horse battery staple';

  // PowerShell makes the backup; the Node version opens it
  let r = await ps(['backup', 'fake', '-To', path.join(dir, 'out')], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out + r.err, SECRETS);
  const made = lastJson(r.out);
  assert.deepEqual(made.logins, { desktop: 'saved', cli: 'saved' });
  const raw = await fs.readFile(made.file);
  assert.equal(raw.subarray(0, 4).toString(), 'CSBK');
  assert.doesNotMatch(raw.toString('latin1'), /FAKEVALUE|CLI-FAKE|history|manifest/);
  r = await node('backup.mjs', ['verify', made.file], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /intact/);
  r = await node('backup.mjs', ['inspect', made.file], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const info = JSON.parse(r.out);
  assert.equal(info.account, 'fake');
  assert.deepEqual(info.vault.sort(), ['cli/fake', 'desktop/fake']);
  assert.equal(info.hasConfig, true);
  assert.equal(info.hasDesktop, true);
  r = await node('backup.mjs', ['verify', made.file], { env, input: 'not the passphrase\n' });
  assert.equal(r.code, 1);
  r = await ps(['verify', made.file], { env, input: 'not the passphrase\n' });
  assert.equal(r.code, 1);
  assert.match(r.err, /wrong passphrase/);

  // the Node version makes a backup; PowerShell opens it, inspects it and applies it on a "new PC"
  r = await node('backup.mjs', ['backup', 'fake', '--to', path.join(dir, 'out2')], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const byNode = lastJson(r.out).file;
  r = await ps(['verify', byNode], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /intact/);
  assert.match(r.out, /desktop login: saved/);
  r = await ps(['inspect', byNode], { env, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const seen = JSON.parse(r.out);
  assert.equal(seen.account, 'fake');
  assert.deepEqual(seen.vault.sort(), ['cli/fake', 'desktop/fake']);
  assert.equal(seen.hasConfig, true);

  const dir2 = await scratch('ps-restore');
  const env2 = { ...env, VAULT_FILE_DIR: path.join(dir2, 'vault'), ACCOUNTS_FILE: path.join(dir2, 'accounts.json'), SUPPORT_DIR: path.join(dir2, 'support'), SWAP_STATE_DIR: path.join(dir2, 'state') };
  await fs.writeFile(env2.ACCOUNTS_FILE, JSON.stringify([{ id: 'fake', cliConfigDir: path.join(dir2, 'claude-fake') }]));
  await fs.mkdir(path.join(dir2, 'claude-fake'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'claude-fake', 'settings.json'), 'KEEP ME');
  r = await ps(['apply', byNode, '-Parts', 'vault,config,desktop'], { env: env2, input: `${pass}\n` });
  assert.equal(r.code, 0, r.err);
  const applied = lastJson(r.out);
  assert.equal(applied.account, 'fake');
  assert.deepEqual(applied.parts.vault, { written: 2, kept: 0 });
  assert.equal(applied.parts.config.copied, 1);
  assert.equal(applied.parts.config.skipped, 1);
  assert.equal(await fs.readFile(path.join(dir2, 'claude-fake', 'settings.json'), 'utf8'), 'KEEP ME');
  const restored = path.join(dir2, 'claude-fake', 'projects', 'p1', 'history.jsonl');
  assert.equal(await fs.readFile(restored, 'utf8'), 'line\n');
  assert.equal((await fs.stat(restored)).mtime.toISOString(), old.toISOString());
  assert.equal(await exists(path.join(dir2, 'claude-fake', 'cache')), false);
  assert.equal(await exists(path.join(dir2, 'claude-fake', '.credentials.json')), false); // the login travels in vault/ only
  assert.equal(await fs.readFile(path.join(dir2, 'support', 'Claude.fake', 'config.json'), 'utf8'), '{"app":true}');
  assert.equal(await exists(path.join(dir2, 'support', 'Claude.fake', 'Cookies')), false);
  assert.equal(await exists(path.join(dir2, 'support', 'Claude.fake', 'Cache')), false);
  // the restored entry loads on the "new PC" with PowerShell, into a folder that gets its own key;
  // load-app then makes that account the active one, as the dashboard's Load button does
  await fs.mkdir(path.join(dir2, 'state'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'state', 'active'), 'someone-else\n');
  await fs.mkdir(path.join(dir2, 'support', 'Claude'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'support', 'Claude', 'marker'), 'someone else');
  r = await ps(['load-app', 'fake', '-Yes'], { env: env2 });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Loaded "fake"/);
  assert.match(r.out, /'fake' is active/);
  assert.equal(await sessionKeyIn(path.join(dir2, 'support', 'Claude')), 'DESKTOP-FAKEVALUE');
  assert.equal(await fs.readFile(path.join(dir2, 'support', 'Claude.someone-else', 'marker'), 'utf8'), 'someone else');
  assert.equal(await fs.readFile(path.join(dir2, 'support', 'Claude', 'config.json'), 'utf8'), '{"app":true}');
  r = await node('desktop-swap.mjs', ['list'], { env: env2 });
  assert.equal(r.out, 'active fake\nrunning no\nparked someone-else\n');
  r = await ps(['apply', byNode, '-Parts', 'vault,config'], { env: env2, input: `${pass}\n` });
  assert.deepEqual(lastJson(r.out).parts.vault, { written: 0, kept: 2 });

  // a passphrase with accents gives the same key on both sides (stdin is read as UTF-8)
  const accented = 'été correct horse battery staple';
  r = await ps(['backup', 'fake', '-To', path.join(dir, 'out3')], { env, input: `${accented}\n` });
  assert.equal(r.code, 0, r.err);
  r = await node('backup.mjs', ['verify', lastJson(r.out).file], { env, input: `${accented}\n` });
  assert.equal(r.code, 0, r.err);
  r = await ps(['verify', byNode], { env, input: `${accented}\n` });
  assert.equal(r.code, 1); // the Node backup used the other passphrase: refused, not accepted by accident
  r = await node('backup.mjs', ['backup', 'fake', '--to', path.join(dir, 'out4')], { env, input: `${accented}\n` });
  assert.equal(r.code, 0, r.err);
  r = await ps(['verify', lastJson(r.out).file], { env, input: `${accented}\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /intact/);

  // adding an account before any was added from the page writes a clean list the dashboard can read
  r = await ps(['add', 'work', 'Work', 'account'], { env: { ...env, LOCAL_ACCOUNTS_FILE: path.join(dir, 'local.json') } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'local.json'), 'utf8')), [{ id: 'work', label: 'Work account' }]);
});
