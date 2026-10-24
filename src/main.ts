import { setupLatexNotation } from "./latex-notation";
import { setMathDefinitions } from "./math";
import { setupUpdates } from "./updates";
import { Vim, toggleVim, observeVim, vimEnabled } from "./vim";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { createEditor, makeState, setEditorFontSize } from "./editor";
import { desktop, storage } from "./storage";
import { icon } from "./icons";
import type { DocumentFile, Workspace, Entry } from "./types";

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const tool = (id: string, glyph: string, label: string, shortcut = "") =>
  `<button id="${id}" class="icon-button" aria-label="${label}" title="${label}${shortcut ? ` (${shortcut})` : ""}">${icon(glyph)}</button>`;
const shortcutGroup = (title: string, rows: [string, string][]) =>
  `<section><h3>${title}</h3><table><tbody>${rows.map(([label, keys]) =>
    `<tr><th scope="row">${label}</th><td><kbd>${keys}</kbd></td></tr>`).join("")}</tbody></table></section>`;
const shortcuts = [
  shortcutGroup("Notes", [
    ["New note", mod + "N"], ["New folder", mod + "Shift+N"],
    ["Save", mod + "S"], ["Close note", mod === "⌘" ? "⌘W / Ctrl+W" : "Ctrl+W"],
    ["Import Markdown", mod + "O"], ["Export Markdown", mod + "Shift+S"],
  ]),
  shortcutGroup("Sidebar", [
    ["Toggle sidebar", mod + "B"], ["Navigate / expand", "↑ ↓ ← →"],
    ["Rename focused item", "Enter / F2"], ["Move to trash", "Delete"],
    ["Return to editor", "Esc"],
  ]),
  shortcutGroup("Text size", [
    ["Increase", mod + "+"], ["Decrease", mod + "−"], ["Reset", mod + "0"],
  ]),
  shortcutGroup("Editing · Vim off", [
    ["Find", mod + "F"], ["Bold", mod + "Shift+B"],
    ["Italic", mod + "I"], ["Insert link", mod + "K"],
  ]),
  shortcutGroup("Vim", [
    ["Toggle Vim", mod + "Alt+V"], ["Insert / normal mode", "i / Esc"],
    ["Visual mode", "v"], ["Move", "h j k l"],
    ["Search / next match", "/ / n"], ["Undo / redo", "u / Ctrl+R"],
  ]),
].join("");
document.querySelector("#app")!.innerHTML = `
<aside id="sidebar" aria-label="Notes"><div class="sidebar-heading"><span>text</span><div>${tool("new-folder", "folderPlus", "New folder", mod + "⇧N")}${tool("new-note", "plus", "New note", mod + "N")}</div></div><nav id="files" aria-label="Files"></nav><button id="check-updates" type="button" hidden>Updates</button></aside>
<main><header>${tool("toggle-sidebar", "sidebar", "Toggle sidebar", mod + "B")}<button id="document-name" title="Rename (F2)"></button><span id="dirty" hidden aria-label="Unsaved changes"></span><span id="vim-mode" role="status" aria-label="Vim mode"></span><button id="vim-toggle" type="button"></button></header><div id="editor"></div></main>
<div id="notice" role="alert" hidden><span></span><button aria-label="Dismiss">×</button></div>
<dialog id="shortcuts-dialog" aria-labelledby="shortcuts-title"><div class="shortcuts-heading"><h2 id="shortcuts-title">Keyboard shortcuts</h2><button id="open-latex-notation" type="button" hidden>LaTeX notation…</button><button id="close-shortcuts" class="icon-button" aria-label="Close shortcuts">×</button></div><div class="shortcut-groups">${shortcuts}</div><p class="shortcut-commands"><code>:w</code> save · <code>:q</code> quit · <code>:wq</code> save &amp; quit<br><code>:new Name</code> new note · <code>:mkdir Name</code> new folder</p><p class="shortcut-footnote">Drag items onto a folder to move them; drop into empty sidebar space for the top level.<br>F1 opens this reference · Esc closes it.</p></dialog>
<dialog id="info-dialog" aria-labelledby="info-title"><div class="shortcuts-heading"><h2 id="info-title">Get Info</h2><button id="close-info" class="icon-button" aria-label="Close info">×</button></div><p id="info-name"></p><dl id="info-details"></dl></dialog>
<dialog id="name-dialog"><form><label id="name-label" for="name-input"></label><input id="name-input" autocomplete="off" maxlength="120" required><div class="dialog-actions"><button type="button" id="name-cancel">Cancel</button><button type="submit" id="name-submit">Create</button></div></form></dialog>
<dialog id="unsaved"><form><p>Couldn’t save this note.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button value="discard">Discard</button><button value="export">Export copy</button></div></form></dialog>
<dialog id="password-dialog"><form><h2 id="password-heading"></h2><label for="password-input">Password</label><input id="password-input" type="password" maxlength="1024" required><div id="password-confirm-row"><label for="password-confirm">Confirm password</label><input id="password-confirm" type="password" maxlength="1024" autocomplete="new-password"></div><p id="password-hint">No recovery if forgotten.</p><p id="password-error" role="alert" hidden></p><div class="dialog-actions"><button id="password-cancel" type="button">Cancel</button><button id="password-submit" type="submit"></button></div></form></dialog>
<dialog id="export-warning"><form><p>Export an unencrypted Markdown copy?</p><div class="dialog-actions"><button value="cancel">Cancel</button><button value="export">Export</button></div></form></dialog>
<div id="context-menu" popover="auto"><button id="rename">Rename</button><button id="get-info">Get Info</button><button id="set-password">Set password</button><button id="remove-password">Remove password</button><button id="move-private">Move to Private</button><button id="trash">Move to trash</button></div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let workspace: Workspace | null = null,
  path: string | null = null,
  selectedFolder: string | null = null;
let savedContent = "",
  diskContent = "",
  eol = "\n",
  busy = false,
  ready = false,
  currentProtected = false,
  sidebarHidden = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined,
  savePromise: Promise<boolean> | null = null;
let context: Entry | null = null;
const expanded = new Set<string>();
const treeEntries = new Map<string, Entry>();
let treeFocusedPath: string | null = null;
let draggedEntry: Entry | null = null;
let privatePath: string | null = null, privateConfigured = false, privateUnlocked = false;
let privateConcealed = false, privateAuthenticating = false, privateEpoch = 0;
let lastPrivateNote: string | null = null;
let privateDraft: { path: string; content: string; expected: string; saved: string } | null = null;
let privateLockPromise: Promise<void> | null = null;
let actionDone: Promise<void> | null = null;
let cancelPasswordDialog: (() => void) | null = null;
const isPrivate = (candidate: string | null) => !!privatePath && within(candidate, privatePath);
const editor = createEditor($("editor"), "", changed);
const showLatexNotation = setupLatexNotation({
  storage,
  apply: applyMathDefinitions,
  focusEditor: () => editor.focus(),
});
$("open-latex-notation").hidden = !desktop;
$("open-latex-notation").onclick = () => {
  $<HTMLDialogElement>("shortcuts-dialog").close();
  void showLatexNotation();
};
void document.fonts.ready.then(() => editor.requestMeasure());
function text() {
  return editor.state.doc.toString();
}
function dirty() {
  return text() !== savedContent;
}
function filename() {
  return path?.split(/[\\/]/).at(-1) || "";
}
function title() {
  return filename().replace(/\.(md|markdown|textlock)$/i, "");
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem("notes:" + key, value);
  } catch {
    /* Optional layout/session pointers only. */
  }
}
function recalled(key: string) {
  try {
    return localStorage.getItem("notes:" + key);
  } catch {
    return null;
  }
}
function notice(error: unknown) {
  $("notice").hidden = false;
  $("notice").querySelector("span")!.textContent = String(error);
}
$("notice").querySelector("button")!.onclick = () => {
  $("notice").hidden = true;
};
function updateStatus() {
  $("document-name").textContent = privateConcealed && isPrivate(path) ? "" : title();
  $("dirty").hidden = !dirty();
  document.title = isPrivate(path) ? "Private — text" : `${dirty() ? "● " : ""}${title() ? title() + " — " : ""}text`;
  $("document-name").hidden = !path;
  if (desktop)
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(document.title),
      )
      .catch(() => {});
  document.querySelectorAll<HTMLButtonElement>(".file-row").forEach((row) => {
    const selected =
      row.dataset.path === path || row.dataset.path === selectedFolder;
    row.classList.toggle("selected", selected);
    if (row.dataset.path === path) row.setAttribute("aria-current", "page");
    else row.removeAttribute("aria-current");
  });
}
function changed() {
  updateStatus();
  clearTimeout(saveTimer);
  if (ready && path && dirty()) saveTimer = setTimeout(() => void flush(), 500);
}
async function setDocument(file: DocumentFile) {
  // All routes into a public note (open, create, import, or password actions)
  // must conceal the private tree and drop its key before showing that note.
  if (!isPrivate(file.path) && privateUnlocked && !privateLockPromise)
    await lockPrivateOnLeave();
  if (currentProtected || file.protected) Vim.resetVimGlobalState_();
  clearTimeout(saveTimer);
  $("notice").hidden = true;
  path = file.path;
  currentProtected = !!file.protected;
  $("editor").hidden = false;
  editor.dom.hidden = false;
  remember("closed", "false");
  diskContent = file.content;
  eol = diskContent.includes("\r\n") ? "\r\n" : "\n";
  editor.setState(makeState(file.content, changed));
  editor.contentDOM.spellcheck = !currentProtected;
  bindVim();
  savedContent = text();
  selectedFolder = path.slice(
    0,
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")),
  );
  remember("last-note", isPrivate(path) ? "" : path);
  let ancestor = selectedFolder;
  while (
    workspace &&
    ancestor &&
    ancestor !== workspace.path &&
    ancestor.length > workspace.path.length
  ) {
    expanded.add(ancestor);
    ancestor = ancestor.slice(
      0,
      Math.max(ancestor.lastIndexOf("/"), ancestor.lastIndexOf("\\")),
    );
  }
  updateStatus();
}
function flush(): Promise<boolean> {
  clearTimeout(saveTimer);
  if (savePromise) return savePromise;
  savePromise = (async () => {
    try {
      while (dirty()) {
        if (!path) return false;
        const result = await storage.saveFile(
          path,
          text().replaceAll("\n", eol),
          diskContent,
        );
        diskContent = result.content;
        savedContent = result.content.replace(/\r\n?/g, "\n");
      }
      $("notice").hidden = true;
      return true;
    } catch (error) {
      notice(error);
      return false;
    } finally {
      updateStatus();
    }
  })().finally(() => {
    savePromise = null;
  });
  return savePromise;
}
function nameDialog(
  label: string,
  value: string,
  submitLabel: string,
): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("name-dialog"),
    form = dialog.querySelector("form")!,
    input = $<HTMLInputElement>("name-input");
  $("name-label").textContent = label;
  $("name-submit").textContent = submitLabel;
  input.value = value;
  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      form.removeEventListener("submit", submit);
      dialog.removeEventListener("cancel", cancel);
      $("name-cancel").onclick = null;
      dialog.close();
      resolve(value);
    };
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      if (input.value.trim()) finish(input.value.trim());
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      finish(null);
    };
    form.addEventListener("submit", submit);
    dialog.addEventListener("cancel", cancel);
    $("name-cancel").onclick = () => finish(null);
    dialog.showModal();
    input.focus();
    input.select();
  });
}
function passwordDialog<T>(
  setting: boolean,
  submitPassword: (password: string) => Promise<T>,
  heading?: string,
): Promise<T | null> {
  const dialog = $<HTMLDialogElement>("password-dialog"),
    form = dialog.querySelector("form")!;
  const input = $<HTMLInputElement>("password-input"),
    confirm = $<HTMLInputElement>("password-confirm");
  const submitButton = $<HTMLButtonElement>("password-submit"),
    cancelButton = $<HTMLButtonElement>("password-cancel");
  let pending = false, cancelled = false, finished = false;
  $("password-heading").textContent = heading || (setting ? "Set password" : "Unlock note");
  $("password-confirm-row").hidden = !setting;
  confirm.required = setting;
  $("password-hint").hidden = !setting;
  $("password-error").hidden = true;
  input.autocomplete = setting ? "new-password" : "current-password";
  input.value = confirm.value = "";
  submitButton.textContent = setting ? "Set password" : "Unlock";
  return new Promise((resolve) => {
    const finish = (result: T | null) => {
      if (finished) return;
      finished = true;
      cancelPasswordDialog = null;
      input.value = confirm.value = "";
      form.removeEventListener("submit", submit);
      dialog.removeEventListener("cancel", cancel);
      cancelButton.onclick = null;
      dialog.close();
      resolve(result);
    };
    cancelPasswordDialog = () => {
      cancelled = true;
      input.value = confirm.value = "";
      if (!pending) finish(null);
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      if (!pending) finish(null);
    };
    const submit = async (event: SubmitEvent) => {
      event.preventDefault();
      if (pending) return;
      if (setting && input.value !== confirm.value) {
        $("password-error").textContent = "Passwords do not match.";
        $("password-error").hidden = false;
        confirm.focus();
        return;
      }
      if (!input.value) return;
      pending = true;
      submitButton.disabled =
        cancelButton.disabled =
        input.disabled =
        confirm.disabled =
          true;
      let value = input.value;
      input.value = confirm.value = "";
      try {
        const result = await submitPassword(value);
        finish(cancelled ? null : result);
      } catch (error) {
        if (cancelled) { finish(null); return; }
        $("password-error").textContent = String(error);
        $("password-error").hidden = false;
      } finally {
        value = "";
        pending = false;
        submitButton.disabled =
          cancelButton.disabled =
          input.disabled =
          confirm.disabled =
            false;
        if (dialog.open) input.focus();
      }
    };
    form.addEventListener("submit", submit);
    dialog.addEventListener("cancel", cancel);
    cancelButton.onclick = () => {
      if (!pending) finish(null);
    };
    dialog.showModal();
    input.focus();
  });
}
async function readDocument(target: string): Promise<DocumentFile | null> {
  try {
    return await storage.readFile(target);
  } catch (error) {
    if (String(error).includes("PASSWORD_REQUIRED"))
      return passwordDialog(false, (password) =>
        storage.unlockFile(target, password),
      );
    throw error;
  }
}
function clearDocument() {
  clearTimeout(saveTimer);
  if (currentProtected) Vim.resetVimGlobalState_();
  path = null;
  currentProtected = false;
  savedContent = diskContent = "";
  editor.setState(makeState("", changed));
  editor.dom.hidden = true;
  $("editor").hidden = true;
  remember("last-note", "");
  remember("closed", "true");
  bindVim();
  updateStatus();
}
async function closeCurrent() {
  if (!path || !(await canLeave())) return;
  if (isPrivate(path) && privateUnlocked) {
    await lockPrivateOnLeave();
    return;
  }
  await storage.closeNote();
  clearDocument();
  await renderFiles();
}
async function protectEntry(entry: Entry, remove = false) {
  if (entry.directory || !(await canLeave())) return;
  if (path !== entry.path) {
    const file = await readDocument(entry.path);
    if (!file) return;
    await setDocument(file);
    await renderFiles();
  }
  const result = remove
    ? await storage.removePassword(path!)
    : await passwordDialog(true, (password) =>
        storage.setPassword(path!, password, diskContent),
      );
  if (result) {
    await setDocument(result);
    treeFocusedPath = result.path;
    await renderFiles();
  }
}
async function exportCopy() {
  if (!path) return false;
  if (currentProtected) {
    const dialog = $<HTMLDialogElement>("export-warning"),
      form = dialog.querySelector("form")!;
    const confirmed = await new Promise<boolean>((resolve) => {
      const finish = (yes: boolean) => {
        form.removeEventListener("submit", submit);
        dialog.removeEventListener("cancel", cancel);
        dialog.close();
        resolve(yes);
      };
      const submit = (event: SubmitEvent) => {
        event.preventDefault();
        finish((event.submitter as HTMLButtonElement)?.value === "export");
      };
      const cancel = (event: Event) => {
        event.preventDefault();
        finish(false);
      };
      form.addEventListener("submit", submit);
      dialog.addEventListener("cancel", cancel);
      dialog.showModal();
    });
    if (!confirmed) return false;
  }
  return storage.exportFile(
    text().replaceAll("\n", eol),
    filename().replace(/\.textlock$/i, ".md") || "Untitled.md",
  );
}
async function canLeave() {
  if (await flush()) return true;
  const dialog = $<HTMLDialogElement>("unsaved"),
    form = dialog.querySelector("form")!;
  const choice = await new Promise<string>((resolve) => {
    const finish = (value: string) => {
      form.removeEventListener("submit", submit);
      dialog.removeEventListener("cancel", cancel);
      dialog.close();
      resolve(value);
    };
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      finish((event.submitter as HTMLButtonElement)?.value || "cancel");
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      finish("cancel");
    };
    form.addEventListener("submit", submit);
    dialog.addEventListener("cancel", cancel);
    dialog.showModal();
  });
  if (choice === "export") return exportCopy();
  return choice === "discard";
}
async function action(task: () => Promise<void>, after?: () => void) {
  if (busy || privateLockPromise) return;
  busy = true;
  let complete!: () => void;
  actionDone = new Promise<void>((resolve) => { complete = resolve; });
  editor.dom.inert = true;
  try {
    await task();
  } catch (error) {
    notice(error);
  } finally {
    busy = false;
    editor.dom.inert = false;
    if (after) after();
    else if (path) editor.focus();
    else focusEntry(treeFocusedPath);
    actionDone = null;
    complete();
  }
}
function parent() {
  return selectedFolder || workspace!.path;
}
async function newNote() {
  if (!ready || !(await canLeave())) return;
  const note = await storage.createNote(parent());
  await setDocument(note);
  await renderFiles();
}
async function newFolder() {
  if (!ready) return;
  const name = await nameDialog("New folder", "", "Create");
  if (!name) return;
  const created = await storage.createFolder(parent(), name);
  expanded.add(parent());
  expanded.add(created);
  selectedFolder = created;
  await renderFiles();
}
async function openNote(target: string) {
  if (target === path || !(await canLeave())) return;
  const file = await readDocument(target);
  if (!file) return;
  await setDocument(file);
  await renderFiles();
}
async function renameEntry(entry: Entry) {
  if (entry.path === privatePath || !(await canLeave())) return;
  const name = await nameDialog(
    "Rename",
    entry.name.replace(/\.(md|markdown|textlock)$/i, ""),
    "Rename",
  );
  if (!name) return;
  const next = await storage.rename(entry.path, name);
  remapEntry(entry.path, next);
  await renderFiles();
  updateStatus();
}
function within(candidate: string | null, ancestor: string): candidate is string {
  return candidate !== null &&
    (candidate === ancestor || candidate.startsWith(ancestor + "/") ||
      candidate.startsWith(ancestor + "\\"));
}
function remapEntry(previous: string, next: string) {
  if (within(lastPrivateNote, previous))
    lastPrivateNote = next + lastPrivateNote.slice(previous.length);
  if (within(treeFocusedPath, previous))
    treeFocusedPath = next + treeFocusedPath.slice(previous.length);
  if (within(path, previous)) {
    path = next + path.slice(previous.length);
    remember("last-note", isPrivate(path) ? "" : path);
  }
  if (within(selectedFolder, previous))
    selectedFolder = next + selectedFolder.slice(previous.length);
  for (const folder of [...expanded])
    if (within(folder, previous)) {
      expanded.delete(folder);
      expanded.add(next + folder.slice(previous.length));
    }
}
async function moveEntry(entry: Entry, destination: string) {
  // A failed save leaves both the editor and the file in place.
  if (!(await flush())) return;
  const next = await storage.move(entry.path, destination);
  remapEntry(entry.path, next);
  selectedFolder = destination;
  treeFocusedPath = next;
  let ancestor = destination;
  while (workspace && ancestor !== workspace.path &&
    within(ancestor, workspace.path)) {
    expanded.add(ancestor);
    ancestor = ancestor.slice(0, Math.max(ancestor.lastIndexOf("/"), ancestor.lastIndexOf("\\")));
  }
  await renderFiles();
  updateStatus();
}
async function trashEntry(entry: Entry) {
  if (entry.path === privatePath || !(await canLeave())) return;
  const current =
    path === entry.path ||
    path?.startsWith(entry.path + "/") ||
    path?.startsWith(entry.path + "\\");
  await storage.trash(entry.path);
  if (within(lastPrivateNote, entry.path)) lastPrivateNote = null;
  expanded.delete(entry.path);
  if (
    selectedFolder === entry.path ||
    selectedFolder?.startsWith(entry.path + "/") ||
    selectedFolder?.startsWith(entry.path + "\\")
  )
    selectedFolder = workspace!.path;
  if (current) {
    const first = await firstNote(workspace!.path);
    if (first) {
      try {
        await setDocument(await storage.readFile(first));
      } catch (error) {
        if (String(error).includes("PASSWORD_REQUIRED")) clearDocument();
        else throw error;
      }
    } else await setDocument(await storage.createNote(workspace!.path));
  }
  await renderFiles();
}
async function addFolder(
  container: HTMLElement,
  folder: string,
  depth: number,
) {
  const entries = await storage.listFolder(folder);
  if (folder === workspace?.path && privatePath)
    entries.push({ path: privatePath, name: "Private", directory: true });
  for (const entry of entries) {
    const privateRoot = entry.path === privatePath;
    if (isPrivate(entry.path) && !privateRoot && (!privateUnlocked || privateConcealed)) continue;
    const item = document.createElement("div"),
      row = document.createElement("button");
    row.className = "file-row";
    row.dataset.path = entry.path;
    row.dataset.parent = folder;
    row.draggable = !privateRoot;
    if (isPrivate(entry.path) && !privateRoot) item.dataset.private = "true";
    row.ondragstart = (event) => {
      if (busy || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      draggedEntry = entry;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-text-entry", entry.path);
      event.dataTransfer.setData("text/plain", entry.name);
    };
    row.ondragend = () => {
      draggedEntry = null;
      clearDropTarget();
    };
    treeEntries.set(entry.path, entry);
    row.onfocus = () => {
      treeFocusedPath = entry.path;
      selectedFolder = privateRoot && !privateUnlocked ? workspace!.path : entry.directory ? entry.path : folder;
      updateStatus();
    };
    row.style.paddingLeft = `${14 + depth * 14}px`;
    row.innerHTML = `<span class="chevron">${entry.directory ? icon("chevron") : ""}</span><span class="file-label"></span>`;
    row.querySelector(".file-label")!.textContent = entry.directory
      ? entry.name
      : entry.name.replace(/\.(md|markdown|textlock)$/i, "");
    if (privateRoot) {
      row.id = "private-folder";
      row.querySelector(".chevron")!.innerHTML = icon("lock");
      row.setAttribute("aria-description", privateUnlocked ? "Unlocked. Switch apps to lock." : "Locked. Password required.");
    }
    row.title = privateRoot ? (privateUnlocked ? "Private · unlocked" : "Private · locked") : entry.protected
      ? entry.name + " · password protected"
      : entry.name;
    if (entry.protected)
      row.setAttribute("aria-description", "Password protected");
    item.append(row);
    container.append(item);
    row.oncontextmenu = (event) => {
      event.preventDefault();
      if (privateRoot || privateConcealed && isPrivate(entry.path)) return;
      context = entry;
      $("move-private").hidden = !desktop || entry.directory || isPrivate(entry.path);
      treeFocusedPath = entry.path;
      $("set-password").hidden =
        !desktop || entry.directory || !!entry.protected;
      $("remove-password").hidden =
        !desktop || entry.directory || !entry.protected || isPrivate(entry.path);
      const menu = $("context-menu");
      menu.style.left = `${Math.min(event.clientX, innerWidth - 150)}px`;
      menu.style.top = `${Math.min(event.clientY, innerHeight - 140)}px`;
      menu.showPopover();
      menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
    };
    row.ondblclick = () =>
      void action(
        () => renameEntry(entry),
        () => focusEntry(treeFocusedPath),
      );
    if (entry.directory) {
      const children = document.createElement("div");
      item.append(children);
      const fill = async () => {
        children.replaceChildren();
        if (privateRoot) children.dataset.private = "true";
        if (expanded.has(entry.path) && (!privateRoot || privateUnlocked))
          await addFolder(children, entry.path, depth + 1);
        row.setAttribute("aria-expanded", String(expanded.has(entry.path)));
        row.classList.toggle("expanded", expanded.has(entry.path));
        updateStatus();
      };
      await fill();
      row.onclick = () =>
        void action(
          async () => {
            if (privateRoot && !privateUnlocked) {
              if (await unlockPrivateFolder()) await renderFiles();
              return;
            }
            selectedFolder = entry.path;
            expanded.has(entry.path)
              ? expanded.delete(entry.path)
              : expanded.add(entry.path);
            await fill();
          },
          () => focusEntry(entry.path),
        );
    } else
      row.onclick = () =>
        void action(
          () => openNote(entry.path),
          () => focusEntry(entry.path),
        );
  }
}
async function renderFiles() {
  const epoch = privateEpoch;
  treeEntries.clear();
  const fragment = document.createElement("div");
  if (workspace) await addFolder(fragment, workspace.path, 0);
  if (epoch !== privateEpoch) return;
  $("files").replaceChildren(...fragment.childNodes);
  updateStatus();
}
async function firstNote(folder: string): Promise<string | null> {
  const entries = await storage.listFolder(folder);
  const file = entries.find((entry) => !entry.directory);
  if (file) return file.path;
  for (const entry of entries)
    if (entry.directory && entry.path !== privatePath) {
      const found = await firstNote(entry.path);
      if (found) return found;
    }
  return null;
}
function focusEntry(target: string | null) {
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>(".file-row"),
  ].find((row) => row.dataset.path === target);
  if (row && !sidebarHidden) row.focus();
  else if (path) editor.focus();
  else $("new-note").focus();
}
$("files").addEventListener("keydown", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>(
    ".file-row",
  );
  if (!row || busy) return;
  const entry = treeEntries.get(row.dataset.path!);
  if (!entry) return;
  const rows = [...document.querySelectorAll<HTMLButtonElement>(".file-row")];
  const index = rows.indexOf(row);
  if (["Enter", "F2"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    void action(
      () => renameEntry(entry),
      () => focusEntry(treeFocusedPath),
    );
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    rows[
      Math.max(
        0,
        Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      )
    ]?.focus();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (entry.directory && !expanded.has(entry.path)) row.click();
    else if (entry.directory) rows[index + 1]?.focus();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (entry.directory && expanded.has(entry.path)) row.click();
    else focusEntry(row.dataset.parent || null);
  } else if (event.key === "Delete") {
    event.preventDefault();
    void action(
      () => trashEntry(entry),
      () => focusEntry(path),
    );
  } else if (event.key === "Escape") {
    event.preventDefault();
    editor.focus();
  }
});
function clearDropTarget() {
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
}
function dropDestination(event: DragEvent) {
  if (!draggedEntry || busy || !workspace) return null;
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest<HTMLElement>(".file-row");
  const folder = row ? treeEntries.get(row.dataset.path!) : null;
  if (row && !folder?.directory) return null;
  const destination = folder?.path || workspace.path;
  const sourceParent = draggedEntry.path.slice(0,
    Math.max(draggedEntry.path.lastIndexOf("/"), draggedEntry.path.lastIndexOf("\\")));
  if (destination === sourceParent || within(destination, draggedEntry.path) ||
    isPrivate(destination) !== isPrivate(draggedEntry.path)) return null;
  return { path: destination, element: row || $("files") };
}
$("sidebar").addEventListener("dragover", (event) => {
  const destination = dropDestination(event);
  clearDropTarget();
  if (!destination) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  destination.element.classList.add("drop-target");
});
$("sidebar").addEventListener("dragleave", (event) => {
  if (!(event.relatedTarget instanceof Node) || !$("sidebar").contains(event.relatedTarget))
    clearDropTarget();
});
$("sidebar").addEventListener("drop", (event) => {
  const destination = dropDestination(event), entry = draggedEntry;
  event.preventDefault();
  clearDropTarget();
  draggedEntry = null;
  if (destination && entry)
    void action(() => moveEntry(entry, destination.path), () => focusEntry(treeFocusedPath));
});
// A library drag only moves within the tree; do not insert its name into a note.
document.addEventListener("drop", (event) => {
  if (!draggedEntry) return;
  event.preventDefault();
  draggedEntry = null;
  clearDropTarget();
});
let infoFocus: string | null = null;
async function showInfo(entry: Entry) {
  const info = await storage.info(entry.path);
  const date = (value: number | null) => value === null ? "Unavailable" :
    new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "medium" }).format(value);
  const size = info.size < 1024 ? `${info.size} ${info.size === 1 ? "byte" : "bytes"}` :
    `${(info.size / (info.size < 1024 * 1024 ? 1024 : 1024 * 1024)).toFixed(1)} ${info.size < 1024 * 1024 ? "KB" : "MB"} (${info.size.toLocaleString()} bytes)`;
  const fields = [
    ["Location", desktop ? info.path : "Browser storage: " + info.path],
    ["Type", info.directory ? "Folder" : info.protected ? "Encrypted note" : "Markdown note"],
    ["Created", date(info.created)], ["Modified", date(info.modified)],
    ...(!info.directory ? [["Size", size], ["Password", info.protected ? "Protected" : "None"]] : []),
  ];
  $("info-name").textContent = info.name;
  $("info-details").replaceChildren(...fields.flatMap(([label, value]) => {
    const term = document.createElement("dt"), detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    return [term, detail];
  }));
  infoFocus = entry.path;
  $<HTMLDialogElement>("info-dialog").showModal();
}
$("get-info").onclick = () => {
  $("context-menu").hidePopover();
  if (context) {
    const entry = context;
    void action(() => showInfo(entry), () => {});
  }
};
$("close-info").onclick = () => $<HTMLDialogElement>("info-dialog").close();
$("info-dialog").addEventListener("close", () => focusEntry(infoFocus));
let editorFontSize = 13;
function zoomText(change: number) {
  if (document.querySelector("dialog[open]")) return;
  editorFontSize = change === 0 ? 13 : Math.max(9, Math.min(32, editorFontSize + change));
  setEditorFontSize(editor, editorFontSize);
  remember("text-size", String(editorFontSize));
}
const rememberedSize = Number(recalled("text-size"));
if (Number.isInteger(rememberedSize) && rememberedSize >= 9 && rememberedSize <= 32)
  zoomText(rememberedSize - 13);
let shortcutsFocus: HTMLElement | null = null;
function showShortcuts() {
  if (document.querySelector("dialog[open]")) return;
  shortcutsFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $<HTMLDialogElement>("shortcuts-dialog").showModal();
}
$("close-shortcuts").onclick = () => $<HTMLDialogElement>("shortcuts-dialog").close();
$("shortcuts-dialog").addEventListener("close", () => {
  if (shortcutsFocus?.isConnected) shortcutsFocus.focus();
  else if (path) editor.focus();
  shortcutsFocus = null;
});
function toggleSidebar() {
  sidebarHidden = !sidebarHidden;
  document.body.classList.toggle("sidebar-hidden", sidebarHidden);
  $("sidebar").inert = sidebarHidden;
  $("toggle-sidebar").setAttribute("aria-expanded", String(!sidebarHidden));
  remember("sidebar", String(sidebarHidden));
  editor.requestMeasure();
  editor.focus();
}
function bindVim() {
  observeVim(editor, (mode) => {
    $("vim-mode").hidden = mode === null;
    $("vim-mode").textContent = mode ? "[" + mode + "]" : "";
    $("vim-toggle").textContent = vimEnabled ? "vim:on" : "vim:off";
    $("vim-toggle").setAttribute("aria-pressed", String(vimEnabled));
    const label = vimEnabled ? "Disable Vim" : "Enable Vim";
    $("vim-toggle").setAttribute("aria-label", label);
    $("vim-toggle").title = label + " (" + mod + "Alt+V)";
  });
}
function switchVim() {
  toggleVim(editor);
  bindVim();
}
$("vim-toggle").onclick = switchVim;
bindVim();
Vim.defineEx("write", "w", () => {
  void action(async () => {
    await flush();
  });
});
const quit = () =>
  void action(async () => {
    if (privateDraft && !(await unlockPrivateFolder())) return;
    if (await canLeave()) {
      if (desktop) await invoke("quit");
      else notice("Quit is available in the desktop app.");
    }
  });
Vim.defineEx("quit", "q", quit);
Vim.defineEx("wq", "wq", quit);
Vim.defineEx("new", "new", (_cm, params) => {
  void action(async () => {
    if (await canLeave()) {
      await setDocument(
        await storage.createNote(
          parent(),
          params.argString?.trim() || "Untitled",
        ),
      );
      await renderFiles();
    }
  });
});
Vim.defineEx("mkdir", "mkdir", (_cm, params) => {
  void action(async () => {
    const name = params.argString?.trim();
    if (!name) return newFolder();
    const created = await storage.createFolder(parent(), name);
    expanded.add(parent());
    selectedFolder = created;
    expanded.add(created);
    await renderFiles();
  });
});
$("new-note").onclick = () => void action(newNote);
$("new-folder").onclick = () => void action(newFolder);
$("document-name").onclick = () => {
  if (path)
    void action(() =>
      renameEntry({ path: path!, name: filename(), directory: false }),
    );
};
$("rename").onclick = () => {
  $("context-menu").hidePopover();
  if (context) void action(() => renameEntry(context!));
};
$("set-password").onclick = () => {
  $("context-menu").hidePopover();
  if (context) void action(() => protectEntry(context!));
};
$("remove-password").onclick = () => {
  $("context-menu").hidePopover();
  if (context) void action(() => protectEntry(context!, true));
};
$("move-private").onclick = () => {
  $("context-menu").hidePopover();
  const entry = context;
  if (entry) void action(async () => {
    if (!(await canLeave())) return;
    if (path !== entry.path) {
      const file = await readDocument(entry.path);
      if (!file) return;
      await setDocument(file);
    }
    if (!privateUnlocked && !(await unlockPrivateFolder(false))) return;
    const result = await storage.moveToPrivate(entry.path, diskContent);
    await setDocument(result);
    lastPrivateNote = result.path;
    expanded.add(privatePath!);
    await renderFiles();
  });
};
$("trash").onclick = () => {
  $("context-menu").hidePopover();
  if (context) void action(() => trashEntry(context!));
};
$("files").addEventListener("click", (event) => {
  if (event.target === $("files")) {
    selectedFolder = workspace?.path || null;
    updateStatus();
  }
});
$("toggle-sidebar").onclick = toggleSidebar;
$("toggle-sidebar").setAttribute("aria-expanded", "true");
$("toggle-sidebar").setAttribute("aria-controls", "sidebar");
document.addEventListener(
  "keydown",
  (event) => {
    if (event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const zoom = event.key === "+" || event.key === "=" || event.code === "NumpadAdd" ? 1 :
        event.key === "-" || event.code === "NumpadSubtract" ? -1 :
        event.key === "0" || event.code === "Digit0" || event.code === "Numpad0" ? 0 : null;
      if (zoom !== null) {
        event.preventDefault();
        event.stopPropagation();
        zoomText(zoom);
        return;
      }
    }
    if (event.key === "F1" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      showShortcuts();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (ready && !document.querySelector("dialog[open]"))
        void action(closeCurrent);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.altKey &&
      event.code === "KeyV"
    ) {
      event.preventDefault();
      if (!document.querySelector("dialog[open]") && !busy) switchVim();
      return;
    }
    if (
      event.key === "F2" &&
      ready &&
      !document.querySelector("dialog[open]")
    ) {
      if ((event.target as HTMLElement).closest(".file-row")) return;
      event.preventDefault();
      if (path)
        void action(() =>
          renameEntry({ path: path!, name: filename(), directory: false }),
        );
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "b" && !event.shiftKey) {
      event.preventDefault();
      if (!document.querySelector("dialog[open]")) toggleSidebar();
      return;
    }
    if (!["n", "o", "s"].includes(key)) return;
    event.preventDefault();
    if (document.querySelector("dialog[open]") || !ready) return;
    if (key === "n") void action(event.shiftKey ? newFolder : newNote);
    if (key === "s")
      void action(async () => {
        if (event.shiftKey) await exportCopy();
        else await flush();
      });
    if (key === "o")
      void action(async () => {
        if (await canLeave()) {
          const file = await storage.importFile(parent());
          if (file) {
            await setDocument(file);
            await renderFiles();
          }
        }
      });
  },
  true,
);
window.addEventListener("beforeunload", (event) => {
  if (!desktop && dirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
let definitionsLoading = false;
let definitionsError: string | null = null;
function applyMathDefinitions(source: string) {
  setMathDefinitions(editor, source);
  if (definitionsError && $("notice").querySelector("span")!.textContent === definitionsError)
    $("notice").hidden = true;
  definitionsError = null;
}
async function refreshMathDefinitions() {
  if (!desktop || definitionsLoading) return;
  definitionsLoading = true;
  try {
    applyMathDefinitions((await storage.latexDefinitions()) || "");
  } catch (error) {
    definitionsError = `Couldn’t load def.tex. Previous working definitions are unchanged. ${String(error)}`;
    notice(definitionsError);
  } finally {
    definitionsLoading = false;
  }
}
window.addEventListener("focus", () => { void refreshMathDefinitions(); });
window.addEventListener("blur", concealPrivate);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) concealPrivate();
});
if (desktop) {
  const close = () =>
    void action(async () => {
      if (privateDraft && !(await unlockPrivateFolder())) return;
      if (await canLeave()) await invoke("quit");
    });
  import("@tauri-apps/api/event")
    .then(async ({ listen }) => {
      await listen("request-quit", close);
      await listen("tauri://blur", concealPrivate);
      await listen("close-note", () => {
        if (!document.querySelector("dialog[open]")) void action(closeCurrent);
      });
      await listen("show-shortcuts", showShortcuts);
      await listen("edit-latex-notation", () => { if (!busy) void showLatexNotation(); });
      await listen<number>("text-size", (event) => zoomText(event.payload));
    })
    .catch(notice);
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        close();
      }),
    )
    .catch(notice);
}
if (recalled("sidebar") === "true") toggleSidebar();
void action(async () => {
  workspace = await storage.library();
  if (desktop) {
    const status = await storage.privateStatus();
    privatePath = status.path;
    privateConfigured = status.configured;
  }
  selectedFolder = workspace.path;
  const last = recalled("last-note");
  if (recalled("closed") === "true") {
    clearDocument();
    ready = true;
    await renderFiles();
    return;
  }
  let initial: DocumentFile | null = null;
  if (last && !isPrivate(last)) {
    try {
      initial = await storage.readFile(last);
    } catch (error) {
      if (String(error).includes("PASSWORD_REQUIRED")) {
        clearDocument();
        ready = true;
        await renderFiles();
        return;
      }
    }
  }
  if (!initial) {
    const first = await firstNote(workspace.path);
    if (first) {
      try {
        initial = await storage.readFile(first);
      } catch (error) {
        if (String(error).includes("PASSWORD_REQUIRED")) {
          clearDocument();
          ready = true;
          await renderFiles();
          return;
        }
        throw error;
      }
    } else initial = await storage.createNote(workspace.path);
  }
  await setDocument(initial);
  let ancestor = selectedFolder;
  while (
    ancestor &&
    ancestor !== workspace.path &&
    ancestor.length > workspace.path.length
  ) {
    expanded.add(ancestor);
    ancestor = ancestor.slice(
      0,
      Math.max(ancestor.lastIndexOf("/"), ancestor.lastIndexOf("\\")),
    );
  }
  ready = true;
  await renderFiles();
}).then(refreshMathDefinitions);

setupUpdates({ desktop, button: $<HTMLButtonElement>("check-updates"), run: (task) => action(task), save: () => privateDraft ? Promise.resolve(false) : flush() });

async function unlockPrivateFolder(restore = true): Promise<boolean> {
  if (restore && (privateDraft || lastPrivateNote) && !(await canLeave())) return false;
  const epoch = privateEpoch;
  privateConcealed = false;
  document.body.classList.remove("private-concealed");
  privateAuthenticating = true;
  try {
    const result = await passwordDialog(!privateConfigured, async (password) => {
      await storage.unlockPrivate(password, !privateConfigured);
      return true;
    }, privateConfigured ? "Unlock Private" : "Set Private folder password");
    if (!result || epoch !== privateEpoch) return false;
    privateConfigured = privateUnlocked = true;
    selectedFolder = privatePath;
    expanded.add(privatePath!);
    if (restore && (privateDraft || lastPrivateNote)) {
      const target = privateDraft?.path || lastPrivateNote!;
      let file: DocumentFile | null = null;
      try { file = await storage.readFile(target); }
      catch {
        if (!privateDraft) {
          lastPrivateNote = null;
          notice("Your last private note is no longer available. Choose another note in Private.");
          return true;
        }
      }
      if (privateDraft) {
        const draft = privateDraft;
        await setDocument({ path: target, content: draft.content, protected: true });
        diskContent = draft.expected;
        savedContent = draft.saved;
        privateDraft = null;
        notice("Your unsaved private edits were restored. Save or export a copy before leaving this note.");
        updateStatus();
      } else if (file) await setDocument(file);
    }
    return true;
  } finally { privateAuthenticating = false; }
}
function concealPrivate() {
  beginPrivateLock(true);
}
async function lockPrivateOnLeave() {
  // This runs inside the current action, so it must not wait for that action.
  beginPrivateLock(false);
  await privateLockPromise;
}
function beginPrivateLock(waitForAction: boolean) {
  if (!ready) return;
  if (!privateUnlocked && !privateAuthenticating && !isPrivate(path)) {
    void flush();
    return;
  }
  if (privateLockPromise) return;
  // Conceal synchronously, before awaiting a save, dialog or in-flight operation.
  privateEpoch++;
  privateConcealed = true;
  document.body.classList.add("private-concealed");
  document.querySelectorAll<HTMLElement>('[data-private="true"]').forEach((el) => el.remove());
  if (privatePath) expanded.delete(privatePath);
  privateUnlocked = false;
  context = draggedEntry = null;
  treeFocusedPath = selectedFolder = workspace!.path;
  $("context-menu").hidePopover();
  $("notice").hidden = true;
  for (const id of ["name-input", "password-input", "password-confirm"])
    $<HTMLInputElement>(id).value = "";
  cancelPasswordDialog?.();
  document.querySelectorAll<HTMLDialogElement>('dialog[open]:not(#password-dialog)').forEach((dialog) => {
    if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  });
  const row = $("private-folder");
  if (row) {
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-description", "Locked. Password required.");
    row.classList.remove("expanded");
    row.title = "Private · locked";
  }
  document.title = "text";
  if (desktop) import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle("text")).catch(() => {});
  const pendingAction = waitForAction ? actionDone : null;
  privateLockPromise = (async () => {
    if (pendingAction) await pendingAction;
    const privateNote = isPrivate(path);
    const saved = await flush();
    if (privateNote && path) {
      lastPrivateNote = path;
      if (!saved) privateDraft = { path, content: text(), expected: diskContent, saved: savedContent };
      clearDocument();
    }
    // Hidden dialogs can contain titles/paths. Clear them before revealing the app.
    document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    $("info-name").textContent = "";
    $("info-details").replaceChildren();
    await storage.lockPrivate();
    if (privatePath) {
      expanded.delete(privatePath);
      for (const folder of [...expanded]) if (isPrivate(folder)) expanded.delete(folder);
    }
    for (const key of [...treeEntries.keys()]) if (isPrivate(key)) treeEntries.delete(key);
    selectedFolder = workspace!.path;
    treeFocusedPath = privatePath;
    await renderFiles();
  })().catch(() => {
    // Keep the veil in place if locking fails; never expose private content.
    notice("Couldn’t finish locking Private. Return to Private to retry.");
  }).finally(() => {
    privateLockPromise = null;
    if (!isPrivate(path)) {
      privateConcealed = false;
      document.body.classList.remove("private-concealed");
    }
  });
}
