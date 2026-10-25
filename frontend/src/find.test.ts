import { describe, expect, it } from "vitest";
import { findMatches, foldCase } from "./find";

describe("findMatches", () => {
  it("finds nothing for an empty query", () => {
    expect(findMatches(["hello"], "")).toEqual([]);
  });

  it("finds matches inside one text, case-insensitively", () => {
    expect(findMatches(["Hello hello"], "HELLO")).toEqual([
      { start: { node: 0, offset: 0 }, end: { node: 0, offset: 5 } },
      { start: { node: 0, offset: 6 }, end: { node: 0, offset: 11 } },
    ]);
  });

  it("finds a match that spans several texts", () => {
    // e.g. "foo <strong>bar</strong>"
    expect(findMatches(["foo ", "bar"], "o b")).toEqual([
      { start: { node: 0, offset: 2 }, end: { node: 1, offset: 1 } },
    ]);
  });

  it("does not return overlapping matches", () => {
    expect(findMatches(["aaaa"], "aa")).toHaveLength(2);
  });

  it("starts and ends in the right text at boundaries, skipping empty texts", () => {
    expect(findMatches(["ab", "", "cd"], "cd")).toEqual([
      { start: { node: 2, offset: 0 }, end: { node: 2, offset: 2 } },
    ]);
    expect(findMatches(["ab", "", "cd"], "ab")).toEqual([
      { start: { node: 0, offset: 0 }, end: { node: 0, offset: 2 } },
    ]);
  });

  it("stops at the limit", () => {
    expect(findMatches(["a".repeat(100)], "a", 10)).toHaveLength(10);
  });

  it("keeps offsets right around characters whose lowercase is longer", () => {
    // "İ".toLowerCase() is two code units; it must not shift later offsets.
    expect(findMatches(["İx"], "x")).toEqual([
      { start: { node: 0, offset: 1 }, end: { node: 0, offset: 2 } },
    ]);
  });
});

describe("foldCase", () => {
  it("keeps the length", () => {
    const text = "Straße İstanbul ÆØÅ";
    expect(foldCase(text)).toHaveLength(text.length);
  });
});
