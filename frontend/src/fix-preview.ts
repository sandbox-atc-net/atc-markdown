// The "Fix all" preview: a dialog with the changed lines (red removed, green
// added, a little context), and Apply / Cancel.

import { lineDiff, type DiffLine } from "./text-diff";

/** At most this many diff lines are drawn; the dialog says how many more there are. */
const MAX_LINES = 3000;

export interface FixPreview {
  title: string;
  /** What will be fixed, e.g. "12 issues: MD009 × 8, MD012 × 4". */
  summary: string;
  before: string;
  after: string;
}

/** Shows the changes and resolves to true if the user applies them. */
export function confirmFix(preview: FixPreview): Promise<boolean> {
  const hunks = lineDiff(preview.before, preview.after);
  const changed = hunks.flat().filter((l) => l.kind !== "same").length;

  const dialog = document.createElement("dialog");
  dialog.className = "fix-preview";
  dialog.setAttribute("aria-label", preview.title);

  const title = document.createElement("h2");
  title.textContent = preview.title;
  const summary = document.createElement("p");
  summary.className = "fix-summary";
  summary.textContent = `${preview.summary} · ${changed} line${changed === 1 ? "" : "s"} in ${hunks.length} place${
    hunks.length === 1 ? "" : "s"
  }`;

  const body = document.createElement("div");
  body.className = "fix-diff";
  body.tabIndex = 0;
  let drawn = 0;
  for (const hunk of hunks) {
    if (drawn >= MAX_LINES) break;
    const table = document.createElement("table");
    for (const line of hunk.slice(0, MAX_LINES - drawn)) table.append(row(line));
    drawn += hunk.length;
    body.append(table);
  }
  const total = hunks.reduce((sum, h) => sum + h.length, 0);
  if (total > MAX_LINES) {
    const more = document.createElement("p");
    more.className = "fix-more";
    more.textContent = `… ${total - MAX_LINES} more lines not shown`;
    body.append(more);
  }

  const buttons = document.createElement("div");
  buttons.className = "fix-buttons";
  const cancel = button("Cancel", "tool");
  const apply = button("Apply", "tool primary");
  buttons.append(cancel, apply);
  dialog.append(title, summary, body, buttons);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let applied = false;
    apply.addEventListener("click", () => {
      applied = true;
      dialog.close();
    });
    cancel.addEventListener("click", () => dialog.close());
    // Escape closes the dialog (a "cancel" event, then "close").
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(applied);
    });
    dialog.showModal();
    apply.focus();
  });
}

function row(line: DiffLine): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = `fix-${line.kind}`;
  const before = cell("fix-num", line.before === undefined ? "" : String(line.before));
  const after = cell("fix-num", line.after === undefined ? "" : String(line.after));
  const sign = cell("fix-sign", { same: "", removed: "−", added: "+" }[line.kind]);
  const text = document.createElement("td");
  text.className = "fix-text";
  text.append(...showWhitespace(line.text, line.kind !== "same"));
  if (line.noNewline) text.append(marker(" no line break at the end", "fix-eol"));
  tr.append(before, after, sign, text);
  return tr;
}

/**
 * The text of a line, with tabs and trailing spaces made visible on changed
 * lines (otherwise a whitespace fix would look like no change at all).
 */
function showWhitespace(text: string, visible: boolean): Node[] {
  if (!visible) return [document.createTextNode(text)];
  return whitespaceParts(text).map((part) =>
    part.whitespace ? marker(part.text, "fix-ws") : document.createTextNode(part.text),
  );
}

/** A line split into text and visible whitespace markers (`→` tab, `·` trailing space). */
export function whitespaceParts(text: string): { text: string; whitespace: boolean }[] {
  const body = text.replace(/[ \t]+$/, "");
  const trailing = text.slice(body.length);
  const parts: { text: string; whitespace: boolean }[] = [];
  body.split("\t").forEach((part, i) => {
    if (i > 0) parts.push({ text: "→\t", whitespace: true });
    if (part) parts.push({ text: part, whitespace: false });
  });
  if (trailing) parts.push({ text: trailing.replace(/ /g, "·").replace(/\t/g, "→\t"), whitespace: true });
  return parts;
}

function marker(text: string, className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function cell(className: string, text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

function button(label: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  return b;
}
