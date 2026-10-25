import { describe, expect, it } from "vitest";
import { parseSession, toSession } from "./session";
import { emptyTabs, openTab } from "./tabs";

const doc = (path: string) => ({ path, title: path, html: "" });

describe("toSession", () => {
  it("saves the paths and the active one", () => {
    const state = openTab(openTab(emptyTabs, doc("a.md")), doc("b.md"));
    expect(toSession(state)).toEqual({ paths: ["a.md", "b.md"], active: "b.md" });
  });

  it("saves an empty session", () => {
    expect(toSession(emptyTabs)).toEqual({ paths: [], active: null });
  });
});

describe("parseSession", () => {
  it("round-trips", () => {
    const session = { paths: ["a.md"], active: "a.md" };
    expect(parseSession(JSON.stringify(session))).toEqual(session);
  });

  it.each([null, "", "not json", "42", "null", '{"paths":"a"}', '{"paths":[1],"active":null}', '{"paths":[],"active":1}'])(
    "rejects %j",
    (raw) => {
      expect(parseSession(raw)).toBeUndefined();
    },
  );
});
