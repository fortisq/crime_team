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
async fn settings_get() -> Result<SettingsSnapshot, String> {
    // agents.list — JSON array
    let agents_json = run_openclaw(&["config", "get", "agents.list"], None).await?;
    let agents_v: serde_json::Value = serde_json::from_str(&agents_json)
        .map_err(|e| format!("parse agents.list: {e}"))?;
    let active_id = active_group_id().unwrap_or_else(|_| String::new());
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
/// scoped under the active group (perGroupThinking.<groupId>.<role>).
/// agent_id may be fully-qualified ("crimeos.architect") or just the role.
#[tauri::command]
async fn settings_set_agent_thinking(agent_id: String, thinking: String) -> Result<(), String> {
    const VALID: &[&str] = &["", "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"];
    if !VALID.contains(&thinking.as_str()) {
        return Err(format!("invalid thinking level '{thinking}' — valid: {VALID:?}"));
    }
    let group_id = active_group_id()?;
    // Strip the group prefix if present, so the storage key is just the role.
    let prefix = format!("{group_id}.");
    let role = agent_id.strip_prefix(&prefix).unwrap_or(&agent_id).to_string();

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
