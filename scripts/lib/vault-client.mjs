// Shared Vault access for the scripts (desktop-vault, cli-vault, vault-list, backup).
// Providers store one opaque string per id (the id may contain "/"): HashiCorp Vault (KV v2
// over HTTP, no CLI needed) and a plaintext file provider for tests.
//
// Settings (environment). With the local Vault from scripts/vault-local.mjs none are needed.
//   VAULT_PROVIDER      hashicorp | file   (default: hashicorp when the local token exists)
//   VAULT_ADDR, VAULT_TOKEN   server URL and a token that may read/write the path
//   VAULT_MOUNT         KV v2 mount, default "secret"
//   VAULT_PATH_PREFIX   path inside the mount, default "claude-switcher"
//   VAULT_ALLOW_INSECURE=1   allow plain http to a non-local Vault (do not)
//   VAULT_FILE_DIR      file provider folder (plaintext, for testing only)
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Optional settings file in the project folder (gitignored) so the dashboard and every script
// share settings such as PROTECTED_ACCOUNTS without exporting them. Real environment
// variables win over it.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  /* no .env: the defaults apply */
}

export const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

// Owner-only atomic write.
export async function writeFile0600(file, data) {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

// The local Vault set up by scripts/vault-local.mjs leaves a limited token here.
export const LOCAL_DIR = process.env.VAULT_LOCAL_DIR || path.join(os.homedir(), '.claude-switcher-vault');
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

function vaultFetch(id, init, kind = 'data', query = '') {
  const token = process.env.VAULT_TOKEN || LOCAL_TOKEN;
  if (!VAULT_ADDR || !token) fail('set VAULT_ADDR and VAULT_TOKEN, or set up the local Vault: node scripts/vault-local.mjs init');
  const { protocol, hostname } = new URL(VAULT_ADDR);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (protocol !== 'https:' && !local && !process.env.VAULT_ALLOW_INSECURE) {
    fail('refusing to send session data to a non-local Vault over plain http. Use https.');
  }
  return fetch(`${VAULT_ADDR}/v1/${MOUNT}/${kind}/${PREFIX}/${id}${query}`, {
    ...init,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
  }).catch((e) => fail(`cannot reach Vault at ${VAULT_ADDR}: ${e.cause?.code || e.message}`));
}

function vaultError(res) {
  if (res.status === 403) return new Error('Vault denied access (HTTP 403): the token is wrong, expired or lacks the policy (local Vault: node scripts/vault-local.mjs token)');
  if (res.status === 503) return new Error('Vault is sealed (local Vault: node scripts/vault-local.mjs unseal)');
  return new Error(`Vault answered HTTP ${res.status}`);
}

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
    // Names directly under prefix; folders end with "/".
    async list(prefix = '') {
      if (!FILE_DIR) fail('VAULT_FILE_DIR is required for the file provider');
      try {
        return (await fs.readdir(path.join(FILE_DIR, prefix), { withFileTypes: true })).map((e) => (e.isDirectory() ? `${e.name}/` : e.name.replace(/\.json$/, '')));
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
    async delete(id) {
      if (!FILE_DIR) fail('VAULT_FILE_DIR is required for the file provider');
      await fs.rm(path.join(FILE_DIR, `${id}.json`), { force: true });
    },
  },

  hashicorp: {
    async read(id) {
      const res = await vaultFetch(id, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw vaultError(res);
      const data = (await res.json()).data?.data ?? {};
      if (typeof data.envelope === 'string') return data.envelope;
      // An entry written by hand in the Vault's own UI, as separate fields instead of one "envelope":
      // accepted as the same thing.
      return 'version' in data ? JSON.stringify(data) : null;
    },
    async write(id, text) {
      const res = await vaultFetch(id, { method: 'POST', body: JSON.stringify({ data: { envelope: text } }) });
      if (!res.ok) throw vaultError(res);
    },
    async list(prefix = '') {
      const res = await vaultFetch(prefix, { method: 'GET' }, 'metadata', '?list=true');
      if (res.status === 404) return [];
      if (!res.ok) throw vaultError(res);
      return (await res.json()).data?.keys ?? [];
    },
    // Every version of the entry, permanently. Needs "delete" on the metadata path, which the
    // limited policy grants since 2026-11-04 (re-apply it with: node scripts/vault-local.mjs policy).
    async delete(id) {
      const res = await vaultFetch(id, { method: 'DELETE' }, 'metadata');
      if (res.status === 404) return;
      if (res.status === 403) throw new Error('Vault refused the deletion: re-apply the helper policy (node scripts/vault-local.mjs policy) so the token may delete');
      if (!res.ok) throw vaultError(res);
    },
  },
};

export function provider() {
  if (!PROVIDER || !providers[PROVIDER]) fail(`set VAULT_PROVIDER to one of: ${Object.keys(providers).join(', ')}`);
  return providers[PROVIDER];
}
