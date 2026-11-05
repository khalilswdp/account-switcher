# Checks the native pieces on this machine without touching anything of yours: known answers for
# scrypt, an AES-GCM round trip (and a tampered one that must fail), SQLite through winsqlite3.dll,
# and a DPAPI round trip. Run:  powershell -ExecutionPolicy Bypass -File ps\selftest.ps1
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Native.ps1')

$failed = 0
function Check([string]$what, [bool]$ok) {
    if ($ok) { Write-Host ("  ok   " + $what) } else { Write-Host ("  FAIL " + $what) -ForegroundColor Red; $script:failed++ }
}
function Hex([byte[]]$b) { return ([System.BitConverter]::ToString($b)).Replace('-', '').ToLower() }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
Import-Native
Write-Host ("native shim loaded in {0} ms" -f $sw.ElapsedMilliseconds)

# scrypt: RFC 7914 test vectors 2 and 3
$ascii = [System.Text.Encoding]::ASCII
$v2 = [ClaudeSwitcher.Scrypt]::Derive($ascii.GetBytes('password'), $ascii.GetBytes('NaCl'), 1024, 8, 16, 64)
Check 'scrypt RFC 7914 vector 2' ((Hex $v2) -eq 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640')
$sw.Restart()
$v3 = [ClaudeSwitcher.Scrypt]::Derive($ascii.GetBytes('pleaseletmein'), $ascii.GetBytes('SodiumChloride'), 16384, 8, 1, 64)
Check ("scrypt RFC 7914 vector 3 ({0} ms)" -f $sw.ElapsedMilliseconds) ((Hex $v3) -eq '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887')
$sw.Restart()
$v4 = [ClaudeSwitcher.Scrypt]::Derive($ascii.GetBytes('correct horse battery staple'), (New-Object byte[] 16), 32768, 8, 1, 32)
Check ("scrypt with the backup parameters, N=32768, takes {0} ms" -f $sw.ElapsedMilliseconds) ($v4.Length -eq 32)

# AES-256-GCM: round trip in one shot and in pieces, and tampering detected
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$key = New-Object byte[] 32; $rng.GetBytes($key)
$nonce = New-Object byte[] 12; $rng.GetBytes($nonce)
$plain = [System.Text.Encoding]::UTF8.GetBytes('hello, this is a test of the chained GCM path that is longer than two blocks')
$sealed = [ClaudeSwitcher.AesGcm]::Seal($key, $nonce, $plain)
Check 'AES-GCM seal length = plain + 16' ($sealed.Length -eq $plain.Length + 16)
$opened = [ClaudeSwitcher.AesGcm]::Open($key, $nonce, $sealed)
Check 'AES-GCM open gives the plaintext back' ((Hex $opened) -eq (Hex $plain))
$bad = [byte[]]$sealed.Clone(); $bad[5] = $bad[5] -bxor 1
$caught = $false
try { [ClaudeSwitcher.AesGcm]::Open($key, $nonce, $bad) | Out-Null } catch { $caught = $true }
Check 'AES-GCM rejects a changed byte' $caught
$g = New-Object ClaudeSwitcher.AesGcm($key, $nonce, $true)
$parts = @()
$parts += $g.Update($plain[0..4]); $parts += $g.Update($plain[5..40]); $parts += $g.Update($plain[41..($plain.Length - 1)]); $parts += $g.Final($null)
$streamed = [byte[]]($parts + $g.Tag)
$g.Dispose()
Check 'AES-GCM streamed in odd pieces equals one shot' ((Hex $streamed) -eq (Hex $sealed))
$empty = [ClaudeSwitcher.AesGcm]::Open($key, $nonce, [ClaudeSwitcher.AesGcm]::Seal($key, $nonce, (New-Object byte[] 0)))
Check 'AES-GCM handles an empty message' ($empty.Length -eq 0)

# SQLite
$tmp = Join-Path $env:TEMP ('claude-switcher-selftest-' + [guid]::NewGuid().ToString('n') + '.db')
$db = New-Object ClaudeSwitcher.Sqlite($tmp, $false)
$db.Exec("create table cookies(host_key text, name text, encrypted_value blob, creation_utc integer)")
$blob = [byte[]](0x76, 0x31, 0x30, 0xff, 0x00, 0x01)
$db.Query("insert into cookies values (?, ?, ?, ?)", @('claude.ai', 'sessionKey', $blob, [long]13400000000000001)) | Out-Null
$rows = $db.Query("select rowid as id, host_key, name, encrypted_value, creation_utc, hex(encrypted_value) as h from cookies", $null)
Check 'SQLite round trip: one row' ($rows.Count -eq 1)
Check 'SQLite blob bytes intact' ((Hex $rows[0]['encrypted_value']) -eq (Hex $blob))
Check 'SQLite 64-bit integer intact' ($rows[0]['creation_utc'] -eq 13400000000000001)
Check 'SQLite hex() uppercase as in Node' ($rows[0]['h'] -eq '763130FF0001')
$copy = $tmp + '.copy'
$db.Exec("vacuum into '" + $copy.Replace("'", "''") + "'")
$db.Dispose()
Check 'SQLite VACUUM INTO makes a copy' (Test-Path $copy)
$ro = New-Object ClaudeSwitcher.Sqlite($copy, $true)
Check 'SQLite read-only copy reads' ($ro.Query("select count(*) as n from cookies", $null)[0]['n'] -eq 1)
$ro.Dispose()
Remove-Item $tmp, $copy -Force -ErrorAction SilentlyContinue
Write-Host ("  SQLite version " + [ClaudeSwitcher.Sqlite]::Version())

# DPAPI
Add-Type -AssemblyName System.Security
$secret = New-Object byte[] 32; $rng.GetBytes($secret)
$prot = [System.Security.Cryptography.ProtectedData]::Protect($secret, $null, 'CurrentUser')
$back = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, 'CurrentUser')
Check 'DPAPI round trip' ((Hex $back) -eq (Hex $secret))

if ($failed -gt 0) { Write-Host ("{0} check(s) failed" -f $failed) -ForegroundColor Red; exit 1 }
Write-Host 'all checks passed'
