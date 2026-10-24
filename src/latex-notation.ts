import { validateMathDefinitions } from "./math";
import type { Storage } from "./types";

export function setupLatexNotation(options: {
  storage: Storage;
  apply: (source: string) => void;
  focusEditor: () => void;
}) {
  const dialog = document.createElement("dialog");
  dialog.id = "latex-notation-dialog";
  dialog.setAttribute("aria-labelledby", "latex-notation-title");
  dialog.innerHTML = `<form><h2 id="latex-notation-title">LaTeX notation</h2>
    <p>Define commands for every note. Save creates or updates <code>def.tex</code> in your notes library.</p>
    <label for="latex-notation-source">Definitions</label>
    <textarea id="latex-notation-source" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="latex-notation-hint"></textarea>
    <p id="latex-notation-hint">Use KaTeX-compatible definitions. LaTeX packages and file imports are not supported.</p>
    <p id="latex-notation-error" role="alert" hidden></p>
    <div class="dialog-actions"><button type="button" id="latex-notation-cancel">Cancel</button><button type="submit" id="latex-notation-save">Save</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form")!;
  const source = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  const error = dialog.querySelector<HTMLElement>("#latex-notation-error")!;
  const save = dialog.querySelector<HTMLButtonElement>("#latex-notation-save")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("#latex-notation-cancel")!;
  source.placeholder = String.raw`\newcommand{\R}{\mathbb{R}}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}`;
  let original = "";
  let pending = false;
  let focusBefore: HTMLElement | null = null;
  cancel.onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    // A queued close event may arrive after the dialog has been reopened.
    if (dialog.open) return;
    source.value = "";
    if (focusBefore?.isConnected) focusBefore.focus();
    else options.focusEditor();
    focusBefore = null;
  });
  const lock = (value: boolean) => {
    pending = value;
    source.disabled = save.disabled = cancel.disabled = value;
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    lock(true);
    error.hidden = true;
    try {
      validateMathDefinitions(source.value);
      await options.storage.saveLatexDefinitions(source.value, original);
      options.apply(source.value);
      dialog.close();
    } catch (cause) {
      error.textContent = String(cause);
      error.hidden = false;
    } finally {
      lock(false);
      if (dialog.open) source.focus();
    }
  };
  source.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      if (!pending) form.requestSubmit();
    }
  });
  return async function showLatexNotation() {
    if (document.querySelector("dialog[open]") || pending) return;
    focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    source.value = "";
    error.hidden = true;
    lock(true);
    dialog.showModal();
    try {
      original = (await options.storage.latexDefinitions()) || "";
      source.value = original;
      lock(false);
      source.focus();
    } catch (cause) {
      pending = false;
      cancel.disabled = false;
      error.textContent = `Couldn’t open def.tex. ${String(cause)}`;
      error.hidden = false;
      cancel.focus();
    }
  };
}
