// Citation verification — the hallucination guard.
//
// Specialists routinely cite files like `index.ts:662` or `lib/game/resolve.ts:40`.
// This module parses every such citation from a reply, tries to resolve it in
// the workspace, and flags anything that doesn't exist or whose line number is
// out of range. The orchestrator appends a verification report to the reply
// before forwarding to Producer for integration — so Producer can call out
// unverified citations in the final answer.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

export interface Citation {
  raw: string;        // exact substring matched, e.g. "index.ts:662" or "lib/x.ts:84-101"
  path: string;       // e.g. "index.ts" or "lib/x.ts"
  lineStart?: number;
  lineEnd?: number;
}

export interface VerifiedCitation extends Citation {
  status: "verified" | "ambiguous-basename" | "file-not-found" | "line-out-of-range";
  resolvedPath?: string;     // absolute path that was actually checked
  totalLines?: number;
}

// File extensions we treat as "could be a code citation" — used to filter the
// regex's many false positives (version numbers, urls, sentence-ending dots).
const CODE_EXTS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","mts","cts",
  "rs","py","go","rb","java","kt","swift","c","h","cpp","hpp","cs",
  "json","yaml","yml","toml","html","css","scss","sass","md","mdx","txt",
  "sql","prisma","graphql","gql","sh","ps1","bat","cmd",
]);

// Directories we never recurse into when building the workspace file index.
const SKIP_DIRS = new Set([
  "node_modules",".git","dist","build","out",".next",".turbo","target",
  ".openclaw",".claude",".vscode",".idea","coverage",".cache","tmp",
]);

// Conservative regex: a path-ish run of chars ending with .EXT, optionally
// followed by :LINE or :LINE-LINE. The negative-lookbehind and lookahead
// keep us from gobbling URLs, version numbers, or function names.
const CITATION_RE =
  /(?<![A-Za-z0-9_\-./])([A-Za-z0-9_.\-/\\]+\.[A-Za-z]{1,6})(?::(\d+)(?:[-–](\d+))?)?(?![A-Za-z0-9_/])/g;

export function parseCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const path = m[1]!.replace(/\\/g, "/");
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (!CODE_EXTS.has(ext)) continue;
    const lineStart = m[2] ? parseInt(m[2], 10) : undefined;
    const lineEnd = m[3] ? parseInt(m[3], 10) : undefined;
    // Dedupe on (path, lineStart) so the same finding cited 3× doesn't bloat.
    const key = `${path}#${lineStart ?? "-"}#${lineEnd ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m[0], path, lineStart, lineEnd });
  }
  return out;
}

// ───────────────────────── workspace index ─────────────────────────

// basename → list of absolute paths in the workspace
type FileIndex = Map<string, string[]>;
const indexCache = new Map<string, FileIndex>();

function buildIndex(workspace: string): FileIndex {
  const cached = indexCache.get(workspace);
  if (cached) return cached;
  const index: FileIndex = new Map();
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const list = index.get(e.name);
        const full = join(dir, e.name);
        if (list) list.push(full); else index.set(e.name, [full]);
      }
    }
  };
  walk(workspace, 0);
  indexCache.set(workspace, index);
  return index;
}

export function clearIndexCache(): void { indexCache.clear(); }

// ───────────────────────── verification ─────────────────────────

export function verifyCitations(
  citations: Citation[],
  workspace: string,
): VerifiedCitation[] {
  if (!workspace || !existsSync(workspace)) {
    return citations.map(c => ({ ...c, status: "file-not-found" as const }));
  }
  const index = buildIndex(workspace);

  return citations.map((c): VerifiedCitation => {
    // 1) Exact relative path under workspace?
    const exact = join(workspace, c.path);
    if (existsSync(exact) && statSync(exact).isFile()) {
      return checkLines(c, exact);
    }
    // 2) Match against basename index. Path may include trailing segments.
    const wantedBase = basename(c.path);
    const candidates = index.get(wantedBase);
    if (!candidates || candidates.length === 0) {
      return { ...c, status: "file-not-found" };
    }
    // Prefer candidates whose relative path ends with the cited path.
    const tail = c.path.replace(/^\.?\//, "");
    const matches = candidates.filter(p => p.replace(/\\/g, "/").endsWith(tail));
    const pick = matches.length === 1 ? matches[0]
               : matches.length > 1   ? matches[0]   // ambiguous; take first
               : candidates.length === 1 ? candidates[0]
               : candidates[0];
    const ambiguous = (matches.length > 1) || (matches.length === 0 && candidates.length > 1);
    const result = checkLines(c, pick!);
    if (ambiguous && result.status === "verified") result.status = "ambiguous-basename";
    return result;
  });
}

function checkLines(c: Citation, resolvedPath: string): VerifiedCitation {
  if (c.lineStart === undefined) {
    return { ...c, status: "verified", resolvedPath };
  }
  let totalLines = 0;
  try {
    totalLines = readFileSync(resolvedPath, "utf8").split(/\r?\n/).length;
  } catch {
    return { ...c, status: "file-not-found", resolvedPath };
  }
  const top = c.lineEnd ?? c.lineStart;
  if (c.lineStart < 1 || top > totalLines) {
    return { ...c, status: "line-out-of-range", resolvedPath, totalLines };
  }
  return { ...c, status: "verified", resolvedPath, totalLines };
}

// ───────────────────────── report formatting ─────────────────────────

export function formatVerificationReport(verified: VerifiedCitation[]): string {
  if (verified.length === 0) return "";
  const counts = { verified: 0, ambiguous: 0, missing: 0, oor: 0 };
  for (const v of verified) {
    if (v.status === "verified") counts.verified++;
    else if (v.status === "ambiguous-basename") counts.ambiguous++;
    else if (v.status === "file-not-found") counts.missing++;
    else if (v.status === "line-out-of-range") counts.oor++;
  }
  const ok = counts.verified + counts.ambiguous;
  const bad = counts.missing + counts.oor;
  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push(`CITATION CHECK: ${ok}/${verified.length} verified` +
             (counts.ambiguous ? ` (${counts.ambiguous} via basename, ambiguous)` : "") +
             (bad ? ` — ${bad} UNVERIFIED` : ""));
  if (bad === 0 && counts.ambiguous === 0) {
    lines.push("All cited file:line references resolve and are within range.");
    return lines.join("\n");
  }
  for (const v of verified) {
    if (v.status === "verified") continue;
    const where = v.lineStart !== undefined
      ? `${v.path}:${v.lineStart}${v.lineEnd ? "-" + v.lineEnd : ""}`
      : v.path;
    if (v.status === "ambiguous-basename") {
      lines.push(`? ${where} — basename matched but path ambiguous (resolved to ${v.resolvedPath})`);
    } else if (v.status === "file-not-found") {
      lines.push(`✗ ${where} — FILE NOT FOUND in workspace`);
    } else if (v.status === "line-out-of-range") {
      lines.push(`✗ ${where} — line out of range (file has ${v.totalLines} lines)`);
    }
  }
  return lines.join("\n");
}
