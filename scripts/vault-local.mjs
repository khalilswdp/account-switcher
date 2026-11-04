#!/usr/bin/env node
// Run and manage the private local Vault (vault/docker-compose.yml).
//
//   node scripts/vault-local.mjs up            start the container
//   node scripts/vault-local.mjs init          first time only: initialise, unseal, create the
//                                              secret/ store, a limited policy and a token
//   node scripts/vault-local.mjs unseal        needed after every container restart or reboot
//   node scripts/vault-local.mjs token         issue a fresh limited token (they last 1 year)
//   node scripts/vault-local.mjs policy        re-apply the limited policy (read, write, list under claude-switcher)
//   node scripts/vault-local.mjs status
//   node scripts/vault-local.mjs backup <file> save a snapshot of everything (new-laptop move)
//   node scripts/vault-local.mjs restore <file>  load a snapshot into a freshly initialised Vault
//   node scripts/vault-local.mjs purge <entry> delete every version of one entry, e.g. desktop/test
//   node scripts/vault-local.mjs trim [keep] [entry]   keep only the latest versions (default 2) of every entry
//   node scripts/vault-local.mjs down          stop the container (data is kept)
//
// Secrets live in ~/.claude-switcher-vault (keys.json, token), owner-only, never in git.
// keys.json holds the unseal key and root token: copy it to a password manager.
// Nothing secret is ever printed.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Optional settings file in the project folder (gitignored): VAULT_PORT, VAULT_LOCAL_DIR, VAULT_IMAGE.
// Real environment variables win over it.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  /* no .env: the defaults apply */
}

const run = promisify(execFile);

const LOCAL_DIR = process.env.VAULT_LOCAL_DIR || path.join(os.homedir(), '.claude-switcher-vault');
const PORT = process.env.VAULT_PORT || '8200';
const ADDR = `http://127.0.0.1:${PORT}`;
const KEYS = path.join(LOCAL_DIR, 'keys.json');
const TOKEN_FILE = path.join(LOCAL_DIR, 'token');
const COMPOSE_FILE = fileURLToPath(new URL('../vault/docker-compose.yml', import.meta.url));
const POLICY = 'claude-switcher';
// What the helper's limited token may do: read and write entries under claude-switcher, list them
// (so the dashboard can show which accounts exist), and delete one entry with all its versions
// (the dashboard's "also delete from the Vault"). Plus listing the names at the mount's root, which
// is where the Vault UI starts browsing (folder names only, never contents). Nothing else.
const POLICY_RULES = [
  'path "secret/metadata/" { capabilities = ["list"] }',
  'path "secret/data/claude-switcher/*" { capabilities = ["create", "read", "update"] }',
  'path "secret/metadata/claude-switcher" { capabilities = ["list"] }',
  'path "secret/metadata/claude-switcher/*" { capabilities = ["list", "read", "delete"] }',
].join('\n');

const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

async function writeSecret(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

const readKeys = () => {
  try {
    return JSON.parse(readFileSync(KEYS, 'utf8'));
  } catch {
    return fail(`cannot read ${KEYS}. Run "init" first, or put your saved keys.json there.`);
  }
};

async function docker(...args) {
  try {
    return await run('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
      env: { ...process.env, VAULT_PORT: PORT },
    });
  } catch (e) {
    if (e.code === 'ENOENT') fail('docker is not installed or not on PATH');
    return fail(`docker compose failed: ${(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

// Vault API. The token goes in a header, never on a command line.
async function api(method, route, { token, json, body } = {}) {
  const headers = {};
  if (token) headers['X-Vault-Token'] = token;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${ADDR}/v1/${route}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch (e) {
    return fail(`cannot reach Vault at ${ADDR} (${e.cause?.code || e.message}). Run "up" first.`);
  }
}

async function health() {
  // Ask for HTTP 200 whatever the state, so the body tells us.
  const res = await api('GET', 'sys/health?standbyok=true&sealedcode=200&uninitcode=200&perfstandbyok=true');
  return res.json();
}

async function waitUntilReachable() {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${ADDR}/v1/sys/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  fail(`Vault did not answer on ${ADDR} within 30 seconds`);
}

async function ok(res, what) {
  if (!res.ok && res.status !== 204) fail(`${what} failed (HTTP ${res.status})`);
}

async function unsealWith(key) {
  const res = await api('PUT', 'sys/unseal', { json: { key } });
  await ok(res, 'unseal');
  const unsealed = (await res.json()).sealed === false;
  if (unsealed) await waitUntilActive();
  return unsealed;
}

// Right after an unseal the raft node is not yet the active node, and a write then fails (HTTP 500).
async function waitUntilActive() {
  for (let i = 0; i < 30; i++) {
    const h = await health();
    if (h.initialized && !h.sealed && !h.standby) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail('Vault is unsealed but not active yet; try again in a moment');
}

// The Vault keeps a new version of an entry on every write. Old versions of a login cookie
// are old secrets, so only the latest few are kept.
const KEEP_VERSIONS = 2;
const limitHistory = async (root, keep) =>
  ok(await api('POST', 'secret/config', { token: root, json: { max_versions: keep } }), 'history setting');

async function listEntries(root, prefix = '') {
  const res = await api('GET', `secret/metadata/claude-switcher/${prefix}?list=true`, { token: root });
  if (res.status === 404) return [];
  await ok(res, 'listing');
  const out = [];
  for (const k of (await res.json()).data.keys) {
    if (k.endsWith('/')) out.push(...(await listEntries(root, `${prefix}${k}`)));
    else out.push(`${prefix}${k}`);
  }
  return out;
}

async function createScopedToken(rootToken) {
  const res = await api('POST', 'auth/token/create', {
    token: rootToken,
    json: { policies: [POLICY], ttl: '8760h', renewable: true, display_name: 'claude-switcher' },
  });
  await ok(res, 'token creation');
  await writeSecret(TOKEN_FILE, (await res.json()).auth.client_token);
}

const commands = {
  async up() {
    await docker('up', '-d');
    await waitUntilReachable();
    const h = await health();
    console.log(`Vault ${h.version} is up on ${ADDR} (${h.initialized ? (h.sealed ? 'sealed: run "unseal"' : 'unsealed') : 'not initialised: run "init"'}).`);
  },

  async init() {
    await waitUntilReachable();
    if ((await health()).initialized) fail('Vault is already initialised. Use "unseal" or "token".');
    const res = await api('PUT', 'sys/init', { json: { secret_shares: 1, secret_threshold: 1 } });
    await ok(res, 'init');
    const out = await res.json();
    await writeSecret(
      KEYS,
      JSON.stringify({ unseal_key: out.keys_base64[0], root_token: out.root_token, created: new Date().toISOString() }, null, 2),
    );
    if (!(await unsealWith(out.keys_base64[0]))) fail('Vault did not unseal after init');

    const root = out.root_token;
    // The store for the session envelopes (KV version 2) and a policy limited to our path.
    const mount = await api('POST', 'sys/mounts/secret', { token: root, json: { type: 'kv', options: { version: '2' } } });
    if (!mount.ok && mount.status !== 400) fail(`creating the secret/ store failed (HTTP ${mount.status})`);
    await limitHistory(root, KEEP_VERSIONS);
    await ok(await api('PUT', `sys/policies/acl/${POLICY}`, { token: root, json: { policy: POLICY_RULES } }), 'policy creation');
    await createScopedToken(root);
    console.log('Vault initialised and unsealed.');
    console.log(`  Keys (unseal key + root token): ${KEYS}`);
    console.log(`  Limited token for the helper : ${TOKEN_FILE}`);
    console.log('IMPORTANT: copy keys.json into a password manager now. Without the unseal key the data cannot be recovered.');
  },

  async unseal() {
    await waitUntilReachable();
    const h = await health();
    if (!h.initialized) fail('Vault is not initialised. Run "init".');
    if (!h.sealed) return console.log('Vault is already unsealed.');
    if (!(await unsealWith(readKeys().unseal_key))) fail('Vault is still sealed (wrong key?)');
    console.log('Vault unsealed.');
  },

  async token() {
    const h = await health();
    if (!h.initialized || h.sealed) fail('Vault must be initialised and unsealed first.');
    await createScopedToken(readKeys().root_token);
    console.log(`New limited token written to ${TOKEN_FILE} (valid for 1 year).`);
  },

  // Re-apply the limited policy to an existing Vault. Tokens already issued pick it up at once.
  async policy() {
    const h = await health();
    if (!h.initialized || h.sealed) fail('Vault must be initialised and unsealed first.');
    await ok(await api('PUT', `sys/policies/acl/${POLICY}`, { token: readKeys().root_token, json: { policy: POLICY_RULES } }), 'policy update');
    console.log(`Policy "${POLICY}" updated: read, write, list and delete under claude-switcher, and listing the names at the root (for the UI).`);
  },

  async status() {
    const h = await health();
    console.log(`Vault ${h.version}: ${h.initialized ? 'initialised' : 'NOT initialised'}, ${h.sealed ? 'SEALED' : 'unsealed'} at ${ADDR}`);
    console.log(`keys.json : ${await fs.access(KEYS).then(() => 'present', () => 'missing')}`);
    const token = await fs.readFile(TOKEN_FILE, 'utf8').then((s) => s.trim(), () => null);
    if (!token) return console.log('token     : missing');
    if (h.sealed || !h.initialized) return console.log('token     : present');
    const res = await api('GET', 'auth/token/lookup-self', { token });
    console.log(res.ok ? `token     : valid, ${Math.round((await res.json()).data.ttl / 3600)} h left` : 'token     : present but rejected (run "token")');
  },

  async backup(file) {
    if (!file) fail('usage: backup <file>');
    if (await fs.access(file).then(() => true, () => false)) fail(`${file} already exists, refusing to overwrite`);
    const res = await api('GET', 'sys/storage/raft/snapshot', { token: readKeys().root_token });
    await ok(res, 'snapshot');
    await writeSecret(file, Buffer.from(await res.arrayBuffer()));
    console.log(`Snapshot saved to ${file}. It is encrypted by Vault, but keep it with the unseal key kept separately.`);
  },

  async restore(file) {
    if (!file) fail('usage: restore <file>');
    const data = await fs.readFile(file).catch(() => fail(`cannot read ${file}`));
    const res = await api('POST', 'sys/storage/raft/snapshot-force', { token: readKeys().root_token, body: data });
    await ok(res, 'restore');
    console.log('Snapshot restored. Vault is now sealed with the ORIGINAL keys.');
    console.log(`Put the original keys.json at ${KEYS} (from your password manager), then run "unseal" and "token".`);
  },

  // The Vault keeps old versions of every entry. This deletes ALL versions of one entry, so
  // an entry that held more than it should have does not linger in its history.
  async purge(entry) {
    if (!entry || !/^[\w][\w/-]*$/.test(entry)) fail('usage: purge <entry>, e.g. desktop/test');
    const root = readKeys().root_token;
    const route = `secret/metadata/claude-switcher/${entry}`;
    const meta = await api('GET', route, { token: root });
    if (meta.status === 404) return console.log(`Nothing stored at claude-switcher/${entry}.`);
    await ok(meta, 'metadata read');
    const data = (await meta.json()).data;
    console.log(`claude-switcher/${entry}: ${Object.keys(data.versions).length} version(s), current is ${data.current_version}.`);
    await ok(await api('DELETE', route, { token: root }), 'purge');
    console.log('All versions permanently deleted.');
  },

  // Cap the history for the whole store and for every entry already in it, and permanently
  // destroy the versions beyond the cap. Optional second argument limits it to one entry.
  async trim(keepArg, only) {
    const keep = Math.max(1, Number(keepArg) || KEEP_VERSIONS);
    const root = readKeys().root_token;
    await limitHistory(root, keep);
    for (const entry of only ? [only] : await listEntries(root)) {
      const meta = await api('GET', `secret/metadata/claude-switcher/${entry}`, { token: root });
      if (!meta.ok) continue;
      const data = (await meta.json()).data;
      await ok(await api('POST', `secret/metadata/claude-switcher/${entry}`, { token: root, json: { max_versions: keep } }), 'entry setting');
      const live = Object.entries(data.versions)
        .filter(([, v]) => !v.destroyed && !v.deletion_time)
        .map(([n]) => Number(n))
        .sort((a, b) => a - b);
      const drop = live.slice(0, Math.max(0, live.length - keep));
      if (drop.length) {
        await ok(await api('POST', `secret/destroy/claude-switcher/${entry}`, { token: root, json: { versions: drop } }), 'destroy');
      }
      console.log(`claude-switcher/${entry}: kept ${live.length - drop.length} version(s), destroyed ${drop.length}.`);
    }
    console.log(`History cap is now ${keep} version(s) per entry.`);
  },

  async down() {
    await docker('down');
    console.log('Vault stopped. Data is kept in the Docker volume.');
  },
};

const [cmd, arg, arg2] = process.argv.slice(2);
if (!commands[cmd]) fail(`usage: vault-local.mjs <${Object.keys(commands).join('|')}>`);
await commands[cmd](arg, arg2);
