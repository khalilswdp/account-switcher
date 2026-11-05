# The Windows side of things, mirroring scripts/lib/platform.mjs: where the Claude app keeps its
# data (the package folder of the Store-style app) and its cookie file, the cookie key in "Local
# State" opened with DPAPI, the Claude Code login file, finding, quitting and reopening the app,
# the terminal, tar and staging links. Nothing here prints a secret.
Set-StrictMode -Version 2
Add-Type -AssemblyName System.Security | Out-Null

$script:PackageDir = $null
$script:AppExe = $null
$script:AppExeLooked = $false

# ------------------------------------------------------------------- folders

# The Store-style (MSIX) app's package folder: Windows redirects its %APPDATA% writes into
# <package>\LocalCache\Roaming, and only a process inside the app sees them merged at %APPDATA%.
function Get-PackageDir {
    if ($null -ne $script:PackageDir) { if ($script:PackageDir -eq '') { return $null }; return $script:PackageDir }
    $script:PackageDir = ''
    $local = Get-Setting 'LOCALAPPDATA' (Join-Path (Get-HomeDir) 'AppData\Local')
    $packages = Join-Path $local 'Packages'
    if (Test-Path -LiteralPath $packages) {
        foreach ($d in @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'LocalCache\Roaming\Claude')) { $script:PackageDir = $d.FullName }
        }
    }
    if ($script:PackageDir -eq '') { return $null }
    return $script:PackageDir
}

# Where "<support>\Claude" (active) and "<support>\Claude.<name>" (parked) live.
function Get-SupportDir {
    $s = Get-Setting 'SUPPORT_DIR'
    if ($s) { return (Get-FullPath $s) }
    $pkg = Get-PackageDir
    if ($pkg) { return (Join-Path $pkg 'LocalCache\Roaming') }
    return (Get-Setting 'APPDATA' (Join-Path (Get-HomeDir) 'AppData\Roaming'))
}

# The cookie database inside a data folder: Network\Cookies in current builds, Cookies in older ones.
function Get-CookieFile([string]$Folder) {
    foreach ($rel in @('Network\Cookies', 'Cookies')) {
        $p = Join-Path $Folder $rel
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return (Join-Path $Folder 'Network\Cookies')
}

# ------------------------------------------------------------------ the app

# The app's executable: from the claude:// handler (visible inside the app), the package system,
# or the older installer's place. CLAUDE_DESKTOP_EXE overrides.
function Get-AppExe {
    if ($script:AppExeLooked) { return $script:AppExe }
    $script:AppExeLooked = $true
    $override = Get-Setting 'CLAUDE_DESKTOP_EXE'
    if ($override) { $script:AppExe = $override; return $override }
    $r = Invoke-Native 'reg.exe' @('query', 'HKCU\Software\Classes\claude\shell\open\command', '/ve')
    if ($r.code -eq 0 -and $r.out -match 'REG_SZ\s+"?([^"\r\n]+?\.exe)"?') { $script:AppExe = $Matches[1]; return $script:AppExe }
    if (Get-PackageDir) {
        try {
            $pkg = Get-AppxPackage -Name Claude -ErrorAction Stop | Select-Object -First 1
            if ($pkg) { $script:AppExe = Join-Path $pkg.InstallLocation 'app\Claude.exe'; return $script:AppExe }
        } catch { }
    }
    $older = Join-Path (Get-Setting 'LOCALAPPDATA' '') 'AnthropicClaude\claude.exe'
    if (Test-Path -LiteralPath $older) { $script:AppExe = $older }
    return $script:AppExe
}

function Test-AppExe([string]$Exe, $Known) {
    if (-not $Exe) { return $false }
    $e = $Exe.ToLower()
    if ($Known -and ([System.IO.Path]::GetDirectoryName($e) -eq [System.IO.Path]::GetDirectoryName(([string]$Known).ToLower()))) { return $true }
    return ($e -like '*\windowsapps\claude_*' -or $e -like '*\anthropicclaude\*')
}

# The app's processes as pid/parent pairs. Claude Code's own binary is claude.exe too, so only
# processes running the app's executable count, and only those are ever ended.
function Get-AppProcesses {
    $known = Get-AppExe
    $list = @()
    try { $procs = @(Get-CimInstance Win32_Process -Filter "Name='Claude.exe'" -ErrorAction Stop) } catch { return @() }
    foreach ($p in $procs) {
        if (Test-AppExe ([string]$p.ExecutablePath) $known) { $list += [pscustomobject]@{ pid = [int]$p.ProcessId; parent = [int]$p.ParentProcessId } }
    }
    return $list
}

function Test-AppRunning {
    if (Get-Setting 'SWAP_SKIP_RUNNING_CHECK') { return $false }
    return (@(Get-AppProcesses).Count -gt 0)
}

function Wait-AppGone([int]$Seconds) {
    for ($i = 0; $i -lt $Seconds * 2; $i++) {
        if (-not (Test-AppRunning)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (-not (Test-AppRunning))
}

function Get-AppMainPids {
    $procs = @(Get-AppProcesses)
    $pids = @($procs | ForEach-Object { $_.pid })
    return @($procs | Where-Object { $pids -notcontains $_.parent } | ForEach-Object { $_.pid })
}

# Quits the app: its windows are asked to close; if it only hid to the tray it is ended, with
# its helpers, from a fresh look at the processes.
function Stop-App {
    if (Get-Setting 'SWAP_SKIP_RUNNING_CHECK') { return } # tests: no real app is touched
    if (-not (Test-AppRunning)) { return }
    foreach ($id in (Get-AppMainPids)) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p) { $null = $p.CloseMainWindow() }
    }
    if (Wait-AppGone 6) { return }
    foreach ($id in (Get-AppMainPids)) { Invoke-Native 'taskkill.exe' @('/F', '/T', '/PID', "$id") | Out-Null }
    if (Wait-AppGone 10) { return }
    Fail 'Claude did not quit. Quit it yourself (right-click its tray icon, then Quit) and try again.'
}

# The Store-style app's id, to start it with its package identity.
function Get-AppId {
    $pkg = Get-PackageDir
    $exe = Get-AppExe
    $name = ''
    if ($pkg) { $name = Split-Path -Leaf $pkg } elseif ($exe -and $exe -match '\\WindowsApps\\([^\\]+)') { $name = $Matches[1] }
    $parts = $name -split '_'
    $family = $parts[0] + '_' + $parts[$parts.Length - 1]
    try {
        $app = Get-StartApps -ErrorAction Stop | Where-Object { $_.AppID -like ($family + '!*') } | Select-Object -First 1
        if ($app) { return $app.AppID }
    } catch { }
    return ($family + '!Claude')
}

function Start-App {
    if (Get-Setting 'SWAP_SKIP_RUNNING_CHECK') { return } # tests: no real app is touched
    $exe = Get-AppExe
    $packaged = (Get-PackageDir) -or ($exe -and $exe -like '*\WindowsApps\*')
    if ($packaged) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + (Get-AppId)) | Out-Null; return }
    if ($exe) { Start-Process -FilePath $exe | Out-Null; return }
    Fail 'cannot find the Claude app: set CLAUDE_DESKTOP_EXE to its Claude.exe'
}

# Is this command running inside the Claude app (a shell in its Code tab counts)? Quitting the
# app would end it too. Marker variables first, then the parent chain (a parent born after its
# child is a reused PID and ends the walk).
function Test-InsideApp {
    if ((Get-Setting 'CLAUDE_CODE_ENTRYPOINT') -eq 'claude-desktop' -or (Get-Setting 'CLAUDE_CODE_DESKTOP_APP_VERSION')) { return $true }
    if (Get-Setting 'SWAP_SKIP_RUNNING_CHECK') { return $false } # tests
    $known = Get-AppExe
    try {
        $id = $PID; $born = $null
        for ($i = 0; $i -lt 16 -and $id; $i++) {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
            if (-not $p) { break }
            if ($born -and $p.CreationDate -gt $born) { break }
            if (Test-AppExe ([string]$p.ExecutablePath) $known) { return $true }
            $born = $p.CreationDate
            $id = $p.ParentProcessId
        }
    } catch { }
    return $false
}

# ------------------------------------------------------------- the cookie key

# The 32-byte key a data folder's cookies are encrypted with: "Local State" holds it base64,
# "DPAPI" + a blob only this Windows user can open. -Create gives a folder that has none a fresh
# key, the way the app would.
function Get-SafeStorageKey([string]$Folder, [switch]$Create) {
    $file = Join-Path $Folder 'Local State'
    $state = $null
    if (Test-Path -LiteralPath $file) {
        try { $state = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { Fail ("cannot read " + $file) }
    } elseif (-not $Create) {
        Fail ("no `"Local State`" file in " + $Folder + ": open the Claude app once on this account, quit it, and try again")
    }
    $encoded = Get-Prop (Get-Prop $state 'os_crypt') 'encrypted_key'
    if ($encoded -is [string] -and $encoded -ne '') {
        $raw = [Convert]::FromBase64String($encoded)
        if ($raw.Length -lt 6 -or [System.Text.Encoding]::ASCII.GetString($raw, 0, 5) -ne 'DPAPI') { Fail 'the app data uses an encryption this tool does not know' }
        $blob = New-Object byte[] ($raw.Length - 5)
        [Array]::Copy($raw, 5, $blob, 0, $blob.Length)
        try { return ,([System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')) }
        catch { Fail 'the encryption key in Local State cannot be opened by this Windows user (was the folder copied from another PC or user?)' }
    }
    if (-not $Create) { Fail ("no encryption key in " + $file + ": open the Claude app once on this account, quit it, and try again") }
    $key = New-RandomBytes 32
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($key, $null, 'CurrentUser')
    $value = [Convert]::ToBase64String([byte[]]([System.Text.Encoding]::ASCII.GetBytes('DPAPI') + $protected))
    if ($null -eq $state) { $state = [pscustomobject]@{} }
    $crypt = Get-Prop $state 'os_crypt'
    if ($null -eq $crypt) {
        $state | Add-Member -NotePropertyName 'os_crypt' -NotePropertyValue ([pscustomobject]@{ encrypted_key = $value }) -Force
    } else {
        $crypt | Add-Member -NotePropertyName 'encrypted_key' -NotePropertyValue $value -Force
    }
    if (-not (Test-Path -LiteralPath $Folder)) { New-Item -ItemType Directory -Path $Folder -Force | Out-Null }
    Write-TextFile $file ($state | ConvertTo-Json -Depth 20 -Compress)
    return ,$key
}

# ---------------------------------------------------------- the Claude Code login

# Windows keeps it in .credentials.json inside the config folder. Times are given the way the
# macOS Keychain gives them ("20261104144455Z"), so both implementations compare alike.
function Get-CredentialsFile([string]$ConfigDir) { return (Join-Path (Get-FullPath $ConfigDir) '.credentials.json') }

function Get-CliLoginInfo([string]$ConfigDir) {
    $f = Get-CredentialsFile $ConfigDir
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    return @{ modified = (Get-KeychainStamp (Get-Item -LiteralPath $f).LastWriteTimeUtc) }
}

function Read-CliLogin([string]$ConfigDir) {
    $f = Get-CredentialsFile $ConfigDir
    try { $t = [System.IO.File]::ReadAllText($f) } catch { Fail 'could not read the login file' }
    if ($t.EndsWith("`n")) { $t = $t.Substring(0, $t.Length - 1) }
    return $t
}

function Write-CliLogin([string]$ConfigDir, [string]$Secret, [switch]$Replace) {
    $f = Get-CredentialsFile $ConfigDir
    $dir = Split-Path -Parent $f
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (-not $Replace -and (Test-Path -LiteralPath $f)) { Fail 'the login file already exists' }
    [System.IO.File]::WriteAllBytes($f, (Get-Utf8Bytes $Secret))
}

function Remove-CliLogin([string]$ConfigDir) {
    $f = Get-CredentialsFile $ConfigDir
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
}

function Get-CliLoginDescription([string]$ConfigDir) { return ('file ' + (Get-CredentialsFile $ConfigDir)) }

# ------------------------------------------------------------------ terminal

# Opens a PowerShell window running Claude Code as the account (ConfigDir empty = the default
# folder), in Cwd. Returns the command a person could run by hand instead.
function Open-ClaudeTerminal([string]$Id, [string]$ConfigDir, [string]$Cwd) {
    $parts = @()
    if ($ConfigDir) {
        $q = "'" + $ConfigDir.Replace("'", "''") + "'"
        $parts += ('$env:CLAUDE_CONFIG_DIR=' + $q)
        $parts += ('$env:CLAUDE_SECURESTORAGE_CONFIG_DIR=' + $q)
    }
    $parts += ("Set-Location '" + $Cwd.Replace("'", "''") + "'")
    $parts += 'claude'
    $command = $parts -join '; '
    $saved = @{}
    foreach ($n in @('CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR')) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
    try {
        foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $(if ($ConfigDir) { $ConfigDir } else { $null })) }
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', 'claude') -WorkingDirectory $Cwd | Out-Null
    } finally {
        foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
    }
    return $command
}

# -------------------------------------------------------------- files and tar

function Get-TarExe { return (Join-Path (Get-Setting 'SystemRoot' 'C:\Windows') 'System32\tar.exe') }

# A folder as a junction, a file as a copy (file symlinks need a privilege): tar follows both.
function New-StageLink([string]$Target, [string]$Link) {
    if ((Get-Item -LiteralPath $Target).PSIsContainer) {
        New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    } else {
        Copy-Item -LiteralPath $Target -Destination $Link
    }
}

function Get-FolderBytes([string]$Dir) {
    $total = [long]0
    try {
        foreach ($f in @(Get-ChildItem -LiteralPath $Dir -File -Recurse -Force -ErrorAction SilentlyContinue)) { $total += $f.Length }
    } catch { }
    return $total
}
