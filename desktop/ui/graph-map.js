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

  function textElement(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function createFlowMap(section, { showLog, retry }) {
    const scroll = section.querySelector(".graph-flow-scroll");
    const canvas = section.querySelector(".graph-flow-canvas");
    const stages = section.querySelector(".graph-flow-stages");
    const wires = section.querySelector(".graph-flow-wires g");
    const count = section.querySelector("#graph-flow-count");
    const details = section.querySelector("#graph-step-details");
    const logButton = section.querySelector("#graph-step-log");
    const retryButton = section.querySelector("#graph-step-retry");
    const items = new Map();
    const routes = [];
    let runId;
    let snapshot;
    let selected;
    let updateKey;

    function drawWires() {
      if (!canvas.clientWidth) return;
      const origin = canvas.getBoundingClientRect();
      const railTop = stages.getBoundingClientRect().bottom - origin.top;
      const boxes = new Map([...items].map(([id, item]) => [id, item.button.getBoundingClientRect()]));
      const paths = routes.map(({ from, to, lane }) => {
        const start = boxes.get(from);
        const end = boxes.get(to);
        const x1 = start.right - origin.left + 1;
        const y1 = start.top + start.height / 2 - origin.top;
        const x2 = end.left - origin.left - 1;
        const y2 = end.top + end.height / 2 - origin.top;
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

    const resize = new ResizeObserver(drawWires);
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
        for (const id of node.dependsOn) {
          const parent = items.get(id);
          depth = Math.max(depth, parent.depth + 1);
          for (const ancestor of parent.ancestors) ancestors.add(ancestor);
        }
        const parents = node.dependsOn.filter(id => !ancestors.has(id));
        for (const id of node.dependsOn) ancestors.add(id);
        for (const from of parents) {
          let lane;
          if (depth - items.get(from).depth > 1) {
            if (!lanes.has(from)) lanes.set(from, lanes.size);
            lane = lanes.get(from);
          }
          routes.push({ from, to: node.id, lane });
        }
        const [role, defaultTitle] = roles[node.role];
        const task = tasks.get(node.id);
        const title = task?.title ?? defaultTitle;
        const files = task?.files ?? (node.role === "coder" && !run.context?.tasks ? run.context?.files : undefined);
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
        items.set(node.id, { node, role, title, files, button, phase, attempt, depth, parents, ancestors });
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
      scroll.scrollLeft = 0;
      scroll.scrollTop = 0;
    }

    function phaseFor(node) {
      const state = snapshot.run.nodes[node.id];
      const release = node.role === "gate" && state.status === "succeeded" && snapshot.status;
      return phases[release || state.status];
    }

    function renderDetails() {
      const { node, role, title, files, parents, button } = items.get(selected);
      const state = snapshot.run.nodes[selected];
      const [phase, tone] = phaseFor(node);
      const roleLabel = textElement("span", role, "graph-flow-role");
      const heading = textElement("h3", title);
      heading.id = "graph-step-title";
      const meta = document.createElement("div");
      meta.className = "graph-flow-node-meta";
      meta.dataset.tone = tone;
      meta.append(
        textElement("span", phase, "graph-flow-status"),
        textElement("span", state.attempt ? `Attempt ${state.attempt}` : "No attempts yet", "graph-flow-attempt"),
      );
      const fields = document.createElement("dl");
      function appendField(label, values, tag = "span") {
        if (!values?.length) return;
        const list = document.createElement("dd");
        for (const value of values) list.append(textElement(tag, value));
        fields.append(textElement("dt", label), list);
      }
      appendField("Follows", parents.map(id => items.get(id).title));
      appendField("Owned files", files, "code");
      const reason = node.role === "gate" && state.status === "succeeded" && snapshot.reason;
      const message = state.error || reason;
      details.replaceChildren(roleLabel, heading, meta);
      if (message) details.append(textElement("p", message, "graph-flow-message"));
      if (fields.childElementCount) details.append(fields);
      logButton.hidden = !snapshot.logs?.includes(selected);
      retryButton.hidden = !snapshot.retryable?.includes(selected);
      if (retryButton.hidden && document.activeElement === retryButton) button.focus();
      if (logButton.hidden && document.activeElement === logButton) button.focus();
    }

    function select(id) {
      items.get(selected)?.button.setAttribute("aria-pressed", "false");
      selected = id;
      items.get(selected).button.setAttribute("aria-pressed", "true");
    }

    stages.addEventListener("click", event => {
      const id = event.target.closest("button[data-node]")?.dataset.node;
      if (!id || id === selected) return;
      select(id);
      renderDetails();
      drawWires();
    });
    logButton.addEventListener("click", () => showLog(selected));
    retryButton.addEventListener("click", () => retry(runId, selected));

    return {
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
          build(run);
          const initial = (next.status && run.plan.nodes.find(node => node.role === "gate")) ||
            run.plan.nodes.find(node => ["failed", "interrupted", "running"].includes(run.nodes[node.id].status)) ||
            run.plan.nodes[0];
          select(initial.id);
        }
        const key = JSON.stringify([run.sequence, next.status, next.reason, next.logs, next.retryable]);
        if (key === updateKey) return;
        updateKey = key;
        for (const [id, { node, button, phase, attempt }] of items) {
          const [label, tone] = phaseFor(node);
          const number = run.nodes[id].attempt;
          button.dataset.tone = tone;
          phase.textContent = label;
          attempt.textContent = number ? `#${number}` : "";
        }
        renderDetails();
        drawWires();
        if (newRun) {
          const viewport = scroll.getBoundingClientRect();
          const node = items.get(selected).button.getBoundingClientRect();
          scroll.scrollLeft = Math.max(0, node.right - viewport.left - scroll.clientWidth + 10);
          scroll.scrollTop = Math.max(0, node.bottom - viewport.top - scroll.clientHeight + 10);
        }
      },
    };
  }

  window.KostompGraphMap = createFlowMap;
})();
