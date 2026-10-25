// The open tabs, saved so they can be reopened on the next start.

import { activateTab, emptyTabs, openTab, type OpenDocument, type TabState } from "./tabs";

export type SessionTab = { kind: "document"; path: string } | { kind: "wiki"; root: string; page: string };

export interface Session {
  tabs: SessionTab[];
  /** Identity (`path`) of the active tab. */
  active: string | null;
}

export function toSession(state: TabState): Session {
  return {
    tabs: state.tabs
      .filter((tab) => !tab.settings)
      .map((tab) =>
        tab.wiki
          ? { kind: "wiki", root: tab.wiki.info.root, page: tab.wiki.page.path }
          : { kind: "document", path: tab.path },
      ),
    active: state.tabs[state.activeIndex]?.settings ? null : (state.tabs[state.activeIndex]?.path ?? null),
  };
}

/**
 * Parses a saved session, or returns `undefined` if it is missing or malformed.
 * Also reads the first format (`{ paths, active }`) written by earlier versions.
 */
export function parseSession(raw: string | null): Session | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { tabs, paths, active } = value as Record<string, unknown>;
  if (active !== null && typeof active !== "string") return undefined;

  if (Array.isArray(tabs)) {
    return tabs.every(isSessionTab) ? { tabs, active } : undefined;
  }
  if (Array.isArray(paths) && paths.every((p) => typeof p === "string")) {
    return { tabs: (paths as string[]).map((path) => ({ kind: "document", path })), active };
  }
  return undefined;
}

function isSessionTab(value: unknown): value is SessionTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  if (tab.kind === "document") return typeof tab.path === "string";
  if (tab.kind === "wiki") return typeof tab.root === "string" && typeof tab.page === "string";
  return false;
}

/**
 * The tab state at startup: the restored tabs (in order, failed ones skipped)
 * with the saved active tab, then the files the app was started with — the
 * last of those ends up active.
 */
export function startupState(
  restored: readonly (OpenDocument | undefined)[],
  active: string | null,
  opened: readonly OpenDocument[],
): TabState {
  let state = emptyTabs;
  for (const doc of restored) {
    if (doc) state = openTab(state, doc);
  }
  const index = state.tabs.findIndex((tab) => tab.path === active);
  if (index >= 0) state = activateTab(state, index);
  for (const doc of opened) state = openTab(state, doc);
  return state;
}
