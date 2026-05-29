// Per-agent and global config. Loaded from .crime-team.json in CWD if present,
// merged over the built-in defaults below.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentConfig {
  /** Per-agent timeout in seconds (passed to `openclaw agent --timeout`). */
  timeoutSec: number;
}

export interface Config {
  producerAgent: string;
  defaultTimeoutSec: number;
  perAgent: Record<string, AgentConfig>;
  /** Max parallel specialist dispatches at once. */
  maxParallel: number;
  /** Where to save run records for resume. */
  runsDir: string;
  /** Workspace root for citation verification. Detected from OpenClaw if unset. */
  workspace: string;
  /** Disable citation verification (e.g. for non-code tasks). */
  disableCitationCheck: boolean;
  /**
   * Per-agent thinking level read from OpenClaw's agents.list[].thinking.
   * Detected at startup. Empty string = no override (provider default).
   * Valid values: off | minimal | low | medium | high | xhigh | adaptive | max
   */
  perAgentThinking: Record<string, string>;
}

const DEFAULTS: Config = {
  producerAgent: "producer",
  defaultTimeoutSec: 1800,       // 30 min: audit tasks on Opus/Sonnet routinely take 15-25 min
  perAgent: {
    architect:     { timeoutSec: 1800 },
    frontend:      { timeoutSec: 1800 },
    "art-director": { timeoutSec: 1200 },
    qa:            { timeoutSec: 1200 },
    security:      { timeoutSec: 1800 },  // attacker-perspective audits read a lot
    producer:      { timeoutSec: 1200 },  // producer turns are shorter (plan + ack + integrate)
  },
  maxParallel: 5,                // we have 5 specialists max now (architect, frontend, art-director, qa, security)
  runsDir: "runs",
  workspace: "",                 // auto-detected at startup if empty
  disableCitationCheck: false,
  perAgentThinking: {},
};

import { execSync } from "node:child_process";

interface OpenClawAgentsSnapshot {
  workspace: string;
  thinking: Record<string, string>;
}

/** Read agents.list once and extract workspace + per-agent thinking levels. */
function detectFromOpenClaw(): OpenClawAgentsSnapshot {
  const result: OpenClawAgentsSnapshot = { workspace: "", thinking: {} };
  try {
    const appdata = process.env.APPDATA ?? "";
    const openclawMjs = `${appdata}\\npm\\node_modules\\openclaw\\openclaw.mjs`;
    const out = execSync(
      `node "${openclawMjs}" config get agents.list`,
      { encoding: "utf8", timeout: 5000 },
    );
    const list = JSON.parse(out) as Array<{ id?: string; workspace?: string; thinking?: string }>;
    let producerWs = "";
    let anyWs = "";
    for (const a of list) {
      if (!a.id) continue;
      if (typeof a.thinking === "string" && a.thinking.length > 0) {
        result.thinking[a.id] = a.thinking;
      }
      if (typeof a.workspace === "string" && a.workspace.length > 0) {
        if (a.id === "producer") producerWs = a.workspace;
        else if (a.id !== "main") anyWs ||= a.workspace;
      }
    }
    result.workspace = producerWs || anyWs;
  } catch {}
  return result;
}

export function loadConfig(): Config {
  let cfg: Config;
  try {
    const raw = readFileSync(join(process.cwd(), ".crime-team.json"), "utf8");
    const user = JSON.parse(raw) as Partial<Config>;
    cfg = {
      ...DEFAULTS,
      ...user,
      perAgent: { ...DEFAULTS.perAgent, ...(user.perAgent ?? {}) },
      perAgentThinking: { ...DEFAULTS.perAgentThinking, ...(user.perAgentThinking ?? {}) },
    };
  } catch {
    cfg = { ...DEFAULTS, perAgentThinking: {} };
  }
  const snap = detectFromOpenClaw();
  if (!cfg.workspace) cfg.workspace = snap.workspace;
  // OpenClaw-side thinking levels are the source of truth; merge them in,
  // letting any .crime-team.json overrides win.
  cfg.perAgentThinking = { ...snap.thinking, ...cfg.perAgentThinking };
  return cfg;
}

/** Lookup the thinking level for an agent, or "" if no override is set. */
export function thinkingFor(cfg: Config, agentId: string): string {
  return cfg.perAgentThinking[agentId] ?? "";
}

export function timeoutFor(cfg: Config, agentId: string): number {
  return cfg.perAgent[agentId]?.timeoutSec ?? cfg.defaultTimeoutSec;
}
