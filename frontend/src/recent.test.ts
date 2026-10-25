import { describe, expect, it } from "vitest";
import { parseRecent, remember, type RecentEntry } from "./recent";

const entry = (path: string): RecentEntry => ({ kind: "document", path, title: path });

describe("recent", () => {
  it("puts the newest first, without duplicates, up to the limit", () => {
    let list: RecentEntry[] = [];
    list = remember(list, entry("a.md"), 3);
    list = remember(list, entry("b.md"), 3);
    list = remember(list, entry("A.md"), 3);
    expect(list.map((e) => e.path)).toEqual(["A.md", "b.md"]);
    list = remember(list, entry("c.md"), 3);
    list = remember(list, entry("d.md"), 3);
    expect(list.map((e) => e.path)).toEqual(["d.md", "c.md", "A.md"]);
  });

  it("parses stored lists and drops bad entries", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("nope")).toEqual([]);
    expect(parseRecent('[{"kind":"wiki","path":"w","title":"W"},{"kind":"x"},5]')).toEqual([
      { kind: "wiki", path: "w", title: "W" },
    ]);
  });
});
