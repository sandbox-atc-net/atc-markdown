import { describe, expect, it } from "vitest";
import { canGoBack, canGoForward, currentEntry, navigate, startHistory, step } from "./history";

describe("history", () => {
  it("starts at the first page with nowhere to go", () => {
    const h = startHistory("Home.md");
    expect(currentEntry(h)).toEqual({ path: "Home.md", scroll: 0 });
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it("goes back and forward, restoring scroll positions", () => {
    let h = startHistory("Home.md");
    h = navigate(h, "A.md", 120); // left Home at 120
    h = navigate(h, "B.md", 40); // left A at 40
    const back = step(h, -1, 300)!; // left B at 300
    expect(currentEntry(back)).toEqual({ path: "A.md", scroll: 40 });
    const home = step(back, -1, 40)!;
    expect(currentEntry(home)).toEqual({ path: "Home.md", scroll: 120 });
    expect(step(home, -1, 0)).toBeUndefined();
    const forward = step(step(home, 1, 120)!, 1, 40)!;
    expect(currentEntry(forward)).toEqual({ path: "B.md", scroll: 300 });
  });

  it("drops forward history when navigating somewhere new", () => {
    let h = startHistory("Home.md");
    h = navigate(h, "A.md", 0);
    h = step(h, -1, 0)!;
    h = navigate(h, "C.md", 0);
    expect(h.entries.map((e) => e.path)).toEqual(["Home.md", "C.md"]);
    expect(canGoForward(h)).toBe(false);
  });

  it("does not add an entry for the page already shown", () => {
    const h = navigate(startHistory("Home.md"), "home.md", 10);
    expect(h.entries).toHaveLength(1);
  });
});
