# Shared helpers for the PowerShell command: settings (.env and the environment), the accounts
# list, paths, JSON, gzip, hashes, confirmations and passphrases. Nothing here prints a secret.
# Windows PowerShell 5.1 syntax throughout.
Set-StrictMode -Version 2

$script:Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) # ps\lib -> ps -> the project
$script:AssumeYes = $false # -Yes on the command line: no questions asked (set by the entry script)

# ------------------------------------------------------------------ settings

# The optional .env in the project folder (gitignored). Real environment variables win over it.
function Import-DotEnv {
    $file = Join-Path $script:Root '.env'
    if (-not (Test-Path -LiteralPath $file)) { return }
    foreach ($line in [System.IO.File]::ReadAllLines($file)) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $t.Substring(0, $eq).Trim()
        $value = $t.Substring($eq + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1); $last = $value.Substring($value.Length - 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) { $value = $value.Substring(1, $value.Length - 2) }
        }
        if ($null -eq [Environment]::GetEnvironmentVariable($name)) { [Environment]::SetEnvironmentVariable($name, $value) }
    }
}

function Get-Setting([string]$Name, $Default = $null) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $v -and $v -ne '') { return $v }
    return $Default
}

function Get-HomeDir {
    $h = [Environment]::GetEnvironmentVariable('USERPROFILE')
    if ($h) { return $h }
    return $HOME
}

function Get-FullPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Expand-Home([string]$Path) {
    if ($Path -eq '~') { return (Get-HomeDir) }
    if ($Path -match '^~[\\/]') { return (Join-Path (Get-HomeDir) $Path.Substring(2)) }
    return $Path
}

# ------------------------------------------------------------------ accounts

# A property of a JSON object or a hashtable, or null: strict mode throws on a missing one.
function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -ne $p) { return $p.Value }
    return $null
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    if ($text.Trim() -eq '') { return $null }
    return ($text | ConvertFrom-Json)
}

function Test-AccountName([string]$Name) { return ($Name -match '^[A-Za-z0-9_-]+$') }

# The accounts: accounts.json (hand-edited), then the gitignored .accounts.local.json the dashboard
# adds to. "main" uses the default Claude Code folder, every other account ~/.claude-<name>, unless
# an entry names a folder.
function Get-Accounts {
    $list = @()
    $base = Read-JsonFile (Get-FullPath (Get-Setting 'ACCOUNTS_FILE' (Join-Path $script:Root 'accounts.json')))
    if ($null -eq $base) {
        $base = @(@{ id = 'main'; label = 'Account 1: Main Claude session' }, @{ id = 'test'; label = 'Account 2: Empty test account' })
    }
    foreach ($a in @($base)) {
        $id = [string](Get-Prop $a 'id')
        if (-not (Test-AccountName $id)) { Fail ("invalid account id in accounts.json: " + $id) }
        $label = [string](Get-Prop $a 'label'); if (-not $label) { $label = $id }
        $dir = Get-Prop $a 'cliConfigDir'
        if ($null -eq $dir) { if ($id -eq 'main') { $dir = $null } else { $dir = "~/.claude-$id" } }
        $list += [pscustomobject]@{ id = $id; label = $label; cliConfigDir = $dir }
    }
    $local = Read-JsonFile (Get-FullPath (Get-Setting 'LOCAL_ACCOUNTS_FILE' (Join-Path $script:Root '.accounts.local.json')))
    foreach ($a in @($local)) {
        $id = [string](Get-Prop $a 'id')
        if (-not (Test-AccountName $id)) { continue }
        if (@($list | Where-Object { $_.id -eq $id }).Count -gt 0) { continue }
        $label = [string](Get-Prop $a 'label'); if (-not $label) { $label = $id }
        $dir = $null; if ($id -ne 'main') { $dir = "~/.claude-$id" }
        $list += [pscustomobject]@{ id = $id; label = $label; cliConfigDir = $dir }
    }
    return $list
}

function Get-Account([string]$Name) {
    foreach ($a in (Get-Accounts)) { if ($a.id -eq $Name) { return $a } }
    return $null
}

# Where an account's Claude Code folder is (the account need not be listed: the convention applies).
function Get-CliConfigDir([string]$Name) {
    $a = Get-Account $Name
    $dir = $null
    if ($null -ne $a) { $dir = $a.cliConfigDir } elseif ($Name -ne 'main') { $dir = "~/.claude-$Name" }
    if ($dir) { return (Get-FullPath (Expand-Home $dir)) }
    return (Join-Path (Get-HomeDir) '.claude')
}

function Get-ProtectedAccounts {
    return @(((Get-Setting 'PROTECTED_ACCOUNTS' 'main') -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# ------------------------------------------------------------------- bytes

function ConvertTo-Gzip([byte[]]$Bytes) {
    $ms = New-Object System.IO.MemoryStream
    $gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress, $true)
    $gz.Write($Bytes, 0, $Bytes.Length)
    $gz.Dispose()
    $out = $ms.ToArray()
    $ms.Dispose()
    return ,$out
}

function ConvertFrom-Gzip([byte[]]$Bytes) {
    $in = New-Object System.IO.MemoryStream(,$Bytes)
    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    $out = New-Object System.IO.MemoryStream
    $gz.CopyTo($out)
    $gz.Dispose()
    $r = $out.ToArray()
    $out.Dispose()
    return ,$r
}

function Get-Sha256([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $h = $sha.ComputeHash($Bytes)
    $sha.Dispose()
    return ,$h
}

function ConvertTo-Hex([byte[]]$Bytes) { return ([System.BitConverter]::ToString($Bytes)).Replace('-', '').ToLower() }

function New-RandomBytes([int]$Count) {
    $b = New-Object byte[] $Count
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($b)
    $rng.Dispose()
    return ,$b
}

function Get-Utf8Bytes([string]$Text) { return ,([System.Text.Encoding]::UTF8.GetBytes($Text)) }
function Get-Utf8String([byte[]]$Bytes) { return [System.Text.Encoding]::UTF8.GetString($Bytes) }

# --------------------------------------------------------------------- files

# Owner-only-in-spirit atomic write (a .tmp next to the file, then a rename over it).
function Write-FileAtomic([string]$Path, [byte[]]$Bytes) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllBytes($tmp, $Bytes)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Write-TextFile([string]$Path, [string]$Text) { Write-FileAtomic $Path (Get-Utf8Bytes $Text) }

function Read-TextFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return [System.IO.File]::ReadAllText($Path)
}

# ---------------------------------------------------------------------- time

function Get-IsoNow { return [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }
function Get-KeychainStamp([DateTime]$Time) { return ($Time.ToUniversalTime().ToString('yyyyMMddHHmmss') + 'Z') }

# -------------------------------------------------------------------- output

function Fail([string]$Message) { throw ("Error: " + $Message) }

function Confirm-Action([string]$Question) {
    if ($script:AssumeYes) { return $true }
    if ([Console]::IsInputRedirected) { return $false }
    $answer = Read-Host ($Question + ' [y/N]')
    return ($answer -match '^(y|yes)$')
}

function ConvertFrom-Secure([System.Security.SecureString]$Secure) {
    $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# The passphrase for a backup: typed hidden, or the first line of a piped stdin. Never an argument.
function Read-Passphrase([switch]$Confirm) {
    if ([Console]::IsInputRedirected) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { Fail 'empty passphrase' }
        $pass = $line.TrimEnd("`r")
    } else {
        $pass = ConvertFrom-Secure (Read-Host -AsSecureString 'Passphrase')
        if ($Confirm) {
            $again = ConvertFrom-Secure (Read-Host -AsSecureString 'Repeat passphrase')
            if ($again -ne $pass) { Fail 'the passphrases do not match' }
        }
    }
    if ($Confirm -and $pass.Length -lt 12) { Fail 'the passphrase must be at least 12 characters' }
    if ($pass -eq '') { Fail 'empty passphrase' }
    return $pass
}

# Runs a program with arguments, capturing its output and exit code, without PowerShell turning
# its stderr into errors. Stdin is closed at once.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory = $null) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ($Arguments | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    return @{ code = $p.ExitCode; out = $outTask.Result; err = $errTask.Result }
}
