# Launches the Crime Team Orchestrator desktop app.
# The desktop shortcut on your Desktop points at this file.
$ErrorActionPreference = "Continue"
$proj = "C:\Users\user\Projects\crime-team-orchestrator"
Set-Location (Join-Path $proj "desktop")
cargo tauri dev
