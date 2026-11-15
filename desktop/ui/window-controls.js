// Injected into every page of the main window (loading screen and the stats dashboard).
// Draws glass window controls beside Settings and makes the top strip draggable.
// The shared control recipe is loaded inside the shadow root; theme tokens inherit from the page.
(() => {
  if (window.top !== window || window.__kostompControls) return;
  window.__kostompControls = true;

  const STRIP_HEIGHT = 52; // the dashboard's --topbar-h
  const INTERACTIVE = "button,a,input,select,textarea,label,summary,[role='button'],[role='tab'],[tabindex]";

  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, { label: "main", ...args });

  // The shell's titlebar floats with a margin, so its strip ends at the bar's bottom edge.
  // Events from inside the closed shadow root are retargeted to its host, so exclude the host.
  const inDragStrip = (e, host, topbar) =>
    e.button === 0 && e.clientY <= (topbar ? topbar.getBoundingClientRect().bottom : STRIP_HEIGHT) &&
    e.target !== host && !e.target.closest?.(INTERACTIVE);

  const ICON_MAX = '<rect x="5" y="5" width="14" height="14" rx="2.5"/>';
  const ICON_RESTORE = '<rect x="5" y="9" width="10" height="10" rx="2"/><path d="M9 9V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/>';

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
          display:flex; align-items:center; gap:6px;
          user-select:none; -webkit-user-select:none;
        }
        .bar.in-topbar { margin-left:6px; padding-left:10px; border-left:1px solid var(--line-2); }
        .bar button.bead {
          box-sizing:border-box; display:grid; place-items:center; padding:0;
          width:34px; height:34px; border:0; border-radius:50%;
          background:var(--hover, rgb(255 255 255 / .08)); color:var(--ink-1); cursor:pointer;
          box-shadow:inset 0 1px 1px rgb(255 255 255 / .45), inset 0 -2px 3px rgb(0 0 0 / .16);
        }
        .bar button.bead:hover { background:var(--press, rgb(255 255 255 / .14)); }
        .bar button.bead:active { transform:scale(.9); }
        .bar button.bead:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
        .bar button.close:hover { background:var(--bad); color:#fff; }
        svg { width:14px; height:14px; stroke:currentColor; fill:none; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
      </style>
      <div class="bar${topbar ? " in-topbar" : ""}">
        <button class="min bead" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg></button>
        <button class="max bead" title="Maximize" aria-label="Maximize"><svg viewBox="0 0 24 24">${ICON_MAX}</svg></button>
        <button class="close bead" title="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </div>`;

    const maxBtn = root.querySelector(".max");
    let shownMaximized = false; // the markup starts with the maximize icon
    const syncMaxIcon = async () => {
      const maximized = !!(await call("plugin:window|is_maximized"));
      if (maximized === shownMaximized) return;
      shownMaximized = maximized;
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
      if (!inDragStrip(e, host, topbar)) return;
      if (e.detail === 2) toggleMaximize();
      else if (e.detail < 2) call("plugin:window|start_dragging");
    });
    // Resize fires every frame while an edge is dragged: sync once it settles.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncMaxIcon, 120);
    });

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

    (topbar?.querySelector(".tb-r") || topbar || document.documentElement).appendChild(host);
    syncMaxIcon();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true });
  else mount();
})();
