// Frontend entry. Talks to Tauri via window.__TAURI__.{core,event}.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/**
 * In-app confirm modal. Tauri 2 disables window.confirm() (it'd block the
 * renderer), so every prior `confirm()` call was a silent no-op — Remove
 * buttons fired immediately. This helper renders a small modal that matches
 * the app's style and supports a red "destructive" variant.
 *
 * Returns a Promise<boolean>. Cancel (Esc / backdrop click / Cancel button)
 * resolves false; confirm button resolves true. Focus defaults to Cancel for
 * destructive dialogs so a stray Enter can't blow things up.
 *
 * Usage:
 *   if (!await confirmDialog({
 *     title: "Remove specialist?",
 *     body: "This will…",
 *     confirmLabel: "Remove",
 *     destructive: true,
 *   })) return;
 */
function confirmDialog({ title, body, confirmLabel = "OK", cancelLabel = "Cancel", destructive = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal confirm-modal" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h2>${escapeHtml(title)}</h2>
        </header>
        <div class="modal-body confirm-body-wrap">
          <p class="confirm-body">${escapeHtml(body).replace(/\n/g, "<br>")}</p>
        </div>
        <footer class="modal-footer">
          <div class="modal-footer-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="${destructive ? "danger" : "primary"} confirm-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(backdrop);
    const cancelBtn = backdrop.querySelector(".confirm-cancel");
    const okBtn = backdrop.querySelector(".confirm-ok");
    const close = (result) => {
      document.removeEventListener("keydown", keyHandler);
      backdrop.remove();
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter" && !destructive) close(true);
    };
    okBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener("keydown", keyHandler);
    // Default focus on Cancel for destructive dialogs so an accidental Enter
    // can't fire Remove. Non-destructive dialogs focus the confirm button.
    (destructive ? cancelBtn : okBtn).focus();
  });
}
import { PRESETS as BUNDLED_PRESETS, ANGLES as BUNDLED_ANGLES } from "./presets.js";

// Mutable per-group preset state. Replaced by loadPresetsForActiveGroup()
// when the active group has a presets.json at ~/.crime-team/groups/<id>/.
let PRESETS = BUNDLED_PRESETS;
let ANGLES = BUNDLED_ANGLES;

const els = {
  taskInput:   document.getElementById("taskInput"),
  verbose:     document.getElementById("verboseInput"),
  smart:       document.getElementById("smartDispatchInput"),
  timeout:     document.getElementById("timeoutInput"),
  runBtn:      document.getElementById("runBtn"),
  generateBtn: document.getElementById("generateTaskBtn"),
  cancelBtn:   document.getElementById("cancelBtn"),
  useCoder:    document.getElementById("useCoderInput"),
  useCoderWrap:document.getElementById("useCoderWrap"),
  loop:        document.getElementById("loopInput"),
  loopWrap:    document.getElementById("loopWrap"),
  loopMax:     document.getElementById("loopMaxInput"),
  newRunBtn:   document.getElementById("newRunBtn"),
  statusSec:   document.getElementById("statusSection"),
  logSec:      document.getElementById("logSection"),
  logPre:      document.getElementById("logPre"),
  logToggle:   document.getElementById("logToggleBtn"),
  answerSec:   document.getElementById("answerSection"),
  answerBody:  document.getElementById("answerBody"),
  copyAnswer:  document.getElementById("copyAnswerBtn"),
  popoutAnswer: document.getElementById("popoutAnswerBtn"),
  answerModal: document.getElementById("answerModal"),
  answerModalBody: document.getElementById("answerModalBody"),
  answerModalCopy: document.getElementById("answerModalCopyBtn"),
  answerModalClose: document.getElementById("answerModalCloseBtn"),
  answerModalSize: document.getElementById("answerModalSize"),
  phaseLabel:  document.getElementById("phaseLabel"),
  elapsedLbl:  document.getElementById("elapsedTotal"),
  runIdLbl:    document.getElementById("runIdLabel"),
  appBanner:   document.getElementById("appBanner"),
  appBannerText: document.getElementById("appBannerText"),
  appBannerClose: document.getElementById("appBannerClose"),
  agents:      document.getElementById("agents"),
  runsList:    document.getElementById("runsList"),
  rootPath:    document.getElementById("rootPath"),
  groupSelect: document.getElementById("groupSelect"),
  presetSelect:document.getElementById("presetSelect"),
  angleSelect: document.getElementById("angleSelect"),
};

// --- preset dropdown population + wiring ---
async function loadPresetsForActiveGroup() {
  if (!activeGroup) { PRESETS = BUNDLED_PRESETS; ANGLES = BUNDLED_ANGLES; return; }
  try {
    const data = await invoke("groups_get_presets", { groupId: activeGroup.id });
    if (data && Array.isArray(data.presets) && data.presets.length > 0) {
      PRESETS = data.presets;
      ANGLES = Array.isArray(data.angles) && data.angles.length ? data.angles : BUNDLED_ANGLES;
      return;
    }
  } catch (e) {
    console.warn("[presets] load failed, using bundled fallback:", e);
    showBanner("Custom presets failed to load — using built-in defaults.", "warn");
  }
  PRESETS = BUNDLED_PRESETS;
  ANGLES = BUNDLED_ANGLES;
}

// --- app banner (visible error/warning surface, outside the log panel) ---
let bannerTimer = null;
function showBanner(msg, kind = "warn") {
  if (!els.appBanner) return;
  els.appBannerText.textContent = msg;
  els.appBanner.className = `app-banner ${kind}`;
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  // Errors persist until dismissed; warn/info auto-hide.
  if (kind !== "error") bannerTimer = setTimeout(hideBanner, 9000);
}
function hideBanner() {
  if (!els.appBanner) return;
  els.appBanner.className = "app-banner hidden";
}
els.appBannerClose?.addEventListener("click", hideBanner);

// Click-to-copy the runId — de-emphasized in normal use but the first thing a
// support report needs when a run breaks.
els.runIdLbl?.addEventListener("click", async () => {
  const id = els.runIdLbl.dataset.runid;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    const prev = els.runIdLbl.textContent;
    els.runIdLbl.textContent = "copied!";
    setTimeout(() => { els.runIdLbl.textContent = prev; }, 1000);
  } catch {}
});

function populatePresets() {
  // Clear before rebuilding (called on group switch + initial load)
  els.presetSelect.innerHTML = '<option value="">— Pick a preset —</option>';
  els.angleSelect.innerHTML = "";
  // Build the <optgroup>s for the preset select.
  for (const { group, items } of PRESETS) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = it.label;
      opt.textContent = it.label;
      opt.dataset.prompt = it.prompt;
      og.appendChild(opt);
    }
    els.presetSelect.appendChild(og);
  }
  // Build the angle select.
  for (const a of ANGLES) {
    const opt = document.createElement("option");
    opt.value = a.label;
    opt.textContent = a.label;
    opt.dataset.suffix = a.suffix;
    els.angleSelect.appendChild(opt);
  }
}

async function applyPreset() {
  const sel = els.presetSelect.selectedOptions[0];
  if (!sel || !sel.dataset.prompt) return;
  const angleOpt = els.angleSelect.selectedOptions[0];
  const suffix = angleOpt?.dataset?.suffix ?? "";
  // If textarea has unsaved user edits (non-empty + not from a previous preset),
  // confirm before overwriting. Otherwise just set it.
  const current = els.taskInput.value.trim();
  const needsConfirm = current && els.taskInput.dataset.fromPreset !== "1";
  const overwrite = !needsConfirm || await confirmDialog({
    title: "Replace task text?",
    body: "Your task input has unsaved text. Loading this preset will replace it.",
    confirmLabel: "Replace",
  });
  if (!overwrite) {
    // revert the select to "— Pick a preset —"
    els.presetSelect.selectedIndex = 0;
    return;
  }
  els.taskInput.value = sel.dataset.prompt + suffix;
  els.taskInput.dataset.fromPreset = "1";
  els.taskInput.focus();
}
function applyAngle() {
  // If a preset is currently selected, re-apply with the new angle.
  if (els.presetSelect.value) applyPreset();
}
function onTaskEdit() {
  // User edited manually — clear the "fromPreset" marker so we'll prompt next time.
  els.taskInput.dataset.fromPreset = "";
}

// --- state ---
let activeRun = null;          // { id, startedAt, agents: Map<name, AgentState>, log: string[], answer: string|null }
let elapsedTimer = null;

// Log-line coloring tag (the only string contract left — the orchestrator's
// structured state now arrives as `orchestrator:event`, not scraped from text).
const INFO_RE  = /^\[(info|ok|warn|error|trace)\s*\]\s*(.+)$/;
// Fallback roles for legacy paths (e.g. agentNameFromLabel). The authoritative
// source is the active group's specialist list.
const FALLBACK_ROLES = ["producer","architect","frontend","art-director","qa","security","backend","desktop"];

// Process exit-code legend: turns a bare "exit 124" into something an operator
// can act on. 124 = OS timeout (SIGTERM), 130 = SIGINT/cancel.
const EXIT_LEGEND = {
  0:   { label: "done",      hint: "" },
  1:   { label: "error",     hint: "The orchestrator hit an error — check the log." },
  124: { label: "timed out", hint: "Increase Timeout (s) and re-run, or narrow the task." },
  130: { label: "cancelled", hint: "" },
};
function describeExit(code) {
  const e = EXIT_LEGEND[code];
  return e ? `${e.label} (exit ${code})` : `exit ${code}`;
}

function strip(s) { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

function showSections(opts) {
  els.statusSec.classList.toggle("hidden", !opts.status);
  els.logSec.classList.toggle("hidden", !opts.log);
  els.answerSec.classList.toggle("hidden", !opts.answer);
}

function setPhase(text) { els.phaseLabel.textContent = text; }

function setElapsed(secs) {
  els.elapsedLbl.textContent = `elapsed ${secs.toFixed(1)}s`;
}

function setRunIdLabel(id, live = false) {
  els.runIdLbl.textContent = id ? `runId ${id}` : "";
  els.runIdLbl.dataset.runid = id || "";
  els.runIdLbl.classList.toggle("live", !!(id && live));
  els.runIdLbl.title = id ? "click to copy runId" : "";
}

function startElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  const t0 = Date.now();
  setElapsed(0);
  elapsedTimer = setInterval(() => setElapsed((Date.now() - t0) / 1000), 200);
}
function stopElapsedTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }

// Active group cache. Loaded on startup + on every dropdown change.
let activeGroup = null;
let groupsList = null;

/** Strip the active group's prefix from an agent id, if any. */
function roleOf(agentId) {
  if (!activeGroup) return agentId;
  const prefix = activeGroup.id + ".";
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
}

/**
 * Extract the agent name (role) from the start of a spinner label like
 * "backend: Read-only Findings pass…" or just "producer planning".
 *
 * Validates the candidate against the active group's roster + a fallback
 * list. The old hardcoded regex (`producer|architect|frontend|art-director|
 * qa|security`) silently dropped role names from any new group — which is
 * why backend and desktop sat on "waiting…" forever.
 */
function agentNameFromLabel(label) {
  if (!label) return null;
  const m = label.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
  if (!m) return null;
  const candidate = m[1].toLowerCase();
  if (candidate === "producer") return "producer";
  if (activeGroup && Array.isArray(activeGroup.specialists)) {
    for (const id of activeGroup.specialists) {
      const role = (id.startsWith(activeGroup.id + ".")
        ? id.slice(activeGroup.id.length + 1)
        : id).toLowerCase();
      if (role === candidate) return role;
    }
  }
  if (FALLBACK_ROLES.includes(candidate)) return candidate;
  return null;
}

const EMOJI_PALETTE = ["🧠","🛡️","🧪","📐","🗺️","🔧","🎯","🧩","📡","⚙️","🔬","🧱","🎚️","📦","🛰️"];
function emoji(agent) {
  const role = roleOf(agent);
  // Known stock roles keep their icon; the Coder gets a wrench; every other
  // (wizard-created) specialist gets a STABLE distinct icon derived from its
  // role name — far better than the old "everything not in this list is 🤖".
  const known = {
    producer: "🎬", architect: "🏛️", frontend: "🎨", "art-director": "🖼️", qa: "🔍", security: "🔐", coder: "🛠️",
  };
  if (known[role]) return known[role];
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) >>> 0;
  return EMOJI_PALETTE[h % EMOJI_PALETTE.length];
}

function ensureAgentCard(name) {
  if (!activeRun.agents.has(name)) {
    activeRun.agents.set(name, { name, status: "wait", label: "", elapsed: null });
    renderAgents();
  }
  return activeRun.agents.get(name);
}

function setAgent(name, patch) {
  const a = ensureAgentCard(name);
  Object.assign(a, patch);
  renderAgents();
}

function renderAgents() {
  els.agents.innerHTML = "";
  for (const a of activeRun.agents.values()) {
    const card = document.createElement("div");
    const cls = a.status === "ok" ? "ok" : a.status === "fail" ? "fail"
              : a.status === "running" ? "running" : a.status === "retrying" ? "retrying" : "";
    card.className = `agent-card ${cls}`;
    const dot = a.status === "running"  ? '<span class="spinner"></span>'
              : a.status === "retrying" ? '<span class="spinner retry"></span>'
              : a.status === "ok"       ? '<span class="dot-ok"></span>'
              : a.status === "fail"     ? '<span class="dot-fail"></span>'
              :                           '<span class="dot-wait"></span>';
    let cite = "";
    if (a.citations) {
      if (a.citations.skipped) cite = `<span class="cite">cite: skipped</span>`;
      else if (a.citations.total) {
        const bad = a.citations.unverified || 0;
        cite = `<span class="cite ${bad ? "bad" : "ok"}">cite ${a.citations.total - bad}/${a.citations.total}</span>`;
      }
    }
    card.innerHTML = `
      <div class="agent-card-name">${dot}<span>${emoji(a.name)} ${a.name}</span></div>
      <div class="agent-card-task">${escapeHtml(a.label || "waiting…")}</div>
      <div class="agent-card-meta">
        <span>${a.status}${cite}</span>
        <span>${a.elapsed != null ? a.elapsed.toFixed(1) + "s" : ""}</span>
      </div>
    `;
    els.agents.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function appendLogLine(rawLine) {
  const line = strip(rawLine);
  activeRun.log.push(line);
  const span = document.createElement("span");
  const m = line.match(INFO_RE);
  if (m) span.className = `l-${m[1].trim()}`;
  span.textContent = line + "\n";
  els.logPre.appendChild(span);
  els.logPre.scrollTop = els.logPre.scrollHeight;
}

/**
 * Consume one structured orchestrator event. This replaced the old
 * regex-scraping of stdout: state (phase, agent cards, the answer) now comes
 * from a typed contract, so a cosmetic log-format tweak can't silently break
 * the answer panel. Unknown event types are ignored (forward-compatible).
 */
function onEvent(evt) {
  if (!evt || typeof evt.type !== "string") return;
  switch (evt.type) {
    case "run_started":
      if (evt.runId) setRunIdLabel(evt.runId, true);
      break;
    case "phase":
      setPhase(evt.label ?? evt.phase ?? "");
      break;
    case "dispatch_planned":
      for (const role of evt.agents ?? []) ensureAgentCard(role);
      break;
    case "dispatch_mode":
      if (evt.mode && evt.mode !== "parallel") setPhase(`dispatch: ${evt.mode}`);
      break;
    case "specialist_started":
      setAgent(evt.agent, { status: "running", label: evt.label || "working…" });
      break;
    case "specialist_done":
      setAgent(evt.agent, {
        status: evt.ok ? "ok" : "fail",
        label: evt.ok ? "done" : "failed",
        elapsed: evt.durationMs != null ? evt.durationMs / 1000 : null,
      });
      break;
    case "retry":
      setAgent(evt.agent, { status: "retrying", label: `timed out — retrying (${evt.bumpedTimeoutSec ?? "?"}s)…` });
      break;
    case "citation_check":
      if (evt.agent) setAgent(evt.agent, { citations: { total: evt.total, unverified: evt.unverified, skipped: evt.skippedReason } });
      break;
    case "answer":
      activeRun.answer = (evt.text ?? "").trim();
      els.answerBody.textContent = activeRun.answer;
      showSections({ status: true, log: true, answer: true });
      break;
    case "coder":
      setPhase(evt.ok ? `coder done (${(evt.durationMs / 1000).toFixed(0)}s)` : "coder failed");
      break;
    case "warn":
      appendLogLine(`[warn ] ${evt.msg ?? ""}`);
      break;
    case "error":
      appendLogLine(`[error] ${evt.msg ?? ""}`);
      if (evt.fatal) showBanner(`${evt.phase ? evt.phase + ": " : ""}${evt.msg ?? "error"}`, "error");
      break;
    default:
      break; // done is handled by the process-level orchestrator:done
  }
}

// --- run lifecycle ---

async function startRun() {
  const task = els.taskInput.value.trim();
  if (!task) { els.taskInput.focus(); return; }

  // G.2 — workspace cleanliness guard. Refuse if the tree is dirty (no
  // override); confirm once if it's not a git repo at all. Runs BEFORE we
  // spawn anything so a failed guard doesn't leave a half-set-up run state.
  const useCoder = !!els.useCoder?.checked;
  if (useCoder) {
    if (!activeGroup?.coderAgentId) {
      await confirmDialog({
        title: "No Coder agent on this group",
        body: "The 'Use Coder' box is checked but the active group has no Coder. Add one via Edit Group → '+ Add a specialist' → tick 'Coder agent'.",
        confirmLabel: "OK",
        destructive: true,
      });
      return;
    }
    try {
      const report = await invoke("chat_check_workspace_clean", { groupId: activeGroup.id });
      if (!report.clean) {
        const sample = report.dirtyPaths.slice(0, 8).join("\n  ");
        const more = report.dirtyCount > 8 ? `\n  …and ${report.dirtyCount - 8} more` : "";
        await confirmDialog({
          title: "Workspace has uncommitted changes",
          body:
            `The Coder agent edits files in the workspace. To keep its changes recoverable, commit or stash the working tree first.\n\n` +
            `Dirty entries:\n  ${sample}${more}\n\n` +
            `Commit or stash, then click Run again.`,
          confirmLabel: "OK",
          destructive: true,
        });
        return;
      }
      if (!report.isGitRepo) {
        const ok = await confirmDialog({
          title: "Workspace is not a git repository",
          body: `The workspace at ${activeGroup.workspace} is not a git repo. The Coder will still run, but its changes won't be recoverable via 'git restore'. Proceed?`,
          confirmLabel: "Proceed without git",
          destructive: true,
        });
        if (!ok) return;
      }
    } catch (e) {
      const ok = await confirmDialog({
        title: "Could not check workspace state",
        body: `${String(e).slice(0, 400)}\n\nProceed anyway?`,
        confirmLabel: "Proceed",
        destructive: true,
      });
      if (!ok) return;
    }
  }

  activeRun = { id: null, startedAt: new Date().toISOString(), agents: new Map(), log: [], answer: null };
  hideBanner();

  els.runBtn.disabled = true;
  els.cancelBtn.disabled = false;
  els.taskInput.disabled = true;

  showSections({ status: true, log: true, answer: false });
  setPhase("starting");
  setRunIdLabel("");
  els.logPre.innerHTML = "";
  els.agents.innerHTML = "";
  els.answerBody.textContent = "";
  ensureAgentCard("producer");
  setAgent("producer", { status: "running", label: "planning…" });
  startElapsedTimer();

  // G.3 — loopMax: send 1 if loop unchecked (orchestrator treats <=1 as "no loop")
  const loopMax = (useCoder && els.loop?.checked) ? Math.max(1, Math.min(5, Number(els.loopMax.value) || 1)) : 1;

  try {
    const id = await invoke("run_task", {
      task,
      verbose: els.verbose.checked,
      smartDispatch: els.smart?.checked === true,
      timeoutSec: Number(els.timeout.value) || 1800,
      useCoder,
      loopMax,
    });
    // Pin the run id Rust minted (and passed to the orchestrator via --run-id):
    // it lets us label the run, drop stale events from a previous/dying run,
    // and load this exact record from history afterward.
    activeRun.id = id;
    setRunIdLabel(id, true);
  } catch (e) {
    appendLogLine(`[error] failed to start: ${e}`);
    showBanner(`Failed to start run: ${e}`, "error");
    finishRun(null);
  }
}

async function cancelRun() {
  // G.3 — when a loop is in flight, prefer soft cancel (stops between
  // iterations, lets the current openclaw finish cleanly). Hard kill is the
  // fallback for everything else (single-pass audits, single-pass Coder).
  const usingLoop = els.useCoder?.checked && els.loop?.checked && Number(els.loopMax?.value) > 1;
  if (usingLoop) {
    appendLogLine("[warn ] soft-cancel requested — will stop after current iteration");
    setPhase("cancelling…");
    showBanner("Soft-cancel requested — finishing the current iteration, then stopping.", "info");
    try {
      await invoke("cancel_run_soft");
      return;
    } catch (e) {
      appendLogLine(`[warn ] soft-cancel failed (${e}), falling back to hard kill`);
    }
  }
  try {
    await invoke("cancel_run");
    setPhase("cancelling…");
    appendLogLine("[warn ] cancel requested");
  } catch (e) {
    appendLogLine(`[error] cancel failed: ${e}`);
    showBanner(`Cancel failed: ${e}`, "error");
  }
}

function finishRun(exitCode, waitError) {
  stopElapsedTimer();
  els.runBtn.disabled = false;
  els.cancelBtn.disabled = true;
  els.taskInput.disabled = false;
  if (exitCode != null) {
    appendLogLine(`[info ] process exited code=${exitCode}`);
  }
  if (waitError) {
    appendLogLine(`[error] ${waitError}`);
    showBanner(`Run ended abnormally: ${waitError}`, "error");
  }
  // Reconcile agent cards: on a non-clean exit (crash, cancel, spawn failure)
  // any specialist still showing the spinner/retrying or "waiting…" never
  // reported back. Mark those failed instead of leaving them spinning forever.
  if (exitCode !== 0) {
    for (const [name, a] of activeRun.agents) {
      if (a.status === "running" || a.status === "wait" || a.status === "retrying") {
        setAgent(name, { status: "fail", label: a.label || "did not finish" });
      }
    }
  }
  // Answer safety net: if the run finished but no `answer` event arrived (hard
  // kill mid-answer, format change), fall back to the saved record's
  // finalAnswer so the answer is never silently lost.
  if (!activeRun.answer && activeRun.id) {
    invoke("get_run", { runId: activeRun.id })
      .then(r => {
        if (r?.finalAnswer) {
          activeRun.answer = r.finalAnswer;
          els.answerBody.textContent = r.finalAnswer;
          showSections({ status: true, log: true, answer: true });
        }
      })
      .catch(() => {});
  }
  // Surface a recovery hint for known non-zero exits when the log is collapsed.
  if (exitCode != null && exitCode !== 0) {
    const e = EXIT_LEGEND[exitCode];
    if (e?.hint && els.logSec.classList.contains("collapsed")) showBanner(e.hint, "warn");
  }
  setPhase(exitCode === 0 ? "done" : waitError ? "error (internal)" : exitCode == null ? "stopped" : describeExit(exitCode));
  // refresh history sidebar
  refreshRuns();
}

// --- history ---

async function refreshRuns() {
  try {
    const runs = await invoke("list_runs");
    if (!runs.length) {
      els.runsList.innerHTML = '<div class="empty">No runs yet.</div>';
      return;
    }
    els.runsList.innerHTML = "";
    for (const r of runs) {
      const div = document.createElement("div");
      div.className = "run-item";
      div.dataset.id = r.runId;
      div.innerHTML = `
        <div class="task">${escapeHtml(r.task)}</div>
        <div class="meta">
          <span>${r.runId}</span>
          <span>${r.hasFinal ? '<span class="done-dot">●</span>' : '<span class="pending-dot">●</span>'}</span>
        </div>
      `;
      div.addEventListener("click", () => loadRun(r.runId, div));
      els.runsList.appendChild(div);
    }
  } catch (e) {
    els.runsList.innerHTML = `<div class="empty">failed to load runs: ${escapeHtml(String(e))}</div>`;
  }
}

async function loadRun(runId, itemEl) {
  document.querySelectorAll(".run-item.active").forEach(el => el.classList.remove("active"));
  itemEl?.classList.add("active");
  try {
    const r = await invoke("get_run", { runId });
    activeRun = {
      id: r.runId, startedAt: r.startedAt, agents: new Map(),
      log: [], answer: r.finalAnswer ?? null,
    };
    hideBanner();
    setRunIdLabel(r.runId, false);
    // failurePhase is a structured field on newer records; older ones lack it.
    setPhase(r.finalAnswer ? "done" : r.failurePhase ? `failed: ${r.failurePhase}` : "incomplete");
    els.elapsedLbl.textContent = "";
    els.logPre.innerHTML = "";
    els.agents.innerHTML = "";
    els.taskInput.value = r.task ?? "";

    // Re-create cards from saved specialistResults. New records carry
    // durationMs; old ones don't — guard every new field.
    for (const s of r.specialistResults ?? []) {
      ensureAgentCard(s.agent);
      setAgent(s.agent, {
        status: s.ok ? "ok" : "fail",
        label: (s.reply ?? "").slice(0, 120),
        elapsed: s.durationMs != null ? s.durationMs / 1000 : null,
      });
    }

    // Show a COLLAPSED log (not hidden) so a failed past run's detail is one
    // click away instead of invisible. Populate from a saved log if present.
    els.logPre.innerHTML = "";
    if (Array.isArray(r.log) && r.log.length) {
      for (const ln of r.log) appendLogLine(ln);
    } else {
      appendLogLine("[info ] no saved log for this run (records store the final answer + per-specialist replies).");
    }
    els.logSec.classList.add("collapsed");
    els.logToggle.textContent = "expand";

    if (r.finalAnswer) {
      els.answerBody.textContent = r.finalAnswer;
      showSections({ status: true, log: true, answer: true });
    } else {
      showSections({ status: true, log: true, answer: false });
    }
  } catch (e) {
    appendLogLine(`[error] could not load ${runId}: ${e}`);
  }
}

// --- events ---

els.runBtn.addEventListener("click", startRun);
els.cancelBtn.addEventListener("click", cancelRun);
els.generateBtn?.addEventListener("click", generateMainTaskPrompt);

/**
 * Generate a polished task prompt from a fuzzy user brief using the active
 * group's Producer. Mirrors the Add-specialist Generate flow but aimed at
 * the main task input box. Producer takes 30-90s via claude-cli; Run is
 * disabled the whole time so the user can't kick off the actual run before
 * Generate returns. The brief in the textarea is replaced with the polished
 * prompt on success.
 */
async function generateMainTaskPrompt() {
  const brief = els.taskInput.value.trim();
  if (!brief) {
    alert("Type a brief in the task box first — e.g. \"audit auth flows for missing validation\" — then click Generate.");
    return;
  }
  if (!activeGroup) {
    alert("No active group loaded yet.");
    return;
  }
  const ok = els.taskInput.dataset.fromPreset !== "1"
    && brief.length > 200
    ? await confirmDialog({
        title: "Replace existing task?",
        body: `Generate will send your current text to the ${activeGroup.id} Producer and replace it with a polished version. Your current text (${brief.length} chars) will be lost.`,
        confirmLabel: "Generate",
      })
    : true;
  if (!ok) return;

  const originalLabel = els.generateBtn.textContent;
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = `asking ${activeGroup.id} Producer…`;
  els.runBtn.disabled = true;
  try {
    const polished = await invoke("chat_generate_task_prompt", { brief });
    els.taskInput.value = polished;
    els.taskInput.dataset.fromPreset = "0"; // it's now user-edited territory
    els.taskInput.focus();
  } catch (e) {
    alert(`Generate failed: ${String(e).slice(0, 400)}`);
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = originalLabel;
    els.runBtn.disabled = false;
  }
}
els.newRunBtn.addEventListener("click", () => {
  els.taskInput.value = "";
  els.taskInput.focus();
  document.querySelectorAll(".run-item.active").forEach(el => el.classList.remove("active"));
  showSections({ status: false, log: false, answer: false });
});

els.logToggle.addEventListener("click", () => {
  const sec = els.logSec;
  const collapsed = sec.classList.toggle("collapsed");
  els.logToggle.textContent = collapsed ? "expand" : "collapse";
});

els.copyAnswer.addEventListener("click", async () => {
  if (!activeRun?.answer) return;
  try {
    await navigator.clipboard.writeText(activeRun.answer);
    els.copyAnswer.textContent = "copied!";
    setTimeout(() => els.copyAnswer.textContent = "copy", 1200);
  } catch (e) { els.copyAnswer.textContent = "fail"; }
});

// Pop-out answer modal — bigger, resizable reading area with copy.
function showAnswerPopout() {
  if (!activeRun?.answer) return;
  els.answerModalBody.textContent = activeRun.answer;
  els.answerModalSize.textContent = `${(activeRun.answer.length / 1024).toFixed(1)}KB`;
  els.answerModal.classList.remove("hidden");
  els.answerModalBody.scrollTop = 0;
}
function hideAnswerPopout() {
  els.answerModal.classList.add("hidden");
}
els.popoutAnswer?.addEventListener("click", showAnswerPopout);
els.answerModalClose?.addEventListener("click", hideAnswerPopout);
els.answerModalCopy?.addEventListener("click", async () => {
  if (!activeRun?.answer) return;
  try {
    await navigator.clipboard.writeText(activeRun.answer);
    const orig = els.answerModalCopy.textContent;
    els.answerModalCopy.textContent = "✓ Copied!";
    setTimeout(() => els.answerModalCopy.textContent = orig, 1500);
  } catch (e) {
    els.answerModalCopy.textContent = "✗ Failed";
  }
});
// ESC closes the popout (separate from settings modal escape handling)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.answerModal.classList.contains("hidden")) hideAnswerPopout();
});
// Click backdrop closes
els.answerModal?.addEventListener("click", (e) => {
  if (e.target === els.answerModal) hideAnswerPopout();
});

// Ctrl/Cmd + Enter submits
els.taskInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !els.runBtn.disabled) startRun();
});

// Drop events from any run other than the active one. After a hard cancel,
// buffered stdout from the dying orchestrator still arrives tagged with the
// OLD runId; without this it bleeds into the next run's log + answer buffer
// (run A → cancel → start B → A's late lines corrupt B). activeRun.id is null
// only in the brief window before run_task returns, during which no other run
// can be active — so those unfiltered events are safe to accept.
function isStaleEvent(payload) {
  return activeRun?.id != null && payload?.runId != null && payload.runId !== activeRun.id;
}

// Structured events drive run state (phase, cards, answer); human log lines
// still flow to the log panel verbatim. Both are runId-filtered.
await listen("orchestrator:event", e => {
  if (isStaleEvent(e.payload)) return;
  onEvent(e.payload);
});

await listen("orchestrator:line", e => {
  if (isStaleEvent(e.payload)) return;
  appendLogLine(e.payload.line);
});

await listen("orchestrator:done", e => {
  if (isStaleEvent(e.payload)) return;
  finishRun(e.payload.exitCode, e.payload.waitError);
});

// Backend config-mutation warnings (gateway restart, auth copy, identity, …)
// that used to be silently swallowed now surface as a banner.
await listen("op:warning", e => {
  const p = e.payload || {};
  showBanner(`${p.op}: ${p.detail}`, p.fatal ? "error" : "warn");
});

// --- Settings modal ---

const MODEL_CATALOG = {
  anthropic: ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
  google: ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-flash-latest"],
  openrouter: [
    "openrouter/google/gemma-4-31b-it:free",
    "openrouter/deepseek/deepseek-v4-flash:free",
    "openrouter/qwen/qwen3-coder:free",
    "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    "openrouter/nvidia/nemotron-3-super-120b:free",
  ],
  deepseek: ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  openai: ["openai/gpt-5.3", "openai/gpt-5.2", "openai/gpt-5.4-codex"],
  mistral: ["mistral/codestral-latest", "mistral/devstral-medium-latest"],
  groq: ["groq/deepseek-r1-distill-llama-70b", "groq/llama-3.3-70b-versatile"],
  together: ["together/deepseek-ai/DeepSeek-V3", "together/deepseek-ai/DeepSeek-R1"],
  cerebras: ["cerebras/llama3.1-8b", "cerebras/qwen-3-235b-a22b-instruct-2507"],
};

function allCatalogedModels() {
  return Object.values(MODEL_CATALOG).flat().sort();
}

const settingsEls = {
  modal:        document.getElementById("settingsModal"),
  openBtn:      document.getElementById("settingsBtn"),
  closeBtn:     document.getElementById("settingsCloseBtn"),
  cancelBtn:    document.getElementById("settingsCancelBtn"),
  applyBtn:     document.getElementById("settingsApplyBtn"),
  status:       document.getElementById("settingsStatus"),
  providersTbody: document.querySelector("#providersTable tbody"),
  agentsTbody:    document.querySelector("#agentsTable tbody"),
  groupsTbody:    document.querySelector("#groupsTable tbody"),
  addProvider:    document.getElementById("addProviderSelect"),
  addProfileId:   document.getElementById("addProfileIdInput"),
  addApiKey:      document.getElementById("addApiKeyInput"),
  addProviderBtn: document.getElementById("addProviderBtn"),
  addProviderStatus: document.getElementById("addProviderStatus"),
};

// Pending changes: agentId -> { primary?: string, thinking?: string }.
let pendingAgentChanges = {};

// Models that actually accept an extended-thinking / reasoning-effort knob.
// Anything not matched here gets just (default) + off — picking "high" on a
// model that ignores it is misleading UI.
const THINKING_LABEL = { "": "(default)", off: "off", low: "low", medium: "medium", high: "high", max: "max (Opus only)" };

function thinkingLevelsFor(modelId) {
  const m = (modelId || "").toLowerCase();
  const FULL_WITH_MAX = ["", "off", "low", "medium", "high", "max"];
  const FULL          = ["", "off", "low", "medium", "high"];
  const NONE          = ["", "off"];

  // Inclusion-by-default. Only exclude models we KNOW don't support extended
  // thinking. If a model ignores the parameter, the worst case is "high" gets
  // treated like default — no crash, no error. Hiding a working knob is worse.

  // Legacy Anthropic (Claude 3.x — no extended thinking; Haiku — no extended thinking)
  if (m.startsWith("anthropic/claude-3") || m.includes("haiku")) return NONE;
  // GPT-4 family is not a reasoning model line
  if (/^openai\/gpt-(3|4)(?![-.]?5)/.test(m) || m.startsWith("openai/gpt-4.")) return NONE;
  if (m.startsWith("openai/gpt-3")) return NONE;
  // Non-reasoning open-weight families
  if (/(^|\/)gemma/.test(m)) return NONE;
  if (/(^|\/)llama-?\d/.test(m)) return NONE;
  if (/(^|\/)qwen3-coder/.test(m)) return NONE;     // coder line, not the reasoning line
  if (m.includes("mimo")) return NONE;
  if (m.includes("kimi-k2") && !m.includes("thinking")) return NONE;
  if (/^together\//.test(m) && !m.includes("deepseek")) return NONE;
  if (/^cerebras\//.test(m) && !m.includes("gpt-oss")) return NONE;
  // OpenRouter wrappers around the above
  if (/^openrouter\/(google\/gemma|meta-llama\/llama-?\d|qwen\/qwen3-coder|cognitivecomputations\/dolphin|liquid\/lfm|nvidia\/nemotron-nano)/.test(m)) return NONE;

  // 'max' thinking is Anthropic-Opus-only. Sonnet rejects it via claude-cli
  // with an empty-stderr silent failure (caught after a 33s ui-ux dispatch
  // returned with no useful error). Other Anthropic models stay at 'high'.
  if (m.startsWith("anthropic/claude-opus") || m === "anthropic/claude-opus-4-7" || m === "anthropic/claude-opus-4-6") {
    return FULL_WITH_MAX;
  }
  return FULL;
}

function renderThinkingOptions(levels, current) {
  return levels.map(l => {
    const label = THINKING_LABEL[l] ?? l;
    const sel = l === current ? " selected" : "";
    return `<option value="${escapeHtml(l)}"${sel}>${escapeHtml(label)}</option>`;
  }).join("");
}

function showSettings() {
  pendingAgentChanges = {};
  settingsEls.status.textContent = "loading…";
  settingsEls.modal.classList.remove("hidden");
  loadSettings();
}

function hideSettings() {
  settingsEls.modal.classList.add("hidden");
}

async function loadSettings() {
  try {
    const snap = await invoke("settings_get");
    renderProviders(snap.profiles);
    // Per-agent model + thinking moved into the Edit Group modal — no
    // longer rendered here. (See egState / renderEgAgentsTable.)
    await renderGroupsTable();
    await renderClaudeCliStatus();
    settingsEls.status.textContent = "";
  } catch (e) {
    settingsEls.status.textContent = `load failed: ${e}`;
  }
}

/**
 * Render the Claude CLI status row in Settings → Providers. Shows whether
 * claude.exe is on PATH (the Anthropic fallback path used when no API key is
 * saved). Non-blocking — failures degrade to an unobtrusive "unknown" state.
 */
async function renderClaudeCliStatus() {
  const row = document.getElementById("claudeCliStatusRow");
  if (!row) return;
  const detail = row.querySelector(".cli-status-detail");
  if (!detail) return;
  try {
    const s = await invoke("settings_claude_cli_status");
    if (s.installed) {
      const v = s.version ? ` ${s.version}` : "";
      detail.innerHTML = `<span class="ok">✓ detected${escapeHtml(v)}</span> <span class="muted">— Anthropic fallback ready (Max sub)</span>`;
    } else {
      detail.innerHTML = `<span class="warn">✗ not installed</span> <span class="muted">— run <code>npm i -g @anthropic-ai/claude-code</code> to enable the Anthropic fallback</span>`;
    }
  } catch (e) {
    detail.innerHTML = `<span class="muted">unknown (${escapeHtml(String(e))})</span>`;
  }
}

async function renderGroupsTable() {
  if (!settingsEls.groupsTbody) return;
  settingsEls.groupsTbody.innerHTML = "";
  const file = await invoke("groups_list");
  for (const g of file.groups ?? []) {
    const tr = document.createElement("tr");
    const isActive = g.id === file.activeGroupId;
    const agentCount = (g.specialists?.length ?? 0) + 1; // +1 for producer
    tr.innerHTML = `
      <td><span style="font-size:16px">${escapeHtml(g.emoji)}</span> <strong>${escapeHtml(g.displayName)}</strong>${isActive ? ' <span class="muted">(active)</span>' : ''}<div class="muted" style="font-size:11px">${escapeHtml(g.id)}</div></td>
      <td class="mono" style="font-size:11.5px">${escapeHtml(g.workspace)}</td>
      <td class="mono">${agentCount}</td>
      <td class="actions row-actions">
        ${isActive ? "" : '<button class="ghost small" data-action="activate">Make active</button>'}
        <button class="ghost small" data-action="edit">Edit</button>
        <button class="danger small" data-action="remove" ${file.groups.length <= 1 ? "disabled" : ""}>Remove</button>
      </td>
    `;
    tr.querySelector('[data-action="activate"]')?.addEventListener("click", async () => {
      try { await invoke("groups_set_active", { groupId: g.id }); await loadGroups(); await loadPresetsForActiveGroup(); populatePresets(); refreshComposerCoderUI(); await refreshRuns(); await renderGroupsTable(); }
      catch (e) { alert("activate failed: " + e); }
    });
    tr.querySelector('[data-action="edit"]')?.addEventListener("click", () => openEditGroup(g));
    tr.querySelector('[data-action="remove"]')?.addEventListener("click", async () => {
      if (!await confirmDialog({
        title: `Remove group "${g.displayName}"?`,
        body:
          `Removing this group will delete:\n` +
          `  • ${agentCount} agents (OpenClaw config + ~/.openclaw/agents/<id>/ dirs)\n` +
          `  • Their system prompts in ~/.openclaw/team-prompts/\n` +
          `  • Run history at runs/${g.id}/\n` +
          `  • The group's preset library at ~/.crime-team/groups/${g.id}/\n\n` +
          `The workspace at ${g.workspace} will NOT be touched.\n\n` +
          `This cannot be undone.`,
        confirmLabel: "Remove group",
        destructive: true,
      })) return;
      try {
        await invoke("groups_remove", { groupId: g.id });
        await loadGroups();
        await loadPresetsForActiveGroup(); populatePresets();
        await refreshRuns();
        await loadSettings();
      } catch (e) { alert("remove failed: " + e); }
    });
    settingsEls.groupsTbody.appendChild(tr);
  }
}

// --- Group editor modal ---

const egEls = {
  modal:       document.getElementById("editGroupModal"),
  title:       document.getElementById("egGroupTitle"),
  closeBtn:    document.getElementById("egCloseBtn"),
  cancelBtn:   document.getElementById("egCancelBtn"),
  saveBtn:     document.getElementById("egSaveBtn"),
  status:      document.getElementById("egStatus"),
  name:        document.getElementById("egName"),
  emoji:       document.getElementById("egEmoji"),
  workspace:   document.getElementById("egWorkspace"),
  browseBtn:   document.getElementById("egBrowseBtn"),
  promptTabs:  document.getElementById("egPromptTabs"),
  promptEditor: document.getElementById("egPromptEditor"),
  promptMeta:  document.getElementById("egPromptMeta"),
  agentsTbody: document.querySelector("#egAgentsTable tbody"),
};
let egState = {
  group: null,
  prompts: {},                  // qualifiedId -> markdown
  activeTab: "",
  dirtyMeta: false,
  dirtyPrompts: new Set(),
  pendingAgentChanges: {},      // qualifiedId -> { primary?, thinking? }
};

async function openEditGroup(group) {
  egState = { group, prompts: {}, activeTab: "", dirtyMeta: false, dirtyPrompts: new Set(), pendingAgentChanges: {} };
  egEls.title.textContent = `· ${group.emoji} ${group.displayName}`;
  egEls.name.value = group.displayName;
  egEls.emoji.value = group.emoji;
  egEls.workspace.value = group.workspace;
  egEls.status.textContent = "loading…";

  // Load each agent's prompt
  const allIds = [group.producerAgentId, ...group.specialists];
  for (const id of allIds) {
    try { egState.prompts[id] = await invoke("groups_get_prompt", { agentId: id }); }
    catch (e) { egState.prompts[id] = `[failed to load: ${e}]`; }
  }
  egState.activeTab = allIds[0];

  // Load this group's agents (scoped via the new settings_get groupId arg)
  try {
    const snap = await invoke("settings_get", { groupId: group.id });
    renderEgAgentsTable(snap.agents);
  } catch (e) {
    egEls.agentsTbody.innerHTML = `<tr><td colspan="4" class="muted">load failed: ${escapeHtml(String(e))}</td></tr>`;
  }

  // Populate the "Add specialist" form's model + thinking dropdowns each time
  // we open the modal (model catalog can grow between openings).
  const newSpecModel = document.getElementById("egNewSpecModel");
  if (newSpecModel) {
    fillSelect(newSpecModel, allCatalogedModels(), "anthropic/claude-sonnet-4-6");
    const newSpecThinking = document.getElementById("egNewSpecThinking");
    if (newSpecThinking) {
      newSpecThinking.innerHTML = renderThinkingOptions(thinkingLevelsFor(newSpecModel.value), "medium");
      newSpecModel.onchange = () => {
        newSpecThinking.innerHTML = renderThinkingOptions(thinkingLevelsFor(newSpecModel.value), "medium");
      };
    }
  }
  // G.1 Coder toggle — wire once, then sync the form to its current state
  const kindToggle = document.getElementById("egNewSpecKindCoder");
  if (kindToggle && !kindToggle.dataset.wired) {
    kindToggle.addEventListener("change", () => applyCoderKindUI(kindToggle.checked));
    kindToggle.dataset.wired = "1";
  }
  // If this group already has a Coder, disable the toggle with a tooltip
  // (clearer than hiding — discoverability + explanation).
  if (kindToggle) {
    const hasCoder = !!egState.group.coderAgentId;
    kindToggle.checked = false;
    kindToggle.disabled = hasCoder;
    const kindRow = document.getElementById("egNewSpecKindRow");
    if (kindRow) {
      kindRow.title = hasCoder
        ? `This group already has a Coder agent (${egState.group.coderAgentId.split(".").slice(1).join(".")}). Remove it first to add a new one.`
        : "";
      kindRow.classList.toggle("disabled", hasCoder);
    }
    applyCoderKindUI(false);  // reset form to audit mode on every open
  }
  const addBtn = document.getElementById("egAddSpecBtn");
  if (addBtn && !addBtn.dataset.wired) {
    // Bind once. preventDefault stops the <details> form's default submit.
    addBtn.addEventListener("click", (e) => { e.preventDefault(); addSpecialist(); });
    addBtn.dataset.wired = "1";
  }
  const genBtn = document.getElementById("egGenerateSpecBtn");
  if (genBtn && !genBtn.dataset.wired) {
    genBtn.addEventListener("click", (e) => { e.preventDefault(); generateSpecialistPrompt(); });
    genBtn.dataset.wired = "1";
  }
  // Auto-normalize the role-id input as the user types: lowercase, collapse
  // spaces and underscores into hyphens, strip anything else. Without this,
  // typing "Security Test" produces "Security Test" which fails the
  // kebab-case validator on submit — confusing UX. Now you can type naturally
  // and the field shows the sanitized id live.
  const newSpecIdInput = document.getElementById("egNewSpecId");
  if (newSpecIdInput && !newSpecIdInput.dataset.wired) {
    newSpecIdInput.addEventListener("input", (e) => {
      const cleaned = e.target.value
        .toLowerCase()
        .replace(/[\s_]+/g, "-")          // spaces/underscores → hyphens
        .replace(/[^a-z0-9-]/g, "")        // strip everything else
        .replace(/-+/g, "-")               // collapse multiple hyphens
        .slice(0, 20);                     // hard cap
      if (cleaned !== e.target.value) e.target.value = cleaned;
    });
    newSpecIdInput.dataset.wired = "1";
  }

  egEls.status.textContent = "";
  renderEgTabs();
  egEls.modal.classList.remove("hidden");
}

function renderEgAgentsTable(agents) {
  egEls.agentsTbody.innerHTML = "";
  const all = allCatalogedModels();
  // Producer can never be removed (a group always has exactly one). The last
  // AUDIT specialist also can't be removed — Rust enforces that, but we
  // disable the button here for clearer UX. Coder doesn't count toward the
  // minimum and can always be removed.
  const producerId = egState.group.producerAgentId;
  const coderId = egState.group.coderAgentId;
  const auditCount = egState.group.specialists.filter(s => s !== coderId).length;

  for (const a of agents) {
    const role = a.id.startsWith(egState.group.id + ".") ? a.id.slice(egState.group.id.length + 1) : a.id;
    const isProducer = a.id === producerId;
    const isCoder = a.id === coderId;
    const isLastAudit = !isProducer && !isCoder && auditCount <= 1;
    const options = new Set(all);
    if (a.primary) options.add(a.primary);
    const sortedOpts = Array.from(options).sort();
    const thinkingLevels = thinkingLevelsFor(a.primary);
    const currentThinking = a.thinking ?? "";

    const roleCell = isCoder
      ? `${emoji(a.id)} ${escapeHtml(role)} <span class="role-chip coder-chip" title="Coder agent — excluded from normal audit dispatch. Runs only when 'Use Coder' is checked on the composer.">Coder</span>`
      : `${emoji(a.id)} ${escapeHtml(role)}`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${roleCell}</td>
      <td class="mono">${escapeHtml(a.primary || "(none)")}</td>
      <td>
        <select data-agent="${escapeHtml(a.id)}" data-field="primary">
          ${sortedOpts.map(m => `<option value="${escapeHtml(m)}"${m === a.primary ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </td>
      <td>
        <select data-agent="${escapeHtml(a.id)}" data-field="thinking">
          ${renderThinkingOptions(thinkingLevels, currentThinking)}
        </select>
      </td>
      <td class="row-actions">
        ${isProducer
          ? `<span class="muted" title="The Producer is required and can't be renamed or removed.">—</span>`
          : isCoder
          ? `<span class="muted" title="The Coder role id is fixed.">—</span>
             <button class="danger small" data-remove-role="${escapeHtml(role)}">Remove</button>`
          : `<button class="small" data-rename-role="${escapeHtml(role)}">Rename</button>
             <button class="danger small" data-remove-role="${escapeHtml(role)}"${isLastAudit ? ' disabled title="A group needs at least one audit specialist."' : ""}>Remove</button>`
        }
      </td>
    `;
    const modelSel = tr.querySelector('select[data-field="primary"]');
    const thinkSel = tr.querySelector('select[data-field="thinking"]');
    if (thinkingLevels.length <= 2) thinkSel.title = "This model does not support extended thinking.";

    modelSel.addEventListener("change", () => {
      egState.pendingAgentChanges[a.id] = egState.pendingAgentChanges[a.id] ?? {};
      if (modelSel.value !== a.primary) egState.pendingAgentChanges[a.id].primary = modelSel.value;
      else delete egState.pendingAgentChanges[a.id].primary;
      // Refresh thinking dropdown for the new model
      const newLevels = thinkingLevelsFor(modelSel.value);
      const keep = newLevels.includes(thinkSel.value) ? thinkSel.value : "";
      thinkSel.innerHTML = renderThinkingOptions(newLevels, keep);
      thinkSel.title = newLevels.length <= 2 ? "This model does not support extended thinking." : "";
      if (keep !== currentThinking) {
        egState.pendingAgentChanges[a.id].thinking = keep;
      }
    });
    thinkSel.addEventListener("change", () => {
      egState.pendingAgentChanges[a.id] = egState.pendingAgentChanges[a.id] ?? {};
      if (thinkSel.value !== currentThinking) egState.pendingAgentChanges[a.id].thinking = thinkSel.value;
      else delete egState.pendingAgentChanges[a.id].thinking;
    });

    const removeBtn = tr.querySelector("button[data-remove-role]");
    if (removeBtn && !removeBtn.disabled) {
      removeBtn.addEventListener("click", () => removeSpecialist(role));
    }
    const renameBtn = tr.querySelector("button[data-rename-role]");
    if (renameBtn) {
      renameBtn.addEventListener("click", () => renameSpecialist(role));
    }

    egEls.agentsTbody.appendChild(tr);
  }
}

/**
 * Sibling of confirmDialog with an input field. Returns the trimmed string
 * the user typed, or null if cancelled. Auto-normalizes kebab-case as the
 * user types (lowercase + spaces→hyphens + strip invalid chars + ≤20 chars),
 * matching the Add-specialist field's behavior. The Enter key submits the
 * dialog (allowed here because there's nothing destructive to fat-finger).
 */
function promptDialog({ title, body, defaultValue = "", placeholder = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal confirm-modal" role="dialog" aria-modal="true">
        <header class="modal-header"><h2>${escapeHtml(title)}</h2></header>
        <div class="modal-body confirm-body-wrap">
          ${body ? `<p class="confirm-body">${escapeHtml(body).replace(/\n/g, "<br>")}</p>` : ""}
          <input type="text" class="prompt-input" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}" maxlength="20" />
        </div>
        <footer class="modal-footer">
          <div class="modal-footer-actions">
            <button type="button" class="confirm-cancel">Cancel</button>
            <button type="button" class="primary confirm-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector(".prompt-input");
    const cancelBtn = backdrop.querySelector(".confirm-cancel");
    const okBtn = backdrop.querySelector(".confirm-ok");
    // Auto-normalize as user types — same rules as the Add-specialist input
    input.addEventListener("input", (e) => {
      const cleaned = e.target.value.toLowerCase()
        .replace(/[\s_]+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .slice(0, 20);
      if (cleaned !== e.target.value) e.target.value = cleaned;
    });
    const close = (result) => {
      document.removeEventListener("keydown", keyHandler);
      backdrop.remove();
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter") {
        const v = input.value.trim();
        if (v) close(v);
      }
    };
    okBtn.addEventListener("click", () => {
      const v = input.value.trim();
      if (v) close(v);
    });
    cancelBtn.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", keyHandler);
    input.focus();
    input.select();
  });
}

/**
 * Rename a specialist's role id. Calls groups_rename_specialist which moves
 * the agent dir, prompt file, openclaw.json + groups.json + .crime-team.json
 * entries — gateway restart included. Workspace is never touched.
 */
async function renameSpecialist(oldRole) {
  const newRole = await promptDialog({
    title: `Rename specialist "${oldRole}"`,
    body: `Enter the new role id. Kebab-case, ≤20 chars (auto-normalized as you type).`,
    defaultValue: oldRole,
    placeholder: "e.g. sec-audit",
    confirmLabel: "Rename",
  });
  if (!newRole || newRole === oldRole) return;

  egEls.status.textContent = `renaming ${oldRole} → ${newRole}…`;
  try {
    const updated = await invoke("groups_rename_specialist", {
      groupId: egState.group.id,
      oldRole,
      newRole,
    });
    egState.group = updated;
    await loadGroups();
    await openEditGroup(updated);
    egEls.status.textContent = `renamed ${oldRole} → ${newRole}`;
  } catch (e) {
    egEls.status.textContent = `rename failed: ${String(e).slice(0, 200)}`;
  }
}

/**
 * Remove a specialist from the currently-edited group. Surfaces a confirm
 * dialog that explicitly states the workspace will NOT be touched — that's the
 * lesson from the ServUO incident, see lib.rs::groups_remove for the full
 * write-up. The Rust command refuses to call `openclaw agents delete`.
 */
async function removeSpecialist(role) {
  const ws = egState.group.workspace;
  const ok = await confirmDialog({
    title: `Remove specialist "${role}"?`,
    body:
      `Removing this specialist from "${egState.group.displayName}" will:\n` +
      `  • Drop the agent from OpenClaw config\n` +
      `  • Delete the agent's chat history at ~/.openclaw/agents/${egState.group.id}.${role}/\n` +
      `  • Delete the team-prompt file\n\n` +
      `The workspace at ${ws} will NOT be touched.`,
    confirmLabel: "Remove specialist",
    destructive: true,
  });
  if (!ok) return;

  egEls.status.textContent = `removing ${role}…`;
  try {
    const updated = await invoke("groups_remove_specialist", { groupId: egState.group.id, role });
    egState.group = updated;
    // Reload Edit Group state so dropped role disappears from tabs + tables
    await loadGroups();
    await openEditGroup(updated);
    egEls.status.textContent = `removed ${role}`;
  } catch (e) {
    egEls.status.textContent = `remove failed: ${e}`;
  }
}

/**
 * G.1 — Shape-shift the Add Specialist form when the Coder toggle is on.
 * Locks id/model/thinking, gates Add behind Generate (Coder prompts must be
 * Producer-drafted), and swaps the Generate handler to the Coder-specific
 * meta-prompt. Toggling off restores audit-mode defaults.
 */
function applyCoderKindUI(isCoder) {
  const idInput = document.getElementById("egNewSpecId");
  const emojiInput = document.getElementById("egNewSpecEmoji");
  const modelSel = document.getElementById("egNewSpecModel");
  const thinkSel = document.getElementById("egNewSpecThinking");
  const promptArea = document.getElementById("egNewSpecPrompt");
  const promptLabel = document.getElementById("egNewSpecPromptLabel");
  const genBtn = document.getElementById("egGenerateSpecBtn");
  const addBtn = document.getElementById("egAddSpecBtn");
  if (!idInput || !modelSel || !thinkSel || !genBtn || !addBtn) return;

  if (isCoder) {
    idInput.value = "coder";
    idInput.disabled = true;
    if (emojiInput && (!emojiInput.value || emojiInput.value === "🤖")) emojiInput.value = "🛠";
    // Force Opus + max — Coder is multi-file reasoning where max thinking pays off.
    const opus = "anthropic/claude-opus-4-7";
    if (![...modelSel.options].some(o => o.value === opus)) {
      const opt = document.createElement("option");
      opt.value = opus; opt.textContent = opus;
      modelSel.appendChild(opt);
    }
    modelSel.value = opus;
    modelSel.disabled = true;
    modelSel.title = "Coder always uses Opus (multi-file reasoning).";
    thinkSel.innerHTML = renderThinkingOptions(thinkingLevelsFor(opus), "max");
    thinkSel.value = "max";
    thinkSel.disabled = true;
    thinkSel.title = "Coder always uses max thinking.";
    if (promptLabel) promptLabel.textContent = "Coder system prompt — type a brief, then click Generate (Producer drafts it).";
    promptArea.placeholder = "e.g. 'apply audit findings; small focused changes only; never touch identity files'  →  click Generate Coder prompt";
    promptArea.value = ""; // clear any audit-mode text so the brief doesn't bleed in
    genBtn.textContent = "Generate Coder prompt";
    addBtn.disabled = true;  // re-enable only after Generate succeeds
    addBtn.title = "Click Generate Coder prompt first — Coder prompts must be Producer-drafted.";
  } else {
    idInput.disabled = false;
    if (idInput.value === "coder") idInput.value = "";
    if (emojiInput && emojiInput.value === "🛠") emojiInput.value = "🤖";
    modelSel.disabled = false;
    modelSel.title = "";
    modelSel.value = "anthropic/claude-sonnet-4-6";
    thinkSel.innerHTML = renderThinkingOptions(thinkingLevelsFor(modelSel.value), "medium");
    thinkSel.disabled = false;
    thinkSel.title = "";
    if (promptLabel) promptLabel.textContent = "System prompt — write the full prompt OR type a brief and click Generate";
    promptArea.placeholder = "Brief: e.g. 'audit auth flows, secret handling, injection surfaces'  →  click Generate for Producer to draft a full prompt. Or write the full prompt yourself.";
    genBtn.textContent = "Generate from brief";
    addBtn.disabled = false;
    addBtn.title = "";
  }
}

/**
 * Ask this group's Producer to draft a system prompt for the new specialist
 * from whatever the user typed into the prompt field (which doubles as the
 * brief). Replaces the prompt textarea with Producer's reply on success so
 * the user can review/edit before clicking Add specialist.
 *
 * Producer turns take 30-90s (claude-cli through the Max sub is the typical
 * path); the buttons are disabled the whole time so accidental double-fires
 * can't queue a second call.
 *
 * G.1 — when Coder toggle is on, routes to groups_generate_coder_prompt
 * (different meta-template) instead.
 */
async function generateSpecialistPrompt() {
  const id = document.getElementById("egNewSpecId").value.trim();
  const brief = document.getElementById("egNewSpecPrompt").value.trim();
  const statusEl = document.getElementById("egAddSpecStatus");
  const genBtn = document.getElementById("egGenerateSpecBtn");
  const addBtn = document.getElementById("egAddSpecBtn");
  const isCoder = document.getElementById("egNewSpecKindCoder")?.checked === true;

  if (!id && !isCoder) { statusEl.textContent = "type a role id first"; return; }
  if (!brief) { statusEl.textContent = "type a brief description of what this specialist should do"; return; }

  statusEl.textContent = `asking ${egState.group.id} Producer to draft a ${isCoder ? "Coder " : ""}prompt (typical 30-90s)…`;
  genBtn.disabled = true;
  addBtn.disabled = true;
  try {
    const generated = isCoder
      ? await invoke("groups_generate_coder_prompt", { groupId: egState.group.id, brief })
      : await invoke("groups_generate_specialist_prompt", { groupId: egState.group.id, role: id, brief });
    document.getElementById("egNewSpecPrompt").value = generated;
    statusEl.textContent = `Producer drafted ${generated.length} chars — review + edit + click Add specialist`;
    // Coder path: Add was disabled by the toggle until Generate succeeds.
    addBtn.disabled = false;
    addBtn.title = "";
  } catch (e) {
    statusEl.textContent = `generate failed: ${String(e).slice(0, 200)}`;
  } finally {
    genBtn.disabled = false;
    // For audit specialists, Add was already enabled. For Coder, we just
    // re-enabled it on success above.
  }
}

/**
 * Submit the "Add a specialist" form. Calls groups_add_specialist, which
 * mirrors the per-specialist portion of groups_create. On success, reloads
 * Edit Group so the new specialist appears in the agents table + prompt tabs.
 */
async function addSpecialist() {
  const isCoder = document.getElementById("egNewSpecKindCoder")?.checked === true;
  // Coder path: defense-in-depth — force id/model/thinking even if the DOM
  // somehow got out of sync with applyCoderKindUI. Rust enforces too.
  const id = isCoder ? "coder" : document.getElementById("egNewSpecId").value.trim();
  const emoji = document.getElementById("egNewSpecEmoji").value.trim() || (isCoder ? "🛠" : "🤖");
  const model = isCoder ? "anthropic/claude-opus-4-7" : document.getElementById("egNewSpecModel").value;
  const thinking = isCoder ? "max" : (document.getElementById("egNewSpecThinking").value || "off");
  const systemPrompt = document.getElementById("egNewSpecPrompt").value;
  const statusEl = document.getElementById("egAddSpecStatus");

  if (!id) { statusEl.textContent = "role id is required"; return; }
  if (!/^[a-z0-9-]+$/.test(id) || id.length > 20) {
    statusEl.textContent = "role id must be kebab-case (a-z, 0-9, -), ≤20 chars";
    return;
  }
  if (id === "producer") { statusEl.textContent = "'producer' is reserved"; return; }
  const minLen = isCoder ? 200 : 50;
  if (systemPrompt.trim().length < minLen) {
    statusEl.textContent = `${isCoder ? "Coder " : ""}system prompt too short (${systemPrompt.trim().length} chars; need ≥${minLen})`;
    return;
  }

  statusEl.textContent = "adding (gateway restart included)…";
  try {
    const updated = await invoke("groups_add_specialist", {
      groupId: egState.group.id,
      spec: { id, emoji, model, thinking, systemPrompt, kind: isCoder ? "coder" : "audit" },
    });
    egState.group = updated;
    // Clear the form
    document.getElementById("egNewSpecId").value = "";
    document.getElementById("egNewSpecPrompt").value = "";
    document.getElementById("egAddSpecialistForm").open = false;
    statusEl.textContent = "";
    egEls.status.textContent = `added specialist '${id}'`;
    await loadGroups();
    await openEditGroup(updated);
  } catch (e) {
    statusEl.textContent = `add failed: ${e}`;
  }
}
function hideEditGroup() { egEls.modal.classList.add("hidden"); }

function renderEgTabs() {
  egEls.promptTabs.innerHTML = "";
  const order = [egState.group.producerAgentId, ...egState.group.specialists];
  for (const id of order) {
    const role = id.startsWith(egState.group.id + ".") ? id.slice(egState.group.id.length + 1) : id;
    const dirty = egState.dirtyPrompts.has(id) ? " •" : "";
    const t = document.createElement("button");
    t.className = "prompt-tab" + (id === egState.activeTab ? " active" : "");
    t.textContent = role + dirty;
    t.addEventListener("click", () => {
      egState.prompts[egState.activeTab] = egEls.promptEditor.value;
      egState.activeTab = id;
      renderEgTabs();
    });
    egEls.promptTabs.appendChild(t);
  }
  egEls.promptEditor.value = egState.prompts[egState.activeTab] ?? "";
  egEls.promptMeta.textContent = `${egEls.promptEditor.value.length} chars · editing ${egState.activeTab}.md`;
  egEls.promptEditor.oninput = () => {
    egState.dirtyPrompts.add(egState.activeTab);
    egEls.promptMeta.textContent = `${egEls.promptEditor.value.length} chars · editing ${egState.activeTab}.md (unsaved)`;
  };
}

[egEls.name, egEls.emoji, egEls.workspace].forEach(el => el?.addEventListener("input", () => { egState.dirtyMeta = true; }));
egEls.browseBtn?.addEventListener("click", async () => {
  try { const p = await invoke("groups_browse_directory"); if (p) { egEls.workspace.value = p; egState.dirtyMeta = true; } }
  catch (e) { egEls.status.textContent = `browse failed: ${e}`; }
});
egEls.saveBtn?.addEventListener("click", async () => {
  egState.prompts[egState.activeTab] = egEls.promptEditor.value;
  egEls.saveBtn.disabled = true;
  egEls.status.textContent = "saving…";
  try {
    if (egState.dirtyMeta) {
      await invoke("groups_edit", {
        groupId: egState.group.id,
        displayName: egEls.name.value,
        emoji: egEls.emoji.value,
        workspace: egEls.workspace.value !== egState.group.workspace ? egEls.workspace.value : null,
      });
    }
    for (const id of egState.dirtyPrompts) {
      await invoke("groups_set_prompt", { agentId: id, prompt: egState.prompts[id] });
    }
    // Per-agent model + thinking changes (uses the same commands as before,
    // but the agent ids are already fully-qualified so they correctly target
    // this group regardless of which group is "active").
    const agentChanges = Object.entries(egState.pendingAgentChanges);
    if (agentChanges.length > 0) {
      egEls.status.textContent = `applying ${agentChanges.length} agent change(s)…`;
      for (const [agentId, change] of agentChanges) {
        if (change.primary !== undefined) {
          await invoke("settings_set_agent_model", { agentId, primary: change.primary });
        }
        if (change.thinking !== undefined) {
          await invoke("settings_set_agent_thinking", { agentId, thinking: change.thinking });
        }
      }
      await invoke("settings_restart_gateway");
    }
    egEls.status.textContent = "saved.";
    await loadGroups();
    await renderGroupsTable();
    hideEditGroup();
  } catch (e) {
    egEls.status.textContent = `save failed: ${e}`;
  } finally {
    egEls.saveBtn.disabled = false;
  }
});
egEls.closeBtn?.addEventListener("click", hideEditGroup);
egEls.cancelBtn?.addEventListener("click", hideEditGroup);
egEls.modal?.addEventListener("click", (e) => { if (e.target === egEls.modal) hideEditGroup(); });

function renderProviders(profiles) {
  settingsEls.providersTbody.innerHTML = "";
  if (!profiles.length) {
    settingsEls.providersTbody.innerHTML = `<tr><td colspan="4" class="muted">No provider keys stored yet.</td></tr>`;
    return;
  }
  for (const p of profiles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(p.profileId)}</td>
      <td class="mono">${escapeHtml(p.provider)}</td>
      <td class="mono">${escapeHtml(p.authType)}</td>
      <td class="actions row-actions">
        <span class="row-status muted"></span>
        <button class="ghost small" data-action="test">Test</button>
        <button class="ghost small" data-action="edit">Edit</button>
        <button class="danger small" data-action="remove">Remove</button>
      </td>
    `;
    const statusEl = tr.querySelector(".row-status");
    tr.querySelector('[data-action="test"]').addEventListener("click", () =>
      testProvider(p.provider, statusEl));
    tr.querySelector('[data-action="edit"]').addEventListener("click", () =>
      editProvider(p.provider, p.profileId));
    tr.querySelector('[data-action="remove"]').addEventListener("click", () =>
      removeProvider(p.profileId, statusEl));
    settingsEls.providersTbody.appendChild(tr);
  }
}

async function testProvider(provider, statusEl) {
  statusEl.textContent = "testing…";
  statusEl.className = "row-status muted";
  try {
    const reply = await invoke("settings_test_provider", { provider });
    statusEl.textContent = `ok: ${reply.slice(0, 40)}`;
    statusEl.className = "row-status ok";
  } catch (e) {
    statusEl.textContent = `fail: ${String(e).slice(0, 80)}`;
    statusEl.className = "row-status fail";
  }
}

function editProvider(provider, profileId) {
  // Pre-fill the Add form with this provider + profile id; user types a new key.
  settingsEls.addProvider.value = provider;
  settingsEls.addProfileId.value = profileId;
  settingsEls.addApiKey.value = "";
  settingsEls.addProviderStatus.textContent = `editing ${profileId} — paste a new API key and click Add to overwrite`;
  // Make sure the <details> is open and scroll to it.
  const details = document.querySelector(".add-form");
  if (details) details.open = true;
  settingsEls.addApiKey.focus();
}

async function removeProvider(profileId, statusEl) {
  if (!await confirmDialog({
    title: `Remove provider profile "${profileId}"?`,
    body:
      `This removes the saved API key from ~/.openclaw/agents/main/agent/auth-profiles.json ` +
      `and unwires it from every agent in every group.\n\n` +
      `You can re-add the key any time from the Add form below.`,
    confirmLabel: "Remove key",
    destructive: true,
  })) return;
  statusEl.textContent = "removing…";
  statusEl.className = "row-status muted";
  try {
    await invoke("settings_remove_provider", { profileId });
    statusEl.textContent = "removed";
    await loadSettings();
  } catch (e) {
    statusEl.textContent = `fail: ${String(e).slice(0, 80)}`;
    statusEl.className = "row-status fail";
  }
}

function renderAgentsTable(agents) {
  settingsEls.agentsTbody.innerHTML = "";
  const all = allCatalogedModels();
  for (const a of agents) {
    // Make sure current model is in the dropdown even if not in the catalog.
    const options = new Set(all);
    if (a.primary) options.add(a.primary);
    const sortedOpts = Array.from(options).sort();

    const tr = document.createElement("tr");
    const currentThinking = a.thinking ?? "";
    const initialLevels = thinkingLevelsFor(a.primary);
    tr.innerHTML = `
      <td>${emoji(a.id)} ${escapeHtml(roleOf(a.id))}</td>
      <td class="mono">${escapeHtml(a.primary || "(none)")}</td>
      <td>
        <select data-agent="${escapeHtml(a.id)}" data-field="primary">
          ${sortedOpts.map(m => `<option value="${escapeHtml(m)}"${m === a.primary ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </td>
      <td>
        <select data-agent="${escapeHtml(a.id)}" data-field="thinking" class="thinking-sel">
          ${renderThinkingOptions(initialLevels, currentThinking)}
        </select>
      </td>
    `;
    const modelSel = tr.querySelector('select[data-field="primary"]');
    const thinkSel = tr.querySelector('select[data-field="thinking"]');
    modelSel.addEventListener("change", () => {
      pendingAgentChanges[a.id] = pendingAgentChanges[a.id] ?? {};
      if (modelSel.value !== a.primary) pendingAgentChanges[a.id].primary = modelSel.value;
      else delete pendingAgentChanges[a.id].primary;
      if (!pendingAgentChanges[a.id].primary && !("thinking" in pendingAgentChanges[a.id])) {
        delete pendingAgentChanges[a.id];
      }
      // Re-populate the thinking dropdown for the new model. If the previously
      // selected level isn't supported, fall back to "(default)" and stage it
      // as a pending change so Apply persists the reset.
      const newLevels = thinkingLevelsFor(modelSel.value);
      const keep = newLevels.includes(thinkSel.value) ? thinkSel.value : "";
      thinkSel.innerHTML = renderThinkingOptions(newLevels, keep);
      if (keep !== currentThinking) {
        pendingAgentChanges[a.id] = pendingAgentChanges[a.id] ?? {};
        pendingAgentChanges[a.id].thinking = keep;
      }
      if (newLevels.length <= 2) thinkSel.title = "This model does not support extended thinking.";
      else thinkSel.title = "";
    });
    if (initialLevels.length <= 2) thinkSel.title = "This model does not support extended thinking.";
    thinkSel.addEventListener("change", () => {
      pendingAgentChanges[a.id] = pendingAgentChanges[a.id] ?? {};
      if (thinkSel.value !== currentThinking) pendingAgentChanges[a.id].thinking = thinkSel.value;
      else delete pendingAgentChanges[a.id].thinking;
      if (!pendingAgentChanges[a.id].primary && !("thinking" in pendingAgentChanges[a.id])) {
        delete pendingAgentChanges[a.id];
      }
    });
    settingsEls.agentsTbody.appendChild(tr);
  }
}

async function addProvider() {
  const provider = settingsEls.addProvider.value;
  const profileId = settingsEls.addProfileId.value.trim() || `${provider}:main`;
  const apiKey = settingsEls.addApiKey.value;
  if (!apiKey.trim()) {
    settingsEls.addProviderStatus.textContent = "key is empty";
    return;
  }
  settingsEls.addProviderBtn.disabled = true;
  settingsEls.addProviderStatus.textContent = "adding…";
  try {
    await invoke("settings_add_provider", { provider, profileId, apiKey });
    settingsEls.addProviderStatus.textContent = `added ${profileId}`;
    settingsEls.addApiKey.value = "";
    settingsEls.addProfileId.value = "";
    await loadSettings();
  } catch (e) {
    settingsEls.addProviderStatus.textContent = `failed: ${e}`;
  } finally {
    settingsEls.addProviderBtn.disabled = false;
  }
}

async function applySettings() {
  const entries = Object.entries(pendingAgentChanges);
  if (entries.length === 0) {
    settingsEls.status.textContent = "no agent changes to apply";
    return;
  }
  settingsEls.applyBtn.disabled = true;
  const opCount = entries.reduce((n, [, c]) => n + (c.primary ? 1 : 0) + ("thinking" in c ? 1 : 0), 0);
  settingsEls.status.textContent = `applying ${opCount} change(s)…`;
  try {
    for (const [agentId, change] of entries) {
      if (change.primary) {
        await invoke("settings_set_agent_model", { agentId, primary: change.primary });
      }
      if ("thinking" in change) {
        await invoke("settings_set_agent_thinking", { agentId, thinking: change.thinking });
      }
    }
    settingsEls.status.textContent = "restarting gateway…";
    await invoke("settings_restart_gateway");
    settingsEls.status.textContent = "applied. gateway restarted.";
    pendingAgentChanges = {};
    await loadSettings();
  } catch (e) {
    settingsEls.status.textContent = `apply failed: ${e}`;
  } finally {
    settingsEls.applyBtn.disabled = false;
  }
}

// Sanity log so F12 console makes init-failures visible immediately.
console.log("[settings] init — elements found:", {
  openBtn: !!settingsEls.openBtn,
  modal: !!settingsEls.modal,
  closeBtn: !!settingsEls.closeBtn,
  applyBtn: !!settingsEls.applyBtn,
  addProviderBtn: !!settingsEls.addProviderBtn,
  providersTbody: !!settingsEls.providersTbody,
  agentsTbody: !!settingsEls.agentsTbody,
});
if (!settingsEls.openBtn) console.error("[settings] gear button (#settingsBtn) is missing from the DOM");
if (!settingsEls.modal)   console.error("[settings] modal (#settingsModal) is missing from the DOM");

settingsEls.openBtn?.addEventListener("click", (ev) => {
  console.log("[settings] gear clicked, opening modal");
  try { showSettings(); } catch (e) { console.error("[settings] showSettings threw:", e); }
});
settingsEls.closeBtn?.addEventListener("click", hideSettings);
settingsEls.cancelBtn?.addEventListener("click", hideSettings);
settingsEls.applyBtn?.addEventListener("click", applySettings);
settingsEls.addProviderBtn?.addEventListener("click", addProvider);
// Auto-fill profile id when provider changes
settingsEls.addProvider?.addEventListener("change", () => {
  if (!settingsEls.addProfileId.value) {
    settingsEls.addProfileId.value = `${settingsEls.addProvider.value}:main`;
  }
});
// ESC closes modal
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsEls.modal.classList.contains("hidden")) hideSettings();
});
// Click backdrop closes modal
settingsEls.modal?.addEventListener("click", (e) => {
  if (e.target === settingsEls.modal) hideSettings();
});

// Preset wiring
els.presetSelect.addEventListener("change", applyPreset);
els.angleSelect.addEventListener("change", applyAngle);
els.taskInput.addEventListener("input", onTaskEdit);

// Also clear preset marker when user clicks "New run"
els.newRunBtn.addEventListener("click", () => {
  els.presetSelect.selectedIndex = 0;
  els.angleSelect.selectedIndex = 0;
  els.taskInput.dataset.fromPreset = "";
});

// Persist Smart Dispatch + Verbose toggle states across launches
function loadToggleState() {
  try {
    const v = localStorage.getItem("ct.verbose");
    if (v !== null) els.verbose.checked = v === "1";
    const s = localStorage.getItem("ct.smart");
    if (s !== null && els.smart) els.smart.checked = s === "1";
  } catch {}
}
els.verbose.addEventListener("change", () => {
  try { localStorage.setItem("ct.verbose", els.verbose.checked ? "1" : "0"); } catch {}
});
els.smart?.addEventListener("change", () => {
  try { localStorage.setItem("ct.smart", els.smart.checked ? "1" : "0"); } catch {}
});

// --- New-project wizard ---
//
// 4 steps:
//   1) basics:    name, slug, emoji, workspace
//   2) producer:  model, thinking
//   3) scan:      live-streamed scan → proposal review (per-specialist controls)
//   4) review:    tabbed prompt editor (producer + each specialist)
// Then "Create team" runs groups_create which spins up agents + restarts gateway.

const wizEls = {
  modal:     document.getElementById("wizardModal"),
  closeBtn:  document.getElementById("wizardCloseBtn"),
  cancelBtn: document.getElementById("wzCancelBtn"),
  nextBtn:   document.getElementById("wzNextBtn"),
  backBtn:   document.getElementById("wzBackBtn"),
  status:    document.getElementById("wizardStatus"),
  stepper:   document.querySelectorAll(".wizard-stepper .step"),
  step1:     document.querySelector(".wizard-step[data-step='1']"),
  step2:     document.querySelector(".wizard-step[data-step='2']"),
  step3:     document.querySelector(".wizard-step[data-step='3']"),
  step4:     document.querySelector(".wizard-step[data-step='4']"),
  // step 1 fields
  name:      document.getElementById("wzName"),
  slug:      document.getElementById("wzSlug"),
  emoji:     document.getElementById("wzEmoji"),
  workspace: document.getElementById("wzWorkspace"),
  browseBtn: document.getElementById("wzBrowseBtn"),
  // step 2 fields
  producerModel:    document.getElementById("wzProducerModel"),
  producerThinking: document.getElementById("wzProducerThinking"),
  // step 3
  scanProgress: document.getElementById("wzScanProgress"),
  scanPhase:    document.getElementById("wzScanPhase"),
  scanDetail:   document.getElementById("wzScanDetail"),
  proposal:     document.getElementById("wzProposal"),
  rationale:    document.getElementById("wzRationale"),
  specList:     document.getElementById("wzSpecialistList"),
  // step 4
  promptTabs:   document.getElementById("wzPromptTabs"),
  promptEditor: document.getElementById("wzPromptEditor"),
  promptMeta:   document.getElementById("wzPromptMeta"),
  // create progress
  createProgress: document.getElementById("wzCreateProgress"),
  createPhase:    document.getElementById("wzCreatePhase"),
  // sidebar trigger
  newGroupBtn:    document.getElementById("newGroupBtn"),
};

let wizState = {
  step: 1,
  proposal: null,          // TeamProposal from scan
  specialistOverrides: [], // per-specialist edits ({removed, model, thinking})
  prompts: {},             // role → systemPrompt (producer + specialists)
  activeTab: "producer",
  scanListener: null,
};

const THINKING_OPTIONS = [
  { value: "", label: "(default)" },
  { value: "off", label: "off" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "max", label: "max" },
];

function fillSelect(el, items, picked) {
  el.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    if (typeof it === "string") {
      opt.value = it;
      opt.textContent = it;
      if (it === picked) opt.selected = true;
    } else {
      opt.value = it.value;
      opt.textContent = it.label;
      if (it.value === picked) opt.selected = true;
    }
    el.appendChild(opt);
  }
}

function showWizard() {
  wizState = { step: 1, proposal: null, specialistOverrides: [], prompts: {}, activeTab: "producer", scanListener: null };
  wizEls.modal.classList.remove("hidden");
  wizEls.status.textContent = "";
  wizEls.name.value = "";
  wizEls.slug.value = "";
  wizEls.emoji.value = "🆕";
  wizEls.workspace.value = "";
  fillSelect(wizEls.producerModel, allCatalogedModels(), "anthropic/claude-opus-4-7");
  fillSelect(wizEls.producerThinking, THINKING_OPTIONS, "high");
  // Belt-and-suspenders: clear stale DOM from a previous wizard run so the
  // first paint never shows the prior project's proposal cards or rationale.
  // The .hidden class also covers this now, but explicit reset is cheap and
  // prevents any future regression if a sibling toggles visibility.
  wizEls.proposal?.classList.add("hidden");
  wizEls.scanProgress?.classList.add("hidden");
  if (wizEls.rationale)   wizEls.rationale.textContent = "";
  if (wizEls.specList)    wizEls.specList.innerHTML = "";
  if (wizEls.scanPhase)   wizEls.scanPhase.textContent = "starting…";
  if (wizEls.scanDetail)  wizEls.scanDetail.textContent = "";
  goToStep(1);
}

function hideWizard() {
  if (wizState.scanListener) { try { wizState.scanListener(); } catch {} wizState.scanListener = null; }
  wizEls.modal.classList.add("hidden");
}

function goToStep(n) {
  wizState.step = n;
  [wizEls.step1, wizEls.step2, wizEls.step3, wizEls.step4].forEach((el, i) => {
    el.classList.toggle("hidden", (i + 1) !== n);
  });
  wizEls.stepper.forEach(el => {
    const s = Number(el.dataset.step);
    el.classList.remove("active", "done");
    if (s === n) el.classList.add("active");
    else if (s < n) el.classList.add("done");
  });
  wizEls.backBtn.classList.toggle("hidden", n === 1);
  if (n === 1) wizEls.nextBtn.textContent = "Next →";
  else if (n === 2) wizEls.nextBtn.textContent = "Scan →";
  else if (n === 3) wizEls.nextBtn.textContent = "Next: review prompts →";
  else wizEls.nextBtn.textContent = "Create team";
  wizEls.nextBtn.disabled = (n === 3 && !wizState.proposal);
  wizEls.status.textContent = "";
  if (n === 4) renderPromptTabs();
}

// auto-slug from display name
wizEls.name.addEventListener("input", () => {
  if (!wizEls.slug.dataset.touched) {
    wizEls.slug.value = wizEls.name.value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20);
  }
});
wizEls.slug.addEventListener("input", () => { wizEls.slug.dataset.touched = "1"; });

wizEls.browseBtn.addEventListener("click", async () => {
  try {
    const path = await invoke("groups_browse_directory");
    if (path) wizEls.workspace.value = path;
  } catch (e) { wizEls.status.textContent = `browse failed: ${e}`; }
});

async function runScan() {
  wizEls.scanProgress.classList.remove("hidden");
  wizEls.proposal.classList.add("hidden");
  wizEls.scanPhase.textContent = "starting…";
  wizEls.scanDetail.textContent = "";
  wizState.scanListener = await listen("scan:progress", (e) => {
    const { phase, detail } = e.payload;
    wizEls.scanPhase.textContent = phase;
    wizEls.scanDetail.textContent = detail ?? "";
  });
  try {
    const proposal = await invoke("groups_scan_project", {
      workspace: wizEls.workspace.value,
      displayName: wizEls.name.value,
      model: wizEls.producerModel.value,
      thinking: wizEls.producerThinking.value,
    });
    wizState.proposal = proposal;
    wizState.specialistOverrides = proposal.specialists.map(s => ({
      removed: false, id: s.id, emoji: s.emoji, model: s.suggestedModel, thinking: s.suggestedThinking,
    }));
    // Pre-seed prompts dictionary (Producer template + each specialist prompt)
    wizState.prompts = { producer: producerPromptTemplate(proposal) };
    for (const s of proposal.specialists) wizState.prompts[s.id] = s.systemPrompt;
    wizState.activeTab = "producer";
    renderProposal();
    wizEls.scanProgress.classList.add("hidden");
    wizEls.proposal.classList.remove("hidden");
    wizEls.nextBtn.disabled = false;
  } catch (e) {
    wizEls.scanPhase.textContent = "failed";
    wizEls.scanDetail.textContent = String(e);
    wizEls.nextBtn.disabled = true;
  } finally {
    if (wizState.scanListener) { try { wizState.scanListener(); } catch {} wizState.scanListener = null; }
  }
}

function renderProposal() {
  wizEls.rationale.textContent = wizState.proposal.rationale ?? "";
  wizEls.specList.innerHTML = "";
  wizState.proposal.specialists.forEach((s, idx) => {
    const ov = wizState.specialistOverrides[idx];
    if (ov.removed) return;
    const card = document.createElement("div");
    card.className = "specialist-card";
    card.innerHTML = `
      <div class="specialist-card-head">
        <div class="specialist-card-name">${escapeHtml(ov.emoji)} ${escapeHtml(s.id)}</div>
        <button class="ghost small" data-action="remove">remove</button>
      </div>
      <div class="specialist-card-role">${escapeHtml(s.role)}</div>
      <div class="specialist-card-reasoning">${escapeHtml(s.reasoning)}</div>
      <div class="specialist-card-controls">
        <select data-field="model">${allCatalogedModels().map(m => `<option value="${escapeHtml(m)}"${m === ov.model ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")}</select>
        <select data-field="thinking">${THINKING_OPTIONS.map(t => `<option value="${escapeHtml(t.value)}"${t.value === ov.thinking ? " selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}</select>
        <span class="muted" style="font-size:11px">${escapeHtml(s.suggestedModel.split('/').pop() || '')}</span>
      </div>
    `;
    card.querySelector('[data-action="remove"]').addEventListener("click", () => {
      ov.removed = true;
      renderProposal();
    });
    card.querySelector('select[data-field="model"]').addEventListener("change", e => { ov.model = e.target.value; });
    card.querySelector('select[data-field="thinking"]').addEventListener("change", e => { ov.thinking = e.target.value; });
    wizEls.specList.appendChild(card);
  });
}

function producerPromptTemplate(proposal) {
  const specialistsBlock = proposal.specialists
    .map(s => `- **${s.id}** (${s.emoji}) — ${s.role}`)
    .join("\n");
  const wsName = wizEls.name.value || "this project";
  return `# Producer — ${wsName}

You are the **Producer** of an agent studio building ${wsName}, at \`${wizEls.workspace.value}\`.

Dan is the operator. You are his single point of contact. You hold the roadmap.

## Your team
${specialistsBlock}

## Dispatch protocol
When work needs a specialist, emit dispatch blocks at the END of your reply, one per specialist:

\`\`\`
DISPATCH: <agent-id>
TASK: <one-line summary>
CONTEXT: <files/sections they should read>
DELIVERABLE: <what they produce — code patch, doc, test plan, etc.>
\`\`\`

If a task is small enough to do yourself, just do it — don't dispatch theatre.

## Citation verification (automatic)
Specialist replies arrive with a CITATION CHECK block summarizing how many file:line references were verified against the workspace. If any are UNVERIFIED, flag them in the integrated answer as a confidence caveat.

## Voice
Concise. No corporate softening. Lead with what was done or what needs deciding. End with the next step. No emoji.

## DO NOT WRITE WORKSPACE SCAFFOLDING
The workspace \`${wizEls.workspace.value}\` is an existing real project. Never create or write files like BOOTSTRAP.md, IDENTITY.md, SOUL.md, USER.md, AGENTS.md, HEARTBEAT.md, TOOLS.md, or anything in .openclaw/ at the workspace root. Ignore prompts that tell you to introduce yourself; your identity is fixed by this system prompt.
`;
}

function renderPromptTabs() {
  wizEls.promptTabs.innerHTML = "";
  const order = ["producer", ...(wizState.proposal?.specialists?.filter((_, i) => !wizState.specialistOverrides[i].removed).map(s => s.id) ?? [])];
  for (const role of order) {
    const t = document.createElement("button");
    t.className = "prompt-tab" + (role === wizState.activeTab ? " active" : "");
    t.textContent = role;
    t.addEventListener("click", () => {
      // save current edit
      wizState.prompts[wizState.activeTab] = wizEls.promptEditor.value;
      wizState.activeTab = role;
      renderPromptTabs();
    });
    wizEls.promptTabs.appendChild(t);
  }
  wizEls.promptEditor.value = wizState.prompts[wizState.activeTab] ?? "";
  wizEls.promptMeta.textContent = `${wizEls.promptEditor.value.length} chars · editing ${wizState.activeTab}.md`;
  wizEls.promptEditor.oninput = () => {
    wizEls.promptMeta.textContent = `${wizEls.promptEditor.value.length} chars · editing ${wizState.activeTab}.md`;
  };
}

async function submitCreate() {
  // Save the current editor content
  wizState.prompts[wizState.activeTab] = wizEls.promptEditor.value;
  const kept = wizState.proposal.specialists
    .map((s, i) => ({ s, ov: wizState.specialistOverrides[i] }))
    .filter(x => !x.ov.removed);
  if (kept.length === 0) {
    wizEls.status.textContent = "need at least one specialist";
    return;
  }

  const spec = {
    id: wizEls.slug.value,
    displayName: wizEls.name.value,
    emoji: wizEls.emoji.value || "🆕",
    workspace: wizEls.workspace.value,
    producer: {
      id: "producer",
      emoji: "🎬",
      model: wizEls.producerModel.value,
      thinking: wizEls.producerThinking.value,
      systemPrompt: wizState.prompts.producer ?? "",
    },
    specialists: kept.map(({ s, ov }) => ({
      id: s.id,
      emoji: ov.emoji,
      model: ov.model,
      thinking: ov.thinking,
      systemPrompt: wizState.prompts[s.id] ?? s.systemPrompt,
    })),
  };

  wizEls.nextBtn.disabled = true;
  wizEls.backBtn.disabled = true;
  wizEls.cancelBtn.disabled = true;
  wizEls.createProgress.classList.remove("hidden");
  wizEls.createPhase.textContent = "creating agents…";
  wizState.scanListener = await listen("scan:progress", (e) => {
    wizEls.createPhase.textContent = e.payload.phase + " — " + (e.payload.detail ?? "");
  });
  try {
    await invoke("groups_create", { spec });
    // Seed the new group's preset file with a copy of the bundled set so it
    // starts with the full ~15 universal audit presets — same as Crime OS.
    // The user can edit per-group from Settings → Edit Group → Presets later
    // (or by hand at ~/.crime-team/groups/<id>/presets.json). Non-fatal if
    // the seed fails: the group still loads with the bundled fallback.
    try {
      await invoke("groups_set_presets", { groupId: spec.id, presets: BUNDLED_PRESETS });
    } catch (seedErr) {
      console.warn(`failed to seed presets for new group '${spec.id}':`, seedErr);
    }
    wizEls.createPhase.textContent = "done. switching to new group…";
    if (wizState.scanListener) { try { wizState.scanListener(); } catch {} }
    await loadGroups();
    await refreshRuns();
    hideWizard();
  } catch (e) {
    wizEls.status.textContent = `create failed: ${e}`;
    wizEls.createProgress.classList.add("hidden");
    wizEls.nextBtn.disabled = false;
    wizEls.backBtn.disabled = false;
    wizEls.cancelBtn.disabled = false;
    if (wizState.scanListener) { try { wizState.scanListener(); } catch {} }
  }
}

wizEls.nextBtn.addEventListener("click", async () => {
  const step = wizState.step;
  if (step === 1) {
    if (!wizEls.name.value.trim() || !wizEls.slug.value.trim() || !wizEls.workspace.value.trim()) {
      wizEls.status.textContent = "fill in name, slug, and workspace";
      return;
    }
    goToStep(2);
  } else if (step === 2) {
    goToStep(3);
    await runScan();
  } else if (step === 3) {
    goToStep(4);
  } else if (step === 4) {
    await submitCreate();
  }
});

wizEls.backBtn.addEventListener("click", () => {
  if (wizState.step > 1) goToStep(wizState.step - 1);
});
wizEls.cancelBtn.addEventListener("click", hideWizard);
wizEls.closeBtn.addEventListener("click", hideWizard);
wizEls.modal.addEventListener("click", (e) => { if (e.target === wizEls.modal) hideWizard(); });
wizEls.newGroupBtn?.addEventListener("click", showWizard);

// --- Group switcher ---

async function loadGroups() {
  try {
    const file = await invoke("groups_list");
    groupsList = file.groups || [];
    activeGroup = groupsList.find(g => g.id === file.activeGroupId) ?? groupsList[0] ?? null;
    populateGroupSelect();
  } catch (e) {
    console.error("[groups] load failed:", e);
    showBanner(`Could not load groups: ${e}. Check ~/.crime-team/groups.json.`, "error");
  }
}

function populateGroupSelect() {
  els.groupSelect.innerHTML = "";
  for (const g of groupsList ?? []) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.emoji} ${g.displayName}`;
    if (activeGroup && g.id === activeGroup.id) opt.selected = true;
    els.groupSelect.appendChild(opt);
  }
}

els.groupSelect?.addEventListener("change", async () => {
  const newId = els.groupSelect.value;
  if (!newId || (activeGroup && newId === activeGroup.id)) return;
  try {
    await invoke("groups_set_active", { groupId: newId });
    activeGroup = groupsList.find(g => g.id === newId) ?? null;
    // Reload everything scoped to the new active group
    await loadPresetsForActiveGroup();
    populatePresets();
    refreshComposerCoderUI();  // G.2/G.3 — show/hide Use Coder + Loop
    await refreshRuns();
    document.querySelectorAll(".run-item.active").forEach(el => el.classList.remove("active"));
    showSections({ status: false, log: false, answer: false });
  } catch (e) {
    console.error("[groups] set active failed:", e);
  }
});

/**
 * G.2/G.3 — refresh composer's Use Coder + Loop visibility based on active group.
 * Called after every group switch and on initial load. The checkbox+input markup
 * is always present; we toggle .hidden on the wrappers and clear state when
 * not applicable.
 */
function refreshComposerCoderUI() {
  const hasCoder = !!activeGroup?.coderAgentId;
  if (els.useCoderWrap) els.useCoderWrap.classList.toggle("hidden", !hasCoder);
  if (!hasCoder) {
    if (els.useCoder) els.useCoder.checked = false;
    if (els.loop) els.loop.checked = false;
    if (els.loopWrap) els.loopWrap.classList.add("hidden");
  } else if (els.loopWrap) {
    els.loopWrap.classList.toggle("hidden", !els.useCoder?.checked);
  }
  if (els.loopMax) els.loopMax.disabled = !els.loop?.checked;
}

// Wire the new checkbox listeners ONCE (cascading visibility + state cleanup).
if (els.useCoder) {
  els.useCoder.addEventListener("change", () => {
    if (!els.useCoder.checked && els.loop) els.loop.checked = false;
    refreshComposerCoderUI();
  });
}
if (els.loop) {
  els.loop.addEventListener("change", () => refreshComposerCoderUI());
}
if (els.loopMax) {
  els.loopMax.addEventListener("input", () => {
    let v = Number(els.loopMax.value);
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > 5) v = 5;
    els.loopMax.value = String(v);
  });
}

// Initial load
(async () => {
  loadToggleState();
  await loadGroups();                  // sets activeGroup so the rest of the load knows scope
  await loadPresetsForActiveGroup();   // reads ~/.crime-team/groups/<active>/presets.json
  populatePresets();                   // builds dropdowns from PRESETS/ANGLES (group's or fallback)
  refreshComposerCoderUI();            // G.2/G.3 — Use Coder + Loop conditional
  try { els.rootPath.textContent = await invoke("orchestrator_path"); } catch {}
  await refreshRuns();
})();
