import { describe, expect, it } from "vitest";
import { parseSession, startupState, toSession } from "./session";
import { emptyTabs, openTab, type OpenDocument } from "./tabs";
import { startHistory } from "./history";

const doc = (path: string): OpenDocument => ({ path, title: path, html: "" });

const wikiTab = (root: string, page: string): OpenDocument => ({
  path: root,
  title: "wiki",
  html: "",
  wiki: {
    info: { root, name: "wiki", home: page, pages: [], url: null, sidebar: null, footer: null },
    page: { path: page, name: "Home", title: "Home", html: "", missingLinks: [], modifiedMs: null },
    sidebar: null,
    footer: null,
    history: startHistory(page),
  },
});

describe("toSession", () => {
  it("saves documents, wikis and the active tab", () => {
    const state = openTab(openTab(emptyTabs, doc("a.md")), wikiTab("C:/w", "C:/w/Home.md"));
    expect(toSession(state)).toEqual({
      tabs: [
        { kind: "document", path: "a.md" },
        { kind: "wiki", root: "C:/w", page: "C:/w/Home.md" },
      ],
      active: "C:/w",
    });
  });

  it("saves an empty session", () => {
    expect(toSession(emptyTabs)).toEqual({ tabs: [], active: null });
  });
});

describe("parseSession", () => {
  it("round-trips", () => {
    const session = {
      tabs: [
        { kind: "document" as const, path: "a.md" },
        { kind: "wiki" as const, root: "w", page: "w/Home.md" },
      ],
      active: "a.md",
    };
    expect(parseSession(JSON.stringify(session))).toEqual(session);
  });

  it("reads the first format", () => {
    expect(parseSession('{"paths":["a.md","b.md"],"active":"b.md"}')).toEqual({
      tabs: [
        { kind: "document", path: "a.md" },
        { kind: "document", path: "b.md" },
      ],
      active: "b.md",
    });
  });

  it.each([
    null,
    "",
    "not json",
    "42",
    "null",
    '{"paths":"a"}',
    '{"paths":[1],"active":null}',
    '{"paths":[],"active":1}',
    '{"tabs":[{"kind":"wiki","root":"w"}],"active":null}',
    '{"tabs":[{"kind":"other"}],"active":null}',
  ])("rejects %j", (raw) => {
    expect(parseSession(raw)).toBeUndefined();
  });
});

describe("startupState", () => {
  it("restores tabs and the active one", () => {
    const state = startupState([doc("a.md"), undefined, doc("b.md")], "a.md", []);
    expect(state.tabs.map((t) => t.path)).toEqual(["a.md", "b.md"]);
    expect(state.activeIndex).toBe(0);
  });

  it("makes the file the app was started with the active tab", () => {
    const state = startupState([doc("a.md"), doc("b.md")], "a.md", [doc("c.md"), doc("d.md")]);
    expect(state.tabs.map((t) => t.path)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(state.activeIndex).toBe(3);
  });

  it("activates an already restored file when it is opened again", () => {
    const state = startupState([doc("a.md"), doc("b.md")], "b.md", [doc("A.md")]);
    expect(state.tabs).toHaveLength(2);
    expect(state.activeIndex).toBe(0);
  });
});
