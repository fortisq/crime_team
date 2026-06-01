// Integration tests for orchestrate() — the full audit flow — with a mocked
// agent-call fn (no real openclaw spawns). Covers the paths the audit flagged
// as untested: inline answer, parallel dispatch+integrate, retry-on-timeout,
// and all-specialists-failed, asserting the persisted RunRecord.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrate } from "../dist/orchestrator.js";

const res = (text, { ok = true, exitCode = 0 } = {}) => ({ ok, text, durationMs: 1, exitCode });

function makeCfg(runsDir, specialists = ["g.qa", "g.backend"]) {
  return {
    producerAgent: "g.producer",
    defaultTimeoutSec: 60,
    perAgent: {},
    maxParallel: 5,
    runsDir,
    workspace: "",            // empty → citation verification skipped
    disableCitationCheck: true,
    perGroupThinking: {},
    activeGroup: {
      id: "g", displayName: "G", emoji: "🧪", workspace: "",
      producerAgentId: "g.producer", specialists, coderAgentId: undefined,
      createdAt: "", lastUsedAt: "",
    },
  };
}

const DISPATCH_TWO =
  "Plan.\n\nDISPATCH: qa\nTASK: t\nCONTEXT: c\nDELIVERABLE: d\n\n" +
  "DISPATCH: backend\nTASK: t\nCONTEXT: c\nDELIVERABLE: d";

/** Run orchestrate with stdout (human + event lines) silenced. */
async function run(opts) {
  const orig = console.log;
  console.log = () => {};
  try { return await orchestrate(opts); }
  finally { console.log = orig; }
}

function withRunsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ct-orch-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const readRecord = (dir, runId) => JSON.parse(readFileSync(join(dir, `${runId}.json`), "utf8"));

test("inline answer: Producer answers with no dispatches → dispatchMode inline", () => withRunsDir(async (dir) => {
  const call = async (o) => o.agentId === "g.producer" ? res("The answer is 42.") : res("unexpected");
  const code = await run({ task: "What is 2+2?", cfg: makeCfg(dir), runId: "t-inline", json: true, verbose: false, call });
  assert.equal(code, 0);
  const rec = readRecord(dir, "t-inline");
  assert.equal(rec.dispatchMode, "inline");
  assert.equal(rec.finalAnswer, "The answer is 42.");
}));

test("parallel dispatch: 2 specialists run, replies integrated", () => withRunsDir(async (dir) => {
  const call = async (o) => {
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("INTEGRATED: all good.");
      return res(DISPATCH_TWO); // plan / acks both fine to answer; only plan parses blocks
    }
    return res(`${o.agentId} findings`);
  };
  const code = await run({ task: "Audit the code.", cfg: makeCfg(dir), runId: "t-par", json: true, verbose: false, call });
  assert.equal(code, 0);
  const rec = readRecord(dir, "t-par");
  assert.equal(rec.dispatchMode, "parallel");
  assert.equal(rec.specialistResults.length, 2);
  assert.ok(rec.specialistResults.every(r => r.ok));
  assert.equal(rec.finalAnswer, "INTEGRATED: all good.");
}));

test("retry on timeout: a timed-out specialist is retried once and recorded", () => withRunsDir(async (dir) => {
  const calls = new Map();
  const call = async (o) => {
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("INTEGRATED.");
      if (o.message.startsWith("Specialist '") || o.message.startsWith("Heads up")) return res("ack");
      return res(DISPATCH_TWO);
    }
    const n = (calls.get(o.agentId) ?? 0) + 1;
    calls.set(o.agentId, n);
    // g.qa times out on first attempt (exitCode -1), succeeds on retry.
    if (o.agentId === "g.qa" && n === 1) return res("[timeout]", { ok: false, exitCode: -1 });
    return res(`${o.agentId} findings`);
  };
  const code = await run({ task: "Audit the code.", cfg: makeCfg(dir), runId: "t-retry", json: true, verbose: false, call });
  assert.equal(code, 0);
  const rec = readRecord(dir, "t-retry");
  const qa = rec.specialistResults.find(r => r.agent === "qa");
  assert.ok(qa.ok && qa.retried === true, "qa should be retried and ultimately ok");
  assert.equal(calls.get("g.qa"), 2, "qa should have been called twice");
}));

test("all specialists fail → exit 1 with failurePhase recorded", () => withRunsDir(async (dir) => {
  const call = async (o) => {
    if (o.agentId === "g.producer") return res(DISPATCH_TWO);
    return res("[hard error]", { ok: false, exitCode: 1 }); // not -1 → no retry
  };
  const code = await run({ task: "Audit the code.", cfg: makeCfg(dir), runId: "t-fail", json: true, verbose: false, call });
  assert.equal(code, 1);
  const rec = readRecord(dir, "t-fail");
  assert.equal(rec.failurePhase, "all-specialists-failed");
}));
