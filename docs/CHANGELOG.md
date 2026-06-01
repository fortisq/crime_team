# Changelog

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
