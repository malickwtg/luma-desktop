// Conversation history — file-based persistence in the app data dir.
//
// PRIVACY: threads can contain business figures, so they are written ONLY to the
// per-app, per-user data dir (~/Library/Application Support/
// es.waytogrow.luma.desktop/history on macOS), which the OS user account
// protects. At-rest protection is the OS disk encryption (FileVault). We keep the
// dependency surface minimal on purpose (no SQL crate) — the format is plain JSON
// and never leaves the machine. The id is sanitized to prevent path traversal.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMsg {
    pub role: String,
    pub text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryThread {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub messages: Vec<HistoryMsg>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub count: usize,
}

/// Keep only filename-safe chars so a crafted id can't escape the history dir.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn history_save(app: AppHandle, thread: HistoryThread) -> Result<(), String> {
    let id = sanitize_id(&thread.id);
    if id.is_empty() {
        return Err("id inválido".into());
    }
    let path = history_dir(&app)?.join(format!("{id}.json"));
    let json = serde_json::to_string(&thread).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_list(app: AppHandle) -> Result<Vec<HistoryMeta>, String> {
    let dir = history_dir(&app)?;
    let mut metas: Vec<HistoryMeta> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(t) = serde_json::from_str::<HistoryThread>(&data) {
                metas.push(HistoryMeta {
                    id: t.id,
                    title: t.title,
                    created_at: t.created_at,
                    count: t.messages.len(),
                });
            }
        }
    }
    // ISO-8601 strings sort lexically == chronologically; newest first.
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(metas)
}

#[tauri::command]
pub fn history_load(app: AppHandle, id: String) -> Result<HistoryThread, String> {
    let id = sanitize_id(&id);
    let path = history_dir(&app)?.join(format!("{id}.json"));
    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> Result<(), String> {
    let id = sanitize_id(&id);
    if id.is_empty() {
        return Ok(());
    }
    let path = history_dir(&app)?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
