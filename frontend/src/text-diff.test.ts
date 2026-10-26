import { describe, expect, it } from "vitest";
import { minimalChange, textChanges, type Change } from "./text-diff";

/** Applies changes (positions in the original text) back to front. */
function apply(text: string, changes: readonly Change[]): string {
  let out = text;
  for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

describe("minimalChange", () => {
  it("replaces only the part that differs", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("abc", "abc")).toEqual({ from: 3, to: 3, insert: "" });
    expect(minimalChange("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(minimalChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
  });
});

describe("textChanges", () => {
  it("keeps far-apart fixes separate, so text between them is untouched", () => {
    const before = "# Title\n\nline 3   \n" + "text\n".repeat(40) + "last";
    const after = "# Title\n\nline 3\n" + "text\n".repeat(40) + "last\n";
    const changes = textChanges(before, after);
    expect(changes).toEqual([
      { from: 15, to: 18, insert: "" },
      { from: before.length, to: before.length, insert: "\n" },
    ]);
    expect(apply(before, changes)).toBe(after);
  });

  it("handles inserted and deleted lines", () => {
    const cases: [string, string][] = [
      ["a\nb\nc\n", "a\n\nb\nc\n"],
      ["a\n\n\n\nb\n", "a\n\nb\n"],
      ["", "x\n"],
      ["x\n", ""],
      ["same\n", "same\n"],
      ["a\nb\nc\nd\ne\n", "e\nd\nc\nb\na\n"],
      ["* a\n- b\n+ c\n", "* a\n* b\n* c\n"],
    ];
    for (const [before, after] of cases) expect(apply(before, textChanges(before, after))).toBe(after);
  });

  it("falls back to one change when almost everything differs", () => {
    const before = Array.from({ length: 50 }, (_, i) => `old ${i}\n`).join("");
    const after = Array.from({ length: 50 }, (_, i) => `new ${i}\n`).join("");
    const changes = textChanges(before, after, 10);
    expect(changes).toHaveLength(1);
    expect(apply(before, changes)).toBe(after);
  });

  it("produces the same text for random edits", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const words = ["a", "b", "c", "", "  ", "x y"];
    const lines = (n: number) => Array.from({ length: n }, () => `${words[Math.floor(random() * words.length)]}\n`);
    for (let i = 0; i < 200; i++) {
      const before = lines(Math.floor(random() * 12)).join("");
      const after = lines(Math.floor(random() * 12)).join("") + (random() < 0.3 ? "tail" : "");
      expect(apply(before, textChanges(before, after))).toBe(after);
    }
  });
});
