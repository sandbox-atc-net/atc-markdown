// Scroll sync: keep the preview showing the part of the document that is at
// the top of the editor. Preview blocks carry `data-sourcepos="L:C-L:C"`.

/** A preview block: its source lines and where it is in the preview. */
export interface Block {
  startLine: number;
  endLine: number;
  /** Offset from the top of the preview's scroll content, in px. */
  top: number;
  height: number;
}

/** Parses `data-sourcepos="3:1-7:3"` into [3, 7]. */
export function parseSourcePos(value: string | undefined): [number, number] | undefined {
  const match = /^(\d+):\d+-(\d+):\d+$/.exec(value ?? "");
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/**
 * The preview scroll position that shows source line `line` at the top:
 * inside the block that contains the line (interpolated by line), or between
 * the blocks around it. `blocks` must be in document order.
 */
export function previewScrollFor(blocks: readonly Block[], line: number): number {
  if (blocks.length === 0 || line <= 1) return 0;
  let before: Block | undefined;
  let after: Block | undefined;
  // A block covers lines [startLine, endLine + 1), so fractional lines work.
  for (const block of blocks) {
    if (line >= block.startLine && line < block.endLine + 1) {
      const lines = block.endLine - block.startLine + 1;
      return block.top + (block.height * (line - block.startLine)) / lines;
    }
    if (block.endLine + 1 <= line) before = block;
    else if (block.startLine > line && !after) after = block;
  }
  if (before && after) {
    // In the blank lines between two blocks.
    const gap = after.startLine - (before.endLine + 1);
    const fraction = gap > 0 ? (line - (before.endLine + 1)) / gap : 0;
    const start = before.top + before.height;
    return start + (after.top - start) * fraction;
  }
  if (before) return before.top + before.height;
  return 0;
}

/**
 * The source line (with a fraction) shown at preview scroll position `y`: the
 * inverse of `previewScrollFor`. Inside a block it is interpolated by height;
 * in the space between two blocks, over the source lines between them.
 */
export function sourceLineFor(blocks: readonly Block[], y: number): number {
  if (blocks.length === 0) return 1;
  let previous: Block | undefined;
  for (const block of blocks) {
    if (y < block.top) {
      if (!previous) return 1;
      const end = previous.top + previous.height;
      const fraction = block.top > end ? (y - end) / (block.top - end) : 0;
      const gapStart = previous.endLine + 1;
      return gapStart + (block.startLine - gapStart) * Math.min(1, Math.max(0, fraction));
    }
    if (y < block.top + block.height) {
      const lines = block.endLine - block.startLine + 1;
      return block.startLine + (lines * (y - block.top)) / Math.max(block.height, 1);
    }
    previous = block;
  }
  return (previous?.endLine ?? 0) + 1;
}
