// Native confirmation dialog for money writes (PR2 of C7).
//
// The chat preview card (rendered by the remote web inside the WebView) is just a
// preview — it could be spoofed by an XSS on luma.waytogrow.es. The COMMIT of a
// money action goes through THIS native OS dialog, which the web cannot draw or
// click programmatically. Returns true only when the user explicitly confirms.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
pub fn confirm_invoice(app: AppHandle, summary: String) -> bool {
    app.dialog()
        .message(summary)
        .title("Confirmar facturación")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Facturar".to_string(),
            "Cancelar".to_string(),
        ))
        .blocking_show()
}

/// Generic native confirmation for ANY write the assistant wants to perform
/// (create/update/delete/invoice/...). The agent can NEVER write without this
/// explicit OK: the sidecar's canUseTool blocks every write tool until the human
/// confirms here. Returns true only on explicit confirm.
#[tauri::command]
pub fn confirm_action(app: AppHandle, summary: String) -> bool {
    app.dialog()
        .message(summary)
        .title("Confirmar acción del asistente")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Permitir".to_string(),
            "Cancelar".to_string(),
        ))
        .blocking_show()
}
