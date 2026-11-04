# Claude account switcher

A local dashboard that moves the Claude desktop app and Claude Code between your accounts without
signing in again, on macOS and Windows. Each login can be kept in a private HashiCorp Vault (Docker, on
this machine) so another Mac or PC can load it, and one encrypted file can back an account up.

[HANDOFF.md](HANDOFF.md) has the full picture: how it works, what is verified, and the gotchas.

## Needs

Node 24 or newer, Docker Desktop, the `claude` CLI and the Claude desktop app. Windows needs nothing
else (`tar.exe` and PowerShell ship with it).

## Run it

Use a terminal of your own (Windows Terminal, Terminal.app), not a shell inside the Claude desktop
app: the dashboard quits that app when it switches accounts, so it must not run inside it.

```bash
npm install
cp .env.example .env            # Windows: copy .env.example .env
npm run vault:local -- up       # the Vault container
npm run vault:local -- init     # first time only: makes the keys and the token (see below)
npm start                       # the dashboard, on http://127.0.0.1:3000
```

After a reboot or a container restart the Vault is sealed: `npm run vault:local -- unseal`.

The first time, the page needs to know which account the Claude app is signed in as. It works that
out by itself when it can (the app's data names its account, and one of your Claude Code logins is
the same account); otherwise it asks, at the top of the page. To start that over, delete the file
`~/.claude-desktop-accounts/active`.

## The Vault token

`init` writes two files into `~/.claude-switcher-vault` (`C:\Users\<you>\.claude-switcher-vault` on
Windows):

| File | What | Keep it |
|---|---|---|
| `keys.json` | the unseal key and the root token | in a password manager: without the unseal key the data cannot be recovered |
| `token` | the limited token the dashboard and the scripts use (read, write, list and delete under `claude-switcher` only; valid for one year) | on this machine |

Show the token the dashboard uses:

```bash
cat ~/.claude-switcher-vault/token
```

```powershell
Get-Content ~\.claude-switcher-vault\token
```

Issue a fresh one (the file is replaced; the old token works until it expires):

```bash
npm run vault:local -- token
```

Check that it is valid, and whether the Vault is sealed:

```bash
npm run vault:local -- status
```

The Vault's own UI is at http://127.0.0.1:8200/ui. Signed in with the helper token, open the `secret/`
engine, then the `claude-switcher/` folder, then `cli/` or `desktop/`, then the account: the saved login
is its `envelope` field. Opening `claude-switcher` itself (typed without the trailing slash) says "You do
not have permission to read this secret", because it is a folder, not a secret. The root token from
`keys.json` sees everything. A Vault set up before 2026-11-04 needs `npm run vault:local -- policy` once
for the folder to show at the root. To use another Vault instead, set `VAULT_ADDR` and `VAULT_TOKEN`
in `.env`.

## Everyday commands

```bash
npm test                                            # the test suite
npm run vault:list                                  # what is in the Vault (names and times only)
npm run vault:local -- status|unseal|token|policy|trim|purge <entry>|backup <file>|restore <file>|down
npm run desktop-swap -- status|list|init <name>|new <name>|use <name>
npm run desktop-vault -- push|pull|load|status|forget <name>
npm run cli-vault -- push|pull|status|forget|forget-keychain <name>
npm run backup -- backup <name> --to <folder>
npm run backup -- verify <file>
npm run backup -- restore <file> --out <folder> [--to-vault]
```

## Where things are

| | macOS | Windows |
|---|---|---|
| Claude app data: active, parked | `~/Library/Application Support/Claude`, `Claude.<name>` | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude`, `Claude.<name>` for the Store-style app (inside the app it looks like `%APPDATA%\Claude`); `%APPDATA%\Claude` for the older installer |
| Claude Code folder | `~/.claude` for `main`, `~/.claude-<name>` for the others | the same, under `C:\Users\<you>` |
| Claude Code login | a Keychain item | `.credentials.json` inside that folder |
| Vault keys and token | `~/.claude-switcher-vault/` | `C:\Users\<you>\.claude-switcher-vault\` |
| Which account the app is on | `~/.claude-desktop-accounts/active` | `C:\Users\<you>\.claude-desktop-accounts\active` |
