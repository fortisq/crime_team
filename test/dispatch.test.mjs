// Tests for the DISPATCH wire-grammar parser. The orchestrator↔Producer
// contract lives entirely in this regex: a parse miss silently degrades into
// full-roster auto-fan-out, so these guard against quiet Producer-prompt
// regressions. Run against the built module (npm run build first).
import test from "node:test";
import assert from "node:assert/strict";
import { parseDispatches, formatDispatchMessage } from "../dist/dispatch.js";

const block = (agent) => `DISPATCH: ${agent}
TASK: do a thing
CONTEXT: src/
DELIVERABLE: a result`;

test("parses two well-formed blocks separated by a blank line", () => {
  const d = parseDispatches(`Plan.\n\n${block("architect")}\n\n${block("qa")}`);
  assert.deepEqual(d.map(x => x.agent), ["architect", "qa"]);
  assert.equal(d[0].task, "do a thing");
  assert.equal(d[0].context, "src/");
  assert.equal(d[0].deliverable, "a result");
});

test("tolerates markdown-bolded labels (non-Claude models)", () => {
  const bold = "**DISPATCH: frontend**\n**TASK:** ui audit\n**CONTEXT:** src/ui\n**DELIVERABLE:** findings";
  assert.deepEqual(parseDispatches(bold).map(x => x.agent), ["frontend"]);
});

test("prose with no blocks parses to zero dispatches", () => {
  assert.equal(parseDispatches("just an inline answer, no blocks here").length, 0);
});

test("a block missing DELIVERABLE is dropped (not half-parsed)", () => {
  const broken = "DISPATCH: architect\nTASK: x\nCONTEXT: y";
  assert.equal(parseDispatches(broken).length, 0);
});

test("parses hyphenated role ids (e.g. art-director)", () => {
  const d = parseDispatches("DISPATCH: art-director\nTASK: x\nCONTEXT: y\nDELIVERABLE: z");
  assert.equal(d.length, 1);
  assert.equal(d[0].agent, "art-director");
});

test("formatDispatchMessage round-trips the three fields", () => {
  const msg = formatDispatchMessage({ agent: "qa", task: "t", context: "c", deliverable: "d" });
  assert.equal(msg, "TASK: t\nCONTEXT: c\nDELIVERABLE: d");
});
