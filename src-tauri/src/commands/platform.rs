#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "mac".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else {
        "linux".into()
    }
}

/// App version (from Cargo), so error telemetry can say WHICH release failed.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
