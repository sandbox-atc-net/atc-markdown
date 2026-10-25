import { describe, expect, it } from "vitest";
import { describeLink, middleEllipsis, relativeTo, splitUrl, spoofWarning, type LinkContext } from "./links";

const ctx: LinkContext = {
  linkText: "click",
  documentDir: "C:\\docs",
  isOpen: (path) => path === "C:\\docs\\open.md",
  headingText: (id) => (id === "install" ? "Installation" : undefined),
  isMac: false,
};

describe("describeLink", () => {
  it("describes web links with the host in bold", () => {
    const content = describeLink({ kind: "external", url: "https://github.com/atc-net/x", exists: true }, ctx);
    expect(content.icon).toBe("globe");
    expect(content.action).toBe("Open in browser");
    expect(content.target).toEqual({ before: "https://", strong: "github.com", after: "/atc-net/x" });
    expect(content.warning).toBeUndefined();
  });

  it("describes mail links", () => {
    const content = describeLink({ kind: "external", url: "mailto:a%40b.dk?subject=x", exists: true }, ctx);
    expect(content).toMatchObject({ icon: "mail", target: { before: "a@b.dk" } });
  });

  it("describes documents relative to the current folder", () => {
    const content = describeLink(
      { kind: "document", path: "C:\\docs\\guide\\deploy.md", fragment: "steps", exists: true },
      ctx,
    );
    expect(content).toMatchObject({ icon: "file", action: "Open in new tab", target: { before: "guide/deploy.md#steps" } });
    expect(content.problem).toBeUndefined();
  });

  it("says when a document is already open or missing", () => {
    expect(describeLink({ kind: "document", path: "C:\\docs\\open.md", fragment: null, exists: true }, ctx).action).toBe(
      "Switch to tab",
    );
    expect(describeLink({ kind: "document", path: "C:\\docs\\gone.md", fragment: null, exists: false }, ctx).problem).toBe(
      "not found",
    );
  });

  it("describes wiki pages by title", () => {
    const wiki = { ...ctx, wikiRoot: "C:\\w" };
    const page = { kind: "document", path: "C:\\w\\Working-with-Enums.md", fragment: "values", exists: true } as const;
    expect(describeLink(page, wiki)).toMatchObject({ action: "Go to wiki page", target: { before: "Working with Enums#values" } });
    expect(describeLink({ ...page, exists: false }, wiki).problem).toBe("page not found");
    // Outside the wiki it is an ordinary document.
    expect(describeLink({ ...page, path: "C:\\other\\a.md" }, wiki).action).toBe("Open in new tab");
  });

  it("names the file manager per platform", () => {
    const target = { kind: "localFile", path: "C:\\docs\\a.pdf", exists: true } as const;
    expect(describeLink(target, ctx).action).toBe("Show in Explorer");
    expect(describeLink(target, { ...ctx, isMac: true }).action).toBe("Show in Finder");
  });

  it("uses the heading text for anchors", () => {
    expect(describeLink({ kind: "anchor", id: "install", exists: true }, ctx).target.before).toBe("“Installation”");
    expect(describeLink({ kind: "anchor", id: "nope", exists: true }, ctx).problem).toBe("no such section");
  });

  it("marks blocked links", () => {
    expect(describeLink({ kind: "unsupported", exists: true }, ctx)).toMatchObject({ icon: "blocked", action: "Blocked link" });
  });
});

describe("spoofWarning", () => {
  it("warns when the text names another site", () => {
    expect(spoofWarning("microsoft.com", "https://micros0ft.example/login")).toContain("micros0ft.example");
    expect(spoofWarning("https://www.github.com/x", "https://evil.io")).toContain("evil.io");
  });

  it("accepts the same site and its subdomains", () => {
    expect(spoofWarning("github.com", "https://github.com/a")).toBeUndefined();
    expect(spoofWarning("github.com", "https://www.github.com")).toBeUndefined();
    expect(spoofWarning("github.com", "https://docs.github.com/x")).toBeUndefined();
    expect(spoofWarning("the docs", "https://anything.example")).toBeUndefined();
  });

  it("warns about punycode hosts", () => {
    expect(spoofWarning("click", "https://xn--pple-43d.com")).toContain("look-alike");
  });
});

describe("helpers", () => {
  it("shortens in the middle", () => {
    expect(middleEllipsis("abcdefghij", 5)).toBe("ab…ij");
    expect(middleEllipsis("short", 10)).toBe("short");
  });

  it("makes paths relative only inside the folder", () => {
    expect(relativeTo("C:\\docs", "C:\\Docs\\a\\b.md")).toBe("a/b.md");
    expect(relativeTo("C:\\docs", "C:\\docsx\\b.md")).toBe("C:\\docsx\\b.md");
    expect(relativeTo("/home/u", "/home/u/r.md")).toBe("r.md");
  });

  it("keeps the host whole when shortening a URL", () => {
    const long = `https://example.com/${"x".repeat(200)}`;
    const parts = splitUrl(long);
    expect(parts.strong).toBe("example.com");
    expect(parts.after).toContain("…");
  });
});
