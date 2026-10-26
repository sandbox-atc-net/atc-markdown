import { describe, expect, it } from "vitest";
import { applied, needsRerender, stepTextSize, type Settings } from "./settings";

export const defaults: Settings = {
  version: 1,
  appearance: { theme: "system", codeTheme: "github", textSize: 100, readingWidth: "medium", readingFont: "", codeFont: "", showOutline: false },
  wiki: {
    sidebarPosition: "left",
    sidebarVisible: true,
    sidebarWidth: 280,
    pageList: "collapsed",
    pageHeader: true,
    showFooter: true,
    offerOpenAsWiki: true,
  },
  files: { restoreSession: true, openFromOs: "newTab", autoReload: true },
  links: { statusBubble: true, confirmExternal: false, externalMarker: true },
  rendering: { frontMatter: "table", emoji: true, mermaid: true, math: true },
  code: { copyButton: "hover", wrapLines: false, lineNumbers: false },
  editor: { lineNumbers: true, wrapLines: true, defaultMode: "preview" },
  linting: { enabled: true, useProjectConfig: true, lineLength: 0, listIndent: 2, fixOnSave: false, previewFixes: true, rules: {} },
};

describe("applied", () => {
  it("follows the system theme unless one is chosen", () => {
    expect(applied(defaults, true).theme).toBe("dark");
    expect(applied(defaults, false).theme).toBe("light");
    const light = { ...defaults, appearance: { ...defaults.appearance, theme: "light" as const } };
    expect(applied(light, true).theme).toBe("light");
  });

  it("maps settings to classes and variables", () => {
    const a = applied(
      {
        ...defaults,
        appearance: { ...defaults.appearance, textSize: 125, readingWidth: "full", readingFont: "Georgia" },
        wiki: { ...defaults.wiki, sidebarPosition: "right", pageList: "hidden" },
        code: { copyButton: "off", wrapLines: true, lineNumbers: true },
      },
      false,
    );
    expect(a.vars["--zoom"]).toBe("1.25");
    expect(a.vars["--reading-width"]).toBe("none");
    expect(a.vars["--font-sans"]).toBe("Georgia, var(--font-sans-default)");
    expect(a.vars["--font-mono"]).toBeUndefined();
    expect(a.classes["sidebar-right"]).toBe(true);
    expect(a.classes["page-list-hidden"]).toBe(true);
    expect(a.classes["copy-button-off"]).toBe(true);
    expect(a.classes["wrap-code"]).toBe(true);
    // Line numbers can't line up with wrapped lines, so wrapping turns them off.
    expect(a.classes["line-numbers"]).toBe(false);
  });
});

describe("stepTextSize", () => {
  it("steps through the sizes and stops at the ends", () => {
    expect(stepTextSize(100, 1)).toBe(110);
    expect(stepTextSize(100, -1)).toBe(90);
    expect(stepTextSize(105, 1)).toBe(110);
    expect(stepTextSize(250, 1)).toBe(250);
    expect(stepTextSize(60, -1)).toBe(60);
  });
});

describe("needsRerender", () => {
  it("is true only for settings that change the rendered HTML", () => {
    const theme = { ...defaults, appearance: { ...defaults.appearance, theme: "dark" as const } };
    expect(needsRerender(defaults, theme)).toBe(false);
    const emoji = { ...defaults, rendering: { ...defaults.rendering, emoji: false } };
    expect(needsRerender(defaults, emoji)).toBe(true);
  });
});
