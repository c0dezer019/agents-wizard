# Installer for agents-wizard on Windows. Symlinks agents-wizard.js into a
# bin dir on PATH so `wizard` runs from anywhere.
#
# Usage:
#   .\install.ps1
#   .\install.ps1 -InstallDir "C:\tools\bin"
#
# Creating a real symlink needs Developer Mode enabled or an elevated
# (Run as Administrator) shell. Without either, this falls back to a
# wizard.cmd shim that calls node on the target script — works the same,
# just not a literal symlink.

param(
    [string]$InstallDir = "$env:USERPROFILE\bin"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $ScriptDir "agents-wizard.js"

if (-not (Test-Path $Target)) {
    Write-Error "agents-wizard.js not found in $ScriptDir"
    exit 1
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$LinkJs = Join-Path $InstallDir "wizard.js"
$LinkCmd = Join-Path $InstallDir "wizard.cmd"

# Clean up whichever form exists from a previous install.
Remove-Item -Force -ErrorAction SilentlyContinue $LinkJs
Remove-Item -Force -ErrorAction SilentlyContinue $LinkCmd

$usedSymlink = $false
try {
    New-Item -ItemType SymbolicLink -Path $LinkJs -Target $Target -ErrorAction Stop | Out-Null
    $shim = "@echo off`r`nnode `"$LinkJs`" %*`r`n"
    Set-Content -Path $LinkCmd -Value $shim -NoNewline
    $usedSymlink = $true
    Write-Host "Linked: $LinkJs -> $Target"
} catch {
    # No Developer Mode / not elevated. Fall back to a shim that points
    # straight at the real script -- functionally identical to the user.
    $shim = "@echo off`r`nnode `"$Target`" %*`r`n"
    Set-Content -Path $LinkCmd -Value $shim -NoNewline
    Write-Host "Symlink not permitted (needs Developer Mode or admin)."
    Write-Host "Installed shim instead: $LinkCmd -> $Target"
}

$pathEntries = $env:PATH -split ';'
if ($pathEntries -notcontains $InstallDir) {
    Write-Host ""
    Write-Host "warning: $InstallDir not on PATH. Add it:"
    Write-Host "  setx PATH `"$InstallDir;`$env:PATH`""
    Write-Host "(then restart your terminal)"
}

Write-Host "Run 'wizard' to start."
