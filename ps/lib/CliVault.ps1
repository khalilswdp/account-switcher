# The Claude Code login to and from the Vault, in the envelope scripts/cli-vault.mjs writes and
# reads (version 1, format "cli-keychain", the login JSON as "credential"), so a login saved by
# either implementation, on either system, loads with the other. On Windows the login is the
# file .credentials.json inside the config folder. The login is never printed.
Set-StrictMode -Version 2

function Read-CliRemote([string]$Name) {
    $raw = Read-VaultEntry ('cli/' + $Name)
    if ($null -eq $raw) { return $null }
    try { $env = $raw | ConvertFrom-Json } catch { Fail 'the vault entry is not valid JSON' }
    if ((Get-Prop $env 'version') -ne 1 -or (Get-Prop $env 'format') -ne 'cli-keychain') { Fail 'the vault entry has an unknown format' }
    return $env
}

function Get-CliVaultStatus([string]$Name) {
    Assert-AccountName $Name 'status'
    $remote = Read-CliRemote $Name
    $local = Get-CliLoginInfo (Get-CliConfigDir $Name)
    $vault = $null
    if ($remote) { $vault = [ordered]@{ pushedAt = (Get-Prop $remote 'pushedAt'); host = (Get-Prop $remote 'host') } }
    if ($local) { $localOut = [ordered]@{ present = $true; modified = $local.modified } } else { $localOut = [ordered]@{ present = $false } }
    return [ordered]@{ local = $localOut; vault = $vault }
}

function Push-CliLogin([string]$Name, [switch]$Force) {
    Assert-AccountName $Name 'save-cli'
    $configDir = Get-CliConfigDir $Name
    $info = Get-CliLoginInfo $configDir
    if (-not $info) { Fail ('no CLI login found for "' + $Name + '" (' + (Get-CliLoginDescription $configDir) + '). Run /login with CLAUDE_CONFIG_DIR=' + $configDir + ' first.') }
    $remote = Read-CliRemote $Name
    $rev = Read-Rev 'cli' $Name
    if ($remote -and (Get-Prop $remote 'fp') -eq $info.modified -and -not $Force) {
        Write-Rev 'cli' $Name (Get-Prop $remote 'pushedAt')
        return ('Already up to date: the "' + $Name + '" CLI login has not changed since ' + (Get-Prop $remote 'pushedAt') + '.')
    }
    if ($remote -and (Get-Prop $remote 'pushedAt') -ne $rev -and -not $Force) {
        Fail ('the vault entry was updated (' + (Get-Prop $remote 'pushedAt') + ' from ' + (Get-Prop $remote 'host') + ') since your last pull or push. Pull first, or use -Force.')
    }
    $credential = Read-CliLogin $configDir
    try { $parsed = $credential | ConvertFrom-Json; if ($null -eq $parsed) { throw 'x' } } catch { Fail 'the stored login is not the JSON the CLI writes' }
    $pushedAt = Get-IsoNow
    $envelope = [ordered]@{ version = 1; format = 'cli-keychain'; pushedAt = $pushedAt; host = (Get-HostName); fp = $info.modified; credential = $credential } | ConvertTo-Json -Compress -Depth 5
    Write-VaultEntry ('cli/' + $Name) $envelope
    Write-Rev 'cli' $Name $pushedAt
    return ('Pushed the "' + $Name + '" CLI login (' + $credential.Length + ' bytes) at ' + $pushedAt + '.')
}

function Pull-CliLogin([string]$Name, [string]$ConfigDir = '', [switch]$Replace) {
    Assert-AccountName $Name 'load-cli'
    if ($ConfigDir) { $dir = Get-FullPath (Expand-Home $ConfigDir) } else { $dir = Get-CliConfigDir $Name }
    $existing = Get-CliLoginInfo $dir
    if ($existing -and -not $Replace) {
        Fail ('a CLI login already exists for ' + $dir + ' (' + (Get-CliLoginDescription $dir) + '), refusing to overwrite. Pull into another folder with -Config <path>, or add -Replace to replace it.')
    }
    $remote = Read-CliRemote $Name
    if (-not $remote) { Fail ('nothing in the vault for "' + $Name + '" yet') }
    Write-CliLogin $dir ([string](Get-Prop $remote 'credential')) -Replace:$Replace
    if (-not (Get-CliLoginInfo $dir)) { Fail 'the login was not written' }
    Write-Rev 'cli' $Name (Get-Prop $remote 'pushedAt')
    if ($existing) { $verb = 'Replaced the login for'; $where = 'in' } else { $verb = 'Pulled'; $where = 'into' }
    return ($verb + ' "' + $Name + '" ' + $where + ' the ' + (Get-CliLoginDescription $dir) + ".`nUse it with: `$env:CLAUDE_CONFIG_DIR='" + $dir + "'; `$env:CLAUDE_SECURESTORAGE_CONFIG_DIR='" + $dir + "'; claude")
}

function Forget-CliLogin([string]$Name) {
    Assert-AccountName $Name 'forget-cli'
    $had = ($null -ne (Read-VaultEntry ('cli/' + $Name)))
    Remove-VaultEntry ('cli/' + $Name)
    $rev = Get-RevFile 'cli' $Name
    if (Test-Path -LiteralPath $rev) { Remove-Item -LiteralPath $rev -Force }
    if ($had) { return ('Deleted the "' + $Name + '" CLI login from the vault (every version).') }
    return ('Nothing in the vault for "' + $Name + '".')
}

# Deletes this machine's CLI login for the account (the file). The vault is not touched.
function Remove-CliLoginLocal([string]$Name) {
    Assert-AccountName $Name 'forget-cli-local'
    $dir = Get-CliConfigDir $Name
    if (-not (Get-CliLoginInfo $dir)) { return ('No CLI login on this machine for "' + $Name + '".') }
    Remove-CliLogin $dir
    if (Get-CliLoginInfo $dir) { Fail 'the login is still there' }
    return ('Deleted the "' + $Name + '" CLI login from this machine (' + (Get-CliLoginDescription $dir) + ').')
}
