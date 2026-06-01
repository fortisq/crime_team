// Structured event stream — the machine-readable half of the orchestrator's
// output. Every event is emitted as one NDJSON line on stdout, prefixed with a
// unique sentinel so the desktop shell (Rust) can split structured events from
// human-readable log lines with a cheap startsWith() check.
//
// Two output modes (see createEmitter):
//   - default: emit BOTH the sentinel event line AND the human log line. The
//     desktop GUI runs in this mode — it consumes events for state and shows
//     the human lines in its log panel.
//   - jsonMode (--json): emit ONLY event lines (no human text, no spinner) for
//     a clean stream when piping to a tool.
//
// Events are bound to a runId at creation so every line carries correlation
// context — the thing the observability audit found missing everywhere.

import chalk from "chalk";
import type { DispatchMode } from "./types.js";

export const EVENT_SENTINEL = "@@CTEVT@@ ";
export const EVENT_SCHEMA_VERSION = 1;

export type Level = "info" | "phase" | "ok" | "warn" | "error" | "trace";

/** An event without the base fields (v/runId/ts) — what callers pass to emit(). */
export type CTEventInput =
  | { type: "run_started"; task: string; group: string; producer: string; useCoder: boolean; loopMax: number; smartDispatch: boolean }
  | { type: "phase"; phase: string; iteration: number; label: string }
  | { type: "dispatch_planned"; iteration: number; agents: string[]; count: number }
  | { type: "dispatch_mode"; iteration: number; mode: DispatchMode; detail?: string }
  | { type: "specialist_started"; iteration: number; agent: string; label: string }
  | { type: "specialist_done"; iteration: number; agent: string; ok: boolean; durationMs: number; exitCode: number; retried: boolean }
  | { type: "retry"; iteration: number; agent: string; reason: string; baseTimeoutSec: number; bumpedTimeoutSec: number }
  | { type: "citation_check"; iteration: number; agent: string; total: number; verified: number; unverified: number; skippedReason?: string }
  | { type: "answer"; iteration: number; kind: "inline" | "integrated"; text: string }
  | { type: "coder"; iteration: number; ok: boolean; durationMs: number; role: string; text: string }
  | { type: "warn"; phase: string; msg: string }
  | { type: "error"; phase: string; msg: string; fatal: boolean }
  | { type: "done"; ok: boolean; exitCode: number; totalMs: number; failurePhase?: string; failureReason?: string };

interface EventBase { v: number; runId: string; ts: string; }
export type CTEvent = CTEventInput & EventBase;

/** Serialize one event to its NDJSON wire line (sentinel + single-line JSON). */
export function formatEventLine(e: CTEvent): string {
  return EVENT_SENTINEL + JSON.stringify(e);
}

export interface Spinner {
  stop(status: "ok" | "fail", durationMs: number): void;
}

export interface Emitter {
  readonly runId: string;
  readonly jsonMode: boolean;
  /** Emit a structured event line (always — both modes). */
  event(e: CTEventInput): void;
  /** Emit a human-readable log line (suppressed in jsonMode). */
  log(level: Level, msg: string): void;
  /** warn = structured warn event + human warn line. */
  warn(phase: string, msg: string): void;
  /** error = structured error event + human error line. */
  error(phase: string, msg: string, fatal?: boolean): void;
  /** Visual spinner for a long call (human-only; no-op in jsonMode). */
  spinner(label: string): Spinner;
}

const TAGS: Record<Level, string> = {
  info: chalk.cyan("[info ]"),
  phase: chalk.bold.cyan("[phase]"),
  ok: chalk.green("[ ok  ]"),
  warn: chalk.yellow("[warn ]"),
  error: chalk.red("[error]"),
  trace: chalk.gray("[trace]"),
};

export function createEmitter(runId: string, jsonMode: boolean): Emitter {
  const stamp = (e: CTEventInput): CTEvent =>
    ({ ...e, v: EVENT_SCHEMA_VERSION, runId, ts: new Date().toISOString() });

  const em: Emitter = {
    runId,
    jsonMode,
    event(e) {
      console.log(formatEventLine(stamp(e)));
    },
    log(level, msg) {
      if (jsonMode) return;
      console.log(`${TAGS[level]} ${msg}`);
    },
    warn(phase, msg) {
      em.event({ type: "warn", phase, msg });
      em.log("warn", msg);
    },
    error(phase, msg, fatal = false) {
      em.event({ type: "error", phase, msg, fatal });
      em.log("error", msg);
    },
    spinner(label) {
      if (jsonMode) return { stop() {} };
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let i = 0;
      const start = Date.now();
      const isTTY = !!process.stdout.isTTY;
      const interval = isTTY
        ? setInterval(() => {
            const secs = ((Date.now() - start) / 1000).toFixed(0);
            process.stdout.write(`\r  ${chalk.cyan(frames[i++ % frames.length])} ${label} (${secs}s)   `);
          }, 100)
        : null;
      if (!isTTY) console.log(`  · ${label}`);
      return {
        stop(status, durationMs) {
          if (interval) clearInterval(interval);
          const secs = (durationMs / 1000).toFixed(1);
          const mark = status === "ok" ? chalk.green("✓") : chalk.red("✗");
          if (isTTY) process.stdout.write(`\r  ${mark} ${label} (${secs}s)${" ".repeat(20)}\n`);
          else console.log(`  ${status === "ok" ? "ok" : "FAIL"}: ${label} (${secs}s)`);
        },
      };
    },
  };
  return em;
}
