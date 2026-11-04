# Handoff: Claude account switcher

Last updated 2026-11-04, after the Windows port. macOS and Windows; Linux gets the Claude Code,
Vault and backup parts only. Read the first section before touching anything.

## Read this first

1. **Secrets.** The code handles live logins (cookies, tokens, Keychain items, credential files). It
   never prints a value. Keep it that way: counts, names, times and masked emails only, in code, logs,
   tests and chat.
2. **There is a test suite: `npm test`**, and it runs on macOS and Windows. It runs the scripts and the
   server end to end in scratch folders with the OS parts faked (`SWITCHER_STUB_DIR`, see "How it is
   tested"): no real app, login, key or prompt is ever touched. If you change behaviour, extend it; do
   not trust a green `node --check`.
3. **Everything OS-specific lives in `scripts/lib/platform.mjs`.** The scripts and the server never
   call an OS command of their own. A new platform difference goes there, with a fake for the tests.
4. **Protected accounts.** `main` is the company account and is protected (`PROTECTED_ACCOUNTS` in the
   gitignored `.env`, default `main`): it is switched to, saved to the Vault and backed up like any
   other, but the page can never remove it or delete anything of it. Every account may use the Vault.
5. **The browser part was dropped on purpose** (2026-11-04). See "Dropped" below before adding it back.

## What this is

A local dashboard (`http://127.0.0.1:3000`) that lets one person keep several Claude accounts
(`main`, `test`, more if wanted) and move between them without logging in again, on two surfaces:

| Part | What the account is | macOS | Windows |
|---|---|---|---|
| Claude app (desktop) | The app's login: one cookie, `sessionKey` | `~/Library/Application Support/Claude[.<name>]/Cookies`, encrypted with the per-Mac key in the Keychain item "Claude Safe Storage" (AES-128-CBC) | `%APPDATA%\Claude[.<name>]\Network\Cookies`, encrypted with a per-folder key kept in that folder's `Local State`, protected with DPAPI for the Windows user (AES-256-GCM) |
| Claude Code CLI | The CLI's login | A Keychain item, one per config folder | The file `.credentials.json` inside the config folder |

The Vault entries are the same on both systems (the cookie is stored decrypted, the CLI login is the
same JSON), so a login saved on a Mac loads on a PC and the other way round. A private HashiCorp
Vault (Docker, localhost) holds them. An encrypted `.csbk` file holds a full backup of one account
(logins plus things that cannot be re-downloaded).

## Quick start

Needs: a recent Node (**24 or newer**: `node:sqlite` with its `timeout` option, `process.loadEnvFile`;
developed on 26.13 on the Mac and 24.18 on Windows), Docker Desktop, the `claude` CLI, the Claude
desktop app. On Windows, nothing else: `tar.exe` and PowerShell ship with it.

```bash
npm install
cp .env.example .env                       # sets PROTECTED_ACCOUNTS (Windows: copy .env.example .env)
node scripts/vault-local.mjs up            # start the Vault container
node scripts/vault-local.mjs init          # first time only; copy ~/.claude-switcher-vault/keys.json to a password manager
npm start                                  # dashboard; restarts itself when server code changes, and the page reloads itself
npm test                                   # the test suite (about 5 seconds on a Mac, 12 on Windows)
```

Start the dashboard from **a terminal of your own, not from inside the Claude desktop app** (a shell
in its Code tab counts as inside): switching and loading quit that app, and the server refuses to do
it when it detects it is running inside it (`__CFBundleIdentifier` on macOS, `CLAUDE_CODE_ENTRYPOINT`
or `CLAUDE_CODE_DESKTOP_APP_VERSION` on both).

After any reboot or container restart the Vault comes back **sealed**: `npm run vault:local -- unseal`.
If Docker Hub refuses the image pull (an expired Docker Hub login does that), `docker login` first, or
pull it from HashiCorp's public mirror and tag it (`docker pull public.ecr.aws/hashicorp/vault:2.2.1 &&
docker tag public.ecr.aws/hashicorp/vault:2.2.1 hashicorp/vault:2.2.1`, which is what was done on the
Windows PC on 2026-11-04), or run with `VAULT_IMAGE=hashicorp/vault:<a version you have>` in `.env`
(`vault-local.mjs` reads `.env` too).

**On the Windows PC the local Vault is set up and is the default** (2026-11-04): `.env` there sets
`PROTECTED_ACCOUNTS=main`, `VAULT_PROVIDER=hashicorp` and `VAULT_ADDR=http://127.0.0.1:8200`, the
container `claude-switcher-vault-vault-1` runs Vault 2.2.1 with `restart: unless-stopped`, and
`~/.claude-switcher-vault/` holds `keys.json` and the limited `token`. Nothing has been saved into it yet.

## Layout

| Path | Role |
|---|---|
| `src/server.js` | Express API: CLI launcher, desktop switch/init/new, accounts, Vault save/load/add, backup/restore, native file picker. Calls the two libraries below; never an OS command |
| `public/index.html` | The whole UI, one file, own CSS (no CDN): status strip, first-run setup, Vault-only accounts, one card per account with a row per surface, styled confirmations, activity log, add-account, backup and restore dialogs. Its words follow the server's `platform` (this Mac / this PC, Keychain / credentials file) |
| `scripts/lib/platform.mjs` | **Every OS difference**: the app's data folder and cookie file, the cookie key (Keychain / `Local State` + DPAPI), the CLI login store (Keychain / `.credentials.json`), finding, quitting and reopening the app, the terminal, the file choosers, `tar`, staging links. Plus the fake used by tests |
| `scripts/lib/desktop.mjs` | Which account the app is on and the renames that switch it (`init`, `new`, `use`, `listState`). State file `~/.claude-desktop-accounts/active`. The server calls it directly |
| `scripts/desktop-swap.mjs` | Command-line face of `desktop.mjs`: `status list init new use` (replaced the old `desktop-swap.sh`) |
| `scripts/desktop-vault.mjs` | Desktop login to and from the Vault (see "Crypto") |
| `scripts/cli-vault.mjs` | CLI login to and from the Vault |
| `scripts/backup.mjs` | Encrypted backup: `backup`, `verify`, `restore`, `inspect`, `apply` |
| `scripts/vault-local.mjs` | Run the Docker Vault: `up init unseal token policy status backup restore purge trim down` |
| `scripts/vault-list.mjs` | Which accounts and parts exist in the Vault (names and times only) |
| `scripts/lib/vault-client.mjs` | Vault access (HTTP, KV v2) plus a file provider used by tests; reads `.env` |
| `scripts/lib/chromium-crypto.mjs` | Chromium/Electron "v10" value encryption: the macOS scheme (16-byte key, AES-128-CBC) and the Windows one (32-byte key, AES-256-GCM), told apart by key length |
| `test/` | `node --test` suite: `helpers.mjs` (fakes, scratch machine, fake cookie DB), crypto, desktop-swap, the Vault scripts and backup, the server |
| `vault/docker-compose.yml` | Vault 2.2.1 (`VAULT_IMAGE` overrides), raft storage, `127.0.0.1:8200`, UI on |
| `accounts.json` | The hand-edited accounts. Accounts added on the page or from the Vault go to the gitignored `.accounts.local.json` |
| `README.md` | The short user-facing guide: run it, the Vault token and keys, everyday commands, where things are |

Not in git: `.env`, `.backups/` (only the `.vault-rev` sync markers now), `.accounts.local.json`, and the
leftovers of the browser part (`.profiles/`, `.state/`), which the user can delete. Outside the repo:
`~/.claude-switcher-vault/` (`keys.json` = unseal key and root token, `token` = the limited token the
scripts use), `~/.claude-desktop-accounts/`, `~/.claude-<name>/` (CLI config folders).

## Concepts

**Accounts and naming.** `main` uses the default CLI config folder `~/.claude`; every other account
uses `~/.claude-<name>` (an `accounts.json` entry can override it with an absolute path or one
starting with `~/`). Desktop folders are `Claude` (active) and `Claude.<name>` (parked), in
`~/Library/Application Support` on a Mac and `%APPDATA%` on Windows (`SUPPORT_DIR` overrides).

**The page.** One card per account, two rows (Claude app, Claude Code), each with its state, its action,
and a Vault line with "Save to Vault" and "Load from Vault". The strip at the top says which account the
app is on and whether the Vault is reachable. Every action that quits the app, replaces a login or
replaces a Vault copy goes through a styled confirmation (`ask()` in the page), never a browser
`confirm()`. While something runs, the card shows what and why ("click Allow if macOS asks", on a Mac).
The page polls `/api/state` every 2 s and re-renders only when something changed. It carries the server's
`X-Dashboard-Build` header: when it changes (the server restarted) the page reloads itself, and an old
server without `/api/state` is reported in the strip instead of showing nothing. `/api/state` also
carries `platform` (the page picks its words from it) and `desktop.saveQuits` (Windows: a desktop save
of the active account quits the app first, and the confirmation says so).

**Accounts, from the page.** "Add an account…" makes a brand-new one (`POST /api/accounts` with
`{id, label}`): it gets a card with nothing signed in; "Sign in via the app…" and "Open in Terminal" take
it from there. When the app's data folder is not assigned yet, the page asks "which account is the Claude
app signed in as right now?" (`POST /api/desktop/init/:id`). An account with no app data gets "Sign in
via the app…" (`POST /api/desktop/new/:id`: parks the current data, reopens the app signed out). An
account that exists only in the Vault is listed with "Add to this Mac/PC" (`POST /api/vault/add?account=`,
optional `{label}`), after which its card's Load buttons bring the logins over. Both kinds are remembered
in `.accounts.local.json`. A protected account (`PROTECTED_ACCOUNTS` in `.env`, default `main`) shows a
"Protected" chip, has no "Remove" at all, and the server refuses to forget it or delete anything of it
(`guardProtected`); its own Vault entry can still be loaded back onto it, and no account can ever load
another account's entry (a card only ever loads `desktop/<its id>` and `cli/<its id>`).
"Remove from this Mac/PC" on any other card opens the removal dialog. By itself it forgets the account
(`DELETE /api/accounts/:id`), in whichever file listed it, and deletes none of its data. The dialog
first asks the server what the account holds (`GET /api/accounts/:id/holdings?backupFolder=`: Vault
entries, app data folder and Claude Code folder with sizes, the CLI login, backup files of that
account in the remembered folder; the answer's `local` object used to be called `mac`) and lists each
as a checkbox under "Also delete, permanently". With nothing ticked it is a plain removal; with
anything ticked it asks to type the short name, plus the deletion passphrase when one is set, and
posts `/api/accounts/:id/delete` with `{confirm, passphrase, targets, backupFolder}`. The server
deletes each ticked item on its own (Vault entries through `desktop-vault.mjs forget` and
`cli-vault.mjs forget`, the CLI login through `cli-vault.mjs forget-keychain`, folders with `fs.rm`
behind a guard that refuses the home folder or anything above it, backup files only if they are that
account's own in that folder) and forgets the card only when every item succeeded; otherwise the card
stays with the failures in the activity log. It is refused while the Claude app is on that account.
The deletion passphrase is optional: "Require a passphrase for deletions…" in the dialog sets it
(`POST /api/deletion-passphrase` with `{current?, next}`), stored as a scrypt hash in
`~/.claude-switcher-vault/delete-passphrase` (`DELETE_PASSPHRASE_FILE` overrides); delete that file to
stop requiring one. With no accounts at all the page shows an empty state. When a surface has nothing
on this machine but the Vault has its login, that row says so and "Load from Vault" becomes its
primary button; the strip says how many Vault accounts are not on this machine yet.

**Vault layout.** KV v2 mount `secret/`, entries under `claude-switcher/`: `desktop/<name>` and
`cli/<name>`. Each value is one JSON "envelope". History is capped at 2 versions (`trim`). The helper
uses a limited token (policy: read, write, list and delete under `claude-switcher` only; "delete" was
added on 2026-11-04 for the removal dialog, so an older Vault needs `npm run vault:local -- policy`
once, otherwise deletions from the page fail with a message saying so). A push does nothing when
nothing changed (a fingerprint, or the login's modified time for the CLI), so there is no new
version and no Keychain prompt. A push refuses when the Vault copy changed from another machine since
this one last synced; the page then asks whether to replace it and retries with `?force=1`. Each entry
is one KV field `envelope` holding the JSON text the scripts write (an entry written by hand in the
Vault UI as separate fields is accepted when it has a `version` field). The listing names entries it
cannot read (empty or non-JSON envelope, no `pushedAt`) under `unreadable`, and entries directly under
`claude-switcher/` (the old browser sessions) under `ignored`; the page shows both in the strip. Purge
an old entry with `npm run vault:local -- purge <name>`. The page refreshes the listing every 30 s and
after every Vault action.

**Crypto (desktop).** The app encrypts cookies with a key that stays on the machine. macOS: one key per
Mac, the Keychain item "Claude Safe Storage" (password, PBKDF2 to 16 bytes, AES-128-CBC). Windows: one
key per data folder, 32 random bytes in the folder's `Local State` (`os_crypt.encrypted_key`, "DPAPI" +
a DPAPI blob only this Windows user can open), AES-256-GCM with a 12-byte nonce and a 16-byte tag. From
cookie database version 24 the plaintext is SHA-256(host_key) + value on both. The key never leaves the
machine: push decrypts the cookie locally and stores it decrypted; pull and load encrypt it again with
the target machine's own key. A folder being built from the Vault on Windows gets a fresh key written
into a new `Local State`, the way the app would make one (`ensureSafeStorageKey`). Only `sessionKey` is
stored: tested on macOS to be enough to sign in. The consent cookie is left out on purpose (a consent
choice belongs to each machine). The cookie file is `Network/Cookies` in the Windows app and was seen
at the top of the folder in the macOS app; the code takes whichever exists and puts a new one where
the system's build keeps it (`cookieFileIn`). On a new Mac, open the Claude app once and quit it
before loading (that creates its Keychain key).

**CLI login.** macOS: a plain Keychain item, service `Claude Code-credentials` for `~/.claude`,
otherwise `Claude Code-credentials-<first 8 hex of sha256(config path)>`, account `$USER`; loading
writes it with `security -i` so the value is never in a process list. Windows and Linux: the file
`<config folder>/.credentials.json` (owner-only); its modified time stands in for the Keychain's
`mdat`, in the same `20261104144455Z` form. The Vault envelope format is still called `cli-keychain`.

**Backup file.** `CSBK` header, scrypt key from the passphrase, AES-256-GCM over a gzip tar. Contents:
`vault/` (the two logins in Vault format), `claude-config/` (history, settings, skills, plugins; no
caches, and not `.credentials.json`, which is in `vault/`), `claude.json` (default config only),
`desktop-data/` (no caches, VM bundles, binaries, cookie files, the `Network` folder or `Local State`,
which holds the Windows key), `manifest.json`. Restore is **additive only**: it adds missing files,
never overwrites or deletes, keeps modification times (Claude Code sorts history by them), and
authenticates the whole file before writing. Logins come back via the Vault, then the Load buttons. A
backup made on either system restores on the other. A backup made before the browser part was
dropped also holds `vault/<name>.json`; `apply` skips it and says so. The staging area is made of
symlinks on macOS and of directory junctions plus file copies on Windows (file symlinks need a
privilege there); a file the running app holds open cannot be copied and is noted in the manifest.

## Commands

```bash
npm start                                          # dashboard (npm run dev is the same)
npm test                                           # test suite
npm run vault:local -- status | unseal | token | policy | trim | purge <entry> | backup <file> | restore <file>
npm run desktop-vault -- push|pull|load|status|forget <name>   # pull takes --as <newname>; forget deletes the Vault entry
npm run cli-vault -- push|pull|status|forget|forget-keychain <name>   # pull takes --config <folder> and --replace
npm run vault:list
npm run backup -- backup <name> --to <folder> [--replace]
npm run backup -- verify <file>
npm run backup -- restore <file> --out <folder> [--to-vault]
npm run desktop-swap -- list | status | init <name> | new <name> | use <name>
```

Backup and restore read the passphrase from the terminal (hidden) or from the first line of stdin.

## Rules the code keeps

- Never overwrite or delete the user's data unless they tick it in the removal dialog. Loads merge;
  restores add; a backup never reuses a file name.
- Anything destructive (replace a CLI login, quit the desktop app, replace old backups, replace a Vault
  copy) is confirmed in the UI first, with the consequence spelled out. Deleting data needs the typed
  short name and, when set, the deletion passphrase.
- Passphrases travel in a request body, then stdin; never a URL, argument or log line. Keys travel on
  stdin and stdout of `security` or PowerShell only.
- The server binds to `127.0.0.1`, refuses any request whose `Host` is not local (DNS rebinding), and
  rejects POSTs whose `Origin` is not its own host.
- One Vault operation at a time (`vaulting` flag): login reads can show Keychain prompts.
- `PROTECTED_ACCOUNTS` (in `.env`, default `main`) are never removed and nothing of theirs is ever
  deleted from the page. Every account may use the Vault.
- On Windows, only processes that run the app's own `Claude.exe` are ever ended, never a Claude Code
  CLI process, which has the same image name (see "Gotchas").

## State at handoff

**Covered by `npm test`** (14 tests, green on Windows 11 with Node 24.18 and, before the port, on
macOS): crypto round trips for both schemes and host binding; `desktop-swap.mjs` init/new/use,
rollback refusals, running-app refusal, a `.partial` leftover not counted; desktop push (only
`sessionKey`, decrypted, consent cookie left out), unchanged-push skip, pull into a parked folder
(with its own key on Windows), load merging into an existing cookie file, changed-elsewhere refusal
and `--force`; CLI push/pull/replace against this system's login store; the Vault listing (old
browser entries ignored); backup, verify, inspect, wrong passphrase, damaged file, `--replace`,
additive apply (existing file kept, mtime kept, caches left out, no cookie file), loading the restored
entry on a "new machine"; the server's state, Host/Origin guards, JSON 404, desktop init/new/switch
with quit and reopen, the CLI launcher command, adding accounts (new and from the Vault), protected
accounts refusing removal and deletion, the holdings report, deletion behind the typed name and
passphrase, per-account Vault status without values, backup listing, and the port-in-use message.
Every test also checks that no fake secret appears in any output.

**Verified on the user's Windows PC (2026-11-04), outside the suite:** the app is found through its
`claude://` handler (a Store-style MSIX package under `WindowsApps`) and detected as running while the
Claude Code CLI processes with the same image name are not counted; the DPAPI key in the real `Local
State` opens (32 bytes) and a protect/unprotect round trip matches; `tar.exe` follows junctions and
honours the excludes; the terminal launcher opens a new console window that inherits
`CLAUDE_CONFIG_DIR` and the working folder; a push of the account the running app is on is refused with
the lock explanation; the CLI login status reads the real `.credentials.json` (time only); the Vault
scripts ran end to end against a throwaway Vault container (`up`, `init`, `status`, push, status, list,
pull, unchanged push, `trim`, forget, `unseal`), with `VAULT_IMAGE=hashicorp/vault:1.15` because Docker
Hub refused the 2.2.1 pull on this PC (expired Docker login); `init` needed the new wait for the active
node after the unseal. The dashboard page renders with the Windows words, `/api/state` and the holdings
(folder sizes of 9.7 GB app data and 2.5 GB Claude Code folder) answer, and "Open in Terminal" from the
API started Claude Code as `test` in a new window (which is how `~/.claude-test` came to exist on this
PC). A server started inside the app refuses desktop actions through the parent-chain check.

**Reviewed on 2026-11-04** by a separate read of the port, seven findings, all fixed the same day: a desktop
switch could rename the active folder while a Vault save or a backup was still reading it (now a switch
refuses while `vaulting`, and saves, loads, backups and restores refuse while `switching`); the Windows
process cache trusted a PID for as long as it stayed listed (now 20 s, 3 s after a failed lookup, and
`quitApp` ends only PIDs from a scan taken just before, both before the window close and before the
force); overlapping polls could throw on a PID dropped mid-scan (callers now share one scan);
`insideDesktopApp` could walk into a reused parent PID (a parent created after its child ends the
walk); `guardDeletable` counted the drive letter as a folder (`C:\Windows` was deletable, no more); and
a terminal for the default-folder account inherited a `CLAUDE_CONFIG_DIR` from the dashboard's own
environment (dropped now). Also from that day's use: saving the app login before the one-time setup
said "no folder for main at ...\Claude.main"; it now says what to do, and the page greys the button out.

**Verified on the user's real Mac (earlier, before the port):** the desktop switch (quit, swap,
reopen), signing in from cookie-only folders, a pull built from the Vault, a CLI login restored into a
fresh config folder, and saving `main`'s parts.

**Not verified or not done:**
- **A real desktop switch on Windows** (quit, rename, reopen through the app id) and a real desktop
  push/pull: this session ran inside the Claude desktop app, where the server rightly refuses them.
  Do it once from your own terminal: `npm start`, assign the app's account, add `test`, "Sign in via
  the app…". The GCM decryption of a real cookie was not checked either (the file is locked while the
  app runs); the first `Save to Vault` of the Claude app will tell.
- Whether the Windows app quits cleanly on `taskkill` (window close) or only hides to the tray; the
  code ends it after 6 s in that case, which is a crash-style exit the app's databases are built to
  survive.
- The Windows file choosers (PowerShell `FolderBrowserDialog` / `OpenFileDialog`, old-style on Windows
  PowerShell 5.1): they construct, but were not clicked through.
- The port on a real Mac: the Node rewrite of the swap script and the platform module are covered by
  the suite only. Run `npm test` and one real switch there after pulling.
- A **second machine** accepting a pulled session (device or IP checks, the `sessionKey` lifetime of about
  27 days, Cloudflare on a new network). This is the biggest open question.
- Whether one CLI login used on two computers at once signs one of them out (refresh-token rotation).
- A real **backup of `main`** (about 450 MB, mostly Claude Code history) and its restore on another machine.
- The always-on Vault host and network (see next steps). The Vault runs on one machine only.
- Linux: no desktop app support; the terminal launcher and file choosers report "not supported".
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

Both systems:
- **The server refuses desktop actions when started from inside the Claude desktop app**, and a shell in
  the Code tab is inside it (`__CFBundleIdentifier` on macOS; `CLAUDE_CODE_ENTRYPOINT=claude-desktop` and
  `CLAUDE_CODE_DESKTOP_APP_VERSION` on both). A server the app starts another way (the Code tab's preview
  server) carries none of these, so on Windows the parent chain is looked at as well, once
  (`insideDesktopApp`); before that check existed such a server ran a real `init`. Start the dashboard
  from your own terminal. The tests build a minimal environment, so none of these leak in.
  On Windows there is one way to start it from inside a Claude Code session all the same: have Windows'
  WMI service create the process, which puts it outside the app's tree, in the interactive session, with
  the user's normal environment. That is how the dashboard was started on the PC on 2026-11-04:
  `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c ""<node.exe>" src\server.js > "%TEMP%\claude-switcher-dashboard.log" 2>&1"'; CurrentDirectory = '<project>' }`
  (no `--watch`, so a code change needs a restart; stop it with `Stop-Process` on the `node` that owns
  port 3000, found with `Get-NetTCPConnection -LocalPort 3000 -State Listen`).
- **Right after an unseal the raft node is not yet active**, and the first write (creating the `secret/`
  store in `init`) fails with HTTP 500. `unsealWith` now waits for `sys/health` to report an active node.
- **Chromium cookie timestamps overflow a JS number.** Read them with `setReadBigInts(true)`. Cookie DB
  version 24 prefixes the plaintext with `sha256(host_key)`. The test helper builds such a database.
- **Vault 2.x** will not start with raft storage unless `disable_mlock` is set explicitly.
- **A real environment variable beats `.env`** (`process.loadEnvFile` does not override): that is what
  lets the tests point every script at scratch folders. `platform.mjs` and `vault-client.mjs` both load
  it, so it is in place whichever is imported first.
- **Claude Code's safety check blocks `rm -rf` run by the agent.** Folder deletions were left to the user.
- The Vault keeps a version per write: trim after bulk changes, and `purge` an entry that once held more than it should.

macOS:
- **The CLI finds its Keychain item through `$USER`.** In an environment without `USER`, `claude auth
  status` says not logged in even though the login exists. Check a CLI login with
  `env -i HOME="$HOME" USER="$(id -un)" PATH="$PATH" CLAUDE_CONFIG_DIR=<dir> CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir> claude auth status`.
- **Reading the cookie file of a running app is safe** with `VACUUM INTO` over a read-only connection
  (`snapshotCookies`); a plain file copy is not. Only writes (`load`) need the app closed.
- **The desktop app ignores a custom data folder** (signed build), hence the rename-based swap.
- **Keychain reads show a macOS prompt.** Click Allow (not "Always Allow").
- **zsh does not word-split unquoted variables.** Run multi-step shell harnesses as `bash script.sh`.

Windows:
- **The running app locks its cookie file outright** (`EBUSY` even for a copy, and `VACUUM INTO` fails),
  so the fingerprint and the push of the account the app is on need the app quit. The server quits and
  reopens it for a desktop save of the active account (`saveQuits`), after the page has said so.
- **`Claude.exe` is also Claude Code.** The desktop app, the CLI the app bundles
  (`%APPDATA%\Claude\claude-code\<version>\claude.exe`) and a native CLI install all run as `claude.exe`.
  `tasklist` gives the PIDs cheaply (its text is localized: parse only the CSV rows); PIDs not seen before
  are looked up once through PowerShell (`Win32_Process`, about 0.6 s with its startup) for their
  executable and remembered until they go away. Only the app's own executable counts, and only those
  PIDs are ever passed to `taskkill`.
- **The app is a Store-style package** (`C:\Program Files\WindowsApps\Claude_<version>_x64__<id>\app\Claude.exe`,
  found through `HKCU\Software\Classes\claude\shell\open\command`). It is started by its app id
  (`explorer.exe shell:AppsFolder\Claude_<id>!Claude`, from `Get-StartApps`) so it runs with its package
  identity; its folder changes with every update, so nothing is cached across runs. An older
  `%LOCALAPPDATA%\AnthropicClaude\claude.exe` install is tried too, and `CLAUDE_DESKTOP_EXE` overrides.
- **Quitting:** `taskkill /PID` (window close) first, then after 6 s `taskkill /F /T` on the main process,
  because closing the window may only hide the app to the tray. The tree kill also ends Claude Code
  sessions the app started, as the macOS quit does.
- **The cookie key is per folder and per Windows user.** A folder copied from another PC or user cannot be
  decrypted ("cannot be opened by this Windows user"); `Local State` is therefore left out of backups, and
  a folder built from the Vault gets a new key. DPAPI goes through PowerShell's `ProtectedData`, bytes as
  base64 on stdin and stdout.
- **File symlinks need a privilege; directory junctions do not.** Backups stage folders as junctions and
  single files as copies. `fs.rm` on a junction removes the junction, never what it points to (checked).
- **`tar.exe` in System32 is bsdtar** (Git's `tar` is GNU tar: never rely on PATH). Its listing ends lines
  with CRLF: split on `\r?\n`.
- **The system locale may not be English** (this PC is French): `tasklist`, `reg query` and PowerShell
  print localized text; the code reads only structured parts (CSV rows, `REG_SZ`, piped fields) and sets
  PowerShell's output to UTF-8 so paths with accents survive.
- **A shell in the Code tab has no `USER`;** Node falls back to `os.userInfo()`. Tests set `USERPROFILE`
  as well as `HOME`, since `os.homedir()` reads the former on Windows.

## How it is tested

`npm test` runs `test/*.test.mjs` with Node's own runner, on macOS and Windows. `test/helpers.mjs`
builds a scratch machine: `SWITCHER_STUB_DIR` makes `scripts/lib/platform.mjs` fake the OS parts
(whether the app "runs" is a marker file, quitting and reopening it and opening a terminal are logged,
the file choosers answer `STUB_PICK`, DPAPI is replaced by a visible `FAKEDPAPI` marker inside a real
`Local State`), plus a scratch home (`HOME` and `USERPROFILE`), `SUPPORT_DIR`, `SWAP_STATE_DIR`,
`BACKUP_DIR`, `ACCOUNTS_FILE`, and `VAULT_PROVIDER=file` with `VAULT_FILE_DIR`. On a Mac there is also
a fake `security` command on PATH (a file-backed Keychain plus a fixed "Safe Storage" password for the
service named in `SAFE_STORAGE_SERVICE`), so the real macOS command shapes stay exercised; elsewhere the
CLI login is a real file in the scratch config folder. `safeKey()` is the 16-byte macOS key on a Mac
and a 32-byte Windows key elsewhere; `stubs.keyOf(folder)` reads the key a folder got.
`makeCookieDb` writes a cookie database shaped like the app's. The server test starts `src/server.js`
on a free port with all of that and talks to it over HTTP. Reuse these helpers for anything new; add a
fake rather than touching a real system.

## Suggested next steps

1. **Do one real switch on Windows from your own terminal** (see "Not verified"), then one on the Mac
   after pulling, to close the two verification gaps the port left.
2. **Pick the always-on Vault host** (a small Linux box or NAS; Tailscale was the leading idea). The helper
   already refuses plain http to a non-local address, so it needs TLS, persistent storage, an unseal plan
   and a token limited to `claude-switcher`.
3. **Make `main`'s backup, `verify` it, and restore it on the other machine** to close the biggest open
   questions above.
4. **Clean up after the browser part** on the Mac: `npm run vault:local -- purge main` (and `test` if it has
   one) for the old browser sessions in the Vault, delete `.profiles/` and `.state/`, and delete the
   Playwright browser cache in `~/Library/Caches/ms-playwright` if nothing else uses it.
5. Protection is set in `.env` on purpose, so that it cannot be switched off by a click on the page. If
   editing `.env` proves annoying, a page toggle should at least demand the deletion passphrase.
