//! Window material: frosted glass (transparent window + Windows Mica/Acrylic) or opaque.
//!
//! The window is always created transparent; "opaque" is the page painting a solid background
//! with no system effect underneath. The choice is stored in `window.json` in the app config dir
//! and read at startup, so the first paint already uses it.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::Effect;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::CREATE_NO_WINDOW;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Material {
    Glass,
    Opaque,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSettings {
    pub material: Material,
    /// 0 = clear (no system blur), 1 = light (Mica), 2 = frosted (Acrylic).
    pub blur: u8,
    /// Opacity of the page's tint over the glass, in percent.
    pub tint: u8,
    pub opaque_when_unfocused: bool,
    pub follow_system: bool,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self { material: Material::Glass, blur: 2, tint: 52, opaque_when_unfocused: true, follow_system: false }
    }
}

impl WindowSettings {
    fn clamped(mut self) -> Self {
        self.blur = self.blur.min(2);
        self.tint = self.tint.min(100);
        self
    }
}

struct Inner {
    settings: WindowSettings,
    focused: bool,
    /// Windows "Transparency effects" (Settings > Personalization > Colors).
    system_transparency: bool,
}

pub struct WindowStyle(Mutex<Inner>);

/// What the page needs to paint: sent with every change as the `window-material` event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialState {
    pub settings: WindowSettings,
    /// Glass is actually shown right now (setting, focus and system switch combined).
    pub glass: bool,
    pub system_transparency: bool,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load(app: &AppHandle) -> WindowSettings {
    config_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<WindowSettings>(&b).ok())
        .unwrap_or_default()
        .clamped()
}

fn save(app: &AppHandle, settings: &WindowSettings) -> Result<(), String> {
    let path = config_path(app).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// `EnableTransparency` under HKCU Personalize; missing means on (the Windows default).
fn read_system_transparency() -> bool {
    let out = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "EnableTransparency",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) if o.status.success() => !String::from_utf8_lossy(&o.stdout).contains("0x0"),
        _ => true,
    }
}

impl Inner {
    fn state(&self) -> MaterialState {
        let s = &self.settings;
        let glass = s.material == Material::Glass
            && !(s.follow_system && !self.system_transparency)
            && !(s.opaque_when_unfocused && !self.focused);
        MaterialState { settings: s.clone(), glass, system_transparency: self.system_transparency }
    }
}

fn effects_for(state: &MaterialState) -> Option<WindowEffectsConfig> {
    if !state.glass {
        return None;
    }
    let effect = match state.settings.blur {
        0 => return None,
        1 => Effect::Mica,
        _ => Effect::Acrylic,
    };
    Some(WindowEffectsConfig { effects: vec![effect], ..Default::default() })
}

/// Last applied system effect, so focus changes do not re-apply an unchanged one (that flickers).
static APPLIED: Mutex<Option<Option<u8>>> = Mutex::new(None);

fn apply(window: &WebviewWindow, state: &MaterialState) {
    let effects = effects_for(state);
    let key = effects.as_ref().map(|_| state.settings.blur);
    let mut applied = APPLIED.lock().unwrap();
    if *applied != Some(key) {
        let _ = window.set_effects(effects);
        *applied = Some(key);
    }
    drop(applied);
    let _ = window.emit("window-material", state.clone());
}

/// Called before the window is built: loads the stored settings.
pub fn init(app: &AppHandle) -> WindowStyle {
    let settings = load(app);
    let system_transparency = !settings.follow_system || read_system_transparency();
    WindowStyle(Mutex::new(Inner { settings, focused: true, system_transparency }))
}

/// Script injected into the main page: the material to paint before the shell's own scripts run.
pub fn init_script(style: &WindowStyle) -> String {
    let state = style.0.lock().unwrap().state();
    format!("window.__KOSTOMP_MATERIAL__ = {};", serde_json::to_string(&state).unwrap_or_else(|_| "null".into()))
}

/// Applies the stored material to a freshly built window and follows its focus.
pub fn attach(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let state = app.state::<WindowStyle>().0.lock().unwrap().state();
    apply(window, &state);

    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            let style = app.state::<WindowStyle>();
            let follow = {
                let mut inner = style.0.lock().unwrap();
                inner.focused = *focused;
                inner.settings.follow_system
            };
            // The Windows switch may have changed while we were in the background.
            let system = if follow && *focused { Some(read_system_transparency()) } else { None };
            let state = {
                let mut inner = style.0.lock().unwrap();
                if let Some(s) = system {
                    inner.system_transparency = s;
                }
                inner.state()
            };
            apply(&win, &state);
        }
    });
}

#[tauri::command]
pub fn window_style_get(style: State<WindowStyle>) -> MaterialState {
    style.0.lock().unwrap().state()
}

#[tauri::command]
pub fn window_style_set(
    app: AppHandle,
    window: WebviewWindow,
    style: State<WindowStyle>,
    settings: WindowSettings,
) -> Result<MaterialState, String> {
    let settings = settings.clamped();
    save(&app, &settings)?;
    let system = settings.follow_system.then(read_system_transparency);
    let state = {
        let mut inner = style.0.lock().unwrap();
        inner.settings = settings;
        if let Some(s) = system {
            inner.system_transparency = s;
        }
        inner.state()
    };
    apply(&window, &state);
    Ok(state)
}
