// Tests for the citation hallucination-guard. Verifies against THIS repo as
// the workspace so the fixtures are real files (stable in CI checkouts).
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCitations, verifyCitations, formatVerificationReport } from "../dist/citations.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseCitations extracts path + line range, ignores non-code tokens", () => {
  const cites = parseCitations("see src/config.ts:5 and lib/x.ts:10-20 but not version 1.2 or foo.bar");
  const raws = cites.map(c => c.raw);
  assert.ok(raws.includes("src/config.ts:5"));
  assert.ok(raws.includes("lib/x.ts:10-20"));
  const ranged = cites.find(c => c.path === "lib/x.ts");
  assert.equal(ranged.lineStart, 10);
  assert.equal(ranged.lineEnd, 20);
});

test("verifyCitations flags real / missing / out-of-range correctly", () => {
  const cites = parseCitations("src/config.ts:1 and src/zzz-does-not-exist.ts:5 and package.json:99999");
  const v = verifyCitations(cites, repoRoot);
  const byPath = Object.fromEntries(v.map(x => [x.path, x.status]));
  assert.equal(byPath["src/config.ts"], "verified");
  assert.equal(byPath["src/zzz-does-not-exist.ts"], "file-not-found");
  assert.equal(byPath["package.json"], "line-out-of-range");
});

test("report stays silent on an all-clean set and shouts on a bad one", () => {
  const clean = verifyCitations(parseCitations("src/config.ts:1"), repoRoot);
  assert.match(formatVerificationReport(clean), /verified/);
  const bad = verifyCitations(parseCitations("src/nope.ts:1"), repoRoot);
  assert.match(formatVerificationReport(bad), /UNVERIFIED/);
});
