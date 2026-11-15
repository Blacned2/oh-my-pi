(() => {
  const roles = {
    planner: ["Planner", "Plan work"],
    context: ["Context Manager", "Prepare context"],
    coder: ["Coder", "Implement changes"],
    tester: ["Tester", "Run tests"],
    reviewer: ["Reviewer", "Review changes"],
    gate: ["Decision Gate", "Release decision"],
  };
  const phases = {
    queued: ["Queued", "idle"],
    running: ["Running", "active"],
    succeeded: ["Completed", "done"],
    failed: ["Failed", "error"],
    interrupted: ["Interrupted", "warning"],
    cancelled: ["Cancelled", "idle"],
    ready_to_export: ["Patch ready", "done"],
    needs_input: ["Needs input", "warning"],
    stale_base: ["Base changed", "warning"],
  };
  const minZoom = 0.1;
  const maxZoom = 2;
  const zoomStep = 1.2;

  function textElement(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  /** `m:ss`, or `h:mm:ss` from an hour on. */
  function duration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const pad = value => String(value).padStart(2, "0");
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
  }

  /** The latest attempt's run time, when the sidecar recorded when it started. */
  function timingText(state) {
    if (!state.startedAt) return "";
    if (state.status === "running") return `Running ${duration(Date.now() - state.startedAt)}`;
    return state.endedAt >= state.startedAt ? `Took ${duration(state.endedAt - state.startedAt)}` : "";
  }

  function createFlowMap(section, { retry, onSelect }) {
    const scroll = section.querySelector(".graph-flow-scroll");
    const canvas = section.querySelector(".graph-flow-canvas");
    const stages = section.querySelector(".graph-flow-stages");
    const wires = section.querySelector(".graph-flow-wires g");
    const count = section.querySelector("#graph-flow-count");
    const zoomOut = section.querySelector("#graph-flow-zoom-out");
    const zoomLevel = section.querySelector("#graph-flow-zoom-level");
    const zoomIn = section.querySelector("#graph-flow-zoom-in");
    const fitButton = section.querySelector("#graph-flow-fit");
    const inspector = section.querySelector("#graph-inspector");
    const inspectorToggle = section.querySelector("#graph-inspector-toggle");
    const inspectorClose = section.querySelector("#graph-inspector-close");
    const details = section.querySelector("#graph-step-details");
    let picked = false;
    /** Whether the inspector was opened by choosing a node, so closing it returns focus there. */
    let openedFromNode = false;
    /** The last inspector toggle resized the map; the next resize keeps the zoom instead of refitting. */
    let inspectorResize = false;
    let timing;
    const retryButton = section.querySelector("#graph-step-retry");
    const items = new Map();
    const routes = [];
    let runId;
    let snapshot;
    let selected;
    let updateKey;
    let zoom = 1;
    let fitted = true;
    let panX = 0;
    let panY = 0;
    let drag;
    let suppressClick = false;

    function positionCanvas() {
      canvas.style.translate = `${panX / zoom}px ${panY / zoom}px`;
    }

    scroll.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY, moved: false };
    });
    window.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        fitted = false;
        scroll.setPointerCapture(event.pointerId);
        scroll.classList.add("is-panning");
      }
      panX = drag.panX + dx;
      panY = drag.panY + dy;
      positionCanvas();
      event.preventDefault();
    });
    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      suppressClick = drag.moved;
      drag = undefined;
      scroll.classList.remove("is-panning");
      if (scroll.hasPointerCapture(event.pointerId)) scroll.releasePointerCapture(event.pointerId);
    }
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    scroll.addEventListener("lostpointercapture", endDrag);
    scroll.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    function setZoom(scale) {
      if (scale === zoom) return;
      zoom = scale;
      canvas.style.zoom = String(zoom);
      positionCanvas();
      zoomLevel.value = `${Math.round(zoom * 100)}%`;
      zoomOut.disabled = zoom <= minZoom;
      zoomIn.disabled = zoom >= maxZoom;
    }

    function fitDiagram() {
      if (!scroll.clientWidth || !scroll.clientHeight || !canvas.offsetWidth || !canvas.offsetHeight) return;
      panX = 0;
      panY = 0;
      positionCanvas();
      const scale = Math.min(1, scroll.clientWidth / canvas.offsetWidth, scroll.clientHeight / canvas.offsetHeight);
      setZoom(Math.max(0.01, Math.floor(scale * 100) / 100));
      scroll.scrollTo(0, 0);
    }

    function fit() {
      fitted = true;
      fitDiagram();
    }

    /** Zoom keeping the diagram point under (clientX, clientY) in place; the measured shift goes into the pan. */
    function zoomAt(factor, clientX, clientY) {
      fitted = false;
      const scale = Math.min(maxZoom, Math.max(minZoom, zoom * factor));
      if (scale === zoom) return;
      const ratio = scale / zoom;
      const before = canvas.getBoundingClientRect();
      setZoom(scale);
      const after = canvas.getBoundingClientRect();
      panX += clientX - after.left - (clientX - before.left) * ratio;
      panY += clientY - after.top - (clientY - before.top) * ratio;
      positionCanvas();
    }

    function zoomCentre(factor) {
      const view = scroll.getBoundingClientRect();
      zoomAt(factor, view.left + view.width / 2, view.top + view.height / 2);
    }

    zoomOut.addEventListener("click", () => zoomCentre(1 / zoomStep));
    zoomIn.addEventListener("click", () => zoomCentre(zoomStep));
    fitButton.addEventListener("click", fit);
    scroll.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 33 : event.deltaY;
      zoomAt(zoomStep ** (-delta / 100), event.clientX, event.clientY);
    }, { passive: false });
    scroll.addEventListener("keydown", event => {
      if (event.target !== scroll || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") zoomCentre(zoomStep);
      else if (event.key === "-") zoomCentre(1 / zoomStep);
      else if (event.key === "0") fit();
      else return;
      event.preventDefault();
    });

    /** Pan just enough to bring the selected node fully into the visible map. */
    function revealSelected() {
      const button = items.get(selected)?.button;
      if (!button || !scroll.clientWidth) return;
      const view = scroll.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      const margin = 12;
      const shift = (start, end, low, high) =>
        start < low + margin ? low + margin - start : end > high - margin ? Math.max(high - margin - end, low + margin - start) : 0;
      const dx = shift(box.left, box.right, view.left, view.left + scroll.clientWidth);
      const dy = shift(box.top, box.bottom, view.top, view.top + scroll.clientHeight);
      if (!dx && !dy) return;
      panX += dx;
      panY += dy;
      positionCanvas();
    }

    function drawWires() {
      if (!canvas.clientWidth) return;
      const origin = canvas.getBoundingClientRect();
      // The SVG uses canvas units while the measured button boxes include zoom.
      const railTop = (stages.getBoundingClientRect().bottom - origin.top) / zoom;
      const boxes = new Map([...items].map(([id, item]) => [id, item.button.getBoundingClientRect()]));
      const paths = routes.map(({ from, to, lane }) => {
        const start = boxes.get(from);
        const end = boxes.get(to);
        const x1 = (start.right - origin.left) / zoom + 1;
        const y1 = (start.top + start.height / 2 - origin.top) / zoom;
        const x2 = (end.left - origin.left) / zoom - 1;
        const y2 = (end.top + end.height / 2 - origin.top) / zoom;
        const middle = (x1 + x2) / 2;
        const rail = railTop + 11 + (lane ?? 0) * 8;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", lane === undefined
          ? `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`
          : `M ${x1} ${y1} H ${x1 + 7} V ${rail} H ${x2 - 8} V ${y2} H ${x2}`);
        path.classList.toggle("graph-flow-wire-selected", from === selected || to === selected);
        return path;
      });
      wires.replaceChildren(...paths);
    }

    const resize = new ResizeObserver(() => requestAnimationFrame(() => {
      if (inspectorResize) {
        inspectorResize = false;
        revealSelected();
      } else if (fitted) fitDiagram();
      drawWires();
    }));
    resize.observe(scroll);
    resize.observe(canvas);

    function build(run) {
      items.clear();
      routes.length = 0;
      const columns = [];
      const lanes = new Map();
      const tasks = new Map((run.context?.tasks ?? []).map(task => [`code-${task.id}`, task]));
      // The sidecar sends prerequisites first. If one is already an ancestor of
      // another prerequisite, its extra artifact edge adds no step ordering.
      for (const node of run.plan.nodes) {
        const ancestors = new Set();
        let depth = 0;
        // A dependency missing from the drawn steps gets no edge rather than breaking the whole map.
        const known = node.dependsOn.filter(id => items.has(id));
        for (const id of known) {
          const parent = items.get(id);
          depth = Math.max(depth, parent.depth + 1);
          for (const ancestor of parent.ancestors) ancestors.add(ancestor);
        }
        const parents = known.filter(id => !ancestors.has(id));
        for (const id of known) ancestors.add(id);
        for (const from of parents) {
          let lane;
          if (depth - items.get(from).depth > 1) {
            if (!lanes.has(from)) lanes.set(from, lanes.size);
            lane = lanes.get(from);
          }
          routes.push({ from, to: node.id, lane });
        }
        const [role, defaultTitle] = roles[node.role] ?? [node.role, node.id];
        const task = tasks.get(node.id);
        const title = task?.title ?? defaultTitle;
        const files = task?.files ?? (node.role === "coder" && !run.context?.tasks ? run.context?.files : undefined);
        const brief = task?.brief;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "graph-flow-node";
        button.dataset.node = node.id;
        button.setAttribute("aria-pressed", "false");
        const label = textElement("strong", title, "graph-flow-node-title");
        label.title = title;
        const phase = textElement("span", "", "graph-flow-status");
        const attempt = textElement("span", "", "graph-flow-attempt");
        const footer = document.createElement("span");
        footer.className = "graph-flow-node-meta";
        footer.append(phase, attempt);
        button.append(textElement("span", role, "graph-flow-role"), label, footer);
        items.set(node.id, { node, role, title, files, brief, button, phase, attempt, depth, parents, ancestors });
        if (!columns[depth]) {
          const column = document.createElement("div");
          column.className = "graph-flow-stage";
          columns[depth] = column;
        }
        columns[depth].append(button);
      }
      canvas.style.setProperty("--graph-stages", columns.length);
      canvas.style.setProperty("--graph-flow-rail-space", `${lanes.size * 8}px`);
      stages.replaceChildren(...columns);
      count.textContent = `${items.size} ${items.size === 1 ? "step" : "steps"}`;
    }

    function stateOf(id) {
      return snapshot.run.nodes[id] ?? { status: "queued", attempt: 0, usedAttempts: 0 };
    }

    function phaseFor(node) {
      const state = stateOf(node.id);
      const release = node.role === "gate" && state.status === "succeeded" && snapshot.status;
      return phases[release || state.status] ?? [String(state.status), "idle"];
    }

    function updateTiming() {
      if (!timing || !selected) return;
      const text = timingText(stateOf(selected));
      if (timing.textContent !== text) timing.textContent = text;
    }

    function renderDetails() {
      const { node, role, title, files, brief, parents, button } = items.get(selected);
      const state = stateOf(selected);
      const [phase, tone] = phaseFor(node);
      const roleLabel = textElement("span", role, "graph-flow-role");
      const heading = textElement("h3", title);
      heading.id = "graph-step-title";
      const meta = document.createElement("div");
      meta.className = "graph-flow-node-meta";
      meta.dataset.tone = tone;
      const used = state.usedAttempts
        ? `Attempt ${state.usedAttempts}${node.maxAttempts ? ` of ${node.maxAttempts}` : ""}`
        : "No attempts yet";
      timing = textElement("span", timingText(state), "graph-flow-attempt");
      meta.append(textElement("span", phase, "graph-flow-status"), textElement("span", used, "graph-flow-attempt"), timing);
      const fields = document.createElement("dl");
      function appendField(label, values, tag = "span", className) {
        if (!values?.length) return;
        const list = document.createElement("dd");
        for (const value of values) list.append(textElement(tag, value, className));
        fields.append(textElement("dt", label), list);
      }
      appendField("Follows", parents.map(id => items.get(id).title));
      appendField("Owned files", files, "code");
      appendField("Task brief", brief && [brief], "div", "graph-flow-brief");
      const reason = node.role === "gate" && state.status === "succeeded" && snapshot.reason;
      const message = state.error || reason;
      details.replaceChildren(roleLabel, heading, meta);
      if (message) details.append(textElement("p", message, "graph-flow-message"));
      if (fields.childElementCount) details.append(fields);
      retryButton.hidden = !snapshot.retryable?.includes(selected);
      if (retryButton.hidden && document.activeElement === retryButton) button.focus();
    }

    function select(id) {
      items.get(selected)?.button.setAttribute("aria-pressed", "false");
      selected = id;
      items.get(selected).button.setAttribute("aria-pressed", "true");
    }

    function showInspector(open) {
      if (open === !inspector.hidden) return;
      const width = scroll.clientWidth;
      const height = scroll.clientHeight;
      inspector.hidden = !open;
      inspectorToggle.setAttribute("aria-expanded", String(open));
      // In the narrow layout the inspector overlays the map, so the map keeps its size.
      inspectorResize = scroll.clientWidth !== width || scroll.clientHeight !== height;
    }

    function closeInspector() {
      showInspector(false);
      ((openedFromNode && items.get(selected)?.button) || inspectorToggle).focus();
    }

    inspectorToggle.addEventListener("click", () => {
      if (inspector.hidden) openedFromNode = false;
      showInspector(inspector.hidden);
    });
    inspectorClose.addEventListener("click", closeInspector);
    inspector.addEventListener("keydown", event => {
      if (event.key === "Escape") closeInspector();
    });

    stages.addEventListener("click", event => {
      const id = event.target.closest("button[data-node]")?.dataset.node;
      if (!id) return;
      const opening = inspector.hidden;
      if (opening) openedFromNode = true;
      showInspector(true);
      picked = true;
      if (id !== selected) {
        select(id);
        onSelect();
        renderDetails();
        drawWires();
      }
      if (opening) inspectorClose.focus({ preventScroll: true });
    });
    // Disabled until the queued retry settles, so a double click cannot queue it twice.
    retryButton.addEventListener("click", () => {
      if (retryButton.disabled) return;
      retryButton.disabled = true;
      void Promise.resolve(retry(runId, selected)).finally(() => { retryButton.disabled = false; });
    });

    return {
      selected: () => selected,
      titleOf: id => items.get(id)?.title,
      render(next) {
        const run = next?.run;
        section.hidden = !run;
        snapshot = next;
        if (!run) {
          runId = undefined;
          return;
        }
        const newRun = runId !== run.id;
        if (newRun) {
          runId = run.id;
          updateKey = undefined;
          picked = false;
          fitted = true;
          build(run);
          const initial = (next.status && run.plan.nodes.find(node => node.role === "gate")) ||
            run.plan.nodes.find(node => ["failed", "interrupted", "running"].includes(run.nodes[node.id]?.status)) ||
            run.plan.nodes[0];
          select(initial.id);
        }
        // A step the user has not chosen follows whichever step is working.
        if (!picked) {
          const live = run.plan.nodes.find(node => run.nodes[node.id]?.status === "running");
          if (live && live.id !== selected) select(live.id);
        }
        const key = JSON.stringify([run.sequence, next.status, next.reason, next.logs, next.retryable, selected]);
        if (key !== updateKey) {
          updateKey = key;
          for (const [id, { node, button, phase, attempt }] of items) {
            const [label, tone] = phaseFor(node);
            const number = stateOf(id).attempt;
            button.dataset.tone = tone;
            phase.textContent = label;
            attempt.textContent = number ? `#${number}` : "";
          }
          renderDetails();
          if (newRun) fitDiagram();
          drawWires();
        }
        updateTiming();
      },
    };
  }

  window.KostompGraphMap = createFlowMap;
})();
