// Everything that differs between macOS and Windows, in one place: where the Claude desktop app
// keeps its data and how it encrypts its cookies, where Claude Code keeps its login, how the app
// is found, quit and reopened, and how a terminal or a file chooser is opened. The scripts and
// the server call this module, never an OS command of their own.
//
// Linux gets the parts that need no desktop app: the Claude Code login (a file), the Vault and
// the backups. The desktop app rows report "not available".
//
// Tests set SWITCHER_STUB_DIR to a scratch folder: process control, the terminal, the file
// choosers and Windows' DPAPI are then replaced by marker files and logs in it (see
// test/helpers.mjs), so no test touches the real app, a real login or a real key. Everything
// else runs as it does for real, in the scratch folders the other environment variables name.
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

// Optional settings file in the project folder (gitignored); real environment variables win.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  /* no .env: the defaults apply */
}

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const OS = process.platform; // 'darwin' | 'win32' | 'linux' | ...
export const isMac = OS === 'darwin';
export const isWindows = OS === 'win32';
const STUB = process.env.SWITCHER_STUB_DIR || '';
export const stubbed = Boolean(STUB);
export const desktopSupported = isMac || isWindows || stubbed;
// Windows keeps the app's cookie file locked while the app runs (it cannot even be copied), so
// saving the account the app is on means quitting the app first. macOS reads the file live.
export const cookieFileLockedWhileRunning = isWindows;

// ------------------------------------------------------------------- paths

export const expandHome = (p) => (p === '~' ? os.homedir() : /^~[\\/]/.test(p ?? '') ? path.join(os.homedir(), p.slice(2)) : p);

// Windows, Store-style (MSIX) install: the app's package folder under %LOCALAPPDATA%\Packages.
// Windows redirects such an app's writes to %APPDATA% (and to HKCU) into the package's own
// LocalCache\Roaming folder (and registry hive): processes inside the app see them merged at
// %APPDATA%\Claude, every other process sees them only there. So that is where the data folder
// really is, and the folder renames must happen there for the app to notice.
let packageDir; // ...\Packages\Claude_<id>, or null
export function windowsPackage() {
  if (packageDir !== undefined) return packageDir;
  packageDir = null;
  const packages = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  try {
    for (const name of readdirSync(packages)) {
      if (/^Claude_/.test(name) && existsSync(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'))) packageDir = path.join(packages, name);
    }
  } catch {
    /* no Packages folder: not a Store-style install */
  }
  return packageDir;
}

// Where the Claude desktop app keeps its data: "<SUPPORT>/Claude" is the active account, and
// scripts/lib/desktop.mjs parks the others next to it as "Claude.<name>".
export const SUPPORT = process.env.SUPPORT_DIR
  || (isWindows
    ? (windowsPackage() ? path.join(windowsPackage(), 'LocalCache', 'Roaming') : process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : isMac
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));

// The app's cookie database inside a data folder. Newer builds keep it under Network/ (the
// Windows app does), older ones at the top (the macOS app was seen to): whichever exists, else
// where this system's build would put a new one.
export function cookieFileIn(folder) {
  for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
    if (existsSync(path.join(folder, rel))) return path.join(folder, rel);
  }
  return isWindows ? path.join(folder, 'Network', 'Cookies') : path.join(folder, 'Cookies');
}

// ------------------------------------------------------------ the fake (tests)

const stubFile = (name) => path.join(STUB, name);
const stubLog = (name, line) => fs.appendFile(stubFile(name), `${line}\n`);

// ------------------------------------------------------------ PowerShell (Windows)

// Runs a PowerShell snippet without a window. Its output comes back as UTF-8 whatever the system
// locale (paths may carry accents). Anything secret travels on stdin and stdout only, never on
// the command line.
function powershell(script, { input = '', args = [], timeout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', ...args, '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(err.trim().split('\n')[0] || `PowerShell exited with ${code}`), { code }));
    });
    p.stdin.end(input);
  });
}

// ------------------------------------------------------- the desktop app process

// Windows: the app's executable (its install folder changes with every update). From the claude://
// handler it registers, which only a process inside the app's own registry view sees for a
// Store-style install; otherwise from the package system; otherwise the older installer's place.
// CLAUDE_DESKTOP_EXE overrides it.
let appExePromise;
function appExe() {
  appExePromise ??= (async () => {
    if (process.env.CLAUDE_DESKTOP_EXE) return process.env.CLAUDE_DESKTOP_EXE;
    try {
      const { stdout } = await run('reg', ['query', 'HKCU\\Software\\Classes\\claude\\shell\\open\\command', '/ve'], { windowsHide: true });
      const m = /REG_SZ\s+"?([^"\r\n]+?\.exe)"?/i.exec(stdout);
      if (m) return m[1];
    } catch {
      /* not visible here */
    }
    if (windowsPackage()) {
      try {
        const location = (await powershell('Get-AppxPackage -Name Claude | Select-Object -First 1 -ExpandProperty InstallLocation')).trim();
        if (location) return path.join(location, 'app', 'Claude.exe');
      } catch {
        /* the package system did not answer */
      }
    }
    const older = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');
    return existsSync(older) ? older : null;
  })();
  return appExePromise;
}

// Windows: the desktop app is Claude.exe, and so is Claude Code's own binary (the one the app
// bundles, or a native install), so the image name alone does not say what is running. tasklist
// (fast; its text is localized, so only its CSV rows are read) gives the PIDs; a PID not seen
// before is looked up through PowerShell for its executable and parent, and remembered for a short
// while only (Windows reuses PIDs, so nothing is trusted for long, and a failed lookup is retried
// soon). Concurrent callers share one scan. Only processes that run the app's own executable count,
// and only they are ever ended, from a scan taken just before.
const APP_IMAGE = 'Claude.exe';
const procs = new Map(); // pid -> { app, parent, expires }
const REMEMBER = 20_000; // ms a classification is trusted
let scanning = null;
const isAppExe = (exe, known) => {
  if (!exe) return false;
  const e = exe.toLowerCase();
  if (known && path.dirname(e) === path.dirname(known.toLowerCase())) return true;
  return /\\windowsapps\\claude_/.test(e) || /\\anthropicclaude\\/.test(e);
};
// The app's processes as { pid, parent }. fresh: forget what was remembered and look everything up
// now (before anything is ended).
async function windowsAppProcesses({ fresh = false } = {}) {
  if (fresh) {
    if (scanning) await scanning.catch(() => {});
    procs.clear();
  }
  scanning ??= scanAppProcesses().finally(() => {
    scanning = null;
  });
  return scanning;
}

async function scanAppProcesses() {
  let out = '';
  try {
    ({ stdout: out } = await run('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/FO', 'CSV', '/NH'], { windowsHide: true }));
  } catch {
    return [];
  }
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"[^"]*","(\d+)"/.exec(line);
    if (m) pids.push(Number(m[1]));
  }
  const now = Date.now();
  for (const [pid, entry] of [...procs]) if (!pids.includes(pid) || entry.expires <= now) procs.delete(pid);
  const unknown = pids.filter((pid) => !procs.has(pid));
  if (unknown.length) {
    const known = await appExe();
    const seen = new Map();
    let looked = true;
    try {
      const text = await powershell(`Get-CimInstance Win32_Process -Filter "Name='${APP_IMAGE}'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)" }`);
      for (const line of text.split(/\r?\n/)) {
        const [pid, parent, exe] = line.trim().split('|');
        if (pid) seen.set(Number(pid), { parent: Number(parent) || 0, exe: exe ?? '' });
      }
    } catch {
      looked = false; // unknown processes count as not the app, and are looked up again soon
    }
    for (const pid of unknown) {
      const info = seen.get(pid);
      procs.set(pid, { parent: info?.parent ?? 0, app: Boolean(info && isAppExe(info.exe, known)), expires: now + (looked ? REMEMBER : 3000) });
    }
  }
  return pids.filter((pid) => procs.get(pid)?.app).map((pid) => ({ pid, parent: procs.get(pid).parent }));
}

// Diagnostics: the desktop app's processes on Windows ([] elsewhere), as { pid, parent }.
export const appProcesses = () => (isWindows ? windowsAppProcesses() : Promise.resolve([]));

export async function appRunning() {
  if (process.env.SWAP_SKIP_RUNNING_CHECK) return false; // tests that run the scripts without a fake app
  if (stubbed) return existsSync(stubFile('running'));
  if (isMac) return new Promise((resolve) => execFile('pgrep', ['-f', '/Applications/Claude.app/Contents/'], (e) => resolve(!e)));
  if (isWindows) return (await windowsAppProcesses()).length > 0;
  return false;
}

const gone = async (ms) => {
  for (let waited = 0; waited < ms; waited += 500) {
    if (!(await appRunning())) return true;
    await sleep(500);
  }
  return !(await appRunning());
};

// Quits the app and returns once it is gone; throws when it will not go.
export async function quitApp() {
  if (stubbed) {
    await fs.rm(stubFile('running'), { force: true });
    await stubLog('quit.log', 'quit');
    return;
  }
  if (isMac) {
    await run('osascript', ['-e', 'tell application "Claude" to quit']).catch(() => {});
    if (await gone(20_000)) return;
    throw new Error('Claude did not quit (an unsaved change or a dialog?). Quit it yourself and try again.');
  }
  if (isWindows) {
    // The main processes (those whose parent is not the app) from a scan taken right now.
    const mains = async () => {
      const all = await windowsAppProcesses({ fresh: true });
      const pids = new Set(all.map((p) => p.pid));
      return all.filter((p) => !pids.has(p.parent)).map((p) => p.pid);
    };
    // Ask its windows to close first: a clean quit when the app honours it.
    for (const pid of await mains()) await run('taskkill', ['/PID', String(pid)], { windowsHide: true }).catch(() => {});
    if (await gone(6000)) return;
    // It is still there (closing its window only hides it to the tray): end it with its helpers,
    // looked up afresh so that no PID handed to something else since is touched.
    for (const pid of await mains()) await run('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }).catch(() => {});
    if (await gone(10_000)) return;
    throw new Error('Claude did not quit. Quit it yourself (right-click its tray icon, then Quit) and try again.');
  }
  throw new Error('quitting the Claude app is not supported on this system');
}

// Windows, Store-style (MSIX) install: the app id to start it by, so it runs with its package
// identity (running the .exe straight from WindowsApps does not). The package family is the
// package folder's name (Claude_<id>), or comes from the executable's path.
let appIdPromise;
function windowsAppId(exe) {
  appIdPromise ??= (async () => {
    const pkg = windowsPackage() ? path.basename(windowsPackage()) : /\\WindowsApps\\([^\\]+)/i.exec(exe ?? '')?.[1] ?? ''; // Claude_abcdefgh, or Claude_1.2.3.0_x64__abcdefgh
    const family = `${pkg.split('_')[0]}_${pkg.split('_').pop()}`; // Claude_abcdefgh
    try {
      const out = await powershell(`Get-StartApps | Where-Object { $_.AppID -like '${family}!*' } | Select-Object -First 1 -ExpandProperty AppID`);
      if (out.trim()) return out.trim();
    } catch {
      /* the usual id */
    }
    return `${family}!Claude`;
  })();
  return appIdPromise;
}

export async function openApp() {
  if (stubbed) {
    await fs.writeFile(stubFile('running'), '');
    await stubLog('open.log', 'open');
    return;
  }
  if (isMac) {
    await run('open', ['-a', 'Claude']);
    return;
  }
  if (isWindows) {
    const exe = await appExe();
    const packaged = Boolean(windowsPackage()) || /\\windowsapps\\/i.test(exe ?? '');
    if (!exe && !packaged) throw new Error('cannot find the Claude app: set CLAUDE_DESKTOP_EXE to its Claude.exe');
    const child = packaged
      ? spawn('explorer.exe', [`shell:AppsFolder\\${await windowsAppId(exe)}`], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return;
  }
  throw new Error('opening the Claude app is not supported on this system');
}

// Is this process running inside the Claude desktop app (a shell in its Code tab counts)? Quitting
// the app would then end the dashboard too, so the server refuses desktop actions in that case.
// The app's shells carry marker variables; on Windows a process the app starts another way (the
// Code tab's preview server, say) carries none, so the parent chain is looked at too, once. A
// parent that was created after its child is a reused PID, not an ancestor, and ends the walk.
let insidePromise;
export function insideDesktopApp() {
  insidePromise ??= (async () => {
    if (process.env.__CFBundleIdentifier === 'com.anthropic.claudefordesktop'
      || process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
      || process.env.CLAUDE_CODE_DESKTOP_APP_VERSION) return true;
    if (stubbed || !isWindows) return false;
    try {
      const known = await appExe();
      const text = await powershell(`$id = ${process.pid}; $born = $null; for ($i = 0; $i -lt 16 -and $id; $i++) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if (-not $p) { break }; if ($born -and $p.CreationDate -gt $born) { break }; Write-Output ([string]$p.ExecutablePath); $born = $p.CreationDate; $id = $p.ParentProcessId }`);
      return text.split(/\r?\n/).some((exe) => isAppExe(exe.trim(), known));
    } catch {
      return false;
    }
  })();
  return insidePromise;
}

// -------------------------------------------------- the app's encryption key

// macOS: one key per Mac, from the Keychain item "Claude Safe Storage" (reading it makes macOS
// ask to allow it); 16 bytes, AES-128-CBC. Windows: one key per data folder, in its "Local State"
// file, protected with DPAPI for this Windows user; 32 bytes, AES-256-GCM. lib/chromium-crypto.mjs
// tells the two apart by length. Nothing here prints or stores a key.
const SERVICE = process.env.SAFE_STORAGE_SERVICE || 'Claude Safe Storage';
const useLocalState = isWindows || (stubbed && !isMac); // tests on Linux take the Windows road

async function macKey() {
  let stdout;
  try {
    ({ stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', 'Claude Key', '-w'], { timeout: 120_000 }));
  } catch (e) {
    throw new Error(
      /could not be found/i.test(e.stderr || '')
        ? `no "${SERVICE}" item in the Keychain. Open the Claude app once on this Mac, quit it, and try again.`
        : 'could not read the Keychain item (access denied or timed out)',
    );
  }
  const password = stdout.replace(/\n$/, '');
  if (!password) throw new Error('the Keychain item is empty');
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

// DPAPI through PowerShell's ProtectedData, bytes in and out as base64 on stdin and stdout.
async function dpapi(op, bytes) {
  if (stubbed) { // tests: a visible marker instead of this user's DPAPI
    const mark = Buffer.from('FAKEDPAPI');
    if (op === 'protect') return Buffer.concat([mark, bytes]);
    if (!bytes.subarray(0, mark.length).equals(mark)) throw new Error('not a fake-protected value');
    return bytes.subarray(mark.length);
  }
  const method = op === 'protect' ? 'Protect' : 'Unprotect';
  const out = await powershell(
    `Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${method}($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`,
    { input: bytes.toString('base64'), timeout: 60_000 },
  );
  return Buffer.from(out.trim(), 'base64');
}

const DPAPI_TAG = Buffer.from('DPAPI');
const localStateFile = (folder) => path.join(folder, 'Local State');

async function localStateKey(folder, create) {
  const file = localStateFile(folder);
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`cannot read ${file}`);
    if (!create) throw new Error(`no "Local State" file in ${folder}: open the Claude app once on this account, quit it, and try again`);
  }
  const encoded = state.os_crypt?.encrypted_key;
  if (typeof encoded === 'string') {
    const raw = Buffer.from(encoded, 'base64');
    if (!raw.subarray(0, DPAPI_TAG.length).equals(DPAPI_TAG)) throw new Error('the app data uses an encryption this tool does not know');
    try {
      return await dpapi('unprotect', raw.subarray(DPAPI_TAG.length));
    } catch {
      throw new Error('the encryption key in Local State cannot be opened by this Windows user (was the folder copied from another PC or user?)');
    }
  }
  if (!create) throw new Error(`no encryption key in ${file}: open the Claude app once on this account, quit it, and try again`);
  // A folder the app has not opened yet: give it a key the way the app would make one.
  const key = randomBytes(32);
  state.os_crypt = { ...(state.os_crypt ?? {}), encrypted_key: Buffer.concat([DPAPI_TAG, await dpapi('protect', key)]).toString('base64') };
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
  return key;
}

// The key an account folder's cookies are encrypted with (the folder is ignored on macOS).
export const readSafeStorageKey = (folder) => (useLocalState ? localStateKey(folder, false) : macKey());
// The same, creating a key for a folder that has none yet (a folder being built from the Vault).
export const ensureSafeStorageKey = (folder) => (useLocalState ? localStateKey(folder, true) : macKey());

// ------------------------------------------------------- the Claude Code login

// macOS keeps it in a Keychain item: service "Claude Code-credentials" for the default config
// folder (~/.claude), otherwise "Claude Code-credentials-<first 8 hex of sha256(path)>", with
// $USER as the account. Windows and Linux keep it in the file .credentials.json inside the config
// folder. Each store answers: info (is it there, when did it change), read, write, remove, and
// describe (for messages). Times are "20261104144455Z", as the Keychain gives them.
const BASE = 'Claude Code-credentials';
const KEYCHAIN_USER = process.env.USER || os.userInfo().username; // the CLI looks its item up by $USER
const stamp = (date) => `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

export const serviceFor = (configDir) => {
  const dir = path.resolve(configDir).normalize('NFC');
  return dir === path.join(os.homedir(), '.claude') ? BASE : `${BASE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
};

const keychainLogin = {
  describe: (configDir) => `Keychain item "${serviceFor(configDir)}"`,
  // Attributes only (no -w), so no prompt. Null when the item does not exist.
  async info(configDir) {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', serviceFor(configDir), '-a', KEYCHAIN_USER]);
      return { modified: /"mdat"<timedate>=\S+\s+"(\d{14}Z)/.exec(stdout)?.[1] ?? 'unknown' };
    } catch (e) {
      if (/could not be found/i.test(e.stderr || '')) return null;
      throw new Error('could not look in the Keychain');
    }
  },
  async read(configDir) {
    try {
      return (await run('security', ['find-generic-password', '-s', serviceFor(configDir), '-a', KEYCHAIN_USER, '-w'], { timeout: 120_000 })).stdout.replace(/\n$/, '');
    } catch {
      throw new Error('could not read the Keychain item (access denied or timed out)');
    }
  },
  // `security -i` takes the command on stdin, so the login never appears in a process list. The
  // value goes in as hex to avoid any quoting problem; -U updates an existing item.
  write(configDir, secret, replace = false) {
    return new Promise((resolve, reject) => {
      const p = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', () => (/error|fail/i.test(err) ? reject(new Error('could not write the Keychain item')) : resolve()));
      p.stdin.end(`add-generic-password -s "${serviceFor(configDir)}" -a "${KEYCHAIN_USER}" -X ${Buffer.from(secret).toString('hex')}${replace ? ' -U' : ''}\n`);
    });
  },
  async remove(configDir) {
    try {
      await run('security', ['delete-generic-password', '-s', serviceFor(configDir), '-a', KEYCHAIN_USER], { timeout: 120_000 });
    } catch {
      throw new Error('could not delete the Keychain item (access denied or timed out)');
    }
  },
};

const credentialsFile = (configDir) => path.join(path.resolve(configDir), '.credentials.json');
const fileLogin = {
  describe: (configDir) => `file ${credentialsFile(configDir)}`,
  async info(configDir) {
    try {
      return { modified: stamp((await fs.stat(credentialsFile(configDir))).mtime) };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error('could not look at the login file');
    }
  },
  async read(configDir) {
    try {
      return (await fs.readFile(credentialsFile(configDir), 'utf8')).replace(/\n$/, '');
    } catch {
      throw new Error('could not read the login file');
    }
  },
  async write(configDir, secret, replace = false) {
    const file = credentialsFile(configDir);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!replace && (await fs.access(file).then(() => true, () => false))) throw new Error('the login file already exists');
    await fs.writeFile(file, secret, { mode: 0o600 });
  },
  async remove(configDir) {
    await fs.rm(credentialsFile(configDir), { force: true });
  },
};

export const cliLogin = isMac ? keychainLogin : fileLogin;

// ------------------------------------------------------------- a terminal

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const asQuote = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Opens a terminal window running Claude Code as the account (configDir null = the default
// folder), in cwd. Returns the command a person could run by hand instead.
export async function openTerminal({ id, configDir, cwd }) {
  const vars = configDir ? { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir } : {};
  const command = isWindows
    ? [...Object.entries(vars).map(([k, v]) => `$env:${k}=${psQuote(v)}`), `Set-Location ${psQuote(cwd)}`, 'claude'].join('; ')
    : `cd ${shQuote(cwd)} && ${Object.entries(vars).map(([k, v]) => `${k}=${shQuote(v)} `).join('')}claude`;
  if (stubbed) {
    await stubLog('terminal.log', command);
    return { command };
  }
  if (isMac) {
    try {
      await run('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script "${asQuote(command)}"\nend tell`]);
    } catch (e) {
      // First use may need Automation permission (System Settings > Privacy & Security).
      throw new Error(`could not open Terminal (${e.message.split('\n')[0]}). Run this yourself: ${command}`);
    }
    return { command };
  }
  if (isWindows) {
    // A new console window (Windows Terminal when it is the default) running PowerShell with the
    // account's variables set, which claude inherits. Any such variable in the dashboard's own
    // environment is dropped first, so the default-folder account never runs as another. "start"
    // needs cmd; /s keeps the quotes as they are.
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    try {
      const child = spawn('cmd.exe', ['/s', '/c', `"start "Claude Code (${id})" /D "${cwd}" powershell.exe -NoExit -Command claude"`], {
        env: { ...env, ...vars },
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
        windowsHide: true,
      });
      child.on('error', () => {});
      child.unref();
    } catch (e) {
      throw new Error(`could not open a terminal (${e.message}). Run this yourself in PowerShell: ${command}`);
    }
    return { command };
  }
  throw new Error(`opening a terminal is not supported on this system. Run this yourself: ${command}`);
}

// ---------------------------------------------------------- a file chooser

// A native folder or file chooser, so a path never has to be typed. Resolves to { path } or
// { canceled: true }.
export async function pickPath(kind) {
  if (stubbed) {
    const p = process.env.STUB_PICK ?? '';
    return p ? { path: p } : { canceled: true };
  }
  if (isMac) {
    const choose = kind === 'folder'
      ? 'choose folder with prompt "Choose the folder for the backups"'
      : 'choose file with prompt "Choose a Claude backup (a .csbk file)"';
    try {
      // "activate" brings the chooser in front of the browser window
      const { stdout } = await run('osascript', ['-e', `tell current application\nactivate\nreturn POSIX path of (${choose})\nend tell`], { timeout: 300_000 });
      return { path: stdout.trim().replace(/(.)\/$/, '$1') };
    } catch (e) {
      if (/-128|cancel/i.test(e.stderr || '')) return { canceled: true };
      throw new Error('could not open the file chooser');
    }
  }
  if (isWindows) {
    const dialog = kind === 'folder'
      ? "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the folder for the backups'; $d.ShowNewFolderButton = $true; $r = $d.ShowDialog($owner); $p = $d.SelectedPath"
      : "$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Choose a Claude backup (a .csbk file)'; $d.Filter = 'Claude backup (*.csbk)|*.csbk|All files (*.*)|*.*'; $r = $d.ShowDialog($owner); $p = $d.FileName";
    try {
      // An invisible top-most owner window keeps the chooser in front of the browser.
      const out = await powershell(
        `Add-Type -AssemblyName System.Windows.Forms; $owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.Show(); ${dialog}; $owner.Close(); if ($r -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }; [Console]::Out.Write($p)`,
        { args: ['-STA'], timeout: 300_000 },
      );
      return { path: out.trim() };
    } catch (e) {
      if (e.code === 2) return { canceled: true };
      throw new Error('could not open the file chooser');
    }
  }
  throw new Error('a file chooser is not available on this system: type the path');
}

// ------------------------------------------------------------- files and tar

// The size of a folder, from its files (unreadable ones count as 0).
export async function folderBytes(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += await fs.stat(p).then((s) => s.size, () => 0);
    }
  };
  await walk(dir);
  return total;
}

// bsdtar on macOS and Windows (Windows ships it in System32; Git's own tar would differ).
export const tarExe = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// Puts a folder or file into a staging area without copying it, for tar to follow: a symlink on
// macOS and Linux; on Windows a directory junction (no privilege needed), and a copy for a single
// file (file symlinks need a privilege there). A file the running app holds open cannot be copied
// (EBUSY): the caller notes it and goes on.
export async function stageLink(target, link) {
  if (!isWindows) return fs.symlink(target, link);
  if ((await fs.stat(target)).isDirectory()) return fs.symlink(target, link, 'junction');
  return fs.copyFile(target, link);
}
