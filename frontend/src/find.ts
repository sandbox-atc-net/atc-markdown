// Text search over a list of DOM text nodes, kept free of the DOM so it can be
// unit tested. Matches may span several nodes (e.g. "foo **bar**").

/** A position inside one of the searched texts. */
export interface TextPosition {
  node: number;
  offset: number;
}

export interface TextMatch {
  start: TextPosition;
  end: TextPosition;
}

/** Stop after this many matches so a one-letter search stays fast. */
export const MAX_MATCHES = 10_000;

/** Lowercases `text` without changing its length, so offsets stay valid. */
export function foldCase(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Finds all non-overlapping, case-insensitive occurrences of `query` in `texts` joined together. */
export function findMatches(texts: readonly string[], query: string, limit = MAX_MATCHES): TextMatch[] {
  if (query === "" || texts.length === 0) return [];

  const starts: number[] = [];
  let total = 0;
  for (const text of texts) {
    starts.push(total);
    total += text.length;
  }

  const haystack = foldCase(texts.join(""));
  const needle = foldCase(query);
  const matches: TextMatch[] = [];
  let from = 0;
  while (matches.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    const endIndex = index + needle.length;
    matches.push({ start: locate(starts, index, false), end: locate(starts, endIndex, true) });
    from = endIndex;
  }
  return matches;
}

/**
 * Maps an offset in the joined text to a node and an offset inside it. A start
 * goes in the node where the character begins; an end goes in the node where
 * the previous character is (so empty nodes are skipped either way).
 */
function locate(starts: readonly number[], offset: number, isEnd: boolean): TextPosition {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const start = starts[mid]!;
    if (isEnd ? start < offset : start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { node: lo, offset: offset - starts[lo]! };
}
