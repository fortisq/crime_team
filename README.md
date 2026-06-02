# crime-team-orchestrator

Multi-agent orchestrator on top of OpenClaw for the **Crime OS · MERIDIAN//OS** myproject project.

You type one task. Producer plans. Specialists run in **parallel**. Producer integrates. You get one answer.

Replaces the older PowerShell wrapper at `~/.openclaw/bin/crime-team.ps1` with a TypeScript service that:
- Uses Node's `child_process.spawn` (better argv handling than PowerShell + cmd)
- Runs specialists concurrently (`Promise.all` with bounded `maxParallel`)
- Honors per-agent timeouts (defaults: 30 min for architect/frontend/security, 20 min for qa/art-director/producer; 30 min fallback)
- Persists every run to `runs/<group-id>/<runId>.json` for review or future resume
- Auto-truncates oversize messages with a marker (instead of crashing)

## Install

```bash
cd <your-checkout>   # e.g. C:\Users\you\Projects\crime-team-orchestrator
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

# override timeout (default 30 min per call; per-role defaults in src/config.ts)
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

Drop a `.crime-team.json` in your CWD to set per-group thinking levels (and, optionally, override timeouts/parallelism). The active producer and roster come from `~/.crime-team/groups.json`, **not** this file — a `producerAgent` key here is ignored:

```json
{
  "perGroupThinking": {
    "crimeos": {
      "producer": "high",
      "architect": "high",
      "frontend": "medium",
      "art-director": "low",
      "qa": "medium",
      "security": "max"
    }
  },
  "maxParallel": 5,
  "perAgent": {
    "architect": { "timeoutSec": 1800 }
  }
}
```

`perGroupThinking[<group-id>][<role>]` sets each agent's `--thinking` level (the only thinking config the orchestrator reads). `perAgent`, `defaultTimeoutSec`, and `maxParallel` are optional overrides — omit them for the built-in defaults.

`maxParallel` caps how many specialists run at once. Useful if your Max-sub usage window can't sustain N concurrent Opus calls.

## Requires

- Node.js 18+ (you have 22+). If `node` isn't on PATH (nvm/Volta/fnm, or the GUI launched from a shortcut), set `CRIME_TEAM_NODE=<full path to node>` — both the CLI orchestrator and the desktop app honor it.
- OpenClaw installed with the active group's team configured. The dispatched roster is whatever is in that group's `specialists[]` in `~/.crime-team/groups.json` and **varies per project** (Crime OS ships 5 — architect / frontend / art-director / qa / security — plus the producer). The 6 names in `src/config.ts` `DEFAULT_PER_AGENT` are **timeout fallbacks only**, not the dispatch list — editing them does not change who runs. See `~\.openclaw\team-prompts\HOW-TO.md`.
- `openclaw.cmd` discoverable on PATH (default install puts it at `%APPDATA%\npm\openclaw.cmd`). Override with `OPENCLAW_BIN=...` env var.

## Desktop GUI

A Tauri-based desktop app lives at `desktop/`. Same orchestrator, with a window.

### Building the installer

```powershell
cd <your-checkout>
npm install ; npm run build          # builds the engine to dist/ (bundled into the app)
cd desktop
cargo tauri build                    # ~5-10 min, optimized + bundled
# Output: desktop\src-tauri\target\release\bundle\nsis\Crime Team_0.1.0_x64-setup.exe
```

`cargo tauri build` produces an **NSIS installer** that bundles the orchestrator's
own JavaScript (`bin/`, `dist/`, `node_modules/chalk`) as Tauri resources, so the
installed app finds `crime-team.mjs` no matter where it lands — no dev checkout
required. Run the engine build (`npm run build`) **first**: the installer packs
whatever is in `dist/` at build time.

> **Unsigned build.** v0.1 ships without code signing, so Windows SmartScreen
> shows "Windows protected your PC" on first run — click **More info → Run
> anyway**. (Signing is a future item; see `docs/FOLLOWUPS.md` B-series.)

### Running it

- **Installed:** use the Start-menu / desktop shortcut the installer creates.
- **From a checkout (release):** `Crime-Team.ps1` runs a prebuilt
  `target\release\crime-team-desktop.exe` (no Rust toolchain needed to *run* it),
  and falls back to a dev build if none exists yet.
- **Dev (hot reload):** `Crime-Team-Dev.ps1` runs `cargo tauri dev` — needs the
  full Rust + Tauri toolchain.

Both launchers resolve the repo from `$PSScriptRoot` (or `CRIME_TEAM_ROOT` if set)
— no hardcoded personal path.

### Prerequisites on the target machine

The bundle ships the orchestrator's JS, but it still **runs on the user's Node**
and **drives their globally-installed `openclaw`** — neither can be bundled. On a
fresh machine, install both:

```powershell
# Node.js 18+  →  https://nodejs.org
npm install -g openclaw
```

On startup the app probes for both and shows a **persistent banner** with install
instructions if either is missing, instead of letting the first run fail with a
cryptic spawn error. (If `node` isn't on PATH — nvm/Volta/fnm — set
`CRIME_TEAM_NODE=<full path to node>`.)

### What the GUI gives you over the CLI

- Persistent **run history sidebar** (loads the active group's `runs/<group-id>/*.json` automatically)
- **Live per-agent status cards** (spinner per running specialist, ok/fail when done)
- **Live log panel** with colorized info/phase/ok/warn/error
- **Integrated answer block** at the bottom with a copy button
- Ctrl+Enter to submit, Cancel button for in-flight runs

The GUI launches `node bin/crime-team.mjs` under the hood — same orchestrator, same auth, same parallel dispatch. Just nicer to look at.

## What it doesn't do (yet)

- **No streaming**: you wait for each agent's full reply, no token-by-token.
- **`--resume` does not work as described**: the flag *is* wired, but it reuses the given runId, **overwrites** the existing `runs/<group-id>/<runId>.json`, and re-runs every phase from scratch — it does **not** load prior results or skip succeeded phases. Treat it as "re-run under this id," not resume. (The intended behavior — load `runs/<id>.json`, skip succeeded phases, re-run from first failure — is still unimplemented.) To simply pin a fresh run to a caller-chosen id, use `--run-id <id>` instead (this is how the GUI keeps its run id, record, and cancel marker aligned).
- **No tool-approval gating**: agents act freely within their permitted tool profile. If you need confirm-before-write, that's a v0.2 feature.
- **No web UI**: terminal only.

## Run artifacts & protocols

Behaviors the orchestrator enforces that aren't visible from the CLI flags — these bite if you don't know them.

- **Run records live under `runs/<group-id>/<runId>.json`** — not `runs/<runId>.json`. Every run is scoped to the active group (`config.ts` → `runsDir: runs/<group-id>`). The #1 "why isn't my run showing?" cause is looking in the wrong group's subfolder.
- **Soft-cancel via a `.cancel` marker.** The GUI's Cancel (command `cancel_run_soft`) writes `runs/<group-id>/<runId>.cancel`. The orchestrator polls for it between loop iterations and before the Coder phase, then exits cleanly instead of hard-killing. CLI users can stop a `--loop` run cleanly by creating that file by hand; the orchestrator deletes it on the way out. (`src/orchestrator.ts`.) For the GUI this only works because `run_task` now passes its run UUID through as `--run-id`, so the marker it writes is the one the orchestrator polls — previously the two used different ids and GUI soft-cancel silently did nothing.
- **`.salvage/` directories are recovery dumps.** A `runs/<group-id>/<runId>.salvage/` folder holds loose-file copies of one run — `00-task.md` (the task) plus one `ok-<agent>.md` per successful specialist reply. The authoritative record is still the sibling `<runId>.json`, which already contains the task and every reply; the `.salvage/` dump is derived and safe to delete (you only lose the loose copies). To actually re-integrate a run that died mid-integration (e.g. a Defender/EPERM block in Phase 3), run `node scripts/salvage-integrate.mjs <runId>` — note it reads the **`.json` record**, *not* the `.salvage/` dir, and writes `finalAnswer` back.
- **Dispatch is an enforced wire protocol.** Producer requests specialists by emitting blocks in this exact grammar:

  ```
  DISPATCH: <agent-id>
  TASK: <one-line summary>
  CONTEXT: <files/sections to read>
  DELIVERABLE: <what they produce>
  ```

  Blocks are separated by a blank line or the next `DISPATCH:`. Markdown-bolded labels (`**DISPATCH:**`) are tolerated (pre-stripped), but any other deviation parses as **zero** dispatches and silently triggers the auto-fan-out path — every specialist runs, which is expensive. (`src/dispatch.ts`.)
- **Keyword heuristics silently widen dispatch.** With Smart Dispatch OFF, phrases like "every / all / each specialist" in the task (or a preset's wording) flip the run into full-roster enforcement: the orchestrator auto-adds any specialist the Producer omitted. The trigger is the task's wording, and the substitution shows up only as a `warn` log line — invisible in the run record's plan. (`src/orchestrator.ts`.)
- **`thinking: "max"` clamps to `"high"` on non-Opus models.** `max` is Anthropic-Opus-only; on any other model the orchestrator downgrades to `high` to avoid a silent claude-cli hang. The warning is written to **stderr only** — the GUI never surfaces it, so a Sonnet/Gemini agent you set to `max` is really running `high`. (`src/agent.ts`.)
- **Timed-out calls retry once at 1.5× the timeout.** A specialist that times out is retried a single time with `Math.round(timeout * 1.5)`. Budget for it when tuning `--timeout`. (`src/orchestrator.ts`.)
- **`--group <id>` is a one-shot override.** The CLI validates the id, then runs that group for this invocation only (via `loadConfig(overrideGroupId)`) — it does **not** persist; the on-disk `activeGroupId` is untouched. To change the default group, set the active group in the GUI (or edit `groups.json`). (`src/cli.ts`.)
- **The Coder is excluded from the audit fan-out.** A group's optional `coderAgentId` stays in `specialists[]` but `auditSpecialists()` filters it out of Phases 1–4; it runs only in the Coder phase under `--use-coder`. (`src/config.ts`.)

## Architecture decisions (the why)

- **Subprocess `openclaw agent`, not direct WebSocket RPC.** OpenClaw's gateway requires device pairing + scope approval for direct WS calls, which is its own rabbit hole. The CLI bypasses that because it inherits the gateway's local trust. So we shell out to the same CLI but smarter.
- **One session key per (agent, run)**: `agent:<id>:<runId>`. Per-run isolation; specialists don't bleed into prior runs.
- **Producer keeps its session across all turns of one run**: it sees the original plan, each specialist reply, and produces the integration with full context.
- **Reply chunking via multiple turns**: rather than one giant integration message (CLI argv limit), we send each specialist reply as its own turn to Producer, then ask for integration. Cost: N+2 Producer calls instead of 2. Worth it for reliability.
