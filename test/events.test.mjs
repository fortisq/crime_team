// Tests for the structured event emitter — the new orchestrator↔GUI contract.
// A regression here silently breaks the GUI's event consumer, so pin the wire
// format (sentinel prefix, schema version, single-line JSON) and the two output
// modes (dual vs json-only).
import test from "node:test";
import assert from "node:assert/strict";
import { createEmitter, formatEventLine, EVENT_SENTINEL, EVENT_SCHEMA_VERSION } from "../dist/events.js";

/** Run `fn` while capturing console.log lines. */
function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test("formatEventLine prefixes the sentinel and is single-line JSON", () => {
  const line = formatEventLine({ type: "phase", phase: "plan", iteration: 1, label: "x", v: 1, runId: "r", ts: "t" });
  assert.ok(line.startsWith(EVENT_SENTINEL));
  assert.ok(!line.slice(EVENT_SENTINEL.length).includes("\n"));
  const obj = JSON.parse(line.slice(EVENT_SENTINEL.length));
  assert.equal(obj.type, "phase");
  assert.equal(obj.runId, "r");
});

test("event() stamps v/runId/ts and emits one sentinel line", () => {
  const em = createEmitter("team-1", false);
  const lines = capture(() => em.event({ type: "done", ok: true, exitCode: 0, totalMs: 5 }));
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0].slice(EVENT_SENTINEL.length));
  assert.equal(obj.v, EVENT_SCHEMA_VERSION);
  assert.equal(obj.runId, "team-1");
  assert.equal(typeof obj.ts, "string");
});

test("default mode: warn emits BOTH an event line and a human line", () => {
  const em = createEmitter("team-1", false);
  const lines = capture(() => em.warn("agent", "clamped"));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith(EVENT_SENTINEL));
  assert.ok(lines[1].includes("clamped") && !lines[1].startsWith(EVENT_SENTINEL));
});

test("json mode: log() is suppressed, event() still emits", () => {
  const em = createEmitter("team-1", true);
  const logLines = capture(() => em.log("info", "should be hidden"));
  assert.equal(logLines.length, 0);
  const evLines = capture(() => em.event({ type: "phase", phase: "p", iteration: 1, label: "l" }));
  assert.equal(evLines.length, 1);
});

test("an answer event keeps multi-line text on ONE wire line", () => {
  const em = createEmitter("team-1", false);
  const lines = capture(() => em.event({ type: "answer", iteration: 1, kind: "integrated", text: "line1\nline2\nline3" }));
  const evLine = lines.find(l => l.startsWith(EVENT_SENTINEL));
  assert.ok(!evLine.slice(EVENT_SENTINEL.length).includes("\n"));
  assert.equal(JSON.parse(evLine.slice(EVENT_SENTINEL.length)).text, "line1\nline2\nline3");
});
