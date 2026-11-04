# Handoff: Claude account switcher

Written at commit `73187ae` (23 commits, about 3,500 lines). macOS only. Read the first section before
touching anything.

## Read this first

1. **Secrets.** The code handles live logins (cookies, tokens, Keychain items). It never prints a value.
   Keep it that way: counts, names, times and masked emails only, in code, logs, tests and chat.
2. **Nothing here has a test suite.** Every feature was checked with throwaway scratch scripts (see
   "How it was tested"). If you change behaviour, recreate that kind of check; do not trust a green
   `node --check`.
3. **The corporate account.** `main` is a company account. It is opted in to the Vault through the
   gitignored `.env` at the user's request. Check company policy before widening that.

## What this is

A local dashboard (`http://127.0.0.1:3000`) that lets one person keep two Claude accounts (`main`, `test`)
and move between them without logging in again, on three surfaces:

| Part | What the account is | Where it lives |
|---|---|---|
| Desktop app | The Claude desktop app's login | One cookie, `sessionKey`, in `~/Library/Application Support/Claude[.<name>]/Cookies` |
| Browser (claude.ai) | A Playwright Chromium profile | `.profiles/<id>` (gitignored) |
| Claude Code CLI | The CLI's login | A Keychain item, one per config folder |

A private HashiCorp Vault (Docker, localhost) holds the logins so another Mac can load them. An
encrypted `.csbk` file holds a full backup of one account (logins plus things that cannot be re-downloaded).

## Quick start

Needs: macOS, a recent Node (developed on **26.13** only; it uses `node:sqlite` and
`process.loadEnvFile`, so use a current release), Docker Desktop, the `claude` CLI, the Claude desktop app.

```bash
npm install && npx playwright install chromium
cp .env.example .env                       # sets VAULT_ALLOWED_ACCOUNTS
node scripts/vault-local.mjs up            # start the Vault container
node scripts/vault-local.mjs init          # first time only; copy ~/.claude-switcher-vault/keys.json to a password manager
npm run dev                                # dashboard, restarts itself when server code changes
```

Start the dashboard from **Terminal.app, not from inside the Claude desktop app**: switching and loading
quit that app, and the server refuses to do it if it detects it is running inside it.

After any reboot or container restart the Vault comes back **sealed**: `npm run vault:local -- unseal`.

## Layout

| Path | Role |
|---|---|
| `src/server.js` | Express API: browser profiles and tasks, login window, CLI launcher (Terminal.app), desktop switch, Vault save/load, backup/restore, native file picker |
| `public/index.html` | The whole UI (Tailwind CDN, vanilla JS): "From the Vault" panel, account cards, backup and restore dialogs, activity log |
| `scripts/desktop-swap.sh` | Switch desktop accounts by renaming `Claude` and `Claude.<name>`. State file `~/.claude-desktop-accounts/active` |
| `scripts/desktop-vault.mjs` | Desktop login to and from the Vault (see "Crypto") |
| `scripts/vault.mjs` | Browser session (Playwright `storageState` JSON) to and from the Vault |
| `scripts/cli-vault.mjs` | CLI login (Keychain item) to and from the Vault |
| `scripts/backup.mjs` | Encrypted backup: `backup`, `verify`, `restore`, `inspect`, `apply` |
| `scripts/vault-local.mjs` | Run the Docker Vault: `up init unseal token policy status backup restore purge trim down` |
| `scripts/vault-list.mjs` | Which accounts and parts exist in the Vault (names and times only) |
| `scripts/lib/vault-client.mjs` | Vault access (HTTP, KV v2) plus a file provider used by tests; reads `.env` |
| `scripts/lib/chromium-crypto.mjs` | Chromium/Electron macOS "v10" encryption helpers |
| `vault/docker-compose.yml` | Vault 2.2.1, raft storage, `127.0.0.1:8200`, UI on |
| `accounts.json` | The configured accounts. Accounts that exist only in the Vault are added to the gitignored `.accounts.local.json` |

Not in git: `.env`, `.profiles/`, `.backups/`, `.state/`, `.accounts.local.json`. Outside the repo:
`~/.claude-switcher-vault/` (`keys.json` = unseal key and root token, `token` = the limited token the
scripts use), `~/.claude-desktop-accounts/`, `~/.claude-<name>/` (CLI config folders).

## Concepts

**Accounts and naming.** `main` uses the default CLI config folder `~/.claude`; every other account
uses `~/.claude-<name>` (an `accounts.json` entry can override it). Desktop folders are
`Claude` (active) and `Claude.<name>` (parked). Browser profiles are `.profiles/<name>`.

**Vault layout.** KV v2 mount `secret/`, entries under `claude-switcher/`:
`desktop/<name>`, `cli/<name>`, `<name>` (browser). Each value is one JSON "envelope". History is
capped at 2 versions (`trim`). The helper uses a limited token (policy: read, write, list under
`claude-switcher` only). A push does nothing when nothing changed (a fingerprint, or the Keychain
item's modified time for the CLI), so there is no new version and no Keychain prompt.

**Crypto (desktop).** The app encrypts cookies with a per-Mac key from the Keychain item
"Claude Safe Storage". That key never leaves the Mac. Push decrypts the cookie locally and stores it
decrypted; pull and load encrypt it again with the target Mac's own key. Only `sessionKey` is stored:
tested to be enough to sign in. The consent cookie is left out on purpose (a consent choice belongs to
each machine). On a new Mac, open the Claude app once and quit it before loading (that creates its key).

**CLI login.** A plain Keychain item: service `Claude Code-credentials` for `~/.claude`, otherwise
`Claude Code-credentials-<first 8 hex of sha256(config path)>`, account `$USER`. Loading writes it with
`security -i` so the value is never in a process list.

**Backup file.** `CSBK` header, scrypt key from the passphrase, AES-256-GCM over a gzip tar. Contents:
`vault/` (the three logins in Vault format), `claude-config/` (history, settings, skills, plugins, no
caches), `claude.json` (default config only), `desktop-data/` (no caches, VM bundles, binaries or the
encrypted cookie file), `manifest.json`. Restore is **additive only**: it adds missing files, never
overwrites or deletes, keeps modification times (Claude Code sorts history by them), and authenticates
the whole file before writing. Logins come back via the Vault, then the Load buttons.

## Commands

```bash
npm run dev                                        # dashboard
npm run vault:local -- status | unseal | token | policy | trim | backup <file> | restore <file>
npm run vault -- push|pull|status <name>           # browser session
npm run desktop-vault -- push|pull|load|status <name>   # pull takes --as <newname>
npm run cli-vault -- push|pull|status <name>       # pull takes --config <folder> and --replace
node scripts/vault-list.mjs
node scripts/backup.mjs backup <name> --to <folder> [--replace]
node scripts/backup.mjs verify <file>
node scripts/backup.mjs restore <file> --out <folder> [--to-vault]
node scripts/desktop-swap.sh list | status | init <name> | new <name> | use <name>
```

Backup and restore read the passphrase from the terminal (hidden) or from the first line of stdin.

## Rules the code keeps

- Never overwrite or delete the user's data. Loads merge; restores add; a backup never reuses a file name.
- Anything destructive (replace a CLI login, quit the desktop app, replace old backups) is confirmed in the UI first.
- Passphrases travel in a request body, then stdin; never a URL, argument or log line.
- The server binds to `127.0.0.1` and rejects POSTs whose `Origin` is not its own host.
- One Vault operation at a time (`vaulting` flag): login reads can show Keychain prompts.
- `VAULT_ALLOWED_ACCOUNTS` (in `.env`) gates every save and load per account; default `test` only.

## State at handoff

**Built and checked** (in scratch, with fake data or read-only on real data): save and load of all three
parts, discovery of accounts from the Vault, the desktop and browser switch buttons, encrypted backup,
verify, restore (including damaged-file and wrong-passphrase cases), history cap, unchanged-push skip,
the native Browse pickers (chooser stubbed), live read of the running app's cookie file.

**Verified on the user's real machine:** the desktop switch (quit, swap, reopen), signing in from
cookie-only folders, a pull built from the Vault, a CLI login restored into a fresh config folder
(`claude auth status` reported logged in), and saving `main`'s three parts (it shows in the Vault listing).

**Not verified or not done:**
- A **second Mac** accepting a pulled session (device or IP checks, the `sessionKey` lifetime of about
  27 days, Cloudflare on a new network). This is the biggest open question.
- Whether one CLI login used on two laptops at once signs one of them out (refresh-token rotation).
- A real **backup of `main`** (about 450 MB, mostly Claude Code history) and its restore on another Mac.
  The test account's backup (11 MB) was made, verified and restored.
- The login window's Cloudflare-challenge message was written but never seen running.
- The always-on Vault host and network (see next steps). The Vault runs on this Mac only.
- Windows and Linux. macOS only (Keychain, `osascript`, `pgrep`, Terminal.app).
- No automated tests, no CI.

**Deliberately not done:** getting around Cloudflare's bot check. Playwright-driven browsers are challenged
(`cf-mitigated: challenge`), bundled Chromium and installed Chrome alike; the cause is the automation
flag. No stealth tricks were built and none should be. The desktop and CLI parts do not use a browser and
are unaffected; treat the Playwright browser part as best effort.

## Gotchas learned the hard way

- **The CLI finds its Keychain item through `$USER`.** In an environment without `USER`, `claude auth
  status` says not logged in even though the login exists. Check a CLI login with
  `env -i HOME="$HOME" USER="$(id -un)" PATH="$PATH" CLAUDE_CONFIG_DIR=<dir> CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir> claude auth status`.
- **Chromium cookie timestamps overflow a JS number.** Read them with `setReadBigInts(true)`. Cookie DB
  version 24 prefixes the plaintext with `sha256(host_key)`.
- **Vault 2.x** will not start with raft storage unless `disable_mlock` is set explicitly.
- **Reading the cookie file of a running app is safe** with `VACUUM INTO` over a read-only connection
  (`snapshotCookies`); a plain file copy is not. Only writes (`load`) need the app closed.
- **The desktop app ignores a custom data folder** (signed build), hence the rename-based swap.
- **Keychain reads show a macOS prompt.** Click Allow (not "Always Allow").
- **A running dashboard does not pick up server changes** unless started with `npm run dev`. A stale server
  shows as "restart the dashboard server" in the UI.
- **zsh does not word-split unquoted variables.** Run multi-step test harnesses as `bash script.sh`.
- **Claude Code's safety check blocks `rm -rf` run by the agent.** Folder deletions were left to the user.
- The Vault keeps a version per write: trim after bulk changes, and `purge` an entry that once held more than it should.

## How it was tested

Each change got a throwaway bash script (not kept in the repo) that used: a **fake account** with fake
config and desktop folders, `VAULT_PROVIDER=file` with `VAULT_FILE_DIR` as a plaintext stand-in Vault, a
**second server on port 3100** with scratch `PROFILES_DIR`, `BACKUP_DIR`, `SUPPORT_DIR` and `SWAP_STATE_DIR`,
**stubs for `pgrep`, `osascript` and `open`** on `PATH` to fake "the app is running" and the quit/open
steps, a **throwaway Keychain item** under a different service name as "the new Mac's key"
(`SAFE_STORAGE_SERVICE`), and a **throwaway CLI config folder** whose Keychain item was deleted after.
Every script also checked that the user's real Keychain items were unchanged afterwards and that no secret
value appeared in any output. Reuse that pattern.

## Suggested next steps

1. **Pick the always-on Vault host** (a small Linux box or NAS; Tailscale was the leading idea). The helper
   already refuses plain http to a non-local address, so it needs TLS, persistent storage, an unseal plan
   and a token limited to `claude-switcher`.
2. **Make `main`'s backup, `verify` it, and restore it on a second Mac** to close the biggest open
   questions above.
3. **Add real tests** (the scratch scripts are the specification) and npm shortcuts for `backup.mjs`
   and `vault-list.mjs`.
4. Ask whether a Vault-only account should get a friendlier label than its id.
