#!/usr/bin/env node
// Keep a Claude desktop account in the vault, DECRYPTED, so another machine can run it.
//
//   node scripts/desktop-vault.mjs status [name]
//   node scripts/desktop-vault.mjs push <name> [--force]      read the account's files, decrypt, upload
//   node scripts/desktop-vault.mjs pull <name> [--as <new>]   rebuild it as a parked account on this machine
//   node scripts/desktop-vault.mjs load <name>                merge the saved login into the account's own folder
//   node scripts/desktop-vault.mjs forget <name>              delete the account's entry from the vault (every version)
//
// Why decrypted: the desktop app encrypts its cookies and login token with a key that stays on
// the machine (macOS: one per Mac in the Keychain, "Claude Safe Storage"; Windows: one per data
// folder in its "Local State" file, protected with DPAPI for that Windows user). That key is a
// long-lived master secret, so it never leaves the machine. On push the data is decrypted
// locally; on pull it is encrypted again with THIS machine's own key, so no key is ever shared
// between machines, and a login saved on a Mac loads on a PC and the other way round.
//
// <name> is the account name used by scripts/desktop-swap.mjs. A pull creates the parked
// folder "Claude.<name>"; switch to it with the dashboard or `desktop-swap.mjs use <name>`.
// On a Mac that has never run the app, open it once and quit first (that creates the key).
//
// Only the login cookie (sessionKey) is stored by default: it is all the app needs to start
// signed in. On macOS, reading the Keychain item makes the system ask you to allow it. On
// Windows the app keeps its cookie file locked while it runs, so the account the app is on can
// only be pushed with the app quit (the dashboard quits and reopens it). Nothing secret is ever
// printed.
//   DESKTOP_ITEMS           comma list of items to store instead (config.json, "Local Storage", ...)
//   DESKTOP_COOKIES         comma list of cookie names to keep, default "sessionKey" ("*" keeps all)
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fail, provider, writeFile0600 } from './lib/vault-client.mjs';
import { decryptCookie, decryptV10, encryptCookie, encryptV10 } from './lib/chromium-crypto.mjs';
import { appRunning, cookieFileIn, cookieFileLockedWhileRunning, ensureSafeStorageKey, readSafeStorageKey } from './lib/platform.mjs';
import { ACTIVE_FOLDER, activeName, parked } from './lib/desktop.mjs';

const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
// Tested on 2026-11-04 (macOS): the app starts signed in from the Cookies file alone (config.json
// alone does not). Everything else it rebuilds itself, so only the cookies are stored.
const ITEMS = (process.env.DESKTOP_ITEMS || 'Cookies').split(',').map((s) => s.trim()).filter(Boolean);
// Also tested: of the cookies, sessionKey alone signs the app in. The consent cookie is left
// out on purpose: it only hides the cookie banner, and a consent choice should be made on
// each machine, not carried over from another one. "*" keeps every cookie.
const COOKIES = (process.env.DESKTOP_COOKIES || 'sessionKey').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_ENTRY = 700_000; // bytes of the stored envelope; Vault's default entry limit is about 1 MiB

const validName = (n) => /^[\w-]+$/.test(n ?? '') || fail('account name may only use letters, digits, - and _');
const remoteId = (n) => `desktop/${n}`;
const revFile = (n) => path.join(BACKUP_DIR, `desktop-${n}.vault-rev`);
const exists = (p) => fs.access(p).then(() => true, () => false);
const checkName = (name) => void validName(name);
// Where an item lives inside a data folder: the cookie database moves between builds.
const itemPath = (folder, name) => (name === 'Cookies' ? cookieFileIn(folder) : path.join(folder, name));

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

// A consistent copy of a cookie database that is safe to take while the Claude app is using it
// (on macOS; Windows locks the file): SQLite's own VACUUM INTO over a read-only connection (it
// waits for a writer's lock instead of reading half-written pages), not a file copy. The live
// file is never written to.
function snapshotCookies(file, dest) {
  let src;
  try {
    src = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    throw new Error(`could not read the cookie file (${e.message.split('\n')[0]}). Quit the Claude app, or try again in a moment.`);
  } finally {
    src?.close();
  }
}

async function packCookies(file, key) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-vault-'));
  const copy = path.join(dir, 'Cookies');
  try {
    snapshotCookies(file, copy);
    const db = new DatabaseSync(copy);
    const version = Number(db.prepare("select value from meta where key='version'").get().value);
    if (!COOKIES.includes('*')) {
      db.prepare(`delete from cookies where name not in (${COOKIES.map(() => '?').join(',')})`).run(...COOKIES);
    }
    if (db.prepare('select count(*) as n from cookies').get().n === 0) {
      db.close();
      fail(`none of the cookies to store (${COOKIES.join(', ')}) were found. Is this account signed in?`);
    }
    const values = {};
    for (const r of db.prepare('select rowid as id, host_key, encrypted_value from cookies').all()) {
      let v;
      try {
        v = decryptCookie(r.encrypted_value, r.host_key, key, version);
      } catch {
        db.close();
        fail('a cookie could not be decrypted. Is this the machine (and the key) the account was signed in on?');
      }
      if (v) values[r.id] = v.toString('base64');
    }
    db.exec("update cookies set encrypted_value = x''"); // the old ciphertext is useless elsewhere
    db.exec('vacuum'); // and no deleted rows linger in free pages
    db.close();
    return { kind: 'cookies', version, db: (await fs.readFile(copy)).toString('base64'), values };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function packItem(name, source, key) {
  const p = itemPath(source, name);
  if (name === 'config.json') return packConfig(p, key);
  if (name === 'Cookies') return packCookies(p, key);
  if ((await fs.stat(p)).isDirectory()) return packDir(p);
  return { kind: 'file', data: (await fs.readFile(p)).toString('base64') };
}

// A fingerprint of what would be pushed, taken from the still-encrypted source files, so
// "nothing changed" can be detected without the key (no prompt, no new Vault version).
async function fingerprint(source) {
  const h = createHash('sha256');
  h.update(JSON.stringify({ items: ITEMS, cookies: COOKIES }));
  for (const name of ITEMS) {
    const p = itemPath(source, name);
    if (!(await exists(p))) continue;
    h.update(`\n${name}\n`);
    if (name === 'Cookies') {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-vault-fp-'));
      try {
        const copy = path.join(dir, 'Cookies');
        snapshotCookies(p, copy);
        const db = new DatabaseSync(copy, { readOnly: true });
        const all = COOKIES.includes('*');
        const rows = db
          .prepare(`select host_key, name, path, hex(encrypted_value) as v from cookies ${all ? '' : `where name in (${COOKIES.map(() => '?').join(',')})`} order by host_key, name, path`)
          .all(...(all ? [] : COOKIES));
        for (const r of rows) h.update(`${r.host_key}|${r.name}|${r.path}|${r.v}\n`);
        db.close();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } else if ((await fs.stat(p)).isDirectory()) {
      for (const f of (await packDir(p)).files.sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}:${f.data}\n`);
    } else {
      h.update(await fs.readFile(p));
    }
  }
  return h.digest('hex');
}

// ----------------------------------------------------------------- unpacking

async function unpackItem(name, item, root, key) {
  const p = itemPath(root, name);
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
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

// Adds or replaces the saved cookies inside an EXISTING cookie database, encrypted with this
// machine's key. The cookies already there, and everything else in the account folder, stay.
async function mergeCookies(file, packed, key) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-vault-merge-'));
  try {
    const src = path.join(dir, 'Cookies');
    await fs.writeFile(src, Buffer.from(packed.db, 'base64'));
    const incoming = new DatabaseSync(src);
    const select = incoming.prepare('select rowid as _id, * from cookies');
    select.setReadBigInts(true); // Chromium timestamps do not fit a plain JS integer
    const rows = select.all();
    incoming.close();

    const db = new DatabaseSync(file);
    const version = Number(db.prepare("select value from meta where key='version'").get().value);
    const columns = new Set(db.prepare('pragma table_info(cookies)').all().map((c) => c.name));
    const remove = db.prepare('delete from cookies where host_key = ? and name = ? and path = ?');
    for (const r of rows) {
      const plain = packed.values[String(r._id)];
      if (!plain) continue;
      const { _id, ...row } = r;
      row.encrypted_value = encryptCookie(Buffer.from(plain, 'base64'), row.host_key, key, version);
      const use = Object.keys(row).filter((c) => columns.has(c));
      remove.run(row.host_key, row.name, row.path);
      db.prepare(`insert into cookies (${use.join(',')}) values (${use.map(() => '?').join(',')})`).run(...use.map((c) => row[c]));
    }
    db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
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

async function status(name, asJson) {
  checkName(name);
  const remote = await readRemote(name);
  if (asJson) {
    return console.log(JSON.stringify({ vault: remote ? { items: remote.items, pushedAt: remote.pushedAt, host: remote.host } : null }));
  }
  console.log(`[${name}]`);
  console.log(`  vault : ${remote ? `${remote.items.join(', ')} | pushed ${remote.pushedAt} from ${remote.host}` : 'empty'}`);
  console.log(`  local : ${(await exists(parked(name))) || activeName() === name ? 'account folder present' : 'no account folder on this machine'}`);
}

async function push(name, force) {
  checkName(name);
  const isActive = activeName() === name;
  const source = isActive ? ACTIVE_FOLDER : parked(name);
  if (!(await exists(source))) {
    if (!activeName()) fail('the Claude app is not assigned to an account yet: at the top of the dashboard, say which account it is signed in as (or run desktop-swap.mjs init <name>), then save again');
    fail(`no folder for "${name}" at ${source}`);
  }
  // On macOS reading the cookie file is safe while the app runs (see snapshotCookies); only load,
  // which writes into the folder, needs the app closed. Windows locks the file.
  if (cookieFileLockedWhileRunning && isActive && (await appRunning())) {
    fail('the Claude app is running on this account, and Windows keeps its cookie file locked while it runs. Quit the app first (the dashboard does that for you).');
  }

  const remote = await readRemote(name);
  const rev = await lastRev(name);
  const fp = await fingerprint(source);
  if (remote?.fp === fp && !force) {
    await writeFile0600(revFile(name), remote.pushedAt);
    return console.log(`Already up to date: nothing changed in "${name}" since ${remote.pushedAt}.`);
  }
  if (remote && remote.pushedAt !== rev && !force) {
    fail(`the vault entry was updated (${remote.pushedAt} from ${remote.host}) since your last pull or push. Pull first, or use --force.`);
  }

  const key = await readSafeStorageKey(source);
  const items = {};
  const missing = [];
  for (const item of ITEMS) {
    if (!(await exists(itemPath(source, item)))) missing.push(item);
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
    fp,
    payload: gzipSync(JSON.stringify(items)).toString('base64'),
  });
  if (envelope.length > MAX_ENTRY) fail(`the packed account is ${envelope.length} bytes, over the ${MAX_ENTRY} limit. Store fewer items (DESKTOP_ITEMS).`);

  await provider().write(remoteId(name), envelope);
  await writeFile0600(revFile(name), pushedAt);
  console.log(`Pushed "${name}": ${Object.keys(items).join(', ')} (${envelope.length} bytes) at ${pushedAt}.`);
  if (missing.length) console.log(`Not present in the source, skipped: ${missing.join(', ')}`);
}

async function pull(name, asName) {
  checkName(name);
  const target = asName || name;
  validName(target);
  if (target === activeName()) fail(`"${target}" is the active account; pull into another name with --as`);
  if (await exists(parked(target))) fail(`${parked(target)} already exists, refusing to overwrite. Pull into another name with --as.`);

  const remote = await readRemote(name);
  if (!remote) fail(`nothing in the vault for "${name}" yet`);

  const items = JSON.parse(gunzipSync(Buffer.from(remote.payload, 'base64')).toString('utf8'));

  const partial = `${parked(target)}.partial`;
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    const key = await ensureSafeStorageKey(partial); // THIS machine's key (made for the new folder on Windows)
    for (const [item, packed] of Object.entries(items)) await unpackItem(item, packed, partial, key);
    await fs.rename(partial, parked(target));
  } catch (e) {
    await fs.rm(partial, { recursive: true, force: true });
    throw e;
  }
  await writeFile0600(revFile(name), remote.pushedAt);
  console.log(`Pulled "${name}" into ${parked(target)} (${Object.keys(items).join(', ')}), encrypted with this machine's key.`);
  console.log(`Switch to it with the dashboard, or: node scripts/desktop-swap.mjs use ${target}`);
}

// Like pull, but into the account's own folder: the saved cookie is merged into what is there
// (or the folder is created if missing). The Claude app must not be using that folder.
async function load(name) {
  checkName(name);
  const remote = await readRemote(name);
  if (!remote) fail(`nothing in the vault for "${name}" yet`);
  const isActive = activeName() === name;
  const target = isActive ? ACTIVE_FOLDER : parked(name);
  if (isActive && (await appRunning())) fail('the Claude app is running and this account is the active one. Quit it first.');

  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const key = await ensureSafeStorageKey(target); // THIS machine's key
  const items = JSON.parse(gunzipSync(Buffer.from(remote.payload, 'base64')).toString('utf8'));
  for (const [item, packed] of Object.entries(items)) {
    if (packed.kind === 'cookies' && (await exists(cookieFileIn(target)))) {
      await mergeCookies(cookieFileIn(target), packed, key);
    } else {
      await unpackItem(item, packed, target, key);
    }
  }
  await writeFile0600(revFile(name), remote.pushedAt);
  console.log(`Loaded "${name}" from the vault into ${target}.`);
}

// Deletes the account's entry from the vault, every version of it. Nothing on this machine is touched.
async function forget(name) {
  checkName(name);
  const had = Boolean(await provider().read(remoteId(name)));
  await provider().delete(remoteId(name));
  await fs.rm(revFile(name), { force: true });
  console.log(had ? `Deleted the "${name}" desktop login from the vault (every version).` : `Nothing in the vault for "${name}".`);
}

const [cmd, name, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const asIndex = rest.indexOf('--as');
try {
  if (cmd === 'status') {
    if (!name) fail('usage: status <name> [--json]');
    await status(name, flag('--json'));
  } else if (cmd === 'push') await push(name, flag('--force'));
  else if (cmd === 'pull') await pull(name, asIndex >= 0 ? rest[asIndex + 1] : undefined);
  else if (cmd === 'load') await load(name);
  else if (cmd === 'forget') await forget(name);
  else fail('usage: desktop-vault.mjs <status [name] | push <name> [--force] | pull <name> [--as <new>] | load <name> | forget <name>>');
} catch (e) {
  fail(e.message);
}
