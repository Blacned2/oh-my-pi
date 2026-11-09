//! App updates. Only the Kostomp shell is replaced: the bundled omp/stats live in `runtime\`,
//! which the NSIS installer never deletes, so a slim update installer leaves them in place.
//!
//! Update source: a local folder (default `%LOCALAPPDATA%\Kostomp\updates`, override with
//! `KOSTOMP_UPDATE_DIR`) that build-installer.ps1 fills. The updater plugin only speaks HTTP, so
//! the app serves that folder on 127.0.0.1:47821 (loopback only) and the endpoint in
//! tauri.conf.json points there. `KOSTOMP_UPDATE_URL` can still override the endpoint.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const PORT: u16 = 47821;

fn update_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("KOSTOMP_UPDATE_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Kostomp").join("updates")
}

fn respond(mut stream: TcpStream, dir: &Path) {
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }
    // "GET /name HTTP/1.1": only a bare file name is served, never a path.
    let name = line.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/');
    let ok = !name.is_empty() && !name.contains(['/', '\\', ':']) && name != "..";
    let file = if ok { std::fs::File::open(dir.join(name)).ok() } else { None };
    match file {
        Some(mut f) => {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n");
            if stream.write_all(head.as_bytes()).is_ok() {
                let _ = std::io::copy(&mut f, &mut stream);
            }
        }
        None => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    }
}

/// Starts the loopback file server once. Errors (port taken) surface as an update-check error.
fn ensure_server() -> Result<(), String> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| format!("update server: {e}"))?;
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    // Re-read per request so a folder created later is picked up.
                    respond(stream, &update_dir());
                }
            });
            Ok(())
        })
        .clone()
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    ensure_server()?;
    let mut builder = app.updater_builder();
    if let Ok(raw) = std::env::var("KOSTOMP_UPDATE_URL") {
        let url: Url = raw.parse().map_err(|e| format!("KOSTOMP_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// `None` when the app is current.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(find_update(&app).await?.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// Downloads the update, stops the child processes (they would lock files in the install dir),
/// then hands over to the installer, which closes and restarts the app.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = find_update(&app).await?.ok_or("No update available.")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    crate::shutdown_children(&app);
    update.install(bytes).map_err(|e| e.to_string())
}
