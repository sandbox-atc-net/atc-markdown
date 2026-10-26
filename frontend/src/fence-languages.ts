// Completing the language name after a code fence (```cs → csharp). The names
// come from the preview's highlighter (`code_languages`), popular ones first.

import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";

/** A fence name and the grammar it selects. */
export interface FenceLanguage {
  name: string;
  label: string;
}

/** Characters a fence language name is made of (`c#`, `c++`, `objective-c`, `f90`). */
export const FENCE_NAME = /^[\w#+.-]*$/;

/**
 * If the text before the cursor on its line is a code fence followed by the
 * start of a language name, the column where the name starts. Quotes and a list
 * marker may come before the fence (`> - ```js`).
 */
export function fenceNameStart(lineBefore: string): number | undefined {
  const match = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:`{3,}|~{3,})[ \t]*([\w#+.-]*)$/.exec(lineBefore);
  if (!match) return undefined;
  return lineBefore.length - (match[1] ?? "").length;
}

/**
 * The completion source: language names while typing after the fence that
 * opens a code block (not on a closing fence or inside code). Typing starts it;
 * right after the backticks only an explicit request (Ctrl+Space) does.
 */
export function completeFenceLanguage(context: CompletionContext, options: readonly Completion[]): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const start = fenceNameStart(line.text.slice(0, context.pos - line.from));
  if (start === undefined || options.length === 0) return null;
  if (start === context.pos - line.from && !context.explicit) return null;
  const inner = syntaxTree(context.state).resolveInner(context.pos, -1);
  let node: typeof inner | null = inner;
  while (node && node.name !== "FencedCode") node = node.parent;
  if (!node || context.state.doc.lineAt(node.from).number !== line.number) return null;
  return { from: line.from + start, options, validFor: FENCE_NAME };
}

/** Completion options for the language list, popular ones (listed first) ranked higher. */
export function fenceCompletions(languages: readonly FenceLanguage[]): Completion[] {
  return languages.map((language, index) => ({
    label: language.name,
    detail: language.label.toLowerCase() === language.name ? undefined : language.label,
    type: "type",
    // Popular names (listed first) rank higher among equally good matches. Kept
    // in 0..99: a full match scores 100 more than a prefix match, so the name
    // typed in full (`js`) always stays above a longer one (`json`).
    boost: Math.max(0, 50 - index),
  }));
}
