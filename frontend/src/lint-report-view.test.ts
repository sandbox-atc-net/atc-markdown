import { describe, expect, it } from "vitest";
import { type FileLint, type FolderLint, visibleFiles } from "./lint-report-view";

const issue = (rule: string, line: number) => ({ rule, message: "m", line, column: 1, fixable: false });
const file = (relative: string, issues: FileLint["issues"], ruleCounts?: Record<string, number>): FileLint => {
  const counts = ruleCounts ?? {};
  if (!ruleCounts) for (const i of issues) counts[i.rule] = (counts[i.rule] ?? 0) + 1;
  return {
    path: `C:/docs/${relative}`,
    relative,
    issues,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    ruleCounts: counts,
    error: null,
  };
};

const report: FolderLint = {
  root: "C:/docs",
  scanned: 4,
  truncated: false,
  configErrors: [],
  rules: [],
  files: [
    file("a.md", [issue("MD009", 1), issue("MD009", 2), issue("MD010", 3)]),
    file("b.md", [issue("MD010", 1)]),
    // Capped: only one issue listed, 500 counted.
    file("capped.md", [issue("MD022", 1)], { MD022: 300, MD009: 200 }),
    { ...file("binary.md", []), error: "not UTF-8" },
  ],
};

describe("visibleFiles", () => {
  it("lists every file with its total without a filter", () => {
    expect(visibleFiles(report, null).map((v) => [v.file.relative, v.count])).toEqual([
      ["a.md", 3],
      ["b.md", 1],
      ["capped.md", 500],
      ["binary.md", 0],
    ]);
  });

  it("with a rule, only the files that have it, with all of their issues counted", () => {
    expect(visibleFiles(report, "MD009").map((v) => [v.file.relative, v.count])).toEqual([
      ["a.md", 2],
      ["capped.md", 200],
    ]);
    expect(visibleFiles(report, "MD047")).toEqual([]);
  });
});
