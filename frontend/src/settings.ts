// User settings: types mirroring `src-tauri/src/settings.rs`, and the pure
// mapping from settings to what the page applies (theme, CSS classes, variables).

export type Theme = "system" | "light" | "dark";
export type ReadingWidth = "medium" | "narrow" | "wide" | "full";
export type Side = "left" | "right";
export type PageList = "collapsed" | "expanded" | "hidden";
export type OpenIn = "newTab" | "replaceCurrent";
export type CopyButton = "hover" | "always" | "off";
export type FrontMatterStyle = "table" | "hidden" | "raw";

export interface Settings {
  version: number;
  appearance: {
    theme: Theme;
    codeTheme: string;
    textSize: number;
    readingWidth: ReadingWidth;
    readingFont: string;
    codeFont: string;
    showOutline: boolean;
  };
  wiki: {
    sidebarPosition: Side;
    sidebarVisible: boolean;
    sidebarWidth: number;
    pageList: PageList;
    pageHeader: boolean;
    showFooter: boolean;
    offerOpenAsWiki: boolean;
  };
  files: { restoreSession: boolean; openFromOs: OpenIn; autoReload: boolean };
  links: { statusBubble: boolean; confirmExternal: boolean; externalMarker: boolean };
  rendering: { frontMatter: FrontMatterStyle; emoji: boolean; mermaid: boolean; math: boolean };
  code: { copyButton: CopyButton; wrapLines: boolean; lineNumbers: boolean };
}

/** A partial update, as sent to `update_settings`. */
export type SettingsChanges = { [S in keyof Settings]?: Settings[S] extends object ? Partial<Settings[S]> : never };

export interface Applied {
  /** The resolved colour theme (`system` follows the OS). */
  theme: "light" | "dark";
  /** Classes toggled on `<body>`. */
  classes: Record<string, boolean>;
  /** CSS variables set on `<html>`. */
  vars: Record<string, string>;
}

const WIDTHS: Record<ReadingWidth, string> = {
  narrow: "720px",
  medium: "900px",
  wide: "1200px",
  full: "none",
};

/** What the page should look like for these settings. */
export function applied(settings: Settings, systemDark: boolean): Applied {
  const { appearance, wiki, links, code } = settings;
  const theme = appearance.theme === "system" ? (systemDark ? "dark" : "light") : appearance.theme;
  const vars: Record<string, string> = {
    "--zoom": String(appearance.textSize / 100),
    "--reading-width": WIDTHS[appearance.readingWidth],
    "--sidebar-width": `${wiki.sidebarWidth}px`,
  };
  if (appearance.readingFont) vars["--font-sans"] = `${appearance.readingFont}, var(--font-sans-default)`;
  if (appearance.codeFont) vars["--font-mono"] = `${appearance.codeFont}, var(--font-mono-default)`;
  return {
    theme,
    classes: {
      "sidebar-right": wiki.sidebarPosition === "right",
      "outline-on": appearance.showOutline,
      "sidebar-hidden": !wiki.sidebarVisible,
      "page-list-hidden": wiki.pageList === "hidden",
      "no-wiki-header": !wiki.pageHeader,
      "no-wiki-footer": !wiki.showFooter,
      "no-link-marker": !links.externalMarker,
      "copy-button-always": code.copyButton === "always",
      "copy-button-off": code.copyButton === "off",
      "wrap-code": code.wrapLines,
      "line-numbers": code.lineNumbers && !code.wrapLines,
    },
    vars,
  };
}

/** Text size steps for Ctrl +/- (percent). */
export const TEXT_SIZES = [60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 250];

/** The next text size up or down from `current` (which may be between steps). */
export function stepTextSize(current: number, direction: 1 | -1): number {
  if (direction > 0) return TEXT_SIZES.find((size) => size > current) ?? TEXT_SIZES[TEXT_SIZES.length - 1]!;
  return [...TEXT_SIZES].reverse().find((size) => size < current) ?? TEXT_SIZES[0]!;
}

/** True if a change needs open documents to be rendered again (by Rust). */
export function needsRerender(before: Settings, after: Settings): boolean {
  const a = before.rendering;
  const b = after.rendering;
  return a.frontMatter !== b.frontMatter || a.emoji !== b.emoji || a.math !== b.math;
}
