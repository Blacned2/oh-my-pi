// Injected into every frame of the main window; acts only inside the stats dashboard iframe.
// The shell owns the theme preference (system|light|dark). The dashboard is cross-origin, so this
// script copies the preference into the dashboard's own storage key ("omp-stats-theme", read once
// at startup by packages/stats useSystemTheme.ts) and hides the dashboard's own theme toggle.
// The dashboard source stays untouched.
(() => {
  if (window.top === window) return;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;

  const KEY = "omp-stats-theme";
  const PARAM = "kostomp-theme";
  const valid = (t) => t === "system" || t === "light" || t === "dark";
  const stored = () => localStorage.getItem(KEY) || "system";

  // First load: the shell passes the preference in the URL. Runs before the dashboard's scripts.
  try {
    const url = new URL(location.href);
    const theme = url.searchParams.get(PARAM);
    if (valid(theme)) {
      localStorage.setItem(KEY, theme);
      url.searchParams.delete(PARAM);
      history.replaceState(history.state, "", url);
    }
  } catch {}

  // Later changes: the dashboard reads its preference only at startup, so reload on a change
  // (the current route is kept by the reload).
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const data = e.data;
    if (!data || data.type !== "kostomp-theme" || !valid(data.theme) || stored() === data.theme) return;
    localStorage.setItem(KEY, data.theme);
    location.reload();
  });

  // Window material: under glass the dashboard drops its solid page background so the shell's tint
  // (and the system blur under it) shows through; its panels keep a translucent fill for reading.
  // Remembered in the frame's storage so a reload (theme change) paints right away.
  const MAT_KEY = "kostomp-material";
  let glassStyle = null;
  const setGlass = (glass) => {
    document.documentElement.dataset.material = glass ? "glass" : "opaque";
    if (glass && !glassStyle) {
      glassStyle = document.createElement("style");
      glassStyle.textContent =
        "html,body{background:transparent !important}";
      (document.head || document.documentElement).appendChild(glassStyle);
    } else if (!glass && glassStyle) {
      glassStyle.remove();
      glassStyle = null;
    }
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "kostomp-material") return;
    const glass = e.data.glass === true;
    localStorage.setItem(MAT_KEY, glass ? "glass" : "opaque");
    setGlass(glass);
  });

  // The frame stays loaded while another shell view is open, so its own document.hidden never turns
  // true and the dashboard keeps polling. Fold the shell's view into document.hidden: the dashboard's
  // polling already skips while it is true.
  const realHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden").get;
  const realState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get;
  let shown = true;
  Object.defineProperty(document, "hidden", { configurable: true, get() { return !shown || realHidden.call(this); } });
  Object.defineProperty(document, "visibilityState", { configurable: true, get() { return shown ? realState.call(this) : "hidden"; } });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "kostomp-visible") return;
    const next = e.data.visible === true;
    if (next === shown) return;
    shown = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const hideToggle = () => {
    document.documentElement.classList.add("kostomp-frame");
    setGlass(localStorage.getItem(MAT_KEY) === "glass");
    const style = document.createElement("style");
    style.textContent = 'button[aria-label$="theme (click to switch)"]{display:none !important}';
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) hideToggle();
  else document.addEventListener("DOMContentLoaded", hideToggle, { once: true });
})();
