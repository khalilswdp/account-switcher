# Full backup of one account into ONE passphrase-encrypted file, in exactly the format
# scripts/backup.mjs writes and reads: "CSBK" + version + 16-byte salt + 12-byte IV, then
# AES-256-GCM over a gzip tar, then the 16-byte tag, the key from the passphrase with scrypt.
# Contents: vault/ (the logins in Vault format), claude-config/ (the Claude Code folder without
# caches and without the login file), claude.json (default folder only), desktop-data/ (the app's
# data without caches, the cookie file, the Network folder and Local State), manifest.json.
# The tar stream is encrypted as it comes, so a backup never sits in memory or on disk unencrypted.
Set-StrictMode -Version 2

$script:Magic = [byte[]](0x43, 0x53, 0x42, 0x4b)
$script:HeaderLen = 33
$script:TagLen = 16
$script:ConfigSkip = @('cache', 'debug', 'telemetry', 'shell-snapshots', 'session-env', 'downloads', 'statsig', '.DS_Store', '.credentials.json')
$script:DesktopSkip = @('vm_bundles', 'claude-code', 'claude-code-vm', 'Cache', 'Code Cache', 'GPUCache', 'GraphiteDawnCache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache', 'Crashpad', 'Shared Dictionary', 'lockfile', 'logs', 'sentry', 'fcache',
    'Cookies', 'Cookies-journal', 'Network', 'Local State')

function Write-Log([string]$Message) { [Console]::Error.WriteLine($Message) }
function Get-BackupKey([string]$Passphrase, [byte[]]$Salt) { return ,([ClaudeSwitcher.Scrypt]::Derive((Get-Utf8Bytes $Passphrase), $Salt, 32768, 8, 1, 32)) }

function Start-Tar([string[]]$Arguments, [bool]$RedirectInput) {
    # The process's StandardInput writer takes the console's input encoding; one with a byte-order
    # mark would put three bytes in front of the archive. UTF-8 without a mark reads as before.
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Get-TarExe
    $psi.Arguments = ($Arguments | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $RedirectInput
    $psi.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($psi)
}

# tar's output (a gzip tar on stdout), encrypted into File as it comes. Never overwrites a file.
# Returns tar's warnings; an exit code above 1 (1 = some files could not be read) is a failure.
function Write-EncryptedTar([string]$File, [string]$Passphrase, [string[]]$TarArgs) {
    $salt = New-RandomBytes 16
    $iv = New-RandomBytes 12
    $key = Get-BackupKey $Passphrase $salt
    $p = Start-Tar $TarArgs $false
    $errTask = $p.StandardError.ReadToEndAsync()
    $fs = [System.IO.File]::Open($File, [System.IO.FileMode]::CreateNew)
    try {
        $fs.Write($script:Magic, 0, 4); $fs.WriteByte(1); $fs.Write($salt, 0, 16); $fs.Write($iv, 0, 12)
        $gcm = New-Object ClaudeSwitcher.AesGcm($key, $iv, $true)
        try {
            $buf = New-Object byte[] 65536
            $stream = $p.StandardOutput.BaseStream
            while ($true) {
                $n = $stream.Read($buf, 0, $buf.Length)
                if ($n -le 0) { break }
                $chunk = New-Object byte[] $n
                [Array]::Copy($buf, 0, $chunk, 0, $n)
                $out = $gcm.Update($chunk)
                if ($out.Length -gt 0) { $fs.Write($out, 0, $out.Length) }
            }
            $out = $gcm.Final($null)
            if ($out.Length -gt 0) { $fs.Write($out, 0, $out.Length) }
            $tag = $gcm.Tag
            $fs.Write($tag, 0, $tag.Length)
        } finally { $gcm.Dispose() }
    } finally { $fs.Dispose() }
    $p.WaitForExit()
    $err = $errTask.Result
    if ($p.ExitCode -gt 1) {
        Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
        Fail ('tar failed: ' + (($err.Trim() -split "`r?`n")[0]))
    }
    return $err.Trim()
}

# Reads the file, decrypting as it goes into the Sink stream; the tag is checked at the end (a wrong
# passphrase or any damage throws). A sink that stops taking data (tar done early) is left alone
# and the rest is still decrypted, so the tag check always happens.
function Read-EncryptedFile([string]$File, [string]$Passphrase, [System.IO.Stream]$Sink) {
    $open = $true
    $size = (Get-Item -LiteralPath $File).Length
    if ($size -lt $script:HeaderLen + $script:TagLen) { Fail 'this is not a backup file (too small)' }
    $fs = [System.IO.File]::OpenRead($File)
    try {
        $head = New-Object byte[] $script:HeaderLen
        $null = $fs.Read($head, 0, $head.Length)
        for ($i = 0; $i -lt 4; $i++) { if ($head[$i] -ne $script:Magic[$i]) { Fail 'this is not a backup made by this tool' } }
        $salt = New-Object byte[] 16; [Array]::Copy($head, 5, $salt, 0, 16)
        $iv = New-Object byte[] 12; [Array]::Copy($head, 21, $iv, 0, 12)
        $null = $fs.Seek($size - $script:TagLen, [System.IO.SeekOrigin]::Begin)
        $tag = New-Object byte[] $script:TagLen
        $null = $fs.Read($tag, 0, $tag.Length)
        $null = $fs.Seek($script:HeaderLen, [System.IO.SeekOrigin]::Begin)
        $key = Get-BackupKey $Passphrase $salt
        $gcm = New-Object ClaudeSwitcher.AesGcm($key, $iv, $false)
        try {
            $remaining = $size - $script:HeaderLen - $script:TagLen
            $buf = New-Object byte[] 65536
            while ($remaining -gt 0) {
                $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $remaining))
                if ($n -le 0) { break }
                $remaining -= $n
                $chunk = New-Object byte[] $n
                [Array]::Copy($buf, 0, $chunk, 0, $n)
                $out = $gcm.Update($chunk)
                if ($out.Length -gt 0 -and $open) { try { $Sink.Write($out, 0, $out.Length) } catch { $open = $false } }
            }
            $out = $gcm.Final($tag)
            if ($out.Length -gt 0 -and $open) { try { $Sink.Write($out, 0, $out.Length) } catch { $open = $false } }
        } finally { $gcm.Dispose() }
    } finally { $fs.Dispose() }
}

# Reads the whole file once: does the passphrase open it, and is nothing damaged?
function Test-BackupOpens([string]$File, [string]$Passphrase) {
    try { Read-EncryptedFile $File $Passphrase ([System.IO.Stream]::Null); return $true } catch { return $false }
}

function Assert-BackupOpens([string]$File, [string]$Passphrase) {
    if (-not (Test-BackupOpens $File $Passphrase)) { Fail 'wrong passphrase, or the file is damaged' }
}

# The decrypted archive piped into tar with the given arguments; tar's exit code and texts.
function Invoke-TarFromBackup([string]$File, [string]$Passphrase, [string[]]$TarArgs) {
    $p = Start-Tar $TarArgs $true
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $stdin = $p.StandardInput.BaseStream
    try {
        Read-EncryptedFile $File $Passphrase $stdin
    } finally {
        try { $stdin.Close() } catch { }
    }
    $p.WaitForExit()
    return @{ code = $p.ExitCode; out = $outTask.Result; err = $errTask.Result }
}

function Get-ArchiveNames([string]$File, [string]$Passphrase) {
    $r = Invoke-TarFromBackup $File $Passphrase @('-tzf', '-')
    return @(($r.out -split "`r?`n") | Where-Object { $_ -ne '' })
}

# ----------------------------------------------------------------------- backup

# Saves one login into a throwaway file "Vault" in the stage, in the real Vault's format.
function Invoke-PushInto([string]$Stage, [string]$Part, [string]$Name) {
    $saved = @{}
    foreach ($n in @('VAULT_PROVIDER', 'VAULT_FILE_DIR', 'BACKUP_DIR')) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
    try {
        [Environment]::SetEnvironmentVariable('VAULT_PROVIDER', 'file')
        [Environment]::SetEnvironmentVariable('VAULT_FILE_DIR', (Join-Path $Stage 'vault'))
        [Environment]::SetEnvironmentVariable('BACKUP_DIR', (Join-Path $Stage '.work\b'))
        try {
            if ($Part -eq 'desktop') { $message = Push-DesktopLogin $Name } else { $message = Push-CliLogin $Name }
            return @{ ok = $true; message = (($message -split "`r?`n")[0]) }
        } catch {
            return @{ ok = $false; message = ($_.Exception.Message -replace '^Error:\s*', '') }
        }
    } finally {
        foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
    }
}

# Removes the staging area: junctions are deleted as junctions (never followed), then the rest.
function Remove-Stage([string]$Stage) {
    foreach ($dir in @($Stage, (Join-Path $Stage 'desktop-data'))) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($e in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            if ($e.PSIsContainer -and ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { [System.IO.Directory]::Delete($e.FullName) }
        }
    }
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}

function New-Backup([string]$Name, [string]$To, [switch]$Replace) {
    if (-not (Test-AccountName $Name)) { Fail 'account name may only use letters, digits, - and _' }
    if (-not $To) { Fail 'usage: backup <name> -To <folder>' }
    $folder = Get-FullPath (Expand-Home $To)
    $passphrase = Read-Passphrase -Confirm
    $stage = New-TempDir 'claude-backup-'
    try {
        New-Item -ItemType Directory -Path (Join-Path $stage '.work\b') -Force | Out-Null
        if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }

        # 1. the two logins, in Vault format
        $parts = [ordered]@{}
        foreach ($part in @('desktop', 'cli')) {
            Write-Log ('Reading the ' + $part + ' login...')
            $parts[$part] = Invoke-PushInto $stage $part $Name
            if ($parts[$part].ok) { Write-Log ('  ' + $part + ': saved') } else { Write-Log ('  ' + $part + ': skipped (' + $parts[$part].message + ')') }
        }

        # 2. the files that cannot be re-downloaded, staged as junctions and copies for tar to follow
        $notes = @()
        $members = @('manifest.json', 'README.txt')
        if (Test-Path -LiteralPath (Join-Path $stage 'vault')) { $members += 'vault' }
        $configDir = Get-CliConfigDir $Name
        if (Test-Path -LiteralPath $configDir) {
            try { New-StageLink $configDir (Join-Path $stage 'claude-config'); $members += 'claude-config' }
            catch { $notes += ('left out: ' + $configDir + ' (' + $_.Exception.Message + ')') }
            $homeJson = Join-Path (Get-HomeDir) '.claude.json'
            if ($configDir -eq (Join-Path (Get-HomeDir) '.claude') -and (Test-Path -LiteralPath $homeJson)) {
                try { New-StageLink $homeJson (Join-Path $stage 'claude.json'); $members += 'claude.json' }
                catch { $notes += ('left out: ' + $homeJson + ' (' + $_.Exception.Message + ')') }
            }
        } else {
            $notes += ('no Claude Code config folder at ' + $configDir)
        }
        $isActive = ((Get-ActiveName) -eq $Name)
        if ($isActive) { $desktopDir = Get-ActiveFolder } else { $desktopDir = Get-ParkedFolder $Name }
        if (Test-Path -LiteralPath $desktopDir) {
            New-Item -ItemType Directory -Path (Join-Path $stage 'desktop-data') | Out-Null
            foreach ($entry in @(Get-ChildItem -LiteralPath $desktopDir -Force)) {
                if ($script:DesktopSkip -contains $entry.Name -or $entry.Name.StartsWith('Singleton')) { continue }
                try { New-StageLink $entry.FullName (Join-Path (Join-Path $stage 'desktop-data') $entry.Name) }
                catch { $notes += ('left out: app data ' + $entry.Name + ' (in use by the running app, or: ' + $_.Exception.Message + ')') }
            }
            $members += 'desktop-data'
            if ($isActive) { $notes += 'the desktop app data was read while that account is the active one; quit the app first for a fully consistent copy' }
        } else {
            $notes += ('no desktop app folder for "' + $Name + '"')
        }

        $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
        $file = Join-Path $folder ('claude-backup-' + $Name + '-' + $stamp + '.csbk')
        $n = 2
        while (Test-Path -LiteralPath $file) { $file = Join-Path $folder ('claude-backup-' + $Name + '-' + $stamp + '-' + $n + '.csbk'); $n++ } # never overwrite
        $logins = [ordered]@{}
        foreach ($k in $parts.Keys) { if ($parts[$k].ok) { $logins[$k] = 'saved' } else { $logins[$k] = 'skipped: ' + $parts[$k].message } }
        $manifest = [ordered]@{
            version = 1; account = $Name; createdAt = (Get-IsoNow); host = (Get-HostName); platform = 'win32'
            logins = $logins; configFolder = $configDir; desktopFolder = $desktopDir; notes = @($notes)
        }
        Write-TextFile (Join-Path $stage 'manifest.json') ($manifest | ConvertTo-Json -Depth 5)
        Write-TextFile (Join-Path $stage 'README.txt') (@(
            'Claude account backup. Encrypted with a passphrase; only this tool can open it.',
            '',
            '  node scripts/backup.mjs verify <this file>        (or: claude-switcher.ps1 verify <this file>)',
            '  node scripts/backup.mjs restore <this file> --out <new folder> --to-vault',
            '',
            'The vault/ folder holds the logins in the Vault format. After "restore --to-vault",',
            'use the dashboard''s "Load from Vault" buttons to load them onto a computer.',
            'claude-config/ is the Claude Code folder (history, settings, skills, plugins).'
        ) -join "`n")

        Write-Log 'Packing and encrypting (this can take a minute)...'
        $excludes = @()
        foreach ($s in $script:ConfigSkip) { $excludes += '--exclude'; $excludes += ('claude-config/' + $s) }
        $excludes += '--exclude'; $excludes += '.DS_Store'
        $warning = Write-EncryptedTar $file $passphrase (@('-czhf', '-', '-C', $stage) + $excludes + $members)
        if ($warning) { $notes += ('tar warnings: ' + ((($warning -split "`r?`n") | Select-Object -First 3) -join ' | ')) }
        $size = (Get-Item -LiteralPath $file).Length
        Write-Log ('Saved ' + $file + ' (' + ('{0:N1}' -f ($size / 1048576)) + ' MB). Keep the passphrase safe: without it the file cannot be opened.')

        $replaced = @()
        if ($Replace) {
            if (Test-BackupOpens $file $passphrase) {
                $mine = '^claude-backup-' + [regex]::Escape($Name) + '-\d{8}-\d{6}(-\d+)?\.csbk$'
                foreach ($f in @(Get-ChildItem -LiteralPath $folder -File)) {
                    if ($f.Name -match $mine -and $f.FullName -ne $file) { Remove-Item -LiteralPath $f.FullName -Force; $replaced += $f.Name }
                }
                if ($replaced.Count) { Write-Log ('Replaced ' + $replaced.Count + ' older backup(s).') }
            } else {
                $notes += 'the new backup could not be verified, so the older ones were kept'
            }
        }
        return ([ordered]@{ ok = $true; file = $file; bytes = $size; replaced = @($replaced); logins = $logins; notes = @($notes) } | ConvertTo-Json -Compress -Depth 5)
    } finally {
        Remove-Stage $stage
    }
}

# ------------------------------------------------------------------ verify, restore

function Test-Backup([string]$File) {
    if (-not $File) { Fail 'usage: verify <file>' }
    $File = Get-FullPath $File
    if (-not (Test-Path -LiteralPath $File)) { Fail ('no such file: ' + $File) }
    $passphrase = Read-Passphrase
    Assert-BackupOpens $File $passphrase
    $names = Get-ArchiveNames $File $passphrase
    $manifest = Invoke-TarFromBackup $File $passphrase @('-xzOf', '-', 'manifest.json')
    $top = [ordered]@{}
    foreach ($n in $names) { $k = ($n -split '/')[0]; if ($top.Contains($k)) { $top[$k]++ } else { $top[$k] = 1 } }
    $lines = @('The backup opens and is intact.')
    $lines += ('Entries: ' + $names.Count + '  (' + (($top.Keys | ForEach-Object { $_ + ': ' + $top[$_] }) -join ', ') + ')')
    try {
        $m = $manifest.out | ConvertFrom-Json
        $lines += ('Account "' + (Get-Prop $m 'account') + '", made ' + (Get-Prop $m 'createdAt') + ' on ' + (Get-Prop $m 'host'))
        $logins = Get-Prop $m 'logins'
        if ($logins) { foreach ($p in $logins.PSObject.Properties) { $lines += ('  ' + $p.Name + ' login: ' + $p.Value) } }
        foreach ($n in @(Get-Prop $m 'notes')) { if ($n) { $lines += ('  note: ' + $n) } }
    } catch { $lines += '(no readable manifest)' }
    return ($lines -join "`n")
}

function Get-BackupInfo([string]$File) {
    if (-not $File) { Fail 'usage: inspect <file>' }
    $File = Get-FullPath $File
    if (-not (Test-Path -LiteralPath $File)) { Fail ('no such file: ' + $File) }
    $passphrase = Read-Passphrase
    Assert-BackupOpens $File $passphrase
    $names = Get-ArchiveNames $File $passphrase
    $manifest = Invoke-TarFromBackup $File $passphrase @('-xzOf', '-', 'manifest.json')
    try { $m = $manifest.out | ConvertFrom-Json } catch { Fail 'this backup has no readable manifest' }
    if ($null -eq $m) { Fail 'this backup has no readable manifest' }
    $vault = @($names | Where-Object { $_ -match '^vault/.+\.json$' } | ForEach-Object { ($_ -replace '^vault/', '') -replace '\.json$', '' })
    $notes = @(Get-Prop $m 'notes'); if ($null -eq $notes) { $notes = @() }
    return ([ordered]@{
        ok = $true; account = (Get-Prop $m 'account'); createdAt = (Get-Prop $m 'createdAt'); host = (Get-Prop $m 'host')
        logins = (Get-Prop $m 'logins'); notes = @($notes | Where-Object { $null -ne $_ }); vault = @($vault)
        hasConfig = (@($names | Where-Object { $_.StartsWith('claude-config/') }).Count -gt 0)
        hasDesktop = (@($names | Where-Object { $_.StartsWith('desktop-data/') }).Count -gt 0)
    } | ConvertTo-Json -Compress -Depth 5)
}

# Puts the login entries of an unpacked backup into the Vault. An existing entry is kept unless Replace.
function Set-VaultFromFolder([string]$Root, [bool]$ReplaceExisting, [scriptblock]$Say) {
    $result = @{ written = 0; kept = 0 }
    if (-not (Test-Path -LiteralPath $Root)) { return $result }
    foreach ($f in @(Get-ChildItem -LiteralPath $Root -File -Recurse -Filter '*.json')) {
        $rel = $f.FullName.Substring($Root.Length).TrimStart('\') -replace '\\', '/'
        $id = $rel -replace '\.json$', ''
        if (-not $id.Contains('/')) {
            & $Say ('skipped ' + $id + ': a browser session from an older backup (the browser part is no longer used)')
        } elseif (-not $ReplaceExisting -and ($null -ne (Read-VaultEntry $id))) {
            $result.kept++
            & $Say ('kept the Vault''s existing entry for ' + $id + ' (use -Force to replace it)')
        } else {
            Write-VaultEntry $id ([System.IO.File]::ReadAllText($f.FullName))
            $result.written++
            & $Say ('put ' + $id + ' into the Vault')
        }
    }
    return $result
}

function Restore-Backup([string]$File, [string]$OutDir, [switch]$ToVault, [switch]$Force) {
    if (-not $File -or -not $OutDir) { Fail 'usage: restore <file> -Out <folder> [-ToVault] [-Force]' }
    $File = Get-FullPath $File
    if (-not (Test-Path -LiteralPath $File)) { Fail ('no such file: ' + $File) }
    $out = Get-FullPath (Expand-Home $OutDir)
    if ((Test-Path -LiteralPath $out) -and (@(Get-ChildItem -LiteralPath $out -Force).Count -gt 0)) { Fail ($out + ' is not empty, refusing to unpack into it') }
    $passphrase = Read-Passphrase
    Assert-BackupOpens $File $passphrase # nothing is written until the file is known to be intact
    if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out -Force | Out-Null }
    $r = Invoke-TarFromBackup $File $passphrase @('-xzf', '-', '-C', $out)
    if ($r.code -ne 0) { Fail ('could not unpack: ' + (($r.err.Trim() -split "`r?`n")[0])) }
    $lines = @('Unpacked into ' + $out + '.')
    if ($ToVault) {
        $res = Set-VaultFromFolder (Join-Path $out 'vault') ([bool]$Force) { param($line) $script:restoreLines += ('  ' + $line) }
        $lines += $script:restoreLines
        $lines += ($res.written.ToString() + ' login(s) written to the Vault. Use the dashboard''s "Load from Vault" buttons, or load-app and load-cli, to load them.')
    }
    return ($lines -join "`n")
}
$script:restoreLines = @()

# Copies every file of Src into Dst that Dst does not have yet; modification times are kept.
function Copy-Missing([string]$Src, [string]$Dst) {
    $r = @{ copied = 0; skipped = 0; target = $Dst }
    if (-not (Test-Path -LiteralPath $Src)) { return $r }
    foreach ($f in @(Get-ChildItem -LiteralPath $Src -File -Recurse -Force)) {
        $rel = $f.FullName.Substring($Src.Length).TrimStart('\')
        $to = Join-Path $Dst $rel
        if (Test-Path -LiteralPath $to) { $r.skipped++; continue }
        $dir = Split-Path -Parent $to
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $to
        (Get-Item -LiteralPath $to).LastWriteTimeUtc = $f.LastWriteTimeUtc
        $r.copied++
    }
    return $r
}

# Puts chosen parts of a backup back where they belong. Only adds what is missing.
function Restore-BackupParts([string]$File, [string]$PartsArg, [switch]$ReplaceVault) {
    $parts = @(($PartsArg -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0 -or @($parts | Where-Object { @('vault', 'config', 'desktop') -notcontains $_ }).Count -gt 0) {
        Fail 'usage: apply <file> -Parts vault,config,desktop [-ReplaceVault]'
    }
    if (-not $File) { Fail 'usage: apply <file> -Parts vault,config,desktop [-ReplaceVault]' }
    $File = Get-FullPath $File
    if (-not (Test-Path -LiteralPath $File)) { Fail ('no such file: ' + $File) }
    $passphrase = Read-Passphrase
    Assert-BackupOpens $File $passphrase
    $stage = New-TempDir 'claude-restore-'
    try {
        $wanted = @('manifest.json')
        if ($parts -contains 'vault') { $wanted += 'vault' }
        if ($parts -contains 'config') { $wanted += 'claude-config'; $wanted += 'claude.json' }
        if ($parts -contains 'desktop') { $wanted += 'desktop-data' }
        $r = Invoke-TarFromBackup $File $passphrase (@('-xzf', '-', '-C', $stage) + $wanted)
        if ($r.code -gt 1) { Fail ('could not unpack: ' + (($r.err.Trim() -split "`r?`n")[0])) }
        $manifest = [System.IO.File]::ReadAllText((Join-Path $stage 'manifest.json')) | ConvertFrom-Json
        $name = [string](Get-Prop $manifest 'account')
        if (-not (Test-AccountName $name)) { Fail 'the backup names no valid account' }
        $result = [ordered]@{}
        if ($parts -contains 'desktop') {
            if ((Get-ActiveName) -eq $name -and (Test-AppRunning)) { Fail 'the Claude app is running on this account. Quit it and try again.' }
        }
        if ($parts -contains 'vault') { $result['vault'] = Set-VaultFromFolder (Join-Path $stage 'vault') ([bool]$ReplaceVault) { param($line) } }
        if ($parts -contains 'config') {
            $target = Get-CliConfigDir $name
            $result['config'] = Copy-Missing (Join-Path $stage 'claude-config') $target
            $homeJson = Join-Path (Get-HomeDir) '.claude.json'
            if ($target -eq (Join-Path (Get-HomeDir) '.claude') -and (Test-Path -LiteralPath (Join-Path $stage 'claude.json'))) {
                if (Test-Path -LiteralPath $homeJson) { $result['config'].skipped++ }
                else { Copy-Item -LiteralPath (Join-Path $stage 'claude.json') -Destination $homeJson; $result['config'].copied++ }
            }
        }
        if ($parts -contains 'desktop') {
            if ((Get-ActiveName) -eq $name) { $target = Get-ActiveFolder } else { $target = Get-ParkedFolder $name }
            $result['desktop'] = Copy-Missing (Join-Path $stage 'desktop-data') $target
        }
        return ([ordered]@{ ok = $true; account = $name; parts = $result } | ConvertTo-Json -Compress -Depth 5)
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
