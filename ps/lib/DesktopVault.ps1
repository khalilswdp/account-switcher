# The Claude app's login to and from the Vault, in exactly the envelope scripts/desktop-vault.mjs
# writes and reads: version 1, format "gzip-base64-json", a payload holding the cookie database
# with its values blanked plus the values decrypted, keyed by rowid. Only the "sessionKey" cookie
# is kept by default; the consent cookie belongs to each machine. The key never leaves the
# machine: a push decrypts here, a pull or load encrypts again with this folder's own key.
Set-StrictMode -Version 2

function Get-DesktopItems { return @(((Get-Setting 'DESKTOP_ITEMS' 'Cookies') -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Get-DesktopCookies { return @(((Get-Setting 'DESKTOP_COOKIES' 'sessionKey') -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$script:MaxEntry = 700000 # bytes of the stored envelope; Vault's default entry limit is about 1 MiB

function Get-BackupDir { return (Get-FullPath (Get-Setting 'BACKUP_DIR' (Join-Path $script:Root '.backups'))) }
function Get-RevFile([string]$Kind, [string]$Name) { return (Join-Path (Get-BackupDir) ($Kind + '-' + $Name + '.vault-rev')) }
function Read-Rev([string]$Kind, [string]$Name) {
    $t = Read-TextFile (Get-RevFile $Kind $Name)
    if ($null -eq $t) { return $null }
    return $t.Trim()
}
function Write-Rev([string]$Kind, [string]$Name, [string]$Value) { Write-TextFile (Get-RevFile $Kind $Name) $Value }

function Get-HostName { return [System.Net.Dns]::GetHostName() }

# Where an item lives inside a data folder (the cookie database moves between builds).
function Get-ItemPath([string]$Folder, [string]$Name) {
    if ($Name -eq 'Cookies') { return (Get-CookieFile $Folder) }
    return (Join-Path $Folder $Name)
}

# ------------------------------------------------------------------ cookie crypto

# "v10" + nonce + AES-256-GCM; from database version 24 the plaintext starts with SHA-256(host_key).
function Unprotect-Cookie([byte[]]$Encrypted, [string]$HostKey, [byte[]]$Key, [int]$DbVersion) {
    if ($null -eq $Encrypted -or $Encrypted.Length -eq 0) { return $null }
    if ($Encrypted.Length -lt 31 -or [System.Text.Encoding]::ASCII.GetString($Encrypted, 0, 3) -ne 'v10') { Fail 'not a v10 value' }
    $nonce = New-Object byte[] 12
    [Array]::Copy($Encrypted, 3, $nonce, 0, 12)
    $rest = New-Object byte[] ($Encrypted.Length - 15)
    [Array]::Copy($Encrypted, 15, $rest, 0, $rest.Length)
    $plain = [ClaudeSwitcher.AesGcm]::Open($Key, $nonce, $rest)
    if ($DbVersion -lt 24) { return ,$plain }
    $hash = Get-Sha256 (Get-Utf8Bytes $HostKey)
    if ($plain.Length -lt 32) { Fail ('cookie for ' + $HostKey + ' fails its host check') }
    for ($i = 0; $i -lt 32; $i++) { if ($plain[$i] -ne $hash[$i]) { Fail ('cookie for ' + $HostKey + ' fails its host check') } }
    $value = New-Object byte[] ($plain.Length - 32)
    [Array]::Copy($plain, 32, $value, 0, $value.Length)
    return ,$value
}

function Protect-Cookie([byte[]]$Value, [string]$HostKey, [byte[]]$Key, [int]$DbVersion) {
    if ($DbVersion -lt 24) { $plain = $Value } else { $plain = [byte[]]((Get-Sha256 (Get-Utf8Bytes $HostKey)) + $Value) }
    $nonce = New-RandomBytes 12
    $sealed = [ClaudeSwitcher.AesGcm]::Seal($Key, $nonce, $plain)
    return ,([byte[]]([System.Text.Encoding]::ASCII.GetBytes('v10') + $nonce + $sealed))
}

# --------------------------------------------------------------------- sqlite

# The rows as one list object (a plain return would unroll it into separate rows).
function Invoke-Sql($Db, [string]$Sql, [object[]]$Params = $null) {
    if ($null -eq $Params) { return ,$Db.Query($Sql, $null) }
    $args = New-Object object[] $Params.Length
    for ($i = 0; $i -lt $Params.Length; $i++) {
        $v = $Params[$i]
        if ($null -ne $v) { $v = $v.PSObject.BaseObject } # a value that came through a pipeline is wrapped
        $args[$i] = $v
    }
    return ,$Db.Query($Sql, $args)
}

# A consistent copy of a cookie database through SQLite's own VACUUM INTO over a read-only
# connection. The live file is never written to (Windows locks it while the app runs anyway).
function Copy-CookieDb([string]$File, [string]$Dest) {
    try {
        $src = New-Object ClaudeSwitcher.Sqlite($File, $true)
        try { $src.Exec("vacuum into '" + $Dest.Replace("'", "''") + "'") } finally { $src.Dispose() }
    } catch {
        Fail ('could not read the cookie file (' + $_.Exception.Message + '). Quit the Claude app, or try again in a moment.')
    }
}

function New-TempDir([string]$Prefix) {
    $d = Join-Path ([System.IO.Path]::GetTempPath()) ($Prefix + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    return $d
}

# The cookie database with the chosen cookies only, their values blanked in the file and kept
# decrypted next to it, keyed by rowid.
function Get-PackedCookies([string]$File, [byte[]]$Key) {
    $tmp = New-TempDir 'desktop-vault-'
    try {
        $copy = Join-Path $tmp 'Cookies'
        Copy-CookieDb $File $copy
        $db = New-Object ClaudeSwitcher.Sqlite($copy, $false)
        try {
            $version = [int](Invoke-Sql $db "select value from meta where key='version'")[0]['value']
            $cookies = @(Get-DesktopCookies)
            if ($cookies -notcontains '*') {
                $marks = ($cookies | ForEach-Object { '?' }) -join ','
                Invoke-Sql $db ('delete from cookies where name not in (' + $marks + ')') ([object[]]$cookies) | Out-Null
            }
            if ((Invoke-Sql $db 'select count(*) as n from cookies')[0]['n'] -eq 0) { Fail ('none of the cookies to store (' + ($cookies -join ', ') + ') were found. Is this account signed in?') }
            $values = [ordered]@{}
            foreach ($r in (Invoke-Sql $db 'select rowid as id, host_key, encrypted_value from cookies')) {
                try { $v = Unprotect-Cookie $r['encrypted_value'] $r['host_key'] $Key $version }
                catch { Fail 'a cookie could not be decrypted. Is this the machine (and the key) the account was signed in on?' }
                if ($null -ne $v) { $values[[string]$r['id']] = [Convert]::ToBase64String($v) }
            }
            $db.Exec("update cookies set encrypted_value = x''") # the old ciphertext is useless elsewhere
            $db.Exec('vacuum') # and no deleted rows linger in free pages
        } finally { $db.Dispose() }
        $bytes = [System.IO.File]::ReadAllBytes($copy)
        return [ordered]@{ kind = 'cookies'; version = $version; db = [Convert]::ToBase64String($bytes); values = $values }
    } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

function Get-PackedItem([string]$Name, [string]$Source, [byte[]]$Key) {
    $p = Get-ItemPath $Source $Name
    if ($Name -eq 'Cookies') { return (Get-PackedCookies $p $Key) }
    if ($Name -eq 'config.json') { Fail 'config.json as a stored item is not supported by the PowerShell command' }
    if ((Get-Item -LiteralPath $p).PSIsContainer) { Fail 'a folder as a stored item is not supported by the PowerShell command' }
    return [ordered]@{ kind = 'file'; data = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($p)) }
}

# A fingerprint of what would be pushed, from the still-encrypted files, byte for byte the one
# scripts/desktop-vault.mjs computes, so "already up to date" holds across the two.
function Get-DesktopFingerprint([string]$Source) {
    $items = @(Get-DesktopItems)
    $cookies = @(Get-DesktopCookies)
    $ms = New-Object System.IO.MemoryStream
    $put = { param($text) $b = [System.Text.Encoding]::UTF8.GetBytes($text); $ms.Write($b, 0, $b.Length) }
    & $put ('{"items":[' + (($items | ForEach-Object { '"' + $_ + '"' }) -join ',') + '],"cookies":[' + (($cookies | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']}')
    foreach ($name in $items) {
        $p = Get-ItemPath $Source $name
        if (-not (Test-Path -LiteralPath $p)) { continue }
        & $put ("`n" + $name + "`n")
        if ($name -eq 'Cookies') {
            $tmp = New-TempDir 'desktop-vault-fp-'
            try {
                $copy = Join-Path $tmp 'Cookies'
                Copy-CookieDb $p $copy
                $db = New-Object ClaudeSwitcher.Sqlite($copy, $true)
                try {
                    if ($cookies -contains '*') {
                        $rows = Invoke-Sql $db 'select host_key, name, path, hex(encrypted_value) as v from cookies order by host_key, name, path'
                    } else {
                        $marks = ($cookies | ForEach-Object { '?' }) -join ','
                        $rows = Invoke-Sql $db ('select host_key, name, path, hex(encrypted_value) as v from cookies where name in (' + $marks + ') order by host_key, name, path') ([object[]]$cookies)
                    }
                    foreach ($r in $rows) { & $put ([string]$r['host_key'] + '|' + [string]$r['name'] + '|' + [string]$r['path'] + '|' + [string]$r['v'] + "`n") }
                } finally { $db.Dispose() }
            } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        } elseif ((Get-Item -LiteralPath $p).PSIsContainer) {
            Fail 'a folder as a stored item is not supported by the PowerShell command'
        } else {
            $b = [System.IO.File]::ReadAllBytes($p); $ms.Write($b, 0, $b.Length)
        }
    }
    $hex = ConvertTo-Hex (Get-Sha256 $ms.ToArray())
    $ms.Dispose()
    return $hex
}

# ----------------------------------------------------------------- unpacking

function Expand-DesktopItem([string]$Name, $Item, [string]$Root, [byte[]]$Key) {
    $p = Get-ItemPath $Root $Name
    $dir = Split-Path -Parent $p
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $kind = Get-Prop $Item 'kind'
    if ($kind -eq 'cookies') {
        [System.IO.File]::WriteAllBytes($p, [Convert]::FromBase64String((Get-Prop $Item 'db')))
        $db = New-Object ClaudeSwitcher.Sqlite($p, $false)
        try {
            $hosts = @{}
            foreach ($r in (Invoke-Sql $db 'select rowid as id, host_key from cookies')) { $hosts[[string]$r['id']] = [string]$r['host_key'] }
            $version = [int](Get-Prop $Item 'version')
            foreach ($prop in (Get-Prop $Item 'values').PSObject.Properties) {
                $enc = Protect-Cookie ([Convert]::FromBase64String([string]$prop.Value)) $hosts[$prop.Name] $Key $version
                Invoke-Sql $db 'update cookies set encrypted_value = ? where rowid = ?' @($enc, [long]$prop.Name) | Out-Null
            }
        } finally { $db.Dispose() }
    } elseif ($kind -eq 'dir') {
        New-Item -ItemType Directory -Path $p -Force | Out-Null
        foreach ($f in @(Get-Prop $Item 'files')) {
            $fp = Join-Path $p ([string](Get-Prop $f 'path'))
            $fd = Split-Path -Parent $fp
            if (-not (Test-Path -LiteralPath $fd)) { New-Item -ItemType Directory -Path $fd -Force | Out-Null }
            [System.IO.File]::WriteAllBytes($fp, [Convert]::FromBase64String([string](Get-Prop $f 'data')))
        }
    } elseif ($kind -eq 'config') {
        Fail 'this entry holds a config.json item, which the PowerShell command cannot rebuild; load it with the Node version'
    } else {
        [System.IO.File]::WriteAllBytes($p, [Convert]::FromBase64String([string](Get-Prop $Item 'data')))
    }
}

# Adds or replaces the saved cookies inside an EXISTING cookie database, encrypted with this
# folder's key. The cookies already there, and everything else in the folder, stay.
function Merge-Cookies([string]$File, $Packed, [byte[]]$Key) {
    $tmp = New-TempDir 'desktop-vault-merge-'
    try {
        $src = Join-Path $tmp 'Cookies'
        [System.IO.File]::WriteAllBytes($src, [Convert]::FromBase64String((Get-Prop $Packed 'db')))
        $incoming = New-Object ClaudeSwitcher.Sqlite($src, $true)
        try { $rows = Invoke-Sql $incoming 'select rowid as _id, * from cookies' } finally { $incoming.Dispose() }
        $values = Get-Prop $Packed 'values'
        $db = New-Object ClaudeSwitcher.Sqlite($File, $false)
        try {
            $version = [int](Invoke-Sql $db "select value from meta where key='version'")[0]['value']
            $columns = @()
            foreach ($c in (Invoke-Sql $db 'pragma table_info(cookies)')) { $columns += [string]$c['name'] }
            foreach ($row in $rows) {
                $plain = Get-Prop $values ([string]$row['_id'])
                if (-not $plain) { continue }
                $use = @(); $vals = @()
                foreach ($c in $columns) {
                    if (-not $row.ContainsKey($c)) { continue }
                    $use += $c
                    if ($c -eq 'encrypted_value') { $vals += ,(Protect-Cookie ([Convert]::FromBase64String([string]$plain)) ([string]$row['host_key']) $Key $version) }
                    else { $vals += ,$row[$c] }
                }
                Invoke-Sql $db 'delete from cookies where host_key = ? and name = ? and path = ?' @([string]$row['host_key'], [string]$row['name'], [string]$row['path']) | Out-Null
                Invoke-Sql $db ('insert into cookies (' + ($use -join ',') + ') values (' + (($use | ForEach-Object { '?' }) -join ',') + ')') ([object[]]$vals) | Out-Null
            }
        } finally { $db.Dispose() }
    } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------------- vault

function Read-DesktopRemote([string]$Name) {
    $raw = Read-VaultEntry ('desktop/' + $Name)
    if ($null -eq $raw) { return $null }
    try { $env = $raw | ConvertFrom-Json } catch { Fail 'the vault entry is not valid JSON' }
    if ((Get-Prop $env 'version') -ne 1 -or (Get-Prop $env 'format') -ne 'gzip-base64-json') { Fail 'the vault entry has an unknown format' }
    return $env
}

function Get-RemoteItems($Remote) {
    $json = Get-Utf8String (ConvertFrom-Gzip ([Convert]::FromBase64String([string](Get-Prop $Remote 'payload'))))
    return ($json | ConvertFrom-Json)
}

# ----------------------------------------------------------------- commands

function Get-DesktopVaultStatus([string]$Name) {
    Assert-AccountName $Name 'status'
    $remote = Read-DesktopRemote $Name
    $vault = $null
    if ($remote) { $vault = [ordered]@{ items = @(Get-Prop $remote 'items'); pushedAt = (Get-Prop $remote 'pushedAt'); host = (Get-Prop $remote 'host') } }
    $local = (Test-Path -LiteralPath (Get-ParkedFolder $Name)) -or ((Get-ActiveName) -eq $Name)
    return [ordered]@{ vault = $vault; localFolder = $local }
}

function Push-DesktopLogin([string]$Name, [switch]$Force) {
    Assert-AccountName $Name 'save-app'
    $isActive = ((Get-ActiveName) -eq $Name)
    if ($isActive) { $source = Get-ActiveFolder } else { $source = Get-ParkedFolder $Name }
    if (-not (Test-Path -LiteralPath $source)) {
        if ((Get-ActiveName) -eq '') { Fail 'the Claude app is not assigned to an account yet: run "claude-switcher.ps1 init <name>" with the account it is signed in as, then save again' }
        Fail ('no folder for "' + $Name + '" at ' + $source)
    }
    if ($isActive -and (Test-AppRunning)) { Fail 'the Claude app is running on this account, and Windows keeps its cookie file locked while it runs. Quit the app first (claude-switcher.ps1 save-app does that for you).' }
    $remote = Read-DesktopRemote $Name
    $rev = Read-Rev 'desktop' $Name
    $fp = Get-DesktopFingerprint $source
    if ($remote -and (Get-Prop $remote 'fp') -eq $fp -and -not $Force) {
        Write-Rev 'desktop' $Name (Get-Prop $remote 'pushedAt')
        return ('Already up to date: nothing changed in "' + $Name + '" since ' + (Get-Prop $remote 'pushedAt') + '.')
    }
    if ($remote -and (Get-Prop $remote 'pushedAt') -ne $rev -and -not $Force) {
        Fail ('the vault entry was updated (' + (Get-Prop $remote 'pushedAt') + ' from ' + (Get-Prop $remote 'host') + ') since your last pull or push. Pull first, or use -Force.')
    }
    $key = Get-SafeStorageKey $source
    $items = [ordered]@{}
    $missing = @()
    foreach ($item in @(Get-DesktopItems)) {
        if (-not (Test-Path -LiteralPath (Get-ItemPath $source $item))) { $missing += $item; continue }
        $items[$item] = Get-PackedItem $item $source $key
    }
    if (-not $items.Contains('config.json') -and -not $items.Contains('Cookies')) { Fail 'neither config.json nor Cookies found: nothing that holds a login' }
    $pushedAt = Get-IsoNow
    $payload = [Convert]::ToBase64String((ConvertTo-Gzip (Get-Utf8Bytes ($items | ConvertTo-Json -Compress -Depth 10))))
    $envelope = [ordered]@{ version = 1; format = 'gzip-base64-json'; pushedAt = $pushedAt; host = (Get-HostName); items = @($items.Keys); fp = $fp; payload = $payload } | ConvertTo-Json -Compress -Depth 5
    if ($envelope.Length -gt $script:MaxEntry) { Fail ('the packed account is ' + $envelope.Length + ' bytes, over the ' + $script:MaxEntry + ' limit. Store fewer items (DESKTOP_ITEMS).') }
    Write-VaultEntry ('desktop/' + $Name) $envelope
    Write-Rev 'desktop' $Name $pushedAt
    $out = 'Pushed "' + $Name + '": ' + (@($items.Keys) -join ', ') + ' (' + $envelope.Length + ' bytes) at ' + $pushedAt + '.'
    if ($missing.Count) { $out += "`nNot present in the source, skipped: " + ($missing -join ', ') }
    return $out
}

function Pull-DesktopLogin([string]$Name, [string]$As = '') {
    Assert-AccountName $Name 'pull-app'
    $target = $Name
    if ($As) { $target = $As }
    if (-not (Test-AccountName $target)) { Fail 'account name may only use letters, digits, - and _' }
    if ($target -eq (Get-ActiveName)) { Fail ('"' + $target + '" is the active account; pull into another name with -As') }
    if (Test-Path -LiteralPath (Get-ParkedFolder $target)) { Fail ((Get-ParkedFolder $target) + ' already exists, refusing to overwrite. Pull into another name with -As.') }
    $remote = Read-DesktopRemote $Name
    if (-not $remote) { Fail ('nothing in the vault for "' + $Name + '" yet') }
    $items = Get-RemoteItems $remote
    $partial = (Get-ParkedFolder $target) + '.partial'
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }
    New-Item -ItemType Directory -Path $partial -Force | Out-Null
    try {
        $key = Get-SafeStorageKey $partial -Create # this machine's key, made for the new folder
        foreach ($prop in $items.PSObject.Properties) { Expand-DesktopItem $prop.Name $prop.Value $partial $key }
        Rename-Item -LiteralPath $partial -NewName (Split-Path -Leaf (Get-ParkedFolder $target))
    } catch {
        Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
    Write-Rev 'desktop' $Name (Get-Prop $remote 'pushedAt')
    $names = @($items.PSObject.Properties | ForEach-Object { $_.Name })
    return ('Pulled "' + $Name + '" into ' + (Get-ParkedFolder $target) + ' (' + ($names -join ', ') + "), encrypted with this machine's key.`nSwitch to it with: claude-switcher.ps1 use " + $target)
}

# Into the account's own folder: the saved cookie is merged into what is there (or the folder is
# created). The Claude app must not be using that folder.
function Load-DesktopLogin([string]$Name) {
    Assert-AccountName $Name 'load-app'
    $remote = Read-DesktopRemote $Name
    if (-not $remote) { Fail ('nothing in the vault for "' + $Name + '" yet') }
    $isActive = ((Get-ActiveName) -eq $Name)
    if ($isActive) { $target = Get-ActiveFolder } else { $target = Get-ParkedFolder $Name }
    if ($isActive -and (Test-AppRunning)) { Fail 'the Claude app is running and this account is the active one. Quit it first.' }
    if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
    $key = Get-SafeStorageKey $target -Create
    $items = Get-RemoteItems $remote
    foreach ($prop in $items.PSObject.Properties) {
        $cookieFile = Get-CookieFile $target
        if ((Get-Prop $prop.Value 'kind') -eq 'cookies' -and (Test-Path -LiteralPath $cookieFile)) { Merge-Cookies $cookieFile $prop.Value $key }
        else { Expand-DesktopItem $prop.Name $prop.Value $target $key }
    }
    Write-Rev 'desktop' $Name (Get-Prop $remote 'pushedAt')
    return ('Loaded "' + $Name + '" from the vault into ' + $target + '.')
}

function Forget-DesktopLogin([string]$Name) {
    Assert-AccountName $Name 'forget-app'
    Assert-NotProtected $Name
    $had = ($null -ne (Read-VaultEntry ('desktop/' + $Name)))
    Remove-VaultEntry ('desktop/' + $Name)
    $rev = Get-RevFile 'desktop' $Name
    if (Test-Path -LiteralPath $rev) { Remove-Item -LiteralPath $rev -Force }
    if ($had) { return ('Deleted the "' + $Name + '" desktop login from the vault (every version).') }
    return ('Nothing in the vault for "' + $Name + '".')
}
