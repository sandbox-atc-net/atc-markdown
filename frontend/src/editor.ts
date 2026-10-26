// The Markdown editor (CodeMirror 6). One EditorView is shared; each tab has
// its own EditorState (text, selection, undo history), swapped in on show.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  diagnosticCount,
  forceLinting,
  linter,
  lintGutter,
  lintKeymap,
  openLintPanel,
  setDiagnosticsEffect,
  type Diagnostic,
} from "@codemirror/lint";
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
import { textChanges } from "./text-diff";

export interface EditorOptions {
  lineNumbers: boolean;
  wrapLines: boolean;
  /** Show lint issues (markdownlint rules). */
  lint: boolean;
}

/** A lint issue from `lint_source` (positions in UTF-16 units, like the editor). */
export interface LintIssue {
  rule: string;
  alias: string;
  message: string;
  line: number;
  from: number;
  to: number;
  fix: { from: number; to: number; insert: string }[] | null;
}

export interface EditorCallbacks {
  /** The text of the shown tab changed (typing, undo, paste…). */
  changed(tab: string): void;
  /** The editor scrolled (for scroll sync). */
  scrolled(tab: string): void;
  /** Lints a tab's text. */
  lint(tab: string, text: string): Promise<LintIssue[]>;
  /** Fixes all issues of these rules (all rules if empty) in a tab. */
  fixAll(tab: string, rules: string[]): void;
  /** The number of lint issues of the shown tab changed. */
  linted(tab: string, count: number): void;
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
  ".cm-tooltip": { backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "6px" },
  ".cm-tooltip-lint": { fontFamily: "var(--font-ui, system-ui)", fontSize: "13px", maxWidth: "520px" },
  ".cm-diagnostic": { padding: "6px 10px", borderLeftWidth: "4px" },
  ".cm-diagnosticSource": { color: "var(--muted)", opacity: "1" },
  ".cm-diagnosticAction": {
    backgroundColor: "var(--accent)",
    color: "#fff",
    borderRadius: "4px",
    padding: "1px 8px",
    font: "inherit",
    fontSize: "12px",
  },
  ".cm-panel.cm-panel-lint": { fontFamily: "var(--font-ui, system-ui)", fontSize: "13px" },
  ".cm-panel.cm-panel-lint ul": { maxHeight: "160px" },
  ".cm-panel.cm-panel-lint ul [aria-selected]": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)" },
  ".cm-panel.cm-panel-lint ul:focus [aria-selected]": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    color: "var(--fg)",
  },
  ".cm-panel.cm-panel-lint button[name=close]": { color: "var(--fg)" },
  ".cm-lintRange-warning": { backgroundSize: "auto" },
  ".cm-gutter-lint": { width: "1.2em" },
});

const numbers = new Compartment();
const wrapping = new Compartment();
const linting = new Compartment();

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

  /**
   * Replaces a tab's text with small changes (one undo step), so the cursor
   * and scroll position stay outside the lines that changed.
   */
  replaceText(tab: string, text: string): void {
    const before = this.text(tab);
    if (before === text) return;
    const change = textChanges(before, text);
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

  /** Applies changed settings (line numbers, wrapping, linting) to the shown editor. */
  setOptions(options: EditorOptions): void {
    this.options = options;
    this.applyOptions();
  }

  /** Lints the shown tab again now (after lint settings changed). */
  relint(): void {
    if (this.current && this.options.lint) forceLinting(this.view);
  }

  /** Number of lint issues in a tab (as last linted). */
  lintCount(tab: string): number {
    const state = tab === this.current ? this.view.state : this.tabs.get(tab)?.state;
    return state ? diagnosticCount(state) : 0;
  }

  /** Opens the list of lint issues below the editor. */
  openProblems(): void {
    if (!this.current) return;
    this.view.focus();
    openLintPanel(this.view);
  }

  private applyOptions(): void {
    this.view.dispatch({
      effects: [
        numbers.reconfigure(this.numbersExtension()),
        wrapping.reconfigure(this.options.wrapLines ? EditorView.lineWrapping : []),
        linting.reconfigure(this.lintExtension()),
      ],
    });
  }

  /** Lint underlines, gutter markers and the problems panel, while linting is on. */
  private lintExtension(): Extension {
    if (!this.options.lint) return [];
    return [
      linter(
        async (view) => {
          const tab = this.current;
          if (!tab) return [];
          const doc = view.state.doc;
          const issues = await this.callbacks.lint(tab, doc.toString());
          return issues.map((issue) => this.diagnostic(tab, doc, issue));
        },
        { delay: 400 },
      ),
      // Its own gutter, so the markers stay when line numbers are off.
      lintGutter(),
    ];
  }

  private diagnostic(tab: string, linted: Text, issue: LintIssue): Diagnostic {
    const actions: { name: string; apply: (view: EditorView) => void }[] = [];
    const fix = issue.fix;
    if (fix) {
      actions.push({
        name: "Fix",
        apply: (view) => {
          // Positions are from the linted text; if it changed since, lint again first.
          if (view.state.doc !== linted) {
            forceLinting(view);
            return;
          }
          view.dispatch({ changes: fix.map((e) => ({ from: e.from, to: e.to, insert: e.insert })), userEvent: "lint.fix" });
        },
      });
      actions.push({ name: `Fix all ${issue.rule}`, apply: () => this.callbacks.fixAll(tab, [issue.rule]) });
    }
    return {
      from: issue.from,
      to: issue.to,
      severity: "warning",
      message: issue.message,
      source: `${issue.rule}/${issue.alias}`,
      actions,
    };
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
      linting.of(this.lintExtension()),
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
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...lintKeymap, indentWithTab]),
      EditorView.updateListener.of((update) => {
        if (!this.current) return;
        if (update.docChanged) this.callbacks.changed(this.current);
        const linted = update.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect)));
        if (linted) {
          this.callbacks.linted(this.current, diagnosticCount(update.state));
        }
      }),
      EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": "Markdown source" }),
    ];
  }
}
