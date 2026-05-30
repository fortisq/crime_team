// Per-agent and global config. Loaded from .crime-team.json in CWD if present,
// merged over the built-in defaults below.
//
// Phase A (multi-project): config is now scoped to an "active group" loaded
// from ~/.crime-team/groups.json. The orchestrator dispatches to the group's
// specialists. Within a group, dispatch ids in Producer's output ("architect")
// are auto-prefixed with the group id ("crimeos.architect") before invocation.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Group, GroupsFile } from "./types.js";

export interface AgentConfig {
  /** Per-agent timeout in seconds (passed to `openclaw agent --timeout`). */
  timeoutSec: number;
}

export interface Config {
  /** The fully-qualified producer agent id for the active group. */
  producerAgent: string;
  defaultTimeoutSec: number;
  /**
   * Per-agent timeout — keyed by **unprefixed** role name (e.g. "architect").
   * Defaults are common to every group; overrides via .crime-team.json.
   */
  perAgent: Record<string, AgentConfig>;
  maxParallel: number;
  /** Where to save run records. Group-scoped: `runs/<group-id>/`. */
  runsDir: string;
  /** Workspace root for citation verification (from the active group). */
  workspace: string;
  disableCitationCheck: boolean;
  /**
   * Per-group, per-role thinking level. Lookup form: perGroupThinking[group.id][role].
   * The orchestrator passes --thinking <level> to `openclaw agent` per call.
   */
  perGroupThinking: Record<string, Record<string, string>>;
  /** The Group object that's active. Drives dispatch + display. */
  activeGroup: Group;
}

const DEFAULT_PER_AGENT: Record<string, AgentConfig> = {
  architect:     { timeoutSec: 1800 },
  frontend:      { timeoutSec: 1800 },
  "art-director": { timeoutSec: 1200 },
  qa:            { timeoutSec: 1200 },
  security:      { timeoutSec: 1800 },
  producer:      { timeoutSec: 1200 },
};

const GROUPS_FILE_PATH = join(homedir(), ".crime-team", "groups.json");

/**
 * Read ~/.crime-team/groups.json and return the active group.
 * If the file is missing or empty, returns null (Phase A migration not run).
 */
export function loadActiveGroup(): Group | null {
  try {
    const raw = readFileSync(GROUPS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as GroupsFile;
    if (!parsed.groups?.length) return null;
    return parsed.groups.find(g => g.id === parsed.activeGroupId) ?? parsed.groups[0]!;
  } catch {
    return null;
  }
}

/**
 * Strip the group prefix from a fully-qualified agent id.
 * e.g. "crimeos.architect" → "architect"; "architect" → "architect".
 */
export function roleOf(agentId: string, groupId: string): string {
  const prefix = groupId + ".";
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
}

/**
 * Add the group prefix to an unprefixed role name.
 * e.g. "architect" (with group "crimeos") → "crimeos.architect".
 * Already-prefixed ids are returned as-is.
 */
export function fullyQualify(role: string, groupId: string): string {
  const prefix = groupId + ".";
  return role.startsWith(prefix) ? role : prefix + role;
}

/** Detect workspace from OpenClaw config if active group's workspace is empty. */
function detectWorkspaceFromOpenClaw(): string {
  try {
    const appdata = process.env.APPDATA ?? "";
    const openclawMjs = `${appdata}\\npm\\node_modules\\openclaw\\openclaw.mjs`;
    const out = execSync(
      `node "${openclawMjs}" config get agents.list`,
      { encoding: "utf8", timeout: 5000 },
    );
    const list = JSON.parse(out) as Array<{ id?: string; workspace?: string }>;
    for (const a of list) {
      if (a.id && a.id !== "main" && typeof a.workspace === "string" && a.workspace.length > 0) {
        return a.workspace;
      }
    }
  } catch {}
  return "";
}

export function loadConfig(): Config {
  const group = loadActiveGroup();
  if (!group) {
    throw new Error(
      `No active group found. Expected ~/.crime-team/groups.json to exist with at ` +
      `least one group. Run the Phase A migration to set this up.`
    );
  }

  // .crime-team.json user overrides (perGroupThinking, perAgent, etc.)
  let userOverrides: Partial<Config> = {};
  try {
    const raw = readFileSync(join(process.cwd(), ".crime-team.json"), "utf8");
    userOverrides = JSON.parse(raw) as Partial<Config>;
  } catch {}

  const cfg: Config = {
    producerAgent: group.producerAgentId,
    defaultTimeoutSec: userOverrides.defaultTimeoutSec ?? 1800,
    perAgent: { ...DEFAULT_PER_AGENT, ...(userOverrides.perAgent ?? {}) },
    maxParallel: userOverrides.maxParallel ?? 5,
    runsDir: join("runs", group.id),
    workspace: group.workspace || detectWorkspaceFromOpenClaw(),
    disableCitationCheck: userOverrides.disableCitationCheck ?? false,
    perGroupThinking: userOverrides.perGroupThinking ?? {},
    activeGroup: group,
  };

  return cfg;
}

/**
 * The audit-only specialist roster = all specialists minus the optional Coder.
 * This is who the orchestrator dispatches to during Phases 1–4. The Coder
 * (if present) stays in `cfg.activeGroup.specialists` and OpenClaw config
 * — only the audit-fan-out logic skips it.
 */
export function auditSpecialists(cfg: Config): string[] {
  const coder = cfg.activeGroup.coderAgentId;
  return cfg.activeGroup.specialists.filter(s => s !== coder);
}

/** Lookup the thinking level for an agent in the active group. */
export function thinkingFor(cfg: Config, agentId: string): string {
  // agentId may be either fully-qualified ("crimeos.architect") or just role ("architect").
  const role = roleOf(agentId, cfg.activeGroup.id);
  const groupMap = cfg.perGroupThinking[cfg.activeGroup.id] ?? {};
  return groupMap[role] ?? "";
}

export function timeoutFor(cfg: Config, agentId: string): number {
  const role = roleOf(agentId, cfg.activeGroup.id);
  return cfg.perAgent[role]?.timeoutSec ?? cfg.defaultTimeoutSec;
}
