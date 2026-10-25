import { describe, expect, it } from "vitest";
import { filterPages, isInside, isSamePage, pageNameFromHref, pageUrl, relativeTime, titleFromPath } from "./wiki";

const pages = [
  { name: "Home", title: "Home", path: "C:\\w\\Home.md" },
  { name: "Working-with-Enums", title: "Working with Enums", path: "C:\\w\\Working-with-Enums.md" },
  { name: "Working-with-XML", title: "Working with XML", path: "C:\\w\\Working-with-XML.md" },
];

describe("wiki helpers", () => {
  it("reads page names from canonical hrefs", () => {
    expect(pageNameFromHref("Working-with-Enums#values")).toBe("Working-with-Enums");
    expect(pageNameFromHref("Working-with-C%23-Client")).toBe("Working-with-C#-Client");
    expect(pageNameFromHref("https://example.com")).toBeUndefined();
    expect(pageNameFromHref("#top")).toBeUndefined();
    expect(isSamePage("working-with-enums", "Working-with-Enums")).toBe(true);
  });

  it("filters pages by every word", () => {
    expect(filterPages(pages, "with xml").map((p) => p.name)).toEqual(["Working-with-XML"]);
    expect(filterPages(pages, "  ")).toHaveLength(3);
    expect(filterPages(pages, "nope")).toEqual([]);
  });

  it("builds github.com page addresses", () => {
    const url = "https://github.com/atc-net/x/wiki";
    expect(pageUrl(url, "Home")).toBe(url);
    expect(pageUrl(url, "Working-with-Enums")).toBe(`${url}/Working-with-Enums`);
    expect(pageUrl(null, "Home")).toBeUndefined();
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 9, 25, 12);
    const ago = (ms: number) => relativeTime(now - ms, now);
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 minutes ago");
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(24 * 3_600_000)).toBe("yesterday");
    expect(ago(3 * 24 * 3_600_000)).toBe("3 days ago");
    expect(ago(65 * 24 * 3_600_000)).toBe("2 months ago");
    expect(ago(400 * 24 * 3_600_000)).toBe("1 year ago");
  });

  it("checks folder membership and titles", () => {
    expect(isInside("C:\\w", "c:/W/Home.md")).toBe(true);
    expect(isInside("C:\\w", "C:\\wiki\\Home.md")).toBe(false);
    expect(titleFromPath("C:\\w\\Working-with-Enums.md")).toBe("Working with Enums");
  });
});
