import { StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import "katex/dist/katex.min.css";

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
    readonly from: number,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.from === other.from
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "math-block" : "math-inline";
    el.setAttribute("aria-label", this.source);
    el.title = this.source;
    katex.render(this.source, el, {
      displayMode: this.display,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20,
      output: "htmlAndMathml",
    });
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.from + (this.display ? 2 : 1) },
        scrollIntoView: true,
      });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
export interface MathRange {
  from: number;
  to: number;
  source: string;
  display: boolean;
}
export function mathRanges(state: EditorState): MathRange[] {
  const text = state.doc.toString(),
    result: MathRange[] = [];
  const excluded: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (
        [
          "FencedCode",
          "CodeBlock",
          "InlineCode",
          "HTMLBlock",
          "HTMLTag",
          "Link",
          "Image",
        ].includes(node.name)
      ) {
        excluded.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  const pattern =
    /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<![\\$])\$(?![\s$])([^\n$]*?\S)(?<!\\)\$(?![\d$])/g;
  for (const match of text.matchAll(pattern)) {
    const from = match.index!,
      to = from + match[0].length;
    if (excluded.some((range) => from < range.to && to > range.from)) continue;
    const display = match[1] !== undefined;
    // Multiline display math occupies its own lines; avoid consuming adjacent prose.
    if (
      display &&
      (text.slice(state.doc.lineAt(from).from, from).trim() ||
        text.slice(to, state.doc.lineAt(to).to).trim())
    )
      continue;
    result.push({ from, to, source: (match[1] ?? match[2]).trim(), display });
  }
  return result;
}
function decorations(state: EditorState, ranges: MathRange[]): DecorationSet {
  return Decoration.set(
    ranges
      .filter(
        (math) =>
          !state.selection.ranges.some(
            (range) =>
              math.from <= state.doc.lineAt(range.to).to &&
              math.to >= state.doc.lineAt(range.from).from,
          ),
      )
      .map((math) =>
        Decoration.replace({
          block: math.display,
          widget: new MathWidget(math.source, math.display, math.from),
        }).range(math.from, math.to),
      ),
    true,
  );
}
export const mathPreview = StateField.define<{
  ranges: MathRange[];
  decorations: DecorationSet;
}>({
  create(state) {
    const ranges = mathRanges(state);
    return { ranges, decorations: decorations(state, ranges) };
  },
  update(value, transaction) {
    const changed =
      transaction.docChanged ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    if (!changed && !transaction.selection) return value;
    const ranges = changed ? mathRanges(transaction.state) : value.ranges;
    return { ranges, decorations: decorations(transaction.state, ranges) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});
