// Checks for an app update at start and offers it in the titlebar's Kostomp menu. Only the Kostomp shell is
// replaced; the bundled omp/stats stay as installed (see src/updater.rs).
(() => {
  const { invoke } = window.__TAURI__.core;
  const button = document.getElementById("update");
  const trigger = document.getElementById("app-btn");
  const menu = document.getElementById("app-menu");
  const dot = document.getElementById("app-dot");
  const version = document.getElementById("app-version");

  const setOpen = (open) => {
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) button.hidden ? trigger.focus() : button.focus();
  };
  trigger.addEventListener("click", () => setOpen(menu.hidden));
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !trigger.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { setOpen(false); trigger.focus(); }
  });

  version.textContent = "Up to date";

  async function check() {
    try {
      const info = await invoke("update_check");
      if (!info) return;
      version.textContent = `Update available · ${info.version}`;
      button.textContent = `Update to ${info.version} and restart`;
      button.title = info.notes || "";
      button.hidden = false;
      dot.hidden = false;
    } catch (e) {
      // Offline or no update server configured: stay quiet, the app works without it.
      console.warn("update check failed:", e);
    }
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Updating…";
    try {
      await invoke("update_install"); // the installer closes the app
    } catch (e) {
      button.disabled = false;
      button.textContent = "Update failed";
      button.title = String(e);
    }
  });

  check();
})();
