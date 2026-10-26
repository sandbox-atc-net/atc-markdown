import { describe, expect, it } from "vitest";
import { minimalChange } from "./editor";
import { parseSourcePos, previewScrollFor, type Block } from "./scroll-sync";

const blocks: Block[] = [
  { startLine: 1, endLine: 1, top: 0, height: 40 }, // # Title
  { startLine: 3, endLine: 6, top: 60, height: 80 }, // paragraph, 4 lines
  { startLine: 10, endLine: 19, top: 200, height: 200 }, // code block, 10 lines
];

describe("scroll sync", () => {
  it("parses source positions", () => {
    expect(parseSourcePos("3:1-7:3")).toEqual([3, 7]);
    expect(parseSourcePos("nope")).toBeUndefined();
    expect(parseSourcePos(undefined)).toBeUndefined();
  });

  it("interpolates inside a block", () => {
    expect(previewScrollFor(blocks, 3)).toBe(60);
    expect(previewScrollFor(blocks, 5)).toBe(100);
    expect(previewScrollFor(blocks, 15)).toBe(300);
  });

  it("handles lines between blocks, at the top and past the end", () => {
    expect(previewScrollFor(blocks, 1)).toBe(0);
    // Line 8 is between the paragraph (ends 6, bottom 140) and the code (starts 10, top 200).
    expect(previewScrollFor(blocks, 8)).toBe(140 + (200 - 140) * 0.5);
    expect(previewScrollFor(blocks, 40)).toBe(400);
    expect(previewScrollFor([], 10)).toBe(0);
  });
});

describe("minimalChange", () => {
  it("replaces only the part that differs", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("abc", "abc")).toEqual({ from: 3, to: 3, insert: "" });
    expect(minimalChange("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(minimalChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
  });
});
