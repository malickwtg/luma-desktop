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
