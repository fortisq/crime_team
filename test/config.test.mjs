// Tests for the pure group-identity helpers (no filesystem). The dotted/role
// duality is hand-handled in many places; these pin the conversion both ways.
import test from "node:test";
import assert from "node:assert/strict";
import { roleOf, fullyQualify } from "../dist/config.js";

test("roleOf strips the group prefix, leaves unprefixed ids alone", () => {
  assert.equal(roleOf("crimeos.architect", "crimeos"), "architect");
  assert.equal(roleOf("architect", "crimeos"), "architect");
});

test("fullyQualify adds the prefix, leaves already-qualified ids alone", () => {
  assert.equal(fullyQualify("architect", "crimeos"), "crimeos.architect");
  assert.equal(fullyQualify("crimeos.architect", "crimeos"), "crimeos.architect");
});

test("roleOf ∘ fullyQualify is identity on a role", () => {
  for (const role of ["architect", "qa", "art-director", "coder"]) {
    assert.equal(roleOf(fullyQualify(role, "g"), "g"), role);
  }
});
