# Vault access, mirroring scripts/lib/vault-client.mjs: one opaque string per id (the id may hold
# "/"), in HashiCorp Vault (KV v2 over HTTP, each entry one field "envelope") or, for tests, in
# plain files. The same settings as the Node version: VAULT_PROVIDER, VAULT_ADDR, VAULT_TOKEN,
# VAULT_MOUNT, VAULT_PATH_PREFIX, VAULT_ALLOW_INSECURE, VAULT_FILE_DIR, VAULT_LOCAL_DIR.
Set-StrictMode -Version 2

function Get-VaultLocalDir { return (Get-Setting 'VAULT_LOCAL_DIR' (Join-Path (Get-HomeDir) '.claude-switcher-vault')) }

function Get-LocalVaultToken {
    $f = Join-Path (Get-VaultLocalDir) 'token'
    if (-not (Test-Path -LiteralPath $f)) { return '' }
    return ([System.IO.File]::ReadAllText($f)).Trim()
}

function Get-VaultProvider {
    $p = Get-Setting 'VAULT_PROVIDER'
    if ($p) { return $p }
    if (Get-LocalVaultToken) { return 'hashicorp' }
    return $null
}

function Get-VaultAddr {
    $a = Get-Setting 'VAULT_ADDR'
    if (-not $a -and (Get-VaultProvider) -eq 'hashicorp' -and (Get-LocalVaultToken)) { $a = 'http://127.0.0.1:8200' }
    if (-not $a) { return '' }
    return ($a -replace '/+$', '')
}

function Get-VaultMount { return (Get-Setting 'VAULT_MOUNT' 'secret') }
function Get-VaultPrefix { return ((Get-Setting 'VAULT_PATH_PREFIX' 'claude-switcher') -replace '^/+|/+$', '') }

function Get-VaultFileDir {
    $d = Get-Setting 'VAULT_FILE_DIR'
    if (-not $d) { Fail 'VAULT_FILE_DIR is required for the file provider' }
    return $d
}

# One request to the Vault. The token goes in a header, never on a command line. Returns the
# status and the parsed body (null when there is none).
function Invoke-VaultApi([string]$Method, [string]$Route, [string]$Body = '') {
    $token = Get-Setting 'VAULT_TOKEN' (Get-LocalVaultToken)
    $addr = Get-VaultAddr
    if (-not $addr -or -not $token) { Fail 'set VAULT_ADDR and VAULT_TOKEN, or set up the local Vault: claude-switcher.ps1 vault init' }
    $uri = [Uri]$addr
    $local = @('localhost', '127.0.0.1', '[::1]', '::1') -contains $uri.Host
    if ($uri.Scheme -ne 'https' -and -not $local -and -not (Get-Setting 'VAULT_ALLOW_INSECURE')) { Fail 'refusing to send session data to a non-local Vault over plain http. Use https.' }
    $params = @{ Method = $Method; Uri = ($addr + '/v1/' + $Route); Headers = @{ 'X-Vault-Token' = $token }; UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($Body -ne '') { $params['ContentType'] = 'application/json'; $params['Body'] = (Get-Utf8Bytes $Body) } # a [string] parameter turns $null into ''
    try {
        $r = Invoke-WebRequest @params
        $json = $null
        if ($r.Content) { try { $json = ([string]$r.Content) | ConvertFrom-Json } catch { $json = $null } }
        return @{ status = [int]$r.StatusCode; json = $json }
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { Fail ('cannot reach Vault at ' + $addr + ' (' + $_.Exception.Message + ')') }
        return @{ status = [int]$resp.StatusCode; json = $null }
    }
}

function Get-VaultErrorText([int]$Status) {
    if ($Status -eq 403) { return 'Vault denied access (HTTP 403): the token is wrong, expired or lacks the policy (local Vault: claude-switcher.ps1 vault token)' }
    if ($Status -eq 503) { return 'Vault is sealed (local Vault: claude-switcher.ps1 vault unseal)' }
    return ('Vault answered HTTP ' + $Status)
}

function Assert-VaultProvider {
    $p = Get-VaultProvider
    if ($p -ne 'file' -and $p -ne 'hashicorp') { Fail 'set VAULT_PROVIDER to one of: file, hashicorp' }
    return $p
}

# The entry's text, or null when there is none.
function Read-VaultEntry([string]$Id) {
    if ((Assert-VaultProvider) -eq 'file') {
        $f = Join-Path (Get-VaultFileDir) ($Id + '.json')
        if (-not (Test-Path -LiteralPath $f)) { return $null }
        return [System.IO.File]::ReadAllText($f)
    }
    $r = Invoke-VaultApi 'GET' ((Get-VaultMount) + '/data/' + (Get-VaultPrefix) + '/' + $Id)
    if ($r.status -eq 404) { return $null }
    if ($r.status -ne 200) { Fail (Get-VaultErrorText $r.status) }
    $data = Get-Prop (Get-Prop $r.json 'data') 'data'
    $envelope = Get-Prop $data 'envelope'
    if ($envelope -is [string]) { return $envelope }
    # An entry written by hand in the Vault's own UI, as separate fields: accepted when it has a version.
    if ($null -ne (Get-Prop $data 'version')) { return ($data | ConvertTo-Json -Compress -Depth 10) }
    return $null
}

function Write-VaultEntry([string]$Id, [string]$Text) {
    if ((Assert-VaultProvider) -eq 'file') {
        Write-TextFile (Join-Path (Get-VaultFileDir) ($Id + '.json')) $Text
        return
    }
    $body = @{ data = @{ envelope = $Text } } | ConvertTo-Json -Compress -Depth 5
    $r = Invoke-VaultApi 'POST' ((Get-VaultMount) + '/data/' + (Get-VaultPrefix) + '/' + $Id) $body
    if ($r.status -ne 200 -and $r.status -ne 204) { Fail (Get-VaultErrorText $r.status) }
}

# Names directly under a prefix; folders end with "/".
function Get-VaultEntries([string]$Prefix = '') {
    if ((Assert-VaultProvider) -eq 'file') {
        $dir = Join-Path (Get-VaultFileDir) $Prefix
        if (-not (Test-Path -LiteralPath $dir)) { return @() }
        $names = @()
        foreach ($e in @(Get-ChildItem -LiteralPath $dir -Force)) {
            if ($e.PSIsContainer) { $names += ($e.Name + '/') } else { $names += ($e.Name -replace '\.json$', '') }
        }
        return $names
    }
    $r = Invoke-VaultApi 'GET' ((Get-VaultMount) + '/metadata/' + (Get-VaultPrefix) + '/' + $Prefix + '?list=true')
    if ($r.status -eq 404) { return @() }
    if ($r.status -ne 200) { Fail (Get-VaultErrorText $r.status) }
    $keys = Get-Prop (Get-Prop $r.json 'data') 'keys'
    if ($null -eq $keys) { return @() }
    return @($keys)
}

# Every version of the entry, permanently.
function Remove-VaultEntry([string]$Id) {
    if ((Assert-VaultProvider) -eq 'file') {
        $f = Join-Path (Get-VaultFileDir) ($Id + '.json')
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
        return
    }
    $r = Invoke-VaultApi 'DELETE' ((Get-VaultMount) + '/metadata/' + (Get-VaultPrefix) + '/' + $Id)
    if ($r.status -eq 404) { return }
    if ($r.status -eq 403) { Fail 'Vault refused the deletion: re-apply the helper policy (claude-switcher.ps1 vault policy) so the token may delete' }
    if ($r.status -ne 200 -and $r.status -ne 204) { Fail (Get-VaultErrorText $r.status) }
}
