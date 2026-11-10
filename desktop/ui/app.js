// Kostomp shell: several chat sessions (each its own `omp --mode rpc-ui` process, see session.js)
// laid out in split panes (layout.js), plus the stats dashboard and settings.
// The Rust side forwards raw JSONL lines tagged with the session id; this file routes them.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  let layout = null; // set up below; showView() runs before that
  const sessions = new Map(); // sid -> { sid, api, tab, cwd, status: { text, kind } }
  const focusChat = () => sessions.get(layout?.focused)?.api.focus();
  // ---- tabs: Chat | Stats | Settings (settings.js fills the last). Graph lives inside Chat: its pane and
  // runs share the chat sidebar (graph.js). --------
  const VIEW_KEY = "kostomp-view";
  const VIEWS = ["chat", "stats", "settings"];
  const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
  const gear = $("gear");
  function showView(name) {
    for (const view of VIEWS) $(view).hidden = view !== name;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    $("tabs").dataset.view = tabs.some((t) => t.dataset.view === name) ? name : "none";
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
  let statsOrigin = null;
  function postStatsTheme() {
    if (statsOrigin) statsFrame.contentWindow?.postMessage({ type: "kostomp-theme", theme: themePref }, statsOrigin);
  }
  // Re-sync after every dashboard load (the bridge ignores a preference it already has).
  statsFrame.addEventListener("load", postStatsTheme);
  function applyStats(result) {
    if (!result) return;
    if ("Ok" in result) {
      const frame = statsFrame;
      if (!statsOrigin) {
        statsOrigin = new URL(result.Ok).origin;
        // First load carries the preference in the URL so the dashboard paints in it at once.
        frame.src = result.Ok + "/?kostomp-theme=" + themePref;
      }
      frame.hidden = false;
      $("stats-wait").hidden = true;
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
  const statusBox = $("status");
  let nextSid = 0;
  const AVATAR_COLORS = ["#6d4aff", "#ff6b5b", "#19c9a0", "#f5a60b", "#3d9bff", "#e0489e"];
  let avatarSeq = 0;

  // ---- collapsible session sidebar (state persists) ----
  const sidebar = $("sidebar");
  const sideToggle = $("side-toggle");
  function setSidebar(collapsed, persist = true) {
    sidebar.classList.toggle("collapsed", collapsed);
    sideToggle.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    sideToggle.setAttribute("aria-label", label);
    sideToggle.title = label + " (Ctrl+B)";
    if (persist) try { localStorage.setItem("kostomp-sidebar", collapsed ? "1" : "0"); } catch {}
  }
  setSidebar(localStorage.getItem("kostomp-sidebar") === "1", false);
  sideToggle.addEventListener("click", () => setSidebar(!sidebar.classList.contains("collapsed")));
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyB" && !$("chat").hidden) {
      e.preventDefault();
      setSidebar(!sidebar.classList.contains("collapsed"));
    }
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
  const savedEl = $("saved");
  savedEl.remove();
  savedEl.hidden = false;
  let lastChatSid = null; // the chat that last had focus (the list pane has none)
  const isTab = (sid) => sid === LIST_SID || sessions.has(sid);

  layout = createLayout($("workspace"), {
    sessionEl: (sid) => (sid === LIST_SID ? savedEl : sessions.get(sid)?.api.el),
    onFocus: () => {
      document.dispatchEvent(new CustomEvent("kostomp-chat-shown"));
      if (sessions.has(layout.focused)) lastChatSid = layout.focused;
      paintTabs();
      paintTopStatus();
      $("sessions-open").classList.toggle("active", layout.focused === LIST_SID);
    },
    onChange: () => { paintTabs(); save(); },
    split: (sid, zone) => newSession(sid, zone),
    pinned: (sid) => sid === LIST_SID,
  });
  layout.setMeta(LIST_SID, { title: "Sessions" });
  $("sessions-open").addEventListener("click", () => {
    layout.show(LIST_SID);
    refreshSaved();
    savedEl.querySelector("input")?.focus();
  });
  /** Bring a chat into view; from the list pane it opens beside the list instead of replacing it. */
  function placeChat(sid) {
    if (layout.has(sid) || layout.focused !== LIST_SID) layout.show(sid);
    else layout.drop(sid, LIST_SID, "right");
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
      s.label.textContent = s.title;
      s.avatar.textContent = (Array.from(s.title.trim())[0] ?? "?").toLocaleUpperCase();
      s.tab.title = s.cwd ? `${s.cwd} — drag onto the workspace to split` : "starting…";
      layout.setMeta(s.sid, { title: s.title });
    }
    groupTabs();
    save();
  }
  const groupHeads = new Map(); // cwd -> header element
  const COLLAPSED_KEY = "kostomp-collapsed-projects";
  const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) ?? []; } catch { return []; } })());
  function setCollapsed(key, on) {
    if (on) collapsed.add(key); else collapsed.delete(key);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {}
    groupTabs();
  }
  /** Sidebar order: one header per project folder, its tabs underneath (first-opened project first).
   *  Clicking a header folds its tabs; its + opens a new chat in that project. */
  function groupTabs() {
    const groups = new Map();
    for (const s of sessions.values()) {
      const key = s.cwd ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    for (const [key, head] of groupHeads) {
      if (groups.has(key)) continue;
      head.remove();
      groupHeads.delete(key);
    }
    for (const [key, rows] of groups) {
      let head = groupHeads.get(key);
      if (!head) {
        head = document.createElement("div");
        head.className = "stab-group";
        head.setAttribute("role", "button");
        head.tabIndex = 0;
        const chev = document.createElement("span");
        chev.className = "stab-group-chev";
        chev.setAttribute("aria-hidden", "true");
        chev.textContent = "▾";
        const name = document.createElement("span");
        name.className = "stab-group-name";
        const add = document.createElement("button");
        add.type = "button";
        add.className = "stab-group-add";
        add.textContent = "+";
        head.append(chev, name, add);
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
          const entry = addSession({ cwd: k, resume: false });
          placeChat(entry.sid);
          entry.api.focus();
        });
        groupHeads.set(key, head);
      }
      head.dataset.key = key;
      const isCollapsed = collapsed.has(key);
      head.classList.toggle("collapsed", isCollapsed);
      head.setAttribute("aria-expanded", String(!isCollapsed));
      head.querySelector(".stab-group-name").textContent = key ? baseName(key) : "starting…";
      const add = head.querySelector(".stab-group-add");
      add.hidden = !key;
      add.title = `New chat in ${baseName(key)}`;
      add.setAttribute("aria-label", add.title);
      head.title = key;
      for (const s of rows) s.tab.hidden = isCollapsed;
      strip.append(head, ...rows.map((s) => s.tab));
    }
  }
  function paintTopStatus() {
    const s = sessions.get(layout.focused);
    statusBox.textContent = s ? s.status.text : "";
    statusBox.className = "status" + (s?.status.kind ? " " + s.status.kind : "");
  }
  /** Sidebar badge: coral while a question waits for an answer, amber while working, green for a finished turn not yet visited, red on error, none otherwise. */
  function paintDot(s) {
    const kind = s.status.kind;
    const state = s.asking !== null ? "ask" : kind === "busy" ? "busy" : kind === "bad" ? "bad" : s.unseen ? "ok" : "idle";
    s.dot.className = "dot " + state;
    s.tab.classList.toggle("asking", s.asking !== null);
  }
  function paintTabs() {
    const shown = new Set(layout.visible());
    for (const s of sessions.values()) {
      s.tab.classList.toggle("active", s.sid === layout.focused);
      if (s.sid === layout.focused && s.unseen) {
        s.unseen = false;
        paintDot(s);
      }
      s.tab.classList.toggle("shown", shown.has(s.sid));
      s.tab.setAttribute("aria-selected", String(s.sid === layout.focused));
      if (s.sid === layout.focused) s.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    strip.classList.toggle("single", sessions.size === 1);
  }

  function addSession(opts) {
    const sid = opts.sid ?? "s" + ++nextSid;
    const tab = document.createElement("div");
    tab.className = "stab";
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
    const dot = document.createElement("span");
    dot.className = "dot idle";
    const label = document.createElement("span");
    label.className = "stab-label";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "stab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close session");
    const avatar = document.createElement("span");
    avatar.className = "stab-av";
    avatar.style.setProperty("--c", AVATAR_COLORS[avatarSeq++ % AVATAR_COLORS.length]);
    avatar.setAttribute("aria-hidden", "true");
    tab.append(avatar, label, dot, close);
    const entry = { sid, tab, label, avatar, dot, cwd: null, title: "session", name: opts.name ?? null, autoTitle: null, sessionFile: opts.sessionFile ?? null, status: { text: "starting…" }, unseen: false, asking: null, api: null };
    sessions.set(sid, entry);
    strip.insertBefore(tab, $("session-add"));
    entry.api = createSession(sid, {
      status(text, kind) {
        const wasBusy = entry.status.kind === "busy";
        entry.status = { text, kind };
        if (wasBusy && kind !== "busy" && layout.focused !== sid) entry.unseen = true;
        if (layout.focused === sid) entry.unseen = false;
        paintDot(entry);
        tab.classList.toggle("busy", kind === "busy");
        layout.setMeta(sid, { status: kind });
        if (layout.focused === sid) paintTopStatus();
        if (wasBusy && kind !== "busy") {
          markAttention(sid);
          if (kind === "ok") notifyReply(entry);
          refreshSavedSoon();
        }
      },
      /** A dialog/ask is waiting (`text` = what it asks) or was closed (`null`). */
      asking(text) {
        const was = entry.asking !== null;
        entry.asking = text;
        paintDot(entry);
        if (text !== null && !was) notifyQuestion(entry, text);
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
        refreshSavedSoon();
      },
    }, opts);
    layout.makeDraggable(tab, sid);
    tab.addEventListener("click", (e) => {
      if (e.target === close) return;
      layout.show(sid);
      entry.api.focus();
    });
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); layout.show(sid); entry.api.focus(); }
    });
    tab.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      close.click();
    });
    tab.addEventListener("dblclick", (e) => {
      if (e.target === close) return;
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

  function closeSession(sid) {
    const entry = sessions.get(sid);
    if (!entry || sessions.size === 1) return; // the last session stays: the app always has a chat
    const order = [...sessions.keys()];
    const next = order[order.indexOf(sid) + 1] ?? order[order.indexOf(sid) - 1];
    invoke("rpc_stop", { id: sid }).catch(() => {});
    entry.api.dispose();
    sessions.delete(sid);
    entry.tab.remove();
    layout.remove(sid);
    entry.api.el.remove();
    if (!layout.visible().length) layout.show(next);
    retitle();
    paintTabs();
    paintTopStatus();
    focusChat();
  }

  /** A fresh session in `from`'s folder. Without a zone it takes the focused pane (the old one keeps
   *  running as a tab); with one it opens beside `from`. */
  function newSession(from, zone) {
    const at = from ?? layout.focused;
    const src = sessions.get(at) ?? sessions.get(lastChatSid);
    const entry = addSession({ cwd: src?.api.cwd ?? null, resume: false });
    if (zone && isTab(at)) layout.drop(entry.sid, at, zone);
    else placeChat(entry.sid);
    entry.api.focus();
    return entry;
  }
  $("session-add").addEventListener("click", () => newSession());
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
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.code === "KeyT") { e.preventDefault(); newSession(); }
    else if (e.code === "Digit5") { e.preventDefault(); newSession(layout.focused, "right"); }
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
    layoutBtn.querySelector(".layout-name").textContent = cur?.name ?? "";
    layoutBtn.classList.toggle("attention", attention.size > 0);
    layoutBtn.title = "Layouts (Alt+L switches)";
  }
  function paintLayoutMenu() {
    layoutMenu.replaceChildren();
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
    if (next) paintLayoutMenu();
    else focusChat();
  }
  layoutBtn.addEventListener("click", () => toggleLayoutMenu());
  document.addEventListener("pointerdown", (e) => {
    if (!layoutMenu.hidden && !e.target.closest(".layout-anchor")) toggleLayoutMenu(false);
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
  const current = () => sessions.get(layout.focused) ?? sessions.get(lastChatSid) ?? sessions.values().next().value;
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

  // ---- sidebar: stored Claude (anthropic) accounts, the one this session uses is marked -------
  const acctBox = $("side-accounts");
  const acctList = $("side-accounts-list");
  let acctBusy = false;
  let acctRetry = 0;
  async function refreshAccounts() {
    if (acctBusy) return;
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
        .filter((a) => a && Number.isInteger(a.credentialId) && a.type !== "api_key");
      acctList.replaceChildren();
      acctBox.hidden = list.length === 0;
      for (const a of list) {
        const inUse = canPin ? a.credentialId === activeId : !!a.active;
        const info = canPin ? sess.accounts.find((s) => s && s.credentialId === a.credentialId) : null;
        const label = (typeof a.label === "string" && a.label) || info?.email || "account " + a.credentialId;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "sacct" + (inUse ? " on" : "");
        row.title = label + (inUse ? " (connected)" : canPin ? " (click to connect)" : "");
        const av = document.createElement("span");
        av.className = "sacct-av";
        av.textContent = label.trim().charAt(0).toUpperCase() || "?";
        const name = document.createElement("span");
        name.className = "sacct-name";
        name.textContent = label;
        row.append(av, name);
        if (inUse) {
          const tag = document.createElement("span");
          tag.className = "sacct-tag";
          tag.textContent = "connected";
          row.append(tag);
        }
        row.addEventListener("click", async () => {
          if (!canPin || inUse) return;
          row.disabled = true;
          try { await current().api.request("pin_session_account", { credentialId: a.credentialId, providerId: "anthropic" }); }
          catch { /* e.g. a response is streaming; the list below shows the real state */ }
          refreshAccounts();
        });
        acctList.append(row);
      }
      acctRetry = 0;
    } catch {
      // omp not ready yet (or no Claude login): try again a few times, then wait for an explicit refresh.
      if (acctRetry++ < 8) setTimeout(refreshAccounts, 2500);
    } finally {
      acctBusy = false;
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
  const samePath = (a, b) => !!a && !!b && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
  const tabFor = (path) => [...sessions.values()].find((s) => samePath(s.api.sessionFile ?? s.sessionFile, path));
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
      savedHeld = new Set(held.filter((id) => !tabFor(list.find((s) => s.id === id)?.path)));
      paintSaved();
    } catch (e) {
      if (mine !== savedSeq) return;
      const err = document.createElement("div");
      err.className = "saved-empty";
      err.textContent = "Could not list sessions: " + String(e?.message ?? e);
      savedList.replaceChildren(err);
    }
  }
  function refreshSavedSoon() {
    if (restoring) return;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(refreshSaved, 600);
  }
  function paintSaved() {
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
      for (const s of rows) savedList.append(savedRow(s));
    }
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "saved-empty";
      empty.textContent = q ? "No session matches." : "No saved sessions.";
      savedList.append(empty);
    }
  }
  function savedRow(s) {
    const open = tabFor(s.path);
    const held = savedHeld.has(s.id);
    const row = document.createElement("div");
    row.className = "layout-item saved-row" + (open ? " on" : "") + (held ? " held" : "");
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    const title = typeof s.title === "string" && s.title.trim() ? s.title.trim() : baseName(s.path);
    row.title = `${title}\n${s.path}` + (held ? "\nOpen in another omp process" : open ? "\nOpen in a tab" : "");
    const text = document.createElement("span");
    text.className = "layout-label";
    text.textContent = (s.pinned ? "★ " : "") + title;
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
    const activate = async () => {
      if (open) {
        layout.show(open.sid);
        open.api.focus();
        return;
      }
      if (held) return;
      const target = current();
      placeChat(target.sid);
      if (await target.api.switchTo(s.path)) refreshSavedSoon();
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
  savedSearch.addEventListener("input", paintSaved);
  savedSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && savedSearch.value) { e.stopPropagation(); savedSearch.value = ""; paintSaved(); }
  });
  savedEl.querySelector("#saved-refresh").addEventListener("click", refreshSaved);
  refreshSaved(); // waits for the focused session's process to be ready

  // ---- process events, routed by session id ------------------------------
  listen("rpc-frame", (e) => {
    const [id, line] = e.payload;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (err) {
      sessions.get(id)?.api.onBadFrame(line, err);
      return;
    }
    // protocol v2 chunking is opt-in via negotiate_protocol, which this client never sends.
    sessions.get(id)?.api.onFrame(frame);
  });
  listen("rpc-stderr", (e) => {
    const [id, line] = Array.isArray(e.payload) ? e.payload : [];
    sessions.get(id)?.api.onStderr(line);
  });
  listen("rpc-exit", (e) => sessions.get(e.payload)?.api.onExit());
})();
