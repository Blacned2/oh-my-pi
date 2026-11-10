//! In-app toast: a small frameless always-on-top window in the bottom-right of the work area,
//! shown when a chat finishes a turn (or asks a question) while that chat is not open; the page decides.
//! Clicking it restores the main window and tells the page which session to open (`notify-activate`).

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";
const TOAST_WINDOW: &str = "toast";
/// Logical size; the card inside leaves a margin for its CSS shadow.
const TOAST_W: f64 = 392.0;
const TOAST_H: f64 = 116.0;
const EDGE_MARGIN: f64 = 4.0;

pub fn restore_main(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Shows a toast for session `sid`; the page only calls this when that chat is not open.
/// Returns whether a toast was shown. Async: building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn notify_reply(handle: AppHandle, sid: String, title: String, body: String) -> Result<bool, String> {
    let Some(main) = handle.get_webview_window(MAIN_WINDOW) else { return Ok(false) };
    if let Some(old) = handle.get_webview_window(TOAST_WINDOW) {
        let _ = old.destroy();
    }
    let url = format!(
        "toast.html?sid={}&title={}&body={}",
        percent_encode(&sid),
        percent_encode(&title),
        percent_encode(&body)
    );
    let toast = WebviewWindowBuilder::new(&handle, TOAST_WINDOW, WebviewUrl::App(url.into()))
        .inner_size(TOAST_W, TOAST_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;

    let monitor = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| handle.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let w = (TOAST_W * scale) as i32;
        let h = (TOAST_H * scale) as i32;
        let margin = (EDGE_MARGIN * scale) as i32;
        let x = area.position.x + area.size.width as i32 - w - margin;
        let y = area.position.y + area.size.height as i32 - h - margin;
        let _ = toast.set_position(tauri::PhysicalPosition::new(x, y));
    }
    Ok(true)
}

/// Toast clicked: bring the app back and open the session.
#[tauri::command]
pub fn toast_activate(handle: AppHandle, sid: String) {
    restore_main(&handle);
    let _ = handle.emit_to(MAIN_WINDOW, "notify-activate", sid);
    toast_close(handle);
}

#[tauri::command]
pub fn toast_close(handle: AppHandle) {
    if let Some(toast) = handle.get_webview_window(TOAST_WINDOW) {
        let _ = toast.destroy();
    }
}
