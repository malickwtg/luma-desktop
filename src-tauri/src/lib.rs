// LUMA Desktop — Tauri shell.
//
// Architecture (see ../../README.md and the LUMA plan):
//   WebView (remote luma.waytogrow.es)
//     -> tauri::invoke (scoped to the remote origin by capabilities/main.json)
//   Rust (this crate): launcher + OS keychain + process lifecycle
//     -> spawns a Node sidecar running @anthropic-ai/claude-agent-sdk
//        -> the Agent SDK talks to LUMA's MCP over Streamable HTTP + Bearer token
//
// Security invariants enforced here:
//   - The MCP token is stored in the OS keychain and injected into the sidecar
//     via an env var. NO command ever returns it to the WebView.
//   - The Node sidecar (and the `claude` process it spawns) is killed when the
//     window is destroyed or the app exits — no orphan holding a live token.

mod commands;

use std::process::Child;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WindowEvent};

/// Holds the running Node sidecar (the Claude Agent SDK host) and the in-memory
/// read-only MCP token. The token is kept in the Rust process (NOT the OS
/// keychain — ad-hoc-signed apps can't reliably read it back, and NOT the
/// WebView) and re-provisioned each launch.
#[derive(Default)]
pub struct AgentState {
    pub child: Mutex<Option<Child>>,
    pub token: Mutex<Option<String>>,
}

impl AgentState {
    /// Kill the sidecar and reap it. Best-effort; safe to call repeatedly.
    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_app_version,
            commands::check_claude_installed,
            commands::check_claude_auth,
            commands::store_luma_token,
            commands::has_luma_token,
            commands::clear_luma_token,
            commands::start_agent_session,
            commands::send_message,
            commands::stop_agent_session,
            commands::history_save,
            commands::history_list,
            commands::history_load,
            commands::history_delete,
        ])
        .setup(|app| {
            // Create the main window pointing at the remote LUMA web, and inject
            // the self-contained chat overlay (runs before page scripts, not
            // subject to the page CSP). Built in Rust (not tauri.conf.json) so we
            // can attach the initialization_script.
            let url: tauri::Url = "https://luma.waytogrow.es"
                .parse()
                .expect("URL de LUMA inválida");
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("LUMA")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1200.0, 700.0)
                .initialization_script(include_str!("overlay.js"))
                .build()?;

            // Check for updates on startup; if one is available, prompt with a
            // native dialog and (on accept) download, install, and relaunch.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                use tauri_plugin_updater::UpdaterExt;
                let updater = match handle.updater() {
                    Ok(u) => u,
                    Err(e) => {
                        eprintln!("[updater] init failed: {e}");
                        return;
                    }
                };
                if let Ok(Some(update)) = updater.check().await {
                    let install = handle
                        .dialog()
                        .message(format!(
                            "Hay una nueva versión de LUMA ({}). ¿Instalarla ahora? La app se reiniciará.",
                            update.version
                        ))
                        .title("Actualización disponible")
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Instalar".to_string(),
                            "Ahora no".to_string(),
                        ))
                        .blocking_show();
                    if install {
                        match update.download_and_install(|_, _| {}, || {}).await {
                            Ok(()) => handle.restart(),
                            Err(e) => eprintln!("[updater] install failed: {e}"),
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                // No orphan sidecar/claude process holding a live MCP token.
                window.state::<AgentState>().kill();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building LUMA Desktop")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                app.state::<AgentState>().kill();
            }
        });
}
