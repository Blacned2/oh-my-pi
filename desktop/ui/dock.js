// Floating panels inside a chat. Terminal, Changes, Browser and Files open as cards in the same stack as the
// activity deck (see `.stack` in app.css) instead of as separate panes. Every card, the deck included, resizes
// from its left edge, bottom edge or bottom-left corner; the size is kept per kind in localStorage and a
// double-click on a handle restores the default.
(() => {
  const SIZES_KEY = "kostomp-dock-sizes";
  const MIN_W = 240; // px
  const MIN_H = 140; // px
  const SVG_NS = "http://www.w3.org/2000/svg";

  const TOOLS = [
    { kind: "terminal", title: "Terminal", key: "Ctrl+`", icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
    {
      kind: "changes",
      title: "Değişiklikler",
      key: "Ctrl+Shift+G",
      icon: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V10a4 4 0 0 0-4-4H8.5"/>',
    },
    {
      kind: "browser",
      title: "Tarayıcı",
      key: "Ctrl+Shift+B",
      icon: '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    },
    {
      kind: "files",
      title: "Dosyalar",
      key: "Ctrl+Shift+E",
      icon: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/>',
    },
  ];

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const folderOf = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() || p : "");

  // ---- sizes: { [kind]: { w?, h? } }; an unset side keeps the CSS default (the deck's height follows its content) ----
  /** @type {Record<string, { w?: number, h?: number }>} */
  const sizes = (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(SIZES_KEY));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  })();
  const saveSizes = () => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {}
  };

  /** Paint the stored size of `kind` onto its card. */
  function applySize(card, kind) {
    const s = sizes[kind] ?? {};
    for (const [name, value] of [["--w", s.w], ["--h", s.h]]) {
      if (value > 0) card.style.setProperty(name, value + "px");
      else card.style.removeProperty(name);
    }
  }

  function beginResize(e, handle, kind, edge) {
    if (e.button !== 0) return;
    const card = handle.parentElement;
    const stack = card?.closest(".stack");
    if (!card || !stack) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const box = card.getBoundingClientRect();
    const maxW = stack.clientWidth;
    const maxH = stack.clientHeight - 40; // the button bar stays reachable
    const x0 = e.clientX;
    const y0 = e.clientY;
    document.body.classList.add("dock-resizing");
    const move = (ev) => {
      const next = { ...sizes[kind] };
      if (edge !== "h") next.w = Math.round(clamp(box.width - (ev.clientX - x0), MIN_W, maxW));
      if (edge !== "w") next.h = Math.round(clamp(box.height + (ev.clientY - y0), MIN_H, maxH));
      sizes[kind] = next;
      applySize(handle.parentElement, kind);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("dock-resizing");
      saveSizes();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Add the three resize handles to `card`; `kind` keys the stored size. */
  function attachResize(card, kind) {
    for (const edge of ["w", "h", "wh"]) {
      const handle = document.createElement("i");
      handle.className = "rz rz-" + edge;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (e) => beginResize(e, handle, kind, edge));
      handle.addEventListener("dblclick", () => {
        delete sizes[kind];
        saveSizes();
        applySize(handle.parentElement, kind);
      });
      card.append(handle);
    }
  }

  function icon(markup) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = markup;
    return svg;
  }

  /**
   * The tool buttons and cards of one chat. `ctx`: `sid` (unique per chat), `cwd()` the chat's folder and
   * `highlight(code, lang)` for syntax tokens. Cards are built on first open and then only hidden, so a
   * terminal keeps running while its card is closed; `dispose()` ends them.
   */
  function createToolDock(ctx) {
    const bar = document.createElement("div");
    bar.className = "stack-tools";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Workspace panels");
    const host = document.createElement("div");
    host.className = "stack-docks";
    const open = new Map(); // kind -> { card, api, cwd }
    const buttons = new Map();

    function build(tool) {
      const entry = { card: document.createElement("section"), api: null, cwd: ctx.cwd() };
      const { card } = entry;
      card.className = "stack-panel dock-panel";
      card.dataset.kind = tool.kind;
      card.setAttribute("aria-label", tool.title);
      const head = document.createElement("div");
      head.className = "dock-head";
      const title = document.createElement("span");
      title.textContent = tool.title;
      const sub = document.createElement("small");
      const paintSub = (text) => {
        sub.textContent = text || folderOf(entry.cwd);
        sub.title = entry.cwd ?? "";
      };
      const close = document.createElement("button");
      close.type = "button";
      close.className = "dock-x";
      close.setAttribute("aria-label", tool.title + " panelini kapat");
      close.title = "Kapat";
      close.append(icon('<path d="M6 6l12 12M18 6L6 18"/>'));
      close.firstChild.style.cssText = "width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round";
      close.addEventListener("click", () => toggle(tool.kind));
      head.append(title, sub, close);
      const body = document.createElement("div");
      body.className = "dock-body";
      card.append(head, body);
      applySize(card, tool.kind);
      attachResize(card, tool.kind);
      host.append(card);
      entry.api = window.createWorkspacePanel(
        `${ctx.sid}-${tool.kind}`,
        tool.kind,
        {
          cwd: () => entry.cwd ?? ctx.cwd(),
          setCwd(next) {
            entry.cwd = next;
            paintSub();
          },
          subTitle: paintSub,
          status() {},
          save() {},
          highlight: ctx.highlight,
        },
        { cwd: entry.cwd, state: null },
      );
      body.append(entry.api.el);
      paintSub();
      return entry;
    }

    /** Show the card of `kind`, building it first; or hide it when it is showing. */
    function toggle(kind) {
      const tool = TOOLS.find((t) => t.kind === kind);
      if (!tool) return;
      let entry = open.get(kind);
      if (!entry) {
        entry = build(tool);
        open.set(kind, entry);
      } else entry.card.hidden = !entry.card.hidden;
      const shown = !entry.card.hidden;
      buttons.get(kind).setAttribute("aria-pressed", String(shown));
      if (shown) {
        requestAnimationFrame(() => {
          entry.api.onShow?.();
          entry.api.focus?.();
        });
      }
    }

    for (const tool of TOOLS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dock-btn";
      b.title = `${tool.title} (${tool.key})`;
      b.setAttribute("aria-label", tool.title + " paneli");
      b.setAttribute("aria-pressed", "false");
      b.append(icon(tool.icon));
      b.addEventListener("click", () => toggle(tool.kind));
      buttons.set(tool.kind, b);
      bar.append(b);
    }

    return {
      bar,
      host,
      toggle,
      dispose() {
        for (const { api, card } of open.values()) {
          api.dispose?.();
          card.remove();
        }
        open.clear();
      },
    };
  }

  window.KostompDock = { applySize, attachResize, createToolDock };
})();
