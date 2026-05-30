#!/usr/bin/env node
// Salvage a run that died mid-Phase-3 (Defender blocked an openclaw spawn or
// any other transient EPERM). Reads the persisted specialist replies from the
// run record, replays Phase 3 (one ack turn per reply) + Phase 4 (integrate)
// against the group's Producer, and writes the finalAnswer back to the JSON.
//
// Usage:
//   node scripts/salvage-integrate.mjs <runId>
//   e.g.  node scripts/salvage-integrate.mjs team-1780122162
//
// Prereqs:
//   - You're in the orchestrator project root
//   - Defender exclusions are in place (otherwise the spawns will EPERM again)
//   - The original run record under runs/<groupId>/<runId>.json has
//     specialistResults persisted

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: node scripts/salvage-integrate.mjs <runId>");
  console.error("  e.g.  node scripts/salvage-integrate.mjs team-1780122162");
  process.exit(2);
}

// Locate the run record by scanning runs/<group>/<runId>.json
const runsRoot = join(process.cwd(), "runs");
let recordPath = null;
let groupId = null;
for (const g of readdirSync(runsRoot, { withFileTypes: true })) {
  if (!g.isDirectory()) continue;
  const candidate = join(runsRoot, g.name, `${runId}.json`);
  try {
    readFileSync(candidate);
    recordPath = candidate;
    groupId = g.name;
    break;
  } catch {}
}
if (!recordPath) {
  console.error(`runId '${runId}' not found under runs/*/`);
  process.exit(2);
}
console.log(`[salvage] run record: ${recordPath}`);
console.log(`[salvage] group:      ${groupId}`);

const record = JSON.parse(readFileSync(recordPath, "utf8"));
const okReplies = (record.specialistResults || []).filter(r => r.ok);
const failReplies = (record.specialistResults || []).filter(r => !r.ok);
if (okReplies.length === 0) {
  console.error("[salvage] no successful specialist replies to integrate — nothing to do");
  process.exit(1);
}
console.log(`[salvage] ${okReplies.length} ok + ${failReplies.length} fail specialist(s)`);

// Resolve the Producer agent id from groups.json
const home = process.env.USERPROFILE || process.env.HOME || "";
const groups = JSON.parse(readFileSync(join(home, ".crime-team", "groups.json"), "utf8"));
const group = groups.groups.find(g => g.id === groupId);
if (!group) {
  console.error(`[salvage] group '${groupId}' not in ~/.crime-team/groups.json`);
  process.exit(2);
}
const producerAgentId = group.producerAgentId;
const sessionKey = `agent:${producerAgentId}:${runId}-salvage`;
console.log(`[salvage] producer:   ${producerAgentId}`);
console.log(`[salvage] sessionKey: ${sessionKey}`);

// Mirror the orchestrator's spawn pattern (Node → openclaw.mjs, never the .cmd shim)
const NODE_BIN = process.execPath;
const OPENCLAW_MJS = process.env.OPENCLAW_BIN
  || `${process.env.APPDATA}\\npm\\node_modules\\openclaw\\openclaw.mjs`;
const MAX_ARGV_CHARS = 28000;

function callAgent({ agentId, message, timeoutSec = 1800, thinkingLevel }) {
  return new Promise((resolve) => {
    const args = [
      OPENCLAW_MJS, "agent",
      "--agent", agentId,
      "--session-key", sessionKey,
      "--message", message,
      "--timeout", String(timeoutSec),
    ];
    if (thinkingLevel && thinkingLevel !== "off") args.push("--thinking", thinkingLevel);
    const argvSize = args.reduce((s, a) => s + a.length + 3, 0);
    if (argvSize > MAX_ARGV_CHARS) {
      resolve({ ok: false, text: `[salvage] argv too large (${argvSize} > ${MAX_ARGV_CHARS})` });
      return;
    }
    const child = spawn(NODE_BIN, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b.toString());
    child.stderr.on("data", b => stderr += b.toString());
    child.on("error", e => resolve({ ok: false, text: `spawn error: ${e.message} (code=${e.code})` }));
    child.on("close", code => {
      resolve({
        ok: code === 0,
        text: code === 0 ? stdout.trim() : `[exit ${code}] ${stderr || stdout}`.trim(),
      });
    });
  });
}

(async () => {
  // Phase 3: notify Producer of failures up front, then ack each ok reply
  if (failReplies.length > 0) {
    const note = `Heads up before specialist replies arrive: ${failReplies.length} specialist(s) failed in the original run and are skipped — ${failReplies.map(r => r.agent).join(", ")}. When you integrate, note which were unavailable; do not invent their findings.`;
    console.log(`[salvage] notifying producer of failures…`);
    const r = await callAgent({ agentId: producerAgentId, message: note, thinkingLevel: "high" });
    console.log(`[salvage]   ${r.ok ? "ok" : "fail"}`);
  }

  for (const reply of okReplies) {
    const sizeKB = (reply.reply.length / 1024).toFixed(1);
    console.log(`[salvage] posting ${reply.agent}'s reply (${sizeKB}KB)…`);
    let body = `Specialist '${reply.agent}' returned the following. Read it; acknowledge briefly; do NOT integrate yet:\n\n${reply.reply}`;
    if (body.length > MAX_ARGV_CHARS - 200) {
      const trunc = MAX_ARGV_CHARS - 400;
      body = body.slice(0, trunc) + `\n\n[…truncated by salvage at ${trunc} chars; full was ${reply.reply.length}…]`;
    }
    const start = Date.now();
    const ack = await callAgent({ agentId: producerAgentId, message: body, thinkingLevel: "high" });
    console.log(`[salvage]   ${ack.ok ? "ok" : "fail"} in ${((Date.now() - start)/1000).toFixed(1)}s`);
    if (!ack.ok) {
      console.error(`[salvage] producer failed to ack ${reply.agent}:`);
      console.error(ack.text);
      process.exit(1);
    }
  }

  // Phase 4: integrate
  const failedNote = failReplies.length > 0
    ? ` Note: ${failReplies.length} specialist(s) — ${failReplies.map(r => r.agent).join(", ")} — were unavailable for this run. State that explicitly in the integration; don't invent their findings.`
    : "";
  const integratePrompt =
    "Now integrate every specialist reply you just received into ONE coherent answer for Dan. " +
    "Address any BLOCK / INVARIANT VIOLATION / REQ DELTA flags. Lead with the result. End with the concrete next step." +
    failedNote;

  console.log(`[salvage] integrating…`);
  const start = Date.now();
  const integration = await callAgent({ agentId: producerAgentId, message: integratePrompt, thinkingLevel: "high" });
  console.log(`[salvage] integration ${integration.ok ? "ok" : "fail"} in ${((Date.now() - start)/1000).toFixed(1)}s`);

  if (!integration.ok) {
    console.error("[salvage] integration failed:");
    console.error(integration.text);
    process.exit(1);
  }

  // Persist + print
  record.finalAnswer = integration.text;
  record.endedAt = new Date().toISOString();
  record.salvaged = true;
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`[salvage] wrote finalAnswer (${integration.text.length} chars) → ${recordPath}`);
  console.log();
  console.log("=".repeat(72));
  console.log("PRODUCER'S INTEGRATED ANSWER (salvaged)");
  console.log("=".repeat(72));
  console.log(integration.text);
})();
