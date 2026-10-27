// The Explorer panel of an open folder (like VS Code's): a tree of the folder's
// Markdown files with a filter / search box. Holds its own view state
// (expanded folders, selection, filter); the app owns the tree data and what
// opening a file means. Everything is built with textContent.

import {
  ancestors,
  countFiles,
  jumpTo,
  relativeTo,
  visibleRows,
  type FolderEntry,
  type FolderTree,
  type Row,
} from "./folder-tree";
import { renderSearchResults, type SearchHit } from "./wiki-view";

/** How a file is opened from the tree. */
export type OpenHow = "preview" | "keep" | "background";

export interface MenuItem {
  label: string;
  run(): unknown;
}

export interface ExplorerActions {
  open(path: string, how: OpenHow): void;
  openWiki(root: string): void;
  /** Full-text search (3+ characters); the app answers with `showSearchResults`. */
  search(query: string): void;
  openSearchHit(hit: SearchHit, query: string): void;
  refresh(): void;
  close(): void;
  showMenu(items: MenuItem[], x: number, y: number): void;
  /** Folders were expanded or collapsed (to save the session). */
  expandedChanged(): void;
  reveal(path: string): void;
  copy(text: string): void;
  lintFolder(root: string): void;
}

const isMac = navigator.userAgent.includes("Mac");

export class Explorer {
  readonly element: HTMLElement;
  private readonly title = document.createElement("span");
  private readonly filterInput = document.createElement("input");
  private readonly treeList = document.createElement("ul");
  private readonly note = document.createElement("p");
  private readonly searchTitle = document.createElement("p");
  private readonly searchResults = document.createElement("ul");

  private tree: FolderTree | undefined;
  private expanded = new Set<string>();
  private rows: Row[] = [];
  /** `relative` of the selected row (keyboard focus / last clicked). */
  private selected: string | undefined;
  /** `relative` of the active tab's file. */
  private active: string | undefined;
  private compact = true;
  private typed = "";
  private typedTimer: number | undefined;
  private searchTimer: number | undefined;

  constructor(element: HTMLElement, private readonly actions: ExplorerActions) {
    this.element = element;
    this.build();
  }

  /** Shows a folder (or nothing). Keeps the expanded folders that still exist. */
  setTree(tree: FolderTree | undefined, expanded?: readonly string[]): void {
    const sameRoot = tree && this.tree && tree.root.toLowerCase() === this.tree.root.toLowerCase();
    this.tree = tree;
    if (expanded) this.expanded = new Set(expanded);
    else if (!sameRoot) this.expanded = new Set();
    if (!sameRoot) {
      this.filterInput.value = "";
      this.selected = undefined;
      this.showSearchResults(undefined);
    }
    this.render();
  }

  get root(): string | undefined {
    return this.tree?.root;
  }

  expandedFolders(): string[] {
    return [...this.expanded].sort();
  }

  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.render();
  }

  /** Marks the active tab's file; with `reveal`, opens its folders and scrolls to it. */
  setActiveFile(path: string | undefined, reveal: boolean): void {
    const relative = this.tree && path ? relativeTo(this.tree.root, path) : undefined;
    const changed = relative?.toLowerCase() !== this.active?.toLowerCase();
    this.active = relative;
    if (!changed) return;
    if (reveal && relative) {
      const before = this.expanded.size;
      for (const folder of ancestors(relative)) this.expanded.add(folder);
      if (this.expanded.size !== before) this.actions.expandedChanged();
      this.selected = relative;
    }
    this.render();
    if (reveal && relative) this.scrollToSelected();
  }

  /** Ctrl+Shift+F / Ctrl+P: puts the cursor in the filter box. */
  focusFilter(): void {
    this.filterInput.focus();
    this.filterInput.select();
  }

  /** Full-text search results for the filter text (undefined clears them). */
  showSearchResults(hits: readonly SearchHit[] | undefined, query = ""): void {
    renderSearchResults(this.searchTitle, this.searchResults, hits, (hit) => this.actions.openSearchHit(hit, query), "file");
  }

  // ------------------------------------------------------------ building

  private build(): void {
    const header = document.createElement("div");
    header.className = "explorer-header";
    this.title.className = "explorer-title";
    const buttons = document.createElement("span");
    buttons.className = "explorer-buttons";
    buttons.append(
      this.button("⟳", "Refresh", () => this.actions.refresh()),
      this.button("⊟", "Collapse all folders", () => this.collapseAll()),
      this.button("×", "Close folder", () => this.actions.close()),
    );
    header.append(this.title, buttons);

    this.filterInput.type = "text";
    this.filterInput.className = "explorer-filter wiki-pages-filter";
    this.filterInput.placeholder = "Filter files or search text…";
    this.filterInput.setAttribute("aria-label", "Filter files");
    this.filterInput.spellcheck = false;
    this.filterInput.autocomplete = "off";
    this.filterInput.addEventListener("input", () => this.onFilterInput());
    this.filterInput.addEventListener("keydown", (e) => this.onFilterKeys(e));

    this.treeList.className = "explorer-tree";
    this.treeList.setAttribute("role", "tree");
    this.treeList.setAttribute("aria-label", "Files");
    this.treeList.tabIndex = 0;
    this.treeList.addEventListener("keydown", (e) => this.onTreeKeys(e));
    // A mouse press focuses the tree before its click: redrawing the rows on
    // that focus would swallow the click, so only keyboard focus selects.
    let pointerDown = false;
    this.treeList.addEventListener("pointerdown", () => (pointerDown = true));
    this.treeList.addEventListener("pointerup", () => (pointerDown = false));
    this.treeList.addEventListener("focus", () => {
      if (!pointerDown && !this.selected && this.rows[0]) this.select(this.rows[0].entry.relative);
    });

    this.note.className = "explorer-note";
    this.note.hidden = true;
    this.searchTitle.className = "wiki-search-title";
    this.searchTitle.hidden = true;
    this.searchResults.className = "wiki-search-results";

    this.element.replaceChildren(header, this.filterInput, this.treeList, this.note, this.searchTitle, this.searchResults);
  }

  private button(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", onClick);
    return button;
  }

  // ------------------------------------------------------------ rendering

  render(): void {
    const tree = this.tree;
    this.title.textContent = tree ? tree.name : "";
    this.title.title = tree?.root ?? "";
    if (!tree) {
      this.rows = [];
      this.treeList.replaceChildren();
      this.note.hidden = true;
      return;
    }
    const filter = this.filterInput.value;
    this.rows = visibleRows(tree.entries, { expanded: this.expanded, filter, compact: this.compact });
    this.treeList.replaceChildren(...this.rows.map((row, index) => this.renderRow(row, index)));
    const selectedIndex = this.selectedIndex();
    this.treeList.setAttribute(
      "aria-activedescendant",
      selectedIndex >= 0 ? `explorer-row-${selectedIndex}` : "",
    );

    let note = "";
    if (tree.entries.length === 0) note = "No Markdown files in this folder.";
    else if (filter.trim() && this.rows.length === 0) note = "No matching file names.";
    else if (filter.trim()) note = `${countFiles(tree.entries, filter)} of ${tree.files} files`;
    if (tree.truncated) note = `${note ? `${note} · ` : ""}Showing the first ${tree.files.toLocaleString()} files.`;
    this.note.textContent = note;
    this.note.hidden = note === "";
  }

  private renderRow(row: Row, index: number): HTMLElement {
    const { entry } = row;
    const item = document.createElement("li");
    item.id = `explorer-row-${index}`;
    item.className = "explorer-row";
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.depth + 1));
    item.style.setProperty("--depth", String(row.depth));
    item.title = entry.relative;
    const key = entry.relative.toLowerCase();
    item.classList.toggle("selected", key === this.selected?.toLowerCase());
    item.classList.toggle("active", key === this.active?.toLowerCase());
    item.setAttribute("aria-selected", String(key === this.selected?.toLowerCase()));

    const twisty = document.createElement("span");
    twisty.className = "explorer-twisty";
    const label = document.createElement("span");
    label.className = "explorer-label";
    label.textContent = row.label;
    if (row.folder) {
      item.classList.add("folder");
      item.setAttribute("aria-expanded", String(row.expanded));
      twisty.textContent = row.expanded ? "▾" : "▸";
      if (entry.wiki) {
        const badge = document.createElement("span");
        badge.className = "explorer-wiki";
        badge.textContent = "📚";
        badge.title = "A GitHub wiki: right-click → Open as Wiki";
        label.prepend(badge, " ");
      }
    }
    item.append(twisty, label);

    item.addEventListener("click", (e) => {
      this.select(entry.relative);
      this.treeList.focus({ preventScroll: true });
      if (row.folder) this.toggle(entry);
      else this.actions.open(entry.path, e.ctrlKey || e.metaKey ? "background" : "preview");
    });
    item.addEventListener("dblclick", () => {
      if (!row.folder) this.actions.open(entry.path, "keep");
    });
    item.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no auto-scroll
    });
    item.addEventListener("auxclick", (e) => {
      if (e.button === 1 && !row.folder) this.actions.open(entry.path, "background");
    });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.select(entry.relative);
      this.openMenu(entry, e.clientX, e.clientY);
    });
    return item;
  }

  // ------------------------------------------------------------ state

  private selectedIndex(): number {
    const key = this.selected?.toLowerCase();
    return key === undefined ? -1 : this.rows.findIndex((r) => r.entry.relative.toLowerCase() === key);
  }

  private select(relative: string): void {
    this.selected = relative;
    this.render();
    this.scrollToSelected();
  }

  private scrollToSelected(): void {
    const index = this.selectedIndex();
    if (index >= 0) this.treeList.children[index]?.scrollIntoView({ block: "nearest" });
  }

  private toggle(folder: FolderEntry, open?: boolean): void {
    const isOpen = this.expanded.has(folder.relative);
    if (open ?? !isOpen) this.expanded.add(folder.relative);
    else this.expanded.delete(folder.relative);
    if (isOpen !== this.expanded.has(folder.relative)) this.actions.expandedChanged();
    this.render();
  }

  private collapseAll(): void {
    this.expanded.clear();
    this.actions.expandedChanged();
    // The selection may now be inside a closed folder: select its top folder.
    const top = this.selected?.split("/")[0];
    if (top && !this.rows.some((r) => r.entry.relative === this.selected)) this.selected = top;
    this.render();
  }

  private openMenu(entry: FolderEntry, x: number, y: number): void {
    const root = this.tree?.root;
    if (!root) return;
    const items: MenuItem[] = [];
    if (entry.children) {
      items.push({ label: "Open as Wiki", run: () => this.actions.openWiki(entry.path) });
      items.push({ label: "Lint Folder", run: () => this.actions.lintFolder(entry.path) });
    } else {
      items.push({ label: "Open", run: () => this.actions.open(entry.path, "keep") });
      items.push({ label: "Open in New Tab", run: () => this.actions.open(entry.path, "background") });
    }
    items.push(
      { label: isMac ? "Reveal in Finder" : "Reveal in File Explorer", run: () => this.actions.reveal(entry.path) },
      { label: "Copy Path", run: () => this.actions.copy(entry.path) },
      { label: "Copy Relative Path", run: () => this.actions.copy(entry.relative) },
    );
    this.actions.showMenu(items, x, y);
  }

  // ------------------------------------------------------------ keys

  private onFilterInput(): void {
    this.render();
    window.clearTimeout(this.searchTimer);
    const query = this.filterInput.value.trim();
    if (query.length < 3) {
      this.showSearchResults(undefined);
      return;
    }
    this.searchTimer = window.setTimeout(() => this.actions.search(query), 250);
  }

  private onFilterKeys(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = this.rows.find((r) => !r.folder);
      if (first) this.actions.open(first.entry.path, "keep");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.treeList.focus();
      const first = this.rows[0];
      if (first) this.select(first.entry.relative);
    } else if (e.key === "Escape" && this.filterInput.value) {
      e.preventDefault();
      e.stopPropagation();
      this.filterInput.value = "";
      this.onFilterInput();
    }
  }

  private onTreeKeys(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const index = this.selectedIndex();
    const row = this.rows[index];
    const move = (to: number) => {
      const target = this.rows[Math.max(0, Math.min(to, this.rows.length - 1))];
      if (target) this.select(target.entry.relative);
    };
    const handled = (() => {
      switch (e.key) {
        case "ArrowDown":
          move(index + 1);
          return true;
        case "ArrowUp":
          move(index < 0 ? 0 : index - 1);
          return true;
        case "Home":
          move(0);
          return true;
        case "End":
          move(this.rows.length - 1);
          return true;
        case "ArrowRight":
          if (row?.folder && !row.expanded) this.toggle(row.entry, true);
          else if (row?.folder) move(index + 1);
          return true;
        case "ArrowLeft": {
          if (row?.folder && row.expanded) {
            this.toggle(row.entry, false);
            return true;
          }
          // To the parent folder's row.
          const parent = row ? this.rows.slice(0, index).reverse().find((r) => r.depth < row.depth) : undefined;
          if (parent) this.select(parent.entry.relative);
          return true;
        }
        case "Enter":
        case " ":
          if (row?.folder) this.toggle(row.entry);
          else if (row) this.actions.open(row.entry.path, e.key === "Enter" ? "keep" : "preview");
          return true;
        case "ContextMenu":
          if (row) this.openRowMenu(index, row);
          return true;
        case "F10":
          if (e.shiftKey && row) {
            this.openRowMenu(index, row);
            return true;
          }
          return false;
        default:
          return this.typeToJump(e.key, index);
      }
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private openRowMenu(index: number, row: Row): void {
    const box = this.treeList.children[index]?.getBoundingClientRect();
    this.openMenu(row.entry, box ? box.left + 24 : 0, box ? box.bottom : 0);
  }

  private typeToJump(key: string, index: number): boolean {
    if (key.length !== 1 || key === " ") return false;
    this.typed += key;
    window.clearTimeout(this.typedTimer);
    this.typedTimer = window.setTimeout(() => (this.typed = ""), 700);
    const target = jumpTo(this.rows, index, this.typed);
    if (target !== undefined) this.select(this.rows[target]!.entry.relative);
    return true;
  }
}
