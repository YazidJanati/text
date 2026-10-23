import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Storage, DocumentFile } from "./types";
export const desktop = isTauri();
const native: Storage = {
  library: () => invoke("library"),
  listFolder: (path) => invoke("list_folder", { path }),
  readFile: (path) => invoke("read_file", { path }),
  unlockFile: (path, password) => invoke("unlock_file", { path, password }),
  setPassword: (path, password, expected) =>
    invoke("set_password", { path, password, expected }),
  removePassword: (path) => invoke("remove_password", { path }),
  closeNote: () => invoke("close_note"),
  saveFile: (path, content, expected) =>
    invoke("save_file", { path, content, expected }),
  createNote: (parent, name) =>
    invoke("create_note", { parent, name: name || "Untitled" }),
  createFolder: (parent, name) => invoke("create_folder", { parent, name }),
  rename: (path, name) => invoke("rename_entry", { path, name }),
  trash: (path) => invoke("trash_entry", { path }),
  importFile: (parent) => invoke("import_file", { parent }),
  exportFile: async (content, suggested) =>
    !!(await invoke("save_as", { content, suggested })),
};

// A persistent, self-contained preview library for running the UI in a browser.
// Desktop notes use real Markdown files in the app's own local library.
const root = "/notes";
let data: Record<string, string | null> = {};
try {
  data = JSON.parse(localStorage.getItem("notes:preview-library") || "{}");
} catch {
  /* Start empty if storage is unavailable. */
}
function persist() {
  try {
    localStorage.setItem("notes:preview-library", JSON.stringify(data));
  } catch {
    throw new Error("Browser storage is full. Export your note with Ctrl/⌘⇧S.");
  }
}
function valid(name: string) {
  if (
    !name.trim() ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    name.startsWith(".")
  )
    throw new Error("Choose a name without slashes or special characters.");
  return name.trim();
}
function unique(parent: string, name: string, extension = "") {
  let index = 1;
  let path = `${parent}/${name}${extension}`;
  while (path in data) path = `${parent}/${name} ${++index}${extension}`;
  return path;
}
const browser: Storage = {
  unlockFile: async () => {
    throw new Error("Password protection is available in the desktop app.");
  },
  setPassword: async () => {
    throw new Error("Password protection is available in the desktop app.");
  },
  removePassword: async () => {
    throw new Error("Password protection is available in the desktop app.");
  },
  closeNote: async () => {},
  library: async () => ({ path: root, name: "text" }),
  listFolder: async (path) =>
    Object.keys(data)
      .filter(
        (key) =>
          key.startsWith(path + "/") &&
          !key.slice(path.length + 1).includes("/"),
      )
      .map((key) => ({
        path: key,
        name: key.split("/").at(-1)!,
        directory: data[key] === null,
      }))
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      ),
  readFile: async (path) => {
    const content = data[path];
    if (typeof content !== "string")
      throw new Error("This note no longer exists.");
    return { path, content };
  },
  saveFile: async (path, content, expected) => {
    if (data[path] !== expected)
      throw new Error(
        "This note changed elsewhere. Export a copy to keep your edits.",
      );
    data[path] = content;
    persist();
    return { path, content };
  },
  createNote: async (parent, name = "Untitled") => {
    const path = unique(parent, valid(name.replace(/\.md$/i, "")), ".md");
    data[path] = "";
    persist();
    return { path, content: "" };
  },
  createFolder: async (parent, name) => {
    const path = unique(parent, valid(name));
    data[path] = null;
    persist();
    return path;
  },
  rename: async (path, name) => {
    const target =
      path.slice(0, path.lastIndexOf("/") + 1) +
      valid(data[path] === null ? name : name.replace(/\.md$/i, "") + ".md");
    if (target === path) return path;
    if (target in data) throw new Error("That name already exists.");
    for (const key of Object.keys(data))
      if (key === path || key.startsWith(path + "/")) {
        data[target + key.slice(path.length)] = data[key];
        delete data[key];
      }
    persist();
    return target;
  },
  trash: async (path) => {
    for (const key of Object.keys(data))
      if (key === path || key.startsWith(path + "/")) delete data[key];
    persist();
  },
  importFile: (parent) =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".md,.markdown,text/markdown";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const note = await browser.createNote(
          parent,
          file.name.replace(/\.(md|markdown)$/i, ""),
        );
        data[note.path] = await file.text();
        persist();
        resolve({ path: note.path, content: data[note.path] as string });
      };
      input.oncancel = () => resolve(null);
      input.click();
    }),
  exportFile: async (content, suggested) => {
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
};
export const storage = desktop ? native : browser;
