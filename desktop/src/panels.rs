//! Workspace panels backend: Terminal (ConPTY), Changes (Git), and Files (Tree/Read/Write).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::CREATE_NO_WINDOW;

// -----------------------------------------------------------------------------
// Win32 ConPTY FFI
// -----------------------------------------------------------------------------

type HANDLE = *mut std::ffi::c_void;
type HPCON = *mut std::ffi::c_void;
type HRESULT = i32;
type DWORD = u32;
type BOOL = i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct COORD {
    x: i16,
    y: i16,
}

#[repr(C)]
struct SECURITY_ATTRIBUTES {
    n_length: DWORD,
    lp_security_descriptor: *mut std::ffi::c_void,
    b_inherit_handle: BOOL,
}

#[repr(C)]
struct STARTUPINFOEXW {
    startup_info: STARTUPINFOW,
    lp_attribute_list: *mut std::ffi::c_void,
}

#[repr(C)]
struct STARTUPINFOW {
    cb: DWORD,
    lp_reserved: *mut u16,
    lp_desktop: *mut u16,
    lp_title: *mut u16,
    dw_x: DWORD,
    dw_y: DWORD,
    dw_x_size: DWORD,
    dw_y_size: DWORD,
    dw_x_count_chars: DWORD,
    dw_y_count_chars: DWORD,
    dw_fill_attribute: DWORD,
    dw_flags: DWORD,
    w_show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    h_std_input: HANDLE,
    h_std_output: HANDLE,
    h_std_error: HANDLE,
}

#[repr(C)]
struct PROCESS_INFORMATION {
    h_process: HANDLE,
    h_thread: HANDLE,
    dw_process_id: DWORD,
    dw_thread_id: DWORD,
}

const EXTENDED_STARTUPINFO_PRESENT: DWORD = 0x0008_0000;
const CREATE_UNICODE_ENVIRONMENT: DWORD = 0x0000_0400;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

#[link(name = "kernel32")]
extern "system" {
    fn CreatePipe(
        h_read_pipe: *mut HANDLE,
        h_write_pipe: *mut HANDLE,
        lp_pipe_attributes: *const SECURITY_ATTRIBUTES,
        n_size: DWORD,
    ) -> BOOL;
    fn CloseHandle(h_object: HANDLE) -> BOOL;
    fn CreatePseudoConsole(
        size: COORD,
        h_input: HANDLE,
        h_output: HANDLE,
        dw_flags: DWORD,
        ph_pc: *mut HPCON,
    ) -> HRESULT;
    fn ResizePseudoConsole(h_pc: HPCON, size: COORD) -> HRESULT;
    fn ClosePseudoConsole(h_pc: HPCON);
    fn InitializeProcThreadAttributeList(
        lp_attribute_list: *mut std::ffi::c_void,
        dw_attribute_count: DWORD,
        dw_flags: DWORD,
        lp_size: *mut usize,
    ) -> BOOL;
    fn UpdateProcThreadAttribute(
        lp_attribute_list: *mut std::ffi::c_void,
        dw_flags: DWORD,
        attribute: usize,
        lp_value: *mut std::ffi::c_void,
        cb_size: usize,
        lp_previous_value: *mut std::ffi::c_void,
        lp_return_size: *mut usize,
    ) -> BOOL;
    fn DeleteProcThreadAttributeList(lp_attribute_list: *mut std::ffi::c_void);
    fn CreateProcessW(
        lp_application_name: *const u16,
        lp_command_line: *mut u16,
        lp_process_attributes: *const SECURITY_ATTRIBUTES,
        lp_thread_attributes: *const SECURITY_ATTRIBUTES,
        b_inherit_handles: BOOL,
        dw_creation_flags: DWORD,
        lp_environment: *const std::ffi::c_void,
        lp_current_directory: *const u16,
        lp_startup_info: *const STARTUPINFOEXW,
        lp_process_information: *mut PROCESS_INFORMATION,
    ) -> BOOL;
    fn WaitForSingleObject(h_handle: HANDLE, dw_milliseconds: DWORD) -> DWORD;
    fn GetExitCodeProcess(h_process: HANDLE, lp_exit_code: *mut DWORD) -> BOOL;
    fn TerminateProcess(h_process: HANDLE, u_exit_code: u32) -> BOOL;
    fn GetLastError() -> DWORD;
}

struct ConPtyHandle {
    hpc: HPCON,
    h_process: HANDLE,
    pid: u32,
}

unsafe impl Send for ConPtyHandle {}
unsafe impl Sync for ConPtyHandle {}

impl Drop for ConPtyHandle {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.hpc);
            let _ = TerminateProcess(self.h_process, 1);
            let _ = CloseHandle(self.h_process);
        }
        let _ = Command::new("taskkill")
            .args(["/PID", &self.pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

fn wide_null(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

struct TermSession {
    pty: ConPtyHandle,
    writer: fs::File,
    generation: u64,
}

#[derive(Default)]
pub struct TerminalState(Mutex<HashMap<String, TermSession>>);

static TERM_GEN: AtomicU64 = AtomicU64::new(0);

fn resolve_dir(cwd: Option<String>) -> Result<PathBuf, String> {
    let dir = match cwd.filter(|c| !c.trim().is_empty()) {
        Some(c) => PathBuf::from(c),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }
    Ok(dir)
}

fn default_shell_cmd(shell: Option<&str>) -> String {
    match shell.map(str::trim).filter(|s| !s.is_empty()) {
        Some("cmd") => "cmd.exe".into(),
        Some("pwsh") => "pwsh.exe -NoLogo".into(),
        Some("powershell") => "powershell.exe -NoLogo".into(),
        Some(custom) => custom.to_string(),
        None => {
            // Prefer pwsh if installed on PATH, else Windows PowerShell.
            let has_pwsh = Command::new("where")
                .arg("pwsh.exe")
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if has_pwsh {
                "pwsh.exe -NoLogo".into()
            } else {
                "powershell.exe -NoLogo".into()
            }
        }
    }
}

#[tauri::command]
pub fn term_start(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<String, String> {
    let dir = resolve_dir(cwd)?;
    let cols = cols.unwrap_or(100).clamp(20, 500) as i16;
    let rows = rows.unwrap_or(30).clamp(5, 200) as i16;
    let cmd_str = default_shell_cmd(shell.as_deref());

    let mut sessions = state.0.lock().unwrap();
    // Dropping stops any old session with the same id; its taskkill waits, so not here.
    if let Some(old) = sessions.remove(&id) {
        std::thread::spawn(move || drop(old));
    }

    unsafe {
        let mut in_read: HANDLE = std::ptr::null_mut();
        let mut in_write: HANDLE = std::ptr::null_mut();
        let mut out_read: HANDLE = std::ptr::null_mut();
        let mut out_write: HANDLE = std::ptr::null_mut();

        if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0 {
            return Err(format!("CreatePipe (in) failed: {}", GetLastError()));
        }
        if CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0 {
            CloseHandle(in_read);
            CloseHandle(in_write);
            return Err(format!("CreatePipe (out) failed: {}", GetLastError()));
        }

        let mut hpc: HPCON = std::ptr::null_mut();
        let hr = CreatePseudoConsole(COORD { x: cols, y: rows }, in_read, out_write, 0, &mut hpc);
        CloseHandle(in_read);
        CloseHandle(out_write);
        if hr != 0 {
            CloseHandle(in_write);
            CloseHandle(out_read);
            return Err(format!("CreatePseudoConsole failed: 0x{hr:08x}"));
        }

        let mut attr_size: usize = 0;
        let _ = InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
        let mut attr_buf = vec![0u8; attr_size.max(1)];
        let attr_list = attr_buf.as_mut_ptr() as *mut std::ffi::c_void;
        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) == 0 {
            ClosePseudoConsole(hpc);
            CloseHandle(in_write);
            CloseHandle(out_read);
            return Err(format!("InitializeProcThreadAttributeList failed: {}", GetLastError()));
        }

        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpc,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            DeleteProcThreadAttributeList(attr_list);
            ClosePseudoConsole(hpc);
            CloseHandle(in_write);
            CloseHandle(out_read);
            return Err(format!("UpdateProcThreadAttribute failed: {}", GetLastError()));
        }

        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.startup_info.cb = std::mem::size_of::<STARTUPINFOEXW>() as DWORD;
        si.lp_attribute_list = attr_list;

        let mut cmd_wide = wide_null(OsStr::new(&cmd_str));
        let dir_wide = wide_null(dir.as_os_str());
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();

        let ok = CreateProcessW(
            std::ptr::null(),
            cmd_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            dir_wide.as_ptr(),
            &si,
            &mut pi,
        );
        DeleteProcThreadAttributeList(attr_list);

        if ok == 0 {
            let err = GetLastError();
            ClosePseudoConsole(hpc);
            CloseHandle(in_write);
            CloseHandle(out_read);
            return Err(format!("Could not start shell ({cmd_str}): error {err}"));
        }

        CloseHandle(pi.h_thread);

        let writer = fs::File::from_raw_handle(in_write as RawHandle);
        let mut reader = fs::File::from_raw_handle(out_read as RawHandle);
        let generation = TERM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let h_process_wait = pi.h_process as usize;

        sessions.insert(
            id.clone(),
            TermSession {
                pty: ConPtyHandle {
                    hpc,
                    h_process: pi.h_process,
                    pid: pi.dw_process_id,
                },
                writer,
                generation,
            },
        );

        let out_app = app.clone();
        let out_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        // Emit valid UTF-8 prefix; hold trailing incomplete multi-byte sequence (up to 3 bytes).
                        let valid_len = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(e) => {
                                let v = e.valid_up_to();
                                if e.error_len().is_some() || carry.len() - v > 3 {
                                    carry.len()
                                } else {
                                    v
                                }
                            }
                        };
                        if valid_len > 0 {
                            let text = String::from_utf8_lossy(&carry[..valid_len]).into_owned();
                            carry.drain(..valid_len);
                            let _ = out_app.emit("term-data", (&out_id, text));
                        }
                    }
                }
            }
            if !carry.is_empty() {
                let text = String::from_utf8_lossy(&carry).into_owned();
                let _ = out_app.emit("term-data", (&out_id, text));
            }
            let current = out_app
                .state::<TerminalState>()
                .0
                .lock()
                .unwrap()
                .get(&out_id)
                .map(|s| s.generation);
            if current == Some(generation) {
                let mut code: DWORD = 0;
                let h = h_process_wait as HANDLE;
                let _ = WaitForSingleObject(h, 200);
                let _ = GetExitCodeProcess(h, &mut code);
                let _ = out_app.emit("term-exit", (&out_id, code));
            }
        });
    }

    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn term_write(state: State<TerminalState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("Terminal is not running")?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<TerminalState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let session = sessions.get(&id).ok_or("Terminal is not running")?;
    let size = COORD {
        x: cols.clamp(20, 500) as i16,
        y: rows.clamp(5, 200) as i16,
    };
    let hr = unsafe { ResizePseudoConsole(session.pty.hpc, size) };
    if hr != 0 {
        return Err(format!("ResizePseudoConsole failed: 0x{hr:08x}"));
    }
    Ok(())
}

#[tauri::command]
pub fn term_stop(state: State<TerminalState>, id: String) {
    let old = state.0.lock().unwrap().remove(&id);
    if let Some(old) = old {
        // Dropping waits for taskkill; keep that off the UI thread and the lock.
        std::thread::spawn(move || drop(old));
    }
}

pub fn shutdown(app: &AppHandle) {
    app.state::<TerminalState>().0.lock().unwrap().clear();
}

// -----------------------------------------------------------------------------
// Changes (Git status, diff, stage, unstage, discard)
// -----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub orig_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub root: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileStatus>,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&cwd);
        if !dir.is_dir() {
            return Err(format!("Not a directory: {cwd}"));
        }
        let root_out = run_git(&dir, &["rev-parse", "--show-toplevel"])?;
        if !root_out.status.success() {
            return Err("Not a Git repository".into());
        }
        let root = String::from_utf8_lossy(&root_out.stdout)
            .trim()
            .replace('/', "\\");

        let out = run_git(&dir, &["status", "--porcelain=v1", "-b", "-uall", "-z"])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }

        let bytes = &out.stdout;
        let mut branch = String::from("HEAD");
        let mut ahead = 0u32;
        let mut behind = 0u32;
        let mut files = Vec::new();

        let mut parts = bytes.split(|&b| b == 0).filter(|s| !s.is_empty());
        while let Some(entry) = parts.next() {
            let line = String::from_utf8_lossy(entry);
            if let Some(b_info) = line.strip_prefix("## ") {
                let (head_part, track_part) = match b_info.find(" [") {
                    Some(idx) => (&b_info[..idx], Some(&b_info[idx + 2..b_info.len().saturating_sub(1)])),
                    None => (b_info, None),
                };
                branch = head_part
                    .split("...")
                    .next()
                    .unwrap_or(head_part)
                    .trim()
                    .to_string();
                if let Some(track) = track_part {
                    for seg in track.split(',') {
                        let seg = seg.trim();
                        if let Some(n) = seg.strip_prefix("ahead ") {
                            ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = seg.strip_prefix("behind ") {
                            behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                continue;
            }
            if line.len() < 4 {
                continue;
            }
            let bytes_line = line.as_bytes();
            let x = bytes_line[0] as char;
            let y = bytes_line[1] as char;
            let path = line[3..].to_string();
            let orig_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
                parts.next().map(|p| String::from_utf8_lossy(p).into_owned())
            } else {
                None
            };
            let untracked = x == '?' && y == '?';
            let staged = !untracked && x != ' ' && x != '?';
            let unstaged = !untracked && y != ' ' && y != '?';
            files.push(GitFileStatus {
                path,
                orig_path,
                index_status: x.to_string(),
                worktree_status: y.to_string(),
                staged,
                unstaged,
                untracked,
            });
        }

        Ok(GitStatusResult {
            root,
            branch,
            ahead,
            behind,
            files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff(cwd: String, path: String, staged: bool, untracked: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&cwd);
        if untracked {
            let full = dir.join(&path);
            let size = fs::metadata(&full).map_err(|e| e.to_string())?.len();
            if size > MAX_READ_BYTES {
                return Ok(format!(
                    "diff --git a/{path} b/{path}\nnew file\nFile {path} is too large to show ({size} bytes)\n"
                ));
            }
            let content = match String::from_utf8(fs::read(&full).map_err(|e| e.to_string())?) {
                Ok(text) => text,
                Err(e) => {
                    let b = e.into_bytes();
                    if b.iter().take(8000).any(|&c| c == 0) {
                        return Ok(format!("diff --git a/{path} b/{path}\nnew file\nBinary file {path} added\n"));
                    }
                    String::from_utf8_lossy(&b).into_owned()
                }
            };
            let lines: Vec<&str> = content.lines().collect();
            let mut out = format!(
                "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n",
                lines.len()
            );
            for l in lines {
                out.push('+');
                out.push_str(l);
                out.push('\n');
            }
            return Ok(out);
        }

        let mut args = vec!["diff", "--no-color", "--unified=3"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&path);
        let out = run_git(&dir, &args)?;
        let limit = MAX_READ_BYTES as usize;
        if out.stdout.len() <= limit {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let keep = out.stdout[..limit].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        let mut text = String::from_utf8_lossy(&out.stdout[..keep]).into_owned();
        text.push_str(&format!("\\ Diff truncated at {} MiB\n", MAX_READ_BYTES / (1024 * 1024)));
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_action(
    cwd: String,
    action: String,
    paths: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&cwd);
        match action.as_str() {
            "stage" => {
                if paths.is_empty() {
                    let out = run_git(&dir, &["add", "-A"])?;
                    if !out.status.success() {
                        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                    }
                } else {
                    let mut args = vec!["add", "--"];
                    for p in &paths {
                        args.push(p);
                    }
                    let out = run_git(&dir, &args)?;
                    if !out.status.success() {
                        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                    }
                }
            }
            "unstage" => {
                if paths.is_empty() {
                    let out = run_git(&dir, &["reset", "-q", "HEAD"])?;
                    if !out.status.success() {
                        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                    }
                } else {
                    let mut args = vec!["reset", "-q", "HEAD", "--"];
                    for p in &paths {
                        args.push(p);
                    }
                    let out = run_git(&dir, &args)?;
                    if !out.status.success() {
                        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                    }
                }
            }
            "discard" => {
                for p in &paths {
                    // Check if untracked first
                    let st = run_git(&dir, &["status", "--porcelain=v1", "--", p])?;
                    let st_str = String::from_utf8_lossy(&st.stdout);
                    if st_str.starts_with("?? ") {
                        let full = dir.join(p);
                        if full.is_dir() {
                            fs::remove_dir_all(&full).map_err(|e| e.to_string())?;
                        } else if full.exists() {
                            fs::remove_file(&full).map_err(|e| e.to_string())?;
                        }
                    } else {
                        let out = run_git(&dir, &["checkout", "--", p])?;
                        if !out.status.success() {
                            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                        }
                    }
                }
            }
            _ => return Err(format!("Unknown git action: {action}")),
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let msg = message.trim();
        if msg.is_empty() {
            return Err("Commit message cannot be empty".into());
        }
        let dir = PathBuf::from(&cwd);
        let out = run_git(&dir, &["commit", "-m", msg])?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return Err(if !err.is_empty() { err } else { stdout });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// -----------------------------------------------------------------------------
// Files (Directory tree, file viewer & editor)
// -----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FsNode>,
}

#[tauri::command]
pub async fn fs_list(path: String, show_hidden: Option<bool>) -> Result<FsListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let rd = fs::read_dir(&p).map_err(|e| e.to_string())?;
        let include_hidden = show_hidden.unwrap_or(false);
        let mut entries = Vec::new();
        for e in rd.filter_map(Result::ok) {
            let Ok(meta) = e.metadata() else { continue };
            let attrs = meta.file_attributes();
            // Skip system files (0x4); skip hidden (0x2) or dot-prefixed unless requested
            if attrs & 0x4 != 0 {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let hidden = (attrs & 0x2 != 0) || name.starts_with('.');
            if hidden && !include_hidden {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            entries.push(FsNode {
                name,
                path: e.path().display().to_string(),
                is_dir: meta.is_dir(),
                size: if meta.is_file() { meta.len() } else { 0 },
                modified,
                hidden,
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(FsListing {
            path: p.display().to_string(),
            parent: p.parent().map(|x| x.display().to_string()).filter(|s| !s.is_empty()),
            entries,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

const MAX_READ_BYTES: u64 = 4 * 1024 * 1024; // 4 MiB cap for in-pane text viewer/editor

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsFileContent {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
    pub content: String,
}

#[tauri::command]
pub async fn fs_read(path: String) -> Result<FsFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Not a regular file".into());
        }
        let size = meta.len();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let mut file = fs::File::open(&p).map_err(|e| e.to_string())?;
        let to_read = size.min(MAX_READ_BYTES) as usize;
        let mut buf = vec![0u8; to_read];
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);

        let binary = buf.iter().take(8192).any(|&b| b == 0);
        if binary {
            return Ok(FsFileContent {
                path: p.display().to_string(),
                name,
                size,
                binary: true,
                truncated: false,
                content: String::new(),
            });
        }
        Ok(FsFileContent {
            path: p.display().to_string(),
            name,
            size,
            binary: false,
            truncated: size > MAX_READ_BYTES,
            content: String::from_utf8_lossy(&buf).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_write(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
