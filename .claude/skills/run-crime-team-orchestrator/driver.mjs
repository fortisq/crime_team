#!/usr/bin/env node
// driver.mjs — smoke-drives the crime-team ENGINE without making any real
// OpenClaw agent calls (which cost real Opus tokens + minutes). It exercises
// the layer recent PRs actually touch: dispatch parsing, the citation
// hallucination-guard, and the group/config resolution helpers — by importing
// the built modules and calling them directly. Plus a subprocess check that the
// real CLI binary launches.
//
// Usage (from repo root):
//   node .claude/skills/run-crime-team-orchestrator/driver.mjs           # checks only
//   node .claude/skills/run-crime-team-orchestrator/driver.mjs --build   # tsc first
//
// Exit 0 = all checks passed; exit 1 = at least one failed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");          // repo root, 3 levels up
const dist = join(root, "dist");
const doBuild = process.argv.includes("--build");

const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push({ name, ok, got: String(got), want: String(want) });
};

if (doBuild || !existsSync(join(dist, "cli.js"))) {
  console.log("[driver] npm run build …");
  const b = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (b.status !== 0) { console.error("[driver] build failed"); process.exit(1); }
}

// ── 1. real CLI binary launches and prints usage ────────────────────────────
const help = spawnSync(process.execPath, [join(root, "bin", "crime-team.mjs"), "--help"], { encoding: "utf8" });
check("cli --help exit code", help.status, 0);
check("cli --help prints USAGE", /USAGE/.test(help.stdout || ""), true);

// ── import built engine modules (ESM) ───────────────────────────────────────
const { parseDispatches } = await import(pathToFileURL(join(dist, "dispatch.js")).href);
const { parseCitations, verifyCitations } = await import(pathToFileURL(join(dist, "citations.js")).href);
const { roleOf, fullyQualify, loadActiveGroup, loadConfig, auditSpecialists } = await import(pathToFileURL(join(dist, "config.js")).href);

// ── 2. dispatch wire-grammar parser (plain + markdown-bold variants) ────────
const plain = `Plan first.

DISPATCH: architect
TASK: map the reducers
CONTEXT: src/store
DELIVERABLE: a list

DISPATCH: qa
TASK: check tests
CONTEXT: test/
DELIVERABLE: gaps`;
check("dispatch parses 2 plain blocks", parseDispatches(plain).map(d => d.agent).join(","), "architect,qa");
const bold = "**DISPATCH: frontend**\n**TASK:** ui audit\n**CONTEXT:** src/ui\n**DELIVERABLE:** findings";
check("dispatch tolerates markdown-bold labels", parseDispatches(bold).map(d => d.agent).join(","), "frontend");
check("malformed reply parses 0 dispatches", parseDispatches("just prose, no blocks").length, 0);

// ── 3. citation hallucination-guard (verify against THIS repo as workspace) ──
const cites = parseCitations("see src/config.ts:1 and src/zzz-fake.ts:5 and package.json:99999");
const statuses = verifyCitations(cites, root).map(v => v.status).join(",");
check("citations: real/fake/out-of-range", statuses, "verified,file-not-found,line-out-of-range");

// ── 4. group identity helpers (prefix <-> role) ─────────────────────────────
check("roleOf strips group prefix", roleOf("crimeos.architect", "crimeos"), "architect");
check("fullyQualify adds group prefix", fullyQualify("architect", "crimeos"), "crimeos.architect");

// ── 5. live config: active group loads + Coder excluded from audit roster ────
const g = loadActiveGroup();
check("active group loads from groups.json", g != null && typeof g.id === "string", true);
const cfg = loadConfig();
const aud = auditSpecialists(cfg);
const coder = cfg.activeGroup.coderAgentId;
check("auditSpecialists excludes the Coder", coder ? !aud.includes(coder) : true, true);

// ── report ──────────────────────────────────────────────────────────────────
let failed = 0;
console.log("\n" + "=".repeat(64));
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${r.name}`);
  if (!r.ok) { console.log(`        got=${r.got}  want=${r.want}`); failed++; }
}
console.log("=".repeat(64));
console.log(`${results.length - failed}/${results.length} checks passed (active group: ${g?.id ?? "?"})`);
process.exit(failed ? 1 : 0);
