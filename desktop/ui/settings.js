// Settings tab: the window material (glass / opaque, owned by the Rust side, window_style.rs), the Graph
// profile (graph_request, see graph/service.ts) and every omp setting, read and written through the omp CLI
// (`omp config list|set|reset --json`).
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  // h("div", { class: "x", text: "y", onclick: fn }, ...children): DOM without innerHTML.
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k in n && k !== "list" && k !== "role") n[k] = v;
      else if (v !== false) n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
    return n;
  }

  // ---- window material --------------------------------------------------
  // State: { settings: { material, glassType, blur, tint, tintColor, sheen, rim, grain, paneBlur,
  // saturation, glow, accent, opaqueWhenUnfocused, followSystem }, glass, systemTransparency }.
  const { TYPES } = window.kostompMaterial;
  let material = window.__KOSTOMP_MATERIAL__ || null;
  let wanted = material ? { ...material.settings } : null; // last settings sent, ahead of the echo
  const statsFrame = $("stats-frame");

  function postStatsMaterial() {
    if (!material || !statsFrame.getAttribute("src")) return;
    let origin;
    try { origin = new URL(statsFrame.src).origin; } catch { return; }
    statsFrame.contentWindow?.postMessage(
      { type: "kostomp-material", glass: material.glass, tint: material.settings.tint }, origin);
  }
  statsFrame.addEventListener("load", postStatsMaterial);

  function applyMaterial(state) {
    if (!state) return;
    material = window.kostompMaterial.apply(state);
    if (!wanted) wanted = { ...state.settings };
    postStatsMaterial();
    syncWindowPage();
  }
  window.addEventListener("kostomp-material-change", (e) => {
    material = e.detail;
    postStatsMaterial();
  });
  listen("window-material", (e) => applyMaterial(e.payload));
  invoke("window_style_get").then(applyMaterial);

  // Saves run one after another so a fast slider never lands out of order.
  let saving = Promise.resolve();
  function saveWindow(patch) {
    if (!wanted) return;
    wanted = { ...wanted, ...patch };
    const settings = { ...wanted };
    syncWindowPage();
    saving = saving
      .then(() => invoke("window_style_set", { settings }))
      .then(applyMaterial, (err) => showWindowError(String(err)));
  }

  // ---- navigation -------------------------------------------------------
  const OMP_TABS = [
    ["appearance", "Appearance"], ["model", "Model"], ["interaction", "Interaction"], ["context", "Context"],
    ["memory", "Memory"], ["files", "Files"], ["shell", "Shell"], ["tools", "Tools"], ["tasks", "Tasks"],
    ["providers", "Providers"],
  ];
  const TAB_LEADS = {
    appearance: "Theme, composer, status line and how the transcript renders.",
    model: "Thinking, sampling, the system prompt, retries and the helper models.",
    interaction: "Input, approvals, notifications, speech and what happens at startup.",
    context: "What the model sees, and when and how the conversation compacts.",
    memory: "What omp remembers across sessions and where it keeps it.",
    files: "How files are read, summarized and edited, and the language servers.",
    shell: "The bash tool and the eval runtimes.",
    tools: "Which tools the model has, their limits and the external integrations.",
    tasks: "Modes, subagents, isolation and custom commands.",
    providers: "Services, provider protocols, timeouts and privacy.",
    other: "Settings this omp build does not place in a section.",
  };
  const TAB_GROUPS = {
    appearance: ["Theme", "Composer", "Status Line", "Display", "Images"],
    model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
    interaction: ["Input", "Approvals", "Notifications", "Speech", "Collab", "Stream", "Magic Keywords",
      "Startup & Updates", "Power", "Agent", "Git", "Skills"],
    context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
    memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
    files: ["Editing", "Reading", "Read Summaries", "LSP"],
    shell: ["Bash", "Eval & Runtimes"],
    tools: ["Available Tools", "Todos", "Grep & Browser", "Computer", "IDA Pro", "GitHub", "Output Limits",
      "Execution", "Discovery & MCP", "Extensions", "Developer"],
    tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
    providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
  };

  // Static SVG path markup (no user data), lucide-style 24x24 strokes.
  const NAV_ICONS = {
    window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20M6 4v4M10 4v4"/>',
    accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    models: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    agents: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    appearance: '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-9-10-9z"/><circle cx="7.5" cy="11" r="1"/><circle cx="11" cy="7" r="1"/><circle cx="16" cy="8" r="1"/>',
    model: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15v4M17 17h4"/>',
    interaction: '<path d="M4 4l7 17 2.5-7.5L21 11z"/>',
    context: '<path d="M12 2L2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    memory: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',
    files: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
    shell: '<path d="M4 17l6-6-6-6M12 19h8"/>',
    tools: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
    tasks: '<path d="M3 5l2 2 4-4M3 13l2 2 4-4M13 6h8M13 14h8M13 20h8"/>',
    extensions: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17.5h7M17.5 14v7"/>',
    providers: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
    graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7.2 8.2l3.6 7.6M16.8 8.2l-3.6 7.6"/>',
    other: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  };
  const PAGE_KEY = "kostomp-settings-page";
  const nav = $("set-nav");
  const pageEl = $("set-page");
  const navButtons = new Map();
  let page = null;

  function navButton(id, label) {
    const b = h("button", { type: "button", role: "tab", id: "set-tab-" + id,
      "aria-selected": "false", "aria-controls": "set-page", onclick: () => showPage(id) });
    b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[id] || NAV_ICONS.other}</svg>`;
    b.append(h("span", { text: label }));
    navButtons.set(id, b);
    nav.append(b);
    return b;
  }
  navButton("window", "Window");
  nav.append(h("div", { class: "set-sep", role: "separator" }));
  navButton("accounts", "Accounts");
  navButton("models", "Models");
  navButton("agents", "Agents");
  navButton("extensions", "Extensions");
  navButton("graph", "Graph");
  nav.append(h("div", { class: "set-sep", role: "separator" }));
  for (const [id, label] of OMP_TABS) navButton(id, label);

  // Sliding selection capsule behind the active tab.
  const thumb = h("div", { class: "set-thumb", "aria-hidden": "true" });
  nav.prepend(thumb);
  function moveThumb() {
    const b = navButtons.get(page);
    if (!b || b.hidden || !b.offsetHeight) { thumb.style.opacity = "0"; return; }
    thumb.style.height = b.offsetHeight + "px";
    thumb.style.transform = `translateY(${b.offsetTop}px)`;
    thumb.style.opacity = "1";
  }
  new ResizeObserver(moveThumb).observe(nav);

  nav.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const ids = [...navButtons].filter(([, b]) => !b.hidden).map(([key]) => key);
    if (!ids.length) return;
    const next = ids[(ids.indexOf(page) + (e.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length];
    showPage(next);
    navButtons.get(next).focus();
    e.preventDefault();
  });

  // Section search: hides sections whose name does not match; separators hide while filtering.
  $("set-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const b of navButtons.values()) b.hidden = q !== "" && !b.textContent.toLowerCase().includes(q);
    for (const s of nav.querySelectorAll(".set-sep")) s.hidden = q !== "";
    moveThumb();
  });

  function showPage(id) {
    if (!navButtons.has(id)) id = "window";
    page = id;
    localStorage.setItem(PAGE_KEY, id);
    for (const [key, b] of navButtons) {
      b.setAttribute("aria-selected", String(key === id));
      b.tabIndex = key === id ? 0 : -1;
    }
    moveThumb();
    navButtons.get(id).scrollIntoView({ block: "nearest" });
    pageEl.setAttribute("aria-labelledby", "set-tab-" + id);
    pageEl.replaceChildren();
    pageEl.scrollTop = 0;
    if (id === "window") renderWindowPage();
    else if (id === "accounts") renderAccountsPage();
    else if (id === "models") renderModelsPage();
    else if (id === "agents") renderAgentsPage();
    else if (id === "graph") renderGraphPage();
    else if (id === "extensions") renderExtensionsPage();
    else renderOmpPage(id);
  }

  // ---- window page ------------------------------------------------------
  let win = null; // controls of the rendered window page

  function slider(min, max, step, onInput, onChange) {
    const input = h("input", { type: "range", class: "slider", min, max, step });
    input.addEventListener("input", () => { fill(input); onInput(Number(input.value)); });
    input.addEventListener("change", () => onChange(Number(input.value)));
    return input;
  }
  function fill(input) {
    const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
    input.style.setProperty("--fill", pct + "%");
  }
  function toggle(label, onFlip) {
    const b = h("button", { type: "button", role: "switch", class: "switch", "aria-label": label,
      "aria-checked": "false" });
    b.addEventListener("click", () => onFlip(b.getAttribute("aria-checked") !== "true"));
    return b;
  }
  function row(name, desc, ...controls) {
    return h("div", { class: "set-row" },
      h("div", { class: "txt" }, h("div", { class: "name", text: name }), desc && h("div", { class: "desc", text: desc })),
      h("div", { class: "ctl" }, ...controls));
  }
  function preview(kind) {
    return h("div", { class: "pv pv-" + kind, "aria-hidden": "true" },
      h("div", { class: "pv-win" },
        h("div", { class: "pv-bar" }, h("i"), h("i"), h("i")),
        h("div", { class: "pv-line", style: "width:62%" }),
        h("div", { class: "pv-line", style: "width:84%" }),
        h("div", { class: "pv-line", style: "width:48%" }),
        h("div", { class: "pv-line accent", style: "width:30%" })));
  }

  // Sliders of the glass: [setting key, name, description, min, max, label].
  const BACKDROPS = ["Off", "Mica", "Acrylic", "Mica Alt"];
  const PARAMS = [
    ["blur", "Backdrop", "System material behind the window. Off keeps it fully clear.", 0, 3, (v) => BACKDROPS[v]],
    ["tint", "Tint", "How much colour covers the glass. Higher keeps text easier to read.", 0, 100, (v) => v + "%"],
    ["sheen", "Top light", "Soft highlight washing down from the top edge.", 0, 100, (v) => v + "%"],
    ["rim", "Edge light", "Bright hairline around the window edge.", 0, 100, (v) => v + "%"],
    ["grain", "Grain", "Fine frosted texture over the glass.", 0, 100, (v) => v + "%"],
    ["paneBlur", "Pane blur", "Blur behind floating panes such as the command palette.", 0, 40, (v) => v + "px"],
    ["saturation", "Pane saturation", "Colour of what shows through floating panes.", 50, 250, (v) => v + "%"],
    ["glow", "Ambient glow", "Colour glow drifting behind the glass.", 0, 100, (v) => v + "%"],
  ];
  const DEFAULT_TYPE = TYPES[0];

  function renderWindowPage() {
    const tile = (value, name, desc) => h("button", {
      type: "button", role: "radio", class: "tile", "aria-checked": "false",
      onclick: () => saveWindow({ material: value }),
    }, preview(value), h("div", { class: "tile-foot" }, h("span", { class: "radio" }),
      h("span", {}, h("div", { class: "tile-name", text: name }), h("div", { class: "tile-desc", text: desc }))));

    const glassTile = tile("glass", "Transparent", "Frosted glass, the desktop shows through blurred.");
    const opaqueTile = tile("opaque", "Opaque", "Solid dark background, best for long reading.");

    // One tile per glass type, painted with that type's own numbers.
    const typeTiles = new Map();
    const typeTile = (t) => {
      const pv = preview("glass");
      const v = t.v;
      pv.style.cssText = `--pv-a:${v.tint / 100};--pv-sat:${v.saturation / 100};` +
        `--pv-blur:${[0, 6, 14, 9][v.blur] + v.paneBlur / 4}px;` +
        `--pv-sheen:rgb(255 255 255 / ${Math.min(1, v.sheen / 100 * 2.2)});` +
        (v.tintColor ? `--pv-rgb:${window.kostompMaterial.rgbOf(v.tintColor)};` : "");
      const b = h("button", {
        type: "button", role: "radio", class: "tile", "aria-checked": "false",
        onclick: () => saveWindow({ glassType: t.id, ...v }),
      }, pv, h("div", { class: "tile-foot" }, h("span", { class: "radio" }),
        h("span", {}, h("div", { class: "tile-name", text: t.name }), h("div", { class: "tile-desc", text: t.desc }))));
      typeTiles.set(t.id, b);
      return b;
    };
    const typeGrid = h("div", { class: "tiles types", role: "radiogroup", "aria-label": "Glass type" },
      TYPES.map(typeTile));

    // Sliders: live paint while dragging, one save on release. Any edit makes the type "custom".
    const sliders = new Map();
    const paramRows = PARAMS.map(([key, name, desc, min, max, fmt]) => {
      const val = h("span", { class: "val" });
      const input = slider(min, max, 1, (v) => {
        val.textContent = fmt(v);
        if (wanted) paint({ ...wanted, [key]: v });
      }, (v) => saveWindow({ [key]: v, glassType: "custom" }));
      const r = row(name, desc, input, val);
      sliders.set(key, { input, val, fmt, row: r });
      return r;
    });

    // Colours: "" follows the theme; the picker shows the theme colour until one is chosen.
    const colors = new Map();
    const colorRow = (key, name, desc, themeHex, extra) => {
      const input = h("input", { type: "color", class: "color", "aria-label": name });
      input.addEventListener("input", () => { if (wanted) paint({ ...wanted, [key]: input.value }); });
      input.addEventListener("change", () => saveWindow({ [key]: input.value, ...extra }));
      const reset = h("button", { type: "button", class: "btn", text: "Theme", style: "margin:0",
        onclick: () => saveWindow({ [key]: "", ...extra }) });
      const r = row(name, desc, input, reset);
      colors.set(key, { input, reset, themeHex, row: r });
      return r;
    };
    const tintColorRow = colorRow("tintColor", "Tint colour", "Colour of the glass tint. Theme uses the dark or light palette.",
      () => (root.dataset.theme === "light" ? "#f5f1ff" : "#120e26"), { glassType: "custom" });
    const accentRow = colorRow("accent", "Accent colour", "Buttons, focus rings and highlights, in both materials.",
      () => (root.dataset.theme === "light" ? "#6d4aff" : "#a99bff"), {});

    const unfocused = toggle("Turn opaque when the window is not focused", (on) => saveWindow({ opaqueWhenUnfocused: on }));
    const follow = toggle("Follow Windows transparency effects", (on) => saveWindow({ followSystem: on }));
    const resetBtn = h("button", { type: "button", class: "btn", text: "Reset glass and colours",
      onclick: () => saveWindow({ glassType: DEFAULT_TYPE.id, ...DEFAULT_TYPE.v, accent: "" }) });
    const note = h("div", { class: "set-note", hidden: true });
    const error = h("div", { class: "row-err", hidden: true });

    pageEl.append(
      h("h1", { text: "Window" }),
      h("p", { class: "set-lead", text: "How the Kostomp window sits on your desktop. Changes apply right away." }),
      h("div", { class: "set-body" },
        h("div", { class: "tiles", role: "radiogroup", "aria-label": "Window material" }, glassTile, opaqueTile),
        note, error,
        h("div", { class: "set-h", text: "Glass type" }), typeGrid,
        h("div", { class: "set-h", text: "Fine tuning" }),
        paramRows, tintColorRow,
        h("div", { class: "set-h", text: "Theme" }), accentRow,
        h("div", { class: "set-h", text: "Behaviour" }),
        row("Turn opaque when the window is not focused", "Saves GPU work while you are in another app.", unfocused),
        row("Follow Windows transparency effects", "Use Opaque when transparency is off in Windows settings.", follow),
        resetBtn));

    win = { glassTile, opaqueTile, typeGrid, typeTiles, sliders, colors, unfocused, follow, note, error };
    syncWindowPage();
  }

  function syncWindowPage() {
    if (page !== "window" || !win || !wanted) return;
    const s = wanted;
    win.glassTile.setAttribute("aria-checked", String(s.material === "glass"));
    win.opaqueTile.setAttribute("aria-checked", String(s.material === "opaque"));
    for (const [id, b] of win.typeTiles) b.setAttribute("aria-checked", String(s.material === "glass" && s.glassType === id));
    for (const [key, c] of win.sliders) {
      if (document.activeElement !== c.input) { c.input.value = s[key]; fill(c.input); c.val.textContent = c.fmt(s[key]); }
    }
    for (const [key, c] of win.colors) {
      c.input.value = s[key] || c.themeHex();
      c.reset.disabled = !s[key];
    }
    win.unfocused.setAttribute("aria-checked", String(s.opaqueWhenUnfocused));
    win.follow.setAttribute("aria-checked", String(s.followSystem));
    const off = s.material !== "glass";
    win.typeGrid.classList.toggle("off", off);
    for (const c of win.sliders.values()) { c.row.classList.toggle("off", off); c.input.disabled = off; }
    const tc = win.colors.get("tintColor");
    tc.row.classList.toggle("off", off);
    tc.input.disabled = off;
    if (off) tc.reset.disabled = true;
    const blocked = s.material === "glass" && s.followSystem && material && !material.systemTransparency;
    win.note.hidden = !blocked;
    win.note.textContent = blocked
      ? "Transparency effects are off in Windows settings, so the window stays opaque." : "";
  }

  function showWindowError(msg) {
    if (page !== "window" || !win) return;
    win.error.hidden = false;
    win.error.textContent = msg;
  }

  // ---- models and agents pages (through the running omp, see app.js kostompRpc) ----
  function rpc(type, params, timeoutMs) {
    if (!window.kostompRpc) return Promise.reject(new Error("the chat runtime is not loaded"));
    return window.kostompRpc.request(type, params, timeoutMs);
  }
  function rpcErrorText(err) {
    const msg = err && err.message ? err.message : String(err);
    return /unknown command/i.test(msg)
      ? "The omp this app runs is too old for this page. Update omp, then restart the chat."
      : msg;
  }
  function waitBox(text) {
    return h("div", { class: "set-wait" }, h("div", { class: "spin" }), text);
  }
  function failBox(body, err, retry) {
    body.replaceChildren(h("div", { class: "row-err", text: rpcErrorText(err) }),
      h("button", { type: "button", class: "btn", text: "Try again", onclick: retry }));
  }

  let catalog = null; // { enabledModels, providers: [{ provider, models: [{ id, name, scoped }] }] }
  const loadCatalog = () => rpc("get_model_catalog").then((data) => (catalog = data));

  function renderModelsPage() {
    const body = h("div", { class: "set-body" });
    pageEl.append(
      h("h1", { text: "Models" }),
      h("p", { class: "set-lead", text: "Connected providers and their models. The models you tick here are the ones the chat model picker offers. With none ticked, it offers every model." }),
      body);
    body.append(waitBox("Reading models from omp…"));
    loadCatalog().then(() => { if (page === "models") drawModels(body); },
      (err) => { if (page === "models") failBox(body, err, () => showPage("models")); });
  }

  function drawModels(body) {
    const keyOf = (provider, m) => provider + "/" + m.id;
    const allKeys = new Set(catalog.providers.flatMap((p) => p.models.map((m) => keyOf(p.provider, m))));
    // Exact provider/id entries are edited by the checkboxes; anything else (globs, bare ids) is kept as is.
    const exact = new Set(catalog.enabledModels.filter((p) => allKeys.has(p)));
    let patterns = catalog.enabledModels.filter((p) => !allKeys.has(p));
    // Models in scope only through a pattern, as of this load (the server's `scoped` flag goes stale on edits).
    const locked = new Set();
    if (patterns.length) {
      for (const p of catalog.providers) for (const m of p.models) {
        if (m.scoped && !exact.has(keyOf(p.provider, m))) locked.add(keyOf(p.provider, m));
      }
    }
    const byPattern = (provider, m) => locked.has(keyOf(provider, m));

    const summary = h("div", { class: "models-sum" });
    const err = h("div", { class: "row-err", hidden: true });
    const search = h("input", { class: "field", type: "search", placeholder: "Filter models", spellcheck: false,
      "aria-label": "Filter models" });
    const clear = h("button", { type: "button", class: "btn", text: "Untick all" });
    const list = h("div", {});
    const patternBox = h("div", {});

    let saving = Promise.resolve();
    function save({ reload } = {}) {
      const next = [...patterns, ...exact];
      catalog.enabledModels = next;
      for (const p of catalog.providers) for (const m of p.models) {
        const key = keyOf(p.provider, m);
        m.scoped = !next.length || exact.has(key) || locked.has(key);
      }
      err.hidden = true;
      updateSummary();
      saving = saving
        .then(() => rpc("set_enabled_models", { patterns: next }))
        .then(async () => {
          window.kostompRpc?.refreshModels(); window.kostompRefreshAccounts?.();
          if (reload) { await loadCatalog(); if (page === "models") { body.replaceChildren(); drawModels(body); } }
        })
        .catch((x) => { err.hidden = false; err.textContent = "Could not save: " + rpcErrorText(x); });
    }
    function updateSummary() {
      let ticked = 0, total = 0;
      for (const p of catalog.providers) for (const m of p.models) {
        total++;
        if (exact.has(keyOf(p.provider, m)) || byPattern(p.provider, m)) ticked++;
      }
      summary.textContent = catalog.enabledModels.length
        ? `The picker offers ${ticked} of ${total} models.`
        : `Nothing ticked: the picker offers all ${total} models.`;
      clear.disabled = !catalog.enabledModels.length;
    }

    function drawPatterns() {
      patternBox.replaceChildren();
      if (!patterns.length) return;
      patternBox.append(h("div", { class: "set-note", text: "Also in your scope as patterns (set from the CLI). Models they match show ticked and locked:" }),
        h("div", { class: "chips" }, patterns.map((p) => h("span", { class: "chip" }, p,
          h("button", { type: "button", class: "link", text: "×", title: "Remove pattern", "aria-label": "Remove pattern " + p,
            onclick: () => { patterns = patterns.filter((x) => x !== p); drawPatterns(); save({ reload: true }); } })))));
    }

    function drawList() {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren();
      if (!catalog.providers.length) {
        list.append(h("p", { class: "set-empty" }, "No connected provider. ",
          h("button", { type: "button", class: "link", style: "color:var(--accent)", text: "Sign in on the Accounts page", onclick: () => showPage("accounts") }),
          " or set an API key, then come back."));
        return;
      }
      let shown = 0;
      for (const p of catalog.providers) {
        const models = p.models.filter((m) => !q || keyOf(p.provider, m).toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
        if (!models.length) continue;
        shown += models.length;
        const count = h("span", { class: "count" });
        const boxes = [];
        const setCount = () => {
          const n = p.models.filter((m) => exact.has(keyOf(p.provider, m)) || byPattern(p.provider, m)).length;
          count.textContent = `${n} / ${p.models.length}`;
        };
        const bulk = (on) => {
          for (const m of models) {
            if (byPattern(p.provider, m)) continue;
            if (on) exact.add(keyOf(p.provider, m)); else exact.delete(keyOf(p.provider, m));
          }
          for (const b of boxes) if (!b.disabled) b.checked = on;
          setCount();
          save();
        };
        const grid = h("div", { class: "checks model-checks" });
        for (const m of models) {
          const key = keyOf(p.provider, m);
          const locked = byPattern(p.provider, m);
          const cb = h("input", { type: "checkbox", checked: exact.has(key) || locked, disabled: locked });
          cb.addEventListener("change", () => {
            if (cb.checked) exact.add(key); else exact.delete(key);
            setCount();
            save();
          });
          boxes.push(cb);
          grid.append(h("label", { title: locked ? key + " (matched by a pattern)" : (m.name && m.name !== m.id ? m.name : key) }, cb, m.id));
        }
        setCount();
        list.append(h("section", { class: "set-group" },
          h("h2", { class: "prov-head" }, h("span", { text: p.provider }), count,
            h("button", { type: "button", class: "link", text: "all", onclick: () => bulk(true) }),
            h("button", { type: "button", class: "link", text: "none", onclick: () => bulk(false) })),
          grid));
      }
      if (!shown) list.append(h("p", { class: "set-empty", text: "No model matches the filter." }));
    }

    search.addEventListener("input", drawList);
    clear.addEventListener("click", () => {
      exact.clear();
      patterns = [];
      save({ reload: true });
    });
    body.append(h("div", { class: "models-bar" }, search, summary, clear), err, patternBox, list,
      h("p", { class: "set-foot", text: "Saved to your global omp config (enabledModels). The chat picker updates right away." }));
    updateSummary();
    drawPatterns();
    drawList();
  }

  // ---- accounts page (get_login_providers / login / get_logout_accounts / logout) ----
  // One login at a time; its panel survives page switches so the code prompt is not lost.
  let loginRun = null; // { providerId, name, box }

  function renderAccountsPage() {
    const body = h("div", { class: "set-body" });
    pageEl.append(
      h("h1", { text: "Accounts" }),
      h("p", { class: "set-lead", text: "Sign in to the providers omp can reach through OAuth. Their models show up in the chat model picker once you are signed in." }),
      body);
    if (loginRun) body.append(loginRun.box);
    const list = h("div", {});
    body.append(list, h("p", { class: "set-foot", text: "Credentials are stored by omp (the same store the CLI /login and /logout use). API keys set in the environment are not listed here." }));
    list.append(waitBox("Reading providers from omp…"));
    rpc("get_login_providers").then(
      (data) => { if (page === "accounts") drawAccounts(list, Array.isArray(data) ? data : (data && Array.isArray(data.providers) ? data.providers : [])); },
      (err) => { if (page === "accounts") failBox(list, err, () => showPage("accounts")); });
  }

  function drawAccounts(list, providers) {
    list.replaceChildren();
    const valid = providers.filter((p) => p && typeof p.id === "string");
    if (!valid.length) {
      list.append(h("p", { class: "set-empty", text: "This omp build offers no OAuth providers." }));
      return;
    }
    // Signed-in first, then available, then the rest; alphabetical inside each.
    const rank = (p) => (p.authenticated ? 0 : p.available !== false ? 1 : 2);
    valid.sort((a, b) => rank(a) - rank(b) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const section = h("section", { class: "set-group" });
    for (const p of valid) section.append(accountRow(p));
    list.append(section);
  }

  function accountRow(p) {
    const name = typeof p.name === "string" && p.name ? p.name : p.id;
    const status = p.authenticated ? "signed in" : p.available === false ? "unavailable" : "not signed in";
    const err = h("div", { class: "row-err", hidden: true });
    const accounts = h("div", {});
    const flat = "margin-top:0";
    const note = h("div", { class: "row-note", hidden: true });
    const stored = h("div", { class: "accts" });
    if (p.authenticated) {
      const draw = async () => {
        let res;
        let sess = null;
        try { res = await rpc("get_logout_accounts", { providerId: p.id }); } catch { return; }
        let why = "";
        try { sess = await rpc("get_session_accounts", { providerId: p.id }); } catch (x) { why = "Switching is unavailable: " + rpcErrorText(x); }
        const canPin = !!sess && sess.provider === p.id && Array.isArray(sess.accounts);
        if (!canPin && !why) why = "Switching is unavailable: omp did not return this provider's accounts.";
        note.textContent = why;
        note.hidden = !why;
        const activeId = canPin ? (sess.accounts.find((s) => s && s.active) || {}).credentialId : null;
        const list = (Array.isArray(res) ? res : res && Array.isArray(res.accounts) ? res.accounts : [])
          .filter((a) => a && Number.isInteger(a.credentialId));
        stored.replaceChildren();
        for (const a of list) {
          const inUse = canPin ? a.credentialId === activeId : !!a.active;
          const label = typeof a.label === "string" && a.label ? a.label : "account " + a.credentialId;
          const meta = [a.detail, a.type === "oauth" ? "OAuth" : a.type === "api_key" ? "API key" : null]
            .filter((x) => typeof x === "string" && x).join(" · ");
          const row = h("div", { class: "acct" + (inUse ? " on" : "") },
            h("span", { class: "acct-name", text: label, title: label }),
            meta ? h("span", { class: "tag", text: meta }) : null,
            inUse ? h("span", { class: "acct-on", text: "in use" }) : null);
          if (canPin && !inUse) {
            const use = h("button", { type: "button", class: "btn acct-use", text: "Use" });
            use.addEventListener("click", async () => {
              use.disabled = true;
              try { await rpc("pin_session_account", { credentialId: a.credentialId, providerId: p.id }); draw(); window.kostompRefreshAccounts?.(); }
              catch (x) { use.disabled = false; err.hidden = false; err.textContent = rpcErrorText(x); }
            });
            row.append(use);
          }
          stored.append(row);
        }
      };
      draw();
    }
    const loginBtn = h("button", { type: "button", class: "btn", style: flat,
      text: p.authenticated ? "Log in again" : "Log in",
      disabled: p.available === false || !!loginRun,
      title: p.available === false ? "omp cannot use this provider right now" : undefined,
      onclick: () => startLogin(p.id, name) });
    const logoutBtn = p.authenticated && h("button", { type: "button", class: "btn", style: flat, text: "Log out",
      onclick: () => showLogout(p.id, name, accounts, err, logoutBtn) });
    return h("div", { class: "set-row" + (p.available === false ? " off" : "") },
      h("div", { class: "txt" },
        h("div", { class: "name" }, name, h("span", { class: "tag", text: status })),
        h("div", { class: "key", text: p.id }),
        stored, note, err, accounts),
      h("div", { class: "ctl" }, loginBtn, logoutBtn));
  }

  async function showLogout(providerId, name, box, err, button) {
    err.hidden = true;
    box.replaceChildren(waitBox("Reading stored credentials…"));
    button.disabled = true;
    let res;
    try {
      res = await rpc("get_logout_accounts", { providerId });
    } catch (x) {
      box.replaceChildren();
      err.hidden = false;
      err.textContent = rpcErrorText(x);
      button.disabled = false;
      return;
    }
    const accounts = (Array.isArray(res) ? res : res && Array.isArray(res.accounts) ? res.accounts : [])
      .filter((a) => a && Number.isInteger(a.credentialId));
    box.replaceChildren();
    button.disabled = false;
    if (!accounts.length) {
      box.append(h("div", { class: "row-note", text: "omp has no stored credential for " + name + ". It may come from an environment variable or another config." }));
      return;
    }
    box.append(h("div", { class: "desc", text: accounts.length > 1 ? "Choose the credential to remove:" : "Remove this credential?" }));
    for (const a of accounts) {
      const label = [a.label, a.type === "oauth" ? "OAuth" : a.type === "api_key" ? "API key" : null, a.active ? "in use" : null]
        .filter((x) => typeof x === "string" && x).join(" · ");
      const rm = h("button", { type: "button", class: "btn", style: "margin:6px 0 0", text: "Remove" });
      rm.addEventListener("click", async () => {
        rm.disabled = true;
        err.hidden = true;
        try {
          const out = await rpc("logout", { providerId, credentialId: a.credentialId });
          window.kostompRpc?.refreshModels(); window.kostompRefreshAccounts?.();
          const remaining = out && typeof out.remainingSource === "string" && out.remainingSource;
          if (page === "accounts") showPage("accounts");
          if (remaining) flash(`Logged out of ${name}. omp still authenticates it through ${remaining}.`);
          else flash(`Logged out of ${name}.`);
        } catch (x) {
          rm.disabled = false;
          err.hidden = false;
          err.textContent = rpcErrorText(x);
        }
      });
      box.append(h("div", { class: "chips", style: "align-items:center;gap:10px" },
        h("span", { class: "chip", text: label || "credential " + a.credentialId, title: typeof a.detail === "string" ? a.detail : undefined }),
        typeof a.detail === "string" && a.detail ? h("span", { class: "tag", text: a.detail }) : null,
        rm));
    }
    box.append(h("button", { type: "button", class: "link", text: "cancel", onclick: () => box.replaceChildren() }));
  }

  /** A one-line result shown at the top of the accounts page (after a re-render). */
  function flash(text, bad) {
    if (page !== "accounts") return;
    const body = pageEl.querySelector(".set-body");
    body?.prepend(h("div", { class: bad ? "row-err" : "row-note", text }));
  }

  function startLogin(providerId, name) {
    if (loginRun || !window.kostompRpc?.login) return;
    const status = h("div", { class: "set-wait" }, h("div", { class: "spin" }), "Starting the sign-in for " + name + "…");
    const detail = h("div", {});
    const prompt = h("div", {});
    const cancelBtn = h("button", { type: "button", class: "btn", style: "margin-top:10px", text: "Cancel sign-in",
      onclick: () => {
        if (!window.kostompRpc?.loginCancel) return;
        cancelBtn.disabled = true;
        setStatus("Cancelling…");
        window.kostompRpc.loginCancel().then(
          (did) => { if (!did) cancelBtn.disabled = false; },
          () => { cancelBtn.disabled = false; }); // older omp without login_cancel: the login runs on
      } });
    if (!window.kostompRpc?.loginCancel) cancelBtn.hidden = true;
    const box = h("section", { class: "set-group" }, h("h2", { text: "Signing in to " + name }), status, detail, prompt, cancelBtn);
    loginRun = { providerId, name, box };
    if (page === "accounts") showPage("accounts");

    const setStatus = (text) => { status.lastChild.textContent = text; };
    const linkActions = (url) => h("div", { class: "chips", style: "gap:10px" },
      h("button", { type: "button", class: "btn", style: "margin-top:6px", text: "Open sign-in page",
        onclick: () => window.kostompOpenUrl?.(url, (t) => detail.append(h("div", { class: "row-note", text: t }))) }),
      h("button", { type: "button", class: "btn", style: "margin-top:6px", text: "Copy link",
        onclick: () => navigator.clipboard?.writeText(url).then(() => setStatus("Link copied. Paste it into your browser."), () => {}) }));

    let promptId = null;
    const onUi = (req, respond) => {
      switch (req && req.method) {
        case "open_url": {
          const url = typeof req.launchUrl === "string" && req.launchUrl ? req.launchUrl : req.url;
          if (typeof url !== "string" || !url) return true;
          setStatus("Finish the sign-in in your browser. This page updates when it is done.");
          detail.replaceChildren(
            typeof req.instructions === "string" && req.instructions
              ? h("p", { class: "desc", style: "white-space:pre-wrap", text: req.instructions }) : null,
            linkActions(url));
          window.kostompOpenUrl?.(url, (t) => detail.append(h("div", { class: "row-note", text: t })));
          return true;
        }
        case "input": {
          promptId = req.id;
          const field = h("input", { class: "field", type: "text", spellcheck: false,
            placeholder: typeof req.placeholder === "string" ? req.placeholder : "",
            "aria-label": typeof req.title === "string" ? req.title : "Sign-in code" });
          const submit = () => { if (promptId !== req.id) return; promptId = null; respond({ value: field.value }); prompt.replaceChildren(); setStatus("Checking…"); };
          field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
          prompt.replaceChildren(
            h("div", { class: "desc", style: "margin-top:10px;white-space:pre-wrap", text: [req.title, req.message].filter((x) => typeof x === "string" && x).join("\n") || "Paste the code or the redirect URL from the browser:" }),
            h("div", { class: "chips", style: "align-items:center;gap:10px" }, field,
              h("button", { type: "button", class: "btn", style: "margin-top:0", text: "Submit", onclick: submit }),
              h("button", { type: "button", class: "link", text: "cancel", onclick: () => {
                if (promptId !== req.id) return;
                promptId = null;
                respond({ cancelled: true });
                prompt.replaceChildren();
              } })));
          queueMicrotask(() => field.focus());
          return true;
        }
        case "cancel":
          if (req.targetId && req.targetId === promptId) { promptId = null; prompt.replaceChildren(); }
          return true;
        case "notify":
          if (typeof req.message === "string" && req.message) setStatus(req.message);
          return true;
        default:
          return false; // anything else stays with the chat session
      }
    };

    window.kostompRpc.login(providerId, onUi).then(
      () => {
        loginRun = null;
        window.kostompRpc?.refreshModels(); window.kostompRefreshAccounts?.();
        catalog = null; // the Models page re-reads the catalog
        if (page === "accounts") { showPage("accounts"); flash("Signed in to " + name + ". Its models are now in the picker."); }
      },
      (x) => {
        loginRun = null;
        if (x?.code === "cancelled") {
          if (page === "accounts") { showPage("accounts"); flash("Sign-in to " + name + " cancelled."); }
          return;
        }
        // omp will not take secrets (API keys) or pre-link prompts over RPC: point at the terminal flow.
        const text = rpcErrorText(x);
        const hint = /requires (secret input|interactive prompts)/i.test(text)
          ? ` Run \`omp login ${providerId}\` in a terminal for this provider, then come back here.` : "";
        if (page === "accounts") { showPage("accounts"); flash("Sign-in to " + name + " failed: " + text + hint, true); }
      });
  }

  function renderAgentsPage() {
    const body = h("div", { class: "set-body" });
    pageEl.append(
      h("h1", { text: "Agents" }),
      h("p", { class: "set-lead", text: "The model each subagent runs on. Default keeps the agent's own model, or the session model when it has none." }),
      body);
    body.append(waitBox("Reading agents from omp…"));
    Promise.all([rpc("get_agent_models"), catalog ? catalog : loadCatalog()])
      .then(([res]) => { if (page === "agents") drawAgents(body, res.agents || []); },
        (err) => { if (page === "agents") failBox(body, err, () => showPage("agents")); });
  }

  function drawAgents(body, agents) {
    body.replaceChildren();
    if (!agents.length) {
      body.append(h("p", { class: "set-empty", text: "omp found no subagents." }));
      return;
    }
    // Offer the scoped models; with no scope, every connected model.
    const choices = [];
    for (const p of catalog.providers) for (const m of p.models) {
      if (catalog.enabledModels.length && !m.scoped) continue;
      choices.push(p.provider + "/" + m.id);
    }
    const section = h("section", { class: "set-group" });
    for (const a of agents) section.append(agentRow(a, choices));
    body.append(section,
      h("p", { class: "set-foot", text: "Saved to your global omp config (task.agentModelOverrides), the same setting the CLI /agents hub edits." }));
  }

  function agentRow(a, choices) {
    const err = h("div", { class: "row-err", hidden: true });
    const eff = h("div", { class: "key" });
    const showEff = (agent) => { eff.textContent = agent.effectiveModel ? "runs on " + agent.effectiveModel : "runs on the session model"; };
    showEff(a);
    const cur = a.overrideModel || "";
    const own = a.agentModel && a.agentModel.length ? a.agentModel.join(", ") : "";
    const opts = [h("option", { value: "", text: own ? `Default (${own})` : "Default", selected: !cur })];
    if (cur && !choices.includes(cur)) opts.push(h("option", { value: cur, text: cur, selected: true }));
    for (const c of choices) opts.push(h("option", { value: c, text: c, selected: c === cur }));
    const sel = h("select", { class: "field", "aria-label": "Model for " + a.name }, opts);
    let last = cur;
    sel.addEventListener("change", async () => {
      err.hidden = true;
      const value = sel.value;
      sel.disabled = true;
      try {
        await rpc("set_agent_model", { agent: a.name, model: value || null });
        last = value;
        const fresh = ((await rpc("get_agent_models")).agents || []).find((x) => x.name === a.name);
        if (fresh) showEff(fresh);
      } catch (x) {
        sel.value = last;
        err.hidden = false;
        err.textContent = rpcErrorText(x);
      } finally {
        sel.disabled = false;
      }
    });
    return h("div", { class: "set-row" + (a.disabled ? " off" : "") },
      h("div", { class: "txt" },
        h("div", { class: "name" }, a.name, h("span", { class: "tag", text: a.disabled ? a.source + " · disabled" : a.source })),
        a.description && h("div", { class: "desc", text: a.description }),
        eff, err),
      h("div", { class: "ctl" }, sel));
  }

  // ---- extensions page (get_extensions / set_extension_enabled / reconnect_mcp_server) ----
  const EXT_KINDS = [
    ["mcp", "MCP servers"], ["skill", "Skills"], ["extension-module", "Extension modules"], ["tool", "Tools"],
    ["rule", "Rules"], ["slash-command", "Commands"], ["prompt", "Prompts"], ["hook", "Hooks"],
    ["instruction", "Instructions"], ["context-file", "Context files"],
  ];
  const EXT_KIND_KEY = "kostomp-settings-ext-kind";

  function renderExtensionsPage() {
    const body = h("div", { class: "set-body" });
    pageEl.append(
      h("h1", { text: "Extensions" }),
      h("p", { class: "set-lead", text: "MCP servers, skills, extension modules, rules and the rest omp discovered for this project. MCP changes apply right away; the others apply on the next session or reload." }),
      body);
    body.append(waitBox("Reading extensions from omp…"));
    rpc("get_extensions", undefined, 30000)
      .then((res) => { if (page === "extensions") drawExtensions(body, Array.isArray(res?.extensions) ? res.extensions : []); },
        (err) => { if (page === "extensions") failBox(body, err, () => showPage("extensions")); });
  }

  function drawExtensions(body, all) {
    body.replaceChildren();
    const counts = new Map();
    for (const e of all) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
    const kinds = EXT_KINDS.filter(([k]) => counts.has(k));
    for (const k of counts.keys()) if (!EXT_KINDS.some(([x]) => x === k)) kinds.push([k, k]);
    if (!kinds.length) {
      body.append(h("p", { class: "set-empty", text: "omp found no extensions for this project." }));
      return;
    }
    let kind = localStorage.getItem(EXT_KIND_KEY);
    if (!counts.has(kind)) kind = kinds[0][0];
    const pick = h("select", { class: "field", "aria-label": "Kind" },
      kinds.map(([k, label]) => h("option", { value: k, text: `${label} (${counts.get(k)})`, selected: k === kind })));
    const search = h("input", { class: "field", type: "search", placeholder: "Filter", spellcheck: false, "aria-label": "Filter extensions" });
    const refresh = h("button", { type: "button", class: "btn", text: "Refresh", onclick: () => showPage("extensions") });
    const list = h("div", {});
    const drawList = () => {
      const q = search.value.trim().toLowerCase();
      const rows = all.filter((e) => e.kind === kind && (!q
        || String(e.displayName || e.name || "").toLowerCase().includes(q)
        || String(e.description || "").toLowerCase().includes(q)));
      list.replaceChildren();
      if (!rows.length) { list.append(h("p", { class: "set-empty", text: "Nothing matches the filter." })); return; }
      const section = h("section", { class: "set-group" });
      for (const e of rows) section.append(extensionRow(e));
      list.append(section);
    };
    pick.addEventListener("change", () => { kind = pick.value; localStorage.setItem(EXT_KIND_KEY, kind); drawList(); });
    search.addEventListener("input", drawList);
    body.append(h("div", { class: "models-bar" }, pick, search, refresh), list,
      h("p", { class: "set-foot", text: "MCP servers are switched in their mcp.json; the others are listed under disabledExtensions in your omp config, the same settings the CLI /extensions dashboard edits." }));
    drawList();
  }

  function extensionRow(e) {
    const err = h("div", { class: "row-err", hidden: true });
    const info = h("div", { class: "key" });
    const note = h("div", { class: "desc", hidden: true });
    const isMcp = e.kind === "mcp";
    const shadowed = e.state === "shadowed";
    let on = e.state === "active";

    const showInfo = () => {
      const bits = [];
      if (e.providerName || e.provider) bits.push(e.providerName || e.provider);
      if (e.level) bits.push(e.level);
      if (shadowed) bits.push("shadowed" + (e.shadowedBy ? " by " + e.shadowedBy : ""));
      else if (!on) bits.push("disabled" + (e.disabledReason ? " (" + e.disabledReason + ")" : ""));
      if (isMcp && on) {
        if (e.mcpStatus) bits.push(e.mcpStatus);
        if (typeof e.mcpTools === "number") bits.push(e.mcpTools + (e.mcpTools === 1 ? " tool" : " tools"));
      }
      info.textContent = bits.join(" · ");
      info.title = e.path || "";
      if (isMcp && on && e.mcpError) { err.hidden = false; err.textContent = e.mcpError; }
    };
    showInfo();

    const sw = toggle((on ? "Disable " : "Enable ") + (e.displayName || e.name), async (want) => {
      err.hidden = true;
      sw.disabled = true;
      try {
        const res = await rpc("set_extension_enabled", { extension: e.id, enabled: want }, 60000);
        on = want;
        sw.setAttribute("aria-checked", String(on));
        rowEl.classList.toggle("off", !on);
        if (isMcp) { e.mcpStatus = undefined; e.mcpTools = undefined; e.mcpError = undefined; }
        note.hidden = Boolean(res?.live);
        note.textContent = res?.live ? "" : "Applies on the next session or after /reload.";
        if (isMcp && on && res?.live) await refreshMcp();
        showInfo();
      } catch (x) {
        err.hidden = false;
        err.textContent = rpcErrorText(x);
      } finally {
        sw.disabled = shadowed;
      }
    });
    sw.setAttribute("aria-checked", String(on));
    sw.disabled = shadowed;

    // Re-read this server's live status after a toggle or reconnect.
    async function refreshMcp() {
      try {
        const res = await rpc("get_extensions", undefined, 30000);
        const fresh = (Array.isArray(res?.extensions) ? res.extensions : []).find((x) => x.id === e.id);
        if (fresh) Object.assign(e, { mcpStatus: fresh.mcpStatus, mcpTools: fresh.mcpTools, mcpError: fresh.mcpError });
      } catch { /* the row keeps its last known status */ }
    }

    const controls = [];
    if (isMcp) {
      const again = h("button", { type: "button", class: "btn", text: "Reconnect" });
      again.addEventListener("click", async () => {
        err.hidden = true;
        again.disabled = true;
        again.textContent = "Connecting…";
        try {
          const res = await rpc("reconnect_mcp_server", { name: e.name }, 120000);
          await refreshMcp();
          if (!res?.connected && !e.mcpError) e.mcpError = "The server did not connect.";
          showInfo();
        } catch (x) {
          err.hidden = false;
          err.textContent = rpcErrorText(x);
        } finally {
          again.disabled = false;
          again.textContent = "Reconnect";
        }
      });
      if (!shadowed) controls.push(again);
    }
    controls.push(sw);

    const label = e.displayName || e.name || e.id;
    const rowEl = h("div", { class: "set-row" + (on ? "" : " off") },
      h("div", { class: "txt" },
        h("div", { class: "name" }, label, e.trigger && h("span", { class: "tag", text: e.trigger })),
        e.description && h("div", { class: "desc", text: e.description }),
        info, note, err),
      h("div", { class: "ctl" }, ...controls));
    return rowEl;
  }

  // ---- omp pages --------------------------------------------------------
  let config = null; // path -> { value?, redacted?, type, description, tab?, group?, label?, warning?, values?, options?, secret? }
  let configError = null;
  let loading = null;

  function loadConfig() {
    if (!loading) {
      loading = invoke("omp_config_list")
        .then((text) => {
          config = JSON.parse(text);
          configError = null;
          // An omp build without section metadata: everything lands in "Other".
          if (Object.values(config).some((e) => !e.tab) && !navButtons.has("other")) navButton("other", "Other");
        })
        .catch((err) => { configError = String(err); loading = null; });
    }
    return loading;
  }

  function renderOmpPage(tab) {
    const label = tab === "other" ? "Other" : OMP_TABS.find(([id]) => id === tab)[1];
    const body = h("div", { class: "set-body" });
    pageEl.append(
      h("h1", { text: label }),
      h("p", { class: "set-lead", text: TAB_LEADS[tab] }),
      body);
    if (!config) {
      body.append(h("div", { class: "set-wait" }, h("div", { class: "spin" }), "Reading omp settings…"));
      loadConfig().then(() => {
        if (page !== tab) return;
        if (config) return showPage(tab);
        body.replaceChildren(h("div", { class: "row-err", text: "Could not read omp settings: " + configError }),
          h("button", { type: "button", class: "btn", text: "Try again", onclick: () => showPage(tab) }));
      });
      return;
    }

    const entries = Object.entries(config).filter(([, e]) => (e.tab || "other") === tab);
    if (!entries.length) {
      body.append(h("p", { class: "set-empty", text: navButtons.has("other")
        ? "The installed omp does not report sections; its settings are listed under Other."
        : "No settings in this section." }));
      return;
    }
    const order = TAB_GROUPS[tab] || [];
    const groups = new Map([["", []]]);
    for (const name of order) groups.set(name, []);
    for (const entry of entries) {
      const g = entry[1].group || "";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(entry);
    }
    for (const [name, list] of groups) {
      if (!list.length) continue;
      const section = h("section", { class: "set-group" }, name && h("h2", { text: name }));
      for (const [key] of list) section.append(settingRow(key));
      body.append(section);
    }
    body.append(h("p", { class: "set-foot",
      text: "Saved to your global omp config. Queue modes, auto-compaction, auto-retry and cache warming also apply to running chats at once; other changes may need a new session." }));
  }

  // Settings a running omp can take over RPC: config key -> value -> [command, params].
  const LIVE = {
    steeringMode: (v) => ["set_steering_mode", { mode: v }],
    followUpMode: (v) => ["set_follow_up_mode", { mode: v }],
    interruptMode: (v) => ["set_interrupt_mode", { mode: v }],
    "compaction.enabled": (v) => ["set_auto_compaction", { enabled: v === true }],
    "retry.enabled": (v) => ["set_auto_retry", { enabled: v === true }],
    "providers.cacheWarming": (v) => ["set_cache_warming", { mode: v }],
  };
  /** Apply a saved value to every running chat; returns the note to show under the row, or null. */
  async function pushLive(key, value) {
    const live = LIVE[key];
    const rpc = window.kostompRpc;
    if (!live || value === undefined || !rpc?.broadcast) return null;
    const [type, params] = live(value);
    try {
      const { sent, failed } = await rpc.broadcast(type, params, 5000);
      if (!sent) return null;
      if (!failed.length) return sent === 1 ? "Applied to the running chat." : `Applied to ${sent} running chats.`;
      return `Saved, but ${failed.length} of ${sent} running chats did not take it: ${failed[0]}`;
    } catch (x) {
      return "Saved, but could not reach the running chats: " + String(x);
    }
  }

  // Value text for `omp config set`: JSON for strings too, so a value that looks like JSON stays a string.
  function encode(type, value) {
    if (type === "boolean") return value ? "true" : "false";
    if (type === "number") return String(value);
    return JSON.stringify(value);
  }

  function settingRow(key) {
    const e = config[key];
    const err = h("div", { class: "row-err", hidden: true });
    const note = h("div", { class: "row-note", hidden: true });
    let el;

    async function commit(value) {
      err.hidden = true;
      try {
        const out = JSON.parse(await invoke("omp_config_set", { key, value: encode(e.type, value) }));
        if (out.redacted) { e.redacted = true; delete e.value; } else e.value = "value" in out ? out.value : value;
        const by = out.overriddenBy || out.fallbackEnv;
        if (by) { e.note = (out.overriddenBy ? "Saved, but overridden by " : "Saved; falls back to ") + by + "."; }
        else delete e.note;
        // An override elsewhere is what running chats use, so only an effective value is pushed.
        if (!out.overriddenBy && !out.redacted) {
          const pushed = await pushLive(key, e.value);
          if (pushed) e.note = e.note ? `${e.note} ${pushed}` : pushed;
        }
        if (!out.overriddenBy) addNewSessionNote();
        refresh();
      } catch (x) {
        refresh();
        el.querySelector(".row-err").hidden = false;
        el.querySelector(".row-err").textContent = String(x);
      }
    }
    async function reset() {
      try {
        const out = JSON.parse(await invoke("omp_config_reset", { key }));
        if (out.redacted) { e.redacted = true; delete e.value; } else { delete e.redacted; e.value = out.value; }
        delete e.note;
        if (!out.redacted && !out.overriddenBy) {
          const pushed = await pushLive(key, e.value);
          if (pushed) e.note = pushed;
        }
        if (!out.overriddenBy) addNewSessionNote();
        refresh();
      } catch (x) {
        err.hidden = false;
        err.textContent = String(x);
      }
    }
    /** Running chats keep the old value of a setting omp cannot take over RPC: say so under the row. */
    function addNewSessionNote() {
      if (LIVE[key]) return;
      const msg = "Applies in a new session.";
      e.note = e.note ? `${e.note} ${msg}` : msg;
    }
    function refresh() {
      const next = settingRow(key);
      el.replaceWith(next);
      el = next;
    }

    const control = buildControl(key, e, commit);
    const wide = control.classList.contains("wide");
    if (e.warning) { note.hidden = false; note.textContent = e.warning; }
    if (e.note) { note.hidden = false; note.textContent = e.note; }
    el = h("div", { class: "set-row" + (wide ? " wide" : "") },
      h("div", { class: "txt" },
        h("div", { class: "name" }, e.label || key,
          h("button", { type: "button", class: "link reset", text: "reset", title: "Reset to default", onclick: reset })),
        e.description && h("div", { class: "desc", text: e.description }),
        h("div", { class: "key", text: key }),
        note, err),
      h("div", { class: "ctl" + (wide ? " wide" : "") }, control));
    return el;
  }

  function choiceList(e) {
    if (Array.isArray(e.options) && e.options.length) return e.options.map((o) => [o.value, o.label || o.value, o.description]);
    if (Array.isArray(e.values) && e.values.length) return e.values.map((v) => [v, v]);
    return null;
  }

  function buildControl(key, e, commit) {
    const choices = choiceList(e);
    const v = e.value;
    if (e.type === "boolean") {
      const b = toggle(e.label || key, (on) => commit(on));
      b.setAttribute("aria-checked", String(v === true));
      return b;
    }
    if ((e.type === "enum" || e.type === "string" || e.type === "number") && choices) {
      const cur = v === undefined || v === null ? v : String(v);
      const list = choices.some(([c]) => c === cur) || cur === undefined || cur === null ? choices : [[cur, cur], ...choices];
      const sel = h("select", { class: "field", "aria-label": e.label || key,
        onchange: () => commit(e.type === "number" ? Number(sel.value) : sel.value) },
        list.map(([value, label, desc]) => h("option", { value, text: label, title: desc, selected: value === cur })));
      if (v === undefined || v === null || v === "") sel.prepend(h("option", { value: "", text: "(not set)", selected: true, disabled: true }));
      return sel;
    }
    if (e.type === "string") {
      const secret = e.secret || e.redacted;
      const input = h("input", { class: "field", type: secret ? "password" : "text", spellcheck: false,
        "aria-label": e.label || key, value: secret ? "" : (v ?? ""),
        placeholder: secret ? (e.redacted ? "configured, type to replace" : "not set") : "" });
      input.addEventListener("change", () => {
        if (secret && input.value === "") return;
        commit(input.value);
      });
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") input.blur(); });
      return input;
    }
    if (e.type === "number") {
      const input = h("input", { class: "field num", type: "number", "aria-label": e.label || key, value: v ?? "" });
      input.addEventListener("change", () => { if (input.value !== "") commit(Number(input.value)); });
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") input.blur(); });
      return input;
    }
    if (e.type === "array" && choices) {
      const on = new Set(Array.isArray(v) ? v : []);
      const box = h("div", { class: "checks wide" });
      for (const [value, label, desc] of choices) {
        const cb = h("input", { type: "checkbox", checked: on.has(value) });
        cb.addEventListener("change", () => {
          if (cb.checked) on.add(value); else on.delete(value);
          commit(choices.map(([c]) => c).filter((c) => on.has(c)));
        });
        box.append(h("label", { title: desc }, cb, label));
      }
      return box;
    }
    // array / record without choices: edit as JSON.
    const area = h("textarea", { class: "field json wide", spellcheck: false, rows: 3, "aria-label": e.label || key,
      value: JSON.stringify(v ?? (e.type === "array" ? [] : {}), null, 2) });
    area.addEventListener("change", () => {
      let parsed;
      try { parsed = JSON.parse(area.value); } catch (x) {
        area.classList.add("bad");
        area.title = "Not valid JSON: " + x.message;
        return;
      }
      area.classList.remove("bad");
      commit(parsed);
    });
    return area;
  }

  // ---- graph page (graph/service.ts: the profile.json settings / configure requests) ----
  async function graphRequest(op, input) {
    const res = await invoke("graph_request", { request: { op, input } });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  function renderGraphPage() {
    const body = h("div", { class: "set-body" });
    pageEl.append(
      h("h1", { text: "Graph" }),
      h("p", { class: "set-lead", text: "The model that plans and codes, the Docker tester, the failure judge and how Graph treats the source checkout." }),
      body);
    body.append(waitBox("Reading the Graph profile…"));
    graphRequest("settings").then(
      (state) => { if (page === "graph") drawGraph(body, state); },
      (err) => { if (page === "graph") failBox(body, err, () => showPage("graph")); });
  }

  function drawGraph(body, { path, profile, error }) {
    body.replaceChildren();
    const p = profile && typeof profile === "object" ? profile : {};
    const tester = p.tester || {};
    const judge = p.failureJudge || null;
    const input = (type, label, value, cls) => h("input", { class: cls || "field", type, spellcheck: false,
      "aria-label": label, value: value ?? "" });
    const switchOf = (label, on, onFlip) => {
      const b = toggle(label, (want) => { b.setAttribute("aria-checked", String(want)); onFlip(want); });
      b.setAttribute("aria-checked", String(on));
      return b;
    };
    const group = (title, ...rows) => h("section", { class: "set-group" }, h("h2", { text: title }), ...rows);

    let allowDirty = p.allowDirty === true;
    let judgeOn = judge !== null;
    const provider = input("text", "Provider", p.provider);
    const model = input("text", "Model", p.model);
    const maxCoders = h("select", { class: "field", "aria-label": "Parallel Coders" },
      h("option", { value: "", text: "Default (2)", selected: p.maxCoders === undefined }),
      [1, 2, 3, 4].map((n) => h("option", { value: String(n), text: String(n), selected: p.maxCoders === n })));
    const dockerPath = input("text", "Docker executable", tester.dockerPath);
    const imageId = input("text", "Docker image ID", tester.imageId);
    const command = h("textarea", { class: "field json", spellcheck: false, rows: 3, "aria-label": "Container command",
      placeholder: "/bin/sh\n-c\nbun test", value: Array.isArray(tester.command) ? tester.command.join("\n") : "" });
    const timeout = input("number", "Tester timeout (ms)", tester.timeoutMs, "field num");
    const judgeProvider = input("text", "Judge provider", judge?.provider);
    const judgeModel = input("text", "Judge model", judge?.model);
    const judgeTimeout = input("number", "Judge timeout (ms)", judge?.timeoutMs, "field num");
    const judgeUrl = input("text", "Judge base URL", judge?.baseUrl);
    judgeUrl.placeholder = "Provider default";

    const judgeRows = [
      row("Provider", "Catalog provider that serves the judge model.", judgeProvider),
      row("Model", "Bundled judgment model. Its API key comes from the app's environment.", judgeModel),
      row("Timeout (ms)", "Up to 5000. A slow judge is recorded as unavailable.", judgeTimeout),
      row("Base URL", "Optional endpoint override.", judgeUrl),
    ];
    const syncJudge = () => {
      for (const r of judgeRows) {
        r.classList.toggle("off", !judgeOn);
        for (const c of r.querySelectorAll("input")) c.disabled = !judgeOn;
      }
    };
    const commandRow = row("Container command", "One argument per line. The first is the executable.", command);
    commandRow.classList.add("wide");

    const status = h("div", { class: "row-err", hidden: true });
    const save = h("button", { type: "button", class: "btn", text: "Save" });

    function collect() {
      const text = (el, name) => {
        const v = el.value.trim();
        if (!v) throw new Error(name + " is required.");
        return v;
      };
      const whole = (el, name) => {
        const v = Number(el.value);
        if (el.value.trim() === "" || !Number.isInteger(v)) throw new Error(name + " must be a whole number.");
        return v;
      };
      const out = {
        provider: text(provider, "Provider"),
        model: text(model, "Model"),
        tester: {
          dockerPath: text(dockerPath, "Docker executable"),
          imageId: text(imageId, "Docker image ID"),
          command: command.value.split(/\r?\n/).filter((line) => line.trim() !== ""),
          timeoutMs: whole(timeout, "Tester timeout"),
        },
      };
      if (!out.tester.command.length) throw new Error("Container command is required.");
      if (maxCoders.value) out.maxCoders = Number(maxCoders.value);
      if (allowDirty) out.allowDirty = true;
      if (judgeOn) {
        out.failureJudge = {
          provider: text(judgeProvider, "Judge provider"),
          model: text(judgeModel, "Judge model"),
          timeoutMs: whole(judgeTimeout, "Judge timeout"),
        };
        if (judgeUrl.value.trim()) out.failureJudge.baseUrl = judgeUrl.value.trim();
      }
      return out;
    }
    const show = (text, ok) => {
      status.hidden = false;
      status.className = ok ? "set-foot" : "row-err";
      status.textContent = text;
    };
    save.addEventListener("click", async () => {
      let next;
      try { next = collect(); } catch (x) { show(x.message, false); return; }
      save.disabled = true;
      try {
        await graphRequest("configure", next);
        show("Saved.", true);
      } catch (x) {
        show(rpcErrorText(x), false);
      } finally {
        save.disabled = false;
      }
    });

    if (error) body.append(h("div", { class: "row-err", text: "The saved profile is not usable: " + error }));
    body.append(
      group("Source",
        row("Allow uncommitted changes", "Plan and run on a dirty checkout. Graph still works from the committed HEAD only, so uncommitted edits are invisible to the agents, and a patch may conflict with them when applied.",
          switchOf("Allow uncommitted changes", allowDirty, (on) => { allowDirty = on; }))),
      group("Agents",
        row("Provider", "Catalog provider the Planner, Coders and Reviewer run on.", provider),
        row("Model", "Model ID. Credentials live in the Graph profile-home agent directory.", model),
        row("Parallel Coders", "How many Coders with disjoint files run at once.", maxCoders)),
      group("Tester",
        row("Docker executable", "Absolute path to docker.exe.", dockerPath),
        row("Image ID", "A preloaded image. Graph never pulls one.", imageId),
        commandRow,
        row("Timeout (ms)", "Up to 300000.", timeout)),
      group("Failure judge",
        row("Observe test failures", "Classify failed tests with a judge model. Observation only: it never changes a decision.",
          switchOf("Observe test failures", judgeOn, (on) => { judgeOn = on; syncJudge(); })),
        ...judgeRows),
      h("div", { class: "models-bar" }, save, status),
      h("p", { class: "set-foot", text: "Saved to " + path + ". Changing the agents, tester, parallel Coders or failure judge makes saved plans and runs ask for a new plan; the source option does not. Settings cannot be saved while a Graph plan or run is active." }));
    syncJudge();
  }

  // ---- start ------------------------------------------------------------
  let started = false;
  function onView(name) {
    if (name !== "settings") return;
    if (!started) { started = true; showPage(localStorage.getItem(PAGE_KEY) || "window"); }
    loadConfig();
  }
  document.addEventListener("kostomp-view", (e) => onView(e.detail));
  if (!$("settings").hidden) onView("settings");
})();
