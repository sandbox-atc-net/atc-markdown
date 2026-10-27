import { describe, expect, it } from "vitest";
import {
  allFolders,
  ancestors,
  countFiles,
  findEntry,
  jumpTo,
  relativeTo,
  visibleRows,
  type FolderEntry,
  type RowOptions,
} from "./folder-tree";

const file = (relative: string): FolderEntry => ({
  name: relative.split("/").pop()!,
  path: `C:\\repo\\${relative.replace(/\//g, "\\")}`,
  relative,
});
const folder = (relative: string, children: FolderEntry[], wiki = false): FolderEntry => ({
  ...file(relative),
  children,
  ...(wiki ? { wiki } : {}),
});

// docs/guides/api/overview.md is a chain of single folders.
const tree: FolderEntry[] = [
  folder("docs", [
    folder("docs/guides", [folder("docs/guides/api", [file("docs/guides/api/overview.md")])]),
    file("docs/2-setup.md"),
    file("docs/10-deploy.md"),
  ]),
  folder("plans", [file("plans/roadmap.md")]),
  file("README.md"),
];

const options = (o: Partial<RowOptions> = {}): RowOptions => ({ expanded: new Set(), filter: "", compact: true, ...o });
const labels = (o: Partial<RowOptions>) => visibleRows(tree, options(o)).map((r) => `${"  ".repeat(r.depth)}${r.label}`);

describe("visibleRows", () => {
  it("shows only the top level while folders are closed", () => {
    expect(labels({})).toEqual(["docs", "plans", "README.md"]);
  });

  it("shows the children of expanded folders", () => {
    expect(labels({ expanded: new Set(["docs", "plans"]) })).toEqual([
      "docs",
      "  guides/api",
      "  2-setup.md",
      "  10-deploy.md",
      "plans",
      "  roadmap.md",
      "README.md",
    ]);
  });

  it("puts a chain of single folders on one row, opened by its last folder", () => {
    const rows = visibleRows(tree, options({ expanded: new Set(["docs", "docs/guides/api"]) }));
    expect(rows[1]).toMatchObject({ label: "guides/api", expanded: true, entry: { relative: "docs/guides/api" } });
    expect(rows[2]?.label).toBe("overview.md");
    expect(rows[2]?.depth).toBe(2);
  });

  it("shows every folder on its own row without compact folders", () => {
    expect(labels({ compact: false, expanded: new Set(["docs", "docs/guides"]) }).slice(0, 3)).toEqual([
      "docs",
      "  guides",
      "    api",
    ]);
  });

  it("filters by every word of the path and opens what is left", () => {
    expect(labels({ filter: "api over" })).toEqual(["docs/guides/api", "  overview.md"]);
    expect(labels({ filter: "ROAD" })).toEqual(["plans", "  roadmap.md"]);
    expect(labels({ filter: "nothing" })).toEqual([]);
    expect(countFiles(tree)).toBe(5);
    expect(countFiles(tree, "md docs")).toBe(3);
  });
});

describe("paths", () => {
  it("lists the folders above a file", () => {
    expect(ancestors("docs/guides/api/overview.md")).toEqual(["docs", "docs/guides", "docs/guides/api"]);
    expect(ancestors("README.md")).toEqual([]);
  });

  it("finds the path below the root, ignoring case and separators", () => {
    expect(relativeTo("C:\\repo", "C:\\Repo\\docs\\a.md")).toBe("docs/a.md");
    expect(relativeTo("C:/repo/", "C:/repo/a.md")).toBe("a.md");
    expect(relativeTo("C:\\repo", "C:\\repo2\\a.md")).toBeUndefined();
    expect(relativeTo("C:\\repo", "C:\\repo")).toBeUndefined();
  });

  it("finds entries and lists folders", () => {
    expect(findEntry(tree, "DOCS/2-setup.md")?.name).toBe("2-setup.md");
    expect(findEntry(tree, "docs/guides/api")?.children).toHaveLength(1);
    expect(findEntry(tree, "docs/missing.md")).toBeUndefined();
    expect(allFolders(tree)).toEqual(["docs", "docs/guides", "docs/guides/api", "plans"]);
  });
});

describe("jumpTo", () => {
  const rows = visibleRows(tree, options({ expanded: new Set(["docs", "plans"]) }));
  // docs, guides/api, 2-setup.md, 10-deploy.md, plans, roadmap.md, README.md
  it("moves to the next row starting with the typed letters", () => {
    expect(jumpTo(rows, 0, "r")).toBe(5);
    expect(jumpTo(rows, 5, "r")).toBe(6);
    expect(jumpTo(rows, 6, "r")).toBe(5);
    expect(jumpTo(rows, 5, "rea")).toBe(6);
    expect(jumpTo(rows, 5, "roa")).toBe(5);
    expect(jumpTo(rows, 0, "rr")).toBe(5);
    expect(jumpTo(rows, 0, "x")).toBeUndefined();
    expect(jumpTo(rows, -1, "d")).toBe(0);
  });
});
