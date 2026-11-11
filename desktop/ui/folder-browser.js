(() => {
  const { invoke } = window.__TAURI__.core;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const errText = error => String(error?.message ?? error);
  // Chat and Graph share the folder browser and recent projects.
  const RECENT_KEY = "kostomp-recent-folders";
  const RECENT_MAX = 12;
  const loadRecent = () => {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
    } catch {
      return [];
    }
  };
  const saveRecent = (dir) => {
    if (!dir) return;
    const key = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
    const list = [dir, ...loadRecent().filter((d) => key(d) !== key(dir))].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  };
  // Folders are shown by project name only; the full path stays in the tooltip.
  const folderName = (p) => {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  };
  // Large in-app folder browser (replaces the native dialog). Resolves the chosen path, or null.
  function browseFolder(start, opts = {}) {
    const imgMode = !!opts.images;
    const picked = new Map(); // path -> file entry (image mode)
    const { promise, resolve } = Promise.withResolvers();
    const mk = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const btn = (label, cls, onClick) => {
      const b = mk("button", "fb-btn glass-control " + (cls || ""), label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    };
    const veil = mk("div", "fb-veil");
    const dlg = mk("div", "fb-panel glass");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    const title = imgMode ? "Choose images" : "Choose project folder";
    dlg.setAttribute("aria-label", title);
    const head = mk("div", "fb-head");
    const crumbs = mk("div", "fb-path glass-control");
    const closeX = mk("button", "fb-x", "✕");
    closeX.type = "button";
    closeX.setAttribute("aria-label", "Close");
    head.append(mk("b", "", title), crumbs, closeX);
    const side = mk("div", "fb-side");
    const list = mk("div", "fb-list");
    const prev = mk("div", "fb-prev");
    const foot = mk("div", "fb-foot");
    const hint = mk("span", "fb-hint", imgMode ? "Click images to select several, double-click a folder to open it" : "Double-click to open a folder");
    const newBtn = btn("New folder", "", () => newFolder());
    newBtn.hidden = imgMode || opts.allowCreate === false;
    const cancel = btn("Cancel", "", () => done(null));
    const ok = btn(imgMode ? "Attach" : "Open folder", "primary", () => (imgMode ? picked.size && done([...picked.keys()]) : selected && done(selected)));
    foot.append(hint, newBtn, cancel, ok);
    dlg.append(head, side, list, prev, foot);
    veil.append(dlg);

    let current = "";
    let selected = "";
    let token = 0;
    const opener = document.activeElement;
    const done = (v) => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      document.removeEventListener("keydown", onKey, true);
      veil.remove();
      if (opener?.isConnected) opener.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && (imgMode ? picked.size : selected) && !e.target.closest?.("button, input, textarea")) { e.preventDefault(); ok.click(); }
    };
    veil.addEventListener("pointerdown", (e) => { if (e.target === veil) done(null); });
    closeX.addEventListener("click", () => done(null));

    const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
    const setCrumbs = (p) => {
      crumbs.replaceChildren();
      const parts = p.split(/[\\/]+/).filter(Boolean);
      let acc = "";
      parts.forEach((part, i) => {
        acc = i === 0 ? part + "\\" : acc.replace(/\\?$/, "\\") + part;
        const target = acc;
        if (i) crumbs.append(mk("span", "fb-sep", "›"));
        const c = mk("button", "fb-crumb" + (i === parts.length - 1 ? " last" : ""), part);
        c.type = "button";
        c.addEventListener("click", () => load(target));
        crumbs.append(c);
      });
    };
    const syncOk = () => {
      ok.disabled = imgMode ? !picked.size : false;
      if (imgMode) ok.textContent = picked.size ? `Attach ${picked.size} image${picked.size > 1 ? "s" : ""}` : "Attach";
    };
    let blobUrl = "";
    const showImage = async (f) => {
      const t = ++token;
      prev.replaceChildren();
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = ""; }
      prev.append(mk("h3", "", f.name), mk("p", "", f.path));
      const kv = (k, v) => { const r = mk("div", "fb-kv"); r.append(mk("span", "", k), mk("b", "", v)); prev.append(r); };
      kv("Size", f.size > 1048576 ? (f.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(f.size / 1024)) + " KB");
      if (f.size > MAX_IMAGE_BYTES) return;
      try {
        const buf = await invoke("read_image", { path: f.path });
        if (t !== token) return;
        const ext = f.name.split(".").pop().toLowerCase();
        blobUrl = URL.createObjectURL(new Blob([buf], { type: "image/" + (ext === "jpg" ? "jpeg" : ext) }));
        const img = mk("img", "fb-img");
        img.src = blobUrl;
        prev.prepend(img);
      } catch {}
    };
    const showPreview = async (e) => {
      const t = ++token;
      selected = e.path;
      syncOk();
      prev.replaceChildren();
      const icon = mk("div", "fb-bigfolder");
      const title = mk("h3", "", e.name);
      const pth = mk("p", "", e.path);
      prev.append(icon, title, pth);
      let d = null;
      try { d = await invoke("dir_details", { path: e.path }); } catch {}
      if (t !== token || !d) return;
      const kv = (k, v) => { const r = mk("div", "fb-kv"); r.append(mk("span", "", k), mk("b", "", v)); prev.append(r); };
      kv("Git repository", d.git_branch ? "Yes · " + d.git_branch : "No");
      if (d.package_manager) kv("Package manager", d.package_manager);
      kv("Folders", String(d.subfolders));
      kv("Files", String(d.files));
    };
    const select = (row, e) => {
      list.querySelectorAll(".fb-row.sel").forEach((r) => r.classList.remove("sel"));
      row.classList.add("sel");
      showPreview(e);
    };
    async function load(path) {
      let res;
      try {
        res = await invoke("list_dir", { path, images: imgMode });
      } catch (err) {
        list.replaceChildren(mk("div", "fb-empty", "Cannot open this folder: " + errText(err)));
        return;
      }
      current = res.path;
      selected = current;
      syncOk();
      setCrumbs(current);
      side.querySelectorAll(".fb-it").forEach((n) => n.classList.toggle("on", current.toLowerCase().startsWith(n.dataset.path.toLowerCase())));
      list.replaceChildren();
      const th = mk("div", "fb-th");
      th.append(mk("span", "", "Name"), mk("span", "", "Modified"), mk("span", "", "Items"));
      list.append(th);
      if (res.parent) {
        const up = mk("div", "fb-row");
        up.append(mk("span", "fb-name", "← Up one level"), mk("span"), mk("span"));
        up.addEventListener("click", () => load(res.parent));
        list.append(up);
      }
      if (!res.dirs.length && !(imgMode && res.files.length)) list.append(mk("div", "fb-empty", imgMode ? "No sub-folders or images here." : "No sub-folders here. You can open this folder."));
      for (const e of res.dirs) {
        const row = mk("div", "fb-row");
        row.tabIndex = 0;
        const name = mk("span", "fb-name");
        name.append(mk("i", "fb-folder"), mk("span", "", e.name));
        if (e.git) name.append(mk("span", "fb-tag", "git"));
        else if (e.project) name.append(mk("span", "fb-tag", "project"));
        row.append(name, mk("span", "fb-dim", fmtDate(e.modified)), mk("span", "fb-dim", e.items == null ? "" : String(e.items)));
        row.addEventListener("click", () => select(row, e));
        row.addEventListener("dblclick", () => load(e.path));
        row.addEventListener("keydown", (ev) => { if (ev.key === " ") { ev.preventDefault(); select(row, e); } else if (ev.key === "ArrowRight") load(e.path); });
        list.append(row);
      }
      for (const f of imgMode ? res.files : []) {
        const row = mk("div", "fb-row" + (picked.has(f.path) ? " sel" : ""));
        row.tabIndex = 0;
        const name = mk("span", "fb-name");
        name.append(mk("i", "fb-file"), mk("span", "", f.name));
        row.append(name, mk("span", "fb-dim", fmtDate(f.modified)), mk("span", "fb-dim", f.size > 1048576 ? (f.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(f.size / 1024)) + " KB"));
        const toggle = () => {
          if (picked.has(f.path)) { picked.delete(f.path); row.classList.remove("sel"); }
          else { picked.set(f.path, f); row.classList.add("sel"); }
          syncOk();
          showImage(f);
        };
        row.addEventListener("click", toggle);
        row.addEventListener("dblclick", () => { if (!picked.has(f.path)) picked.set(f.path, f); done([...picked.keys()]); });
        row.addEventListener("keydown", (ev) => { if (ev.key === " ") { ev.preventDefault(); toggle(); } });
        list.append(row);
      }
      if (imgMode) { prev.replaceChildren(mk("p", "", "Select images to preview them.")); syncOk(); }
      else showPreview({ name: folderName(current) || current, path: current });
    }
    async function newFolder() {
      const name = window.prompt("New folder name");
      if (!name || !current) return;
      try {
        const p = await invoke("make_dir", { parent: current, name });
        await load(p);
      } catch (err) {
        const message = "Could not create the folder: " + errText(err);
        hint.textContent = message;
        opts.onError?.(message);
      }
    }
    async function init() {
      const recent = loadRecent();
      if (recent.length) {
        side.append(mk("h6", "", "Recent projects"));
        for (const d of recent.slice(0, 5)) {
          const b = mk("button", "fb-it", folderName(d));
          b.type = "button"; b.title = d; b.dataset.path = d;
          b.addEventListener("click", () => load(d));
          side.append(b);
        }
      }
      let places = [];
      try { places = await invoke("list_places"); } catch {}
      for (const [h, kind] of [["Places", "place"], ["Drives", "drive"]]) {
        const items = places.filter((p) => p.kind === kind);
        if (!items.length) continue;
        side.append(mk("h6", "", h));
        for (const p of items) {
          const b = mk("button", "fb-it", p.name);
          b.type = "button"; b.title = p.path; b.dataset.path = p.path;
          b.addEventListener("click", () => load(p.path));
          side.append(b);
        }
      }
      const first = [start, ...recent, places[0]?.path].find(Boolean);
      if (first) await load(first);
    }
    ok.disabled = true;
    document.body.append(veil);
    closeX.focus();
    document.addEventListener("keydown", onKey, true);
    init();
    return promise;
  }
  const clearRecent = () => localStorage.removeItem(RECENT_KEY);
  window.KostompFolders = { browseFolder, folderName, loadRecent, saveRecent, clearRecent, MAX_IMAGE_BYTES };
})();
