#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod omp_config;
mod rpc;
mod runtime;
mod updater;
mod window_style;

use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_PORT: u16 = 3847;

struct StatsServer(Mutex<Option<Child>>);

/// `None` while starting, `Some(Ok(url))` when the dashboard answers, `Some(Err(msg))` on failure.
struct StatsStatus(Mutex<Option<Result<String, String>>>);

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// The shell polls this on load, because it may start listening after the result was emitted.
#[tauri::command]
fn stats_status(state: tauri::State<StatsStatus>) -> Option<Result<String, String>> {
    state.0.lock().unwrap().clone()
}

fn publish_stats(handle: &tauri::AppHandle, result: Result<String, String>) {
    *handle.state::<StatsStatus>().0.lock().unwrap() = Some(result.clone());
    let _ = handle.emit("stats-status", result);
}

fn start_stats(handle: tauri::AppHandle, port: u16) {
    // Reuse a dashboard that is already running (e.g. `omp stats`).
    if !port_open(port) {
        let (mut cmd, entry) = runtime::stats_command();
        let dir = entry.parent().map(PathBuf::from).unwrap_or_default();
        let child = cmd
            .args(["--port", &port.to_string()])
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match child {
            Ok(c) => *handle.state::<StatsServer>().0.lock().unwrap() = Some(c),
            Err(e) => return publish_stats(&handle, Err(format!("Could not start bun: {e}"))),
        }
    }

    let deadline = Instant::now() + Duration::from_secs(60);
    while !port_open(port) {
        if Instant::now() > deadline {
            return publish_stats(&handle, Err("Stats server did not start within 60 seconds.".into()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    publish_stats(&handle, Ok(format!("http://127.0.0.1:{port}")));
}

fn kill_tree(child: &mut Child) {
    // Kill the whole tree: cmd.exe -> bun.
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = child.kill();
}

fn main() {
    let port = std::env::var("KOSTOMP_STATS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(StatsServer(Mutex::new(None)))
        .manage(StatsStatus(Mutex::new(None)))
        .manage(rpc::RpcState::default())
        .invoke_handler(tauri::generate_handler![
            stats_status,
            updater::update_check,
            updater::update_install,
            rpc::rpc_start,
            rpc::rpc_send,
            rpc::rpc_stop,
            rpc::pick_folder,
            rpc::list_places,
            rpc::list_dir,
            rpc::dir_details,
            rpc::make_dir, rpc::read_image,
            rpc::open_url,
            rpc::open_file,
            window_style::window_style_get,
            window_style::window_style_set,
            omp_config::omp_config_list,
            omp_config::omp_config_set,
            omp_config::omp_config_reset
        ])
        .setup(move |app| {
            if let Ok(dir) = app.path().resource_dir() {
                runtime::init(&dir.join("runtime"));
            }
            let style = window_style::init(app.handle());
            let material_script = window_style::init_script(&style);
            app.manage(style);

            // Frameless and always transparent: the page paints glass or a solid background
            // (window_style.rs). min/max/close live in the injected top-right overlay.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kostomp")
                .inner_size(1280.0, 820.0)
                .min_inner_size(800.0, 500.0)
                .decorations(false)
                .transparent(true)
                // Let the page receive HTML5 file drops (image attachments in the composer);
                // Tauri's native drag-drop handler would swallow them on Windows.
                .disable_drag_drop_handler()
                .initialization_script(material_script)
                .initialization_script(include_str!("../ui/window-controls.js"))
                // Runs in the stats iframe too: syncs the shell's theme into the dashboard.
                .initialization_script_for_all_frames(include_str!("../ui/stats-bridge.js"))
                .build()?;
            window_style::attach(&window);

            let handle = app.handle().clone();
            std::thread::spawn(move || start_stats(handle, port));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Kostomp desktop");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            shutdown_children(handle);
        }
    });
}

/// Stops the stats server and the omp RPC process. Also called before an update, because the
/// installer ends the app without an Exit event.
pub fn shutdown_children(handle: &tauri::AppHandle) {
    if let Some(mut child) = handle.state::<StatsServer>().0.lock().unwrap().take() {
        kill_tree(&mut child);
    }
    rpc::shutdown(handle);
}
