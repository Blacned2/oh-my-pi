//! Bridge between the WebView and `omp --mode rpc-ui` child processes, one per chat session.
//!
//! The wire protocol is newline-delimited JSON (docs/rpc.md). This module does not
//! interpret it: stdout lines are forwarded verbatim as `rpc-frames` events (payload
//! `[sessionId, lines]`, each batch holding the lines one pipe read delivered) and lines
//! from the UI are written to the stdin of the session they name, so protocol changes
//! upstream never need a Rust change.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::CREATE_NO_WINDOW;

#[derive(Default)]
pub struct RpcState {
    /// Running sessions by the id the UI chose. Locked only for map operations, never across a
    /// kill or a spawn, so `rpc_send` (UI thread) never waits behind one.
    sessions: Mutex<HashMap<String, Session>>,
    /// Held for the whole of every start, stop and `shutdown` so they never interleave.
    lifecycle: Mutex<()>,
}

struct Session {
    child: Option<Child>,
    /// Feeds the writer thread that owns the child's stdin; dropping it closes stdin.
    stdin: Option<Sender<String>>,
    /// Unique per start so a stale reader thread cannot report the exit of a newer process
    /// that reuses the same session id.
    generation: u64,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Blocks until the process tree has exited; never call it with the `sessions` lock held.
fn stop(session: &mut Session) {
    session.stdin = None; // writer drains its queue, then EOF: omp drains and exits by itself
    if let Some(mut child) = session.child.take() {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Writes queued lines to the child's stdin off the UI thread, in queue order.
fn spawn_writer(mut stdin: ChildStdin) -> Sender<String> {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in rx {
            let written = stdin
                .write_all(line.trim_end().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush());
            if written.is_err() {
                break;
            }
        }
    });
    tx
}

/// Start (or restart) session `id` in `cwd`. Returns the working directory in use.
#[tauri::command]
pub async fn rpc_start(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    resume: Option<bool>,
    session: Option<String>,
    model: Option<String>,
    agent_prompt: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let dir = match cwd.filter(|c| !c.trim().is_empty()) {
            Some(c) => std::path::PathBuf::from(c),
            None => std::env::current_dir().map_err(|e| e.to_string())?,
        };
        if !dir.is_dir() {
            return Err(format!("Not a directory: {}", dir.display()));
        }
        // An explicit model wins over the resumed session's model; unlike RPC `set_model` it leaves
        // the user's global default untouched. Validated before the running session is stopped.
        let model = model.as_deref().map(str::trim).filter(|m| !m.is_empty());
        if model.is_some_and(|m| m.starts_with('-') || m.chars().any(char::is_control)) {
            return Err("Invalid model.".into());
        }
        // Agent whose instructions are appended to the system prompt; same validation as `model`.
        let agent_prompt = agent_prompt.as_deref().map(str::trim).filter(|a| !a.is_empty());
        if agent_prompt.is_some_and(|a| a.starts_with('-') || a.chars().any(char::is_control)) {
            return Err("Invalid agent prompt.".into());
        }

        let state = app.state::<RpcState>();
        let _lifecycle = state.lifecycle.lock().unwrap();
        // The old process must have exited before the new one spawns: a resume needs the session
        // lease it holds.
        let old = state.sessions.lock().unwrap().remove(&id);
        if let Some(mut old) = old {
            stop(&mut old);
        }

        let mut cmd = crate::runtime::omp_command()?;
        cmd.args(["--mode", "rpc-ui"]);
        if let Some(model) = model {
            cmd.args(["--model", model]);
        }
        if let Some(agent) = agent_prompt {
            cmd.args(["--append-agent-prompt", agent]);
        }
        // An exact session file (a restored session) wins over "continue the folder's latest"; a file
        // that has since been deleted falls back to a fresh session rather than failing to start.
        match session {
            Some(file) if std::path::Path::new(&file).is_file() => {
                cmd.args(["--resume", &file]);
            }
            Some(_) => {}
            None if resume.unwrap_or(false) => {
                cmd.arg("--continue");
            }
            None => {}
        }
        let mut child = cmd
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Could not start omp: {e}"))?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        state.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                stdin: child.stdin.take().map(spawn_writer),
                child: Some(child),
                generation,
            },
        );

        // Started only after the insert: the exit check below looks its generation up in the map.
        let out_app = app.clone();
        let out_id = id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            let mut lines: Vec<String> = Vec::new();
            let mut eof = false;
            while !eof {
                // Block for one line, then batch every complete line the same pipe read already
                // buffered; never wait for more data before emitting.
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            eof = true;
                            break;
                        }
                        Ok(_) => {}
                    }
                    if line.ends_with('\n') {
                        line.pop();
                        if line.ends_with('\r') {
                            line.pop();
                        }
                    }
                    if !line.trim().is_empty() {
                        lines.push(line);
                    }
                    if !reader.buffer().contains(&b'\n') {
                        break;
                    }
                }
                if !lines.is_empty() {
                    let _ = out_app.emit("rpc-frames", (&out_id, &lines));
                    lines.clear();
                }
            }
            let current = out_app
                .state::<RpcState>()
                .sessions
                .lock()
                .unwrap()
                .get(&out_id)
                .map(|s| s.generation);
            if current == Some(generation) {
                let _ = out_app.emit("rpc-exit", &out_id);
            }
        });

        let err_app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = err_app.emit("rpc-stderr", (&id, line));
            }
        });

        Ok(dir.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write one JSON line to the stdin of session `id`.
#[tauri::command]
pub fn rpc_send(state: State<RpcState>, id: String, line: String) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let stdin = sessions
        .get(&id)
        .and_then(|s| s.stdin.as_ref())
        .ok_or("agent is not running")?;
    stdin.send(line).map_err(|_| "agent is not running".to_string())
}

/// Native folder picker (STA PowerShell + WinForms; no extra crate). `None` when cancelled.
#[tauri::command]
pub async fn pick_folder(start: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = "Add-Type -AssemblyName System.Windows.Forms; \
            $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
            if ($env:KOSTOMP_PICK_START -and (Test-Path -LiteralPath $env:KOSTOMP_PICK_START)) { $d.SelectedPath = $env:KOSTOMP_PICK_START }; \
            if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
        let out = Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .env("KOSTOMP_PICK_START", start.unwrap_or_default())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!path.is_empty()).then_some(path)
    })
    .await
    .ok()
    .flatten()
}

#[derive(serde::Serialize)]
pub struct DirEntryInfo {
    name: String,
    path: String,
    /// Seconds since the Unix epoch.
    modified: Option<u64>,
    /// Number of entries directly inside (None when unreadable).
    items: Option<usize>,
    git: bool,
    project: bool,
}

#[derive(serde::Serialize)]
pub struct DirListing {
    path: String,
    parent: Option<String>,
    dirs: Vec<DirEntryInfo>,
    /// Image files, only filled when the caller asked for them.
    files: Vec<FileInfo>,
}

#[derive(serde::Serialize)]
pub struct FileInfo {
    name: String,
    path: String,
    modified: Option<u64>,
    size: u64,
}

const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];

/// Raw bytes of an image file (arrives in JS as an ArrayBuffer).
#[tauri::command]
pub async fn read_image(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = std::path::Path::new(&path)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            return Err("not an image file".into());
        }
        std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct PlaceInfo {
    name: String,
    path: String,
    kind: &'static str,
}

fn dir_entry(path: &std::path::Path, name: String) -> DirEntryInfo {
    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let mut items = None;
    let mut project = false;
    if let Ok(rd) = std::fs::read_dir(path) {
        let mut n = 0;
        for e in rd.filter_map(Result::ok) {
            n += 1;
            let f = e.file_name().to_string_lossy().to_ascii_lowercase();
            if matches!(f.as_str(), "package.json" | "cargo.toml" | "pyproject.toml" | "go.mod" | "pom.xml")
                || f.ends_with(".sln")
                || f.ends_with(".csproj")
            {
                project = true;
            }
        }
        items = Some(n);
    }
    DirEntryInfo {
        name,
        path: path.display().to_string(),
        modified,
        items,
        git: path.join(".git").exists(),
        project,
    }
}

/// Drives and the user's well-known folders, for the in-app folder browser sidebar.
#[tauri::command]
pub async fn list_places() -> Result<Vec<PlaceInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        if let Ok(home) = std::env::var("USERPROFILE") {
            for name in ["Desktop", "Documents", "Downloads"] {
                let p = std::path::Path::new(&home).join(name);
                if p.is_dir() {
                    out.push(PlaceInfo { name: name.into(), path: p.display().to_string(), kind: "place" });
                }
            }
        }
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if std::path::Path::new(&root).is_dir() {
                out.push(PlaceInfo { name: format!("{}:", letter as char), path: root, kind: "drive" });
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sub-folders of `path` (hidden and system ones skipped), sorted by name.
#[tauri::command]
pub async fn list_dir(path: String, images: Option<bool>) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::os::windows::fs::MetadataExt;
        let p = std::path::PathBuf::from(&path);
        let rd = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
        let mut files: Vec<FileInfo> = Vec::new();
        if images.unwrap_or(false) {
            if let Ok(rd2) = std::fs::read_dir(&p) {
                for e in rd2.filter_map(Result::ok) {
                    let Ok(meta) = e.metadata() else { continue };
                    if !meta.is_file() || meta.file_attributes() & 0x6 != 0 {
                        continue;
                    }
                    let name = e.file_name().to_string_lossy().to_string();
                    let ext = std::path::Path::new(&name)
                        .extension()
                        .map(|x| x.to_string_lossy().to_ascii_lowercase())
                        .unwrap_or_default();
                    if !IMAGE_EXTS.contains(&ext.as_str()) {
                        continue;
                    }
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());
                    files.push(FileInfo { name, path: e.path().display().to_string(), modified, size: meta.len() });
                }
            }
            files.sort_by_key(|f| f.name.to_lowercase());
        }
        let mut dirs: Vec<DirEntryInfo> = rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                if meta.file_attributes() & 0x6 != 0 {
                    return None;
                }
                Some(dir_entry(&e.path(), e.file_name().to_string_lossy().to_string()))
            })
            .collect();
        dirs.sort_by_key(|d| d.name.to_lowercase());
        Ok(DirListing {
            path: p.display().to_string(),
            parent: p.parent().map(|x| x.display().to_string()).filter(|s| !s.is_empty()),
            dirs,
            files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct DirDetails {
    git_branch: Option<String>,
    package_manager: Option<&'static str>,
    subfolders: usize,
    files: usize,
}

/// Facts shown in the folder browser's preview pane.
#[tauri::command]
pub async fn dir_details(path: String) -> Result<DirDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let git_branch = std::fs::read_to_string(p.join(".git").join("HEAD")).ok().map(|h| {
            let h = h.trim();
            h.strip_prefix("ref: refs/heads/").unwrap_or(&h[..h.len().min(7)]).to_string()
        });
        let package_manager = [
            ("bun.lock", "bun"),
            ("bun.lockb", "bun"),
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("package-lock.json", "npm"),
            ("Cargo.toml", "cargo"),
            ("pyproject.toml", "python"),
            ("go.mod", "go"),
        ]
        .iter()
        .find(|(f, _)| p.join(f).is_file())
        .map(|(_, n)| *n);
        let (mut subfolders, mut files) = (0, 0);
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.filter_map(Result::ok) {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    subfolders += 1;
                } else {
                    files += 1;
                }
            }
        }
        DirDetails { git_branch, package_manager, subfolders, files }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Create `name` inside `parent`; returns the new folder's path.
#[tauri::command]
pub fn make_dir(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("Invalid folder name".into());
    }
    let p = std::path::Path::new(&parent).join(name);
    std::fs::create_dir(&p).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// Open an http(s) URL in the default browser. Goes through `url.dll`'s
/// ShellExecute handler instead of `cmd /C start`, because cmd treats `&`, `^`
/// and `%` in OAuth query strings as metacharacters.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http and https links can be opened".into());
    }
    if url.len() > 16_384 || url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"') {
        return Err("invalid link".into());
    }
    Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Open a local HTML file (a session export) with its default app. Only an existing
/// `.html`/`.htm` file, so the UI cannot be used to launch arbitrary programs.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(path.trim());
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !p.is_absolute() || !matches!(ext.as_deref(), Some("html" | "htm")) {
        return Err("only an exported .html file can be opened".into());
    }
    if !p.is_file() {
        return Err("the file does not exist".into());
    }
    Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(p)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// End session `id` and forget it. Resolves once its process has exited.
#[tauri::command]
pub async fn rpc_stop(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RpcState>();
        let _lifecycle = state.lifecycle.lock().unwrap();
        let session = state.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            stop(&mut session);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Waits for a start or stop in flight, so a child it spawns is stopped with the rest.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<RpcState>();
    let _lifecycle = state.lifecycle.lock().unwrap();
    let sessions: Vec<Session> = state.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    for mut session in sessions {
        stop(&mut session);
    }
}
