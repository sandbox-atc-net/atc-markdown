import { describe, expect, it } from "vitest";
import { parseSourcePos, previewScrollFor, sourceLineFor, type Block } from "./scroll-sync";

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
    // Lines 7–9 are between the paragraph (ends 6, bottom 140) and the code (starts 10, top 200).
    expect(previewScrollFor(blocks, 7)).toBe(140);
    expect(previewScrollFor(blocks, 8.5)).toBe(140 + (200 - 140) * 0.5);
    expect(previewScrollFor(blocks, 40)).toBe(400);
    expect(previewScrollFor([], 10)).toBe(0);
  });
});

describe("sourceLineFor", () => {
  it("is the inverse of previewScrollFor inside blocks and between them", () => {
    for (const line of [1, 3, 4.5, 6, 7, 8, 9.5, 10, 15, 19.9]) {
      expect(sourceLineFor(blocks, previewScrollFor(blocks, line))).toBeCloseTo(line, 6);
    }
  });

  it("handles the top, the end and an empty preview", () => {
    expect(sourceLineFor(blocks, 0)).toBe(1);
    expect(sourceLineFor(blocks, 5000)).toBe(20);
    expect(sourceLineFor([], 300)).toBe(1);
    // Front matter first: the first block starts further down.
    expect(sourceLineFor([{ startLine: 5, endLine: 5, top: 30, height: 20 }], 10)).toBe(1);
  });
});
