// Tests for agent.ts data-safety + clamp behavior: the thinking-clamp now
// routes through a callback (not stderr), and the child env is an allow-list
// rather than the full process.env (which leaked every secret to subprocesses).
import test from "node:test";
import assert from "node:assert/strict";
import { clampThinking, childEnv } from "../dist/agent.js";

test("clampThinking routes its warning through onWarn (not stderr) and still clamps", () => {
  const msgs = [];
  // Use an agent id guaranteed absent from ~/.openclaw model map → unknown
  // model → not Opus → max clamps to high, deterministically.
  const out = clampThinking("test.definitely-unknown-agent", "max", (m) => msgs.push(m));
  assert.equal(out, "high");
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /clamping thinking='max'/);
});

test("clampThinking passes non-max levels through untouched", () => {
  for (const t of ["low", "medium", "high", "off", "", undefined]) {
    assert.equal(clampThinking("test.unknown", t), t);
  }
});

test("childEnv forwards needed vars and DROPS unrelated secrets", () => {
  const SECRET = "CT_TEST_SECRET_TOKEN";
  const ALLOWED = "OPENCLAW_TEST_FLAG";
  process.env[SECRET] = "supersecret";
  process.env[ALLOWED] = "1";
  process.env.PATH = process.env.PATH || "/usr/bin";
  try {
    const env = childEnv();
    assert.ok("PATH" in env || "Path" in env, "PATH must be forwarded");
    assert.equal(env[ALLOWED], "1", "OPENCLAW_* must be forwarded");
    assert.ok(!(SECRET in env), "an unrelated secret must NOT be forwarded");
  } finally {
    delete process.env[SECRET];
    delete process.env[ALLOWED];
  }
});
