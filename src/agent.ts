// Thin wrapper around `openclaw agent` invoked via Node child_process.
// Node's spawn passes argv as an array (no shell quoting headaches) and handles
// arg strings up to ~32K on Windows (vs cmd.exe's 8K limit). For messages
// larger than that we still need a chunking strategy (see orchestrator.ts).

import { spawn } from "node:child_process";
import type { AgentCallOpts, AgentCallResult } from "./types.js";

// Empirical safe limit for a single argv on Windows. Beyond this we get
// "Too many arguments for this command" from OpenClaw's parser because the
// command line gets truncated/mangled.
export const MAX_ARGV_CHARS = 28000;

// Launch OpenClaw directly via Node, bypassing the .cmd shim.
// `spawn` with shell:false can't invoke .cmd on Windows (EINVAL), and using
// shell:true reintroduces argv quoting hazards. The .mjs entry is cleanest.
const NODE_BIN = process.execPath;
const OPENCLAW_MJS =
  process.env.OPENCLAW_BIN ||
  `${process.env.APPDATA}\\npm\\node_modules\\openclaw\\openclaw.mjs`;

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
  if (opts.thinkingLevel && opts.thinkingLevel.length > 0) {
    args.push("--thinking", opts.thinkingLevel);
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
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Generous buffer over openclaw's own timeout — when claude-cli sessions
    // are slow to finalize, the wrapper killing too aggressively turns a recoverable
    // late-finish into a hard failure. Give openclaw 2 min to wind down gracefully.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, (timeoutSec + 120) * 1000);

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
      const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();

      if (timedOut) {
        resolve({ ok: false, text: `[orchestrator] killed after ${timeoutSec + 30}s timeout. Partial:\n${combined}`, durationMs, exitCode: -1 });
        return;
      }
      const ok = code === 0
        && !/^(GatewayClientRequestError|GatewayTransportError|FailoverError|Error:|EMBEDDED FALLBACK)/.test(combined);
      resolve({ ok, text: combined, durationMs, exitCode: code ?? -1 });
    });
  });
}
