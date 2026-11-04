#!/usr/bin/env node
// What accounts exist in the Vault, and which parts of each. Names and save times only,
// printed as one line of JSON for the dashboard:
//   { "accounts": { "test": { "desktop": {pushedAt, host}|null, "cli": ..., "allowed": true } } }
//
// Entries live at claude-switcher/desktop/<name> and claude-switcher/cli/<name>. Anything else
// under claude-switcher (such as a browser session left by the dropped browser part) is ignored.
// Names starting with "_" are ignored too.
//   VAULT_ALLOWED_ACCOUNTS  comma list, default "test": the accounts this tooling may load or save
import { fail, provider } from './lib/vault-client.mjs';

const ALLOWED = (process.env.VAULT_ALLOWED_ACCOUNTS || 'test').split(',').map((s) => s.trim()).filter(Boolean);
const NAME = /^[\w-]+$/;

async function info(id) {
  const raw = await provider().read(id);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw);
    return { pushedAt: env.pushedAt ?? null, host: env.host ?? null };
  } catch {
    return null;
  }
}

try {
  const accounts = {};
  const add = (name, part, value) => {
    if (!NAME.test(name) || name.startsWith('_') || !value) return;
    accounts[name] ??= { desktop: null, cli: null, allowed: ALLOWED.includes(name) };
    accounts[name][part] = value;
  };
  for (const [prefix, part] of [['desktop/', 'desktop'], ['cli/', 'cli']]) {
    for (const key of await provider().list(prefix)) {
      if (!key.endsWith('/')) add(key, part, await info(`${prefix}${key}`));
    }
  }
  console.log(JSON.stringify({ accounts }));
} catch (e) {
  fail(e.message);
}
