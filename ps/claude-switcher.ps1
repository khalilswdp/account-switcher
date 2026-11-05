# Claude account switcher, the Windows-only command-line version: no Node, no npm, nothing to
# install. Windows PowerShell 5.1, Docker (for the Vault) and the claude CLI are all it needs.
# Same folders, same state file, same Vault entries and same backup files as the dashboard, so
# both can be used, and a login saved here loads on the Mac and the other way round.
#
#   claude-switcher.ps1 status                         what the app is on, the accounts, the Vault
#   claude-switcher.ps1 accounts | add <name> [label]
#   claude-switcher.ps1 init [<name>]                  record the app's current data as <name> (once;
#                                                      without a name the account is worked out and asked)
#   claude-switcher.ps1 new <name>                     park the current data; the app opens signed out
#   claude-switcher.ps1 use <name>                     switch the app (quits and reopens it if running)
#   claude-switcher.ps1 save-app <name> [-Force]       app login -> Vault (quits/reopens the app if it is on it)
#   claude-switcher.ps1 load-app <name>                Vault -> app login (merged), switches to it
#   claude-switcher.ps1 pull-app <name> [-As <new>]    rebuild it as a parked account
#   claude-switcher.ps1 save-cli <name> [-Force]       Claude Code login -> Vault
#   claude-switcher.ps1 load-cli <name> [-Replace] [-Config <folder>]
#   claude-switcher.ps1 forget-app|forget-cli <name>   delete the Vault entry (every version)
#   claude-switcher.ps1 forget-cli-local <name>        delete this PC's Claude Code login for the account
#   claude-switcher.ps1 open <name>                    a PowerShell window running Claude Code as <name>
#   claude-switcher.ps1 vault-list                     what the Vault holds (names and times, as JSON)
#   claude-switcher.ps1 backup <name> -To <folder> [-Replace]
#   claude-switcher.ps1 verify <file> | inspect <file>
#   claude-switcher.ps1 restore <file> -Out <folder> [-ToVault] [-Force]
#   claude-switcher.ps1 apply <file> -Parts vault,config,desktop [-ReplaceVault]
#   claude-switcher.ps1 vault up|init|unseal|token|policy|status|backup <file>|restore <file>|purge <entry>|trim|down
#   claude-switcher.ps1 selftest
#
#   -Yes answers every question with yes. -Json makes status answer in JSON. Passphrases are typed
#   hidden, or read from the first line of a piped stdin. Nothing secret is ever printed.
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command = '',
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @(),
    [switch]$Yes,
    [switch]$Force,
    [switch]$Replace,
    [switch]$ToVault,
    [switch]$ReplaceVault,
    [switch]$Json,
    [string]$As = '',
    [string]$Config = '',
    [string]$To = '',
    [string]$Out = '',
    [string]$Parts = ''
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
# UTF-8 both ways, without a byte-order mark: a piped passphrase with accents must give Node's bytes,
# and a mark would reach child processes' stdin ahead of the data (see Start-Tar).
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$lib = Join-Path $PSScriptRoot 'lib'
. (Join-Path $lib 'Common.ps1')
. (Join-Path $lib 'Native.ps1')
. (Join-Path $lib 'Platform.ps1')
. (Join-Path $lib 'Desktop.ps1')
. (Join-Path $lib 'Vault.ps1')
. (Join-Path $lib 'DesktopVault.ps1')
. (Join-Path $lib 'CliVault.ps1')
. (Join-Path $lib 'Backup.ps1')
. (Join-Path $lib 'VaultLocal.ps1')

$script:AssumeYes = [bool]$Yes
Import-DotEnv
Import-Native

function Get-Arg([int]$Index) { if ($Rest.Count -gt $Index) { return $Rest[$Index] } else { return '' } }

# Switching and loading quit the app, so this must not run inside it.
function Assert-NotInsideApp {
    if (Test-InsideApp) { Fail 'this is running inside the Claude desktop app, which this would quit. Run it from a PowerShell window of your own.' }
}

function Confirm-Or-Stop([string]$Question) {
    if (-not (Confirm-Action $Question)) { Fail 'not confirmed (add -Yes to skip the question)' }
}

# The accounts the app's data could belong to: the ones whose Claude Code login is the same
# Anthropic account (ids compared, never shown; the email masked).
function Get-DetectedAccount {
    $uuid = Get-AppAccountUuid
    if (-not $uuid) { return $null }
    $matches = @()
    foreach ($a in @(Get-Accounts)) {
        $dir = Get-CliConfigDir $a.id
        if ($dir -eq (Join-Path (Get-HomeDir) '.claude')) { $file = Join-Path (Get-HomeDir) '.claude.json' } else { $file = Join-Path $dir '.claude.json' }
        if (-not (Test-Path -LiteralPath $file)) { continue }
        try { $acct = Get-Prop ([System.IO.File]::ReadAllText($file) | ConvertFrom-Json) 'oauthAccount' } catch { continue }
        if ((Get-Prop $acct 'accountUuid') -eq $uuid) {
            $email = [string](Get-Prop $acct 'emailAddress')
            if ($email -and $email.Contains('@')) { $email = $email.Substring(0, 2) + '***' + $email.Substring($email.IndexOf('@')) } else { $email = $null }
            $matches += [pscustomobject]@{ account = $a.id; label = $a.label; email = $email }
        }
    }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Show-Status {
    $state = Get-DesktopState
    $accounts = @(Get-Accounts)
    $inside = Test-InsideApp
    $vault = $null; $vaultError = $null
    try {
        $entries = @{}
        foreach ($pair in @(@('desktop/', 'desktop'), @('cli/', 'cli'))) {
            foreach ($k in @(Get-VaultEntries $pair[0])) {
                if ($k.EndsWith('/') -or -not (Test-AccountName $k)) { continue }
                if (-not $entries.ContainsKey($k)) { $entries[$k] = @{ desktop = $false; cli = $false } }
                $entries[$k][$pair[1]] = $true
            }
        }
        $vault = $entries
    } catch { $vaultError = ($_.Exception.Message -replace '^Error:\s*', '') }
    if ($Json) {
        $o = [ordered]@{ platform = 'win32'; insideApp = $inside; desktop = [ordered]@{ active = $state.active; running = $state.running; parked = @($state.parked) }; accounts = @($accounts | ForEach-Object { [ordered]@{ id = $_.id; label = $_.label; cliConfigDir = (Get-CliConfigDir $_.id); cliLogin = ($null -ne (Get-CliLoginInfo (Get-CliConfigDir $_.id))); protected = (Test-ProtectedAccount $_.id) } }); vault = $vault; vaultError = $vaultError; detected = (Get-DetectedAccount) }
        return ($o | ConvertTo-Json -Depth 6)
    }
    $lines = @()
    if ($state.active) { $where = 'on "' + $state.active + '"' } else { $where = 'not assigned to an account yet (run: claude-switcher.ps1 init)' }
    if ($state.running) { $run = 'running' } else { $run = 'not running' }
    $lines += ('Claude app   : ' + $where + ', ' + $run)
    if ($state.parked.Count) { $lines += ('Parked       : ' + ($state.parked -join ', ')) } else { $lines += 'Parked       : (none)' }
    $lines += ('App data     : ' + (Get-SupportDir))
    if ($inside) { $lines += 'Note         : this window is inside the Claude app; switching and loading need a window of your own' }
    foreach ($a in $accounts) {
        $dir = Get-CliConfigDir $a.id
        if (Get-CliLoginInfo $dir) { $login = 'login present' } else { $login = 'no login' }
        $v = ''
        if ($vault -and $vault.ContainsKey($a.id)) {
            $v = ' | Vault: ' + (@(@('app', $vault[$a.id].desktop), @('cli', $vault[$a.id].cli)) | Where-Object { $_[1] } | ForEach-Object { $_[0] }) -join ', '
            if ($v -eq ' | Vault: ') { $v = ' | Vault: nothing' }
        } elseif ($vault) { $v = ' | Vault: nothing' }
        $mark = ''
        if (Test-ProtectedAccount $a.id) { $mark = ', protected' }
        $lines += ('Account      : ' + $a.id + ' (' + $a.label + $mark + ') Claude Code folder ' + $dir + ': ' + $login + $v)
    }
    if ($vaultError) { $lines += ('Vault        : ' + $vaultError) } else {
        $onlyThere = @($vault.Keys | Where-Object { $k = $_; @($accounts | Where-Object { $_.id -eq $k }).Count -eq 0 })
        if ($onlyThere.Count) { $lines += ('Vault only   : ' + ($onlyThere -join ', ') + ' (add with: claude-switcher.ps1 add <name>, then load-app / load-cli)') }
    }
    $d = Get-DetectedAccount
    if (-not $state.active -and $d) { $lines += ('Detected     : the app''s data matches "' + $d.label + '" (Claude Code is signed in there as ' + $d.email + '); record it with: claude-switcher.ps1 init ' + $d.account) }
    return ($lines -join "`n")
}

function Invoke-VaultList {
    $accounts = [ordered]@{}
    $unreadable = @(); $ignored = @()
    foreach ($pair in @(@('desktop/', 'desktop'), @('cli/', 'cli'))) {
        foreach ($k in @(Get-VaultEntries $pair[0])) {
            if ($k.EndsWith('/') -or -not (Test-AccountName $k) -or $k.StartsWith('_')) { continue }
            $raw = Read-VaultEntry ($pair[0] + $k)
            $info = $null
            if ($raw) { try { $e = $raw | ConvertFrom-Json; if ((Get-Prop $e 'pushedAt') -is [string]) { $info = [ordered]@{ pushedAt = (Get-Prop $e 'pushedAt'); host = (Get-Prop $e 'host') } } } catch { } }
            if (-not $info) { $unreadable += ($pair[0] + $k); continue }
            if (-not $accounts.Contains($k)) { $accounts[$k] = [ordered]@{ desktop = $null; cli = $null } }
            $accounts[$k][$pair[1]] = $info
        }
    }
    foreach ($k in @(Get-VaultEntries '')) { if (-not $k.EndsWith('/') -and -not $k.StartsWith('_')) { $ignored += $k } }
    return ([ordered]@{ accounts = $accounts; unreadable = @($unreadable | Sort-Object); ignored = @($ignored | Sort-Object) } | ConvertTo-Json -Compress -Depth 6)
}

try {
    $name = Get-Arg 0
    switch ($Command) {
        'status' { Write-Output (Show-Status) }
        'accounts' {
            foreach ($a in @(Get-Accounts)) { Write-Output ($a.id + "`t" + $a.label + "`t" + (Get-CliConfigDir $a.id)) }
        }
        'add' {
            if (-not (Test-AccountName $name)) { Fail 'usage: add <name> [label]; letters, digits, - and _ only' }
            if (Get-Account $name) { Fail ('"' + $name + '" already exists') }
            $label = (@($Rest | Select-Object -Skip 1) -join ' ').Trim()
            if (-not $label) { $label = 'Account: ' + $name }
            $file = Get-FullPath (Get-Setting 'LOCAL_ACCOUNTS_FILE' (Join-Path $script:Root '.accounts.local.json'))
            $list = @(Read-JsonFile $file | Where-Object { $null -ne $_ }) # no file gives $null, and @($null) has one element
            $list += [ordered]@{ id = $name; label = $label }
            Write-TextFile $file ((ConvertTo-Json -InputObject @($list) -Depth 3) + "`n")
            Write-Output ('Added "' + $name + '" (' + $label + '). Its Claude Code folder is ' + (Get-CliConfigDir $name) + '. Sign in with: claude-switcher.ps1 open ' + $name + ' (Claude Code offers /login), and "new ' + $name + '" for the app.')
        }
        'init' {
            if (-not $name) {
                $d = Get-DetectedAccount
                if (-not $d) { Fail 'usage: init <name>  (the account the Claude app is signed in as right now; it could not be worked out from the app''s data)' }
                Write-Output ('The app''s data matches "' + $d.label + '": Claude Code is signed in there as ' + $d.email + '.')
                Confirm-Or-Stop ('Record the Claude app''s current data as "' + $d.account + '"? Nothing is moved.')
                $name = $d.account
            }
            Write-Output (Initialize-Desktop $name)
        }
        'new' {
            Assert-AccountName $name 'new'
            Assert-NotInsideApp
            $state = Get-DesktopState
            if (-not $state.active) { Fail 'not initialised: first run "claude-switcher.ps1 init" with the account the app is signed in as' }
            if ($state.parked -contains $name) { Fail 'this account already has app data: switch to it instead (use)' }
            if ($state.running) { Confirm-Or-Stop ('The Claude app will quit (ending whatever is open in it) and reopen signed out, so you can sign in as "' + $name + '". Its current data stays safe as "' + $state.active + '". Go on?') }
            else { Confirm-Or-Stop ('Park the app''s current data as "' + $state.active + '" and open the app signed out, to sign in as "' + $name + '"?') }
            if ($state.running) { Stop-App }
            Write-Output (New-DesktopAccount $name)
            Start-App
            Write-Output ('The Claude app is open and signed out: sign in as "' + $name + '" in it.')
        }
        'use' {
            Assert-AccountName $name 'use'
            Assert-NotInsideApp
            $state = Get-DesktopState
            if (-not $state.active) { Fail 'not initialised: first run "claude-switcher.ps1 init" with the account the app is signed in as' }
            if ($name -eq $state.active) { Write-Output ('The Claude app is already on "' + $name + '".'); break }
            if ($state.parked -notcontains $name) { Fail ('no parked desktop account named ' + $name) }
            if ($state.running) { Confirm-Or-Stop ('The Claude app will quit (ending whatever is open in it, Claude Code sessions included) and reopen on "' + $name + '". Go on?') }
            if ($state.running) { Stop-App }
            Write-Output (Use-DesktopAccount $name)
            if ($state.running) { Start-App; Write-Output 'The Claude app has been reopened.' }
        }
        'save-app' {
            Assert-AccountName $name 'save-app'
            $state = Get-DesktopState
            $quits = ($state.active -eq $name -and $state.running)
            if ($quits) {
                Assert-NotInsideApp
                Confirm-Or-Stop 'The Claude app is on this account and Windows keeps its cookie file locked while it runs: the app will quit (ending whatever is open in it) and reopen after the save. Go on?'
                Stop-App
                try { Write-Output (Push-DesktopLogin $name -Force:$Force) } finally { Start-App }
            } else {
                Write-Output (Push-DesktopLogin $name -Force:$Force)
            }
        }
        'load-app' {
            Assert-AccountName $name 'load-app'
            Assert-NotInsideApp
            $state = Get-DesktopState
            if (-not $state.active) { Fail 'not initialised: first run "claude-switcher.ps1 init" with the account the app is signed in as' }
            $lines = @('The saved login cookie is merged into this account''s app data; nothing else there is touched.')
            if ($state.running) { $lines += 'The Claude app will quit (ending whatever is open in it) and reopen on this account.' }
            Confirm-Or-Stop (($lines -join ' ') + ' Go on?')
            if ($state.running) { Stop-App }
            try {
                Write-Output (Load-DesktopLogin $name)
                if ($name -ne $state.active) { Write-Output (Use-DesktopAccount $name) }
            } finally {
                if ($state.running) { Start-App }
            }
        }
        'pull-app' { Write-Output (Pull-DesktopLogin $name -As $As) }
        'save-cli' { Write-Output (Push-CliLogin $name -Force:$Force) }
        'load-cli' {
            if ((Get-CliLoginInfo $(if ($Config) { Get-FullPath (Expand-Home $Config) } else { Get-CliConfigDir $name })) -and $Replace) {
                Confirm-Or-Stop ('This replaces the Claude Code login this PC has for "' + $name + '" with the Vault copy. Go on?')
            }
            Write-Output (Pull-CliLogin $name -ConfigDir $Config -Replace:$Replace)
        }
        'forget-app' { Confirm-Or-Stop ('Delete the "' + $name + '" app login from the Vault, every version?'); Write-Output (Forget-DesktopLogin $name) }
        'forget-cli' { Confirm-Or-Stop ('Delete the "' + $name + '" Claude Code login from the Vault, every version?'); Write-Output (Forget-CliLogin $name) }
        'forget-cli-local' { Confirm-Or-Stop ('Delete this PC''s Claude Code login for "' + $name + '"?'); Write-Output (Remove-CliLoginLocal $name) }
        'open' {
            Assert-AccountName $name 'open'
            $a = Get-Account $name
            $dir = $null
            if ($null -eq $a -or $null -ne $a.cliConfigDir) { $dir = Get-CliConfigDir $name }
            $cwd = Get-Setting 'CLI_WORKDIR' (Get-HomeDir)
            $command = Open-ClaudeTerminal $name $dir $cwd
            Write-Output ('Opened a PowerShell window running Claude Code as "' + $name + '". By hand: ' + $command)
        }
        'vault-list' { Write-Output (Invoke-VaultList) }
        'backup' { Write-Output (New-Backup $name $To -Replace:$Replace) }
        'verify' { Write-Output (Test-Backup $name) }
        'inspect' { Write-Output (Get-BackupInfo $name) }
        'restore' { Write-Output (Restore-Backup $name $Out -ToVault:$ToVault -Force:$Force) }
        'apply' { Write-Output (Restore-BackupParts $name $Parts -ReplaceVault:$ReplaceVault) }
        'vault' { Write-Output (Invoke-VaultLocal $name (Get-Arg 1) (Get-Arg 2)) }
        'selftest' { $global:LASTEXITCODE = 0; & (Join-Path $PSScriptRoot 'selftest.ps1'); if ($LASTEXITCODE) { exit $LASTEXITCODE } }
        default {
            $usage = Get-Content -LiteralPath $PSCommandPath | Select-Object -Skip 5 -First 25 | ForEach-Object { $_ -replace '^#\s?', '' }
            Write-Output ($usage -join "`n")
            if ($Command) { exit 1 }
        }
    }
} catch {
    $message = $_.Exception.Message
    if ($message -notmatch '^Error:') { $message = 'Error: ' + $message }
    [Console]::Error.WriteLine($message)
    if (Get-Setting 'SWITCHER_DEBUG') { [Console]::Error.WriteLine($_.ScriptStackTrace) } # where it happened, for troubleshooting
    exit 1
}
