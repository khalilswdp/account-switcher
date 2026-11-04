// The dashboard server on a free port, with scratch folders, the file Vault and the fake commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, baseEnv, cliService, exists, makeStubs, scratch } from './helpers.mjs';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// fetch() refuses to set Host, so raw requests go through node:http.
const raw = (base, method, p, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(b);
      } catch {}
      resolve({ status: res.statusCode, body });
    });
  });
  req.on('error', reject);
  req.end();
});

async function startServer() {
  const dir = await scratch('server');
  const stubs = await makeStubs(dir);
  const support = path.join(dir, 'support');
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await fs.writeFile(path.join(support, 'Claude', 'marker'), 'A');
  await fs.mkdir(path.join(dir, 'home'), { recursive: true });
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify([
    { id: 'a', label: 'Account A' },
    { id: 'b', label: 'Account B', cliConfigDir: path.join(dir, 'claude-b') },
    { id: 'c', label: 'Account C' },
  ]));
  const port = await freePort();
  const env = {
    ...baseEnv(),
    ...stubs.env,
    HOME: path.join(dir, 'home'),
    PORT: String(port),
    BACKUP_DIR: path.join(dir, 'backups'),
    ACCOUNTS_FILE: path.join(dir, 'accounts.json'),
    LOCAL_ACCOUNTS_FILE: path.join(dir, 'accounts.local.json'),
    SUPPORT_DIR: support,
    SWAP_STATE_DIR: path.join(dir, 'state'),
    VAULT_PROVIDER: 'file',
    VAULT_FILE_DIR: path.join(dir, 'vault'),
    PROTECTED_ACCOUNTS: 'work',
    DELETE_PASSPHRASE_FILE: path.join(dir, 'delete-passphrase'),
  };
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const onData = (d) => {
      out += d;
      if (out.includes('Dashboard on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', () => reject(new Error(`server exited:\n${out}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p2, init = {}) => {
    const res = await fetch(base + p2, init);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const post = (p2, body) => call(p2, {
    method: 'POST',
    headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    dir, support, stubs, base, call, post,
    log: () => out,
    stop: () => new Promise((resolve) => {
      p.on('exit', resolve);
      p.kill('SIGTERM');
    }),
  };
}

test('dashboard server: state, guards, desktop flows, Vault listing, backups', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  // state in one answer, with the build stamp the page watches
  let r = await s.call('/api/state');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accounts.map((a) => a.id), ['a', 'b', 'c']);
  assert.equal(r.body.accounts[0].cliConfigDir, '~/.claude-a');
  assert.deepEqual(r.body.accounts[0].onThisMac, { appData: false, cliFolder: false }); // not assigned yet
  assert.equal(r.body.desktop.supported, true);
  assert.equal(r.body.desktop.active, null);
  assert.ok(r.headers.get('x-dashboard-build'));

  // guards: a foreign Host (DNS rebinding) or Origin (cross-site POST) is refused; unknown routes answer JSON
  r = await raw(s.base, 'GET', '/api/state', { Host: 'evil.example' });
  assert.equal(r.status, 403);
  r = await raw(s.base, 'POST', '/api/accounts/a/cli', { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  r = await raw(s.base, 'GET', '/api/state', { Host: 'localhost' });
  assert.equal(r.status, 200);
  r = await s.call('/api/nothing');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Not found' });
  r = await s.call('/api/accounts/zzz/vault');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /Unknown account/);
  r = await s.post('/api/accounts/a/vault?parts=bogus');
  assert.equal(r.status, 400);
  r = await s.post('/api/accounts/a/backup', { folder: s.dir, passphrase: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /12 characters/);

  // the Claude app: first-run assignment, a new account by hand, switching back and forth
  r = await s.post('/api/desktop/switch/b');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Not set up/);
  r = await s.post('/api/desktop/init/a');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await s.call('/api/state');
  assert.equal(r.body.desktop.active, 'a');
  r = await s.post('/api/desktop/init/b');
  assert.equal(r.status, 409);
  r = await s.post('/api/desktop/switch/b');
  assert.equal(r.status, 404); // b has no app data yet

  await s.stubs.setRunning(true);
  r = await s.post('/api/desktop/new/b');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, active: 'b', parked: 'a' });
  assert.match(await s.stubs.osascriptLog(), /to quit/);
  assert.match(await s.stubs.openLog(), /-a Claude/);
  assert.equal(await exists(path.join(s.support, 'Claude')), false);
  assert.equal(await fs.readFile(path.join(s.support, 'Claude.a', 'marker'), 'utf8'), 'A');

  await fs.mkdir(path.join(s.support, 'Claude')); // the person signed in as b
  await fs.writeFile(path.join(s.support, 'Claude', 'marker'), 'B');
  r = await s.post('/api/desktop/switch/a');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.relaunched, true);
  assert.equal(await fs.readFile(path.join(s.support, 'Claude', 'marker'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(s.support, 'Claude.b', 'marker'), 'utf8'), 'B');
  r = await s.call('/api/state');
  assert.equal(r.body.desktop.active, 'a');
  assert.deepEqual(r.body.desktop.parked, ['b']);
  assert.equal(r.body.desktop.running, true);
  await fs.mkdir(path.join(s.dir, 'claude-b'));
  r = await s.call('/api/state');
  assert.deepEqual(r.body.accounts.map((x) => [x.id, x.onThisMac]), [
    ['a', { appData: true, cliFolder: false }], // active
    ['b', { appData: true, cliFolder: true }], // parked, with a Claude Code folder
    ['c', { appData: false, cliFolder: false }],
  ]);
  r = await s.post('/api/desktop/switch/a');
  assert.equal(r.body.note, 'already active');
  r = await s.post('/api/desktop/new/b');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /switch to it instead/);

  // Claude Code: opening Terminal goes through osascript with the account's own folder
  r = await s.post('/api/accounts/b/cli');
  assert.equal(r.status, 200);
  assert.match(r.body.command, /CLAUDE_CONFIG_DIR=.*claude-b .*claude$/);
  r = await s.post('/api/accounts/a/vault?parts=cli');
  assert.equal(r.status, 200);
  assert.equal(r.body.cli.ok, false);
  assert.match(r.body.cli.message, /no CLI login found/);

  // the Vault listing, and adding an account that exists only there
  const put = async (rel, obj) => {
    await fs.mkdir(path.dirname(path.join(s.dir, 'vault', rel)), { recursive: true });
    await fs.writeFile(path.join(s.dir, 'vault', rel), JSON.stringify(obj));
  };
  const cliEntry = { version: 1, format: 'cli-keychain', pushedAt: '2026-01-01T00:00:00.000Z', host: 'elsewhere', fp: 'x', credential: '{"t":"SECRET"}' };
  await put('cli/ghost.json', cliEntry);
  r = await s.call('/api/vault/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accounts.ghost, { desktop: null, cli: { pushedAt: '2026-01-01T00:00:00.000Z', host: 'elsewhere' }, local: false });
  r = await s.post('/api/vault/add?account=nobody');
  assert.equal(r.status, 404);
  r = await s.post('/api/vault/add?account=ghost', { label: 'The ghost' });
  assert.equal(r.status, 200);
  r = await s.call('/api/state');
  assert.ok(r.body.accounts.some((a) => a.id === 'ghost' && a.label === 'The ghost' && a.cliConfigDir === '~/.claude-ghost'));

  // a brand-new account made on the page
  r = await s.post('/api/accounts', { id: 'bad name', label: 'x' });
  assert.equal(r.status, 400);
  r = await s.post('/api/accounts', { id: 'a', label: 'x' });
  assert.equal(r.status, 409);
  r = await s.post('/api/accounts', { id: 'work', label: 'Work account' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, account: 'work', label: 'Work account' });
  r = await s.post('/api/accounts', { id: 'plain' });
  assert.equal(r.body.label, 'Account: plain');
  r = await s.call('/api/state');
  assert.ok(r.body.accounts.some((a) => a.id === 'work' && a.label === 'Work account'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.dir, 'accounts.local.json'), 'utf8')), [
    { id: 'ghost', label: 'The ghost' }, { id: 'work', label: 'Work account' }, { id: 'plain', label: 'Account: plain' },
  ]);
  r = await s.call('/api/accounts/work/vault');
  assert.equal(r.body.desktop.vault, null); // every account may use the Vault; nothing saved yet

  // per-account Vault status: counts and times only
  r = await s.call('/api/accounts/ghost/vault');
  assert.equal(r.status, 200);
  assert.equal(r.body.cli.state, 'ok');
  assert.equal(r.body.cli.vault.host, 'elsewhere');
  assert.equal(r.body.cli.local.present, false);
  assert.equal(r.body.desktop.vault, null);
  assert.doesNotMatch(JSON.stringify(r.body), /SECRET/);
  r = await s.call('/api/accounts/c/vault');
  assert.equal(r.body.desktop.state, 'ok');
  assert.equal(r.body.desktop.vault, null);

  // backup files in a folder: names, sizes and times, filtered by account
  await fs.writeFile(path.join(s.dir, 'claude-backup-a-20260101-000000.csbk'), 'x');
  await fs.writeFile(path.join(s.dir, 'claude-backup-b-20260101-000000.csbk'), 'x');
  r = await s.call(`/api/backups?folder=${encodeURIComponent(s.dir)}&account=a`);
  assert.deepEqual(r.body.files.map((f) => f.name), ['claude-backup-a-20260101-000000.csbk']);
  r = await s.call(`/api/backups?folder=${encodeURIComponent(s.dir)}`);
  assert.equal(r.body.files.length, 2);
  r = await s.call(`/api/backups?folder=${encodeURIComponent(path.join(s.dir, 'nope'))}`);
  assert.equal(r.status, 404);

  // removing an account forgets its card only, in whichever file listed it
  const remove = (id, origin = s.base) => s.call(`/api/accounts/${id}`, { method: 'DELETE', headers: { Origin: origin } });
  r = await remove('plain', 'http://evil.example');
  assert.equal(r.status, 403);
  r = await remove('a');
  assert.equal(r.status, 409); // the Claude app is on a
  assert.match(r.body.error, /switch it/);
  r = await remove('plain');
  assert.equal(r.status, 200);
  r = await remove('c');
  assert.equal(r.status, 200);
  r = await remove('nobody');
  assert.equal(r.status, 404);
  r = await remove('work'); // protected: no removal, no deletion, ever
  assert.equal(r.status, 403);
  assert.match(r.body.error, /protected/);
  r = await s.post('/api/accounts/work/delete', { confirm: 'work', targets: { cliFolder: true } });
  assert.equal(r.status, 403);
  r = await s.call('/api/state');
  assert.deepEqual(r.body.accounts.map((x) => [x.id, x.protected]), [['a', false], ['b', false], ['ghost', false], ['work', true]]);
  r = await s.call('/api/state');
  assert.deepEqual(r.body.accounts.map((x) => x.id), ['a', 'b', 'ghost', 'work']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.dir, 'accounts.local.json'), 'utf8')).map((x) => x.id), ['ghost', 'work']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.dir, 'accounts.json'), 'utf8')).map((x) => x.id), ['a', 'b']);
  assert.equal(await exists(path.join(s.support, 'Claude.b')), true); // data is never touched by a removal

  // deleting data: what b holds, then everything ticked, behind the typed name and a passphrase
  const user = baseEnv().USER;
  await s.stubs.seedKeychain(cliService(path.join(s.dir, 'claude-b')), user, '{"t":"B-SECRET"}');
  await put('cli/b.json', { ...cliEntry, pushedAt: '2026-02-01T00:00:00.000Z' });
  await fs.writeFile(path.join(s.dir, 'claude-backup-b-20260202-000000.csbk'), 'yy');
  r = await s.call(`/api/accounts/b/holdings?backupFolder=${encodeURIComponent(s.dir)}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.mac.appData.path.endsWith('Claude.b'));
  assert.equal(typeof r.body.mac.appData.bytes, 'number');
  assert.ok(r.body.mac.cliFolder.path.endsWith('claude-b'));
  assert.equal(r.body.mac.keychain.present, true);
  assert.equal(r.body.vault.cli.vault.pushedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(r.body.vault.desktop.vault, null);
  assert.deepEqual(r.body.backups.files.map((f) => f.name), ['claude-backup-b-20260202-000000.csbk', 'claude-backup-b-20260101-000000.csbk']);
  assert.equal(r.body.passphraseSet, false);
  assert.doesNotMatch(JSON.stringify(r.body), /SECRET/);

  const all = { vaultDesktop: true, vaultCli: true, keychain: true, appData: true, cliFolder: true, backups: r.body.backups.files.map((f) => f.path) };
  r = await s.post('/api/accounts/b/delete', { confirm: 'nope', targets: all, backupFolder: s.dir });
  assert.equal(r.status, 400);
  r = await s.post('/api/accounts/a/delete', { confirm: 'a', targets: { cliFolder: true } });
  assert.equal(r.status, 409); // the Claude app is on a
  r = await s.post('/api/deletion-passphrase', { next: 'short' });
  assert.equal(r.status, 400);
  r = await s.post('/api/deletion-passphrase', { next: 'open sesame 1' });
  assert.equal(r.status, 200);
  r = await s.call('/api/deletion-passphrase');
  assert.deepEqual(r.body, { set: true });
  r = await s.post('/api/deletion-passphrase', { next: 'open sesame 2' });
  assert.equal(r.status, 403); // changing needs the current one
  r = await s.post('/api/deletion-passphrase', { current: 'open sesame 1', next: 'open sesame 2' });
  assert.equal(r.status, 200);
  r = await s.post('/api/accounts/b/delete', { confirm: 'b', targets: all, backupFolder: s.dir });
  assert.equal(r.status, 403); // no passphrase given
  r = await s.post('/api/accounts/b/delete', { confirm: 'b', passphrase: 'open sesame 1', targets: all, backupFolder: s.dir });
  assert.equal(r.status, 403); // the old one
  assert.equal(await exists(path.join(s.support, 'Claude.b')), true); // nothing happened so far

  // a file of another account is refused, the card stays, nothing else is touched
  r = await s.post('/api/accounts/b/delete', { confirm: 'b', passphrase: 'open sesame 2', targets: { backups: [path.join(s.dir, 'claude-backup-a-20260101-000000.csbk')] }, backupFolder: s.dir });
  assert.equal(r.status, 200);
  assert.match(r.body.errors.backups, /not a backup of this account/);
  assert.equal(r.body.removed, false);
  assert.equal(await exists(path.join(s.dir, 'claude-backup-a-20260101-000000.csbk')), true);
  r = await s.call('/api/state');
  assert.ok(r.body.accounts.some((x) => x.id === 'b'));

  r = await s.post('/api/accounts/b/delete', { confirm: 'b', passphrase: 'open sesame 2', targets: all, backupFolder: s.dir });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.errors, {});
  assert.equal(r.body.removed, true);
  assert.match(r.body.done.vaultDesktop, /Nothing in the vault/);
  assert.match(r.body.done.vaultCli, /Deleted/);
  assert.match(r.body.done.keychain, /Deleted/);
  assert.equal(await exists(path.join(s.support, 'Claude.b')), false);
  assert.equal(await exists(path.join(s.dir, 'claude-b')), false);
  assert.equal(await exists(path.join(s.dir, 'vault', 'cli', 'b.json')), false);
  await assert.rejects(s.stubs.readKeychain(cliService(path.join(s.dir, 'claude-b')), user));
  assert.equal(await exists(path.join(s.dir, 'claude-backup-b-20260202-000000.csbk')), false);
  assert.equal(await exists(path.join(s.dir, 'claude-backup-b-20260101-000000.csbk')), false);
  assert.equal(await exists(path.join(s.dir, 'claude-backup-a-20260101-000000.csbk')), true); // another account's backup stays
  assert.equal(await exists(path.join(s.support, 'Claude')), true); // the active account's data stays
  assert.equal(await exists(path.join(s.dir, 'vault', 'cli', 'ghost.json')), true);
  r = await s.call('/api/state');
  assert.deepEqual(r.body.accounts.map((x) => x.id), ['a', 'ghost', 'work']);

  assert.doesNotMatch(s.log(), /SECRET|Error/);
});

test('dashboard server: a port already in use is reported, not a stack trace', async () => {
  const blocker = net.createServer();
  const port = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
  const dir = await scratch('port');
  const stubs = await makeStubs(dir);
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify([{ id: 'a' }]));
  const env = {
    ...baseEnv(), ...stubs.env, HOME: dir, PORT: String(port),
    BACKUP_DIR: path.join(dir, 'backups'),
    ACCOUNTS_FILE: path.join(dir, 'accounts.json'), SUPPORT_DIR: path.join(dir, 'support'), SWAP_STATE_DIR: path.join(dir, 'state'),
  };
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const code = await new Promise((resolve) => p.on('exit', resolve));
  blocker.close();
  assert.equal(code, 1);
  assert.match(err, /already in use/);
  assert.doesNotMatch(err, /at .*\.js:\d+/);
});
