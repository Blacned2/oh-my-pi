//! omp's own settings (`config.yml` in the agent dir), read and written through `omp config`
//! so validation, defaults and layering stay omp's.

use crate::runtime::omp_command;

fn run(args: &[&str]) -> Result<String, String> {
    let out = omp_command()?
        .args(args)
        .output()
        .map_err(|e| format!("Could not run omp: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = strip_ansi(if stderr.trim().is_empty() { &stdout } else { &stderr });
    Err(msg.trim().to_string())
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// `omp config list --json`, raw (the UI parses it). Runs off the main thread: omp takes a moment to start.
#[tauri::command]
pub async fn omp_config_list() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| run(&["config", "list", "--json"]))
        .await
        .map_err(|e| e.to_string())?
}

/// `omp config set <key> <value> --json`; `value` is text in omp's own syntax (JSON for arrays/records).
#[tauri::command]
pub async fn omp_config_set(key: String, value: String) -> Result<String, String> {
    // omp treats arguments starting with "-" as flags; it trims values, so a leading space is harmless.
    let value = if value.starts_with('-') { format!(" {value}") } else { value };
    tauri::async_runtime::spawn_blocking(move || run(&["config", "set", &key, &value, "--json"]))
        .await
        .map_err(|e| e.to_string())?
}

/// `omp config reset <key> --json`: removes the key so the default applies again.
#[tauri::command]
pub async fn omp_config_reset(key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run(&["config", "reset", &key, "--json"]))
        .await
        .map_err(|e| e.to_string())?
}
