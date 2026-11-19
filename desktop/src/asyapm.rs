//! AsyaPM panel backend: one generic bridge to `omp asyapm <action> [flags]`, which prints exactly one
//! JSON document on stdout. The CLI owns `asyapm.json`; the desktop never reads or writes it.

use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::Stdio;

use crate::runtime::omp_command;
use crate::CREATE_NO_WINDOW;

const ACTIONS: &[&str] = &[
    "orgs", "org-set", "org-remove", "projects", "board", "issues", "issue", "comments", "set-status", "comment", "brief",
];

fn run(args: Vec<String>, stdin: Option<String>) -> Result<serde_json::Value, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    if !ACTIONS.contains(&action) {
        return Err(format!("Unknown AsyaPM action: {action:?}"));
    }
    let mut cmd = omp_command()?;
    cmd.arg("asyapm")
        .args(&args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("Could not run omp: {e}"))?;
    // Feed stdin from a thread so a large body cannot deadlock against the child's output pipes.
    let writer = stdin.and_then(|text| {
        child.stdin.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
                // dropping `pipe` closes the child's stdin
            })
        })
    });
    let out = child.wait_with_output().map_err(|e| format!("Could not run omp: {e}"))?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        Ok(value) => {
            if let Some(err) = value.get("error").filter(|e| e.is_object()) {
                let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("AsyaPM request failed");
                return Err(msg.to_string());
            }
            if out.status.success() {
                Ok(value)
            } else {
                Err(failure_text(&stderr, &stdout))
            }
        }
        Err(_) if out.status.success() => Err(format!("omp asyapm printed no JSON: {}", failure_text(&stderr, &stdout))),
        Err(_) => Err(failure_text(&stderr, &stdout)),
    }
}

fn failure_text(stderr: &str, stdout: &str) -> String {
    let text = if stderr.trim().is_empty() { stdout } else { stderr };
    let text = text.trim();
    if text.is_empty() { "omp asyapm failed".to_string() } else { text.to_string() }
}

/// `omp asyapm <args...>`; `stdin` (a token, a comment body, or the brief's JSON extras) goes to the child's stdin, never argv.
#[tauri::command]
pub async fn asyapm_cli(args: Vec<String>, stdin: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(args, stdin))
        .await
        .map_err(|e| e.to_string())?
}
