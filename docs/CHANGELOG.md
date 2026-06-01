# Changelog

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
