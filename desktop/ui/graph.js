(() => {
  const { invoke } = window.__TAURI__.core;
  const dialog = document.getElementById("graph-dialog");
  const form = document.getElementById("graph-form");
  const start = document.getElementById("graph-start");
  const cancel = document.getElementById("graph-cancel");
  const showPatch = document.getElementById("graph-patch");
  const nodes = document.getElementById("graph-nodes");
  const status = document.getElementById("graph-status");
  const output = document.getElementById("graph-output");
  const base = document.getElementById("graph-base");
  const patchView = document.getElementById("graph-patch-view");
  const logs = document.getElementById("graph-logs");
  const history = document.getElementById("graph-history");
  const retryNode = document.getElementById("graph-retry-node");
  const retry = document.getElementById("graph-retry");
  const resume = document.getElementById("graph-resume");
  const planPanel = document.getElementById("graph-plan");
  const planTitle = document.getElementById("graph-plan-title");
  const tasks = document.getElementById("graph-tasks");
  const planActions = document.getElementById("graph-plan-actions");
  const approve = document.getElementById("graph-approve");
  const discard = document.getElementById("graph-discard");
  const logNode = document.getElementById("graph-log-node");
  const showLog = document.getElementById("graph-show-log");
  const log = document.getElementById("graph-log");
  const states = { ready_to_export: "Verified patch ready", needs_input: "Graph needs input", stale_base: "Source checkout changed" };
  let polling;
  let pending = Promise.resolve();
  let generation = 0;
  let currentRun;
  let shownPlan = "";
  /** The proposal on screen. Approval names it so the host rejects a plan the user has not seen. */
  let shownDraft;
  /** `run:node:attempt` of the log on screen. A newer attempt hides it. */
  let shownLog = "";
  let logKeys = new Map();

  function renderTasks(list) {
    tasks.replaceChildren(...list.map(task => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = task.title;
      const meta = document.createElement("div");
      meta.className = "graph-task-meta";
      const after = task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : "";
      meta.textContent = `${task.id}${after} · writes ${task.files.join(", ")}`;
      const brief = document.createElement("p");
      brief.className = "graph-task-brief";
      brief.textContent = task.brief;
      item.append(title, meta, brief);
      return item;
    }));
  }

  async function request(op, input) {
    const response = await invoke("graph_request", { request: { op, input } });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }

  async function refresh() {
    const snapshot = await request("status");
    start.disabled = !!snapshot?.busy;
    cancel.disabled = !snapshot?.running && !snapshot?.planning;
    showPatch.disabled = snapshot?.status !== "ready_to_export";
    const runId = snapshot?.run?.id;
    if (showPatch.disabled || currentRun !== runId) {
      output.value = "";
      patchView.hidden = true;
      patchView.open = false;
    }
    currentRun = runId;
    history.value = runId ?? "";
    const draft = snapshot?.draft;
    const context = snapshot?.run?.context;
    const planTasks = draft?.tasks ?? context?.tasks;
    const planKey = draft ? `draft:${draft.id}:${draft.hash}` : context?.planHash ? `run:${runId}` : "";
    if (planKey !== shownPlan) {
      shownPlan = planKey;
      shownDraft = draft && { draft: draft.id, hash: draft.hash };
      renderTasks(planTasks ?? []);
    }
    planPanel.hidden = !planTasks;
    planTitle.textContent = draft ? "Proposed plan" : "Approved plan";
    planActions.hidden = !draft;
    approve.disabled = !!snapshot?.busy;
    const eligible = snapshot?.retryable ?? [];
    if (eligible.join() !== [...retryNode.options].map(option => option.value).join()) {
      retryNode.replaceChildren(...eligible.map(id => new Option(id, id)));
    }
    retry.disabled = retryNode.disabled = eligible.length === 0;
    resume.hidden = !snapshot?.resumable;
    const logged = snapshot?.logs ?? [];
    logKeys = new Map(logged.map(id => [id, `${runId}:${id}:${snapshot.run.nodes[id].attempt}`]));
    if (logged.join() !== [...logNode.options].map(option => option.value).join()) {
      logNode.replaceChildren(...logged.map(id => new Option(id, id)));
    }
    showLog.disabled = logNode.disabled = logged.length === 0;
    logs.hidden = logged.length === 0;
    if (shownLog && ![...logKeys.values()].includes(shownLog)) {
      shownLog = "";
      log.value = "";
      log.hidden = true;
    }
    const titles = new Map((context?.tasks ?? []).map(task => [`code-${task.id}`, task.title]));
    nodes.replaceChildren(...(snapshot?.run?.plan.nodes ?? []).map(node => {
      const item = document.createElement("li");
      const state = snapshot.run.nodes[node.id];
      const phase = state.status === "succeeded" ? "completed" : state.status;
      const role = titles.has(node.id) ? `coder · ${titles.get(node.id)}` : node.role;
      item.textContent = `${role} · ${phase}${state.error ? ` · ${state.error}` : ""}`;
      return item;
    }));
    const label =
      snapshot?.error ||
      snapshot?.planError ||
      (snapshot?.planning ? "Planning…" : "") ||
      (draft && !snapshot?.running ? "Review the plan. Coders start only after approval." : "") ||
      snapshot?.reason ||
      states[snapshot?.status] ||
      (snapshot?.running ? "Graph running" : snapshot?.run?.cancelled ? "Run cancelled" : snapshot?.run ? "Run finished" : "");
    if (status.textContent !== label) status.textContent = label;
  }

  async function refreshHistory() {
    const runs = await request("list");
    history.replaceChildren(new Option("Select a run", ""), ...runs.map(run => {
      const objective = run.context?.objective.trim().replace(/\s+/g, " ").slice(0, 70);
      return new Option(`${objective || "Saved run"} · ${run.id.slice(0, 8)}`, run.id);
    }));
    await refresh();
  }

  function action(run) {
    pending = pending.then(run).catch(error => {
      status.textContent = error.message || String(error);
    });
    return pending;
  }

  function tick(current) {
    if (!dialog.open || current !== generation) return;
    void action(refresh).finally(() => {
      if (dialog.open && current === generation) polling = setTimeout(() => tick(current), 800);
    });
  }

  document.getElementById("graph-open").addEventListener("click", () => {
    dialog.showModal();
    void action(refreshHistory);
    tick(++generation);
  });
  document.getElementById("graph-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { generation++; clearTimeout(polling); });
  form.addEventListener("submit", event => {
    event.preventDefault();
    void action(async () => {
      const fields = new FormData(form);
      await request("plan", {
        source: fields.get("source").trim(),
        objective: fields.get("objective").trim(),
        files: fields.get("files").split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      });
      output.value = "";
      patchView.hidden = true;
      patchView.open = false;
      await refresh();
    });
  });
  approve.addEventListener("click", () => {
    const chosen = shownDraft;
    if (chosen) void action(async () => { await request("approve", chosen); await refreshHistory(); });
  });
  discard.addEventListener("click", () => void action(async () => { await request("discard"); await refresh(); }));
  cancel.addEventListener("click", () => void action(async () => {
    await request("cancel");
    await refresh();
  }));
  history.addEventListener("change", () => {
    const id = history.value;
    if (id) void action(async () => { await request("open", id); await refresh(); });
  });
  retry.addEventListener("click", () => {
    const node = retryNode.value;
    if (node) void action(async () => { await request("retry", node); await refresh(); });
  });
  resume.addEventListener("click", () => void action(async () => { await request("resume"); await refresh(); }));
  showLog.addEventListener("click", () => {
    const node = logNode.value;
    if (node) void action(async () => {
      log.value = await request("log", node);
      shownLog = logKeys.get(node) ?? "";
      log.hidden = false;
      logs.open = true;
    });
  });
  showPatch.addEventListener("click", () => void action(async () => {
    const artifact = await request("patch");
    base.textContent = `Base ${artifact.baseSha}`;
    output.value = artifact.patch;
    patchView.hidden = false;
    patchView.open = true;
    output.focus();
  }));
})();
