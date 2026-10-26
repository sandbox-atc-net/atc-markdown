import { CompletionContext } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { completeFenceLanguage, fenceCompletions, fenceNameStart } from "./fence-languages";

const OPTIONS = fenceCompletions([
  { name: "bash", label: "Bourne Again Shell (bash)" },
  { name: "csharp", label: "C#" },
]);

/** Completes at `|` in the text; returns the start of the replaced name, or null. */
function completeAt(textWithCursor: string, explicit = false): number | null {
  const pos = textWithCursor.indexOf("|");
  const doc = textWithCursor.replace("|", "");
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  return completeFenceLanguage(new CompletionContext(state, pos, explicit), OPTIONS)?.from ?? null;
}

describe("completeFenceLanguage", () => {
  it("offers names on the line that opens a code block", () => {
    expect(completeAt("text\n\n```cs|\ncode\n```\n")).toBe(9);
    expect(completeAt("```c|")).toBe(3);
    expect(completeAt("> ```b|\n> x\n")).toBe(5);
    expect(completeAt("- item\n\n  ~~~c|\n")).toBe(13);
  });

  it("right after the backticks only when asked", () => {
    expect(completeAt("```|\ncode\n```\n")).toBeNull();
    expect(completeAt("```|\ncode\n```\n", true)).toBe(3);
  });

  it("not on a closing fence, in code or in text", () => {
    expect(completeAt("```\ncode\n```b|\n```\n")).toBeNull();
    expect(completeAt("```js\n```c|\n```\n", true)).toBeNull();
    expect(completeAt("Use ```c| here\n")).toBeNull();
    expect(completeAt("    ```c|\n")).toBeNull();
  });
});

describe("fenceNameStart", () => {
  it("finds the language name after an opening fence", () => {
    expect(fenceNameStart("```")).toBe(3);
    expect(fenceNameStart("```cs")).toBe(3);
    expect(fenceNameStart("~~~~ py")).toBe(5);
    expect(fenceNameStart("  ```c#")).toBe(5);
    expect(fenceNameStart("> > ```ts")).toBe(7);
    expect(fenceNameStart("- ```objective-c")).toBe(5);
    expect(fenceNameStart("10. ```")).toBe(7);
  });

  it("ignores lines that are not a fence", () => {
    expect(fenceNameStart("``")).toBeUndefined();
    expect(fenceNameStart("text ```js")).toBeUndefined();
    expect(fenceNameStart("```js title")).toBeUndefined();
    expect(fenceNameStart("```js{1,3}")).toBeUndefined();
  });
});

describe("fenceCompletions", () => {
  it("keeps the order and shows the grammar when it differs from the name", () => {
    const options = fenceCompletions([
      { name: "bash", label: "Bourne Again Shell (bash)" },
      { name: "csharp", label: "C#" },
      { name: "lua", label: "Lua" },
    ]);
    expect(options.map((o) => o.label)).toEqual(["bash", "csharp", "lua"]);
    expect(options[1]?.detail).toBe("C#");
    expect(options[2]?.detail).toBeUndefined();
    expect((options[0]?.boost ?? 0) > (options[1]?.boost ?? 0)).toBe(true);
  });

  it("keeps boosts below the gap between a full and a prefix match", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `n${i}`, label: `L${i}` }));
    for (const option of fenceCompletions(many)) {
      expect(option.boost).toBeGreaterThanOrEqual(0);
      expect(option.boost).toBeLessThan(100);
    }
  });
});
