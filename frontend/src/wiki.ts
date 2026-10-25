// Wiki types (mirroring `atc-markdown-core`) and pure helpers for the wiki view.

import type { History } from "./history";

/** Mirrors `WikiPage`. */
export interface WikiPage {
  name: string;
  title: string;
  path: string;
}

/** Mirrors `WikiInfo`. */
export interface WikiInfo {
  root: string;
  name: string;
  home: string;
  pages: WikiPage[];
  url: string | null;
  sidebar: string | null;
  footer: string | null;
}

/** Mirrors `WikiDocument`. */
export interface WikiDocument {
  path: string;
  name: string;
  title: string;
  html: string;
  missingLinks: string[];
  modifiedMs: number | null;
}

/** Everything a wiki tab shows. A new object is made for every change. */
export interface WikiView {
  info: WikiInfo;
  page: WikiDocument;
  sidebar: WikiDocument | null;
  footer: WikiDocument | null;
  history: History;
}

/** The page name a link in a wiki page points to (internal links use the page name as href). */
export function pageNameFromHref(href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return undefined;
  const name = href.split("#")[0] ?? "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function isSamePage(href: string, pageName: string): boolean {
  return pageNameFromHref(href)?.toLowerCase() === pageName.toLowerCase();
}

/** Pages whose title contains every word of the query. */
export function filterPages(pages: readonly WikiPage[], query: string): WikiPage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pages.slice();
  return pages.filter((page) => {
    const title = page.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
}

/** The github.com address of a page, e.g. for "Open on GitHub". */
export function pageUrl(wikiUrl: string | null, pageName: string): string | undefined {
  if (!wikiUrl) return undefined;
  return pageName.toLowerCase() === "home" ? wikiUrl : `${wikiUrl}/${encodeURIComponent(pageName)}`;
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", "2 months ago", "1 year ago". */
export function relativeTime(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  if (hours < 24) return plural(hours, "hour");
  if (days === 1) return "yesterday";
  if (days < 30) return plural(days, "day");
  if (days < 365) return plural(Math.round(days / 30), "month");
  return plural(Math.round(days / 365), "year");
}

/** True if `path` is inside the folder `root`. */
export function isInside(root: string, path: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(path).startsWith(norm(root) + "/");
}

/** "Working-with-Enums.md" → "Working with Enums". */
export function titleFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "").replace(/-/g, " ");
}
