// Shared types for the orchestrator.

/**
 * One project's team. Agents in OpenClaw are stored with fully-qualified ids
 * (e.g. "crimeos.architect"); within the GUI and dispatch blocks we use the
 * unprefixed role name ("architect"). The Group encodes the mapping.
 */
export interface Group {
  id: string;                 // stable slug, used as agent-id prefix
  displayName: string;
  emoji: string;
  workspace: string;          // absolute path
  producerAgentId: string;    // fully-qualified, e.g. "crimeos.producer"
  specialists: string[];      // fully-qualified ids, e.g. ["crimeos.architect", …]
  /**
   * Fully-qualified id of the optional Coder agent (e.g. "myproject.coder").
   * The Coder is ALSO present in `specialists[]` (it's a real OpenClaw agent
   * like any other). This sidecar flags it so the orchestrator can exclude it
   * from the audit fan-out and the GUI can render it distinctly. At most one
   * Coder per group. Undefined on pre-G.1 groups.
   */
  coderAgentId?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface GroupsFile {
  activeGroupId: string;
  groups: Group[];
}

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

  // --- G.2 / G.3 (all optional, additive) ---
  /** True when the user ticked "Use Coder" for this run. */
  usedCoder?: boolean;
  /** Max iterations requested for the loop (1 = no loop, 2..5 = loop wrapper). */
  loopMax?: number;
  /** Result of iteration 1's Coder pass (Phase 5 of the initial audit). */
  coderResult?: { ok: boolean; reply: string; durationMs: number };
  /** Loop iterations 2..N. Iteration 1 lives in the top-level fields above. */
  loopIterations?: Array<{
    iteration: number;
    audit: {
      producerPlan?: string;
      dispatches?: DispatchBlock[];
      specialistResults?: { agent: string; reply: string; ok: boolean }[];
      integrated?: string;
      noFindings?: boolean;
    };
    coder?: { ok: boolean; reply: string; durationMs: number };
  }>;
  /** True when the loop stopped because an audit returned the AUDIT CLEAN sentinel. */
  loopStoppedClean?: boolean;
  /** True when the user pressed Cancel mid-loop and the orchestrator exited
   *  cleanly between iterations via the soft-cancel marker file. */
  loopSoftCancelled?: boolean;
}
