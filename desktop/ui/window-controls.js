// Injected into every page of the main window (loading screen and the stats dashboard).
// Draws glass window controls beside Settings and makes the top strip draggable.
// The shared control recipe is loaded inside the shadow root; theme tokens inherit from the page.
(() => {
  if (window.top !== window || window.__kostompControls) return;
  window.__kostompControls = true;

  const STRIP_HEIGHT = 52; // the dashboard's --topbar-h
  const INTERACTIVE = "button,a,input,select,textarea,label,summary,[role='button'],[role='tab'],[tabindex]";

  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, { label: "main", ...args });

  // Events from inside the closed shadow root are retargeted to its host, so exclude the host.
  const inDragStrip = (e, host) =>
    e.button === 0 && e.clientY <= STRIP_HEIGHT && e.target !== host && !e.target.closest?.(INTERACTIVE);

  const ICON_MAX = '<rect x="2.5" y="2.5" width="7" height="7" rx="1"/>';
  const ICON_RESTORE = '<path d="M4.5 2.5h5v5M2.5 4.5h5v5h-5z" stroke-linejoin="round"/>';

  const mount = () => {
    const host = document.createElement("div");
    const topbar = document.querySelector(".topbar");
    host.style.cssText = topbar
      ? "display:flex;flex:none;align-items:center;"
      : "position:fixed;top:18px;right:24px;z-index:2147483647;";

    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <link rel="stylesheet" href="glass.css">
      <style>
        :host { font:inherit; }
        .bar {
          display:flex; align-items:center; gap:8px;
          user-select:none; -webkit-user-select:none;
        }
        button.glass-control {
          box-sizing:border-box; display:grid; place-items:center; padding:0;
          width:36px; height:36px; border-radius:10px;
          color:var(--ink-2); cursor:pointer;
          transition:transform 160ms var(--ease),opacity 160ms var(--ease);
        }
        button:hover { color:var(--ink-1); }
        button:active { transform:scale(.97); }
        button:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
        button.close:hover { background:var(--bad-soft); color:var(--bad); }
        svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; }
      </style>
      <div class="bar">
        <button class="min glass-control" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 12 12"><path d="M2.5 6h7"/></svg></button>
        <button class="max glass-control" title="Maximize" aria-label="Maximize"><svg viewBox="0 0 12 12">${ICON_MAX}</svg></button>
        <button class="close glass-control" title="Close" aria-label="Close"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>
      </div>`;

    const maxBtn = root.querySelector(".max");
    const syncMaxIcon = async () => {
      const maximized = await call("plugin:window|is_maximized");
      maxBtn.querySelector("svg").innerHTML = maximized ? ICON_RESTORE : ICON_MAX;
      maxBtn.title = maxBtn.ariaLabel = maximized ? "Restore" : "Maximize";
    };
    const toggleMaximize = async () => {
      await call("plugin:window|toggle_maximize");
      syncMaxIcon();
    };

    root.querySelector(".min").addEventListener("click", () => call("plugin:window|minimize"));
    maxBtn.addEventListener("click", toggleMaximize);
    root.querySelector(".close").addEventListener("click", () => call("plugin:window|close"));

    // Drag the window by its top strip (anything that is not an interactive element).
    // start_dragging hands the mouse to the OS and swallows the click/dblclick events, so the
    // double-click is detected on the second mousedown (detail === 2) and must not start a drag.
    document.addEventListener("mousedown", (e) => {
      if (!inDragStrip(e, host)) return;
      if (e.detail === 2) toggleMaximize();
      else if (e.detail < 2) call("plugin:window|start_dragging");
    });
    window.addEventListener("resize", syncMaxIcon);

    // Invisible edge/corner grips: a frameless window has no native resize border to grab.
    const GRIP = 5;
    const grips = [
      ["North", "top:0;left:8px;right:8px;height:%px;cursor:ns-resize"],
      ["South", "bottom:0;left:8px;right:8px;height:%px;cursor:ns-resize"],
      ["West", "left:0;top:8px;bottom:8px;width:%px;cursor:ew-resize"],
      ["East", "right:0;top:8px;bottom:8px;width:%px;cursor:ew-resize"],
      ["NorthWest", "top:0;left:0;width:8px;height:8px;cursor:nwse-resize"],
      ["NorthEast", "top:0;right:0;width:8px;height:8px;cursor:nesw-resize"],
      ["SouthWest", "bottom:0;left:0;width:8px;height:8px;cursor:nesw-resize"],
      ["SouthEast", "bottom:0;right:0;width:8px;height:8px;cursor:nwse-resize"],
    ];
    const gripHost = document.createElement("div");
    gripHost.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    for (const [dir, css] of grips) {
      const g = document.createElement("div");
      g.style.cssText = "position:absolute;pointer-events:auto;" + css.replace("%", GRIP);
      g.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        call("plugin:window|start_resize_dragging", { value: dir });
      });
      gripHost.appendChild(g);
    }
    document.documentElement.appendChild(gripHost);

    (topbar || document.documentElement).appendChild(host);
    syncMaxIcon();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true });
  else mount();
})();
