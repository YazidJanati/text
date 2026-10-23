import { Compartment } from "@codemirror/state";
import { vim, getCM, Vim } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
export { Vim };
export const vimCompartment = new Compartment();
export let vimEnabled = true;
try {
  vimEnabled = localStorage.getItem("notes:vim") !== "false";
} catch {
  /* Vim is the default. */
}
export const vimExtension = () => (vimEnabled ? vim({ status: false }) : []);
export function toggleVim(view: EditorView) {
  vimEnabled = !vimEnabled;
  try {
    localStorage.setItem("notes:vim", String(vimEnabled));
  } catch {
    /* Optional preference. */
  }
  view.dispatch({ effects: vimCompartment.reconfigure(vimExtension()) });
  view.focus();
}
export function observeVim(
  view: EditorView,
  onMode: (mode: string | null) => void,
) {
  onMode(vimEnabled ? "normal" : null);
  getCM(view)?.on(
    "vim-mode-change",
    (event: { mode: string; subMode?: string }) =>
      onMode(event.subMode ? `${event.mode} ${event.subMode}` : event.mode),
  );
}
