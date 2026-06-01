# Changelog

## 2026-06-01 — citation guard: handle basename collisions (FOLLOWUPS D2)

The hallucination guard resolved a cited `file:line` by basename and, on a collision (multiple same-named files), validated the line against an arbitrary `matches[0]` — so it could "verify" the wrong file, or falsely fail a real citation whose line happened to be out of range in the pick but valid in the intended file.

- **Fixed (`src/citations.ts`):** when more than one file could be the target, `verifyCitations` now checks the cited line against **every** candidate. It returns `ambiguous-basename` (carrying the candidate count) if the line fits at least one file, and a hard `line-out-of-range` only if it fits none — so a genuine hallucination still trips the guard while a real-but-ambiguous citation isn't falsely failed. A path-qualified citation (`a/dup.ts:8`) still resolves uniquely to a clean `verified`. The report now notes how many files share the name and suggests path-qualifying.
- Test: `basename collision: ambiguous when the line fits some candidate, hard-fail when it fits none`. `npm test` → 29.

## 2026-06-01 — config-mutation integrity (FOLLOWUPS C1/C2/C3)

Hardened the registry-mutation code (the most delicate area — same as the 940 MB-incident rollback) against torn writes, lost updates, and partial failures.

- **C1 — atomic + serialized config writes.** `write_groups_file`/`write_crime_team_json` now go through `atomic_write` (write a sibling temp, then atomic rename over the target), so a crash mid-write can never leave a truncated `groups.json`/`.crime-team.json`. A process-wide async `config_lock()` is held for the whole of every mutating command (the 6 async `groups_*` mutators + `groups_set_active` (now async) + `groups_set_prompt` + the agent model/thinking settings commands), serializing the `read → openclaw patch → write` sequences so overlapping GUI actions can't lost-update or corrupt the registry.
- **C2 — complete `groups_create` rollback.** On a mid-create failure the rollback now also removes the `perGroupThinking` block it wrote to `.crime-team.json` and the starter `presets/` dir (idempotent), so a failed create leaves no orphan config for a group that no longer exists.
- **C3 — atomic `groups_edit` workspace change.** It now patches the agent workspaces in `openclaw.json` **first** and commits `groups.json` only on success — a patch failure no longer leaves the group pointing at the new workspace with its agents still on the old one.
- Tests: new `atomic_write_replaces_target_and_cleans_temp`; `cargo test --lib` → 9. Verified the GUI still launches with the locks + async `groups_set_active`.

## 2026-06-01 — kill orphaned subprocess tree on app exit (FOLLOWUPS A1)

The top remaining audit item: closing the window (or crashing) mid-run left the `node`→`openclaw`→`claude`/`git` tree running detached, **still spending API tokens**, with no UI to find it. Even `cancel_run` only killed `node`, orphaning the grandchildren.

- **Windows Job Object with `KILL_ON_JOB_CLOSE`** (`lib.rs`): a job is created on first run and every spawned `node` is assigned to it (`assign_child_to_job`). The kernel terminates all job members — node and every descendant — when the app's job handle closes, which happens on **graceful exit *or* crash**. This is the crash-proof core fix.
- **`CloseRequested` window handler** makes the teardown prompt (kills the tree the instant the window closes), and **`cancel_run` now `TerminateJobObject`s** so a hard cancel reaps the whole tree, not just `node`.
- Adds `windows-sys` (Windows-only dep; already in the tree). New test `kill_on_close_job_reaps_assigned_process_when_handle_drops` spawns a real `node`, assigns it, drops the handle, and asserts the OS killed it. `cargo test --lib` → 8.

## 2026-06-01 — v1 release-blocker fixes (portability + multi-user)

The release-readiness self-audit returned no-go on 4 hard blockers (3 single-user/single-machine leftovers + 1 irreversible bundle id). Fixed exactly those; the high/med/low tiers stay in [FOLLOWUPS.md](FOLLOWUPS.md).

- **Portable root resolution.** `orchestrator_root()` (`lib.rs`) no longer hardcodes a personal path — it resolves `CRIME_TEAM_ROOT` → exe-relative → CWD walk (fixes all 7 call sites; works on any machine/checkout). `Crime-Team.ps1` uses `$PSScriptRoot`/`CRIME_TEAM_ROOT` instead of the literal path. (A bundled installer that ships `bin/crime-team.mjs` is still a follow-up — FOLLOWUPS B3.)
- **Permanent bundle identifier.** `tauri.conf.json` `identifier` → **`com.crime-team.desktop`** (was `com.dan.crime-team`). For the NSIS target the identifier *is* the Windows uninstall/upgrade key (no separate productCode — confirmed against the Tauri v2 schema), so this is the one irreversible decision; locked before any installer ships.
- **No hardcoded operator name.** All 12 "Dan" occurrences across 7 files are gone. The Producer's **final answer** addresses an optional global `operatorName` (top-level in `groups.json`, read by the TS engine + preserved by Rust writes) with a neutral `"the operator"` default; set `"operatorName": "Dan"` to keep a personal addressee. Setup-time meta-prompts (Rust ×4) + the wizard template use neutral wording.
- **`--group` is a real one-shot override.** `loadActiveGroup`/`loadConfig` take an `overrideGroupId`; `cli.ts` validates then passes `--group` through (dropping the old in-memory mutation that did nothing). Selects that group for the run without persisting.
- Tests: new Rust `orchestrator_root_honors_env_override`; `cargo test --lib` → 7, `npm test` → 28. Verified `--group` selects the right group at the config layer (what `run_started` emits) and the built engine is "Dan"-free.

## 2026-06-01 — observability overhaul (structured event stream)

Acting on the orchestrator's self-run observability audit (~45 findings across the engine, the Rust shell, and the GUI). Replaced the fragile stdout string-scraping with a structured event contract and surfaced what used to fail silently.

### Engine (`src/`)
- **NDJSON event stream** (`src/events.ts`, new): a per-run `runId`-bound emitter writes one event per line prefixed `@@CTEVT@@ `, alongside the human log. Event types: `run_started`, `phase`, `dispatch_planned`, `dispatch_mode`, `specialist_started/done`, `retry`, `citation_check`, `answer`, `coder`, `warn`, `error`, `done`. New `--json` flag emits events only (suppresses human log + spinner).
- **runId collision fixed** — `team-<ms base36>-<rand>` instead of second-precision (two runs in the same second overwrote each other's record).
- **Guarded `persist()`** — a disk error emits an error event instead of crashing the run.
- **RunRecord provenance** — added `dispatchMode` (inline/parallel/auto-fan-out/…), `failurePhase`/`failureReason`, per-specialist `exitCode`/`durationMs`/`retried`, loop-iteration `status`, `citationCheckSkippedReason`. All optional (back-compat).
- **Data-safety (`agent.ts`)**: child `stderr` is no longer folded into the reply (it leaked tooling noise / token fragments into the run record + Producer context) — surfaced as a warn instead; child `env` is now an allow-list, not the full `process.env`; fixed the timeout-kill message (was `+30`, timer is `+120`).
- **Surfaced silent paths**: malformed-but-present `DISPATCH:` that parsed to 0 now warns; a malformed `.crime-team.json` now fails loud (ENOENT still silent); citation-check-disabled (empty workspace) is recorded + warned.

### Desktop (`lib.rs`)
- **Poison-tolerant mutex** (`lock_ok`) across all 10 `RunState` locks — a poisoned lock no longer crashes the process.
- **Sentinel split**: the stdout pump parses `@@CTEVT@@` lines into an `orchestrator:event`; a dropped-event counter logs to stderr; the done-emit failure is always logged.
- **Surfaced 13 swallowed `let _ =`** config-mutation failures (gateway restart ×6, auth copy ×2, set-identity ×2, thinking-config ×3) as `op:warning` events; the prompt-file rename now propagates (a silent miss stripped the agent's prompt). `wait()` failure now carries a distinct `waitError` (vs. a user cancel).

### GUI (`main.js`/`index.html`/`style.css`)
- Event consumer (`onEvent`) replaced the regex/answer-scraping contract; human lines still populate the log.
- Answer safety-net: falls back to the record's saved `finalAnswer` if no `answer` event arrived; reconciles spinning cards on a non-clean exit.
- Visible error/warning **banner** outside the log (loadGroups/presets/run-start failures + `op:warning`); soft-cancel "cancelling…" feedback; exit-code legend (124 = timed out); click-to-copy runId; timeout-retry card state; fixed the `THINKING_LABEL` duplicate-key bug; per-specialist emoji now distinct (was always 🤖); history view shows a collapsed log.

### Tests
- `test/events.test.mjs` (wire format + dual/json modes) and `test/agent-safety.test.mjs` (clampThinking via callback, env allow-list drops secrets). Rust `extract_json_payload` tests unchanged. `npm test` → 28 checks.

### Deltas / notes
- GUI stays in **dual mode** (Rust does not pass `--json`) so the log panel keeps the human lines while events drive state — cleaner than the GUI passing `--json` (which would empty the log). `--json` is a CLI/automation convenience.
- emoji fix is a deterministic per-role palette (pure JS), not the user's wizard-assigned emoji (would need plumbing emoji through `settings_get` — a follow-up).
- Verified end-to-end with a real `--json` inline run (exit 0 → env allow-list does not break openclaw auth; clean event stream; `dispatchMode: "inline"` persisted).
- Remaining deferred items from both self-audits (orphaned-subprocess kill, atomic config writes, distribution story, per-iteration loop answers, integration tests, …) are tracked, verified against source, in [FOLLOWUPS.md](FOLLOWUPS.md).

## 2026-06-01 — self-audit fixes (runId unification, rollback safety, tests)

Acting on a read-only self-audit of the orchestrator + desktop shell. Three
top findings fixed.

### Fixed
- **groups_create rollback no longer uses the banned `openclaw agents delete`.**
  On a mid-create failure the rollback deleted agents whose `workspace` was
  already the user's project dir — the exact command behind the 940 MB
  workspace-to-Trash incident the *remove* paths were hardened against. Rollback
  now mirrors `groups_remove`: drop the entries from `agents.list` via a direct
  `config patch` (both dotted and dashed id forms) and remove only the
  `~/.openclaw/agents/<id>/` home dirs. (`desktop/src-tauri/src/lib.rs`.)
- **One runId end-to-end → GUI soft-cancel actually fires.** `run_task` mints a
  UUID and now passes it to the orchestrator as `--run-id`, so the Rust id, the
  run record, the `.cancel` marker path, and the `runId` on every emitted event
  all share one id. Previously the orchestrator invented its own `team-<epoch>`
  id, so the GUI wrote a cancel marker under a UUID the orchestrator never
  polled — soft-cancel was a confirmed no-op. (`lib.rs`, `src/cli.ts`.)
- **Stale-event bleed killed.** The frontend now pins `activeRun.id` from the
  id `run_task` returns and drops any `orchestrator:line`/`done` event whose
  `runId` ≠ the active run — so buffered stdout from a hard-cancelled run can no
  longer corrupt the next run's log/answer buffer. (`desktop/src/main.js`.)

### Added
- **Concurrent-run guard** in `run_task` — a second run while one is in flight is
  rejected instead of orphaning the first orchestrator. (`lib.rs`.)
- **Crash card reconcile** — on a non-clean exit, `finishRun` marks any still-
  spinning specialist card as failed instead of leaving it on the cyan dot
  forever. (`main.js`.)
- **Test suite + CI.** Dependency-free `node:test` suites in `test/` for the pure
  functions (dispatch grammar, citation guard, `detectNoFindings`,
  `clampThinking`, group-id helpers); `cargo test --lib` unit tests for the Rust
  `extract_json_payload` brace-scanner; `npm test` script; and a GitHub Actions
  workflow (`.github/workflows/ci.yml`) running `npm ci → build → node --test`.
- **`--run-id <id>`** CLI flag to pin a fresh run to a caller-chosen id.
- Project docs: `CLAUDE.md` and a `run-crime-team-orchestrator` skill under
  `.claude/skills/` (build/launch/screenshot harness).

### Notes / deltas from the audit
- The CLI **already parsed `--resume` and fed it to `orchestrate({ runId })`**, so
  the runId fix needed only a new `--run-id` flag (chosen over overloading
  `--resume`, whose load/skip semantics remain unimplemented) plus the Rust call
  passing it — not new plumbing.
- `detectNoFindings` and `clampThinking` were module-private; exported them so
  the unit tests can reach them. No behavior change.
- The angle-bracket-wrapped dispatch id `DISPATCH: <architect>` is **not** a
  supported form — `BLOCK_RE` requires a non-angle leading char, so it parses to
  zero dispatches. (An initial test assumed otherwise and was corrected; the
  `replace(/^<|>$/)` in `dispatch.ts` only trims a stray trailing bracket.)
- **Not verified by a live run:** an end-to-end `--loop` soft-cancel was confirmed
  by source + unit/compile checks only, not by spending tokens on a real
  loop+cancel.

## Phase G
- Opt-in Coder agent with audit→implement loop and soft-cancel.
