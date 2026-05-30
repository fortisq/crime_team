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

// Some models (especially non-Claude ones) wrap labels in markdown bold:
//   **DISPATCH: backend**          (whole line bolded)
//   **TASK:** Review ...           (only the label bolded)
// The regex above expects raw labels, so a markdown-styled Producer reply
// silently parses as 0 dispatches and forces the auto-fan-out path. Pre-strip
// the bold markers so a well-formed-but-styled reply parses cleanly.
function stripMarkdownLabels(text: string): string {
  return text
    // **LABEL:** value   →   LABEL: value
    .replace(/\*\*\s*(DISPATCH|TASK|CONTEXT|DELIVERABLE)\s*:\s*\*\*/gi, "$1:")
    // **LABEL: value**   →   LABEL: value
    .replace(/\*\*\s*(DISPATCH|TASK|CONTEXT|DELIVERABLE)\s*:\s*([^\n*]*)\*\*/gi, "$1: $2")
    // _LABEL:_ value     →   LABEL: value
    .replace(/_\s*(DISPATCH|TASK|CONTEXT|DELIVERABLE)\s*:\s*_/gi, "$1:")
    // Stray opening **LABEL: ... newline (no closing **)  →  LABEL: ...
    .replace(/\*\*(DISPATCH|TASK|CONTEXT|DELIVERABLE)\s*:/gi, "$1:");
}

export function parseDispatches(text: string): DispatchBlock[] {
  const normalized = stripMarkdownLabels(text);
  const out: DispatchBlock[] = [];
  for (const m of normalized.matchAll(BLOCK_RE)) {
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
