import type { Entry } from "./types";

export function setupNoteSwitcher(options: {
  enabled: () => boolean;
  current: () => string | null;
  load: () => Promise<Entry[]>;
  open: (path: string) => Promise<void>;
}) {
  const dialog = document.createElement("dialog");
  dialog.id = "note-switcher";
  dialog.setAttribute("aria-labelledby", "note-switcher-title");
  dialog.innerHTML = `<h2 id="note-switcher-title">Switch note</h2>
    <input id="note-switcher-query" type="search" role="combobox" aria-label="Search notes in this folder" aria-autocomplete="list" aria-controls="note-switcher-results" aria-expanded="true" autocomplete="off" spellcheck="false" placeholder="Search notes in this folder…">
    <ul id="note-switcher-results" role="listbox" aria-label="Notes in this folder"></ul>
    <p id="note-switcher-status" role="status" aria-live="polite"></p>
    <p class="note-switcher-hint">Tab / Shift+Tab to cycle · Enter to open · Esc to cancel</p>`;
  document.body.append(dialog);
  const input = dialog.querySelector<HTMLInputElement>("input")!;
  const list = dialog.querySelector<HTMLUListElement>("ul")!;
  const status = dialog.querySelector<HTMLElement>("#note-switcher-status")!;
  let entries: Entry[] = [];
  let matches: Entry[] = [];
  let selected = 0;
  let steps = 1;
  let loading = false;
  let generation = 0;
  let previousFocus: HTMLElement | null = null;
  const label = (entry: Entry) => entry.name.replace(/\.(md|markdown|textlock)$/i, "");
  const normalized = (value: string) => value.trim().toLocaleLowerCase();
  function render() {
    list.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    matches.forEach((entry, index) => {
      const row = document.createElement("li");
      row.id = `note-switcher-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selected));
      row.title = entry.name;
      const name = document.createElement("span");
      name.textContent = label(entry);
      row.append(name);
      if (entry.protected || entry.path === options.current()) {
        const badge = document.createElement("span");
        badge.className = "note-switcher-badge";
        badge.textContent = [entry.protected ? "Locked" : "", entry.path === options.current() ? "Current" : ""].filter(Boolean).join(" · ");
        row.append(badge);
      }
      row.onmousedown = (event) => event.preventDefault();
      row.onclick = () => { selected = index; choose(); };
      list.append(row);
      if (index === selected) input.setAttribute("aria-activedescendant", row.id);
    });
    status.textContent = loading ? "Loading notes…" : matches.length ? `${matches.length} note${matches.length === 1 ? "" : "s"} in this folder` : "No matching notes in this folder.";
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  }
  function filter() {
    const query = normalized(input.value);
    matches = entries.filter((entry) => normalized(label(entry)).includes(query) || normalized(entry.name).includes(query));
    if (query) matches.sort((a, b) => {
      const exact = (entry: Entry) => normalized(label(entry)) === query || normalized(entry.name) === query;
      return Number(exact(b)) - Number(exact(a));
    });
    selected = 0;
    render();
  }
  function cycle(direction: number) {
    if (loading) { steps += direction; return; }
    if (matches.length) selected = (selected + direction + matches.length) % matches.length;
    render();
  }
  function close(restoreFocus = true) {
    generation++;
    loading = false;
    entries = matches = [];
    input.value = "";
    input.removeAttribute("aria-activedescendant");
    list.replaceChildren();
    status.textContent = "";
    if (dialog.open) dialog.close();
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  }
  function choose() {
    const target = matches[selected];
    if (loading || !target || !options.enabled()) return;
    close(false);
    void options.open(target.path);
  }
  async function show(direction: number) {
    if (!options.enabled() || document.querySelector("dialog[open]")) return;
    const request = ++generation;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    entries = matches = [];
    input.value = "";
    steps = direction;
    loading = true;
    render();
    dialog.showModal();
    input.focus();
    try {
      const loaded = await options.load();
      if (request !== generation || !dialog.open || !options.enabled()) return;
      entries = loaded.filter((entry) => !entry.directory).sort((a, b) => a.name.localeCompare(b.name));
      loading = false;
      filter();
      if (!input.value && matches.length) {
        const current = matches.findIndex((entry) => entry.path === options.current());
        selected = ((current < 0 ? (steps < 0 ? 0 : -1) : current) + steps) % matches.length;
        if (selected < 0) selected += matches.length;
        render();
      }
    } catch (error) {
      if (request !== generation || !dialog.open) return;
      loading = false;
      status.textContent = `Couldn’t list notes. ${String(error)}`;
    }
  }
  input.oninput = () => { steps = 0; filter(); };
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (dialog.open) {
      if (event.key === "Tab" || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cycle(event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose();
      }
      return;
    }
    if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey && options.enabled() && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void show(event.shiftKey ? -1 : 1);
    }
  }, true);
  return { close };
}
