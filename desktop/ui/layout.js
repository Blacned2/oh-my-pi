// Split-pane workspace. A binary tree whose leaves are tab groups { gid, tabs: [sid…], active } and
// whose nodes are splits { dir, ratio, a, b } ("row" = side by side, "col" = stacked). A session
// sits in at most one group; only a group's active session is mounted, the others keep running as
// that group's tabs. Sessions in no group keep running too and stay reachable from the tab strip.
//
// Dropping a session (dragged from a strip tab or a pane tab) on the outer 20% of a pane splits
// that pane on the side it was dropped on, previewing the half it will take; dropping on the middle
// adds it to the pane as another tab. Splits are resized with their gutter (drag, arrow keys,
// double-click to reset). A pane's pill carries its tabs plus "split right" / "split below"; middle click closes a tab.
// serialize()/restore() turn the arrangement into plain data so the shell can save named layouts.
(() => {
  const MIME = "application/x-kostomp-session";
  const MIN_W = 280; // px, smallest pane width the layout will produce
  const MIN_H = 170; // px, smallest pane height
  const GUTTER = 4; // px, keep in sync with --gutter in app.css
  const EDGE = 0.2; // outer band of a pane that splits it; the middle adds a tab
  const SMALL = 100; // px; a pane thinner than this shows the drop target as a thin line
  const STEP = 0.02;

  // ---- tree (pure) --------------------------------------------------------
  const isLeaf = (n) => "tabs" in n;
  const groups = (n) => (n ? (isLeaf(n) ? [n] : [...groups(n.a), ...groups(n.b)]) : []);
  const sidsOf = (n) => groups(n).flatMap((g) => g.tabs);
  /** The tree without `sid`: its group's neighbour tab takes over, an emptied group vanishes and its sibling takes the space. */
  function without(n, sid) {
    if (!n) return null;
    if (isLeaf(n)) {
      const at = n.tabs.indexOf(sid);
      if (at < 0) return n;
      const tabs = n.tabs.filter((s) => s !== sid);
      if (!tabs.length) return null;
      return { ...n, tabs, active: n.active === sid ? tabs[Math.min(at, tabs.length - 1)] : n.active };
    }
    const a = without(n.a, sid);
    const b = without(n.b, sid);
    if (!a) return b;
    if (!b) return a;
    return a === n.a && b === n.b ? n : { ...n, a, b };
  }
  function mapGroup(n, gid, fn) {
    if (isLeaf(n)) return n.gid === gid ? fn(n) : n;
    return { ...n, a: mapGroup(n.a, gid, fn), b: mapGroup(n.b, gid, fn) };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  window.createLayout = (host, hooks = {}) => {
    let tree = null;
    let focusedGid = null;
    let gidSeq = 0;
    let dragging = null; // sid being dragged (dataTransfer.getData is unreadable during dragover)
    let mounted = []; // sids whose root is in the DOM right now
    const meta = new Map(); // sid -> { title, status }
    const heads = new Map(); // sid -> { title, dot } of the rendered pane tab
    const scrollMemo = new Map(); // sid -> { top, bottom } of its transcript while it was last shown

    host.style.setProperty("--pane-min-w", MIN_W + "px");
    host.style.setProperty("--pane-min-h", MIN_H + "px");
    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";
    overlay.hidden = true;

    const el = (tag, cls) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      return n;
    };
    const newGroup = (sid) => ({ gid: ++gidSeq, tabs: [sid], active: sid });
    const groupOf = (sid) => groups(tree).find((g) => g.tabs.includes(sid)) ?? null;
    const focusedGroup = () => groups(tree).find((g) => g.gid === focusedGid) ?? null;
    const focusedSid = () => focusedGroup()?.active ?? null;
    const visible = () => groups(tree).map((g) => g.active);

    // ---- rendering ----------------------------------------------------------
    // Session roots are re-parented on every render, which resets their scroll offset and drops
    // focus; both are put back so a split never makes the transcript jump.
    function capture() {
      const active = document.activeElement;
      for (const sid of mounted) {
        const m = hooks.sessionEl(sid)?.querySelector(".messages");
        if (m && m.clientHeight) scrollMemo.set(sid, { top: m.scrollTop, bottom: m.scrollHeight - m.scrollTop - m.clientHeight < 4 });
      }
      return active && active !== document.body ? active : null;
    }
    function restore(active) {
      for (const sid of mounted) {
        const memo = scrollMemo.get(sid);
        const m = hooks.sessionEl(sid)?.querySelector(".messages");
        // Instant: `.messages` is scroll-behavior:smooth and a re-parented transcript restarts at the top,
        // so a plain `scrollTop` assignment would visibly scroll the whole chat down to where it was.
        if (memo && m) m.scrollTo({ top: memo.bottom ? m.scrollHeight : memo.top, behavior: "instant" });
      }
      if (active?.isConnected) active.focus({ preventScroll: true });
    }

    function render() {
      const active = capture();
      host.replaceChildren();
      heads.clear();
      if (tree) host.append(build(tree));
      host.append(overlay);
      mounted = visible();
      restore(active);
      for (const sid of heads.keys()) paintMeta(sid);
      paintFocus();
    }

    function build(n) {
      if (isLeaf(n)) return pane(n);
      const box = el("div", "node split " + n.dir);
      const a = build(n.a);
      const b = build(n.b);
      a.style.flex = `${n.ratio} 1 0`;
      b.style.flex = `${1 - n.ratio} 1 0`;
      box.append(a, gutter(n, box, a, b), b);
      return box;
    }

    const ICON_RIGHT = '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M8 2.5v11"/></svg>';
    const ICON_BELOW = '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 8h12"/></svg>';
    function tool(cls, html, label, onClick) {
      const b = el("button", "pane-tool " + cls);
      b.type = "button";
      b.innerHTML = html;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", onClick);
      return b;
    }

    function pane(g) {
      const p = el("section", "node pane");
      p.dataset.gid = String(g.gid);
      p.dataset.sid = g.active;
      // The pill floats over the pane's top-right corner; the rest of the strip is inert.
      const head = el("div", "pane-head");
      const pill = el("div", "pane-pill");
      const tabs = el("div", "pane-tabs");
      tabs.setAttribute("role", "tablist");
      for (const sid of g.tabs) {
        const chip = el("button", "pane-tab" + (sid === g.active ? " on" : ""));
        chip.type = "button";
        chip.setAttribute("role", "tab");
        chip.setAttribute("aria-selected", String(sid === g.active));
        chip.title = "Drag onto another pane to move this session · Middle click to close the tab (the session keeps running)";
        const dot = el("span", "dot");
        const title = el("span", "pane-title");
        chip.append(dot, title);
        chip.addEventListener("click", () => api.show(sid));
        // Middle click closes the tab in the pane (the session keeps running in the tab strip).
        // mousedown is cancelled too, so Windows does not start autoscroll on the scrollable chip row.
        chip.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
        chip.addEventListener("auxclick", (e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          api.close(sid);
        });
        makeDraggable(chip, sid);
        tabs.append(chip);
        heads.set(sid, { title, dot });
      }
      const sep = el("span", "pane-sep");
      sep.setAttribute("aria-hidden", "true");
      const sid = g.active;
      pill.append(
        tabs,
        sep,
        tool("split-right", ICON_RIGHT, "Split right (Ctrl+Shift+5)", () => hooks.split?.(sid, "right")),
        tool("split-below", ICON_BELOW, "Split below", () => hooks.split?.(sid, "bottom")),
      );
      head.append(pill);
      const body = el("div", "pane-body");
      const root = hooks.sessionEl(g.active);
      if (root) body.append(root);
      p.append(head, body);
      p.addEventListener("pointerdown", () => focusGroup(g.gid), true);
      p.addEventListener("focusin", () => focusGroup(g.gid));
      return p;
    }
    function gutter(n, box, a, b) {
      const row = n.dir === "row";
      const g = el("div", "gutter " + n.dir);
      g.setAttribute("role", "separator");
      g.setAttribute("aria-orientation", row ? "vertical" : "horizontal");
      g.setAttribute("aria-label", "Resize panes (arrow keys, double-click to reset)");
      g.setAttribute("aria-valuemin", "0");
      g.setAttribute("aria-valuemax", "100");
      g.tabIndex = 0;
      const paint = () => {
        a.style.flex = `${n.ratio} 1 0`;
        b.style.flex = `${1 - n.ratio} 1 0`;
        g.setAttribute("aria-valuenow", String(Math.round(n.ratio * 100)));
      };
      const setRatio = (v) => {
        const r = box.getBoundingClientRect();
        const size = (row ? r.width : r.height) - GUTTER;
        const min = Math.min(0.5, (row ? MIN_W : MIN_H) / Math.max(size, 1));
        n.ratio = clamp(v, min, 1 - min);
        paint();
      };
      paint();
      g.addEventListener("pointerdown", (e) => {
        if (e.button) return;
        e.preventDefault();
        g.setPointerCapture(e.pointerId);
        g.classList.add("active");
        host.classList.add("resizing", row ? "resizing-row" : "resizing-col");
      });
      g.addEventListener("pointermove", (e) => {
        if (!g.hasPointerCapture(e.pointerId)) return;
        const r = box.getBoundingClientRect();
        const size = (row ? r.width : r.height) - GUTTER;
        setRatio(((row ? e.clientX - r.left : e.clientY - r.top) - GUTTER / 2) / size);
      });
      const end = (e) => {
        if (!g.hasPointerCapture(e.pointerId)) return;
        g.releasePointerCapture(e.pointerId);
        g.classList.remove("active");
        host.classList.remove("resizing", "resizing-row", "resizing-col");
        hooks.onChange?.(); // the ratio is part of the saved layout
      };
      g.addEventListener("pointerup", end);
      g.addEventListener("pointercancel", end);
      g.addEventListener("dblclick", () => {
        setRatio(0.5);
        hooks.onChange?.();
      });
      g.addEventListener("keydown", (e) => {
        const dec = row ? "ArrowLeft" : "ArrowUp";
        const inc = row ? "ArrowRight" : "ArrowDown";
        if (e.key !== dec && e.key !== inc) return;
        e.preventDefault();
        setRatio(n.ratio + (e.key === inc ? 1 : -1) * (e.shiftKey ? 5 : 1) * STEP);
        hooks.onChange?.();
      });
      return g;
    }

    function paintMeta(sid) {
      const h = heads.get(sid);
      const m = meta.get(sid);
      if (!h || !m) return;
      h.title.textContent = m.title;
      h.title.title = m.title;
      h.dot.className = "dot" + (m.status ? " " + m.status : "");
    }
    function paintFocus() {
      for (const p of host.querySelectorAll(".pane")) p.classList.toggle("focused", p.dataset.gid === String(focusedGid));
    }
    function focusGroup(gid) {
      if (gid === focusedGid || !groups(tree).some((g) => g.gid === gid)) return;
      focusedGid = gid;
      paintFocus();
      hooks.onFocus?.(focusedSid());
    }

    // ---- tree operations ----------------------------------------------------
    function commit(next, focusSid) {
      tree = next;
      const fg = focusSid ? groupOf(focusSid) : null;
      if (fg) focusedGid = fg.gid;
      if (!focusedGroup()) focusedGid = groups(tree)[0]?.gid ?? null;
      render();
      hooks.onChange?.();
      hooks.onFocus?.(focusedSid());
    }

    /** Move `sid` onto the pane showing `target`. zone: left|right|top|bottom split, center adds a tab. */
    function drop(sid, target, zone) {
      if (!tree) return;
      const tg = groupOf(target);
      if (!tg) return;
      // The active tab of a pane is also that pane's target, so dragging it onto its own pane's edge is a real split.
      if (sid === target && zone === "center") return;
      if (zone === "center") {
        if (tg.tabs.includes(sid)) return api.show(sid);
        commit(mapGroup(without(tree, sid), tg.gid, (g) => ({ ...g, tabs: [...g.tabs, sid], active: sid })), sid);
        return;
      }
      if (tg.tabs.includes(sid) && tg.tabs.length === 1) return; // nothing to split off
      const dir = zone === "left" || zone === "right" ? "row" : "col";
      const first = zone === "left" || zone === "top";
      const fresh = newGroup(sid);
      commit(
        mapGroup(without(tree, sid), tg.gid, (g) => ({ dir, ratio: 0.5, a: first ? fresh : g, b: first ? g : fresh })),
        sid,
      );
    }

    // ---- drag and drop ------------------------------------------------------
    function makeDraggable(node, sid) {
      node.draggable = true;
      node.addEventListener("dragstart", (e) => {
        dragging = sid;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(MIME, sid);
        host.classList.add("dnd");
      });
      node.addEventListener("dragend", () => {
        dragging = null;
        host.classList.remove("dnd");
        overlay.hidden = true;
      });
    }

    /** Where a drag at (x, y) would land: { target, zone, rect } or null when it can't. */
    function zoneAt(e) {
      const p = e.target.closest?.(".pane");
      if (!p || !dragging) return null;
      const g = groups(tree).find((x) => String(x.gid) === p.dataset.gid);
      if (!g) return null;
      const r = p.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      let zone = "center";
      if (fx < EDGE || fx > 1 - EDGE || fy < EDGE || fy > 1 - EDGE) {
        const d = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]].sort((x, y) => x[1] - y[1])[0][0];
        const horizontal = d === "left" || d === "right";
        // Splitting a pane that would end up below the minimum size falls back to adding a tab.
        if (horizontal ? r.width >= 2 * MIN_W + GUTTER : r.height >= 2 * MIN_H + GUTTER) zone = d;
      }
      const own = g.tabs.includes(dragging);
      if (own && (zone === "center" || g.tabs.length === 1)) return null; // already a tab here / nothing to split off
      return { target: g.active, zone, rect: r };
    }
    function showOverlay({ zone, rect }) {
      const h = host.getBoundingClientRect();
      let { left, top, width, height } = rect;
      const horizontal = zone === "left" || zone === "right";
      const vertical = zone === "top" || zone === "bottom";
      // The preview is the half the dragged session would take; a thin pane gets a 4px line.
      const line = horizontal ? rect.width < SMALL : vertical ? rect.height < SMALL : false;
      if (horizontal) width = line ? 4 : width / 2;
      if (vertical) height = line ? 4 : height / 2;
      if (zone === "right") left = rect.right - width;
      if (zone === "bottom") top = rect.bottom - height;
      Object.assign(overlay.style, {
        left: left - h.left + host.scrollLeft + "px",
        top: top - h.top + host.scrollTop + "px",
        width: width + "px",
        height: height + "px",
      });
      overlay.className = "drop-overlay " + zone + (line ? " line" : "");
      overlay.hidden = false;
    }
    host.addEventListener("dragover", (e) => {
      if (!dragging) return;
      const z = zoneAt(e);
      if (!z) {
        overlay.hidden = true;
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      showOverlay(z);
    });
    host.addEventListener("dragleave", (e) => {
      if (!host.contains(e.relatedTarget)) overlay.hidden = true;
    });
    host.addEventListener("drop", (e) => {
      if (!dragging) return;
      e.preventDefault();
      const z = zoneAt(e);
      const sid = dragging;
      dragging = null;
      host.classList.remove("dnd");
      overlay.hidden = true;
      if (z) drop(sid, z.target, z.zone);
    });

    // ---- public API ---------------------------------------------------------
    const api = {
      /** The session showing in the focused pane. */
      get focused() { return focusedSid(); },
      /** The session each pane is showing. */
      visible,
      /** Every session that sits in some pane's tab group, shown or not. */
      has: (sid) => !!tree && sidsOf(tree).includes(sid),
      sids: () => sidsOf(tree),
      makeDraggable,
      drop,
      /** Bring a session into view: select its tab and focus its pane. A session not in any pane replaces the focused pane's
       *  unpinned tabs (they keep running; only an explicit split or tab drop grows a pane's tab row). */
      show(sid) {
        if (!tree) return commit(newGroup(sid), sid);
        const g = groupOf(sid);
        if (g) {
          if (g.active === sid) return focusGroup(g.gid);
          return commit(mapGroup(tree, g.gid, (x) => ({ ...x, active: sid })), sid);
        }
        const kept = (x) => x.tabs.filter((t) => hooks.pinned?.(t));
        commit(mapGroup(tree, focusedGid, (x) => ({ ...x, tabs: [...kept(x), sid], active: sid })), sid);
      },
      focus(sid) {
        const g = groupOf(sid);
        if (g && g.active === sid) focusGroup(g.gid);
      },
      /** Take a session out of its pane (it lives on in the tab strip). An emptied pane closes; the last session stays. */
      close(sid) {
        if (!tree || !groupOf(sid) || sidsOf(tree).length === 1) return;
        commit(without(tree, sid));
      },
      /** The session is gone for good; drop it from its pane too (even the last one). */
      remove(sid) {
        scrollMemo.delete(sid);
        meta.delete(sid);
        if (!tree || !groupOf(sid)) return;
        commit(without(tree, sid));
      },
      setMeta(sid, patch) {
        meta.set(sid, { ...meta.get(sid), ...patch });
        paintMeta(sid);
      },
      /** The arrangement as plain data (session ids, split directions and ratios), or null when empty. */
      serialize() {
        if (!tree) return null;
        const plain = (n) => (isLeaf(n) ? { tabs: [...n.tabs], active: n.active } : { dir: n.dir, ratio: n.ratio, a: plain(n.a), b: plain(n.b) });
        return { tree: plain(tree), focus: focusedSid() };
      },
      /** Show a serialized arrangement; sessions `valid` rejects are dropped. false (and nothing changes) when none is left. */
      restore(state, valid) {
        const seen = new Set();
        const rebuild = (n) => {
          if (!n || typeof n !== "object") return null;
          if (Array.isArray(n.tabs)) {
            const tabs = n.tabs.filter((s) => typeof s === "string" && valid(s) && !seen.has(s));
            for (const s of tabs) seen.add(s);
            if (!tabs.length) return null;
            return { gid: ++gidSeq, tabs, active: tabs.includes(n.active) ? n.active : tabs[0] };
          }
          const a = rebuild(n.a);
          const b = rebuild(n.b);
          if (!a || !b) return a ?? b;
          return { dir: n.dir === "col" ? "col" : "row", ratio: clamp(Number(n.ratio) || 0.5, 0.05, 0.95), a, b };
        };
        const next = rebuild(state?.tree);
        if (!next) return false;
        commit(next, state.focus);
        return true;
      },
    };
    return api;
  };
})();
