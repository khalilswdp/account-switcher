#!/usr/bin/env node
// Swap the Claude desktop app between accounts by renaming its data folder.
// Nothing is copied, deleted or overwritten: only renames, and every step checks
// that its target does not exist first. Quit the app and run this from a terminal
// of your own, not from inside the desktop app.
//
//   node scripts/desktop-swap.mjs status            show the active account and parked ones
//   node scripts/desktop-swap.mjs list              same, in a machine-readable form
//   node scripts/desktop-swap.mjs init <name>       record the CURRENT folder as account <name> (once)
//   node scripts/desktop-swap.mjs new <name>        park the current folder, so the next launch starts fresh
//   node scripts/desktop-swap.mjs use <name>        make the parked account <name> the active one
//
// Layout:  <app data>/Claude          active account      (macOS: ~/Library/Application Support,
//          <app data>/Claude.<name>   parked accounts      Windows: %APPDATA%)
import fs from 'node:fs/promises';
import { ACTIVE_FOLDER, activeName, init, listState, newAccount, parkedNames, use } from './lib/desktop.mjs';
import { appRunning } from './lib/platform.mjs';

const USAGE = `usage: desktop-swap.mjs <status | list | init <name> | new <name> | use <name>>
  status        show the active account and parked ones
  list          same, in a machine-readable form
  init <name>   record the CURRENT folder as account <name> (once)
  new <name>    park the current folder, so the next launch starts fresh
  use <name>    make the parked account <name> the active one`;

const [cmd, name] = process.argv.slice(2);
try {
  if (cmd === 'status') {
    const cur = activeName();
    console.log(`Active account : ${cur || '(not initialised)'}`);
    console.log(`Active folder  : ${(await fs.stat(ACTIVE_FOLDER).then((s) => s.isDirectory(), () => false)) ? 'present' : 'missing'}`);
    console.log(`Desktop app    : ${(await appRunning()) ? 'RUNNING' : 'not running'}`);
    const names = await parkedNames();
    if (names.length) for (const n of names) console.log(`Parked         : ${n}`);
    else console.log('Parked         : (none)');
  } else if (cmd === 'list') {
    const s = await listState();
    console.log(`active ${s.active ?? '-'}`);
    console.log(`running ${s.running ? 'yes' : 'no'}`);
    for (const n of s.parked) console.log(`parked ${n}`);
  } else if (cmd === 'init') console.log(await init(name));
  else if (cmd === 'new') console.log(await newAccount(name));
  else if (cmd === 'use') console.log(await use(name));
  else {
    console.error(USAGE);
    process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
