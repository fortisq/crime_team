---
name: run-crime-team-orchestrator
description: Build, run, smoke-test, and screenshot the crime-team multi-agent orchestrator (TypeScript CLI engine + Tauri desktop GUI). Use when asked to start, launch, build, smoke-test, drive, or take a screenshot of crime-team / the Crime Team Orchestrator desktop app.
---

Multi-agent orchestrator on top of OpenClaw: a CLI engine in `src/` (compiled to `dist/`, launched via `bin/crime-team.mjs`) and a Tauri desktop GUI in `desktop/`. Drive the **engine** with `.claude/skills/run-crime-team-orchestrator/driver.mjs` (builds + launches the real CLI + direct-invokes the dispatch/citation/config modules — no paid agent calls). Drive the **GUI** with `.claude/skills/run-crime-team-orchestrator/gui-screenshot.ps1` (launches the desktop window and PrintWindow-captures it to a PNG).

All paths below are relative to the repo root (`crime-team-orchestrator/`). **Windows-only** — the app uses WebView2, PowerShell, `%APPDATA%\npm\node_modules\openclaw`, and a hardcoded project path in the Rust GUI. There is no Linux path.

## Prerequisites

- **Node.js** (built/tested on v26, npm 11) — on PATH.
- **OpenClaw** installed at `%APPDATA%\npm\node_modules\openclaw\openclaw.mjs` (override with `OPENCLAW_BIN`). Required for *real* runs; the driver does not need it.
- **`~/.crime-team/groups.json`** with at least one group and an `activeGroupId`. `loadConfig()` throws without it.
- **Rust + cargo-tauri** (`cargo`, `cargo-tauri` on PATH) — only to *build* the GUI. The debug exe is already built at `desktop/src-tauri/target/debug/crime-team-desktop.exe`.

Verify the host in one shot:

```powershell
"node $(node -v); openclaw $(Test-Path $env:APPDATA\npm\node_modules\openclaw\openclaw.mjs); groups $(Test-Path $env:USERPROFILE\.crime-team\groups.json)"
```

## Build

```powershell
npm install
npm run build        # tsc -> dist/   (exit 0)
```

GUI — rebuild after any Rust/frontend change (the build script re-embeds `../src`, so frontend edits only reach the exe via a rebuild):

```powershell
cargo build --manifest-path desktop\src-tauri\Cargo.toml   # debug exe; ~40s incremental (verified)
```

For a release build + NSIS installer (*not run this session — ~5-10 min per README*):

```powershell
cd desktop ; cargo tauri build
```

## Run (agent path)

**Engine smoke** — fast, free, deterministic. Builds if needed, launches the real CLI, and direct-invokes the modules recent PRs touch (dispatch parsing, the citation hallucination-guard, group/Coder resolution):

```powershell
node .\.claude\skills\run-crime-team-orchestrator\driver.mjs
# add --build to force `npm run build` first
```

Expect `10/10 checks passed` and exit code 0. Each check prints PASS/FAIL with got/want on failure.

**GUI** — launch the desktop window and screenshot it (PrintWindow, so occlusion/z-order doesn't matter):

```powershell
pwsh -File .\.claude\skills\run-crime-team-orchestrator\gui-screenshot.ps1 -Kill
```

Screenshot lands at `.claude/skills/run-crime-team-orchestrator/gui-shot.png` (override with `-Out`). A good capture shows the group selector + run-history sidebar on the left and the Preset/Angle/task-composer panel (Verbose, Smart dispatch, Use Coder, Run) on the right. **Open the PNG and look** — a blank/white capture means WebView2 hadn't painted (raise `-WaitSec`). Drop `-Kill` to leave the window open.

| harness | drives | cost |
|---|---|---|
| `driver.mjs` | CLI binary + engine internals | free, ~seconds |
| `gui-screenshot.ps1` | desktop GUI render | free, ~10s |
| `crime-team "task"` (below) | full Producer→specialist→integrate pipeline | **real Opus tokens + minutes** |

## Run (human / full pipeline)

A real orchestration run dispatches to live OpenClaw agents — it costs real Opus tokens and takes minutes, so it is **not executed by the smoke driver and was not run in this session**. The flags below are the ones `crime-team --help` documents (that help output *was* run):

```powershell
node .\bin\crime-team.mjs "Survey src/ and list every exported function. No changes." --smart-dispatch --verbose
```

It prints live spinners per agent and the Producer's integrated answer, and writes `runs/<active-group-id>/<runId>.json`. The desktop GUI shells out to this same binary.

## Test

```powershell
npm test    # npm run build && node --test  → 20 checks, exit 0
```

Dependency-free `node:test` suites in `test/` cover the pure functions (dispatch parsing, citation guard, detectNoFindings sentinel, clampThinking clamp, group-id helpers). The Rust JSON brace-scanner has its own unit tests:

```powershell
cargo test --lib --manifest-path desktop\src-tauri\Cargo.toml   # 6 tests, exit 0
```

CI runs the Node side on push/PR via `.github/workflows/ci.yml` (`npm ci` → `npm run build` → `node --test`). Rust tests stay local (a Tauri CI build needs system webkit libs). `driver.mjs` remains the app-level smoke on top of these unit tests.

## Gotchas

- **`dist/` shadows `src/`.** `bin/crime-team.mjs` runs `dist/cli.js` if it exists, else `tsx src/cli.ts`. So editing `src/` changes nothing for the CLI *or the GUI* until you `npm run build`. The driver rebuilds with `--build`.
- **Screenshotting WebView2 needs `PrintWindow(h, hdc, 2)`, not `CopyFromScreen`.** Screen-coordinate capture grabbed whatever window was on top (first attempt photographed a browser). `PW_RENDERFULLCONTENT` (flag `2`) captures the window's own surface regardless of z-order; `SetForegroundWindow` is unreliable and unneeded.
- **The Rust GUI hardcodes the orchestrator root path** as the orchestrator root (`orchestrator_root()` in `desktop/src-tauri/src/lib.rs`). Move the repo and the GUI can't find `bin/crime-team.mjs` or `runs/`.
- **Runs are group-scoped: `runs/<group-id>/<runId>.json`**, never `runs/<runId>.json`. The active group here is `crime-team-orchestra`.
- **`thinking: "max"` silently clamps to `"high"` on non-Opus agents** and only warns to stderr (`clampThinking` in `src/agent.ts`) — invisible in the GUI.

## Troubleshooting

- **`No active group found … groups.json`**: `~/.crime-team/groups.json` is missing/empty. The driver's config checks and any real run need it.
- **GUI screenshot shows the wrong app / a browser**: you have a `CopyFromScreen`-based capture; use `gui-screenshot.ps1` (PrintWindow). Re-run it.
- **`no window after Ns`**: WebView2 was slow to create the frame. Re-run with `-WaitSec 40`.
- **`cargo build` fails with `failed to remove … crime-team-desktop.exe (os error 5)`**: a GUI instance still holds the exe. The screenshot helper's `-Kill` targets the pid it launched, but Tauri can leave a sibling `crime-team-desktop` process behind. Run `Get-Process -Name crime-team-desktop | Stop-Process -Force`, then rebuild.
- **Screenshot is a tiny ~160x28 image**: it captured Tauri's init splash before the window sized up. The helper now polls `GetWindowRect` for a full-size frame before capturing; if you still hit it, the window genuinely never grew — check the app launched.
- **`crime-team.mjs not found` from the GUI**: repo isn't at the hardcoded path above, or `npm run build` was never run.
