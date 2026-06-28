// Agent session lifecycle: spawn the Node sidecar (Claude Agent SDK), stream its
// output to the WebView, forward user messages to its stdin, and stop it cleanly.

use crate::commands::credentials::token_entry;
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

    let token = token_entry()?
        .get_password()
        .map_err(|_| "No hay token de LUMA. Conéctate primero.".to_string())?;

    let sidecar = sidecar_path()?;
    let mut child = Command::new("node")
        .arg(&sidecar)
        .env("LUMA_MCP_URL", MCP_URL)
        .env("LUMA_MCP_TOKEN", token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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

/// Resolve the sidecar entry point. Dev: `../sidecar/src/index.mjs` next to the
/// crate. Override with `LUMA_SIDECAR_PATH`. Release bundling (externalBin) is a
/// follow-up (see README → Packaging).
fn sidecar_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("LUMA_SIDECAR_PATH") {
        return Ok(PathBuf::from(p));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("sidecar").join("src").join("index.mjs"))
        .ok_or("No se pudo resolver la ruta del sidecar")?;
    if dev.exists() {
        Ok(dev)
    } else {
        Err("No se encontró el sidecar. Define LUMA_SIDECAR_PATH.".into())
    }
}
