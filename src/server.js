import express from 'express';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const run = promisify(execFile);

const PORT = Number(process.env.PORT) || 3000;
const LOGIN_URL = process.env.LOGIN_URL || 'https://claude.ai/login';
const TASK_URL = process.env.TASK_URL || 'https://claude.ai/';
const PROFILES_DIR = process.env.PROFILES_DIR || '.profiles';
const BACKUP_DIR = process.env.BACKUP_DIR || '.backups'; // storageState safety copies
const LEGACY_DIR = process.env.LEGACY_STATE_DIR || '.state'; // sessions from the earlier version
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
const MARKER = '.synced'; // written once a login window has been saved/closed

// One persistent Chromium profile per account. The profile folder IS the session:
// cookies, localStorage, IndexedDB and refreshed tokens live there natively, so
// switching accounts means opening the other folder. Nothing is copied or replayed.
function loadAccounts() {
  let list = [
    { id: 'main', label: 'Account 1: Main Claude session' },
    { id: 'test', label: 'Account 2: Empty test account' },
  ];
  try {
    list = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${ACCOUNTS_FILE}: ${e.message}`);
  }
  const out = Object.create(null);
  for (const { id, label, cliConfigDir } of list) {
    if (!/^[\w-]+$/.test(id ?? '') || id === '__proto__') throw new Error(`Invalid account id: ${id}`);
    if (out[id]) throw new Error(`Duplicate account id: ${id}`);
    // Claude Code config folder for this account; omit it to use the default (~/.claude).
    if (cliConfigDir != null && !/^(~\/|\/)[\w./-]+$/.test(cliConfigDir)) {
      throw new Error(`Invalid cliConfigDir for ${id}: use an absolute or ~/ path without spaces or quotes`);
    }
    out[id] = {
      label: label || id,
      cliConfigDir: cliConfigDir || null,
      profileDir: path.join(PROFILES_DIR, id),
      backupFile: path.join(BACKUP_DIR, `${id}.json`),
      legacyState: path.join(LEGACY_DIR, `${id}_account.json`),
    };
  }
  if (!Object.keys(out).length) throw new Error(`${ACCOUNTS_FILE} defines no accounts`);
  return out;
}
const ACCOUNTS = loadAccounts();

// mode: idle | busy (task running) | login (headed window open)
const runtime = Object.fromEntries(
  Object.keys(ACCOUNTS).map((id) => [id, { mode: 'idle', visual: null, lastResult: null, loggedOut: false }]),
);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const markerFile = (id) => path.join(ACCOUNTS[id].profileDir, MARKER);
const importedFlag = (id) => path.join(PROFILES_DIR, `.imported-${id}`); // survives a profile reset
const isReady = (id) => fs.access(markerFile(id)).then(() => true, () => false);

async function markReady(id) {
  const now = new Date().toISOString();
  await fs.mkdir(ACCOUNTS[id].profileDir, { recursive: true });
  await fs.writeFile(markerFile(id), now, { mode: 0o600 });
  await fs.writeFile(importedFlag(id), now, { mode: 0o600 });
  runtime[id].loggedOut = false;
}

// A page counts as logged out when it ended up on a login route.
const LOGGED_OUT = /\/(login|log-in|signin|sign-in|logout)(\/|$)/i;
const CHALLENGE = /just a moment/i; // Cloudflare interstitial: says nothing about the session
function looksLoggedIn(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !LOGGED_OUT.test(u.pathname);
  } catch {
    return false;
  }
}

// Safety copy of the session as storageState JSON (atomic, owner-only). Only taken
// when the session looks logged in, so a good backup is never replaced by a bad one.
async function saveBackup(id, context) {
  const file = ACCOUNTS[id].backupFile;
  const tmp = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await context.storageState({ path: tmp });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (e) {
    console.warn(`[${id}] Backup failed: ${e.message.split('\n')[0]}`);
  }
}

// A profile directory can only be open in one browser at a time. The mode flag
// guarantees that: a task and a login window never share an account.
const open = (id, headless) =>
  chromium.launchPersistentContext(ACCOUNTS[id].profileDir, {
    headless,
    viewport: headless ? undefined : null,
  });

// -------------------------------------------------------- startup housekeeping

// A crash can leave Chromium's Singleton* lock files behind, which makes the next
// launch of that profile fail. Remove them unless a browser really uses the profile.
async function clearStaleLocks() {
  let processes;
  try {
    processes = (await run('ps', ['-axo', 'command'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch {
    return; // cannot tell: leave locks alone
  }
  for (const [id, a] of Object.entries(ACCOUNTS)) {
    const dir = path.resolve(a.profileDir);
    if (processes.includes(`--user-data-dir=${dir}`)) continue;
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(dir, name);
      if (await fs.lstat(p).then(() => true, () => false)) {
        await fs.rm(p, { force: true });
        console.log(`[${id}] Removed stale ${name}`);
      }
    }
  }
}

// One-time import for a profile that was never set up: prefer the newest backup,
// then the earlier .state/*.json. Sources are only read, never modified or deleted.
// Token values are never logged.
async function importLegacy(id) {
  const rt = runtime[id];
  const a = ACCOUNTS[id];
  if ((await isReady(id)) || (await fs.access(importedFlag(id)).then(() => true, () => false))) return;

  let state;
  let source;
  for (const file of [a.backupFile, a.legacyState]) {
    try {
      const s = JSON.parse(await fs.readFile(file, 'utf8'));
      if (s.cookies?.length) {
        state = s;
        source = file;
        break;
      }
    } catch {}
  }
  if (!state) return;

  rt.mode = 'busy';
  let context;
  try {
    await fs.mkdir(a.profileDir, { recursive: true });
    context = await open(id, true);
    await context.addCookies(state.cookies);
    for (const { origin, localStorage: items = [] } of state.origins ?? []) {
      if (!items.length) continue;
      const page = await context.newPage();
      // Serve a blank page for the origin so no network request is made.
      await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
      try {
        await page.goto(origin);
        await page.evaluate((kv) => kv.forEach(({ name, value }) => localStorage.setItem(name, value)), items);
      } catch {}
      await page.close();
    }
    await context.close();
    context = null;
    await markReady(id);
    console.log(`[${id}] Imported existing session from ${path.basename(source)} (${state.cookies.length} cookies)`);
  } catch (e) {
    console.error(`[${id}] Session import failed: ${e.message.split('\n')[0]}`);
  } finally {
    await context?.close().catch(() => {});
    rt.mode = 'idle';
  }
}

// ------------------------------------------------ headless (automated) side

async function runTask(id) {
  const rt = runtime[id];
  if (rt.mode !== 'idle') throw httpError(409, `Account is busy (${rt.mode})`);
  rt.mode = 'busy'; // claim synchronously so double clicks cannot race
  let context;
  try {
    if (!(await isReady(id))) throw httpError(409, 'Not logged in: use "Login / Sync Session" first');
    context = await open(id, true);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const title = await page.title();
    // true / false, or null when a bot challenge hides the real answer
    const loggedIn = CHALLENGE.test(title) ? null : looksLoggedIn(page.url());
    const result = {
      account: id,
      title,
      url: page.url(),
      loggedIn,
      cookies: (await context.cookies()).length,
      at: new Date().toISOString(),
    };
    if (loggedIn !== null) rt.loggedOut = !loggedIn;
    if (loggedIn === true) await saveBackup(id, context);
    rt.lastResult = result;
    return result;
  } finally {
    await context?.close().catch(() => {}); // closing flushes the profile to disk
    rt.mode = 'idle';
  }
}

// ----------------------------------------------- headed (interactive) side

async function startLogin(id) {
  const rt = runtime[id];
  if (rt.mode !== 'idle') throw httpError(409, `Account is busy (${rt.mode})`);
  rt.mode = 'login'; // automated tasks are blocked for this account from here on
  let context;
  try {
    await fs.mkdir(ACCOUNTS[id].profileDir, { recursive: true });
    context = await open(id, false);
    const session = { context, closing: false };
    rt.visual = session;

    // The profile saves itself, so closing the window by hand also counts as a save.
    context.on('close', async () => {
      if (session.closing) return;
      session.closing = true;
      rt.visual = null;
      await markReady(id).catch(() => {});
      rt.mode = 'idle';
    });
    // Closing the last tab is treated as "Save Session".
    const watch = (p) =>
      p.on('close', () => {
        if (!session.closing && context.pages().length === 0) endLogin(id).catch(() => {});
      });
    context.pages().forEach(watch);
    context.on('page', watch);

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  } catch (e) {
    await context?.close().catch(() => {});
    rt.visual = null;
    rt.mode = 'idle';
    throw e;
  }
}

async function endLogin(id) {
  const rt = runtime[id];
  const s = rt.visual;
  if (!s || s.closing) throw httpError(409, 'No open login window for this account');
  s.closing = true;
  try {
    // Back up only if some tab is on a non-login page (the user is signed in).
    if (s.context.pages().some((p) => looksLoggedIn(p.url()))) await saveBackup(id, s.context);
    await s.context.close(); // flushes cookies and storage to the profile folder
    await markReady(id);
  } finally {
    rt.visual = null;
    rt.mode = 'idle';
  }
  return { saved: true };
}

// Wipes one account's profile and its backup. The old .state files are left alone,
// and the imported flag stops them from being re-imported on the next start.
async function resetProfile(id) {
  const rt = runtime[id];
  if (rt.mode !== 'idle') throw httpError(409, `Account is busy (${rt.mode})`);
  rt.mode = 'busy';
  try {
    await fs.rm(ACCOUNTS[id].profileDir, { recursive: true, force: true });
    await fs.rm(ACCOUNTS[id].backupFile, { force: true });
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    await fs.writeFile(importedFlag(id), new Date().toISOString(), { mode: 0o600 });
    rt.lastResult = null;
    rt.loggedOut = false;
  } finally {
    rt.mode = 'idle';
  }
  return { ok: true };
}

// ------------------------------------------------- Claude Code (CLI) launcher

// Each account keeps its own Claude Code login: a separate config folder, with its own
// Keychain item. Nothing is swapped, so opening one account never touches the other.
// The command comes from accounts.json only, never from the request.
const CLI_WORKDIR = process.env.CLI_WORKDIR || os.homedir();
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const asQuote = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function cliCommand(id) {
  const dir = ACCOUNTS[id].cliConfigDir?.replace(/^~\//, '$HOME/');
  const env = dir ? `CLAUDE_CONFIG_DIR=${dir} CLAUDE_SECURESTORAGE_CONFIG_DIR=${dir} ` : '';
  return `cd ${shQuote(CLI_WORKDIR)} && ${env}claude`;
}

async function openCli(id) {
  if (process.platform !== 'darwin') throw httpError(501, 'Opening Terminal is only supported on macOS');
  const command = cliCommand(id);
  try {
    await run('osascript', [
      '-e',
      `tell application "Terminal"\nactivate\ndo script "${asQuote(command)}"\nend tell`,
    ]);
  } catch (e) {
    // First use may need Automation permission (System Settings > Privacy & Security).
    throw httpError(500, `Could not open Terminal (${e.message.split('\n')[0]}). Run this yourself: ${command}`);
  }
  return { ok: true, command };
}

// ------------------------------------------------- Claude desktop app switcher

// Switching renames the app's data folder (see scripts/desktop-swap.sh): nothing is
// copied or deleted. The app has to be quit first, so the dashboard must not be running
// inside the desktop app itself.
const SWAP_SCRIPT = fileURLToPath(new URL('../scripts/desktop-swap.sh', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failText = (e) => (e.stderr || e.message || '').toString().trim().split('\n')[0];
let switching = false;

async function desktopState() {
  if (process.platform !== 'darwin') return { supported: false };
  const { stdout } = await run('bash', [SWAP_SCRIPT, 'list']);
  const state = { supported: true, active: null, parked: [], running: false };
  for (const line of stdout.trim().split('\n')) {
    const [key, value] = line.split(' ');
    if (key === 'active' && value !== '-') state.active = value;
    else if (key === 'parked') state.parked.push(value);
    else if (key === 'running') state.running = value === 'yes';
  }
  return state;
}

async function switchDesktop(name) {
  if (process.platform !== 'darwin') throw httpError(501, 'The desktop switcher is only supported on macOS');
  if (process.env.__CFBundleIdentifier === 'com.anthropic.claudefordesktop') {
    throw httpError(409, 'The dashboard is running inside the Claude desktop app, which this switch would quit. Start it from Terminal.app.');
  }
  if (switching) throw httpError(409, 'A desktop switch is already in progress');
  switching = true;
  try {
    const state = await desktopState();
    if (!state.active) throw httpError(409, 'Not set up. In Terminal run: ./scripts/desktop-swap.sh init <account-now-signed-in>');
    if (name === state.active) return { ok: true, active: name, note: 'already active' };
    if (!state.parked.includes(name)) throw httpError(404, `No parked desktop account named ${name}`);

    if (state.running) {
      await run('osascript', ['-e', 'tell application "Claude" to quit']).catch(() => {});
      for (let i = 0; i < 40 && (await desktopState()).running; i++) await sleep(500); // up to 20 s
      if ((await desktopState()).running) {
        throw httpError(409, 'Claude did not quit (an unsaved change or a dialog?). Quit it yourself and try again.');
      }
    }
    try {
      await run('bash', [SWAP_SCRIPT, 'use', name]);
    } catch (e) {
      throw httpError(500, failText(e));
    }
    if (state.running) await run('open', ['-a', 'Claude']).catch(() => {}); // reopen only if it was open
    return { ok: true, active: name, relaunched: state.running };
  } finally {
    switching = false;
  }
}

// ------------------------------------------------------- Save to the Vault

// One click saves the minimum needed to run the account on another laptop: the desktop
// login cookie and, if there is one, the browser session. The two scripts do the work and
// never print secret values, so only their first output line is passed on.
const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
let vaulting = false;

async function runScript(script, args) {
  try {
    const { stdout } = await run(process.execPath, [path.join(PROJECT_DIR, 'scripts', script), ...args], {
      cwd: PROJECT_DIR,
      timeout: 150_000, // includes time to click Allow on the macOS Keychain prompt
    });
    return { ok: true, message: stdout.trim().split('\n')[0] };
  } catch (e) {
    if (e.killed) return { ok: false, message: 'timed out (did you click Allow on the Keychain prompt?)' };
    const line = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n')[0];
    return { ok: false, message: line.replace(/^Error:\s*/, '') };
  }
}

const PARTS = ['desktop', 'browser', 'cli'];

// parts: which of the three to save. The dashboard saves one at a time; no parts means all.
async function saveToVault(id, parts = PARTS) {
  if (vaulting) throw httpError(409, 'A Vault save is already in progress');
  vaulting = true;
  try {
    const out = {};
    if (parts.includes('desktop')) out.desktop = await runScript('desktop-vault.mjs', ['push', id]); // may show the Keychain prompt
    if (parts.includes('browser')) out.browser = await runScript('vault.mjs', ['push', id]);
    if (parts.includes('cli')) out.cli = await runScript('cli-vault.mjs', ['push', id]); // may show the Keychain prompt
    return out;
  } finally {
    vaulting = false;
  }
}

// What is in the Vault for one account, per part. Counts and times only, never values.
async function scriptStatus(script, id) {
  const r = await runScript(script, ['status', id, '--json']);
  if (!r.ok) return { state: 'blocked', message: r.message };
  try {
    return { state: 'ok', ...JSON.parse(r.message) };
  } catch {
    return { state: 'blocked', message: 'unexpected answer from the Vault helper' };
  }
}

async function vaultStatus(id) {
  const [desktop, browser, cli] = await Promise.all([
    scriptStatus('desktop-vault.mjs', id),
    scriptStatus('vault.mjs', id),
    scriptStatus('cli-vault.mjs', id),
  ]);
  return { desktop, browser, cli };
}

// -------------------------------------------------------------------- API

const app = express();

// A web page must not be able to open browser windows: reject cross-site POSTs.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers.origin) {
    let host;
    try {
      host = new URL(req.headers.origin).host;
    } catch {}
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.param('id', (req, res, next, id) =>
  Object.hasOwn(ACCOUNTS, id) ? next() : res.status(404).json({ error: `Unknown account ${id}` }),
);

app.get('/api/accounts', async (req, res) => {
  const list = await Promise.all(
    Object.entries(ACCOUNTS).map(async ([id, a]) => {
      const { mode, lastResult, loggedOut } = runtime[id];
      let status = mode;
      if (mode === 'idle') {
        if (!(await isReady(id))) status = 'not_logged_in';
        else status = loggedOut ? 'login_required' : 'ready';
      }
      return { id, label: a.label, status, lastResult, cliConfigDir: a.cliConfigDir };
    }),
  );
  res.json(list);
});

app.post('/api/accounts/:id/login', async (req, res) => {
  await startLogin(req.params.id);
  res.json({ ok: true });
});
app.post('/api/accounts/:id/save', async (req, res) => res.json(await endLogin(req.params.id)));
app.post('/api/accounts/:id/task', async (req, res) => res.json(await runTask(req.params.id)));
app.get('/api/desktop', async (req, res) => res.json({ ...(await desktopState()), switching }));
app.post('/api/desktop/switch/:name', async (req, res) => {
  if (!/^[\w-]+$/.test(req.params.name)) throw httpError(404, 'Invalid account name');
  res.json(await switchDesktop(req.params.name));
});
app.get('/api/accounts/:id/vault', async (req, res) => res.json(await vaultStatus(req.params.id)));
app.post('/api/accounts/:id/vault', async (req, res) => {
  const wanted = String(req.query.parts ?? PARTS.join(',')).split(',').filter(Boolean);
  if (!wanted.length || wanted.some((p) => !PARTS.includes(p))) {
    throw httpError(400, `parts must be ${PARTS.join(' and/or ')}`);
  }
  res.json(await saveToVault(req.params.id, wanted));
});
app.post('/api/accounts/:id/cli', async (req, res) => res.json(await openCli(req.params.id)));
app.post('/api/accounts/:id/reset', async (req, res) => res.json(await resetProfile(req.params.id)));

app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message.split('\n')[0] }));

await clearStaleLocks();
await Promise.all(Object.keys(ACCOUNTS).map(importLegacy));

const server = app.listen(PORT, '127.0.0.1', (err) => {
  if (err) {
    console.error(`Cannot listen on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Dashboard on http://127.0.0.1:${PORT}`);
});

async function shutdown() {
  for (const rt of Object.values(runtime)) {
    if (rt.visual) {
      rt.visual.closing = true;
      await rt.visual.context.close().catch(() => {}); // flush the profile
    }
  }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
