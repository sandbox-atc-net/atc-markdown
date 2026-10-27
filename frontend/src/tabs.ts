// Pure tab state. No DOM or Tauri here, so it is easy to unit test.

import type { FolderLint } from "./lint-report-view";
import type { WikiView } from "./wiki";

/** Editing state of a document tab (the text itself lives in the editor). */
export interface EditInfo {
  mode: "preview" | "split" | "edit";
  /** The text differs from what was last loaded or saved. */
  dirty: boolean;
  /** A new file that has never been saved. */
  untitled?: true;
  lineEnding: "lf" | "crlf";
  bom: boolean;
  /** Fingerprint of the file on disk when it was loaded or last saved. */
  fingerprint: string | null;
  /** Another program changed the file while there were unsaved edits. */
  conflict?: true;
}

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
  /** Set on a lint report tab: the issues of a folder (not saved in the session). */
  lintReport?: FolderLint;
  /** Set once a document tab has been opened in the editor. */
  edit?: EditInfo;
  /**
   * A preview tab (opened with one click in the Explorer, title in italics):
   * the next file opened that way takes its place, until it is kept.
   */
  preview?: true;
}

/** True for the app's own tabs (Settings, lint reports), which show no document. */
export const isAppView = (doc: OpenDocument | undefined): boolean =>
  doc !== undefined && (doc.settings === true || doc.lintReport !== undefined);

/** Ids of new, unsaved files start with this. */
export const UNTITLED_PREFIX = "untitled:";

export const isUntitled = (doc: OpenDocument): boolean => doc.edit?.untitled === true;

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
    // Refresh the content; a preview tab stays one.
    tabs[existing] = state.tabs[existing]?.preview && doc.preview === undefined ? { ...doc, preview: true } : doc;
    return { tabs, activeIndex: existing };
  }
  const tabs = [...state.tabs, doc];
  return { tabs, activeIndex: tabs.length - 1 };
}

/**
 * Opens `doc` as the preview tab: in place of the current preview tab, or as
 * a new one. A document that is already open is only activated (and stays as
 * it is: kept or preview).
 */
export function openPreviewTab(state: TabState, doc: OpenDocument): TabState {
  const existing = state.tabs.findIndex((t) => samePath(t.path, doc.path));
  if (existing >= 0) return { ...state, activeIndex: existing };
  const preview = state.tabs.findIndex((t) => t.preview === true);
  const tab: OpenDocument = { ...doc, preview: true };
  if (preview < 0) return openTab(state, tab);
  const tabs = state.tabs.slice();
  tabs[preview] = tab;
  return { tabs, activeIndex: preview };
}

/** The preview tab that {@link openPreviewTab} would replace, if any. */
export function previewTab(state: TabState): OpenDocument | undefined {
  return state.tabs.find((t) => t.preview === true);
}

/** Keeps a preview tab open (double-click, or editing it): it is no longer replaced. */
export function keepTab(state: TabState, path: string): TabState {
  const index = state.tabs.findIndex((t) => samePath(t.path, path) && t.preview === true);
  if (index < 0) return state;
  const tabs = state.tabs.slice();
  const { preview: _, ...kept } = tabs[index]!;
  tabs[index] = kept;
  return { ...state, tabs };
}

/** Replaces the content of an open document (e.g. after it changed on disk) without switching tabs. */
export function updateTab(state: TabState, doc: OpenDocument): TabState {
  const index = state.tabs.findIndex((t) => samePath(t.path, doc.path));
  if (index < 0) return state;
  const tabs = state.tabs.slice();
  tabs[index] = state.tabs[index]?.preview && doc.preview === undefined ? { ...doc, preview: true } : doc;
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

/**
 * A tab id not used by any open tab: `base` itself, or `base::2`, `base::3`…
 * Lets the same wiki be open in more than one tab.
 */
export function uniqueTabPath(paths: readonly string[], base: string): string {
  const used = new Set(paths.map((p) => p.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}::${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
