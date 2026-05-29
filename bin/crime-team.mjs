#!/usr/bin/env node
// crime-team launcher — uses the built JS if available, else tsx for dev.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "cli.js");
const src   = join(here, "..", "src", "cli.ts");

if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else if (existsSync(src)) {
  // Run via tsx for unbuilt dev usage.
  const r = spawn("npx", ["tsx", src, ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  r.on("exit", code => process.exit(code ?? 0));
} else {
  console.error("crime-team: neither dist/cli.js nor src/cli.ts found. Run `npm run build`.");
  process.exit(1);
}
