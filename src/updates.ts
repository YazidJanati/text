import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";

export function setupUpdates(options: {
  desktop: boolean;
  button: HTMLButtonElement;
  run: (task: () => Promise<void>) => Promise<void>;
  save: () => Promise<boolean>;
}) {
  if (!options.desktop) return;
  options.button.hidden = false;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "update-title");
  dialog.innerHTML = `<h2 id="update-title">App updates</h2><p id="update-status" role="status" aria-live="polite"></p><pre id="update-notes"></pre><div class="dialog-actions"><button id="update-close">Close</button><button id="update-install" hidden>Update and restart</button></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector<HTMLElement>("#update-status")!;
  const notes = dialog.querySelector<HTMLElement>("#update-notes")!;
  const install = dialog.querySelector<HTMLButtonElement>("#update-install")!;
  const close = dialog.querySelector<HTMLButtonElement>("#update-close")!;
  let update: Update | null = null;
  let pending = false;
  let installed = false;
  close.onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    void update?.close().catch(() => {});
    update = null;
  });
  options.button.onclick = () => {
    if (pending || dialog.open) return;
    void options.run(async () => {
      if (document.querySelector("dialog[open]")) return;
      dialog.showModal();
      pending = true;
      close.disabled = true;
      install.hidden = true;
      notes.textContent = "";
      status.textContent = "Checking for updates…";
      try {
        update = await check({ timeout: 30000 });
        status.textContent = update ? `Version ${update.version} is available (installed: ${update.currentVersion}).` : "You’re up to date.";
        notes.textContent = update?.body || "";
        installed = false;
        install.textContent = "Update and restart";
        install.hidden = !update;
      } catch (error) {
        status.textContent = `Couldn’t check for updates. Try again later. ${String(error)}`;
      } finally {
        pending = false;
        close.disabled = false;
      }
    });
  };
  install.onclick = () => {
    if (pending || !update) return;
    void options.run(async () => {
      pending = true;
      install.disabled = close.disabled = true;
      try {
        // Block editing during download and flush before installers can exit (Windows).
        if (!(await options.save())) {
          status.textContent = "Couldn’t save your note. Close this dialog and resolve the save error before updating.";
          return;
        }
        if (!installed) {
          status.textContent = "Downloading update…";
          let downloaded = 0;
          let total: number | undefined;
          await update!.downloadAndInstall((event) => {
            if (event.event === "Started") total = event.data.contentLength;
            if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              status.textContent = total ? `Downloading update… ${Math.min(100, Math.round(downloaded / total * 100))}%` : `Downloading update… ${Math.round(downloaded / 1024)} KB`;
            }
            if (event.event === "Finished") status.textContent = "Installing update…";
          });
          installed = true;
        }
        status.textContent = "Restarting…";
        await invoke("restart_after_update");
      } catch (error) {
        status.textContent = `${installed ? "Update installed; restart the app to finish." : "Couldn’t install the update."} ${String(error)}`;
        if (installed) install.textContent = "Restart app";
      } finally {
        pending = false;
        install.disabled = close.disabled = false;
      }
    });
  };
}
