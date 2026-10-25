import { describe, expect, it } from "vitest";
import { activateTab, activeTab, closeTab, emptyTabs, openTab, updateTab, type OpenDocument } from "./tabs";

const doc = (path: string): OpenDocument => ({ path, title: path, html: `<p>${path}</p>` });

describe("tabs", () => {
  it("opens a document as the active tab", () => {
    const state = openTab(emptyTabs, doc("a.md"));
    expect(state.tabs).toHaveLength(1);
    expect(activeTab(state)?.path).toBe("a.md");
  });

  it("does not open the same path twice", () => {
    let state = openTab(emptyTabs, doc("C:\\docs\\a.md"));
    state = openTab(state, doc("b.md"));
    state = openTab(state, doc("c:\\DOCS\\a.md"));
    expect(state.tabs).toHaveLength(2);
    expect(state.activeIndex).toBe(0);
  });

  it("activates the previous tab when the last one is closed", () => {
    let state = openTab(openTab(emptyTabs, doc("a.md")), doc("b.md"));
    state = closeTab(state, 1);
    expect(activeTab(state)?.path).toBe("a.md");
  });

  it("keeps the same active document when an earlier tab is closed", () => {
    let state = openTab(openTab(openTab(emptyTabs, doc("a.md")), doc("b.md")), doc("c.md"));
    state = closeTab(state, 0);
    expect(activeTab(state)?.path).toBe("c.md");
  });

  it("returns to empty when the only tab is closed", () => {
    const state = closeTab(openTab(emptyTabs, doc("a.md")), 0);
    expect(state).toEqual(emptyTabs);
  });

  it("updates content without changing the active tab", () => {
    let state = openTab(openTab(emptyTabs, doc("a.md")), doc("b.md"));
    state = updateTab(state, { path: "a.md", title: "a.md", html: "<p>new</p>" });
    expect(state.activeIndex).toBe(1);
    expect(state.tabs[0]?.html).toBe("<p>new</p>");
  });

  it("ignores updates for documents that are not open", () => {
    const state = openTab(emptyTabs, doc("a.md"));
    expect(updateTab(state, doc("x.md"))).toBe(state);
  });

  it("ignores out-of-range indexes", () => {
    const state = openTab(emptyTabs, doc("a.md"));
    expect(closeTab(state, 5)).toBe(state);
    expect(activateTab(state, -1)).toBe(state);
  });
});
