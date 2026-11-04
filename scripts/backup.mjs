#!/usr/bin/env node
// Full backup of one account into ONE passphrase-encrypted file you keep somewhere safe.
//
//   node scripts/backup.mjs backup <name> --to <folder>       make the backup (asks for a passphrase)
//   node scripts/backup.mjs verify <file>                     check it opens and show what is inside
//   node scripts/backup.mjs restore <file> --out <folder> [--to-vault] [--force]
//                                                             unpack it (and optionally put the logins back in the Vault)
//
// What goes in (everything that cannot be re-downloaded):
//   vault/            the three logins (desktop cookie, browser session, CLI login) in exactly the format
//                     the Vault holds, so "restore --to-vault" followed by the dashboard's Load buttons
//                     brings an account back on any Mac
//   claude-config/    the Claude Code config folder: conversation history, settings, skills, plugins
//                     (~/.claude for main, ~/.claude-<name> for the others), without caches
//   claude.json       ~/.claude.json, for the default config folder
//   desktop-data/     the desktop app's data without caches, VM bundles, binaries and the encrypted cookie file
//   manifest.json     what was saved, what was skipped and why
// A part that cannot be read (for example the desktop app is running on that account) is skipped and
// listed in the manifest; the rest is still saved.
//
// Format: "CSBK" + version + 16-byte salt + 12-byte IV, then AES-256-GCM over a gzip tar, then the
// 16-byte tag. The key comes from the passphrase with scrypt. The passphrase is read from the terminal
// (hidden) or, when piped, from the first line of stdin; it is never an argument and never printed.
import fs from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, provider } from './lib/vault-client.mjs';

const MAGIC = Buffer.from('CSBK');
const HEADER = 4 + 1 + 16 + 12;
const TAG = 16;
const MIN_PASSPHRASE = 12;
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const SUPPORT = process.env.SUPPORT_DIR || path.join(os.homedir(), 'Library/Application Support');
const SWAP_STATE_DIR = process.env.SWAP_STATE_DIR || path.join(os.homedir(), '.claude-desktop-accounts');
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
const BACKUP_DIR = process.env.BACKUP_DIR || '.backups';
const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const exists = (p) => fs.access(p).then(() => true, () => false);
const log = (msg) => process.stderr.write(`${msg}\n`);

// Re-creatable data that is left out of the backup.
const CONFIG_SKIP = ['cache', 'debug', 'telemetry', 'shell-snapshots', 'session-env', 'downloads', 'statsig', '.DS_Store'];
const DESKTOP_SKIP = new Set([
  'vm_bundles', 'claude-code', 'claude-code-vm', 'Cache', 'Code Cache', 'GPUCache', 'GraphiteDawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache', 'Crashpad', 'Shared Dictionary',
  'Cookies', 'Cookies-journal', // encrypted with this Mac's key: the login is in vault/ instead
]);

// ------------------------------------------------------------------ passphrase

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) process.stderr.write(s); // show the prompt, never the typing
    };
    rl.question(question, (answer) => {
      process.stderr.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readPassphrase({ confirm }) {
  let pass;
  if (process.stdin.isTTY) {
    pass = await askHidden('Passphrase: ');
    if (confirm && pass !== (await askHidden('Repeat passphrase: '))) fail('the passphrases do not match');
  } else {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    pass = Buffer.concat(chunks).toString('utf8').split('\n')[0];
  }
  if (confirm && pass.length < MIN_PASSPHRASE) fail(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  if (!pass) fail('empty passphrase');
  return pass;
}

const derive = (passphrase, salt) => promisify(scrypt)(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

// ------------------------------------------------------------- encrypt / decrypt

async function encryptTarTo(file, passphrase, tarArgs) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await derive(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tarErr = '';
  tar.stderr.on('data', (d) => (tarErr += d));
  const exited = new Promise((resolve) => tar.on('close', resolve));

  const fh = await fs.open(file, 'wx', 0o600); // never overwrites an existing file
  try {
    await fh.write(Buffer.concat([MAGIC, Buffer.from([1]), salt, iv]));
    for await (const chunk of tar.stdout.pipe(cipher)) await fh.write(chunk);
    await fh.write(cipher.getAuthTag());
  } finally {
    await fh.close();
  }
  const code = await exited;
  if (code > 1) { // 1 = some files could not be read: kept, and reported
    await fs.rm(file, { force: true });
    throw new Error(`tar failed: ${tarErr.trim().split('\n')[0]}`);
  }
  return tarErr.trim();
}

async function decryptedStream(file, passphrase) {
  const { size } = await fs.stat(file);
  if (size < HEADER + TAG) fail('this is not a backup file (too small)');
  const fh = await fs.open(file, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  await fh.read(head, 0, HEADER, 0);
  await fh.read(tag, 0, TAG, size - TAG);
  await fh.close();
  if (!head.subarray(0, 4).equals(MAGIC)) fail('this is not a backup made by this tool');
  const key = await derive(passphrase, head.subarray(5, 21));
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(21, 33));
  decipher.setAuthTag(tag);
  return createReadStream(file, { start: HEADER, end: size - TAG - 1 }).pipe(decipher);
}

// Reads the whole file once to be sure the passphrase is right and nothing is damaged.
async function authenticate(file, passphrase) {
  try {
    for await (const _ of await decryptedStream(file, passphrase)) void _;
  } catch {
    fail('wrong passphrase, or the file is damaged');
  }
}

function tarFrom(stream, args) {
  const tar = spawn('tar', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  tar.stdout.on('data', (d) => (out += d));
  tar.stderr.on('data', (d) => (err += d));
  stream.pipe(tar.stdin);
  tar.stdin.on('error', () => {});
  return new Promise((resolve) => tar.on('close', (code) => resolve({ code, out, err })));
}

// ----------------------------------------------------------------------- backup

function configDirOf(name) {
  let list = [];
  try {
    list = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    /* no accounts.json */
  }
  const dir = list.find((x) => x.id === name)?.cliConfigDir ?? (name === 'main' ? null : `~/.claude-${name}`);
  return dir ? path.resolve(expand(dir)) : path.join(os.homedir(), '.claude');
}

const activeName = () => {
  try {
    return readFileSync(path.join(SWAP_STATE_DIR, 'active'), 'utf8').trim();
  } catch {
    return '';
  }
};

// Runs one of the push scripts into a throwaway file "Vault", so the archive holds the logins in the
// same format the real Vault does. The real Vault and its sync markers are never touched.
function pushInto(stage, script, name) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(SCRIPTS, script), 'push', name], {
      env: { ...process.env, VAULT_PROVIDER: 'file', VAULT_FILE_DIR: path.join(stage, 'vault'), BACKUP_DIR: path.join(stage, '.work', 'b') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const line = (code === 0 ? out : err).trim().split('\n')[0] ?? '';
      resolve({
        ok: code === 0,
        // the push scripts name a path inside the temporary staging folder: drop it, it means nothing to the user
        message: line.replace(/^Error:\s*/, '').replace(/\s*\(that writes [^)]*\)/, ''),
      });
    });
  });
}

async function backup(name, toArg) {
  if (!/^[\w-]+$/.test(name ?? '')) fail('account name may only use letters, digits, - and _');
  if (!toArg) fail('usage: backup <name> --to <folder>');
  const folder = path.resolve(expand(toArg));
  const passphrase = await readPassphrase({ confirm: true });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-backup-'));
  try {
    await fs.mkdir(path.join(stage, '.work', 'b'), { recursive: true });
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });

    // 1. the three logins, in Vault format
    const real = path.join(BACKUP_DIR, `${name}.json`);
    if (await exists(real)) await fs.copyFile(real, path.join(stage, '.work', 'b', `${name}.json`));
    const parts = {};
    for (const [part, script] of [['desktop', 'desktop-vault.mjs'], ['browser', 'vault.mjs'], ['cli', 'cli-vault.mjs']]) {
      log(`Reading the ${part} login...`);
      parts[part] = await pushInto(stage, script, name);
      log(`  ${part}: ${parts[part].ok ? 'saved' : `skipped (${parts[part].message})`}`);
    }

    // 2. the files that cannot be re-downloaded
    const notes = [];
    const members = ['manifest.json', 'README.txt'];
    if (await exists(path.join(stage, 'vault'))) members.push('vault');
    const configDir = configDirOf(name);
    if (await exists(configDir)) {
      await fs.symlink(configDir, path.join(stage, 'claude-config'));
      members.push('claude-config');
      if (configDir === path.join(os.homedir(), '.claude') && (await exists(path.join(os.homedir(), '.claude.json')))) {
        await fs.symlink(path.join(os.homedir(), '.claude.json'), path.join(stage, 'claude.json'));
        members.push('claude.json');
      }
    } else {
      notes.push(`no Claude Code config folder at ${configDir}`);
    }
    const isActive = activeName() === name;
    const desktopDir = isActive ? path.join(SUPPORT, 'Claude') : path.join(SUPPORT, `Claude.${name}`);
    if (await exists(desktopDir)) {
      await fs.mkdir(path.join(stage, 'desktop-data'));
      for (const entry of await fs.readdir(desktopDir)) {
        if (!DESKTOP_SKIP.has(entry) && !entry.startsWith('Singleton')) {
          await fs.symlink(path.join(desktopDir, entry), path.join(stage, 'desktop-data', entry));
        }
      }
      members.push('desktop-data');
      if (isActive) notes.push('the desktop app data was read while that account is the active one; quit the app first for a fully consistent copy');
    } else {
      notes.push(`no desktop app folder for "${name}"`);
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    let file = path.join(folder, `claude-backup-${name}-${stamp}.csbk`);
    for (let n = 2; await exists(file); n++) file = path.join(folder, `claude-backup-${name}-${stamp}-${n}.csbk`); // never overwrite
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
      version: 1, account: name, createdAt: new Date().toISOString(), host: os.hostname(),
      logins: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.ok ? 'saved' : `skipped: ${v.message}`])),
      configFolder: configDir, desktopFolder: desktopDir, notes,
    }, null, 2));
    await fs.writeFile(path.join(stage, 'README.txt'), [
      'Claude account backup. Encrypted with a passphrase; only this tool can open it.',
      '',
      '  node scripts/backup.mjs verify <this file>',
      '  node scripts/backup.mjs restore <this file> --out <new folder> --to-vault',
      '',
      'The vault/ folder holds the three logins in the Vault format. After "restore --to-vault",',
      'use the dashboard\'s "From the Vault" buttons to load them onto a Mac.',
      'claude-config/ is the Claude Code folder (history, settings, skills, plugins).',
    ].join('\n'));

    log('Packing and encrypting (this can take a minute)...');
    const excludes = CONFIG_SKIP.flatMap((n) => ['--exclude', `claude-config/${n}`]).concat(['--exclude', '.DS_Store']);
    const warning = await encryptTarTo(file, passphrase, ['-czhf', '-', '-C', stage, ...excludes, ...members]);
    if (warning) notes.push(`tar warnings: ${warning.split('\n').slice(0, 3).join(' | ')}`);
    const { size } = await fs.stat(file);
    log(`Saved ${file} (${(size / 1048576).toFixed(1)} MB). Keep the passphrase safe: without it the file cannot be opened.`);
    console.log(JSON.stringify({
      ok: true, file, bytes: size, logins: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.ok ? 'saved' : `skipped: ${v.message}`])), notes,
    }));
  } finally {
    await fs.rm(stage, { recursive: true, force: true }); // symlinks are removed, never followed
  }
}

// ------------------------------------------------------------------ verify, restore

async function verify(file) {
  if (!file) fail('usage: verify <file>');
  if (!(await exists(file))) fail(`no such file: ${file}`);
  const passphrase = await readPassphrase({ confirm: false });
  await authenticate(file, passphrase);
  const [list, manifest] = await Promise.all([
    decryptedStream(file, passphrase).then((s) => tarFrom(s, ['-tzf', '-'])),
    decryptedStream(file, passphrase).then((s) => tarFrom(s, ['-xzOf', '-', 'manifest.json'])),
  ]);
  const names = list.out.split('\n').filter(Boolean);
  const top = {};
  for (const n of names) top[n.split('/')[0]] = (top[n.split('/')[0]] ?? 0) + 1;
  console.log('The backup opens and is intact.');
  console.log(`Entries: ${names.length}  (${Object.entries(top).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
  try {
    const m = JSON.parse(manifest.out);
    console.log(`Account "${m.account}", made ${m.createdAt} on ${m.host}`);
    for (const [k, v] of Object.entries(m.logins)) console.log(`  ${k} login: ${v}`);
    for (const n of m.notes ?? []) console.log(`  note: ${n}`);
  } catch {
    console.log('(no readable manifest)');
  }
}

async function restore(file, outArg, toVault, force) {
  if (!file || !outArg) fail('usage: restore <file> --out <folder> [--to-vault] [--force]');
  if (!(await exists(file))) fail(`no such file: ${file}`);
  const out = path.resolve(expand(outArg));
  if ((await exists(out)) && (await fs.readdir(out)).length) fail(`${out} is not empty, refusing to unpack into it`);
  const passphrase = await readPassphrase({ confirm: false });
  await authenticate(file, passphrase); // nothing is written until the file is known to be intact
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const r = await tarFrom(await decryptedStream(file, passphrase), ['-xzf', '-', '-C', out]);
  if (r.code !== 0) fail(`could not unpack: ${r.err.trim().split('\n')[0]}`);
  console.log(`Unpacked into ${out}.`);

  if (toVault) {
    const root = path.join(out, 'vault');
    let n = 0;
    const walk = async (dir, prefix) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.name.endsWith('.json')) {
          const id = `${prefix}${e.name.replace(/\.json$/, '')}`;
          if (!force && (await provider().read(id))) {
            console.log(`  kept the Vault's existing entry for ${id} (use --force to replace it)`);
          } else {
            await provider().write(id, await fs.readFile(path.join(dir, e.name), 'utf8'));
            n++;
            console.log(`  put ${id} into the Vault`);
          }
        }
      }
    };
    if (await exists(root)) await walk(root, '');
    console.log(`${n} login(s) written to the Vault. Use the dashboard's "From the Vault" buttons to load them.`);
  }
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
try {
  if (cmd === 'backup') await backup(arg, opt('--to'));
  else if (cmd === 'verify') await verify(arg);
  else if (cmd === 'restore') await restore(arg, opt('--out'), rest.includes('--to-vault'), rest.includes('--force'));
  else fail('usage: backup.mjs <backup <name> --to <folder> | verify <file> | restore <file> --out <folder> [--to-vault] [--force]>');
} catch (e) {
  fail(e.message);
}
