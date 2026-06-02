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

// --- --resume ---------------------------------------------------------------

const isAck = (m) => m.startsWith("Specialist '") || m.startsWith("Heads up");

test("resume: integration failed → specialists reused, only re-integrates", () => withRunsDir(async (dir) => {
  const calls = new Map();
  const cnt = (id) => calls.get(id) ?? 0;
  // Run 1: both specialists OK, but integration FAILS → incomplete (no finalAnswer).
  const call1 = async (o) => {
    calls.set(o.agentId, cnt(o.agentId) + 1);
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("[integrate boom]", { ok: false, exitCode: 1 });
      if (isAck(o.message)) return res("ack");
      return res(DISPATCH_TWO);
    }
    return res(`${o.agentId} findings`);
  };
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-res", json: true, verbose: false, call: call1 }), 1);
  let rec = readRecord(dir, "t-res");
  assert.equal(rec.failurePhase, "integrate");
  assert.ok(!rec.finalAnswer, "no finalAnswer after integration failure");
  assert.ok(rec.specialistResults.every((r) => r.ok));
  assert.equal(cnt("g.qa"), 1); assert.equal(cnt("g.backend"), 1);

  // Resume: integration now succeeds. Plan + both specialists must be reused.
  const call2 = async (o) => {
    calls.set(o.agentId, cnt(o.agentId) + 1);
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("INTEGRATED on resume.");
      if (isAck(o.message)) return res("ack");
      return res(DISPATCH_TWO); // a fresh plan call would hit this — it must NOT
    }
    return res(`${o.agentId} SHOULD-NOT-RUN`);
  };
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-res", resume: true, json: true, verbose: false, call: call2 }), 0);
  rec = readRecord(dir, "t-res");
  assert.equal(rec.finalAnswer, "INTEGRATED on resume.");
  assert.ok(rec.resumedAt, "resumedAt stamped");
  assert.equal(cnt("g.qa"), 1, "qa reused, not re-run");
  assert.equal(cnt("g.backend"), 1, "backend reused, not re-run");
  // reused replies survive (not the SHOULD-NOT-RUN text)
  assert.ok(rec.specialistResults.every((r) => r.reply.endsWith("findings")));
}));

test("resume: only the failed specialist is re-run", () => withRunsDir(async (dir) => {
  const calls = new Map();
  const cnt = (id) => calls.get(id) ?? 0;
  // Run 1: qa OK, backend FAILS, then integration fails → incomplete.
  const call1 = async (o) => {
    calls.set(o.agentId, cnt(o.agentId) + 1);
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("[boom]", { ok: false, exitCode: 1 });
      if (isAck(o.message)) return res("ack");
      return res(DISPATCH_TWO);
    }
    if (o.agentId === "g.backend") return res("[fail]", { ok: false, exitCode: 1 });
    return res("qa findings");
  };
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-part", json: true, verbose: false, call: call1 }), 1);
  let rec = readRecord(dir, "t-part");
  assert.equal(rec.specialistResults.find((r) => r.agent === "backend").ok, false);

  // Resume: backend succeeds now, qa must be reused.
  const call2 = async (o) => {
    calls.set(o.agentId, cnt(o.agentId) + 1);
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("INTEGRATED final.");
      if (isAck(o.message)) return res("ack");
      return res(DISPATCH_TWO);
    }
    if (o.agentId === "g.backend") return res("backend FIXED");
    return res("qa SHOULD-NOT-RUN");
  };
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-part", resume: true, json: true, verbose: false, call: call2 }), 0);
  rec = readRecord(dir, "t-part");
  assert.equal(rec.finalAnswer, "INTEGRATED final.");
  assert.equal(cnt("g.qa"), 1, "qa reused (called once, in run 1)");
  assert.equal(cnt("g.backend"), 2, "backend re-run once on resume");
  assert.equal(rec.specialistResults.find((r) => r.agent === "backend").reply, "backend FIXED");
}));

test("resume: a completed run re-runs nothing and is not clobbered", () => withRunsDir(async (dir) => {
  const calls = new Map();
  const cnt = (id) => calls.get(id) ?? 0;
  const mkCall = (label) => async (o) => {
    calls.set(o.agentId, cnt(o.agentId) + 1);
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res(`INTEGRATED ${label}`);
      if (isAck(o.message)) return res("ack");
      return res(DISPATCH_TWO);
    }
    return res(`${o.agentId} ${label}`);
  };
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-cmpl", json: true, verbose: false, call: mkCall("v1") }), 0);
  assert.equal(readRecord(dir, "t-cmpl").finalAnswer, "INTEGRATED v1");
  const afterRun1 = new Map(calls);

  // Resume a complete run: reuse the answer, call nothing, don't overwrite it.
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-cmpl", resume: true, json: true, verbose: false, call: mkCall("v2") }), 0);
  const after = readRecord(dir, "t-cmpl");
  assert.equal(after.finalAnswer, "INTEGRATED v1", "completed answer not clobbered");
  assert.ok(after.resumedAt);
  for (const [id, n] of calls) assert.equal(n, afterRun1.get(id) ?? 0, `${id} not re-called on resume`);
}));

test("resume audit-only of a prior coder run clears stale coder provenance", () => withRunsDir(async (dir) => {
  const calls = new Map();
  const cnt = (id) => calls.get(id) ?? 0;
  const coderCfg = makeCfg(dir);
  coderCfg.activeGroup.coderAgentId = "g.coder";
  const call1 = async (o) => {
    calls.set(o.agentId, cnt(o.agentId) + 1);
    if (o.agentId === "g.producer") {
      if (o.message.startsWith("Now integrate")) return res("INTEGRATED.");
      if (isAck(o.message)) return res("ack");
      return res(DISPATCH_TWO);
    }
    if (o.agentId === "g.coder") return res("coder applied changes");
    return res(`${o.agentId} findings`);
  };
  assert.equal(await run({ task: "Audit.", cfg: coderCfg, runId: "t-prov", useCoder: true, json: true, verbose: false, call: call1 }), 0);
  let rec = readRecord(dir, "t-prov");
  assert.equal(rec.usedCoder, true);
  assert.ok(rec.coderResult?.ok);
  const afterRun1 = new Map(calls);

  // Resume WITHOUT useCoder → audit-only; stale coder provenance must be cleared.
  const call2 = async (o) => { calls.set(o.agentId, cnt(o.agentId) + 1); return res("SHOULD-NOT-RUN"); };
  assert.equal(await run({ task: "Audit.", cfg: makeCfg(dir), runId: "t-prov", resume: true, json: true, verbose: false, call: call2 }), 0);
  rec = readRecord(dir, "t-prov");
  assert.equal(rec.finalAnswer, "INTEGRATED.", "audit reused");
  assert.ok(!rec.usedCoder, "usedCoder cleared on audit-only resume");
  assert.ok(!rec.coderResult, "coderResult cleared on audit-only resume");
  assert.ok(rec.resumedAt);
  for (const [id, n] of calls) assert.equal(n, afterRun1.get(id) ?? 0, `${id} not re-called`);
}));

test("resume with no saved record → falls back to a fresh run", () => withRunsDir(async (dir) => {
  const call = async (o) => {
    if (o.agentId === "g.producer") return res("Inline answer, no dispatch.");
    return res("unexpected");
  };
  // No prior t-missing.json exists; --resume should warn and run fresh.
  const code = await run({ task: "What is 2+2?", cfg: makeCfg(dir), runId: "t-missing", resume: true, json: true, verbose: false, call });
  assert.equal(code, 0);
  assert.equal(readRecord(dir, "t-missing").finalAnswer, "Inline answer, no dispatch.");
}));
