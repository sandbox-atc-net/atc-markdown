// What the link status bubble says. Pure functions, so they can be unit tested.

import { toUnicodeHost } from "./punycode";
import { isInside, titleFromPath } from "./wiki";

/** Mirrors `LinkTarget` in `atc-markdown-core`. */
export type LinkTarget =
  | { kind: "anchor"; id: string }
  | { kind: "document"; path: string; fragment: string | null }
  | { kind: "localFile"; path: string }
  | { kind: "external"; url: string }
  | { kind: "unsupported" };

/** Mirrors `LinkPreview` in `atc-markdown-core`. */
export type LinkPreview = LinkTarget & { exists: boolean };

export type IconName = "globe" | "file" | "hash" | "folder" | "mail" | "blocked";

/** Text with an optional bold middle part (the host of a URL). */
export interface TargetText {
  before: string;
  strong: string;
  after: string;
}

export interface BubbleContent {
  icon: IconName;
  /** What a click does, e.g. "Open in browser". */
  action: string;
  target: TargetText;
  /** Shown in red after the target, e.g. "not found". */
  problem?: string;
  /** Shown on its own line, e.g. a spoofing warning. */
  warning?: string;
}

export interface LinkContext {
  /** The visible text of the link. */
  linkText: string;
  /** Folder of the current document, to show local paths relative to it. */
  documentDir: string;
  isOpen(path: string): boolean;
  headingText(id: string): string | undefined;
  isMac: boolean;
  /** Set when the link is in a wiki page: links to its pages navigate inside the wiki. */
  wikiRoot?: string;
}

const MAX_TARGET_LENGTH = 90;

const plain = (text: string): TargetText => ({ before: text, strong: "", after: "" });

export function describeLink(preview: LinkPreview, ctx: LinkContext): BubbleContent {
  const missing = preview.exists ? undefined : "not found";
  switch (preview.kind) {
    case "external": {
      if (/^mailto:/i.test(preview.url)) {
        const address = decodeSafely(preview.url.replace(/^mailto:/i, "").split("?")[0] ?? "");
        return { icon: "mail", action: "Send email to", target: plain(address) };
      }
      return {
        icon: "globe",
        action: "Open in browser",
        target: splitUrl(preview.url),
        warning: spoofWarning(ctx.linkText, preview.url),
      };
    }
    case "document": {
      const fragment = preview.fragment ? `#${preview.fragment}` : "";
      if (ctx.wikiRoot && isInside(ctx.wikiRoot, preview.path)) {
        return {
          icon: "file",
          action: "Go to wiki page",
          target: plain(middleEllipsis(titleFromPath(preview.path) + fragment, MAX_TARGET_LENGTH)),
          problem: preview.exists ? undefined : "page not found",
        };
      }
      const action = ctx.isOpen(preview.path) ? "Switch to tab" : "Open in new tab";
      return {
        icon: "file",
        action,
        target: plain(middleEllipsis(relativeTo(ctx.documentDir, preview.path) + fragment, MAX_TARGET_LENGTH)),
        problem: missing,
      };
    }
    case "localFile":
      return {
        icon: "folder",
        action: ctx.isMac ? "Show in Finder" : "Show in Explorer",
        target: plain(middleEllipsis(relativeTo(ctx.documentDir, preview.path), MAX_TARGET_LENGTH)),
        problem: missing,
      };
    case "anchor": {
      const heading = ctx.headingText(preview.id);
      return heading === undefined
        ? { icon: "hash", action: "Jump to", target: plain(`#${preview.id}`), problem: "no such section" }
        : { icon: "hash", action: "Jump to", target: plain(`“${middleEllipsis(heading, MAX_TARGET_LENGTH)}”`) };
    }
    case "unsupported":
      return { icon: "blocked", action: "Blocked link", target: plain("not opened") };
  }
}

/** Splits a URL so the host can be shown in bold; long paths are shortened in the middle. */
export function splitUrl(url: string): TargetText {
  const match = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?)([^/?#:]+)(.*)$/i.exec(url);
  if (!match) return plain(middleEllipsis(url, MAX_TARGET_LENGTH));
  const [, before = "", host = "", after = ""] = match;
  return { before, strong: host, after: middleEllipsis(after, Math.max(20, MAX_TARGET_LENGTH - host.length)) };
}

/** Shortens text to `max` characters by cutting out the middle. */
export function middleEllipsis(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return chars.slice(0, head).join("") + "…" + chars.slice(chars.length - (keep - head)).join("");
}

/** Shows `path` relative to `dir` when it is inside it; otherwise the full path. */
export function relativeTo(dir: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(dir);
  const full = norm(path);
  if (base && full.toLowerCase().startsWith(base.toLowerCase() + "/")) {
    return full.slice(base.length + 1);
  }
  return path;
}

const DOMAIN_LIKE = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i;

/**
 * Warns when the link text looks like a web address but the link goes to a
 * different site, or when the host uses look-alike (punycode) characters.
 */
export function spoofWarning(linkText: string, url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const textHost = DOMAIN_LIKE.exec(linkText.trim())?.[1]?.toLowerCase();
  if (textHost) {
    const real = host.replace(/^www\./, "");
    if (real !== textHost && !real.endsWith(`.${textHost}`)) {
      return `The text says ${textHost}, but the link goes to ${host}`;
    }
  }
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return `Look-alike characters: shown as “${toUnicodeHost(host)}”, really ${host}`;
  }
  return undefined;
}

function decodeSafely(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
