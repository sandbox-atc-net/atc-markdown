// The Explorer tree of an open folder: types mirroring `FolderTree` in
// `atc-markdown-core`, and the pure logic that turns it into visible rows
// (expanded folders, compact folder chains, the filter box, type-to-jump).

/** A file or folder. Folders have `children`. */
export interface FolderEntry {
  name: string;
  path: string;
  /** Path below the opened folder, with `/` separators. Identifies the row. */
  relative: string;
  children?: FolderEntry[];
  /** The folder is a GitHub wiki. */
  wiki?: boolean;
}

export interface FolderTree {
  root: string;
  name: string;
  wiki: boolean;
  entries: FolderEntry[];
  files: number;
  truncated: boolean;
}

/** One line of the tree as shown. */
export interface Row {
  /** The file, or the (last) folder of the row. */
  entry: FolderEntry;
  /** The name, or `docs/guides/api` for a compact chain of folders. */
  label: string;
  depth: number;
  folder: boolean;
  expanded: boolean;
}

export interface RowOptions {
  /** `relative` of each expanded folder. */
  expanded: ReadonlySet<string>;
  /** Text in the filter box: every word must occur in the file's path. */
  filter: string;
  /** Show a folder that only holds one folder on the same row as it. */
  compact: boolean;
}

/** The rows to show, top to bottom. While filtering, every folder left is open. */
export function visibleRows(entries: readonly FolderEntry[], options: RowOptions): Row[] {
  const words = filterWords(options.filter);
  const shown = words.length > 0 ? prune(entries, words) : entries;
  const rows: Row[] = [];
  const walk = (list: readonly FolderEntry[], depth: number) => {
    for (const entry of list) {
      if (!entry.children) {
        rows.push({ entry, label: entry.name, depth, folder: false, expanded: false });
        continue;
      }
      let folder = entry;
      let label = entry.name;
      while (options.compact && folder.children?.length === 1 && folder.children[0]?.children) {
        folder = folder.children[0];
        label += `/${folder.name}`;
      }
      const expanded = words.length > 0 || options.expanded.has(folder.relative);
      rows.push({ entry: folder, label, depth, folder: true, expanded });
      if (expanded) walk(folder.children ?? [], depth + 1);
    }
  };
  walk(shown, 0);
  return rows;
}

const filterWords = (filter: string): string[] => filter.toLowerCase().split(/\s+/).filter(Boolean);

/** Only the files whose path has every word, and the folders that lead to them. */
function prune(entries: readonly FolderEntry[], words: readonly string[]): FolderEntry[] {
  const out: FolderEntry[] = [];
  for (const entry of entries) {
    if (entry.children) {
      const children = prune(entry.children, words);
      if (children.length > 0) out.push({ ...entry, children });
    } else {
      const path = entry.relative.toLowerCase();
      if (words.every((word) => path.includes(word))) out.push(entry);
    }
  }
  return out;
}

/** Number of files the filter leaves (all files without a filter). */
export function countFiles(entries: readonly FolderEntry[], filter = ""): number {
  const words = filterWords(filter);
  const list = words.length > 0 ? prune(entries, words) : entries;
  const count = (items: readonly FolderEntry[]): number =>
    items.reduce((sum, e) => sum + (e.children ? count(e.children) : 1), 0);
  return count(list);
}

/** The folders that hold `relative` (`a/b/c.md` → `a`, `a/b`), to expand when revealing it. */
export function ancestors(relative: string): string[] {
  const parts = relative.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Every folder below `entries` (for "expand all" and tests). */
export function allFolders(entries: readonly FolderEntry[]): string[] {
  return entries.flatMap((e) => (e.children ? [e.relative, ...allFolders(e.children)] : []));
}

/** `path` below `root`, with `/` separators, or undefined if it isn't inside it. */
export function relativeTo(root: string, path: string): string | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const full = norm(path);
  if (full.length <= base.length || full.slice(0, base.length + 1).toLowerCase() !== `${base}/`.toLowerCase()) {
    return undefined;
  }
  return full.slice(base.length + 1);
}

/** Finds a file or folder by its `relative` path (case-insensitive, like the file system). */
export function findEntry(entries: readonly FolderEntry[], relative: string): FolderEntry | undefined {
  const key = relative.toLowerCase();
  for (const entry of entries) {
    if (entry.relative.toLowerCase() === key) return entry;
    if (entry.children && key.startsWith(`${entry.relative.toLowerCase()}/`)) return findEntry(entry.children, relative);
  }
  return undefined;
}

/**
 * Type-to-jump: the next row after `from` (wrapping round) whose label starts
 * with `prefix`. Typing the same letter again moves on to the next match.
 */
export function jumpTo(rows: readonly Row[], from: number, prefix: string): number | undefined {
  const text = prefix.toLowerCase();
  if (!text || rows.length === 0) return undefined;
  // "aaa" means "the next row starting with a", not a row starting with "aaa".
  const sameLetter = [...text].every((c) => c === text[0]);
  const wanted = sameLetter ? text[0]! : text;
  // A longer prefix may still match the current row; one letter moves on.
  const start = text.length > 1 && !sameLetter ? from : from + 1;
  for (let i = 0; i < rows.length; i += 1) {
    const index = (Math.max(start, 0) + i) % rows.length;
    if (rows[index]!.label.toLowerCase().startsWith(wanted)) return index;
  }
  return undefined;
}
