// crime-team CLI entry point.
//
// Usage:
//   crime-team "your task" [--verbose] [--group <id>] [--timeout <sec>]
//   crime-team --help
//
// Reads ~/.crime-team/groups.json to find the active group (or use --group to
// override). Reads .crime-team.json from CWD for per-agent timeouts.

import { orchestrate } from "./orchestrator.js";
import { loadConfig, loadActiveGroup } from "./config.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GroupsFile } from "./types.js";

interface Args {
  task?: string;
  verbose: boolean;
  resume?: string;
  runId?: string;
  json: boolean;
  timeout?: number;
  help: boolean;
  smartDispatch: boolean;
  groupId?: string;
  useCoder: boolean;
  loopMax?: number;
}

function parseArgv(argv: string[]): Args {
  const a: Args = { verbose: false, help: false, smartDispatch: false, useCoder: false, json: false };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--verbose" || t === "-v") a.verbose = true;
    else if (t === "--json") a.json = true;
    else if (t === "--smart-dispatch" || t === "--smart") a.smartDispatch = true;
    else if (t === "--use-coder") a.useCoder = true;
    else if (t === "--loop") {
      const n = Number(tokens[++i]);
      if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error("--loop expects 1..5");
      a.loopMax = n;
    }
    else if (t === "--resume") a.resume = tokens[++i];
    else if (t === "--run-id") a.runId = tokens[++i];
    else if (t === "--timeout") a.timeout = Number(tokens[++i]);
    else if (t === "--group" || t === "-g") a.groupId = tokens[++i];
    else if (!a.task) a.task = t;
    else throw new Error(`unexpected arg: ${t} (only one positional task argument; quote it)`);
  }
  return a;
}

function printHelp() {
  console.log(`
crime-team — multi-agent orchestrator (one team per project group)

USAGE
  crime-team "your task"            run a fresh team task on the active group
  crime-team "..." --verbose        also print specialist replies as they arrive
  crime-team "..." --smart-dispatch Let Producer pick specialists per task
  crime-team --group myproject "…" run this one task on a specific group

OPTIONS
  --verbose, -v       Print specialist replies inline
  --smart-dispatch    Producer judges which specialists this task needs
  --use-coder         After audit integrates, hand off to the group's Coder
                      agent to implement findings (requires a Coder + clean git tree)
  --loop <N>          Loop audit→coder up to N times (1..5), stops early on
                      AUDIT CLEAN sentinel. Only honored with --use-coder.
  --timeout <s>       Override per-call timeout in seconds
  --group, -g <id>    Group for this run — one-shot override, not persisted
                      (defaults to activeGroupId in ~/.crime-team/groups.json)
  --run-id <id>       Use this id for a fresh run (record/marker/events align).
                      The desktop GUI passes its run UUID here.
  --json              Emit machine-readable NDJSON events only (one @@CTEVT@@
                      line per event); suppresses human log lines + spinner.
  --resume <id>       Resume an earlier run: reuse phases that already
                      succeeded (plan, OK specialist replies, integration,
                      Coder, completed loop iterations) and re-run only from
                      the first gap. Unlike --run-id, never clobbers prior work.
  --help, -h          Show this

CONFIG
  - ~/.crime-team/groups.json       active group + group registry
  - .crime-team.json (in CWD)       per-group thinking levels, per-agent timeouts
  - ~/.openclaw/team-prompts/*.md   agent system prompts

OUTPUT
  - Live spinner per agent with elapsed seconds
  - On success: prints the Producer's integrated answer
  - All runs persist to ./runs/<group-id>/<runId>.json
`.trim());
}

async function main() {
  let args: Args;
  try { args = parseArgv(process.argv); }
  catch (e) { console.error(String(e)); process.exit(2); }

  if (args.help || !args.task) { printHelp(); process.exit(args.help ? 0 : 2); }

  // --group <id> is a one-shot override for THIS run (not persisted): validate
  // it exists, then pass it to loadConfig so it actually selects that group.
  if (args.groupId) {
    try {
      const path = join(homedir(), ".crime-team", "groups.json");
      const file = JSON.parse(readFileSync(path, "utf8")) as GroupsFile;
      if (!file.groups.find(g => g.id === args.groupId)) {
        const ids = file.groups.map(g => g.id).join(", ");
        console.error(`group "${args.groupId}" not found. Available: ${ids}`);
        process.exit(2);
      }
    } catch (e) {
      console.error(`failed to read groups.json: ${e}`);
      process.exit(2);
    }
  }

  const cfg = loadConfig(args.groupId);
  if (args.timeout) {
    cfg.defaultTimeoutSec = args.timeout;
    for (const k of Object.keys(cfg.perAgent)) cfg.perAgent[k]!.timeoutSec = args.timeout;
  }
  void loadActiveGroup;  // re-export for downstream consumers

  const code = await orchestrate({
    task: args.task!,
    cfg,
    // --run-id pins a caller-chosen id for a FRESH run (the desktop GUI passes
    // its UUID so the record + soft-cancel marker + emitted events all align).
    // --resume loads that id's saved record and continues from the first
    // incomplete phase. If both are given, the explicit --run-id picks the id.
    runId: args.runId ?? args.resume,
    resume: args.resume != null,
    json: args.json,
    verbose: args.verbose,
    smartDispatch: args.smartDispatch,
    useCoder: args.useCoder,
    loopMax: args.loopMax,
  });
  process.exit(code);
}

main().catch(e => { console.error(e); process.exit(1); });
