// Kostomp shell: several chat sessions (each its own `omp --mode rpc-ui` process, see session.js)
// laid out in split panes (layout.js), plus the stats dashboard and settings.
// The Rust side forwards raw JSONL lines tagged with the session id; this file routes them.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  let layout = null; // set up below; showView() runs before that
  const sessions = new Map(); // sid -> { sid, api, tab, cwd, status: { text, kind } }
  const focusActive = () => sessions.get(layout?.focused)?.api.focus?.();
  const focusChat = () => focusActive();
  window.kostompConfirmDelete = async (title, detail) => {
    const dialog = document.createElement("dialog");
    dialog.className = "delete-confirm glass";
    dialog.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.textContent = title;
    const description = document.createElement("p");
    description.textContent = detail;
    const form = document.createElement("form");
    form.method = "dialog";
    const cancel = document.createElement("button");
    cancel.value = "cancel";
    cancel.textContent = "Cancel";
    cancel.autofocus = true;
    const confirm = document.createElement("button");
    confirm.value = "delete";
    confirm.className = "bad";
    confirm.textContent = "Delete permanently";
    form.append(cancel, confirm);
    dialog.append(heading, description, form);
    const result = Promise.withResolvers();
    dialog.addEventListener("close", () => {
      result.resolve(dialog.returnValue === "delete");
      dialog.remove();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    return result.promise;
  };
  // ---- tabs: Chat | Stats | Settings (settings.js fills the last). Graph lives inside Chat: its pane and
  // runs share the chat sidebar (graph.js). --------
  const VIEW_KEY = "kostomp-view";
  const VIEWS = ["chat", "stats", "settings"];
  const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
  const tabStrip = $("tabs");
  const tabThumb = tabStrip.querySelector(".thumb");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const DROP_EASE = "cubic-bezier(.23,1,.32,1)";
  /** Fits the droplet to the selected tab. Moving, its leading edge travels faster than the trailing one, so it stretches. */
  function placeThumb(dir) {
    const tab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    if (!tab) return;
    const vertical = getComputedStyle(tabStrip).flexDirection === "column"; // the collapsed rail stacks the tabs
    const [a, b, start, end] = vertical ? ["--t", "--b", "top", "bottom"] : ["--l", "--r", "left", "right"];
    const from = [tabThumb.style.getPropertyValue(a), tabThumb.style.getPropertyValue(b)];
    const near = vertical ? tab.offsetTop : tab.offsetLeft;
    const size = vertical ? tab.offsetHeight : tab.offsetWidth;
    const l = near + "px";
    const r = (vertical ? tabStrip.clientHeight : tabStrip.clientWidth) - near - size + "px";
    tabThumb.style.setProperty(a, l);
    tabThumb.style.setProperty(b, r);
    if (!dir || !from[0] || reducedMotion.matches) return;
    tabThumb.animate({ [start]: [from[0], l] }, { duration: dir === "r" ? 380 : 220, easing: DROP_EASE });
    tabThumb.animate({ [end]: [from[1], r] }, { duration: dir === "r" ? 220 : 380, easing: DROP_EASE });
  }
  // The strip's size changes with the window and with the sidebar's width, collapse and drag: follow it every frame.
  new ResizeObserver(() => placeThumb()).observe(tabStrip);
  document.fonts.ready.then(() => placeThumb());
  const gear = $("gear");
  function showView(name) {
    for (const view of VIEWS) {
      const section = $(view);
      const inactive = view !== name;
      section.inert = inactive;
      section.hidden = inactive;
    }
    const from = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const to = tabs.findIndex((t) => t.dataset.view === name);
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    tabStrip.dataset.view = to >= 0 ? name : "none";
    placeThumb(from >= 0 && to >= 0 && from !== to ? (to > from ? "r" : "l") : undefined);
    gear.classList.toggle("on", name === "settings");
    localStorage.setItem(VIEW_KEY, name);
    document.dispatchEvent(new CustomEvent("kostomp-view", { detail: name }));
    if (name === "chat") focusChat();
  }
  for (const tab of tabs) tab.addEventListener("click", () => { showView(tab.dataset.view); });
  const storedView = localStorage.getItem(VIEW_KEY);
  showView(VIEWS.includes(storedView) ? storedView : "chat");

  // Settings: the gear opens the Settings view; its sections live in the view's own left sidebar.
  gear.addEventListener("click", () => showView("settings"));

  // ---- theme: one global preference, owned by the shell -----------------
  // Stored as system|light|dark. The stats dashboard is cross-origin, so stats-bridge.js (injected
  // into its frame) mirrors the preference into the dashboard's own storage key.
  const THEME_KEY = "kostomp-theme";
  const THEME_NEXT = { system: "light", light: "dark", dark: "system" };
  const THEME_LABEL = { system: "System theme", light: "Light theme", dark: "Dark theme" };
  const THEME_ICON = {
    system: '<rect x="2" y="3" width="12" height="8.5" rx="1.2"/><path d="M6 14h4M8 11.5V14"/>',
    light: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
    dark: '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/>',
  };
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const storedTheme = localStorage.getItem(THEME_KEY);
  let themePref = storedTheme && Object.hasOwn(THEME_NEXT, storedTheme) ? storedTheme : "system";
  function applyTheme() {
    const dark = themePref === "dark" || (themePref === "system" && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const b = $("theme");
    b.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${THEME_ICON[themePref]}</svg>`;
    b.title = b.ariaLabel = THEME_LABEL[themePref] + " (click to switch)";
    postStatsTheme();
  }
  $("theme").addEventListener("click", () => {
    themePref = THEME_NEXT[themePref];
    localStorage.setItem(THEME_KEY, themePref);
    applyTheme();
  });
  darkQuery.addEventListener("change", () => { if (themePref === "system") applyTheme(); });

  // ---- stats ------------------------------------------------------------
  const statsFrame = $("stats-frame");
  let statsOrigin = null; // set together with the frame's src
  let statsUrl = null;
  function postStatsTheme() {
    if (statsOrigin) statsFrame.contentWindow?.postMessage({ type: "kostomp-theme", theme: themePref }, statsOrigin);
  }
  // Re-sync after every dashboard load (the bridge ignores a preference it already has).
  statsFrame.addEventListener("load", postStatsTheme);
  // Tell the dashboard whether the Stats view is shown: hidden, it stops polling (stats-bridge.js).
  function postStatsVisible() {
    if (statsOrigin) statsFrame.contentWindow?.postMessage({ type: "kostomp-visible", visible: !$("stats").hidden }, statsOrigin);
  }
  statsFrame.addEventListener("load", postStatsVisible);
  document.addEventListener("kostomp-view", postStatsVisible);
  // The dashboard is a cross-origin app with its own renderer: load it only once Stats is first shown.
  function loadStats() {
    if (statsOrigin || !statsUrl || $("stats").hidden) return;
    statsOrigin = new URL(statsUrl).origin;
    statsFrame.addEventListener("load", () => {
      statsFrame.hidden = false;
      $("stats-wait").hidden = true;
    }, { once: true });
    // First load carries the preference in the URL so the dashboard paints in it at once.
    statsFrame.src = statsUrl + "/?kostomp-theme=" + themePref;
  }
  document.addEventListener("kostomp-view", loadStats);
  function applyStats(result) {
    if (!result) return;
    if ("Ok" in result) {
      statsUrl ??= result.Ok;
      loadStats(); // the stored view may already be Stats
    } else {
      $("stats-wait").innerHTML = "";
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = result.Err;
      $("stats-wait").append(err);
    }
  }
  listen("stats-status", (e) => applyStats(e.payload));
  invoke("stats_status").then(applyStats);
  applyTheme(); // after the stats bindings it posts through
  // ---- sessions: tab strip + split workspace ------------------------------
  const strip = $("session-tabs");
  let nextSid = 0;
  const AVATAR_COLORS = ["var(--c-coral)", "var(--c-mint)", "var(--c-sun)", "var(--c-sky)", "var(--accent)"];

  /**
   * Graph and Design leave their pane when this is true for a click, Enter or Space caught (capture phase) on the
   * strip, the compose button, the sidebar segments or the tool rail. In the strip only a chat tab, or a project's
   * "+", shows a chat; folding a project, closing or renaming a tab do not. Switching the sidebar view (an unselected
   * segment tab) is not navigation; the selected one opens its list.
   */
  window.kostompLeavesForChat = (event) => {
    const target = event.target;
    if (event.currentTarget !== strip) return !target.closest("#graph-new, #graphs-toggle, #design-new, #designs-toggle, #compose-new, .seg [aria-selected=false]");
    if (event.type === "keydown") return target.matches(".stab");
    if (target.closest(".stab-group-add")) return true;
    return !!target.closest(".stab") && !target.closest(".stab-close, .stab-input");
  };

  // ---- collapsible session sidebar (state persists) ----
  const sidebar = $("sidebar");
  // The sidebar stays up in every view: a click in it, outside the Chat/Stats tabs and the shell tools, brings the chat view forward.
  sidebar.addEventListener("click", (e) => { if ($("chat").hidden && !e.target.closest("#tabs, .side-tools")) $("tab-chat").click(); }, true);
  function setSidebar(collapsed, persist = true) {
    sidebar.classList.toggle("collapsed", collapsed);
    if (persist) try { localStorage.setItem("kostomp-sidebar", collapsed ? "1" : "0"); } catch {}
  }
  setSidebar(localStorage.getItem("kostomp-sidebar") === "1", false);
  // Collapsed rail: a glass tooltip to the right of the hovered item (session, panel, graph run, button).
  let railTip = null;
  let railTipFor = null;
  let railTitle = null;
  function hideRailTip() {
    railTip?.remove();
    railTip = null;
    if (railTipFor && railTitle !== null) railTipFor.setAttribute("title", railTitle);
    railTipFor = null;
    railTitle = null;
  }
  sidebar.addEventListener("pointerover", (e) => {
    if (!sidebar.classList.contains("collapsed")) return;
    const target = e.target.closest?.(".stab, .graph-run-item, .seg-btn, .cta, button[title], button[aria-label]");
    if (!target || target === railTipFor || !sidebar.contains(target)) return;
    hideRailTip();
    const title = target.getAttribute("title") || "";
    const name = target.querySelector?.(".stab-text")?.textContent?.trim();
    const head = name || title.split(String.fromCharCode(10))[0].replace(/ — .*$/, "") || target.getAttribute("aria-label") || target.textContent.trim();
    const detail = name ? title.replace(/ — .*$/, "") : "";
    if (!head) return;
    railTipFor = target;
    railTitle = target.hasAttribute("title") ? title : null;
    if (railTitle !== null) target.removeAttribute("title");
    const tip = document.createElement("div");
    tip.className = "rail-tip glass";
    tip.setAttribute("role", "tooltip");
    const b = document.createElement("b");
    b.textContent = head;
    tip.append(b);
    if (detail && detail !== head) {
      const d = document.createElement("span");
      d.textContent = detail;
      tip.append(d);
    }
    document.body.append(tip);
    const r = target.getBoundingClientRect();
    tip.style.left = r.right + 10 + "px";
    tip.style.top = Math.max(8, Math.min(r.top + r.height / 2 - tip.offsetHeight / 2, innerHeight - tip.offsetHeight - 8)) + "px";
    railTip = tip;
  });
  sidebar.addEventListener("pointerout", (e) => {
    if (railTipFor && !railTipFor.contains(e.relatedTarget)) hideRailTip();
  });
  sidebar.addEventListener("pointerdown", hideRailTip);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyB") {
      e.preventDefault();
      setSidebar(!sidebar.classList.contains("collapsed"));
    }
  });

  // ---- buttons that no longer fit fold into one menu: the sidebar's New chat / Graph / Design row
  // becomes "New ▾", the titlebar's panel rail one "⋯" bead. Rows click the real (hidden) buttons.
  // Fit is measured with the full row in place, so toggling the folded state never feeds back into it.
  const compose = sidebar.querySelector(".compose");
  const composeMenu = window.kostompOverflowMenu($("compose-new"), $("compose-menu"), () => [
    { button: $("session-add"), label: "Chat", icon: $("tab-chat").querySelector("svg") },
    { button: $("graph-new"), label: "Graph" },
    { button: $("design-new"), label: "Design" },
  ], "left");
  function fitCompose() {
    compose.classList.remove("compact");
    // The folded rail stacks the three buttons already; only the open sidebar can run out of room.
    const tight = !sidebar.classList.contains("collapsed") && compose.scrollWidth > compose.clientWidth;
    compose.classList.toggle("compact", tight);
    if (!tight) composeMenu.close();
  }
  new ResizeObserver(fitCompose).observe(compose);

  // ---- resizable sidebar: drag the gap after it (double-click resets, arrows step). Dragging it under half
  // the minimum folds it to the rail, dragging the rail out unfolds it. Moves are coalesced to one write per
  // frame and the width is stored only when the drag ends. CSS clamps it to the window (50vw).
  const sideResize = $("side-resize");
  const SIDE_W_KEY = "kostomp-sidebar-w";
  const SIDE_MIN = 240;
  const SIDE_DEFAULT = 332;
  const SIDE_STEP = 16;
  const sideMax = () => Math.max(SIDE_MIN, Math.floor(window.innerWidth / 2));
  let sideWidth = Number(localStorage.getItem(SIDE_W_KEY)) || 0; // 0: the CSS default
  function applySideWidth() {
    if (sideWidth > 0) sidebar.style.setProperty("--side-w", sideWidth + "px");
    else sidebar.style.removeProperty("--side-w");
    sideResize.setAttribute("aria-valuenow", String(sideWidth || SIDE_DEFAULT));
  }
  function saveSideWidth() {
    try { localStorage.setItem(SIDE_W_KEY, String(sideWidth)); } catch {}
  }
  applySideWidth();
  sideResize.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sideResize.setPointerCapture(e.pointerId);
    sideResize.classList.add("active");
    document.body.classList.add("side-resizing");
    const left = sidebar.getBoundingClientRect().left;
    const max = sideMax();
    let x = e.clientX;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const w = x - left;
      const folded = sidebar.classList.contains("collapsed");
      if (w < SIDE_MIN / 2) {
        if (!folded) setSidebar(true);
        return;
      }
      if (folded) setSidebar(false);
      sideWidth = Math.round(Math.min(max, Math.max(SIDE_MIN, w)));
      applySideWidth();
    };
    const move = (ev) => {
      x = ev.clientX;
      frame ||= requestAnimationFrame(paint);
    };
    const up = () => {
      if (frame) { cancelAnimationFrame(frame); paint(); }
      sideResize.classList.remove("active");
      document.body.classList.remove("side-resizing");
      sideResize.removeEventListener("pointermove", move);
      sideResize.removeEventListener("pointerup", up);
      sideResize.removeEventListener("pointercancel", up);
      saveSideWidth();
    };
    sideResize.addEventListener("pointermove", move);
    sideResize.addEventListener("pointerup", up);
    sideResize.addEventListener("pointercancel", up);
  });
  sideResize.addEventListener("dblclick", () => {
    sideWidth = 0;
    setSidebar(false);
    applySideWidth();
    saveSideWidth();
  });
  sideResize.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const grow = e.key === "ArrowRight";
    if (sidebar.classList.contains("collapsed")) {
      if (grow) setSidebar(false);
      return;
    }
    const next = (sideWidth || SIDE_DEFAULT) + (grow ? SIDE_STEP : -SIDE_STEP);
    if (next < SIDE_MIN) { setSidebar(true); return; }
    sideWidth = Math.min(sideMax(), next);
    applySideWidth();
    saveSideWidth();
  });

  // ---- persistence: sessions + named layouts survive a restart -------------------------------
  // Sessions are global (one list, one process each); a layout is just an arrangement of them.
  // Each session remembers its omp session file, so a restart resumes that exact conversation.
  const WS_KEY = "kostomp-workspace";
  let layouts = []; // [{ id, name, state }]  state = layout.serialize()
  let activeLayout = null;
  let layoutSeq = 0;
  const attention = new Set(); // layout ids with a finished turn the user has not seen
  let saveTimer = 0;
  let restoring = true; // no saving while the saved workspace is being rebuilt

  function loadSaved() {
    try {
      const raw = JSON.parse(localStorage.getItem(WS_KEY));
      if (raw?.v === 1 && Array.isArray(raw.sessions) && raw.sessions.length) return raw;
    } catch {}
    return null;
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (restoring || !layouts.length) return;
    const cur = layouts.find((l) => l.id === activeLayout);
    if (cur) cur.state = layout.serialize();
    const data = {
      v: 1,
      nextSid,
      sessions: [...sessions.values()].map((s) => ({ sid: s.sid, cwd: s.cwd, name: s.name, sessionFile: s.sessionFile })),
      layouts,
      active: activeLayout,
    };
    try {
      localStorage.setItem(WS_KEY, JSON.stringify(data));
    } catch {}
  }
  const save = () => {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 200);
  };
  window.addEventListener("beforeunload", saveNow);

  // The sessions list is a pseudo-session in the layout: it can be a tab, split off, dragged and saved
  // like any chat. Detached here; the layout mounts it into whichever pane shows it.
  const LIST_SID = "sessions";
  const GRAPHS_SID = "graphs";
  const DESIGNS_SID = "designs";
  const savedEl = $("saved");
  let savedStale = false; // a list refresh landed while the panel was not mounted
  const graphsEl = $("graphs-panel");
  const designsEl = $("designs-panel");
  savedEl.remove();
  savedEl.hidden = false;
  graphsEl.remove();
  graphsEl.hidden = false;
  designsEl.remove();
  designsEl.hidden = false;
  // graph.js and design.js load after this detaches the panels, so document lookups would miss them.
  window.KostompGraphsPanel = graphsEl;
  window.KostompDesignsPanel = designsEl;
  let lastChatSid = null; // the chat that last had focus (the list panes have none)
  const isListPanel = (sid) => sid === LIST_SID || sid === GRAPHS_SID || sid === DESIGNS_SID;
  const isTab = (sid) => isListPanel(sid) || sessions.has(sid);

  const activeCwd = (fromSid) => {
    const at = fromSid ?? layout?.focused;
    return sessions.get(at)?.api.cwd ?? sessions.get(lastChatSid)?.api.cwd ?? [...sessions.values()][0]?.api.cwd ?? null;
  };

  layout = createLayout($("workspace"), {
    sessionEl: (sid) => (sid === LIST_SID ? savedEl : sid === GRAPHS_SID ? graphsEl : sid === DESIGNS_SID ? designsEl : sessions.get(sid)?.api.el),
    onFocus: () => {
      document.dispatchEvent(new CustomEvent("kostomp-chat-shown"));
      if (sessions.has(layout.focused)) lastChatSid = layout.focused;
      paintTabs();
    },
    // Only refreshSaved sets savedStale, so the saved-list bindings exist whenever this paints.
    onChange: () => {
      for (const sid of layout.visible()) sessions.get(sid)?.api?.ensureStarted();
      paintTabs();
      save();
      if (savedStale && savedEl.isConnected) paintSaved();
    },
    split: (sid, zone) => newSession(sid, zone),
    pinned: isListPanel,
  });
  layout.setMeta(LIST_SID, { title: "Sessions" });
  layout.setMeta(GRAPHS_SID, { title: "Graphs" });
  layout.setMeta(DESIGNS_SID, { title: "Designs" });
  function placeChat(sid) {
    if (layout.has(sid) || !isListPanel(layout.focused)) layout.show(sid);
    else layout.drop(sid, layout.focused, "right");
  }
  const baseName = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() || p : "session");
  function retitle() {
    // Same folder in several sessions: number them so tabs and pane headers stay tellable apart.
    const seen = new Map();
    for (const s of sessions.values()) {
      const base = baseName(s.cwd);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      // A name typed on the tab wins over the one omp reports (session name / extension setTitle).
      s.title = s.name ?? s.autoTitle ?? (n > 1 ? `${base} ${n}` : base);
      s.label.textContent = (window.kostompFavs.any(s.sessionFile) ? "★ " : "") + s.title;
      s.av.textContent = (Array.from(s.title.trim())[0] ?? "·").toUpperCase();
      s.av.style.setProperty("--c", s.cwd ? groupColor(s.cwd) : "var(--ink-3)");
      s.tab.title = s.cwd ? `${s.cwd} — drag onto the workspace to split` : "starting…";
      layout.setMeta(s.sid, { title: s.title });
    }
    groupTabs();
    save();
  }
  const groupEls = new Map(); // cwd -> { head, body, rows }
  const COLLAPSED_KEY = "kostomp-collapsed-projects";
  const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) ?? []; } catch { return []; } })());
  function setCollapsed(key, on) {
    if (on) collapsed.add(key); else collapsed.delete(key);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {}
    groupTabs();
  }
  /** Stable swatch color per project folder. */
  const groupColor = (key) => {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  };
  const GROUP_CHEV = '<svg class="stab-group-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  let groupSeq = 0;
  /** Sidebar order: one header per project folder, its tabs underneath (first-opened project first).
   *  Clicking a header folds its tabs; its + opens a new chat in that project. */
  function groupTabs() {
    const groups = new Map();
    for (const s of sessions.values()) {
      const key = s.cwd ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    for (const [key, g] of groupEls) {
      if (groups.has(key)) continue;
      g.head.remove();
      g.body.remove();
      groupEls.delete(key);
    }
    for (const [key, rows] of groups) {
      let g = groupEls.get(key);
      if (!g) {
        const head = document.createElement("div");
        head.className = "stab-group";
        head.setAttribute("role", "button");
        head.tabIndex = 0;
        head.innerHTML = GROUP_CHEV + '<span class="stab-group-sw" aria-hidden="true"></span><span class="stab-group-name"></span><span class="stab-group-ct"></span>';
        const add = document.createElement("button");
        add.type = "button";
        add.className = "stab-group-add";
        add.textContent = "+";
        head.append(add);
        const body = document.createElement("div");
        body.className = "stab-rows";
        body.id = "stab-rows-" + ++groupSeq;
        head.setAttribute("aria-controls", body.id);
        const inner = document.createElement("div");
        body.append(inner);
        const toggle = () => setCollapsed(head.dataset.key, !collapsed.has(head.dataset.key));
        head.addEventListener("click", (e) => {
          if (e.target === add) return;
          toggle();
        });
        head.addEventListener("keydown", (e) => {
          if (e.target === head && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); }
        });
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          const k = head.dataset.key;
          if (!k) return;
          if (collapsed.has(k)) setCollapsed(k, false);
          if (openBlank(k)) return;
          const entry = addSession({ cwd: k, resume: false });
          placeChat(entry.sid);
          entry.api.focus();
        });
        g = { head, body, rows: inner };
        groupEls.set(key, g);
      }
      const { head, body } = g;
      head.dataset.key = key;
      head.style.setProperty("--c", key ? groupColor(key) : "var(--ink-3)");
      const isCollapsed = collapsed.has(key);
      head.setAttribute("aria-expanded", String(!isCollapsed));
      body.classList.toggle("shut", isCollapsed);
      body.inert = isCollapsed;
      head.querySelector(".stab-group-name").textContent = key ? baseName(key) : "starting…";
      head.querySelector(".stab-group-ct").textContent = String(rows.length);
      const add = head.querySelector(".stab-group-add");
      add.hidden = !key;
      add.title = `New chat in ${baseName(key)}`;
      add.setAttribute("aria-label", add.title);
      head.title = key;
      g.rows.append(...rows.map((s) => s.tab));
      strip.append(head, body);
    }
    filterSide();
  }

  // ---- sidebar library: Sessions | Graphs | Designs switch the list under the segment. Clicking the
  // selected one again opens its full list as a tab (graph.js / design.js refresh theirs on that click).
  const seg = $("side-seg");
  const segTabs = [$("sessions-open"), $("graphs-toggle"), $("designs-toggle")];
  const sideSearch = $("side-search");
  const graphOpen = $("graph-open");
  const designOpen = $("design-open");
  const SIDE_VIEW_KEY = "kostomp-side-view";
  const SEARCH_HINTS = ["Search chats", "Search graphs", "Search designs"];
  let sideView = 0;
  const viewOf = (tab) => $(tab.getAttribute("aria-controls"));
  const emptyOf = (tab) => viewOf(tab).querySelector(".side-empty");
  for (const tab of segTabs) emptyOf(tab).dataset.none = emptyOf(tab).textContent;
  function setSideView(i, persist = true) {
    sideView = i;
    segTabs.forEach((tab, j) => {
      tab.setAttribute("aria-selected", String(i === j));
      tab.tabIndex = i === j ? 0 : -1;
      viewOf(tab).hidden = i !== j;
    });
    seg.style.setProperty("--i", String(i));
    sideSearch.placeholder = SEARCH_HINTS[i];
    sideSearch.setAttribute("aria-label", SEARCH_HINTS[i]);
    filterSide();
    if (persist) try { localStorage.setItem(SIDE_VIEW_KEY, String(i)); } catch {}
  }
  /** Applies the search box to every view and shows each view's empty line when nothing is left. */
  function filterSide() {
    const q = sideSearch.value.trim().toLocaleLowerCase();
    const hit = (text) => !q || text.toLocaleLowerCase().includes(q);
    let chats = 0;
    for (const s of sessions.values()) {
      const ok = hit(s.title + "\n" + (s.cwd ? baseName(s.cwd) : ""));
      s.tab.classList.toggle("filtered", !ok);
      if (ok) chats++;
    }
    for (const g of groupEls.values()) {
      const any = !!g.rows.querySelector(".stab:not(.filtered)");
      g.head.hidden = !any;
      g.body.hidden = !any;
    }
    emptyOf(segTabs[0]).hidden = chats > 0 || !q;
    [graphOpen, designOpen].forEach((list, i) => {
      let shown = 0;
      for (const item of list.children) {
        const ok = hit(item.textContent);
        item.hidden = !ok;
        if (ok) shown++;
      }
      const empty = emptyOf(segTabs[i + 1]);
      empty.textContent = list.children.length ? "No matches." : empty.dataset.none;
      empty.hidden = shown > 0;
      const count = $(i ? "designs-count" : "graphs-count");
      count.textContent = String(list.children.length);
      count.hidden = list.children.length === 0;
    });
  }
  segTabs.forEach((tab, i) => tab.addEventListener("click", (e) => {
    if (sideView !== i) {
      // graph.js / design.js open their full list on this click; switching views must not.
      e.stopImmediatePropagation();
      setSideView(i);
      return;
    }
    if (i === 1) layout.show(GRAPHS_SID);
    else if (i === 2) layout.show(DESIGNS_SID);
    else {
      layout.show(LIST_SID);
      refreshSaved();
      savedEl.querySelector("input")?.focus();
    }
  }));
  seg.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next = e.key === "Home" ? 0 : e.key === "End" ? 2 : e.key in keys ? (sideView + keys[e.key] + 3) % 3 : -1;
    if (next < 0) return;
    e.preventDefault();
    setSideView(next);
    segTabs[next].focus();
  });
  for (const list of [graphOpen, designOpen]) new MutationObserver(filterSide).observe(list, { childList: true });
  sideSearch.addEventListener("input", filterSide);
  sideSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sideSearch.value) {
      e.preventDefault();
      e.stopPropagation();
      sideSearch.value = "";
      filterSide();
    } else if (e.key === "Enter") {
      // Enter opens the first match of the current view.
      e.preventDefault();
      const view = viewOf(segTabs[sideView]);
      const first = sideView === 0
        ? [...view.querySelectorAll(".stab:not(.filtered)")].find((t) => !t.closest("[inert]"))
        : view.querySelector("li:not([hidden]) button[data-run], li:not([hidden]) button[data-board]");
      first?.click();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== "KeyK" || $("chat").hidden) return;
    if (e.target instanceof Element && e.target.closest(".term-wrap")) return; // the terminal owns Ctrl+K
    e.preventDefault();
    if (sidebar.classList.contains("collapsed")) setSidebar(false);
    sideSearch.focus();
    sideSearch.select();
  });
  setSideView(Math.min(2, Math.max(0, Number(localStorage.getItem(SIDE_VIEW_KEY)) || 0)), false);

  /** Compact age of the last turn, as in the sidebar mockup: şimdi, 12dk, 3s, 2g. */
  function sideAgo(at) {
    const m = Math.floor((Date.now() - at) / 60000);
    if (m < 1) return "şimdi";
    if (m < 60) return m + "dk";
    const h = Math.floor(m / 60);
    return h < 24 ? h + "s" : Math.floor(h / 24) + "g";
  }
  function paintTime(s) {
    const busy = s.badge.dataset.state === "busy";
    s.time.hidden = busy;
    if (!busy) s.time.textContent = sideAgo(s.lastAt);
  }
  setInterval(() => { for (const s of sessions.values()) paintTime(s); }, 30000);
  /** Subtitle text of the sidebar row: a question, an unseen reply, else the status. */
  function sessionLabel(s) {
    if (s.asking !== null) return s.asking;
    if (s.scripts.length) return "▶ " + s.scripts.join(", ");
    return s.status.kind !== "busy" && s.status.kind !== "bad" && s.unseen ? "New reply" : s.status.text;
  }
  /** Arrow keys walk the open layout popover's rows. */
  document.addEventListener("keydown", (e) => {
    if (layoutMenu.hidden || !layoutMenu.contains(document.activeElement)) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...layoutMenu.querySelectorAll(".layout-item")];
    const i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  });
  /** Status dot and row subtitle: a waiting question, a turn in flight (typing dots), an unseen reply, an error. */
  function paintSessionStatus(s) {
    const kind = s.status.kind;
    const state = s.asking !== null ? "ask" : kind === "busy" || s.scripts.length ? "busy" : kind === "bad" ? "bad" : s.unseen ? "ok" : "idle";
    s.badge.dataset.state = state;
    s.tab.classList.toggle("fresh", state === "ok");
    s.badge.title = s.asking ?? sessionLabel(s);
    s.sub.replaceChildren();
    if (state === "busy") {
      const dots = document.createElement("span");
      dots.className = "typing";
      dots.setAttribute("aria-hidden", "true");
      dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      s.sub.append(dots);
    }
    s.sub.append(sessionLabel(s));
    paintTime(s);
  }
  function paintTabs() {
    const showingPane = $("chat").classList.contains("graph-mode") || $("chat").classList.contains("design-mode");
    const focused = showingPane ? null : layout.focused;
    const shown = new Set(showingPane ? [] : layout.visible());
    for (const s of sessions.values()) {
      const selected = s.sid === focused;
      s.tab.classList.toggle("active", selected);
      if (selected && s.unseen) {
        s.unseen = false;
        paintSessionStatus(s);
      }
      s.tab.classList.toggle("shown", shown.has(s.sid));
      s.tab.setAttribute("aria-selected", String(selected));
      if (selected) s.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    strip.classList.toggle("single", sessions.size === 1);
  }
  document.addEventListener("kostomp-graph-mode", paintTabs);
  document.addEventListener("kostomp-design-mode", paintTabs);

  function addSession(opts) {
    const sid = opts.sid ?? "s" + ++nextSid;
    const tab = document.createElement("div");
    tab.className = "stab";
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
    const text = document.createElement("span");
    text.className = "stab-text";
    const label = document.createElement("span");
    label.className = "stab-label";
    const sub = document.createElement("span");
    sub.className = "stab-sub";
    text.append(label, sub);
    const time = document.createElement("span");
    time.className = "stab-time";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "stab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close session");
    const badge = document.createElement("span");
    badge.className = "stab-dot";
    badge.setAttribute("aria-hidden", "true");
    const av = document.createElement("span");
    av.className = "stab-av";
    av.setAttribute("aria-hidden", "true");
    tab.append(badge, av, text, time, close);
    const entry = { sid, tab, label, sub, time, badge, av, cwd: typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd : null, title: "session", name: opts.name ?? null, autoTitle: null, sessionFile: opts.sessionFile ?? null, fresh: opts.resume === false, status: { text: "not started" }, lastAt: Date.now(), unseen: false, asking: null, scripts: [], api: null };
    sessions.set(sid, entry);
    paintSessionStatus(entry);
    strip.append(tab);
    entry.api = createSession(sid, {
      status(text, kind) {
        const wasBusy = entry.status.kind === "busy";
        if (kind !== entry.status.kind) entry.lastAt = Date.now();
        entry.status = { text, kind };
        if (wasBusy && kind !== "busy" && layout.focused !== sid) entry.unseen = true;
        if (layout.focused === sid) entry.unseen = false;
        paintSessionStatus(entry);
        layout.setMeta(sid, { status: kind });
        if (wasBusy && kind !== "busy") {
          markAttention(sid);
          if (kind === "ok") notifyReply(entry);
          refreshSavedSoon();
          window.kostompRefreshAccounts?.(); // the turn may have rotated to another account
        }
      },
      /** A dialog/ask is waiting (`text` = what it asks) or was closed (`null`). */
      asking(text) {
        const was = entry.asking !== null;
        entry.asking = text;
        paintSessionStatus(entry);
        if (text !== null && !was) notifyQuestion(entry, text);
      },
      /** Names of saved scripts currently running from the activity panel; empty when none. */
      scripts(names) {
        entry.scripts = names;
        paintSessionStatus(entry);
      },
      cwd(cwd) {
        entry.cwd = cwd;
        retitle();
      },
      /**
       * Title omp reports for the session; `null` drops it. `fromFile` marks the name stored in the
       * session file (get_state / session_info_update): it is the source of truth, so it replaces a
       * remembered tab name. An extension's setTitle is shown but never persisted.
       */
      title(text, fromFile) {
        const t = typeof text === "string" && text.trim() ? text.trim().slice(0, 80) : null;
        if (fromFile && t && entry.name !== null) {
          entry.name = null;
          entry.autoTitle = t;
          retitle();
          return;
        }
        if (t === entry.autoTitle) return;
        entry.autoTitle = t;
        retitle();
      },
      sessionFile(file) {
        if (!file || file === entry.sessionFile) return;
        entry.sessionFile = file;
        save();
        retitle(); // the new file may carry favourite answers
        refreshSavedSoon();
      },
    }, opts);
    layout.makeDraggable(tab, sid);
    tab.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      layout.show(sid);
      window.kostompRefreshAccounts?.(); // each session pins its own account
      entry.api.focus();
    });
    tab.addEventListener("keydown", (e) => {
      if (e.target !== tab) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); layout.show(sid); entry.api.focus(); }
    });
    // Cancel the middle-button mousedown so Windows does not start autoscroll once the sidebar scrolls.
    tab.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    tab.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      close.click();
    });
    tab.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      const input = document.createElement("input");
      input.className = "stab-input";
      input.value = entry.title;
      input.maxLength = 40;
      input.setAttribute("aria-label", "Rename session");
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        // Confirming the shown title unchanged must not pin it as a hand-set name.
        if (save && name !== entry.title) {
          entry.name = name || null;
          // omp keeps the name in the session file too (an empty name only clears the tab label).
          if (name) entry.api.rename(name).then((ok) => ok && refreshSavedSoon());
        }
        input.remove();
        label.hidden = false;
        retitle();
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      label.hidden = true;
      label.after(input);
      input.select();
    });
    // A turn in flight is lost on close: the first click arms, a second one within 3 s confirms.
    let armed = null;
    close.addEventListener("click", () => {
      if (entry.api.busy && !armed) {
        tab.classList.add("armed");
        close.title = "Click again to stop the running turn and close";
        armed = setTimeout(() => { armed = null; tab.classList.remove("armed"); close.title = ""; }, 3000);
        return;
      }
      closeSession(sid);
    });
    retitle();
    paintTabs();
    return entry;
  }

  function closeSession(sid, stopped = false) {
    const entry = sessions.get(sid);
    if (!entry || sessions.size === 1) return; // the last session stays: the app always has a chat
    const order = [...sessions.keys()];
    const next = order[order.indexOf(sid) + 1] ?? order[order.indexOf(sid) - 1];
    if (!stopped) window.KostompRpcLifecycle.stop(sid).catch(() => {});
    entry.api.dispose();
    sessions.delete(sid);
    entry.tab.remove();
    layout.remove(sid);
    entry.api.el.remove();
    if (!layout.visible().length) layout.show(next);
    retitle();
    paintTabs();
    focusChat();
  }

  /** A fresh session in `from`'s folder. Without a zone it takes the focused pane (the old one keeps
   *  running as a tab); with one it opens beside `from`. */
  function newSession(from, zone) {
    const at = from ?? layout.focused;
    const src = sessions.get(at) ?? sessions.get(lastChatSid);
    const cwd = src?.api.cwd ?? null;
    if (!zone) {
      const blank = openBlank(cwd);
      if (blank) return blank;
    }
    const entry = addSession({ cwd, resume: false });
    if (zone && isTab(at)) layout.drop(entry.sid, at, zone);
    else placeChat(entry.sid);
    entry.api.focus();
    return entry;
  }
  /** An already-open empty chat in `cwd` is shown instead of opening a second one. */
  function openBlank(cwd) {
    const entry = [...sessions.values()].find((s) => s.fresh && s.api.cwd === cwd && s.api.blank);
    if (!entry) return null;
    placeChat(entry.sid);
    entry.api.focus();
    return entry;
  }
  /** Open a fresh chat in `cwd` (an empty one already there is reused) and send `prompt` as if typed + Enter. Resolves to the sid. */
  window.kostompStartChat = async ({ cwd, prompt, name } = {}) => {
    showView("chat");
    const entry = openBlank(cwd ?? null) ?? addSession({ cwd: cwd ?? null, resume: false, name: name ?? null });
    placeChat(entry.sid);
    entry.api.focus();
    if (cwd) window.KostompFolders.saveRecent(cwd);
    await entry.api.submitText(prompt);
    return entry.sid;
  };
  $("session-add").addEventListener("click", () => newSession());
  /** Open or close a tool panel (terminal, changes, browser, files) inside the chat that has focus. */
  function toggleTool(kind) {
    (sessions.get(layout.focused) ?? sessions.get(lastChatSid))?.api.toggleTool(kind);
  }
  document.addEventListener("keydown", (e) => {
    if ($("chat").hidden) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyL") {
      e.preventDefault();
      cycleLayout();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyN") {
      e.preventDefault();
      newSession();
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === "Backquote") {
      e.preventDefault();
      toggleTool("terminal");
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.code === "KeyT") { e.preventDefault(); newSession(); }
    else if (e.code === "Digit5") { e.preventDefault(); newSession(layout.focused, "right"); }
    else if (e.code === "KeyG") { e.preventDefault(); toggleTool("changes"); }
    else if (e.code === "KeyB") { e.preventDefault(); toggleTool("browser"); }
    else if (e.code === "KeyE") { e.preventDefault(); toggleTool("files"); }
  });

  // ---- named layouts: Alt+L cycles, the strip button opens the list ---------------------------
  const layoutBtn = $("layout-btn");
  const layoutMenu = $("layout-menu");
  const stateHas = (state, sid) => JSON.stringify(state?.tree ?? null).includes(`"${sid}"`);

  function switchLayout(id) {
    const target = layouts.find((l) => l.id === id);
    if (!target || id === activeLayout) return;
    const cur = layouts.find((l) => l.id === activeLayout);
    if (cur) cur.state = layout.serialize();
    activeLayout = id;
    attention.delete(id);
    if (!layout.restore(target.state, isTab)) {
      // Nothing of that arrangement is left (its sessions were closed): start it from the focused session.
      layout.show(layout.focused ?? [...sessions.keys()][0]);
    }
    paintLayoutBtn();
    paintLayoutMenu();
    save();
    focusChat();
  }
  function cycleLayout() {
    if (layouts.length < 2) return;
    const i = layouts.findIndex((l) => l.id === activeLayout);
    switchLayout(layouts[(i + 1) % layouts.length].id);
  }
  function addLayout() {
    const cur = layouts.find((l) => l.id === activeLayout);
    if (cur) cur.state = layout.serialize();
    const name = nextLayoutName();
    const id = "l" + ++layoutSeq;
    layouts.push({ id, name, state: layout.serialize() });
    activeLayout = id;
    paintLayoutBtn();
    paintLayoutMenu();
    save();
  }
  function nextLayoutName() {
    let n = layouts.length + 1;
    while (layouts.some((l) => l.name === `Layout ${n}`)) n++;
    return `Layout ${n}`;
  }
  function deleteLayout(id) {
    if (layouts.length < 2) return;
    const wasActive = id === activeLayout;
    const i = layouts.findIndex((l) => l.id === id);
    if (wasActive) {
      const next = layouts[i + 1] ?? layouts[i - 1];
      layouts[i].state = null;
      switchLayout(next.id);
    }
    layouts = layouts.filter((l) => l.id !== id);
    attention.delete(id);
    paintLayoutBtn();
    paintLayoutMenu();
    save();
  }
  /** True while `entry` is the chat in front of a visible window: nothing to announce then. */
  function isOpen(entry) {
    return !document.hidden && !$("chat").hidden && layout.focused === entry.sid;
  }
  /** A turn finished in a chat that is not open: raise a toast; clicking it opens this session. */
  function notifyReply(entry) {
    if (isOpen(entry)) return;
    const text = entry.api.lastAnswer().replace(/[`*_#>~|]/g, "").replace(/\s+/g, " ").trim();
    const body = text.length > 220 ? text.slice(0, 219) + "…" : text || "Yanıt hazır";
    invoke("notify_reply", { sid: entry.sid, title: entry.title, body }).catch(() => {});
  }
  /** A question waits in `entry`: toast unless that chat is open. */
  function notifyQuestion(entry, text) {
    if (isOpen(entry)) return;
    const body = text.replace(/[`*_#>~|]/g, "").replace(/\s+/g, " ").trim().slice(0, 220) || "Bir soru soruldu";
    invoke("notify_reply", { sid: entry.sid, title: entry.title, body }).catch(() => {});
  }
  function openSession(entry) {
    if (!layout.has(entry.sid)) {
      const owner = layouts.find((l) => l.id !== activeLayout && stateHas(l.state, entry.sid));
      if (owner) switchLayout(owner.id);
    }
    showView("chat");
    layout.show(entry.sid);
    entry.api.focus();
  }
  listen("notify-activate", (e) => {
    const entry = sessions.get(e.payload);
    if (entry) openSession(entry);
  });
  /** A turn finished in a session the current layout doesn't show: flag the layouts that do. */
  function markAttention(sid) {
    if (restoring || layout.has(sid)) return;
    for (const l of layouts) if (l.id !== activeLayout && stateHas(l.state, sid)) attention.add(l.id);
    paintLayoutBtn();
    if (!layoutMenu.hidden) paintLayoutMenu();
  }
  function paintLayoutBtn() {
    const cur = layouts.find((l) => l.id === activeLayout);
    layoutBtn.classList.toggle("attention", attention.size > 0);
    layoutBtn.title = cur ? `Layout: ${cur.name} (Alt+L switches)` : "Layouts (Alt+L switches)";
  }
  function paintLayoutMenu() {
    const heading = document.createElement("h3");
    heading.textContent = "Layouts";
    layoutMenu.replaceChildren(heading);
    for (const l of layouts) {
      const row = document.createElement("div");
      row.className = "layout-item" + (l.id === activeLayout ? " on" : "");
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(l.id === activeLayout));
      row.tabIndex = 0;
      const check = document.createElement("span");
      check.className = "layout-check";
      check.textContent = l.id === activeLayout ? "✓" : "";
      const name = document.createElement("span");
      name.className = "layout-label";
      name.textContent = l.name;
      const dot = document.createElement("span");
      dot.className = "layout-attn";
      dot.hidden = !attention.has(l.id);
      dot.title = "A response arrived in this layout";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "layout-act";
      edit.title = "Rename";
      edit.setAttribute("aria-label", "Rename layout");
      edit.textContent = "✎";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "layout-act";
      del.title = "Delete";
      del.setAttribute("aria-label", "Delete layout");
      del.textContent = "×";
      del.hidden = layouts.length < 2;
      row.append(check, name, dot, edit, del);
      const rename = () => {
        const input = document.createElement("input");
        input.className = "layout-input";
        input.value = l.name;
        input.maxLength = 30;
        input.setAttribute("aria-label", "Layout name");
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          const v = input.value.trim();
          if (ok && v) l.name = v;
          paintLayoutMenu();
          paintLayoutBtn();
          save();
        };
        input.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") finish(true);
          if (ev.key === "Escape") finish(false);
        });
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("click", (ev) => ev.stopPropagation());
        name.replaceWith(input);
        input.select();
      };
      row.addEventListener("click", (e) => {
        if (e.target.closest(".layout-act") || e.target.closest(".layout-input")) return;
        switchLayout(l.id);
        toggleLayoutMenu(false);
      });
      row.addEventListener("keydown", (e) => {
        if (e.target !== row) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchLayout(l.id); toggleLayoutMenu(false); }
        if (e.key === "F2") rename();
      });
      edit.addEventListener("click", rename);
      del.addEventListener("click", () => deleteLayout(l.id));
      layoutMenu.append(row);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "layout-add";
    add.textContent = "+ Save current layout as new";
    add.addEventListener("click", addLayout);
    layoutMenu.append(add);
  }
  function toggleLayoutMenu(open) {
    const next = open === undefined ? layoutMenu.hidden : open;
    layoutMenu.hidden = !next;
    layoutBtn.setAttribute("aria-expanded", String(next));
    if (next) {
      // Body-level popover: left-aligned to the button, opening upward.
      const box = layoutBtn.getBoundingClientRect();
      layoutMenu.style.left = Math.max(8, Math.min(box.left, innerWidth - layoutMenu.offsetWidth - 8)) + "px";
      layoutMenu.style.bottom = innerHeight - box.top + 6 + "px";
      paintLayoutMenu();
      layoutMenu.querySelector(".layout-item[aria-checked=true]")?.focus();
    } else focusChat();
  }
  layoutBtn.addEventListener("click", () => toggleLayoutMenu());
  document.addEventListener("pointerdown", (e) => {
    if (!layoutMenu.hidden && !e.target.closest(".layout-anchor, #layout-menu")) toggleLayoutMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !layoutMenu.hidden) { toggleLayoutMenu(false); layoutBtn.focus(); }
  });

  // ---- startup: rebuild the saved workspace, else one session that continues the folder's latest ---
  const saved = loadSaved();
  if (saved) {
    for (const s of saved.sessions) {
      addSession({ sid: s.sid, cwd: s.cwd ?? null, name: s.name ?? null, sessionFile: s.sessionFile ?? null, resume: s.sessionFile ?? false });
    }
    nextSid = Math.max(Number(saved.nextSid) || 0, ...[...sessions.keys()].map((k) => Number(k.slice(1)) || 0));
    layouts = (Array.isArray(saved.layouts) ? saved.layouts : []).filter((l) => l && typeof l.id === "string" && typeof l.name === "string");
    layoutSeq = Math.max(0, ...layouts.map((l) => Number(l.id.slice(1)) || 0));
    activeLayout = layouts.some((l) => l.id === saved.active) ? saved.active : layouts[0]?.id ?? null;
  } else {
    addSession({ cwd: null, resume: true });
  }
  if (!layouts.length) {
    layouts = [{ id: "l" + ++layoutSeq, name: "Layout 1", state: null }];
    activeLayout = layouts[0].id;
  }
  {
    const cur = layouts.find((l) => l.id === activeLayout);
    if (!cur.state || !layout.restore(cur.state, isTab)) layout.show([...sessions.keys()][0]);
  }
  restoring = false;
  paintLayoutBtn();
  saveNow();
  if (!$("chat").hidden) sessions.get(layout.focused)?.api.focus();

  // ---- bridge for settings.js (talks to omp through whichever session has focus) -------------
  const current = () => sessions.get(layout.focused) ?? sessions.get(lastChatSid) ?? sessions.get(layout.visible().find((sid) => sessions.has(sid))) ?? sessions.values().next().value;
  let loginApi = null; // the session running `login`, so a cancel reaches the same omp
  window.kostompRpc = {
    request: (type, params, timeoutMs) => current().api.request(type, params, timeoutMs),
    /**
     * Run `login` on the focused session with `onUi(req, respond) => boolean` seeing the flow's
     * UI requests (open_url, input, notify, cancel) first. Resolves `{ providerId }`; a
     * `loginCancel()` rejects it with "Login cancelled".
     */
    login: async (providerId, onUi) => {
      const api = current().api;
      api.setUiInterceptor(onUi);
      loginApi = api;
      try {
        return await api.request("login", { providerId }, 600_000);
      } finally {
        if (loginApi === api) loginApi = null;
        api.setUiInterceptor(null);
      }
    },
    /** `login_cancel` on the session running `login`; resolves true when one was cancelled. */
    loginCancel: async () => {
      const api = loginApi;
      if (!api) return false;
      const data = await api.request("login_cancel", {});
      return data?.cancelled === true;
    },
    /** Re-read the scoped model list into every session's model picker. */
    refreshModels: () => { for (const s of sessions.values()) s.api.refreshModels(); },
    /**
     * Send one command to every running session. Resolves `{ sent, failed }`; `failed` holds the
     * error text of each session that rejected it (e.g. an older omp without the command).
     */
    broadcast: async (type, params, timeoutMs) => {
      const live = [...sessions.values()].filter((s) => s.api.alive);
      const results = await Promise.allSettled(live.map((s) => s.api.request(type, params, timeoutMs)));
      const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
      return { sent: live.length, failed };
    },
  };

  // ---- sidebar footer: stored Claude (anthropic) accounts. The connected one is the footer button;
  // it unfolds the others above it, and a click on one pins it to the session. ---------------------
  const acctBox = $("side-accounts");
  const acctList = $("side-accounts-list");
  const acctMenu = $("side-accounts-menu");
  const acctBtn = $("side-acct");
  let acctBusy = false;
  let acctAgain = false;
  let acctSwitchPending = false;
  function setAcctMenu(open) {
    acctBtn.setAttribute("aria-expanded", String(open));
    acctMenu.classList.toggle("open", open);
    acctMenu.inert = !open;
  }
  setAcctMenu(false);
  acctBtn.addEventListener("click", () => {
    if (acctList.childElementCount) setAcctMenu(acctBtn.getAttribute("aria-expanded") !== "true");
  });
  const initial = (label) => label.trim().charAt(0).toUpperCase() || "?";
  let acctRetry = 0;
  async function refreshAccounts() {
    if (acctBusy) { acctAgain = true; return; }
    acctBusy = true;
    try {
      const cur = current();
      if (!cur || !cur.api.alive) throw new Error("not ready");
      const res = await cur.api.request("get_logout_accounts", { providerId: "anthropic" });
      let sess = null;
      try { sess = await cur.api.request("get_session_accounts", { providerId: "anthropic" }); } catch { /* switching unavailable */ }
      const canPin = !!sess && Array.isArray(sess.accounts);
      const activeId = canPin ? (sess.accounts.find((s) => s && s.active) || {}).credentialId : null;
      const list = (Array.isArray(res) ? res : res && Array.isArray(res.accounts) ? res.accounts : [])
        .filter((a) => a && Number.isInteger(a.credentialId) && a.type !== "api_key")
        .sort((a, b) => a.credentialId - b.credentialId);
      acctList.replaceChildren();
      acctBox.hidden = list.length === 0;
      let connected = null;
      for (const a of list) {
        const inUse = canPin ? a.credentialId === activeId : !!a.active;
        const info = canPin ? sess.accounts.find((s) => s && s.credentialId === a.credentialId) : null;
        const label = (typeof a.label === "string" && a.label) || info?.email || "account " + a.credentialId;
        if (inUse && connected === null) { connected = label; continue; }
        const row = document.createElement("button");
        row.type = "button";
        row.className = "sacct";
        row.title = label + (canPin ? " (click to connect)" : "");
        const av = document.createElement("span");
        av.className = "sacct-av";
        av.setAttribute("aria-hidden", "true");
        av.textContent = initial(label);
        const name = document.createElement("span");
        name.className = "sacct-name";
        name.textContent = label;
        row.append(av, name);
        row.addEventListener("click", async () => {
          if (!canPin || acctSwitchPending) return;
          acctSwitchPending = true;
          for (const button of acctList.querySelectorAll(".sacct")) button.disabled = true;
          try {
            await current().api.request("pin_session_account", { credentialId: a.credentialId, providerId: "anthropic" });
            setAcctMenu(false);
          } catch { /* e.g. a response is streaming; the refresh below shows the real state */ }
          finally {
            acctSwitchPending = false;
            for (const button of acctList.querySelectorAll(".sacct")) button.disabled = false;
          }
          refreshAccounts();
        });
        acctList.append(row);
      }
      const shown = connected ?? "Claude accounts";
      acctBtn.querySelector(".sacct-av").textContent = connected === null ? String(list.length) : initial(connected);
      acctBtn.querySelector(".sacct-name").textContent = shown;
      acctBtn.querySelector(".acct-status").hidden = connected === null;
      acctBtn.classList.toggle("solo", acctList.childElementCount === 0);
      acctBtn.title = connected === null ? shown : connected + " (connected)";
      if (!acctList.childElementCount) setAcctMenu(false);
      acctRetry = 0;
    } catch {
      // omp not ready yet (or no Claude login): try again a few times, then wait for an explicit refresh.
      if (acctRetry++ < 8) setTimeout(refreshAccounts, 2500);
    } finally {
      acctBusy = false;
      if (acctAgain) { acctAgain = false; refreshAccounts(); }
    }
  }
  window.kostompRefreshAccounts = refreshAccounts;
  setTimeout(refreshAccounts, 1500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAccounts(); });

  // ---- saved sessions: every omp session on disk, grouped by folder -------------------------
  // A click opens the session in the focused tab (`switch_session`), ↗ opens it in a new tab
  // (`--resume`). Sessions another omp process holds (`get_session_lease`) are marked and not opened.
  const savedList = savedEl.querySelector("#saved-list");
  const savedSearch = savedEl.querySelector("#saved-search");
  let savedRows = []; // last list_sessions answer
  let savedHeld = new Set(); // session ids leased by a process other than ours
  let savedSeq = 0;
  let savedTimer = 0;
  let savedPaintFrame = 0;
  const pathKey = (p) => p.replace(/\//g, "\\").toLowerCase();
  const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
  const tabFor = (path) => [...sessions.values()].find((s) => samePath(s.api.sessionFile ?? s.sessionFile, path));
  /** Normalised session file -> its tab (the first, like tabFor), for checking many paths at once. */
  function tabsByPath() {
    const map = new Map();
    for (const s of sessions.values()) {
      const p = s.api.sessionFile ?? s.sessionFile;
      if (p && !map.has(pathKey(p))) map.set(pathKey(p), s);
    }
    return map;
  }
  const tabIn = (tabs, path) => (path ? tabs.get(pathKey(path)) : undefined);
  function ago(when) {
    const t = new Date(when).getTime();
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    return new Date(t).toLocaleDateString();
  }
  /** A session whose omp already answers: the focused one first, else any other ready tab. */
  const readySession = () => {
    const first = current();
    if (first?.api.alive && first.api.ready) return first;
    return [...sessions.values()].find((s) => s.api.alive && s.api.ready) ?? null;
  };
  async function refreshSaved() {
    const mine = ++savedSeq;
    // The list is global (all folders), so any running omp can answer it.
    let source = readySession();
    if (!source) {
      if (!savedRows.length) {
        const wait = document.createElement("div");
        wait.className = "saved-empty";
        wait.textContent = "omp is starting…";
        savedList.replaceChildren(wait);
        savedStale = false;
      }
      source = current();
    }
    try {
      if (!source) throw new Error("no session is open");
      const data = await source.api.request("list_sessions", { all: true, limit: 500 });
      const list = (Array.isArray(data?.sessions) ? data.sessions : []).filter((s) => s && typeof s.path === "string");
      const ids = list.map((s) => s.id).filter((id) => typeof id === "string" && id);
      let held = [];
      if (ids.length) {
        try {
          const lease = await source.api.request("get_session_lease", { sessionIds: ids });
          held = Array.isArray(lease?.held) ? lease.held : [];
        } catch {} // no lease info: show everything as free
      }
      if (mine !== savedSeq) return;
      savedRows = list;
      // Titles omp assigned itself (auto-generated) only show up in the saved list: carry them onto the tabs.
      let changed = false;
      for (const s of sessions.values()) {
        if (s.name !== null || s.autoTitle || !s.sessionFile) continue;
        const row = list.find((r) => r.path === s.sessionFile);
        const t = typeof row?.title === "string" ? row.title.trim().slice(0, 80) : "";
        if (!t) continue;
        s.autoTitle = t;
        changed = true;
      }
      if (changed) retitle();
      // The lease also counts our own processes: those sessions are open in a tab, not "in use".
      const byId = new Map();
      for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
      const tabs = tabsByPath();
      savedHeld = new Set(held.filter((id) => !tabIn(tabs, byId.get(id)?.path)));
      // Hidden, the rows would be built for nothing: paint when the layout mounts the panel.
      if (savedEl.isConnected) paintSaved();
      else savedStale = true;
    } catch (e) {
      if (mine !== savedSeq) return;
      const err = document.createElement("div");
      err.className = "saved-empty";
      err.textContent = "Could not list sessions: " + String(e?.message ?? e);
      savedList.replaceChildren(err);
      savedStale = false;
    }
  }
  function refreshSavedSoon() {
    if (restoring) return;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(refreshSaved, 600);
  }
  document.addEventListener("kostomp-favs", () => {
    retitle();
    if (savedEl.isConnected) paintSaved();
    else savedStale = true;
  });
  function paintSaved() {
    savedStale = false;
    cancelAnimationFrame(savedPaintFrame);
    savedPaintFrame = 0;
    const tabs = tabsByPath();
    const q = savedSearch.value.trim().toLowerCase();
    const shown = q
      ? savedRows.filter((s) => [s.title, s.cwd, s.path].some((v) => typeof v === "string" && v.toLowerCase().includes(q)))
      : savedRows;
    const groups = new Map(); // cwd -> sessions, in list order (newest first)
    for (const s of shown) {
      const key = typeof s.cwd === "string" ? s.cwd : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    savedList.replaceChildren();
    for (const [cwd, rows] of groups) {
      const head = document.createElement("div");
      head.className = "saved-group";
      head.textContent = cwd ? baseName(cwd) : "(no folder)";
      head.title = cwd;
      savedList.append(head);
      for (const s of rows) savedList.append(savedRow(s, tabs));
    }
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "saved-empty";
      empty.textContent = q ? "No session matches." : "No saved sessions.";
      savedList.append(empty);
    }
  }
  function savedRow(s, tabs) {
    const open = tabIn(tabs, s.path);
    const held = savedHeld.has(s.id);
    const row = document.createElement("div");
    row.className = "layout-item saved-row" + (open ? " on" : "") + (held ? " held" : "");
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    const title = typeof s.title === "string" && s.title.trim() ? s.title.trim() : baseName(s.path);
    row.title = `${title}\n${s.path}` + (held ? "\nOpen in another omp process" : open ? "\nOpen in a tab" : "");
    const text = document.createElement("span");
    text.className = "layout-label";
    text.textContent = (s.pinned || window.kostompFavs.any(s.path) ? "★ " : "") + title;
    const meta = document.createElement("span");
    meta.className = "saved-meta";
    const count = Number(s.messageCount);
    meta.textContent = held ? "in use" : [Number.isFinite(count) ? count + " msg" : "", ago(s.mtime)].filter(Boolean).join(" · ");
    if (held) meta.classList.add("saved-held");
    row.append(text, meta);
    const act = (label, tip, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "layout-act";
      b.textContent = label;
      b.title = tip;
      b.setAttribute("aria-label", tip);
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      row.append(b);
    };
    if (!open && !held) act("↗", "Open in a new tab", () => openSavedInTab(s));
    if (!held) act("✎", "Rename", () => renameSaved(row, text, open, title, s.path));
    if (!held) act("⌫", "Delete session permanently", () => void deleteChat(s.path, title));
    const activate = async () => {
      if (open) {
        layout.show(open.sid);
        open.api.focus();
        return;
      }
      if (held) return;
      const target = current();
      placeChat(target.sid);
      if (await target.api.switchTo(s.path, undefined, s.cwd)) refreshSavedSoon();
    };
    row.addEventListener("click", (e) => {
      if (e.target.closest(".layout-act, .layout-input")) return;
      activate();
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
    return row;
  }
  function openSavedInTab(s) {
    const entry = addSession({ cwd: typeof s.cwd === "string" && s.cwd ? s.cwd : null, sessionFile: s.path, resume: s.path });
    placeChat(entry.sid);
    entry.api.focus();
    refreshSavedSoon();
  }

  const deletingChats = new Set();
  async function deleteChat(path, title) {
    if (!path || deletingChats.has(path)) return;
    deletingChats.add(path);
    try {
      if (!await window.kostompConfirmDelete(`Delete "${title}"?`,
        "This permanently removes the conversation and its saved artifacts. Any running turn in this chat will be stopped. This cannot be undone.")) return;
      const matches = [...sessions.values()].filter(s => samePath(s.api.sessionFile ?? s.sessionFile, path));
      if (matches.length === sessions.size) {
        const replacement = addSession({ cwd: matches[0]?.api.cwd ?? null, resume: false });
        // request() waits for the new process's initial state before sending.
        await replacement.api.request("get_state");
      }
      for (const s of matches) {
        await window.KostompRpcLifecycle.stop(s.sid);
        closeSession(s.sid, true);
      }
      const source = readySession() ?? current();
      if (!source) throw new Error("No chat is available to delete the saved session");
      await source.api.request("delete_session", { path });
      window.kostompFavs.forget(path);
      await refreshSaved();
    } catch (error) {
      const message = document.createElement("div");
      message.className = "saved-empty";
      message.setAttribute("role", "alert");
      message.textContent = "Could not delete session: " + String(error?.message ?? error);
      layout.show(LIST_SID);
      savedList.prepend(message);
    } finally {
      deletingChats.delete(path);
    }
  }
  /** Rename a saved session: through its tab when open, else `rename_session` on its file. */
  async function renameSessionFile(path, name) {
    const source = readySession();
    if (!source) return false;
    try {
      await source.api.request("rename_session", { path, name });
      return true;
    } catch (e) {
      const err = document.createElement("div");
      err.className = "saved-empty";
      err.textContent = "Could not rename: " + String(e?.message ?? e);
      savedList.prepend(err);
      setTimeout(() => err.remove(), 4000);
      return false;
    }
  }
  function renameSaved(row, text, entry, currentTitle, path) {
    if (row.querySelector(".layout-input")) return;
    const input = document.createElement("input");
    input.className = "layout-input";
    input.value = currentTitle;
    input.maxLength = 80;
    input.setAttribute("aria-label", "Session name");
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove();
      text.hidden = false;
      if (!ok || !v || v === currentTitle) return;
      if (entry) {
        if (await entry.api.rename(v)) {
          entry.name = v;
          retitle();
          refreshSaved();
        }
      } else if (await renameSessionFile(path, v)) {
        refreshSaved();
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    text.hidden = true;
    text.after(input);
    input.select();
  }
  savedSearch.addEventListener("input", () => {
    if (!savedPaintFrame) savedPaintFrame = requestAnimationFrame(paintSaved);
  });
  savedSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && savedSearch.value) { e.stopPropagation(); savedSearch.value = ""; paintSaved(); }
  });
  savedEl.querySelector("#saved-refresh").addEventListener("click", refreshSaved);
  refreshSaved(); // waits for the focused session's process to be ready

  // ---- process events, routed by session id ------------------------------
  listen("rpc-frames", (e) => {
    const [id, lines] = e.payload;
    // Design boards share this event; their lines are not ours to parse.
    const api = sessions.get(id)?.api;
    if (!api) return;
    for (const line of lines) {
      // A frame earlier in the batch may have closed or replaced the session.
      if (sessions.get(id)?.api !== api) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        api.onBadFrame(line, err);
        continue;
      }
      api.onFrame(frame);
    }
  });
  listen("rpc-stderr", (e) => {
    const [id, line] = Array.isArray(e.payload) ? e.payload : [];
    sessions.get(id)?.api.onStderr(line);
  });
  listen("rpc-exit", (e) => sessions.get(e.payload)?.api.onExit());
})();
