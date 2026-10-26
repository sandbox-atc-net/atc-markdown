// The changes that turn one text into another, as small as practical, so that
// replacing an editor's text (fix all, reload from disk) keeps the cursor,
// selection and scroll position everywhere outside the changed lines.

export interface Change {
  from: number;
  to: number;
  insert: string;
}

/** Minimal single edit from `before` to `after` (common prefix and suffix kept). */
export function minimalChange(before: string, after: string): Change {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

/** Lines with their line breaks, so joining them gives the text back. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

/**
 * Changes from `before` to `after`, one per group of changed lines (Myers
 * line diff), each trimmed to the characters that differ. Positions refer to
 * `before`, in order and non-overlapping. Falls back to a single change when
 * the texts differ in more than `maxEdits` lines.
 */
export function textChanges(before: string, after: string, maxEdits = 400): Change[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  const matches = matchLines(a, b, maxEdits);
  if (!matches) return [minimalChange(before, after)];

  const offsets = [0];
  for (const line of a) offsets.push((offsets.at(-1) ?? 0) + line.length);

  const changes: Change[] = [];
  let ai = 0;
  let bi = 0;
  const hunk = (aEnd: number, bEnd: number) => {
    if (aEnd === ai && bEnd === bi) return;
    const from = offsets[ai] ?? 0;
    const old = a.slice(ai, aEnd).join("");
    const replacement = b.slice(bi, bEnd).join("");
    const inner = minimalChange(old, replacement);
    changes.push({ from: from + inner.from, to: from + inner.to, insert: inner.insert });
  };
  for (const [x, y] of matches) {
    hunk(x, y);
    ai = x + 1;
    bi = y + 1;
  }
  hunk(a.length, b.length);
  return changes;
}

/** Pairs of equal lines (index in `a`, index in `b`) of a shortest edit script, in order. */
function matchLines(a: readonly string[], b: readonly string[], maxEdits: number): [number, number][] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: the window [-d-1, d+1] of `v` before step d.
  const trace: Int32Array[] = [];
  let steps = -1;
  search: for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        steps = d;
        break search;
      }
    }
  }
  if (steps < 0) return undefined;

  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = steps; d > 0; d--) {
    const before = trace[d];
    if (!before) break;
    const at = (k: number) => before[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // The diagonal (equal lines) after the edit.
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  return matches.reverse();
}
