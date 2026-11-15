//! Design mode storage: boards, generated design cards and the design skill pool.
//!
//! Everything lives under `app_data_dir()/design/`. Every id, skill directory and relative path
//! coming from the UI is validated before it is joined onto that root, and files the design agent
//! writes (index.html, meta.json) are only read when they are regular files, never symlinks.

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde_json::{json, Map, Value};
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Manager};

const MAX_HTML: u64 = 8 * 1024 * 1024;
const MAX_JSON: u64 = 8 * 1024 * 1024;
const MAX_SKILL_MD: u64 = 1024 * 1024;
const MAX_DOC: u64 = 1024 * 1024;
const MAX_CRITIQUE: u64 = 1024 * 1024;
const MAX_COPY_DEPTH: usize = 32;

/// Serializes read-modify-write of pool.json and board.json (commands run on a thread pool).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- validation

/// Windows device names (`CON`, `NUL.txt`, `COM1`, ...) must never become path components.
fn reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// `^[A-Za-z0-9_-]{1,64}$`
fn check_id(kind: &str, id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !reserved(id);
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid {kind} id."))
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (no trailing dot: Windows would strip it).
fn skill_dir_ok(dir: &str) -> bool {
    let bytes = dir.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|&b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        && !dir.ends_with('.')
        && !reserved(dir)
}

fn check_skill_dir(dir: &str) -> Result<(), String> {
    if skill_dir_ok(dir) {
        Ok(())
    } else {
        Err("Invalid skill name.".into())
    }
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3).ok_or("Invalid skill file path.")?;
            let hex = std::str::from_utf8(hex).map_err(|_| "Invalid skill file path.")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Invalid skill file path.")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Invalid skill file path.".to_string())
}

/// Splits a decoded relative path into safe segments: no empty/`.`/`..`, no absolute paths, drive
/// letters, backslashes, alternate data streams or other characters Windows treats specially.
fn safe_segments(path: &str) -> Result<Vec<&str>, String> {
    let bad = || "Invalid skill file path.".to_string();
    if path.is_empty() || path.len() > 1024 {
        return Err(bad());
    }
    let mut out = Vec::new();
    for seg in path.split('/') {
        let invalid = seg.is_empty()
            || seg == "."
            || seg == ".."
            || seg.len() > 255
            || seg.ends_with('.')
            || seg.ends_with(' ')
            || seg.chars().any(|c| c < ' ' || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
            || reserved(seg);
        if invalid {
            return Err(bad());
        }
        out.push(seg);
    }
    Ok(out)
}

// ---------------------------------------------------------------- filesystem helpers

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("design"))
}

fn ensure_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = root_dir(app)?;
    for sub in [Path::new(".omp").join("skills"), PathBuf::from("boards")] {
        let dir = root.join(sub);
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    Ok(root)
}

fn skills_dir(root: &Path) -> PathBuf {
    root.join(".omp").join("skills")
}

fn board_dir(root: &Path, board_id: &str) -> Result<PathBuf, String> {
    check_id("board", board_id)?;
    Ok(root.join("boards").join(board_id))
}

fn design_dir(root: &Path, board_id: &str, design_id: &str) -> Result<PathBuf, String> {
    check_id("design", design_id)?;
    Ok(board_dir(root, board_id)?.join("designs").join(design_id))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Bytes of a regular file no larger than `cap`; symlinks are refused.
fn read_capped(path: &Path, cap: u64, what: &str) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{what}: {e}"))?;
    if !meta.file_type().is_file() {
        return Err(format!("{what} is not a regular file."));
    }
    if meta.len() > cap {
        return Err(format!("{what} is larger than {} MiB.", cap / (1024 * 1024)));
    }
    fs::read(path).map_err(|e| format!("{what}: {e}"))
}

fn read_json(path: &Path, cap: u64) -> Option<Value> {
    serde_json::from_slice(&read_capped(path, cap, "JSON file").ok()?).ok()
}

/// Write `<file>.tmp`, then rename over `file`.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut name = path.file_name().ok_or("Invalid path.")?.to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    let result = fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

fn remove_dir(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        // Symlink or stray file: remove the entry itself, never follow it.
        fs::remove_file(path)
            .or_else(|_| fs::remove_dir(path))
            .map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------- pool.json

fn read_pool(root: &Path) -> Map<String, Value> {
    read_json(&root.join("pool.json"), MAX_JSON)
        .and_then(|v| match v.get("skills") {
            Some(Value::Object(map)) => Some(map.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn write_pool(root: &Path, skills: Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let text = serde_json::to_vec_pretty(&json!({ "skills": skills })).map_err(|e| e.to_string())?;
    write_atomic(&root.join("pool.json"), &text)
}

// ---------------------------------------------------------------- SKILL.md frontmatter

fn unquote(value: &str) -> String {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        let mut out = String::new();
        let mut chars = value[1..value.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return out;
    }
    if bytes.len() >= 2 && bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'' {
        return value[1..value.len() - 1].replace("''", "'");
    }
    match value.find(" #") {
        Some(at) => value[..at].trim_end().to_string(),
        None => value.to_string(),
    }
}

/// Top-level scalar `key` of the YAML frontmatter. Handles quoted values, `>`/`|` block scalars
/// and plain values continued on indented lines.
fn frontmatter_field(text: &str, key: &str) -> Option<String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let block: Vec<&str> = lines
        .take_while(|line| {
            let line = line.trim_end();
            line != "---" && line != "..."
        })
        .collect();
    let indented = |line: &str| line.starts_with(' ') || line.starts_with('\t');
    let mut i = 0;
    while i < block.len() {
        let line = block[i];
        i += 1;
        if indented(line) || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.trim() != key {
            continue;
        }
        let mut continued = Vec::new();
        while i < block.len() && (block[i].trim().is_empty() || indented(block[i])) {
            continued.push(block[i].trim());
            i += 1;
        }
        let value = value.trim();
        if value.starts_with('>') || value.starts_with('|') {
            let sep = if value.starts_with('|') { "\n" } else { " " };
            let parts: Vec<&str> = continued.into_iter().filter(|part| !part.is_empty()).collect();
            return Some(parts.join(sep));
        }
        let mut joined = value.to_string();
        for part in continued.into_iter().filter(|part| !part.is_empty()) {
            if !joined.is_empty() {
                joined.push(' ');
            }
            joined.push_str(part);
        }
        return Some(unquote(&joined));
    }
    None
}

// ---------------------------------------------------------------- commands: root and boards

#[tauri::command]
pub async fn design_root(app: AppHandle) -> Result<String, String> {
    blocking(move || Ok(path_text(&ensure_root(&app)?))).await
}

#[tauri::command]
pub async fn design_board_open(app: AppHandle, board_id: String) -> Result<String, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let dir = board_dir(&root, &board_id)?;
        let designs = dir.join("designs");
        fs::create_dir_all(&designs).map_err(|e| e.to_string())?;
        Ok(path_text(&dir))
    })
    .await
}

fn sort_key(board: &Value) -> (f64, String) {
    match board.get("updatedAt") {
        Some(Value::Number(n)) => (n.as_f64().unwrap_or(0.0), String::new()),
        Some(Value::String(s)) => (0.0, s.clone()),
        _ => (0.0, String::new()),
    }
}

#[tauri::command]
pub async fn design_boards(app: AppHandle) -> Result<Vec<Value>, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let mut boards = Vec::new();
        for entry in fs::read_dir(root.join("boards")).map_err(|e| e.to_string())?.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !kind.is_dir() || check_id("board", &name).is_err() {
                continue;
            }
            if let Some(board) = read_json(&entry.path().join("board.json"), MAX_JSON) {
                if board.is_object() {
                    boards.push(board);
                }
            }
        }
        boards.sort_by(|a, b| {
            let (an, a_text) = sort_key(a);
            let (bn, b_text) = sort_key(b);
            bn.partial_cmp(&an)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b_text.cmp(&a_text))
        });
        Ok(boards)
    })
    .await
}

#[tauri::command]
pub async fn design_board_save(app: AppHandle, board_id: String, board: Value) -> Result<(), String> {
    blocking(move || {
        if !board.is_object() {
            return Err("Board must be a JSON object.".into());
        }
        let root = ensure_root(&app)?;
        let dir = board_dir(&root, &board_id)?;
        let bytes = serde_json::to_vec_pretty(&board).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_JSON {
            return Err("Board is too large.".into());
        }
        let _guard = lock();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_atomic(&dir.join("board.json"), &bytes)
    })
    .await
}

#[tauri::command]
pub async fn design_board_delete(app: AppHandle, board_id: String) -> Result<(), String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let dir = board_dir(&root, &board_id)?;
        let _guard = lock();
        remove_dir(&dir)
    })
    .await
}

// ---------------------------------------------------------------- commands: designs

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn design_cards(app: AppHandle, board_id: String) -> Result<Vec<Value>, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let designs = board_dir(&root, &board_id)?.join("designs");
        let Ok(entries) = fs::read_dir(&designs) else { return Ok(Vec::new()) };
        let mut cards: Vec<(u64, String, Value)> = Vec::new();
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let id = entry.file_name().to_string_lossy().into_owned();
            if !kind.is_dir() || check_id("design", &id).is_err() {
                continue;
            }
            let dir = entry.path();
            let html = dir.join("index.html");
            let has_html = fs::symlink_metadata(&html).map(|m| m.file_type().is_file()).unwrap_or(false);
            let modified = if has_html { mtime_ms(&html) } else { 0 };
            let meta = read_json(&dir.join("meta.json"), MAX_JSON).filter(Value::is_object);
            let critique_path = dir.join("critique.json");
            let critique = read_json(&critique_path, MAX_CRITIQUE).filter(Value::is_object);
            let critique_modified = if critique.is_some() { mtime_ms(&critique_path) } else { 0 };
            let card = json!({
                "id": id,
                "meta": meta,
                "modified": modified,
                "hasHtml": has_html,
                "critique": critique,
                "critiqueModified": critique_modified,
            });
            cards.push((modified, id, card));
        }
        cards.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        Ok(cards.into_iter().map(|(_, _, card)| card).collect())
    })
    .await
}

#[tauri::command]
pub async fn design_html(app: AppHandle, board_id: String, design_id: String) -> Result<String, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let dir = design_dir(&root, &board_id, &design_id)?;
        let bytes = read_capped(&dir.join("index.html"), MAX_HTML, "Design")?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
}

#[tauri::command]
pub async fn design_card_delete(app: AppHandle, board_id: String, design_id: String) -> Result<(), String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let dir = design_dir(&root, &board_id, &design_id)?;
        let _guard = lock();
        remove_dir(&dir)
    })
    .await
}

#[tauri::command]
pub async fn design_critique_clear(app: AppHandle, board_id: String, design_id: String) -> Result<(), String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let dir = design_dir(&root, &board_id, &design_id)?;
        let _guard = lock();
        remove_dir(&dir.join("critique.json"))
    })
    .await
}

// ---------------------------------------------------------------- commands: DESIGN.md

/// `boards/<id>/DESIGN.md`, or "" when absent.
#[tauri::command]
pub async fn design_doc_read(app: AppHandle, board_id: String) -> Result<String, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let path = board_dir(&root, &board_id)?.join("DESIGN.md");
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Err(e) => return Err(e.to_string()),
        }
        let bytes = read_capped(&path, MAX_DOC, "DESIGN.md")?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
}

/// Whitespace-only `text` deletes DESIGN.md.
#[tauri::command]
pub async fn design_doc_write(app: AppHandle, board_id: String, text: String) -> Result<(), String> {
    blocking(move || {
        if text.len() as u64 > MAX_DOC {
            return Err(format!("DESIGN.md is larger than {} MiB.", MAX_DOC / (1024 * 1024)));
        }
        let root = ensure_root(&app)?;
        let path = board_dir(&root, &board_id)?.join("DESIGN.md");
        let _guard = lock();
        if text.trim().is_empty() {
            return remove_dir(&path);
        }
        write_atomic(&path, text.as_bytes())
    })
    .await
}

// ---------------------------------------------------------------- commands: export

/// Copies regular files only; `skip` names entries ignored at the top level.
fn copy_design(from: &Path, to: &Path, skip: &[&str], depth: usize) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err("Design folder is nested too deeply.".into());
    }
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if depth == 0 && skip.iter().any(|s| name == *s) {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = to.join(&name);
        if kind.is_symlink() {
            return Err(format!("Refusing to copy symlink {}.", entry.path().display()));
        } else if kind.is_dir() {
            fs::create_dir(&target).map_err(|e| e.to_string())?;
            copy_design(&entry.path(), &target, skip, depth + 1)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Copy a design (without critique.json) into a new folder under `dest`; returns that folder.
#[tauri::command]
pub async fn design_export(
    app: AppHandle,
    board_id: String,
    design_id: String,
    dest: String,
) -> Result<String, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let source = design_dir(&root, &board_id, &design_id)?;
        let source_meta = fs::symlink_metadata(&source).map_err(|e| format!("Design: {e}"))?;
        if !source_meta.file_type().is_dir() {
            return Err("Design is not a folder.".into());
        }

        let dest = PathBuf::from(dest.trim());
        if !dest.is_absolute() || !fs::metadata(&dest).map(|m| m.is_dir()).unwrap_or(false) {
            return Err("Choose an existing folder to export into.".into());
        }
        let real_source = fs::canonicalize(&source).map_err(|e| e.to_string())?;
        let real_dest = fs::canonicalize(&dest).map_err(|e| e.to_string())?;
        if real_dest.starts_with(&real_source) {
            return Err("Cannot export into the design's own folder.".into());
        }

        let title = read_json(&source.join("meta.json"), MAX_JSON)
            .and_then(|m| m.get("title").and_then(Value::as_str).map(sanitize_dir))
            .unwrap_or_default();
        let slug = if skill_dir_ok(&title) { title } else { design_id.clone() };

        let _guard = lock();
        let mut target = None;
        for n in 1..=1000 {
            let name = if n == 1 { slug.clone() } else { format!("{slug}-{n}") };
            let candidate = dest.join(&name);
            match fs::create_dir(&candidate) {
                Ok(()) => {
                    target = Some(candidate);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("{}: {e}", candidate.display())),
            }
        }
        let target = target.ok_or("Could not find a free folder name.")?;
        if let Err(error) = copy_design(&source, &target, &["critique.json"], 0) {
            let _ = remove_dir(&target);
            return Err(error);
        }
        Ok(path_text(&target))
    })
    .await
}

/// Open `designs/<id>/index.html` in the default browser.
#[tauri::command]
pub async fn design_open_external(app: AppHandle, board_id: String, design_id: String) -> Result<(), String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let html = design_dir(&root, &board_id, &design_id)?.join("index.html");
        if !fs::symlink_metadata(&html).map(|m| m.file_type().is_file()).unwrap_or(false) {
            return Err("The design has no index.html yet.".into());
        }
        Command::new("explorer")
            .arg(&html)
            .creation_flags(crate::CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------- commands: skill pool

#[tauri::command]
pub async fn design_skills(app: AppHandle) -> Result<Vec<Value>, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let pool = read_pool(&root);
        let mut skills: Vec<(String, Value)> = Vec::new();
        for entry in fs::read_dir(skills_dir(&root)).map_err(|e| e.to_string())?.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let dir = entry.file_name().to_string_lossy().into_owned();
            if !kind.is_dir() || !skill_dir_ok(&dir) {
                continue;
            }
            let path = entry.path();
            let Ok(bytes) = read_capped(&path.join("SKILL.md"), MAX_SKILL_MD, "SKILL.md") else { continue };
            let text = String::from_utf8_lossy(&bytes);
            let name = frontmatter_field(&text, "name")
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| dir.clone());
            let description = frontmatter_field(&text, "description").unwrap_or_default();
            let entry = pool.get(&dir);
            let active = entry.and_then(|e| e.get("active")).and_then(Value::as_bool).unwrap_or(true);
            let source = entry
                .and_then(|e| e.get("source"))
                .and_then(Value::as_str)
                .map(|s| Value::String(s.to_string()))
                .unwrap_or(Value::Null);
            let sort = name.to_lowercase();
            skills.push((
                sort,
                json!({
                    "dir": dir,
                    "name": name,
                    "description": description,
                    "active": active,
                    "source": source,
                    "path": path_text(&path),
                }),
            ));
        }
        skills.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(skills.into_iter().map(|(_, skill)| skill).collect())
    })
    .await
}

#[tauri::command]
pub async fn design_skill_set(
    app: AppHandle,
    dir: String,
    active: bool,
    source: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        check_skill_dir(&dir)?;
        let root = ensure_root(&app)?;
        let _guard = lock();
        let mut pool = read_pool(&root);
        let kept = pool.get(&dir).and_then(|e| e.get("source")).cloned().unwrap_or(Value::Null);
        let source = match source {
            Some(source) => Value::String(source),
            None => kept,
        };
        pool.insert(dir, json!({ "active": active, "source": source }));
        write_pool(&root, pool)
    })
    .await
}

#[tauri::command]
pub async fn design_skill_remove(app: AppHandle, dir: String) -> Result<(), String> {
    blocking(move || {
        check_skill_dir(&dir)?;
        let root = ensure_root(&app)?;
        let _guard = lock();
        remove_dir(&skills_dir(&root).join(&dir))?;
        let mut pool = read_pool(&root);
        if pool.remove(&dir).is_some() {
            write_pool(&root, pool)?;
        }
        Ok(())
    })
    .await
}

/// Folder name reduced to the skill directory alphabet.
fn sanitize_dir(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    let trimmed = mapped.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
    let cut: String = trimmed.chars().take(64).collect();
    cut.trim_end_matches('.').to_string()
}

fn copy_tree(from: &Path, to: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err("Skill folder is nested too deeply.".into());
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = to.join(&name);
        if kind.is_symlink() {
            return Err(format!("Refusing to copy symlink {}.", entry.path().display()));
        } else if kind.is_dir() {
            copy_tree(&entry.path(), &target, depth + 1)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn design_skill_import_folder(app: AppHandle, path: String) -> Result<String, String> {
    blocking(move || {
        let root = ensure_root(&app)?;
        let source = PathBuf::from(path.trim());
        let meta = fs::symlink_metadata(&source).map_err(|e| format!("{}: {e}", source.display()))?;
        if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
            return Err("Choose a plain folder (not a symlink).".into());
        }
        let skill_md = fs::symlink_metadata(source.join("SKILL.md"));
        if !skill_md.map(|m| m.file_type().is_file()).unwrap_or(false) {
            return Err("The folder has no SKILL.md.".into());
        }
        let folder = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or("Choose a folder, not a drive root.")?;
        let dir = sanitize_dir(&folder);
        check_skill_dir(&dir).map_err(|_| format!("Cannot derive a skill name from \"{folder}\"."))?;

        let pool_dir = skills_dir(&root);
        let dest = pool_dir.join(&dir);
        let real_source = fs::canonicalize(&source).map_err(|e| e.to_string())?;
        let real_pool = fs::canonicalize(&pool_dir).map_err(|e| e.to_string())?;
        if real_pool.starts_with(&real_source) {
            return Err("That folder contains the skill pool.".into());
        }

        let _guard = lock();
        if fs::symlink_metadata(&dest).is_ok() {
            return Err(format!("A skill named \"{dir}\" already exists."));
        }
        let staging = root.join(format!(".import-{dir}"));
        remove_dir(&staging)?;
        let copied = copy_tree(&source, &staging, 0).and_then(|_| fs::rename(&staging, &dest).map_err(|e| e.to_string()));
        if let Err(error) = copied {
            let _ = remove_dir(&staging);
            return Err(error);
        }

        let mut pool = read_pool(&root);
        pool.insert(dir.clone(), json!({ "active": true, "source": path_text(&source) }));
        write_pool(&root, pool)?;
        Ok(dir)
    })
    .await
}

/// Body = file bytes. Headers: `x-skill` = skill directory, `x-path` = percent-encoded relative path.
#[tauri::command]
pub fn design_skill_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file bytes as a raw body.".into());
    };
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("Missing {name} header."))
    };
    let dir = header("x-skill")?;
    check_skill_dir(&dir)?;
    let relative = percent_decode(&header("x-path")?)?;
    let segments = safe_segments(&relative)?;

    let root = ensure_root(&app)?;
    let base = skills_dir(&root).join(&dir);
    let mut target = base.clone();
    for segment in &segments {
        target.push(segment);
    }
    // No component that already exists may be a symlink or junction.
    let mut probe = base;
    let mut parts = vec![None];
    parts.extend(segments.iter().map(Some));
    for part in parts {
        if let Some(part) = part {
            probe.push(part);
        }
        if fs::symlink_metadata(&probe).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("Refusing to write through a symlink.".into());
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))
}
