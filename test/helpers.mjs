// Shared test helpers. Every test runs in scratch folders with:
//   - the OS parts faked (SWITCHER_STUB_DIR, see scripts/lib/platform.mjs): whether the Claude app
//     "runs" is a marker file, quitting and reopening it and opening a terminal are logged, the
//     file choosers answer STUB_PICK, and Windows' DPAPI is replaced by a visible marker
//   - on macOS, a fake "security" command on PATH (a file-backed Keychain and a fixed "Safe
//     Storage" password), so the real Keychain is never read or written and no prompt appears;
//     elsewhere the Claude Code login is a file in the scratch config folder, as for real
//   - the file provider as the Vault (VAULT_PROVIDER=file)
//   - a scratch home folder, so nothing defaults into the real one
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
export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';

export const SAFE_SERVICE = 'Test Safe Storage';
export const SAFE_PASSWORD = 'fake-safe-storage-password';
// The app's cookie key in tests: the macOS kind (16 bytes, from the fake Keychain password) on a
// Mac; the Windows kind (32 bytes, kept in each data folder's "Local State") everywhere else.
export const safeKey = () => (isMac
  ? pbkdf2Sync(SAFE_PASSWORD, 'saltysalt', 1003, 16, 'sha1')
  : createHash('sha256').update('fake-local-state-key').digest());

export const exists = (p) => fs.access(p).then(() => true, () => false);
export const scratch = (name) => fs.mkdtemp(path.join(os.tmpdir(), `claude-switcher-test-${name}-`));

// The Keychain item name the CLI uses for a config folder on macOS (mirrors scripts/lib/platform.mjs).
export const cliService = (configDir) =>
  `Claude Code-credentials-${createHash('sha256').update(path.resolve(configDir).normalize('NFC')).digest('hex').slice(0, 8)}`;

// A minimal environment: never this process's whole env, so a developer's real settings and the
// desktop app's marker variables cannot leak into a test.
export const baseEnv = () => {
  const nodeDir = path.dirname(process.execPath);
  if (isWindows) {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return {
      SystemRoot: root,
      windir: root,
      COMSPEC: process.env.COMSPEC || path.join(root, 'System32', 'cmd.exe'),
      PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      USERNAME: os.userInfo().username,
      PATH: [nodeDir, path.join(root, 'System32'), root, path.join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
    };
  }
  return {
    USER: process.env.USER || os.userInfo().username,
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    PATH: [nodeDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  };
};
// The scratch home folder, under both names (os.homedir() reads USERPROFILE on Windows).
export const homeEnv = (dir) => ({ HOME: dir, USERPROFILE: dir });

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
if (args[0] === 'delete-generic-password') {
  const s = opt('-s');
  const a = opt('-a');
  if (!fs.existsSync(file(s, a))) {
    process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n');
    process.exit(44);
  }
  fs.unlinkSync(file(s, a));
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

// What scripts/lib/platform.mjs writes in tests instead of a DPAPI blob: "DPAPI" + its fake marker.
const FAKE_DPAPI = Buffer.from('DPAPIFAKEDPAPI');

export async function makeStubs(dir) {
  const state = path.join(dir, 'stub-state');
  await fs.mkdir(state, { recursive: true });
  const env = { SWITCHER_STUB_DIR: state, SAFE_STORAGE_SERVICE: SAFE_SERVICE };
  const keychain = path.join(dir, 'keychain');
  if (isMac) {
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(keychain, { recursive: true });
    await fs.writeFile(path.join(bin, 'security'), SECURITY_STUB, { mode: 0o755 });
    env.PATH = `${bin}${path.delimiter}${baseEnv().PATH}`;
    env.FAKE_KEYCHAIN_DIR = keychain;
  }
  const keychainFile = (configDir) => path.join(keychain, encodeURIComponent(`${cliService(configDir)}|${baseEnv().USER}`));
  const credentialsFile = (configDir) => path.join(configDir, '.credentials.json');
  const read = (f) => fs.readFile(f, 'utf8').catch(() => '');
  return {
    env,
    setRunning: (on) => (on ? fs.writeFile(path.join(state, 'running'), '') : fs.rm(path.join(state, 'running'), { force: true })),
    quitLog: () => read(path.join(state, 'quit.log')),
    openLog: () => read(path.join(state, 'open.log')),
    terminalLog: () => read(path.join(state, 'terminal.log')),
    // The Claude Code login of a config folder, where this system's store keeps it.
    seedCliLogin: async (configDir, value) => {
      if (isMac) return fs.writeFile(keychainFile(configDir), value);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(credentialsFile(configDir), value);
    },
    readCliLogin: (configDir) => fs.readFile(isMac ? keychainFile(configDir) : credentialsFile(configDir), 'utf8'),
    // The app's cookie key of a data folder: on a Mac the one fake Keychain key; elsewhere the key
    // in the folder's "Local State", which seedKey writes and the code under test creates itself.
    seedKey: async (folder) => {
      if (isMac) return;
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([FAKE_DPAPI, safeKey()]).toString('base64') } }));
    },
    keyOf: async (folder) => {
      if (isMac) return safeKey();
      const raw = Buffer.from(JSON.parse(await fs.readFile(path.join(folder, 'Local State'), 'utf8')).os_crypt.encrypted_key, 'base64');
      return raw.subarray(FAKE_DPAPI.length);
    },
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

// The scratch machine most script tests start from: account "fake" active in the desktop app (with
// its cookie key in place), its Claude Code folder inside the scratch dir, the file Vault, and the
// fakes.
export async function world(name = 'world') {
  const dir = await scratch(name);
  const stubs = await makeStubs(dir);
  const support = path.join(dir, 'support');
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await stubs.seedKey(path.join(support, 'Claude'));
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  await fs.writeFile(path.join(dir, 'state', 'active'), 'fake\n');
  await fs.mkdir(path.join(dir, 'home'), { recursive: true });
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify([{ id: 'fake', cliConfigDir: path.join(dir, 'claude-fake') }]));
  const env = {
    ...stubs.env,
    ...homeEnv(path.join(dir, 'home')),
    SUPPORT_DIR: support,
    SWAP_STATE_DIR: path.join(dir, 'state'),
    SWAP_SKIP_RUNNING_CHECK: '1',
    BACKUP_DIR: path.join(dir, 'backups'),
    ACCOUNTS_FILE: path.join(dir, 'accounts.json'),
    VAULT_PROVIDER: 'file',
    VAULT_FILE_DIR: path.join(dir, 'vault'),
  };
  return { dir, env, support, stubs };
}
