# Follow-ups & Deferments

Open items deferred from the two self-audits (the read-only findings report and the observability audit) and from the observability overhaul's out-of-scope list. Each was **verified against current source** (2026-06-01) — line numbers are accurate as of `d3360ac` but drift as the code changes; treat them as starting points.

Two findings turned out **already resolved** by the observability event rewrite — see [Resolved this cycle](#resolved-this-cycle). A few entries are **design deferments** (deliberate decisions, not bugs) — see [Design deferments](#design-deferments).

Severity = blast radius if it bites · Effort = S (≲1h) / M (a few h) / L (a day+).

## Priority 1 — highest user / safety value

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| A1 | ✅ **RESOLVED.** Orphaned subprocess tree on app exit. **Fixed:** every `node` orchestrator is assigned to a Windows **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so app exit/crash reaps the whole `node`→`openclaw`→`claude`/`git` tree; a `CloseRequested` handler makes it prompt; `cancel_run` now `TerminateJobObject`s (kills the tree, not just `node`). Proven by `kill_on_close_job_reaps_assigned_process_when_handle_drops`. | — | — | `lib.rs` (RunState job, `assign_child_to_job`, `terminate_job`, run() handler) | done |
| A1b | **Dropped `done` emit has no recovery.** If the `orchestrator:done` emit fails (frontend gone), it's only `eprintln!`'d; the UI can hang. | MED | S | `lib.rs` done-handler | Write a `runs/<gid>/<runId>.done` tombstone the frontend can poll as a fallback watchdog. |
| C2 | **`groups_create` rollback is incomplete.** On a mid-create failure it does not revert the `perGroupThinking` block written to `.crime-team.json` nor the starter `presets.json` — leaving orphan config for a group that no longer exists. | MED | M | `lib.rs:843-878` (rollback) vs `:982-1007` | Pass the presets path + original `.crime-team.json` value into the rollback closure so it removes/restores them. |
| C3 | **`groups_edit` workspace change is non-atomic.** It writes `groups.json` *before* patching agent workspaces in `openclaw.json`, with no rollback if the patch fails → group points at the new workspace, agents at the old. | MED | M | `lib.rs:1148` before `:1169` | Patch `openclaw.json` first, write `groups.json` only on success; or roll back `groups.json` on patch failure. |

## Priority 2 — robustness / integrity

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| C1 | **Config writes are non-atomic and unlocked.** `write_groups_file` / `write_crime_team_json` use plain `std::fs::write` (no temp-file + atomic rename), and every mutation is an unguarded `config get → mutate → config patch` with no lock → overlapping GUI actions lost-update or truncate the registry. | MED | M–L | `lib.rs:434`, `:2271`; read-mutate-write at `:1131,1452,1577,2006` | Temp-file + atomic rename for both writers; a process-level lock (e.g. `parking_lot::Mutex`) around each read-mutate-write sequence. |
| D2 | **Citation guard can verify the wrong file.** On a basename collision `verifyCitations` picks `matches[0]`, so `index.ts:50` in a multi-file tree can be "verified" against the wrong file — undermining the hallucination guard. | MED | M | `src/citations.ts:124-127` | On `matches.length > 1`, mark `ambiguous` and require/prefer a path-qualified match; surface the resolved file in the report. |
| A3 | **Unbounded line buffering in the pumps.** `BufReader::…lines()`/`next_line()` reads to `\n` with no cap; a multi-MB no-newline blob grows an unbounded `String` and floods the webview. | LOW | M | `lib.rs:202, 226` | Cap per-line length (e.g. `read_until` with a `MAX_LINE` guard) and truncate with a marker. |
| A2 | **Inconsistent Node resolution.** `run_task` spawns bare `Command::new("node")` while `run_openclaw` honors `CRIME_TEAM_NODE`. Launch from a shortcut without `node` on PATH → every run fails at spawn. | LOW | S | `lib.rs:162` vs `:2095` | Route `run_task` through the same `openclaw_bin()`/`CRIME_TEAM_NODE` resolution. |

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
| E7 | **History-item runIds aren't copyable.** The active-run runId is now click-to-copy, but the sidebar items render `runId` as plain muted text. | LOW | S | `main.js:613-638` | Reuse the runId-chip copy affordance for history items. |
| E3 | **No structured logging in Rust.** Everything is stringly-typed `Result<_, String>`; no `tracing`/`log`, no timestamps/levels/file sink. Long errors get sliced to 200–400 chars in the GUI. | LOW | S | `Cargo.toml`, `lib.rs` throughout | Add `tracing-subscriber` with a stderr/file sink; `#[instrument]` the command handlers. |
| E5 | **Salvage script is CLI-only and rigid.** `scripts/salvage-integrate.mjs` hardcodes `thinking:"high"` and has no overrides; recovery isn't reachable from the GUI. (Producer is resolved from `groups.json` by group id, so it's robust to most changes.) | LOW | S | `scripts/salvage-integrate.mjs:111,124,144` | Add `--thinking`/`--producer` flags; consider a GUI "re-integrate" button. |

## Priority 5 — testing

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| E1 | **No integration tests for the orchestration flow.** Tests cover pure functions + the new event/agent-safety units; `orchestrate()`, retry-on-timeout, 0-dispatch→auto-fan-out, and all-specialists-failed paths are unexercised. | MED | M | `test/` | Add `orchestrate()` integration tests with a mocked `callAgent` asserting retry, dispatch-mode, and failure-path records. |

## Security

| ID | Item | Sev | Eff | Where | Fix |
|---|---|---|---|---|---|
| D1 | **Unused `shell:default` capability.** Granted to the JS frontend, which never spawns processes (all spawning is in trusted Rust) — pure attack surface if local content is ever compromised. | LOW | S | `capabilities/default.json:11` | Remove the grant. |

## Resolved this cycle

These appeared in the audits but the **observability overhaul already fixed them** — recorded so they aren't re-filed:

- **D4 — off-roster specialists now get cards.** The event-driven GUI calls `ensureAgentCard`/`setAgent` for any `specialist_started`/`specialist_done` agent regardless of roster (`main.js` `onEvent`), so off-roster specialists no longer sit on "waiting…" forever.
- **D3 — `--run-id` and `--group` both work.** The GUI's run UUID flows through to the record, the soft-cancel marker, and the event stream; **`--group` is now a real one-shot override** (loadConfig override) as of the v1 blocker fixes. (`--resume`'s load-prior-results/skip-succeeded-phases behavior remains **intentionally unimplemented** and is documented as such.)
- **Orchestrator↔GUI string-contract fragility** (first audit, top-5 #4) — replaced by the structured NDJSON event stream; DISPATCH parse-misses and swallowed gateway-restart/auth/identity failures now surface.

## Design deferments

Deliberate decisions, not defects:

- **GUI runs in dual mode** (Rust does *not* pass `--json`), so the log panel keeps the human lines while events drive state. `--json` is a CLI/automation convenience.
- **Emoji** uses a deterministic per-role palette until **E6** plumbs the real per-agent emoji through `settings_get`.
