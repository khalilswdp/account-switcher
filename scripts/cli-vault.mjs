#!/usr/bin/env node
// Keep a Claude Code (CLI) login in the vault so another machine can use it.
//
//   node scripts/cli-vault.mjs status [name] [--json]
//   node scripts/cli-vault.mjs push <name> [--force]            read the login, store it
//   node scripts/cli-vault.mjs pull <name> [--config <folder>] [--replace]
//                                                               write it into this machine's login store
//                                                               (--replace overwrites an existing login)
//   node scripts/cli-vault.mjs forget <name>                    delete the vault entry (every version)
//   node scripts/cli-vault.mjs forget-keychain <name>           delete this machine's login for the account
//
// Where the CLI keeps its login depends on the system (see lib/platform.mjs): a Keychain item on
// macOS (service "Claude Code-credentials" for ~/.claude, "Claude Code-credentials-<8 hex of
// sha256(path)>" for any other config folder, your user name as the account), and the file
// .credentials.json inside the config folder on Windows and Linux. The login itself is the same
// JSON everywhere, so a copy saved on a Mac loads on a PC and the other way round. Pull computes
// the place for the target folder on THIS machine. An existing login is never overwritten.
//
// Caution: the CLI rewrites the login when it refreshes its token, so a saved copy can go stale,
// and one login used on two computers at once may sign one of them out. Treat the vault copy as
// owned by one machine at a time (push refuses when the vault changed since your last pull or
// push). On macOS, reading the item makes the system ask you to allow it. The login is never printed.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail, provider, writeFile0600 } from './lib/vault-client.mjs';
import { cliLogin, expandHome } from './lib/platform.mjs';

const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';

const remoteId = (n) => `cli/${n}`;
const revFile = (n) => path.join(BACKUP_DIR, `cli-${n}.vault-rev`);

function checkName(name) {
  if (!/^[\w-]+$/.test(name ?? '')) fail('account name may only use letters, digits, - and _');
}

function configDirOf(name) {
  let list = [];
  try {
    list = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    /* no accounts.json: fall back to the defaults below */
  }
  const a = list.find((x) => x.id === name);
  // "main" uses the default config folder (~/.claude); every other account uses ~/.claude-<name>,
  // unless accounts.json names a folder.
  const dir = a?.cliConfigDir ?? (name === 'main' ? null : `~/.claude-${name}`);
  return dir ? path.resolve(expandHome(dir)) : path.join(os.homedir(), '.claude');
}

// ------------------------------------------------------------------- vault

async function readRemote(name) {
  const raw = await provider().read(remoteId(name));
  if (!raw) return null;
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    return fail('the vault entry is not valid JSON');
  }
  if (env.version !== 1 || env.format !== 'cli-keychain') fail('the vault entry has an unknown format');
  return env;
}
const lastRev = (n) => fs.readFile(revFile(n), 'utf8').then((s) => s.trim(), () => null);

// ---------------------------------------------------------------- commands

async function status(name, asJson) {
  checkName(name);
  const remote = await readRemote(name);
  const local = await cliLogin.info(configDirOf(name));
  if (asJson) {
    return console.log(JSON.stringify({
      local: local ? { present: true, modified: local.modified } : { present: false },
      vault: remote ? { pushedAt: remote.pushedAt, host: remote.host } : null,
    }));
  }
  console.log(`[${name}]`);
  console.log(`  login : ${local ? `present (modified ${local.modified})` : 'no CLI login for this config on this machine'}`);
  console.log(`  vault : ${remote ? `pushed ${remote.pushedAt} from ${remote.host}` : 'empty'}`);
}

async function push(name, force) {
  checkName(name);
  const configDir = configDirOf(name);
  const info = await cliLogin.info(configDir);
  if (!info) fail(`no CLI login found for "${name}" (${cliLogin.describe(configDir)}). Run /login with CLAUDE_CONFIG_DIR=${configDir} first.`);

  const remote = await readRemote(name);
  const rev = await lastRev(name);
  // The login's modified time changes when the CLI rewrites it: unchanged means nothing to push,
  // and we can tell without reading the secret (no prompt).
  if (remote?.fp === info.modified && !force) {
    await writeFile0600(revFile(name), remote.pushedAt);
    return console.log(`Already up to date: the "${name}" CLI login has not changed since ${remote.pushedAt}.`);
  }
  if (remote && remote.pushedAt !== rev && !force) {
    fail(`the vault entry was updated (${remote.pushedAt} from ${remote.host}) since your last pull or push. Pull first, or use --force.`);
  }

  const credential = await cliLogin.read(configDir);
  try {
    if (typeof JSON.parse(credential) !== 'object') throw new Error();
  } catch {
    fail('the stored login is not the JSON the CLI writes');
  }
  const pushedAt = new Date().toISOString();
  await provider().write(remoteId(name), JSON.stringify({ version: 1, format: 'cli-keychain', pushedAt, host: os.hostname(), fp: info.modified, credential }));
  await writeFile0600(revFile(name), pushedAt);
  console.log(`Pushed the "${name}" CLI login (${credential.length} bytes) at ${pushedAt}.`);
}

async function pull(name, configArg, replace = false) {
  checkName(name);
  const configDir = configArg ? path.resolve(expandHome(configArg)) : configDirOf(name);
  const existing = await cliLogin.info(configDir);
  if (existing && !replace) {
    fail(`a CLI login already exists for ${configDir} (${cliLogin.describe(configDir)}), refusing to overwrite. Pull into another folder with --config <path>, or add --replace to replace it.`);
  }
  const remote = await readRemote(name);
  if (!remote) fail(`nothing in the vault for "${name}" yet`);

  await cliLogin.write(configDir, remote.credential, replace);
  if (!(await cliLogin.info(configDir))) fail('the login was not written');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile0600(revFile(name), remote.pushedAt);
  console.log(`${existing ? 'Replaced the login for' : 'Pulled'} "${name}" ${existing ? 'in' : 'into'} the ${cliLogin.describe(configDir)}.`);
  console.log(`Use it with: CLAUDE_CONFIG_DIR=${configDir} CLAUDE_SECURESTORAGE_CONFIG_DIR=${configDir} claude`);
}

// Deletes the account's entry from the vault, every version of it. The local login is not touched.
async function forget(name) {
  checkName(name);
  const had = Boolean(await provider().read(remoteId(name)));
  await provider().delete(remoteId(name));
  await fs.rm(revFile(name), { force: true });
  console.log(had ? `Deleted the "${name}" CLI login from the vault (every version).` : `Nothing in the vault for "${name}".`);
}

// Deletes this machine's CLI login for the account (the Keychain item on macOS, the credentials
// file elsewhere). The vault is not touched. macOS may ask to allow it.
async function forgetKeychain(name) {
  checkName(name);
  const configDir = configDirOf(name);
  if (!(await cliLogin.info(configDir))) return console.log(`No CLI login on this machine for "${name}".`);
  await cliLogin.remove(configDir);
  if (await cliLogin.info(configDir)) fail('the login is still there');
  console.log(`Deleted the "${name}" CLI login from this machine (${cliLogin.describe(configDir)}).`);
}

const [cmd, name, ...rest] = process.argv.slice(2);
const ci = rest.indexOf('--config');
try {
  if (cmd === 'status') {
    if (!name) fail('usage: status <name> [--json]');
    await status(name, rest.includes('--json'));
  } else if (cmd === 'push') await push(name, rest.includes('--force'));
  else if (cmd === 'pull') await pull(name, ci >= 0 ? rest[ci + 1] : undefined, rest.includes('--replace'));
  else if (cmd === 'forget') await forget(name);
  else if (cmd === 'forget-keychain') await forgetKeychain(name);
  else fail('usage: cli-vault.mjs <status [name] [--json] | push <name> [--force] | pull <name> [--config <folder>] [--replace] | forget <name> | forget-keychain <name>>');
} catch (e) {
  fail(e.message);
}
