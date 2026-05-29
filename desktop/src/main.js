// Frontend entry. Talks to Tauri via window.__TAURI__.{core,event}.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { PRESETS, ANGLES } from "./presets.js";

const els = {
  taskInput:   document.getElementById("taskInput"),
  verbose:     document.getElementById("verboseInput"),
  smart:       document.getElementById("smartDispatchInput"),
  timeout:     document.getElementById("timeoutInput"),
  runBtn:      document.getElementById("runBtn"),
  cancelBtn:   document.getElementById("cancelBtn"),
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
  agents:      document.getElementById("agents"),
  runsList:    document.getElementById("runsList"),
  rootPath:    document.getElementById("rootPath"),
  groupSelect: document.getElementById("groupSelect"),
  presetSelect:document.getElementById("presetSelect"),
  angleSelect: document.getElementById("angleSelect"),
};

// --- preset dropdown population + wiring ---
function populatePresets() {
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

function applyPreset() {
  const sel = els.presetSelect.selectedOptions[0];
  if (!sel || !sel.dataset.prompt) return;
  const angleOpt = els.angleSelect.selectedOptions[0];
  const suffix = angleOpt?.dataset?.suffix ?? "";
  // If textarea has unsaved user edits (non-empty + not from a previous preset),
  // confirm before overwriting. Otherwise just set it.
  const current = els.taskInput.value.trim();
  const overwrite = !current || els.taskInput.dataset.fromPreset === "1"
    || confirm("Replace the current task with the preset?");
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
let collectingAnswer = false;
let answerBuf = "";

const PHASE_RE = /^\[phase\]\s*(.+)$/;
const INFO_RE  = /^\[(info|ok|warn|error|trace)\s*\]\s*(.+)$/;
const RUNID_RE = /^\[info\s*\]\s*runId=(\S+)/;
const SPIN_START_RE = /^\s*·\s+(.+?)$/;
const SPIN_OK_RE    = /^\s*ok:\s*(.+?)\s*\((\d+(?:\.\d+)?)s\)\s*$/;
const SPIN_FAIL_RE  = /^\s*FAIL:\s*(.+?)\s*\((\d+(?:\.\d+)?)s\)\s*$/;
const SPIN_TTY_RE   = /^\s*[✓✗]\s+(.+?)\s*\((\d+(?:\.\d+)?)s\)/;
const SPECIALISTS_RE= /Producer wants \d+ specialist\(s\):\s*(.+)$/;
const AGENT_FROM_LABEL_RE = /^(producer|architect|frontend|art-director|qa|security)(?:\s|:|$)/;
const ANSWER_HEADER = "PRODUCER'S INTEGRATED ANSWER";
const ANSWER_SEP    = "========================================================================";
const DONE_RE       = /done\. runId=\S+\. total\s+([\d.]+)s/;

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

function setRunIdLabel(id) {
  els.runIdLbl.textContent = id ? `runId ${id}` : "";
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

function emoji(agent) {
  const role = roleOf(agent);
  return {
    producer: "🎬", architect: "🏛️", frontend: "🎨", "art-director": "🖼️", qa: "🔍", security: "🔐",
  }[role] ?? "🤖";
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
    card.className = `agent-card ${a.status === "ok" ? "ok" : a.status === "fail" ? "fail" : a.status === "running" ? "running" : ""}`;
    const dot = a.status === "running" ? '<span class="spinner"></span>'
              : a.status === "ok"      ? '<span class="dot-ok"></span>'
              : a.status === "fail"    ? '<span class="dot-fail"></span>'
              :                          '<span class="dot-wait"></span>';
    card.innerHTML = `
      <div class="agent-card-name">${dot}<span>${emoji(a.name)} ${a.name}</span></div>
      <div class="agent-card-task">${escapeHtml(a.label || "waiting…")}</div>
      <div class="agent-card-meta">
        <span>${a.status}</span>
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

function parseLine(rawLine) {
  const line = strip(rawLine);

  // capture runId
  const ridM = line.match(RUNID_RE);
  if (ridM) { setRunIdLabel(ridM[1]); }

  // phases
  const phaseM = line.match(PHASE_RE);
  if (phaseM) setPhase(phaseM[1].trim());

  // "Producer wants N specialist(s): a, b"
  const specs = line.match(SPECIALISTS_RE);
  if (specs) {
    for (const s of specs[1].split(",")) {
      ensureAgentCard(s.trim());
    }
  }

  // spinner start (non-TTY format: "  · <label>")
  const startM = line.match(SPIN_START_RE);
  if (startM) {
    const label = startM[1];
    const a = label.match(AGENT_FROM_LABEL_RE);
    if (a) setAgent(a[1], { status: "running", label });
  }

  // spinner OK (non-TTY: "  ok: <label> (Ns)")
  const okM = line.match(SPIN_OK_RE) || line.match(SPIN_TTY_RE);
  if (okM && line.includes("ok")) {
    const label = okM[1];
    const elapsed = parseFloat(okM[2]);
    const a = label.match(AGENT_FROM_LABEL_RE);
    if (a) setAgent(a[1], { status: "ok", label, elapsed });
  }
  const failM = line.match(SPIN_FAIL_RE);
  if (failM) {
    const label = failM[1];
    const elapsed = parseFloat(failM[2]);
    const a = label.match(AGENT_FROM_LABEL_RE);
    if (a) setAgent(a[1], { status: "fail", label, elapsed });
  }

  // answer header detection — start collecting after the second "===" separator
  if (collectingAnswer) {
    if (line.startsWith("[ ok  ] done.")) {
      collectingAnswer = false;
      activeRun.answer = answerBuf.trim();
      els.answerBody.textContent = activeRun.answer;
      showSections({ status: true, log: true, answer: true });
    } else if (!line.startsWith(ANSWER_SEP)) {
      answerBuf += rawLine + "\n";
    }
  } else if (line.includes(ANSWER_HEADER)) {
    collectingAnswer = true;
    answerBuf = "";
  }

  appendLogLine(rawLine);
}

// --- run lifecycle ---

async function startRun() {
  const task = els.taskInput.value.trim();
  if (!task) { els.taskInput.focus(); return; }

  activeRun = { id: null, startedAt: new Date().toISOString(), agents: new Map(), log: [], answer: null };
  collectingAnswer = false;
  answerBuf = "";

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

  try {
    await invoke("run_task", {
      task,
      verbose: els.verbose.checked,
      smartDispatch: els.smart?.checked === true,
      timeoutSec: Number(els.timeout.value) || 1800,
    });
  } catch (e) {
    appendLogLine(`[error] failed to start: ${e}`);
    finishRun(null);
  }
}

async function cancelRun() {
  try {
    await invoke("cancel_run");
    appendLogLine("[warn ] cancel requested");
  } catch (e) {
    appendLogLine(`[error] cancel failed: ${e}`);
  }
}

function finishRun(exitCode) {
  stopElapsedTimer();
  els.runBtn.disabled = false;
  els.cancelBtn.disabled = true;
  els.taskInput.disabled = false;
  if (exitCode != null) {
    appendLogLine(`[info ] process exited code=${exitCode}`);
  }
  setPhase(exitCode === 0 ? "done" : exitCode == null ? "stopped" : `exit ${exitCode}`);
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
    setRunIdLabel(r.runId);
    setPhase(r.finalAnswer ? "done" : "incomplete");
    els.elapsedLbl.textContent = "";
    els.logPre.innerHTML = "";
    els.agents.innerHTML = "";
    els.taskInput.value = r.task ?? "";

    // Re-create cards from saved specialistResults
    for (const s of r.specialistResults ?? []) {
      ensureAgentCard(s.agent);
      setAgent(s.agent, { status: s.ok ? "ok" : "fail", label: s.reply.slice(0, 120), elapsed: null });
    }

    if (r.finalAnswer) {
      els.answerBody.textContent = r.finalAnswer;
      showSections({ status: true, log: false, answer: true });
    } else {
      showSections({ status: true, log: false, answer: false });
    }
  } catch (e) {
    appendLogLine(`[error] could not load ${runId}: ${e}`);
  }
}

// --- events ---

els.runBtn.addEventListener("click", startRun);
els.cancelBtn.addEventListener("click", cancelRun);
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

await listen("orchestrator:line", e => {
  const { line } = e.payload;
  parseLine(line);
});

await listen("orchestrator:done", e => {
  finishRun(e.payload.exitCode);
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
const THINKING_LABEL = { "": "(default)", "": "(default)" };

function thinkingLevelsFor(modelId) {
  const m = (modelId || "").toLowerCase();
  const FULL = ["", "off", "low", "medium", "high", "max"];
  const NONE = ["", "off"];

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
    renderAgentsTable(snap.agents);
    settingsEls.status.textContent = "";
  } catch (e) {
    settingsEls.status.textContent = `load failed: ${e}`;
  }
}

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
  if (!confirm(`Remove provider profile "${profileId}" from all agents? You can re-add the key later.`)) return;
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

// --- Group switcher ---

async function loadGroups() {
  try {
    const file = await invoke("groups_list");
    groupsList = file.groups || [];
    activeGroup = groupsList.find(g => g.id === file.activeGroupId) ?? groupsList[0] ?? null;
    populateGroupSelect();
  } catch (e) {
    console.error("[groups] load failed:", e);
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
    await refreshRuns();
    document.querySelectorAll(".run-item.active").forEach(el => el.classList.remove("active"));
    showSections({ status: false, log: false, answer: false });
  } catch (e) {
    console.error("[groups] set active failed:", e);
  }
});

// Initial load
(async () => {
  populatePresets();
  loadToggleState();
  await loadGroups();        // populate dropdown FIRST so emoji() etc. know the active group
  try { els.rootPath.textContent = await invoke("orchestrator_path"); } catch {}
  await refreshRuns();
})();
