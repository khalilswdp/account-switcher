#!/usr/bin/env node
// Keep a Claude Code (CLI) login in the vault so another Mac can use it.
//
//   node scripts/cli-vault.mjs status [name] [--json]
//   node scripts/cli-vault.mjs push <name> [--force]            read the Keychain item, store it
//   node scripts/cli-vault.mjs pull <name> [--config <folder>]  write it into this Mac's Keychain
//
// The CLI keeps its login in a plain Keychain item: service "Claude Code-credentials" for the
// default config folder (~/.claude), or "Claude Code-credentials-<8 hex of sha256(path)>" for
// any other, with your user name as the account. Nothing in it is tied to one Mac, so it can
// be copied. The name depends on the config folder path, so pull computes it for the target
// folder on THIS Mac. An existing item is never overwritten.
//
// Caution: the CLI rewrites this item when it refreshes its token, so a saved copy can go
// stale, and one login used on two laptops at once may sign one of them out. Treat the vault
// copy as owned by one machine at a time (push refuses when the vault changed since your last
// pull or push). Reading the item makes macOS ask you to allow it. The login is never printed.
//   VAULT_ALLOWED_ACCOUNTS  comma list, default "test"
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, provider, writeFile0600 } from './lib/vault-client.mjs';

const run = promisify(execFile);
const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
const ALLOWED = (process.env.VAULT_ALLOWED_ACCOUNTS || 'test').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = 'Claude Code-credentials';
const KEYCHAIN_USER = process.env.USER || os.userInfo().username; // the CLI looks its item up by $USER

const remoteId = (n) => `cli/${n}`;
const revFile = (n) => path.join(BACKUP_DIR, `cli-${n}.vault-rev`);
const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function checkAllowed(name) {
  if (!/^[\w-]+$/.test(name ?? '')) fail('account name may only use letters, digits, - and _');
  if (!ALLOWED.includes(name)) fail(`"${name}" is not allowed (VAULT_ALLOWED_ACCOUNTS=${ALLOWED.join(',')}). Add it there to opt in.`);
}

function configDirOf(name) {
  let list = [];
  try {
    list = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    /* no accounts.json: fall back to the defaults below */
  }
  const a = list.find((x) => x.id === name);
  if (!a && !['main', 'test'].includes(name)) fail(`unknown account "${name}"`);
  const dir = a?.cliConfigDir ?? (name === 'test' ? '~/.claude-test' : null);
  return dir ? path.resolve(expand(dir)) : path.join(os.homedir(), '.claude');
}

const serviceFor = (configDir) => {
  const dir = path.resolve(configDir).normalize('NFC');
  return dir === path.join(os.homedir(), '.claude') ? BASE : `${BASE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
};

// ---------------------------------------------------------------- Keychain

// Attributes only (no -w), so no prompt. Returns null when the item does not exist.
async function itemInfo(service) {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', KEYCHAIN_USER]);
    return { modified: /"mdat"<timedate>=\S+\s+"(\d{14}Z)/.exec(stdout)?.[1] ?? 'unknown' };
  } catch (e) {
    if (/could not be found/i.test(e.stderr || '')) return null;
    throw new Error('could not look in the Keychain');
  }
}

async function readSecret(service) {
  try {
    return (await run('security', ['find-generic-password', '-s', service, '-a', KEYCHAIN_USER, '-w'], { timeout: 120_000 })).stdout.replace(/\n$/, '');
  } catch {
    throw new Error('could not read the Keychain item (access denied or timed out)');
  }
}

// `security -i` takes the command on stdin, so the login never appears in a process list.
// The value goes in as hex to avoid any quoting problem.
function writeSecret(service, secret) {
  return new Promise((resolve, reject) => {
    const p = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => (/error|fail/i.test(err) ? reject(new Error('could not write the Keychain item')) : resolve()));
    p.stdin.end(`add-generic-password -s "${service}" -a "${KEYCHAIN_USER}" -X ${Buffer.from(secret).toString('hex')}\n`);
  });
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
  checkAllowed(name);
  const remote = await readRemote(name);
  const local = await itemInfo(serviceFor(configDirOf(name)));
  if (asJson) {
    return console.log(JSON.stringify({
      local: local ? { present: true, modified: local.modified } : { present: false },
      vault: remote ? { pushedAt: remote.pushedAt, host: remote.host } : null,
    }));
  }
  console.log(`[${name}]`);
  console.log(`  keychain : ${local ? `login present (modified ${local.modified})` : 'no CLI login for this config on this Mac'}`);
  console.log(`  vault    : ${remote ? `pushed ${remote.pushedAt} from ${remote.host}` : 'empty'}`);
}

async function push(name, force) {
  checkAllowed(name);
  const configDir = configDirOf(name);
  const service = serviceFor(configDir);
  const info = await itemInfo(service);
  if (!info) fail(`no CLI login found for "${name}" (Keychain item "${service}"). Run /login with CLAUDE_CONFIG_DIR=${configDir} first.`);

  const remote = await readRemote(name);
  const rev = await lastRev(name);
  // The item's modified time changes when the CLI rewrites it: unchanged means nothing to push,
  // and we can tell without reading the secret (no prompt).
  if (remote?.fp === info.modified && !force) {
    await writeFile0600(revFile(name), remote.pushedAt);
    return console.log(`Already up to date: the "${name}" CLI login has not changed since ${remote.pushedAt}.`);
  }
  if (remote && remote.pushedAt !== rev && !force) {
    fail(`the vault entry was updated (${remote.pushedAt} from ${remote.host}) since your last pull or push. Pull first, or use --force.`);
  }

  const credential = await readSecret(service);
  try {
    if (typeof JSON.parse(credential) !== 'object') throw new Error();
  } catch {
    fail('the Keychain item is not the JSON login the CLI writes');
  }
  const pushedAt = new Date().toISOString();
  await provider().write(remoteId(name), JSON.stringify({ version: 1, format: 'cli-keychain', pushedAt, host: os.hostname(), fp: info.modified, credential }));
  await writeFile0600(revFile(name), pushedAt);
  console.log(`Pushed the "${name}" CLI login (${credential.length} bytes) at ${pushedAt}.`);
}

async function pull(name, configArg) {
  checkAllowed(name);
  const configDir = configArg ? path.resolve(expand(configArg)) : configDirOf(name);
  const service = serviceFor(configDir);
  if (await itemInfo(service)) {
    fail(`a CLI login already exists for ${configDir} (Keychain item "${service}"), refusing to overwrite. Pull into another folder with --config <path>.`);
  }
  const remote = await readRemote(name);
  if (!remote) fail(`nothing in the vault for "${name}" yet`);

  await writeSecret(service, remote.credential);
  if (!(await itemInfo(service))) fail('the Keychain item was not created');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile0600(revFile(name), remote.pushedAt);
  console.log(`Pulled "${name}" into the Keychain item for ${configDir}.`);
  console.log(`Use it with: CLAUDE_CONFIG_DIR=${configDir} CLAUDE_SECURESTORAGE_CONFIG_DIR=${configDir} claude`);
}

const [cmd, name, ...rest] = process.argv.slice(2);
const ci = rest.indexOf('--config');
try {
  if (cmd === 'status') {
    for (const n of name ? [name] : ALLOWED) await status(n, rest.includes('--json'));
  } else if (cmd === 'push') await push(name, rest.includes('--force'));
  else if (cmd === 'pull') await pull(name, ci >= 0 ? rest[ci + 1] : undefined);
  else fail('usage: cli-vault.mjs <status [name] [--json] | push <name> [--force] | pull <name> [--config <folder>]>');
} catch (e) {
  fail(e.message);
}
