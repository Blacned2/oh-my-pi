// Overflow menu: when a row of buttons no longer fits, one trigger stands in for them and opens a
// body-level glass popover listing them. Each row clicks the real (hidden) button, so every listener
// on it and its ancestors (capture-phase navigation in graph.js/design.js included) runs unchanged.
(() => {
  /**
   * @param {HTMLButtonElement} trigger shown instead of the buttons while they do not fit
   * @param {HTMLElement} menu the popover (`.tb-pop.glass.ovf-menu`, hidden)
   * @param {() => {button: HTMLButtonElement, label: string, icon?: SVGElement}[]} items read on every open; `icon` defaults to the button's
   */
  window.kostompOverflowMenu = (trigger, menu, items, align) => {
    const rows = () => [...menu.querySelectorAll(".ovf-item")];

    function paint() {
      menu.replaceChildren();
      for (const { button, label, icon: iconSource } of items()) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ovf-item";
        row.setAttribute("role", "menuitem");
        // Mirror the current-page / active-panel state the hidden button would have shown.
        row.classList.toggle("on", button.getAttribute("aria-current") === "page" || button.classList.contains("active"));
        const icon = (iconSource ?? button.querySelector("svg"))?.cloneNode(true);
        const text = document.createElement("span");
        text.textContent = label;
        if (icon) row.append(icon);
        row.append(text);
        row.addEventListener("click", () => {
          toggle(false, false);
          button.click();
        });
        menu.append(row);
      }
    }

    function place() {
      const r = trigger.getBoundingClientRect();
      menu.style.top = r.bottom + 8 + "px";
      if (align === "left") {
        menu.style.left = Math.max(12, r.left) + "px";
        menu.style.minWidth = r.width + "px";
      } else {
        menu.style.right = Math.max(12, innerWidth - r.right) + "px";
      }
    }

    function toggle(open = menu.hidden, refocus = true) {
      if (open === !menu.hidden) return;
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
      if (open) {
        paint();
        place();
        rows()[0]?.focus();
      } else if (refocus) trigger.focus();
    }

    trigger.addEventListener("click", () => toggle());
    document.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !trigger.contains(e.target) && !menu.contains(e.target)) toggle(false, false);
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); toggle(false); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = rows();
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    });
    addEventListener("resize", () => toggle(false, false));

    return { close: () => toggle(false, false) };
  };
})();
