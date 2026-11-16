// Workspace panels that live in the split-pane layout alongside chats:
//   1. Terminal (ConPTY interactive shell)
//   2. Changes / Değişiklikler (Git status, diff, stage/unstage/discard, commit)
//   3. Browser / Tarayıcı (In-pane web browser with navigation, bookmarks, external open)
//   4. Files / Dosyalar (Project tree, syntax-highlighted viewer, in-place editor & image preview)
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { browseFolder, folderName, saveRecent } = window.KostompFolders;

  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (label, cls, title, onClick) => {
    const b = mk("button", "wpanel-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }
    b.addEventListener("click", onClick);
    return b;
  };
  const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  };
  const extOf = (name) => {
    const m = /\.([A-Za-z0-9_+-]+)$/.exec(String(name ?? ""));
    return m ? m[1].toLowerCase() : String(name ?? "").toLowerCase();
  };
  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);

  // Global terminal event routing (sid -> handler)
  const termDataHandlers = new Map();
  const termExitHandlers = new Map();
  listen("term-data", (e) => {
    const [id, data] = Array.isArray(e.payload) ? e.payload : [];
    termDataHandlers.get(id)?.(data);
  });
  listen("term-exit", (e) => {
    const [id, code] = Array.isArray(e.payload) ? e.payload : [e.payload, 0];
    termExitHandlers.get(id)?.(code);
  });

  // ===========================================================================
  // 1. Terminal Panel (ConPTY + VT100/ANSI screen buffer)
  // ===========================================================================

  function ansi256(n) {
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    const k = n - 16;
    const level = (v) => (v ? 55 + v * 40 : 0);
    return `rgb(${level(Math.floor(k / 36))},${level(Math.floor(k / 6) % 6)},${level(k % 6)})`;
  }

  function applySgr(st, params) {
    const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) for (const k of Object.keys(st)) delete st[k];
      else if (c === 1) st.b = true;
      else if (c === 2) st.d = true;
      else if (c === 3) st.i = true;
      else if (c === 4) st.u = true;
      else if (c === 7) st.v = true;
      else if (c === 9) st.s = true;
      else if (c === 21 || c === 22) { delete st.b; delete st.d; }
      else if (c === 23) delete st.i;
      else if (c === 24) delete st.u;
      else if (c === 27) delete st.v;
      else if (c === 29) delete st.s;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 39) delete st.fg;
      else if (c === 49) delete st.bg;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5 && Number.isInteger(codes[i + 2])) {
          const n = codes[i + 2];
          if (n >= 0 && n < 256) st[key] = n < 16 ? n : ansi256(n);
          i += 2;
        } else if (codes[i + 1] === 2 && codes.length >= i + 5) {
          const [r, g, b] = codes.slice(i + 2, i + 5).map((v) => Math.max(0, Math.min(255, v | 0)));
          st[key] = `rgb(${r},${g},${b})`;
          i += 4;
        } else break;
      }
    }
  }

  function createTerminalPanel(sid, hooks, opts) {
    const root = mk("section", "wpanel term-panel");
    const bar = mk("div", "wpanel-bar");
    const cwdBtn = btn("", "wpanel-cwd", "Çalışma klasörünü değiştir", async () => {
      const dir = await browseFolder(currentCwd);
      if (dir) {
        saveRecent(dir);
        hooks.setCwd(dir);
        currentCwd = dir;
        syncCwdLabel();
        startPty();
      }
    });
    const shellSelect = mk("select", "wpanel-select");
    shellSelect.title = "Kabuk (Shell)";
    for (const [val, label] of [["", "PowerShell"], ["cmd", "CMD"], ["pwsh", "pwsh"]]) {
      shellSelect.append(new Option(label, val));
    }
    shellSelect.value = opts.state?.shell ?? "";
    shellSelect.addEventListener("change", () => {
      hooks.save?.();
      startPty();
    });
    const clearBtn = btn("Temizle", "", "Ekranı temizle (Ctrl+L)", () => {
      resetBuffer();
      paintScreen();
      focus();
    });
    const restartBtn = btn("↻", "ico", "Terminali yeniden başlat", () => startPty());
    const stateBadge = mk("span", "wpanel-badge ok", "çalışıyor");
    bar.append(cwdBtn, shellSelect, clearBtn, restartBtn, stateBadge);

    const wrap = mk("div", "term-wrap");
    wrap.tabIndex = 0;
    const screen = mk("div", "term-screen");
    const hiddenInput = mk("textarea", "term-input-Capture");
    hiddenInput.setAttribute("aria-label", "Terminal input");
    hiddenInput.spellcheck = false;
    hiddenInput.autocapitalize = "off";
    hiddenInput.autocomplete = "off";
    wrap.append(screen, hiddenInput);
    root.append(bar, wrap);

    let currentCwd = opts.cwd ?? hooks.cwd() ?? null;
    let alive = false;
    let cols = 100;
    let rows = 30;

    // Terminal grid + scrollback state
    const MAX_SCROLLBACK = 1500;
    const TERM_PAINT_MS = 50;
    let scrollback = []; // array of rendered row arrays
    let scrollTotal = 0; // rows ever scrolled off; numbers scrollback rows across trims and clears
    let grid = []; // rows x cols of { ch, style }
    let curR = 0;
    let curC = 0;
    let savedR = 0;
    let savedC = 0;
    let sgr = {};
    // Snapshot of `sgr` shared by every cell printed in it, so never mutated; refreshed whenever `sgr` changes.
    let cellStyle = null;
    let parseCarry = "";
    let paintQueued = false;
    let paintOwed = false;
    // Painted scrollback rows never change, so they stay in the DOM; `backEnd` is the scrollTotal they cover.
    let backEls = [];
    let backEnd = 0;
    let gridEls = [];

    const blankCell = () => ({ ch: " ", s: null });
    const makeRow = (w = cols) => Array.from({ length: w }, blankCell);

    function resetBuffer() {
      scrollback = [];
      grid = Array.from({ length: rows }, () => makeRow(cols));
      curR = 0;
      curC = 0;
      savedR = 0;
      savedC = 0;
      sgr = {};
      cellStyle = null;
    }
    resetBuffer();

    function ensureRow(r) {
      while (grid.length <= r) grid.push(makeRow(cols));
      if (grid[r].length < cols) {
        while (grid[r].length < cols) grid[r].push(blankCell());
      }
    }

    function scrollUp() {
      const top = grid.shift() ?? makeRow(cols);
      scrollback.push(top);
      scrollTotal++;
      if (scrollback.length > MAX_SCROLLBACK) scrollback.shift();
      grid.push(makeRow(cols));
    }

    function lineFeed() {
      if (curR + 1 >= rows) scrollUp();
      else curR++;
    }

    function putChar(ch) {
      if (curC >= cols) {
        curC = 0;
        lineFeed();
      }
      ensureRow(curR);
      grid[curR][curC] = { ch, s: cellStyle };
      curC++;
    }

    function eraseInLine(mode) {
      ensureRow(curR);
      const row = grid[curR];
      const start = mode === 1 ? 0 : mode === 2 ? 0 : curC;
      const end = mode === 1 ? Math.min(curC + 1, row.length) : row.length;
      for (let i = start; i < end; i++) row[i] = blankCell();
    }

    function eraseInDisplay(mode) {
      if (mode === 2 || mode === 3) {
        if (mode === 3) scrollback = [];
        for (let r = 0; r < rows; r++) grid[r] = makeRow(cols);
        return;
      }
      if (mode === 0) {
        eraseInLine(0);
        for (let r = curR + 1; r < rows; r++) grid[r] = makeRow(cols);
      } else if (mode === 1) {
        eraseInLine(1);
        for (let r = 0; r < curR; r++) grid[r] = makeRow(cols);
      }
    }

    function feed(chunk) {
      const data = parseCarry + chunk;
      parseCarry = "";
      let i = 0;
      const n = data.length;
      while (i < n) {
        const ch = data[i];
        if (ch === "\x1b") {
          if (i + 1 >= n) {
            parseCarry = data.slice(i);
            break;
          }
          const next = data[i + 1];
          if (next === "[") {
            // CSI sequence: \x1b [ params intermediates final
            let j = i + 2;
            while (j < n && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++;
            if (j >= n) {
              parseCarry = data.slice(i);
              break;
            }
            const rawParams = data.slice(i + 2, j);
            const final = data[j];
            i = j + 1;
            const cleanParams = rawParams.replace(/^[?>=!]+/, "");
            const nums = cleanParams ? cleanParams.split(";").map((x) => (x === "" ? 0 : parseInt(x, 10) || 0)) : [];
            const p0 = nums[0] || 0;
            const p1 = nums[1] || 0;
            switch (final) {
              case "m":
                applySgr(sgr, cleanParams);
                cellStyle = Object.keys(sgr).length ? { ...sgr } : null;
                break;
              case "A":
                curR = Math.max(0, curR - (p0 || 1));
                break;
              case "B":
                curR = Math.min(rows - 1, curR + (p0 || 1));
                break;
              case "C":
                curC = Math.min(cols - 1, curC + (p0 || 1));
                break;
              case "D":
                curC = Math.max(0, curC - (p0 || 1));
                break;
              case "E":
                curR = Math.min(rows - 1, curR + (p0 || 1));
                curC = 0;
                break;
              case "F":
                curR = Math.max(0, curR - (p0 || 1));
                curC = 0;
                break;
              case "G":
                curC = Math.min(cols - 1, Math.max(0, (p0 || 1) - 1));
                break;
              case "H":
              case "f":
                curR = Math.min(rows - 1, Math.max(0, (p0 || 1) - 1));
                curC = Math.min(cols - 1, Math.max(0, (p1 || 1) - 1));
                break;
              case "J":
                eraseInDisplay(p0);
                break;
              case "K":
                eraseInLine(p0);
                break;
              case "X": {
                ensureRow(curR);
                const count = p0 || 1;
                for (let k = 0; k < count && curC + k < cols; k++) grid[curR][curC + k] = blankCell();
                break;
              }
              case "s":
                savedR = curR;
                savedC = curC;
                break;
              case "u":
                curR = savedR;
                curC = savedC;
                break;
            }
            continue;
          } else if (next === "]") {
            // OSC sequence: \x1b ] ... (\x07 | \x1b \)
            let j = i + 2;
            let closed = false;
            while (j < n) {
              if (data[j] === "\x07") {
                closed = true;
                j++;
                break;
              }
              if (data[j] === "\x1b" && data[j + 1] === "\\") {
                closed = true;
                j += 2;
                break;
              }
              j++;
            }
            if (!closed) {
              parseCarry = data.slice(i);
              break;
            }
            const osc = data.slice(i + 2, j);
            const titleMatch = /^(?:0|2);([^\x07\x1b]*)/.exec(osc);
            if (titleMatch) {
              const t = titleMatch[1].trim().split(/[\\/]/).pop();
              if (t) hooks.subTitle(t.slice(0, 32));
            }
            i = j;
            continue;
          } else {
            // 2-byte escape sequence (e.g. \x1bM, \x1b7, \x1b8)
            if (next === "7") { savedR = curR; savedC = curC; }
            else if (next === "8") { curR = savedR; curC = savedC; }
            else if (next === "c") resetBuffer();
            i += 2;
            continue;
          }
        }
        if (ch === "\r") {
          curC = 0;
          i++;
        } else if (ch === "\n") {
          lineFeed();
          i++;
        } else if (ch === "\b" || ch === "\x7f") {
          if (curC > 0) curC--;
          i++;
        } else if (ch === "\t") {
          const nextStop = Math.min(cols - 1, (Math.floor(curC / 8) + 1) * 8);
          while (curC < nextStop) putChar(" ");
          i++;
        } else if (ch.charCodeAt(0) < 32) {
          i++;
        } else {
          putChar(ch);
          i++;
        }
      }
      schedulePaint();
    }

    // Output repaints the live grid; batch it to TERM_PAINT_MS instead of every display refresh.
    function schedulePaint() {
      if (paintQueued) return;
      paintQueued = true;
      setTimeout(() => {
        paintQueued = false;
        // Not rendered (detached or in a hidden view): the ResizeObserver paints once the screen has a box again.
        if (screen.checkVisibility()) paintScreen();
        else paintOwed = true;
      }, TERM_PAINT_MS);
    }

    function sameStyle(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      return a.b === b.b && a.d === b.d && a.i === b.i && a.u === b.u && a.s === b.s && a.v === b.v && a.fg === b.fg && a.bg === b.bg;
    }

    function makeSpan(text, g) {
      if (!g) return document.createTextNode(text);
      let fg = g.fg;
      let bg = g.bg;
      if (g.v) [fg, bg] = [bg ?? "inv-fg", fg ?? "inv-bg"];
      const cls = [g.b && "ansi-b", g.d && "ansi-d", g.i && "ansi-i", g.u && "ansi-u", g.s && "ansi-s"];
      if (typeof fg === "number") cls.push("ansi-f" + fg);
      else if (fg === "inv-fg") cls.push("ansi-inv-f");
      if (typeof bg === "number") cls.push("ansi-g" + bg);
      else if (bg === "inv-bg") cls.push("ansi-inv-g");
      const names = cls.filter(Boolean).join(" ");
      const custom = (typeof fg === "string" && !fg.startsWith("inv")) || (typeof bg === "string" && !bg.startsWith("inv"));
      if (!names && !custom) return document.createTextNode(text);
      const sp = mk("span", names, text);
      if (typeof fg === "string" && !fg.startsWith("inv")) sp.style.color = fg;
      if (typeof bg === "string" && !bg.startsWith("inv")) sp.style.backgroundColor = bg;
      return sp;
    }

    function renderRow(cells, cursorCol) {
      const div = mk("div", "term-line");
      let end = cells.length;
      while (end > 0 && cells[end - 1].ch === " " && !cells[end - 1].s && end - 1 !== cursorCol) end--;
      if (cursorCol >= 0 && cursorCol >= end) end = cursorCol + 1;
      let runText = "";
      let runStyle = null;
      const flush = () => {
        if (!runText) return;
        div.append(makeSpan(runText, runStyle));
        runText = "";
      };
      for (let c = 0; c < end; c++) {
        const cell = cells[c] ?? { ch: " ", s: null };
        if (c === cursorCol) {
          flush();
          const cur = mk("span", "term-cursor", cell.ch || " ");
          div.append(cur);
          runStyle = null;
          continue;
        }
        if (!sameStyle(cell.s, runStyle)) {
          flush();
          runStyle = cell.s;
        }
        runText += cell.ch;
      }
      flush();
      return div;
    }

    function paintScreen() {
      paintOwed = false;
      const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
      // Find last non-empty row in grid so we don't render trailing blank rows below cursor
      let lastGridRow = curR;
      for (let r = grid.length - 1; r > curR; r--) {
        if (grid[r]?.some((c) => c.ch !== " " || c.s)) {
          lastGridRow = r;
          break;
        }
      }
      for (const el of gridEls) el.remove();
      // Drop painted rows that were trimmed or cleared since, then append the ones scrolled off since.
      const first = scrollTotal - scrollback.length;
      const drop = Math.min(backEls.length, Math.max(0, first - (backEnd - backEls.length)));
      for (let k = 0; k < drop; k++) backEls[k].remove();
      if (drop) backEls.splice(0, drop);
      const frag = document.createDocumentFragment();
      for (let a = Math.max(backEnd, first); a < scrollTotal; a++) {
        const el = renderRow(scrollback[a - first], -1);
        backEls.push(el);
        frag.append(el);
      }
      backEnd = scrollTotal;
      gridEls = [];
      for (let r = 0; r <= lastGridRow; r++) {
        ensureRow(r);
        const el = renderRow(grid[r], alive && r === curR ? curC : -1);
        gridEls.push(el);
        frag.append(el);
      }
      screen.append(frag);
      if (atBottom) screen.scrollTop = screen.scrollHeight;
    }

    function syncCwdLabel() {
      const c = currentCwd || hooks.cwd() || "";
      cwdBtn.textContent = c ? "📁 " + folderName(c) : "📁 Klasör seç";
      cwdBtn.title = (c ? c + "\n" : "") + "Çalışma klasörünü değiştirmek için tıklayın";
    }

    function sendInput(data) {
      if (!alive || !data) return;
      invoke("term_write", { id: sid, data }).catch(() => {});
    }

    function measureAndResize() {
      if (!screen.clientWidth || !screen.clientHeight) return;
      const newCols = Math.max(30, Math.min(300, Math.floor((screen.clientWidth - 28) / 7.8)));
      const newRows = Math.max(8, Math.min(120, Math.floor((screen.clientHeight - 20) / 19)));
      if (newCols === cols && newRows === rows) return;
      cols = newCols;
      rows = newRows;
      while (grid.length < rows) grid.push(makeRow(cols));
      if (curR >= rows) curR = rows - 1;
      if (curC >= cols) curC = cols - 1;
      if (alive) invoke("term_resize", { id: sid, cols, rows }).catch(() => {});
    }

    const resizeObserver = new ResizeObserver(() => {
      measureAndResize();
      if (paintOwed && screen.checkVisibility()) paintScreen();
    });
    resizeObserver.observe(screen);

    async function startPty() {
      currentCwd = currentCwd ?? hooks.cwd();
      syncCwdLabel();
      measureAndResize();
      resetBuffer();
      stateBadge.className = "wpanel-badge warn";
      stateBadge.textContent = "başlatılıyor…";
      hooks.status("terminal başlatılıyor…", "busy");
      try {
        const dir = await invoke("term_start", {
          id: sid,
          cwd: currentCwd,
          cols,
          rows,
          shell: shellSelect.value || null,
        });
        currentCwd = dir;
        hooks.setCwd(dir);
        syncCwdLabel();
        alive = true;
        stateBadge.className = "wpanel-badge ok";
        stateBadge.textContent = "çalışıyor";
        hooks.status("terminal hazır", "ok");
        paintScreen();
      } catch (err) {
        alive = false;
        stateBadge.className = "wpanel-badge bad";
        stateBadge.textContent = "hata";
        hooks.status("terminal hatası", "bad");
        feed(`\r\n\x1b[31m[Terminal başlatılamadı: ${String(err?.message ?? err)}]\x1b[0m\r\n`);
      }
    }

    termDataHandlers.set(sid, (data) => feed(String(data ?? "")));
    termExitHandlers.set(sid, (code) => {
      alive = false;
      stateBadge.className = "wpanel-badge";
      stateBadge.textContent = `sonlandı (${code ?? 0})`;
      hooks.status(`terminal sonlandı (${code ?? 0})`, "ok");
      feed(`\r\n\x1b[90m[İşlem sonlandı (kod ${code ?? 0}) — yeniden başlatmak için Enter'a basın]\x1b[0m\r\n`);
    });

    function keyToVt(e) {
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.code === "KeyC") {
          const sel = window.getSelection()?.toString();
          if (sel) {
            navigator.clipboard?.writeText(sel);
            return null;
          }
          return "\x03";
        }
        if (e.code === "KeyV") return null; // let paste event handle it
        if (e.code === "KeyL") {
          resetBuffer();
          paintScreen();
          return "\x0c";
        }
        if (e.code === "KeyD") return "\x04";
        if (e.code === "KeyZ") return "\x1a";
        if (e.code === "KeyA") return "\x01";
        if (e.code === "KeyE") return "\x05";
        if (e.code === "KeyU") return "\x15";
        if (e.code === "KeyK") return "\x0b";
        if (e.code === "KeyW") return "\x17";
        if (e.code === "KeyR") return "\x12";
      }
      switch (e.key) {
        case "Enter": return "\r";
        case "Backspace": return "\x7f";
        case "Tab": return e.shiftKey ? "\x1b[Z" : "\t";
        case "Escape": return "\x1b";
        case "ArrowUp": return "\x1b[A";
        case "ArrowDown": return "\x1b[B";
        case "ArrowRight": return "\x1b[C";
        case "ArrowLeft": return "\x1b[D";
        case "Home": return "\x1b[H";
        case "End": return "\x1b[F";
        case "Delete": return "\x1b[3~";
        case "PageUp": return "\x1b[5~";
        case "PageDown": return "\x1b[6~";
        case "Insert": return "\x1b[2~";
        case "F1": return "\x1bOP";
        case "F2": return "\x1bOQ";
        case "F3": return "\x1bOR";
        case "F4": return "\x1bOS";
        case "F5": return "\x1b[15~";
        case "F6": return "\x1b[17~";
        case "F7": return "\x1b[18~";
        case "F8": return "\x1b[19~";
        case "F9": return "\x1b[20~";
        case "F10": return "\x1b[21~";
        case "F11": return "\x1b[23~";
        case "F12": return "\x1b[24~";
      }
      if (!e.ctrlKey && !e.metaKey && e.key.length === 1) {
        return e.altKey ? "\x1b" + e.key : e.key;
      }
      return undefined;
    }

    hiddenInput.addEventListener("keydown", (e) => {
      // Allow global layout/panel shortcuts to bubble
      if (e.altKey && e.code === "KeyL") return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ["KeyT", "Digit5", "KeyG", "KeyB", "KeyE"].includes(e.code)) return;
      if (e.ctrlKey && e.code === "Backquote") return;
      if (e.ctrlKey && !e.shiftKey && e.code === "KeyB") return;

      if (!alive && e.key === "Enter") {
        e.preventDefault();
        startPty();
        return;
      }
      const seq = keyToVt(e);
      if (seq === null) return;
      if (seq !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        sendInput(seq);
      }
    });

    hiddenInput.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text");
      if (text) {
        e.preventDefault();
        sendInput(text.replace(/\r?\n/g, "\r"));
      }
    });

    wrap.addEventListener("click", () => {
      if (!window.getSelection()?.toString()) hiddenInput.focus({ preventScroll: true });
    });

    const focus = () => hiddenInput.focus({ preventScroll: true });

    startPty();

    return {
      el: root,
      focus,
      onShow: () => {
        measureAndResize();
        paintScreen();
      },
      serialize: () => ({ shell: shellSelect.value }),
      dispose: () => {
        termDataHandlers.delete(sid);
        termExitHandlers.delete(sid);
        resizeObserver.disconnect();
        invoke("term_stop", { id: sid }).catch(() => {});
      },
    };
  }

  // ===========================================================================
  // 2. Changes / Değişiklikler Panel (Git status, diff, stage/unstage/discard, commit)
  // ===========================================================================

  function createChangesPanel(hooks, opts) {
    const root = mk("section", "wpanel changes-panel");
    const bar = mk("div", "wpanel-bar");
    const cwdBtn = btn("", "wpanel-cwd", "Çalışma klasörünü değiştir", async () => {
      const dir = await browseFolder(currentCwd);
      if (dir) {
        saveRecent(dir);
        currentCwd = dir;
        hooks.setCwd(dir);
        refresh();
      }
    });
    const branchBadge = mk("span", "wpanel-badge", "");
    branchBadge.hidden = true;
    const countBadge = mk("span", "wpanel-badge", "0 dosya");
    const refreshBtn = btn("↻ Yenile", "", "Değişiklikleri yenile", () => refresh());
    bar.append(cwdBtn, branchBadge, countBadge, refreshBtn);

    const body = mk("div", "changes-body");
    const side = mk("div", "changes-side");
    const commitBox = mk("div", "changes-commit");
    const commitInput = mk("textarea", "", "");
    commitInput.placeholder = "Commit mesajı… (Ctrl+Enter ile commit)";
    commitInput.rows = 2;
    const commitRow = mk("div", "changes-commit-row");
    const stageAllBtn = btn("Tümünü Ekle (+)", "", "Tüm değişiklikleri stage'e al", () => runGitAction("stage", []));
    const commitBtn = btn("Commit", "primary", "Stage'deki değişiklikleri commit et", () => doCommit());
    commitRow.append(stageAllBtn, commitBtn);
    commitBox.append(commitInput, commitRow);

    const listEl = mk("div", "changes-list");
    side.append(commitBox, listEl);

    const diffCol = mk("div", "changes-diff");
    const diffHead = mk("div", "changes-diff-head", "Farkı görmek için soldan bir dosya seçin");
    const diffView = mk("div", "changes-diff-view");
    diffCol.append(diffHead, diffView);

    body.append(side, diffCol);
    root.append(bar, body);

    let currentCwd = opts.cwd ?? hooks.cwd() ?? null;
    let selectedPath = opts.state?.selectedPath ?? null;
    let selectedStaged = !!opts.state?.selectedStaged;
    let statusData = null;
    let refreshGen = 0;
    let refreshing = false;
    let refreshedAt = 0;
    let diffGen = 0;
    const ROW_CAP = 300;
    const DIFF_LINE_CAP = 2000;

    commitInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doCommit();
      }
    });

    async function runGitAction(action, paths) {
      if (!currentCwd) return;
      try {
        await invoke("git_action", { cwd: currentCwd, action, paths });
        await refresh();
      } catch (err) {
        diffHead.textContent = "Hata: " + String(err?.message ?? err);
      }
    }

    async function doCommit() {
      const msg = commitInput.value.trim();
      if (!msg || !currentCwd) return;
      commitBtn.disabled = true;
      try {
        // If nothing is staged yet, stage all automatically before committing
        const hasStaged = statusData?.files?.some((f) => f.staged);
        if (!hasStaged) {
          await invoke("git_action", { cwd: currentCwd, action: "stage", paths: [] });
        }
        await invoke("git_commit", { cwd: currentCwd, message: msg });
        commitInput.value = "";
        await refresh();
      } catch (err) {
        diffHead.textContent = "Commit hatası: " + String(err?.message ?? err);
      } finally {
        commitBtn.disabled = false;
      }
    }

    function renderDiffText(raw, fileLabel) {
      diffHead.textContent = fileLabel;
      diffView.replaceChildren();
      if (!raw || !raw.trim()) {
        diffView.append(mk("div", "wpanel-empty", "Fark yok (dosya içeriği aynı veya ikili dosya)."));
        return;
      }
      const lines = raw.replace(/\r\n/g, "\n").split("\n");
      let oldLn = 0;
      let newLn = 0;
      const buildRows = (from, to) => {
        const frag = document.createDocumentFragment();
        for (let i = from; i < to; i++) {
          const l = lines[i];
          if (l.startsWith("diff --git") || l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("new file")) {
            frag.append(mk("div", "diff-row meta", l));
            continue;
          }
          const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
          if (hunk) {
            oldLn = parseInt(hunk[1], 10);
            newLn = parseInt(hunk[2], 10);
            frag.append(mk("div", "diff-row hunk", l));
            continue;
          }
          const r = mk("div", "diff-row");
          const ln = mk("span", "diff-ln");
          const sign = mk("span", "diff-sign");
          const txt = mk("span", "diff-txt");
          if (l.startsWith("+")) {
            r.classList.add("add");
            ln.textContent = String(newLn++);
            sign.textContent = "+";
            txt.textContent = l.slice(1);
          } else if (l.startsWith("-")) {
            r.classList.add("del");
            ln.textContent = String(oldLn++);
            sign.textContent = "-";
            txt.textContent = l.slice(1);
          } else {
            ln.textContent = oldLn ? String(newLn++) : "";
            if (oldLn) oldLn++;
            sign.textContent = " ";
            txt.textContent = l.startsWith(" ") ? l.slice(1) : l;
          }
          r.append(ln, sign, txt);
          frag.append(r);
        }
        return frag;
      };
      const head = Math.min(lines.length, DIFF_LINE_CAP);
      diffView.append(buildRows(0, head));
      if (head < lines.length) {
        // oldLn/newLn continue from where the head pass stopped.
        const more = btn(`Kalan ${lines.length - head} satırı göster`, "", "", () => more.replaceWith(buildRows(head, lines.length)));
        more.style.margin = "6px 12px";
        diffView.append(more);
      }
    }

    async function loadDiff(file, staged) {
      const gen = ++diffGen;
      selectedPath = file.path;
      selectedStaged = staged;
      hooks.save?.();
      paintListSelection();
      try {
        const diff = await invoke("git_diff", {
          cwd: currentCwd,
          path: file.path,
          staged,
          untracked: !staged && file.untracked,
        });
        if (gen !== diffGen) return;
        renderDiffText(diff, `${file.path} ${staged ? "(Staged)" : file.untracked ? "(Yeni dosya)" : "(Çalışma alanı)"}`);
      } catch (err) {
        if (gen !== diffGen) return;
        diffHead.textContent = file.path;
        diffView.replaceChildren(mk("div", "wpanel-empty", "Fark okunamadı: " + String(err?.message ?? err)));
      }
    }

    function paintListSelection() {
      for (const el of listEl.querySelectorAll(".changes-item")) {
        el.classList.toggle("on", el.dataset.path === selectedPath && (el.dataset.staged === "1") === selectedStaged);
      }
    }

    function makeFileItem(f, stagedSection) {
      const row = mk("div", "changes-item");
      row.dataset.path = f.path;
      row.dataset.staged = stagedSection ? "1" : "0";
      const code = stagedSection ? f.indexStatus : f.untracked ? "U" : f.worktreeStatus;
      const st = mk("span", "changes-st " + code, code === "?" ? "U" : code);
      const pathSpan = mk("span", "changes-path", f.path);
      pathSpan.title = f.path;
      const acts = mk("div", "changes-acts");

      if (stagedSection) {
        const unstage = mk("button", "changes-act", "−");
        unstage.type = "button";
        unstage.title = "Stage'den çıkar (Unstage)";
        unstage.addEventListener("click", (e) => {
          e.stopPropagation();
          runGitAction("unstage", [f.path]);
        });
        acts.append(unstage);
      } else {
        const stage = mk("button", "changes-act", "+");
        stage.type = "button";
        stage.title = "Stage'e ekle (Stage)";
        stage.addEventListener("click", (e) => {
          e.stopPropagation();
          runGitAction("stage", [f.path]);
        });
        const discard = mk("button", "changes-act bad", "↺");
        discard.type = "button";
        discard.title = "Değişiklikleri geri al (Discard)";
        discard.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (await window.kostompConfirmDelete(`"${f.path}" değişiklikleri geri alınsın mı?`, "Bu dosyadaki kaydedilmemiş değişiklikler kalıcı olarak silinecek.")) {
            runGitAction("discard", [f.path]);
          }
        });
        acts.append(stage, discard);
      }

      row.append(st, pathSpan, acts);
      row.addEventListener("click", () => loadDiff(f, stagedSection));
      return row;
    }

    // keepIndex: a row that must be built even past the cut (the selected file).
    function appendFileItems(files, stagedSection, keepIndex) {
      const shown = Math.max(Math.min(files.length, ROW_CAP), keepIndex + 1);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < shown; i++) frag.append(makeFileItem(files[i], stagedSection));
      listEl.append(frag);
      if (shown >= files.length) return;
      const more = mk("div", "changes-item", `${files.length - shown} dosya daha göster`);
      more.addEventListener("click", () => {
        const rest = document.createDocumentFragment();
        for (let i = shown; i < files.length; i++) rest.append(makeFileItem(files[i], stagedSection));
        more.replaceWith(rest);
      });
      listEl.append(more);
    }

    async function refresh() {
      const gen = ++refreshGen;
      currentCwd = currentCwd ?? hooks.cwd();
      cwdBtn.textContent = currentCwd ? "📁 " + folderName(currentCwd) : "📁 Klasör seç";
      cwdBtn.title = currentCwd || "Klasör seç";
      if (!currentCwd) {
        refreshing = false;
        listEl.replaceChildren(mk("div", "wpanel-empty", "Bir proje klasörü seçin."));
        return;
      }
      refreshing = true;
      try {
        const res = await invoke("git_status", { cwd: currentCwd });
        if (gen !== refreshGen) return;
        statusData = res;
        branchBadge.hidden = false;
        const sync = [res.ahead ? `↑${res.ahead}` : "", res.behind ? `↓${res.behind}` : ""].filter(Boolean).join(" ");
        branchBadge.textContent = `⎇ ${res.branch}${sync ? " " + sync : ""}`;
        countBadge.textContent = `${res.files.length} değişiklik`;
        countBadge.className = "wpanel-badge " + (res.files.length ? "warn" : "ok");
        hooks.subTitle(`${res.branch} (${res.files.length})`);
        hooks.status(`${res.branch} · ${res.files.length} değişiklik`, "ok");

        listEl.replaceChildren();
        const stagedFiles = res.files.filter((f) => f.staged);
        const unstagedFiles = res.files.filter((f) => f.unstaged || f.untracked);
        const match = res.files.find((f) => f.path === selectedPath && (selectedStaged ? f.staged : f.unstaged || f.untracked)) ?? res.files[0];
        const matchStaged = !!match && (selectedStaged && match.staged ? true : !match.unstaged && !match.untracked && match.staged);

        if (stagedFiles.length) {
          const sec = mk("div", "changes-sec");
          sec.append(mk("span", "", `Staged (${stagedFiles.length})`));
          const acts = mk("div", "changes-sec-acts");
          const unstageAll = mk("button", "", "Tümünü çıkar");
          unstageAll.type = "button";
          unstageAll.addEventListener("click", () => runGitAction("unstage", []));
          acts.append(unstageAll);
          sec.append(acts);
          listEl.append(sec);
          appendFileItems(stagedFiles, true, match && matchStaged ? stagedFiles.indexOf(match) : -1);
        }

        if (unstagedFiles.length) {
          const sec = mk("div", "changes-sec");
          sec.append(mk("span", "", `Değişiklikler (${unstagedFiles.length})`));
          const acts = mk("div", "changes-sec-acts");
          const stageAll = mk("button", "", "Tümünü ekle");
          stageAll.type = "button";
          stageAll.addEventListener("click", () => runGitAction("stage", []));
          acts.append(stageAll);
          sec.append(acts);
          listEl.append(sec);
          appendFileItems(unstagedFiles, false, match && !matchStaged ? unstagedFiles.indexOf(match) : -1);
        }

        if (!res.files.length) {
          listEl.append(mk("div", "wpanel-empty", "Çalışma ağacı temiz."));
          // A diff still loading for the previous status must not paint over this.
          diffGen++;
          diffHead.textContent = "Değişiklik yok";
          diffView.replaceChildren(mk("div", "wpanel-empty", "Bu depoda kaydedilmemiş değişiklik bulunmuyor."));
          return;
        }

        if (match) loadDiff(match, matchStaged);
      } catch (err) {
        if (gen !== refreshGen) return;
        branchBadge.hidden = true;
        countBadge.textContent = "Git yok";
        countBadge.className = "wpanel-badge bad";
        listEl.replaceChildren(mk("div", "wpanel-empty", String(err?.message ?? err)));
      } finally {
        if (gen === refreshGen) {
          refreshing = false;
          refreshedAt = Date.now();
        }
      }
    }

    refresh();

    return {
      el: root,
      focus: () => commitInput.focus(),
      // Mounting and focus changes land right after the constructor's or a git action's refresh.
      onShow: () => {
        if (refreshing || Date.now() - refreshedAt < 1000) return;
        refresh();
      },
      serialize: () => ({ selectedPath, selectedStaged }),
      dispose: () => {},
    };
  }

  // ===========================================================================
  // 3. Browser / Tarayıcı Panel (Address bar, history, quick dev ports, iframe)
  // ===========================================================================

  function normalizeUrl(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "about:blank";
    if (/^https?:\/\//i.test(s) || s === "about:blank") return s;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(s)) return "http://" + s;
    if (/^:\d+(\/.*)?$/.test(s)) return "http://localhost" + s;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s)) return "https://" + s;
    return "https://www.bing.com/search?q=" + encodeURIComponent(s);
  }

  function createBrowserPanel(hooks, opts) {
    const root = mk("section", "wpanel browser-panel");
    const bar = mk("div", "wpanel-bar");
    const backBtn = btn("←", "ico", "Geri", () => goHistory(-1));
    const fwdBtn = btn("→", "ico", "İleri", () => goHistory(1));
    const reloadBtn = btn("↻", "ico", "Yenile", () => reload());
    const urlInput = mk("input", "wpanel-input");
    urlInput.type = "text";
    urlInput.spellcheck = false;
    urlInput.placeholder = "URL veya localhost:port girin (örn. :3000, http://localhost:5173)…";
    const goBtn = btn("Git", "primary", "Adrese git", () => navigate(urlInput.value));
    const extBtn = btn("↗", "ico", "Varsayılan tarayıcıda aç", () => {
      const u = history[histIndex];
      if (u && /^https?:\/\//i.test(u)) window.kostompOpenUrl?.(u);
    });
    bar.append(backBtn, fwdBtn, reloadBtn, urlInput, goBtn, extBtn);

    const bookmarks = mk("div", "browser-bookmarks");
    const QUICK_LINKS = [
      [":3000", "http://localhost:3000"],
      [":5173", "http://localhost:5173"],
      [":8080", "http://localhost:8080"],
      [":4321", "http://localhost:4321"],
      ["Stats (:3847)", "http://127.0.0.1:3847"],
      ["MDN", "https://developer.mozilla.org"],
      ["Docs.rs", "https://docs.rs"],
    ];
    for (const [label, target] of QUICK_LINKS) {
      const chip = mk("button", "browser-chip", label);
      chip.type = "button";
      chip.title = target;
      chip.addEventListener("click", () => navigate(target));
      bookmarks.append(chip);
    }

    const stage = mk("div", "browser-stage");
    const frame = mk("iframe", "browser-frame");
    frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
    stage.append(frame);
    root.append(bar, bookmarks, stage);

    const initialUrl = opts.state?.url || "http://127.0.0.1:3847";
    let history = [initialUrl];
    let histIndex = 0;

    function syncControls() {
      const cur = history[histIndex] || "";
      urlInput.value = cur;
      backBtn.disabled = histIndex <= 0;
      fwdBtn.disabled = histIndex >= history.length - 1;
      try {
        const u = new URL(cur);
        hooks.subTitle(u.host);
        hooks.status(u.href, "ok");
      } catch {
        hooks.subTitle(cur.slice(0, 24));
      }
      hooks.save?.();
    }

    function navigate(raw, push = true) {
      const url = normalizeUrl(raw);
      if (push && url !== history[histIndex]) {
        history = history.slice(0, histIndex + 1);
        history.push(url);
        histIndex = history.length - 1;
      }
      frame.src = url;
      syncControls();
    }

    function goHistory(delta) {
      const next = histIndex + delta;
      if (next < 0 || next >= history.length) return;
      histIndex = next;
      frame.src = history[histIndex];
      syncControls();
    }

    function reload() {
      const cur = history[histIndex];
      if (cur) frame.src = cur;
    }

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        navigate(urlInput.value);
      }
    });

    navigate(initialUrl, false);

    return {
      el: root,
      focus: () => {
        urlInput.focus();
        urlInput.select();
      },
      onShow: () => {},
      serialize: () => ({ url: history[histIndex] }),
      dispose: () => {
        frame.src = "about:blank";
      },
    };
  }

  // ===========================================================================
  // 4. Files / Dosyalar Panel (Directory tree + file viewer/editor)
  // ===========================================================================

  function createFilesPanel(hooks, opts) {
    const root = mk("section", "wpanel files-panel");
    const bar = mk("div", "wpanel-bar");
    const cwdBtn = btn("", "wpanel-cwd", "Kök klasörü değiştir", async () => {
      const dir = await browseFolder(rootDir);
      if (dir) {
        saveRecent(dir);
        rootDir = dir;
        hooks.setCwd(dir);
        expanded.clear();
        expanded.add(dir);
        refreshTree();
      }
    });
    const filterInput = mk("input", "wpanel-input");
    filterInput.type = "search";
    filterInput.placeholder = "Dosya filtrele…";
    filterInput.style.maxWidth = "200px";
    const hiddenBtn = btn("Gizli", "", "Gizli dosyaları göster/gizle", () => {
      showHidden = !showHidden;
      hiddenBtn.classList.toggle("primary", showHidden);
      hooks.save?.();
      refreshTree();
    });
    const refreshBtn = btn("↻", "ico", "Dosya ağacını yenile", () => refreshTree());
    const viewerBtn = btn("Görüntüleyici", "", "Dosya görüntüleyiciyi göster/gizle", () => setViewerOpen(!viewerOpen));
    bar.append(cwdBtn, filterInput, hiddenBtn, viewerBtn, refreshBtn);

    const body = mk("div", "files-body");
    const treeEl = mk("div", "files-tree");
    const viewCol = mk("div", "files-view");
    const viewHead = mk("div", "files-view-head");
    const viewPath = mk("span", "files-view-path", "Görüntülemek için soldan bir dosya seçin");
    const editBtn = btn("Düzenle", "", "Dosyayı düzenle", () => toggleEdit());
    editBtn.hidden = true;
    const saveBtn = btn("Kaydet (Ctrl+S)", "primary", "Dosyayı kaydet", () => saveFile());
    saveBtn.hidden = true;
    viewHead.append(viewPath, editBtn, saveBtn);
    const viewContent = mk("div", "files-view-body");
    viewContent.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden";
    viewContent.append(mk("div", "wpanel-empty", "Dosya içeriğini görmek veya düzenlemek için ağaçtan bir dosya seçin."));
    viewCol.append(viewHead, viewContent);

    const gutter = mk("div", "files-gutter");
    gutter.title = "Sürükleyerek yeniden boyutlandır (çift tık: sıfırla)";
    body.append(treeEl, gutter, viewCol);
    let treeWidth = Number(opts.state?.treeWidth) || 0;
    const applyTreeWidth = () => {
      if (treeWidth > 0) body.style.setProperty("--files-tree-w", `${treeWidth}px`);
      else body.style.removeProperty("--files-tree-w");
    };
    applyTreeWidth();
    gutter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add("active");
      const left = body.getBoundingClientRect().left;
      const max = () => Math.max(120, body.clientWidth - 160);
      const move = (ev) => {
        treeWidth = Math.round(Math.min(max(), Math.max(120, ev.clientX - left)));
        applyTreeWidth();
      };
      const up = () => {
        gutter.classList.remove("active");
        gutter.removeEventListener("pointermove", move);
        gutter.removeEventListener("pointerup", up);
        gutter.removeEventListener("pointercancel", up);
        hooks.save?.();
      };
      gutter.addEventListener("pointermove", move);
      gutter.addEventListener("pointerup", up);
      gutter.addEventListener("pointercancel", up);
    });
    gutter.addEventListener("dblclick", () => {
      treeWidth = 0;
      applyTreeWidth();
      hooks.save?.();
    });
    root.append(bar, body);

    let rootDir = opts.cwd ?? hooks.cwd() ?? null;
    let showHidden = !!opts.state?.showHidden;
    hiddenBtn.classList.toggle("primary", showHidden);
    let viewerOpen = opts.state?.viewerOpen !== false;
    const applyViewerOpen = () => {
      body.classList.toggle("viewer-closed", !viewerOpen);
      viewerBtn.classList.toggle("primary", viewerOpen);
    };
    const setViewerOpen = (open) => {
      viewerOpen = open;
      applyViewerOpen();
      hooks.save?.();
    };
    applyViewerOpen();
    let selectedFile = opts.state?.selectedFile ?? null;
    const expanded = new Set(Array.isArray(opts.state?.expanded) ? opts.state.expanded : []);
    const dirCache = new Map(); // path -> entries[]
    let currentFileData = null;
    let editing = false;
    let editorArea = null;
    let blobUrl = null;
    let treeGen = 0;
    let treeRefreshing = false;
    let treeRefreshedAt = 0;
    let filterFrame = 0;
    const CODE_LINE_CAP = 3000;

    filterInput.addEventListener("input", () => {
      if (filterFrame) return;
      filterFrame = requestAnimationFrame(() => {
        filterFrame = 0;
        paintTree();
      });
    });

    async function loadDirEntries(dirPath) {
      try {
        const res = await invoke("fs_list", { path: dirPath, showHidden });
        dirCache.set(dirPath, res.entries || []);
      } catch (err) {
        dirCache.set(dirPath, [{ error: String(err?.message ?? err) }]);
      }
    }

    async function refreshTree() {
      const gen = ++treeGen;
      rootDir = rootDir ?? hooks.cwd();
      cwdBtn.textContent = rootDir ? "📁 " + folderName(rootDir) : "📁 Klasör seç";
      cwdBtn.title = rootDir || "Klasör seç";
      if (!rootDir) {
        treeRefreshing = false;
        treeEl.replaceChildren(mk("div", "wpanel-empty", "Bir proje klasörü seçin."));
        return;
      }
      hooks.subTitle(folderName(rootDir));
      hooks.status(rootDir, "ok");
      expanded.add(rootDir);
      dirCache.clear();
      treeRefreshing = true;
      await Promise.all([...expanded].map((d) => loadDirEntries(d)));
      if (gen !== treeGen) return;
      treeRefreshing = false;
      treeRefreshedAt = Date.now();
      paintTree();
      if (selectedFile && !currentFileData) openFile(selectedFile);
    }

    // Right-click menu on tree rows (and the empty area, for the root): open in Windows Explorer.
    let treeMenu = null;
    function closeTreeMenu() {
      if (!treeMenu) return;
      treeMenu.remove();
      treeMenu = null;
      document.removeEventListener("pointerdown", onTreeMenuOutside, true);
      document.removeEventListener("keydown", onTreeMenuKey, true);
      window.removeEventListener("blur", closeTreeMenu);
    }
    function onTreeMenuOutside(e) {
      if (treeMenu && !treeMenu.contains(e.target)) closeTreeMenu();
    }
    function onTreeMenuKey(e) {
      if (e.key === "Escape") closeTreeMenu();
    }
    function openTreeMenu(ev, targetPath) {
      ev.preventDefault();
      ev.stopPropagation();
      closeTreeMenu();
      const menu = mk("div", "folder-menu glass");
      menu.setAttribute("role", "menu");
      const item = mk("button", "folder-item", "Explorer'da aç");
      item.type = "button";
      item.title = targetPath;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", async () => {
        closeTreeMenu();
        try {
          await invoke("reveal_in_explorer", { path: targetPath });
        } catch (err) {
          hooks.status?.("Explorer açılamadı: " + String(err?.message ?? err), "err");
        }
      });
      menu.append(item);
      document.body.append(menu);
      menu.style.left = Math.max(8, Math.min(ev.clientX, innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(ev.clientY, innerHeight - menu.offsetHeight - 8)) + "px";
      treeMenu = menu;
      document.addEventListener("pointerdown", onTreeMenuOutside, true);
      document.addEventListener("keydown", onTreeMenuKey, true);
      window.addEventListener("blur", closeTreeMenu);
      item.focus();
    }
    treeEl.addEventListener("contextmenu", (ev) => {
      if (rootDir) openTreeMenu(ev, rootDir);
    });

    function paintTree() {
      treeEl.replaceChildren();
      if (!rootDir) return;
      const q = filterInput.value.trim().toLowerCase();
      const frag = document.createDocumentFragment();

      const renderEntries = (dirPath, depth) => {
        const entries = dirCache.get(dirPath) || [];
        for (const e of entries) {
          if (e.error) {
            const errRow = mk("div", "wpanel-empty", e.error);
            frag.append(errRow);
            continue;
          }
          const isOpen = e.isDir && expanded.has(e.path);
          if (q && !e.isDir && !e.name.toLowerCase().includes(q)) continue;
          const row = mk("div", "files-row" + (e.path === selectedFile ? " on" : ""));
          row.style.paddingLeft = 8 + depth * 14 + "px";
          const chev = mk("span", "files-chev", e.isDir ? (isOpen ? "▾" : "▸") : "");
          const ico = mk("span", "files-ico " + (e.isDir ? "dir" : "file"));
          const name = mk("span", "files-name", e.name);
          name.title = e.path;
          row.append(chev, ico, name);
          if (!e.isDir) {
            row.append(mk("span", "files-size", fmtBytes(e.size)));
          }
          row.addEventListener("click", async () => {
            if (e.isDir) {
              if (expanded.has(e.path)) {
                expanded.delete(e.path);
              } else {
                expanded.add(e.path);
                if (!dirCache.has(e.path)) await loadDirEntries(e.path);
              }
              hooks.save?.();
              paintTree();
            } else {
              if (!viewerOpen) setViewerOpen(true);
              openFile(e.path);
            }
          });
          row.addEventListener("contextmenu", (ev) => openTreeMenu(ev, e.path));
          frag.append(row);
          if (isOpen) renderEntries(e.path, depth + 1);
        }
      };

      renderEntries(rootDir, 0);
      treeEl.append(frag);
    }

    async function openFile(filePath) {
      selectedFile = filePath;
      editing = false;
      editBtn.textContent = "Düzenle";
      saveBtn.hidden = true;
      hooks.save?.();
      paintTree();
      viewPath.textContent = filePath;
      viewPath.title = filePath;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }

      const ext = extOf(filePath);
      if (IMAGE_EXTS.has(ext)) {
        editBtn.hidden = true;
        try {
          const buf = await invoke("read_image", { path: filePath });
          if (selectedFile !== filePath) return;
          // Reopening the same file can leave an earlier read's URL in place.
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          blobUrl = URL.createObjectURL(new Blob([buf], { type: "image/" + (ext === "jpg" ? "jpeg" : ext) }));
          const wrap = mk("div", "files-img-wrap");
          const img = mk("img");
          img.src = blobUrl;
          img.alt = filePath;
          wrap.append(img);
          viewContent.replaceChildren(wrap);
        } catch (err) {
          if (selectedFile !== filePath) return;
          viewContent.replaceChildren(mk("div", "wpanel-empty", "Resim okunamadı: " + String(err?.message ?? err)));
        }
        return;
      }

      try {
        const data = await invoke("fs_read", { path: filePath });
        if (selectedFile !== filePath) return;
        currentFileData = data;
        if (data.binary) {
          editBtn.hidden = true;
          viewContent.replaceChildren(mk("div", "wpanel-empty", `İkili (binary) dosya · ${fmtBytes(data.size)}`));
          return;
        }
        editBtn.hidden = data.truncated;
        renderCodeView(data);
      } catch (err) {
        if (selectedFile !== filePath) return;
        editBtn.hidden = true;
        viewContent.replaceChildren(mk("div", "wpanel-empty", "Dosya okunamadı: " + String(err?.message ?? err)));
      }
    }

    function renderCodeView(data) {
      const pre = mk("div", "files-code");
      const lines = data.content.replace(/\r\n/g, "\n").split("\n");
      let shown = Math.min(lines.length, CODE_LINE_CAP);
      let tokenLines = null;
      const buildRows = (from, to) => {
        const frag = document.createDocumentFragment();
        for (let i = from; i < to; i++) {
          const row = mk("div", "files-code-row");
          row.append(mk("span", "files-code-ln", String(i + 1)));
          const toks = tokenLines?.[i];
          if (toks && toks.length) {
            for (const t of toks) {
              if (t.kind && /^[a-z]+$/.test(t.kind)) row.append(mk("span", "hl-" + t.kind, t.text));
              else row.append(document.createTextNode(t.text));
            }
          } else {
            row.append(document.createTextNode(lines[i]));
          }
          frag.append(row);
        }
        return frag;
      };
      const paintLines = () => {
        const frag = buildRows(0, shown);
        if (shown < lines.length) {
          const more = btn(`Tüm ${lines.length} satırı göster`, "", "", () => {
            const from = shown;
            shown = lines.length;
            more.replaceWith(buildRows(from, shown));
          });
          more.style.margin = "6px 14px";
          frag.append(more);
        }
        pre.replaceChildren(frag);
      };
      paintLines();
      viewContent.replaceChildren(pre);

      const lang = extOf(data.name);
      if (lang && data.content.length < 150000 && hooks.highlight) {
        hooks.highlight(data.content, lang).then((tokens) => {
          if (!tokens || editing || selectedFile !== data.path) return;
          const byLine = [[]];
          for (const t of tokens) {
            String(t.text ?? "").replace(/\r\n/g, "\n").split("\n").forEach((part, idx) => {
              if (idx) byLine.push([]);
              if (part) byLine[byLine.length - 1].push({ text: part, kind: t.kind });
            });
          }
          tokenLines = byLine;
          paintLines();
        });
      }
    }

    function toggleEdit() {
      if (!currentFileData || currentFileData.binary) return;
      editing = !editing;
      if (editing) {
        editBtn.textContent = "Vazgeç";
        saveBtn.hidden = false;
        editorArea = mk("textarea", "files-editor");
        editorArea.spellcheck = false;
        editorArea.value = currentFileData.content;
        editorArea.addEventListener("keydown", (e) => {
          if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
            e.preventDefault();
            saveFile();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const start = editorArea.selectionStart;
            const end = editorArea.selectionEnd;
            editorArea.setRangeText("\t", start, end, "end");
          }
        });
        viewContent.replaceChildren(editorArea);
        editorArea.focus();
      } else {
        editBtn.textContent = "Düzenle";
        saveBtn.hidden = true;
        renderCodeView(currentFileData);
      }
    }

    async function saveFile() {
      if (!editing || !editorArea || !currentFileData) return;
      saveBtn.disabled = true;
      try {
        const nextText = editorArea.value;
        await invoke("fs_write", { path: currentFileData.path, content: nextText });
        currentFileData.content = nextText;
        editing = false;
        editBtn.textContent = "Düzenle";
        saveBtn.hidden = true;
        renderCodeView(currentFileData);
        hooks.status(`Kaydedildi: ${currentFileData.name}`, "ok");
      } catch (err) {
        hooks.status("Kaydetme hatası: " + String(err?.message ?? err), "bad");
      } finally {
        saveBtn.disabled = false;
      }
    }

    refreshTree();

    return {
      el: root,
      focus: () => (editing && editorArea ? editorArea.focus() : filterInput.focus()),
      // Mounting and focus changes land right after the constructor's or a toolbar refresh.
      onShow: () => {
        if (treeRefreshing || Date.now() - treeRefreshedAt < 1000) return;
        refreshTree();
      },
      serialize: () => ({
        selectedFile,
        showHidden,
        treeWidth,
        viewerOpen,
        expanded: [...expanded].slice(0, 40),
      }),
      dispose: () => {
        cancelAnimationFrame(filterFrame);
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      },
    };
  }

  // ===========================================================================
  // Factory
  // ===========================================================================

  window.createWorkspacePanel = (sid, kind, hooks = {}, opts = {}) => {
    switch (kind) {
      case "terminal":
        return createTerminalPanel(sid, hooks, opts);
      case "changes":
        return createChangesPanel(hooks, opts);
      case "browser":
        return createBrowserPanel(hooks, opts);
      case "files":
        return createFilesPanel(hooks, opts);
      default:
        return createTerminalPanel(sid, hooks, opts);
    }
  };
})();
