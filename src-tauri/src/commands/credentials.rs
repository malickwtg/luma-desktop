// OS keychain storage for the LUMA MCP token.
//
// SECURITY: there is deliberately NO command that returns the token to the
// WebView. `store_luma_token` takes it in once (the web obtains it from
// /api/desktop/provision-token and hands it over), `has_luma_token` returns a
// bool, and the agent session reads it internally (commands/agent.rs) to inject
// into the sidecar. The token never crosses the IPC boundary back to JS.

use keyring::{Entry, Error as KeyringError};

pub const KEYCHAIN_SERVICE: &str = "es.waytogrow.luma.desktop";
pub const KEYCHAIN_ACCOUNT: &str = "luma-mcp-token";

pub fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_luma_token(token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Token vacío".into());
    }
    token_entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_luma_token() -> bool {
    matches!(token_entry(), Ok(e) if e.get_password().is_ok())
}

#[tauri::command]
pub fn clear_luma_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
