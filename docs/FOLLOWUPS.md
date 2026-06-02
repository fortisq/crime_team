# Follow-ups & Deferments

Open items deferred from the two self-audits (the read-only findings report and the observability audit) and from the observability overhaul's out-of-scope list. Each was **verified against current source** (2026-06-01) — line numbers are accurate as of `d3360ac` but drift as the code changes; treat them as starting points.

Two findings turned out **already resolved** by the observability event rewrite — see [Resolved this cycle](#resolved-this-cycle). A few entries are **design deferments** (deliberate decisions, not bugs) — see [Design deferments](#design-deferments).

> **Status (2026-06-01):** every tracked item below is now ✅ **RESOLVED** — the distribution **B-series** (real NSIS installer, portable resolution, prereq banner) and the final robustness item **`A1b`** (done-emit tombstone + GUI watchdog, hardened against an 8-finding adversarial review) both closed this cycle. The only remaining items are deliberate [design deferments](#design-deferments) (code signing, auto-updater) — not blockers.

Severity = blast radius if it bites · Effort = S (≲1h) / M (a few h) / L (a day+).

## Priority 1 — highest user / safety value

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| A1 | ✅ **RESOLVED.** Orphaned subprocess tree on app exit. **Fixed:** every `node` orchestrator is assigned to a Windows **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so app exit/crash reaps the whole `node`→`openclaw`→`claude`/`git` tree; a `CloseRequested` handler makes it prompt; `cancel_run` now `TerminateJobObject`s (kills the tree, not just `node`). Proven by `kill_on_close_job_reaps_assigned_process_when_handle_drops`. | — | — | `lib.rs` (RunState job, `assign_child_to_job`, `terminate_job`, run() handler) | done |
| A1b | ✅ **RESOLVED.** Dropped `done` emit has no recovery. **Fixed:** the Rust done-handler now writes a durable `runs/<gid>/<runId>.done` tombstone (atomically, before the emit) carrying `{ exitCode, waitError }`; a GUI watchdog (`startDoneWatchdog`, polls `run_done_status` immediately then every 3 s, scoped to the run's pinned group) finalizes the UI from it if the live `orchestrator:done` was dropped. `finishRun` is idempotent (a `finished` guard) so a late live event + the watchdog can't double-finalize, and clears the tombstone on finish; orphans are swept at startup (`sweep_done_tombstones`). Hardened against an 8-finding adversarial review (group-switch mid-run, history-nav race, torn read, startup-window race). | — | — | `lib.rs` (`write_done_tombstone`/`run_done_status`/`clear_run_done`/`sweep_done_tombstones`), `main.js` watchdog | done |
| C2 | ✅ **RESOLVED.** `groups_create` rollback was incomplete. **Fixed:** the rollback closure now also reverts the `perGroupThinking` block and removes the starter `presets/` dir for the failed group (idempotent), so a mid-create failure leaves no orphan config. | — | — | `lib.rs` rollback (`group_id` param) | done |
| C3 | ✅ **RESOLVED.** `groups_edit` workspace change was non-atomic. **Fixed:** it now patches the agent workspaces in `openclaw.json` **first** and commits `groups.json` only on success — a patch failure no longer leaves the group pointing at the new workspace with agents on the old. | — | — | `lib.rs` `groups_edit` | done |

## Priority 2 — robustness / integrity

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| C1 | ✅ **RESOLVED.** Config writes were non-atomic and unlocked. **Fixed:** `write_groups_file`/`write_crime_team_json` go through an `atomic_write` helper (sibling temp + atomic rename — never a torn registry), and a process-wide async `config_lock()` is held for the duration of every mutating command (the 6 `groups_*` mutators + `groups_set_active` + `groups_set_prompt` + the agent-model/thinking settings commands), serializing the `read → patch → write` sequences. | — | — | `lib.rs` `atomic_write`/`config_lock` | done |
| D2 | ✅ **RESOLVED.** Citation guard could verify against the wrong file on a basename collision. **Fixed:** when >1 file could be the target, `verifyCitations` now checks the cited line against **every** candidate — `ambiguous-basename` (with the count) if it fits any, a hard `line-out-of-range` if it fits none — instead of validating against an arbitrary `matches[0]`. A path-qualified citation still resolves uniquely. | — | — | `src/citations.ts` | done |
| A3 | ✅ **RESOLVED.** Unbounded line buffering in the pumps. **Fixed:** both stdout/stderr pumps now go through `pump_lines`, which reads in fixed 8 KB chunks and caps each line at 1 MB (a DoS guard well above any real answer/event line — strips `\r`, flags truncation), so a pathological no-newline blob can't grow an unbounded buffer or flood the webview. | — | — | `lib.rs` `pump_lines`/`MAX_PUMP_LINE` | done |
| A2 | ✅ **RESOLVED.** Inconsistent Node resolution. **Fixed:** extracted a shared `node_bin()` helper (honors `CRIME_TEAM_NODE`, else `node` on PATH); both `run_task` and `run_openclaw` now use it, so a machine without `node` on PATH can be made to work by setting the env var, consistently. | — | — | `lib.rs` `node_bin()` | done |

## Priority 3 — distribution / portability (hand it to another machine)

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| B1 | ✅ **RESOLVED.** `orchestrator_root()` previously hardcoded a personal path. **Fixed** (in the v1-blocker pass, now extended): resolution chain is `CRIME_TEAM_ROOT` env → **bundled resource dir** → exe-relative → CWD walk (dev) → `"."`. The new step 2 finds the installed app's `bin/dist/node_modules` via `RESOURCE_DIR` (set in `setup()` from `app.path().resource_dir()`). Proven end-to-end against the release exe (resource_dir logged, resolves to the bundled root). | — | — | `lib.rs` `orchestrator_root`/`bundled_orchestrator_root`/`RESOURCE_DIR` | done |
| B2 | ✅ **RESOLVED.** **Fixed:** `Crime-Team.ps1` now launches the prebuilt **release** `crime-team-desktop.exe` (no toolchain needed to run), falling back to dev only if no release build exists; `Crime-Team-Dev.ps1` is the explicit `cargo tauri dev` hot-reload script. Both resolve the repo from `$PSScriptRoot`/`CRIME_TEAM_ROOT`. | — | — | `Crime-Team.ps1`, `Crime-Team-Dev.ps1` | done |
| B3 | ✅ **RESOLVED.** **Fixed:** `bundle.resources` now ships `bin/`, `dist/`, and `node_modules/chalk` (zero-dep) — the NSIS installer is self-contained and runs off a fresh checkout-free path (verified: 2.0 MB `Crime Team_0.1.0_x64-setup.exe`, resources stage to `_up_/_up_/`). Node + openclaw remain **external prerequisites** (the app shells out to the user's global openclaw — can't be bundled); a startup `check_prereqs` command + GUI banner surfaces either if missing. **Ships unsigned, no updater** (deliberate v1 scope) — see [Design deferments](#design-deferments). | — | — | `tauri.conf.json`, `lib.rs` `check_prereqs`, `main.js` `checkPrereqs` | done |

## Priority 4 — observability & UX polish

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| E2 | ✅ **RESOLVED.** `--loop` answer panel showed only the last iteration. **Fixed:** the `coder` event now carries its report `text`; the GUI accumulates each iteration's audit answer + Coder report as labeled sections (single-answer runs still render plain), and `loadRun` reconstructs the sections from a saved record's `loopIterations`. | — | — | `events.ts`, `orchestrator.ts`, `main.js` | done |
| E6 | ✅ **RESOLVED.** Per-agent emoji not plumbed to the GUI. **Fixed:** `AgentSetting` gained an `emoji` field populated from the agent's `identity.emoji` in `settings_get`; the GUI caches role→emoji on group load (`loadAgentEmojis`) and `emoji()` prefers it, falling back to the palette. | — | — | `lib.rs` `AgentSetting`/`settings_get`, `main.js` | done |
| E7 | ✅ **RESOLVED.** History-item runIds weren't copyable. **Fixed:** each sidebar run's runId is now click-to-copy (`.run-id-copy`, `stopPropagation` so it doesn't trigger the row's loadRun), with a "copied!" flash. | — | — | `main.js` `refreshRuns` | done |
| E3 | ✅ **RESOLVED** (stderr sink). Added `tracing` + `tracing-subscriber` with a stderr sink (timestamps + levels; level via `CRIME_TEAM_LOG`, default info) initialized in `run()`; the ad-hoc `eprintln!` diagnostics now go through `tracing::warn!/error!`, plus a startup + `run_task` info log. A **persistent file sink** is a follow-up that pairs with a real installer build (visible in dev via the terminal today). | — | — | `Cargo.toml`, `lib.rs` `init_tracing` | done (file sink → distribution) |
| E5 | ✅ **RESOLVED.** Salvage script was rigid. **Fixed:** added `--thinking <level>` (defaults to "high") and `--producer <agentId>` (overrides the group's Producer, e.g. after a model swap) flags. A GUI "re-integrate" button is still a possible nice-to-have. | — | — | `scripts/salvage-integrate.mjs` | done |

## Priority 5 — testing

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| E1 | ✅ **RESOLVED.** No integration tests for the orchestration flow. **Fixed:** `orchestrate()` now accepts an injectable `call` (defaults to the real `callAgent`); `test/orchestrate.test.mjs` drives the full flow with a mocked agent — covering inline answer, parallel dispatch+integrate, retry-on-timeout (asserts `retried`), and all-specialists-failed (asserts `failurePhase`) by reading the persisted RunRecord. | — | — | `orchestrator.ts`, `test/orchestrate.test.mjs` | done |

## Security

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| D1 | ✅ **RESOLVED.** Unused `shell:default` capability. **Fixed:** the shell plugin was 100% unused (no JS `shell` API calls, no Rust usage beyond `init()`), so removed the `shell:default` grant **and** the plugin registration + the `tauri-plugin-shell` dependency — closes the attack surface and drops a dep. | — | — | `capabilities/default.json`, `lib.rs`, `Cargo.toml` | done |

## Resolved this cycle

These appeared in the audits but the **observability overhaul already fixed them** — recorded so they aren't re-filed:

- **D4 — off-roster specialists now get cards.** The event-driven GUI calls `ensureAgentCard`/`setAgent` for any `specialist_started`/`specialist_done` agent regardless of roster (`main.js` `onEvent`), so off-roster specialists no longer sit on "waiting…" forever.
- **D3 — `--run-id` and `--group` both work.** The GUI's run UUID flows through to the record, the soft-cancel marker, and the event stream; **`--group` is now a real one-shot override** (loadConfig override) as of the v1 blocker fixes. (`--resume`'s load-prior-results/skip-succeeded-phases behavior remains **intentionally unimplemented** and is documented as such.)
- **Orchestrator↔GUI string-contract fragility** (first audit, top-5 #4) — replaced by the structured NDJSON event stream; DISPATCH parse-misses and swallowed gateway-restart/auth/identity failures now surface.

## Design deferments

Deliberate decisions, not defects:

- **GUI runs in dual mode** (Rust does *not* pass `--json`), so the log panel keeps the human lines while events drive state. `--json` is a CLI/automation convenience.
- **Emoji** uses a deterministic per-role palette until **E6** plumbs the real per-agent emoji through `settings_get`. *(E6 since resolved — palette is now the fallback.)*
- **v1 installer ships unsigned, no auto-updater** (B3). Code signing (Azure Trusted Signing / an EV cert) and `tauri-plugin-updater` (Ed25519 keypair + hosted `latest.json`) are both real future items, but out of scope for a single-operator desktop tool — the cost/ceremony isn't worth it yet. Unsigned means a one-time SmartScreen "Run anyway"; no updater means rebuild + reinstall to upgrade. Both are easy to add later without breaking the bundle layout.
