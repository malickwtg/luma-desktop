fn main() {
    // Declare the custom commands so the ACL generates permissions for them.
    // Required for the REMOTE webview (luma.waytogrow.es) to invoke them — the
    // capability then allows each via `allow-<command>` (see capabilities/main.json).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_platform",
            "get_app_version",
            "check_claude_installed",
            "check_claude_auth",
            "store_luma_token",
            "has_luma_token",
            "clear_luma_token",
            "start_agent_session",
            "send_message",
            "stop_agent_session",
            "history_save",
            "history_list",
            "history_load",
            "history_delete",
        ])),
    )
    .expect("failed to run tauri-build");
}
