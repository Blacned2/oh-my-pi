// Injected into every page of the main window (loading screen and the stats dashboard).
// Draws floating window controls and a quiet drag handle beside them.
// The shared control recipe is loaded inside the shadow root; theme tokens inherit from the page.
(() => {
  if (window.top !== window || window.__kostompControls) return;
  window.__kostompControls = true;

  const STRIP_HEIGHT = 52; // the dashboard's --topbar-h
  const INTERACTIVE = "button,a,input,select,textarea,label,summary,[role='button'],[role='tab'],[tabindex]";

  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, { label: "main", ...args });

  // The shell's sidebar head is the drag strip; the controls always float top-right (macOS-style traffic
  // lights) over the page, which reserves --wc-w for them. Pages without a head (loading screen) drag from
  // a STRIP_HEIGHT strip.
  // Events from inside the closed shadow root are retargeted to its host, so exclude the host.
  const inDragStrip = (e, host, head) => {
    if (e.button !== 0 || e.target === host || e.target.closest?.(INTERACTIVE)) return false;
    if (!head) return e.clientY <= STRIP_HEIGHT;
    const r = head.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  const ICON_MAX = '<rect x="5" y="5" width="14" height="14" rx="2.5"/>';
  const ICON_RESTORE = '<rect x="5" y="9" width="10" height="10" rx="2"/><path d="M9 9V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/>';

  const mount = () => {
    const host = document.createElement("div");
    const head = document.getElementById("side-head");
    // Vertical centre matches the pane pills: --edge + pill top (8px) + half pill height (14px); panes have no border.
    host.style.cssText = "position:fixed;top:calc(var(--edge,0px) + 11.5px);right:14px;z-index:2147483647;";

    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <link rel="stylesheet" href="glass.css">
      <style>
        :host { font:inherit; }
        .bar {
          display:flex; align-items:center; gap:8px; padding:4px;
          user-select:none; -webkit-user-select:none;
        }
        .bar button.bead {
          box-sizing:border-box; display:grid; place-items:center; padding:0;
          width:13px; height:13px; border-radius:50%; cursor:pointer;
          border:.5px solid var(--tl-edge); background:var(--tl); color:var(--tl-ink);
          box-shadow:inset 0 .5px .5px rgb(255 255 255 / .4);
        }
        .bar button.close { --tl:#ff5f57; --tl-edge:#e0443e; --tl-ink:#4d0000; }
        .bar button.min { --tl:#febc2e; --tl-edge:#dea123; --tl-ink:#5a3a00; }
        .bar button.max { --tl:#28c840; --tl-edge:#1aab29; --tl-ink:#003d0a; }
        .bar button.bead svg { opacity:0; transition:opacity .12s; }
        .bar:hover button.bead svg, .bar button.bead:focus-visible svg { opacity:1; }
        .bar button.bead:hover { filter:brightness(1.08); }
        .bar button.bead:active { filter:brightness(.82); transform:scale(.92); }
        .bar button.bead:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
        .bar button.grip {
          display:grid; place-items:center; padding:0; width:30px; height:20px; margin-right:4px;
          border:0; border-radius:999px; cursor:grab;
          background:transparent; box-shadow:none; color:var(--ink-2, #ccc); transform:none;
        }
        .bar button.grip svg { opacity:.25; transition:opacity .12s; }
        .bar button.grip:hover svg, .bar button.grip:focus-visible svg { opacity:.8; }
        .bar button.grip:focus-visible { outline:2px solid var(--accent, #a78bfa); outline-offset:2px; }
        .bar button.grip:active { cursor:grabbing; }
        .bar button.grip svg { width:14px; height:14px; fill:currentColor; stroke:none; }
        svg { width:9px; height:9px; stroke:currentColor; fill:none; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; }
      </style>
      <div class="bar">
        <button class="grip" title="Drag to move window" aria-label="Move window"><svg viewBox="0 0 24 24"><circle cx="8" cy="7" r="1.4"/><circle cx="16" cy="7" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="8" cy="17" r="1.4"/><circle cx="16" cy="17" r="1.4"/></svg></button>
        <button class="min bead" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
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
    // Keep the handle available when maximized: the OS restores the window as it is dragged.
    root.querySelector(".grip").addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      call("plugin:window|start_dragging");
    });

    // Drag the window by its top strip (anything that is not an interactive element).
    // start_dragging hands the mouse to the OS and swallows the click/dblclick events, so the
    // double-click is detected on the second mousedown (detail === 2) and must not start a drag.
    document.addEventListener("mousedown", (e) => {
      if (!inDragStrip(e, host, head)) return;
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

    document.documentElement.appendChild(host);
    syncMaxIcon();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true });
  else mount();
})();
