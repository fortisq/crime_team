// Thin wrapper around `openclaw agent` invoked via Node child_process.
// Node's spawn passes argv as an array (no shell quoting headaches) and handles
// arg strings up to ~32K on Windows (vs cmd.exe's 8K limit). For messages
// larger than that we still need a chunking strategy (see orchestrator.ts).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCallOpts, AgentCallResult } from "./types.js";

// Lazy-loaded map of agentId → model, sourced from ~/.openclaw/openclaw.json.
// Used by clampThinking() to defensively downgrade incompatible thinking
// levels (e.g. 'max' on Sonnet fails silently via claude-cli with empty
// stderr). Refreshed once per process; agents added mid-run get a fresh
// lookup attempt on the next call.
let agentModelCache: Map<string, string> | null = null;
let agentModelCacheLoadedAt = 0;
const AGENT_MODEL_CACHE_TTL_MS = 30_000;

function loadAgentModels(): Map<string, string> {
  const now = Date.now();
  if (agentModelCache && (now - agentModelCacheLoadedAt) < AGENT_MODEL_CACHE_TTL_MS) {
    return agentModelCache;
  }
  const map = new Map<string, string>();
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const cfg = JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"));
    for (const a of (cfg?.agents?.list ?? [])) {
      if (!a?.id) continue;
      // The `model` field is sometimes a string ("anthropic/claude-opus-4-7")
      // and sometimes an object ({ primary, fallbacks }). Normalize to the
      // primary string — otherwise String(obj) → "[object Object]" and the
      // Opus check below silently fails, downgrading max→high for every
      // Opus-Producer run.
      let model: string | null = null;
      if (typeof a.model === "string") model = a.model;
      else if (a.model && typeof a.model === "object" && typeof a.model.primary === "string") model = a.model.primary;
      if (model) map.set(String(a.id), model);
    }
  } catch {
    // Best-effort. If we can't read it, just don't clamp.
  }
  agentModelCache = map;
  agentModelCacheLoadedAt = now;
  return map;
}

/**
 * Downgrade incompatible thinking levels for an agent before passing them to
 * openclaw. 'max' only works on Anthropic Opus models; Sonnet rejects it via
 * claude-cli with an empty stderr (silent failure, looks like a hang to the
 * orchestrator). Logs a warn to stderr when it clamps so debugging is obvious.
 */
export function clampThinking(
  agentId: string,
  thinking: string | undefined,
  onWarn?: (msg: string) => void,
): string | undefined {
  if (!thinking || thinking === "" || thinking === "off") return thinking;
  if (thinking !== "max") return thinking;
  const model = loadAgentModels().get(agentId) ?? "";
  const isOpus = /^anthropic\/claude-opus/i.test(model);
  if (isOpus) return thinking;
  const msg =
    `clamping thinking='max' → 'high' for ${agentId} ` +
    `(model='${model || "unknown"}' does not support 'max'; only Anthropic Opus does)`;
  // Route through the caller's logger when available so it lands in the
  // structured event stream; fall back to stderr for standalone use.
  if (onWarn) onWarn(msg);
  else process.stderr.write(`[agent.ts] ${msg}\n`);
  return "high";
}

// Empirical safe limit for a single argv on Windows. Beyond this we get
// "Too many arguments for this command" from OpenClaw's parser because the
// command line gets truncated/mangled.
export const MAX_ARGV_CHARS = 28000;

// Grace added to the per-call timeout before we SIGKILL the child — gives
// openclaw room to wind down a slow claude-cli finalize. Shared by the timer
// and the "killed after" message so they can never drift (they used to: timer
// was +120 while the message said +30).
const KILL_GRACE_SEC = 120;

// Launch OpenClaw directly via Node, bypassing the .cmd shim.
// `spawn` with shell:false can't invoke .cmd on Windows (EINVAL), and using
// shell:true reintroduces argv quoting hazards. The .mjs entry is cleanest.
const NODE_BIN = process.execPath;
const OPENCLAW_MJS =
  process.env.OPENCLAW_BIN ||
  `${process.env.APPDATA}\\npm\\node_modules\\openclaw\\openclaw.mjs`;

// Minimal environment for spawned children. Passing the parent's full
// `process.env` wholesale leaked every secret (AWS keys, unrelated tokens) into
// every specialist subprocess. Forward only what openclaw/Node/Windows need:
// a fixed set plus auth/proxy vars by prefix.
const ENV_ALLOW_FIXED = [
  "PATH", "Path", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME",
  "SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS",
  "NODE_OPTIONS", "OPENCLAW_BIN", "CRIME_TEAM_NODE",
];
const ENV_ALLOW_PREFIX = /^(OPENCLAW_|ANTHROPIC_|OPENAI_|GOOGLE_|DEEPSEEK_|OPENROUTER_|AZURE_)/;
const ENV_ALLOW_PROXY = /^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;

export function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALLOW_FIXED.includes(k) || ENV_ALLOW_PREFIX.test(k) || ENV_ALLOW_PROXY.test(k)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Call `openclaw agent` and capture the full reply.
 * Returns an AgentCallResult with `ok: false` on non-zero exit OR if stdout
 * starts with a known error marker.
 */
export function callAgent(opts: AgentCallOpts): Promise<AgentCallResult> {
  const timeoutSec = opts.timeoutSec ?? 600;
  const args = [
    "agent",
    "--agent", opts.agentId,
    "--session-key", opts.sessionKey,
    "--message", opts.message,
    "--timeout", String(timeoutSec),
  ];
  const safeThinking = clampThinking(opts.agentId, opts.thinkingLevel, opts.onWarn);
  if (safeThinking && safeThinking.length > 0) {
    args.push("--thinking", safeThinking);
  }

  const argvSize = args.reduce((s, a) => s + a.length + 3, 0);
  if (argvSize > MAX_ARGV_CHARS) {
    return Promise.resolve({
      ok: false,
      text: `[orchestrator] message too large for argv (${argvSize} chars > ${MAX_ARGV_CHARS} cap). Caller should chunk via multi-turn.`,
      durationMs: 0,
      exitCode: -2,
    });
  }

  return new Promise<AgentCallResult>((resolve) => {
    const start = Date.now();
    const child = spawn(NODE_BIN, [OPENCLAW_MJS, ...args], {
      shell: false,
      windowsHide: true,
      env: childEnv(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Generous buffer over openclaw's own timeout — when claude-cli sessions
    // are slow to finalize, the wrapper killing too aggressively turns a recoverable
    // late-finish into a hard failure. Give openclaw this grace to wind down.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, (timeoutSec + KILL_GRACE_SEC) * 1000);

    child.stdout.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stdout += s;
      opts.onProgress?.(s);
    });
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr += s;
      opts.onProgress?.(s);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: `[orchestrator] spawn failed: ${err.message}`,
        durationMs: Date.now() - start,
        exitCode: -3,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      // Keep stderr OUT of the reply text: it carries tooling noise and can
      // include credential-error fragments that must not flow into the run
      // record or back into Producer context. The caller surfaces it as a warn.
      const out = stdout.trim();
      const err = stderr.trim();

      if (timedOut) {
        resolve({
          ok: false,
          text: `[orchestrator] killed after ${timeoutSec + KILL_GRACE_SEC}s timeout. Partial:\n${out}`,
          stderr: err || undefined,
          durationMs,
          exitCode: -1,
        });
        return;
      }
      // Error-marker check scans stdout only (those markers are openclaw's own
      // prints); a non-empty stderr does NOT by itself fail the call.
      const ok = code === 0
        && !/^(GatewayClientRequestError|GatewayTransportError|FailoverError|Error:|EMBEDDED FALLBACK)/.test(out);
      resolve({ ok, text: out, stderr: err || undefined, durationMs, exitCode: code ?? -1 });
    });
  });
}
