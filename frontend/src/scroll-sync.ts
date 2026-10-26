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
  for (const block of blocks) {
    if (line >= block.startLine && line <= block.endLine) {
      const lines = block.endLine - block.startLine + 1;
      return block.top + (block.height * (line - block.startLine)) / lines;
    }
    if (block.endLine < line) before = block;
    else if (block.startLine > line && !after) after = block;
  }
  if (before && after) {
    // In the blank lines between two blocks.
    const gap = after.startLine - before.endLine;
    const fraction = gap > 0 ? (line - before.endLine) / gap : 0;
    const start = before.top + before.height;
    return start + (after.top - start) * fraction;
  }
  if (before) return before.top + before.height;
  return 0;
}
