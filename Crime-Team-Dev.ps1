# Launches the Crime Team Orchestrator desktop app in DEV mode (hot reload).
# Requires the full Rust + Tauri toolchain. For day-to-day use prefer
# Crime-Team.ps1, which runs a prebuilt release exe.
$ErrorActionPreference = "Continue"
# Resolve the repo root: CRIME_TEAM_ROOT if set, else this script's own folder.
$proj = if ($env:CRIME_TEAM_ROOT) { $env:CRIME_TEAM_ROOT } else { $PSScriptRoot }
Set-Location (Join-Path $proj "desktop")
cargo tauri dev
