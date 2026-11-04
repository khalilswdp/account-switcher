// Which account the Claude desktop app is on, and the renames that switch it. The app's data
// folder ("<SUPPORT>/Claude", see lib/platform.mjs) is the active account; "Claude.<name>" next
// to it are the parked ones. Nothing is copied, deleted or overwritten: only renames, and every
// step checks that its target does not exist first. The app has to be quit for a rename.
//
// The active account's name is kept in <SWAP_STATE_DIR or ~/.claude-desktop-accounts>/active.
// scripts/desktop-swap.mjs is the command-line face of this module; the dashboard calls it directly.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUPPORT, appRunning } from './platform.mjs';

export const STATE_DIR = process.env.SWAP_STATE_DIR || path.join(os.homedir(), '.claude-desktop-accounts');
const ACTIVE_FILE = path.join(STATE_DIR, 'active');
export const ACTIVE_FOLDER = path.join(SUPPORT, 'Claude');
export const parked = (name) => path.join(SUPPORT, `Claude.${name}`);
export const validName = (name) => /^[A-Za-z0-9_-]+$/.test(name ?? '');

const exists = (p) => fs.access(p).then(() => true, () => false);
const isDir = (p) => fs.stat(p).then((s) => s.isDirectory(), () => false);

export function activeName() {
  try {
    return readFileSync(ACTIVE_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

// The parked accounts: every "Claude.<name>" folder with a valid name (a leftover ".partial" of
// a failed pull is not one).
export async function parkedNames() {
  let entries;
  try {
    entries = await fs.readdir(SUPPORT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('Claude.') && validName(e.name.slice('Claude.'.length)))
    .map((e) => e.name.slice('Claude.'.length))
    .sort();
}

export async function listState() {
  return { active: activeName() || null, running: await appRunning(), parked: await parkedNames() };
}

// The account a data folder was last signed in as: the id the app keeps in its config.json (an
// identifier, not a secret). Null when the folder or the id is not there.
export async function appAccountUuid(folder = ACTIVE_FOLDER) {
  try {
    const { lastKnownAccountUuid: id } = JSON.parse(await fs.readFile(path.join(folder, 'config.json'), 'utf8'));
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

function checkName(name, usage) {
  if (!name) throw new Error(`usage: desktop-swap.mjs ${usage} <name>`);
  if (!validName(name)) throw new Error('account name may only use letters, digits, - and _');
}
async function requireQuit() {
  if (await appRunning()) throw new Error('Claude desktop is still running. Quit it, wait a few seconds, then run this again.');
}
function requireInit() {
  const cur = activeName();
  if (!cur) throw new Error('not initialised. First run:  desktop-swap.mjs init <name-of-the-account-currently-signed-in>');
  return cur;
}
async function setActive(name) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(ACTIVE_FILE, `${name}\n`);
}

// Records the CURRENT data folder as account <name> (once). Nothing is moved.
export async function init(name) {
  checkName(name, 'init');
  const cur = activeName();
  if (cur) throw new Error(`already initialised as '${cur}'`);
  if (!(await isDir(ACTIVE_FOLDER))) throw new Error(`no Claude data folder found at: ${ACTIVE_FOLDER}`);
  await setActive(name);
  return `OK: the current Claude data folder is now tracked as '${name}'.`;
}

// Parks the current data folder, so the next launch of the app starts fresh (signed out) as <name>.
export async function newAccount(name) {
  checkName(name, 'new');
  await requireQuit();
  const cur = requireInit();
  if (name === cur) throw new Error(`'${name}' is already the active account`);
  if (await exists(parked(name))) throw new Error(`an account named '${name}' already exists (parked)`);
  if (!(await isDir(ACTIVE_FOLDER))) throw new Error('active folder is missing: launch the app once and sign in before creating another account');
  if (await exists(parked(cur))) throw new Error(`${parked(cur)} already exists, refusing to overwrite`);
  await fs.rename(ACTIVE_FOLDER, parked(cur));
  await setActive(name);
  return `OK: '${cur}' is parked. Now open the Claude app, sign in as '${name}', then quit it.`;
}

// Makes the parked account <name> the active one.
export async function use(name) {
  checkName(name, 'use');
  await requireQuit();
  const cur = requireInit();
  if (name === cur) return `'${name}' is already active.`;
  if (!(await isDir(parked(name)))) throw new Error(`no parked account named '${name}' (see: desktop-swap.mjs status)`);
  if (!(await isDir(ACTIVE_FOLDER))) throw new Error(`active folder is missing: launch the app once and sign in as '${cur}' before switching`);
  if (await exists(parked(cur))) throw new Error(`${parked(cur)} already exists, refusing to overwrite`);
  await fs.rename(ACTIVE_FOLDER, parked(cur));
  try {
    await fs.rename(parked(name), ACTIVE_FOLDER);
  } catch (e) {
    await fs.rename(parked(cur), ACTIVE_FOLDER); // roll back the first rename
    throw new Error(`switch failed (${e.message}); rolled back, '${cur}' is active again`);
  }
  await setActive(name);
  return `OK: '${name}' is active, '${cur}' is parked. You can open the Claude app now.`;
}
