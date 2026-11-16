(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { browseFolder, folderName, loadRecent, saveRecent, MAX_IMAGE_BYTES } = window.KostompFolders;
  const $ = id => document.getElementById(id);
  const chat = $("chat");
  const panel = $("design");
  const stage = $("design-stage");
  const empty = $("design-empty");
  const titleInput = $("design-title");
  const zoomOut = $("design-zoom-out");
  const zoomIn = $("design-zoom-in");
  const zoomLevel = $("design-zoom-level");
  const fitButton = $("design-fit");
  const dockWrap = panel.querySelector(".design-dock-wrap");
  const form = $("design-form");
  const input = $("design-input");
  const sendButton = $("design-send");
  const sendIcon = sendButton.querySelector(".send-ico");
  const stopIcon = sendButton.querySelector(".stop-ico");
  const statusLine = $("design-status");
  const targetChip = $("design-target-text").parentElement;
  const targetText = $("design-target-text");
  const targetClear = $("design-target-clear");
  const variantsWrap = $("design-variants-wrap");
  const variantsSelect = $("design-variants");
  const skillSelect = $("design-skill");
  const switchButton = $("design-switch");
  const notesButton = $("design-send-notes");
  const designsPanel = window.KostompDesignsPanel;
  const history = designsPanel.querySelector("#design-history");
  const historyEmpty = designsPanel.querySelector("#design-board-empty");
  const historyRefresh = designsPanel.querySelector("#designs-refresh");
  const openList = $("design-open");
  const sideDesigns = $("side-designs");
  const newButton = $("design-new");
  const modelSelect = $("design-model");
  const sysButton = $("design-system-btn");
  const sysDot = $("design-system-dot");
  const sysPanel = $("design-system-panel");
  const sysText = $("design-system-text");
  const sysDirty = $("design-system-dirty");
  const sysNote = $("design-system-note");
  const sysLoad = $("design-system-load");
  const sysGenerate = $("design-system-generate");
  const sysClear = $("design-system-clear");
  const sysSave = $("design-system-save");
  const sysClose = $("design-system-close");
  const sysFile = $("design-system-file");
  const implementSlot = $("design-implement-slot");
  const projectSelect = $("design-project");
  const projectBrowse = $("design-project-browse");
  const projectWrap = $("design-project-wrap");
  const attachButton = $("design-attach");
  const attachStrip = $("design-attachments");
  const stateBadge = $("design-state");

  const OPEN_KEY = "kostomp-design-open";
  const CARD_W = 1280;
  const CARD_H = 800;
  const HEAD = 38;
  const GAP = 60;
  const MIN_W = 320;
  const MIN_H = 240;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 2;
  const STOP_GRACE_MS = 8000;

  /** Runs inside every design iframe: reports clicks and ctrl+wheel, and answers "what is at this point" probes. */
  const PROBE_SCRIPT = `<script>(()=>{
const post=m=>parent.postMessage(m,"*");
addEventListener("pointerdown",e=>post({type:"kd-click",shift:e.shiftKey}),true);
addEventListener("wheel",e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();post({type:"kd-zoom",dy:e.deltaY});}},{passive:false});
const path=n=>{const parts=[];for(;n&&n.nodeType===1&&n!==document.documentElement&&parts.length<6;n=n.parentElement){let s=n.tagName.toLowerCase();if(n.id){parts.unshift(s+"#"+CSS.escape(n.id));break;}const sib=n.parentElement?[...n.parentElement.children].filter(c=>c.tagName===n.tagName):[];if(sib.length>1)s+=":nth-of-type("+(sib.indexOf(n)+1)+")";parts.unshift(s);}return parts.join(" > ");};
addEventListener("message",e=>{const d=e.data;if(e.source!==parent||!d)return;if(d.type==="kd-locate"){let n=null;try{n=document.querySelector(String(d.selector).slice(0,500));}catch{}const r=n?n.getBoundingClientRect():null;const ok=!!r&&(r.width>0||r.height>0)&&innerWidth>0&&innerHeight>0;post({type:"kd-locate-result",id:d.id,found:ok,x:ok?(r.left+r.width/2)/innerWidth:0,y:ok?(r.top+r.height/2)/innerHeight:0});return;}if(d.type!=="kd-probe")return;const n=document.elementFromPoint(d.x,d.y);const t=n?(n.innerText||n.textContent||"").replace(/\\s+/g," ").trim().slice(0,80):"";post({type:"kd-probe-result",id:d.id,selector:n?path(n):"",snippet:t});});
})()<\/script>`;

  let designMode = false;
  /** board.json values of every saved board, newest first. */
  let known = [];
  /** Runtime state per board id (saved boards and the unsaved draft). */
  const boards = new Map();
  let current = null;
  let draft = null;
  let skills = [];
  let zTop = 1;
  let openIds = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(OPEN_KEY));
      return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : [];
    } catch { return []; }
  })();
  const probes = new Map();
  let probeSeq = 0;
  const templates = new Map();
  let models = [];
  let modelsError = "";
  let modelsLoading = null;
  let modelSig = "";
  let designerModel = "";
  let designerKnown = false;
  let sysBoard = null;
  let exportMenu = null;
  let implPop = null;
  const DOC_MAX = 1024 * 1024;

  // ---- small helpers ---------------------------------------------------------------------------

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(paths, size = 15) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs = { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value));
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  const message = err => String(err?.message ?? err);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stripAnsi = text => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const agentId = b => "design-" + b.id;
  const randomId = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function blankData(id) {
    const now = Date.now();
    return { id, title: "", model: "", implementProject: loadRecent()[0] ?? "", createdAt: now, updatedAt: now, cards: {}, notes: {}, usedSkills: {} };
  }

  function normalize(data) {
    for (const key of ["cards", "notes", "usedSkills"]) {
      if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
    }
    if (typeof data.title !== "string") data.title = "";
    if (typeof data.model !== "string") data.model = "";
    if (typeof data.implementProject !== "string") data.implementProject = "";
    if (!Number.isFinite(data.createdAt)) data.createdAt = Date.now();
    if (!Number.isFinite(data.updatedAt)) data.updatedAt = data.createdAt;
    return data;
  }

  function makeBoard(data, persisted) {
    const b = {
      id: data.id,
      data: normalize(data),
      persisted,
      dir: null,
      world: el("div", "design-world"),
      cards: new Map(),
      selected: new Set(),
      pinning: null,
      pop: null,
      zoom: 1,
      panX: 40,
      panY: 64,
      userView: false,
      saveTimer: 0,
      refreshTimer: 0,
      refreshing: null,
      refreshAgain: false,
      implementing: false,
      attached: [],
      synced: false,
      status: { text: "", kind: "", title: "" },
      state: "",
      stateAt: 0,
      doc: { saved: "", draft: "", has: false },
      run: { proc: null, alive: false, openReady: null, busy: false, finishing: false, preparing: false, aborting: false, kind: "design", focusId: "", agentModel: "", stopping: null, seq: 0, reqId: "", targets: [], newIds: [], sent: [], forced: "", multiSkill: false, skillSeen: "", skillsSeen: [], summary: "", error: "", stderr: [], stopTimer: 0 },
    };
    boards.set(b.id, b);
    applyView(b);
    return b;
  }

  // ---- persistence of board.json ---------------------------------------------------------------

  function saveBoard(b, immediate) {
    if (!b.persisted) return Promise.resolve();
    clearTimeout(b.saveTimer);
    const write = async () => {
      b.saveTimer = 0;
      b.data.updatedAt = Date.now();
      try {
        await invoke("design_board_save", { boardId: b.id, board: b.data });
      } catch (err) {
        setStatus(b, "Could not save the board: " + message(err), "error");
      }
    };
    if (immediate) return write();
    b.saveTimer = setTimeout(write, 500);
    return Promise.resolve();
  }

  async function persist(b, titleSeed) {
    if (b.persisted) return;
    b.dir = await invoke("design_board_open", { boardId: b.id });
    if (!b.data.title.trim()) b.data.title = titleSeed.replace(/\s+/g, " ").trim().slice(0, 48) || "Untitled board";
    b.persisted = true;
    await saveBoard(b, true);
    known = [b.data, ...known.filter(item => item.id !== b.id)];
    if (!openIds.includes(b.id)) openIds.push(b.id);
    saveOpen();
    if (draft === b) draft = null;
    if (current === b) titleInput.value = b.data.title;
    renderLists();
  }

  const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(openIds)); } catch {} };

  async function refreshKnown() {
    try {
      const list = await invoke("design_boards");
      known = (Array.isArray(list) ? list : [])
        .filter(item => item && typeof item.id === "string")
        .map(item => {
          const live = boards.get(item.id);
          return live?.persisted ? live.data : item;
        });
    } catch (err) {
      if (current) setStatus(current, "Could not list design boards: " + message(err), "error");
    }
    const ids = new Set(known.map(item => item.id));
    const kept = openIds.filter(id => ids.has(id));
    if (kept.length !== openIds.length) {
      openIds = kept;
      saveOpen();
    }
    renderLists();
  }

  // ---- sidebar and designs list ----------------------------------------------------------------

  const boardTitle = data => data.title.trim() || "Untitled board";
  const cardCount = data => Object.keys(data.cards).length;

  function boardButton(data) {
    const button = el("button", "graph-run-item");
    button.type = "button";
    button.dataset.board = data.id;
    const name = el("span", "graph-run-name", boardTitle(data));
    const ico = el("span", "graph-run-ico", name.textContent.charAt(0) || "D");
    ico.setAttribute("aria-hidden", "true");
    button.append(ico, name, el("span", "graph-run-detail"));
    paintRow(button, data, boards.get(data.id));
    return button;
  }

  function deleteButton(data) {
    const button = el("button", "graph-run-delete", "⌫");
    button.type = "button";
    button.title = "Delete design board permanently";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      void deleteBoard(data).finally(() => { button.disabled = false; });
    });
    return button;
  }

  function renderLists() {
    const sorted = [...known].sort((a, b) => b.updatedAt - a.updatedAt);
    history.replaceChildren(...sorted.map(data => {
      const item = el("li", "graph-history-row");
      item.append(boardButton(data), deleteButton(data));
      return item;
    }));
    historyEmpty.hidden = known.length > 0;
    const rows = openIds.map(id => known.find(item => item.id === id)).filter(Boolean);
    openList.replaceChildren(...rows.map(data => {
      const item = el("li", "graph-open-row");
      const close = el("button", "graph-run-close", "×");
      close.type = "button";
      close.dataset.close = data.id;
      close.title = "Close design board";
      close.setAttribute("aria-label", close.title);
      item.append(boardButton(data), deleteButton(data), close);
      item.addEventListener("mousedown", event => { if (event.button === 1) event.preventDefault(); });
      item.addEventListener("auxclick", event => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeBoard(data.id);
      });
      return item;
    }));
    sideDesigns.hidden = rows.length === 0;
    markCurrent();
  }

  /** Highlight the open board, or New design, in the sidebar while the Design pane is on screen. */
  function markCurrent() {
    for (const button of [...history.querySelectorAll("button[data-board]"), ...openList.querySelectorAll("button[data-board]")]) {
      if (designMode && current?.persisted && button.dataset.board === current.id) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (designMode && current && !current.persisted) newButton.setAttribute("aria-current", "page");
    else newButton.removeAttribute("aria-current");
  }

  async function deleteBoard(data) {
    const confirmed = await window.kostompConfirmDelete("Delete design board?",
      `${boardTitle(data)}\nThis permanently removes the board and all of its designs. A running agent on this board will be stopped. This cannot be undone.`);
    if (!confirmed) return;
    const b = boards.get(data.id);
    try {
      if (b) {
        clearTimeout(b.saveTimer);
        b.persisted = false;
        await window.KostompRpcLifecycle.stop(agentId(b)).catch(() => {});
      }
      await invoke("design_board_delete", { boardId: data.id });
    } catch (err) {
      if (b) b.persisted = true;
      const shown = current ?? draft;
      if (shown) setStatus(shown, "Could not delete the board: " + message(err), "error");
      return;
    }
    known = known.filter(item => item.id !== data.id);
    openIds = openIds.filter(id => id !== data.id);
    saveOpen();
    if (b) {
      boards.delete(b.id);
      b.world.remove();
      if (current === b) {
        current = null;
        setMode(false);
      }
    }
    renderLists();
  }

  function closeBoard(id) {
    openIds = openIds.filter(open => open !== id);
    saveOpen();
    const b = boards.get(id);
    if (b && !b.run.busy && b.run.proc) {
      b.run.proc = null;
      b.run.alive = false;
      void window.KostompRpcLifecycle.stop(agentId(b)).catch(() => {});
    }
    renderLists();
    if (designMode && current?.id === id) setMode(false);
  }

  // ---- mode switching --------------------------------------------------------------------------

  /** Design shares the chat sidebar with Graph: its pane replaces the chat workspace until a chat is picked. */
  function setMode(on) {
    if (designMode === on) return;
    designMode = on;
    if (!on) closeImplementPop();
    chat.classList.toggle("design-mode", on);
    panel.hidden = !on;
    document.dispatchEvent(new CustomEvent("kostomp-design-mode"));
    markCurrent();
    if (on) {
      void refreshSkills();
      if (!models.length || modelsError) void refreshModels();
      requestAnimationFrame(() => { if (current && !current.userView) fit(current); });
    }
  }

  function show(b) {
    if (sysBoard && sysBoard !== b) closeSystem();
    current = b;
    stage.replaceChildren(b.world);
    titleInput.value = b.data.title;
    setMode(true);
    markCurrent();
    paintAll();
    requestAnimationFrame(() => { if (!b.userView) fit(b); });
  }

  async function openBoard(id) {
    const data = known.find(item => item.id === id);
    if (!data) return;
    const b = boards.get(id) ?? makeBoard(data, true);
    if (!openIds.includes(id)) {
      openIds.push(id);
      saveOpen();
    }
    show(b);
    renderLists();
    await refreshCards(b);
    void reloadDoc(b);
    // A board with earlier designs resumes its conversation so the agent remembers them.
    if (b.cards.size && !b.run.proc) ensureAgent(b).catch(err => setStatus(b, "Could not start the design agent: " + message(err), "error"));
  }

  function newDesign() {
    if (!draft) draft = makeBoard(blankData(randomId("b")), false);
    show(draft);
    input.focus();
  }

  document.addEventListener("kostomp-chat-shown", () => setMode(false));
  document.addEventListener("kostomp-graph-mode", () => { if (chat.classList.contains("graph-mode")) setMode(false); });
  const chatControls = document.querySelectorAll("#session-tabs, .sidebar .compose, .sidebar .seg");
  // app.js decides which of these clicks and keys navigate to a chat.
  const leaveForChat = event => { if (window.kostompLeavesForChat(event)) setMode(false); };
  for (const el of chatControls) {
    el.addEventListener("click", leaveForChat, true);
    el.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") leaveForChat(event); }, true);
  }
  $("designs-toggle").addEventListener("click", () => { setMode(false); void refreshKnown(); });
  historyRefresh.addEventListener("click", () => void refreshKnown());
  newButton.addEventListener("click", newDesign);
  history.addEventListener("click", event => {
    const id = event.target.closest("button[data-board]")?.dataset.board;
    if (id) void openBoard(id);
  });
  openList.addEventListener("click", event => {
    const close = event.target.closest("button[data-close]")?.dataset.close;
    if (close) closeBoard(close);
    else {
      const id = event.target.closest("button[data-board]")?.dataset.board;
      if (id) void openBoard(id);
    }
  });

  // ---- canvas: pan and zoom --------------------------------------------------------------------

  function applyView(b) {
    b.world.style.transform = `translate(${b.panX}px, ${b.panY}px) scale(${b.zoom})`;
    if (b !== current) return;
    zoomLevel.value = `${Math.round(b.zoom * 100)}%`;
    zoomOut.disabled = b.zoom <= MIN_ZOOM + 1e-6;
    zoomIn.disabled = b.zoom >= MAX_ZOOM - 1e-6;
  }

  function zoomAt(b, factor, clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const zoom = clamp(b.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = zoom / b.zoom;
    b.panX = px - (px - b.panX) * ratio;
    b.panY = py - (py - b.panY) * ratio;
    b.zoom = zoom;
    b.userView = true;
    applyView(b);
  }

  function zoomCenter(b, factor) {
    const rect = stage.getBoundingClientRect();
    zoomAt(b, factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function geometry(b, id) {
    return b.data.cards[id];
  }

  /** Center every card in the free area above the dock. */
  function fit(b) {
    if (b !== current) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    const boxes = [...b.cards.keys()].map(id => geometry(b, id)).filter(Boolean);
    b.userView = false;
    if (!boxes.length) {
      b.zoom = 1;
      b.panX = 40;
      b.panY = 64;
      applyView(b);
      return;
    }
    const minX = Math.min(...boxes.map(g => g.x));
    const minY = Math.min(...boxes.map(g => g.y));
    const maxX = Math.max(...boxes.map(g => g.x + g.w));
    const maxY = Math.max(...boxes.map(g => g.y + g.h + HEAD));
    const top = 56;
    const bottom = dockWrap.offsetHeight + 12;
    const availW = Math.max(120, width - 64);
    const availH = Math.max(120, height - top - bottom - 12);
    const boxW = maxX - minX;
    const boxH = maxY - minY;
    const zoom = clamp(Math.min(availW / boxW, availH / boxH, 1), MIN_ZOOM, MAX_ZOOM);
    b.zoom = zoom;
    b.panX = (width - boxW * zoom) / 2 - minX * zoom;
    b.panY = top + (availH + 12 - boxH * zoom) / 2 - minY * zoom;
    applyView(b);
  }

  let panning = null;
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || !current || event.target.closest(".design-card")) return;
    panning = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: current.panX, panY: current.panY, moved: false, board: current };
  });
  stage.addEventListener("pointermove", event => {
    if (!panning || event.pointerId !== panning.id) return;
    const dx = event.clientX - panning.x;
    const dy = event.clientY - panning.y;
    if (!panning.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      panning.moved = true;
      panning.board.userView = true;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("is-panning");
    }
    panning.board.panX = panning.panX + dx;
    panning.board.panY = panning.panY + dy;
    applyView(panning.board);
  });
  function endPan(event) {
    if (!panning || event.pointerId !== panning.id) return;
    const { moved, board } = panning;
    panning = null;
    stage.classList.remove("is-panning");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!moved && event.type === "pointerup") {
      closePop(board);
      setPinning(board, null);
      board.selected.clear();
      paintSelection(board);
    }
  }
  stage.addEventListener("pointerup", endPan);
  stage.addEventListener("pointercancel", endPan);
  stage.addEventListener("wheel", event => {
    if (!current) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAt(current, Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    } else {
      current.panX -= event.deltaX;
      current.panY -= event.deltaY;
      current.userView = true;
      applyView(current);
    }
  }, { passive: false });
  zoomOut.addEventListener("click", () => current && zoomCenter(current, 1 / 1.2));
  zoomIn.addEventListener("click", () => current && zoomCenter(current, 1.2));
  fitButton.addEventListener("click", () => current && fit(current));
  new ResizeObserver(() => { if (designMode && current && !current.userView) fit(current); }).observe(stage);

  // ---- cards -----------------------------------------------------------------------------------

  function autoPlace(b) {
    const taken = Object.values(b.data.cards).filter(g => g && Number.isFinite(g.x));
    const pad = GAP / 2;
    const hit = (x, y) => taken.some(c => x < c.x + c.w + pad && x + CARD_W + pad > c.x && y < c.y + c.h + HEAD + pad && y + CARD_H + HEAD + pad > c.y);
    for (let row = 0; row < 500; row++) {
      for (let col = 0; col < 2; col++) {
        const x = col * (CARD_W + GAP);
        const y = row * (CARD_H + HEAD + GAP);
        if (!hit(x, y)) return { x, y, w: CARD_W, h: CARD_H };
      }
    }
    return { x: 0, y: 0, w: CARD_W, h: CARD_H };
  }

  function placeCard(rec, g) {
    rec.el.style.left = `${g.x}px`;
    rec.el.style.top = `${g.y}px`;
    rec.el.style.width = `${g.w}px`;
    rec.el.style.height = `${g.h + HEAD}px`;
  }

  function cardButton(className, label, paths) {
    const button = el("button", "dc-btn " + className);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(paths));
    return button;
  }

  function addCard(b, id) {
    let g = b.data.cards[id];
    if (![g?.x, g?.y, g?.w, g?.h].every(Number.isFinite)) g = b.data.cards[id] = autoPlace(b);
    g.w = Math.max(MIN_W, g.w);
    g.h = Math.max(MIN_H, g.h);
    const rec = { id, el: el("article", "design-card"), meta: null, hasHtml: false, modified: -1, html: "", critique: null, critiqueModified: 0, pinLayer: null, popLayer: null };
    rec.el.dataset.id = id;
    const head = el("header", "design-card-head");
    rec.title = el("span", "design-card-title");
    rec.skill = el("span", "design-card-skill glass-pill");
    rec.selectBtn = cardButton("dc-select", "Select to iterate on this design (Shift-click to add)", ["M5 12.5 10 17.5 19 7"]);
    rec.notesBtn = cardButton("dc-notes", "Pin notes on this design", ["M4 5h16v11H9l-5 4z"]);
    rec.count = el("span", "dc-count glass-pill");
    rec.count.hidden = true;
    rec.notesBtn.append(rec.count);
    rec.critBtn = cardButton("dc-critique dc-text", "Critique this design: the agent reviews it and pins its findings", ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5"]);
    rec.critBtn.append(el("span", "dc-label", "Critique"));
    rec.exportBtn = cardButton("dc-export", "Export this design", ["M12 3v12M7 10l5 5 5-5M5 20h14"]);
    rec.implement = implementControl(true, () => ({ b, ids: [rec.id], fromDock: false }));
    rec.exportBtn.setAttribute("aria-haspopup", "menu");
    rec.exportBtn.setAttribute("aria-expanded", "false");
    rec.openBtn = cardButton("dc-open", "Preview large", ["M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"]);
    rec.delBtn = cardButton("dc-del", "Delete design", ["M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"]);
    head.append(rec.title, rec.skill, el("span", "design-card-spacer"), rec.critBtn, rec.implement.node, rec.exportBtn, rec.selectBtn, rec.notesBtn, rec.openBtn, rec.delBtn);
    const body = el("div", "design-card-body");
    rec.frame = document.createElement("iframe");
    rec.frame.setAttribute("sandbox", "allow-scripts");
    rec.frame.title = "Design preview";
    rec.frame.hidden = true;
    rec.wait = el("div", "design-card-wait", "Designing…");
    rec.busyLayer = el("div", "design-card-busy");
    rec.overlay = el("div", "design-card-overlay");
    rec.pinLayer = el("div");
    rec.pinLayer.style.display = "contents";
    rec.popLayer = el("div");
    rec.popLayer.style.display = "contents";
    rec.overlay.append(rec.pinLayer, rec.popLayer);
    body.append(rec.frame, rec.wait, rec.busyLayer, rec.overlay);
    const grip = el("div", "design-card-resize");
    grip.title = "Resize";
    rec.el.append(head, body, grip);
    placeCard(rec, g);
    rec.el.style.zIndex = String(++zTop);
    b.cards.set(id, rec);
    b.world.append(rec.el);
    wireCard(b, rec, head, grip);
    paintCard(b, rec);
    renderPins(b, rec);
    return rec;
  }

  function wireCard(b, rec, head, grip) {
    rec.el.addEventListener("pointerdown", () => { rec.el.style.zIndex = String(++zTop); });
    head.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const g = geometry(b, rec.id);
      // `g` holds the committed position until release; moving by transform keeps the iframe card from re-laying out per move.
      const start = { x: event.clientX, y: event.clientY, gx: g.x, gy: g.y, tx: g.x, ty: g.y, moved: false };
      head.setPointerCapture(event.pointerId);
      const move = e => {
        if (e.pointerId !== event.pointerId) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!start.moved) {
          if (Math.hypot(dx, dy) < 3) return;
          start.moved = true;
          stage.classList.add("is-dragging");
          rec.el.classList.add("is-moving");
        }
        start.tx = Math.round(start.gx + dx / b.zoom);
        start.ty = Math.round(start.gy + dy / b.zoom);
        rec.el.style.transform = `translate(${start.tx - g.x}px, ${start.ty - g.y}px)`;
      };
      const up = e => {
        if (e.pointerId !== event.pointerId) return;
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        head.removeEventListener("pointercancel", up);
        document.removeEventListener("lostpointercapture", lost);
        stage.classList.remove("is-dragging");
        rec.el.classList.remove("is-moving");
        rec.el.style.transform = "";
        if (start.moved) {
          if (b.cards.get(rec.id) !== rec) return;
          g.x = start.tx;
          g.y = start.ty;
          placeCard(rec, g);
          saveBoard(b);
        } else if (e.type === "pointerup") selectCard(b, rec.id, e.shiftKey || e.ctrlKey || e.metaKey);
      };
      // A removed card's capture loss is fired at the document, not at the detached head.
      const lost = e => { if (e.target === head || !head.isConnected) up(e); };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
      head.addEventListener("pointercancel", up);
      document.addEventListener("lostpointercapture", lost);
    });
    grip.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const g = geometry(b, rec.id);
      const start = { x: event.clientX, y: event.clientY, w: g.w, h: g.h };
      grip.setPointerCapture(event.pointerId);
      stage.classList.add("is-dragging");
      let frame = 0;
      const move = e => {
        if (e.pointerId !== event.pointerId) return;
        g.w = Math.max(MIN_W, Math.round(start.w + (e.clientX - start.x) / b.zoom));
        g.h = Math.max(MIN_H, Math.round(start.h + (e.clientY - start.y) / b.zoom));
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; placeCard(rec, g); });
      };
      const up = e => {
        if (e.pointerId !== event.pointerId) return;
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        document.removeEventListener("lostpointercapture", lost);
        cancelAnimationFrame(frame);
        frame = 0;
        stage.classList.remove("is-dragging");
        if (b.cards.get(rec.id) !== rec) return;
        placeCard(rec, g);
        saveBoard(b);
      };
      const lost = e => { if (e.target === grip || !grip.isConnected) up(e); };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
      document.addEventListener("lostpointercapture", lost);
    });
    rec.selectBtn.addEventListener("click", () => selectCard(b, rec.id, true));
    rec.notesBtn.addEventListener("click", () => setPinning(b, b.pinning === rec.id ? null : rec.id));
    rec.openBtn.addEventListener("click", () => openPreview(b, rec));
    rec.delBtn.addEventListener("click", () => void deleteCard(b, rec));
    rec.critBtn.addEventListener("click", () => void critique(b, rec));
    rec.exportBtn.addEventListener("click", () => toggleExportMenu(rec.exportBtn, b, rec));
    rec.overlay.addEventListener("click", event => {
      if (event.target !== rec.overlay || b.pinning !== rec.id) return;
      closePop(b);
      const rect = rec.overlay.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const note = { id: randomId("n"), x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1), text: "", done: false };
      (b.data.notes[rec.id] ??= []).push(note);
      renderPins(b, rec);
      openPop(b, rec, note);
      void probe(rec, note.x, note.y).then(found => {
        if (!found) return;
        if (found.selector) note.selector = found.selector;
        if (found.snippet) note.snippet = found.snippet;
        if (b.pop?.note === note) paintPopMeta(b.pop);
        saveBoard(b);
      });
    });
  }

  function paintCard(b, rec) {
    const used = b.data.usedSkills[rec.id];
    const skill = (typeof rec.meta?.skill === "string" && rec.meta.skill.trim()) || (Array.isArray(used) ? used[used.length - 1] : "") || "";
    rec.title.textContent = (typeof rec.meta?.title === "string" && rec.meta.title.trim()) || (rec.hasHtml ? rec.id : "Designing…");
    rec.title.title = typeof rec.meta?.prompt === "string" ? rec.meta.prompt : rec.title.textContent;
    rec.skill.textContent = skill;
    rec.skill.title = skill ? `Skill: ${skill}` : "";
    rec.wait.hidden = rec.hasHtml;
    rec.frame.hidden = !rec.hasHtml;
    rec.openBtn.disabled = rec.notesBtn.disabled = rec.exportBtn.disabled = !rec.hasHtml;
    rec.critBtn.disabled = !rec.hasHtml || isBusy(b);
    paintImplement(rec.implement, b, rec.hasHtml ? [rec.id] : []);
    const selected = b.selected.has(rec.id);
    rec.el.classList.toggle("is-selected", selected);
    rec.selectBtn.setAttribute("aria-pressed", String(selected));
    const pending = pendingFor(b, rec.id).length;
    rec.count.textContent = String(pending);
    rec.count.hidden = pending === 0;
    const pinning = b.pinning === rec.id;
    rec.el.classList.toggle("is-pinning", pinning);
    rec.notesBtn.setAttribute("aria-pressed", String(pinning));
    const run = b.run;
    rec.el.classList.toggle("is-busy", run.busy && (run.targets.includes(rec.id) || run.newIds.includes(rec.id) || run.focusId === rec.id));
    rec.critBtn.classList.toggle("is-running", run.busy && run.focusId === rec.id);
  }

  function paintCards(b) {
    for (const rec of b.cards.values()) paintCard(b, rec);
    if (preview?.b === b) paintImplement(preview.implement, b, preview.rec.hasHtml ? [preview.rec.id] : []);
  }

  function setFrame(rec, html) {
    rec.html = html;
    rec.frame.srcdoc = html + PROBE_SCRIPT;
  }

  function removeCard(b, id) {
    const rec = b.cards.get(id);
    if (rec) {
      if (b.pop?.rec === rec) closePop(b);
      rec.el.remove();
    }
    b.cards.delete(id);
    b.selected.delete(id);
    if (b.pinning === id) b.pinning = null;
    delete b.data.cards[id];
    delete b.data.notes[id];
    delete b.data.usedSkills[id];
  }

  async function deleteCard(b, rec) {
    const name = rec.title.textContent || rec.id;
    const confirmed = await window.kostompConfirmDelete(`Delete design "${name}"?`, "This permanently removes the design and its files from the board. This cannot be undone.");
    if (!confirmed) return;
    try {
      await invoke("design_card_delete", { boardId: b.id, designId: rec.id });
    } catch (err) {
      setStatus(b, "Could not delete the design: " + message(err), "error");
      return;
    }
    removeCard(b, rec.id);
    saveBoard(b);
    afterCardsChanged(b);
  }

  function afterCardsChanged(b) {
    paintCards(b);
    if (b === current) {
      paintAll();
      if (!b.userView) fit(b);
    }
    renderLists();
  }

  // ---- selection -------------------------------------------------------------------------------

  function selectCard(b, id, additive) {
    if (additive) {
      if (b.selected.has(id)) b.selected.delete(id);
      else b.selected.add(id);
    } else if (!(b.selected.size === 1 && b.selected.has(id))) {
      b.selected = new Set([id]);
    }
    paintSelection(b);
  }

  function paintSelection(b) {
    paintCards(b);
    if (b === current) paintDock();
  }

  const targetsOf = b => [...b.cards.keys()].filter(id => b.selected.has(id));

  // ---- notes -----------------------------------------------------------------------------------

  const notesOf = (b, id) => (Array.isArray(b.data.notes[id]) ? b.data.notes[id] : []);
  const pendingFor = (b, id) => notesOf(b, id).filter(note => !note.done && note.text.trim());
  const designsWithPending = b => [...b.cards.keys()].filter(id => pendingFor(b, id).length);

  function setPinning(b, id) {
    if (b.pinning === id) return;
    closePop(b);
    b.pinning = id;
    paintCards(b);
  }

  function renderPins(b, rec) {
    const notes = notesOf(b, rec.id);
    rec.pinLayer.replaceChildren(...notes.map((note, index) => {
      const pin = el("button", "design-pin", String(index + 1));
      pin.type = "button";
      pin.style.left = `${note.x * 100}%`;
      pin.style.top = `${note.y * 100}%`;
      pin.classList.toggle("is-done", !!note.done);
      pin.classList.toggle("is-open", b.pop?.note === note);
      if (note.source === "critique") pin.classList.add("is-critique", "sev-" + severityOf(note));
      pin.title = (note.source === "critique" ? `Critique · ${severityOf(note)} severity\n` : "") + (note.text ? (note.done ? "Sent: " : "") + note.text : "Empty note");
      pin.setAttribute("aria-label", `Note ${index + 1}`);
      pin.addEventListener("click", event => {
        event.stopPropagation();
        if (b.pop?.note === note) closePop(b);
        else {
          closePop(b);
          openPop(b, rec, note);
        }
      });
      return pin;
    }));
    paintCard(b, rec);
  }

  function paintPopMeta(pop) {
    const bits = [pop.note.selector, pop.note.snippet ? `“${pop.note.snippet}”` : ""].filter(Boolean);
    pop.meta.textContent = bits.join(" · ");
    pop.meta.title = pop.meta.textContent;
    pop.meta.hidden = bits.length === 0;
  }

  function openPop(b, rec, note) {
    closePop(b);
    const box = el("div", "design-pin-pop glass");
    const textarea = el("textarea", "glass-control");
    textarea.rows = 3;
    textarea.value = note.text;
    textarea.placeholder = "What should change here?";
    textarea.setAttribute("aria-label", `Note ${notesOf(b, rec.id).indexOf(note) + 1}`);
    const meta = el("div", "design-pin-meta");
    const state = el("span", "design-pin-state", note.done ? "Sent" : note.source === "critique" ? `Critique · ${severityOf(note)}` : "Pending");
    const remove = el("button", "danger", "Delete");
    remove.type = "button";
    const done = el("button", "", "Done");
    done.type = "button";
    const actions = el("div", "design-pin-actions");
    const right = el("div");
    right.style.display = "flex";
    right.style.gap = "6px";
    right.append(remove, done);
    actions.append(state, right);
    box.append(textarea, meta, actions);
    box.style.left = box.style.right = box.style.top = box.style.bottom = "";
    if (note.x < 0.55) box.style.left = `calc(${note.x * 100}% + 16px)`;
    else box.style.right = `calc(${(1 - note.x) * 100}% + 16px)`;
    if (note.y < 0.55) box.style.top = `calc(${note.y * 100}% - 12px)`;
    else box.style.bottom = `calc(${(1 - note.y) * 100}% - 12px)`;
    for (const type of ["pointerdown", "click", "wheel"]) box.addEventListener(type, event => event.stopPropagation());
    const pop = { box, note, rec, meta, state };
    b.pop = pop;
    paintPopMeta(pop);
    rec.popLayer.append(box);
    textarea.addEventListener("input", () => {
      note.text = textarea.value;
      if (note.done) {
        note.done = false;
        state.textContent = "Pending";
      }
      paintCard(b, rec);
      if (b === current) paintDock();
      saveBoard(b);
    });
    textarea.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closePop(b);
      }
    });
    done.addEventListener("click", () => closePop(b));
    remove.addEventListener("click", () => {
      removeNote(b, rec, note);
    });
    const pinButton = [...rec.pinLayer.children][notesOf(b, rec.id).indexOf(note)];
    pinButton?.classList.add("is-open");
    textarea.focus();
  }

  function removeNote(b, rec, note) {
    const list = notesOf(b, rec.id);
    const at = list.indexOf(note);
    if (at < 0) return;
    list.splice(at, 1);
    if (!list.length) delete b.data.notes[rec.id];
    if (b.pop?.note === note) {
      b.pop.box.remove();
      b.pop = null;
    }
    renderPins(b, rec);
    if (b === current) paintDock();
    saveBoard(b);
  }

  function closePop(b) {
    const pop = b.pop;
    if (!pop) return;
    b.pop = null;
    pop.box.remove();
    if (!pop.note.text.trim()) removeNote(b, pop.rec, pop.note);
    else renderPins(b, pop.rec);
  }

  /** Ask the design page what element sits at a point (0..1 of its viewport). */
  function probe(rec, fx, fy) {
    const target = rec.frame.contentWindow;
    if (!target || !rec.hasHtml) return Promise.resolve(null);
    const id = ++probeSeq;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        probes.delete(id);
        resolve(null);
      }, 800);
      probes.set(id, result => {
        clearTimeout(timer);
        resolve(result);
      });
      target.postMessage({ type: "kd-probe", id, x: Math.round(fx * rec.frame.clientWidth), y: Math.round(fy * rec.frame.clientHeight) }, "*");
    });
  }

  /** Ask the design page where a CSS selector sits: the element's center as 0..1 of its viewport, or null. */
  function locate(rec, selector) {
    const target = rec.frame.contentWindow;
    if (!target || !rec.hasHtml) return Promise.resolve(null);
    const id = ++probeSeq;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        probes.delete(id);
        resolve(null);
      }, 1500);
      probes.set(id, result => {
        clearTimeout(timer);
        resolve(result);
      });
      target.postMessage({ type: "kd-locate", id, selector }, "*");
    });
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string" || !data.type.startsWith("kd-")) return;
    let hit = null;
    for (const b of boards.values()) {
      for (const rec of b.cards.values()) {
        if (rec.frame.contentWindow && rec.frame.contentWindow === event.source) hit = { b, rec };
      }
    }
    if (!hit) return;
    if (data.type === "kd-click") {
      hit.rec.el.style.zIndex = String(++zTop);
      selectCard(hit.b, hit.rec.id, !!data.shift);
    } else if (data.type === "kd-zoom") {
      if (hit.b === current && Number.isFinite(data.dy)) zoomCenter(current, Math.exp(-data.dy * 0.0015));
    } else if (data.type === "kd-probe-result") {
      probes.get(data.id)?.({ selector: typeof data.selector === "string" ? data.selector : "", snippet: typeof data.snippet === "string" ? data.snippet : "" });
      probes.delete(data.id);
    } else if (data.type === "kd-locate-result") {
      const found = data.found === true && Number.isFinite(data.x) && Number.isFinite(data.y);
      probes.get(data.id)?.(found ? { x: clamp(data.x, 0.02, 0.98), y: clamp(data.y, 0.02, 0.98) } : null);
      probes.delete(data.id);
    }
  });

  // ---- large preview ---------------------------------------------------------------------------

  let preview = null;
  function closePreview() {
    if (!preview) return;
    closeExportMenu();
    closeImplementPop();
    const { node, opener } = preview;
    preview = null;
    node.remove();
    opener?.focus();
  }
  function openPreview(b, rec) {
    closePreview();
    const node = el("div", "design-preview glass");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-label", "Design preview");
    const bar = el("div", "design-preview-bar");
    const close = el("button", "glass-control", "Close");
    close.type = "button";
    close.id = "design-preview-close";
    close.addEventListener("click", closePreview);
    const exportButton = el("button", "design-preview-export glass-control", "Export ▾");
    exportButton.type = "button";
    exportButton.title = "Export this design";
    exportButton.setAttribute("aria-haspopup", "menu");
    exportButton.setAttribute("aria-expanded", "false");
    exportButton.addEventListener("click", () => toggleExportMenu(exportButton, b, rec));
    const note = el("span", "design-preview-note");
    note.setAttribute("role", "status");
    const actions = el("div", "design-preview-actions");
    const implement = implementControl(false, () => ({ b, ids: [rec.id], fromDock: false }));
    paintImplement(implement, b, [rec.id]);
    actions.append(implement.node, exportButton, close);
    bar.append(el("span", "design-preview-title", rec.title.textContent), note, actions);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = "Design preview";
    frame.srcdoc = rec.html;
    node.append(bar, frame);
    document.body.append(node);
    preview = { node, opener: document.activeElement, note, b, rec, implement };
    close.focus();
  }

  // ---- composer dock ---------------------------------------------------------------------------

  let switchOn = false;

  function lastDesignId(b) {
    let best = null;
    for (const rec of b.cards.values()) {
      if (rec.hasHtml && (!best || rec.modified > best.modified)) best = rec;
    }
    return best?.id ?? null;
  }

  function variantCount(targets = current ? targetsOf(current) : []) {
    return targets.length ? 0 : clamp(Number(variantsSelect.value) || 1, 1, 4);
  }

  /** Skills a "Switch skill" send must not use: what the targeted designs (or the newest batch) already used. */
  function excludedFor(b, targets, count = variantCount(targets)) {
    if (targets.length) {
      const out = new Set();
      for (const id of targets) {
        for (const name of Array.isArray(b.data.usedSkills[id]) ? b.data.usedSkills[id] : []) out.add(name);
      }
      return [...out];
    }
    const lastId = lastDesignId(b);
    if (!lastId) return [];
    const batchPrefix = lastId.replace(/-\d+$/, "") + "-";
    const ids = [...b.cards.values()]
      .filter(rec => rec.hasHtml && (rec.id === lastId || rec.id.startsWith(batchPrefix)))
      .sort((a, c) => c.modified - a.modified)
      .map(rec => rec.id);
    const out = new Set();
    for (const id of ids) {
      for (const name of Array.isArray(b.data.usedSkills[id]) ? b.data.usedSkills[id] : []) out.add(name);
    }
    if (skills.length >= 2) {
      const need = Math.min(Math.max(count, 1), skills.length);
      const activeNames = new Set(skills.map(skill => skill.name));
      const kept = [];
      let remaining = activeNames.size;
      for (const name of out) {
        if (activeNames.has(name)) {
          if (remaining - 1 < need) continue;
          remaining--;
        }
        kept.push(name);
      }
      return kept;
    }
    return [...out];
  }

  let skillSig = "";
  function paintSkills() {
    const wanted = skillSelect.value;
    const excluded = switchOn && current ? new Set(excludedFor(current, targetsOf(current))) : new Set();
    const sig = skills.map(skill => `${skill.name}\u0000${skill.description}\u0000${excluded.has(skill.name)}`).join("\u0001");
    if (sig !== skillSig) {
      skillSig = sig;
      const options = [new Option("Auto", "")];
      for (const skill of skills) {
        const option = new Option(skill.name, skill.name);
        option.title = skill.description;
        option.disabled = excluded.has(skill.name);
        options.push(option);
      }
      skillSelect.replaceChildren(...options);
    }
    const chosen = [...skillSelect.options].find(option => option.value === wanted);
    skillSelect.value = chosen && !chosen.disabled ? wanted : "";
  }

  async function refreshSkills() {
    try {
      const all = await invoke("design_skills");
      skills = (Array.isArray(all) ? all : []).filter(skill => skill?.active).map(skill => ({ name: String(skill.name || skill.dir), description: String(skill.description || "") }));
    } catch (err) {
      if (current) setStatus(current, "Could not read design skills: " + message(err), "error");
    }
    paintSkills();
  }

  function paintDock() {
    const b = current;
    if (!b) return;
    const targets = targetsOf(b);
    const busy = b.run.busy || b.run.finishing;
    targetChip.classList.toggle("is-target", targets.length > 0);
    targetText.textContent = targets.length === 0 ? "New design"
      : targets.length === 1 ? `Editing: ${b.cards.get(targets[0]).title.textContent}` : `${targets.length} selected`;
    targetClear.hidden = targets.length === 0;
    variantsWrap.hidden = targets.length > 0;
    input.placeholder = targets.length === 0 ? "Describe a design… (Enter to send, Shift+Enter for a new line)"
      : targets.length === 1 ? "Describe a change to this design…" : "Describe a change to the selected designs…";
    const pending = designsWithPending(b).reduce((sum, id) => sum + pendingFor(b, id).length, 0);
    notesButton.hidden = pending === 0;
    notesButton.textContent = pending === 1 ? "Send 1 note" : `Send ${pending} notes`;
    notesButton.disabled = busy;
    implementSlot.hidden = targets.length === 0;
    paintImplement(dockImplement, b, targets.filter(id => b.cards.get(id)?.hasHtml));
    switchButton.setAttribute("aria-pressed", String(switchOn));
    sendButton.classList.toggle("stop", b.run.busy);
    sendButton.title = b.run.busy ? "Stop" : "Send (Enter)";
    sendButton.setAttribute("aria-label", sendButton.title.replace(/ \(.*\)/, ""));
    sendButton.disabled = b.run.finishing;
    sendIcon.hidden = b.run.busy;
    stopIcon.hidden = !b.run.busy;
    paintSkills();
    paintModel();
    paintSystem();
    paintDocBadge();
    paintProject(b);
    paintAttachments(b);
    paintState(b);
  }

  function setStatus(b, text, kind = "", title = "") {
    b.status = { text, kind, title };
    if (b === current) paintStatus();
    paintState(b);
  }

  function paintStatus() {
    const status = current?.status ?? { text: "", kind: "", title: "" };
    statusLine.textContent = status.text;
    statusLine.classList.toggle("glass-pill", !!status.text);
    statusLine.title = status.title || status.text;
    if (status.kind) statusLine.dataset.kind = status.kind;
    else delete statusLine.dataset.kind;
  }

  // ---- board state: one reading for the sidebar row and the canvas badge ---------------------------

  /** busy: a turn, its preparation, an implementation or an export is in flight; bad/ok: how the last action ended. */
  function boardState(b) {
    if (isBusy(b) || b.implementing || b.status.kind === "busy") return "busy";
    if (b.status.kind === "error") return "bad";
    if (b.status.kind === "ok") return "ok";
    return "idle";
  }

  function stateLabel(b, state) {
    if (state === "bad") return "Error";
    if (state === "ok") return "Done";
    if (state === "idle") return cardCount(b.data) ? "Ready" : "Empty";
    const run = b.run;
    if (run.aborting) return "Stopping";
    if (b.implementing) return "Implementing";
    if (run.finishing) return "Finishing";
    if (run.busy) return run.kind === "critique" ? "Critiquing" : run.kind === "system" ? "Writing design system" : "Designing";
    if (run.preparing) return "Preparing";
    return "Working";
  }

  const clock = since => {
    const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };

  /** The board's state and its label; the busy clock restarts only when the state itself changes. */
  function stateView(b) {
    const state = boardState(b);
    if (b.state !== state) {
      b.state = state;
      b.stateAt = Date.now();
    }
    const label = stateLabel(b, state);
    return { state, text: state === "busy" ? `${label} ${clock(b.stateAt)}` : label, tip: b.status.text };
  }

  /** A sidebar board row: state dot, state label and design count. Boards not loaded yet are idle. */
  function paintRow(button, data, b) {
    const count = cardCount(b?.data ?? data);
    const designs = count === 1 ? "1 design" : `${count} designs`;
    const view = b ? stateView(b) : { state: "idle", text: "", tip: "" };
    button.dataset.state = view.state;
    button.querySelector(".graph-run-detail").textContent = view.state === "idle" ? designs : `${view.text} · ${designs}`;
    button.title = view.tip ? `${boardTitle(data)}\n${view.tip}` : boardTitle(data);
  }

  function paintState(b) {
    const rows = [...history.querySelectorAll("button[data-board]"), ...openList.querySelectorAll("button[data-board]")];
    for (const button of rows) if (button.dataset.board === b.id) paintRow(button, b.data, b);
    if (b !== current) return;
    const view = stateView(b);
    stateBadge.dataset.state = view.state;
    stateBadge.textContent = view.text;
    stateBadge.title = view.tip || view.text;
  }

  setInterval(() => { for (const b of boards.values()) if (b.state === "busy") paintState(b); }, 1000);

  function setPreparing(b, on) {
    b.run.preparing = on;
    paintState(b);
  }

  function paintAll() {
    if (!current) return;
    paintCards(current);
    paintDock();
    paintStatus();
    empty.hidden = current.cards.size > 0;
    applyView(current);
  }

  targetClear.addEventListener("click", () => {
    if (!current) return;
    current.selected.clear();
    paintSelection(current);
  });
  switchButton.addEventListener("click", () => {
    switchOn = !switchOn;
    paintDock();
  });
  variantsSelect.addEventListener("change", paintSkills);
  window.addEventListener("focus", () => {
    if (!designMode) return;
    void refreshSkills();
    if (!models.length || modelsError) void refreshModels();
  });
  titleInput.addEventListener("change", () => {
    if (!current) return;
    current.data.title = titleInput.value.trim();
    saveBoard(current);
    renderLists();
  });
  titleInput.addEventListener("keydown", event => { if (event.key === "Enter") titleInput.blur(); });
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!current) return;
    if (current.run.busy) stop(current);
    else void send();
  });
  notesButton.addEventListener("click", () => void send({ notesOnly: true }));

  // ---- project and reference images ------------------------------------------------------------

  /** The project dropdown: the board's project plus the recent ones shared with Chat and Graph. */
  function paintProject(b) {
    const chosen = b.data.implementProject;
    const paths = [];
    for (const candidate of [chosen, ...loadRecent()]) {
      if (candidate && !paths.some(p => samePath(p, candidate))) paths.push(candidate);
    }
    const labels = projectLabels(paths);
    const options = [new Option(paths.length ? "Choose a project…" : "No projects yet", "")];
    paths.forEach((value, index) => {
      const option = new Option(labels[index], value);
      option.title = value;
      options.push(option);
    });
    projectSelect.replaceChildren(...options);
    projectSelect.value = paths.find(p => chosen && samePath(p, chosen)) ?? "";
    projectSelect.title = chosen || "Choose the project these designs are for";
    projectSelect.disabled = projectBrowse.disabled = isBusy(b);
    projectWrap.dataset.missing = chosen ? "false" : "true";
  }

  function setProject(b, path) {
    if (!b || b.data.implementProject === path) return;
    b.data.implementProject = path;
    if (path) saveRecent(path);
    void saveBoard(b);
    if (b === current) paintDock();
  }

  projectSelect.addEventListener("change", () => setProject(current, projectSelect.value));
  projectBrowse.addEventListener("click", async () => {
    const b = current;
    if (!b) return;
    let picked = null;
    try {
      picked = await browseFolder(b.data.implementProject || loadRecent()[0] || null, { allowCreate: false });
    } catch (err) {
      setStatus(b, message(err), "error");
    }
    if (picked) setProject(b, picked);
  });

  function paintAttachments(b) {
    if (b !== current) return;
    attachStrip.replaceChildren(...b.attached.map((image, index) => {
      const label = `Image ${index + 1}`;
      const item = el("span", "thumb");
      const picture = el("img");
      picture.src = image.src;
      picture.alt = label;
      const remove = el("button", "rm", "×");
      remove.type = "button";
      remove.title = `Remove ${label}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        b.attached.splice(index, 1);
        paintAttachments(b);
        input.focus();
      });
      item.append(picture, el("span", "num", String(index + 1)), remove);
      return item;
    }));
    attachStrip.hidden = !b.attached.length;
  }

  const readImage = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const src = String(reader.result);
      resolve({ data: src.slice(src.indexOf(",") + 1), mimeType: file.type, src });
    };
    reader.readAsDataURL(file);
  });

  async function attachFiles(files) {
    const b = current;
    if (!b) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setStatus(b, `${file.name || "File"} is not an image and was skipped.`, "error");
      } else if (file.size > MAX_IMAGE_BYTES) {
        setStatus(b, `${file.name || "Image"} is larger than ${MAX_IMAGE_BYTES / 1048576} MB and was skipped.`, "error");
      } else {
        try {
          b.attached.push(await readImage(file));
        } catch (err) {
          setStatus(b, `Could not read ${file.name || "image"}: ${message(err)}`, "error");
        }
      }
    }
    paintAttachments(b);
    input.focus();
  }

  attachButton.addEventListener("click", async () => {
    const b = current;
    if (!b) return;
    let paths = null;
    try {
      paths = await browseFolder(b.data.implementProject || null, { images: true });
    } catch (err) {
      setStatus(b, message(err), "error");
    }
    if (!paths?.length) return;
    const files = [];
    for (const path of paths) {
      try {
        const name = path.split(/[\\/]/).pop();
        const ext = name.split(".").pop().toLowerCase();
        const buf = await invoke("read_image", { path });
        files.push(new File([buf], name, { type: "image/" + (ext === "jpg" ? "jpeg" : ext) }));
      } catch (err) {
        setStatus(b, `Could not read ${path}: ${message(err)}`, "error");
      }
    }
    if (files.length) await attachFiles(files);
  });
  input.addEventListener("paste", event => {
    const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
    if (!files.length) return;
    // Text copied alongside (e.g. from a web page) still pastes; a bare bitmap must not paste nothing silently.
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void attachFiles(files);
  });
  const dock = panel.querySelector(".design-dock");
  const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes("Files");
  dock.addEventListener("dragover", event => { if (hasFiles(event)) event.preventDefault(); });
  dock.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    void attachFiles([...event.dataTransfer.files]);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (implPop) {
      if (implPop.browsing) return;
      event.stopPropagation();
      closeImplementPop(true);
    } else if (exportMenu) {
      event.stopPropagation();
      const { opener } = exportMenu;
      closeExportMenu();
      opener.focus();
    } else if (preview) {
      event.stopPropagation();
      closePreview();
    } else if (designMode && current?.pop) closePop(current);
    else if (designMode && sysBoard) {
      event.stopPropagation();
      closeSystem();
    } else if (designMode && current?.pinning && panel.contains(document.activeElement)) setPinning(current, null);
  }, true);

  // ---- prompt rendering ------------------------------------------------------------------------

  async function loadTemplate(file) {
    const cached = templates.get(file);
    if (cached) return cached;
    const response = await fetch(file);
    if (!response.ok) throw new Error(`Could not load ${file} (${response.status})`);
    const text = await response.text();
    templates.set(file, text);
    return text;
  }

  const oneLine = (text, max) => String(text).replace(/\s+/g, " ").trim().slice(0, max);

  function renderPrompt(tpl, vars) {
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
  }

  function titleOf(b, id) {
    const rec = b.cards.get(id);
    return rec?.title.textContent || id;
  }

  function notesBlock(b, sent) {
    if (!sent.length) return "(no pinned notes)";
    const lines = [];
    for (const id of [...new Set(sent.map(item => item.designId))]) {
      lines.push(`Design \`${id}\` ("${titleOf(b, id)}"):`);
      sent.filter(item => item.designId === id).forEach((item, index) => {
        const note = item.note;
        const where = `(${Math.round(note.x * 100)}%, ${Math.round(note.y * 100)}%)`;
        const element = note.selector ? ` element \`${note.selector}\`${note.snippet ? `, text "${note.snippet}"` : ""}:` : "";
        const tag = note.source === "critique" ? ` [critique, ${severityOf(note)} severity]` : "";
        lines.push(`${index + 1}. ${where}${tag}${element} ${note.text.trim()}`);
      });
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  // ---- agent -----------------------------------------------------------------------------------

  const isBusy = b => b.run.busy || b.run.finishing || b.run.preparing;
  const severityOf = note => (["high", "medium", "low"].includes(note.severity) ? note.severity : "medium");

  async function send({ notesOnly = false } = {}) {
    const b = current;
    if (!b || isBusy(b)) return;
    const text = input.value.trim();
    const targets = notesOnly ? designsWithPending(b) : targetsOf(b);
    const sent = targets.flatMap(id => pendingFor(b, id).map(note => ({ designId: id, note })));
    const images = b.attached.slice();
    if (!text && !sent.length && !images.length) {
      setStatus(b, "Write a prompt, attach an image, or pin notes on a design first.", "error");
      input.focus();
      return;
    }
    if (!b.data.implementProject) {
      setStatus(b, "Choose a project first: the designs are made for it.", "error");
      projectSelect.focus();
      return;
    }
    setPreparing(b, true);
    try {
      const mode = targets.length ? "edit" : "new";
      const count = mode === "new" ? clamp(Number(variantsSelect.value) || 1, 1, 4) : 0;
      const turn = await prepareTurn(b, targets, "design-prompt.md", count);
      if (!turn) return;
      const base = "d" + Date.now().toString(36);
      const newIds = Array.from({ length: count }, (_, index) => `${base}-${index + 1}`);
      const prompt = text || (sent.length ? "Apply the pinned notes." : "Design from the attached images.");
      try {
        await boardDir(b);
        await persist(b, prompt);
      } catch (err) {
        setStatus(b, "Could not create the board: " + message(err), "error");
        return;
      }
      const designSystem = await designSystemFlag(b);
      const body = renderPrompt(turn.template, {
        boardDir: b.dir,
        mode,
        targets: targets.length
          ? targets.map(id => {
            const used = Array.isArray(b.data.usedSkills[id]) ? b.data.usedSkills[id] : [];
            return `- \`${id}\` ("${titleOf(b, id)}"), file \`designs/${id}/index.html\`${used.length ? `, skills used before: ${used.join(", ")}` : ""}`;
          }).join("\n")
          : "(none: this request creates new designs)",
        newIds: newIds.length ? newIds.map(id => `- \`${id}\` (folder \`designs/${id}/\`)`).join("\n") : "(none: this request edits existing designs)",
        ...skillVars(turn),
        designSystem,
        project: b.data.implementProject,
        imageCount: String(images.length),
        userPrompt: prompt,
        notes: notesBlock(b, sent),
      });
      await startRun(b, {
        kind: "design",
        body,
        forced: turn.forced,
        multiSkill: turn.multiSkill,
        targets,
        newIds,
        sent: sent.map(item => ({ designId: item.designId, noteId: item.note.id })),
        images,
        restore: text,
      });
    } finally {
      setPreparing(b, false);
    }
  }

  /** Skill choice and template shared by every turn kind. Reports its own problems and returns null. */
  async function prepareTurn(b, targetIds, file, count = 1) {
    if (!skills.length) await refreshSkills();
    if (!skills.length) {
      setStatus(b, "No active design skills. Add or activate one in Settings → Design.", "error");
      return null;
    }
    const multiSkill = switchOn && count > 1;
    const excluded = switchOn ? excludedFor(b, targetIds, count) : [];
    const candidates = skills.filter(skill => !excluded.includes(skill.name));
    if (!candidates.length || (multiSkill && skills.length < 2)) {
      setStatus(b, "No other active skill to switch to. Activate more skills in Settings → Design.", "error");
      return null;
    }
    let forced = skillSelect.value;
    if (forced && !candidates.some(skill => skill.name === forced)) forced = "";
    let tpl;
    try {
      tpl = await loadTemplate(file);
    } catch (err) {
      setStatus(b, message(err), "error");
      return null;
    }
    return { forced, excluded, multiSkill, template: tpl };
  }

  const skillVars = turn => ({
    activeSkills: skills.map(skill => `- \`${skill.name}\`: ${oneLine(skill.description, 300) || "(no description)"}`).join("\n"),
    skillMode: turn.multiSkill ? "per-variant" : "single",
    forcedSkill: turn.forced ? `\`${turn.forced}\`` : "(none: you choose)",
    excludedSkills: turn.excluded.length ? turn.excluded.map(name => `\`${name}\``).join(", ") : "(none)",
  });

  async function boardDir(b) {
    b.dir ??= await invoke("design_board_open", { boardId: b.id });
    return b.dir;
  }

  /** "present" when the board has a non-empty DESIGN.md right now, else "absent" (the prompt templates carry the wording). */
  async function designSystemFlag(b) {
    if (!b.persisted) return "absent";
    try {
      const text = await invoke("design_doc_read", { boardId: b.id });
      b.doc.has = typeof text === "string" && text.trim().length > 0;
      paintDocBadge();
    } catch { /* keep the last known state */ }
    return b.doc.has ? "present" : "absent";
  }

  /** Start one agent turn of any kind (design, critique, system); `finish` reconciles it by `run.kind`. */
  async function startRun(b, spec) {
    const run = b.run;
    run.kind = spec.kind;
    run.busy = true;
    run.finishing = false;
    run.aborting = false;
    run.targets = spec.targets ?? [];
    run.newIds = spec.newIds ?? [];
    run.sent = spec.sent ?? [];
    run.focusId = spec.focusId ?? "";
    run.multiSkill = !!spec.multiSkill;
    run.forced = run.multiSkill ? "" : spec.forced;
    run.skillSeen = spec.forced;
    run.skillsSeen = spec.forced ? [spec.forced] : [];
    run.summary = "";
    run.error = "";
    for (const id of run.newIds) addCard(b, id);
    saveBoard(b);
    if (!b.userView) fit(b);
    input.value = "";
    autosize();
    if (spec.images?.length) {
      b.attached = [];
      paintAttachments(b);
    }
    switchOn = false;
    const head = spec.kind === "critique" ? `Critiquing ${spec.title}` : spec.kind === "system" ? "Generating the design system" : "Starting";
    if (!b.data.model) await refreshDesigner();
    const skillLabel = run.multiSkill ? " with different skills" : spec.forced ? ` with skill ${spec.forced}` : "";
    setStatus(b, `${head}${skillLabel} on ${modelLabel(boardModel(b))}…`, "busy");
    paintAll();
    renderLists();
    try {
      await ensureAgent(b);
      if (!run.busy) return;
      run.reqId = `design-${++run.seq}`;
      const images = spec.images?.length ? { images: spec.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {};
      await rpcSend(b, { id: run.reqId, type: "prompt", message: (run.forced ? `/skill:${run.forced} ` : "") + spec.body, ...images });
    } catch (err) {
      if (!input.value) input.value = spec.restore;
      if (spec.images?.length && !b.attached.length) {
        b.attached = spec.images;
        paintAttachments(b);
      }
      autosize();
      await finish(b, { error: "Could not reach the design agent: " + message(err) + stderrTail(b) });
    }
  }

  const rpcSend = (b, payload) => invoke("rpc_send", { id: agentId(b), line: JSON.stringify(payload) });

  /** Forget the running agent process; the next send starts a fresh one. */
  function dropAgent(b) {
    const run = b.run;
    const proc = run.proc;
    run.proc = null;
    run.alive = false;
    if (!proc) return;
    run.stopping = proc.catch(() => {}).then(() => window.KostompRpcLifecycle.stop(agentId(b)).catch(() => {}));
  }

  /** Make the agent process match the board's model once nothing is running on it. */
  function applyModel(b) {
    const run = b.run;
    if (isBusy(b) || !run.proc || run.agentModel === boardModel(b)) return;
    dropAgent(b);
  }

  async function ensureAgent(b) {
    const run = b.run;
    if (!b.data.model) await refreshDesigner(); // a change under Settings → Agents applies to the next start
    const model = boardModel(b);
    if (run.proc && run.agentModel === model) return run.proc;
    if (run.proc) dropAgent(b);
    run.alive = false;
    run.stderr = [];
    run.agentModel = model;
    run.proc = (async () => {
      await run.stopping;
      await boardDir(b);
      const ready = new Promise(resolve => { run.openReady = resolve; });
      await window.KostompRpcLifecycle.start({ id: agentId(b), cwd: b.dir, resume: true, model: model || null, agentPrompt: "designer" });
      // omp announces `ready` when it accepts commands; a missing frame must not wedge the board.
      await Promise.race([ready, sleep(45000)]);
      // Only these session events reach `onFrame`; streamed `message_update`s would resend the whole partial reply each time.
      // An omp without the filter rejects it and keeps sending everything.
      await rpcSend(b, { id: "evfilter", type: "set_event_filter", events: ["message_end", "tool_execution_start", "tool_execution_end"] }).catch(() => {});
    })().catch(err => {
      run.proc = null;
      throw err;
    });
    return run.proc;
  }

  /** Critique one design: the agent writes critique.json, `finishCritique` turns it into pins. */
  async function critique(b, rec) {
    if (!rec.hasHtml || isBusy(b)) return;
    const text = input.value.trim();
    setPreparing(b, true);
    try {
      const turn = await prepareTurn(b, [rec.id], "design-critique-prompt.md");
      if (!turn) return;
      await boardDir(b);
      const designSystem = await designSystemFlag(b);
      // A leftover critique.json from an interrupted run must not be mistaken for this run's result.
      await invoke("design_critique_clear", { boardId: b.id, designId: rec.id }).catch(() => {});
      const body = renderPrompt(turn.template, {
        boardDir: b.dir,
        designId: rec.id,
        designTitle: titleOf(b, rec.id),
        designSystem,
        ...skillVars(turn),
        userPrompt: text || "(none: review the design as a whole)",
      });
      await startRun(b, { kind: "critique", body, forced: turn.forced, focusId: rec.id, restore: text, title: `"${titleOf(b, rec.id)}"` });
    } catch (err) {
      setStatus(b, "Could not start the critique: " + message(err), "error");
    } finally {
      setPreparing(b, false);
    }
  }

  /** Designs a "Generate from designs" run reads: the selected ones with HTML, else every one. */
  function generationIds(b) {
    const withHtml = [...b.cards.values()].filter(rec => rec.hasHtml).map(rec => rec.id);
    const chosen = withHtml.filter(id => b.selected.has(id));
    return chosen.length ? chosen : withHtml;
  }

  /** Ask the agent to extract DESIGN.md from the board's designs. */
  async function generateSystem(b) {
    if (!b || isBusy(b)) return;
    const ids = generationIds(b);
    if (!ids.length) {
      setSysNote("Add a design first.", "error");
      return;
    }
    const text = input.value.trim();
    setPreparing(b, true);
    try {
      // The agent starts from what is on disk, so unsaved edits are saved first.
      if (docDirty(b) && !(await saveDoc(b))) return;
      const turn = await prepareTurn(b, ids, "design-system-prompt.md");
      if (!turn) return;
      await boardDir(b);
      const body = renderPrompt(turn.template, {
        boardDir: b.dir,
        designIds: ids.map(id => `- \`${id}\` ("${titleOf(b, id)}"), file \`designs/${id}/index.html\``).join("\n"),
        userPrompt: text || "(none: describe the system the designs share)",
        ...skillVars(turn),
      });
      setSysNote(`Generating from ${ids.length === 1 ? "1 design" : `${ids.length} designs`}… progress shows under the canvas.`, "busy");
      await startRun(b, { kind: "system", body, forced: turn.forced, restore: text });
    } catch (err) {
      setStatus(b, "Could not start the design system run: " + message(err), "error");
    } finally {
      setPreparing(b, false);
    }
  }

  function stop(b) {
    const run = b.run;
    if (!run.busy) return;
    run.aborting = true;
    setStatus(b, "Stopping…", "busy");
    void rpcSend(b, { type: "abort" }).catch(() => {});
    clearTimeout(run.stopTimer);
    run.stopTimer = setTimeout(() => {
      if (!run.busy) return;
      run.proc = null;
      run.alive = false;
      void window.KostompRpcLifecycle.stop(agentId(b)).catch(() => {});
      void finish(b, { note: "Stopped" });
    }, STOP_GRACE_MS);
    paintDock();
  }

  function stderrTail(b) {
    const lines = b.run.stderr.filter(line => line.trim()).slice(-2);
    return lines.length ? "\n" + lines.join("\n") : "";
  }

  function lastSkillOf(b, id) {
    const rec = b.cards.get(id);
    if (typeof rec?.meta?.skill === "string" && rec.meta.skill.trim()) return rec.meta.skill.trim();
    const used = b.data.usedSkills[id];
    return Array.isArray(used) ? used[used.length - 1] ?? "" : "";
  }

  /** The turn is over (or never started): reconcile by run kind (cards and skills, critique pins, DESIGN.md), clear busy. */
  async function finish(b, { error = "", note = "" } = {}) {
    const run = b.run;
    if (!run.busy || run.finishing) return;
    run.finishing = true;
    clearTimeout(run.stopTimer);
    clearTimeout(b.refreshTimer);
    const { kind, focusId, sent, forced, summary } = run;
    const seen = run.skillSeen;
    const seenList = run.skillsSeen;
    const ids = [...run.targets, ...run.newIds];
    run.busy = false;
    run.aborting = false;
    run.targets = [];
    run.newIds = [];
    run.sent = [];
    run.focusId = "";
    paintDock();
    await refreshCards(b);
    let result = null;
    if (kind === "design") {
      for (const id of ids) {
        const rec = b.cards.get(id);
        if (!rec?.hasHtml) continue;
        const skill = (typeof rec.meta?.skill === "string" && rec.meta.skill.trim()) || forced || "";
        if (!skill) continue;
        const used = Array.isArray(b.data.usedSkills[id]) ? b.data.usedSkills[id] : [];
        if (!used.includes(skill)) used.push(skill);
        b.data.usedSkills[id] = used;
      }
      if (!error && !note) {
        for (const item of sent) {
          const found = notesOf(b, item.designId).find(candidate => candidate.id === item.noteId);
          if (found) found.done = true;
        }
      }
      const made = ids.filter(id => b.cards.get(id)?.hasHtml);
      const usedSkills = [...new Set(made.map(id => lastSkillOf(b, id)).filter(Boolean))];
      const skill = (usedSkills.length ? usedSkills : seenList).join(", ") || seen;
      const first = firstLine(summary);
      const head = made.length ? `Done${skill ? ` with ${skill}` : ""}` : "Finished without producing a design";
      result = { text: first ? `${head} · ${first}` : head, kind: made.length ? "ok" : "error", title: summary };
    } else if (kind === "critique") {
      result = await finishCritique(b, focusId, { failed: !!(error || note), forced, seen, summary });
    } else {
      result = await finishSystem(b, { failed: !!(error || note), summary });
    }
    run.finishing = false;
    applyModel(b);
    paintCards(b);
    for (const rec of b.cards.values()) renderPins(b, rec);
    if (error) setStatus(b, error, "error");
    else if (note) setStatus(b, note);
    else if (result) setStatus(b, result.text, result.kind, result.title);
    await saveBoard(b, true);
    if (b === current) paintAll();
    renderLists();
  }

  const firstLine = text => oneLine(String(text).split(/\r?\n/).find(line => line.trim()) ?? "", 140);

  /** Turn the critique.json the agent wrote into pending notes on the design, then delete the file. */
  async function finishCritique(b, id, { failed, forced, seen, summary }) {
    const rec = b.cards.get(id);
    if (!rec) return null;
    const data = rec.critique;
    let result = null;
    if (!failed) {
      if (data) {
        const count = await importCritique(b, rec, data);
        const skill = (typeof data.skill === "string" && data.skill.trim()) || forced || seen;
        const verdict = typeof data.summary === "string" ? data.summary.trim() : "";
        const found = count === 0 ? "No findings" : count === 1 ? "1 finding pinned" : `${count} findings pinned`;
        const first = firstLine(verdict);
        result = { text: `Critique${skill ? ` with ${skill}` : ""} · ${found}${first ? ` · ${first}` : ""}`, kind: "ok", title: verdict };
      } else {
        result = { text: "The agent finished without writing a critique.", kind: "error", title: summary };
      }
    }
    rec.critique = null;
    rec.critiqueModified = 0;
    await invoke("design_critique_clear", { boardId: b.id, designId: id }).catch(() => {});
    return result;
  }

  const SEVERITIES = ["high", "medium", "low"];

  /** Pin every finding on its element (found by the injected `kd-locate` probe); unlocatable ones stack along the top-left. */
  async function importCritique(b, rec, data) {
    const findings = (Array.isArray(data.findings) ? data.findings : []).slice(0, 8)
      .map(item => ({
        selector: typeof item?.selector === "string" ? item.selector.trim().slice(0, 500) : "",
        severity: SEVERITIES.includes(item?.severity) ? item.severity : "medium",
        text: typeof item?.text === "string" ? item.text.trim() : "",
      }))
      .filter(item => item.text);
    const spots = await Promise.all(findings.map(item => (item.selector ? locate(rec, item.selector) : Promise.resolve(null))));
    if (b.pop?.rec === rec) closePop(b);
    // A new critique replaces the pins of the previous one that were not sent yet.
    const list = notesOf(b, rec.id).filter(note => !(note.source === "critique" && !note.done));
    let stacked = 0;
    findings.forEach((item, index) => {
      let spot = spots[index];
      if (!spot) spot = { x: 0.04, y: clamp(0.08 + stacked++ * 0.07, 0.04, 0.96) };
      const note = { id: randomId("n"), x: spot.x, y: spot.y, text: item.text, done: false, source: "critique", severity: item.severity };
      if (item.selector) note.selector = item.selector;
      list.push(note);
    });
    if (list.length) b.data.notes[rec.id] = list;
    else delete b.data.notes[rec.id];
    return findings.length;
  }

  /** A design-system run ended: show what is on disk now. */
  async function finishSystem(b, { failed, summary }) {
    await reloadDoc(b, true);
    if (b.doc.has) setSysNote("DESIGN.md updated from your designs.", "ok");
    if (failed) return null;
    if (!b.doc.has) return { text: "Finished without writing DESIGN.md", kind: "error", title: summary };
    const first = firstLine(summary);
    return { text: first ? `Design system written · ${first}` : "Design system written", kind: "ok", title: summary };
  }

  function scheduleRefresh(b) {
    clearTimeout(b.refreshTimer);
    b.refreshTimer = setTimeout(() => void refreshCards(b), 400);
  }

  function refreshCards(b) {
    if (!b.persisted) return Promise.resolve();
    if (b.refreshing) {
      b.refreshAgain = true;
      return b.refreshing;
    }
    b.refreshing = (async () => {
      try {
        do {
          b.refreshAgain = false;
          await syncCards(b);
        } while (b.refreshAgain);
      } finally {
        b.refreshing = null;
      }
    })();
    return b.refreshing;
  }

  async function syncCards(b) {
    let list;
    try {
      list = await invoke("design_cards", { boardId: b.id });
    } catch (err) {
      setStatus(b, "Could not read the designs: " + message(err), "error");
      return;
    }
    if (!Array.isArray(list)) return;
    let changed = false;
    const seen = new Set();
    for (const info of list) {
      if (!info || typeof info.id !== "string") continue;
      seen.add(info.id);
      let rec = b.cards.get(info.id);
      if (!rec) {
        rec = addCard(b, info.id);
        changed = true;
      }
      rec.meta = info.meta && typeof info.meta === "object" ? info.meta : null;
      rec.critique = info.critique && typeof info.critique === "object" ? info.critique : null;
      rec.critiqueModified = Number(info.critiqueModified) || 0;
      const had = rec.hasHtml;
      rec.hasHtml = !!info.hasHtml;
      if (rec.hasHtml && rec.modified !== info.modified) {
        try {
          const html = await invoke("design_html", { boardId: b.id, designId: info.id });
          rec.modified = info.modified;
          setFrame(rec, html);
        } catch (err) {
          setStatus(b, `Could not load design ${info.id}: ${message(err)}`, "error");
        }
      }
      if (had !== rec.hasHtml) changed = true;
      paintCard(b, rec);
    }
    const expected = new Set(b.run.newIds);
    for (const id of [...b.cards.keys()]) {
      if (seen.has(id) || expected.has(id)) continue;
      removeCard(b, id);
      changed = true;
    }
    if (!b.synced) {
      // First listing: forget geometry, notes and skills of designs that no longer exist on disk.
      b.synced = true;
      for (const key of ["cards", "notes", "usedSkills"]) {
        for (const id of Object.keys(b.data[key])) {
          if (!seen.has(id) && !expected.has(id)) delete b.data[key][id];
        }
      }
    }
    if (changed) {
      saveBoard(b);
      afterCardsChanged(b);
    } else if (b === current) {
      paintDock();
      empty.hidden = b.cards.size > 0;
    }
  }

  function onProgress(b, frame) {
    const run = b.run;
    if (!run.busy) return;
    const blob = JSON.stringify(frame.args ?? {}).replace(/\\+/g, "/");
    const skill = /skill:\/\/([A-Za-z0-9._-]+)/.exec(blob);
    if (skill) {
      run.skillSeen = skill[1];
      if (!run.skillsSeen.includes(skill[1])) run.skillsSeen.push(skill[1]);
    }
    const prefix = run.skillSeen ? `${run.skillSeen} · ` : "";
    let action;
    const writing = /write|edit/i.test(String(frame.toolName));
    if (skill) action = `Reading skill ${skill[1]}…`;
    else if (writing && /critique\.json/.test(blob)) action = "Writing the critique…";
    else if (writing && /DESIGN\.md/.test(blob)) action = "Writing DESIGN.md…";
    else {
      const path = /designs\/([A-Za-z0-9_-]+)\//.exec(blob);
      action = path && writing ? `Writing ${path[1]}…` : `${frame.toolName || "Working"}…`;
    }
    setStatus(b, prefix + action, "busy");
  }

  function assistantText(msg) {
    if (!msg || msg.role !== "assistant") return "";
    if (typeof msg.content === "string") return msg.content;
    if (!Array.isArray(msg.content)) return "";
    return msg.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
  }

  function onUiRequest(b, req) {
    switch (req.method) {
      case "confirm":
      case "select":
      case "input":
      case "editor":
      case "ask":
        // Designs run unattended: refuse so the agent carries on instead of waiting forever.
        void rpcSend(b, { type: "extension_ui_response", id: req.id, cancelled: true }).catch(() => {});
        setStatus(b, `The agent asked "${oneLine(req.title || req.message || "a question", 120)}" and was told to continue without an answer.`, "error");
        break;
      case "notify":
        if (req.notifyType === "error") setStatus(b, oneLine(req.message ?? "The agent reported an error.", 200), "error");
        break;
      default:
        break;
    }
  }

  function onFrame(b, frame) {
    const run = b.run;
    switch (frame.type) {
      case "ready":
        run.alive = true;
        run.openReady?.();
        break;
      case "response":
        if (frame.success === false && frame.id && frame.id === run.reqId) void finish(b, { error: String(frame.error || "The agent rejected the prompt") + stderrTail(b) });
        break;
      case "tool_execution_start":
        onProgress(b, frame);
        break;
      case "tool_execution_end":
        if (run.busy) scheduleRefresh(b);
        break;
      case "message_end": {
        const text = assistantText(frame.message).trim();
        if (text && run.busy) run.summary = text;
        break;
      }
      case "prompt_result":
        if (frame.status === "error") run.error = String(frame.error?.message ?? "The agent failed");
        if (frame.status !== "completed" || frame.sessionSettled) {
          if (run.error) void finish(b, { error: run.error + stderrTail(b) });
          else if (frame.status !== "completed") void finish(b, { note: "Stopped" });
          else void finish(b);
        }
        break;
      case "session_settled":
        if (run.error) void finish(b, { error: run.error + stderrTail(b) });
        else void finish(b);
        break;
      case "extension_ui_request":
        onUiRequest(b, frame);
        break;
      case "extension_error":
        if (run.busy) setStatus(b, oneLine(`${frame.event ?? "extension"}: ${frame.error ?? "error"}`, 200), "error");
        break;
      default:
        break;
    }
  }

  const boardOf = id => (typeof id === "string" && id.startsWith("design-") ? boards.get(id.slice(7)) : undefined);
  void listen("rpc-frames", event => {
    const [id, lines] = event.payload;
    const b = boardOf(id);
    if (!b) return;
    for (const line of lines) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame && typeof frame === "object") onFrame(b, frame);
    }
  });
  void listen("rpc-stderr", event => {
    const [id, line] = Array.isArray(event.payload) ? event.payload : [];
    const b = boardOf(id);
    if (!b || typeof line !== "string") return;
    b.run.stderr.push(stripAnsi(line));
    if (b.run.stderr.length > 30) b.run.stderr.splice(0, b.run.stderr.length - 30);
  });
  void listen("rpc-exit", event => {
    const b = boardOf(event.payload);
    if (!b) return;
    b.run.proc = null;
    b.run.alive = false;
    if (b.run.busy) void finish(b, { error: "The design agent exited unexpectedly." + stderrTail(b) });
  });

  // ---- per-board model -------------------------------------------------------------------------

  /** The model a board's agent should run on: its own choice, else the designer agent's, else "" (omp default). */
  function boardModel(b) {
    return b.data.model || designerModel;
  }

  function modelLabel(value) {
    if (!value) return "omp default model";
    return models.find(item => item.value === value)?.label ?? models.find(item => item.value === value.replace(/:[^/:]+$/, ""))?.label.concat(value.slice(value.lastIndexOf(":"))) ?? value;
  }

  function paintModel() {
    const b = current;
    if (!b) return;
    const wanted = b.data.model || "";
    const list = !wanted || models.some(item => item.value === wanted)
      ? models
      : [...models, { value: wanted, label: wanted, title: "Saved for this board; not in the current model list" }];
    const defaultLabel = designerKnown
      ? `Designer agent (${designerModel ? modelLabel(designerModel) : "omp default"})`
      : "omp default model";
    const sig = `${defaultLabel}\u0002` + list.map(item => `${item.value}\u0000${item.label}`).join("\u0001");
    if (sig !== modelSig) {
      modelSig = sig;
      const options = [new Option(defaultLabel, "")];
      for (const item of list) {
        const option = new Option(item.label, item.value);
        option.title = item.title;
        options.push(option);
      }
      modelSelect.replaceChildren(...options);
    }
    modelSelect.value = wanted;
    modelSelect.parentElement.title = modelsError
      ? `Could not load the model list (${modelsError}). Only the default and this board's saved choice are available.`
      : designerKnown
        ? "Model for this board's design agent. Unless you pick one here, it follows the designer agent, set in Settings → Agents → designer."
        : "Model for this board's design agent. The omp default is used when unset.";
    modelSelect.parentElement.classList.toggle("is-error", !!modelsError);
    applyModel(b);
  }

  /** Resolve the designer agent's model (Settings → Agents); any failure falls back to the omp default. */
  async function refreshDesigner() {
    let value = "";
    let known = false;
    try {
      if (!window.kostompRpc) throw new Error("the chat runtime is not loaded");
      const data = await window.kostompRpc.request("get_agent_models", undefined, 30000);
      const entry = (Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : [])
        .find(item => item && item.name === "designer");
      if (entry) {
        known = true;
        value = [entry.overrideModel, entry.effectiveModel].find(v => typeof v === "string" && v.trim())?.trim() ?? "";
      }
    } catch { /* older runtime or RPC failure: keep the omp default */ }
    designerModel = value;
    designerKnown = known;
    return value;
  }

  function refreshModels() {
    if (modelsLoading) return modelsLoading;
    modelsLoading = (async () => {
      try {
        if (!window.kostompRpc) throw new Error("the chat runtime is not loaded");
        const [data] = await Promise.all([window.kostompRpc.request("get_available_models", undefined, 30000), refreshDesigner()]);
        models = (Array.isArray(data?.models) ? data.models : [])
          .filter(item => item && typeof item.provider === "string" && typeof item.id === "string")
          .map(item => ({
            value: `${item.provider}/${item.id}`,
            label: `${typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id} (${item.provider})`,
            title: `${item.provider}/${item.id}`,
          }));
        modelsError = "";
      } catch (err) {
        modelsError = oneLine(message(err), 160);
      } finally {
        modelsLoading = null;
      }
      paintModel();
    })();
    return modelsLoading;
  }

  modelSelect.addEventListener("change", () => {
    const b = current;
    if (!b) return;
    b.data.model = modelSelect.value;
    saveBoard(b);
    if (isBusy(b)) return; // the running agent keeps its model; the next run after this one uses the new choice
    const wanted = boardModel(b);
    const restart = !!b.run.proc && b.run.agentModel !== wanted;
    applyModel(b);
    if (restart) setStatus(b, `Model: ${modelLabel(wanted)}. The agent restarts with it on the next send.`);
  });

  // ---- export ----------------------------------------------------------------------------------

  function closeExportMenu() {
    if (!exportMenu) return;
    const { node, opener } = exportMenu;
    exportMenu = null;
    node.remove();
    opener.setAttribute("aria-expanded", "false");
  }

  function toggleExportMenu(button, b, rec) {
    if (exportMenu?.opener === button) {
      closeExportMenu();
      return;
    }
    closeExportMenu();
    if (!rec.hasHtml) return;
    const node = el("div", "design-export-menu glass");
    node.setAttribute("role", "menu");
    const items = [
      ["Open in browser", "browser", "Open the design in your default browser"],
      ["Copy HTML", "copy", "Copy the design's HTML to the clipboard"],
      ["Save to folder…", "save", "Copy the design's files into a folder you choose"],
    ];
    for (const [label, kind, hint] of items) {
      const item = el("button", "design-export-item", label);
      item.type = "button";
      item.title = hint;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", () => {
        closeExportMenu();
        void exportDesign(b, rec, kind);
      });
      node.append(item);
    }
    node.addEventListener("keydown", event => {
      if (event.key === "Tab") {
        closeExportMenu();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const all = [...node.children];
      const at = all.indexOf(document.activeElement);
      all[(at + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length].focus();
    });
    document.body.append(node);
    const rect = button.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    node.style.left = `${clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8))}px`;
    const below = rect.bottom + 4;
    node.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, rect.top - 4 - height) : below}px`;
    button.setAttribute("aria-expanded", "true");
    exportMenu = { node, opener: button };
    node.firstElementChild.focus();
  }

  async function exportDesign(b, rec, kind) {
    const report = (text, level, title = "") => {
      setStatus(b, text, level, title);
      if (preview) preview.note.textContent = text;
    };
    try {
      if (kind === "browser") {
        await invoke("design_open_external", { boardId: b.id, designId: rec.id });
        report("Opened the design in your browser.", "ok");
      } else if (kind === "copy") {
        await navigator.clipboard.writeText(rec.html);
        report(`Copied the HTML (${Math.max(1, Math.round(rec.html.length / 1024))} KB).`, "ok");
      } else {
        const dest = await invoke("pick_folder", { start: null });
        if (!dest) return;
        const path = await invoke("design_export", { boardId: b.id, designId: rec.id, dest });
        report(`Exported to ${path}`, "ok", String(path));
      }
    } catch (err) {
      report("Export failed: " + message(err), "error");
    }
  }

  document.addEventListener("pointerdown", event => {
    if (!exportMenu || exportMenu.node.contains(event.target) || exportMenu.opener.contains(event.target)) return;
    closeExportMenu();
  }, true);
  window.addEventListener("wheel", event => {
    if (exportMenu && !exportMenu.node.contains(event.target)) closeExportMenu();
  }, { capture: true, passive: true });
  window.addEventListener("blur", closeExportMenu);

  // ---- implement in a real project -------------------------------------------------------------

  const samePath = (a, c) => {
    const key = p => String(p).replace(/[\\/]+$/, "").toLowerCase();
    return key(a) === key(c);
  };

  /** Primary "Implement" action plus a chevron for the project options. `scope()` returns `{ b, ids, fromDock }` or null. */
  function implementControl(compact, scope) {
    const node = el("span", "design-implement" + (compact ? " is-compact" : ""));
    const main = el("button", "design-implement-go glass-pill");
    main.type = "button";
    main.append(icon(["M8 7l-5 5 5 5M16 7l5 5-5 5"], 14), el("span", "dc-label", "Implement"));
    const more = el("button", "design-implement-more glass-pill");
    more.type = "button";
    more.append(icon(["M6 9l6 6 6-6"], 12));
    more.setAttribute("aria-haspopup", "dialog");
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-label", "Implementation options");
    more.title = "Choose the project and add instructions";
    main.addEventListener("click", () => {
      const s = scope();
      if (!s?.ids.length) return;
      if (s.b.data.implementProject) void runImplement(s, s.b.data.implementProject, s.fromDock ? input.value.trim() : "");
      else toggleImplementPop(s, more);
    });
    more.addEventListener("click", () => {
      const s = scope();
      if (s?.ids.length) toggleImplementPop(s, more);
    });
    node.append(main, more);
    return { node, main, more };
  }

  function paintImplement(ctl, b, ids) {
    const project = b.data.implementProject;
    const off = !ids.length || isBusy(b) || b.implementing;
    ctl.main.disabled = ctl.more.disabled = off;
    const what = ids.length > 1 ? `these ${ids.length} designs` : "this design";
    ctl.main.title = !ids.length ? "This design has no HTML yet"
      : isBusy(b) ? "Wait for the current run to finish"
      : project ? `Implement ${what} in ${folderName(project)} (opens a new chat)\n${project}`
      : `Implement ${what} in a project: choose the project first`;
  }

  function closeImplementPop(restoreFocus = false) {
    if (!implPop) return;
    const { node, opener } = implPop;
    implPop = null;
    node.remove();
    opener.setAttribute("aria-expanded", "false");
    if (restoreFocus && opener.isConnected) opener.focus();
  }

  function toggleImplementPop(scope, opener) {
    if (implPop?.opener === opener) {
      closeImplementPop(true);
      return;
    }
    openImplementPop(scope, opener);
  }

  function projectLabels(paths) {
    const names = paths.map(folderName);
    return paths.map((path, index) => {
      if (names.filter(name => name === names[index]).length < 2) return names[index];
      const parent = path.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean).slice(-2, -1)[0];
      return parent ? `${names[index]} (${parent})` : names[index];
    });
  }

  function openImplementPop(scope, opener) {
    closeImplementPop();
    closeExportMenu();
    const { b } = scope;
    const node = el("div", "design-implement-pop glass");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "Implement in a project");
    const count = scope.ids.length;
    const heading = el("strong", "design-implement-title", count === 1 ? `Implement “${titleOf(b, scope.ids[0])}”` : `Implement ${count} designs`);
    const hint = el("p", "design-implement-hint", "Opens a new chat in the project and asks the agent to build the design there.");
    const select = el("select", "glass-control");
    select.setAttribute("aria-label", "Project");
    const browse = el("button", "glass-control", "Browse…");
    browse.type = "button";
    const projectRow = el("div", "design-implement-row");
    projectRow.append(select, browse);
    const path = el("div", "design-implement-path");
    const textarea = el("textarea", "glass-control");
    textarea.rows = 3;
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", "Extra instructions");
    textarea.placeholder = "Extra instructions (optional): which page or component, constraints…";
    textarea.value = scope.fromDock ? input.value.trim() : "";
    const note = el("div", "design-implement-note");
    note.setAttribute("role", "status");
    const cancel = el("button", "glass-control", "Cancel");
    cancel.type = "button";
    const go = el("button", "design-primary glass-control", "Implement");
    go.type = "button";
    const actions = el("div", "design-implement-actions");
    actions.append(cancel, go);
    node.append(heading, hint, projectRow, path, textarea, note, actions);

    const fill = chosen => {
      const paths = [];
      for (const candidate of [chosen, b.data.implementProject, ...loadRecent()]) {
        if (candidate && !paths.some(known => samePath(known, candidate))) paths.push(candidate);
      }
      const labels = projectLabels(paths);
      const options = [new Option(paths.length ? "Choose a project…" : "No projects yet. Use Browse…", "")];
      paths.forEach((value, index) => {
        const option = new Option(labels[index], value);
        option.title = value;
        options.push(option);
      });
      select.replaceChildren(...options);
      select.value = paths.find(candidate => chosen && samePath(candidate, chosen)) ?? "";
      sync();
    };
    const sync = () => {
      path.textContent = select.value;
      path.title = select.value;
      path.hidden = !select.value;
      go.disabled = !select.value;
    };
    select.addEventListener("change", () => {
      note.textContent = "";
      sync();
    });
    fill(b.data.implementProject);

    const state = { node, opener, browsing: false };
    browse.addEventListener("click", async () => {
      state.browsing = true;
      node.hidden = true;
      let picked = null;
      try {
        picked = await browseFolder(select.value || null, { allowCreate: false });
      } catch (err) {
        note.textContent = message(err);
        note.dataset.kind = "error";
      }
      state.browsing = false;
      if (implPop !== state) return;
      node.hidden = false;
      if (picked) {
        note.textContent = "";
        fill(picked);
      }
      select.focus();
    });
    cancel.addEventListener("click", () => closeImplementPop(true));
    go.addEventListener("click", async () => {
      const project = select.value;
      if (!project) return;
      const extra = textarea.value.trim();
      closeImplementPop();
      if (b.data.implementProject !== project) {
        b.data.implementProject = project;
        await saveBoard(b, true);
        if (b === current) paintDock();
      }
      await runImplement(scope, project, extra);
    });
    textarea.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        go.click();
      }
    });
    for (const type of ["pointerdown", "click", "wheel"]) node.addEventListener(type, event => event.stopPropagation());

    document.body.append(node);
    const rect = opener.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    node.style.left = `${clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8))}px`;
    const below = rect.bottom + 6;
    node.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - height) : below}px`;
    opener.setAttribute("aria-expanded", "true");
    implPop = state;
    (select.value ? textarea : browse).focus();
  }

  /** Build the implementation prompt from the selected designs and open a new chat in `project` that submits it. */
  async function runImplement({ b, ids, fromDock }, project, extra) {
    if (b.implementing || isBusy(b)) return;
    const recs = ids.map(id => b.cards.get(id)).filter(rec => rec?.hasHtml);
    if (!recs.length) return;
    const where = folderName(project);
    b.implementing = true;
    paintCards(b);
    if (b === current) paintDock();
    const report = (text, kind, title = "") => {
      setStatus(b, text, kind, title);
      if (preview) preview.note.textContent = text;
    };
    report(`Opening chat in ${where}…`, "busy");
    try {
      const dir = await boardDir(b);
      const template = await loadTemplate("design-implement-prompt.md");
      const hasSystem = (await designSystemFlag(b)) === "present";
      const sep = dir.includes("\\") ? "\\" : "/";
      const at = (...parts) => [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
      const designs = recs.map(rec => {
        const skill = lastSkillOf(b, rec.id);
        return [
          `- ${rec.title.textContent || rec.id}${skill ? ` (skill: ${skill})` : ""}`,
          `  - index.html: ${at("designs", rec.id, "index.html")}`,
          `  - meta.json: ${at("designs", rec.id, "meta.json")}`,
        ].join("\n");
      }).join("\n");
      const prompt = renderPrompt(template, {
        designs,
        designSystemPath: hasSystem ? at("DESIGN.md") : "(none)",
        userPrompt: extra || "(none)",
      });
      const first = recs[0].title.textContent || recs[0].id;
      const name = oneLine(`Implement: ${first}${recs.length > 1 ? ` +${recs.length - 1} more` : ""}`, 80);
      await window.kostompStartChat({ cwd: project, prompt, name });
      if (fromDock && extra && input.value.trim() === extra) {
        input.value = "";
        autosize();
      }
      report(`Implementation started in ${where}.`, "ok", project);
      closePreview();
      setMode(false);
    } catch (err) {
      report("Could not start the implementation: " + message(err), "error");
    } finally {
      b.implementing = false;
      paintState(b);
      paintCards(b);
      if (b === current) paintDock();
    }
  }

  document.addEventListener("pointerdown", event => {
    if (!implPop || implPop.browsing || implPop.node.contains(event.target) || implPop.opener.contains(event.target)) return;
    closeImplementPop();
  }, true);
  window.addEventListener("wheel", event => {
    if (implPop && !implPop.browsing && !implPop.node.contains(event.target)) closeImplementPop();
  }, { capture: true, passive: true });

  const dockImplement = implementControl(false, () => {
    if (!current) return null;
    return { b: current, ids: targetsOf(current).filter(id => current.cards.get(id)?.hasHtml), fromDock: true };
  });
  implementSlot.append(dockImplement.node);

  // ---- design system (DESIGN.md) ---------------------------------------------------------------

  const docDirty = b => b.doc.draft !== b.doc.saved;

  function setSysNote(text, kind = "") {
    sysNote.textContent = text;
    if (kind) sysNote.dataset.kind = kind;
    else delete sysNote.dataset.kind;
  }

  /** The topbar button: a dot when the board has a DESIGN.md, an amber dot while the draft is unsaved. */
  function paintDocBadge() {
    const b = current;
    const dirty = !!b && docDirty(b);
    const has = !!b?.doc.has;
    sysDot.hidden = !has && !dirty;
    sysDot.classList.toggle("is-dirty", dirty);
    sysButton.classList.toggle("has-doc", has);
    sysButton.setAttribute("aria-expanded", String(!!b && sysBoard === b));
    sysButton.title = dirty ? "Design system: unsaved changes" : has ? "Design system: this board has a DESIGN.md" : "Design system: this board has no DESIGN.md yet";
  }

  function paintSystem() {
    const b = sysBoard;
    if (!b) return;
    if (sysText.value !== b.doc.draft) sysText.value = b.doc.draft;
    const writing = (b.run.busy || b.run.finishing) && b.run.kind === "system";
    const dirty = docDirty(b);
    const ids = generationIds(b);
    sysText.readOnly = writing;
    sysDirty.hidden = !dirty;
    sysSave.disabled = writing || !dirty;
    sysClear.disabled = writing || (!b.doc.has && !b.doc.draft.trim());
    sysLoad.disabled = writing;
    sysGenerate.disabled = isBusy(b) || !ids.length;
    sysGenerate.title = !ids.length ? "Add a design first"
      : isBusy(b) ? "Wait for the current run to finish"
      : `Let the agent extract a design system from ${ids.length === 1 ? "1 design" : `${ids.length} designs`} (the selected ones, else all)`;
  }

  /** Read DESIGN.md from disk; a dirty draft survives unless `force`. */
  async function reloadDoc(b, force = false) {
    if (!b.persisted) return;
    try {
      const text = await invoke("design_doc_read", { boardId: b.id });
      const value = typeof text === "string" ? text : "";
      const keep = !force && docDirty(b);
      b.doc.saved = value;
      if (!keep) b.doc.draft = value;
      b.doc.has = value.trim().length > 0;
    } catch (err) {
      if (sysBoard === b) setSysNote("Could not read DESIGN.md: " + message(err), "error");
    }
    paintDocBadge();
    paintSystem();
  }

  async function saveDoc(b) {
    if ((b.run.busy || b.run.finishing) && b.run.kind === "system") return false;
    const text = b.doc.draft.trim() ? b.doc.draft : "";
    try {
      // A draft board only becomes a board on disk once there is something to keep.
      if (b.persisted || text) {
        await persist(b, "Untitled board");
        await invoke("design_doc_write", { boardId: b.id, text });
      }
      b.doc.saved = text;
      b.doc.draft = text;
      b.doc.has = text.length > 0;
      if (sysBoard === b) setSysNote(text ? "Saved DESIGN.md." : "DESIGN.md removed.", "ok");
    } catch (err) {
      if (sysBoard === b) setSysNote("Could not save DESIGN.md: " + message(err), "error");
      return false;
    }
    paintDocBadge();
    paintSystem();
    return true;
  }

  function closeSystem() {
    if (!sysBoard) return;
    const hadFocus = sysPanel.contains(document.activeElement);
    sysBoard = null;
    sysPanel.hidden = true;
    paintDocBadge();
    if (hadFocus) sysButton.focus();
  }

  async function openSystem(b) {
    sysBoard = b;
    sysPanel.hidden = false;
    sysPanel.style.bottom = `${dockWrap.offsetHeight + 12}px`;
    setSysNote("");
    paintSystem();
    paintDocBadge();
    sysText.focus();
    await reloadDoc(b);
  }

  new ResizeObserver(() => { if (sysBoard) sysPanel.style.bottom = `${dockWrap.offsetHeight + 12}px`; }).observe(dockWrap);
  sysButton.addEventListener("click", () => {
    if (!current) return;
    if (sysBoard === current) closeSystem();
    else void openSystem(current);
  });
  sysClose.addEventListener("click", closeSystem);
  sysText.addEventListener("input", () => {
    if (!sysBoard) return;
    sysBoard.doc.draft = sysText.value;
    paintSystem();
    paintDocBadge();
  });
  sysLoad.addEventListener("click", () => sysFile.click());
  sysFile.addEventListener("change", async () => {
    const file = sysFile.files?.[0];
    sysFile.value = "";
    const b = sysBoard;
    if (!file || !b) return;
    if (file.size > DOC_MAX) {
      setSysNote(`${file.name} is larger than 1 MiB.`, "error");
      return;
    }
    try {
      b.doc.draft = await file.text();
      setSysNote(`Loaded ${file.name}. Review it, then Save.`);
    } catch (err) {
      setSysNote("Could not read the file: " + message(err), "error");
    }
    paintSystem();
    paintDocBadge();
  });
  sysGenerate.addEventListener("click", () => void generateSystem(sysBoard));
  sysSave.addEventListener("click", () => { if (sysBoard) void saveDoc(sysBoard); });
  sysClear.addEventListener("click", async () => {
    const b = sysBoard;
    if (!b) return;
    const confirmed = await window.kostompConfirmDelete("Clear the design system?", "This removes DESIGN.md from the board. Designs already made are not changed.");
    if (!confirmed || sysBoard !== b) return;
    b.doc.draft = "";
    await saveDoc(b);
  });

  void refreshKnown();
})();
