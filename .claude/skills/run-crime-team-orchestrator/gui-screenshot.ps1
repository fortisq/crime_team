# gui-screenshot.ps1 — launch the Tauri desktop GUI, wait for its window to
# render, screenshot just that window to a PNG, and (by default) leave it
# running. This is the agent's handle on the GUI surface: there is no DOM
# automation for WebView2 here, so "drive it" means launch + capture + inspect.
#
# Usage (from repo root):
#   pwsh -File .\.claude\skills\run-crime-team-orchestrator\gui-screenshot.ps1
#   pwsh -File .\.claude\skills\run-crime-team-orchestrator\gui-screenshot.ps1 -Out shot.png -Kill
param(
  [string]$Exe = ".\desktop\src-tauri\target\debug\crime-team-desktop.exe",
  [string]$Out = ".\.claude\skills\run-crime-team-orchestrator\gui-shot.png",
  [int]$WaitSec = 25,
  [switch]$Kill   # kill the GUI after capturing (default: leave it running)
)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  // PrintWindow captures the window's OWN content into an HDC, so the grab is
  // immune to z-order/occlusion — no fighting SetForegroundWindow. Flag 2 =
  // PW_RENDERFULLCONTENT, required for WebView2/Chromium-backed windows.
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Exe)) { throw "GUI exe not found at $Exe — build it first (see SKILL.md Build)." }
$proc = Start-Process -FilePath $Exe -PassThru
Write-Host "launched pid=$($proc.Id), waiting for window…"

$h = [IntPtr]::Zero
for ($i = 0; $i -lt ($WaitSec * 2); $i++) {
  Start-Sleep -Milliseconds 500
  $proc.Refresh()
  if ($proc.HasExited) { throw "GUI exited early (code $($proc.ExitCode)) — check it launches manually." }
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $h = $proc.MainWindowHandle; break }
}
if ($h -eq [IntPtr]::Zero) { if ($Kill) { $proc.Kill() }; throw "no window after ${WaitSec}s" }

[Win]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE

# Tauri shows a tiny init frame (≈160x28) before sizing the real window, so a
# fixed sleep can capture the splash. Poll GetWindowRect until the window
# reaches a sane size, then give WebView2 a moment to paint the page.
$r = New-Object Win+RECT
$w = 0; $hgt = 0
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  [Win]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  if ($w -ge 800 -and $hgt -ge 400) { break }
}
if ($w -lt 800 -or $hgt -lt 400) { if ($Kill) { $proc.Kill() }; throw "window never reached full size (${w}x${hgt})" }
Start-Sleep -Seconds 3

$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
$ok = [Win]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
$gfx.ReleaseHdc($hdc)
$abs = (Resolve-Path -LiteralPath (Split-Path $Out -Parent)).Path
$bmp.Save((Join-Path $abs (Split-Path $Out -Leaf)), [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Host "saved ${w}x${hgt} screenshot (PrintWindow ok=$ok) -> $Out"

if ($Kill) { $proc.Kill(); Write-Host "killed pid=$($proc.Id)" }
else { Write-Host "GUI left running (pid=$($proc.Id)); close it manually or pass -Kill" }
