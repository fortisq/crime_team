// Shared types for the orchestrator.

/** A parsed DISPATCH block from Producer's output. */
export interface DispatchBlock {
  agent: string;        // e.g. "architect", "frontend"
  task: string;         // one-line summary
  context: string;      // files/sections to read
  deliverable: string;  // what they produce
}

/** A single call to `openclaw agent`. */
export interface AgentCallOpts {
  agentId: string;
  sessionKey: string;
  message: string;
  /** Per-call timeout in seconds. Default 600 = 10 min. */
  timeoutSec?: number;
  /**
   * Pass through to openclaw's `--thinking <level>` flag.
   * Valid values: off | minimal | low | medium | high | xhigh | adaptive | max
   * Empty string or undefined → no flag passed (provider default applies).
   */
  thinkingLevel?: string;
  /** Called once per stdout chunk for live progress UI. */
  onProgress?: (chunk: string) => void;
}

export interface AgentCallResult {
  ok: boolean;
  text: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Exit code of the underlying process; -1 if killed by timeout. */
  exitCode: number;
}

/** Snapshot of one team-orchestrator run (saved to disk for resume). */
export interface RunRecord {
  runId: string;
  startedAt: string;          // ISO
  task: string;
  producerPlan?: string;
  dispatches?: DispatchBlock[];
  specialistResults?: { agent: string; reply: string; ok: boolean }[];
  finalAnswer?: string;
  endedAt?: string;
}
