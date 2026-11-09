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
  const states = { ready_to_export: "Verified patch ready", needs_input: "Graph needs input", stale_base: "Source checkout changed" };
  let polling;
  let pending = Promise.resolve();
  let generation = 0;

  async function request(op, input) {
    const response = await invoke("graph_request", { request: { op, input } });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }

  async function refresh() {
    const snapshot = await request("status");
    start.disabled = !!snapshot?.running;
    cancel.disabled = !snapshot?.running;
    showPatch.disabled = snapshot?.status !== "ready_to_export";
    if (showPatch.disabled) {
      output.value = "";
      output.hidden = true;
      base.hidden = true;
    }
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
      await refresh();
    });
  });
  cancel.addEventListener("click", () => void action(async () => {
    await request("cancel");
    await refresh();
  }));
  showPatch.addEventListener("click", () => void action(async () => {
    const artifact = await request("patch");
    base.textContent = `Base ${artifact.baseSha}`;
    base.hidden = false;
    output.value = artifact.patch;
    output.hidden = false;
    output.focus();
  }));
})();
