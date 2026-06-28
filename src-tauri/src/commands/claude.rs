use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
}

/// Is the `claude` CLI reachable? NOTE: a GUI app inherits a minimal PATH, so
/// `claude` installed under ~/.local/bin may not be found even when present.
/// The sidecar uses the Agent SDK's bundled binary, so this is an onboarding
/// hint, not a hard dependency.
#[tauri::command]
pub fn check_claude_installed() -> ClaudeStatus {
    match Command::new("claude").arg("--version").output() {
        Ok(out) if out.status.success() => ClaudeStatus {
            installed: true,
            version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        },
        _ => ClaudeStatus {
            installed: false,
            version: None,
        },
    }
}

/// Best-effort: is Claude authenticated? The Agent SDK authenticates via the
/// user's Claude credentials (subscription/OAuth) or `ANTHROPIC_API_KEY`.
#[tauri::command]
pub fn check_claude_auth() -> Result<bool, String> {
    if std::env::var("ANTHROPIC_API_KEY").is_ok() {
        return Ok(true);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "No se pudo resolver el directorio del usuario".to_string())?;
    let dir = Path::new(&home).join(".claude");
    Ok(dir.join(".credentials.json").exists() || dir.join("credentials.json").exists())
}
