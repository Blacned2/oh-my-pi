// One chat session: its own omp process (by id), transcript, composer, palette and usage ledger.
// Shared, stateless helpers (markdown, thumbnails, lightbox, formatters) live at module level;
// everything stateful is created per call of createSession().
(() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);
  const { browseFolder, folderName, loadRecent, saveRecent, clearRecent, MAX_IMAGE_BYTES } = window.KostompFolders;

  // ---- shared helpers ---------------------------------------------------
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  // A file dropped outside a composer must not navigate the shell to it.
  for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => { if (hasFiles(e)) e.preventDefault(); });
  const pretty = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  function textOf(content) {
    if (typeof content === "string") return content;
    return (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  const LABELS_TAIL = /(?:\n*[ \t]*\[Image \d+\])+\s*$/;
  const imageSrc = (img) => `data:${img.mimeType};base64,${img.data}`;
  const lightbox = { root: $("lightbox"), img: $("lightbox-img"), cap: $("lightbox-cap") };
  let lightboxOpener = null; // element focused before the preview opened
  function openLightbox(src, label) {
    lightboxOpener = document.activeElement;
    lightbox.img.src = src;
    lightbox.img.alt = label;
    lightbox.cap.textContent = label;
    lightbox.root.hidden = false;
    $("lightbox-close").focus();
  }
  function closeLightbox() {
    lightbox.root.hidden = true;
    lightbox.img.removeAttribute("src");
    if (lightboxOpener?.isConnected) lightboxOpener.focus();
    lightboxOpener = null;
  }
  lightbox.root.addEventListener("click", (e) => {
    if (e.target !== lightbox.img) closeLightbox(); // backdrop, caption area or the × button
  });
  // Capture phase: Esc closes the preview before the composer's Esc-to-abort sees it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.root.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeLightbox();
    }
  }, true);
  /** A numbered thumbnail button; clicking opens the large preview. `onRemove` adds a × (composer only). */
  function thumb(src, num, onRemove) {
    const label = "Image " + num;
    const b = document.createElement("span");
    b.className = "thumb";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "thumb-open";
    open.style.cssText = "all:unset;cursor:zoom-in;display:block;line-height:0";
    open.title = label + " — click to enlarge";
    open.setAttribute("aria-label", "Open " + label);
    const img = document.createElement("img");
    img.src = src;
    img.alt = label;
    open.append(img);
    open.addEventListener("click", () => openLightbox(src, label));
    const n = span("num", String(num));
    b.append(open, n);
    if (onRemove) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.textContent = "×";
      rm.title = "Remove " + label;
      rm.setAttribute("aria-label", "Remove " + label);
      rm.addEventListener("click", onRemove);
      b.append(rm);
    }
    return b;
  }

  // ---- links: open in the system browser (Rust `open_url`, http/https only); copy as fallback ----
  function copyLink(url, onNote) {
    const p = navigator.clipboard?.writeText(url);
    if (p) p.then(() => onNote?.("Link copied: " + url), () => onNote?.("Could not copy the link: " + url));
    else onNote?.("Could not copy the link: " + url);
  }
  function openUrl(url, onNote) {
    return invoke("open_url", { url }).then(
      () => true,
      (e) => {
        onNote?.("Could not open the link (" + String(e) + "). Copying it instead.");
        copyLink(url, onNote);
        return false;
      },
    );
  }
  window.kostompOpenUrl = openUrl;

  // ---- markdown (DOM-built, never innerHTML, so model output cannot inject markup) ----
  // Groups: 1 code, 2 bold, 3 em, 4 strike, 5 [label](url), 6 bare http(s) URL.
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"])/g;
  /** An http(s) link that opens in the system browser (navigating would replace the shell itself). */
  function linkNode(url, label, onCopied) {
    if (!/^https?:\/\//i.test(url)) return document.createTextNode(label);
    const node = document.createElement("a");
    node.href = url;
    node.textContent = label;
    node.title = url + " — click to open in the browser, right-click to copy";
    node.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(url, onCopied);
    });
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      copyLink(url, onCopied);
    });
    return node;
  }
  function inline(parent, text, onCopied) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const t = m[0];
      let node;
      if (m[1]) {
        node = document.createElement("code");
        node.textContent = t.slice(1, -1);
      } else if (m[2]) {
        node = document.createElement("strong");
        node.textContent = t.slice(2, -2);
      } else if (m[3]) {
        node = document.createElement("em");
        node.textContent = t.slice(1, -1);
      } else if (m[4]) {
        node = document.createElement("del");
        node.textContent = t.slice(2, -2);
      } else if (m[5]) {
        const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
        node = /^https?:\/\//i.test(url) ? linkNode(url, label, onCopied) : document.createTextNode(t);
      } else {
        node = linkNode(t, t, onCopied);
      }
      parent.append(node);
      last = m.index + t.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }
  // ---- syntax highlighting: omp's highlight_code tokens, styled with theme classes (hl-<kind>) ----
  const HL_MAX_CHARS = 200000;
  const HL_CACHE_MAX = 300;
  const hlCache = new Map(); // `${lang}\0${code}` -> { tokens } once answered, { promise } while asked
  let hlUnsupported = false; // an omp without highlight_code: stop asking
  /** Resolves with the token list, or null (no language, too big, an older omp, a failure). */
  function highlight(code, lang) {
    if (hlUnsupported || !lang || !code || code.length > HL_MAX_CHARS) return Promise.resolve(null);
    const key = lang + "\0" + code;
    const hit = hlCache.get(key);
    if (hit) return hit.promise ?? Promise.resolve(hit.tokens);
    const entry = {};
    entry.promise = request("highlight_code", { code, lang }, 5000).then(
      (data) => {
        const list = data && Array.isArray(data.tokens) ? data.tokens.filter((t) => t && typeof t.text === "string") : null;
        if (hlCache.get(key) === entry) hlCache.set(key, { tokens: list });
        return list;
      },
      (e) => {
        if (/unknown command/i.test(String(e?.message ?? e))) hlUnsupported = true;
        hlCache.delete(key);
        return null;
      },
    );
    hlCache.set(key, entry);
    if (hlCache.size > HL_CACHE_MAX) hlCache.delete(hlCache.keys().next().value);
    return entry.promise;
  }
  /** Tokens already answered for this code, so a repaint colors at once instead of flashing plain text. */
  const highlightedNow = (code, lang) => (lang && code ? hlCache.get(lang + "\0" + code)?.tokens : undefined);
  const HL_KIND = /^[a-z]+$/;
  const hlNode = (t) => (typeof t.kind === "string" && HL_KIND.test(t.kind) ? span("hl-" + t.kind, t.text) : document.createTextNode(t.text));
  /** Split tokens at newlines into one token list per line. */
  function tokenLines(tokens) {
    const lines = [[]];
    for (const t of tokens) {
      String(t.text).replace(/\r\n/g, "\n").split("\n").forEach((part, i) => {
        if (i) lines.push([]);
        if (part) lines[lines.length - 1].push({ text: part, kind: t.kind });
      });
    }
    return lines;
  }
  /** A file's language for highlight_code: its extension, else its lowercased name (Makefile, Dockerfile). */
  const langOfPath = (p) => {
    const name = String(p ?? "").split(/[\\/]/).pop() ?? "";
    const ext = /\.([A-Za-z0-9_+-]+)$/.exec(name);
    return ext ? ext[1].toLowerCase() : name.toLowerCase();
  };
  /** A fenced code block: language label + copy button over the code. `closed`: the fence ended (not streaming). */
  function codeBlock(lang, code, closed = true) {
    const box = document.createElement("div");
    box.className = "codeblock";
    const bar = document.createElement("div");
    bar.className = "codebar";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "link";
    copy.textContent = "copy";
    copy.title = "Copy the code";
    copy.addEventListener("click", () => {
      const p = navigator.clipboard?.writeText(code);
      const done = (t) => {
        copy.textContent = t;
        setTimeout(() => (copy.textContent = "copy"), 1200);
      };
      if (p) p.then(() => done("copied"), () => done("copy failed"));
      else done("copy failed");
    });
    bar.append(span("lang", lang || "text"), copy);
    const pre = document.createElement("pre");
    const c = document.createElement("code");
    const ready = highlightedNow(code, lang);
    if (ready) c.append(...ready.map(hlNode));
    else {
      c.textContent = code;
      // Only a finished fence: a streaming one changes with every delta.
      if (closed && lang) highlight(code, lang).then((tokens) => {
        if (tokens && tokens.length && c.textContent === code) c.replaceChildren(...tokens.map(hlNode));
      });
    }
    pre.append(c);
    box.append(bar, pre);
    return box;
  }
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  function table(head, sep, body, onCopied) {
    const align = tableCells(sep).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
    const wrap = document.createElement("div");
    wrap.className = "md-table";
    const t = document.createElement("table");
    const row = (cells, tag) => {
      const tr = document.createElement("tr");
      head.forEach((_, i) => {
        const cell = document.createElement(tag);
        if (align[i]) cell.style.textAlign = align[i];
        inline(cell, cells[i] ?? "", onCopied);
        tr.append(cell);
      });
      return tr;
    };
    const thead = document.createElement("thead");
    thead.append(row(head, "th"));
    const tbody = document.createElement("tbody");
    for (const r of body) tbody.append(row(r, "td"));
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }
  function markdown(text, onCopied) {
    const root = document.createElement("div");
    root.className = "md";
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    let para = null;
    let list = null;
    const flush = () => { para = null; list = null; };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```(\S*)\s*$/.exec(line);
      if (fence) {
        flush();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        const closed = i < lines.length;
        i++; // closing fence (or EOF while streaming)
        root.append(codeBlock(fence[1], code.join("\n"), closed));
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flush();
        const head = tableCells(line);
        const sep = lines[i + 1];
        const body = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(tableCells(lines[i++]));
        root.append(table(head, sep, body, onCopied));
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ""));
        const q = document.createElement("blockquote");
        q.append(...markdown(quoted.join("\n"), onCopied).childNodes);
        root.append(q);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const hr = /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) {
        flush();
        const e = document.createElement("h" + Math.min(h[1].length + 2, 6));
        inline(e, h[2], onCopied);
        root.append(e);
      } else if (hr) {
        flush();
        root.append(document.createElement("hr"));
      } else if (li) {
        const ordered = /\d/.test(li[1]);
        if (!list || list.tagName !== (ordered ? "OL" : "UL")) {
          para = null;
          list = document.createElement(ordered ? "ol" : "ul");
          root.append(list);
        }
        const item = document.createElement("li");
        const task = /^\[([ xX])\]\s+(.*)$/.exec(li[2]);
        if (task) {
          const box = document.createElement("input");
          box.type = "checkbox";
          box.disabled = true;
          box.checked = task[1] !== " ";
          item.className = "task";
          item.append(box, " ");
          inline(item, task[2], onCopied);
        } else {
          inline(item, li[2], onCopied);
        }
        list.append(item);
      } else if (!line.trim()) {
        flush();
      } else {
        list = null;
        if (!para) {
          para = document.createElement("p");
          root.append(para);
        } else {
          para.append(document.createElement("br"));
        }
        inline(para, line, onCopied);
      }
      i++;
    }
    return root;
  }

  // ---- tool cards: per-tool summary line and body (clipped blocks, line gutters, diffs, images) ----
  const TODO_MARK = { pending: "○", in_progress: "◐", completed: "●", abandoned: "⊘", blocked: "⚠" };
  const TOOL_LINES = 30; // rows shown before "show all"
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = (v) => (typeof v === "string" ? v : "");
  const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const splitLines = (text) => String(text ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  function row(cls, ...parts) {
    const r = span("row" + (cls ? " " + cls : ""));
    r.append(...parts);
    return r;
  }
  // While a card body is being built, which of its blocks the user expanded ("show all"), keyed by
  // block order, so a repaint (streamed output, a result arriving) keeps them expanded.
  let blockMemo = null;
  let blockSeq = 0;
  /**
   * A monospace block of rows: the first (or, with `tail`, the last) TOOL_LINES, plus a "show all" link.
   * `box.update(items)` takes a longer list whose old rows are unchanged but the last, and appends.
   */
  function rowsBlock(items, render, { tail = false, cls = "" } = {}) {
    const box = document.createElement("div");
    box.className = "tool-block" + (cls ? " " + cls : "");
    const pre = document.createElement("pre");
    box.append(pre);
    const memo = blockMemo;
    const key = blockSeq++;
    let all = !!memo?.has(key);
    const paint = (showAll) => {
      if (showAll && !all) memo?.add(key);
      all = showAll;
      const cut = !all && items.length > TOOL_LINES;
      const shown = !cut ? items : tail ? items.slice(-TOOL_LINES) : items.slice(0, TOOL_LINES);
      pre.replaceChildren(...shown.map(render));
      for (const b of box.querySelectorAll(":scope > .more")) b.remove();
      if (!cut) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link more";
      const hidden = items.length - TOOL_LINES;
      b.textContent = tail ? `▴ ${plural(hidden, "earlier line")}` : `▾ ${plural(hidden, "more line")}`;
      b.title = `Show all ${items.length} lines`;
      b.addEventListener("click", () => paint(true));
      if (tail) box.prepend(b);
      else box.append(b);
    };
    paint(all);
    /** Same rows, new rendering (e.g. highlighting arrived): repaint, keeping "show all". */
    box.repaint = (next) => {
      items = next;
      paint(all);
    };
    box.update = (next) => {
      const prev = items.length;
      items = next;
      if (!all && items.length > TOOL_LINES) return paint(false); // a clipped view: only TOOL_LINES rows
      pre.lastChild?.remove(); // the last line may have grown
      pre.append(...items.slice(Math.max(0, prev - 1)).map(render));
    };
    return box;
  }
  // ---- ANSI SGR in tool output (bold, colors...) -> styled spans; every other escape is dropped ----
  // A line is a plain string, or (when escapes are present) a list of segments: { t, b, d, i, u, s, v, fg, bg }.
  // fg/bg: 0-15 = palette class, else a CSS color (256-color cube or truecolor). Style carries across lines.
  const ANSI_ESC = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g;
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
      else if (c === 21 || c === 22) delete st.b, delete st.d;
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
        } else break; // malformed: ignore the rest of this sequence
      }
    }
  }
  function ansiLines(text) {
    const lines = splitLines(text);
    if (!String(text ?? "").includes("\x1b")) return lines;
    const st = {};
    return lines.map((line) => {
      if (!line.includes("\x1b")) return Object.keys(st).length ? [{ t: line, ...st }] : line;
      const segs = [];
      let last = 0;
      for (const m of line.matchAll(ANSI_ESC)) {
        if (m.index > last) segs.push({ t: line.slice(last, m.index), ...st });
        last = m.index + m[0].length;
        if (m[2] === "m") applySgr(st, m[1]);
      }
      if (last < line.length) segs.push({ t: line.slice(last), ...st });
      return segs;
    });
  }
  /** DOM nodes for one ansiLines() line. */
  function ansiNodes(line) {
    if (typeof line === "string") return [line];
    return line.map((g) => {
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
      if (!names && !custom) return document.createTextNode(g.t);
      const s = span(names, g.t);
      if (typeof fg === "string" && !fg.startsWith("inv")) s.style.color = fg;
      if (typeof bg === "string" && !bg.startsWith("inv")) s.style.backgroundColor = bg;
      return s;
    });
  }
  const textRows = (text, opts) => rowsBlock(ansiLines(text), (l) => row("", ...ansiNodes(l)), opts);
  /** File text with a line-number gutter; `numbers[i]` (null = no number) wins over `start + i`. */
  function numberedRows(text, start, numbers, opts, lang) {
    const first = Number.isFinite(start) ? start : 1;
    const items = splitLines(text).map((l, i) => [Array.isArray(numbers) && i < numbers.length ? numbers[i] : first + i, l, null]);
    // Highlighted lines replace the plain ones only when they line up one to one.
    const withTokens = (tokens) => {
      const lines = tokenLines(tokens);
      if (lines.length === items.length + 1 && !lines[lines.length - 1].length) lines.pop();
      return lines.length === items.length ? items.map(([n, l], i) => [n, l, lines[i]]) : null;
    };
    const code = String(text ?? "").replace(/\r\n/g, "\n");
    const ready = highlightedNow(code, lang);
    const box = rowsBlock((ready && withTokens(ready)) || items, ([n, l, toks]) => row("num", span("ln", n == null ? "" : String(n)), ...(toks ? toks.map(hlNode) : [l])), opts);
    if (!ready && lang) highlight(code, lang).then((tokens) => {
      const next = tokens && withTokens(tokens);
      if (next && box.isConnected) box.repaint(next);
    });
    return box;
  }
  // omp's edit diff: `<+|-| ><lineNo>|<text>` per line, `...` rows between hunks, no @@ headers.
  const DIFF_LINE = /^([+\-\s])(\s*\d+)\|(.*)$/;
  const DIFF_SIGN = { add: "+", del: "-", ctx: " ", meta: "" };
  function parseDiff(diff) {
    const rows = [];
    let add = 0;
    let del = 0;
    for (const l of splitLines(diff)) {
      const m = DIFF_LINE.exec(l);
      if (!m) {
        rows.push({ kind: "meta", num: "", text: l });
        continue;
      }
      const kind = m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx";
      if (kind === "add") add++;
      else if (kind === "del") del++;
      rows.push({ kind, num: m[2].trim(), text: m[3] });
    }
    return { rows, add, del };
  }
  /** Patch-like text (an edit's arguments before the result): +/- lines colored, the rest context. */
  const patchRows = (text) =>
    splitLines(text).map((l) => ({
      kind: /^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@/.test(l) ? "meta" : "ctx",
      num: "",
      text: l,
    }));
  // Word-level diff: a run of removed lines followed by a run of added ones is paired line by line,
  // and the words that differ (LCS over word/space/punctuation tokens) get a stronger background.
  const WORD = /\w+|\s+|[^\w\s]/g;
  const WD_MAX = 300; // tokens per line; longer lines keep the whole-line coloring
  function lcsChanged(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ca = new Array(n).fill(true);
    const cb = new Array(m).fill(true);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ca[i++] = false;
        cb[j++] = false;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return { ca, cb, same: dp[0][0] };
  }
  function segments(tokens, changed) {
    const segs = [];
    tokens.forEach((t, i) => {
      const last = segs[segs.length - 1];
      if (last && last.changed === changed[i]) last.t += t;
      else segs.push({ t, changed: changed[i] });
    });
    return segs;
  }
  function withWordDiff(rows) {
    const out = rows.slice();
    let i = 0;
    while (i < out.length) {
      if (out[i].kind !== "del") {
        i++;
        continue;
      }
      let d = i;
      while (d < out.length && out[d].kind === "del") d++;
      let a = d;
      while (a < out.length && out[a].kind === "add") a++;
      for (let k = 0; k < Math.min(d - i, a - d); k++) {
        const x = out[i + k];
        const y = out[d + k];
        const ta = String(x.text).match(WORD) ?? [];
        const tb = String(y.text).match(WORD) ?? [];
        if (!ta.length || !tb.length || ta.length > WD_MAX || tb.length > WD_MAX) continue;
        const { ca, cb, same } = lcsChanged(ta, tb);
        // Lines that share little are a rewrite, not an edit: keep the whole-line coloring.
        if (same * 3 < Math.max(ta.length, tb.length) || (!ca.some(Boolean) && !cb.some(Boolean))) continue;
        out[i + k] = { ...x, segs: segments(ta, ca) };
        out[d + k] = { ...y, segs: segments(tb, cb) };
      }
      i = Math.max(a, i + 1);
    }
    return out;
  }
  const diffText = (r) => (r.segs ? r.segs.map((s) => (s.changed ? span("wd", s.t) : document.createTextNode(s.t))) : [r.text]);
  const diffBlock = (rows) => rowsBlock(withWordDiff(rows), (r) => row("diff " + r.kind, span("ln", r.num), span("sign", DIFF_SIGN[r.kind]), ...diffText(r)));
  const imagesOf = (list) =>
    Array.isArray(list) ? list.filter((b) => isObj(b) && (b.type === "image" || b.type === undefined) && typeof b.data === "string" && typeof b.mimeType === "string") : [];
  /** Image thumbnails that open the large preview (tool output, assistant images). */
  function imageRow(images, label) {
    const box = document.createElement("div");
    box.className = "msg-images";
    images.forEach((img, i) => {
      const src = imageSrc(img);
      const name = images.length > 1 ? `${label} ${i + 1}` : label;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "thumb tool-img";
      b.title = name + " — click to enlarge";
      b.setAttribute("aria-label", "Open " + name);
      const im = document.createElement("img");
      im.src = src;
      im.alt = name;
      b.append(im);
      b.addEventListener("click", () => openLightbox(src, name));
      box.append(b);
    });
    return box;
  }
  const dimRow = (text) => {
    const d = document.createElement("div");
    d.className = "tool-note";
    d.textContent = text;
    return d;
  };
  const resultParts = (res) => {
    const content = isObj(res) && Array.isArray(res.content) ? res.content : null;
    return {
      details: isObj(res) && isObj(res.details) ? res.details : {},
      text: res === undefined ? "" : content ? textOf(content) : pretty(res),
      images: imagesOf(content),
    };
  };
  /** One-line argument shown after the tool name: the command, path, pattern, query... */
  function toolArg(name, a) {
    if (!isObj(a)) return "";
    switch (name) {
      case "bash":
        return str(a.command) ? "$ " + flat(a.command) : "";
      case "grep":
      case "ast_grep":
        return [str(a.pattern) && flat(a.pattern), str(a.path) && "in " + a.path].filter(Boolean).join(" ");
      case "find":
        return flat(str(a.query));
      case "task": {
        const tasks = Array.isArray(a.tasks) ? a.tasks.length : 0;
        return [str(a.agent), tasks > 1 ? plural(tasks, "task") : flat(str(a.task) || str(a.description))].filter(Boolean).join(" · ");
      }
      case "eval":
        return str(a.title) || str(a.language);
      case "todo":
        return str(a.op);
    }
    for (const k of ["path", "file", "url", "query", "command", "pattern", "name"]) if (str(a[k])) return flat(a[k]);
    return "";
  }
  /** Edit-like tools report a `diff` (or one per file); counts for the badge, rows for the body. */
  function editDiffs(details) {
    const per = Array.isArray(details.perFileResults) ? details.perFileResults.filter(isObj) : [];
    if (per.length) return per.map((f) => ({ path: str(f.path), ...parseDiff(str(f.diff)), empty: !str(f.diff), error: f.isError ? str(f.errorText) || "failed" : "" }));
    return str(details.diff) ? [{ path: "", ...parseDiff(details.diff), empty: false, error: "" }] : [];
  }
  /** Short result facts for the summary: exit code, +/- counts, match counts. `kind` colors it. */
  function toolBadge(c) {
    const res = c.result ?? c.partial;
    if (res === undefined) return null;
    const { details: d } = resultParts(res);
    const n = (v) => (Number.isFinite(v) ? v : null);
    switch (c.toolName) {
      case "bash":
        if (d.timedOut) return { text: "timed out", kind: "bad" };
        if (d.cancelled === true) return { text: "cancelled", kind: "bad" };
        if (n(d.exitCode) != null && d.exitCode !== 0) return { text: "exit " + d.exitCode, kind: "bad" };
        return n(d.wallTimeMs) != null && c.done ? { text: (d.wallTimeMs / 1000).toFixed(1) + "s", kind: "" } : null;
      case "read":
        return n(d.totalLines) != null ? { text: plural(d.totalLines, "line"), kind: "" } : null;
      case "grep":
      case "ast_grep":
        if (n(d.matchCount) == null) return null;
        return { text: `${d.matchCount} ${d.matchCount === 1 ? "match" : "matches"}` + (n(d.fileCount) != null ? " in " + plural(d.fileCount, "file") : ""), kind: "" };
      case "glob":
        return n(d.fileCount) != null ? { text: plural(d.fileCount, "file") + (d.truncated ? "+" : ""), kind: "" } : null;
      case "task":
        return n(d.totalDurationMs) != null && c.done ? { text: (d.totalDurationMs / 1000).toFixed(1) + "s", kind: "" } : null;
    }
    const diffs = editDiffs(d);
    if (!diffs.length) return null;
    const add = diffs.reduce((s, f) => s + f.add, 0);
    const del = diffs.reduce((s, f) => s + f.del, 0);
    return { text: `+${add} −${del}`, kind: "diff" };
  }
  /** The card body for one tool, from its arguments and its (partial or final) result. */
  function toolBody(c, onNote) {
    const a = isObj(c.args) ? c.args : {};
    const res = c.result ?? c.partial;
    const { details: d, text, images } = resultParts(res);
    const out = [];
    const errOut = () => text && out.push(textRows(text, { cls: "err" }));
    switch (c.toolName) {
      case "bash": {
        const cmd = str(a.command);
        if (cmd.includes("\n") || cmd.length > 100) out.push(textRows(cmd, { cls: "cmd" }));
        if (text) {
          const block = textRows(text, { tail: true, cls: c.isError ? "err" : "" });
          out.push(block);
          // Streaming: later partials that only extend this text are appended (see liveAppend).
          if (!c.done) c.live = { block, text, truncated: d.truncated === true };
        } else if (c.done) out.push(dimRow("(no output)"));
        if (d.truncated === true) {
          const total = Number.isFinite(d.totalLines) ? " of " + plural(d.totalLines, "line") : "";
          out.push(dimRow("output truncated" + total + (str(d.artifactId) ? " · full output: artifact " + d.artifactId : "")));
        }
        return out;
      }
      case "read": {
        if (images.length) out.push(imageRow(images, str(a.path) || "image"));
        const dc = isObj(d.displayContent) ? d.displayContent : null;
        if (c.isError) errOut();
        else if (dc && typeof dc.text === "string") out.push(numberedRows(dc.text, dc.startLine, dc.lineNumbers, undefined, c.done ? langOfPath(a.path) : ""));
        else if (text && !images.length) out.push(textRows(text));
        else if (text) out.push(dimRow(text));
        return out;
      }
      case "write":
        if (c.isError) errOut();
        else if (text) out.push(dimRow(text));
        if (str(a.content)) out.push(numberedRows(a.content, 1, null, undefined, c.done ? langOfPath(a.path) : ""));
        return out;
      case "grep":
      case "ast_grep":
        if (c.isError) errOut();
        else if (str(d.displayContent)) out.push(textRows(d.displayContent));
        else if (text) out.push(textRows(text));
        return out;
      case "glob":
        if (c.isError) errOut();
        else if (Array.isArray(d.files) && d.files.length) out.push(textRows(d.files.filter((f) => typeof f === "string").join("\n")));
        else if (text) out.push(textRows(text));
        return out;
      case "todo": {
        const phases = Array.isArray(d.phases) ? d.phases.filter((p) => isObj(p) && Array.isArray(p.tasks)) : [];
        if (c.isError || !phases.length) {
          if (c.isError) errOut();
          else if (text) out.push(textRows(text));
          return out;
        }
        const items = [];
        for (const p of phases) {
          if (phases.length > 1 && str(p.name)) items.push({ head: p.name });
          for (const t of p.tasks.filter((t) => isObj(t) && typeof t.content === "string")) items.push(t);
        }
        out.push(rowsBlock(items, (t) => {
          if (t.head) return row("todo-phase", t.head);
          const status = Object.hasOwn(TODO_MARK, t.status) ? t.status : "pending";
          return row("todo " + status, span("mark", TODO_MARK[status] + " "), t.content);
        }));
        return out;
      }
      case "task": {
        const brief = str(a.task) || str(a.description) || (Array.isArray(a.tasks) ? a.tasks.map((t) => (isObj(t) ? str(t.task) || str(t.description) : "")).filter(Boolean).join("\n\n") : "");
        if (brief) out.push(textRows(brief, { cls: "cmd" }));
        if (c.isError) errOut();
        else if (text) {
          const md = markdown(text, onNote);
          md.classList.add("tool-md");
          out.push(md);
        }
        return out;
      }
      case "eval":
        if (str(a.code)) out.push(textRows(a.code, { cls: "cmd" }));
        if (text) out.push(textRows(text, { tail: true, cls: c.isError ? "err" : "" }));
        if (images.length || imagesOf(d.images).length) out.push(imageRow([...images, ...imagesOf(d.images)], "eval output"));
        return out;
    }
    // Edit-like tools (edit, ast_edit, ...): the diff of the result, or a preview of the arguments.
    const diffs = editDiffs(d);
    if (diffs.length && !c.isError) {
      for (const f of diffs) {
        if (diffs.length > 1 && f.path) out.push(dimRow(f.path));
        if (f.error) out.push(textRows(f.error, { cls: "err" }));
        else if (!f.empty) out.push(diffBlock(f.rows));
      }
      const diag = isObj(d.diagnostics) ? d.diagnostics : null;
      const msgs = diag && Array.isArray(diag.messages) ? diag.messages.filter((m) => typeof m === "string") : [];
      if (diag && (str(diag.summary) || msgs.length)) out.push(textRows([str(diag.summary), ...msgs].filter(Boolean).join("\n"), { cls: diag.errored ? "err" : "warn" }));
      return out;
    }
    if (c.isError) {
      errOut();
      return out;
    }
    if (!c.done && (typeof a.old_string === "string" || typeof a.new_string === "string")) {
      const rows = [
        ...(str(a.old_string) ? splitLines(a.old_string).map((t) => ({ kind: "del", num: "", text: t })) : []),
        ...(str(a.new_string) ? splitLines(a.new_string).map((t) => ({ kind: "add", num: "", text: t })) : []),
      ];
      if (rows.length) out.push(diffBlock(rows));
      return out;
    }
    if (!c.done && Array.isArray(a.edits) && a.edits.some((e) => isObj(e) && str(e.diff))) {
      for (const e of a.edits.filter((e) => isObj(e) && str(e.diff))) out.push(diffBlock(patchRows(e.diff)));
      return out;
    }
    if (!c.done && str(a.input)) {
      out.push(diffBlock(patchRows(a.input)));
      return out;
    }
    // Any other tool: its arguments, then its output.
    if (Object.keys(a).length && (!text || !c.done)) out.push(textRows(pretty(a), { cls: "cmd" }));
    if (text) out.push(textRows(text));
    if (images.length) out.push(imageRow(images, c.toolName || "image"));
    return out;
  }

  const fmtTok = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(2) + "M");
  const fmtCost = (c, fine) => "$" + c.toFixed(fine && c < 1 ? 3 : 2);
  // Share of the prompt served from cache: cacheRead / (cacheRead + cacheWrite + input).
  const hitRate = (u) => {
    const prompt = u.cacheRead + u.cacheWrite + u.input;
    return prompt > 0 ? (u.cacheRead / prompt) * 100 : 0;
  };
  function span(cls, text) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    if (text !== undefined) s.textContent = text;
    return s;
  }
  function splitBar(cls, u) {
    const bar = span(cls);
    for (const [part, n] of [["read", u.cacheRead], ["write", u.cacheWrite], ["input", u.input]]) {
      const i = document.createElement("i");
      i.className = "seg-" + part;
      i.style.flexGrow = String(n);
      bar.append(i);
    }
    bar.title = `read ${fmtTok(u.cacheRead)} · write ${fmtTok(u.cacheWrite)} · uncached ${fmtTok(u.input)}`;
    return bar;
  }

  // ---- one session ------------------------------------------------------
  window.createSession = (sid, hooks = {}, opts = {}) => {
  const root = document.getElementById("session-template").content.firstElementChild.cloneNode(true);
  const el = { root };
  for (const n of root.querySelectorAll("[data-ref]")) el[n.dataset.ref] = n;
  let lastId = null; // message_start fallback key
  let busy = false;
  let bashExclude = false; // ready.supportsBashExcludeFromContext
  let bashRunning = 0; // user `!cmd` runs in flight
  let userBashSeq = 0;
  let alive = false; // the omp process is up (ready seen, no exit since)
  let treeUi = null; // tree panel parts, built on first open: { list, info, state, sum, cancel, fork }
  let navPending = false; // a navigate_tree is in flight
  let navSummarize = false;
  let sessionFile = null; // current session file, from get_state
  let histNote = null; // note shown after the next get_messages render
  let seq = 0;
  const messages = new Map(); // messageId -> element
  const tools = new Map(); // toolCallId -> { root, body, state }

  function setStatus(text, kind) {
    hooks.status?.(text, kind);
  }
  let lastAnswer = ""; // final text of the newest assistant message in the current turn, for notifications
  function setBusy(value) {
    busy = value;
    el.stop.hidden = !value && bashRunning === 0;
    el.busyHint.hidden = !value;
    el.hint.hidden = value;
    paintTreeBusy();
    setStatus(value ? "working…" : "ready", value ? "busy" : "ok");
  }
  function scrollDown() {
    const m = el.messages;
    if (!pinned) return;
    // `.messages` has scroll-behavior:smooth: a plain scrollTop assignment animates and stops short
    // when content keeps growing (tool rows, thinking blocks), leaving the last message hidden.
    const toEnd = () => m.scrollTo({ top: m.scrollHeight, behavior: "instant" });
    toEnd();
    requestAnimationFrame(toEnd);
  }
  // Follow the tail while the user is at the bottom; scrolling up unpins, scrolling back down re-pins.
  // Content grows after being appended (streaming text, tool output), so a mutation observer keeps following.
  let pinned = true;
  el.messages.addEventListener("scroll", () => {
    const m = el.messages;
    pinned = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }, { passive: true });
  new MutationObserver(() => scrollDown()).observe(el.messages, { childList: true, subtree: true, characterData: true });
  function note(text, error, kind = "note") {
    const n = document.createElement("div");
    n.className = "msg " + kind + (error ? " error" : "");
    n.textContent = text;
    el.messages.append(n);
    scrollDown();
    return n;
  }
  /** A `.link` button appended to a note (e.g. "Copy link" on the login note). */
  function noteAction(n, label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = label;
    b.style.marginLeft = "8px";
    b.addEventListener("click", onClick);
    n.append(b);
    return b;
  }
  // ---- omp's stderr: the last lines of the current process, shown on demand (e.g. after a crash) ----
  const STDERR_MAX = 200;
  let stderrLines = [];
  const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  function onStderr(line) {
    if (typeof line !== "string") return;
    stderrLines.push(stripAnsi(line));
    if (stderrLines.length > STDERR_MAX) stderrLines.splice(0, stderrLines.length - STDERR_MAX);
  }
  function showLogs() {
    const n = note(stderrLines.length ? stderrLines.join("\n") : "omp wrote nothing to stderr.", false, "output");
    n.style.whiteSpace = "pre-wrap";
    const text = stderrLines.join("\n");
    if (text) noteAction(n, "Copy", () => {
      const p = navigator.clipboard?.writeText(text);
      if (p) p.then(() => note("Logs copied."), () => note("Could not copy the logs.", true));
      else note("Could not copy the logs.", true);
    });
  }
  // ---- configuration warnings (get_state.configWarnings): a badge in the status line ----
  let configWarnings = [];
  function setWarnings(list) {
    // An omp without the field reports nothing, which hides the badge.
    configWarnings = Array.isArray(list) ? list.filter((w) => typeof w === "string" && w.trim()).map(stripAnsi) : [];
    const n = configWarnings.length;
    el.warn.hidden = !n;
    el.warn.textContent = n === 1 ? "1 config warning" : `${n} config warnings`;
    el.warn.title = configWarnings.join("\n");
  }
  el.warn.addEventListener("click", () => {
    if (!configWarnings.length) return;
    const n = note(configWarnings.map((w) => "• " + w).join("\n"), false, "output");
    n.style.whiteSpace = "pre-wrap";
  });
  // OAuth login: omp asks the client to open the auth page; no response is expected.
  function onOpenUrl(req) {
    const target = typeof req.launchUrl === "string" && req.launchUrl ? req.launchUrl : req.url;
    if (typeof target !== "string" || !target) return;
    const n = note(typeof req.instructions === "string" && req.instructions ? req.instructions : "Opening the sign-in page in your browser…");
    n.style.whiteSpace = "pre-wrap";
    noteAction(n, "Open again", () => openUrl(target, (t) => note(t)));
    noteAction(n, "Copy link", () => copyLink(target, (t) => note(t)));
    openUrl(target, (t) => note(t));
  }
  function send(obj) {
    return invoke("rpc_send", { id: sid, line: JSON.stringify(obj) }).catch((e) => note(String(e), true));
  }

  let imageSeq = 0; // highest image number used so far
  const imageNums = new Map(); // messageId -> numbers of that message's images

  /** Numbers for a message's images: the labels in its text, else fresh session numbers (cached per message). */
  function numbersFor(id, text, count) {
    let nums = imageNums.get(id);
    if (nums?.length === count) return nums;
    const tail = LABELS_TAIL.exec(text)?.[0] ?? "";
    const labeled = [...tail.matchAll(/\[Image (\d+)\]/g)].map((m) => Number(m[1]));
    nums = labeled.length === count ? labeled : Array.from({ length: count }, () => ++imageSeq);
    imageSeq = Math.max(imageSeq, ...nums);
    imageNums.set(id, nums);
    return nums;
  }

  // ---- thinking: folded by default; Ctrl+T opens/closes them all, as in the CLI ----
  let thinkingOpen = false;
  const thinkingSet = new Map(); // "<messageId>:<block>" -> open, for blocks toggled by hand
  /** Messages re-render on every delta, so a hand-toggled block keeps its state by key. */
  function thinkingBlock(key, text) {
    const d = document.createElement("details");
    d.className = "thinking";
    d.open = thinkingSet.get(key) ?? thinkingOpen;
    const sum = document.createElement("summary");
    const first = text.trim().split("\n", 1)[0] ?? "";
    sum.append(span("label", "Thinking"), span("peek", clip(flat(first.replace(/^[#*\s]+|\*+$/g, "")), 120)));
    sum.addEventListener("click", () => thinkingSet.set(key, !d.open));
    const body = document.createElement("div");
    body.className = "thinking-body";
    body.textContent = text;
    d.append(sum, body);
    return d;
  }
  function toggleThinking() {
    thinkingOpen = !thinkingOpen;
    thinkingSet.clear();
    el.thinkingBtn.classList.toggle("on", thinkingOpen);
    el.thinkingBtn.setAttribute("aria-pressed", String(thinkingOpen));
    for (const d of el.messages.querySelectorAll("details.thinking")) d.open = thinkingOpen;
  }
  el.thinkingBtn.addEventListener("click", toggleThinking);

  // ---- messages ---------------------------------------------------------
  function renderMessage(id, message, live = false) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) return;
    if (message.role === "user" && (message.synthetic || message.steering)) return;
    let node = messages.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "msg " + message.role;
      messages.set(id, node);
      el.messages.append(node);
    }
    node.replaceChildren();
    if (message.role === "user") {
      // The card holds the text only; thumbnails and the copy/branch/fork bar sit below it.
      node.classList.add("split");
      const images = Array.isArray(message.content) ? message.content.filter((b) => b.type === "image" && b.data) : [];
      let text = textOf(message.content);
      let row = null;
      if (images.length) {
        const nums = numbersFor(id, text, images.length);
        text = text.replace(LABELS_TAIL, ""); // the badges on the thumbnails carry the numbers
        row = document.createElement("div");
        row.className = "msg-images";
        images.forEach((img, i) => row.append(thumb(imageSrc(img), nums[i])));
      }
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;
      node.append(bubble);
      if (row) node.append(row);
      userText.set(node, textOf(message.content));
      node.append(userActions(node));
    } else {
      const content = Array.isArray(message.content) ? message.content : [];
      content.forEach((block, bi) => {
        if (!isObj(block)) return;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          node.append(thinkingBlock(id + ":" + bi, block.thinking));
        } else if (block.type === "text" && typeof block.text === "string" && block.text) {
          node.append(markdown(block.text, note));
        }
      });
      const images = imagesOf(content.filter((b) => isObj(b) && b.type === "image"));
      if (images.length) node.append(imageRow(images, "Image"));
      if (message.errorMessage) {
        const e = document.createElement("div");
        e.className = "error";
        e.textContent = message.errorMessage;
        node.append(e);
      }
      if (!node.childNodes.length) node.hidden = true;
      else node.hidden = false;
      // Copy the answer as markdown, once it stopped streaming (re-rendered on every delta until then).
      const answer = content
        .filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string" && b.text)
        .map((b) => b.text)
        .join("\n\n");
      if (answer && !live) lastAnswer = answer;
      if (answer && !live) {
        const bar = document.createElement("div");
        bar.className = "msg-acts";
        const copy = linkBtn("copy", "Copy this answer as markdown", () => copyText(answer, copy));
        bar.append(copy);
        node.append(bar);
      }
      renderLedger(id, node, message, live);
    }
    scrollDown();
  }

  // ---- usage: per-turn ledger + session total (formulas as in the omp CLI status line) ----
  const turnUsage = new Map(); // messageId -> final Usage of that assistant turn
  const ledgers = new Map(); // messageId -> ledger element
  let sessionStats = null; // last get_session_stats result

  function renderLedger(id, node, message, live) {
    const u = message.usage;
    const prompt = u ? u.cacheRead + u.cacheWrite + u.input : 0;
    let led = ledgers.get(id);
    if (!live && (!u || prompt + u.output === 0)) {
      // No usage (old transcript, aborted before the first token): nothing to report, as in the CLI.
      led?.remove();
      ledgers.delete(id);
      if (turnUsage.delete(id)) renderTotal();
      return;
    }
    if (!led) {
      led = document.createElement("div");
      led.className = "ledger";
      ledgers.set(id, led);
    }
    if (led.previousElementSibling !== node) node.after(led);
    led.replaceChildren();
    if (live) {
      led.append(span("ico"), span("", "streaming…"), span("rule"));
      return;
    }
    if (u.cacheRead > 0) {
      led.append(span("ico"), splitBar("mini", u), span("hit", hitRate(u).toFixed(1) + "% cached"));
    } else {
      const cold = span("cold", "cold");
      cold.title = "No prompt cache read on this turn";
      led.append(cold);
    }
    led.append(span("", `${fmtTok(prompt)} in · ${fmtTok(u.output)} out`));
    const cost = u.cost?.total ?? 0;
    if (cost > 0) led.append(span("c", fmtCost(cost, true)));
    led.append(span("rule"));
    if (message.duration) led.append(span("", (message.duration / 1000).toFixed(1) + "s"));
    turnUsage.set(id, u);
    renderTotal();
  }
  function renderTotal() {
    const own = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const u of turnUsage.values()) {
      own.input += u.input;
      own.output += u.output;
      own.cacheRead += u.cacheRead;
      own.cacheWrite += u.cacheWrite;
      own.cost += u.cost?.total ?? 0;
    }
    // Session stats add task (subagent) and side-model spend on top of this session's own turns.
    const sub = sessionStats ? Math.max(0, sessionStats.cost - own.cost) : 0;
    const box = el.total;
    box.replaceChildren();
    if (own.cacheRead > 0) {
      const hit = span("hit", hitRate(own).toFixed(0) + "% hit");
      hit.title = `cache read ${fmtTok(own.cacheRead)} · write ${fmtTok(own.cacheWrite)} · uncached input ${fmtTok(own.input)} tokens (${hitRate(own).toFixed(2)}%)`;
      box.append(hit);
    }
    if (own.cost > 0) box.append(span("num tick", fmtCost(own.cost)));
    if (sub >= 0.005) {
      const s = span("", "+ " + fmtCost(sub) + " sub");
      s.title = "Subagent and side-model spend";
      box.append(s);
    }
    box.hidden = !box.childNodes.length;
    const ctx = el.ctx;
    const pct = sessionStats?.contextUsage?.percent;
    ctx.hidden = !(pct > 0);
    if (pct > 0) {
      ctx.textContent = Math.round(pct) + "% ctx";
      const cu = sessionStats.contextUsage;
      ctx.title = `${fmtTok(cu.tokens)} / ${fmtTok(cu.contextWindow)} tokens`;
    }
  }
  const refreshStats = () => send({ id: "stats", type: "get_session_stats" });
  const keyOf = (ev) => ev.messageId || "m" + ++seq;

  // ---- tools ------------------------------------------------------------
  // Each card keeps its arguments and (partial or final) result and repaints from them; a folded
  // card only repaints its summary and builds the body when it is opened.
  let toolsOpen = null; // Ctrl+O: null = per-card default, else every card open/folded
  const OPEN_WHEN_DONE = new Set(["edit", "ast_edit"]); // diffs are shown unfolded, as in the CLI
  function toolCard(ev) {
    let card = tools.get(ev.toolCallId);
    if (!card) {
      const root = document.createElement("details");
      root.className = "tool";
      const sum = document.createElement("summary");
      const name = span("name", str(ev.toolName) || "tool");
      const arg = span("arg");
      const intent = span("intent");
      const badge = span("badge");
      badge.hidden = true;
      const state = span("state", "running…");
      sum.append(name, arg, intent, badge, state);
      const body = document.createElement("div");
      body.className = "tool-body";
      root.append(sum, body);
      el.messages.append(root);
      card = { root, arg, intent, badge, state, body, toolName: str(ev.toolName), args: undefined, partial: undefined, result: undefined, isError: false, done: false, touched: false, dirty: true };
      const c = card;
      sum.addEventListener("click", () => (c.touched = true));
      root.addEventListener("toggle", () => { if (root.open && c.dirty) paintBody(c); });
      if (toolsOpen !== null) root.open = toolsOpen;
      tools.set(ev.toolCallId, card);
    }
    if (str(ev.toolName)) card.toolName = ev.toolName;
    if (str(ev.intent)) card.intent.textContent = ev.intent;
    return card;
  }
  function paintBody(c) {
    c.dirty = false;
    if (!c.done && liveAppend(c)) return;
    c.live = null;
    blockMemo = c.expanded ??= new Set();
    blockSeq = 0;
    try {
      c.body.replaceChildren(...toolBody(c, note));
    } finally {
      blockMemo = null;
    }
  }
  /** Running bash: when the new output only extends the painted one, append the new lines. */
  function liveAppend(c) {
    const live = c.live;
    if (!live || !live.block.isConnected || c.isError) return false;
    const { details: d, text } = resultParts(c.partial);
    if (!text.startsWith(live.text) || (d.truncated === true) !== live.truncated) return false;
    if (text !== live.text) live.block.update(ansiLines(text));
    live.text = text;
    return true;
  }
  const LIVE_PAINT_MS = 100; // streamed tool updates repaint at most ~10 times a second
  function paintTool(c) {
    const arg = toolArg(c.toolName, c.args);
    c.arg.textContent = clip(arg, 160);
    c.arg.title = arg;
    const b = toolBadge(c);
    c.badge.hidden = !b;
    c.badge.textContent = b?.text ?? "";
    c.badge.className = "badge" + (b?.kind ? " " + b.kind : "");
    c.state.textContent = c.done ? (c.isError ? "error" : "done") : "running…";
    c.root.classList.toggle("done", c.done && !c.isError);
    c.root.classList.toggle("err", c.done && c.isError);
    if (c.done && !c.touched && toolsOpen === null) c.root.open = c.isError || (OPEN_WHEN_DONE.has(c.toolName) && toolBadge(c)?.kind === "diff");
    if (c.root.open) paintBody(c);
    else c.dirty = true;
  }
  /** Apply what a tool frame or history entry knows (only the fields it carries) and repaint. */
  function updateTool(ev, patch) {
    const c = toolCard(ev);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) c[k] = v;
    const wait = c.done ? 0 : (c.paintedAt ?? 0) + LIVE_PAINT_MS - Date.now();
    if (wait > 0) {
      c.paintTimer ??= setTimeout(() => {
        c.paintTimer = undefined;
        c.paintedAt = Date.now();
        paintTool(c);
      }, wait);
      return c;
    }
    clearTimeout(c.paintTimer);
    c.paintTimer = undefined;
    c.paintedAt = Date.now();
    paintTool(c);
    return c;
  }
  function toggleTools() {
    toolsOpen = toolsOpen !== true;
    for (const c of tools.values()) {
      c.touched = true;
      c.root.open = toolsOpen;
    }
  }

  // ---- dialogs (extension_ui_request) ----------------------------------
  let dialogId = null;
  let localDone = null; // resolver of an open askLocal() dialog
  function dropLocal() {
    const done = localDone;
    localDone = null;
    done?.(-1);
  }
  let dialogTimer = null; // countdown of a request with `timeout`
  function closeDialog() {
    dropLocal();
    clearInterval(dialogTimer);
    dialogTimer = null;
    dialogId = null;
    el.dialog.hidden = true;
    el.dialog.replaceChildren();
    hooks.asking?.(null);
  }
  /**
   * `timeout` (ms) on a request: count down in the heading, then answer `{cancelled, timedOut}`
   * (omp then applies its own timeout result, e.g. the recommended answers of an `ask`).
   */
  function startCountdown(req, heading) {
    const ms = Number(req.timeout);
    if (!Number.isFinite(ms) || ms <= 0) return;
    const end = Date.now() + ms;
    const c = span("countdown");
    heading.append(c);
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      c.textContent = `closes in ${left}s`;
      if (left === 0 && dialogId === req.id) respond(req.id, { cancelled: true, timedOut: true });
    };
    tick();
    dialogTimer = setInterval(tick, 1000);
  }
  /** `ask`: several questions in one dialog; each offers its options plus free text. */
  function openAskDialog(req) {
    const questions = (Array.isArray(req.questions) ? req.questions : []).filter((q) => q && typeof q.id === "string");
    if (!questions.length) return respond(req.id, { cancelled: true });
    dropLocal();
    clearInterval(dialogTimer);
    dialogId = req.id;
    hooks.asking?.(String(questions[0].question ?? "") || req.title || "Question");
    el.dialog.replaceChildren();
    el.dialog.classList.remove("ask-card");
    const h = document.createElement("h4");
    h.textContent = req.title || (questions.length > 1 ? `${questions.length} questions` : "Question");
    el.dialog.append(h);
    const reads = questions.map((q, qi) => {
      const box = document.createElement("div");
      box.className = "ask-q";
      if (typeof q.header === "string" && q.header) box.append(span("head", q.header));
      const p = document.createElement("p");
      p.textContent = String(q.question ?? "");
      box.append(p);
      const multi = q.multi === true;
      const opts = (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === "string");
      const inputs = opts.map((o, oi) => {
        const lab = document.createElement("label");
        const inp = document.createElement("input");
        inp.type = multi ? "checkbox" : "radio";
        inp.name = `ask-${req.id}-${qi}`;
        if (oi === q.recommended && !multi) inp.checked = true;
        lab.append(inp, span("", o.label));
        if (oi === q.recommended) lab.append(span("rec", "recommended"));
        if (typeof o.description === "string" && o.description) lab.append(span("desc", "— " + o.description));
        box.append(lab);
        return inp;
      });
      // An option's `preview` (a code sample, a mock-up...): folded boxes under the options.
      for (const o of opts) {
        if (typeof o.preview !== "string" || !o.preview.trim()) continue;
        const d = document.createElement("details");
        d.className = "ask-preview";
        const s = document.createElement("summary");
        s.textContent = "preview · " + o.label;
        const pre = document.createElement("pre");
        pre.textContent = o.preview.replace(/\r\n?/g, "\n");
        d.append(s, pre);
        box.append(d);
      }
      const other = document.createElement("input");
      other.placeholder = opts.length ? "Or type your own answer" : "Your answer";
      // Single-select: an option and free text are exclusive, so typing clears the radio and vice versa.
      if (!multi) {
        other.addEventListener("input", () => { if (other.value.trim()) for (const i of inputs) i.checked = false; });
        for (const i of inputs) i.addEventListener("change", () => { if (i.checked) other.value = ""; });
      }
      box.append(other);
      el.dialog.append(box);
      return () => {
        const answer = { id: q.id, selectedOptions: opts.filter((_, i) => inputs[i].checked).map((o) => o.label) };
        const custom = other.value.trim();
        if (custom) answer.customInput = custom;
        return answer;
      };
    });
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      btn("Submit", () => respond(req.id, { answers: reads.map((read) => read()) })),
      btn("Cancel", () => respond(req.id, { cancelled: true })),
    );
    el.dialog.append(row);
    startCountdown(req, h);
    el.dialog.hidden = false;
    el.dialog.scrollIntoView({ block: "nearest" });
    queueMicrotask(() => el.dialog.querySelector("input")?.focus());
  }

  // ---- extension UI state: setStatus chips, setWidget blocks --------------
  const extStatus = new Map(); // statusKey -> text
  const widgets = new Map(); // widgetKey -> { lines, below }
  function renderExtStatus() {
    el.ext.replaceChildren(...[...extStatus].map(([key, text]) => {
      const s = span("", text);
      s.title = `${key}: ${text}`;
      return s;
    }));
    el.ext.hidden = !extStatus.size;
  }
  function renderWidgets() {
    for (const [box, below] of [[el.widgetsAbove, false], [el.widgetsBelow, true]]) {
      const list = [...widgets.values()].filter((w) => w.below === below);
      box.replaceChildren(...list.map((w) => {
        const pre = document.createElement("pre");
        pre.textContent = w.lines.join("\n");
        return pre;
      }));
      box.hidden = !list.length;
    }
  }
  function clearExtUi() {
    extStatus.clear();
    widgets.clear();
    renderExtStatus();
    renderWidgets();
  }
  function onSetStatus(req) {
    if (typeof req.statusKey !== "string") return;
    const text = stripAnsi(req.statusText).trim();
    if (text) extStatus.set(req.statusKey, text);
    else extStatus.delete(req.statusKey);
    renderExtStatus();
  }
  function onSetWidget(req) {
    if (typeof req.widgetKey !== "string") return;
    const lines = Array.isArray(req.widgetLines) ? req.widgetLines.filter((l) => typeof l === "string").map(stripAnsi) : null;
    if (lines?.length) widgets.set(req.widgetKey, { lines, below: req.widgetPlacement === "belowEditor" });
    else widgets.delete(req.widgetKey);
    renderWidgets();
  }
  function respond(id, payload) {
    send({ type: "extension_ui_response", id, ...payload });
    closeDialog();
  }
  function btn(label, onClick, primary) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (primary) b.setAttribute("type", "button");
    b.addEventListener("click", onClick);
    return b;
  }
  function openDialog(req) {
    dropLocal();
    clearInterval(dialogTimer);
    dialogId = req.id;
    hooks.asking?.(req.message || req.title || "omp");
    el.dialog.replaceChildren();
    // The ask tool's field-by-field prompts lead with "(2/3) ": show it as a progress header instead.
    const step = /^\((\d+)\/(\d+)\) ([\s\S]*)$/.exec(req.title || "");
    el.dialog.classList.toggle("ask-card", !!step);
    if (step) {
      const at = Number(step[1]);
      const total = Number(step[2]);
      const bar = document.createElement("div");
      bar.className = "ask-progress";
      bar.append(span("ask-count", `Question ${at} of ${total}`));
      const dots = span("ask-dots");
      for (let i = 1; i <= total; i++) dots.append(span(i < at ? "done" : i === at ? "cur" : ""));
      bar.append(dots);
      el.dialog.append(bar);
    }
    const h = document.createElement("h4");
    h.textContent = step ? step[3] : req.title || "omp";
    el.dialog.append(h);
    if (req.message) {
      const p = document.createElement("p");
      p.textContent = req.message;
      el.dialog.append(p);
    }
    const row = document.createElement("div");
    row.className = "row";
    const cancel = btn("Cancel", () => respond(req.id, { cancelled: true }));
    cancel.classList.add("cancel");
    if (req.method === "confirm") {
      row.append(btn("Yes", () => respond(req.id, { confirmed: true })), btn("No", () => respond(req.id, { confirmed: false })));
    } else if (req.method === "select") {
      (req.options || []).forEach((opt, i) => {
        const b = btn(opt, () => respond(req.id, { value: opt }));
        const d = req.optionDetails && req.optionDetails[i] && req.optionDetails[i].description;
        if (d) { b.title = d; b.append(span("desc", d)); }
        row.append(b);
      });
      row.append(cancel);
    } else {
      const field = req.method === "editor" ? document.createElement("textarea") : document.createElement("input");
      if (req.method === "editor") field.rows = 6;
      if (req.secret) field.type = "password";
      field.placeholder = req.placeholder || "";
      field.value = req.prefill || "";
      el.dialog.append(field);
      row.append(btn("OK", () => respond(req.id, { value: field.value })), cancel);
      queueMicrotask(() => field.focus());
    }
    el.dialog.append(row);
    startCountdown(req, h);
    el.dialog.hidden = false;
    el.dialog.scrollIntoView({ block: "nearest" });
  }
  /** A question of this UI's own (not an extension request): resolves the picked button's index, -1 if dismissed. */
  function askLocal(title, message, labels) {
    closeDialog();
    const h = document.createElement("h4");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = message;
    p.style.whiteSpace = "pre-wrap"; // multi-line details (the goal's status, tokens, time) one per line
    const row = document.createElement("div");
    row.className = "row";
    return new Promise((resolve) => {
      localDone = resolve;
      labels.forEach((label, i) => row.append(btn(label, () => {
        localDone = null;
        closeDialog();
        resolve(i);
      })));
      el.dialog.append(h, p, row);
      el.dialog.hidden = false;
      el.dialog.scrollIntoView({ block: "nearest" });
      row.querySelector("button")?.focus();
    });
  }
  const errText = (e) => String(e?.message ?? e);
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  /** Prepend withdrawn texts to the editor and re-stage their images (queue removal, abort-and-restore). */
  function restoreToEditor(texts, images) {
    const parts = texts.filter((t) => typeof t === "string" && t.trim());
    const imgs = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.data === "string" && typeof i.mimeType === "string");
    if (parts.length) {
      const cur = el.input.value.trim();
      el.input.value = [...parts, ...(cur ? [cur] : [])].join("\n\n");
      autosize();
    }
    if (imgs.length) {
      for (const i of imgs) attached.push({ data: i.data, mimeType: i.mimeType, src: imageSrc(i) });
      renderAttachments();
    }
    el.input.focus();
  }

  // ---- queued messages (queue_update): chips above the composer ------------
  // Steering entries reach the model at its next step, follow-ups after the turn. The first
  // `liveSteered` steering entries are already in the running step and cannot be withdrawn.
  let queue = { steering: [], followUp: [], liveSteered: 0 };
  // queue_update carries only texts: the images of messages sent from here, by text (staged → shown).
  const queuedImages = new Map(); // text -> images [{ data, mimeType }]
  function noteQueuedImages(text, images) {
    if (Array.isArray(images) && images.length) queuedImages.set(text, images);
  }
  const strList = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string") : []);
  function setQueue(q) {
    const src = q && typeof q === "object" ? q : {};
    const steering = strList(src.steering);
    const live = Math.trunc(Number(src.liveSteered) || 0);
    queue = { steering, followUp: strList(src.followUp), liveSteered: Math.min(steering.length, Math.max(0, live)) };
    const present = new Set([...steering, ...queue.followUp]);
    for (const t of queuedImages.keys()) if (!present.has(t)) queuedImages.delete(t); // delivered or removed
    renderQueue();
  }
  const queueSize = () => queue.steering.length + queue.followUp.length;
  function renderQueue() {
    const chips = [];
    const add = (text, kind, i) => {
      const c = span("chip " + kind);
      c.append(span("q-kind", kind === "steering" ? "steer" : "queued"));
      const t = span("q-text", clip(oneLine(text), 90));
      t.title = text;
      c.append(t);
      const imgs = queuedImages.get(text);
      if (imgs) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "link q-img";
        b.textContent = plural(imgs.length, "image");
        b.title = "Show the attached " + (imgs.length === 1 ? "image" : "images");
        b.addEventListener("click", () => openLightbox(imageSrc(imgs[0]), "queued image"));
        c.append(b);
      }
      if (kind === "followUp") c.append(linkBtn("↑ steer", "Deliver it at the model's next step instead of after the turn", () => promoteQueued(text)));
      if (kind === "steering" && i < queue.liveSteered) c.title = "Already handed to the running step";
      else c.append(linkBtn("✕", "Remove it from the queue and put it back in the editor", () => removeQueued(text, kind)));
      chips.push(c);
    };
    queue.steering.forEach((t, i) => add(t, "steering", i));
    queue.followUp.forEach((t, i) => add(t, "followUp", i));
    el.queue.replaceChildren(...chips);
    el.queue.hidden = !chips.length;
  }
  async function removeQueued(text, kind) {
    try {
      const r = await request("remove_queued_message", { message: text, queue: kind });
      if (!r?.removed) return note("That message was already delivered.");
      restoreToEditor([text], r.images);
      if (r.imagesDropped) note("Its images were too large to return and were dropped.", true);
    } catch (e) {
      note("Could not remove the queued message: " + errText(e), true);
    }
  }
  async function promoteQueued(text) {
    try {
      const r = await request("promote_queued_message", { message: text });
      if (!r?.promoted) note("That message was already delivered.");
    } catch (e) {
      note("Could not promote the queued message: " + errText(e), true);
    }
  }
  /** Esc with a queue: stop the turn and pull every withdrawable queued message back into the editor. */
  async function abortAndRestore() {
    try {
      const r = await request("abort_and_restore_queue", {});
      const items = [...(Array.isArray(r?.steering) ? r.steering : []), ...(Array.isArray(r?.followUp) ? r.followUp : [])]
        .filter((x) => x && typeof x.text === "string");
      restoreToEditor(items.map((x) => x.text), items.flatMap((x) => (Array.isArray(x.images) ? x.images : [])));
      if (r?.imagesDropped) note("Some queued images were too large to return and were dropped.", true);
      if (r?.truncated) note("Some queued messages were too large to return.", true);
    } catch {
      send({ type: "abort" }); // an older omp: at least stop the turn
    }
  }
  function stopTurn() {
    if (bashRunning && !busy) {
      send({ type: "abort_bash" });
      return;
    }
    if (queueSize() > queue.liveSteered) abortAndRestore();
    else send({ type: "abort" });
  }

  // ---- `!cmd` / `!!cmd`: user shell commands (bash RPC; `!!` keeps the output out of the context) ----
  /** Card patch for a bash result or a `bashExecution` history entry (fields are optional). */
  function bashPatch(r) {
    const o = isObj(r) ? r : {};
    const exitCode = Number.isFinite(o.exitCode) ? o.exitCode : undefined;
    const details = { exitCode, timedOut: o.timedOut === true, cancelled: o.cancelled === true, truncated: o.truncated === true, totalLines: o.totalLines, artifactId: str(o.artifactId) || undefined, userBash: true };
    return {
      result: { content: [{ type: "text", text: str(o.output) }], details },
      isError: details.cancelled || details.timedOut || (exitCode !== undefined && exitCode !== 0),
      done: true,
    };
  }
  const bashIntent = (excluded) => (excluded ? "you · not sent to model" : "you");
  async function runUserBash(raw) {
    const excluded = raw.startsWith("!!");
    const command = raw.slice(excluded ? 2 : 1).trim();
    if (!command) return;
    if (excluded && !bashExclude) note("This omp cannot keep !! output out of the context; it will be sent with the next prompt.");
    const ev = { toolCallId: "ubash-" + ++userBashSeq, toolName: "bash", intent: bashIntent(excluded && bashExclude) };
    updateTool(ev, { args: { command } });
    scrollDown();
    bashRunning++;
    el.stop.hidden = false;
    try {
      const params = { command };
      if (excluded && bashExclude) params.excludeFromContext = true;
      const r = await request("bash", params, 6 * 3600 * 1000);
      updateTool(ev, bashPatch(r));
    } catch (e) {
      updateTool(ev, { result: { content: [{ type: "text", text: String(e?.message ?? e) }], details: {} }, isError: true, done: true });
    } finally {
      bashRunning--;
      if (!busy) el.stop.hidden = bashRunning === 0;
      scrollDown();
    }
  }

  // ---- todo list (get_state.todoPhases; re-read after the `todo` tool) -------
  let todoPhases = [];
  let todoOpen = true;
  function setTodos(phases) {
    todoPhases = (Array.isArray(phases) ? phases : [])
      .filter((p) => p && Array.isArray(p.tasks))
      .map((p) => ({ name: typeof p.name === "string" ? p.name : "", tasks: p.tasks.filter((t) => t && typeof t.content === "string") }))
      .filter((p) => p.tasks.length);
    renderTodos();
  }
  const refreshTodos = () => send({ id: "todos", type: "get_state" });
  function renderTodos() {
    const all = todoPhases.flatMap((p) => p.tasks);
    if (!all.length) {
      el.todos.replaceChildren();
      el.todos.hidden = true;
      return;
    }
    const done = all.filter((t) => t.status === "completed").length;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "link panel-head";
    head.setAttribute("aria-expanded", String(todoOpen));
    head.textContent = `${todoOpen ? "▾" : "▸"} todos ${done}/${all.length}`;
    const cur = all.find((t) => t.status === "in_progress");
    if (!todoOpen && cur) head.append(span("panel-sub", " · " + clip(oneLine(cur.content), 80)));
    head.addEventListener("click", () => {
      todoOpen = !todoOpen;
      renderTodos();
    });
    const parts = [head];
    if (todoOpen) {
      for (const p of todoPhases) {
        if (todoPhases.length > 1 && p.name) {
          const ph = document.createElement("div");
          ph.className = "todo-phase";
          ph.textContent = p.name;
          parts.push(ph);
        }
        for (const t of p.tasks) {
          const status = Object.hasOwn(TODO_MARK, t.status) ? t.status : "pending";
          const row = document.createElement("div");
          row.className = "panel-row todo " + status;
          row.append(span("mark", TODO_MARK[status]), span("text", t.content));
          if (status === "blocked" && typeof t.blocker === "string" && t.blocker) row.append(span("panel-sub", "— " + t.blocker));
          const extra = [t.details, t.notes].filter((x) => typeof x === "string" && x.trim());
          if (extra.length) row.title = extra.join("\n\n");
          parts.push(row);
        }
      }
    }
    el.todos.replaceChildren(...parts);
    el.todos.hidden = false;
  }

  // ---- subagents (subagent_lifecycle / subagent_progress at level "progress") ----
  const AGENT_MARK = { pending: "○", running: "◐", completed: "●", failed: "✕", aborted: "⊘" };
  const agents = new Map(); // id -> { id, index, agent, description, task, status, progress }
  const agentTimers = new Map(); // id -> removal timer of a finished row
  function clearAgents() {
    for (const t of agentTimers.values()) clearTimeout(t);
    agentTimers.clear();
    agents.clear();
    renderAgents();
  }
  function dropFinishedAgents() {
    for (const [id, a] of agents) {
      if (a.status === "running" || a.status === "pending") continue;
      clearTimeout(agentTimers.get(id));
      agentTimers.delete(id);
      agents.delete(id);
    }
    renderAgents();
  }
  function upsertAgent(id, patch) {
    const a = { ...(agents.get(id) ?? { id, index: 0, agent: "agent", status: "running" }), ...patch };
    agents.set(id, a);
    if (a.status === "running" || a.status === "pending") {
      clearTimeout(agentTimers.get(id));
      agentTimers.delete(id);
    } else if (!agentTimers.has(id)) {
      // Keep a finished row a moment so its outcome can be read (and its transcript opened).
      agentTimers.set(id, setTimeout(() => {
        agentTimers.delete(id);
        agents.delete(id);
        renderAgents();
      }, 15000));
    }
    renderAgents();
    if (viewer?.id === id) loadSubagent(Date.now() - viewer.at > 2000 || !(a.status === "running" || a.status === "pending"));
  }
  function onSubagentFrame(frame) {
    const p = frame.payload && typeof frame.payload === "object" ? frame.payload : null;
    if (!p) return;
    if (frame.type === "subagent_lifecycle") {
      const id = str(p.id);
      if (!id) return;
      const status = p.status === "started" ? "running" : Object.hasOwn(AGENT_MARK, p.status) ? p.status : "running";
      const patch = { status, index: Number(p.index) || 0, agent: str(p.agent) || "agent" };
      if (str(p.description)) patch.description = p.description;
      upsertAgent(id, patch);
    } else {
      const pr = p.progress && typeof p.progress === "object" ? p.progress : {};
      const id = str(pr.id) || str(p.id);
      if (!id) return;
      const patch = { progress: pr, index: Number(p.index) || 0, agent: str(p.agent) || str(pr.agent) || "agent" };
      if (str(p.task)) patch.task = p.task;
      if (str(pr.description)) patch.description = pr.description;
      if (Object.hasOwn(AGENT_MARK, pr.status)) patch.status = pr.status;
      upsertAgent(id, patch);
    }
  }
  function renderAgents() {
    const list = [...agents.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    if (!list.length) {
      el.agents.replaceChildren();
      el.agents.hidden = true;
      return;
    }
    const running = list.filter((a) => a.status === "running" || a.status === "pending").length;
    const head = span("panel-head", `subagents ${running} running · ${list.length - running} done`);
    const rows = list.map((a) => {
      const row = document.createElement("div");
      row.className = "panel-row agent " + a.status;
      const what = oneLine(a.description || a.task || "");
      row.append(span("mark", AGENT_MARK[a.status] ?? "○"), span("name", a.agent), span("text", clip(what, 120)));
      if (a.task) row.title = a.task;
      const pr = a.progress || {};
      const meta = [];
      if (str(pr.lastIntent)) meta.push(clip(oneLine(pr.lastIntent), 60));
      else if (str(pr.currentTool)) meta.push(pr.currentTool);
      if (Number(pr.toolCount) > 0) meta.push(`${pr.toolCount} tools`);
      if (Number(pr.tokens) > 0) meta.push(fmtTok(Number(pr.tokens)) + " tok");
      if (meta.length) row.append(span("panel-sub", meta.join(" · ")));
      row.append(linkBtn("view", "Show its transcript and steer it", () => openSubagent(a.id)));
      if (a.status === "running" || a.status === "pending") row.append(linkBtn("stop", "Cancel this subagent", () => cancelSubagent(a.id)));
      return row;
    });
    el.agents.replaceChildren(head, ...rows);
    el.agents.hidden = false;
  }
  async function cancelSubagent(id) {
    try {
      const r = await request("cancel_subagent", { subagentId: id });
      if (r && r.cancelled === false) note("That subagent is no longer running.");
    } catch (e) {
      note("Could not stop the subagent: " + errText(e), true);
    }
  }
  // A subagent transcript, rendered like the main one: prompts, markdown replies, folded thinking and
  // tool cards (same bodies as the main transcript; a result that arrives in a later read fills its card).
  function subToolCard(v, call) {
    const root = document.createElement("details");
    root.className = "tool";
    const sum = document.createElement("summary");
    const c = { root, toolName: str(call.name) || "tool", args: isObj(call.arguments) ? call.arguments : {}, result: undefined, isError: false, done: false, expanded: new Set() };
    const arg = toolArg(c.toolName, c.args);
    const argEl = span("arg", clip(arg, 160));
    argEl.title = arg;
    c.badge = span("badge");
    c.badge.hidden = true;
    c.state = span("state", "running…");
    sum.append(span("name", c.toolName), argEl, c.badge, c.state);
    c.body = document.createElement("div");
    c.body.className = "tool-body";
    root.append(sum, c.body);
    c.paint = () => {
      blockMemo = c.expanded;
      blockSeq = 0;
      try {
        c.body.replaceChildren(...toolBody(c, note));
      } finally {
        blockMemo = null;
      }
    };
    root.addEventListener("toggle", () => root.open && c.paint());
    if (str(call.id)) v.cards.set(call.id, c);
    return c;
  }
  function subToolResult(v, m) {
    const c = v.cards.get(str(m.toolCallId));
    if (!c) return;
    c.result = m;
    c.isError = m.isError === true;
    c.done = true;
    const b = toolBadge(c);
    c.badge.hidden = !b;
    c.badge.textContent = b?.text ?? "";
    c.badge.className = "badge" + (b?.kind ? " " + b.kind : "");
    c.state.textContent = c.isError ? "error" : "done";
    c.root.classList.add(c.isError ? "err" : "done");
    if (c.isError) c.root.open = true;
    if (c.root.open) c.paint();
  }
  function subagentAppend(v, msgs) {
    const nodes = [];
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (!isObj(m)) continue;
      const n = v.count++;
      if (m.role === "user") {
        const t = (typeof m.content === "string" || Array.isArray(m.content) ? textOf(m.content) : "").trim();
        if (!t) continue;
        const u = document.createElement("div");
        u.className = "msg user";
        u.textContent = t;
        nodes.push(u);
      } else if (m.role === "assistant") {
        // Text and thinking go in a message bubble; each tool call closes it and adds its card.
        let a = null;
        const bubble = () => {
          if (!a) {
            a = document.createElement("div");
            a.className = "msg assistant";
            nodes.push(a);
          }
          return a;
        };
        (Array.isArray(m.content) ? m.content : []).forEach((b, bi) => {
          if (!isObj(b)) return;
          if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) bubble().append(thinkingBlock(`sub:${v.id}:${n}:${bi}`, b.thinking));
          else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) bubble().append(markdown(b.text, note));
          else if (b.type === "toolCall") {
            a = null;
            nodes.push(subToolCard(v, b).root);
          }
        });
        if (str(m.errorMessage)) nodes.push(span("error", m.errorMessage));
      } else if (m.role === "toolResult") {
        subToolResult(v, m);
      }
    }
    v.log.append(...nodes);
  }
  let viewer = null; // open subagent transcript: { id, log, cards, count, nextByte, loading, at }
  function openSubagent(id) {
    const a = agents.get(id);
    closeDialog();
    const h = document.createElement("h4");
    h.textContent = `${a?.agent ?? "subagent"} — ${clip(oneLine(a?.description || a?.task || id), 100)}`;
    const log = document.createElement("div");
    log.className = "sub-log";
    log.textContent = "Loading…";
    const field = document.createElement("input");
    field.placeholder = "Steer this subagent (Enter sends)";
    const steer = async () => {
      const message = field.value.trim();
      if (!message) return;
      try {
        await request("steer_subagent", { subagentId: id, message });
        field.value = "";
      } catch (e) {
        note("Could not steer the subagent: " + errText(e), true);
      }
    };
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        steer();
      }
    });
    const row = document.createElement("div");
    row.className = "row";
    row.append(btn("Steer", steer), btn("Refresh", () => loadSubagent(true)), btn("Stop", () => cancelSubagent(id)), btn("Close", closeDialog));
    el.dialog.append(h, log, field, row);
    el.dialog.hidden = false;
    el.dialog.scrollIntoView({ block: "nearest" });
    viewer = { id, log, cards: new Map(), count: 0, fresh: true, nextByte: undefined, loading: false, at: 0 };
    loadSubagent(true);
  }
  /** Read the viewed transcript from where the last read stopped (`fromByte`). */
  async function loadSubagent(force) {
    const v = viewer;
    if (!v || !el.dialog.contains(v.log)) return void (viewer = null); // the dialog was taken over
    if (v.loading || !force) return;
    v.loading = true;
    v.at = Date.now();
    try {
      const params = { subagentId: v.id };
      if (Number.isFinite(v.nextByte)) params.fromByte = v.nextByte;
      const r = await request("get_subagent_messages", params);
      const stick = v.log.scrollHeight - v.log.scrollTop - v.log.clientHeight < 40;
      if (r?.reset || v.fresh) {
        v.log.replaceChildren();
        v.cards.clear();
        v.count = 0;
        v.fresh = false;
      }
      v.log.querySelector(":scope > .sub-empty")?.remove();
      subagentAppend(v, r?.messages);
      if (Number.isFinite(r?.nextByte)) v.nextByte = r.nextByte;
      if (!v.log.childNodes.length) v.log.append(span("sub-empty", "(no messages yet)"));
      if (stick) v.log.scrollTop = v.log.scrollHeight;
    } catch (e) {
      v.log.replaceChildren(span("error", "Could not read the transcript: " + errText(e)));
      v.fresh = true;
      v.nextByte = undefined;
    } finally {
      v.loading = false;
    }
  }

  // ---- compaction ------------------------------------------------------------
  function compactionStarted(text) {
    setStatus("compacting…", "busy");
    note(text);
  }
  function compactionEnded(frame, auto) {
    const r = frame.result && typeof frame.result === "object" ? frame.result : null;
    let text;
    let error = false;
    if (frame.aborted) text = "Compaction cancelled.";
    else if (frame.skipped) text = "Nothing to compact" + (str(frame.errorMessage) ? ": " + frame.errorMessage : ".");
    else if (str(frame.errorMessage)) {
      text = "Compaction failed: " + frame.errorMessage;
      error = true;
    } else text = `Context compacted${Number.isFinite(r?.tokensBefore) ? ` (was ${fmtTok(r.tokensBefore)} tokens)` : ""}.`;
    if (auto && frame.willRetry) text += " Retrying the turn.";
    const n = note(text, error);
    if (str(r?.summary)) noteAction(n, "Show summary", () => {
      const s = note(r.summary, false, "output");
      s.style.whiteSpace = "pre-wrap";
    });
    setStatus(busy ? "working…" : "ready", busy ? "busy" : "ok");
    refreshStats();
  }

  // ---- goal (goal_updated, get_state.goal): a chip in the status line ------------
  let goal = null;
  const GOAL_LABEL = { active: "goal", paused: "goal paused", "budget-limited": "goal over budget", complete: "goal done" };
  function setGoal(g) {
    goal = g && typeof g === "object" && typeof g.objective === "string" && g.status !== "dropped" ? g : null;
    el.goal.hidden = !goal;
    if (!goal) return;
    el.goal.textContent = `${GOAL_LABEL[goal.status] ?? "goal"} · ${clip(oneLine(goal.objective), 40)}`;
    el.goal.title = goalText(goal);
  }
  function goalText(g) {
    const lines = [g.objective, `status: ${g.status}`];
    const used = Number(g.tokensUsed) || 0;
    lines.push(`tokens: ${fmtTok(used)}${Number(g.tokenBudget) > 0 ? " / " + fmtTok(Number(g.tokenBudget)) : ""}`);
    const sec = Number(g.timeUsedSeconds) || 0;
    if (sec) lines.push(`time: ${sec < 120 ? sec + "s" : Math.round(sec / 60) + "m"}`);
    return lines.join("\n");
  }
  async function goalOp(op, extra) {
    try {
      const r = await request("goal", { op, ...extra }, 60000);
      setGoal(r?.goal ?? null);
      return r;
    } catch (e) {
      note(`goal ${op} failed: ${errText(e)}`, true);
      return null;
    }
  }
  el.goal.addEventListener("click", async () => {
    if (!goal) return;
    const acts = goal.status === "active" ? ["Pause", "Drop", "Close"] : goal.status === "complete" ? ["Drop", "Close"] : ["Resume", "Drop", "Close"];
    const pick = await askLocal("Goal", goalText(goal), acts);
    const op = { Pause: "pause", Resume: "resume", Drop: "drop" }[acts[pick]];
    if (op) goalOp(op);
  });
  /** `/goal [show|pause|resume|drop|set <objective>|<objective>]` (TUI-only in omp, so handled here). */
  async function runGoal(arg) {
    const [word, ...rest] = arg.split(/\s+/);
    const w = (word || "").toLowerCase();
    if (!w || w === "show" || w === "status") {
      const r = await goalOp("get");
      if (r) note(r.goal ? goalText(r.goal) : "No goal is set. Use /goal <objective> to set one.", false, "output").style.whiteSpace = "pre-wrap";
    } else if (w === "pause" || w === "resume" || w === "drop") {
      const r = await goalOp(w);
      if (r) note(w === "drop" ? "Goal dropped." : `Goal ${w === "pause" ? "paused" : "resumed"}.`);
    } else {
      const objective = (w === "set" ? rest.join(" ") : arg).trim();
      if (!objective) return note("Usage: /goal <objective>", true);
      const r = await goalOp("create", { objective });
      if (r?.goal) note("Goal set: " + r.goal.objective);
    }
  }

  // ---- /btw side questions (btw_delta / btw_record) ----------------------------
  const btwCards = new Map(); // recordId -> { root, q, answer, state, cancel }
  function btwCard(id) {
    let c = btwCards.get(id);
    if (c) return c;
    const root = document.createElement("div");
    root.className = "msg output btw";
    const q = span("btw-q", "btw");
    const state = span("panel-sub", "");
    const answer = document.createElement("div");
    answer.className = "btw-a";
    const cancel = linkBtn("cancel", "Cancel this side question", async () => {
      try {
        await request("btw_cancel", { recordId: id });
      } catch (e) {
        note("Could not cancel: " + errText(e), true);
      }
    });
    root.append(q, state, cancel, answer);
    el.messages.append(root);
    c = { root, q, answer, state, cancel };
    btwCards.set(id, c);
    scrollDown();
    return c;
  }
  function renderBtw(rec) {
    if (!rec || typeof rec !== "object" || !str(rec.id)) return;
    const c = btwCard(rec.id);
    if (typeof rec.question === "string") c.q.textContent = "btw · " + rec.question;
    const parts = [typeof rec.answer === "string" ? rec.answer : ""];
    for (const f of Array.isArray(rec.followUps) ? rec.followUps : []) {
      if (f && typeof f.question === "string") parts.push(`› ${f.question}\n${typeof f.answer === "string" ? f.answer : ""}`);
    }
    const running = rec.status === "running";
    const text = parts.filter(Boolean).join("\n\n");
    // A running snapshot can trail the btw_delta frames already appended; never shrink it then.
    if (!running || text.length >= c.answer.textContent.length) c.answer.textContent = text;
    c.state.textContent = running ? " · thinking…" : rec.status === "complete" ? "" : ` · ${rec.status}${str(rec.error) ? ": " + rec.error : ""}`;
    c.root.classList.toggle("error", rec.status === "error");
    c.cancel.hidden = !running;
    scrollDown();
  }
  async function runBtw(question) {
    if (!question) {
      try {
        const r = await request("get_btw_history", {});
        const recs = (Array.isArray(r?.records) ? r.records : []).filter((x) => x && typeof x.question === "string");
        if (!recs.length) return note("No side questions yet. Use /btw <question>.");
        const n = note(recs.map((x) => `• ${x.question}${x.status === "complete" ? "" : ` (${x.status})`}\n  ${clip(oneLine(x.answer), 200)}`).join("\n"), false, "output");
        n.style.whiteSpace = "pre-wrap";
      } catch (e) {
        note("Could not read the side questions: " + errText(e), true);
      }
      return;
    }
    try {
      renderBtw(await request("btw", { question }, 60000).then((r) => r?.record));
    } catch (e) {
      note("Side question failed: " + errText(e), true);
    }
  }

  /** `/queue [message]`: queue a follow-up for after the current turn, or list the queue. */
  async function runQueue(arg, images) {
    if (!arg && !images) {
      if (!queueSize()) return note("The queue is empty.");
      const n = note([...queue.steering.map((t) => "steer · " + t), ...queue.followUp.map((t) => "queued · " + t)].join("\n"), false, "output");
      n.style.whiteSpace = "pre-wrap";
      return;
    }
    try {
      const params = { message: arg };
      if (images) params.images = images;
      noteQueuedImages(arg, images);
      await request("follow_up", params);
    } catch (e) {
      note("Could not queue the message: " + errText(e), true);
    }
  }
  /** Copy `text`, then report on `btn` (a link button) or, without one, with a note. */
  function copyText(text, btn, what = "Text") {
    const label = btn?.textContent;
    const done = (ok) => {
      if (!btn) return note(ok ? what + " copied." : "Could not copy to the clipboard.", !ok);
      btn.textContent = ok ? "copied" : "copy failed";
      setTimeout(() => (btn.textContent = label), 1200);
    };
    const p = text ? navigator.clipboard?.writeText(text) : null;
    if (p) p.then(() => done(true), () => done(false));
    else done(false);
  }
  /** `/copy [code|cmd]`: the last answer (as omp has it), its last code block, or the last shell command. */
  async function runCopy(arg) {
    const what = arg.toLowerCase();
    if (what === "code") {
      const blocks = el.messages.querySelectorAll(".msg.assistant .codeblock pre");
      const last = blocks[blocks.length - 1];
      return last ? copyText(last.textContent, null, "Code block") : note("No code block to copy.");
    }
    if (what === "cmd" || what === "command") {
      const cmd = (await loadHistory()).find((x) => x.startsWith("!"));
      return cmd ? copyText(cmd.replace(/^!!?\s*/, ""), null, "Command") : note("No shell command to copy.");
    }
    if (what) return note("Usage: /copy [code|cmd]", true);
    try {
      const r = await request("get_last_assistant_text", {}, 5000);
      const text = isObj(r) ? str(r.text) : "";
      if (!text) return note("No answer to copy yet.");
      copyText(text, null, "Last answer");
    } catch (e) {
      note("Could not read the last answer: " + errText(e), true);
    }
  }
  /**
   * `/export [path]`: omp writes the HTML (`export_html`), the desktop offers to open it. `--themes` is a
   * TUI option this RPC lacks: that form goes to omp's own /export.
   */
  async function runExport(arg) {
    if (/(^|\s)--themes(\s|$)/.test(arg)) {
      const cmd = { type: "prompt", message: "/export " + arg };
      if (busy) cmd.streamingBehavior = "followUp"; // omp rejects a bare prompt during a turn
      return send(cmd);
    }
    try {
      const r = await request("export_html", arg ? { outputPath: arg } : {}, 60000);
      const path = isObj(r) ? str(r.path) : "";
      if (!path) return note("Export finished, but omp did not say where the file is.", true);
      const n = note("Session exported to " + path);
      noteAction(n, "Open", () => invoke("open_file", { path }).catch((e) => note("Could not open the file: " + errText(e), true)));
      noteAction(n, "Copy path", () => copyText(path, null, "Path"));
    } catch (e) {
      note("Could not export the session: " + errText(e), true);
    }
  }
  const HOTKEYS = [
    ["Composer", ""],
    ["Enter", "Send (steers the running turn)"],
    ["Alt+Enter", "Queue as a follow-up for after the turn"],
    ["Shift+Enter", "New line"],
    ["Esc", "Close the popup / drop the suggestion / stop the turn"],
    ["↑ / ↓", "Prompt history (on an empty editor)"],
    ["Ctrl+R", "Search the prompt history (again: next match)"],
    ["Tab / →", "Accept the suggestion or the highlighted completion"],
    ["/  @  !", "Commands, file mentions, shell command"],
    ["Ctrl+V", "Paste an image"],
    ["Session", ""],
    ["Shift+Tab", "Cycle the thinking level"],
    ["Ctrl+T", "Show or hide thinking"],
    ["Ctrl+O", "Expand or collapse tool output"],
    ["Window", ""],
    ["Ctrl+B", "Show or hide the sidebar"],
    ["Ctrl+Shift+T", "New session"],
    ["Ctrl+Shift+5", "New session split to the right"],
    ["Alt+L", "Next saved layout"],
    ["F2", "Rename (session tree, layout list)"],
    ["Ctrl+/", "This list (also /hotkeys)"],
  ];
  function showHotkeys() {
    const width = Math.max(...HOTKEYS.map(([k]) => k.length)) + 3;
    const text = HOTKEYS.map(([k, d]) => (d ? "  " + k.padEnd(width) + d : k)).join("\n");
    const n = note(text, false, "output");
    n.style.whiteSpace = "pre";
    n.style.fontFamily = "var(--mono)";
  }
  // Built-in TUI commands omp does not run over RPC; a newer omp that advertises one wins, unless the
  // desktop's version adds something (`override`: /export can open the file).
  const LOCAL_COMMANDS = [
    { name: "btw", description: "Ask a side question without interrupting the turn (bare: list them)", input: { hint: "<question>" }, run: (arg) => runBtw(arg) },
    { name: "copy", description: "Copy the last answer (code: its last code block, cmd: the last shell command)", input: { hint: "[code|cmd]" }, run: (arg) => runCopy(arg) },
    { name: "export", override: true, description: "Export the session to an HTML file and open it", input: { hint: "[path]" }, run: (arg) => runExport(arg) },
    { name: "goal", description: "Show or set the session goal: pause, resume, drop, <objective>", input: { hint: "[objective|pause|resume|drop]" }, run: (arg) => runGoal(arg) },
    { name: "hotkeys", description: "Show the keyboard shortcuts", run: () => showHotkeys() },
    { name: "queue", description: "Queue a message for after the current turn (bare: show the queue)", input: { hint: "<message>" }, run: (arg, images) => runQueue(arg, images) },
  ];
  const advertised = (name) => commands.some((c) => c.name.toLowerCase() === name || (c.aliases || []).some((a) => a.toLowerCase() === name));
  const localFor = (name) => LOCAL_COMMANDS.find((c) => c.name === name && (c.override || !advertised(name))) ?? null;

  // ---- branching: actions on user messages, the session tree -------------
  const userText = new WeakMap(); // user message element -> its text as omp stores it
  const squash = (s) => String(s ?? "").replace(/\s+/g, "");
  function linkBtn(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  function userActions(node) {
    const bar = document.createElement("div");
    bar.className = "msg-acts";
    const copy = linkBtn("copy", "Copy this message", () => copyText(userText.get(node) ?? node.textContent, copy));
    bar.append(
      copy,
      linkBtn("branch", "Branch from here: go back to before this message and edit it", () => branchFrom(node, "branch")),
      linkBtn("fork", "Fork: copy the session up to this message into a new session", () => branchFrom(node, "fork")),
    );
    return bar;
  }
  /** Tree nodes by entry id (iterative: long sessions are deep chains). */
  function indexTree(roots) {
    const byId = new Map();
    const stack = Array.isArray(roots) ? [...roots] : [];
    while (stack.length) {
      const n = stack.pop();
      if (!n?.entry || typeof n.entry.id !== "string") continue;
      byId.set(n.entry.id, n);
      if (Array.isArray(n.children)) stack.push(...n.children);
    }
    return byId;
  }
  /** Entries from the root to `leafId`, oldest first. */
  function activePath(byId, leafId) {
    const path = [];
    const seen = new Set();
    let id = leafId;
    while (typeof id === "string" && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      const entry = byId.get(id).entry;
      path.push(entry);
      id = entry.parentId;
    }
    return path.reverse();
  }
  /**
   * The entry id behind a rendered user message. Candidates come from `get_branch_messages`, kept to
   * the active path (from `get_tree`) in path order; the transcript is a suffix of that path (it may
   * start after a compaction), so the node is matched by its position from the end, checked by text.
   */
  async function entryIdFor(node) {
    const [branchable, treeData] = await Promise.all([request("get_branch_messages"), request("get_tree")]);
    const byId = indexTree(treeData?.tree);
    const order = new Map(activePath(byId, treeData?.leafId).map((e, i) => [e.id, i]));
    const list = (Array.isArray(branchable?.messages) ? branchable.messages : [])
      .filter((c) => c && typeof c.entryId === "string" && order.has(c.entryId))
      .filter((c) => {
        const m = byId.get(c.entryId).entry.message;
        return !(m?.synthetic || m?.steering);
      })
      .sort((a, b) => order.get(a.entryId) - order.get(b.entryId));
    const nodes = [...el.messages.querySelectorAll(".msg.user")];
    const fromEnd = nodes.length - 1 - nodes.indexOf(node);
    const want = squash(userText.get(node));
    const guess = list[list.length - 1 - fromEnd];
    if (guess && squash(guess.text) === want) return guess.entryId;
    const byText = list.filter((c) => squash(c.text) === want);
    if (byText.length === 1) return byText[0].entryId;
    throw new Error("this message is not on the session's current branch");
  }
  async function branchFrom(node, kind) {
    if (busy) return note(`Wait for the turn to finish (or stop it) before you ${kind}.`, true);
    try {
      const entryId = await entryIdFor(node);
      if (kind === "fork") return forkSession(entryId);
      const r = await request("branch", { entryId }, 60000);
      if (r?.cancelled) return note("Branch cancelled.");
      reloadTranscript("— branched: edit the message and send it —");
      if (typeof r?.text === "string" && r.text) {
        el.input.value = r.text;
        autosize();
      }
      el.input.focus();
    } catch (e) {
      note(`Could not ${kind}: ${errText(e)}`, true);
    }
  }
  /** `fork` the whole session, or up to `entryId`, into a new session file. */
  async function forkSession(entryId) {
    try {
      const r = await request("fork", entryId ? { entryId } : {}, 60000);
      if (r?.cancelled) return note("Fork cancelled.");
      reloadTranscript("— forked into a new session —");
    } catch (e) {
      note("Could not fork: " + errText(e), true);
    }
  }

  // Tree panel: `get_tree` rows; a click is `navigate_tree` (refused while a turn runs).
  const TREE_MAX_ROWS = 2000;
  let treeSeq = 0; // drops stale get_tree answers
  let treeLimit = TREE_MAX_ROWS; // rows painted; "show more" raises it, opening the panel resets it
  function buildTreePanel() {
    const h = document.createElement("h4");
    h.textContent = "Session tree";
    const bar = document.createElement("div");
    bar.className = "row tree-bar";
    const sumLabel = document.createElement("label");
    sumLabel.className = "tree-sum";
    const sum = document.createElement("input");
    sum.type = "checkbox";
    sumLabel.append(sum, "summarize the branch you leave");
    const fork = btn("Fork session", () => forkSession());
    fork.title = "Copy the whole session into a new session";
    const cancel = btn("Cancel summary", () => request("abort_branch_summary").catch((e) => note("Could not cancel: " + errText(e), true)));
    cancel.hidden = true;
    const close = btn("Close", () => toggleTree(false));
    bar.append(sumLabel, fork, cancel, close);
    const state = document.createElement("div");
    state.className = "tree-status";
    const info = document.createElement("div");
    info.className = "tree-status";
    const list = document.createElement("div");
    list.className = "tree-list";
    list.setAttribute("role", "list");
    el.tree.append(h, bar, state, list, info);
    treeUi = { list, info, state, sum, cancel, fork };
  }
  function toggleTree(open = el.tree.hidden) {
    el.tree.hidden = !open;
    el.treeBtn.classList.toggle("on", open);
    el.treeBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    if (!treeUi) buildTreePanel();
    treeLimit = TREE_MAX_ROWS;
    paintTreeBusy();
    loadTree();
  }
  el.treeBtn.addEventListener("click", () => toggleTree());
  function paintTreeBusy() {
    if (!treeUi) return;
    const off = busy || navPending;
    el.tree.classList.toggle("off", off);
    treeUi.fork.disabled = off;
    treeUi.sum.disabled = navPending;
    treeUi.cancel.hidden = !(navPending && navSummarize);
    treeUi.state.textContent = navPending
      ? (navSummarize ? "Summarizing the branch you leave…" : "Moving…")
      : busy ? "Wait for the turn to finish to move in the tree." : "";
  }
  async function loadTree() {
    if (!treeUi) return;
    const mine = ++treeSeq;
    try {
      const data = await request("get_tree");
      if (mine === treeSeq) renderTree(data);
    } catch (e) {
      if (mine === treeSeq) treeUi.info.textContent = "Could not read the tree: " + errText(e);
    }
  }
  /** What a tree row shows for an entry; null skips it (its children still show). */
  function entryPreview(entry) {
    const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    switch (entry?.type) {
      case "message": {
        const m = entry.message;
        if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
        if (m.role === "user") return m.synthetic || m.steering ? null : { kind: "user", text: one(textOf(m.content)) || "(image)" };
        const calls = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "toolCall" && b.name).map((b) => b.name);
        const text = one(textOf(m.content)) || (calls.length ? "→ " + calls.join(", ") : one(m.errorMessage) || "(no text)");
        return { kind: "assistant", text };
      }
      case "branch_summary":
        return { kind: "summary", text: "branch summary: " + one(entry.summary) };
      case "compaction":
        return { kind: "summary", text: "compacted" + (entry.tokensBefore > 0 ? ` (${fmtTok(entry.tokensBefore)} tokens before)` : "") };
      case "custom_message":
        return entry.display === false ? null : { kind: "summary", text: (entry.customType ? entry.customType + ": " : "") + one(textOf(entry.content)) };
      default:
        return null;
    }
  }
  /** `keepScroll`: list scroll offset to restore ("show more" repaints without jumping to the leaf). */
  function renderTree(data, keepScroll = 0) {
    const roots = Array.isArray(data?.tree) ? data.tree : [];
    const byId = indexTree(roots);
    const onPath = new Set(activePath(byId, typeof data?.leafId === "string" ? data.leafId : null).map((e) => e.id));
    const list = treeUi.list;
    list.replaceChildren();
    let rows = 0;
    let total = 0;
    let here = null;
    // Depth grows only below a fork point, so a straight conversation stays flush left.
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: roots.length > 1 ? 1 : 0 });
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (!node?.entry || typeof node.entry.id !== "string") continue;
      const preview = entryPreview(node.entry);
      if (preview) {
        total++;
        if (rows < treeLimit) {
          const row = treeRow(node, preview, depth, onPath.has(node.entry.id));
          if (onPath.has(node.entry.id)) here = row;
          list.append(row);
          rows++;
        }
      }
      const kids = Array.isArray(node.children) ? node.children : [];
      const next = kids.length > 1 ? depth + 1 : depth;
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], depth: next });
    }
    here?.classList.add("here");
    if (!keepScroll) here?.scrollIntoView({ block: "nearest" });
    else list.scrollTop = keepScroll;
    treeUi.info.replaceChildren();
    if (!total) treeUi.info.textContent = "No messages yet.";
    else if (total > rows) {
      const more = Math.min(TREE_MAX_ROWS, total - rows);
      treeUi.info.append(
        `Showing the first ${rows} of ${total} entries. `,
        btn(`Show ${more} more`, () => { treeLimit += TREE_MAX_ROWS; renderTree(data, list.scrollTop || 1); }),
      );
    }
    paintTreeBusy();
  }
  function treeRow(node, preview, depth, on) {
    const id = node.entry.id;
    const row = document.createElement("div");
    row.className = "layout-item tree-row " + preview.kind + (on ? " on" : "");
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    row.style.paddingLeft = 8 + depth * 14 + "px";
    const when = new Date(node.entry.timestamp);
    row.title = (on ? "On the current branch" : "Click to move here") + (isNaN(when) ? "" : " · " + when.toLocaleString());
    const text = span("layout-label tree-text", preview.text);
    row.append(span("tree-mark", on ? "●" : "○"), text);
    const label = typeof node.label === "string" && node.label ? node.label : null;
    if (label) row.append(span("tree-label", label));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "layout-act";
    edit.textContent = "✎";
    edit.title = label ? "Change label" : "Add label";
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      editLabel(row, text, id, label);
    });
    row.append(edit);
    row.addEventListener("click", (e) => {
      if (e.target.closest(".layout-act, .layout-input")) return;
      navigate(id);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigate(id);
      } else if (e.key === "F2") {
        editLabel(row, text, id, label);
      }
    });
    return row;
  }
  function editLabel(row, text, entryId, current) {
    if (row.querySelector(".layout-input")) return;
    const input = document.createElement("input");
    input.className = "layout-input";
    input.value = current ?? "";
    input.maxLength = 60;
    input.placeholder = "label (empty clears it)";
    input.setAttribute("aria-label", "Entry label");
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove();
      text.style.display = "";
      if (!ok || v === (current ?? "")) return;
      try {
        await request("set_label", v ? { entryId, label: v } : { entryId });
      } catch (e) {
        note("Could not set the label: " + errText(e), true);
      }
      loadTree();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    text.style.display = "none";
    text.after(input);
    input.select();
  }
  async function navigate(entryId) {
    if (busy || navPending) return;
    navPending = true;
    navSummarize = !!treeUi?.sum.checked;
    paintTreeBusy();
    try {
      // A branch summary is a model call: allow it the server's own 10-minute budget.
      const r = await request("navigate_tree", { entryId, summarize: navSummarize }, 600000);
      if (r?.aborted) note("Branch summary cancelled; stayed where you were.");
      else if (r?.cancelled) note("Move cancelled.");
      else {
        reloadTranscript("— moved to another point in the session tree —");
        if (typeof r?.editorText === "string" && r.editorText) {
          el.input.value = r.editorText;
          autosize();
          el.input.focus();
        }
      }
    } catch (e) {
      note("Could not move in the tree: " + errText(e), true);
    } finally {
      navPending = false;
      navSummarize = false;
      paintTreeBusy();
      loadTree();
    }
  }

  // ---- model picker + history ------------------------------------------
  let currentModel = null;
  let availableModels = [];
  const modelKey = (m) => m.provider + "/" + m.id;
  function renderModels() {
    const sel = el.model;
    sel.replaceChildren();
    for (const m of availableModels) {
      const o = document.createElement("option");
      o.value = modelKey(m);
      o.textContent = modelKey(m);
      sel.append(o);
    }
    if (currentModel && !availableModels.some((m) => modelKey(m) === modelKey(currentModel))) {
      const o = document.createElement("option");
      o.value = modelKey(currentModel);
      o.textContent = modelKey(currentModel);
      sel.append(o);
    }
    if (currentModel) sel.value = modelKey(currentModel);
    sel.hidden = !sel.options.length;
    syncPicker(sel);
    renderEffort();
  }
  // ---- chip + popup menu over a (hidden) <select>, styled like the folder menu ------------
  // The select stays the source of truth (options, value, change event); the chip mirrors it.
  const pickers = new Map();
  let pickMenu = null;
  function closePickMenu() {
    if (!pickMenu) return;
    pickMenu.remove();
    pickMenu = null;
    document.removeEventListener("pointerdown", onPickOutside, true);
    document.removeEventListener("keydown", onPickKey, true);
  }
  function onPickOutside(e) {
    if (pickMenu && !pickMenu.contains(e.target) && !pickMenu.owner.contains(e.target)) closePickMenu();
  }
  function onPickKey(e) {
    if (e.key === "Escape") return closePickMenu();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...pickMenu.querySelectorAll(".pick-item")];
    const i = items.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[next]?.focus();
    e.preventDefault();
  }
  function syncPicker(sel) {
    let btn = pickers.get(sel);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = sel.className;
      btn.title = sel.title;
      btn.setAttribute("aria-haspopup", "menu");
      sel.after(btn);
      pickers.set(sel, btn);
      btn.addEventListener("click", () => {
        const reopen = !(pickMenu && pickMenu.owner === btn);
        closePickMenu();
        if (reopen) openPickMenu(sel, btn);
      });
      const label = document.createElement("span");
      label.className = "pick-label";
      const caret = document.createElement("span");
      caret.className = "pick-caret";
      caret.setAttribute("aria-hidden", "true");
      btn.append(label, caret);
    }
    btn.hidden = sel.hidden;
    const opt = sel.selectedOptions[0];
    btn.querySelector(".pick-label").textContent = opt ? opt.textContent : sel.value;
  }
  function openPickMenu(sel, btn) {
    const menu = document.createElement("div");
    menu.className = "pick-menu";
    menu.setAttribute("role", "menu");
    menu.owner = btn;
    for (const o of sel.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pick-item" + (o.value === sel.value ? " current" : "");
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(o.value === sel.value));
      b.title = o.value;
      const check = document.createElement("i");
      check.textContent = o.value === sel.value ? "✓" : "";
      b.append(check);
      const slash = sel === el.model ? o.textContent.indexOf("/") : -1;
      if (slash > 0) {
        const prov = document.createElement("s");
        prov.textContent = o.textContent.slice(0, slash + 1);
        const name = document.createElement("b");
        name.textContent = o.textContent.slice(slash + 1);
        b.append(prov, name);
      } else {
        const name = document.createElement("b");
        name.textContent = o.textContent;
        b.append(name);
      }
      b.addEventListener("click", () => {
        closePickMenu();
        if (o.value === sel.value) return;
        sel.value = o.value;
        sel.dispatchEvent(new Event("change"));
      });
      menu.append(b);
    }
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
    const above = r.top - 6 - menu.offsetHeight >= 8;
    menu.style.top = above ? r.top - 6 - menu.offsetHeight + "px" : Math.min(r.bottom + 6, Math.max(8, innerHeight - menu.offsetHeight - 8)) + "px";
    menu.style.transformOrigin = (above ? "bottom" : "top") + " left";
    pickMenu = menu;
    document.addEventListener("pointerdown", onPickOutside, true);
    document.addEventListener("keydown", onPickKey, true);
    (menu.querySelector(".pick-item.current") || menu.querySelector(".pick-item"))?.focus();
  }
  el.model.addEventListener("change", () => {
    const m = availableModels.find((x) => modelKey(x) === el.model.value);
    if (m) send({ id: "setmodel", type: "set_model", provider: m.provider, modelId: m.id });
  });
  // ---- effort: the thinking level, beside the model ---------------------
  // `get_state` seeds it and `thinking_level_changed` / `config_update` follow it. The options come
  // from `get_available_thinking_levels` (refetched per model). `auto` is not in that list and
  // `set_thinking_level` takes only concrete levels, so auto is reached by shift+tab
  // (`cycle_thinking_level`) and shown as "auto · <resolved>" while it is on.
  let thinkingLevel = null;
  let autoEffort = null; // null = not in auto; otherwise the resolved level, or "auto" before the first turn
  let thinkingLevels = null; // null = not fetched (or failed): fall back to currentModel.thinking
  let levelsGen = 0;
  const optionOf = (value, text) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  };
  function renderEffort() {
    const sel = el.effort;
    const levels = Array.isArray(thinkingLevels) ? thinkingLevels.filter((l) => typeof l === "string") : null;
    const thinks = levels ? levels.some((l) => l !== "off") : Boolean(currentModel?.thinking);
    if (!currentModel || !thinks) {
      sel.hidden = true;
      sel.replaceChildren();
      syncPicker(sel);
      return;
    }
    const current = autoEffort !== null ? "auto" : (thinkingLevel ?? "off");
    const opts = (levels ?? [current]).map((l) => optionOf(l, "effort " + l));
    if (current === "auto") opts.unshift(optionOf("auto", autoEffort === "auto" ? "effort auto" : "effort auto · " + autoEffort));
    else if (!opts.some((o) => o.value === current)) opts.push(optionOf(current, "effort " + current));
    sel.replaceChildren(...opts);
    sel.value = current;
    sel.hidden = false;
    syncPicker(sel);
  }
  async function loadThinkingLevels() {
    const gen = ++levelsGen;
    try {
      const data = await request("get_available_thinking_levels");
      if (gen !== levelsGen) return;
      thinkingLevels = Array.isArray(data?.levels) ? data.levels : null;
    } catch {
      if (gen !== levelsGen) return;
      thinkingLevels = null;
    }
    renderEffort();
  }
  // A concrete pick (or any level in a frame) leaves auto; "auto" itself enters it.
  function applyLevel(level) {
    if (typeof level !== "string") return;
    if (level === "auto") autoEffort = autoEffort ?? "auto";
    else {
      thinkingLevel = level;
      autoEffort = null;
    }
  }
  el.effort.addEventListener("change", async () => {
    const level = el.effort.value;
    if (!level || level === "auto") return renderEffort();
    try {
      await request("set_thinking_level", { level });
      applyLevel(level);
    } catch (e) {
      note("Could not set thinking level: " + (e?.message || String(e)), true);
    }
    renderEffort();
  });
  async function cycleEffort() {
    try {
      const data = await request("cycle_thinking_level");
      if (!data || typeof data.level !== "string") return note("This model has no thinking levels.");
      applyLevel(data.level);
      renderEffort();
    } catch (e) {
      note("Could not change thinking level: " + (e?.message || String(e)), true);
    }
  }
  function renderHistory(list) {
    let n = 0;
    list.forEach((m, i) => {
      if (m.role === "user" || m.role === "assistant") {
        renderMessage("h" + i, m);
        n++;
        if (m.role === "assistant") {
          for (const b of m.content || []) {
            if (!isObj(b) || b.type !== "toolCall") continue;
            updateTool({ toolCallId: b.id, toolName: b.name, intent: b.intent }, { args: b.arguments });
          }
        }
      } else if (m.role === "toolResult") {
        updateTool({ toolCallId: m.toolCallId, toolName: m.toolName }, { result: m, isError: !!m.isError, done: true });
      } else if (m.role === "bashExecution" && str(m.command)) {
        updateTool({ toolCallId: "h" + i, toolName: "bash", intent: bashIntent(m.excludeFromContext === true) }, { args: { command: m.command }, ...bashPatch(m) });
      }
    });
    const text = histNote ?? (n ? "— previous session restored —" : null);
    histNote = null;
    if (text) note(text);
    pinned = true;
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: "instant" });
  }
  // ---- request/response bridge for other panels (settings) ---------------
  // Each call gets its own id; the matching response frame settles its promise.
  const pending = new Map();
  let nextReq = 0;
  let readyGate = null;
  function resetReady() {
    let open;
    const p = new Promise((r) => (open = r));
    readyGate = { promise: p, open, isOpen: false };
  }
  resetReady();
  async function request(type, params = {}, timeoutMs = 20000) {
    if (!readyGate.isOpen) {
      const waited = await Promise.race([readyGate.promise.then(() => true), new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
      if (!waited) throw new Error("omp is not running");
    }
    const reqId = "req-" + ++nextReq;
    let settle;
    const p = new Promise((resolve, reject) => (settle = { resolve, reject }));
    const timer = setTimeout(() => {
      pending.delete(reqId);
      settle.reject(new Error(`${type}: no answer from omp`));
    }, timeoutMs);
    pending.set(reqId, { ...settle, timer });
    invoke("rpc_send", { id: sid, line: JSON.stringify({ ...params, id: reqId, type }) }).catch((e) => {
      clearTimeout(timer);
      pending.delete(reqId);
      settle.reject(new Error(String(e)));
    });
    return p;
  }

  function onResponse(frame) {
    const waiter = frame.id && pending.get(frame.id);
    if (waiter) {
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.success === false) {
        const err = new Error(frame.error || "unknown error");
        if (typeof frame.code === "string") err.code = frame.code; // e.g. "cancelled"
        waiter.reject(err);
      } else waiter.resolve(frame.data);
      return;
    }
    if (frame.success === false) {
      if (frame.id === "setmodel") renderModels(); // revert the picker
      // An older omp without set_ask_dialog keeps using single dialogs; nothing to report.
      // "subsub": an older omp without subagent events just shows no subagent panel.
      // "evfilter": without bash_output chunks, full bash snapshots keep arriving.
      if (!["hist", "stats", "askdlg", "warns", "todos", "subsub", "evfilter"].includes(frame.id)) note(`${frame.command || "command"} failed: ${frame.error || "unknown error"}`, true);
      return;
    }
    const data = frame.data || {};
    if (frame.id === "state") {
      currentModel = data.model || null;
      thinkingLevel = data.thinkingLevel ?? null;
      // Older omp has no configuredThinkingLevel: assume a concrete level. Under auto the
      // resolved level arrives with the next `thinking_level_changed`.
      autoEffort = data.configuredThinkingLevel === "auto" ? "auto" : null;
      wordCompletion = typeof data.wordCompletion === "string" ? data.wordCompletion : null;
      if (wordCompletion === "off") hideGhost(false);
      renderModels();
      loadThinkingLevels();
      sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : null;
      hooks.sessionFile?.(sessionFile);
      hooks.title?.(typeof data.sessionName === "string" ? data.sessionName : null, true);
      setWarnings(data.configWarnings);
      if (data.queuedMessages && typeof data.queuedMessages === "object") setQueue(data.queuedMessages);
      setTodos(data.todoPhases);
      setGoal(data.goal && typeof data.goal === "object" ? data.goal.goal : null);
    } else if (frame.id === "todos") {
      setTodos(data.todoPhases);
    } else if (frame.id === "warns") {
      setWarnings(data.configWarnings);
    } else if (frame.id === "mstate") {
      // model_changed: only the model (a full "state" would also reset the auto-effort display).
      if (data.model && typeof data.model === "object" && typeof data.model.provider === "string") {
        currentModel = data.model;
        renderModels();
        loadThinkingLevels();
      }
    } else if (frame.id === "sfile") {
      sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : null;
      hooks.sessionFile?.(sessionFile);
    } else if (frame.id === "models") {
      availableModels = data.models || [];
      renderModels();
    } else if (frame.id === "hist") {
      renderHistory(data.messages || []);
      refreshStats();
    } else if (frame.id === "stats") {
      sessionStats = data;
      renderTotal();
    } else if (frame.id === "setmodel") {
      if (data && typeof data === "object" && data.provider) currentModel = data;
      renderModels();
      loadThinkingLevels();
    } else if (frame.id === "cmds") {
      setCommands(data.commands);
    }
  }
  // ---- frames -----------------------------------------------------------
  function onFrame(frame) {
    switch (frame.type) {
      case "ready":
        setBusy(false);
        alive = true;
        readyGate.isOpen = true;
        readyGate.open();
        bashExclude = frame.supportsBashExcludeFromContext === true;
        send({ id: "state", type: "get_state" });
        send({ id: "models", type: "get_available_models" });
        send({ id: "cmds", type: "get_available_commands" });
        send({ id: "askdlg", type: "set_ask_dialog", enabled: true }); // multi-question `ask` requests
        send({ id: "subsub", type: "set_subagent_subscription", level: "progress" }); // subagent panel
        // Running bash output as bash_output splices; an older omp ignores the field and keeps sending snapshots.
        send({ id: "evfilter", type: "set_event_filter", events: null, bashOutput: "chunks" });
        if (resumed) send({ id: "hist", type: "get_messages" });
        break;
      case "response":
        onResponse(frame);
        break;
      case "agent_start":
        clearRecapHint();
        lastAnswer = "";
        setBusy(true);
        break;
      case "message_start":
      case "message_update":
      case "message_end": {
        // Frames of one message share messageId; without it, fall back to start-order.
        const id = frame.messageId || (frame.type === "message_start" ? (lastId = keyOf(frame)) : lastId);
        renderMessage(id, frame.message, frame.type !== "message_end");
        break;
      }
      case "tool_execution_start":
        updateTool(frame, { args: frame.args });
        scrollDown();
        break;
      case "tool_execution_update": {
        // Under bash_output chunks the update carries only details; keep the spliced text.
        let partial = frame.partialResult;
        const streamed = tools.get(frame.toolCallId)?.streamText;
        if (streamed !== undefined && partial && typeof partial === "object" && Array.isArray(partial.content) && partial.content.length === 0) {
          partial = { ...partial, content: [{ type: "text", text: streamed }] };
        }
        updateTool(frame, { args: frame.args, partial });
        break;
      }
      case "bash_output": {
        if (!str(frame.toolCallId)) break;
        const c = toolCard({ toolCallId: frame.toolCallId, toolName: tools.has(frame.toolCallId) ? undefined : "bash" });
        if (c.done) break; // a late splice never overwrites the final result
        const prev = c.streamText ?? "";
        const keep = Number.isInteger(frame.keep) && frame.keep >= 0 ? Math.min(frame.keep, prev.length) : 0;
        const text = prev.slice(0, keep) + (typeof frame.chunk === "string" ? frame.chunk : "");
        c.streamText = text;
        const details = c.partial && typeof c.partial === "object" && c.partial.details ? c.partial.details : {};
        updateTool(frame, { partial: { content: [{ type: "text", text }], details } });
        break;
      }
      case "tool_execution_end": {
        const ended = tools.get(frame.toolCallId);
        if (ended) ended.streamText = undefined;
        updateTool(frame, { result: frame.result, isError: !!frame.isError, done: true });
        scrollDown();
        if (frame.toolName === "todo") refreshTodos();
        break;
      }
      case "prompt_result":
        if (frame.status === "error" && frame.error) note(frame.error.message, true);
        if (frame.status !== "completed" || frame.sessionSettled) setBusy(false);
        break;
      case "session_settled":
        setBusy(false);
        send({ id: "sfile", type: "get_state" }); // a /new or /resume inside the turn may have switched files
        // A turn cut off before message_end would otherwise keep saying "streaming…".
        for (const [id, led] of ledgers) {
          if (!turnUsage.has(id)) {
            led.remove();
            ledgers.delete(id);
          }
        }
        refreshStats();
        refreshTodos();
        if (!el.tree.hidden) loadTree();
        break;
      case "notice":
        if (frame.source === "recap") {
          note(frame.message, false, "recap");
          setRecapHint(frame.message);
        }
        else note(frame.message, frame.level === "error");
        break;
      case "command_output":
        note(frame.text, false, "output");
        break;
      case "available_commands_update":
        setCommands(frame.commands);
        break;
      case "auto_retry_start": {
        const secs = Number(frame.delayMs) > 0 ? ` in ${Math.round(Number(frame.delayMs) / 1000)}s` : "";
        const n = note(`Retrying${secs} (${frame.attempt ?? "?"}/${frame.maxAttempts ?? "?"}): ${frame.errorMessage ?? "request failed"}`);
        const b = noteAction(n, "Cancel retry", () => {
          send({ type: "abort_retry" });
          b.remove();
        });
        break;
      }
      case "auto_retry_end":
        if (frame.success === false) note(`Retry gave up after ${frame.attempt ?? "?"} attempts${str(frame.finalError) ? ": " + frame.finalError : "."}`, true);
        break;
      case "retry_fallback_applied":
        note(`Switched from ${frame.from ?? "the model"} to ${frame.to ?? "a fallback"}${str(frame.reason) ? " (" + frame.reason + ")" : ""}.`);
        break;
      case "retry_fallback_succeeded":
        note(`The fallback ${frame.model ?? "model"} answered.`);
        break;
      case "ttsr_triggered": {
        const names = (Array.isArray(frame.rules) ? frame.rules : []).map((r) => r?.name).filter((x) => typeof x === "string");
        note(`Rule${names.length === 1 ? "" : "s"} triggered: ${names.join(", ") || "unknown"} — the turn restarts with the rule injected.`);
        break;
      }
      case "cache_warming_end":
        if (str(frame.warmingStopReason)) note(`Cache warming stopped: ${frame.warmingStopReason}`);
        break;
      case "auto_compaction_start":
        compactionStarted(`Compacting the context${str(frame.reason) ? " (" + frame.reason + ")" : ""}…`);
        break;
      case "auto_compaction_end":
        compactionEnded(frame, true);
        break;
      case "manual_compaction_start":
        compactionStarted("Compacting the context…");
        break;
      case "manual_compaction_end":
        compactionEnded(frame, false);
        break;
      case "queue_update":
        setQueue(frame);
        break;
      case "todo_reminder":
        note(`Unfinished todos — reminding the model (${frame.attempt ?? "?"}/${frame.maxAttempts ?? "?"}).`);
        refreshTodos();
        break;
      case "todo_auto_clear":
        setTodos([]);
        refreshTodos();
        break;
      case "goal_updated":
        setGoal(frame.goal ?? null);
        break;
      case "subagent_lifecycle":
      case "subagent_progress":
        onSubagentFrame(frame);
        break;
      case "btw_delta": {
        if (!str(frame.recordId) || typeof frame.delta !== "string") break;
        const c = btwCard(frame.recordId);
        c.answer.append(frame.delta);
        c.state.textContent = " · thinking…";
        scrollDown();
        break;
      }
      case "btw_record":
        renderBtw(frame.record);
        break;
      case "thinking_level_changed":
        if (typeof frame.thinkingLevel === "string") thinkingLevel = frame.thinkingLevel;
        autoEffort = frame.configured === "auto" ? (typeof frame.resolved === "string" ? frame.resolved : "auto") : null;
        renderEffort();
        break;
      case "config_update": {
        // Builtin slash commands (/model, /thinking …) report what they changed; either field may be absent.
        const m = frame.model;
        if (m && typeof m === "object" && typeof m.provider === "string" && typeof m.id === "string") {
          currentModel = m;
          renderModels();
          loadThinkingLevels();
        }
        // Under auto this is the provisional concrete level, so it must not end auto mode; leaving
        // auto is reported by the `thinking_level_changed` the same command emits first.
        if (typeof frame.thinkingLevel === "string" && frame.thinkingLevel !== "auto") {
          thinkingLevel = frame.thinkingLevel;
          renderEffort();
        }
        break;
      }
      case "model_changed": // no payload: re-read the model
        send({ id: "mstate", type: "get_state" });
        break;
      case "config_warnings_changed": // no payload: re-read the warnings
        send({ id: "warns", type: "get_state" });
        break;
      case "session_info_update":
        hooks.title?.(typeof frame.title === "string" ? frame.title : null, true);
        break;
      case "rpc_frame_error":
        note(`omp could not send ${typeof frame.originalType === "string" ? "a " + frame.originalType + " frame" : "a frame"}: ${frame.error ?? "unknown error"}`, true);
        break;
      case "extension_ui_request":
        onUiRequest(frame);
        break;
      case "extension_error":
        note(`${frame.event}: ${frame.error}`, true);
        break;
      default:
        break; // other session events are not shown yet
    }
  }
  // Settings (Accounts page) claims the login flow's UI requests while it runs a `login`,
  // because the chat pane is hidden behind the settings tab. Returns true when it handled one.
  let uiInterceptor = null;
  function onUiRequest(req) {
    if (uiInterceptor) {
      try {
        if (uiInterceptor(req, (payload) => send({ type: "extension_ui_response", id: req.id, ...payload }))) return;
      } catch (e) {
        note("UI request handler failed: " + String(e), true);
      }
    }
    switch (req.method) {
      case "confirm":
      case "select":
      case "input":
      case "editor":
        openDialog(req);
        break;
      case "cancel":
        if (dialogId === req.targetId) closeDialog();
        break;
      case "notify":
        note(req.message, req.notifyType === "error");
        break;
      case "ask": // sent because `ready` opts in with set_ask_dialog
        openAskDialog(req);
        break;
      case "open_url":
        onOpenUrl(req);
        break;
      case "setStatus":
        onSetStatus(req);
        break;
      case "setWidget":
        onSetWidget(req);
        break;
      case "setTitle":
        hooks.title?.(typeof req.title === "string" ? stripAnsi(req.title) : null);
        break;
      case "set_editor_text":
        if (typeof req.text === "string") {
          el.input.value = req.text;
          autosize();
          el.input.focus();
        }
        break;
      default:
        break; // unknown methods: newer omp than this UI
    }
  }


  // ---- composer ---------------------------------------------------------
  /** Labels the staged images into `message` and hands them over (the strip empties). */
  function takeImages(message) {
    if (!attached.length) return { message, images: undefined };
    const labels = attached.map((_, i) => `[Image ${imageSeq + i + 1}]`).join(" ");
    const images = attached.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
    imageSeq += attached.length;
    attached = [];
    renderAttachments();
    return { message: message ? `${message}\n\n${labels}` : labels, images };
  }
  /** behavior: while a turn runs, "steer" (next model step, the default) or "followUp" (after the turn). */
  function submit(behavior) {
    const message = el.input.value.trim();
    if (!message && !attached.length) return;
    const local = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message);
    const lc = local && localFor(local[1].toLowerCase());
    closePalette();
    hideGhost(false);
    el.input.value = "";
    el.input.style.height = "";
    el.composer.classList.remove("shell");
    if (message) rememberPrompt(message);
    if (message.startsWith("!")) {
      runUserBash(message); // staged images stay for the next message
      return;
    }
    if (lc) {
      const arg = (local[2] ?? "").trim();
      // Only /queue sends images; /btw and /goal leave the staged ones for the next message.
      if (lc.name === "queue") {
        const t = takeImages(arg);
        lc.run(t.images ? t.message : arg, t.images);
      } else lc.run(arg);
      return;
    }
    const t = takeImages(message);
    const cmd = { type: "prompt", message: t.message };
    if (t.images) cmd.images = t.images;
    if (busy) {
      cmd.streamingBehavior = behavior || "steer";
      noteQueuedImages(t.message, t.images);
    }
    send(cmd);
  }
  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  // ---- image attachments: paste, drop or the "+ image" button ------------
  let attached = []; // { data (base64), mimeType, src (data URL) } in attach order
  const strip = el.attachments;
  function renderAttachments() {
    strip.replaceChildren();
    attached.forEach((img, i) => strip.append(thumb(img.src, imageSeq + i + 1, () => {
      attached.splice(i, 1);
      renderAttachments();
      el.input.focus();
    })));
    strip.hidden = !attached.length;
  }
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => {
        const src = String(r.result);
        resolve({ data: src.slice(src.indexOf(",") + 1), mimeType: file.type, src });
      };
      r.readAsDataURL(file);
    });
  }
  async function attachFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        note(`${file.name || "File"} is not an image and was skipped.`, true);
      } else if (file.size > MAX_IMAGE_BYTES) {
        note(`${file.name || "Image"} is larger than ${MAX_IMAGE_BYTES / 1048576} MB and was skipped.`, true);
      } else {
        try {
          attached.push(await readImage(file));
        } catch (e) {
          note(`Could not read ${file.name || "image"}: ${e}`, true);
        }
      }
    }
    renderAttachments();
    el.input.focus();
  }
  el.input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    // Plain text alongside (e.g. copied from a page) still pastes; a bare bitmap must not insert nothing silently.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    attachFiles(files);
  });
  const prompt = el.root.querySelector(".prompt-area");
  let dragDepth = 0;
  prompt.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    prompt.classList.add("drop");
  });
  prompt.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  prompt.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      prompt.classList.remove("drop");
    }
  });
  prompt.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    prompt.classList.remove("drop");
    attachFiles([...e.dataTransfer.files]);
  });
  el.attach.addEventListener("click", async () => {
    const paths = await browseFolder(cwd, { images: true });
    if (!paths?.length) return;
    const files = [];
    for (const p of paths) {
      try {
        const name = p.split(/[\\/]/).pop();
        const ext = name.split(".").pop().toLowerCase();
        const buf = await invoke("read_image", { path: p });
        files.push(new File([buf], name, { type: "image/" + (ext === "jpg" ? "jpeg" : ext) }));
      } catch (e) {
        note(`Could not read ${p}: ${errText(e)}`, true);
      }
    }
    if (files.length) await attachFiles(files);
  });
  el.file.addEventListener("change", (e) => {
    attachFiles([...e.target.files]);
    e.target.value = ""; // allow picking the same file again
  });
  function autosize() {
    const t = el.input;
    t.style.height = "auto";
    const h = t.scrollHeight;
    t.style.height = Math.min(h, 220) + "px";
  }

  // ---- new-chat welcome: a suggestion fills the composer (Enter sends); Alt+1..4 pick one ----
  const welcomeItems = [...el.welcome.querySelectorAll(".wl-item")];
  function pickSuggestion(btn) {
    el.input.value = btn.dataset.prompt || "";
    autosize();
    el.input.focus();
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
  }
  for (const b of welcomeItems) b.addEventListener("click", () => pickSuggestion(b));
  el.input.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || el.welcome.offsetParent === null) return;
    const b = welcomeItems[Number(e.key) - 1];
    if (!b) return;
    e.preventDefault();
    pickSuggestion(b);
  });

  // ---- slash command palette (as in the omp CLI) ------------------------
  // Typing "/" lists the session's commands (builtins, custom, skills, MCP, prompt templates).
  // "/name " on a command with subcommands lists those. ↑/↓ move, Tab completes, Enter
  // completes (and runs a command that takes no arguments), Esc closes.
  let commands = [];
  // mode "path": `@file` completions from complete_path; `prefix` is the mention text that ends at `cursor`.
  const pal = { items: [], index: 0, open: false, mode: "cmd", prefix: "", cursor: 0 };
  let pathTimer = null; // debounced complete_path
  let pathSeq = 0; // answers for an older caret/text are dropped
  let histTimer = null; // debounced Ctrl+R history search
  let histSeq = 0;
  function setCommands(list) {
    commands = Array.isArray(list) ? list : [];
    refreshPalette();
  }
  function rank(name, aliases, desc, q) {
    if (!q || name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (aliases.some((a) => a.toLowerCase().startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    if (desc.includes(q)) return 4;
    return -1;
  }
  function paletteMatches() {
    const value = el.input.value;
    const top = /^\/(\S*)$/.exec(value);
    if (top) {
      const q = top[1].toLowerCase();
      return [...commands, ...LOCAL_COMMANDS.filter((l) => !advertised(l.name))]
        .map((c, i) => ({ c, i, r: rank(c.name.toLowerCase(), c.aliases || [], (c.description || "").toLowerCase(), q) }))
        .filter((x) => x.r >= 0)
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(({ c }) => ({
          label: "/" + c.name,
          hint: c.input?.hint || (c.subcommands?.length ? "<subcommand>" : ""),
          desc: c.description || (c.aliases?.length ? "alias: /" + c.aliases.join(", /") : ""),
          insert: "/" + c.name,
          final: !c.input?.hint && !c.subcommands?.length,
        }));
    }
    const sub = /^\/(\S+)\s+(\S*)$/.exec(value);
    if (sub) {
      const name = sub[1].toLowerCase();
      const cmd = commands.find((c) => c.name.toLowerCase() === name || (c.aliases || []).some((a) => a.toLowerCase() === name));
      if (!cmd?.subcommands?.length) return null;
      const q = sub[2].toLowerCase();
      const subs = cmd.subcommands
        .filter((s) => s.name.toLowerCase().startsWith(q))
        .map((s) => ({ label: s.name, hint: s.usage || "", desc: s.description || "", insert: "/" + sub[1] + " " + s.name, final: !s.usage }));
      return subs.length ? subs : null; // free-form argument: get out of the way
    }
    return null;
  }
  function closePalette() {
    pal.open = false;
    pal.items = [];
    pal.mode = "cmd";
    clearTimeout(pathTimer);
    pathSeq++; // drop a completion still in flight
    clearTimeout(histTimer);
    histSeq++;
    pal.loading = false;
    el.palette.hidden = true;
    el.palette.replaceChildren();
  }
  function renderPalette() {
    el.palette.replaceChildren();
    if (!pal.items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = pal.mode === "hist" ? (pal.loading ? "Searching history…" : "No matching prompts") : commands.length ? "No matching commands" : "Loading commands…";
      el.palette.append(empty);
    }
    pal.items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "item";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === pal.index));
      const cmd = document.createElement("span");
      cmd.className = "cmd" + (item.directory ? " dir" : "");
      cmd.textContent = item.label;
      if (item.hint) {
        const h = document.createElement("span");
        h.className = "hint";
        h.textContent = item.hint;
        cmd.append(h);
      }
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = item.desc;
      row.append(cmd, desc);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the editor
        pal.index = i;
        acceptPalette(true);
      });
      el.palette.append(row);
    });
    el.palette.hidden = false;
    el.palette.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }
  function refreshPalette() {
    const items = paletteMatches();
    if (!items && mentionAtCursor()) {
      if (pal.open && pal.mode === "cmd") closePalette();
      schedulePathCompletion();
      return;
    }
    // Hide once the input is exactly a finished command with nothing left to pick.
    if (!items || (items.length === 1 && items[0].insert === el.input.value && items[0].final)) return closePalette();
    const keep = pal.open && pal.mode === "cmd" && pal.items[pal.index]?.insert;
    pal.mode = "cmd";
    pal.items = items;
    pal.index = Math.max(0, items.findIndex((x) => x.insert === keep));
    pal.open = true;
    renderPalette();
  }

  // ---- @file mentions: complete_path lists files/folders for the `@…` before the caret ----
  function mentionAtCursor() {
    const t = el.input;
    if (t.selectionStart !== t.selectionEnd) return false;
    const before = t.value.slice(0, t.selectionStart);
    return /(?:^|\s)@(?:"[^"]*|\S*)$/.test(before.slice(before.lastIndexOf("\n") + 1));
  }
  function schedulePathCompletion() {
    clearTimeout(pathTimer);
    const mine = ++pathSeq;
    pathTimer = setTimeout(async () => {
      const text = el.input.value;
      const cursor = el.input.selectionStart;
      let data = null;
      try {
        data = await request("complete_path", { text, cursor }, 5000);
      } catch {
        data = null; // older omp without complete_path, or omp not running: no popup
      }
      if (mine !== pathSeq || el.input.value !== text || el.input.selectionStart !== cursor) return;
      const raw = isObj(data) && Array.isArray(data.items) ? data.items : [];
      const items = raw
        .filter((it) => isObj(it) && typeof it.value === "string" && it.value)
        .slice(0, 50)
        .map((it) => ({ label: str(it.label) || it.value, hint: "", desc: str(it.description), insert: it.value, directory: it.directory === true }));
      if (!items.length || typeof data.prefix !== "string") {
        if (pal.mode === "path") closePalette();
        return;
      }
      Object.assign(pal, { mode: "path", prefix: data.prefix, cursor, items, index: 0, open: true });
      renderPalette();
    }, 120);
  }
  /** Replace the mention before the caret with the picked path; a folder keeps completing inside it. */
  function acceptPath(item) {
    const t = el.input;
    const start = pal.cursor - pal.prefix.length;
    if (start < 0 || t.value.slice(start, pal.cursor) !== pal.prefix) return closePalette();
    const ins = item.insert + (item.directory ? "" : " ");
    t.value = t.value.slice(0, start) + ins + t.value.slice(pal.cursor);
    const pos = start + ins.length;
    t.setSelectionRange(pos, pos);
    autosize();
    closePalette();
    if (item.directory) schedulePathCompletion();
  }
  function acceptPalette(run) {
    const item = pal.items[pal.index];
    if (!item) return closePalette();
    if (pal.mode === "path") return acceptPath(item);
    if (pal.mode === "hist") {
      closePalette();
      setInput(item.insert); // picked into the editor, never sent on its own (as Ctrl+R in the CLI)
      return;
    }
    if (run && item.final) {
      el.input.value = item.insert;
      closePalette();
      el.composer.requestSubmit();
      return;
    }
    el.input.value = item.insert + " ";
    autosize();
    refreshPalette();
  }

  // ---- prompt history (shared with the CLI editor): ↑ on an empty editor walks back, ↓ forward ----
  // Entries newest first, fetched again when a walk starts (another tab or the CLI may have added some).
  const hist = { entries: null, index: -1, draft: "" };
  async function loadHistory(fresh) {
    if (hist.entries && !fresh) return hist.entries;
    let list = [];
    try {
      const r = await request("get_prompt_history", { limit: 200 }, 5000);
      const raw = Array.isArray(r) ? r : isObj(r) && Array.isArray(r.entries) ? r.entries : [];
      list = raw.map((x) => (isObj(x) ? str(x.prompt) : str(x))).filter(Boolean);
    } catch {
      list = null; // older omp: no history, ↑ does nothing; on a failed refresh keep what we had
    }
    if (list) hist.entries = list;
    hist.entries ??= [];
    return hist.entries;
  }
  function rememberPrompt(message) {
    hist.index = -1;
    if (hist.entries) hist.entries = [message, ...hist.entries.filter((x) => x !== message)];
    request("add_prompt_history", { prompt: message }).catch(() => {});
  }
  function setInput(value) {
    el.input.value = value;
    el.input.setSelectionRange(value.length, value.length);
    el.composer.classList.toggle("shell", value.startsWith("!"));
    autosize();
  }

  // ---- Ctrl+R: search the prompt history; the editor text is the query, the popup lists the matches ----
  function histAge(when) {
    if (typeof when !== "number" || !Number.isFinite(when) || when <= 0) return "";
    const ms = when < 1e12 ? when * 1000 : when; // omp stores epoch seconds
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    return new Date(ms).toLocaleDateString();
  }
  function openHistorySearch() {
    if (pal.open && pal.mode === "hist") {
      // Ctrl+R again: next (older) match, as in a shell
      if (pal.items.length) {
        pal.index = (pal.index + 1) % pal.items.length;
        renderPalette();
      }
      return;
    }
    hideGhost(false);
    Object.assign(pal, { mode: "hist", items: [], index: 0, open: true, loading: true });
    renderPalette();
    scheduleHistorySearch(0);
  }
  function scheduleHistorySearch(delay = 150) {
    clearTimeout(histTimer);
    const mine = ++histSeq;
    pal.loading = true;
    histTimer = setTimeout(async () => {
      const query = el.input.value.trim();
      let data = null;
      try {
        data = await request("get_prompt_history", query ? { query, limit: 50 } : { limit: 50 }, 5000);
      } catch {
        data = null; // older omp or omp not running: an empty list
      }
      if (mine !== histSeq || pal.mode !== "hist" || !pal.open) return;
      const raw = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.entries) ? data.entries : [];
      const seen = new Set();
      const items = [];
      for (const x of raw) {
        const prompt = isObj(x) ? str(x.prompt) : str(x);
        if (!prompt || seen.has(prompt)) continue;
        seen.add(prompt);
        const lines = prompt.split("\n");
        const first = lines[0].length > 90 ? lines[0].slice(0, 89) + "…" : lines[0];
        const uses = isObj(x) && Number.isInteger(x.useCount) && x.useCount > 1 ? x.useCount + "×" : "";
        const age = isObj(x) ? histAge(x.createdAt) : "";
        items.push({ label: first || "(blank line)", hint: lines.length > 1 ? "+" + (lines.length - 1) + " lines" : "", desc: [age, uses].filter(Boolean).join(" · "), insert: prompt });
      }
      pal.items = items;
      pal.index = 0;
      pal.loading = false;
      renderPalette();
    }, delay);
  }
  async function historyMove(delta) {
    const start = hist.index === -1;
    let list = hist.entries;
    if (start && delta > 0) {
      if (hist.loading) return;
      const before = el.input.value;
      hist.loading = true;
      try {
        list = await loadHistory(true);
      } finally {
        hist.loading = false;
      }
      if (el.input.value !== before || hist.index !== -1) return; // typed while the history was loading
    }
    if (!list) return;
    const i = hist.index + delta;
    if (i >= list.length) return;
    if (hist.index === -1) {
      if (delta < 0) return;
      hist.draft = el.input.value;
    }
    hist.index = Math.max(-1, i);
    setInput(hist.index === -1 ? hist.draft : list[hist.index]);
  }
  /** ↑/↓ recall history only where they cannot move the caret: first line going up, last line going down. */
  function historyKey(e) {
    if (pal.open || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
    const t = el.input;
    if (t.selectionStart !== t.selectionEnd) return false;
    if (e.key === "ArrowUp") {
      if (t.value.slice(0, t.selectionStart).includes("\n")) return false;
      if (t.value && hist.index === -1) return false;
      historyMove(1);
      return true;
    }
    if (e.key === "ArrowDown") {
      if (hist.index === -1 || t.value.slice(t.selectionEnd).includes("\n")) return false;
      historyMove(-1);
      return true;
    }
    return false;
  }

  // ---- idle recap: shown as the composer placeholder while it is empty, Tab fills it in ----
  const DEFAULT_PLACEHOLDER = el.input.placeholder;
  const RECAP_PLACEHOLDER = "Tab to use the recap as your message";
  let recapHint = "";
  function setRecapHint(text) {
    recapHint = str(text).replace(/\s+/g, " ").trim();
    el.input.placeholder = recapHint ? RECAP_PLACEHOLDER : DEFAULT_PLACEHOLDER;
    autosize();
  }
  function clearRecapHint() {
    if (!recapHint) return;
    recapHint = "";
    el.input.placeholder = DEFAULT_PLACEHOLDER;
    autosize();
  }
  function acceptRecapHint() {
    if (!recapHint || el.input.value) return false;
    const text = recapHint;
    clearRecapHint();
    setInput(text);
    return true;
  }

  // ---- word prediction: ghost text after the caret (predict_word), Tab or → accepts ----
  let ghost = null; // { text, cursor, suffix } shown in el.ghost
  let ghostTimer = null;
  let ghostSeq = 0;
  let wordCompletion = null; // get_state's wordCompletion method; "off" disables predict_word
  const GHOST_STYLE = ["font", "letterSpacing", "lineHeight", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"];
  function ghostFeedback(g, accepted) {
    request("predict_word_feedback", { text: g.text, cursor: g.cursor, suggestion: g.suffix, accepted }).catch(() => {});
  }
  /** Drop the ghost; `typedPast` tells omp the user typed something else than the suggestion. */
  function hideGhost(typedPast) {
    clearTimeout(ghostTimer);
    ghostSeq++;
    if (ghost && typedPast) ghostFeedback(ghost, false);
    ghost = null;
    el.ghost.hidden = true;
    el.ghost.replaceChildren();
  }
  function showGhost(g) {
    const cs = getComputedStyle(el.input);
    for (const p of GHOST_STYLE) el.ghost.style[p] = cs[p];
    el.ghost.style.borderStyle = "solid";
    el.ghost.style.borderColor = "transparent";
    el.ghost.replaceChildren(document.createTextNode(g.text), span("suffix", g.suffix));
    el.ghost.hidden = false;
    el.ghost.scrollTop = el.input.scrollTop;
    ghost = g;
  }
  function scheduleGhost() {
    clearTimeout(ghostTimer);
    const mine = ++ghostSeq;
    const t = el.input;
    const text = t.value;
    const cursor = t.selectionStart;
    if (wordCompletion === "off") return; // the user turned inline prediction off in omp
    if (!text.trim() || t.selectionEnd !== cursor || cursor !== text.length || /^[/!]/.test(text) || pal.open) return;
    ghostTimer = setTimeout(async () => {
      let r;
      try {
        r = await request("predict_word", { text, cursor }, 3000);
      } catch {
        return; // prediction is best effort
      }
      if (mine !== ghostSeq || el.input.value !== text || el.input.selectionStart !== cursor || pal.open) return;
      const suffix = isObj(r) ? str(r.suffix) : str(r);
      if (suffix) showGhost({ text, cursor, suffix });
    }, 150);
  }
  function acceptGhost() {
    const g = ghost;
    if (!g || el.input.value !== g.text) return false;
    ghostFeedback(g, true);
    hideGhost(false);
    setInput(g.text + g.suffix);
    scheduleGhost();
    return true;
  }
  /**
   * After typing: keep the ghost while the user types through it, otherwise report it and ask again.
   * Deleting (Backspace, Delete, cut) only drops it: that is not a rejection of the suggestion.
   */
  function ghostOnInput(inputType) {
    const g = ghost;
    const v = el.input.value;
    if (g && v.length > g.text.length && v.startsWith(g.text) && g.suffix.startsWith(v.slice(g.text.length)) && el.input.selectionStart === v.length) {
      const rest = g.suffix.slice(v.length - g.text.length);
      if (rest) {
        clearTimeout(ghostTimer);
        ghostSeq++;
        showGhost({ text: v, cursor: v.length, suffix: rest });
        return;
      }
      hideGhost(false); // typed the whole suggestion
    } else hideGhost(!!g && !str(inputType).startsWith("delete"));
    scheduleGhost();
  }

  el.input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.ctrlKey && e.code === "KeyR" && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault(); // not the webview reload
      e.stopPropagation();
      openHistorySearch();
      return;
    }
    if (pal.open) {
      const n = pal.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) pal.index = (pal.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        renderPalette();
        return;
      }
      if (e.key === "Tab" && n) {
        e.preventDefault();
        acceptPalette(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && n) {
        e.preventDefault();
        acceptPalette(true);
        return;
      }
      if (e.key === "Escape" || (pal.mode === "hist" && e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault(); // Enter with no history match closes the search instead of sending the query
        closePalette();
        return;
      }
    }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && acceptRecapHint()) {
      e.preventDefault();
      return;
    }
    if (ghost && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Tab" || (e.key === "ArrowRight" && el.input.selectionStart === el.input.value.length))) {
      if (acceptGhost()) {
        e.preventDefault();
        return;
      }
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && historyKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && ghost) {
      e.preventDefault();
      hideGhost(true);
      return;
    }
    if (e.key === "Escape" && (busy || bashRunning)) {
      e.preventDefault();
      stopTurn(); // with a queue: also pulls the queued messages back into the editor
      return;
    }
    if (e.key === "Enter" && e.altKey && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit("followUp"); // as in the CLI: queue for after the turn instead of steering
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });
  el.input.addEventListener("input", (e) => {
    hist.index = -1;
    el.composer.classList.toggle("shell", el.input.value.startsWith("!"));
    autosize();
    if (pal.open && pal.mode === "hist") return scheduleHistorySearch(); // typing refines the search
    refreshPalette();
    ghostOnInput(e.inputType);
  });
  // The caret moved without typing (arrows, Home/End, a click): follow it with the @file popup.
  let caretTimer = null;
  function caretMoved() {
    clearTimeout(caretTimer);
    caretTimer = setTimeout(() => {
      if (document.activeElement !== el.input) return;
      if (mentionAtCursor()) {
        if (!pal.open || pal.mode === "path") schedulePathCompletion();
      } else if (pal.mode === "path") closePalette();
    }, 150);
  }
  el.input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || (!pal.open && (e.key === "ArrowUp" || e.key === "ArrowDown"))) caretMoved();
  });
  el.input.addEventListener("mouseup", caretMoved);
  el.input.addEventListener("scroll", () => (el.ghost.scrollTop = el.input.scrollTop));
  el.input.addEventListener("blur", () => {
    closePalette();
    hideGhost(false);
  });
  el.stop.addEventListener("click", stopTurn);
  // Transcript hotkeys anywhere in this session pane, as in the CLI: Ctrl+T thinking, Ctrl+O tool output.
  // Clicking plain transcript text focuses nothing, so key events would go to <body> and never reach
  // this pane. Make the pane itself focusable and take focus on a click that landed on non-interactive content.
  root.tabIndex = -1;
  root.style.outline = "none";
  root.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("input, textarea, select, button, a, summary, [contenteditable], [tabindex]:not([tabindex='-1'])")) return;
    if (window.getSelection()?.toString()) return;
    queueMicrotask(() => {
      if (!root.contains(document.activeElement) || document.activeElement === document.body) root.focus({ preventScroll: true });
    });
  });
  root.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    // As in the CLI, Shift+Tab cycles the thinking level anywhere in the pane; inside a dialog or the
    // session tree it keeps moving focus back.
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.target instanceof Element && e.target.closest(".dialog")) return;
      e.preventDefault();
      cycleEffort();
      return;
    }
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (e.code === "KeyT") {
      e.preventDefault();
      toggleThinking();
    } else if (e.code === "KeyO") {
      e.preventDefault();
      toggleTools();
    } else if (e.code === "Slash") {
      e.preventDefault();
      showHotkeys();
    }
  });

  let cwd = null;
  let resumed = false;
  /** Forget everything rendered from the current transcript (staged attachments stay). */
  function clearTranscript() {
    messages.clear();
    tools.clear();
    ledgers.clear();
    turnUsage.clear();
    sessionStats = null;
    imageSeq = 0;
    imageNums.clear();
    lastId = null;
    renderTotal();
    renderAttachments();
    el.messages.replaceChildren(el.welcome);
    btwCards.clear();
    thinkingSet.clear();
    closeDialog();
    viewer = null;
  }
  /** Session-scoped panels (queue, todos, subagents, goal); get_state refills them for a live process. */
  function clearPanels() {
    setQueue(null);
    setTodos([]);
    clearAgents();
    setGoal(null);
  }
  /** The process moved to another transcript (switch, branch, fork, tree, new): re-read it. */
  function reloadTranscript(text) {
    clearTranscript();
    dropFinishedAgents(); // rows of the previous transcript; still-running ones keep reporting
    histNote = text ?? null;
    send({ id: "state", type: "get_state" });
    send({ id: "hist", type: "get_messages" });
    if (!el.tree.hidden) loadTree();
  }
  let starting = false; // rpc_start in flight: a second folder switch must not overlap it
  async function start(dir, resume) {
    starting = true;
    attached = [];
    clearTranscript();
    clearExtUi();
    clearPanels();
    stderrLines = [];
    alive = false;
    setStatus("starting…");
    resetReady();
    resumed = !!resume;
    try {
      // `resume` is true (continue the folder's latest session) or a session file path (that exact one).
      const file = typeof resume === "string" ? resume : null;
      cwd = await invoke("rpc_start", { id: sid, cwd: dir ?? null, resume: resumed, session: file });
      el.cwd.textContent = folderName(cwd);
      el.cwd.title = cwd + " (change working folder)";
      saveRecent(cwd);
      hooks.cwd?.(cwd);
    } catch (e) {
      setStatus("failed to start", "bad");
      note(String(e), true);
    } finally {
      starting = false;
    }
  }
  // ---- session changes inside the running process ------------------------
  /** A fresh session in the same process (`new_session`); a dead process is started again instead. */
  async function newSession() {
    if (!alive) return start(cwd, false);
    try {
      const r = await request("new_session", {}, 60000);
      if (r?.cancelled) return note("New session cancelled.");
      reloadTranscript();
      el.input.focus();
    } catch (e) {
      note("Could not start a new session: " + errText(e), true);
    }
  }
  /**
   * Open saved session `sessionPath` in this process. When its saved model cannot be restored, offer
   * to open it with the current model (`provider`/`modelId` on the retry). Resolves true on success.
   */
  async function switchTo(sessionPath, model) {
    if (busy) {
      note("Stop the running turn before switching to another session.", true);
      return false;
    }
    const params = { sessionPath };
    if (model) {
      params.provider = model.provider;
      params.modelId = model.id;
    }
    try {
      const r = await request("switch_session", params, 60000);
      if (r?.cancelled) {
        note("Switch cancelled.");
        return false;
      }
      reloadTranscript("— switched session —");
      return true;
    } catch (e) {
      const msg = errText(e);
      if (!model && currentModel && /could not restore model/i.test(msg)) {
        const pick = await askLocal("Saved model unavailable", `${msg}\n\nOpen the session with ${modelKey(currentModel)} instead?`, ["Use " + modelKey(currentModel), "Cancel"]);
        return pick === 0 ? switchTo(sessionPath, currentModel) : false;
      }
      note("Could not switch session: " + msg, true);
      return false;
    }
  }
  async function rename(name) {
    const v = String(name ?? "").trim();
    if (!v || !alive) return false;
    try {
      await request("set_session_name", { name: v });
      return true;
    } catch (e) {
      note("Could not rename the session: " + errText(e), true);
      return false;
    }
  }
  let folderMenu = null;
  function closeFolderMenu() {
    if (!folderMenu) return;
    folderMenu.remove();
    folderMenu = null;
    document.removeEventListener("pointerdown", onFolderOutside, true);
    document.removeEventListener("keydown", onFolderKey, true);
  }
  function onFolderOutside(e) {
    if (folderMenu && !folderMenu.contains(e.target) && !el.cwd.contains(e.target)) closeFolderMenu();
  }
  function onFolderKey(e) {
    if (e.key === "Escape") closeFolderMenu();
  }
  async function openFolder(dir) {
    closeFolderMenu();
    if (starting) return;
    if (busy) {
      const pick = await askLocal("Turn in progress", "Switching folders stops the running turn. Continue?", ["Switch folder", "Cancel"]);
      if (pick !== 0 || starting) return;
    }
    saveRecent(dir);
    start(dir, false); // a project switch opens a fresh chat; `--continue` would reopen that folder's latest session
  }
  function openFolderMenu() {
    closeFolderMenu();
    const menu = document.createElement("div");
    menu.className = "folder-menu";
    menu.setAttribute("role", "menu");
    const item = (label, title, onClick, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "folder-item" + (cls ? " " + cls : "");
      b.setAttribute("role", "menuitem");
      b.textContent = cls === "browse" || cls === "clear" ? label : folderName(label);
      b.title = title || label;
      b.addEventListener("click", onClick);
      return b;
    };
    const recent = loadRecent().filter((d) => d !== cwd);
    if (cwd) {
      const cur = item(cwd, cwd + " (current)", closeFolderMenu, "current");
      menu.append(cur);
    }
    if (recent.length) {
      const head = document.createElement("div");
      head.className = "folder-head";
      head.textContent = "Recent folders";
      menu.append(head);
      for (const d of recent) menu.append(item(d, d, () => openFolder(d)));
    }
    const sep = document.createElement("div");
    sep.className = "folder-sep";
    menu.append(sep);
    menu.append(
      item("Browse for folder…", "Choose a folder", async () => {
        closeFolderMenu();
        const dir = await browseFolder(cwd, { onError: message => note(message, true) });
        if (dir) openFolder(dir);
      }, "browse"),
    );
    if (recent.length) {
      menu.append(item("Clear recent folders", "Forget remembered folders", () => {
        clearRecent();
        closeFolderMenu();
      }, "clear"));
    }
    document.body.append(menu);
    const r = el.cwd.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
    const below = r.bottom + 6 + menu.offsetHeight <= innerHeight;
    menu.style.top = below ? r.bottom + 6 + "px" : Math.max(8, r.top - 6 - menu.offsetHeight) + "px";
    folderMenu = menu;
    document.addEventListener("pointerdown", onFolderOutside, true);
    document.addEventListener("keydown", onFolderKey, true);
    (menu.querySelector(".folder-item:not(.current)") || menu.querySelector(".folder-item"))?.focus();
  }
  el.cwd.addEventListener("click", () => (folderMenu ? closeFolderMenu() : openFolderMenu()));
  start(opts.cwd ?? null, opts.resume ?? true);

  return {
    sid,
    el: root,
    onFrame,
    /** The omp process ended (crash or stop): say so in the transcript. */
    onExit() {
      alive = false;
      setBusy(false);
      closeDialog(); // nobody is waiting for its answer any more
      clearExtUi();
      clearPanels();
      setStatus("agent exited", "bad");
      const n = note("The omp process exited. Use “New session” to start it again.", true);
      if (stderrLines.length) noteAction(n, "Show logs", showLogs);
    },
    /** One stderr line of this session's omp process (kept in a ring buffer for "Show logs"). */
    onStderr,
    request,
    /** `fn(req, respond) => boolean` claims extension UI requests first; `null` restores the defaults. */
    setUiInterceptor: (fn) => { uiInterceptor = typeof fn === "function" ? fn : null; },
    /** Re-read the scoped model list into the model picker. */
    refreshModels: () => send({ id: "models", type: "get_available_models" }),
    focus: () => el.input.focus(),
    lastAnswer: () => lastAnswer,
    restart: () => start(cwd, false),
    /** `new_session` in the running process (starts the process again when it has exited). */
    newSession,
    /** `switch_session` to a saved session file; resolves true when the transcript changed. */
    switchTo,
    /** `set_session_name` on the current session; resolves true when omp accepted it. */
    rename,
    get sessionFile() { return sessionFile; },
    get cwd() { return cwd; },
    get busy() { return busy; },
    get alive() { return alive; },
    /** omp answered its first get_state: requests go out without waiting. */
    get ready() { return !!readyGate?.isOpen; },
  };
  };
})();
