import { describe, expect, it } from "vitest";
import { lineCount } from "./enhance";

describe("lineCount", () => {
  it("counts lines, ignoring a final newline", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\n\nb")).toBe(3);
  });
});
