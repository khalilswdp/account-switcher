#!/usr/bin/env node
// Keep a Claude desktop account in the vault, DECRYPTED, so another Mac can run it.
//
//   node scripts/desktop-vault.mjs status [name]
//   node scripts/desktop-vault.mjs push <name> [--force]      read the account's files, decrypt, upload
//   node scripts/desktop-vault.mjs pull <name> [--as <new>]   rebuild it as a parked account on this Mac
//
// Why decrypted: the desktop app encrypts its cookies and login token with a per-Mac key
// held in the Keychain ("Claude Safe Storage"). That key is a long-lived master secret, so
// it never leaves the Keychain. On push the data is decrypted locally; on pull it is
// encrypted again with THIS Mac's own key, so no key is ever shared between machines.
//
// <name> is the account name used by scripts/desktop-swap.sh. A pull creates the parked
// folder "Claude.<name>"; switch to it with the dashboard or `desktop-swap.sh use <name>`.
// On a Mac that has never run the app, open it once and quit first (that creates the key).
//
// Only the files the app needs to start signed in are stored (see ITEMS). Reading the
// Keychain item makes macOS ask you to allow it. Nothing secret is ever printed.
//   VAULT_ALLOWED_ACCOUNTS  comma list, default "test"
//   DESKTOP_ITEMS           comma list of items to store, to experiment with a smaller set
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fail, provider, writeFile0600 } from './lib/vault-client.mjs';
import { decryptCookie, decryptV10, encryptCookie, encryptV10, readSafeStorageKey } from './lib/chromium-crypto.mjs';

const SUPPORT = process.env.SUPPORT_DIR || path.join(os.homedir(), 'Library/Application Support');
const SWAP_STATE_DIR = process.env.SWAP_STATE_DIR || path.join(os.homedir(), '.claude-desktop-accounts');
const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
const SERVICE = process.env.SAFE_STORAGE_SERVICE || 'Claude Safe Storage';
const ALLOWED = (process.env.VAULT_ALLOWED_ACCOUNTS || 'test').split(',').map((s) => s.trim()).filter(Boolean);
const ITEMS = (process.env.DESKTOP_ITEMS || 'config.json,Cookies,Local Storage,Local State,Preferences,ant-did,ant-device-registry.json')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_ENTRY = 700_000; // bytes of the stored envelope; Vault's default entry limit is about 1 MiB

const validName = (n) => /^[\w-]+$/.test(n ?? '') || fail('account name may only use letters, digits, - and _');
const parked = (n) => path.join(SUPPORT, `Claude.${n}`);
const activeFolder = path.join(SUPPORT, 'Claude');
const remoteId = (n) => `desktop/${n}`;
const revFile = (n) => path.join(BACKUP_DIR, `desktop-${n}.vault-rev`);
const exists = (p) => fs.access(p).then(() => true, () => false);
const activeName = () => {
  try {
    return readFileSync(path.join(SWAP_STATE_DIR, 'active'), 'utf8').trim();
  } catch {
    return '';
  }
};
const appRunning = () =>
  !process.env.SWAP_SKIP_RUNNING_CHECK && spawnSync('pgrep', ['-f', '/Applications/Claude.app/Contents/']).status === 0;

function checkAllowed(name) {
  validName(name);
  if (!ALLOWED.includes(name)) fail(`"${name}" is not allowed (VAULT_ALLOWED_ACCOUNTS=${ALLOWED.join(',')}). Add it there to opt in.`);
}

// ------------------------------------------------------------------ packing

async function packDir(dir) {
  const files = [];
  async function walk(rel) {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) files.push({ path: r, data: (await fs.readFile(path.join(dir, r))).toString('base64') });
    }
  }
  await walk('');
  return { kind: 'dir', files };
}

// Values stored as base64 "v10" blobs (the safeStorage token cache) are decrypted.
function packConfig(file, key) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const order = Object.keys(cfg); // so the rebuilt file keeps its original layout
  const enc = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== 'string' || !v.startsWith('djEw')) continue;
    try {
      enc[k] = decryptV10(Buffer.from(v, 'base64'), key).toString('base64');
      delete cfg[k];
    } catch {
      /* not a safeStorage value: leave it as it is */
    }
  }
  if (!Object.keys(enc).length) fail('no encrypted login data found in config.json. Is this account signed in?');
  return { kind: 'config', json: cfg, enc, order };
}

async function packCookies(file, key) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-vault-'));
  const copy = path.join(dir, 'Cookies');
  try {
    await fs.copyFile(file, copy);
    const db = new DatabaseSync(copy);
    const version = Number(db.prepare("select value from meta where key='version'").get().value);
    const values = {};
    for (const r of db.prepare('select rowid as id, host_key, encrypted_value from cookies').all()) {
      let v;
      try {
        v = decryptCookie(r.encrypted_value, r.host_key, key, version);
      } catch {
        db.close();
        fail('a cookie could not be decrypted. Is this the Mac (and Keychain key) the account was signed in on?');
      }
      if (v) values[r.id] = v.toString('base64');
    }
    db.exec("update cookies set encrypted_value = x''"); // the old ciphertext is useless elsewhere
    db.close();
    return { kind: 'cookies', version, db: (await fs.readFile(copy)).toString('base64'), values };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function packItem(name, source, key) {
  const p = path.join(source, name);
  if (name === 'config.json') return packConfig(p, key);
  if (name === 'Cookies') return packCookies(p, key);
  if ((await fs.stat(p)).isDirectory()) return packDir(p);
  return { kind: 'file', data: (await fs.readFile(p)).toString('base64') };
}

// ----------------------------------------------------------------- unpacking

async function unpackItem(name, item, root, key) {
  const p = path.join(root, name);
  if (item.kind === 'config') {
    const filled = { ...item.json };
    for (const [k, b64] of Object.entries(item.enc)) filled[k] = encryptV10(Buffer.from(b64, 'base64'), key).toString('base64');
    const cfg = {};
    for (const k of item.order ?? Object.keys(filled)) if (k in filled) cfg[k] = filled[k];
    await fs.writeFile(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } else if (item.kind === 'cookies') {
    await fs.writeFile(p, Buffer.from(item.db, 'base64'), { mode: 0o600 });
    const db = new DatabaseSync(p);
    const rows = new Map(db.prepare('select rowid as id, host_key from cookies').all().map((r) => [String(r.id), r.host_key]));
    const update = db.prepare('update cookies set encrypted_value = ? where rowid = ?');
    for (const [id, b64] of Object.entries(item.values)) {
      update.run(encryptCookie(Buffer.from(b64, 'base64'), rows.get(id), key, item.version), Number(id));
    }
    db.close();
  } else if (item.kind === 'dir') {
    await fs.mkdir(p, { recursive: true, mode: 0o700 });
    for (const f of item.files) {
      const fp = path.join(p, f.path);
      await fs.mkdir(path.dirname(fp), { recursive: true, mode: 0o700 });
      await fs.writeFile(fp, Buffer.from(f.data, 'base64'), { mode: 0o600 });
    }
  } else {
    await fs.writeFile(p, Buffer.from(item.data, 'base64'), { mode: 0o600 });
  }
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
  if (env.version !== 1 || env.format !== 'gzip-base64-json') fail('the vault entry has an unknown format');
  return env;
}

const lastRev = (n) => fs.readFile(revFile(n), 'utf8').then((s) => s.trim(), () => null);

// ----------------------------------------------------------------- commands

async function status(name) {
  checkAllowed(name);
  const remote = await readRemote(name);
  console.log(`[${name}]`);
  console.log(`  vault : ${remote ? `${remote.items.join(', ')} | pushed ${remote.pushedAt} from ${remote.host}` : 'empty'}`);
  console.log(`  local : ${(await exists(parked(name))) || activeName() === name ? 'account folder present' : 'no account folder on this Mac'}`);
}

async function push(name, force) {
  checkAllowed(name);
  const isActive = activeName() === name;
  const source = isActive ? activeFolder : parked(name);
  if (!(await exists(source))) fail(`no folder for "${name}" at ${source}`);
  if (isActive && appRunning()) fail('the Claude app is running and this account is the active one. Quit it (Cmd+Q) first.');

  const remote = await readRemote(name);
  const rev = await lastRev(name);
  if (remote && remote.pushedAt !== rev && !force) {
    fail(`the vault entry was updated (${remote.pushedAt} from ${remote.host}) since your last pull or push. Pull first, or use --force.`);
  }

  const key = await readSafeStorageKey({ service: SERVICE });
  const items = {};
  const missing = [];
  for (const item of ITEMS) {
    if (!(await exists(path.join(source, item)))) missing.push(item);
    else items[item] = await packItem(item, source, key);
  }
  if (!items['config.json'] && !items.Cookies) fail('neither config.json nor Cookies found: nothing that holds a login');

  const pushedAt = new Date().toISOString();
  const envelope = JSON.stringify({
    version: 1,
    format: 'gzip-base64-json',
    pushedAt,
    host: os.hostname(),
    items: Object.keys(items),
    payload: gzipSync(JSON.stringify(items)).toString('base64'),
  });
  if (envelope.length > MAX_ENTRY) fail(`the packed account is ${envelope.length} bytes, over the ${MAX_ENTRY} limit. Store fewer items (DESKTOP_ITEMS).`);

  await provider().write(remoteId(name), envelope);
  await writeFile0600(revFile(name), pushedAt);
  console.log(`Pushed "${name}": ${Object.keys(items).join(', ')} (${envelope.length} bytes) at ${pushedAt}.`);
  if (missing.length) console.log(`Not present in the source, skipped: ${missing.join(', ')}`);
}

async function pull(name, asName) {
  checkAllowed(name);
  const target = asName || name;
  validName(target);
  if (target === activeName()) fail(`"${target}" is the active account; pull into another name with --as`);
  if (await exists(parked(target))) fail(`${parked(target)} already exists, refusing to overwrite. Pull into another name with --as.`);

  const remote = await readRemote(name);
  if (!remote) fail(`nothing in the vault for "${name}" yet`);

  const key = await readSafeStorageKey({ service: SERVICE }); // THIS Mac's key
  const items = JSON.parse(gunzipSync(Buffer.from(remote.payload, 'base64')).toString('utf8'));

  const partial = `${parked(target)}.partial`;
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    for (const [item, packed] of Object.entries(items)) await unpackItem(item, packed, partial, key);
    await fs.rename(partial, parked(target));
  } catch (e) {
    await fs.rm(partial, { recursive: true, force: true });
    throw e;
  }
  await writeFile0600(revFile(name), remote.pushedAt);
  console.log(`Pulled "${name}" into ${parked(target)} (${Object.keys(items).join(', ')}), encrypted with this Mac's key.`);
  console.log(`Switch to it with the dashboard, or: ./scripts/desktop-swap.sh use ${target}`);
}

const [cmd, name, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const asIndex = rest.indexOf('--as');
try {
  if (cmd === 'status') {
    for (const n of name ? [name] : ALLOWED) await status(n);
  } else if (cmd === 'push') await push(name, flag('--force'));
  else if (cmd === 'pull') await pull(name, asIndex >= 0 ? rest[asIndex + 1] : undefined);
  else fail('usage: desktop-vault.mjs <status [name] | push <name> [--force] | pull <name> [--as <new>]>');
} catch (e) {
  fail(e.message);
}
