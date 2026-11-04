import express from 'express';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  OS, SUPPORT, cookieFileLockedWhileRunning, desktopSupported, expandHome, folderBytes, insideDesktopApp, isMac, isWindows,
  openApp, openTerminal, pickPath as nativePick, quitApp,
} from '../scripts/lib/platform.mjs';
import { appAccountUuid, init as initSwap, listState, newAccount as newSwap, use as useSwap } from '../scripts/lib/desktop.mjs';

// The optional settings file (.env, gitignored) is loaded by scripts/lib/platform.mjs on import;
// real environment variables win over it.

const run = promisify(execFile);

const PORT = Number(process.env.PORT) || 3000;
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
// Accounts added on the page or from the Vault (not in accounts.json) are remembered here; gitignored.
const LOCAL_ACCOUNTS_FILE = process.env.LOCAL_ACCOUNTS_FILE || '.accounts.local.json';

// Two surfaces per account: the Claude desktop app (its data folder is renamed into place by
// scripts/lib/desktop.mjs) and Claude Code (its own config folder and login).
const absoluteOrHome = (p) => /^~[\\/]/.test(p) || path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
function makeAccount(id, label, cliConfigDir) {
  if (!/^[\w-]+$/.test(id ?? '') || id === '__proto__') throw new Error(`Invalid account id: ${id}`);
  if (cliConfigDir != null && (typeof cliConfigDir !== 'string' || !absoluteOrHome(cliConfigDir) || /["'\r\n]/.test(cliConfigDir))) {
    throw new Error(`Invalid cliConfigDir for ${id}: use an absolute path or one starting with ~/, without quotes`);
  }
  return {
    label: label || id,
    // Claude Code config folder: "main" uses the default (~/.claude), every other account uses
    // ~/.claude-<name>, unless accounts.json names a folder.
    cliConfigDir: cliConfigDir ?? (id === 'main' ? null : `~/.claude-${id}`),
  };
}

function readList(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
}

const DEFAULT_ACCOUNTS = [
  { id: 'main', label: 'Account 1: Main Claude session' },
  { id: 'test', label: 'Account 2: Empty test account' },
];

// No accounts at all is fine: the page then offers "Add an account…".
function loadAccounts() {
  const out = Object.create(null);
  for (const { id, label, cliConfigDir } of readList(ACCOUNTS_FILE) ?? DEFAULT_ACCOUNTS) {
    if (out[id]) throw new Error(`Duplicate account id: ${id}`);
    out[id] = makeAccount(id, label, cliConfigDir);
  }
  for (const { id, label } of readList(LOCAL_ACCOUNTS_FILE) ?? []) {
    if (!out[id]) out[id] = makeAccount(id, label);
  }
  return out;
}
const ACCOUNTS = loadAccounts();

// Makes an account local: one that exists in the Vault but not on this machine, or a new one made
// on the page. It gets a card; its folders are created as its parts are signed in or loaded.
// Remembered in the local accounts file.
async function registerAccount(id, label = '') {
  if (ACCOUNTS[id]) return;
  ACCOUNTS[id] = makeAccount(id, label.trim().slice(0, 80) || `Account: ${id}`);
  const list = readList(LOCAL_ACCOUNTS_FILE) ?? [];
  list.push({ id, label: ACCOUNTS[id].label });
  await fs.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const exists = (p) => fs.access(p).then(() => true, () => false);

// Protected accounts (PROTECTED_ACCOUNTS in .env, default "main"): switched to, saved to the Vault
// and backed up like any other, but never removed from this machine, and nothing of theirs is
// ever deleted from this page. Loading their own Vault entry back onto them is allowed; there is
// no way to load another account's entry onto any account.
const PROTECTED = new Set((process.env.PROTECTED_ACCOUNTS ?? 'main').split(',').map((s) => s.trim()).filter(Boolean));
function guardProtected(id) {
  if (PROTECTED.has(id)) throw httpError(403, `"${id}" is a protected account: it cannot be removed or deleted from (PROTECTED_ACCOUNTS in .env)`);
}

// Forgets an account on this machine: its card goes, in whichever file listed it. Nothing of its
// data is deleted (app data folder, Claude Code folder, login, Vault entries), so it can be added
// back any time. Refused while the Claude app is on it.
async function forgetAccount(id) {
  guardProtected(id);
  const state = await desktopState();
  if (state.supported && state.active === id) throw httpError(409, 'The Claude app is on this account: switch it to another account first');
  const base = readList(ACCOUNTS_FILE) ?? DEFAULT_ACCOUNTS;
  if (base.some((a) => a.id === id)) {
    await fs.writeFile(ACCOUNTS_FILE, `${JSON.stringify(base.filter((a) => a.id !== id), null, 2)}\n`);
  }
  const local = readList(LOCAL_ACCOUNTS_FILE) ?? [];
  if (local.some((a) => a.id === id)) {
    await fs.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(local.filter((a) => a.id !== id), null, 2)}\n`, { mode: 0o600 });
  }
  delete ACCOUNTS[id];
  return { ok: true, removed: id };
}

// ------------------------------------------------- Claude Code (CLI) launcher

// Each account keeps its own Claude Code login: a separate config folder, with its own login
// (Keychain item on macOS, credentials file elsewhere). Nothing is swapped, so opening one account
// never touches the other. The folder comes from accounts.json only, never from the request.
const CLI_WORKDIR = process.env.CLI_WORKDIR || os.homedir();

async function openCli(id) {
  const dir = ACCOUNTS[id].cliConfigDir ? path.resolve(expandHome(ACCOUNTS[id].cliConfigDir)) : null;
  try {
    return { ok: true, ...(await openTerminal({ id, configDir: dir, cwd: CLI_WORKDIR })) };
  } catch (e) {
    throw httpError(/not supported/.test(e.message) ? 501 : 500, e.message);
  }
}

// ------------------------------------------------- Claude desktop app switcher

// Switching renames the app's data folder (see scripts/lib/desktop.mjs): nothing is copied or
// deleted. The app has to be quit first, so the dashboard must not be running inside the desktop
// app itself. A switch never runs while a Vault save, load, backup or restore reads the folders
// (they would read the wrong account's data after the rename), and those never start mid-switch.
let switching = false;
let vaulting = false;
const notWhileVaulting = () => {
  if (vaulting) throw httpError(409, 'A Vault save, load, backup or restore is in progress: wait for it to finish');
};
const notWhileSwitching = () => {
  if (switching) throw httpError(409, 'A desktop switch is in progress: wait for it to finish');
};

async function desktopState() {
  if (!desktopSupported) return { supported: false };
  return { supported: true, ...(await listState()) };
}

// Switching and loading both quit the app, so the dashboard must not run inside it.
async function guardDesktopApp() {
  if (!desktopSupported) throw httpError(501, 'The desktop switcher is only supported on macOS and Windows');
  if (await insideDesktopApp()) {
    throw httpError(409, 'The dashboard is running inside the Claude desktop app, which this would quit. Start it from a terminal of your own.');
  }
}

async function quitDesktopApp() {
  try {
    await quitApp();
  } catch (e) {
    throw httpError(409, e.message);
  }
}

const openDesktopApp = () => openApp().catch(() => {});
const swapError = (e) => httpError(500, e.message);

async function switchDesktop(name) {
  await guardDesktopApp();
  if (switching) throw httpError(409, 'A desktop switch is already in progress');
  notWhileVaulting();
  switching = true;
  try {
    const state = await desktopState();
    if (!state.active) throw httpError(409, 'Not set up: first say which account the Claude app is signed in as (at the top of the dashboard)');
    if (name === state.active) return { ok: true, active: name, note: 'already active' };
    if (!state.parked.includes(name)) throw httpError(404, `No parked desktop account named ${name}`);

    if (state.running) await quitDesktopApp();
    try {
      await useSwap(name);
    } catch (e) {
      throw swapError(e);
    }
    if (state.running) await openDesktopApp(); // reopen only if it was open
    return { ok: true, active: name, relaunched: state.running };
  } finally {
    switching = false;
  }
}

// First run: the app's current data folder becomes account <id>. Nothing is moved and nothing is
// quit, so this is fine from anywhere.
async function initDesktop(id) {
  if (!desktopSupported) throw httpError(501, 'The desktop switcher is only supported on macOS and Windows');
  notWhileVaulting();
  const state = await desktopState();
  if (state.active) throw httpError(409, `Already set up: the Claude app is on "${state.active}"`);
  try {
    await initSwap(id);
  } catch (e) {
    throw swapError(e);
  }
  return { ok: true, active: id };
}

// Sign in to another account by hand: the current data folder is parked under the active
// account's name and the app is reopened empty, showing its sign-in page. The person signs in
// as <id>; from then on that folder is account <id>.
async function newDesktopAccount(id) {
  await guardDesktopApp();
  if (switching) throw httpError(409, 'A desktop switch is already in progress');
  notWhileVaulting();
  switching = true;
  try {
    const state = await desktopState();
    if (!state.active) throw httpError(409, 'Not set up: first say which account the Claude app is signed in as (at the top of the dashboard)');
    if (id === state.active) throw httpError(409, 'The Claude app is already on this account');
    if (state.parked.includes(id)) throw httpError(409, 'This account already has app data: switch to it instead');
    if (state.running) await quitDesktopApp();
    try {
      await newSwap(id);
    } catch (e) {
      if (state.running) await openDesktopApp();
      throw swapError(e);
    }
    await openDesktopApp(); // opens signed out, ready for the sign-in
    return { ok: true, active: id, parked: state.active };
  } finally {
    switching = false;
  }
}

// ------------------------------------------------------- Save to the Vault

// The two scripts do the work and never print secret values, so only their first output line is
// passed on.
const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

async function runScript(script, args) {
  try {
    const { stdout } = await run(process.execPath, [path.join(PROJECT_DIR, 'scripts', script), ...args], {
      cwd: PROJECT_DIR,
      timeout: 150_000, // includes time to click Allow on the macOS Keychain prompt
    });
    return { ok: true, message: stdout.trim().split('\n')[0] };
  } catch (e) {
    if (e.killed) return { ok: false, message: `timed out${isMac ? ' (did you click Allow on the Keychain prompt?)' : ''}` };
    const line = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n')[0];
    return { ok: false, message: line.replace(/^Error:\s*/, '') };
  }
}

const PARTS = ['desktop', 'cli'];

// parts: which of the two to save. The dashboard saves one at a time; no parts means both.
// force: replace a Vault copy that was saved from another machine since this one last synced (the
// scripts refuse that by default; the dashboard asks first, then retries with force).
async function saveToVault(id, parts = PARTS, force = false) {
  if (vaulting) throw httpError(409, 'A Vault save is already in progress');
  notWhileSwitching();
  vaulting = true;
  const args = force ? ['push', id, '--force'] : ['push', id];
  try {
    const out = {};
    if (parts.includes('desktop')) out.desktop = await saveDesktop(id, args); // may show the Keychain prompt
    if (parts.includes('cli')) out.cli = await runScript('cli-vault.mjs', args); // may show the Keychain prompt
    return out;
  } finally {
    vaulting = false;
  }
}

// On Windows the running app keeps its cookie file locked, so saving the account the app is on
// means quitting the app first and reopening it after (the page says so before asking).
async function saveDesktop(id, args) {
  const state = await desktopState();
  if (!(cookieFileLockedWhileRunning && state.supported && state.active === id && state.running)) return runScript('desktop-vault.mjs', args);
  await guardDesktopApp();
  if (switching) throw httpError(409, 'A desktop switch is already in progress');
  switching = true;
  try {
    await quitDesktopApp();
    const r = await runScript('desktop-vault.mjs', args);
    await openDesktopApp();
    return r;
  } finally {
    switching = false;
  }
}

// ----------------------------------------------------- Load from the Vault

// The opposite of Save: bring one part back from the Vault and switch to it. Each loader returns
// { ok, message }. Nothing here prints a secret; the scripts do the work.

// Desktop: put the saved login cookie into the account's folder (merged, nothing else touched),
// then make that account the one the Claude app opens. The app has to be quit for this, and is
// reopened afterwards if it was open.
async function loadDesktop(id) {
  await guardDesktopApp();
  if (switching) throw httpError(409, 'A desktop switch is already in progress');
  switching = true;
  try {
    const state = await desktopState();
    if (!state.active) throw httpError(409, 'Not set up: first say which account the Claude app is signed in as (at the top of the dashboard)');
    if (state.running) await quitDesktopApp();

    const r = await runScript('desktop-vault.mjs', ['load', id]); // may show the Keychain prompt
    if (!r.ok) {
      if (state.running) await openDesktopApp(); // leave things as they were
      throw httpError(500, r.message);
    }
    let note = '';
    if (id !== state.active) {
      try {
        await useSwap(id);
        note = ` The Claude app now opens "${id}".`;
      } catch (e) {
        if (state.running) await openDesktopApp();
        throw swapError(e);
      }
    }
    if (state.running) await openDesktopApp();
    return { ok: true, message: r.message + note, switched: id !== state.active };
  } finally {
    switching = false;
  }
}

// CLI: replace this machine's Claude Code login for the account, then open a terminal as it.
async function loadCli(id) {
  const r = await runScript('cli-vault.mjs', ['pull', id, '--replace']); // may show the Keychain prompt
  if (!r.ok) throw httpError(500, r.message);
  await openCli(id);
  return { ok: true, message: `${r.message} Opened a terminal as this account.` };
}

const LOADERS = { desktop: loadDesktop, cli: loadCli };

// What is in the Vault for one account, per part. Counts and times only, never values.
async function scriptStatus(script, id) {
  const r = await runScript(script, ['status', id, '--json']);
  if (!r.ok) return { state: 'blocked', message: r.message };
  try {
    return { state: 'ok', ...JSON.parse(r.message) };
  } catch {
    return { state: 'blocked', message: 'unexpected answer from the Vault helper' };
  }
}

async function vaultStatus(id) {
  const [desktop, cli] = await Promise.all([scriptStatus('desktop-vault.mjs', id), scriptStatus('cli-vault.mjs', id)]);
  return { desktop, cli };
}

// ----------------------------------------------------------- Full backup

// scripts/backup.mjs makes one passphrase-encrypted file with the account's logins and the files
// that cannot be re-downloaded. The passphrase reaches it on stdin only: never an argument, never
// logged, never in a URL.
function runWithStdin(script, args, input, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(PROJECT_DIR, 'scripts', script), ...args], {
      cwd: PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    p.stdin.end(input);
  });
}

async function backupAccount(id, folder, passphrase, replace = false) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw httpError(400, 'the passphrase must be at least 12 characters');
  if (typeof folder !== 'string' || !folder.trim()) throw httpError(400, 'choose a folder for the backup file');
  return runBackupTool(['backup', id, '--to', folder.trim(), ...(replace ? ['--replace'] : [])], passphrase);
}

// One backup operation at a time (the login reads can show Keychain prompts). The tool prints one
// line of JSON on success and "Error: ..." on failure.
async function runBackupTool(args, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) throw httpError(400, 'enter the passphrase');
  if (vaulting) throw httpError(409, 'A Vault save, load, backup or restore is already in progress');
  notWhileSwitching();
  vaulting = true;
  try {
    const r = await runWithStdin('backup.mjs', args, `${passphrase}\n`, 15 * 60_000);
    if (r.code !== 0) {
      const line = r.err.split('\n').find((l) => l.startsWith('Error:'));
      throw httpError(500, line ? line.replace(/^Error:\s*/, '') : 'it did not finish (timed out or was stopped)');
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  } finally {
    vaulting = false;
  }
}

// A native folder or file chooser, so a path never has to be typed. The prompts are fixed in
// scripts/lib/platform.mjs. A picked file also comes with its folder, for the page.
async function pickPath(kind) {
  let r;
  try {
    r = await nativePick(kind);
  } catch (e) {
    throw httpError(/not available/.test(e.message) ? 501 : 500, e.message);
  }
  return r.canceled || kind !== 'file' ? r : { ...r, folder: path.dirname(r.path), name: path.basename(r.path) };
}

// Backup files in a folder: names, sizes and times only. With an account, only that account's.
async function listBackups(folder, account = null) {
  if (!folder.trim()) throw httpError(400, 'choose a folder');
  if (account !== null && !/^[\w-]+$/.test(account)) throw httpError(400, 'invalid account name');
  const dir = path.resolve(expandHome(folder.trim()));
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    throw httpError(404, `no such folder: ${dir}`);
  }
  const files = [];
  const mine = account ? new RegExp(`^claude-backup-${account}-\\d{8}-\\d{6}(-\\d+)?\\.csbk$`) : /^claude-backup-.+\.csbk$/;
  for (const name of names.filter((n) => mine.test(n))) {
    const st = await fs.stat(path.join(dir, name));
    files.push({ name, path: path.join(dir, name), bytes: st.size, modified: st.mtime.toISOString() });
  }
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return { folder: dir, files };
}

const RESTORE_PARTS = ['vault', 'config', 'desktop'];
const backupFile = (file) => {
  if (typeof file !== 'string' || !file.endsWith('.csbk')) throw httpError(400, 'choose a backup file (.csbk)');
  return file;
};

// ------------------------------------------------- Deleting an account's data

const cliDirOf = (id) => expandHome(ACCOUNTS[id].cliConfigDir ?? '~/.claude');

// The one-time setup, worked out when it can be: the app's data folder names the account it was
// last signed in as (config.json, lastKnownAccountUuid), and Claude Code's own config
// (.claude.json, next to the default folder or inside any other) names the account each local
// login belongs to. Exactly one match is the answer, and the page records it. Ids are compared,
// never shown; the email comes back masked.
const maskEmail = (e) => (typeof e === 'string' && e.includes('@') ? `${e.slice(0, 2)}***${e.slice(e.indexOf('@'))}` : null);
async function cliAccount(configDir) {
  const dir = path.resolve(configDir);
  const file = dir === path.resolve(os.homedir(), '.claude') ? path.join(os.homedir(), '.claude.json') : path.join(dir, '.claude.json');
  try {
    const { oauthAccount: a } = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof a?.accountUuid === 'string' && a.accountUuid ? { uuid: a.accountUuid, email: maskEmail(a.emailAddress) } : null;
  } catch {
    return null;
  }
}
async function detectDesktopAccount(desktop) {
  if (!desktop.supported || desktop.active) return null;
  const uuid = await appAccountUuid();
  if (!uuid) return null;
  const matches = [];
  for (const id of Object.keys(ACCOUNTS)) {
    const info = await cliAccount(cliDirOf(id));
    if (info?.uuid === uuid) matches.push({ account: id, email: info.email });
  }
  return matches.length === 1 ? matches[0] : null;
}

// What an account holds, for the removal dialog: its Vault entries, what is on this machine (with
// sizes), and its backup files in the folder the page remembers. Names, sizes and times only.

async function holdings(id, backupFolder) {
  const desktop = await desktopState();
  const vault = await vaultStatus(id);
  const appDir = desktop.supported ? path.join(SUPPORT, desktop.active === id ? 'Claude' : `Claude.${id}`) : null;
  const cliDir = cliDirOf(id);
  return {
    vault,
    local: {
      appActive: Boolean(desktop.supported && desktop.active === id),
      appData: appDir && (await exists(appDir)) ? { path: appDir, bytes: await folderBytes(appDir) } : null,
      cliFolder: (await exists(cliDir)) ? { path: cliDir, bytes: await folderBytes(cliDir) } : null,
      keychain: vault.cli.local ?? null, // the Claude Code login on this machine (whatever store holds it)
    },
    backups: backupFolder ? await listBackups(backupFolder, id).catch(() => null) : null,
    passphraseSet: await passphraseSet(),
  };
}

// An optional passphrase that every deletion must give. Only a scrypt hash is stored, next to the
// Vault keys. Setting a new one needs the current one.
const PASS_FILE = process.env.DELETE_PASSPHRASE_FILE
  || path.join(process.env.VAULT_LOCAL_DIR || path.join(os.homedir(), '.claude-switcher-vault'), 'delete-passphrase');
const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const passphraseSet = () => exists(PASS_FILE);

async function checkPassphrase(given) {
  let stored;
  try {
    stored = (await fs.readFile(PASS_FILE, 'utf8')).trim();
  } catch {
    return; // none set
  }
  const [, saltHex, hashHex] = stored.split('$');
  if (typeof given !== 'string' || !given) throw httpError(403, 'enter the deletion passphrase');
  const hash = await scryptAsync(given, Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  if (!timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))) throw httpError(403, 'wrong deletion passphrase');
}

async function setPassphrase(current, next) {
  if (typeof next !== 'string' || next.length < 8) throw httpError(400, 'the passphrase must be at least 8 characters');
  await checkPassphrase(current);
  const salt = randomBytes(16);
  const hash = await scryptAsync(next, salt, 32, SCRYPT);
  await fs.mkdir(path.dirname(PASS_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(PASS_FILE, `scrypt$${salt.toString('hex')}$${hash.toString('hex')}\n`, { mode: 0o600 });
}

// Never the home folder, anything above it, or a path too short to be an account's own (fewer than
// two folders below the root, the drive letter not counting on Windows).
function guardDeletable(dir) {
  const target = path.resolve(dir);
  const home = path.resolve(os.homedir());
  const same = (a, b) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const rel = path.relative(target, home); // '' for home itself; inside target when it has no '..'
  const aboveHome = same(target, home) || (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  const depth = path.relative(path.parse(target).root, target).split(/[\\/]/).filter(Boolean).length;
  if (aboveHome || depth < 2) throw new Error(`refusing to delete ${dir}`);
}

// Deletes what was ticked, each item on its own so one failure does not stop the rest, then forgets
// the card when everything succeeded (otherwise the card stays, so the rest can be retried). The
// typed short name and the passphrase (when set) are checked first; the Claude app must not be on
// the account.
async function deleteAccountData(id, { confirm, passphrase, targets = {}, backupFolder } = {}) {
  guardProtected(id);
  if (confirm !== id) throw httpError(400, `type the account's short name (${id}) to confirm`);
  await checkPassphrase(passphrase);
  const desktop = await desktopState();
  if (desktop.supported && desktop.active === id) throw httpError(409, 'The Claude app is on this account: switch it to another account first');
  if (vaulting || switching) throw httpError(409, 'Another Vault or desktop operation is in progress');
  vaulting = true;
  const done = {};
  const errors = {};
  const step = async (key, fn) => {
    try {
      done[key] = await fn();
    } catch (e) {
      errors[key] = e.message;
    }
  };
  const viaScript = (script, args) => async () => {
    const r = await runScript(script, args);
    if (!r.ok) throw new Error(r.message);
    return r.message;
  };
  try {
    if (targets.vaultDesktop) await step('vaultDesktop', viaScript('desktop-vault.mjs', ['forget', id]));
    if (targets.vaultCli) await step('vaultCli', viaScript('cli-vault.mjs', ['forget', id]));
    if (targets.keychain) await step('keychain', viaScript('cli-vault.mjs', ['forget-keychain', id])); // may show the Keychain prompt
    if (targets.appData) {
      await step('appData', async () => {
        if (!desktop.supported || !desktop.parked.includes(id)) throw new Error('no parked app data for this account');
        const dir = path.join(SUPPORT, `Claude.${id}`);
        guardDeletable(dir);
        await fs.rm(dir, { recursive: true, force: true });
        return `Deleted the Claude app data folder ${dir}.`;
      });
    }
    if (targets.cliFolder) {
      await step('cliFolder', async () => {
        const dir = cliDirOf(id);
        if (!(await exists(dir))) throw new Error('no Claude Code folder for this account');
        guardDeletable(dir);
        await fs.rm(dir, { recursive: true, force: true });
        return `Deleted the Claude Code folder ${dir}.`;
      });
    }
    if (Array.isArray(targets.backups) && targets.backups.length) {
      await step('backups', async () => {
        const { files } = await listBackups(String(backupFolder ?? ''), id);
        const mine = new Set(files.map((f) => f.path));
        for (const p of targets.backups) if (!mine.has(p)) throw new Error(`not a backup of this account in that folder: ${p}`);
        for (const p of targets.backups) await fs.rm(p);
        return `Deleted ${targets.backups.length} backup file(s): ${targets.backups.map((p) => path.basename(p)).join(', ')}.`;
      });
    }
    const removed = !Object.keys(errors).length;
    if (removed) await forgetAccount(id);
    return { ok: removed, done, errors, removed };
  } finally {
    vaulting = false;
  }
}

// -------------------------------------------------------------------- API

const app = express();

// Only this machine's own browser may talk to the server. The Host check stops DNS rebinding (a
// web page on some-site.com whose name is pointed at 127.0.0.1); the Origin check stops cross-site
// POSTs. Both matter: a POST here can quit the Claude app or read a login.
const BUILD = new Date().toISOString(); // the page reloads itself when this changes (server restarted)
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostOf = (value) => {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
};
app.use((req, res, next) => {
  res.set('X-Dashboard-Build', BUILD);
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host ?? ''))) {
    return res.status(403).json({ error: `Open the dashboard at http://127.0.0.1:${PORT}` });
  }
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
    let host;
    try {
      host = new URL(req.headers.origin).host;
    } catch {}
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.param('id', (req, res, next, id) =>
  Object.hasOwn(ACCOUNTS, id) ? next() : res.status(404).json({ error: `Unknown account ${id}` }),
);

// Each account with what it has on this machine that the page cannot see otherwise: app data
// (the active or a parked folder) and a Claude Code folder. The login and the Vault entries come
// with the per-account Vault status.
async function accountList(desktop = null) {
  return Promise.all(Object.entries(ACCOUNTS).map(async ([id, a]) => ({
    id,
    label: a.label,
    cliConfigDir: a.cliConfigDir,
    protected: PROTECTED.has(id),
    onThisMac: {
      appData: Boolean(desktop?.supported && (desktop.active === id || desktop.parked.includes(id))),
      cliFolder: await exists(expandHome(a.cliConfigDir ?? '~/.claude')),
    },
  })));
}
app.get('/api/accounts', async (req, res) => res.json(await accountList(await desktopState())));
// Everything the page polls, in one answer. "platform" lets the page use this system's words
// (this Mac / this PC, Keychain / credentials file); "saveQuits" says a desktop save of the active
// account quits the app (Windows); "detected" is the account the app's data belongs to, when that
// can be told and the app is not assigned yet.
app.get('/api/state', async (req, res) => {
  const desktop = await desktopState();
  res.json({
    build: BUILD,
    platform: OS,
    accounts: await accountList(desktop),
    desktop: { ...desktop, switching, saveQuits: cookieFileLockedWhileRunning, detected: await detectDesktopAccount(desktop) },
  });
});

// A new account made on the page. Nothing is signed in yet; the card's rows take it from there.
app.post('/api/accounts', express.json({ limit: '4kb' }), async (req, res) => {
  const id = String(req.body?.id ?? '').trim();
  if (!/^[\w-]{1,40}$/.test(id) || id === '__proto__') throw httpError(400, 'the short name may only use letters, digits, - and _');
  if (ACCOUNTS[id]) throw httpError(409, `"${id}" already exists on this machine`);
  await registerAccount(id, String(req.body?.label ?? ''));
  res.json({ ok: true, account: id, label: ACCOUNTS[id].label });
});
app.delete('/api/accounts/:id', async (req, res) => res.json(await forgetAccount(req.params.id)));
app.get('/api/accounts/:id/holdings', async (req, res) =>
  res.json(await holdings(req.params.id, req.query.backupFolder ? String(req.query.backupFolder) : null)),
);
app.post('/api/accounts/:id/delete', express.json({ limit: '64kb' }), async (req, res) => res.json(await deleteAccountData(req.params.id, req.body ?? {})));
app.get('/api/deletion-passphrase', async (req, res) => res.json({ set: await passphraseSet() }));
app.post('/api/deletion-passphrase', express.json({ limit: '4kb' }), async (req, res) => {
  await setPassphrase(req.body?.current, req.body?.next);
  res.json({ ok: true, set: true });
});

app.get('/api/desktop', async (req, res) => res.json({ ...(await desktopState()), switching }));
app.post('/api/desktop/switch/:name', async (req, res) => {
  if (!/^[\w-]+$/.test(req.params.name)) throw httpError(404, 'Invalid account name');
  res.json(await switchDesktop(req.params.name));
});
app.post('/api/desktop/init/:id', async (req, res) => res.json(await initDesktop(req.params.id)));
app.post('/api/desktop/new/:id', async (req, res) => res.json(await newDesktopAccount(req.params.id)));
app.post('/api/accounts/:id/cli', async (req, res) => res.json(await openCli(req.params.id)));

app.get('/api/accounts/:id/vault', async (req, res) => res.json(await vaultStatus(req.params.id)));
app.post('/api/accounts/:id/vault', async (req, res) => {
  const wanted = String(req.query.parts ?? PARTS.join(',')).split(',').filter(Boolean);
  if (!wanted.length || wanted.some((p) => !PARTS.includes(p))) {
    throw httpError(400, `parts must be ${PARTS.join(' and/or ')}`);
  }
  res.json(await saveToVault(req.params.id, wanted, req.query.force === '1'));
});
async function loadPart(id, part) {
  const load = LOADERS[part];
  if (!load) throw httpError(400, `part must be one of ${Object.keys(LOADERS).join(', ')}`);
  if (vaulting) throw httpError(409, 'A Vault save or load is already in progress');
  notWhileSwitching();
  vaulting = true;
  try {
    return await load(id);
  } finally {
    vaulting = false;
  }
}
app.post('/api/accounts/:id/vault/load', async (req, res) => res.json(await loadPart(req.params.id, String(req.query.part))));

// Which accounts exist in the Vault, and which parts of each (names and times only).
async function vaultAccounts() {
  const r = await runScript('vault-list.mjs', []);
  if (!r.ok) throw httpError(502, r.message);
  const { accounts, unreadable = [], ignored = [] } = JSON.parse(r.message);
  for (const [id, a] of Object.entries(accounts)) a.local = Boolean(ACCOUNTS[id]);
  return { accounts, unreadable, ignored };
}
app.get('/api/vault/accounts', async (req, res) => res.json(await vaultAccounts()));

// Give an account that exists only in the Vault a card on this machine, so its parts can be loaded.
app.post('/api/vault/add', express.json({ limit: '4kb' }), async (req, res) => {
  const id = String(req.query.account ?? '');
  if (!/^[\w-]+$/.test(id)) throw httpError(400, 'invalid account name');
  const entry = (await vaultAccounts()).accounts[id];
  if (!entry) throw httpError(404, `"${id}" is not in the Vault`);
  await registerAccount(id, String(req.body?.label ?? ''));
  res.json({ ok: true, account: id });
});

app.post('/api/accounts/:id/backup', express.json({ limit: '16kb' }), async (req, res) =>
  res.json(await backupAccount(req.params.id, req.body?.folder, req.body?.passphrase, req.body?.replace === true)),
);
app.get('/api/backups', async (req, res) =>
  res.json(await listBackups(String(req.query.folder ?? ''), req.query.account ? String(req.query.account) : null)),
);
app.post('/api/pick', async (req, res) => {
  const kind = String(req.query.kind ?? '');
  if (!['folder', 'file'].includes(kind)) throw httpError(400, 'kind must be folder or file');
  res.json(await pickPath(kind));
});
app.post('/api/backup/inspect', express.json({ limit: '16kb' }), async (req, res) =>
  res.json(await runBackupTool(['inspect', backupFile(req.body?.file)], req.body?.passphrase)),
);
app.post('/api/backup/restore', express.json({ limit: '16kb' }), async (req, res) => {
  const { file, passphrase, parts, replaceVault } = req.body ?? {};
  if (!Array.isArray(parts) || !parts.length || parts.some((p) => !RESTORE_PARTS.includes(p))) {
    throw httpError(400, `choose what to restore: ${RESTORE_PARTS.join(', ')}`);
  }
  res.json(await runBackupTool(['apply', backupFile(file), '--parts', parts.join(','), ...(replaceVault ? ['--replace-vault'] : [])], passphrase));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' })); // lets the page tell an old server from a failure
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: String(err?.message ?? err).split('\n')[0] }));

const server = app.listen(PORT, '127.0.0.1', () => console.log(`Dashboard on http://127.0.0.1:${PORT}`));
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use: is the dashboard already running? Open http://127.0.0.1:${PORT}, or start this one with another PORT.`
    : `Cannot listen on port ${PORT}: ${err.message}`);
  process.exit(1);
});
