// The outline panel: the document's headings, with the section you are
// reading highlighted while you scroll.

export interface OutlineItem {
  id: string;
  text: string;
  level: number;
}

/** Headings h1–h4 that have an id (comrak gives every heading one). */
export function outlineItems(root: HTMLElement): OutlineItem[] {
  return [...root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id]")].map((heading) => ({
    id: heading.id,
    text: (heading.textContent ?? "").trim(),
    level: Number(heading.tagName.slice(1)),
  }));
}

/** Indents relative to the smallest level present, so a page without an h1 isn't pushed right. */
export function indentLevels(items: readonly OutlineItem[]): number[] {
  const top = Math.min(...items.map((item) => item.level));
  return items.map((item) => item.level - top);
}

/** The index of the heading being read: the last one at or above `offset` px from the top. */
export function currentIndex(tops: readonly number[], offset: number): number {
  let current = tops.length > 0 ? 0 : -1;
  for (let i = 0; i < tops.length; i += 1) {
    if ((tops[i] ?? Infinity) <= offset) current = i;
    else break;
  }
  return current;
}

export function renderOutline(list: HTMLElement, items: readonly OutlineItem[], jump: (id: string) => void): void {
  const indents = indentLevels(items);
  list.replaceChildren(
    ...items.map((item, i) => {
      const li = document.createElement("li");
      li.style.setProperty("--indent", String(indents[i] ?? 0));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.text;
      button.title = item.text;
      button.dataset.id = item.id;
      button.addEventListener("click", () => jump(item.id));
      li.append(button);
      return li;
    }),
  );
}

/** Highlights the entry for the section at the top of `scroller`. */
export function highlightCurrent(list: HTMLElement, root: HTMLElement, scroller: HTMLElement): void {
  const buttons = [...list.querySelectorAll<HTMLButtonElement>("button")];
  if (buttons.length === 0) return;
  const viewTop = scroller.getBoundingClientRect().top;
  const tops = buttons.map((button) => {
    const heading = root.querySelector(`[id="${CSS.escape(button.dataset.id ?? "")}"]`);
    return heading ? heading.getBoundingClientRect().top - viewTop : Infinity;
  });
  const index = currentIndex(tops, 80);
  buttons.forEach((button, i) => button.classList.toggle("current", i === index));
  buttons[index]?.scrollIntoView({ block: "nearest" });
}
