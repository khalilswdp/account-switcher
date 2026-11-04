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
// Settings (environment). With the local Vault from scripts/vault-local.mjs none are needed.
//   VAULT_PROVIDER          hashicorp | file            (default: hashicorp when the local token exists)
//   VAULT_ALLOWED_ACCOUNTS  comma list, default "test"  (accounts this tool may touch)
//   VAULT_ADDR, VAULT_TOKEN hashicorp: server URL and a token that may read/write the path
//   VAULT_MOUNT             hashicorp KV v2 mount, default "secret"
//   VAULT_PATH_PREFIX       hashicorp path inside the mount, default "claude-switcher"
//   VAULT_ALLOW_INSECURE=1  allow plain http to a non-local Vault (do not)
//   VAULT_FILE_DIR          file provider folder (plaintext, for testing only)
// Session values and the token are never printed.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The local Vault set up by scripts/vault-local.mjs leaves a limited token here; when it
// exists, the helper uses the local Vault with no settings at all.
const LOCAL_DIR = process.env.VAULT_LOCAL_DIR || path.join(os.homedir(), '.claude-switcher-vault');
const LOCAL_TOKEN = (() => {
  try {
    return readFileSync(path.join(LOCAL_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
})();
const PROVIDER = process.env.VAULT_PROVIDER || (LOCAL_TOKEN ? 'hashicorp' : undefined);
const VAULT_ADDR = (process.env.VAULT_ADDR || (PROVIDER === 'hashicorp' && LOCAL_TOKEN ? 'http://127.0.0.1:8200' : '')).replace(/\/+$/, '');
const MOUNT = process.env.VAULT_MOUNT || 'secret';
const PREFIX = (process.env.VAULT_PATH_PREFIX || 'claude-switcher').replace(/^\/+|\/+$/g, '');
const FILE_DIR = process.env.VAULT_FILE_DIR;
const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
const PROFILES_DIR = process.env.PROFILES_DIR || '.profiles';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
const ALLOWED = (process.env.VAULT_ALLOWED_ACCOUNTS || 'test').split(',').map((s) => s.trim()).filter(Boolean);

const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

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

// Owner-only atomic write.
async function writeFile0600(file, text) {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------- providers
// Each provider stores one opaque string per account id.

const providers = {
  file: {
    async read(id) {
      if (!FILE_DIR) fail('VAULT_FILE_DIR is required for the file provider');
      try {
        return await fs.readFile(path.join(FILE_DIR, `${id}.json`), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async write(id, text) {
      if (!FILE_DIR) fail('VAULT_FILE_DIR is required for the file provider');
      await writeFile0600(path.join(FILE_DIR, `${id}.json`), text);
    },
  },

  // HashiCorp Vault, KV version 2, over its HTTP API (no vault CLI needed).
  hashicorp: {
    async read(id) {
      const res = await vaultFetch(id, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw vaultError(res);
      return (await res.json()).data?.data?.envelope ?? null;
    },
    async write(id, text) {
      const res = await vaultFetch(id, { method: 'POST', body: JSON.stringify({ data: { envelope: text } }) });
      if (!res.ok) throw vaultError(res);
    },
  },
};

function vaultFetch(id, init) {
  const token = process.env.VAULT_TOKEN || LOCAL_TOKEN;
  if (!VAULT_ADDR || !token) fail('set VAULT_ADDR and VAULT_TOKEN, or set up the local Vault: node scripts/vault-local.mjs init');
  const { protocol, hostname } = new URL(VAULT_ADDR);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (protocol !== 'https:' && !local && !process.env.VAULT_ALLOW_INSECURE) {
    fail('refusing to send session data to a non-local Vault over plain http. Use https.');
  }
  return fetch(`${VAULT_ADDR}/v1/${MOUNT}/data/${PREFIX}/${id}`, {
    ...init,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
  }).catch((e) => fail(`cannot reach Vault at ${VAULT_ADDR}: ${e.cause?.code || e.message}`));
}

function vaultError(res) {
  if (res.status === 403) return new Error('Vault denied access (HTTP 403): the token is wrong, expired or lacks the policy (local Vault: node scripts/vault-local.mjs token)');
  if (res.status === 503) return new Error('Vault is sealed (local Vault: node scripts/vault-local.mjs unseal)');
  return new Error(`Vault answered HTTP ${res.status}`);
}

function provider() {
  if (!PROVIDER || !providers[PROVIDER]) fail(`set VAULT_PROVIDER to one of: ${Object.keys(providers).join(', ')}`);
  return providers[PROVIDER];
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
