// In-memory storage for the LUMA MCP token.
//
// SECURITY: there is deliberately NO command that returns the token to the
// WebView. `store_luma_token` takes it in once (the web obtains it from
// /api/desktop/provision-token and hands it over), `has_luma_token` returns a
// bool, and the agent session reads it internally (commands/agent.rs) to inject
// into the sidecar. The token never crosses the IPC boundary back to JS.
//
// Kept in the Rust process memory (AgentState), not the OS keychain: an ad-hoc
// signed app cannot reliably read keychain items back (the signature isn't
// stable across launches), and the token is read-only + short-lived, so
// re-provisioning each launch is fine (and rotates the previous one server-side).

use crate::AgentState;
use tauri::State;

#[tauri::command]
pub fn store_luma_token(token: String, state: State<AgentState>) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Token vacío".into());
    }
    *state.token.lock().map_err(|_| "estado bloqueado")? = Some(token);
    Ok(())
}

#[tauri::command]
pub fn has_luma_token(state: State<AgentState>) -> bool {
    state.token.lock().map(|g| g.is_some()).unwrap_or(false)
}

#[tauri::command]
pub fn clear_luma_token(state: State<AgentState>) -> Result<(), String> {
    *state.token.lock().map_err(|_| "estado bloqueado")? = None;
    Ok(())
}
