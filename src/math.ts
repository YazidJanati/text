import { EditorSelection, Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import "katex/dist/katex.min.css";

const definitionsChanged = StateEffect.define<void>();
let definitions = "";
const mathOptions = {
  trust: false,
  strict: "ignore" as const,
  maxExpand: 1000,
  maxSize: 20,
};
export function validateMathDefinitions(source: string) {
  if (new TextEncoder().encode(source).length > 64 * 1024)
    throw new Error("def.tex exceeds the 64 KB limit.");
  katex.renderToString(source.replace(/^\uFEFF/, ""), { ...mathOptions, throwOnError: true });
}
export function setMathDefinitions(view: EditorView, source: string) {
  source = source.replace(/^\uFEFF/, "");
  if (source === definitions) return;
  // Validate the entire preamble before replacing the last working definitions.
  validateMathDefinitions(source);
  definitions = source;
  view.dispatch({ effects: definitionsChanged.of() });
}

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
    readonly from: number,
    readonly preamble: string,
    readonly editing = false,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.from === other.from &&
      this.preamble === other.preamble &&
      this.editing === other.editing
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "math-block" + (this.editing ? " math-live-preview" : "") : "math-inline";
    el.contentEditable = "false";
    el.setAttribute("aria-label", this.source);
    el.title = this.source;
    katex.render(this.preamble + "\n" + this.source, el, {
      ...mathOptions,
      displayMode: this.display,
      throwOnError: false,
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
  closed: boolean;
}
export function mathRanges(state: EditorState): MathRange[] {
  const text = state.doc.toString(),
    result: MathRange[] = [];
  const excluded: { from: number; to: number; link: boolean }[] = [];
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
        excluded.push({
          from: node.from,
          to: node.to,
          link: node.name === "Link" || node.name === "Image",
        });
        return false;
      }
    },
  });
  const excludedMath = (from: number, to: number) => excluded.some((range) =>
    from < range.to && to > range.from &&
    !(range.link && from <= range.from && to >= range.to),
  );
  // Scan display delimiters first so an unfinished block is editable and can
  // preview at EOF without waiting for its closing $$ or a following newline.
  const dollars = /(?<!\\)\$\$/g;
  let opening: RegExpExecArray | null;
  while ((opening = dollars.exec(text))) {
    const from = opening.index;
    if (text.slice(state.doc.lineAt(from).from, from).trim() || excludedMath(from, from + 2)) continue;
    const closing = dollars.exec(text);
    const to = closing ? closing.index + 2 : text.length;
    if (closing && text.slice(to, state.doc.lineAt(to).to).trim()) continue;
    if (excludedMath(from, to)) {
      if (!closing) break;
      continue;
    }
    result.push({ from, to, source: text.slice(from + 2, closing ? closing.index : to).trim(), display: true, closed: !!closing });
    if (!closing) break;
  }
  const inline = /(?<![\\$])\$(?![\s$])([^\n$]*?\S)(?<!\\)\$(?![\d$])/g;
  for (const match of text.matchAll(inline)) {
    const from = match.index!, to = from + match[0].length;
    if (result.some((math) => from < math.to && to > math.from) || excludedMath(from, to)) continue;
    result.push({ from, to, source: match[1].trim(), display: false, closed: true });
  }
  // Keep incomplete inline source in math context too, so grouping brackets
  // are highlighted before the closing dollar is typed. It is never hidden.
  const unfinished = /(?<![\\$])\$(?![\s$])/g;
  for (const match of text.matchAll(unfinished)) {
    const from = match.index!, to = state.doc.lineAt(from).to;
    if (result.some((math) => from >= math.from && from < math.to) || excludedMath(from, to)) continue;
    result.push({ from, to, source: text.slice(from + 1, to).trim(), display: false, closed: false });
  }
  return result.sort((a, b) => a.from - b.from);
}
function mathIsActive(state: EditorState, math: MathRange) {
  return state.selection.ranges.some((range) => {
    if (math.display)
      return math.from <= state.doc.lineAt(range.to).to && math.to >= state.doc.lineAt(range.from).from;
    if (!range.empty) return range.from < math.to && range.to > math.from;
    return range.from >= math.from && (range.from < math.to ||
      (range.from === math.to && !/[ \t]/.test(state.doc.sliceString(math.to, math.to + 1))));
  });
}
function decorations(state: EditorState, ranges: MathRange[]): DecorationSet {
  const result: ReturnType<Decoration["range"]>[] = [];
  for (const math of ranges) {
    if (mathIsActive(state, math)) {
      if (math.display && math.source) result.push(Decoration.widget({
        block: true,
        side: 1,
        widget: new MathWidget(math.source, true, math.from, definitions, true),
      }).range(state.doc.lineAt(math.to).to));
    } else if (math.closed) result.push(Decoration.replace({
      block: math.display,
      widget: new MathWidget(math.source, math.display, math.from, definitions),
    }).range(math.from, math.to));
  }
  return Decoration.set(result, true);
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
    if (!changed && !transaction.selection &&
        !transaction.effects.some((effect) => effect.is(definitionsChanged))) return value;
    const ranges = changed ? mathRanges(transaction.state) : value.ranges;
    return { ranges, decorations: decorations(transaction.state, ranges) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});


// A rendered block has no text caret, so CodeMirror's vertical movement can
// skip its entire replacement. Re-enter its first/last source line instead.
export const mathNavigation = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
    const state = view.state, current = state.selection.main;
    if (!current.empty && !event.shiftKey) return false;
    const forward = event.key === "ArrowDown";
    const next = view.moveVertically(current, forward);
    if (state.doc.lineAt(next.head).number === state.doc.lineAt(current.head).number) return false;
    const candidates = state.field(mathPreview).ranges.filter((math) =>
      math.display && math.closed && !mathIsActive(state, math) &&
      (forward ? current.head < math.from && next.head >= math.from : current.head > math.to && next.head <= math.to),
    );
    const math = forward ? candidates[0] : candidates.at(-1);
    if (!math) return false;
    let start = math.from + 2, end = math.to - 2;
    while (start < end && /\s/.test(state.doc.sliceString(start, start + 1))) start++;
    while (end > start && /\s/.test(state.doc.sliceString(end - 1, end))) end--;
    const line = state.doc.lineAt(forward ? start : end);
    const column = current.head - state.doc.lineAt(current.head).from;
    const target = Math.max(start, Math.min(end, line.to, line.from + column));
    view.dispatch({
      selection: event.shiftKey ? EditorSelection.range(current.anchor, target) : EditorSelection.cursor(target),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  },
}));

interface BracketToken { from: number; to: number; kind: string; opening: boolean }
function bracketDecorations(state: EditorState): DecorationSet {
  const marks: ReturnType<Decoration["range"]>[] = [];
  for (const selection of state.selection.ranges) {
    if (!selection.empty) continue;
    const head = selection.head;
    const math = state.field(mathPreview).ranges.find((range) => head >= range.from + (range.display ? 2 : 1) && head <= range.to);
    if (!math) continue;
    const from = math.from + (math.display ? 2 : 1);
    const to = math.closed ? math.to - (math.display ? 2 : 1) : math.to;
    const source = state.doc.sliceString(from, to);
    const tokens: BracketToken[] = [], stack: BracketToken[] = [];
    const partners = new Map<BracketToken, BracketToken>();
    const pairs = "()[]{}";
    for (let i = 0; i < source.length; i++) {
      const index = pairs.indexOf(source[i]);
      if (index < 0) continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === "\\"; j--) slashes++;
      const escaped = slashes % 2 === 1;
      // Escaped braces are visible TeX delimiters and pair independently from
      // grouping braces (for example \left\{x_{i}\right\}).
      const token = { from: from + i - (escaped ? 1 : 0), to: from + i + 1,
        kind: String(index >> 1) + (escaped ? "literal" : "group"), opening: index % 2 === 0 };
      tokens.push(token);
      if (token.opening) stack.push(token);
      else if (stack.at(-1)?.kind === token.kind) {
        const opening = stack.pop()!;
        partners.set(opening, token);
        partners.set(token, opening);
      }
    }
    const adjacent = tokens.find((token) => token.to === head) || tokens.find((token) => token.from === head);
    const active = adjacent || tokens.filter((token) => token.opening && token.to <= head &&
      (!partners.has(token) || partners.get(token)!.from >= head)).at(-1);
    if (!active) continue;
    const partner = partners.get(active);
    const cls = partner ? "math-matching-bracket" : active.opening ? "math-open-bracket" : "math-unmatched-bracket";
    marks.push(Decoration.mark({ class: cls }).range(active.from, active.to));
    if (partner) marks.push(Decoration.mark({ class: cls }).range(partner.from, partner.to));
  }
  return Decoration.set(marks, true);
}
export const mathBrackets = StateField.define<DecorationSet>({
  create: bracketDecorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection ? bracketDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
