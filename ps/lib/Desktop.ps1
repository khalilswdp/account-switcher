# Which account the Claude app is on, and the renames that switch it: the same folders and the
# same state file as scripts/lib/desktop.mjs, so either implementation can take over. Nothing is
# copied, deleted or overwritten: only renames, each checking that its target does not exist.
Set-StrictMode -Version 2

function Get-StateDir { return (Get-Setting 'SWAP_STATE_DIR' (Join-Path (Get-HomeDir) '.claude-desktop-accounts')) }
function Get-ActiveFolder { return (Join-Path (Get-SupportDir) 'Claude') }
function Get-ParkedFolder([string]$Name) { return (Join-Path (Get-SupportDir) ('Claude.' + $Name)) }

function Get-ActiveName {
    $f = Join-Path (Get-StateDir) 'active'
    if (-not (Test-Path -LiteralPath $f)) { return '' }
    return ([System.IO.File]::ReadAllText($f)).Trim()
}

function Set-ActiveName([string]$Name) {
    $dir = Get-StateDir
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText((Join-Path $dir 'active'), ($Name + "`n"))
}

# The parked accounts: every "Claude.<name>" folder with a valid name.
function Get-ParkedNames {
    $support = Get-SupportDir
    if (-not (Test-Path -LiteralPath $support)) { return @() }
    $names = @()
    foreach ($d in @(Get-ChildItem -LiteralPath $support -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name.StartsWith('Claude.')) {
            $n = $d.Name.Substring(7)
            if (Test-AccountName $n) { $names += $n }
        }
    }
    return @($names | Sort-Object)
}

function Get-DesktopState {
    $active = Get-ActiveName
    if ($active -eq '') { $active = $null }
    return @{ active = $active; running = (Test-AppRunning); parked = @(Get-ParkedNames) }
}

# The account the app's data folder was last signed in as (an id the app keeps in config.json).
function Get-AppAccountUuid([string]$Folder = $null) {
    if (-not $Folder) { $Folder = Get-ActiveFolder }
    $f = Join-Path $Folder 'config.json'
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    try { $id = Get-Prop ([System.IO.File]::ReadAllText($f) | ConvertFrom-Json) 'lastKnownAccountUuid' } catch { return $null }
    if ($id -is [string] -and $id -ne '') { return $id }
    return $null
}

function Assert-AccountName([string]$Name, [string]$Usage) {
    if (-not $Name) { Fail ("usage: claude-switcher.ps1 " + $Usage + " <name>") }
    if (-not (Test-AccountName $Name)) { Fail 'account name may only use letters, digits, - and _' }
}

function Assert-AppQuit {
    if (Test-AppRunning) { Fail 'Claude desktop is still running. Quit it, wait a few seconds, then run this again.' }
}

function Assert-Initialised {
    $cur = Get-ActiveName
    if ($cur -eq '') { Fail 'not initialised. First run:  claude-switcher.ps1 init <name-of-the-account-currently-signed-in>' }
    return $cur
}

# Records the CURRENT data folder as account <name> (once). Nothing is moved.
function Initialize-Desktop([string]$Name) {
    Assert-AccountName $Name 'init'
    $cur = Get-ActiveName
    if ($cur -ne '') { Fail ("already initialised as '" + $cur + "'") }
    if (-not (Test-Path -LiteralPath (Get-ActiveFolder) -PathType Container)) { Fail ("no Claude data folder found at: " + (Get-ActiveFolder)) }
    Set-ActiveName $Name
    return ("OK: the current Claude data folder is now tracked as '" + $Name + "'.")
}

# Parks the current data folder, so the next launch of the app starts fresh (signed out) as <name>.
function New-DesktopAccount([string]$Name) {
    Assert-AccountName $Name 'new'
    Assert-AppQuit
    $cur = Assert-Initialised
    if ($Name -eq $cur) { Fail ("'" + $Name + "' is already the active account") }
    if (Test-Path -LiteralPath (Get-ParkedFolder $Name)) { Fail ("an account named '" + $Name + "' already exists (parked)") }
    if (-not (Test-Path -LiteralPath (Get-ActiveFolder) -PathType Container)) { Fail 'active folder is missing: launch the app once and sign in before creating another account' }
    if (Test-Path -LiteralPath (Get-ParkedFolder $cur)) { Fail ((Get-ParkedFolder $cur) + ' already exists, refusing to overwrite') }
    Move-Item -LiteralPath (Get-ActiveFolder) -Destination (Get-ParkedFolder $cur)
    Set-ActiveName $Name
    return ("OK: '" + $cur + "' is parked. Now open the Claude app, sign in as '" + $Name + "', then quit it.")
}

# Makes the parked account <name> the active one.
function Use-DesktopAccount([string]$Name) {
    Assert-AccountName $Name 'use'
    Assert-AppQuit
    $cur = Assert-Initialised
    if ($Name -eq $cur) { return ("'" + $Name + "' is already active.") }
    if (-not (Test-Path -LiteralPath (Get-ParkedFolder $Name) -PathType Container)) { Fail ("no parked account named '" + $Name + "' (see: claude-switcher.ps1 status)") }
    if (-not (Test-Path -LiteralPath (Get-ActiveFolder) -PathType Container)) { Fail ("active folder is missing: launch the app once and sign in as '" + $cur + "' before switching") }
    if (Test-Path -LiteralPath (Get-ParkedFolder $cur)) { Fail ((Get-ParkedFolder $cur) + ' already exists, refusing to overwrite') }
    Move-Item -LiteralPath (Get-ActiveFolder) -Destination (Get-ParkedFolder $cur)
    try {
        Move-Item -LiteralPath (Get-ParkedFolder $Name) -Destination (Get-ActiveFolder)
    } catch {
        Move-Item -LiteralPath (Get-ParkedFolder $cur) -Destination (Get-ActiveFolder) # roll back the first rename
        Fail ("switch failed (" + $_.Exception.Message + "); rolled back, '" + $cur + "' is active again")
    }
    Set-ActiveName $Name
    return ("OK: '" + $Name + "' is active, '" + $cur + "' is parked. You can open the Claude app now.")
}
