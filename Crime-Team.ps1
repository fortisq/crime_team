# Launches the Crime Team Orchestrator desktop app (dev build).
# The desktop shortcut on your Desktop points at this file.
$ErrorActionPreference = "Continue"
# Resolve the repo root: CRIME_TEAM_ROOT if set, else this script's own folder
# (the script lives at the repo root). No hardcoded personal path.
$proj = if ($env:CRIME_TEAM_ROOT) { $env:CRIME_TEAM_ROOT } else { $PSScriptRoot }
Set-Location (Join-Path $proj "desktop")
cargo tauri dev
