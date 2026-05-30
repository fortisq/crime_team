// Core orchestrator: kick off Producer, parse dispatches, run specialists in
// parallel, feed replies back to Producer (chunked per-reply so each argv stays
// under the Windows CLI limit), integrate, optionally hand off to a Coder
// (G.2) and optionally loop the audit→coder cycle (G.3).

import { mkdir, writeFile } from "node:fs/promises";
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { callAgent, MAX_ARGV_CHARS } from "./agent.js";
import { parseDispatches, formatDispatchMessage } from "./dispatch.js";
import { type Config, timeoutFor, thinkingFor, fullyQualify, roleOf, auditSpecialists } from "./config.js";
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
  /**
   * G.2 — run the group's Coder agent as Phase 5 after the audit integrates.
   * Requires `cfg.activeGroup.coderAgentId` to be set. The audit (Phases 1-4)
   * is unchanged.
   */
  useCoder?: boolean;
  /**
   * G.3 — loop max iterations (1 = single pass, no loop; 2..5 = N iterations).
   * Only applies when `useCoder` is also true. After Phase 5 of each iteration,
   * orchestrator re-runs Phases 1-4 with a re-audit prompt anchored on the
   * Coder's prior touched files. Stops early on the AUDIT CLEAN sentinel.
   */
  loopMax?: number;
}

// Internal type returned by runAuditPhases — captures everything needed to
// fill RunRecord (top-level fields on iter 1, loopIterations entry on iter N).
interface AuditPhaseResult {
  producerPlan: string;
  dispatches: DispatchBlock[];
  specialistResults: { agent: string; reply: string; ok: boolean }[];
  integrated: string;
  noFindings: boolean;
  /** non-zero = bail (no integration to consume) */
  exitCode: number;
}

export async function orchestrate(opts: OrchestratorOpts): Promise<number> {
  const runId = opts.runId ?? `team-${Math.floor(Date.now() / 1000)}`;
  const record: RunRecord = {
    runId,
    startedAt: new Date().toISOString(),
    task: opts.task,
  };
  if (opts.useCoder) record.usedCoder = true;
  if (opts.loopMax && opts.loopMax > 1) record.loopMax = opts.loopMax;

  await mkdir(opts.cfg.runsDir, { recursive: true });
  const recordPath = join(opts.cfg.runsDir, `${runId}.json`);
  const markerPath = join(opts.cfg.runsDir, `${runId}.cancel`);
  const persist = async () => writeFile(recordPath, JSON.stringify(record, null, 2));

  log("info", `runId=${runId}`);
  log("info", `record at ${recordPath}`);
  // Write the initial record immediately so the run is visible in the GUI's
  // sidebar even if the orchestrator (or its parent process) is killed before
  // Producer's first reply lands.
  await persist();

  const tRunStart = Date.now();

  // try/finally — always sweep the soft-cancel marker on the way out, no
  // matter how we exit (success / error / soft-cancel / hard kill mid-finally).
  try {
    // --- Iteration 1: audit + (optionally) Coder ---
    const iter1 = await runAuditPhases(opts.task, opts.cfg, runId, 1, !!opts.smartDispatch, opts.verbose, record, persist);
    // runAuditPhases mutates record's top-level audit fields (producerPlan,
    // dispatches, specialistResults, finalAnswer) for iteration 1.
    if (iter1.exitCode !== 0) {
      record.endedAt = new Date().toISOString();
      await persist();
      return iter1.exitCode;
    }

    if (!opts.useCoder) {
      // Audit-only run — preserves today's behavior end-to-end.
      record.endedAt = new Date().toISOString();
      await persist();
      const totalSec = ((Date.now() - tRunStart) / 1000).toFixed(1);
      log("ok", `done. runId=${runId}. total ${totalSec}s.`);
      return 0;
    }

    // G.2 — Phase 5: Coder applies the audit's findings.
    const coderId = opts.cfg.activeGroup.coderAgentId;
    if (!coderId) {
      log("error", "useCoder=true but active group has no coderAgentId — refusing");
      record.coderResult = { ok: false, reply: "[orchestrator] useCoder=true but group has no coderAgentId", durationMs: 0 };
      record.endedAt = new Date().toISOString();
      await persist();
      return 1;
    }

    if (checkSoftCancel(markerPath)) {
      log("warn", "soft-cancel detected before Coder phase — exiting cleanly");
      record.loopSoftCancelled = true;
      record.endedAt = new Date().toISOString();
      await persist();
      return 0;
    }

    record.coderResult = await runCoderPhase(opts.task, iter1.integrated, opts.cfg, runId, 1, coderId);
    await persist();
    printCoderReport(record.coderResult, 1, opts.cfg.activeGroup.coderAgentId
      ? roleOf(opts.cfg.activeGroup.coderAgentId, opts.cfg.activeGroup.id)
      : "coder");
    if (!record.coderResult.ok) {
      log("warn", "Coder failed; skipping any loop iterations");
      record.endedAt = new Date().toISOString();
      await persist();
      return 1;
    }

    // G.3 — Loop wrapper. iter1 already happened; iter2..N are re-audits.
    const loopMax = opts.loopMax ?? 1;
    if (loopMax > 1) {
      let lastCoderReply = record.coderResult.reply;
      record.loopIterations = [];
      for (let iter = 2; iter <= loopMax; iter++) {
        if (checkSoftCancel(markerPath)) {
          log("warn", `soft-cancel detected before iteration ${iter} — exiting cleanly`);
          record.loopSoftCancelled = true;
          break;
        }

        log("phase", `iter ${iter}/${loopMax} re-auditing changes`);
        const reauditTask = buildReauditTask(opts.task, lastCoderReply);
        // Fresh session keys per iteration (the runId carries an :iter${N}
        // suffix internally — see runAuditPhases). Producer's audit-phase
        // session does NOT carry across iterations to keep argv small and
        // force a fresh look at the workspace.
        const auditN = await runAuditPhases(reauditTask, opts.cfg, runId, iter, !!opts.smartDispatch, opts.verbose, /*record*/ undefined, /*persist*/ undefined);

        const iterEntry: NonNullable<RunRecord["loopIterations"]>[number] = {
          iteration: iter,
          audit: {
            producerPlan: auditN.producerPlan,
            dispatches: auditN.dispatches,
            specialistResults: auditN.specialistResults,
            integrated: auditN.integrated,
            noFindings: auditN.noFindings,
          },
        };
        record.loopIterations.push(iterEntry);
        await persist();

        if (auditN.exitCode !== 0) {
          log("warn", `iter ${iter} audit failed; stopping loop`);
          break;
        }

        if (auditN.noFindings) {
          log("ok", `loop stopped early — iter ${iter} returned AUDIT CLEAN sentinel`);
          record.loopStoppedClean = true;
          break;
        }

        if (checkSoftCancel(markerPath)) {
          log("warn", `soft-cancel detected after iter ${iter} audit — exiting cleanly`);
          record.loopSoftCancelled = true;
          break;
        }

        const coderN = await runCoderPhase(opts.task, auditN.integrated, opts.cfg, runId, iter, coderId);
        iterEntry.coder = coderN;
        await persist();
        printCoderReport(coderN, iter, roleOf(coderId, opts.cfg.activeGroup.id));
        if (!coderN.ok) {
          log("warn", `iter ${iter} Coder failed; stopping loop`);
          break;
        }
        lastCoderReply = coderN.reply;
      }
    }

    record.endedAt = new Date().toISOString();
    await persist();
    const totalSec = ((Date.now() - tRunStart) / 1000).toFixed(1);
    log("ok", `done. runId=${runId}. total ${totalSec}s.`);
    return 0;
  } finally {
    // Always sweep the soft-cancel marker, even on hard kill exits we never
    // see. Idempotent.
    try { unlinkSync(markerPath); } catch {}
  }
}

/**
 * G.2 helper — check whether the soft-cancel marker file exists. The Tauri
 * `cancel_run_soft` command writes the marker; the orchestrator polls between
 * iterations + before the Coder phase. Cheap stat — no need for fs/promises.
 */
function checkSoftCancel(markerPath: string): boolean {
  try { statSync(markerPath); return true; } catch { return false; }
}

/**
 * G.3 — build the re-audit task text for iteration N≥2. Anchors the re-audit
 * on the Coder's prior touched-files summary so Producer's dispatch lands on
 * the actual changed files, not a fresh scan. Includes the AUDIT CLEAN
 * sentinel instruction so we can stop the loop early when there's nothing
 * left to fix.
 */
function buildReauditTask(originalTask: string, lastCoderReply: string): string {
  // Cap the Coder's reply to ~12KB so the kickoff argv stays in budget.
  const CODER_REPLY_CAP = 12000;
  const truncated = lastCoderReply.length > CODER_REPLY_CAP
    ? lastCoderReply.slice(0, CODER_REPLY_CAP) + `\n\n[…coder reply truncated by orchestrator at ${CODER_REPLY_CAP} chars; full was ${lastCoderReply.length} chars…]`
    : lastCoderReply;
  return `ORIGINAL USER TASK (for reference):
  ${originalTask}

Re-audit the changes the Coder just made for that task. Read the workspace
files that the previous iteration's audit cited AND any file the Coder's
last reply lists in its touched-files summary. Look for:
  - Regressions: did the change break something the audit didn't catch?
  - Incomplete fixes: did the Coder address only part of a finding?
  - New issues introduced by the change itself (imports, types, side effects).
  - Findings from the previous iteration that the Coder skipped.

If everything looks clean, say exactly:
  AUDIT CLEAN — no regressions or remaining issues.
on its own line in your integration so the orchestrator can stop the loop
early.

Dispatch in parallel to every relevant specialist. Synthesize into ONE
integrated report. Cite specific file:line references.

CODER'S PREVIOUS REPLY (touched-files + diffs):
${truncated}`;
}

/**
 * G.3 — detect the AUDIT CLEAN sentinel in Producer's integration text so the
 * loop can stop early. Primary check is the exact sentinel sentence on its own
 * line; backup heuristic matches "no findings" / "all clear" near the top with
 * no dispatch/block flags elsewhere.
 */
function detectNoFindings(integrated: string): boolean {
  // Primary: exact sentinel on its own line (forgive an optional trailing period)
  const SENTINEL_RE = /^\s*AUDIT CLEAN[\s—-]+no regressions or remaining issues\.?\s*$/im;
  if (SENTINEL_RE.test(integrated)) return true;
  // Backup heuristic: short, clear, no flags
  const head = integrated.slice(0, 200).toLowerCase();
  const cleanWords = /(no findings|all clear|nothing to address|no issues found)/;
  const hasFlags = /(DISPATCH:|BLOCK:|INVARIANT VIOLATION:|REQ DELTA:)/.test(integrated);
  return cleanWords.test(head) && !hasFlags;
}

/**
 * G.2 — Phase 5: hand the integrated audit to the Coder agent and capture
 * its reply (diffs + touched-files summary). Workspace edits happen as a
 * side-effect of the agent's tool calls; the orchestrator never reads/writes
 * workspace files directly.
 */
async function runCoderPhase(
  originalTask: string,
  integratedAudit: string,
  cfg: Config,
  runId: string,
  iteration: number,
  coderAgentId: string,
): Promise<{ ok: boolean; reply: string; durationMs: number }> {
  const sessionKey = `agent:${coderAgentId}:${runId}:iter${iteration}`;
  const coderRole = roleOf(coderAgentId, cfg.activeGroup.id);

  // Build the message: original task + integrated audit + iteration-aware instruction.
  let body: string;
  if (iteration === 1) {
    body = [
      `ORIGINAL USER TASK:`,
      originalTask,
      ``,
      `INTEGRATED AUDIT REPORT from Producer (specialist findings, already cross-checked):`,
      integratedAudit,
      ``,
      `Implement the audit's findings now. Read each file before editing. Show diffs. End with a touched-files summary.`,
    ].join("\n");
  } else {
    body = [
      `ORIGINAL USER TASK (unchanged from iteration 1):`,
      originalTask,
      ``,
      `RE-AUDIT REPORT (iteration ${iteration}) — these are findings AGAINST your previous changes:`,
      integratedAudit,
      ``,
      `Address the regressions or remaining issues above. Make incremental changes; do not defend prior choices. Show diffs. End with a touched-files summary.`,
    ].join("\n");
  }
  if (body.length > MAX_ARGV_CHARS - 200) {
    const trunc = MAX_ARGV_CHARS - 400;
    body = body.slice(0, trunc) + `\n\n[…coder kickoff truncated by orchestrator at ${trunc} chars…]`;
  }

  log("phase", `5/5 Coder applying changes (iteration ${iteration})`);
  const spin = startSpinner(`${coderRole} (iter ${iteration})`);
  const r = await callAgent({
    agentId: coderAgentId,
    sessionKey,
    message: body,
    timeoutSec: timeoutFor(cfg, coderAgentId),
    thinkingLevel: thinkingFor(cfg, coderAgentId),
  });
  spin.stop(r.ok ? "ok" : "fail", r.durationMs);
  if (!r.ok) {
    log("warn", `Coder failed (iter ${iteration}): ${r.text.split("\n")[0]}`);
  }
  return { ok: r.ok, reply: r.text, durationMs: r.durationMs };
}

/**
 * Runs today's 4-phase audit flow (Producer plan → parallel dispatch → ack
 * each reply → integrate). Mutates `record` (when provided) with iteration-1
 * data for backward-compatibility with existing run-record consumers; returns
 * an AuditPhaseResult so the loop wrapper can collect iter-N data into
 * `record.loopIterations` instead.
 *
 * iteration is the 1-based loop counter. Session keys carry a :iter${N}
 * suffix so each loop iteration is a fresh Producer session.
 */
async function runAuditPhases(
  task: string,
  cfg: Config,
  runId: string,
  iteration: number,
  smartDispatch: boolean,
  verbose: boolean,
  record: RunRecord | undefined,
  persist: (() => Promise<void>) | undefined,
): Promise<AuditPhaseResult> {
  const sessionTag = iteration === 1 ? runId : `${runId}:iter${iteration}`;
  const producerSession = `agent:${cfg.producerAgent}:${sessionTag}`;

  // --- Phase 1: Producer plans ---
  log("phase", "1/4 Producer planning");
  // Pin the AUDIT roster (Coder excluded) into the kickoff so smaller models
  // can't hallucinate stock role names AND can't dispatch to the Coder.
  const roster = auditSpecialists(cfg).map(id => roleOf(id, cfg.activeGroup.id));
  const rosterLine = `Valid specialists for this group: ${roster.join(", ")}. Use ONLY these exact names in DISPATCH blocks — do not invent role names like "architect" or "frontend" if they aren't listed.`;

  const kickoff = smartDispatch
    ? `${task}

${rosterLine}

SMART DISPATCH MODE — Override the dispatch directive in the task above. Judge per-task which specialists this work actually needs. A small task may need only one specialist, or you may answer inline with no dispatches. Match dispatched specialists to the actual scope of the work — don't dispatch theatre. Quality over quantity. Emit DISPATCH blocks if needed, exact format per your system prompt. If the task is genuinely small enough to handle inline, do that with no dispatches.`
    : `${task}

${rosterLine}

Follow the dispatch directive in the task above. If the task says to dispatch to specialists (e.g. "Dispatch in parallel to every relevant specialist"), you MUST emit DISPATCH blocks at the END of your reply (one per specialist, exact format per your system prompt) — do NOT answer inline. Inline answers are only appropriate when the task itself is trivial (e.g. a one-line question) AND does not explicitly request specialist dispatch.`;
  if (iteration === 1) {
    if (smartDispatch) log("info", "smart dispatch enabled — Producer picks specialists per task");
    else log("info", "smart dispatch off — Producer must follow preset's dispatch directive");
  }

  const spin = startSpinner(`producer planning`);
  const plan = await callAgent({
    agentId: cfg.producerAgent,
    sessionKey: producerSession,
    message: kickoff,
    timeoutSec: timeoutFor(cfg, cfg.producerAgent),
    thinkingLevel: thinkingFor(cfg, cfg.producerAgent),
  });
  spin.stop(plan.ok ? "ok" : "fail", plan.durationMs);

  if (!plan.ok) {
    log("error", `Producer planning failed: ${plan.text}`);
    if (record) record.producerPlan = plan.text;
    if (persist) await persist();
    return { producerPlan: plan.text, dispatches: [], specialistResults: [], integrated: "", noFindings: false, exitCode: 2 };
  }
  let producerPlanText = plan.text;
  if (record) record.producerPlan = producerPlanText;
  if (persist) await persist();
  if (verbose) log("trace", `Producer plan:\n${plan.text}\n`);

  // --- Phase 2: parse + validate dispatches ---
  let dispatches = parseDispatches(plan.text);
  // AUDIT roster only — Coder cannot be a valid audit-dispatch target.
  const fullRoster = roster;
  const validRoles = new Set(fullRoster);
  const dropped = dispatches.filter(d => !validRoles.has(roleOf(d.agent, cfg.activeGroup.id)));
  if (dropped.length > 0) {
    for (const d of dropped) {
      log("warn", `dropping dispatch to "${d.agent}" — not an audit specialist of group ${cfg.activeGroup.id} (valid: ${fullRoster.join(", ")})`);
    }
    dispatches = dispatches.filter(d => validRoles.has(roleOf(d.agent, cfg.activeGroup.id)));
  }

  // --- Phase 2a: full-roster enforcement ---
  if (!smartDispatch && hasFullRosterDirective(task) && dispatches.length > 0) {
    const dispatchedRoles = new Set(dispatches.map(d => roleOf(d.agent, cfg.activeGroup.id)));
    const missing = fullRoster.filter(r => !dispatchedRoles.has(r));
    if (missing.length > 0) {
      log("warn", `Producer dispatched to ${dispatches.length}/${fullRoster.length} specialists. Auto-adding missing: ${missing.join(", ")} (Smart Dispatch OFF + "every/all" directive)`);
      for (const role of missing) {
        dispatches.push({
          agent: role,
          task,
          context: "Read the workspace as needed to address the task above.",
          deliverable: "Your specialist findings on the task above. Cite specific file:line references.",
        });
      }
      producerPlanText = `${plan.text}\n\n---\n[orchestrator: auto-added missing specialists ${missing.join(", ")} — Smart Dispatch OFF + every/all directive]\n---`;
      if (record) record.producerPlan = producerPlanText;
    }
  }
  if (record) record.dispatches = dispatches;
  if (persist) await persist();

  // --- Phase 2b: enforce Smart Dispatch OFF ---
  const taskHasDispatchDirective = hasDispatchDirective(task);
  if (!smartDispatch && dispatches.length === 0 && taskHasDispatchDirective) {
    log("warn", `Producer returned 0 dispatches but task explicitly requires dispatch. Retrying with stronger nudge…`);
    const retryMsg = `You did NOT emit any DISPATCH blocks. The task above explicitly requires dispatching to specialists ("Dispatch in parallel to every relevant specialist"). The Smart Dispatch override is OFF, so you cannot answer inline. Re-read the task. Emit DISPATCH blocks now, one per specialist, in the exact format from your system prompt. Do not write any analysis or report — only the DISPATCH blocks. Available specialists: ${roster.join(", ")}.`;
    const spinR = startSpinner(`producer re-planning (forced dispatch)`);
    const replan = await callAgent({
      agentId: cfg.producerAgent,
      sessionKey: producerSession,
      message: retryMsg,
      timeoutSec: timeoutFor(cfg, cfg.producerAgent),
      thinkingLevel: thinkingFor(cfg, cfg.producerAgent),
    });
    spinR.stop(replan.ok ? "ok" : "fail", replan.durationMs);
    if (replan.ok) {
      const retryDispatches = parseDispatches(replan.text);
      if (retryDispatches.length > 0) {
        log("ok", `retry produced ${retryDispatches.length} dispatch(es)`);
        dispatches = retryDispatches;
        producerPlanText = `${producerPlanText}\n\n---\n[orchestrator: re-planned after 0-dispatch on enforced mode]\n---\n\n${replan.text}`;
        if (record) {
          record.producerPlan = producerPlanText;
          record.dispatches = dispatches;
        }
        if (persist) await persist();
      }
    }
    if (dispatches.length === 0) {
      log("warn", `Producer still refused to dispatch. Auto-fanning out to all ${roster.length} audit specialists: ${roster.join(", ")}`);
      dispatches = roster.map(role => ({
        agent: role,
        task,
        context: "Read the workspace as needed to address the task above.",
        deliverable: "Your specialist findings on the task above. Cite specific file:line references.",
      }));
      producerPlanText = `${producerPlanText}\n\n---\n[orchestrator: auto-fan-out — Producer refused dispatch on enforced mode]\n---`;
      if (record) {
        record.producerPlan = producerPlanText;
        record.dispatches = dispatches;
      }
      if (persist) await persist();
    }
  }

  if (dispatches.length === 0) {
    log("ok", `Producer answered inline (no dispatches). Time ${(plan.durationMs / 1000).toFixed(1)}s`);
    console.log();
    console.log(chalk.bold.green("=".repeat(72)));
    console.log(chalk.bold.green("PRODUCER'S INTEGRATED ANSWER"));
    console.log(chalk.bold.green("=".repeat(72)));
    console.log(plan.text);
    console.log();
    if (record) record.finalAnswer = plan.text;
    if (persist) await persist();
    return { producerPlan: producerPlanText, dispatches: [], specialistResults: [], integrated: plan.text, noFindings: detectNoFindings(plan.text), exitCode: 0 };
  }

  log("info", `Producer wants ${dispatches.length} specialist(s): ${dispatches.map(d => d.agent).join(", ")}`);

  // --- Phase 3: parallel specialist dispatch ---
  log("phase", "2/4 specialists running in parallel");
  const results = await runDispatchesInParallel(dispatches, sessionTag, cfg, verbose);
  if (record) record.specialistResults = results.map(r => ({ agent: r.agent, reply: r.reply, ok: r.ok }));
  if (persist) await persist();

  const okResults = results.filter(r => r.ok);
  const failResults = results.filter(r => !r.ok);
  log(okResults.length === results.length ? "ok" : "warn",
      `${okResults.length}/${results.length} specialists returned ok`);

  if (okResults.length === 0) {
    log("error", `all ${results.length} specialists failed — nothing to integrate`);
    const summary = `All ${results.length} specialists failed:\n\n` +
      failResults.map(r => `- ${r.agent}: ${(r.reply || "").split("\n")[0].slice(0, 200)}`).join("\n");
    if (record) record.finalAnswer = summary;
    if (persist) await persist();
    printRawReplies(results);
    return {
      producerPlan: producerPlanText,
      dispatches,
      specialistResults: results.map(r => ({ agent: r.agent, reply: r.reply, ok: r.ok })),
      integrated: summary,
      noFindings: false,
      exitCode: 1,
    };
  }

  // --- Phase 4 (a): tell Producer about failures up front, then ack each ok reply ---
  if (failResults.length > 0) {
    log("warn", `skipping ${failResults.length} failed specialist(s): ${failResults.map(r => r.agent).join(", ")}`);
    const failNote = `Heads up before specialist replies arrive: ${failResults.length} specialist(s) failed and will be skipped — ${failResults.map(r => `${r.agent} (${(r.reply || "").split("\n")[0].slice(0, 120).replace(/\n/g, " ")})`).join("; ")}. When you integrate, note which specialists were unavailable; do not invent their findings.`;
    const spinN = startSpinner(`notifying producer of failures`);
    const noteAck = await callAgent({
      agentId: cfg.producerAgent,
      sessionKey: producerSession,
      message: failNote,
      timeoutSec: timeoutFor(cfg, cfg.producerAgent),
      thinkingLevel: thinkingFor(cfg, cfg.producerAgent),
    });
    spinN.stop(noteAck.ok ? "ok" : "fail", noteAck.durationMs);
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
      agentId: cfg.producerAgent,
      sessionKey: producerSession,
      message: body,
      timeoutSec: timeoutFor(cfg, cfg.producerAgent),
      thinkingLevel: thinkingFor(cfg, cfg.producerAgent),
    });
    spin2.stop(ack.ok ? "ok" : "fail", ack.durationMs);
    if (!ack.ok) {
      log("warn", `Producer failed to ack ${r.agent}; falling back to raw replies:`);
      printRawReplies(results);
      return {
        producerPlan: producerPlanText,
        dispatches,
        specialistResults: results.map(r => ({ agent: r.agent, reply: r.reply, ok: r.ok })),
        integrated: "",
        noFindings: false,
        exitCode: 1,
      };
    }
  }

  // --- Phase 4 (b): integrate ---
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
    agentId: cfg.producerAgent,
    sessionKey: producerSession,
    message: integratePrompt,
    timeoutSec: timeoutFor(cfg, cfg.producerAgent),
    thinkingLevel: thinkingFor(cfg, cfg.producerAgent),
  });
  spin3.stop(integration.ok ? "ok" : "fail", integration.durationMs);

  if (!integration.ok) {
    log("warn", `integration call failed; raw specialist replies follow.`);
    printRawReplies(results);
    return {
      producerPlan: producerPlanText,
      dispatches,
      specialistResults: results.map(r => ({ agent: r.agent, reply: r.reply, ok: r.ok })),
      integrated: "",
      noFindings: false,
      exitCode: 1,
    };
  }

  if (record) record.finalAnswer = integration.text;
  if (persist) await persist();

  console.log();
  console.log(chalk.bold.green("=".repeat(72)));
  console.log(chalk.bold.green("PRODUCER'S INTEGRATED ANSWER"));
  console.log(chalk.bold.green("=".repeat(72)));
  console.log(integration.text);
  console.log();

  return {
    producerPlan: producerPlanText,
    dispatches,
    specialistResults: results.map(r => ({ agent: r.agent, reply: r.reply, ok: r.ok })),
    integrated: integration.text,
    noFindings: detectNoFindings(integration.text),
    exitCode: 0,
  };
}

interface DispatchResult { agent: string; reply: string; ok: boolean; durationMs: number; }

async function runDispatchesInParallel(
  dispatches: DispatchBlock[],
  sessionTag: string,
  cfg: Config,
  verbose: boolean,
): Promise<DispatchResult[]> {
  // Run with bounded concurrency.
  const sem = new Semaphore(cfg.maxParallel);
  // Build a set of valid AUDIT roles for the active group (Coder excluded).
  const validRoles = new Set(auditSpecialists(cfg).map(id => roleOf(id, cfg.activeGroup.id)));
  const tasks = dispatches.map(d => sem.run(async () => {
    const role = roleOf(d.agent, cfg.activeGroup.id);
    if (!validRoles.has(role)) {
      log("warn", `Producer dispatched to "${d.agent}" which is not an audit specialist of group ${cfg.activeGroup.id}. Attempting anyway.`);
    }
    const qualifiedAgentId = fullyQualify(role, cfg.activeGroup.id);
    const sessionKey = `agent:${qualifiedAgentId}:${sessionTag}`;
    const msg = formatDispatchMessage(d);
    const baseTimeout = timeoutFor(cfg, qualifiedAgentId);
    const taskLabel = `${role}: ${d.task.slice(0, 60)}${d.task.length > 60 ? "…" : ""}`;

    let spin = startSpinner(taskLabel);
    let r = await callAgent({
      agentId: qualifiedAgentId,
      sessionKey,
      message: msg,
      timeoutSec: baseTimeout,
      thinkingLevel: thinkingFor(cfg, qualifiedAgentId),
    });
    spin.stop(r.ok ? "ok" : "fail", r.durationMs);

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
 * G.2/G.3 — print the Coder's reply with a clear header so the GUI's
 * answer-panel collector (main.js — captures everything between
 * "PRODUCER'S INTEGRATED ANSWER" and "[ ok  ] done.") includes the diff +
 * touched-files summary alongside the audit integration. Without this the
 * Coder reply lives only in the run record JSON and the user sees a generic
 * audit-style answer with no indication of what was actually changed.
 */
function printCoderReport(
  result: { ok: boolean; reply: string; durationMs: number },
  iteration: number,
  coderRole: string,
) {
  const headerColor = result.ok ? chalk.bold.yellow : chalk.bold.red;
  const statusWord = result.ok ? "REPORT" : "FAILED";
  const iterTag = iteration > 1 ? ` (iteration ${iteration})` : "";
  console.log();
  console.log(headerColor("=".repeat(72)));
  console.log(headerColor(`CODER ${statusWord} — ${coderRole}${iterTag} — ${(result.durationMs/1000).toFixed(1)}s`));
  console.log(headerColor("=".repeat(72)));
  console.log(result.reply);
  console.log();
}

function hasDispatchDirective(task: string): boolean {
  const t = task.toLowerCase();
  if (/\bdispatch\b.*\b(parallel|every|all|each|relevant|specialist|specialists)\b/.test(t)) return true;
  if (/\bfan[\s-]?out\b.*\bspecialist/.test(t)) return true;
  if (/\b(every|all|each)\s+specialist/.test(t) && /\b(consult|run|engage|dispatch|fan)/.test(t)) return true;
  return false;
}

function hasFullRosterDirective(task: string): boolean {
  const t = task.toLowerCase();
  if (/\b(every|all|each)(\s+\w+){0,2}\s+specialist/.test(t)) return true;
  if (/\bdispatch\b.*\b(every|all|each)\b/.test(t)) return true;
  if (/\bfan[\s-]?out\b/.test(t)) return true;
  return false;
}
