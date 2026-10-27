// Recently opened files, wikis and folders (shown on the start page), and recently
// closed tabs (Ctrl+Shift+T). Pure list handling; storage is done by the caller.

export interface RecentEntry {
  kind: "document" | "wiki" | "folder";
  /** File path, or the wiki or open folder. */
  path: string;
  title: string;
}

export const MAX_RECENT = 12;
export const MAX_CLOSED = 20;

/** Puts `entry` first, removing an older entry for the same path, keeping at most `max`. */
export function remember<T extends { path: string }>(list: readonly T[], entry: T, max: number): T[] {
  const key = entry.path.toLowerCase();
  return [entry, ...list.filter((item) => item.path.toLowerCase() !== key)].slice(0, max);
}

/** Parses a stored list, dropping anything malformed. */
export function parseRecent(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is RecentEntry =>
          typeof item === "object" &&
          item !== null &&
          (item.kind === "document" || item.kind === "wiki" || item.kind === "folder") &&
          typeof item.path === "string" &&
          typeof item.title === "string",
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}
