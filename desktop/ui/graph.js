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
  const history = document.getElementById("graph-history");
  const retryNode = document.getElementById("graph-retry-node");
  const retry = document.getElementById("graph-retry");
  const resume = document.getElementById("graph-resume");
  const states = { ready_to_export: "Verified patch ready", needs_input: "Graph needs input", stale_base: "Source checkout changed" };
  let polling;
  let pending = Promise.resolve();
  let generation = 0;
  let currentRun;

  async function request(op, input) {
    const response = await invoke("graph_request", { request: { op, input } });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }

  async function refresh() {
    const snapshot = await request("status");
    start.disabled = !!snapshot?.busy;
    cancel.disabled = !snapshot?.running;
    showPatch.disabled = snapshot?.status !== "ready_to_export";
    const runId = snapshot?.run?.id;
    if (showPatch.disabled || currentRun !== runId) {
      output.value = "";
      output.hidden = true;
      base.hidden = true;
    }
    currentRun = runId;
    history.value = runId ?? "";
    const eligible = snapshot?.retryable ?? [];
    if (eligible.join() !== [...retryNode.options].map(option => option.value).join()) {
      retryNode.replaceChildren(...eligible.map(id => new Option(id, id)));
    }
    retry.disabled = retryNode.disabled = eligible.length === 0;
    resume.hidden = !snapshot?.resumable;
    nodes.replaceChildren(...(snapshot?.run?.plan.nodes ?? []).map(node => {
      const item = document.createElement("li");
      const state = snapshot.run.nodes[node.id];
      const phase = state.status === "succeeded" ? "completed" : state.status;
      item.textContent = `${node.role} · ${phase}${state.error ? ` · ${state.error}` : ""}`;
      return item;
    }));
    const label = snapshot?.error || states[snapshot?.status] || (snapshot?.running ? "Graph running" : snapshot?.run?.cancelled ? "Run cancelled" : snapshot ? "Run finished" : "");
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
      await request("start", {
        source: fields.get("source").trim(),
        objective: fields.get("objective").trim(),
        files: fields.get("files").split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      });
      output.value = "";
      output.hidden = true;
      base.hidden = true;
      await refreshHistory();
    });
  });
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
  showPatch.addEventListener("click", () => void action(async () => {
    const artifact = await request("patch");
    base.textContent = `Base ${artifact.baseSha}`;
    base.hidden = false;
    output.value = artifact.patch;
    output.hidden = false;
    output.focus();
  }));
})();
