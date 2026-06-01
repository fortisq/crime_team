// Tests for detectNoFindings — the AUDIT CLEAN sentinel detector that decides
// whether the --loop wrapper stops early. A false positive ends the loop
// prematurely; a false negative loops forever (until loopMax).
import test from "node:test";
import assert from "node:assert/strict";
import { detectNoFindings } from "../dist/orchestrator.js";

test("matches the exact sentinel on its own line", () => {
  assert.equal(detectNoFindings("AUDIT CLEAN — no regressions or remaining issues."), true);
});

test("matches the sentinel with a hyphen and no trailing period", () => {
  assert.equal(detectNoFindings("intro\nAUDIT CLEAN - no regressions or remaining issues\nmore"), true);
});

test("backup heuristic: short 'no findings' lead with no flags", () => {
  assert.equal(detectNoFindings("No findings. Everything looks good."), true);
});

test("does NOT fire when dispatch/flag markers are present", () => {
  const withFlags = "No findings up top, but:\nDISPATCH: architect\nINVARIANT VIOLATION: x";
  assert.equal(detectNoFindings(withFlags), false);
});

test("does NOT fire on an ordinary report", () => {
  assert.equal(detectNoFindings("Here are 3 issues I found in the audit, ranked by severity."), false);
});
