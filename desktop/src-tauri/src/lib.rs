// Tauri commands for the crime-team orchestrator GUI.
//
// run_task    — spawns `node bin/crime-team.mjs` as a subprocess and streams
//               every stdout/stderr line to the frontend via Tauri events.
// list_runs   — reads ../runs/*.json and returns a summary list.
// get_run     — reads one run JSON.
// cancel_run  — kills the in-flight subprocess if any.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Shared handle to the currently running orchestrator subprocess (if any).
#[derive(Default)]
struct RunState {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunLine {
    run_id: String,
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunDone {
    run_id: String,
    exit_code: Option<i32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    run_id: String,
    started_at: String,
    task: String,
    has_final: bool,
}

/// Resolve the orchestrator project root (one level up from the desktop/ subdir
/// in dev, or alongside the .exe in release if bundled together — for v0.1 we
/// just look up from cwd until we find bin/crime-team.mjs).
fn orchestrator_root() -> PathBuf {
    // Prefer a known absolute path baked at build time, fall back to CWD walk.
    let known = PathBuf::from(r"C:\Users\user\Projects\crime-team-orchestrator");
    if known.join("bin").join("crime-team.mjs").exists() {
        return known;
    }
    let mut cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..6 {
        if cwd.join("bin").join("crime-team.mjs").exists() {
            return cwd;
        }
        if !cwd.pop() { break; }
    }
    PathBuf::from(".")
}

#[tauri::command]
async fn run_task(
    app: AppHandle,
    state: State<'_, Arc<RunState>>,
    task: String,
    verbose: bool,
    timeout_sec: Option<u32>,
    smart_dispatch: Option<bool>,
) -> Result<String, String> {
    let root = orchestrator_root();
    let bin = root.join("bin").join("crime-team.mjs");
    if !bin.exists() {
        return Err(format!("crime-team.mjs not found at {}", bin.display()));
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let run_id_emit = run_id.clone();

    let mut args: Vec<String> = vec![bin.to_string_lossy().to_string(), task];
    if verbose { args.push("--verbose".into()); }
    if smart_dispatch.unwrap_or(false) { args.push("--smart-dispatch".into()); }
    if let Some(t) = timeout_sec {
        args.push("--timeout".into());
        args.push(t.to_string());
    }

    let mut child = Command::new("node")
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    {
        let mut slot = state.child.lock().unwrap();
        *slot = Some(child);
    }

    // stdout pump
    {
        let app_out = app.clone();
        let id = run_id_emit.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_out.emit("orchestrator:line", RunLine {
                    run_id: id.clone(),
                    stream: "stdout",
                    line,
                });
            }
        });
    }

    // stderr pump
    {
        let app_err = app.clone();
        let id = run_id_emit.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_err.emit("orchestrator:line", RunLine {
                    run_id: id.clone(),
                    stream: "stderr",
                    line,
                });
            }
        });
    }

    // wait + emit completion
    let app_done = app.clone();
    let state_done = state.inner().clone();
    let id_done = run_id_emit.clone();
    tauri::async_runtime::spawn(async move {
        // Take ownership of the Child OUT of the Mutex first, then drop the
        // guard, then await. This avoids holding a non-Send std::sync::Mutex
        // guard across the await point.
        let c_opt: Option<Child> = {
            let mut slot = state_done.child.lock().unwrap();
            slot.take()
        };
        let exit_code: Option<i32> = if let Some(mut c) = c_opt {
            match c.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            None
        };
        let _ = app_done.emit("orchestrator:done", RunDone {
            run_id: id_done,
            exit_code,
        });
    });

    Ok(run_id)
}

#[tauri::command]
async fn cancel_run(state: State<'_, Arc<RunState>>) -> Result<bool, String> {
    let mut slot = state.child.lock().unwrap();
    if let Some(mut c) = slot.take() {
        let _ = c.start_kill();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn list_runs() -> Result<Vec<RunSummary>, String> {
    let root = orchestrator_root();
    // Scope to the active group's run dir: runs/<group-id>/
    let group_id = active_group_id().unwrap_or_else(|_| String::new());
    let runs_dir = if group_id.is_empty() {
        root.join("runs")
    } else {
        root.join("runs").join(&group_id)
    };
    if !runs_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&runs_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let txt = match std::fs::read_to_string(&path) { Ok(t) => t, Err(_) => continue };
        let v: serde_json::Value = match serde_json::from_str(&txt) { Ok(v) => v, Err(_) => continue };
        let run_id = v.get("runId").and_then(|s| s.as_str()).unwrap_or("").to_string();
        if run_id.is_empty() { continue; }
        out.push(RunSummary {
            run_id,
            started_at: v.get("startedAt").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            task: v.get("task").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            has_final: v.get("finalAnswer").is_some(),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

#[tauri::command]
fn get_run(run_id: String) -> Result<serde_json::Value, String> {
    let root = orchestrator_root();
    let group_id = active_group_id().unwrap_or_else(|_| String::new());
    // Try the group-scoped path first, fall back to flat for legacy records.
    let candidates: Vec<PathBuf> = if group_id.is_empty() {
        vec![root.join("runs").join(format!("{run_id}.json"))]
    } else {
        vec![
            root.join("runs").join(&group_id).join(format!("{run_id}.json")),
            root.join("runs").join(format!("{run_id}.json")),
        ]
    };
    for path in &candidates {
        if let Ok(txt) = std::fs::read_to_string(path) {
            return serde_json::from_str(&txt).map_err(|e| format!("parse {path:?}: {e}"));
        }
    }
    Err(format!("run not found in any of: {candidates:?}"))
}

#[tauri::command]
fn orchestrator_path() -> String {
    orchestrator_root().to_string_lossy().to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Groups (Phase A multi-project plumbing)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Group {
    id: String,
    display_name: String,
    emoji: String,
    workspace: String,
    producer_agent_id: String,
    specialists: Vec<String>,
    created_at: String,
    last_used_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GroupsFile {
    active_group_id: String,
    groups: Vec<Group>,
}

fn groups_file_path() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home).join(".crime-team").join("groups.json")
}

fn read_groups_file() -> Result<GroupsFile, String> {
    let path = groups_file_path();
    let txt = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {path:?}: {e} — Phase A migration may not have run"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse {path:?}: {e}"))
}

fn write_groups_file(file: &GroupsFile) -> Result<(), String> {
    let path = groups_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let pretty = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write {path:?}: {e}"))
}

fn active_group_id() -> Result<String, String> {
    read_groups_file().map(|f| f.active_group_id)
}

fn active_group() -> Result<Group, String> {
    let file = read_groups_file()?;
    file.groups.iter()
        .find(|g| g.id == file.active_group_id)
        .cloned()
        .ok_or_else(|| format!("active group '{}' not found in groups.json", file.active_group_id))
}

#[tauri::command]
fn groups_list() -> Result<GroupsFile, String> {
    read_groups_file()
}

#[tauri::command]
fn groups_get_active() -> Result<Group, String> {
    active_group()
}

#[tauri::command]
fn groups_set_active(group_id: String) -> Result<(), String> {
    let mut file = read_groups_file()?;
    if !file.groups.iter().any(|g| g.id == group_id) {
        return Err(format!("group '{group_id}' not found"));
    }
    file.active_group_id = group_id;
    // Update lastUsedAt on the now-active group.
    let now = chrono_now_iso();
    if let Some(g) = file.groups.iter_mut().find(|g| g.id == file.active_group_id) {
        g.last_used_at = now;
    }
    write_groups_file(&file)
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan + propose flow
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: &'static str,
    detail: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProposedSpecialist {
    id: String,
    emoji: String,
    role: String,
    reasoning: String,
    suggested_model: String,
    suggested_thinking: String,
    system_prompt: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TeamProposal {
    rationale: String,
    specialists: Vec<ProposedSpecialist>,
}

/// Cap a string to `max_bytes`, appending a truncation marker if cut.
fn cap(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes { return s.to_string(); }
    let cut = max_bytes.saturating_sub(120);
    let safe = match s.char_indices().take_while(|(i, _)| *i < cut).last() {
        Some((i, c)) => i + c.len_utf8(),
        None => 0,
    };
    format!("{}\n[…truncated by scan at {} chars; original was {} chars…]",
            &s[..safe], cut, s.len())
}

fn read_capped(path: &std::path::Path, max_bytes: usize) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| cap(&s, max_bytes))
}

/// List directory entries (depth 1) sorted, filtering noise.
fn list_dir(path: &std::path::Path, max_entries: usize) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path).ok().into_iter().flatten()
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { format!("{name}/") } else { name }
        })
        .filter(|n| {
            let lower = n.to_lowercase();
            !lower.starts_with('.') && !["node_modules/", "dist/", "build/", "target/", "out/", ".next/"]
                .iter().any(|skip| lower == *skip)
        })
        .collect();
    names.sort();
    names.truncate(max_entries);
    names
}

fn emit_scan(app: &AppHandle, phase: &'static str, detail: impl Into<String>) {
    let _ = app.emit("scan:progress", ScanProgress { phase, detail: detail.into() });
}

/// Scan a workspace, build the meta-prompt per plan §6, ask the chosen model
/// to propose a specialist team, and return the parsed/validated proposal.
/// Emits "scan:progress" events as it goes so the GUI can show live status.
#[tauri::command]
async fn groups_scan_project(
    app: AppHandle,
    workspace: String,
    display_name: String,
    model: String,
    thinking: String,
) -> Result<TeamProposal, String> {
    let ws_path = std::path::PathBuf::from(&workspace);
    if !ws_path.exists() || !ws_path.is_dir() {
        return Err(format!("workspace does not exist or is not a directory: {workspace}"));
    }

    // ─── 1. read context files ──────────────────────────────────────────────
    emit_scan(&app, "reading", "scanning project files…");

    // Project brief (CLAUDE.md or AGENTS.md). Cap 8KB.
    let brief = ["CLAUDE.md", "AGENTS.md", "claude.md", "agents.md"].iter()
        .find_map(|f| read_capped(&ws_path.join(f), 8000))
        .unwrap_or_else(|| "(no project brief found)".to_string());
    emit_scan(&app, "reading", format!("brief: {} chars", brief.len()));

    // README.md. Cap 6KB.
    let readme = read_capped(&ws_path.join("README.md"), 6000)
        .unwrap_or_else(|| "(no README.md)".to_string());

    // Stack manifests. Each capped small.
    let manifests = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile",
                     "tsconfig.json", "next.config.ts", "next.config.mjs", "next.config.js",
                     "tauri.conf.json", "vite.config.ts", "vite.config.js"]
        .iter()
        .filter_map(|f| read_capped(&ws_path.join(f), 2000).map(|c| format!("=== {f} ===\n{c}")))
        .collect::<Vec<_>>()
        .join("\n\n");

    // Top-level directory listing.
    let top_level = list_dir(&ws_path, 80).join("\n  ");

    // One level of key sub-dirs.
    let key_subs = ["src", "app", "lib", "components", "scripts", "stdb", "stdb/spacetimedb",
                    "stdb/spacetimedb/src", "src/components", "src/lib"];
    let mut sub_listings: Vec<String> = Vec::new();
    for sub in key_subs {
        let p = ws_path.join(sub);
        if p.is_dir() {
            let entries = list_dir(&p, 60).join("\n  ");
            if !entries.is_empty() {
                sub_listings.push(format!("=== {sub}/ ===\n  {entries}"));
            }
        }
    }
    let sub_text = sub_listings.join("\n\n");

    emit_scan(&app, "building-prompt", "composing meta-prompt…");

    // ─── 2. build the meta-prompt (kept under ~22KB to fit argv) ────────────
    // The example-prompt exemplar is the existing crime-os architect.md (truncated).
    let exemplar_path = std::env::var("USERPROFILE").map(|h|
        std::path::PathBuf::from(h).join(".openclaw").join("team-prompts").join("crimeos.architect.md")
    ).map_err(|e| format!("USERPROFILE: {e}"))?;
    let exemplar = read_capped(&exemplar_path, 3500).unwrap_or_else(|| String::new());

    let mut prompt = String::with_capacity(20000);
    prompt.push_str(&format!(
"You are designing an agent team for a software project. Each team has a Producer (already chosen by Dan) plus 2-5 specialists tailored to THIS project. Propose only the specialists.\n\n\
PROJECT INFO\n────────────\n\
Display name: {display_name}\n\
Workspace:    {workspace}\n\n\
CONTEXT FILES\n─────────────\n\
=== Project brief ===\n{brief}\n\n\
=== README.md ===\n{readme}\n\n\
{manifests}\n\n\
=== Top-level structure ===\n  {top_level}\n\n\
{sub_text}\n\n\
"));

    let exemplar_block = if !exemplar.is_empty() {
        format!("EXAMPLE SYSTEM PROMPT (style template — do not copy literally, this is just to show structure and tone):\n\n{}\n\n", cap(&exemplar, 3000))
    } else {
        String::new()
    };

    prompt.push_str(&format!(
"TASK\n────\nPropose 2-5 specialist agents tailored to THIS project. For each:\n  1. A short id (kebab-case, no spaces, 3-15 chars).\n  2. A one-word emoji.\n  3. A 1-sentence role description.\n  4. Why this project needs this role (cite paths or files from the context above).\n  5. Suggested model from: anthropic/claude-opus-4-7, anthropic/claude-sonnet-4-6, google/gemini-2.5-pro, google/gemini-2.5-flash, deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash, openrouter/google/gemma-4-31b-it:free\n  6. Suggested thinking level: off | low | medium | high | max\n  7. A complete system prompt for this agent (~1500-3000 chars). Include: role, owned domain (cite specific paths from the workspace), what to always read first, invariants, voice. NO scaffolding: do NOT include any 'Hey I just came online' opener or ask to be named.\n\n\
{exemplar_block}\
OUTPUT FORMAT (STRICT)\n──────────────────────\nReturn ONLY a JSON object — no prose before or after, optionally inside a single ```json code fence. Schema:\n\n\
{{\n  \"rationale\": \"<1-2 sentences on why this team for this project>\",\n  \"specialists\": [\n    {{\n      \"id\": \"<id>\",\n      \"emoji\": \"<emoji>\",\n      \"role\": \"<1 sentence>\",\n      \"reasoning\": \"<why this project needs this role; cite paths>\",\n      \"suggestedModel\": \"<provider/model>\",\n      \"suggestedThinking\": \"off|low|medium|high|max\",\n      \"systemPrompt\": \"<full multi-paragraph prompt>\"\n    }}\n  ]\n}}\n\n\
RULES\n─────\n- DO NOT include Producer; that role is fixed.\n- DO NOT propose more than 5 specialists.\n- DO NOT add a security specialist unless this project handles real user data, auth, payments, or multi-user state — most solo projects do not need one.\n- Match dispatched specialists to the actual scope of the work. A CLI tool may need only 2 agents. A game may need 4 or 5.\n- Specialist ids must be unique within this team and kebab-case.\n- Prefer cheap models (deepseek/deepseek-v4-pro, anthropic/claude-sonnet-4-6) unless a role really needs Opus.\n"
    ));

    emit_scan(&app, "calling-model", format!("calling {} ({} chars prompt)…", model, prompt.len()));

    // ─── 3. call the model via openclaw infer ───────────────────────────────
    // openclaw infer model run --local --model X --prompt Y. argv-limited.
    // We cap to ~24KB total prompt to leave room for other args.
    if prompt.len() > 24000 {
        prompt.truncate(24000);
        prompt.push_str("\n[…prompt truncated by scan at 24000 chars to fit argv…]");
    }

    let mut args: Vec<&str> = vec!["infer", "model", "run", "--local", "--model", &model, "--prompt", &prompt];
    if !thinking.is_empty() && thinking != "off" {
        args.push("--thinking");
        args.push(&thinking);
    }
    let raw = run_openclaw(&args, None).await
        .map_err(|e| format!("model call failed: {e}"))?;

    emit_scan(&app, "parsing", "parsing team proposal…");

    // ─── 4. extract + parse JSON ────────────────────────────────────────────
    let json_text = extract_json_payload(&raw)
        .ok_or_else(|| format!("model did not return parseable JSON. Raw output:\n{raw}"))?;
    let mut proposal: TeamProposal = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON parse failed: {e}. Extracted text:\n{}", cap(&json_text, 2000)))?;

    // ─── 5. validate ────────────────────────────────────────────────────────
    if proposal.specialists.is_empty() {
        return Err("model proposed 0 specialists; expected 2-5".into());
    }
    if proposal.specialists.len() > 5 {
        proposal.specialists.truncate(5);
    }
    let mut seen = std::collections::HashSet::new();
    for s in proposal.specialists.iter_mut() {
        let id_ok = s.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok || s.id.is_empty() || s.id.len() > 20 {
            return Err(format!("invalid specialist id '{}' — must be kebab-case ≤20 chars", s.id));
        }
        if !seen.insert(s.id.clone()) {
            return Err(format!("duplicate specialist id '{}'", s.id));
        }
        if s.system_prompt.trim().len() < 200 {
            return Err(format!("specialist '{}' has too-short systemPrompt ({} chars; need ≥200)", s.id, s.system_prompt.len()));
        }
        // Normalize thinking level
        let t = s.suggested_thinking.to_lowercase();
        s.suggested_thinking = match t.as_str() {
            "off" | "low" | "medium" | "high" | "max" => t,
            _ => "medium".to_string(),
        };
    }

    emit_scan(&app, "done", format!("proposal received: {} specialist(s)", proposal.specialists.len()));
    Ok(proposal)
}

/// Pull a JSON object from raw model output. Handles ```json fences, leading
/// chatter, and trailing prose. Returns the inner JSON text only.
fn extract_json_payload(raw: &str) -> Option<String> {
    // Try a ```json … ``` fence first.
    if let Some(start) = raw.find("```json") {
        let after = &raw[start + 7..];
        if let Some(end) = after.find("```") {
            return Some(after[..end].trim().to_string());
        }
    }
    if let Some(start) = raw.find("```") {
        let after = &raw[start + 3..];
        if let Some(end) = after.find("```") {
            let inner = after[..end].trim();
            if inner.starts_with('{') {
                return Some(inner.to_string());
            }
        }
    }
    // Fall back: find the first '{' that begins a balanced object.
    let bytes = raw.as_bytes();
    let mut start_idx: Option<usize> = None;
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut esc = false;
    for (i, b) in bytes.iter().enumerate() {
        if start_idx.is_none() {
            if *b == b'{' { start_idx = Some(i); depth = 1; }
            continue;
        }
        if esc { esc = false; continue; }
        match *b {
            b'\\' if in_str => esc = true,
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(raw[start_idx.unwrap()..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// groups_create — bulk-add agents for a new team, atomic-ish with rollback
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSpec {
    id: String,
    emoji: String,
    model: String,
    thinking: String,
    system_prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateGroupSpec {
    id: String,             // group slug, e.g. "myproject"
    display_name: String,
    emoji: String,
    workspace: String,
    producer: AgentSpec,
    specialists: Vec<AgentSpec>,
}

/// Create a new group: add agents in OpenClaw, write prompts, mirror auth,
/// set identities, append to groups.json, write a starter presets.js,
/// restart the gateway. Rolls back on any failure.
#[tauri::command]
async fn groups_create(app: AppHandle, spec: CreateGroupSpec) -> Result<Group, String> {
    // ─── 1. validate ─────────────────────────────────────────────────────────
    if spec.id.is_empty() || !spec.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(format!("invalid group id '{}' — must be kebab-case", spec.id));
    }
    if !std::path::PathBuf::from(&spec.workspace).is_dir() {
        return Err(format!("workspace not found: {}", spec.workspace));
    }
    let existing = read_groups_file().ok();
    if let Some(ref f) = existing {
        if f.groups.iter().any(|g| g.id == spec.id) {
            return Err(format!("group '{}' already exists", spec.id));
        }
    }

    let prefix = format!("{}.", spec.id);
    let qualified_producer_id = format!("{}producer", prefix);
    let specialist_ids: Vec<String> = spec.specialists.iter()
        .map(|s| format!("{}{}", prefix, s.id))
        .collect();
    let all_ids: Vec<String> = std::iter::once(qualified_producer_id.clone())
        .chain(specialist_ids.iter().cloned())
        .collect();

    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    let home_path = std::path::PathBuf::from(&home);
    let openclaw_root = home_path.join(".openclaw");
    let agents_root = openclaw_root.join("agents");
    let prompts_root = openclaw_root.join("team-prompts");
    let ct_root = home_path.join(".crime-team");

    emit_scan(&app, "creating", format!("creating {} agents…", all_ids.len()));

    // Rollback tracking: collect created agent dirs + prompt files + config-patched ids.
    let mut created_agent_dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut created_prompt_files: Vec<std::path::PathBuf> = Vec::new();

    // Closure: run rollback then return the error.
    async fn rollback(
        ids: &[String],
        dirs: &[std::path::PathBuf],
        prompts: &[std::path::PathBuf],
    ) {
        for id in ids {
            let _ = run_openclaw(&["agents", "delete", id, "--yes"], None).await;
        }
        for d in dirs {
            let _ = std::fs::remove_dir_all(d);
        }
        for p in prompts {
            let _ = std::fs::remove_file(p);
        }
    }

    // ─── 2. add each agent ───────────────────────────────────────────────────
    let auth_src = agents_root.join("main").join("agent").join("auth-profiles.json");

    let make_specs = || -> Vec<(&AgentSpec, String, String)> {
        // (spec, qualified_id, role_for_filename)
        let mut v = Vec::new();
        v.push((&spec.producer, qualified_producer_id.clone(), "producer".to_string()));
        for (s, qid) in spec.specialists.iter().zip(specialist_ids.iter()) {
            v.push((s, qid.clone(), s.id.clone()));
        }
        v
    };

    for (agent_spec, qid, role) in make_specs() {
        let agent_dir = agents_root.join(&qid);
        let agent_dir_str = agent_dir.to_string_lossy().to_string();
        emit_scan(&app, "creating", format!("agents add {qid}"));
        let r = run_openclaw(&[
            "agents", "add", &qid,
            "--non-interactive",
            "--workspace", &spec.workspace,
            "--model", &agent_spec.model,
            "--agent-dir", &agent_dir_str,
        ], None).await;
        if let Err(e) = r {
            rollback(&all_ids, &created_agent_dirs, &created_prompt_files).await;
            return Err(format!("agents add {qid} failed: {e}"));
        }
        created_agent_dirs.push(agent_dir.clone());

        // Mirror auth profiles
        let auth_dest = agent_dir.join("auth-profiles.json");
        let _ = std::fs::copy(&auth_src, &auth_dest);

        // Write system prompt file
        let prompt_file = prompts_root.join(format!("{}.{}.md", spec.id, role));
        if let Err(e) = std::fs::write(&prompt_file, &agent_spec.system_prompt) {
            rollback(&all_ids, &created_agent_dirs, &created_prompt_files).await;
            return Err(format!("write prompt {prompt_file:?}: {e}"));
        }
        created_prompt_files.push(prompt_file);

        // Set identity (display name + emoji)
        let display = if role == "producer" { "Producer".to_string() } else { capitalize(&role) };
        let _ = run_openclaw(&[
            "agents", "set-identity",
            "--agent", &qid,
            "--name", &display,
            "--emoji", &agent_spec.emoji,
        ], None).await;
    }

    // ─── 3. patch agents.list ─────────────────────────────────────────────
    //   (a) Rename: OpenClaw's `agents add` silently converts dots in agent
    //       ids to dashes, so what we asked for as "groupslug.role" was
    //       actually stored as "groupslug-role". Rename it back to match what
    //       groups.json + dispatch code expect.
    //   (b) Add systemPromptOverride per agent.
    emit_scan(&app, "creating", "wiring system prompts…");
    let list_json = run_openclaw(&["config", "get", "agents.list"], None).await
        .map_err(|e| { format!("read agents.list: {e}") })?;
    let mut list: serde_json::Value = serde_json::from_str(&list_json)
        .map_err(|e| format!("parse agents.list: {e}"))?;
    let dashed_prefix = format!("{}-", spec.id);
    let dotted_prefix = format!("{}.", spec.id);
    if let Some(arr) = list.as_array_mut() {
        for (agent_spec, qid, _role) in make_specs() {
            // qid is the dotted form ("groupslug.role"). The actual id stored
            // by `agents add` might be the dashed form. Match either.
            let dashed_id = qid.replacen(&dotted_prefix, &dashed_prefix, 1);
            for a in arr.iter_mut() {
                let current_id = a.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if current_id == qid || current_id == dashed_id {
                    if let Some(obj) = a.as_object_mut() {
                        // Force the id back to the dotted form
                        obj.insert("id".to_string(), serde_json::Value::String(qid.clone()));
                        if obj.contains_key("name") {
                            obj.insert("name".to_string(), serde_json::Value::String(qid.clone()));
                        }
                        // Wire the prompt
                        obj.insert("systemPromptOverride".to_string(),
                                   serde_json::Value::String(agent_spec.system_prompt.clone()));
                    }
                    break;
                }
            }
        }
    }
    let payload = serde_json::json!({ "agents": { "list": list } });
    let payload_s = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    if let Err(e) = run_openclaw(
        &["config", "patch", "--stdin", "--replace-path", "agents.list"],
        Some(payload_s.as_bytes()),
    ).await {
        rollback(&all_ids, &created_agent_dirs, &created_prompt_files).await;
        return Err(format!("patch agents.list: {e}"));
    }

    // ─── 4. write per-group thinking levels into .crime-team.json ────────────
    let mut ct = read_crime_team_json();
    if !ct.is_object() { ct = serde_json::json!({}); }
    let obj = ct.as_object_mut().unwrap();
    let group_thinking_root = obj.entry("perGroupThinking".to_string()).or_insert_with(|| serde_json::json!({}));
    let role_map_entry = group_thinking_root.as_object_mut().unwrap().entry(spec.id.clone()).or_insert_with(|| serde_json::json!({}));
    let role_map = role_map_entry.as_object_mut().unwrap();
    if !spec.producer.thinking.is_empty() && spec.producer.thinking != "off" {
        role_map.insert("producer".to_string(), serde_json::Value::String(spec.producer.thinking.clone()));
    }
    for s in &spec.specialists {
        if !s.thinking.is_empty() && s.thinking != "off" {
            role_map.insert(s.id.clone(), serde_json::Value::String(s.thinking.clone()));
        }
    }
    if let Err(e) = write_crime_team_json(&ct) {
        rollback(&all_ids, &created_agent_dirs, &created_prompt_files).await;
        return Err(format!(".crime-team.json write: {e}"));
    }

    // ─── 5. write starter presets.json for this group ────────────────────────
    let group_dir = ct_root.join("groups").join(&spec.id);
    let _ = std::fs::create_dir_all(&group_dir);
    let presets_path = group_dir.join("presets.json");
    let starter_presets = starter_presets_json_for_group(&spec);
    let _ = std::fs::write(&presets_path, &starter_presets);

    // ─── 6. append to groups.json + set active ───────────────────────────────
    let now = chrono_now_iso();
    let new_group = Group {
        id: spec.id.clone(),
        display_name: spec.display_name.clone(),
        emoji: spec.emoji.clone(),
        workspace: spec.workspace.clone(),
        producer_agent_id: qualified_producer_id.clone(),
        specialists: specialist_ids.clone(),
        created_at: now.clone(),
        last_used_at: now,
    };
    let mut groups_file = existing.unwrap_or(GroupsFile {
        active_group_id: spec.id.clone(),
        groups: Vec::new(),
    });
    groups_file.groups.push(new_group.clone());
    groups_file.active_group_id = spec.id.clone();
    if let Err(e) = write_groups_file(&groups_file) {
        rollback(&all_ids, &created_agent_dirs, &created_prompt_files).await;
        return Err(format!("write groups.json: {e}"));
    }

    // ─── 7. restart gateway ──────────────────────────────────────────────────
    emit_scan(&app, "restarting", "restarting gateway…");
    let _ = run_openclaw(&["gateway", "restart"], None).await;

    emit_scan(&app, "done", format!("group '{}' created", spec.id));
    Ok(new_group)
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

/// Generate a minimal starter presets.json for a new group.
/// Structure: { "presets": [{"group", "items": [{"label", "prompt"}]}], "angles": [{"label", "suffix"}] }
fn starter_presets_json_for_group(spec: &CreateGroupSpec) -> String {
    let specialists_csv = spec.specialists.iter()
        .map(|s| s.id.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let payload = serde_json::json!({
        "presets": [
            {
                "group": "Combos",
                "items": [
                    {
                        "label": "Universal Findings",
                        "prompt": format!(
"Do a read-only Findings pass on this system. No code changes. Judge it from two angles:\n1. Will this hurt the user experience?\n2. Will this slow development later?\n\nReport only the highest-value findings. Ignore minor style issues unless they create real risk. Dispatch in parallel to all relevant specialists ({}). Synthesize into ONE integrated report.",
                            specialists_csv)
                    }
                ]
            }
        ],
        "angles": [
            { "label": "(no extra angle)", "suffix": "" },
            { "label": "Prioritize user pain over coding purity", "suffix": "\n\nPrioritize findings by user pain, not coding purity." },
            { "label": "Sort into ship-blocker / soon / later", "suffix": "\n\nSeparate \"ship blocker,\" \"soon,\" and \"later.\"" }
        ]
    });
    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
}

/// Read an agent's system prompt from the team-prompts dir.
#[tauri::command]
fn groups_get_prompt(agent_id: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    // agent_id like "crimeos.architect" → team-prompts/crimeos.architect.md
    let path = std::path::PathBuf::from(home).join(".openclaw").join("team-prompts").join(format!("{}.md", agent_id));
    std::fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))
}

/// Write an agent's system prompt: updates the team-prompts/.md file AND
/// patches the agent's systemPromptOverride in openclaw.json so the gateway
/// uses the new content on next call.
#[tauri::command]
async fn groups_set_prompt(agent_id: String, prompt: String) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    let path = std::path::PathBuf::from(home).join(".openclaw").join("team-prompts").join(format!("{}.md", agent_id));
    std::fs::write(&path, &prompt).map_err(|e| format!("write {path:?}: {e}"))?;

    // Patch openclaw.json
    let list_json = run_openclaw(&["config", "get", "agents.list"], None).await?;
    let mut list: serde_json::Value = serde_json::from_str(&list_json)
        .map_err(|e| format!("parse agents.list: {e}"))?;
    if let Some(arr) = list.as_array_mut() {
        let mut found = false;
        for a in arr.iter_mut() {
            if a.get("id").and_then(|s| s.as_str()) == Some(&agent_id) {
                if let Some(obj) = a.as_object_mut() {
                    obj.insert("systemPromptOverride".to_string(), serde_json::Value::String(prompt.clone()));
                }
                found = true;
                break;
            }
        }
        if !found { return Err(format!("agent '{agent_id}' not found in agents.list")); }
    }
    let payload = serde_json::json!({ "agents": { "list": list } });
    let payload_s = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    run_openclaw(&["config", "patch", "--stdin", "--replace-path", "agents.list"], Some(payload_s.as_bytes())).await?;
    Ok(())
}

/// Edit a group's metadata. Pass null/empty to leave a field unchanged.
/// Workspace change also rewrites the workspace of every agent in this group
/// inside openclaw.json so they point at the new project root.
#[tauri::command]
async fn groups_edit(
    group_id: String,
    display_name: Option<String>,
    emoji: Option<String>,
    workspace: Option<String>,
) -> Result<Group, String> {
    let mut file = read_groups_file()?;
    let updated = {
        let g = file.groups.iter_mut().find(|g| g.id == group_id)
            .ok_or_else(|| format!("group '{group_id}' not found"))?;
        if let Some(n) = display_name.as_ref() { if !n.trim().is_empty() { g.display_name = n.clone(); } }
        if let Some(e) = emoji.as_ref()        { if !e.trim().is_empty() { g.emoji = e.clone(); } }
        if let Some(w) = workspace.as_ref()    {
            if !w.trim().is_empty() {
                if !std::path::PathBuf::from(w).is_dir() {
                    return Err(format!("new workspace does not exist: {w}"));
                }
                g.workspace = w.clone();
            }
        }
        g.last_used_at = chrono_now_iso();
        g.clone()
    };
    write_groups_file(&file)?;

    // If workspace changed, rewrite every agent's workspace in openclaw.json.
    if let Some(new_ws) = workspace.as_ref() {
        if !new_ws.trim().is_empty() {
            let mut agent_ids: Vec<String> = updated.specialists.clone();
            agent_ids.push(updated.producer_agent_id.clone());
            let list_json = run_openclaw(&["config", "get", "agents.list"], None).await?;
            let mut list: serde_json::Value = serde_json::from_str(&list_json).map_err(|e| format!("parse agents.list: {e}"))?;
            if let Some(arr) = list.as_array_mut() {
                for a in arr.iter_mut() {
                    let id = a.get("id").and_then(|s| s.as_str()).unwrap_or("");
                    if agent_ids.iter().any(|x| x == id) {
                        if let Some(obj) = a.as_object_mut() {
                            obj.insert("workspace".to_string(), serde_json::Value::String(new_ws.clone()));
                        }
                    }
                }
            }
            let payload = serde_json::json!({ "agents": { "list": list } });
            let payload_s = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
            run_openclaw(&["config", "patch", "--stdin", "--replace-path", "agents.list"], Some(payload_s.as_bytes())).await?;
            let _ = run_openclaw(&["gateway", "restart"], None).await;
        }
    }
    Ok(updated)
}

/// Remove a group: delete its agents from OpenClaw, delete agent dirs, delete
/// team-prompts/<gid>.*.md, delete runs/<gid>/, delete ~/.crime-team/groups/<gid>/,
/// remove from groups.json. If the active group is being removed, switch to
/// another group (or refuse if it's the last one).
#[tauri::command]
async fn groups_remove(group_id: String) -> Result<(), String> {
    let mut file = read_groups_file()?;
    let idx = file.groups.iter().position(|g| g.id == group_id)
        .ok_or_else(|| format!("group '{group_id}' not found"))?;
    if file.groups.len() <= 1 {
        return Err("cannot remove the only group — create another first".into());
    }
    let group = file.groups[idx].clone();

    // 1. delete every agent from OpenClaw
    let mut agent_ids: Vec<String> = group.specialists.clone();
    agent_ids.push(group.producer_agent_id.clone());
    for id in &agent_ids {
        let _ = run_openclaw(&["agents", "delete", id, "--yes"], None).await;
    }

    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    let home_path = std::path::PathBuf::from(&home);

    // 2. delete agent dirs (in case `agents delete` left them)
    for id in &agent_ids {
        let dir = home_path.join(".openclaw").join("agents").join(id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 3. delete team-prompt files
    let prompts_dir = home_path.join(".openclaw").join("team-prompts");
    if let Ok(entries) = std::fs::read_dir(&prompts_dir) {
        let prefix = format!("{}.", group.id);
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".md") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }

    // 4. delete runs/<gid>/
    let runs_dir = orchestrator_root().join("runs").join(&group.id);
    let _ = std::fs::remove_dir_all(&runs_dir);

    // 5. delete ~/.crime-team/groups/<gid>/
    let cgroup_dir = home_path.join(".crime-team").join("groups").join(&group.id);
    let _ = std::fs::remove_dir_all(&cgroup_dir);

    // 6. remove per-group thinking + remove from groups.json + adjust active
    let mut ct = read_crime_team_json();
    if let Some(obj) = ct.as_object_mut() {
        if let Some(map) = obj.get_mut("perGroupThinking").and_then(|m| m.as_object_mut()) {
            map.remove(&group.id);
        }
    }
    let _ = write_crime_team_json(&ct);

    file.groups.remove(idx);
    if file.active_group_id == group_id {
        file.active_group_id = file.groups[0].id.clone();
        file.groups[0].last_used_at = chrono_now_iso();
    }
    write_groups_file(&file)?;
    let _ = run_openclaw(&["gateway", "restart"], None).await;
    Ok(())
}

/// Read a group's presets.json from disk. Returns None if the file doesn't
/// exist or can't be parsed — the GUI falls back to bundled defaults.
#[tauri::command]
fn groups_get_presets(group_id: String) -> Option<serde_json::Value> {
    let home = std::env::var("USERPROFILE").ok()?;
    let path = PathBuf::from(home).join(".crime-team").join("groups").join(&group_id).join("presets.json");
    let txt = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&txt).ok()
}

/// Write a group's presets.json. Used by the Settings → Groups editor (future)
/// and by the migration helper below.
#[tauri::command]
fn groups_set_presets(group_id: String, presets: serde_json::Value) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    let dir = PathBuf::from(home).join(".crime-team").join("groups").join(&group_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join("presets.json");
    let pretty = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write {path:?}: {e}"))
}

/// Open the OS folder picker. Returns the absolute path the user chose,
/// or None if they cancelled.
#[tauri::command]
async fn groups_browse_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx.await.map_err(|e| format!("dialog cancelled: {e}"))?;
    Ok(picked.map(|p| p.to_string()))
}

/// Minimal ISO-8601 timestamp without pulling in chrono. Uses UTC.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Just emit "unix:<n>" — the GUI reformats. We don't need millisecond precision.
    format!("unix:{secs}")
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings commands
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentSetting {
    id: String,
    primary: String,
    fallbacks: Vec<String>,
    /// Empty string = provider default; otherwise one of:
    /// off | minimal | low | medium | high | xhigh | adaptive | max
    thinking: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProfile {
    profile_id: String,
    provider: String,
    auth_type: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SettingsSnapshot {
    agents: Vec<AgentSetting>,
    profiles: Vec<ProviderProfile>,
}

fn openclaw_bin() -> (String, String) {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let node = std::env::var("CRIME_TEAM_NODE").unwrap_or_else(|_| "node".to_string());
    let openclaw = format!("{appdata}\\npm\\node_modules\\openclaw\\openclaw.mjs");
    (node, openclaw)
}

/// Run `openclaw <args>` capturing stdout. Returns Err with stderr on non-zero exit.
async fn run_openclaw(args: &[&str], stdin_data: Option<&[u8]>) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let (node, openclaw) = openclaw_bin();
    let mut cmd = Command::new(node);
    cmd.arg(&openclaw).args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_data.is_some() { cmd.stdin(Stdio::piped()); }
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data).await.map_err(|e| format!("stdin write: {e}"))?;
            stdin.shutdown().await.ok();
        }
    }
    let out = child.wait_with_output().await.map_err(|e| format!("wait: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
async fn settings_get(group_id: Option<String>) -> Result<SettingsSnapshot, String> {
    // agents.list — JSON array
    let agents_json = run_openclaw(&["config", "get", "agents.list"], None).await?;
    let agents_v: serde_json::Value = serde_json::from_str(&agents_json)
        .map_err(|e| format!("parse agents.list: {e}"))?;
    // Filter to a specific group's agents — defaults to active group when None.
    let active_id = match group_id {
        Some(id) if !id.is_empty() => id,
        _ => active_group_id().unwrap_or_else(|_| String::new()),
    };
    let group_prefix = if active_id.is_empty() { String::new() } else { format!("{active_id}.") };
    let mut agents = Vec::new();
    if let Some(list) = agents_v.as_array() {
        for a in list {
            let id = a.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if id.is_empty() || id == "main" { continue; }
            // Scope to the active group: only agents whose id starts with "<group>." are part of this team.
            if !group_prefix.is_empty() && !id.starts_with(&group_prefix) { continue; }
            // model can be a string OR an object { primary, fallbacks }
            let (primary, fallbacks) = match a.get("model") {
                Some(serde_json::Value::String(s)) => (s.clone(), vec![]),
                Some(serde_json::Value::Object(m)) => {
                    let p = m.get("primary").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let fb = m.get("fallbacks").and_then(|f| f.as_array()).map(|arr| {
                        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                    }).unwrap_or_default();
                    (p, fb)
                }
                _ => (String::new(), vec![]),
            };
            agents.push(AgentSetting { id, primary, fallbacks, thinking: String::new() });
        }
    }

    // auth profiles from main agent dir (where we copied them to all agents)
    let profile_path = std::env::var("USERPROFILE").map(|h| {
        std::path::PathBuf::from(h).join(".openclaw").join("agents").join("main").join("agent").join("auth-profiles.json")
    }).map_err(|e| format!("USERPROFILE: {e}"))?;
    let mut profiles = Vec::new();
    if let Ok(txt) = std::fs::read_to_string(&profile_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(map) = v.get("profiles").and_then(|p| p.as_object()) {
                for (pid, val) in map {
                    profiles.push(ProviderProfile {
                        profile_id: pid.clone(),
                        provider: val.get("provider").and_then(|s| s.as_str()).unwrap_or("?").to_string(),
                        auth_type: val.get("type").and_then(|s| s.as_str()).unwrap_or("?").to_string(),
                    });
                }
            }
        }
    }
    // Per-agent thinking levels live in our own .crime-team.json — scoped
    // by active group: perGroupThinking.<groupId>.<role> = "high".
    let ct = read_crime_team_json();
    let role_map = ct
        .get("perGroupThinking")
        .and_then(|m| m.as_object())
        .and_then(|g| g.get(&active_id))
        .and_then(|m| m.as_object());
    if let Some(map) = role_map {
        for a in agents.iter_mut() {
            // a.id is fully-qualified; map keys are roles (unprefixed).
            let role = a.id.strip_prefix(&group_prefix).unwrap_or(&a.id);
            if let Some(v) = map.get(role).and_then(|v| v.as_str()) {
                a.thinking = v.to_string();
            }
        }
    }
    Ok(SettingsSnapshot { agents, profiles })
}

#[tauri::command]
async fn settings_add_provider(provider: String, profile_id: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() { return Err("empty api key".into()); }
    let _ = run_openclaw(
        &["models", "auth", "paste-api-key", "--provider", &provider, "--profile-id", &profile_id],
        Some(api_key.trim().as_bytes()),
    ).await?;

    // Mirror the key into every specialist agent's auth-profiles.json — same
    // approach as our manual fix. Without this, the per-agent auth-store would
    // be empty and openclaw would re-prompt.
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    let src = std::path::PathBuf::from(&home).join(".openclaw").join("agents").join("main").join("agent").join("auth-profiles.json");
    // Mirror into every agent of the active group.
    let group = active_group()?;
    let mut all_ids = group.specialists.clone();
    all_ids.push(group.producer_agent_id.clone());
    for agent_id in &all_ids {
        let dest = std::path::PathBuf::from(&home).join(".openclaw").join("agents").join(agent_id).join("auth-profiles.json");
        let _ = std::fs::copy(&src, &dest);
    }
    Ok(())
}

#[tauri::command]
async fn settings_set_agent_model(agent_id: String, primary: String) -> Result<(), String> {
    // Read agents.list, find the agent, set its model.primary while preserving fallbacks.
    let agents_json = run_openclaw(&["config", "get", "agents.list"], None).await?;
    let mut list: serde_json::Value = serde_json::from_str(&agents_json)
        .map_err(|e| format!("parse agents.list: {e}"))?;
    if let Some(arr) = list.as_array_mut() {
        let mut found = false;
        for a in arr.iter_mut() {
            if a.get("id").and_then(|s| s.as_str()) == Some(&agent_id) {
                // promote a string-form model into an object so we can set primary
                let existing_fb = match a.get("model") {
                    Some(serde_json::Value::Object(m)) => {
                        m.get("fallbacks").cloned().unwrap_or_else(|| serde_json::json!([]))
                    }
                    _ => serde_json::json!([]),
                };
                a["model"] = serde_json::json!({
                    "primary": primary,
                    "fallbacks": existing_fb,
                });
                found = true;
                break;
            }
        }
        if !found { return Err(format!("agent '{agent_id}' not found")); }
    }
    let payload = serde_json::json!({ "agents": { "list": list } });
    let payload_s = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let _ = run_openclaw(
        &["config", "patch", "--stdin", "--replace-path", "agents.list"],
        Some(payload_s.as_bytes()),
    ).await?;
    Ok(())
}

/// Path to the orchestrator's .crime-team.json. We store per-agent thinking
/// here, NOT in OpenClaw's agents.list — there's no per-agent thinking field
/// in OpenClaw's schema. The orchestrator reads this file at run time and
/// passes `--thinking <level>` on each `openclaw agent` invocation.
fn crime_team_json_path() -> PathBuf {
    orchestrator_root().join(".crime-team.json")
}

fn read_crime_team_json() -> serde_json::Value {
    match std::fs::read_to_string(crime_team_json_path()) {
        Ok(t) => serde_json::from_str(&t).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

fn write_crime_team_json(v: &serde_json::Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(crime_team_json_path(), pretty).map_err(|e| format!("write .crime-team.json: {e}"))
}

/// Set or clear an agent's thinking-level override in .crime-team.json,
/// scoped under the agent's own group derived from its id prefix.
/// agent_id MUST be fully-qualified ("crimeos.architect") — we split on the
/// first '.' to get group + role. Falls back to active group on unprefixed id.
#[tauri::command]
async fn settings_set_agent_thinking(agent_id: String, thinking: String) -> Result<(), String> {
    const VALID: &[&str] = &["", "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"];
    if !VALID.contains(&thinking.as_str()) {
        return Err(format!("invalid thinking level '{thinking}' — valid: {VALID:?}"));
    }
    // Derive group from the agent's id prefix; fall back to active for legacy / unprefixed ids.
    let (group_id, role) = match agent_id.split_once('.') {
        Some((g, r)) => (g.to_string(), r.to_string()),
        None => (active_group_id()?, agent_id.clone()),
    };

    let mut cfg = read_crime_team_json();
    if !cfg.is_object() { cfg = serde_json::json!({}); }
    let obj = cfg.as_object_mut().unwrap();
    let group_thinking_root = obj
        .entry("perGroupThinking".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let group_map = group_thinking_root
        .as_object_mut()
        .ok_or("perGroupThinking is not an object")?;
    let role_map_entry = group_map
        .entry(group_id.clone())
        .or_insert_with(|| serde_json::json!({}));
    let role_map = role_map_entry
        .as_object_mut()
        .ok_or_else(|| format!("perGroupThinking.{group_id} is not an object"))?;
    if thinking.is_empty() { role_map.remove(&role); }
    else { role_map.insert(role, serde_json::Value::String(thinking)); }
    write_crime_team_json(&cfg)
}

#[tauri::command]
async fn settings_restart_gateway() -> Result<(), String> {
    let _ = run_openclaw(&["gateway", "restart"], None).await?;
    Ok(())
}

/// Delete a provider profile from every agent's auth-profiles.json.
#[tauri::command]
async fn settings_remove_provider(profile_id: String) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE: {e}"))?;
    // Build the path list dynamically from the active group's agents (+ main).
    let mut paths: Vec<PathBuf> = vec![
        std::path::PathBuf::from(&home).join(".openclaw").join("agents").join("main").join("agent").join("auth-profiles.json"),
    ];
    if let Ok(group) = active_group() {
        let mut ids = group.specialists.clone();
        ids.push(group.producer_agent_id.clone());
        for id in ids {
            paths.push(std::path::PathBuf::from(&home).join(".openclaw").join("agents").join(&id).join("auth-profiles.json"));
        }
    }
    let mut removed_anywhere = false;
    for path in &paths {
        if !path.exists() { continue; }
        let txt = std::fs::read_to_string(path).map_err(|e| format!("read {path:?}: {e}"))?;
        let mut v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("parse {path:?}: {e}"))?;
        if let Some(obj) = v.get_mut("profiles").and_then(|p| p.as_object_mut()) {
            if obj.remove(&profile_id).is_some() {
                removed_anywhere = true;
                let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
                std::fs::write(path, out).map_err(|e| format!("write {path:?}: {e}"))?;
            }
        }
    }
    if !removed_anywhere {
        return Err(format!("profile '{profile_id}' was not found in any agent auth store"));
    }
    Ok(())
}

/// Try a 1-token inference against the named provider's representative model.
/// Returns the model's reply on success; returns a stripped error on failure.
#[tauri::command]
async fn settings_test_provider(provider: String) -> Result<String, String> {
    let model = match provider.as_str() {
        "anthropic"  => "anthropic/claude-opus-4-7",
        "google"     => "google/gemini-2.5-flash",
        "openrouter" => "openrouter/google/gemma-4-31b-it:free",
        "deepseek"   => "deepseek/deepseek-chat",
        "openai"     => "openai/gpt-5.3",
        "mistral"    => "mistral/codestral-latest",
        "groq"       => "groq/llama-3.3-70b-versatile",
        "together"   => "together/deepseek-ai/DeepSeek-V3",
        "cerebras"   => "cerebras/llama3.1-8b",
        other => return Err(format!("no test model wired for provider '{other}'")),
    };
    let out = run_openclaw(
        &["infer", "model", "run", "--local", "--model", model, "--prompt", "Reply with exactly: ok"],
        None,
    ).await;
    match out {
        Ok(text) => {
            // The CLI prints header lines + the reply. Pull the last non-empty line.
            let last = text.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").trim().to_string();
            if last.is_empty() {
                Err("no output returned".into())
            } else {
                Ok(last)
            }
        }
        Err(e) => {
            // Trim long Google/OpenRouter error noise to the actually useful sentence.
            let short = e.lines().filter(|l| !l.trim().is_empty()).next().unwrap_or(&e).trim().to_string();
            Err(short)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(RunState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_task,
            cancel_run,
            list_runs,
            get_run,
            orchestrator_path,
            settings_get,
            settings_add_provider,
            settings_set_agent_model,
            settings_restart_gateway,
            settings_remove_provider,
            settings_test_provider,
            settings_set_agent_thinking,
            groups_list,
            groups_get_active,
            groups_set_active,
            groups_browse_directory,
            groups_scan_project,
            groups_create,
            groups_get_presets,
            groups_set_presets,
            groups_edit,
            groups_remove,
            groups_get_prompt,
            groups_set_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
