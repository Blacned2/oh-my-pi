(() => {
  const { invoke } = window.__TAURI__.core;
  const { browseFolder, folderName, loadRecent, saveRecent } = window.KostompFolders;
  const chat = document.getElementById("chat");
  const panel = document.getElementById("graph");
  const eyebrow = document.getElementById("graph-eyebrow");
  const title = document.getElementById("graph-title");
  const intro = document.getElementById("graph-intro");
  const runRepo = document.getElementById("graph-run-repo");
  const form = document.getElementById("graph-form");
  const project = document.getElementById("graph-project");
  const browse = document.getElementById("graph-browse");
  const repoPath = document.getElementById("graph-repository-path");
  const objective = document.getElementById("graph-objective");
  const start = document.getElementById("graph-start");
  const cancel = document.getElementById("graph-cancel");
  const showPatch = document.getElementById("graph-patch");
  const status = document.getElementById("graph-status");
  const output = document.getElementById("graph-output");
  const base = document.getElementById("graph-base");
  const patchView = document.getElementById("graph-patch-view");
  const logs = document.getElementById("graph-logs");
  const failureObservation = document.getElementById("graph-failure-observation");
  const history = document.getElementById("graph-history");
  const sideGraphs = document.getElementById("side-graphs");
  const newRun = document.getElementById("graph-new");
  const newLabel = document.getElementById("graph-new-label");
  const activityActions = document.getElementById("graph-activity-actions");
  const resume = document.getElementById("graph-resume");
  const planPanel = document.getElementById("graph-plan");
  const planTitle = document.getElementById("graph-plan-title");
  const planSummary = document.getElementById("graph-plan-summary");
  const tasks = document.getElementById("graph-tasks");
  const planActions = document.getElementById("graph-plan-actions");
  const edit = document.getElementById("graph-edit-plan");
  const editor = document.getElementById("graph-plan-editor");
  const editorFields = document.getElementById("graph-editor-fields");
  const editTasks = document.getElementById("graph-edit-tasks");
  const editError = document.getElementById("graph-edit-error");
  const save = document.getElementById("graph-save-plan");
  const approve = document.getElementById("graph-approve");
  const discard = document.getElementById("graph-discard");
  const logNode = document.getElementById("graph-log-node");
  const showLog = document.getElementById("graph-show-log");
  const log = document.getElementById("graph-log");
  const states = { ready_to_export: "Verified patch ready", needs_input: "Graph needs input", stale_base: "Source checkout changed" };
  let graphMode = false;
  let repository = "";
  let formBusy = false;
  let submittingPlan = false;
  let browsing = false;
  let polling;
  let pending = Promise.resolve();
  let generation = 0;
  let historyLoaded = false;
  let interactionError = "";
  let currentRun;
  let shownPlan = "";
  /** The proposal on screen. Approval names it so the host rejects a plan the user has not seen. */
  let shownDraft;
  let editingDraft;
  /** `run:node:attempt` of the log on screen. A newer attempt hides it. */
  let shownLog = "";
  let logKeys = new Map();
  const flow = window.KostompGraphMap(document.getElementById("graph-flow"), {
    showLog: openStepLog,
    retry: retryStep,
  });

  const sameFolder = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

  /** The projects chats have opened (recent folders) plus the one selected now. */
  function renderProjects() {
    const folders = loadRecent();
    if (repository && !folders.some(folder => sameFolder(folder, repository))) folders.unshift(repository);
    const names = folders.map(folderName);
    project.replaceChildren(
      new Option(folders.length ? "Choose a project…" : "No projects yet. Use Browse…", ""),
      ...folders.map((folder, index) => {
        const unique = names.filter(name => name === names[index]).length === 1;
        const option = new Option(unique ? names[index] : folder, folder);
        option.title = folder;
        return option;
      }),
    );
    project.value = folders.find(folder => repository && sameFolder(folder, repository)) ?? "";
  }

  function setRepository(path) {
    repository = path;
    repoPath.textContent = path;
    repoPath.hidden = !path;
    renderProjects();
    updateComposer();
  }

  function updateComposer() {
    start.disabled = formBusy || submittingPlan || !repository || !objective.value.trim();
  }

  function showStatus(label, kind = "") {
    if (status.textContent !== label) status.textContent = label;
    status.hidden = !label;
    status.dataset.kind = kind;
  }

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

  function addEditTask(task) {
    const item = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Coder task";
    item.append(legend);
    function field(name, caption, value, { rows, maxLength, required = true } = {}) {
      const label = document.createElement("label");
      label.textContent = caption;
      const input = document.createElement(rows ? "textarea" : "input");
      if (rows) input.rows = rows;
      if (maxLength) input.maxLength = maxLength;
      input.name = name;
      input.required = required;
      input.value = value;
      label.append(input);
      item.append(label);
      return input;
    }
    const id = field("id", "Task ID", task?.id ?? "", { maxLength: 32 });
    id.pattern = "[a-z][a-z0-9\\-]*";
    field("title", "Title", task?.title ?? "", { maxLength: 200 });
    field("brief", "Instructions and acceptance criteria", task?.brief ?? "", { rows: 3, maxLength: 4096 });
    field("dependsOn", "Depends on task IDs (one per line)", task?.dependsOn.join("\n") ?? "", { rows: 2, required: false });
    field("files", "Owned files (one per line)", task?.files.join("\n") ?? "", { rows: 2 });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove task";
    remove.addEventListener("click", () => item.remove());
    item.append(remove);
    editTasks.append(item);
    if (!task) id.focus();
  }

  function setEditError(message = "") {
    editError.textContent = message;
    editError.hidden = !message;
  }

  function closeEditor() {
    editingDraft = undefined;
    editor.hidden = true;
    editorFields.disabled = false;
    tasks.hidden = false;
    planActions.hidden = !shownDraft;
    editTasks.replaceChildren();
    setEditError();
  }

  async function request(op, input) {
    const response = await invoke("graph_request", { request: { op, input } });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }

  /** Highlight the open run, or New graph, in the sidebar while the Graph pane is on screen. */
  function markCurrent() {
    for (const button of history.querySelectorAll("button")) {
      if (graphMode && button.dataset.run === currentRun) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (graphMode && !currentRun) newRun.setAttribute("aria-current", "page");
    else newRun.removeAttribute("aria-current");
  }

  async function refresh() {
    const snapshot = await request("status");
    const runId = snapshot?.run?.id;
    const composing = !runId;
    const planning = composing && !!snapshot?.planning;
    form.hidden = !composing;
    formBusy = !!snapshot?.busy;
    updateComposer();
    cancel.hidden = !snapshot?.running && !planning;
    resume.hidden = !snapshot?.resumable;
    showPatch.hidden = snapshot?.status !== "ready_to_export";
    activityActions.hidden = cancel.hidden && resume.hidden && showPatch.hidden;
    if (showPatch.hidden || currentRun !== runId) {
      output.value = "";
      patchView.hidden = true;
      patchView.open = false;
    }
    currentRun = runId;
    markCurrent();
    newLabel.textContent = snapshot?.draft ? "Graph draft" : "New graph";
    const draft = composing ? snapshot?.draft : undefined;
    const context = snapshot?.run?.context;
    eyebrow.textContent = composing ? "Graph workspace" : `Graph run · ${runId.slice(0, 8)}`;
    title.textContent = composing ? "Plan a change" : context?.objective.trim().replace(/\s+/g, " ").slice(0, 200) || "Saved run";
    intro.hidden = !composing;
    runRepo.hidden = !context?.sourceRoot;
    runRepo.textContent = context?.sourceRoot ?? "";
    const planTasks = draft?.tasks ?? context?.tasks;
    const planKey = draft ? `draft:${draft.id}:${draft.hash}` : context?.planHash ? `run:${runId}` : "";
    if (planKey !== shownPlan) {
      shownPlan = planKey;
      shownDraft = draft;
      if (editingDraft) closeEditor();
      if (draft && !objective.value) {
        setRepository(draft.source);
        objective.value = draft.objective;
        updateComposer();
      }
      planSummary.hidden = !draft;
      planSummary.textContent = draft ? `${draft.objective} · ${draft.source}` : "";
      renderTasks(planTasks ?? []);
    }
    planPanel.hidden = !planTasks;
    planTitle.textContent = draft ? "Proposed plan" : "Approved plan";
    planActions.hidden = !draft || !!editingDraft;
    approve.disabled = edit.disabled = save.disabled = !!snapshot?.busy;
    const logged = snapshot?.logs ?? [];
    logKeys = new Map(logged.map(id => [id, `${runId ?? snapshot.plannerLogId}:${id}:${snapshot.run?.nodes[id]?.attempt ?? 0}`]));
    if (logged.join() !== [...logNode.options].map(option => option.value).join()) {
      logNode.replaceChildren(...logged.map(id => new Option(id, id)));
    }
    showLog.disabled = logNode.disabled = logged.length === 0;
    logs.hidden = logged.length === 0;
    const observation = snapshot?.failureObservation;
    failureObservation.hidden = !observation;
    failureObservation.textContent = !observation ? "" : observation.status === "observed"
      ? `Test failure observation · ${observation.choice.replaceAll("_", " ")} · ${Math.round(observation.confidence * 100)}% · ${observation.model}`
      : `Test failure observation unavailable · ${observation.reason.replaceAll("_", " ")}`;
    if (shownLog && ![...logKeys.values()].includes(shownLog)) {
      shownLog = "";
      log.value = "";
      log.hidden = true;
    }
    flow.render(snapshot);
    const error = interactionError || snapshot?.error || (composing && snapshot?.planError);
    const label = error ||
      (planning ? "Planning…" : "") ||
      (draft && !snapshot?.run ? "Review the plan. Coders start only after approval." : "") ||
      states[snapshot?.status] ||
      snapshot?.reason ||
      (snapshot?.running ? "Graph running" : snapshot?.run?.cancelled ? "Run cancelled" : snapshot?.run ? "Run finished" : "");
    showStatus(label, error ? "error" : snapshot?.status ?? "");
  }

  async function renderHistory() {
    const runs = await request("list");
    history.replaceChildren(...runs.map(run => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.run = run.id;
      button.className = "graph-run-item";
      const name = document.createElement("span");
      name.className = "graph-run-name";
      name.textContent = run.context?.objective.trim().replace(/\s+/g, " ") || "Saved run";
      const detail = document.createElement("span");
      detail.className = "graph-run-detail";
      detail.textContent = folderName(run.context?.sourceRoot ?? "") || run.id.slice(0, 8);
      button.title = name.textContent;
      button.append(name, detail);
      item.append(button);
      return item;
    }));
    sideGraphs.hidden = runs.length === 0;
    markCurrent();
  }

  async function refreshHistory() {
    await renderHistory();
    historyLoaded = true;
    await refresh();
  }

  function action(run, background = false) {
    pending = pending.then(() => {
      if (!background) interactionError = "";
      return run();
    }).catch(error => {
      const message = error?.message || String(error);
      if (!background) interactionError = message;
      showStatus(message, "error");
    });
    return pending;
  }

  function retryStep(runId, node) {
    void action(async () => {
      if (currentRun !== runId) return;
      await request("retry", node);
      await refresh();
    });
  }

  function openStepLog(node) {
    const key = logKeys.get(node);
    if (!key) return;
    void action(async () => {
      if (logKeys.get(node) !== key) return;
      log.value = await request("log", node);
      shownLog = key;
      logNode.value = node;
      log.hidden = false;
      logs.open = true;
      log.focus();
    });
  }

  /** Poll only while the Graph pane is on screen. */
  const visible = () => graphMode && !chat.hidden;

  function tick(current) {
    if (!visible() || current !== generation) return;
    void action(historyLoaded ? refresh : refreshHistory, true).finally(() => {
      if (visible() && current === generation) {
        polling = setTimeout(() => tick(current), status.dataset.kind === "error" ? 2500 : 800);
      }
    });
  }

  function onView() {
    clearTimeout(polling);
    const current = ++generation;
    if (!visible()) return;
    historyLoaded = false;
    tick(current);
  }

  /** Graph shares the chat sidebar: its pane replaces the chat workspace until a chat is picked. */
  function setMode(on) {
    if (graphMode === on) return;
    graphMode = on;
    chat.classList.toggle("graph-mode", on);
    panel.hidden = !on;
    if (on) {
      if (!repository) setRepository(loadRecent()[0] ?? "");
      else renderProjects();
    }
    markCurrent();
    onView();
  }

  document.addEventListener("kostomp-view", onView);
  // A chat coming to the front, from the sidebar or anywhere else, leaves the Graph pane.
  document.addEventListener("kostomp-chat-shown", () => setMode(false));
  const chatControls = document.getElementById("session-tabs");
  const leaveForChat = event => { if (!event.target.closest("#graph-new")) setMode(false); };
  chatControls.addEventListener("click", leaveForChat, true);
  chatControls.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") leaveForChat(event); }, true);
  renderProjects();
  void action(renderHistory, true);
  newRun.addEventListener("click", () => {
    setMode(true);
    void action(async () => {
      await request("compose");
      await refresh();
      panel.scrollTop = 0;
      project.focus();
    });
  });
  project.addEventListener("change", () => setRepository(project.value));
  browse.addEventListener("click", async () => {
    if (browsing) return;
    browsing = true;
    try {
      const picked = await browseFolder(repository, { allowCreate: false });
      if (picked) {
        saveRecent(picked);
        setRepository(picked);
      }
    } catch (error) {
      showStatus(error?.message || String(error), "error");
    } finally {
      browsing = false;
    }
  });
  objective.addEventListener("input", updateComposer);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (start.disabled) return;
    const input = { source: repository, objective: objective.value.trim() };
    submittingPlan = true;
    updateComposer();
    void action(async () => {
      try {
        await request("plan", input);
        await refresh();
      } finally {
        submittingPlan = false;
        updateComposer();
      }
    });
  });
  approve.addEventListener("click", () => {
    const chosen = shownDraft;
    if (chosen) void action(async () => { await request("approve", { draft: chosen.id, hash: chosen.hash }); await refreshHistory(); });
  });
  edit.addEventListener("click", () => {
    if (!shownDraft) return;
    editingDraft = { draft: shownDraft.id, hash: shownDraft.hash };
    for (const task of shownDraft.tasks) addEditTask(task);
    tasks.hidden = planActions.hidden = true;
    editor.hidden = false;
    editTasks.querySelector("input")?.focus();
  });
  document.getElementById("graph-add-task").addEventListener("click", () => addEditTask());
  document.getElementById("graph-cancel-edit").addEventListener("click", () => { closeEditor(); edit.focus(); });
  editor.addEventListener("submit", event => {
    event.preventDefault();
    if (!editingDraft || editorFields.disabled) return;
    const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const plan = { tasks: [...editTasks.children].map(item => {
      const value = name => item.elements.namedItem(name).value.trim();
      return { id: value("id"), title: value("title"), brief: value("brief"), dependsOn: lines(value("dependsOn")), files: lines(value("files")) };
    }) };
    const selected = editingDraft;
    editorFields.disabled = true;
    setEditError();
    void action(async () => {
      if (editingDraft !== selected) return;
      try {
        await request("edit", { ...selected, plan });
      } catch (error) {
        setEditError(error.message || String(error));
        editorFields.disabled = false;
        return;
      }
      closeEditor();
      await refresh();
      edit.focus();
    });
  });
  discard.addEventListener("click", () => void action(async () => { await request("discard"); await refresh(); }));
  cancel.addEventListener("click", () => void action(async () => {
    await request("cancel");
    await refresh();
  }));
  history.addEventListener("click", event => {
    const id = event.target.closest("button[data-run]")?.dataset.run;
    if (!id) return;
    setMode(true);
    void action(async () => {
      await request("open", id);
      await refresh();
      panel.scrollTop = 0;
    });
  });
  resume.addEventListener("click", () => void action(async () => { await request("resume"); await refresh(); }));
  showLog.addEventListener("click", () => openStepLog(logNode.value));
  showPatch.addEventListener("click", () => void action(async () => {
    const artifact = await request("patch");
    base.textContent = `Base ${artifact.baseSha}`;
    output.value = artifact.patch;
    patchView.hidden = false;
    patchView.open = true;
    output.focus();
  }));
})();
