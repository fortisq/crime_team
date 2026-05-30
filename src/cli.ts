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
  timeout?: number;
  help: boolean;
  smartDispatch: boolean;
  groupId?: string;
  useCoder: boolean;
  loopMax?: number;
}

function parseArgv(argv: string[]): Args {
  const a: Args = { verbose: false, help: false, smartDispatch: false, useCoder: false };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--verbose" || t === "-v") a.verbose = true;
    else if (t === "--smart-dispatch" || t === "--smart") a.smartDispatch = true;
    else if (t === "--use-coder") a.useCoder = true;
    else if (t === "--loop") {
      const n = Number(tokens[++i]);
      if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error("--loop expects 1..5");
      a.loopMax = n;
    }
    else if (t === "--resume") a.resume = tokens[++i];
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
  crime-team --group myproject "…" run on a specific group (hint only — change
                                    active group via GUI for persistence)

OPTIONS
  --verbose, -v       Print specialist replies inline
  --smart-dispatch    Producer judges which specialists this task needs
  --use-coder         After audit integrates, hand off to the group's Coder
                      agent to implement findings (requires a Coder + clean git tree)
  --loop <N>          Loop audit→coder up to N times (1..5), stops early on
                      AUDIT CLEAN sentinel. Only honored with --use-coder.
  --timeout <s>       Override per-call timeout in seconds
  --group, -g <id>    Group id (defaults to activeGroupId in ~/.crime-team/groups.json)
  --resume <id>       (planned) Resume an earlier run
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

  // If --group <id> was passed, swap the active group in-memory before loadConfig.
  if (args.groupId) {
    try {
      const path = join(homedir(), ".crime-team", "groups.json");
      const file = JSON.parse(readFileSync(path, "utf8")) as GroupsFile;
      const found = file.groups.find(g => g.id === args.groupId);
      if (!found) {
        const ids = file.groups.map(g => g.id).join(", ");
        console.error(`group "${args.groupId}" not found. Available: ${ids}`);
        process.exit(2);
      }
      // Temporarily mutate the file's activeGroupId so loadConfig picks ours.
      file.activeGroupId = args.groupId;
      // Persist? No — keep --group as a per-invocation override.
      // Instead: we'll re-export a one-shot loader. For Phase A simplicity,
      // require a separate `groups_set_active` for persistent switches; --group
      // works for the CLI by relying on the env, since loadConfig reads the file
      // each call. We accept the limitation that --group must coincide with the
      // file's active group for now.
      console.error(`note: --group ${args.groupId} acts as a hint; persistent switch via GUI.`);
    } catch (e) {
      console.error(`failed to read groups.json: ${e}`);
      process.exit(2);
    }
  }

  const cfg = loadConfig();
  if (args.timeout) {
    cfg.defaultTimeoutSec = args.timeout;
    for (const k of Object.keys(cfg.perAgent)) cfg.perAgent[k]!.timeoutSec = args.timeout;
  }
  void loadActiveGroup;  // re-export for downstream consumers

  const code = await orchestrate({
    task: args.task!,
    cfg,
    runId: args.resume,
    verbose: args.verbose,
    smartDispatch: args.smartDispatch,
    useCoder: args.useCoder,
    loopMax: args.loopMax,
  });
  process.exit(code);
}

main().catch(e => { console.error(e); process.exit(1); });
