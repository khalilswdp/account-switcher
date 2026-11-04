#!/usr/bin/env node
// Move an account's claude.ai session between machines through a vault.
//
//   node scripts/vault.mjs status [id]
//   node scripts/vault.mjs push <id> [--force]   upload .backups/<id>.json
//   node scripts/vault.mjs pull <id> [--force]   download it for the dashboard to import
//
// New machine: clone the repo, `pull <id>`, then `npm start`. The dashboard imports the
// pulled session into a fresh profile on first start.
//
// One machine owns an account at a time. Many sign-ins replace their tokens on use, so a
// stale copy can stop working. `push` refuses when the vault changed since your last
// pull or push (use --force to override).
//
// Vault settings live in scripts/lib/vault-client.mjs (none needed for the local Vault).
//   VAULT_ALLOWED_ACCOUNTS  comma list, default "test"  (accounts this tool may touch)
// Session values and the token are never printed.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail, provider, writeFile0600 } from './lib/vault-client.mjs';

const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
const PROFILES_DIR = process.env.PROFILES_DIR || '.profiles';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
const ALLOWED = (process.env.VAULT_ALLOWED_ACCOUNTS || 'test').split(',').map((s) => s.trim()).filter(Boolean);

function accountIds() {
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')).map((a) => a.id);
  } catch (e) {
    if (e.code === 'ENOENT') return ['main', 'test'];
    return fail(`cannot read ${ACCOUNTS_FILE}: ${e.message}`);
  }
}

function checkAccount(id) {
  if (!id || !accountIds().includes(id)) fail(`unknown account "${id ?? ''}". Known: ${accountIds().join(', ')}`);
  if (!ALLOWED.includes(id)) {
    fail(`"${id}" is not allowed (VAULT_ALLOWED_ACCOUNTS=${ALLOWED.join(',')}). Add it there to opt in.`);
  }
}

// ------------------------------------------------------------------ helpers

const backupFile = (id) => path.join(BACKUP_DIR, `${id}.json`);
const revFile = (id) => path.join(BACKUP_DIR, `${id}.vault-rev`); // pushedAt of the last pull/push
const sha = (text) => createHash('sha256').update(text).digest('hex');
const countCookies = (state) => (Array.isArray(state?.cookies) ? state.cookies.length : 0);

async function readLocal(id) {
  try {
    const text = await fs.readFile(backupFile(id), 'utf8');
    return { text, state: JSON.parse(text) };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return fail(`cannot read ${backupFile(id)}: ${e.message}`);
  }
}

async function readRemote(id) {
  const raw = await provider().read(id);
  if (!raw) return null;
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    return fail('the vault entry is not valid JSON');
  }
  if (env.version !== 1 || !env.state) fail('the vault entry has an unknown format');
  return env;
}

const lastRev = (id) => fs.readFile(revFile(id), 'utf8').then((s) => s.trim(), () => null);

// ----------------------------------------------------------------- commands

async function status(id) {
  checkAccount(id);
  const local = await readLocal(id);
  const remote = await readRemote(id);
  const rev = await lastRev(id);
  console.log(`[${id}]`);
  console.log(`  local  : ${local ? `${countCookies(local.state)} cookies` : 'no session backup'}`);
  console.log(`  vault  : ${remote ? `${countCookies(remote.state)} cookies, pushed ${remote.pushedAt} from ${remote.host}` : 'empty'}`);
  if (local && remote) {
    const same = sha(JSON.stringify(local.state)) === sha(JSON.stringify(remote.state));
    console.log(`  state  : ${same ? 'in sync' : rev === remote.pushedAt ? 'local changed since last sync (push to upload)' : 'vault has a different version (pull, or push --force)'}`);
  }
}

async function push(id, force) {
  checkAccount(id);
  const local = await readLocal(id);
  if (!local || countCookies(local.state) === 0) {
    fail(`no session to push for "${id}". Sign in on the dashboard and run a task first (that writes ${backupFile(id)}).`);
  }
  const remote = await readRemote(id);
  const rev = await lastRev(id);
  if (remote && remote.pushedAt !== rev && !force) {
    fail(`the vault entry was updated (${remote.pushedAt} from ${remote.host}) since your last pull or push. Pull first, or use --force.`);
  }
  const pushedAt = new Date().toISOString();
  await provider().write(id, JSON.stringify({ version: 1, pushedAt, host: os.hostname(), state: local.state }));
  await writeFile0600(revFile(id), pushedAt);
  console.log(`Pushed "${id}" (${countCookies(local.state)} cookies) at ${pushedAt}.`);
}

async function pull(id, force) {
  checkAccount(id);
  const remote = await readRemote(id);
  if (!remote) fail(`nothing in the vault for "${id}" yet`);
  if (countCookies(remote.state) === 0) fail('the vault entry holds no cookies');

  const local = await readLocal(id);
  if (local && !force) {
    if (sha(JSON.stringify(local.state)) === sha(JSON.stringify(remote.state))) {
      await writeFile0600(revFile(id), remote.pushedAt);
      console.log(`"${id}" is already up to date.`);
      return;
    }
    fail(`a different local backup already exists at ${backupFile(id)}. Use --force to replace it.`);
  }
  await writeFile0600(backupFile(id), JSON.stringify(remote.state));
  await writeFile0600(revFile(id), remote.pushedAt);

  // A reset profile blocks re-import via a flag; clear it so a fresh profile imports.
  const ready = await fs.access(path.join(PROFILES_DIR, id, '.synced')).then(() => true, () => false);
  if (!ready) await fs.rm(path.join(PROFILES_DIR, `.imported-${id}`), { force: true });

  console.log(`Pulled "${id}" (${countCookies(remote.state)} cookies, pushed ${remote.pushedAt} from ${remote.host}).`);
  console.log(ready
    ? 'Note: this profile is already set up, so the dashboard will not re-import. Reset it on the dashboard first to use the pulled session.'
    : 'Start the dashboard (npm start): it imports this session into a fresh profile.');
}

const [cmd, id, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
try {
  if (cmd === 'status') {
    for (const a of id ? [id] : ALLOWED.filter((x) => accountIds().includes(x))) await status(a);
  } else if (cmd === 'push') await push(id, force);
  else if (cmd === 'pull') await pull(id, force);
  else fail('usage: vault.mjs <status [id] | push <id> | pull <id>> [--force]');
} catch (e) {
  fail(e.message);
}
