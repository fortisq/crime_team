// Tests for the citation hallucination-guard. Verifies against THIS repo as
// the workspace so the fixtures are real files (stable in CI checkouts).
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseCitations, verifyCitations, formatVerificationReport, clearIndexCache } from "../dist/citations.js";

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

// D2: on a basename collision the guard must check the line against ALL
// candidate files, not an arbitrary matches[0] — so a line valid in one of the
// same-named files isn't falsely failed, and the ambiguity is surfaced.
test("basename collision: ambiguous when the line fits some candidate, hard-fail when it fits none", () => {
  const ws = join(tmpdir(), `ct-cite-collision-${Date.now()}`);
  mkdirSync(join(ws, "a"), { recursive: true });
  mkdirSync(join(ws, "b"), { recursive: true });
  writeFileSync(join(ws, "a", "dup.ts"), Array(10).fill("x").join("\n")); // 10 lines
  writeFileSync(join(ws, "b", "dup.ts"), Array(3).fill("y").join("\n"));  // 3 lines
  clearIndexCache();
  try {
    // line 8 is in range in a/dup.ts (10) but not b/dup.ts (3). A bare basename
    // is ambiguous → must NOT hard-fail just because one candidate is too short.
    const amb = verifyCitations(parseCitations("see dup.ts:8 here"), ws)[0];
    assert.equal(amb.status, "ambiguous-basename");
    assert.equal(amb.ambiguousCount, 2);

    // line 50 is out of range in BOTH → a genuine problem still trips the guard.
    const oor = verifyCitations(parseCitations("see dup.ts:50 here"), ws)[0];
    assert.equal(oor.status, "line-out-of-range");

    // Path-qualifying disambiguates → a clean "verified", no ambiguity flag.
    const exact = verifyCitations(parseCitations("see a/dup.ts:8 here"), ws)[0];
    assert.equal(exact.status, "verified");
    assert.equal(exact.ambiguousCount, undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
