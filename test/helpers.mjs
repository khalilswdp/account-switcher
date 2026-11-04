// Shared test helpers. Every test runs in scratch folders with:
//   - a fake macOS "security" command on PATH (a file-backed Keychain and a fixed "Safe Storage"
//     password), so the real Keychain is never read or written and no prompt appears
//   - fake pgrep / osascript / open commands, so "the Claude app is running", quitting and
//     reopening it can be simulated
//   - the file provider as the Vault (VAULT_PROVIDER=file)
//   - a scratch HOME, so nothing defaults into the real home folder
// Nothing here touches real logins. Test values are obviously fake and never printed by the code
// under test (the tests check that).
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { encryptCookie } from '../scripts/lib/chromium-crypto.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SCRIPTS = path.join(ROOT, 'scripts');

export const SAFE_SERVICE = 'Test Safe Storage';
export const SAFE_PASSWORD = 'fake-safe-storage-password';
export const safeKey = () => pbkdf2Sync(SAFE_PASSWORD, 'saltysalt', 1003, 16, 'sha1');

export const exists = (p) => fs.access(p).then(() => true, () => false);
export const scratch = (name) => fs.mkdtemp(path.join(os.tmpdir(), `claude-switcher-test-${name}-`));

// The Keychain item name the CLI uses for a config folder (mirrors scripts/cli-vault.mjs).
export const cliService = (configDir) =>
  `Claude Code-credentials-${createHash('sha256').update(path.resolve(configDir).normalize('NFC')).digest('hex').slice(0, 8)}`;

// A minimal environment: never this process's whole env, so a developer's real settings and the
// desktop app's marker variable (__CFBundleIdentifier) cannot leak into a test.
export const baseEnv = () => ({
  USER: process.env.USER || os.userInfo().username,
  TMPDIR: os.tmpdir(),
  LANG: 'C',
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
});

export function run(cmd, args, { env = {}, input, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...baseEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
}
export const node = (script, args, opts) => run(process.execPath, [path.join(SCRIPTS, script), ...args], opts);

// ------------------------------------------------------------------ stubs

const SECURITY_STUB = `#!/usr/bin/env node
// Fake macOS "security" for tests: a file-backed Keychain and a fixed "Safe Storage" password.
const fs = require('node:fs');
const path = require('node:path');
const store = process.env.FAKE_KEYCHAIN_DIR;
const file = (s, a) => path.join(store, encodeURIComponent(s + '|' + a));
const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === 'find-generic-password') {
  const s = opt('-s');
  const a = opt('-a');
  if (s === process.env.SAFE_STORAGE_SERVICE) {
    if (args.includes('-w')) process.stdout.write(${JSON.stringify(SAFE_PASSWORD)} + '\\n');
    process.exit(0);
  }
  if (!fs.existsSync(file(s, a))) {
    process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n');
    process.exit(44);
  }
  if (args.includes('-w')) {
    process.stdout.write(fs.readFileSync(file(s, a)) + '\\n');
    process.exit(0);
  }
  const stamp = fs.statSync(file(s, a)).mtime.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  process.stdout.write('keychain: "login"\\nattributes:\\n    "mdat"<timedate>=0x' + Buffer.from(stamp).toString('hex') + '  "' + stamp + '"\\n');
  process.exit(0);
}
if (args[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8');
  const m = /add-generic-password -s "([^"]*)" -a "([^"]*)" -X ([0-9a-fA-F]+)( -U)?/.exec(line);
  if (!m) { process.stderr.write('fake security: unsupported command\\n'); process.exit(1); }
  if (fs.existsSync(file(m[1], m[2])) && !m[4]) {
    process.stderr.write('security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\\n');
    process.exit(45);
  }
  fs.writeFileSync(file(m[1], m[2]), Buffer.from(m[3], 'hex'));
  process.exit(0);
}
process.stderr.write('fake security: unsupported ' + args[0] + '\\n');
process.exit(1);
`;

const PGREP_STUB = `#!/bin/sh
# fake pgrep: "the Claude app is running" while the marker file exists
[ -e "$STUB_STATE/running" ]
`;

const OSASCRIPT_STUB = `#!/bin/sh
# fake osascript: records what it was asked; "quit" stops the fake app; the choosers answer STUB_PICK
printf '%s\\n' "$*" >> "$STUB_STATE/osascript.log"
case "$*" in
  *"to quit"*) rm -f "$STUB_STATE/running" ;;
  *"choose folder"*|*"choose file"*) printf '%s\\n' "$STUB_PICK" ;;
esac
exit 0
`;

const OPEN_STUB = `#!/bin/sh
# fake open: records the call and "starts" the fake app
printf '%s\\n' "$*" >> "$STUB_STATE/open.log"
touch "$STUB_STATE/running"
exit 0
`;

export async function makeStubs(dir) {
  const bin = path.join(dir, 'bin');
  const keychain = path.join(dir, 'keychain');
  const state = path.join(dir, 'stub-state');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(keychain, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  for (const [name, body] of [['security', SECURITY_STUB], ['pgrep', PGREP_STUB], ['osascript', OSASCRIPT_STUB], ['open', OPEN_STUB]]) {
    await fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
  }
  const file = (service, account) => path.join(keychain, encodeURIComponent(`${service}|${account}`));
  const read = (f) => fs.readFile(f, 'utf8').catch(() => '');
  return {
    env: {
      PATH: `${bin}:${baseEnv().PATH}`,
      FAKE_KEYCHAIN_DIR: keychain,
      STUB_STATE: state,
      SAFE_STORAGE_SERVICE: SAFE_SERVICE,
    },
    seedKeychain: (service, account, value) => fs.writeFile(file(service, account), value),
    readKeychain: (service, account) => fs.readFile(file(service, account), 'utf8'),
    setRunning: (on) => (on ? fs.writeFile(path.join(state, 'running'), '') : fs.rm(path.join(state, 'running'), { force: true })),
    osascriptLog: () => read(path.join(state, 'osascript.log')),
    openLog: () => read(path.join(state, 'open.log')),
  };
}

// A cookie database shaped like the Claude app's (schema version 24), with each value encrypted the
// way the app does it. Timestamps are deliberately larger than a double can hold exactly.
export function makeCookieDb(file, key, cookies) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta VALUES('version','24'),('last_compatible_version','24');
    CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL,
      UNIQUE (host_key, top_frame_site_key, name, path, source_scheme, source_port));
  `);
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 1, 1, 1, 0, 2, 443, ?, 0, 0)');
  let t = 13400000000000000n;
  for (const c of cookies) {
    t += 1n;
    insert.run(t, c.host, '', c.name, '', encryptCookie(Buffer.from(c.value), c.host, key, 24), '/', t + 10n ** 12n, t, t);
  }
  db.close();
}

// The scratch "Mac" most script tests start from: account "fake" active in the desktop app, its
// Claude Code folder inside the scratch dir, the file Vault, and the stubs on PATH.
export async function world(name = 'world') {
  const dir = await scratch(name);
  const stubs = await makeStubs(dir);
  const support = path.join(dir, 'support');
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  await fs.writeFile(path.join(dir, 'state', 'active'), 'fake\n');
  await fs.mkdir(path.join(dir, 'home'), { recursive: true });
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify([{ id: 'fake', cliConfigDir: path.join(dir, 'claude-fake') }]));
  const env = {
    ...stubs.env,
    USER: baseEnv().USER,
    HOME: path.join(dir, 'home'),
    SUPPORT_DIR: support,
    SWAP_STATE_DIR: path.join(dir, 'state'),
    SWAP_SKIP_RUNNING_CHECK: '1',
    BACKUP_DIR: path.join(dir, 'backups'),
    ACCOUNTS_FILE: path.join(dir, 'accounts.json'),
    VAULT_PROVIDER: 'file',
    VAULT_FILE_DIR: path.join(dir, 'vault'),
    VAULT_ALLOWED_ACCOUNTS: 'fake,other',
  };
  return { dir, env, support, stubs };
}
