// Pure tab state. No DOM or Tauri here, so it is easy to unit test.

import type { WikiView } from "./wiki";

/**
 * An open tab. For a wiki tab, `path` is the wiki folder (the tab's identity),
 * `title` the wiki name and `html` the current page; `wiki` holds the rest.
 */
export interface OpenDocument {
  path: string;
  title: string;
  html: string;
  /** Set on wiki tabs. */
  wiki?: WikiView;
  /** Set on document tabs whose file is a page of a wiki. */
  wikiRoot?: string;
  /** Set on the Settings tab (not saved in the session). */
  settings?: true;
}

/** Identity of the Settings tab. */
export const SETTINGS_TAB_PATH = "atc-markdown:settings";

/**
 * Puts `doc` in place of the tab at `index` and activates it. If `doc` is
 * already open in another tab, that tab is activated instead.
 */
export function replaceTab(state: TabState, index: number, doc: OpenDocument): TabState {
  const existing = state.tabs.findIndex((t) => samePath(t.path, doc.path));
  if (existing >= 0 || index < 0 || index >= state.tabs.length) return openTab(state, doc);
  const tabs = state.tabs.slice();
  tabs[index] = doc;
  return { tabs, activeIndex: index };
}

export interface TabState {
  tabs: OpenDocument[];
  activeIndex: number; // -1 when no tabs are open
}

export const emptyTabs: TabState = { tabs: [], activeIndex: -1 };

/** Opens a document, or activates its tab if the same path is already open. */
export function openTab(state: TabState, doc: OpenDocument): TabState {
  const existing = state.tabs.findIndex((t) => samePath(t.path, doc.path));
  if (existing >= 0) {
    const tabs = state.tabs.slice();
    tabs[existing] = doc; // refresh content
    return { tabs, activeIndex: existing };
  }
  const tabs = [...state.tabs, doc];
  return { tabs, activeIndex: tabs.length - 1 };
}

/** Replaces the content of an open document (e.g. after it changed on disk) without switching tabs. */
export function updateTab(state: TabState, doc: OpenDocument): TabState {
  const index = state.tabs.findIndex((t) => samePath(t.path, doc.path));
  if (index < 0) return state;
  const tabs = state.tabs.slice();
  tabs[index] = doc;
  return { ...state, tabs };
}

/** Closes a tab and picks a sensible neighbour as the new active tab. */
export function closeTab(state: TabState, index: number): TabState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  let activeIndex = state.activeIndex;
  if (index < activeIndex || activeIndex >= tabs.length) activeIndex -= 1;
  return { tabs, activeIndex: tabs.length === 0 ? -1 : Math.max(0, activeIndex) };
}

export function activateTab(state: TabState, index: number): TabState {
  if (index < 0 || index >= state.tabs.length) return state;
  return { ...state, activeIndex: index };
}

export function activeTab(state: TabState): OpenDocument | undefined {
  return state.tabs[state.activeIndex];
}

// Windows and macOS file systems are case-insensitive by default.
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
