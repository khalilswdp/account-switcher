#!/usr/bin/env node
// What accounts exist in the Vault, and which parts of each. Names and save times only,
// printed as one line of JSON for the dashboard:
//   { "accounts": { "test": { "desktop": {pushedAt, host}|null, "cli": ... } },
//     "unreadable": ["desktop/x"],   entries that exist but hold nothing this tool can read
//     "ignored": ["main"] }          entries outside desktop/ and cli/ (old browser sessions)
//
// Entries live at claude-switcher/desktop/<name> and claude-switcher/cli/<name>, each one key
// "envelope" holding the JSON the scripts write (an entry written by hand as separate fields is
// accepted too, see lib/vault-client.mjs). Names starting with "_" are skipped silently.
import { fail, provider } from './lib/vault-client.mjs';

const NAME = /^[\w-]+$/;

// The save time and host of one entry, or null when it cannot be read as an envelope.
async function info(id) {
  const raw = await provider().read(id);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw);
    return typeof env.pushedAt === 'string' ? { pushedAt: env.pushedAt, host: env.host ?? null } : null;
  } catch {
    return null;
  }
}

try {
  const accounts = {};
  const unreadable = [];
  const ignored = [];
  for (const [prefix, part] of [['desktop/', 'desktop'], ['cli/', 'cli']]) {
    for (const key of await provider().list(prefix)) {
      if (key.endsWith('/') || !NAME.test(key) || key.startsWith('_')) continue;
      const value = await info(`${prefix}${key}`);
      if (!value) {
        unreadable.push(`${prefix}${key}`);
        continue;
      }
      accounts[key] ??= { desktop: null, cli: null };
      accounts[key][part] = value;
    }
  }
  for (const key of await provider().list('')) {
    if (!key.endsWith('/') && !key.startsWith('_')) ignored.push(key);
  }
  console.log(JSON.stringify({ accounts, unreadable: unreadable.sort(), ignored: ignored.sort() }));
} catch (e) {
  fail(e.message);
}
