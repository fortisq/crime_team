// Core orchestrator: kick off Producer, parse dispatches, run specialists in
// parallel, feed replies back to Producer (chunked per-reply so each argv stays
// under the Windows CLI limit), print the integrated answer.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { callAgent, MAX_ARGV_CHARS } from "./agent.js";
import { parseDispatches, formatDispatchMessage } from "./dispatch.js";
import { type Config, timeoutFor, thinkingFor, fullyQualify, roleOf } from "./config.js";
import type { DispatchBlock, RunRecord } from "./types.js";
import { parseCitations, verifyCitations, formatVerificationReport } from "./citations.js";

export interface OrchestratorOpts {
  task: string;
  cfg: Config;
  /** Optional pre-existing runId (resume). */
  runId?: string;
  verbose: boolean;
  /**
   * When true, Producer judges which specialists are actually needed instead
   * of dispatching to all of them. Overrides the preset's "dispatch to all"
   * instruction. Default false (current always-dispatch behavior).
   */
  smartDispatch?: boolean;
}

export async function orchestrate(opts: OrchestratorOpts): Promise<number> {
  const runId = opts.runId ?? `team-${Math.floor(Date.now() / 1000)}`;
  const producerSession = `agent:${opts.cfg.producerAgent}:${runId}`;
  const record: RunRecord = {
    runId,
    startedAt: new Date().toISOString(),
    task: opts.task,
  };

  await mkdir(opts.cfg.runsDir, { recursive: true });
  const recordPath = join(opts.cfg.runsDir, `${runId}.json`);
  const persist = async () => writeFile(recordPath, JSON.stringify(record, null, 2));

  log("info", `runId=${runId}`);
  log("info", `record at ${recordPath}`);
  // Write the initial record immediately so the run is visible in the GUI's
  // sidebar even if the orchestrator (or its parent process) is killed before
  // Producer's first reply lands. Without this, an early kill leaves a 0-byte
  // JSON that list_runs silently skips — and the run vanishes.
  await persist();

  // --- Phase 1: Producer plans ---
  log("phase", "1/4 Producer planning");
  // Pin the valid specialist roster into the kickoff. Without this, smaller
  // models (DeepSeek, some open models) hallucinate stock role names like
  // "architect" / "frontend" / "backend" from training data instead of using
  // the actual group's specialists from the system prompt. The dispatched
  // names then don't resolve to real agents and the parallel run fails.
  const roster = opts.cfg.activeGroup.specialists.map(id => roleOf(id, opts.cfg.activeGroup.id));
  const rosterLine = `Valid specialists for this group: ${roster.join(", ")}. Use ONLY these exact names in DISPATCH blocks — do not invent role names like "architect" or "frontend" if they aren't listed.`;

  // Two modes:
  //   - smartDispatch ON:  Producer overrides preset's dispatch directive and
  //                        judges per-task. May answer inline.
  //   - smartDispatch OFF: Producer MUST follow preset's dispatch directive.
  //                        No inline escape hatch when preset asks for dispatches.
  const kickoff = opts.smartDispatch
    ? `${opts.task}

${rosterLine}

SMART DISPATCH MODE — Override the dispatch directive in the task above. Judge per-task which specialists this work actually needs. A small task may need only one specialist, or you may answer inline with no dispatches. Match dispatched specialists to the actual scope of the work — don't dispatch theatre. Quality over quantity. Emit DISPATCH blocks if needed, exact format per your system prompt. If the task is genuinely small enough to handle inline, do that with no dispatches.`
    : `${opts.task}

${rosterLine}

Follow the dispatch directive in the task above. If the task says to dispatch to specialists (e.g. "Dispatch in parallel to every relevant specialist"), you MUST emit DISPATCH blocks at the END of your reply (one per specialist, exact format per your system prompt) — do NOT answer inline. Inline answers are only appropriate when the task itself is trivial (e.g. a one-line question) AND does not explicitly request specialist dispatch.`;
  if (opts.smartDispatch) log("info", "smart dispatch enabled — Producer picks specialists per task");
  else log("info", "smart dispatch off — Producer must follow preset's dispatch directive");

  const tProducerStart = Date.now();
  const spin = startSpinner(`producer planning`);
  const plan = await callAgent({
    agentId: opts.cfg.producerAgent,
    sessionKey: producerSession,
    message: kickoff,
    timeoutSec: timeoutFor(opts.cfg, opts.cfg.producerAgent),
    thinkingLevel: thinkingFor(opts.cfg, opts.cfg.producerAgent),
  });
  spin.stop(plan.ok ? "ok" : "fail", plan.durationMs);

  if (!plan.ok) {
    log("error", `Producer planning failed: ${plan.text}`);
    record.producerPlan = plan.text;
    await persist();
    return 2;
  }
  record.producerPlan = plan.text;
  await persist();
  if (opts.verbose) log("trace", `Producer plan:\n${plan.text}\n`);

  // --- Phase 2: parse ---
  let dispatches = parseDispatches(plan.text);
  // Drop dispatches that target role names not in this group's roster.
  // Without this, a hallucinated "architect" dispatch in the crime-team-orchestra
  // group would resolve to crime-team-orchestra.architect — which doesn't exist —
  // and the parallel run would fail in 8s with no useful work done.
  const fullRoster = opts.cfg.activeGroup.specialists.map(id => roleOf(id, opts.cfg.activeGroup.id));
  const validRoles = new Set(fullRoster);
  const dropped = dispatches.filter(d => !validRoles.has(roleOf(d.agent, opts.cfg.activeGroup.id)));
  if (dropped.length > 0) {
    for (const d of dropped) {
      log("warn", `dropping dispatch to "${d.agent}" — not a specialist of group ${opts.cfg.activeGroup.id} (valid: ${fullRoster.join(", ")})`);
    }
    dispatches = dispatches.filter(d => validRoles.has(roleOf(d.agent, opts.cfg.activeGroup.id)));
  }

  // --- Phase 2a: full-roster enforcement ---
  // Smart Dispatch OFF + an "every/all" directive in the task means the user
  // wants the FULL specialist roster firing in parallel. If Producer judged
  // some specialists "not relevant" and skipped them, auto-add them with the
  // original task. Smart Dispatch OFF then truly means "all specialists run."
  if (!opts.smartDispatch && hasFullRosterDirective(opts.task) && dispatches.length > 0) {
    const dispatchedRoles = new Set(dispatches.map(d => roleOf(d.agent, opts.cfg.activeGroup.id)));
    const missing = fullRoster.filter(r => !dispatchedRoles.has(r));
    if (missing.length > 0) {
      log("warn", `Producer dispatched to ${dispatches.length}/${fullRoster.length} specialists. Auto-adding missing: ${missing.join(", ")} (Smart Dispatch OFF + "every/all" directive)`);
      for (const role of missing) {
        dispatches.push({
          agent: role,
          task: opts.task,
          context: "Read the workspace as needed to address the task above.",
          deliverable: "Your specialist findings on the task above. Cite specific file:line references.",
        });
      }
      record.producerPlan = `${plan.text}\n\n---\n[orchestrator: auto-added missing specialists ${missing.join(", ")} — Smart Dispatch OFF + every/all directive]\n---`;
    }
  }
  record.dispatches = dispatches;
  await persist();

  // --- Phase 2b: enforce Smart Dispatch OFF ---
  // When Smart Dispatch is OFF, an explicit dispatch directive in the task
  // ("dispatch in parallel", "dispatch to every", etc.) is binding. If Producer
  // returned zero dispatches anyway (some models like DeepSeek treat the
  // system-prompt's "small enough, just do it" line as a license to ignore the
  // directive), we (a) retry once with a forceful nudge, then (b) fall back to
  // an auto-fan-out so Smart Dispatch OFF actually means "dispatch happens".
  const taskHasDispatchDirective = hasDispatchDirective(opts.task);
  if (!opts.smartDispatch && dispatches.length === 0 && taskHasDispatchDirective) {
    log("warn", `Producer returned 0 dispatches but task explicitly requires dispatch. Retrying with stronger nudge…`);
    const retryMsg = `You did NOT emit any DISPATCH blocks. The task above explicitly requires dispatching to specialists ("Dispatch in parallel to every relevant specialist"). The Smart Dispatch override is OFF, so you cannot answer inline. Re-read the task. Emit DISPATCH blocks now, one per specialist, in the exact format from your system prompt. Do not write any analysis or report — only the DISPATCH blocks. Available specialists: ${opts.cfg.activeGroup.specialists.map(id => roleOf(id, opts.cfg.activeGroup.id)).join(", ")}.`;
    const spinR = startSpinner(`producer re-planning (forced dispatch)`);
    const replan = await callAgent({
      agentId: opts.cfg.producerAgent,
      sessionKey: producerSession,
      message: retryMsg,
      timeoutSec: timeoutFor(opts.cfg, opts.cfg.producerAgent),
      thinkingLevel: thinkingFor(opts.cfg, opts.cfg.producerAgent),
    });
    spinR.stop(replan.ok ? "ok" : "fail", replan.durationMs);
    if (replan.ok) {
      const retryDispatches = parseDispatches(replan.text);
      if (retryDispatches.length > 0) {
        log("ok", `retry produced ${retryDispatches.length} dispatch(es)`);
        dispatches = retryDispatches;
        record.producerPlan = `${plan.text}\n\n---\n[orchestrator: re-planned after 0-dispatch on enforced mode]\n---\n\n${replan.text}`;
        record.dispatches = dispatches;
        await persist();
      }
    }

    if (dispatches.length === 0) {
      const roles = opts.cfg.activeGroup.specialists.map(id => roleOf(id, opts.cfg.activeGroup.id));
      log("warn", `Producer still refused to dispatch. Auto-fanning out to all ${roles.length} specialists: ${roles.join(", ")}`);
      dispatches = roles.map(role => ({
        agent: role,
        task: opts.task,
        context: "Read the workspace as needed to address the task above.",
        deliverable: "Your specialist findings on the task above. Cite specific file:line references.",
      }));
      record.dispatches = dispatches;
      record.producerPlan = `${record.producerPlan}\n\n---\n[orchestrator: auto-fan-out — Producer refused dispatch on enforced mode]\n---`;
      await persist();
    }
  }

  if (dispatches.length === 0) {
    log("ok", `Producer answered inline (no dispatches). Time ${(plan.durationMs / 1000).toFixed(1)}s`);
    // Print with the same ==== markers we use after dispatching so the GUI's
    // answer-detection picks up inline answers too.
    console.log();
    console.log(chalk.bold.green("=".repeat(72)));
    console.log(chalk.bold.green("PRODUCER'S INTEGRATED ANSWER"));
    console.log(chalk.bold.green("=".repeat(72)));
    console.log(plan.text);
    console.log();
    record.finalAnswer = plan.text;
    record.endedAt = new Date().toISOString();
    await persist();
    log("ok", `done. runId=${runId}. total ${(plan.durationMs / 1000).toFixed(1)}s.`);
    return 0;
  }

  log("info", `Producer wants ${dispatches.length} specialist(s): ${dispatches.map(d => d.agent).join(", ")}`);

  // --- Phase 3: parallel specialist dispatch ---
  log("phase", "2/4 specialists running in parallel");

  const results = await runDispatchesInParallel(dispatches, runId, opts.cfg, opts.verbose);
  record.specialistResults = results.map(r => ({ agent: r.agent, reply: r.reply, ok: r.ok }));
  await persist();

  const okCount = results.filter(r => r.ok).length;
  const okResults = results.filter(r => r.ok);
  const failResults = results.filter(r => !r.ok);
  log(okCount === results.length ? "ok" : "warn",
      `${okCount}/${results.length} specialists returned ok`);

  // If every specialist failed, there's nothing to integrate. Bail with raw
  // failure info so the operator sees what went wrong (typically: API rate
  // limits, auth, or transport errors — never useful to feed to Producer).
  if (okResults.length === 0) {
    log("error", `all ${results.length} specialists failed — nothing to integrate`);
    record.finalAnswer = `All ${results.length} specialists failed:\n\n` +
      failResults.map(r => `- ${r.agent}: ${(r.reply || "").split("\n")[0].slice(0, 200)}`).join("\n");
    record.endedAt = new Date().toISOString();
    await persist();
    printRawReplies(results);
    return 1;
  }

  // --- Phase 4: feed replies back to Producer (one turn per reply) ---
  // Skip failed specialists — their "reply" is a stderr blob (e.g. a 429 rate
  // limit, an auth error, a transport error). Feeding that to Producer wastes
  // Producer's budget and pollutes the integration with garbage. Producer is
  // told up front which specialists failed so the integration can mention it.
  if (failResults.length > 0) {
    log("warn", `skipping ${failResults.length} failed specialist(s): ${failResults.map(r => r.agent).join(", ")}`);
    const failNote = `Heads up before specialist replies arrive: ${failResults.length} specialist(s) failed and will be skipped — ${failResults.map(r => `${r.agent} (${(r.reply || "").split("\n")[0].slice(0, 120).replace(/\n/g, " ")})`).join("; ")}. When you integrate, note which specialists were unavailable; do not invent their findings.`;
    const spinN = startSpinner(`notifying producer of failures`);
    const noteAck = await callAgent({
      agentId: opts.cfg.producerAgent,
      sessionKey: producerSession,
      message: failNote,
      timeoutSec: timeoutFor(opts.cfg, opts.cfg.producerAgent),
      thinkingLevel: thinkingFor(opts.cfg, opts.cfg.producerAgent),
    });
    spinN.stop(noteAck.ok ? "ok" : "fail", noteAck.durationMs);
    // Non-fatal if the notification ack fails; we'll continue with the ok replies.
  }

  log("phase", "3/4 feeding specialist replies to Producer");
  for (const r of okResults) {
    const sizeKB = (r.reply.length / 1024).toFixed(1);
    const fitTag = r.reply.length > MAX_ARGV_CHARS - 200 ? chalk.yellow(" [will truncate]") : "";
    log("info", `posting ${r.agent}'s reply (${sizeKB}KB)${fitTag}`);

    let body = `Specialist '${r.agent}' returned the following. Read it; acknowledge briefly; do NOT integrate yet:\n\n${r.reply}`;
    if (body.length > MAX_ARGV_CHARS - 200) {
      const trunc = MAX_ARGV_CHARS - 400;
      body = body.slice(0, trunc) + `\n\n[... reply truncated by orchestrator at ${trunc} chars; full content was ${r.reply.length} chars ...]`;
    }

    const spin2 = startSpinner(`producer acknowledging ${r.agent}`);
    const ack = await callAgent({
      agentId: opts.cfg.producerAgent,
      sessionKey: producerSession,
      message: body,
      timeoutSec: timeoutFor(opts.cfg, opts.cfg.producerAgent),
      thinkingLevel: thinkingFor(opts.cfg, opts.cfg.producerAgent),
    });
    spin2.stop(ack.ok ? "ok" : "fail", ack.durationMs);
    if (!ack.ok) {
      log("warn", `Producer failed to ack ${r.agent}; falling back to raw replies:`);
      printRawReplies(results);
      return 1;
    }
  }

  // --- Phase 5: integrate ---
  log("phase", "4/4 Producer integrating");
  const failedNoteForIntegrate = failResults.length > 0
    ? ` Note: ${failResults.length} specialist(s) — ${failResults.map(r => r.agent).join(", ")} — were unavailable for this run. State that explicitly in the integration; don't invent their findings.`
    : "";
  const integratePrompt =
    "Now integrate every specialist reply you just received into ONE coherent answer for Dan. " +
    "Address any BLOCK / INVARIANT VIOLATION / REQ DELTA flags. Lead with the result. End with the concrete next step." +
    failedNoteForIntegrate;

  const spin3 = startSpinner("producer integrating");
  const integration = await callAgent({
    agentId: opts.cfg.producerAgent,
    sessionKey: producerSession,
    message: integratePrompt,
    timeoutSec: timeoutFor(opts.cfg, opts.cfg.producerAgent),
    thinkingLevel: thinkingFor(opts.cfg, opts.cfg.producerAgent),
  });
  spin3.stop(integration.ok ? "ok" : "fail", integration.durationMs);

  if (!integration.ok) {
    log("warn", `integration call failed; raw specialist replies follow.`);
    printRawReplies(results);
    return 1;
  }

  record.finalAnswer = integration.text;
  record.endedAt = new Date().toISOString();
  await persist();

  console.log();
  console.log(chalk.bold.green("=".repeat(72)));
  console.log(chalk.bold.green("PRODUCER'S INTEGRATED ANSWER"));
  console.log(chalk.bold.green("=".repeat(72)));
  console.log(integration.text);
  console.log();

  const totalSec = ((Date.now() - tProducerStart) / 1000).toFixed(1);
  log("ok", `done. runId=${runId}. total ${totalSec}s.`);
  return 0;
}

interface DispatchResult { agent: string; reply: string; ok: boolean; durationMs: number; }

async function runDispatchesInParallel(
  dispatches: DispatchBlock[],
  runId: string,
  cfg: Config,
  verbose: boolean,
): Promise<DispatchResult[]> {
  // Run with bounded concurrency.
  const sem = new Semaphore(cfg.maxParallel);
  // Build a set of valid roles for the active group, so we can warn on
  // dispatches to roles that aren't part of this team.
  const validRoles = new Set(cfg.activeGroup.specialists.map(id => roleOf(id, cfg.activeGroup.id)));
  const tasks = dispatches.map(d => sem.run(async () => {
    // d.agent comes from Producer's DISPATCH block as an unprefixed role
    // (e.g. "architect"). Auto-prefix with the active group to get the
    // OpenClaw-side agent id ("crimeos.architect"). Validate against the group.
    const role = roleOf(d.agent, cfg.activeGroup.id);
    if (!validRoles.has(role)) {
      log("warn", `Producer dispatched to "${d.agent}" which is not a specialist of group ${cfg.activeGroup.id}. Attempting anyway.`);
    }
    const qualifiedAgentId = fullyQualify(role, cfg.activeGroup.id);
    const sessionKey = `agent:${qualifiedAgentId}:${runId}`;
    const msg = formatDispatchMessage(d);
    const baseTimeout = timeoutFor(cfg, qualifiedAgentId);
    const taskLabel = `${role}: ${d.task.slice(0, 60)}${d.task.length > 60 ? "…" : ""}`;

    // Attempt 1
    let spin = startSpinner(taskLabel);
    let r = await callAgent({
      agentId: qualifiedAgentId,
      sessionKey,
      message: msg,
      timeoutSec: baseTimeout,
      thinkingLevel: thinkingFor(cfg, qualifiedAgentId),
    });
    spin.stop(r.ok ? "ok" : "fail", r.durationMs);

    // Attempt 2 — auto-retry on timeout-only failures (exitCode === -1).
    if (!r.ok && r.exitCode === -1) {
      const bumpedTimeout = Math.round(baseTimeout * 1.5);
      log("warn", `${role} timed out at ${(r.durationMs/1000).toFixed(0)}s. Retrying once with ${bumpedTimeout}s budget…`);
      const resumeMsg = `Continue your prior reply. You were interrupted by timeout. If you'd already produced your DELIVERABLE, repeat it; if you were mid-investigation, finish and produce the DELIVERABLE now.`;
      spin = startSpinner(`${taskLabel} (retry)`);
      r = await callAgent({
        agentId: qualifiedAgentId,
        sessionKey,
        message: resumeMsg,
        timeoutSec: bumpedTimeout,
        thinkingLevel: thinkingFor(cfg, qualifiedAgentId),
      });
      spin.stop(r.ok ? "ok" : "fail", r.durationMs);
    }

    // Hallucination guard: verify every cited file:line in the specialist's
    // reply before sending it on to Producer. Append a small CITATION CHECK
    // block so Producer can flag unverified citations in the integration.
    let finalReply = r.text;
    if (r.ok && !cfg.disableCitationCheck && cfg.workspace) {
      const citations = parseCitations(r.text);
      if (citations.length > 0) {
        const verified = verifyCitations(citations, cfg.workspace);
        const report = formatVerificationReport(verified);
        if (report) {
          finalReply = r.text + "\n" + report;
          const bad = verified.filter(v => v.status === "file-not-found" || v.status === "line-out-of-range").length;
          const ambig = verified.filter(v => v.status === "ambiguous-basename").length;
          if (bad > 0)        log("warn", `${role}: ${bad}/${verified.length} citation(s) unverified`);
          else if (ambig > 0) log("info", `${role}: ${verified.length} citation(s) checked (${ambig} ambiguous, 0 unverified)`);
          else                log("ok",   `${role}: ${verified.length}/${verified.length} citation(s) verified`);
        }
      }
    }

    if (verbose && r.ok) log("trace", `${role} reply:\n${finalReply}\n`);
    if (!r.ok) log("warn", `${role} failed: ${r.text.split("\n")[0]}`);
    return { agent: role, reply: finalReply, ok: r.ok, durationMs: r.durationMs };
  }));
  return Promise.all(tasks);
}

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>(res => this.queue.push(res));
    }
    this.active++;
    try { return await fn(); }
    finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

// --- tiny logging + spinner UI ---

type Level = "info" | "phase" | "ok" | "warn" | "error" | "trace";

function log(level: Level, msg: string) {
  const tag = {
    info:  chalk.cyan("[info ]"),
    phase: chalk.bold.cyan("[phase]"),
    ok:    chalk.green("[ ok  ]"),
    warn:  chalk.yellow("[warn ]"),
    error: chalk.red("[error]"),
    trace: chalk.gray("[trace]"),
  }[level];
  console.log(`${tag} ${msg}`);
}

function startSpinner(label: string) {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const start = Date.now();
  const isTTY = !!process.stdout.isTTY;
  const interval = isTTY ? setInterval(() => {
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  ${chalk.cyan(frames[i++ % frames.length])} ${label} (${secs}s)   `);
  }, 100) : null;
  if (!isTTY) console.log(`  · ${label}`);
  return {
    stop(status: "ok" | "fail", durationMs: number) {
      if (interval) clearInterval(interval);
      const secs = (durationMs / 1000).toFixed(1);
      const mark = status === "ok" ? chalk.green("✓") : chalk.red("✗");
      if (isTTY) process.stdout.write(`\r  ${mark} ${label} (${secs}s)${" ".repeat(20)}\n`);
      else console.log(`  ${status === "ok" ? "ok" : "FAIL"}: ${label} (${secs}s)`);
    },
  };
}

function printRawReplies(results: DispatchResult[]) {
  for (const r of results) {
    console.log();
    console.log(chalk.bold.cyan(`=== ${r.agent} ===`));
    console.log(r.reply);
  }
}

/**
 * Does the task contain an explicit instruction to dispatch to specialists?
 * Used by Smart Dispatch OFF mode to know whether a 0-dispatch Producer reply
 * is a violation that warrants a forced retry / auto-fan-out.
 *
 * Matches phrases like:
 *   - "Dispatch in parallel to every relevant specialist"
 *   - "dispatch to all specialists"
 *   - "dispatch each specialist"
 *   - "fan out to specialists"
 */
function hasDispatchDirective(task: string): boolean {
  const t = task.toLowerCase();
  if (/\bdispatch\b.*\b(parallel|every|all|each|relevant|specialist|specialists)\b/.test(t)) return true;
  if (/\bfan[\s-]?out\b.*\bspecialist/.test(t)) return true;
  if (/\b(every|all|each)\s+specialist/.test(t) && /\b(consult|run|engage|dispatch|fan)/.test(t)) return true;
  return false;
}

/**
 * Stricter directive check: did the user explicitly ask for the FULL roster?
 * Triggers when the task contains "every/all/each" near "specialist", or
 * "in parallel to every/all" near "specialist". This is what authorizes the
 * orchestrator to auto-add specialists Producer judged "not relevant" — the
 * user's wording overrides Producer's judgment.
 *
 * Notably we DO match "every relevant specialist" — "relevant" is a softener
 * Producer hides behind to skip people; under Smart Dispatch OFF the user
 * wins.
 */
function hasFullRosterDirective(task: string): boolean {
  const t = task.toLowerCase();
  if (/\b(every|all|each)(\s+\w+){0,2}\s+specialist/.test(t)) return true;
  if (/\bdispatch\b.*\b(every|all|each)\b/.test(t)) return true;
  if (/\bfan[\s-]?out\b/.test(t)) return true;
  return false;
}
