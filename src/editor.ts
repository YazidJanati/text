import { vimCompartment, vimExtension } from "./vim";
import { mathPreview } from "./math";
import { EditorState, EditorSelection } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  drawSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  markdown,
  markdownLanguage,
  markdownKeymap,
} from "@codemirror/lang-markdown";
import { syntaxTree, indentUnit } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { GFM } from "@lezer/markdown";
class Bullet extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-bullet";
    el.textContent = "•";
    return el;
  }
}
class Rule extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-rule";
    return el;
  }
}
class Checkbox extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: Checkbox) {
    return this.checked === other.checked && this.pos === other.pos;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "md-checkbox";
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.setAttribute("aria-label", "Toggle task");
    el.textContent = this.checked ? "✓" : "";
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      view.dispatch({
        changes: {
          from: this.pos + 1,
          to: this.pos + 2,
          insert: this.checked ? " " : "x",
        },
      });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
export function previewDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [],
    state = view.state;
  const active = (from: number, to: number) =>
    state.selection.ranges.some(
      (range) =>
        from <= state.doc.lineAt(range.to).to &&
        to >= state.doc.lineAt(range.from).from,
    );
  const hide = (from: number, to: number) => {
    if (from < to) ranges.push(Decoration.replace({}).range(from, to));
  };
  const mark = (from: number, to: number, cls: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: cls }).range(from, to));
  };
  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const { name, from, to } = node,
          editing = active(from, to);
        if (/^(ATXHeading[1-6]|SetextHeading[12])$/.test(name))
          ranges.push(
            Decoration.line({ class: `md-heading md-h${name.at(-1)}` }).range(
              state.doc.lineAt(from).from,
            ),
          );
        const cls: Record<string, string> = {
          StrongEmphasis: "md-strong",
          Emphasis: "md-em",
          Strikethrough: "md-strike",
          InlineCode: "md-inline-code",
          Link: "md-link",
        };
        if (cls[name]) mark(from, to, cls[name]);
        if (["Blockquote", "FencedCode", "CodeBlock"].includes(name)) {
          let line = state.doc.lineAt(from);
          while (line.from <= to) {
            ranges.push(
              Decoration.line({
                class: name === "Blockquote" ? "md-quote" : "md-code-line",
              }).range(line.from),
            );
            if (line.number === state.doc.lines || line.to >= to) break;
            line = state.doc.line(line.number + 1);
          }
        }
        if (!editing) {
          if (
            [
              "EmphasisMark",
              "StrikethroughMark",
              "CodeMark",
              "QuoteMark",
              "HeaderMark",
            ].includes(name)
          ) {
            let end = to;
            if (
              ["HeaderMark", "QuoteMark"].includes(name) &&
              state.doc.sliceString(to, to + 1) === " "
            )
              end++;
            hide(from, end);
          }
          if (name === "Link") {
            const match = /^\[([^\n]*?)\]\(([^\n]*)\)$/.exec(
              state.doc.sliceString(from, to),
            );
            if (match) {
              hide(from, from + 1);
              hide(from + match[1].length + 1, to);
            }
          }
          if (
            name === "ListMark" &&
            /^[-+*]$/.test(state.doc.sliceString(from, to))
          )
            ranges.push(
              Decoration.replace({ widget: new Bullet() }).range(from, to),
            );
          if (name === "HorizontalRule")
            ranges.push(
              Decoration.replace({ widget: new Rule() }).range(from, to),
            );
          if (name === "TaskMarker")
            ranges.push(
              Decoration.replace({
                widget: new Checkbox(
                  /x/i.test(state.doc.sliceString(from, to)),
                  from,
                ),
              }).range(from, to),
            );
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}
const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = previewDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = previewDecorations(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);
const theme = EditorView.theme(
  {
    "&": {
      color: "#d4d4d4",
      backgroundColor: "transparent",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      letterSpacing: "0",
      wordSpacing: "0",
      lineHeight: "1.6",
      overflow: "auto",
    },
    ".cm-content": {
      maxWidth: "none",
      width: "100%",
      margin: "0 auto",
      padding: "28px 32px 35vh",
      caretColor: "#c9c9c9",
    },
    ".cm-line": { padding: "0 2px", overflowWrap: "anywhere" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#dedede" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      { backgroundColor: "#364858 !important" },
    ".cm-panels": {
      backgroundColor: "#252526",
      color: "#ccc",
      borderColor: "#333",
    },
    ".cm-textfield": {
      backgroundColor: "#1e1e1e",
      color: "#ddd",
      border: "1px solid #555",
    },
    ".cm-button": {
      background: "#333",
      color: "#ddd",
      border: "1px solid #555",
    },
    ".cm-searchMatch": { backgroundColor: "#694b2d" },
    ".cm-searchMatch-selected": { backgroundColor: "#84612b" },
    ".cm-placeholder": { color: "#656565" },
  },
  { dark: true },
);
export function wrapSelection(view: EditorView, marker: string, end = marker) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const already =
        range.from >= marker.length &&
        view.state.sliceDoc(range.from - marker.length, range.from) ===
          marker &&
        view.state.sliceDoc(range.to, range.to + end.length) === end;
      return already
        ? {
            changes: [
              { from: range.from - marker.length, to: range.from, insert: "" },
              { from: range.to, to: range.to + end.length, insert: "" },
            ],
            range: EditorSelection.range(
              range.from - marker.length,
              range.to - marker.length,
            ),
          }
        : {
            changes: {
              from: range.from,
              to: range.to,
              insert: marker + selected + end,
            },
            range: EditorSelection.range(
              range.from + marker.length,
              range.to + marker.length,
            ),
          };
    }),
  );
  view.focus();
  return true;
}
export function createEditor(
  parent: HTMLElement,
  doc: string,
  onChange: () => void,
) {
  return new EditorView({ parent, state: makeState(doc, onChange) });
}
export function makeState(doc: string, onChange: () => void) {
  return EditorState.create({
    doc,
    extensions: [
      vimCompartment.of(vimExtension()),
      drawSelection(),
      markdown({ base: markdownLanguage, extensions: [GFM] }),
      livePreview,
      mathPreview,
      theme,
      EditorView.lineWrapping,
      history(),
      indentUnit.of("  "),
      highlightSelectionMatches(),
      placeholder(""),
      EditorView.contentAttributes.of({
        "aria-label": "Markdown editor",
        spellcheck: "true",
        autocapitalize: "sentences",
      }),
      keymap.of([
        { key: "Mod-Shift-b", run: (view) => wrapSelection(view, "**") },
        { key: "Mod-i", run: (view) => wrapSelection(view, "*") },
        {
          key: "Mod-k",
          run: (view) => wrapSelection(view, "[", "](https://)"),
        },
        ...markdownKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange();
      }),
    ],
  });
}
