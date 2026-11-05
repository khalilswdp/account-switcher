# The private local Vault (vault/docker-compose.yml), as scripts/vault-local.mjs runs it: the same
# container, the same keys.json and token in ~/.claude-switcher-vault, the same policy. Nothing
# secret is ever printed.
Set-StrictMode -Version 2

$script:Policy = 'claude-switcher'
$script:PolicyRules = @(
    'path "secret/metadata/" { capabilities = ["list"] }',
    'path "secret/data/claude-switcher/*" { capabilities = ["create", "read", "update"] }',
    'path "secret/metadata/claude-switcher" { capabilities = ["list"] }',
    'path "secret/metadata/claude-switcher/*" { capabilities = ["list", "read", "delete"] }'
) -join "`n"
$script:KeepVersions = 2

function Get-VaultLocalPort { return (Get-Setting 'VAULT_PORT' '8200') }
function Get-VaultLocalAddr { return ('http://127.0.0.1:' + (Get-VaultLocalPort)) }
function Get-KeysFile { return (Join-Path (Get-VaultLocalDir) 'keys.json') }
function Get-TokenFile { return (Join-Path (Get-VaultLocalDir) 'token') }
function Get-ComposeFile { return (Join-Path $script:Root 'vault\docker-compose.yml') }

function Write-SecretFile([string]$File, [byte[]]$Bytes) {
    $dir = Split-Path -Parent $File
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Write-FileAtomic $File $Bytes
}

function Read-Keys {
    $f = Get-KeysFile
    if (-not (Test-Path -LiteralPath $f)) { Fail ('cannot read ' + $f + '. Run "vault init" first, or put your saved keys.json there.') }
    try { return ([System.IO.File]::ReadAllText($f) | ConvertFrom-Json) } catch { Fail ('cannot read ' + $f) }
}

function Invoke-Docker([string[]]$Arguments) {
    [Environment]::SetEnvironmentVariable('VAULT_PORT', (Get-VaultLocalPort))
    $r = Invoke-Native 'docker' (@('compose', '-f', (Get-ComposeFile)) + $Arguments) $script:Root
    if ($r.code -ne 0) {
        if ($r.err -match 'not recognized|cannot find|introuvable') { Fail 'docker is not installed or not on PATH' }
        Fail ('docker compose failed: ' + ((($r.err.Trim() -split "`r?`n") | Select-Object -Last 1)))
    }
    return $r
}

# The Vault API without the limited token: the root token or none, as each call needs.
function Invoke-LocalApi([string]$Method, [string]$Route, [string]$Token = $null, $Json = $null, [byte[]]$Body = $null) {
    $params = @{ Method = $Method; Uri = ((Get-VaultLocalAddr) + '/v1/' + $Route); UseBasicParsing = $true; ErrorAction = 'Stop'; Headers = @{} }
    if ($Token) { $params.Headers['X-Vault-Token'] = $Token }
    if ($null -ne $Json) { $params['ContentType'] = 'application/json'; $params['Body'] = (Get-Utf8Bytes ($Json | ConvertTo-Json -Compress -Depth 10)) }
    elseif ($null -ne $Body -and $Body.Length -gt 0) { $params['Body'] = $Body }
    try {
        $r = Invoke-WebRequest @params
        $parsed = $null
        if ($r.Content -is [string] -and $r.Content) { try { $parsed = $r.Content | ConvertFrom-Json } catch { } }
        return @{ ok = $true; status = [int]$r.StatusCode; json = $parsed; bytes = $r.Content }
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { Fail ('cannot reach Vault at ' + (Get-VaultLocalAddr) + ' (' + $_.Exception.Message + '). Run "vault up" first.') }
        return @{ ok = $false; status = [int]$resp.StatusCode; json = $null; bytes = $null }
    }
}

function Get-Health {
    $r = Invoke-LocalApi 'GET' 'sys/health?standbyok=true&sealedcode=200&uninitcode=200&perfstandbyok=true'
    return $r.json
}

function Wait-Reachable {
    for ($i = 0; $i -lt 30; $i++) {
        try { Invoke-WebRequest -Uri ((Get-VaultLocalAddr) + '/v1/sys/health') -UseBasicParsing -ErrorAction Stop | Out-Null; return } catch {
            if ($_.Exception -is [System.Net.WebException] -and $null -ne $_.Exception.Response) { return }
            Start-Sleep -Seconds 1
        }
    }
    Fail ('Vault did not answer on ' + (Get-VaultLocalAddr) + ' within 30 seconds')
}

function Wait-Active {
    for ($i = 0; $i -lt 30; $i++) {
        $h = Get-Health
        if ((Get-Prop $h 'initialized') -and -not (Get-Prop $h 'sealed') -and -not (Get-Prop $h 'standby')) { return }
        Start-Sleep -Seconds 1
    }
    Fail 'Vault is unsealed but not active yet; try again in a moment'
}

function Assert-Ok($Result, [string]$What) {
    if (-not $Result.ok -and $Result.status -ne 204) { Fail ($What + ' failed (HTTP ' + $Result.status + ')') }
}

function Unseal-With([string]$Key) {
    $r = Invoke-LocalApi 'PUT' 'sys/unseal' $null @{ key = $Key }
    Assert-Ok $r 'unseal'
    $unsealed = ((Get-Prop $r.json 'sealed') -eq $false)
    if ($unsealed) { Wait-Active }
    return $unsealed
}

function Set-HistoryLimit([string]$Root, [int]$Keep) { Assert-Ok (Invoke-LocalApi 'POST' 'secret/config' $Root @{ max_versions = $Keep }) 'history setting' }

function Get-LocalEntries([string]$Root, [string]$Prefix = '') {
    $r = Invoke-LocalApi 'GET' ('secret/metadata/claude-switcher/' + $Prefix + '?list=true') $Root
    if ($r.status -eq 404) { return @() }
    Assert-Ok $r 'listing'
    $out = @()
    foreach ($k in @(Get-Prop (Get-Prop $r.json 'data') 'keys')) {
        if ($k.EndsWith('/')) { $out += @(Get-LocalEntries $Root ($Prefix + $k)) } else { $out += ($Prefix + $k) }
    }
    return $out
}

function New-ScopedToken([string]$Root) {
    $r = Invoke-LocalApi 'POST' 'auth/token/create' $Root @{ policies = @($script:Policy); ttl = '8760h'; renewable = $true; display_name = 'claude-switcher' }
    Assert-Ok $r 'token creation'
    Write-SecretFile (Get-TokenFile) (Get-Utf8Bytes ([string](Get-Prop (Get-Prop $r.json 'auth') 'client_token')))
}

function Invoke-VaultLocal([string]$Command, [string]$Arg1 = '', [string]$Arg2 = '') {
    switch ($Command) {
        'up' {
            Invoke-Docker @('up', '-d') | Out-Null
            Wait-Reachable
            $h = Get-Health
            if (Get-Prop $h 'initialized') { if (Get-Prop $h 'sealed') { $state = 'sealed: run "vault unseal"' } else { $state = 'unsealed' } } else { $state = 'not initialised: run "vault init"' }
            return ('Vault ' + (Get-Prop $h 'version') + ' is up on ' + (Get-VaultLocalAddr) + ' (' + $state + ').')
        }
        'init' {
            Wait-Reachable
            if (Get-Prop (Get-Health) 'initialized') { Fail 'Vault is already initialised. Use "vault unseal" or "vault token".' }
            $r = Invoke-LocalApi 'PUT' 'sys/init' $null @{ secret_shares = 1; secret_threshold = 1 }
            Assert-Ok $r 'init'
            $key = [string](@(Get-Prop $r.json 'keys_base64')[0])
            $root = [string](Get-Prop $r.json 'root_token')
            Write-SecretFile (Get-KeysFile) (Get-Utf8Bytes (([ordered]@{ unseal_key = $key; root_token = $root; created = (Get-IsoNow) } | ConvertTo-Json)))
            if (-not (Unseal-With $key)) { Fail 'Vault did not unseal after init' }
            $mount = Invoke-LocalApi 'POST' 'sys/mounts/secret' $root @{ type = 'kv'; options = @{ version = '2' } }
            if (-not $mount.ok -and $mount.status -ne 400 -and $mount.status -ne 204) { Fail ('creating the secret/ store failed (HTTP ' + $mount.status + ')') }
            Set-HistoryLimit $root $script:KeepVersions
            Assert-Ok (Invoke-LocalApi 'PUT' ('sys/policies/acl/' + $script:Policy) $root @{ policy = $script:PolicyRules }) 'policy creation'
            New-ScopedToken $root
            return ("Vault initialised and unsealed.`n  Keys (unseal key + root token): " + (Get-KeysFile) + "`n  Limited token for the helper : " + (Get-TokenFile) + "`nIMPORTANT: copy keys.json into a password manager now. Without the unseal key the data cannot be recovered.")
        }
        'unseal' {
            Wait-Reachable
            $h = Get-Health
            if (-not (Get-Prop $h 'initialized')) { Fail 'Vault is not initialised. Run "vault init".' }
            if (-not (Get-Prop $h 'sealed')) { return 'Vault is already unsealed.' }
            if (-not (Unseal-With ([string](Get-Prop (Read-Keys) 'unseal_key')))) { Fail 'Vault is still sealed (wrong key?)' }
            return 'Vault unsealed.'
        }
        'token' {
            $h = Get-Health
            if (-not (Get-Prop $h 'initialized') -or (Get-Prop $h 'sealed')) { Fail 'Vault must be initialised and unsealed first.' }
            New-ScopedToken ([string](Get-Prop (Read-Keys) 'root_token'))
            return ('New limited token written to ' + (Get-TokenFile) + ' (valid for 1 year).')
        }
        'policy' {
            $h = Get-Health
            if (-not (Get-Prop $h 'initialized') -or (Get-Prop $h 'sealed')) { Fail 'Vault must be initialised and unsealed first.' }
            Assert-Ok (Invoke-LocalApi 'PUT' ('sys/policies/acl/' + $script:Policy) ([string](Get-Prop (Read-Keys) 'root_token')) @{ policy = $script:PolicyRules }) 'policy update'
            return ('Policy "' + $script:Policy + '" updated: read, write, list and delete under claude-switcher, and listing the names at the root (for the UI).')
        }
        'status' {
            $h = Get-Health
            if (Get-Prop $h 'initialized') { $i = 'initialised' } else { $i = 'NOT initialised' }
            if (Get-Prop $h 'sealed') { $s = 'SEALED' } else { $s = 'unsealed' }
            $lines = @('Vault ' + (Get-Prop $h 'version') + ': ' + $i + ', ' + $s + ' at ' + (Get-VaultLocalAddr))
            if (Test-Path -LiteralPath (Get-KeysFile)) { $lines += 'keys.json : present' } else { $lines += 'keys.json : missing' }
            $token = Get-LocalVaultToken
            if (-not $token) { $lines += 'token     : missing'; return ($lines -join "`n") }
            if ((Get-Prop $h 'sealed') -or -not (Get-Prop $h 'initialized')) { $lines += 'token     : present'; return ($lines -join "`n") }
            $r = Invoke-LocalApi 'GET' 'auth/token/lookup-self' $token
            if ($r.ok) { $lines += ('token     : valid, ' + [math]::Round([double](Get-Prop (Get-Prop $r.json 'data') 'ttl') / 3600) + ' h left') } else { $lines += 'token     : present but rejected (run "vault token")' }
            return ($lines -join "`n")
        }
        'backup' {
            if (-not $Arg1) { Fail 'usage: vault backup <file>' }
            $file = Get-FullPath $Arg1
            if (Test-Path -LiteralPath $file) { Fail ($file + ' already exists, refusing to overwrite') }
            $r = Invoke-LocalApi 'GET' 'sys/storage/raft/snapshot' ([string](Get-Prop (Read-Keys) 'root_token'))
            Assert-Ok $r 'snapshot'
            $bytes = $r.bytes
            if ($bytes -is [string]) { $bytes = [System.Text.Encoding]::GetEncoding('iso-8859-1').GetBytes($bytes) }
            Write-SecretFile $file $bytes
            return ('Snapshot saved to ' + $file + '. It is encrypted by Vault, but keep it with the unseal key kept separately.')
        }
        'restore' {
            if (-not $Arg1) { Fail 'usage: vault restore <file>' }
            $file = Get-FullPath $Arg1
            if (-not (Test-Path -LiteralPath $file)) { Fail ('cannot read ' + $file) }
            $r = Invoke-LocalApi 'POST' 'sys/storage/raft/snapshot-force' ([string](Get-Prop (Read-Keys) 'root_token')) $null ([System.IO.File]::ReadAllBytes($file))
            Assert-Ok $r 'restore'
            return ("Snapshot restored. Vault is now sealed with the ORIGINAL keys.`nPut the original keys.json at " + (Get-KeysFile) + ' (from your password manager), then run "vault unseal" and "vault token".')
        }
        'purge' {
            if (-not $Arg1 -or $Arg1 -notmatch '^[\w][\w/-]*$') { Fail 'usage: vault purge <entry>, e.g. desktop/test' }
            $root = [string](Get-Prop (Read-Keys) 'root_token')
            $route = 'secret/metadata/claude-switcher/' + $Arg1
            $meta = Invoke-LocalApi 'GET' $route $root
            if ($meta.status -eq 404) { return ('Nothing stored at claude-switcher/' + $Arg1 + '.') }
            Assert-Ok $meta 'metadata read'
            $data = Get-Prop $meta.json 'data'
            $versions = @((Get-Prop $data 'versions').PSObject.Properties).Count
            Assert-Ok (Invoke-LocalApi 'DELETE' $route $root) 'purge'
            return ('claude-switcher/' + $Arg1 + ': ' + $versions + ' version(s), current was ' + (Get-Prop $data 'current_version') + ". All versions permanently deleted.")
        }
        'trim' {
            $keep = $script:KeepVersions
            if ($Arg1 -match '^\d+$') { $keep = [Math]::Max(1, [int]$Arg1) }
            $root = [string](Get-Prop (Read-Keys) 'root_token')
            Set-HistoryLimit $root $keep
            if ($Arg2) { $entries = @($Arg2) } else { $entries = @(Get-LocalEntries $root) }
            $lines = @()
            foreach ($entry in $entries) {
                $meta = Invoke-LocalApi 'GET' ('secret/metadata/claude-switcher/' + $entry) $root
                if (-not $meta.ok) { continue }
                $data = Get-Prop $meta.json 'data'
                Assert-Ok (Invoke-LocalApi 'POST' ('secret/metadata/claude-switcher/' + $entry) $root @{ max_versions = $keep }) 'entry setting'
                $live = @()
                foreach ($v in (Get-Prop $data 'versions').PSObject.Properties) {
                    if (-not (Get-Prop $v.Value 'destroyed') -and -not (Get-Prop $v.Value 'deletion_time')) { $live += [int]$v.Name }
                }
                $live = @($live | Sort-Object)
                $dropCount = [Math]::Max(0, $live.Count - $keep)
                if ($dropCount -gt 0) {
                    $drop = @($live[0..($dropCount - 1)])
                    Assert-Ok (Invoke-LocalApi 'POST' ('secret/destroy/claude-switcher/' + $entry) $root @{ versions = $drop }) 'destroy'
                }
                $lines += ('claude-switcher/' + $entry + ': kept ' + ($live.Count - $dropCount) + ' version(s), destroyed ' + $dropCount + '.')
            }
            $lines += ('History cap is now ' + $keep + ' version(s) per entry.')
            return ($lines -join "`n")
        }
        'down' {
            Invoke-Docker @('down') | Out-Null
            return 'Vault stopped. Data is kept in the Docker volume.'
        }
        default { Fail 'usage: vault <up|init|unseal|token|policy|status|backup <file>|restore <file>|purge <entry>|trim [keep] [entry]|down>' }
    }
}
