# Launches the Crime Team Orchestrator desktop app.
# Prefers a locally-built RELEASE .exe (fast, no Rust/Tauri toolchain needed to
# *run* it). Falls back to the dev build only if no release exe exists yet.
# For the always-hot-reload dev build, use Crime-Team-Dev.ps1.
$ErrorActionPreference = "Continue"
# Resolve the repo root: CRIME_TEAM_ROOT if set, else this script's own folder
# (the script lives at the repo root). No hardcoded personal path.
$proj = if ($env:CRIME_TEAM_ROOT) { $env:CRIME_TEAM_ROOT } else { $PSScriptRoot }
$exe = Join-Path $proj "desktop\src-tauri\target\release\crime-team-desktop.exe"

if (Test-Path $exe) {
  & $exe
} else {
  Write-Host "No release build found at:"
  Write-Host "  $exe"
  Write-Host ""
  Write-Host "Build one (≈5-10 min, one time):"
  Write-Host "  npm install ; npm run build"
  Write-Host "  cd desktop ; cargo tauri build"
  Write-Host ""
  Write-Host "Falling back to the dev build (needs the Rust/Tauri toolchain)..."
  Set-Location (Join-Path $proj "desktop")
  cargo tauri dev
}
