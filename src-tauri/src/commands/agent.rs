// Agent session lifecycle: spawn the Node sidecar (Claude Agent SDK), stream its
// output to the WebView, forward user messages to its stdin, and stop it cleanly.

use crate::AgentState;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{Emitter, State, Window};

const MCP_URL: &str = "https://luma.waytogrow.es/api/mcp";

/// Start the Claude Agent SDK sidecar. Reads the MCP token from the keychain
/// (never from the WebView) and injects it via env. Streams stdout JSON lines to
/// the `agent-event` window event and stderr to `agent-stderr`.
#[tauri::command]
pub fn start_agent_session(window: Window, state: State<AgentState>) -> Result<(), String> {
    {
        let guard = state.child.lock().map_err(|_| "estado bloqueado")?;
        if guard.is_some() {
            return Ok(()); // already running
        }
    }

    let token = {
        let guard = state.token.lock().map_err(|_| "estado bloqueado")?;
        guard
            .clone()
            .ok_or_else(|| "No hay token de LUMA. Conéctate primero.".to_string())?
    };

    let mut cmd = build_sidecar_command();
    cmd.env("LUMA_MCP_URL", MCP_URL);
    cmd.env("LUMA_MCP_TOKEN", token);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo iniciar el asistente: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let win = window.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = win.emit("agent-event", line);
            }
            let _ = win.emit("agent-event", r#"{"type":"sidecar-exit"}"#.to_string());
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let win = window.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = win.emit("agent-stderr", line);
            }
        });
    }

    *state.child.lock().map_err(|_| "estado bloqueado")? = Some(child);
    Ok(())
}

/// Forward a user message to the running sidecar's stdin.
#[tauri::command]
pub fn send_message(message: String, state: State<AgentState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "estado bloqueado")?;
    let child = guard.as_mut().ok_or("El asistente no está iniciado")?;
    let stdin = child.stdin.as_mut().ok_or("stdin no disponible")?;
    let payload = serde_json::json!({ "type": "user", "text": message }).to_string();
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Kill the sidecar (and the `claude` process it spawned).
#[tauri::command]
pub fn stop_agent_session(state: State<AgentState>) -> Result<(), String> {
    state.kill();
    Ok(())
}

/// Build the Command that launches the sidecar.
/// - Packaged app: the bun-compiled `luma-sidecar` externalBin sits next to the
///   main executable, with the `claude` externalBin alongside (passed via
///   LUMA_CLAUDE_PATH so the Agent SDK uses the bundled binary).
/// - Dev: `node ../sidecar/src/index.mjs` (override with LUMA_SIDECAR_PATH); the
///   SDK resolves its own claude from node_modules.
fn build_sidecar_command() -> Command {
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let sidecar = dir.join("luma-sidecar");
        if sidecar.exists() {
            let mut c = Command::new(&sidecar);
            let claude = dir.join("claude");
            if claude.exists() {
                c.env("LUMA_CLAUDE_PATH", &claude);
            }
            return c;
        }
    }
    // Dev fallback.
    let mjs = std::env::var("LUMA_SIDECAR_PATH").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("sidecar").join("src").join("index.mjs"))
            .unwrap_or_default()
    });
    let mut c = Command::new("node");
    c.arg(mjs);
    c
}
