# Follow-ups & Deferments

Open items deferred from the two self-audits (the read-only findings report and the observability audit) and from the observability overhaul's out-of-scope list. Each was **verified against current source** (2026-06-01) — line numbers are accurate as of `d3360ac` but drift as the code changes; treat them as starting points.

Two findings turned out **already resolved** by the observability event rewrite — see [Resolved this cycle](#resolved-this-cycle). A few entries are **design deferments** (deliberate decisions, not bugs) — see [Design deferments](#design-deferments).

Severity = blast radius if it bites · Effort = S (≲1h) / M (a few h) / L (a day+).

## Priority 1 — highest user / safety value

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| A1 | ✅ **RESOLVED.** Orphaned subprocess tree on app exit. **Fixed:** every `node` orchestrator is assigned to a Windows **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so app exit/crash reaps the whole `node`→`openclaw`→`claude`/`git` tree; a `CloseRequested` handler makes it prompt; `cancel_run` now `TerminateJobObject`s (kills the tree, not just `node`). Proven by `kill_on_close_job_reaps_assigned_process_when_handle_drops`. | — | — | `lib.rs` (RunState job, `assign_child_to_job`, `terminate_job`, run() handler) | done |
| A1b | **Dropped `done` emit has no recovery.** If the `orchestrator:done` emit fails (frontend gone), it's only `eprintln!`'d; the UI can hang. | MED | S | `lib.rs` done-handler | Write a `runs/<gid>/<runId>.done` tombstone the frontend can poll as a fallback watchdog. |
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
| B1 | `orchestrator_root()` **hardcodes** `C:\Users\user\Projects\crime-team-orchestrator`. Move the repo and the GUI can't find `bin/crime-team.mjs` or `runs/`. | MED | S | `lib.rs:98` | Resolve from a bundled/known relative path or an env var; fall back to the CWD walk already present. |
| B2 | Launcher `Crime-Team.ps1` runs `cargo tauri dev` (debug build needing the full Rust/Tauri toolchain). | LOW | S | `Crime-Team.ps1:6` | Ship/launch a release `.exe`; keep `dev` as a separate dev script. |
| B3 | `bin/crime-team.mjs` (+ Node) **not bundled**; the NSIS target ships only icons, so the installer wouldn't actually run. No signing/updater. | MED | M | `tauri.conf.json:29-38` | Bundle the orchestrator via `externalBin`/`assets` (or document the Node prerequisite); decide the distribution story (dev-only vs. a real installer). |

## Priority 4 — observability & UX polish

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| E2 | **`--loop` answer panel shows only the last iteration.** Each `answer` event overwrites `activeRun.answer`; per-iteration answers + Coder reports aren't separately viewable. (Better than the old concatenation, but lossy.) | MED | M | `src/orchestrator.ts:549,691` → `main.js:423` | Key answers by `evt.iteration`; render an accordion/section per iteration. |
| E6 | **Per-agent emoji not plumbed to the GUI.** `AgentSetting` has no `emoji` field, so the GUI can't show the wizard-assigned emoji — it falls back to a derived palette (this overhaul) instead of the user's choice. | LOW | M | `lib.rs:2069-2084`, `settings_get` `:2122` | Add `emoji` to `AgentSetting`, populate it in `settings_get`, cache role→emoji in the GUI. |
| E7 | ✅ **RESOLVED.** History-item runIds weren't copyable. **Fixed:** each sidebar run's runId is now click-to-copy (`.run-id-copy`, `stopPropagation` so it doesn't trigger the row's loadRun), with a "copied!" flash. | — | — | `main.js` `refreshRuns` | done |
| E3 | **No structured logging in Rust.** Everything is stringly-typed `Result<_, String>`; no `tracing`/`log`, no timestamps/levels/file sink. Long errors get sliced to 200–400 chars in the GUI. | LOW | S | `Cargo.toml`, `lib.rs` throughout | Add `tracing-subscriber` with a stderr/file sink; `#[instrument]` the command handlers. |
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
- **Emoji** uses a deterministic per-role palette until **E6** plumbs the real per-agent emoji through `settings_get`.
