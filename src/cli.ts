// crime-team CLI entry point.
//
// Usage:
//   crime-team "your task" [--verbose] [--resume <runId>] [--timeout <sec>]
//   crime-team --help
//
// Reads .crime-team.json from CWD for per-agent timeouts + producer name.

import { orchestrate } from "./orchestrator.js";
import { loadConfig } from "./config.js";

interface Args { task?: string; verbose: boolean; resume?: string; timeout?: number; help: boolean; smartDispatch: boolean; }

function parseArgv(argv: string[]): Args {
  const a: Args = { verbose: false, help: false, smartDispatch: false };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--verbose" || t === "-v") a.verbose = true;
    else if (t === "--smart-dispatch" || t === "--smart") a.smartDispatch = true;
    else if (t === "--resume") a.resume = tokens[++i];
    else if (t === "--timeout") a.timeout = Number(tokens[++i]);
    else if (!a.task) a.task = t;
    else throw new Error(`unexpected arg: ${t} (only one positional task argument; quote it)`);
  }
  return a;
}

function printHelp() {
  console.log(`
crime-team — multi-agent orchestrator for myproject

USAGE
  crime-team "your task"            run a fresh team task
  crime-team "..." --verbose        also print specialist replies as they arrive
  crime-team --resume <runId>       (planned) re-run integration from a saved run

OPTIONS
  --verbose, -v   Print specialist replies inline (otherwise: only the final integrated answer)
  --timeout <s>   Override the default per-call timeout in seconds (default per-agent in .crime-team.json)
  --resume <id>   Resume an earlier run (only its integration phase). Not yet implemented.
  --help, -h      Show this

CONFIG
  Reads .crime-team.json from CWD. See README for the schema.

OUTPUT
  - Live spinner per agent with elapsed seconds
  - On success: prints the Producer's integrated answer
  - All runs persist to ./runs/<runId>.json for review
`.trim());
}

async function main() {
  let args: Args;
  try { args = parseArgv(process.argv); }
  catch (e) { console.error(String(e)); process.exit(2); }

  if (args.help || !args.task) { printHelp(); process.exit(args.help ? 0 : 2); }

  const cfg = loadConfig();
  if (args.timeout) {
    cfg.defaultTimeoutSec = args.timeout;
    for (const k of Object.keys(cfg.perAgent)) cfg.perAgent[k]!.timeoutSec = args.timeout;
  }

  const code = await orchestrate({
    task: args.task!,
    cfg,
    runId: args.resume,
    verbose: args.verbose,
    smartDispatch: args.smartDispatch,
  });
  process.exit(code);
}

main().catch(e => { console.error(e); process.exit(1); });
