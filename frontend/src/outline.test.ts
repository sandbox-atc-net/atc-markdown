import { describe, expect, it } from "vitest";
import { currentIndex, indentLevels } from "./outline";

describe("outline", () => {
  it("indents relative to the top level present", () => {
    const items = [2, 3, 3, 2, 4].map((level, i) => ({ id: `h${i}`, text: "", level }));
    expect(indentLevels(items)).toEqual([0, 1, 1, 0, 2]);
  });

  it("finds the heading being read", () => {
    expect(currentIndex([], 80)).toBe(-1);
    expect(currentIndex([200, 500], 80)).toBe(0); // above the first heading: the first one
    expect(currentIndex([-300, 40, 500], 80)).toBe(1);
    expect(currentIndex([-900, -400, -10], 80)).toBe(2);
  });
});
