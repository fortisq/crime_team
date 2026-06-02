# Changelog

## 2026-06-02 — hotfix: installed app crashed at every run (`EISDIR: lstat 'C:'`)

The B1/B3 distribution work shipped a release/installed app that **could not run a task at all**. `orchestrator_root()` returned the value of Tauri's `resource_dir()`, which on Windows is a **verbatim** path (`\\?\C:\…`). `run_task` then spawned `node \\?\C:\…\bin\crime-team.mjs`, and Node's main-module resolver (`realpathSync`) chokes on the `\\?\` prefix — `Error: EISDIR: illegal operation on a directory, lstat 'C:'` — before any engine code runs.

- **Fix:** `orchestrator_root()` now strips the verbatim prefix (`strip_verbatim_prefix`: `\\?\C:\…` → `C:\…`, `\\?\UNC\h\s` → `\\h\s`) so every path handed to `node` (script + cwd) is plain. Dev builds were unaffected (they resolve the root via the CWD walk, which is already plain) — the bug was release/installed-only, which is why it slipped past the earlier "renders + resolves" check.
- **Now actually verified end-to-end:** reproduced the exact crash with a `\\?\` script path, then replicated `run_task`'s spawn (plain bundled bin + bundled cwd) and confirmed the engine launches and runs (emits `run_started` → `plan`, spawns openclaw) with no EISDIR. New `cargo test` `strip_verbatim_prefix_unwraps_tauri_paths`; `cargo test --lib` → 14. Release exe + NSIS installer rebuilt.

## 2026-06-01 — real, phase-skipping `--resume` (was a documented no-op)

`--resume <id>` was wired but did nothing useful — it just reused the id for a from-scratch run that **overwrote** the saved record (a footgun: resuming a finished run destroyed it). It now actually resumes.

- **Reuse what succeeded, re-run only the gaps.** `orchestrate()` loads the saved record and skips completed phases: the Producer plan + dispatch list (skips the planning call and dispatch enforcement), each **OK** specialist reply (only failed/missing specialists are re-dispatched — a run that died at integration re-runs **zero** specialists, just re-acks + re-integrates), the integrated answer, the Coder report, and fully-completed loop iterations (replayed; the loop continues from the first incomplete one). `runAuditPhases` gained a `priorAudit` param driving the reuse; `cli.ts` passes `resume` distinctly from a bare `--run-id` pin.
- **Never clobbers a clean run** — resuming a complete run is a no-op (every phase is individually skipped). A missing/corrupt record warns and falls back to a fresh run.
- **Honors the resumed invocation's flags** — provenance (`usedCoder`/`loopMax`/`coderResult`/`loopIterations`) is reconciled to the current flags so an audit-only resume of a prior Coder run doesn't persist stale Coder state.
- **Hardened against a 9-finding adversarial self-review** (3-lens review workflow → per-finding verification): require a non-empty saved plan before reuse (no empty-plan corruption); positional specialist-result merge (duplicate-role dispatches aren't collapsed); respect a reduced `--loop` on resume; reconcile the provenance flags above. (Two findings correctly skipped: the "lost completed iteration" was impossible given sequential execution; a changed `--smart-dispatch` on resume is intentionally ignored — resume continues, it doesn't re-plan.)
- 5 new resume tests in `test/orchestrate.test.mjs` (reuse-on-integration-failure, re-run-only-failed-specialist, completed-run-no-clobber, audit-only-clears-coder-provenance, missing-record-fresh-fallback). `npm test` → 38.

## 2026-06-01 — run-completion tombstone + GUI watchdog so a dropped done event can't hang the UI (FOLLOWUPS A1b)

The single `orchestrator:done` event is what un-sticks the UI when a run ends. If it was dropped (webview reload race, a listener torn down for an instant, an emit error) the GUI spun on "running" forever — the only trace was a `tracing::error!`.

- **Durable tombstone (Rust).** The done-handler now writes `runs/<group-id>/<run_id>.done` — `{ runId, exitCode, waitError }` — **before** emitting, via the existing `atomic_write` (temp + rename) so a poller never sees a torn file. The Rust handler fires on *process exit* regardless of whether the orchestrator wrote a clean record, so it's the authoritative "the run ended" signal.
- **GUI watchdog.** `startDoneWatchdog(runId, groupId)` polls `run_done_status` immediately, then every 3 s; if the tombstone appears while the UI still thinks the run is live, it calls `finishRun` (which already back-fills the answer from `get_run`). `finishRun` is now idempotent (a `finished` guard) so a late live event + the watchdog can't double-finalize; it clears the tombstone on finish, and `sweep_done_tombstones` clears orphans at startup.
- **Hardened against an 8-finding adversarial self-review** (a 3-lens review workflow → per-finding verification): the watchdog pins the run's group so a mid-run active-group switch can't mis-locate the tombstone (`run_done_status`/`clear_run_done` take an explicit `group_id`); `loadRun` stops the watchdog and marks a loaded historical record `finished` so navigating to history mid-run is clean; `run_done_status` validates the embedded `runId` and, on a (now-impossible) torn read, un-sticks the UI with an honest `waitError` rather than a false "stopped"; the watchdog's immediate first poll closes the run-finishes-before-first-tick window.
- New commands `run_done_status` / `clear_run_done` / `sweep_done_tombstones` (registered). Tests `run_artifact_path_in_builds_grouped_and_flat`, `done_tombstone_round_trips_through_disk`. `cargo test --lib` → 13; `npm test` → 33; debug GUI launches and renders.

## 2026-06-01 — real NSIS installer: bundle the orchestrator, portable resolution, prereq banner (FOLLOWUPS B1/B2/B3)

The desktop app can now be installed and run on a machine that isn't the dev checkout. **Ships unsigned, no auto-updater, graceful prerequisite check** (deliberate v1 scope).

- **B3 — bundle the orchestrator.** `tauri.conf.json` `bundle.resources` now ships the engine's own JS — `bin/`, `dist/`, and `node_modules/chalk` (chalk is zero-dep, so it's self-contained). The NSIS installer is therefore self-running; verified it produces a lean **2.0 MB** `Crime Team_0.1.0_x64-setup.exe`. (WebView2 is a system runtime, not bundled; **Node + openclaw stay external** — the app shells out to the user's global openclaw, which can't be bundled.)
- **B1 — portable resolution.** `orchestrator_root()` gained a **bundled-resources** step: `RESOURCE_DIR` (a `OnceLock` set in `setup()` from `app.path().resource_dir()`) → the extracted, unit-tested `bundled_orchestrator_root()` finds `bin/dist/node_modules`. Tauri encodes the `../../` resource prefix as `_up_/_up_`, so the bundled root is `<resource_dir>/_up_/_up_/` — checked first, with a flattened fallback. Proven against the **release exe** from a neutral CWD: the tracing log shows `resource_dir = …\target\release`, and resolution lands on the bundled root via that branch (not the dev CWD-walk). Full chain: `CRIME_TEAM_ROOT` → bundled → exe-relative → CWD walk → `"."`.
- **B3 — graceful prereq check.** New `check_prereqs` Tauri command probes Node (`node --version`) + openclaw (`openclaw.mjs` presence); the GUI calls it on startup (`checkPrereqs`) and shows a **persistent banner** with install instructions (`npm install -g openclaw`, nodejs.org) if either is missing — instead of letting the first run die at spawn. Confirmed no banner fires when both are present.
- **B2 — release-first launcher.** `Crime-Team.ps1` now runs the prebuilt `target\release\crime-team-desktop.exe` (no Rust toolchain needed to *run* it), falling back to dev only if no release build exists; `Crime-Team-Dev.ps1` is the explicit `cargo tauri dev` hot-reload script. Both resolve the repo from `$PSScriptRoot`/`CRIME_TEAM_ROOT`.
- **Unsigned + no updater** are documented as design deferments (one-time SmartScreen "Run anyway"; rebuild-to-upgrade). README's Desktop GUI section rewritten with build/run/prereq guidance.
- New test `bundled_root_resolves_up_up_and_flat_layouts`. `cargo test --lib` → 11; `npm test` → 33; release build + installer produced; release GUI launches and resolves via the bundle.

## 2026-06-01 — per-iteration loop answers + Rust tracing + real per-agent emoji (FOLLOWUPS E2/E3/E6)

- **E2 — per-iteration `--loop` answers.** The `coder` event now carries its report `text`, and the GUI accumulates each iteration's audit answer + Coder report as labeled sections (`═══ Audit answer — iteration N ═══` / `═══ Coder (role) ═══`) instead of the last `answer` event silently overwriting the rest. A single-answer run still renders plain; `loadRun` reconstructs the sections from a saved record's `loopIterations`.
- **E3 — Rust structured logging.** Added `tracing` + `tracing-subscriber` with a stderr sink (timestamps + levels; level via `CRIME_TEAM_LOG`, default info), initialized in `run()`; the ad-hoc `eprintln!` diagnostics (dropped-event counter, failed `done` emit) now go through `tracing::warn!/error!`, plus a startup and `run_task` info log. In dev this surfaces in the terminal; a persistent file sink pairs with a real installer build (distribution follow-up).
- **E6 — real per-agent emoji.** `AgentSetting` gained an `emoji` field populated from the agent's `identity.emoji` in `settings_get`; the GUI caches role→emoji on group load (`loadAgentEmojis`) and `emoji()` prefers the operator's wizard-assigned icon, falling back to the deterministic palette.
- `npm test` → 33; `cargo build`/`cargo test --lib` → 10; GUI launches.

## 2026-06-01 — orchestration integration tests + salvage flags + copyable history runIds (FOLLOWUPS E1/E5/E7)

- **E1 — integration tests for `orchestrate()`.** Added an injectable `call` to `OrchestratorOpts` (threaded through the audit helpers; defaults to the real `callAgent`) so the full flow is testable without spawning openclaw. `test/orchestrate.test.mjs` exercises the paths the audit flagged: inline answer (`dispatchMode: "inline"`), parallel dispatch + integrate (2 specialists → integrated answer), retry-on-timeout (a specialist returns exitCode −1, is retried once, recorded `retried: true`), and all-specialists-failed (exit 1, `failurePhase: "all-specialists-failed"`) — each asserting the persisted RunRecord. `npm test` → 33.
- **E5 — salvage flags.** `scripts/salvage-integrate.mjs` gained `--thinking <level>` (defaults to "high") and `--producer <agentId>` (overrides the group's Producer, e.g. after a model swap) instead of hardcoding `thinking:"high"`.
- **E7 — copyable history runIds.** Each run in the history sidebar now has a click-to-copy runId (`stopPropagation` so it doesn't trigger the row's load), matching the active-run runId chip.

## 2026-06-01 — cap per-line buffering in the stream pumps (FOLLOWUPS A3)

The stdout/stderr pumps used `BufReader::lines()`/`next_line()`, which read to `\n` with no cap — a pathological multi-MB no-newline blob (a binary dump, a runaway log) would accumulate into one unbounded `String` and then flush to the webview in a single shot.

- Replaced both pumps with a `pump_lines` helper that reads in fixed 8 KB chunks, splits on `\n` (stripping a trailing `\r` to match `next_line`), and caps each emitted line at **1 MB** — a DoS guard sized far above any legitimate line (the `@@CTEVT@@` answer event is large but bounded, well under the cap), so real content is never truncated; only a pathological over-long line is cut, flagged `[line truncated at 1 MB]`. The stdout pump keeps its sentinel event-split + drop counter; stderr stays line-only.
- Test: `pump_lines_caps_long_lines_and_splits_on_newlines`. `cargo test --lib` → 10; GUI still launches.

## 2026-06-01 — consistent Node resolution (FOLLOWUPS A2)

`run_task` spawned a bare `Command::new("node")` while `run_openclaw` honored `CRIME_TEAM_NODE` — so on a machine without `node` on PATH (e.g. nvm/Volta/fnm, or launched from a shortcut), every run failed at spawn even though the env-var escape hatch existed for the other path.

- Extracted a shared `node_bin()` helper (`CRIME_TEAM_NODE` → else `"node"`); both `run_task` and `run_openclaw` (via `openclaw_bin`) now resolve Node through it, so setting `CRIME_TEAM_NODE=<path-to-node>` reliably fixes a missing-PATH install. `cargo build`/`cargo test --lib` (9) clean.

## 2026-06-01 — drop unused shell plugin (FOLLOWUPS D1)

The `shell:default` capability let the JS frontend invoke shell/process commands, but nothing used it — all spawning is in trusted Rust. Pure attack surface if local content were ever compromised.

- Verified the shell plugin is 100% unused (no `shell` JS API calls; the only Rust reference was `tauri_plugin_shell::init()`), then removed all three: the `shell:default` grant (`capabilities/default.json`), the plugin registration (`lib.rs`), and the `tauri-plugin-shell` dependency (`Cargo.toml`). The Tauri ACL manifests under `gen/schemas/` regenerated accordingly.
- The `dialog` plugin (the directory picker in `groups_browse_directory`) is untouched. `cargo build`/`cargo test --lib` (9) clean; GUI still launches.

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
