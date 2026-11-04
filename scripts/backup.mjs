#!/usr/bin/env node
// Full backup of one account into ONE passphrase-encrypted file you keep somewhere safe.
//
//   node scripts/backup.mjs backup <name> --to <folder> [--replace]
//                                                             make the backup (asks for a passphrase). Always a new
//                                                             timestamped file; with --replace the older backups of
//                                                             this account in that folder are deleted afterwards, but
//                                                             only once the new one is proven to open
//   node scripts/backup.mjs verify <file>                     check it opens and show what is inside
//   node scripts/backup.mjs restore <file> --out <folder> [--to-vault] [--force]
//                                                             unpack it (and optionally put the logins back in the Vault)
//   node scripts/backup.mjs inspect <file>                    describe it as one line of JSON (for the dashboard)
//   node scripts/backup.mjs apply <file> --parts vault,config,desktop [--replace-vault]
//                                                             put chosen parts back where they belong. It only ADDS what
//                                                             is missing: nothing existing is overwritten or deleted
//                                                             (config -> the account's Claude Code folder, desktop ->
//                                                             Claude.<name>, vault -> the Vault)
//
// What goes in (everything that cannot be re-downloaded):
//   vault/            the two logins (desktop cookie, CLI login) in exactly the format the Vault holds,
//                     so "restore --to-vault" followed by the dashboard's Load buttons brings an
//                     account back on any machine, Mac or PC
//   claude-config/    the Claude Code config folder: conversation history, settings, skills, plugins
//                     (~/.claude for main, ~/.claude-<name> for the others), without caches and without
//                     the login file (that is in vault/)
//   claude.json       ~/.claude.json, for the default config folder
//   desktop-data/     the desktop app's data without caches, VM bundles, binaries, the cookie file and
//                     the machine-bound encryption key
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
import { fileURLToPath } from 'node:url';
import { fail, provider } from './lib/vault-client.mjs';
import { SUPPORT, appRunning, expandHome, stageLink, tarExe } from './lib/platform.mjs';
import { activeName } from './lib/desktop.mjs';

const MAGIC = Buffer.from('CSBK');
const HEADER = 4 + 1 + 16 + 12;
const TAG = 16;
const MIN_PASSPHRASE = 12;
const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
const exists = (p) => fs.access(p).then(() => true, () => false);
const log = (msg) => process.stderr.write(`${msg}\n`);

// Re-creatable data that is left out of the backup, and the login file (it travels in vault/).
const CONFIG_SKIP = ['cache', 'debug', 'telemetry', 'shell-snapshots', 'session-env', 'downloads', 'statsig', '.DS_Store', '.credentials.json'];
const DESKTOP_SKIP = new Set([
  'vm_bundles', 'claude-code', 'claude-code-vm', 'Cache', 'Code Cache', 'GPUCache', 'GraphiteDawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache', 'Crashpad', 'Shared Dictionary', 'lockfile',
  'Cookies', 'Cookies-journal', 'Network', // encrypted with this machine's key: the login is in vault/ instead
  'Local State', // holds that key on Windows: it belongs to this machine and this user
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
    pass = Buffer.concat(chunks).toString('utf8').split('\n')[0].replace(/\r$/, '');
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
  const tar = spawn(tarExe, tarArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

// Reads the whole file once to see whether the passphrase is right and nothing is damaged.
async function opens(file, passphrase) {
  try {
    for await (const _ of await decryptedStream(file, passphrase)) void _;
    return true;
  } catch {
    return false;
  }
}

async function authenticate(file, passphrase) {
  if (!(await opens(file, passphrase))) fail('wrong passphrase, or the file is damaged');
}

function tarFrom(stream, args) {
  const tar = spawn(tarExe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  tar.stdout.on('data', (d) => (out += d));
  tar.stderr.on('data', (d) => (err += d));
  stream.pipe(tar.stdin);
  tar.stdin.on('error', () => {}); // tar may stop reading early: that is fine
  return new Promise((resolve) =>
    tar.on('close', (code) => {
      stream.destroy();
      resolve({ code, out, err });
    }),
  );
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
  return dir ? path.resolve(expandHome(dir)) : path.join(os.homedir(), '.claude');
}

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
      resolve({ ok: code === 0, message: line.replace(/^Error:\s*/, '') });
    });
  });
}

async function backup(name, toArg, replace = false) {
  if (!/^[\w-]+$/.test(name ?? '')) fail('account name may only use letters, digits, - and _');
  if (!toArg) fail('usage: backup <name> --to <folder>');
  const folder = path.resolve(expandHome(toArg));
  const passphrase = await readPassphrase({ confirm: true });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-backup-'));
  try {
    await fs.mkdir(path.join(stage, '.work', 'b'), { recursive: true });
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });

    // 1. the two logins, in Vault format
    const parts = {};
    for (const [part, script] of [['desktop', 'desktop-vault.mjs'], ['cli', 'cli-vault.mjs']]) {
      log(`Reading the ${part} login...`);
      parts[part] = await pushInto(stage, script, name);
      log(`  ${part}: ${parts[part].ok ? 'saved' : `skipped (${parts[part].message})`}`);
    }

    // 2. the files that cannot be re-downloaded, staged as links for tar to follow (on Windows a
    //    file the running app holds open cannot even be copied: it is noted and left out)
    const notes = [];
    const members = ['manifest.json', 'README.txt'];
    const stageIt = async (target, link, what) => {
      try {
        await stageLink(target, link);
        return true;
      } catch (e) {
        notes.push(`left out: ${what} (${e.code === 'EBUSY' ? 'in use by the running app' : e.message})`);
        return false;
      }
    };
    if (await exists(path.join(stage, 'vault'))) members.push('vault');
    const configDir = configDirOf(name);
    if (await exists(configDir)) {
      if (await stageIt(configDir, path.join(stage, 'claude-config'), configDir)) members.push('claude-config');
      const home = path.join(os.homedir(), '.claude.json');
      if (configDir === path.join(os.homedir(), '.claude') && (await exists(home))) {
        if (await stageIt(home, path.join(stage, 'claude.json'), home)) members.push('claude.json');
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
          await stageIt(path.join(desktopDir, entry), path.join(stage, 'desktop-data', entry), `app data ${entry}`);
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
      version: 1, account: name, createdAt: new Date().toISOString(), host: os.hostname(), platform: process.platform,
      logins: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.ok ? 'saved' : `skipped: ${v.message}`])),
      configFolder: configDir, desktopFolder: desktopDir, notes,
    }, null, 2));
    await fs.writeFile(path.join(stage, 'README.txt'), [
      'Claude account backup. Encrypted with a passphrase; only this tool can open it.',
      '',
      '  node scripts/backup.mjs verify <this file>',
      '  node scripts/backup.mjs restore <this file> --out <new folder> --to-vault',
      '',
      'The vault/ folder holds the logins in the Vault format. After "restore --to-vault",',
      'use the dashboard\'s "Load from Vault" buttons to load them onto a computer.',
      'claude-config/ is the Claude Code folder (history, settings, skills, plugins).',
    ].join('\n'));

    log('Packing and encrypting (this can take a minute)...');
    const excludes = CONFIG_SKIP.flatMap((n) => ['--exclude', `claude-config/${n}`]).concat(['--exclude', '.DS_Store']);
    const warning = await encryptTarTo(file, passphrase, ['-czhf', '-', '-C', stage, ...excludes, ...members]);
    if (warning) notes.push(`tar warnings: ${warning.split('\n').slice(0, 3).join(' | ')}`);
    const { size } = await fs.stat(file);
    log(`Saved ${file} (${(size / 1048576).toFixed(1)} MB). Keep the passphrase safe: without it the file cannot be opened.`);

    // Replace: the older backups of THIS account go, but only once the new file is proven to open.
    const replaced = [];
    if (replace) {
      if (await opens(file, passphrase)) {
        const mine = new RegExp(`^claude-backup-${name}-\\d{8}-\\d{6}(-\\d+)?\\.csbk$`);
        for (const n of await fs.readdir(folder)) {
          if (mine.test(n) && path.join(folder, n) !== file) {
            await fs.rm(path.join(folder, n));
            replaced.push(n);
          }
        }
        if (replaced.length) log(`Replaced ${replaced.length} older backup(s).`);
      } else {
        notes.push('the new backup could not be verified, so the older ones were kept');
      }
    }
    console.log(JSON.stringify({
      ok: true, file, bytes: size, replaced, logins: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.ok ? 'saved' : `skipped: ${v.message}`])), notes,
    }));
  } finally {
    await fs.rm(stage, { recursive: true, force: true }); // links and junctions are removed, never followed
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
  const names = list.out.split(/\r?\n/).filter(Boolean); // Windows' tar ends lines with CRLF
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
  const out = path.resolve(expandHome(outArg));
  if ((await exists(out)) && (await fs.readdir(out)).length) fail(`${out} is not empty, refusing to unpack into it`);
  const passphrase = await readPassphrase({ confirm: false });
  await authenticate(file, passphrase); // nothing is written until the file is known to be intact
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const r = await tarFrom(await decryptedStream(file, passphrase), ['-xzf', '-', '-C', out]);
  if (r.code !== 0) fail(`could not unpack: ${r.err.trim().split('\n')[0]}`);
  console.log(`Unpacked into ${out}.`);

  if (toVault) {
    const { written } = await putVault(path.join(out, 'vault'), force, (line) => console.log(`  ${line}`));
    console.log(`${written} login(s) written to the Vault. Use the dashboard's "Load from Vault" buttons to load them.`);
  }
}

// Puts the login entries of an unpacked backup into the Vault. An existing entry is kept unless replace.
async function putVault(root, replace, say = () => {}) {
  const result = { written: 0, kept: 0 };
  const walk = async (dir, prefix) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith('.json')) {
        const id = `${prefix}${e.name.replace(/\.json$/, '')}`;
        if (!id.includes('/')) {
          say(`skipped ${id}: a browser session from an older backup (the browser part is no longer used)`);
        } else if (!replace && (await provider().read(id))) {
          result.kept++;
          say(`kept the Vault's existing entry for ${id} (use --force to replace it)`);
        } else {
          await provider().write(id, await fs.readFile(path.join(dir, e.name), 'utf8'));
          result.written++;
          say(`put ${id} into the Vault`);
        }
      }
    }
  };
  if (await exists(root)) await walk(root, '');
  return result;
}

// Copies every file of src into dst that dst does not have yet. Nothing is overwritten or deleted,
// and modification times are kept (Claude Code sorts its history by them).
async function copyMissing(src, dst) {
  const r = { copied: 0, skipped: 0, target: dst };
  const walk = async (from, to) => {
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) await walk(a, b);
      else if (e.isFile()) {
        if (await fs.lstat(b).then(() => true, () => false)) {
          r.skipped++;
        } else {
          await fs.copyFile(a, b);
          const st = await fs.stat(a);
          await fs.utimes(b, st.atime, st.mtime);
          r.copied++;
        }
      }
    }
  };
  if (await exists(src)) await walk(src, dst);
  return r;
}

// Opens a backup and describes it as one line of JSON (no secret values), for the dashboard.
async function inspect(file) {
  if (!file) fail('usage: inspect <file>');
  if (!(await exists(file))) fail(`no such file: ${file}`);
  const passphrase = await readPassphrase({ confirm: false });
  await authenticate(file, passphrase);
  const list = await tarFrom(await decryptedStream(file, passphrase), ['-tzf', '-']);
  const names = list.out.split(/\r?\n/).filter(Boolean); // Windows' tar ends lines with CRLF
  const manifest = await tarFrom(await decryptedStream(file, passphrase), ['-xzOf', '-', 'manifest.json']);
  let m;
  try {
    m = JSON.parse(manifest.out);
  } catch {
    fail('this backup has no readable manifest');
  }
  console.log(JSON.stringify({
    ok: true,
    account: m.account,
    createdAt: m.createdAt,
    host: m.host,
    logins: m.logins,
    notes: m.notes ?? [],
    vault: names.filter((n) => /^vault\/.+\.json$/.test(n)).map((n) => n.replace(/^vault\//, '').replace(/\.json$/, '')),
    hasConfig: names.some((n) => n.startsWith('claude-config/')),
    hasDesktop: names.some((n) => n.startsWith('desktop-data/')),
  }));
}

// Puts chosen parts of a backup back where they belong. Only adds what is missing.
async function apply(file, partsArg, replaceVault) {
  const parts = new Set((partsArg ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!parts.size || [...parts].some((p) => !['vault', 'config', 'desktop'].includes(p))) {
    fail('usage: apply <file> --parts vault,config,desktop [--replace-vault]');
  }
  if (!file || !(await exists(file))) fail(`no such file: ${file}`);
  const passphrase = await readPassphrase({ confirm: false });
  await authenticate(file, passphrase); // nothing is written until the file is known to be intact

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-restore-'));
  try {
    const wanted = ['manifest.json'];
    if (parts.has('vault')) wanted.push('vault');
    if (parts.has('config')) wanted.push('claude-config', 'claude.json');
    if (parts.has('desktop')) wanted.push('desktop-data');
    const r = await tarFrom(await decryptedStream(file, passphrase), ['-xzf', '-', '-C', stage, ...wanted]);
    if (r.code > 1) fail(`could not unpack: ${r.err.trim().split('\n')[0]}`);
    const name = JSON.parse(await fs.readFile(path.join(stage, 'manifest.json'), 'utf8')).account;
    if (!/^[\w-]+$/.test(name ?? '')) fail('the backup names no valid account');

    const result = {};
    if (parts.has('desktop')) { // check before writing anything
      if (activeName() === name && (await appRunning())) fail('the Claude app is running on this account. Quit it and try again.');
    }
    if (parts.has('vault')) result.vault = await putVault(path.join(stage, 'vault'), replaceVault);
    if (parts.has('config')) {
      const target = configDirOf(name);
      result.config = await copyMissing(path.join(stage, 'claude-config'), target);
      const home = path.join(os.homedir(), '.claude.json');
      if (target === path.join(os.homedir(), '.claude') && (await exists(path.join(stage, 'claude.json')))) {
        if (await exists(home)) result.config.skipped++;
        else {
          await fs.copyFile(path.join(stage, 'claude.json'), home);
          result.config.copied++;
        }
      }
    }
    if (parts.has('desktop')) {
      const target = activeName() === name ? path.join(SUPPORT, 'Claude') : path.join(SUPPORT, `Claude.${name}`);
      result.desktop = await copyMissing(path.join(stage, 'desktop-data'), target);
    }
    console.log(JSON.stringify({ ok: true, account: name, parts: result }));
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
try {
  if (cmd === 'backup') await backup(arg, opt('--to'), rest.includes('--replace'));
  else if (cmd === 'verify') await verify(arg);
  else if (cmd === 'restore') await restore(arg, opt('--out'), rest.includes('--to-vault'), rest.includes('--force'));
  else if (cmd === 'inspect') await inspect(arg);
  else if (cmd === 'apply') await apply(arg, opt('--parts'), rest.includes('--replace-vault'));
  else fail('usage: backup.mjs <backup <name> --to <folder> | verify <file> | restore <file> --out <folder> [--to-vault] [--force] | inspect <file> | apply <file> --parts vault,config,desktop [--replace-vault]>');
} catch (e) {
  fail(e.message);
}
