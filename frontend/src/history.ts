// Back/forward history for a wiki tab. Pure, so it can be unit tested.

export interface HistoryEntry {
  /** Page file path. */
  path: string;
  /** Scroll position when the page was left, restored on back/forward. */
  scroll: number;
}

export interface History {
  entries: HistoryEntry[];
  index: number;
}

export function startHistory(path: string): History {
  return { entries: [{ path, scroll: 0 }], index: 0 };
}

export function currentEntry(history: History): HistoryEntry {
  return history.entries[history.index] ?? { path: "", scroll: 0 };
}

export const canGoBack = (history: History): boolean => history.index > 0;
export const canGoForward = (history: History): boolean => history.index < history.entries.length - 1;

/** Remembers where we were, then goes to `path`; forward entries are dropped. */
export function navigate(history: History, path: string, scroll: number): History {
  const entries = withScroll(history, scroll).slice(0, history.index + 1);
  if (samePath(currentEntry(history).path, path)) {
    return { entries, index: history.index };
  }
  entries.push({ path, scroll: 0 });
  return { entries, index: entries.length - 1 };
}

/** Steps back (-1) or forward (+1), remembering the current scroll position. */
export function step(history: History, direction: -1 | 1, scroll: number): History | undefined {
  const index = history.index + direction;
  if (index < 0 || index >= history.entries.length) return undefined;
  return { entries: withScroll(history, scroll), index };
}

/** Replaces the current entry's path (e.g. the page was renamed) without adding history. */
export function replaceCurrent(history: History, path: string): History {
  const entries = history.entries.slice();
  entries[history.index] = { path, scroll: 0 };
  return { entries, index: history.index };
}

function withScroll(history: History, scroll: number): HistoryEntry[] {
  return history.entries.map((entry, i) => (i === history.index ? { ...entry, scroll } : entry));
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
