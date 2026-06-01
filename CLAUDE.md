# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-agent orchestrator that sits on top of **OpenClaw**. You give it one task; a **Producer** agent plans and dispatches specialist agents in parallel; the Producer integrates their replies into one answer. It is built for multi-project use: each project is a "group" with its own Producer + specialist roster.

The orchestrator never talks to an LLM directly. Every agent turn is a subprocess: `node openclaw.mjs agent --agent <id> --session-key <key> --message <msg> --timeout <s> [--thinking <level>]`. OpenClaw owns auth, models, and the workspace sandbox; this repo just drives it.

## Two codebases, one repo

- **`src/` — the TypeScript orchestrator (the engine).** Compiled to `dist/` with `tsc`, launched via `bin/crime-team.mjs`. This is the audit→dispatch→integrate loop. It only *reads* config; it never creates or edits agents.
- **`desktop/` — the Tauri (Rust) GUI.** `desktop/src-tauri/src/lib.rs` is ~2400 lines and owns everything the TS side doesn't: creating/editing/removing OpenClaw agents, writing system prompts, scanning a project to *propose* a team, settings, and run history. The GUI runs a task by shelling out to `node bin/crime-team.mjs` (same engine, same auth) and scraping its stdout — it does not re-implement orchestration.

When changing orchestration behavior, edit `src/`. When changing group/agent management or the UI, edit `desktop/`.

## Commands

```bash
# Engine (TypeScript)
npm install
npm run build          # tsc → dist/   (REQUIRED after editing src/ — see below)
npm test               # npm run build && node --test  → pure-function unit suite
npm run dev            # tsx src/cli.ts (run unbuilt)
npm link               # put `crime-team` on PATH globally
crime-team "task" --verbose --smart-dispatch --use-coder --loop 3

# Desktop GUI (Tauri/Rust) — from desktop/
cargo tauri dev        # dev window (or run ../Crime-Team.ps1)
cargo tauri build      # release + NSIS installer
# debug exe only: cd desktop/src-tauri && cargo build → target/debug/crime-team-desktop.exe
```

**Tests:** `npm test` runs dependency-free `node:test` suites in `test/` over the pure functions (dispatch parsing, citation guard, `detectNoFindings`, `clampThinking`, group-id helpers). The Rust JSON brace-scanner has `cargo test --lib` unit tests in `desktop/src-tauri/src/lib.rs`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the Node side on push. There is **no** end-to-end test — a real orchestration makes live OpenClaw calls — so still verify whole-pipeline changes by running a task against a group.

**`bin/crime-team.mjs` prefers `dist/cli.js` if it exists, else falls back to `tsx src/cli.ts`.** Because `dist/` exists in normal use, **editing `src/` has no effect on the CLI or the GUI until you `npm run build`.** This is the #1 "my change didn't take" trap.

## Configuration (four files, different owners)

| File | Owner | Holds |
|---|---|---|
| `~/.crime-team/groups.json` | GUI / Rust | active group id, every group's roster, workspaces, `coderAgentId`. **Source of truth for who runs.** |
| `.crime-team.json` (in CWD) | hand-edited / GUI | `perGroupThinking[groupId][role]`, `perAgent` timeouts, `maxParallel`. Read by the TS engine. |
| `~/.openclaw/openclaw.json` | OpenClaw | agent → model map. `agent.ts` reads it to clamp thinking levels. |
| `~/.openclaw/team-prompts/*.md` | GUI | each agent's system prompt (e.g. `crimeos.architect.md`). |

A `producerAgent` key in `.crime-team.json` is **ignored** — the producer always comes from the active group in `groups.json`.

## Group / agent identity model

A group id is a slug (`crimeos`). Agents are stored fully-qualified: `crimeos.architect`. In Producer DISPATCH output and the GUI, the **unprefixed role** (`architect`) is used. `config.ts` converts between them: `fullyQualify(role, groupId)` / `roleOf(agentId, groupId)`. Session keys are `agent:<fully-qualified-id>:<runId>` — one isolated session per (agent, run). The Producer keeps one session across all turns of a run so it sees the plan + every reply when integrating.

## The orchestration flow (`src/orchestrator.ts`)

1. **Producer plans** — kickoff message pins the valid roster and a dispatch directive (or smart-dispatch override).
2. **Parse + validate dispatches** — `parseDispatches` extracts DISPATCH blocks; non-roster targets are dropped.
3. **Parallel dispatch** — specialists run concurrently under a `Semaphore(maxParallel)`. Each ok reply runs through citation verification (`citations.ts`).
4. **Integrate** — each specialist reply is fed to the Producer as its own turn (to stay under the argv cap), then a final "integrate" turn produces the answer.
5. **(opt) Coder** — `--use-coder` hands the integrated audit to the group's Coder agent, which actually edits files. `--loop N` then re-audits the Coder's changes and re-runs Phases 1–4, stopping early on the `AUDIT CLEAN` sentinel.

The audit (Phases 1–4) is read-only analysis; only the Coder phase mutates the workspace, and only via the agent's own tool calls — the orchestrator never reads/writes project files directly.

## Non-obvious behaviors that will bite you

These span multiple files and aren't visible from CLI flags:

- **Run records are group-scoped: `runs/<group-id>/<runId>.json`**, not `runs/<runId>.json`. "Why isn't my run showing?" is almost always the wrong subfolder.
- **DISPATCH is an enforced wire grammar** (`src/dispatch.ts`): `DISPATCH:` / `TASK:` / `CONTEXT:` / `DELIVERABLE:`, blocks separated by a blank line. Markdown-bolded labels are pre-stripped, but any other deviation parses as **zero** dispatches and silently triggers auto-fan-out (every specialist runs — expensive).
- **Keyword heuristics widen dispatch.** With smart-dispatch OFF, "every/all/each specialist" wording in the task forces full-roster enforcement (`hasFullRosterDirective`), auto-adding omitted specialists. Visible only as a `warn` log line.
- **28 KB argv cap on Windows** (`MAX_ARGV_CHARS` in `agent.ts`). Messages over it are truncated with a marker; that's why specialist replies are fed to the Producer one turn at a time instead of in one big message.
- **`thinking: "max"` clamps to `"high"` on non-Opus models** (`clampThinking` in `agent.ts`) — `max` is Anthropic-Opus-only and silently hangs otherwise. The warning goes to **stderr only**; the GUI never shows it.
- **The Coder is excluded from the audit fan-out.** It stays in `specialists[]` but `auditSpecialists()` filters it out of Phases 1–4; it runs only under `--use-coder`.
- **Timed-out specialists retry once at 1.5× the timeout** with a "continue your prior reply" nudge.
- **Soft-cancel via a marker file.** The GUI's `cancel_run_soft` writes `runs/<group-id>/<runId>.cancel`; the orchestrator polls for it between loop iterations and before the Coder phase, then exits cleanly. It's swept on every exit. For the marker path to match, the GUI passes its run UUID to the orchestrator via `--run-id` (`run_task` → `cli.ts`) so the Rust id, the record, and the cancel marker all share one id — before that wiring the marker was written under a UUID the orchestrator never polled, making GUI soft-cancel a no-op.
- **`--group <id>` is a hint, not a switch** (`src/cli.ts`). It validates and prints a note, but the run uses `activeGroupId` from `groups.json`. Persistent switching is done in the GUI / by editing the file.
- **Spawn `node openclaw.mjs` directly, never the `.cmd` shim.** `shell:false` can't invoke `.cmd` on Windows (EINVAL) and `shell:true` reintroduces quoting hazards. Override the openclaw path with `OPENCLAW_BIN`.

### Rust-side landmine

**Never call `openclaw agents delete` from the GUI.** Each agent's `workspace` field points at the user's real **project directory**; `agents delete` "prunes the workspace" and moved a 940 MB project to Trash once. `groups_remove` instead edits `openclaw.json` to drop entries and removes only `~/.openclaw/agents/<id>/`. Preserve this — see the long comment at the top of `groups_remove` in `lib.rs`.

## Recovery

If a run dies mid-integration (e.g. a Defender/EPERM block in Phase 3) but specialist replies were persisted, `node scripts/salvage-integrate.mjs <runId>` replays the ack+integrate turns from the saved `<runId>.json` and writes `finalAnswer` back. It reads the **`.json` record**, not the sibling `.salvage/` dir (the latter is a derived, safe-to-delete dump of loose-file copies).

## GUI ↔ engine contract

The contract is a **structured NDJSON event stream**, not string-scraping. The orchestrator emits one event per line prefixed with `@@CTEVT@@ ` (see `src/events.ts` — `createEmitter`, the `CTEvent` union), *alongside* the human-readable log lines (a `--json` flag suppresses the human half for CLI piping). The Rust shell ([lib.rs](desktop/src-tauri/src/lib.rs)) splits on the sentinel: event lines become an `orchestrator:event` (raw JSON), everything else an `orchestrator:line` (the log panel). The GUI's `onEvent(evt)` ([main.js](desktop/src/main.js)) switches on `evt.type` to drive phase/cards/answer — so a cosmetic log tweak can't silently break the answer panel. **If you add or change an event type, update the `CTEvent` union in `src/events.ts`, the GUI's `onEvent`, and the contract table in [docs/CHANGELOG.md].** Backend config-mutation failures surface as an `op:warning` event → a GUI banner (instead of being swallowed). The run record gained structured failure/provenance fields (`failurePhase`, `failureReason`, `dispatchMode`, per-specialist `exitCode`/`durationMs`) — all optional, so old records still load.
