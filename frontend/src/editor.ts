// The Markdown editor (CodeMirror 6). One EditorView is shared; each tab has
// its own EditorState (text, selection, undo history), swapped in on show.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";

export interface EditorOptions {
  lineNumbers: boolean;
  wrapLines: boolean;
}

export interface EditorCallbacks {
  /** The text of the shown tab changed (typing, undo, paste…). */
  changed(tab: string): void;
  /** The editor scrolled (for scroll sync). */
  scrolled(tab: string): void;
}

interface TabEditor {
  state: EditorState;
  scrollTop: number;
}

/** Colours from the app's CSS variables, so the editor follows light/dark mode. */
const appTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)", fontSize: "calc(14px * var(--zoom))" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "16px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": { backgroundColor: "var(--subtle-bg)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "3ch" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--find-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--find-match)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--find-current)" },
  ".cm-panels": { backgroundColor: "var(--subtle-bg)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button": { font: "inherit", fontSize: "13px" },
  ".cm-textfield": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)", outline: "none" },
});

const numbers = new Compartment();
const wrapping = new Compartment();

/** Minimal edit from `before` to `after`, so the cursor and selection survive a reload. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

export class MarkdownEditor {
  private readonly view: EditorView;
  private readonly tabs = new Map<string, TabEditor>();
  private current: string | undefined;
  private options: EditorOptions;

  constructor(
    parent: HTMLElement,
    options: EditorOptions,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.options = options;
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "" }) });
    this.view.scrollDOM.addEventListener(
      "scroll",
      () => {
        if (this.current) this.callbacks.scrolled(this.current);
      },
      { passive: true },
    );
  }

  /** True once a tab has an editor state (it was opened in the editor). */
  has(tab: string): boolean {
    return this.tabs.has(tab);
  }

  /** Creates the editor state for a tab. */
  open(tab: string, text: string): void {
    this.tabs.set(tab, { state: EditorState.create({ doc: text, extensions: this.extensions() }), scrollTop: 0 });
  }

  /** Shows a tab's text in the editor. */
  show(tab: string): void {
    if (this.current === tab) return;
    this.remember();
    const entry = this.tabs.get(tab);
    if (!entry) return;
    this.view.setState(entry.state);
    this.applyOptions();
    this.current = tab;
    // Restore after layout, when the editor has its size.
    requestAnimationFrame(() => {
      if (this.current === tab) this.view.scrollDOM.scrollTop = entry.scrollTop;
    });
  }

  /** Stops showing any tab (the editor pane is hidden). */
  hide(): void {
    this.remember();
    this.current = undefined;
  }

  focus(): void {
    this.view.focus();
  }

  /** True if the keyboard focus is in the editor. */
  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** Opens the editor's own search panel (Find in the source). */
  openSearch(): void {
    this.view.focus();
    openSearchPanel(this.view);
  }

  /** The text of a tab. */
  text(tab: string): string {
    return this.doc(tab)?.toString() ?? "";
  }

  /** The document (CodeMirror Text) of a tab, cheap to compare with `Text.eq`. */
  doc(tab: string): Text | undefined {
    return tab === this.current ? this.view.state.doc : this.tabs.get(tab)?.state.doc;
  }

  /** Replaces a tab's text with a minimal change, keeping cursor and scroll position. */
  replaceText(tab: string, text: string): void {
    const before = this.text(tab);
    if (before === text) return;
    const change = minimalChange(before, text);
    if (tab === this.current) {
      this.view.dispatch({ changes: change });
      return;
    }
    const entry = this.tabs.get(tab);
    if (entry) entry.state = entry.state.update({ changes: change }).state;
  }

  /** Moves a tab's editor to a new id (after Save As or saving a new file). */
  rename(from: string, to: string): void {
    const entry = this.tabs.get(from);
    if (!entry) return;
    this.tabs.delete(from);
    this.tabs.set(to, entry);
    if (this.current === from) this.current = to;
  }

  forget(tab: string): void {
    this.tabs.delete(tab);
    if (this.current === tab) this.current = undefined;
  }

  /** The source line at the top of the editor (1-based), for scroll sync. */
  topLine(): number {
    const block = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop);
    return this.view.state.doc.lineAt(block.from).number;
  }

  /** Applies changed settings (line numbers, wrapping) to the shown editor. */
  setOptions(options: EditorOptions): void {
    this.options = options;
    this.applyOptions();
  }

  private applyOptions(): void {
    this.view.dispatch({
      effects: [
        numbers.reconfigure(this.numbersExtension()),
        wrapping.reconfigure(this.options.wrapLines ? EditorView.lineWrapping : []),
      ],
    });
  }

  private numbersExtension(): Extension {
    // The gutter stays for lint markers later; only the numbers go.
    return this.options.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [];
  }

  private remember(): void {
    if (!this.current) return;
    const entry = this.tabs.get(this.current);
    if (entry) {
      entry.state = this.view.state;
      entry.scrollTop = this.view.scrollDOM.scrollTop;
    }
  }

  private extensions(): Extension[] {
    return [
      numbers.of(this.numbersExtension()),
      wrapping.of(this.options.wrapLines ? EditorView.lineWrapping : []),
      history(),
      drawSelection(),
      highlightSpecialChars(),
      highlightActiveLine(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      // Code fences get their language's highlighting (loaded on demand).
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      // Token classes (tok-*) styled in CSS, so colours follow light/dark mode.
      syntaxHighlighting(classHighlighter),
      appTheme,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && this.current) this.callbacks.changed(this.current);
      }),
      EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": "Markdown source" }),
    ];
  }
}
