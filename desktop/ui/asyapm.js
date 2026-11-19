// AsyaPM dock panel: organizations -> projects -> issues, an issue detail view (status, comments,
// hand-off to the agent). All data comes from `omp asyapm <action>` through the asyapm_cli command; the
// organizations and tokens live in the CLI's asyapm.json, never here. dock.js mounts `KostompAsyapm.el`
// as a card beside Terminal/Changes/Browser/Files.
(() => {
  const { invoke } = window.__TAURI__.core;
  const root = document.createElement("div");
  root.className = "apm";

  const KEY_ORG = "kostomp-asyapm-org";
  const keyStatuses = (org) => `kostomp-asyapm-statuses:${org}`;
  const keyFolder = (org, project) => `kostomp-asyapm-folder:${org}/${project}`; // repository folder hand-offs open in
  const keyNote = (org, project) => `kostomp-asyapm-note:${org}/${project}`; // standing context sent with every hand-off
  const PAGE_SIZE = 50;

  const errText = (e) => String(e?.message ?? e);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const call = (args, stdin) => invoke("asyapm_cli", { args, stdin: stdin ?? null });

  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    n.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
    return n;
  }

  // ---- safe rendering of server HTML (allowlist; everything else is unwrapped or dropped) ----
  const KEEP = new Set(["P", "BR", "STRONG", "B", "EM", "I", "UL", "OL", "LI", "A", "CODE", "PRE", "BLOCKQUOTE",
    "H1", "H2", "H3", "H4", "IMG"]);
  const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "TITLE", "HEAD"]);
  function webUrl(raw) {
    try {
      const u = new URL(raw, "https://invalid.invalid/");
      return (u.protocol === "http:" || u.protocol === "https:") && /^https?:/i.test(String(raw).trim()) ? u.href : null;
    } catch { return null; }
  }
  function cleanInto(parent, node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(child.nodeValue)); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE || DROP.has(child.tagName.toUpperCase())) continue;
      const tag = child.tagName.toUpperCase();
      if (!KEEP.has(tag)) { cleanInto(parent, child); continue; } // unknown wrapper: keep its text/children
      if (tag === "IMG") {
        const src = webUrl(child.getAttribute("src") || "");
        if (!src) continue;
        const img = document.createElement("img");
        img.src = src;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.alt = "";
        img.style.cursor = "zoom-in";
        img.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation(); // an image wrapped in a link must preview, not open the link
          window.kostompOpenImage?.(src, "");
        });
        parent.append(img);
        continue;
      }
      const el = document.createElement(tag.toLowerCase());
      if (tag === "A") {
        const href = webUrl(child.getAttribute("href") || "");
        if (href) {
          el.href = href;
          el.rel = "noopener noreferrer";
          el.addEventListener("click", (e) => { e.preventDefault(); window.kostompOpenUrl?.(href); });
        }
      }
      if (tag !== "BR") cleanInto(el, child);
      parent.append(el);
    }
  }
  function renderHtml(html) {
    const box = h("div", { class: "apm-html" });
    if (!html) return box;
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    cleanInto(box, doc.body);
    return box;
  }

  // ---- state ----
  const S = {
    orgs: null,        // [{name, baseUrl, tokenPrefix}]
    org: null,
    boards: new Map(), // project id -> board
    names: [],         // every status name across the organization's boards
    statuses: new Set(), // selected status names
    issues: [],
    total: 0,
    page: 0,
    loading: false,
    error: null,
    detail: null,      // { issue, comments, error, loading, ... } while an issue is open
    started: false,
  };
  let gen = 0; // bumped on every org/project change; stale responses are dropped

  const search = h("input", { type: "search", class: "apm-search", placeholder: "Search issues", "aria-label": "Search issues", spellcheck: "false", autocomplete: "off" });
  const ui = { head: h("div", { class: "apm-head" }), body: h("div", { class: "apm-body" }) };
  root.append(ui.head, search, ui.body);

  /** Union of every project's board statuses, in first-seen order; boards of other projects add their own names. */
  function collectStatuses() {
    const names = [];
    const listed = new Set(); // statuses worth listing by default: any non-final column of any board
    for (const board of S.boards.values()) {
      const cols = board?.columns ?? [];
      cols.forEach((c, idx) => {
        for (const s of c.statuses ?? []) {
          if (!names.includes(s)) names.push(s);
          if (idx < cols.length - 1) listed.add(s);
        }
      });
    }
    S.names = names;
    return listed;
  }

  async function loadOrgs() {
    S.error = null;
    S.loading = true;
    paint();
    try {
      S.orgs = await call(["orgs"]);
    } catch (e) { S.orgs = []; S.error = errText(e); }
    S.loading = false;
    const saved = store.get(KEY_ORG);
    S.org = S.orgs.find((o) => o.name === saved)?.name ?? S.orgs[0]?.name ?? null;
    if (S.org) await loadOrg(); else paint();
  }

  /** Every project of the organization: boards give the status names, issues come from all projects at once. */
  async function loadOrg() {
    const my = ++gen;
    S.boards = new Map(); S.names = []; S.issues = []; S.total = 0; S.page = 0; S.error = null; S.detail = null;
    S.loading = true;
    paint();
    try {
      const projects = await call(["projects", "--org", S.org]);
      if (my !== gen) return;
      const boards = await Promise.allSettled(projects.map((p) => call(["board", "--org", S.org, "--project", String(p.id)])));
      if (my !== gen) return;
      boards.forEach((r, k) => { if (r.status === "fulfilled") S.boards.set(projects[k].id, r.value); });
      const listed = collectStatuses();
      let chosen = null;
      try { chosen = JSON.parse(store.get(keyStatuses(S.org)) || "null"); } catch {}
      const known = new Set(S.names);
      const kept = Array.isArray(chosen) ? chosen.filter((s) => known.has(s)) : null;
      // A saved empty selection is a real choice (no filter); only fall back when every saved name is stale.
      S.statuses = kept && (kept.length || !chosen.length) ? new Set(kept) : listed;
    } catch (e) { if (my !== gen) return; S.error = errText(e); S.loading = false; paint(); return; }
    await loadIssues(true, my);
  }

  async function loadIssues(reset, my = gen) {
    if (reset) { S.issues = []; S.total = 0; S.page = 0; }
    S.error = null;
    S.loading = true;
    paint();
    const args = ["issues", "--org", S.org, "--page", String(S.page + 1), "--page-size", String(PAGE_SIZE)];
    // No status selected means no filter; selecting every status is the same thing.
    if (S.statuses.size && S.statuses.size < S.names.length) args.push("--status", [...S.statuses].join(","));
    try {
      const res = await call(args);
      if (my !== gen) return;
      S.issues = reset ? res.items : S.issues.concat(res.items);
      S.total = res.total;
      S.page = res.page;
    } catch (e) { if (my !== gen) return; S.error = errText(e); }
    S.loading = false;
    paint();
  }

  const refresh = () => { if (S.org) { S.detail?.id != null ? openIssue(S.detail.id) : loadOrg(); } else loadOrgs(); };

  // ---- detail ----
  async function openIssue(id, listIssue) {
    const d = { id, issue: listIssue ?? null, comments: null, loading: true, error: null, commentError: null, busy: false, my: gen };
    S.detail = d;
    paint();
    const [issue, comments] = await Promise.allSettled([
      call(["issue", "--org", S.org, "--id", String(id)]),
      call(["comments", "--org", S.org, "--id", String(id)]),
    ]);
    if (S.detail !== d) return;
    d.loading = false;
    if (issue.status === "fulfilled") d.issue = issue.value; else d.error = errText(issue.reason);
    if (comments.status === "fulfilled") d.comments = comments.value; else d.error = d.error ?? errText(comments.reason);
    paint();
  }

  let lookup = 0; // bumped on every openKey; a superseded search stops quietly
  /**
   * Open the detail of the issue named by `key` ("GPWEB-180"), as a session's pane button asks. The list API has no key
   * filter, so the organizations (current first) are paged through until the key turns up.
   */
  async function openKey(key) {
    const want = String(key).trim().toUpperCase();
    const my = ++lookup;
    if (!S.started) { S.started = true; await loadOrgs(); if (my !== lookup) return; }
    const d = { id: null, issue: null, comments: null, loading: true, error: null, commentError: null, busy: false, my: gen };
    S.detail = d;
    paint();
    const names = (S.orgs ?? []).map((o) => o.name).sort((a, b) => (b === S.org) - (a === S.org));
    let found = null, foundOrg = null, failure = null;
    search: for (const org of names) {
      for (let page = 1; ; page++) {
        let res;
        try { res = await call(["issues", "--org", org, "--page", String(page), "--page-size", "200"]); }
        catch (e) { failure = errText(e); break; }
        if (my !== lookup || S.detail !== d) return;
        found = res.items.find((i) => String(i.key).toUpperCase() === want) ?? null;
        if (found) { foundOrg = org; break search; }
        if (!res.items.length || page * 200 >= res.total) break;
      }
    }
    if (my !== lookup || S.detail !== d) return;
    if (!found) {
      d.loading = false;
      d.error = failure ?? `${want} was not found in AsyaPM.`;
      paint();
      return;
    }
    if (foundOrg !== S.org) { S.org = foundOrg; store.set(KEY_ORG, foundOrg); await loadOrg(); if (my !== lookup) return; }
    await openIssue(found.id, found);
  }

  async function changeStatus(d, statusId) {
    d.busy = true; d.error = null; paint();
    try {
      const r = await call(["set-status", "--org", S.org, "--id", String(d.id), "--status-id", String(statusId)]);
      if (d.issue) { d.issue.statusId = r.statusId ?? statusId; d.issue.status = r.status ?? d.issue.status; d.issue.statusDisplay = r.status ?? d.issue.statusDisplay; }
      const row = S.issues.find((i) => i.id === d.id);
      if (row) { row.statusId = d.issue.statusId; row.status = d.issue.status; row.statusDisplay = d.issue.statusDisplay; }
    } catch (e) { d.error = errText(e); }
    d.busy = false;
    if (S.detail === d) paint();
  }

  async function sendComment(d, text) {
    d.busy = true; d.commentError = null; paint();
    try {
      await call(["comment", "--org", S.org, "--id", String(d.id)], text);
      d.draft = "";
      d.comments = await call(["comments", "--org", S.org, "--id", String(d.id)]);
    } catch (e) { d.commentError = errText(e); d.draft = text; }
    d.busy = false;
    if (S.detail === d) paint();
  }

  /** Ask for an AsyaPM project's repository folder and remember it; resolves the path, or null when cancelled. */
  async function pickFolder(org, project) {
    const key = keyFolder(org, project);
    const path = await window.KostompFolders.browseFolder(store.get(key) || window.kostompActiveCwd?.() || null);
    if (path) store.set(key, path);
    return path || null;
  }

  /**
   * `omp asyapm brief` builds the first message (issue, comments, downloaded images, instruction, project
   * note); the chat opens in the project's folder, chosen on the first hand-off.
   */
  async function handOff(d) {
    const i = d.issue;
    if (!i || d.handing) return;
    const org = S.org;
    const folder = store.get(keyFolder(org, i.projectId)) || await pickFolder(org, i.projectId);
    if (!folder) return;
    d.handing = true; d.handError = null; paint();
    try {
      const extras = { instruction: d.instruction?.trim() || undefined, note: store.get(keyNote(org, i.projectId))?.trim() || undefined };
      const brief = await call(["brief", "--org", org, "--id", String(i.id)], JSON.stringify(extras));
      await window.kostompStartChat({ cwd: folder, prompt: brief.prompt, images: brief.images, name: `${i.key}: ${i.summary}`.slice(0, 80) });
      d.instruction = "";
    } catch (e) { d.handError = errText(e); }
    d.handing = false;
    if (S.detail === d) paint();
  }

  function handOffBox(d, i) {
    const org = S.org;
    const folder = store.get(keyFolder(org, i.projectId));
    const instruction = h("textarea", { class: "apm-draft", rows: "2", placeholder: "Instruction for the agent (optional), e.g. analyze only, no code changes",
      "aria-label": "Instruction for the agent", disabled: !!d.handing });
    instruction.value = d.instruction ?? "";
    instruction.addEventListener("input", () => { d.instruction = instruction.value; });
    const saved = store.get(keyNote(org, i.projectId)) ?? "";
    const note = h("textarea", { class: "apm-draft", rows: "3", placeholder: "Sent with every hand-off from this project: repository, stack, test URL…",
      "aria-label": "Project note", disabled: !!d.handing });
    note.value = saved;
    note.addEventListener("input", () => store.set(keyNote(org, i.projectId), note.value));
    const noteBox = h("details", { class: "apm-note", open: !!d.noteOpen }, h("summary", { text: saved.trim() ? "Project note (set)" : "Add project note" }), note);
    noteBox.addEventListener("toggle", () => { d.noteOpen = noteBox.open; });
    return h("div", { class: "apm-handoff" },
      h("div", { class: "apm-folder" },
        h("span", { class: "apm-dim", text: "Folder" }),
        h("span", { class: "apm-path", title: folder, text: folder ? window.KostompFolders.folderName(folder) : "asked on first hand-off" }),
        h("button", { type: "button", class: "apm-link", text: folder ? "Change" : "Choose", disabled: !!d.handing,
          onclick: async () => { if (await pickFolder(org, i.projectId) && S.detail === d) paint(); } })),
      instruction,
      noteBox,
      h("button", { type: "button", class: "apm-hand", text: d.handing ? "Preparing…" : "Ajana ver", disabled: !!d.handing, onclick: () => handOff(d) }),
      d.handError && h("div", { class: "row-err", role: "alert", text: d.handError }));
  }

  // ---- painting ----
  function select(label, options, value, onchange, disabled) {
    const sel = h("select", { class: "apm-select", "aria-label": label, disabled: !!disabled },
      options.map(([v, text]) => h("option", { value: v, text })));
    sel.value = value ?? "";
    sel.addEventListener("change", () => onchange(sel.value));
    return sel;
  }

  function paintHead() {
    if (!S.orgs || S.orgs.length < 2) { ui.head.replaceChildren(); return; }
    const orgSel = select("Organization", S.orgs.map((o) => [o.name, o.name]), S.org, (v) => {
      S.org = v; store.set(KEY_ORG, v); loadOrg();
    });
    ui.head.replaceChildren(h("div", { class: "apm-sel" }, orgSel));
  }

  function statusFilter() {
    const names = S.names;
    if (!names.length) return null;
    return h("div", { class: "apm-filter", role: "group", "aria-label": "Status filter" },
      names.map((n) => h("button", {
        type: "button", class: "apm-chip", "aria-pressed": String(S.statuses.has(n)), text: n,
        onclick: () => {
          if (S.statuses.has(n)) S.statuses.delete(n); else S.statuses.add(n);
          store.set(keyStatuses(S.org), JSON.stringify([...S.statuses]));
          loadIssues(true);
        },
      })));
  }

  const statusChip = (i) => h("span", { class: "apm-status", "data-cat": i.statusCategory ?? "", text: i.statusDisplay || i.status });

  function paintList() {
    const out = [];
    if (S.error) out.push(h("div", { class: "row-err", role: "alert", text: S.error }));
    if (S.orgs && !S.orgs.length && !S.error) {
      out.push(h("p", { class: "side-empty", text: "No organization yet. Add one in Settings → AsyaPM." }));
      return out;
    }
    const f = statusFilter();
    if (f) out.push(f);
    const q = search.value.trim().toLocaleLowerCase();
    const list = h("ul", { class: "apm-list", "aria-label": "Issues" });
    for (const i of S.issues) {
      const row = h("li", {},
        h("button", { type: "button", class: "apm-issue", "data-issue": String(i.id), "data-key": i.key, onclick: () => openIssue(i.id, i) },
          h("span", { class: "apm-top" }, h("span", { class: "apm-key", text: i.key }), h("span", { class: "apm-tags" }, statusChip(i))),
          h("span", { class: "apm-sum", text: i.summary }),
          i.assigneeName && h("span", { class: "apm-who", text: i.assigneeName })));
      row.hidden = !!q && !row.textContent.toLocaleLowerCase().includes(q);
      list.append(row);
    }
    if (S.issues.length) out.push(list);
    if (S.loading) out.push(h("p", { class: "side-empty", text: "Loading…" }));
    else if (!S.error && S.orgs?.length && !S.issues.length) out.push(h("p", { class: "side-empty", text: "No issues match this filter." }));
    if (!S.loading && S.issues.length < S.total) {
      out.push(h("button", { type: "button", class: "apm-more", text: `Load more (${S.issues.length}/${S.total})`, onclick: () => loadIssues(false) }));
    }
    queueMicrotask(paintAgents);
    return out;
  }

  function paintDetail(d) {
    const i = d.issue;
    const out = [h("div", { class: "apm-bar" },
      h("button", { type: "button", class: "apm-back", text: "← Issues", onclick: () => { S.detail = null; paint(); } }),
      i?.webUrl && h("button", { type: "button", class: "apm-link", text: "Open in AsyaPM", onclick: () => window.kostompOpenUrl?.(i.webUrl) }))];
    if (d.error) out.push(h("div", { class: "row-err", role: "alert", text: d.error }));
    if (!i) { if (d.loading) out.push(h("p", { class: "side-empty", text: "Loading…" })); return out; }
    out.push(h("div", { class: "apm-key", text: i.key }), h("h3", { class: "apm-title-big", text: i.summary }));
    const board = S.boards.get(i.projectId);
    const options = (board?.columns ?? []).flatMap((c) => (c.statuses ?? []).map((name, k) => [String(c.statusIds?.[k]), name]));
    if (!options.some(([v]) => v === String(i.statusId))) options.unshift([String(i.statusId), i.statusDisplay || i.status]);
    out.push(h("div", { class: "apm-meta" },
      select("Status", options, String(i.statusId), (v) => changeStatus(d, v), d.busy),
      h("span", { class: "apm-who", text: i.assigneeName ? `Assignee: ${i.assigneeName}` : "Unassigned" })));
    if (i.labels?.length) out.push(h("div", { class: "chips" }, i.labels.map((l) => h("span", { class: "chip", text: l }))));
    out.push(handOffBox(d, i));
    out.push(h("h4", { class: "apm-h", text: "Description" }),
      i.description ? renderHtml(i.description) : h("p", { class: "apm-dim", text: d.loading ? "Loading…" : "No description." }));
    out.push(h("h4", { class: "apm-h", text: `Comments${d.comments ? ` (${d.comments.length})` : ""}` }));
    if (d.comments && !d.comments.length) out.push(h("p", { class: "apm-dim", text: "No comments." }));
    for (const c of d.comments ?? []) {
      out.push(h("div", { class: "apm-comment" + (c.isInternal ? " internal" : "") },
        h("div", { class: "apm-cwho" }, h("b", { text: c.authorName || "—" }),
          h("span", { class: "apm-dim", text: new Date(c.createdAtUtc).toLocaleString() }),
          c.isInternal && h("span", { class: "apm-dim", text: "internal" })),
        renderHtml(c.body)));
    }
    const box = h("textarea", { class: "apm-draft", rows: "3", placeholder: "Write a comment…", "aria-label": "New comment", disabled: !!d.busy });
    box.value = d.draft ?? "";
    box.addEventListener("input", () => { d.draft = box.value; send.disabled = d.busy || !box.value.trim(); });
    const send = h("button", { type: "button", class: "apm-send", text: "Comment", disabled: d.busy || !box.value.trim(),
      onclick: () => sendComment(d, box.value.trim()) });
    out.push(box, send);
    if (d.commentError) out.push(h("div", { class: "row-err", role: "alert", text: d.commentError }));
    return out;
  }

  function paint() {
    const keep = ui.body.scrollTop;
    paintHead();
    ui.head.hidden = !!S.detail || !(S.orgs?.length > 1);
    search.hidden = !!S.detail;
    ui.body.replaceChildren(...(S.detail ? paintDetail(S.detail) : paintList()));
    ui.body.scrollTop = keep;
  }

  /** Mark issues that already have an agent chat (open tab or stored session); updates rows in place. */
  function paintAgents() {
    const agents = window.kostompIssueAgents?.() ?? new Map();
    for (const btn of ui.body.querySelectorAll(".apm-issue[data-key]")) {
      const state = agents.get(btn.dataset.key.toUpperCase());
      const top = btn.querySelector(".apm-top");
      let tag = top.querySelector(".apm-agent");
      if (!state) { tag?.remove(); continue; }
      if (!tag) { tag = h("span", { class: "apm-agent", text: "Ajanda" }); top.querySelector(".apm-tags").prepend(tag); }
      tag.dataset.state = state;
      tag.title = state === "busy" ? "Agent is working on it" : state === "ask" ? "Agent is waiting for you" : "Has an agent chat";
    }
  }

  function start() {
    if (S.started) {
      // No refresh button: reopening the card re-reads the list (an open issue keeps its state).
      if (S.org && !S.detail && !S.loading) loadIssues(true);
      return;
    }
    S.started = true;
    loadOrgs();
  }

  window.KostompAsyapm = { el: root, show: start, openKey };
  window.addEventListener("kostomp-asyapm-refresh", () => { if (S.started) refresh(); else start(); });
  // Org list changed in Settings: pick it up next time the panel is shown (now, if it is on screen).
  window.addEventListener("kostomp-asyapm-orgs-change", () => { S.started = false; S.detail = null; if (root.offsetParent) start(); });
  search.addEventListener("input", () => { if (!S.detail) paint(); });
  let agentFrame = 0;
  document.addEventListener("kostomp-agents", () => {
    if (agentFrame || S.detail) return;
    agentFrame = requestAnimationFrame(() => { agentFrame = 0; paintAgents(); });
  });
})();
