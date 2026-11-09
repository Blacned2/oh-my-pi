// Checks for an app update at start and offers it in the top bar. Only the Kostomp shell is
// replaced; the bundled omp/stats stay as installed (see src/updater.rs).
(() => {
  const { invoke } = window.__TAURI__.core;
  const button = document.getElementById("update");

  async function check() {
    try {
      const info = await invoke("update_check");
      if (!info) return;
      button.textContent = `update ${info.version}`;
      button.title = (info.notes ? info.notes + "\n\n" : "") + "Click to install and restart";
      button.hidden = false;
    } catch (e) {
      // Offline or no update server configured: stay quiet, the app works without it.
      console.warn("update check failed:", e);
    }
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "updating…";
    try {
      await invoke("update_install"); // the installer closes the app
    } catch (e) {
      button.disabled = false;
      button.textContent = "update failed";
      button.title = String(e);
    }
  });

  check();
})();
