# Handoff: Claude account switcher

Last updated 2026-11-04, after the dashboard rebuild, the test suite, and dropping the browser part.
macOS only. Read the first section before touching anything.

## Read this first

1. **Secrets.** The code handles live logins (cookies, tokens, Keychain items). It never prints a value.
   Keep it that way: counts, names, times and masked emails only, in code, logs, tests and chat.
2. **There is a test suite: `npm test`.** It runs the scripts and the server end to end in scratch folders,
   with a fake `security` command (no real Keychain, no prompts), fake `pgrep`/`osascript`/`open`, and
   the file provider as the Vault. It never touches the real Vault or real logins. If you change behaviour,
   extend it; do not trust a green `node --check`.
3. **The corporate account.** `main` is a company account. It is opted in to the Vault through the
   gitignored `.env` at the user's request. Check company policy before widening that.
4. **The browser part was dropped on purpose** (2026-11-04). See "Dropped" below before adding it back.

## What this is

A local dashboard (`http://127.0.0.1:3000`) that lets one person keep several Claude accounts
(`main`, `test`, more if wanted) and move between them without logging in again, on two surfaces:

| Part | What the account is | Where it lives |
|---|---|---|
| Claude app (desktop) | The Claude desktop app's login | One cookie, `sessionKey`, in `~/Library/Application Support/Claude[.<name>]/Cookies` |
| Claude Code CLI | The CLI's login | A Keychain item, one per config folder |

A private HashiCorp Vault (Docker, localhost) holds the logins so another Mac can load them. An
encrypted `.csbk` file holds a full backup of one account (logins plus things that cannot be re-downloaded).

## Quick start

Needs: macOS, a recent Node (developed on **26.13**; it uses `node:sqlite` and `process.loadEnvFile`,
so use a current release), Docker Desktop, the `claude` CLI, the Claude desktop app.

```bash
npm install
cp .env.example .env                       # sets VAULT_ALLOWED_ACCOUNTS
node scripts/vault-local.mjs up            # start the Vault container
node scripts/vault-local.mjs init          # first time only; copy ~/.claude-switcher-vault/keys.json to a password manager
npm start                                  # dashboard; restarts itself when server code changes, and the page reloads itself
npm test                                   # the test suite (about 5 seconds)
```

Start the dashboard from **Terminal.app, not from inside the Claude desktop app** (a shell in the Code tab
counts as inside): switching and loading quit that app, and the server refuses to do it when it detects it
is running inside it.

After any reboot or container restart the Vault comes back **sealed**: `npm run vault:local -- unseal`.

## Layout

| Path | Role |
|---|---|
| `src/server.js` | Express API: CLI launcher (Terminal.app), desktop switch/init/new, accounts, Vault save/load/add, backup/restore, native file picker |
| `public/index.html` | The whole UI, one file, own CSS (no CDN): status strip, first-run setup, Vault-only accounts, one card per account with a row per surface, styled confirmations, activity log, add-account, backup and restore dialogs |
| `test/` | `node --test` suite: `helpers.mjs` (stubs, scratch "Mac", fake cookie DB), crypto, desktop-swap, the Vault scripts and backup, the server |
| `scripts/desktop-swap.sh` | Switch desktop accounts by renaming `Claude` and `Claude.<name>`. State file `~/.claude-desktop-accounts/active` |
| `scripts/desktop-vault.mjs` | Desktop login to and from the Vault (see "Crypto") |
| `scripts/cli-vault.mjs` | CLI login (Keychain item) to and from the Vault |
| `scripts/backup.mjs` | Encrypted backup: `backup`, `verify`, `restore`, `inspect`, `apply` |
| `scripts/vault-local.mjs` | Run the Docker Vault: `up init unseal token policy status backup restore purge trim down` |
| `scripts/vault-list.mjs` | Which accounts and parts exist in the Vault (names and times only) |
| `scripts/lib/vault-client.mjs` | Vault access (HTTP, KV v2) plus a file provider used by tests; reads `.env` |
| `scripts/lib/chromium-crypto.mjs` | Chromium/Electron macOS "v10" encryption helpers (the Claude app is an Electron app) |
| `vault/docker-compose.yml` | Vault 2.2.1, raft storage, `127.0.0.1:8200`, UI on |
| `accounts.json` | The hand-edited accounts. Accounts added on the page or from the Vault go to the gitignored `.accounts.local.json` |

Not in git: `.env`, `.backups/` (only the `.vault-rev` sync markers now), `.accounts.local.json`, and the
leftovers of the browser part (`.profiles/`, `.state/`), which the user can delete. Outside the repo:
`~/.claude-switcher-vault/` (`keys.json` = unseal key and root token, `token` = the limited token the
scripts use), `~/.claude-desktop-accounts/`, `~/.claude-<name>/` (CLI config folders).

## Concepts

**Accounts and naming.** `main` uses the default CLI config folder `~/.claude`; every other account
uses `~/.claude-<name>` (an `accounts.json` entry can override it). Desktop folders are
`Claude` (active) and `Claude.<name>` (parked).

**The page.** One card per account, two rows (Claude app, Claude Code), each with its state, its action,
and a Vault line with "Save to Vault" and "Load from Vault". The strip at the top says which account the
app is on and whether the Vault is reachable. Every action that quits the app, replaces a login or
replaces a Vault copy goes through a styled confirmation (`ask()` in the page), never a browser
`confirm()`. While something runs, the card shows what and why ("click Allow if macOS asks").
The page polls `/api/state` every 2 s and re-renders only when something changed. It carries the server's
`X-Dashboard-Build` header: when it changes (the server restarted) the page reloads itself, and an old
server without `/api/state` is reported in the strip instead of showing nothing.

**Accounts, from the page.** "Add an account…" makes a brand-new one (`POST /api/accounts` with
`{id, label}`): it gets a card with nothing signed in; "Sign in via the app…" and "Open in Terminal" take
it from there. When the app's data folder is not assigned yet, the page asks "which account is the Claude
app signed in as right now?" (`POST /api/desktop/init/:id`). An account with no app data gets "Sign in
via the app…" (`POST /api/desktop/new/:id`: parks the current data, reopens the app signed out). An
account that exists only in the Vault is listed with "Add to this Mac" (`POST /api/vault/add?account=`,
optional `{label}`), after which its card's Load buttons bring the logins over. Both kinds are remembered
in `.accounts.local.json`. A new account must be added to `VAULT_ALLOWED_ACCOUNTS` in `.env` before its
Vault buttons work (the card says so). "Remove from this Mac" on a card forgets the account
(`DELETE /api/accounts/:id`), in whichever file listed it, and deletes none of its data: app folder,
Claude Code folder, Keychain login and Vault entries all stay, so it can be added back. It is refused
while the Claude app is on that account. With no accounts at all the page shows an empty state.

**Vault layout.** KV v2 mount `secret/`, entries under `claude-switcher/`: `desktop/<name>` and
`cli/<name>`. Each value is one JSON "envelope". History is capped at 2 versions (`trim`). The helper
uses a limited token (policy: read, write, list under `claude-switcher` only). A push does nothing when
nothing changed (a fingerprint, or the Keychain item's modified time for the CLI), so there is no new
version and no Keychain prompt. A push refuses when the Vault copy changed from another Mac since this
one last synced; the page then asks whether to replace it and retries with `?force=1`. Entries directly
under `claude-switcher/` (the old browser sessions) are ignored; purge them with
`npm run vault:local -- purge <name>`.

**Crypto (desktop).** The app encrypts cookies with a per-Mac key from the Keychain item
"Claude Safe Storage". That key never leaves the Mac. Push decrypts the cookie locally and stores it
decrypted; pull and load encrypt it again with the target Mac's own key. Only `sessionKey` is stored:
tested to be enough to sign in. The consent cookie is left out on purpose (a consent choice belongs to
each machine). On a new Mac, open the Claude app once and quit it before loading (that creates its key).

**CLI login.** A plain Keychain item: service `Claude Code-credentials` for `~/.claude`, otherwise
`Claude Code-credentials-<first 8 hex of sha256(config path)>`, account `$USER`. Loading writes it with
`security -i` so the value is never in a process list.

**Backup file.** `CSBK` header, scrypt key from the passphrase, AES-256-GCM over a gzip tar. Contents:
`vault/` (the two logins in Vault format), `claude-config/` (history, settings, skills, plugins, no
caches), `claude.json` (default config only), `desktop-data/` (no caches, VM bundles, binaries or the
encrypted cookie file), `manifest.json`. Restore is **additive only**: it adds missing files, never
overwrites or deletes, keeps modification times (Claude Code sorts history by them), and authenticates
the whole file before writing. Logins come back via the Vault, then the Load buttons. A backup made before
the browser part was dropped also holds `vault/<name>.json`; `apply` skips it and says so.

## Commands

```bash
npm start                                          # dashboard (npm run dev is the same)
npm test                                           # test suite
npm run vault:local -- status | unseal | token | policy | trim | purge <entry> | backup <file> | restore <file>
npm run desktop-vault -- push|pull|load|status <name>   # pull takes --as <newname>
npm run cli-vault -- push|pull|status <name>       # pull takes --config <folder> and --replace
npm run vault:list
npm run backup -- backup <name> --to <folder> [--replace]
npm run backup -- verify <file>
npm run backup -- restore <file> --out <folder> [--to-vault]
scripts/desktop-swap.sh list | status | init <name> | new <name> | use <name>
```

Backup and restore read the passphrase from the terminal (hidden) or from the first line of stdin.

## Rules the code keeps

- Never overwrite or delete the user's data. Loads merge; restores add; a backup never reuses a file name.
- Anything destructive (replace a CLI login, quit the desktop app, replace old backups, replace a Vault
  copy) is confirmed in the UI first, with the consequence spelled out.
- Passphrases travel in a request body, then stdin; never a URL, argument or log line.
- The server binds to `127.0.0.1`, refuses any request whose `Host` is not local (DNS rebinding), and
  rejects POSTs whose `Origin` is not its own host.
- One Vault operation at a time (`vaulting` flag): login reads can show Keychain prompts.
- `VAULT_ALLOWED_ACCOUNTS` (in `.env`) gates every save and load per account; default `test` only.

## State at handoff

**Covered by `npm test`** (13 tests): crypto round trips and host binding; `desktop-swap.sh` init/new/use,
rollback refusals, running-app refusal; desktop push (only `sessionKey`, decrypted, consent cookie left
out), unchanged-push skip, pull into a parked folder, load merging into an existing cookie file,
allow-list, changed-elsewhere refusal and `--force`; CLI push/pull/replace with the Keychain item name
derived from the config path; the Vault listing (old browser entries ignored); backup, verify, inspect,
wrong passphrase, damaged file, `--replace`, additive apply (existing file kept, mtime kept, caches left
out, no cookie file), loading the restored entry on a "new Mac"; the server's state, Host/Origin guards,
JSON 404, desktop init/new/switch with quit and reopen, the CLI launcher command, adding accounts (new
and from the Vault), per-account Vault status without values, backup listing, and the port-in-use
message. Every test also checks that no fake secret appears in any output.

**Verified on the user's real machine (earlier):** the desktop switch (quit, swap, reopen), signing in from
cookie-only folders, a pull built from the Vault, a CLI login restored into a fresh config folder, and
saving `main`'s parts. **Viewed, not clicked, after the rebuild:** the page against the real accounts, in
light and dark, with the confirmation and add-account dialogs opened and cancelled.

**Not verified or not done:**
- A **second Mac** accepting a pulled session (device or IP checks, the `sessionKey` lifetime of about
  27 days, Cloudflare on a new network). This is the biggest open question.
- Whether one CLI login used on two laptops at once signs one of them out (refresh-token rotation).
- A real **backup of `main`** (about 450 MB, mostly Claude Code history) and its restore on another Mac.
  The test account's backup (11 MB) was made, verified and restored (when it still had three parts).
- The always-on Vault host and network (see next steps). The Vault runs on this Mac only.
- Windows and Linux. macOS only (Keychain, `osascript`, `pgrep`, Terminal.app).
- No CI.

**Dropped (2026-11-04): claude.ai in an automated browser.** It was one Playwright Chromium profile per
account, with a sign-in window, a Vault entry per account (`claude-switcher/<name>`) and a part of the
backup. Cloudflare challenges every Playwright-driven browser (`cf-mitigated: challenge`, bundled Chromium
and installed Chrome alike) because of the automation flag, and no stealth tricks were built or should be.
The Claude app covers the same chats, so the part was removed: the Playwright dependency, `scripts/vault.mjs`,
the browser row and endpoints, and the browser login in backups. If claude.ai per account in a browser is
ever wanted, build it on ordinary Chrome profiles (one per account, opened with
`open -na "Google Chrome" --args --profile-directory=...`), which are not challenged; Chrome keeps cookies
in the same "v10" format as the Claude app ("Chrome Safe Storage" key), so `chromium-crypto.mjs` and the
desktop-vault approach would carry over.

## Gotchas learned the hard way

- **The server refuses desktop actions when started from inside the Claude desktop app**, and a shell in
  the Code tab is inside it (`__CFBundleIdentifier` is set). Start the dashboard from Terminal.app. The
  tests clear that variable themselves.
- **The CLI finds its Keychain item through `$USER`.** In an environment without `USER`, `claude auth
  status` says not logged in even though the login exists. Check a CLI login with
  `env -i HOME="$HOME" USER="$(id -un)" PATH="$PATH" CLAUDE_CONFIG_DIR=<dir> CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir> claude auth status`.
- **Chromium cookie timestamps overflow a JS number.** Read them with `setReadBigInts(true)`. Cookie DB
  version 24 prefixes the plaintext with `sha256(host_key)`. The test helper builds such a database.
- **Vault 2.x** will not start with raft storage unless `disable_mlock` is set explicitly.
- **Reading the cookie file of a running app is safe** with `VACUUM INTO` over a read-only connection
  (`snapshotCookies`); a plain file copy is not. Only writes (`load`) need the app closed.
- **The desktop app ignores a custom data folder** (signed build), hence the rename-based swap.
- **Keychain reads show a macOS prompt.** Click Allow (not "Always Allow").
- **A real environment variable beats `.env`** (`process.loadEnvFile` does not override): that is what
  lets the tests point every script at scratch folders.
- **zsh does not word-split unquoted variables.** Run multi-step shell harnesses as `bash script.sh`.
- **Claude Code's safety check blocks `rm -rf` run by the agent.** Folder deletions were left to the user.
- The Vault keeps a version per write: trim after bulk changes, and `purge` an entry that once held more than it should.

## How it is tested

`npm test` runs `test/*.test.mjs` with Node's own runner. `test/helpers.mjs` builds a scratch "Mac":
a `bin/` with a fake `security` (a file-backed Keychain plus a fixed "Safe Storage" password for the
service named in `SAFE_STORAGE_SERVICE`), fake `pgrep`/`osascript`/`open` driven by a marker file, a
scratch `HOME`, `SUPPORT_DIR`, `SWAP_STATE_DIR`, `BACKUP_DIR`, `ACCOUNTS_FILE`, and
`VAULT_PROVIDER=file` with `VAULT_FILE_DIR`. `makeCookieDb` writes a cookie database shaped like the
app's. The server test starts `src/server.js` on a free port with all of that and talks to it over HTTP.
Reuse these helpers for anything new; add a stub rather than touching a real system.

## Suggested next steps

1. **Pick the always-on Vault host** (a small Linux box or NAS; Tailscale was the leading idea). The helper
   already refuses plain http to a non-local address, so it needs TLS, persistent storage, an unseal plan
   and a token limited to `claude-switcher`.
2. **Make `main`'s backup, `verify` it, and restore it on a second Mac** to close the biggest open
   questions above.
3. **Clean up after the browser part**: `npm run vault:local -- purge main` (and `test` if it has one) for
   the old browser sessions in the Vault, delete `.profiles/` and `.state/`, and delete the Playwright
   browser cache in `~/Library/Caches/ms-playwright` if nothing else uses it.
4. Decide whether every account should be allowed in the Vault by default (an exclusion list instead of
   `VAULT_ALLOWED_ACCOUNTS`), now that accounts can be added from the page.
