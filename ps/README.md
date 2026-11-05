# The PowerShell command

A Windows-only, command-line version of the switcher that needs nothing installed: Windows
PowerShell 5.1 (part of Windows), Docker Desktop for the Vault, and the `claude` CLI. No Node, no
npm. It uses the same folders, the same state file, the same Vault entries and the same backup
files as the dashboard, so the two can be used side by side on one PC, and a login saved here
loads on the Mac with the Node version, and the other way round.

## Run it

From a PowerShell window of your own, not one inside the Claude app (switching quits the app):

```powershell
powershell -ExecutionPolicy Bypass -File ps\claude-switcher.ps1 status
```

Or, once, allow local scripts and drop the prefix:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File ps\*.ps1, ps\lib\*.ps1
.\ps\claude-switcher.ps1 status
```

The first run compiles a small helper (about a second); it is cached under
`%LOCALAPPDATA%\claude-switcher`. Settings come from the same `.env` as the dashboard.

## Commands

| Command | What it does |
|---|---|
| `status` (`-Json` for JSON) | what the app is on, the accounts and their logins, what the Vault holds, and the account the app's data belongs to when that can be told |
| `accounts`, `add <name> [label]` | the accounts; `add` writes to `.accounts.local.json` |
| `init [<name>]` | record the app's current data folder as `<name>` (once); without a name the account is worked out from the app's data and asked |
| `new <name>` | park the current data; the app opens signed out, to sign in as `<name>` |
| `use <name>` | switch the app to `<name>` (quits and reopens it if running) |
| `save-app <name> [-Force]` | the app login to the Vault (quits and reopens the app when it is on that account: Windows locks the cookie file) |
| `load-app <name>` | the app login from the Vault, merged into the account's data, and the app switched to it |
| `pull-app <name> [-As <new>]` | rebuild the saved account as a parked one |
| `save-cli <name> [-Force]`, `load-cli <name> [-Replace] [-Config <folder>]` | the Claude Code login to and from the Vault |
| `forget-app <name>`, `forget-cli <name>` | delete the Vault entry, every version |
| `forget-cli-local <name>` | delete this PC's Claude Code login for the account |
| `open <name>` | a PowerShell window running Claude Code as `<name>` |
| `vault-list` | what the Vault holds, as JSON (names and times only) |
| `backup <name> -To <folder> [-Replace]`, `verify <file>`, `inspect <file>` | the encrypted backup file |
| `restore <file> -Out <folder> [-ToVault] [-Force]`, `apply <file> -Parts vault,config,desktop [-ReplaceVault]` | unpack it, or put chosen parts back where they belong (adds only, never overwrites) |
| `vault up|init|unseal|token|policy|status|backup <file>|restore <file>|purge <entry>|trim|down` | the local Docker Vault |
| `selftest` | checks the native pieces on this PC against known answers |

`-Yes` answers every question with yes. Passphrases are typed hidden, or read from the first line
of a piped stdin. Nothing secret is ever printed.

## What it uses from Windows

- `winsqlite3.dll`, the SQLite Windows ships, for the app's cookie database
- CNG (`bcrypt.dll`) for AES-256-GCM: the app's cookie encryption, and the backup file's
- DPAPI for the app's cookie key, which the app keeps in each data folder's `Local State`
- `tar.exe` in System32 for the backup archive
- `Get-CimInstance`, `taskkill`, `Get-AppxPackage` and `Get-StartApps` to find, quit and reopen the app

scrypt, the backup key derivation, is implemented in the helper (RFC 7914), since .NET Framework
has none; `ps\selftest.ps1` checks it against the RFC's test vectors.

## Differences from the dashboard

- No page and no activity log: each command prints what it did, and the ones that quit the app,
  replace a login or delete something ask `[y/N]` first.
- The removal dialog has no equivalent: `forget-app` and `forget-cli` delete Vault entries; folders
  and backup files you delete yourself.
- `DESKTOP_ITEMS` other than `Cookies` (config.json, folders) are not supported.
- Windows only. The Mac keeps the Node version; the Vault is what they share.

## Testing

`npm test` runs `test/powershell.test.mjs` on Windows (Node is the test harness only): the
PowerShell command and the Node scripts switch the same scratch folders, exchange app and Claude
Code logins through a file Vault in both directions, and open and restore each other's backups.
`ps\selftest.ps1` checks the native pieces without Node.
