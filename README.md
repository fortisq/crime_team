# crime-team-orchestrator

Multi-agent orchestrator on top of OpenClaw for the **Crime OS · MERIDIAN//OS** myproject project.

You type one task. Producer plans. Specialists run in **parallel**. Producer integrates. You get one answer.

Replaces the older PowerShell wrapper at `~/.openclaw/bin/crime-team.ps1` with a TypeScript service that:
- Uses Node's `child_process.spawn` (better argv handling than PowerShell + cmd)
- Runs specialists concurrently (`Promise.all` with bounded `maxParallel`)
- Honors per-agent timeouts (Opus surveys get 15 min, QA gets 10)
- Persists every run to `runs/<runId>.json` for review or future resume
- Auto-truncates oversize messages with a marker (instead of crashing)

## Install

```bash
cd C:\Users\user\Projects\crime-team-orchestrator
npm install
npm run build
npm link            # makes `crime-team` available globally on PATH
```

`npm link` registers the bin. After that you can run `crime-team` from any directory.

## Usage

```bash
# basic
crime-team "Survey the existing admin code in myproject — list every reducer, route, and component touched by admin functions. No changes proposed."

# verbose: print specialist replies as they land
crime-team "..." --verbose

# override timeout (default 15 min for Opus agents)
crime-team "..." --timeout 1800

# help
crime-team --help
```

## What you see

```
[info ] runId=team-1780012345
[phase] 1/4 Producer planning
  ✓ producer planning on Opus (28.4s)
[info ] Producer wants 2 specialist(s): architect, frontend
[phase] 2/4 specialists running in parallel
  ✓ architect: Inventory server-side admin reducers… (184.1s)
  ✓ frontend: Inventory admin UI components and pages (162.3s)
[ ok  ] 2/2 specialists returned ok
[phase] 3/4 feeding specialist replies to Producer
[info ] posting architect's reply (12.4KB)
  ✓ producer acknowledging architect (8.1s)
[info ] posting frontend's reply (9.7KB)
  ✓ producer acknowledging frontend (6.4s)
[phase] 4/4 Producer integrating
  ✓ producer integrating (42.1s)

========================================================================
PRODUCER'S INTEGRATED ANSWER
========================================================================
<the merged document>

[ ok  ] done. runId=team-1780012345. total 431.4s.
```

## Config

Drop a `.crime-team.json` in your CWD to override per-agent timeouts and parallelism:

```json
{
  "producerAgent": "producer",
  "defaultTimeoutSec": 900,
  "maxParallel": 3,
  "perAgent": {
    "architect":   { "timeoutSec": 1800 },
    "frontend":    { "timeoutSec": 1200 },
    "art-director":{ "timeoutSec": 600  },
    "qa":          { "timeoutSec": 600  },
    "producer":    { "timeoutSec": 900  }
  }
}
```

`maxParallel` caps how many specialists run at once. Useful if your Max-sub usage window can't sustain N concurrent Opus calls.

## Requires

- Node.js 18+ (you have 22+)
- OpenClaw installed with the 5-agent team (producer / architect / frontend / art-director / qa) configured. See `~\.openclaw\team-prompts\HOW-TO.md`.
- `openclaw.cmd` discoverable on PATH (default install puts it at `%APPDATA%\npm\openclaw.cmd`). Override with `OPENCLAW_BIN=...` env var.

## Desktop GUI

A Tauri-based desktop app lives at `desktop/`. Same orchestrator, with a window:

```powershell
# First time only — build the .exe
cd C:\Users\user\Projects\crime-team-orchestrator\desktop\src-tauri
cargo build                              # ~2-3 min, debug profile

# Launch the GUI
.\target\debug\crime-team-desktop.exe    # or just double-click it
```

For a polished release build with NSIS installer:
```powershell
cd C:\Users\user\Projects\crime-team-orchestrator\desktop
cargo tauri build                        # ~5-10 min, optimized + bundled
# Output: desktop\src-tauri\target\release\bundle\nsis\Crime Team_0.1.0_x64-setup.exe
```

What the GUI gives you over the CLI:
- Persistent **run history sidebar** (loads `runs/*.json` automatically)
- **Live per-agent status cards** (spinner per running specialist, ok/fail when done)
- **Live log panel** with colorized info/phase/ok/warn/error
- **Integrated answer block** at the bottom with a copy button
- Ctrl+Enter to submit, Cancel button for in-flight runs

The GUI launches `node bin/crime-team.mjs` under the hood — same orchestrator, same auth, same parallel dispatch. Just nicer to look at.

## What it doesn't do (yet)

- **No streaming**: you wait for each agent's full reply, no token-by-token.
- **No `--resume`**: stub exists but not implemented. Plan: load `runs/<id>.json`, skip phases that succeeded, re-run from first failure.
- **No tool-approval gating**: agents act freely within their permitted tool profile. If you need confirm-before-write, that's a v0.2 feature.
- **No web UI**: terminal only.

## Architecture decisions (the why)

- **Subprocess `openclaw agent`, not direct WebSocket RPC.** OpenClaw's gateway requires device pairing + scope approval for direct WS calls, which is its own rabbit hole. The CLI bypasses that because it inherits the gateway's local trust. So we shell out to the same CLI but smarter.
- **One session key per (agent, run)**: `agent:<id>:<runId>`. Per-run isolation; specialists don't bleed into prior runs.
- **Producer keeps its session across all turns of one run**: it sees the original plan, each specialist reply, and produces the integration with full context.
- **Reply chunking via multiple turns**: rather than one giant integration message (CLI argv limit), we send each specialist reply as its own turn to Producer, then ask for integration. Cost: N+2 Producer calls instead of 2. Worth it for reliability.
