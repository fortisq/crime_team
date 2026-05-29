// Parse DISPATCH blocks out of Producer's reply.
//
// Expected format:
//
//   DISPATCH: <agent-id>
//   TASK: <one-line summary>
//   CONTEXT: <files/sections>
//   DELIVERABLE: <what they produce>
//
//   DISPATCH: <next>
//   ...
//
// Blocks are separated by a blank line or another DISPATCH:.

import type { DispatchBlock } from "./types.js";

const BLOCK_RE =
  /DISPATCH:\s*(?<agent>[^\s<>]+(?:<[^>]+>)?)\s*\r?\n\s*TASK:\s*(?<task>.+?)\r?\n\s*CONTEXT:\s*(?<context>.+?)\r?\n\s*DELIVERABLE:\s*(?<deliv>.+?)(?=\r?\n\s*\r?\n|\r?\n\s*DISPATCH:|\s*$)/gms;

export function parseDispatches(text: string): DispatchBlock[] {
  const out: DispatchBlock[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const g = m.groups!;
    out.push({
      agent: g.agent.replace(/^<|>$/g, "").trim(),
      task: g.task.trim(),
      context: g.context.trim(),
      deliverable: g.deliv.trim(),
    });
  }
  return out;
}

/** Format a dispatch block as the message body sent to the specialist. */
export function formatDispatchMessage(d: DispatchBlock): string {
  return `TASK: ${d.task}\nCONTEXT: ${d.context}\nDELIVERABLE: ${d.deliverable}`;
}
