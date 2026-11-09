//! Bridge between the WebView and `omp --mode rpc-ui` child processes, one per chat session.
//!
//! The wire protocol is newline-delimited JSON (docs/rpc.md). This module does not
//! interpret it: stdout lines are forwarded verbatim as `rpc-frame` events (payload
//! `[sessionId, line]`) and lines from the UI are written to the stdin of the session
//! they name, so protocol changes upstream never need a Rust change.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::CREATE_NO_WINDOW;

/// Running sessions by the id the UI chose.
#[derive(Default)]
pub struct RpcState(Mutex<HashMap<String, Session>>);

struct Session {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Unique per start so a stale reader thread cannot report the exit of a newer process
    /// that reuses the same session id.
    generation: u64,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

fn stop(session: &mut Session) {
    session.stdin = None; // EOF: omp drains and exits by itself
    if let Some(mut child) = session.child.take() {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Start (or restart) session `id` in `cwd`. Returns the working directory in use.
#[tauri::command]
pub fn rpc_start(
    app: AppHandle,
    state: State<RpcState>,
    id: String,
    cwd: Option<String>,
    resume: Option<bool>,
    session: Option<String>,
) -> Result<String, String> {
    let dir = match cwd.filter(|c| !c.trim().is_empty()) {
        Some(c) => std::path::PathBuf::from(c),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut sessions = state.0.lock().unwrap();
    if let Some(mut old) = sessions.remove(&id) {
        stop(&mut old);
    }

    let mut cmd = crate::runtime::omp_command()?;
    cmd.args(["--mode", "rpc-ui"]);
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
    sessions.insert(
        id.clone(),
        Session {
            stdin: child.stdin.take(),
            child: Some(child),
            generation,
        },
    );

    let out_app = app.clone();
    let out_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = out_app.emit("rpc-frame", (&out_id, line));
            }
        }
        let current = out_app
            .state::<RpcState>()
            .0
            .lock()
            .unwrap()
            .get(&out_id)
            .map(|s| s.generation);
        if current == Some(generation) {
            let _ = out_app.emit("rpc-exit", &out_id);
        }
    });

    let err_app = app;
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = err_app.emit("rpc-stderr", (&id, line));
        }
    });

    Ok(dir.display().to_string())
}

/// Write one JSON line to the stdin of session `id`.
#[tauri::command]
pub fn rpc_send(state: State<RpcState>, id: String, line: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let stdin = sessions
        .get_mut(&id)
        .and_then(|s| s.stdin.as_mut())
        .ok_or("agent is not running")?;
    stdin
        .write_all(line.trim_end().as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Native folder picker (STA PowerShell + WinForms; no extra crate). `None` when cancelled.
#[tauri::command]
pub fn pick_folder(start: Option<String>) -> Option<String> {
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
pub fn read_image(path: String) -> Result<tauri::ipc::Response, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err("not an image file".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
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
pub fn list_places() -> Vec<PlaceInfo> {
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
}

/// Sub-folders of `path` (hidden and system ones skipped), sorted by name.
#[tauri::command]
pub fn list_dir(path: String, images: Option<bool>) -> Result<DirListing, String> {
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
pub fn dir_details(path: String) -> DirDetails {
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

/// End session `id` and forget it.
#[tauri::command]
pub fn rpc_stop(state: State<RpcState>, id: String) {
    if let Some(mut session) = state.0.lock().unwrap().remove(&id) {
        stop(&mut session);
    }
}

pub fn shutdown(app: &AppHandle) {
    let sessions: Vec<Session> = app
        .state::<RpcState>()
        .0
        .lock()
        .unwrap()
        .drain()
        .map(|(_, s)| s)
        .collect();
    for mut session in sessions {
        stop(&mut session);
    }
}
