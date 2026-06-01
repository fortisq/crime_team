// Tests for clampThinking — the guard that downgrades 'max' to 'high' on
// non-Opus models (where 'max' silently hangs claude-cli). Uses an agent id
// guaranteed absent from the model map so the result is deterministic in CI
// (no ~/.openclaw/openclaw.json) and locally alike: unknown model → not Opus.
import test from "node:test";
import assert from "node:assert/strict";
import { clampThinking } from "../dist/agent.js";

const UNKNOWN = "test.definitely-not-a-real-agent-id";

test("non-max levels pass through untouched", () => {
  for (const t of ["low", "medium", "high", "minimal", "adaptive"]) {
    assert.equal(clampThinking(UNKNOWN, t), t);
  }
});

test("empty/off/undefined pass through untouched", () => {
  assert.equal(clampThinking(UNKNOWN, ""), "");
  assert.equal(clampThinking(UNKNOWN, "off"), "off");
  assert.equal(clampThinking(UNKNOWN, undefined), undefined);
});

test("'max' clamps to 'high' on an unknown / non-Opus model", () => {
  assert.equal(clampThinking(UNKNOWN, "max"), "high");
});
