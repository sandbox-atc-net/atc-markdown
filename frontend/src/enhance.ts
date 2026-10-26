// Adds interactive bits to rendered Markdown after it is inserted: a copy
// button and a language label on code blocks. Runs after every render.
//
// The button is icon-only and the label is a CSS pseudo-element, so neither
// adds text to the document: Find doesn't match them and selecting across a
// code block copies only the code.

const COPY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

/** Copies text to the clipboard, with a fallback for when the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** The fence name of a code block, from comrak's `language-xxx` class. */
export function codeLanguage(code: Element): string | undefined {
  for (const name of code.classList) {
    if (name.startsWith("language-")) return name.slice("language-".length) || undefined;
  }
  return undefined;
}

/** Number of lines in a code block (a final newline doesn't start a new line). */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Wraps each code block and adds the copy button and language label. */
export function enhanceCodeBlocks(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre")) {
    const code = pre.querySelector("code");
    if (!code || pre.parentElement?.classList.contains("code-block")) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const language = codeLanguage(code);
    if (language) wrapper.dataset.lang = language;
    pre.replaceWith(wrapper);
    wrapper.append(pre);

    // Line-number gutter (shown only when the setting is on).
    const lines = lineCount(code.textContent ?? "");
    if (lines > 0) {
      const gutter = document.createElement("div");
      gutter.className = "line-numbers";
      gutter.setAttribute("aria-hidden", "true");
      gutter.append(...Array.from({ length: lines }, () => document.createElement("span")));
      wrapper.classList.add("numbered");
      wrapper.append(gutter);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.title = "Copy";
    button.setAttribute("aria-label", "Copy code");
    // Static markup; no document content.
    button.innerHTML = COPY_ICON;
    let reset: number | undefined;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      void copyText(code.textContent ?? "").then(() => {
        button.innerHTML = CHECK_ICON;
        button.classList.add("copied");
        button.title = "Copied!";
        window.clearTimeout(reset);
        reset = window.setTimeout(() => {
          button.innerHTML = COPY_ICON;
          button.classList.remove("copied");
          button.title = "Copy";
        }, 1500);
      });
    });
    wrapper.append(button);
  }
}

/** Everything that runs after a document's HTML is inserted. */
export function enhance(root: HTMLElement): void {
  enhanceCodeBlocks(root);
}

export interface RichOptions {
  mermaid: boolean;
  math: boolean;
  dark: boolean;
}

let diagramCounter = 0;
let mermaidTheme: string | undefined;
/** Drawn diagrams by theme + source, so live editing only redraws what changed. */
const diagramCache = new Map<string, string>();
const MAX_CACHED_DIAGRAMS = 100;

/**
 * Renders Mermaid diagrams and math, loading each library only when the
 * document needs it. Resolves to true if anything changed the page height.
 */
export async function enhanceRich(root: HTMLElement, options: RichOptions): Promise<boolean> {
  const [diagrams, math] = await Promise.all([
    options.mermaid ? renderDiagrams(root, options.dark) : Promise.resolve(false),
    options.math ? renderMath(root) : Promise.resolve(false),
  ]);
  return diagrams || math;
}

async function renderDiagrams(root: HTMLElement, dark: boolean): Promise<boolean> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".code-block")].filter((block) =>
    block.querySelector("code.language-mermaid"),
  );
  if (blocks.length === 0) return false;

  const { default: mermaid } = await import("mermaid");
  const theme = dark ? "dark" : "default";
  if (mermaidTheme !== theme) {
    // 'strict': no HTML labels, no click handlers — the SVG is the only HTML
    // that does not come through the Rust sanitizer.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    mermaidTheme = theme;
  }

  let changed = false;
  for (const block of blocks) {
    const source = block.querySelector("code")?.textContent ?? "";
    const key = `${theme}\n${source}`;
    try {
      let svg = diagramCache.get(key);
      if (svg === undefined) {
        diagramCounter += 1;
        svg = (await mermaid.render(`mermaid-${diagramCounter}`, source)).svg;
        if (diagramCache.size >= MAX_CACHED_DIAGRAMS) {
          const oldest = diagramCache.keys().next().value;
          if (oldest !== undefined) diagramCache.delete(oldest);
        }
        diagramCache.set(key, svg);
      }
      // The user may have switched tabs while it rendered.
      if (!block.isConnected) continue;
      const figure = document.createElement("div");
      figure.className = "mermaid-diagram";
      // Keep the source position for the editor's scroll sync.
      const position = block.querySelector<HTMLElement>("pre")?.dataset.sourcepos;
      if (position) figure.dataset.sourcepos = position;
      figure.innerHTML = svg;
      block.replaceWith(figure);
      changed = true;
    } catch (error) {
      if (!block.isConnected) continue;
      const note = document.createElement("p");
      note.className = "mermaid-error";
      note.textContent = `Diagram could not be drawn: ${error instanceof Error ? error.message : String(error)}`;
      block.after(note);
    }
  }
  return changed;
}

async function renderMath(root: HTMLElement): Promise<boolean> {
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-math-style]")];
  if (nodes.length === 0) return false;
  const [{ default: katex }] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
  for (const node of nodes) {
    if (!node.isConnected) continue;
    const source = node.textContent ?? "";
    // HTML output only (no hidden MathML copy, which Find would match twice);
    // `trust: false` keeps \href, \url and friends from creating links.
    katex.render(source, node, {
      displayMode: node.dataset.mathStyle === "display",
      throwOnError: false,
      trust: false,
      output: "html",
    });
    node.removeAttribute("data-math-style");
  }
  return true;
}
