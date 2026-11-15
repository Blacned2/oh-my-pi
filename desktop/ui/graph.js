(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { browseFolder, folderName, loadRecent, saveRecent } = window.KostompFolders;
  const chat = document.getElementById("chat");
  const panel = document.getElementById("graph");
  const eyebrow = document.getElementById("graph-eyebrow");
  const title = document.getElementById("graph-title");
  const objectiveToggle = document.getElementById("graph-objective-toggle");
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
  const copyPatch = document.getElementById("graph-copy-patch");
  const status = document.getElementById("graph-status");
  const output = document.getElementById("graph-output");
  const base = document.getElementById("graph-base");
  const patchView = document.getElementById("graph-patch-view");
  const failureObservation = document.getElementById("graph-failure-observation");
  const graphsPanel = window.KostompGraphsPanel;
  const history = graphsPanel.querySelector("#graph-history");
  const openList = document.getElementById("graph-open");
  const sideGraphs = document.getElementById("side-graphs");
  const graphsToggle = document.getElementById("graphs-toggle");
  const graphsRefresh = graphsPanel.querySelector("#graphs-refresh");
  const graphEmpty = graphsPanel.querySelector("#graph-empty");
  const loadOlder = graphsPanel.querySelector("#graph-load-older");
  const newRun = document.getElementById("graph-new");
  const openActive = document.getElementById("graph-open-active");
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
  /** What the pane shows (run, draft or composer). When it changes, an error left by an earlier action goes. */
  let shownIdentity = "";
  /** Consecutive failed polls; they back polling off from 2.5 s to 30 s. */
  let failedPolls = 0;
  /** Buttons whose action is queued or running. They stay disabled until it settles. */
  const held = new Set();
  /** The draft under the open editor is no longer the saved one: Save stays off until the editor closes. */
  let editorStale = false;
  const STALE_EDIT = "The plan changed while you were editing. Copy what you need, then cancel editing.";
  const MAX_ENTRIES = 150;
  const OPEN_KEY = "kostomp-graph-open";
  /**
   * Runs shown in the sidebar, like open chat tabs: `{ id, objective, source }`, stored so rows render without the
   * sidecar. Closing one only hides it; the Graphs list reopens it.
   */
  let openRows = [];
  /** Ids stored by earlier versions, without objective or source: matched against the first `list` page, then dropped. */
  let legacyOpen;
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY));
    if (Array.isArray(saved)) {
      openRows = saved.filter(row => typeof row?.id === "string" && typeof row.objective === "string" && typeof row.source === "string");
      const ids = saved.filter(id => typeof id === "string");
      if (ids.length) legacyOpen = ids;
    }
  } catch {}
  /** The runs listed so far, newest first: the first `list` page and every older page loaded after it. */
  let knownRuns = [];
  /** The sidecar has runs older than the last of `knownRuns`. */
  let moreRuns = false;
  /** `busy` from the last status answer, shown or background. */
  let sidecarBusy = false;
  let backgroundPoll;
  /** `finished.at` last seen; the first status answer after load only sets it. */
  let finishedAt;
  let finishedBaseline = false;
  /** The proposal on screen. Approval names it so the host rejects a plan the user has not seen. */
  let shownDraft;
  let editingDraft;
  const activity = document.getElementById("graph-step-activity");
  /** `run:node:attempt` of the transcript on screen, or the note shown instead. */
  let shownActivity = "";
  /** The transcript text painted for `shownActivity`; unset whenever anything else is painted. */
  let shownLog;
  /** Every entry split from `shownLog`; the feed shows the last MAX_ENTRIES. */
  let shownEntries = [];
  /** `logSizes` of the step when `shownLog` was fetched, and whether the step was running then. */
  let shownSize;
  let shownLive = false;
  let latestSnapshot;
  let latestView;
  const flow = window.KostompGraphMap(document.getElementById("graph-flow"), {
    onSelect: () => {
      resetActivity();
      activity.replaceChildren();
      const runId = currentRun;
      void action(() => currentRun === runId ? syncActivity() : undefined, true);
    },
    retry: retryStep,
  });

  function updateObjectiveToggle() {
    const expanded = title.classList.contains("expanded");
    objectiveToggle.hidden = !title.classList.contains("graph-run-title") || (!expanded && title.scrollHeight <= title.clientHeight);
    objectiveToggle.textContent = expanded ? "Collapse objective" : "Show full objective";
    objectiveToggle.setAttribute("aria-expanded", String(expanded));
  }

  objectiveToggle.addEventListener("click", () => {
    title.classList.toggle("expanded");
    updateObjectiveToggle();
  });
  new ResizeObserver(updateObjectiveToggle).observe(title);

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
    const files = field("files", "Owned files (one per line)", task?.files.join("\n") ?? "", { rows: 2 });
    // `required` accepts blank lines; the sidecar would reject them a round-trip later.
    const checkFiles = () => files.setCustomValidity(files.value.split(/\r?\n/).some(line => line.trim()) ? "" : "List at least one owned file, one per line.");
    checkFiles();
    files.addEventListener("input", checkFiles);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove task";
    remove.addEventListener("click", () => item.remove());
    item.append(remove);
    editTasks.append(item);
    if (!task) id.focus();
  }

  function setEditError(message = "") {
    if (editError.textContent !== message) editError.textContent = message;
    editError.hidden = !message;
  }

  function closeEditor() {
    editingDraft = undefined;
    editorStale = false;
    editor.hidden = true;
    editorFields.disabled = false;
    tasks.hidden = false;
    planActions.hidden = !shownDraft;
    planPanel.hidden = !shownPlan;
    editTasks.replaceChildren();
    setEditError();
    syncButtons();
  }

  function focusEdit() {
    if (edit.checkVisibility()) edit.focus();
  }

  async function request(op, input) {
    const response = await invoke("graph_request", { request: { op, input } });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }

  /** Highlight the open run, or New graph, in the sidebar while the Graph pane is on screen. */
  function markCurrent() {
    for (const button of [...history.querySelectorAll("button[data-run]"), ...openList.querySelectorAll("button[data-run]")]) {
      if (graphMode && button.dataset.run === currentRun) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (graphMode && !currentRun) newRun.setAttribute("aria-current", "page");
    else newRun.removeAttribute("aria-current");
  }

  function saveOpen() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...(legacyOpen ?? []), ...openRows])); } catch {}
  }

  /** What a sidebar row needs from a listed or shown run. */
  const rowOf = run => ({ id: run.id, objective: run.context?.objective ?? "", source: run.context?.sourceRoot ?? "" });

  function runButton(row) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.run = row.id;
    button.className = "graph-run-item";
    const name = document.createElement("span");
    name.className = "graph-run-name";
    name.textContent = row.objective.trim().replace(/\s+/g, " ") || "Saved run";
    const detail = document.createElement("span");
    detail.className = "graph-run-detail";
    detail.textContent = folderName(row.source) || row.id.slice(0, 8);
    button.title = name.textContent;
    const icon = document.createElement("span");
    icon.className = "graph-run-ico";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = name.textContent.charAt(0) || "G";
    button.append(icon, name, detail);
    return button;
  }

  function deleteButton(run) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "graph-run-delete";
    button.textContent = "⌫";
    button.title = "Delete graph run permanently";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      const row = button.parentElement;
      void (async () => {
        const confirmed = await window.kostompConfirmDelete("Delete Graph run?",
          `${run.objective || run.id}\nThis permanently removes the run, patch, logs and artifacts. A running Graph will be stopped. Your source repository is not changed. This cannot be undone.`);
        if (confirmed) {
          row.querySelector(":scope > [role=alert]")?.remove();
          const detail = row.querySelector(".graph-run-detail");
          const shown = detail.textContent;
          // Deleting a running run waits for its workers to stop, which can take a while.
          row.setAttribute("aria-busy", "true");
          detail.textContent = "Deleting…";
          await action(async () => {
            try {
              await request("delete", run.id);
            } catch (error) {
              const message = document.createElement("p");
              message.className = "saved-empty";
              message.setAttribute("role", "alert");
              message.textContent = "Could not delete Graph run: " + String(error?.message ?? error);
              row.append(message);
              throw error;
            }
            dropOpen(run.id);
            await refreshHistory();
          });
          row.removeAttribute("aria-busy");
          detail.textContent = shown;
        }
        button.disabled = false;
      })();
    });
    return button;
  }

  /** Sidebar: the runs the user has open, each with a close button. */
  function renderOpen() {
    openList.replaceChildren(...openRows.map(row => {
      const item = document.createElement("li");
      item.className = "graph-open-row";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "graph-run-close";
      close.dataset.close = row.id;
      close.textContent = "×";
      close.title = "Close graph run";
      close.setAttribute("aria-label", "Close graph run");
      item.append(runButton(row), deleteButton(row), close);
      item.addEventListener("mousedown", event => {
        if (event.button === 1) event.preventDefault();
      });
      item.addEventListener("auxclick", event => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeRun(row.id);
      });
      return item;
    }));
    sideGraphs.hidden = openRows.length === 0;
    markCurrent();
  }

  /** Add `row` to the sidebar, or update the open row with its id. A row without objective or source keeps the stored one. */
  function keepOpen(row) {
    const index = openRows.findIndex(open => open.id === row.id);
    if (index >= 0) {
      const open = openRows[index];
      if ((!row.objective && !row.source) || (open.objective === row.objective && open.source === row.source)) return;
      openRows[index] = row;
    } else openRows.push(row);
    saveOpen();
    renderOpen();
  }

  function dropOpen(id) {
    if (!openRows.some(row => row.id === id)) return;
    openRows = openRows.filter(row => row.id !== id);
    saveOpen();
    renderOpen();
  }

  /** The listed or stored row for `id`; an id known to neither shows as "Saved run" until the run is shown. */
  function knownRow(id) {
    const listed = knownRuns.find(run => run.id === id);
    return listed ? rowOf(listed) : openRows.find(row => row.id === id) ?? { id, objective: "", source: "" };
  }

  /** After opening run `id`, store what its open row shows from the run itself. */
  function rememberShown(id) {
    const run = latestSnapshot?.run;
    if (run?.id === id && openRows.some(row => row.id === id)) keepOpen(rowOf(run));
  }

  function closeRun(id) {
    dropOpen(id);
    if (!graphMode || currentRun !== id) return;
    setMode(false);
    void action(() => request("compose"), true);
  }

  function syncButtons() {
    const busy = !!latestSnapshot?.busy;
    approve.disabled = busy || held.has(approve);
    edit.disabled = busy;
    save.disabled = busy || editorStale;
    discard.disabled = held.has(discard);
    cancel.disabled = !!latestSnapshot?.cancelling || held.has(cancel);
    resume.disabled = held.has(resume);
    showPatch.disabled = held.has(showPatch);
    openActive.disabled = held.has(openActive);
  }

  function hold(button) {
    if (held.has(button)) return false;
    held.add(button);
    button.disabled = true;
    return true;
  }

  function release(button) {
    held.delete(button);
    syncButtons();
  }

  /** Queue a button's action once: further clicks do nothing until it settles. */
  function guard(button, run) {
    if (hold(button)) void action(run).finally(() => release(button));
  }

  /** Like `guard`, for ops on the sidecar's selected run: skipped if another run was opened before it executes. */
  function guardRun(button, run) {
    const runId = currentRun;
    guard(button, async () => {
      if (currentRun === runId) await run();
    });
  }

  function showDraftWaiting(waiting) {
    if (waiting === newRun.hasAttribute("data-draft")) return;
    newRun.toggleAttribute("data-draft", waiting);
    const label = waiting ? "New graph · draft waiting for review" : "New graph";
    newRun.title = label;
    newRun.setAttribute("aria-label", label);
  }

  /** Why a run that is not running stopped, read from its steps when the release decided nothing. */
  function runOutcome(run) {
    const status = node => run.nodes[node.id]?.status;
    const failed = run.plan.nodes.find(node => status(node) === "failed");
    if (failed) return `Run stopped: ${flow.titleOf(failed.id) ?? failed.id} failed`;
    if (run.plan.nodes.some(node => status(node) === "interrupted")) return "Run interrupted";
    if (run.cancelled) return "Run cancelled";
    if (run.plan.nodes.some(node => status(node) === "queued")) return "Run paused";
    return "Run finished";
  }

  function statusLine(snapshot, { composing, planning, draft, elsewhere }) {
    const error = interactionError || snapshot?.error || (composing && snapshot?.planError);
    if (error) return [error, "error"];
    if (planning) return ["Planning…", ""];
    if (elsewhere) return ["Another Graph run is active.", ""];
    if (!composing && snapshot.planning) return ["Planning a new graph…", ""];
    if (draft) return ["Review the plan. Coders start only after approval.", ""];
    if (!snapshot?.run) return ["", ""];
    if (snapshot.cancelling) return ["Cancelling…", ""];
    const release = states[snapshot.status];
    if (release) return [snapshot.reason ? `${release} — ${snapshot.reason}` : release, snapshot.status];
    if (snapshot.running) return ["Graph running", ""];
    return [runOutcome(snapshot.run), ""];
  }

  async function refresh() {
    const snapshot = await request("status");
    const run = snapshot?.run;
    const runId = run?.id;
    const composing = !runId;
    const planning = composing && !!snapshot?.planning;
    const draft = composing ? snapshot?.draft : undefined;
    const identity = runId ? `run:${runId}` : draft ? `draft:${draft.id}:${draft.hash}` : "compose";
    if (identity !== shownIdentity) {
      shownIdentity = identity;
      interactionError = "";
    }
    const activeRun = snapshot?.activeRun;
    // Another run holds the sidecar while this view shows something else.
    const elsewhere = !!snapshot?.busy && !!activeRun && (composing ? !planning : !snapshot.running && activeRun !== runId);
    form.hidden = !composing;
    formBusy = !!snapshot?.busy;
    updateComposer();
    cancel.hidden = !snapshot?.running && !planning;
    resume.hidden = !snapshot?.resumable;
    const resumeLabel = run?.cancelled ? "Resume cancelled run" : "Continue queued work";
    if (resume.textContent !== resumeLabel) resume.textContent = resumeLabel;
    showPatch.hidden = snapshot?.status !== "ready_to_export";
    openActive.hidden = !elsewhere;
    activityActions.hidden = cancel.hidden && resume.hidden && showPatch.hidden && openActive.hidden;
    if (showPatch.hidden || currentRun !== runId) {
      output.value = "";
      patchView.hidden = true;
      patchView.open = false;
    }
    if (currentRun !== runId) title.classList.remove("expanded");
    currentRun = runId;
    markCurrent();
    showDraftWaiting(!!snapshot?.draft);
    const context = run?.context;
    eyebrow.textContent = composing ? "Graph workspace" : `Graph run · ${runId.slice(0, 8)}`;
    const heading = composing ? "Plan a change" : context?.objective.trim().replace(/\s+/g, " ") || "Saved run";
    title.classList.toggle("graph-run-title", !composing);
    if (title.textContent !== heading) title.textContent = heading;
    updateObjectiveToggle();
    intro.hidden = !composing;
    runRepo.hidden = !context?.sourceRoot;
    runRepo.textContent = context?.sourceRoot ?? "";
    const planTasks = draft?.tasks ?? context?.tasks;
    const planKey = draft ? `draft:${draft.id}:${draft.hash}` : context?.planHash ? `run:${runId}` : "";
    if (planKey !== shownPlan) {
      shownPlan = planKey;
      shownDraft = draft;
      if (draft && !objective.value) {
        setRepository(draft.source);
        objective.value = draft.objective;
        updateComposer();
      }
      planSummary.hidden = !draft;
      planSummary.textContent = draft ? `${draft.objective} · ${draft.source}` : "";
      renderTasks(planTasks ?? []);
    }
    planPanel.hidden = !planTasks && !editingDraft;
    planTitle.textContent = draft ? "Proposed plan" : "Approved plan";
    planActions.hidden = !draft || !!editingDraft;
    // The open editor keeps unsaved edits when the draft changes under it; only saving is withheld.
    const stale = !!editingDraft && !(snapshot?.draft?.id === editingDraft.draft && snapshot.draft.hash === editingDraft.hash);
    if (stale !== editorStale) {
      editorStale = stale;
      setEditError(stale ? STALE_EDIT : "");
    }
    latestSnapshot = snapshot;
    sidecarBusy = !!snapshot?.busy;
    noteFinished(snapshot);
    syncButtons();
    const observation = snapshot?.failureObservation;
    failureObservation.hidden = !observation;
    failureObservation.textContent = !observation ? "" : observation.status === "observed"
      ? `Test failure observation · ${observation.choice.replaceAll("_", " ")} · ${Math.round(observation.confidence * 100)}% · ${observation.model}`
      : `Test failure observation unavailable · ${observation.reason.replaceAll("_", " ")}`;
    latestView = flowView(snapshot, draft);
    flow.render(latestView);
    await syncActivity();
    showStatus(...statusLine(snapshot, { composing, planning, draft, elsewhere }));
  }

  function historyRow(run) {
    const row = rowOf(run);
    const item = document.createElement("li");
    item.className = "graph-history-row";
    item.append(runButton(row), deleteButton(row));
    return item;
  }

  /** Open rows show what the list says about their runs. */
  function absorbListed(runs) {
    for (const run of runs) if (openRows.some(row => row.id === run.id)) keepOpen(rowOf(run));
  }

  /** The Graphs list from its first page; "Load older runs" appends the next ones. */
  async function renderHistory() {
    const page = await request("list");
    knownRuns = page.runs;
    moreRuns = page.more;
    if (legacyOpen) {
      const upgraded = legacyOpen.flatMap(id => knownRuns.filter(run => run.id === id).map(rowOf));
      legacyOpen = undefined;
      openRows = [...upgraded, ...openRows.filter(row => !upgraded.some(up => up.id === row.id))];
      saveOpen();
    }
    absorbListed(knownRuns);
    history.replaceChildren(...knownRuns.map(historyRow));
    graphEmpty.hidden = knownRuns.length > 0;
    loadOlder.hidden = !moreRuns;
    renderOpen();
  }

  async function renderOlder() {
    const last = knownRuns.at(-1);
    if (!moreRuns || !last) return;
    const page = await request("list", { after: last.id });
    const listed = new Set(knownRuns.map(run => run.id));
    const runs = page.runs.filter(run => !listed.has(run.id));
    knownRuns.push(...runs);
    moreRuns = page.more;
    history.append(...runs.map(historyRow));
    loadOlder.hidden = !moreRuns;
    absorbListed(runs);
    markCurrent();
  }

  async function refreshHistory() {
    await renderHistory();
    historyLoaded = true;
    await refresh();
  }

  /** Queue `run` behind every earlier request. A foreground action clears the last error and polls again soon after. */
  function action(run, background = false) {
    pending = pending.then(() => {
      if (!background) {
        interactionError = "";
        failedPolls = 0;
      }
      return run();
    }).catch(error => {
      const message = error?.message || String(error);
      if (!background) interactionError = message;
      showStatus(message, "error");
    });
    if (!background) void pending.then(schedule);
    return pending;
  }

  function retryStep(runId, node) {
    return action(async () => {
      if (currentRun !== runId) return;
      await request("retry", node);
      await refresh();
    });
  }

  const PLANNER = { id: "planner", role: "planner", dependsOn: [], maxAttempts: 1 };
  const idleNotes = {
    context: "The Context Manager ranks repository files. It runs no agent, so it has no transcript.",
    tester: "Tests run in Docker. Their output appears here when they finish.",
    gate: "The release decision runs no agent, so it has no transcript.",
  };

  /** The pipeline as drawn: the Planner first, so the map exists before a plan or a run does. */
  function flowView(snapshot, draft) {
    const run = snapshot?.run;
    if (run) {
      const nodes = [PLANNER, ...run.plan.nodes.map(node => node.dependsOn.length ? node : { ...node, dependsOn: ["planner"] })];
      const planner = { status: "succeeded", attempt: 1, usedAttempts: 1 };
      return { ...snapshot, run: { ...run, plan: { ...run.plan, nodes }, nodes: { planner, ...run.nodes } } };
    }
    const planning = !!snapshot?.planning;
    const error = !draft && !planning ? snapshot?.planError : undefined;
    const started = draft || planning || error;
    const planner = {
      status: planning ? "running" : draft ? "succeeded" : error ? "failed" : "queued",
      attempt: started ? 1 : 0,
      usedAttempts: started ? 1 : 0,
      ...(error && { error }),
    };
    const proposed = draft?.nodes ?? [];
    return {
      ...snapshot,
      run: {
        id: planning ? "planning" : draft ? `draft:${draft.id}:${draft.hash}` : "compose",
        sequence: error ? 1 : 0,
        cancelled: false,
        plan: {
          nodes: [PLANNER, ...proposed.map(node => node.dependsOn.length ? node : { ...node, dependsOn: ["planner"] })],
        },
        nodes: {
          planner,
          ...Object.fromEntries(proposed.map(node => [node.id, { status: "queued", attempt: 0, usedAttempts: 0 }])),
        },
        context: draft && { tasks: draft.tasks },
      },
    };
  }

  /** Tester logs are `Exit code N after M ms`, then stdout and stderr sections: one entry each, never read as a transcript. */
  function testerEntries(text) {
    const lines = text.split("\n");
    const stdout = lines.indexOf("--- stdout ---");
    const stderr = lines.lastIndexOf("--- stderr ---");
    if (stdout !== 1 || stderr < stdout) return [{ kind: "output", text }];
    const code = /^Exit code (\S+)/.exec(lines[0])?.[1];
    return [
      { kind: code !== undefined && code !== "0" ? "error" : "output", text: lines[0] },
      { kind: "output", text: lines.slice(stdout, stderr).join("\n") },
      { kind: "output", text: lines.slice(stderr).join("\n") },
    ];
  }

  /** One transcript line starts with an arrow or `assistant:`; anything else continues the entry before it. */
  function activityEntries(text, role) {
    if (role === "tester") return testerEntries(text);
    const entries = [];
    for (const line of text.split("\n")) {
      const kind = line.startsWith("→") ? "call" : line.startsWith("←") ? "result" : line.startsWith("✗") || line.startsWith("Failed while") ? "error" : line.startsWith("assistant:") ? "say" : undefined;
      if (kind || !entries.length) entries.push({ kind: kind ?? "say", text: line });
      else entries[entries.length - 1].text += `\n${line}`;
    }
    return entries;
  }

  function resetActivity() {
    shownActivity = "";
    shownLog = undefined;
    shownEntries = [];
    shownSize = undefined;
    shownLive = false;
  }

  function paintNote(text, error = false) {
    const note = document.createElement("p");
    note.className = "graph-activity-note";
    if (error) note.dataset.kind = "error";
    note.textContent = text;
    activity.replaceChildren(note);
  }

  function entryElement({ kind, text }) {
    const entry = document.createElement("div");
    entry.className = "graph-activity-entry";
    entry.dataset.kind = kind;
    entry.textContent = text;
    return entry;
  }

  /**
   * Paint a transcript. When it only grew, the entries already on screen stay (keeping the reader's
   * selection and inner scroll): just the last one is updated if it gained lines, and new ones are appended.
   */
  function paintActivity(text, role) {
    const near = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 48;
    const entries = activityEntries(text, role);
    if (shownLog !== undefined && shownEntries.length && text.startsWith(shownLog)) {
      const last = shownEntries.length - 1;
      const shown = activity.querySelectorAll(".graph-activity-entry");
      const tail = shown[shown.length - 1];
      if (tail && tail.dataset.kind !== entries[last].kind) tail.dataset.kind = entries[last].kind;
      if (tail && tail.textContent !== entries[last].text) tail.textContent = entries[last].text;
      activity.append(...entries.slice(Math.max(last + 1, entries.length - MAX_ENTRIES)).map(entryElement));
      const all = activity.querySelectorAll(".graph-activity-entry");
      for (let index = 0; index < all.length - MAX_ENTRIES; index++) all[index].remove();
    } else {
      activity.replaceChildren(...entries.slice(-MAX_ENTRIES).map(entryElement));
    }
    const hidden = Math.max(0, entries.length - MAX_ENTRIES);
    let row = activity.querySelector(".graph-activity-hidden");
    if (hidden) {
      if (!row) {
        row = document.createElement("p");
        row.className = "graph-activity-note graph-activity-hidden";
        activity.prepend(row);
      }
      const label = `${hidden} earlier ${hidden === 1 ? "entry" : "entries"} hidden`;
      if (row.textContent !== label) row.textContent = label;
    } else row?.remove();
    shownLog = text;
    shownEntries = entries;
    if (near) activity.scrollTop = activity.scrollHeight;
  }

  /** Show what the selected step's agent has done so far, and keep following it while it works. */
  async function syncActivity() {
    const run = latestView?.run;
    const node = flow.selected();
    if (!run || !node) return;
    const state = run.nodes[node] ?? { status: "queued", attempt: 0 };
    const live = state.status === "running";
    const role = run.plan.nodes.find(item => item.id === node)?.role;
    if (!latestSnapshot?.logs?.includes(node)) {
      const note = idleNotes[role] ?? (live
        ? "Waiting for the agent's first action…"
        : role === "planner" && state.status === "queued"
          ? "Write the change under the map and choose Propose plan. The Planner's file reads and replies appear here as it works."
          : state.status === "queued" ? "This step has not started." : "No activity was recorded for this step.");
      if (shownActivity !== note) {
        resetActivity();
        shownActivity = note;
        paintNote(note);
      }
      return;
    }
    const key = `${run.id}:${node}:${state.attempt}`;
    const size = latestSnapshot.logSizes?.[node];
    // Without sizes, fetch while the step runs and once more after it settles, for its final lines.
    const changed = key !== shownActivity || (size === undefined ? live || shownLive : size !== shownSize);
    if (!changed) return;
    let text;
    try {
      text = await request("log", node);
    } catch (error) {
      if (flow.selected() !== node) return;
      resetActivity();
      activityState(key, size, live);
      paintNote(error?.message || String(error), true);
      return;
    }
    if (flow.selected() !== node) return;
    if (key !== shownActivity) resetActivity();
    activityState(key, size, live);
    if (text !== shownLog) paintActivity(text, role);
  }

  function activityState(key, size, live) {
    shownActivity = key;
    shownSize = size;
    shownLive = live;
  }

  /** Poll only while the Graph pane is on screen and the window is not hidden. */
  const visible = () => graphMode && !chat.hidden && !document.hidden;

  /** 800 ms while the sidecar works, 3 s when idle; failed polls back off from 2.5 s to 30 s. */
  function pollDelay() {
    if (failedPolls) return Math.min(30000, 2500 * 2 ** (failedPolls - 1));
    return latestSnapshot?.busy ? 800 : 3000;
  }

  function schedule() {
    clearTimeout(polling);
    if (!visible()) {
      scheduleBackground();
      return;
    }
    const current = generation;
    polling = setTimeout(() => tick(current), pollDelay());
  }

  /** While the sidecar works and the pane is not polled, a 5 s status poll notices work that ends off screen. It renders nothing. */
  function scheduleBackground() {
    clearTimeout(backgroundPoll);
    if (visible() || !sidecarBusy) return;
    backgroundPoll = setTimeout(() => {
      if (visible()) return;
      void action(async () => {
        try {
          const snapshot = await request("status");
          sidecarBusy = !!snapshot?.busy;
          noteFinished(snapshot);
        } catch {} // Nothing on screen to report it on; the next poll retries.
      }, true).finally(scheduleBackground);
    }, 5000);
  }

  const finishedBodies = {
    ready_to_export: () => "Verified patch ready",
    needs_input: reason => reason ? `Needs input — ${reason}` : "Needs input",
    stale_base: () => "Source checkout changed",
    failed: () => "A step failed",
    paused: () => "Run paused",
    plan_ready: () => "Plan ready for review",
    plan_failed: reason => reason ? `Planning failed — ${reason}` : "Planning failed",
  };

  /** Toast a run or plan that ended on its own, unless the user is looking at it. */
  function noteFinished(snapshot) {
    const finished = snapshot?.finished;
    if (!finishedBaseline) {
      finishedBaseline = true;
      finishedAt = finished?.at;
      return;
    }
    if (!finished || finished.at === finishedAt) return;
    finishedAt = finished.at;
    if (visible() && document.hasFocus() && (!finished.run || finished.run === currentRun)) return;
    const body = finishedBodies[finished.outcome]?.(finished.reason);
    if (!body) return;
    const line = (finished.objective ?? "").trim().replace(/\s+/g, " ") || "Graph";
    const title = line.length > 60 ? line.slice(0, 59) + "…" : line;
    invoke("notify_reply", { sid: finished.run ? `graph:${finished.run}` : "graph:plan", title, body }).catch(() => {});
  }

  function tick(current) {
    if (!visible() || current !== generation) return;
    void action(async () => {
      try {
        await (historyLoaded ? refresh : refreshHistory)();
        failedPolls = 0;
      } catch (error) {
        failedPolls++;
        throw error;
      }
    }, true).finally(() => {
      if (current === generation) schedule();
    });
  }

  function onView() {
    clearTimeout(polling);
    const current = ++generation;
    scheduleBackground();
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
    document.dispatchEvent(new CustomEvent("kostomp-graph-mode"));
    if (on) {
      if (!repository) setRepository(loadRecent()[0] ?? "");
      else renderProjects();
    }
    markCurrent();
    onView();
  }

  document.addEventListener("kostomp-view", onView);
  document.addEventListener("visibilitychange", onView);
  // A chat coming to the front, from the sidebar or anywhere else, leaves the Graph pane.
  document.addEventListener("kostomp-chat-shown", () => setMode(false));
  // Design shares the same sidebar and pane slot: entering it leaves Graph.
  document.addEventListener("kostomp-design-mode", () => { if (chat.classList.contains("design-mode")) setMode(false); });
  const chatControls = document.querySelectorAll("#session-tabs, .sidebar .compose, .sidebar .seg, .topbar .tool-rail");
  // app.js decides which of these clicks and keys navigate to a chat.
  const leaveForChat = event => { if (window.kostompLeavesForChat(event)) setMode(false); };
  for (const el of chatControls) {
    el.addEventListener("click", leaveForChat, true);
    el.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") leaveForChat(event); }, true);
  }
  graphsToggle.addEventListener("click", () => {
    setMode(false);
    void action(renderHistory, true);
  });
  graphsRefresh.addEventListener("click", () => void action(renderHistory, true));
  loadOlder.addEventListener("click", () => {
    if (loadOlder.disabled) return;
    loadOlder.disabled = true;
    void action(renderOlder, true).finally(() => { loadOlder.disabled = false; });
  });
  renderProjects();
  renderOpen();
  // The sidecar starts on its first request: open rows are stored, so only ids saved by an earlier version need the list now.
  if (legacyOpen) void action(renderHistory, true);
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void action(renderHistory, true);
  }).observe(graphsPanel);
  /** The composer, from New graph or a planning toast. */
  function showComposer() {
    // Queued before the pane's first poll, so that poll already sees the composer.
    void action(async () => {
      await request("compose");
      await refresh();
      panel.scrollTop = 0;
      project.focus();
    });
    setMode(true);
  }
  newRun.addEventListener("click", showComposer);
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
  objective.addEventListener("keydown", event => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    form.requestSubmit();
  });
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
    if (!chosen) return;
    guard(approve, async () => {
      const { id } = await request("approve", { draft: chosen.id, hash: chosen.hash });
      keepOpen({ id, objective: chosen.objective, source: chosen.source });
      objective.value = "";
      updateComposer();
      await refreshHistory();
    });
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
  document.getElementById("graph-cancel-edit").addEventListener("click", () => {
    closeEditor();
    focusEdit();
  });
  editor.addEventListener("submit", event => {
    event.preventDefault();
    if (!editingDraft || editorFields.disabled || editorStale) return;
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
      focusEdit();
    });
  });
  discard.addEventListener("click", () => {
    if (!hold(discard)) return;
    void (async () => {
      try {
        const confirmed = await window.kostompConfirmDelete("Discard the proposed plan?",
          "This deletes the draft and its Planner log. Your source repository is not changed. This cannot be undone.");
        if (confirmed) await action(async () => { await request("discard"); await refresh(); });
      } finally {
        release(discard);
      }
    })();
  });
  cancel.addEventListener("click", () => guardRun(cancel, async () => {
    await request("cancel");
    await refresh();
  }));
  /** Show run `id` in the pane and keep its sidebar row. A run that no longer exists loses its row. */
  function showRun(id) {
    keepOpen(knownRow(id));
    void action(async () => {
      try {
        await request("open", id);
      } catch (error) {
        if (error?.message === "Unknown Graph run") dropOpen(id);
        throw error;
      }
      await refresh();
      rememberShown(id);
      panel.scrollTop = 0;
    });
    setMode(true);
  }
  function openFromList(event) {
    const id = event.target.closest("button[data-run]")?.dataset.run;
    if (id) showRun(id);
  }
  history.addEventListener("click", openFromList);
  openList.addEventListener("click", event => {
    const id = event.target.closest("button[data-close]")?.dataset.close;
    if (id) closeRun(id);
    else openFromList(event);
  });
  // A Graph toast was clicked (app.js opens chat toasts): show that run, or the composer for a plan.
  listen("notify-activate", event => {
    const sid = event.payload;
    if (typeof sid !== "string" || !sid.startsWith("graph:")) return;
    // The pane lives in the chat view, and Stats or Settings may be in front.
    if (chat.hidden) document.getElementById("tab-chat").click();
    if (sid === "graph:plan") showComposer();
    else showRun(sid.slice("graph:".length));
  });
  openActive.addEventListener("click", () => {
    const id = latestSnapshot?.activeRun;
    if (!id) return;
    guard(openActive, async () => {
      await request("open", id);
      keepOpen(knownRow(id));
      await refreshHistory();
      rememberShown(id);
      panel.scrollTop = 0;
    });
  });
  resume.addEventListener("click", () => guardRun(resume, async () => {
    await request("resume");
    await refresh();
  }));
  showPatch.addEventListener("click", () => guardRun(showPatch, async () => {
    const artifact = await request("patch");
    base.textContent = `Base ${artifact.baseSha}`;
    output.value = artifact.patch;
    patchView.hidden = false;
    patchView.open = true;
    output.focus();
  }));
  let copyReset;
  copyPatch.addEventListener("click", () => {
    const done = ok => {
      copyPatch.textContent = ok ? "Copied" : "Copy failed";
      clearTimeout(copyReset);
      copyReset = setTimeout(() => { copyPatch.textContent = "Copy patch"; }, 1200);
    };
    const copying = output.value ? navigator.clipboard?.writeText(output.value) : null;
    if (copying) copying.then(() => done(true), () => done(false));
    else done(false);
  });
})();
