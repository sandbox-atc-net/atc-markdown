// DOM for the wiki chrome: header, page list and link marking. Document HTML
// itself comes sanitized from Rust; everything built here uses textContent.

import { canGoBack, canGoForward } from "./history";
import { filterPages, isSamePage, pageUrl, relativeTime, type WikiPage, type WikiView } from "./wiki";

export interface WikiHeaderActions {
  back(): void;
  forward(): void;
  openUrl(url: string): void;
}

export function renderWikiHeader(header: HTMLElement, view: WikiView, actions: WikiHeaderActions): void {
  const nav = document.createElement("div");
  nav.className = "wiki-nav";

  const button = (label: string, title: string, enabled: boolean, onClick: () => void) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.disabled = !enabled;
    el.addEventListener("click", onClick);
    return el;
  };

  const crumbs = document.createElement("span");
  crumbs.className = "wiki-crumbs";
  const page = document.createElement("b");
  page.textContent = view.page.title;
  crumbs.append(`📚 ${view.info.name} › `, page);

  nav.append(
    button("←", "Back (Alt+←)", canGoBack(view.history), actions.back),
    button("→", "Forward (Alt+→)", canGoForward(view.history), actions.forward),
    crumbs,
  );

  const url = pageUrl(view.info.url, view.page.name);
  if (url) {
    const github = document.createElement("a");
    github.className = "wiki-github";
    github.href = url;
    github.textContent = "Open on GitHub ↗";
    github.addEventListener("click", (e) => {
      e.preventDefault();
      actions.openUrl(url);
    });
    nav.append(github);
  }

  const title = document.createElement("h1");
  title.className = "wiki-title";
  title.textContent = view.page.title;

  const meta = document.createElement("p");
  meta.className = "wiki-meta";
  meta.textContent =
    view.page.modifiedMs === null ? "" : `Last edited ${relativeTime(view.page.modifiedMs, Date.now())}`;
  if (view.page.modifiedMs !== null) meta.title = new Date(view.page.modifiedMs).toLocaleString();

  header.replaceChildren(nav, title, meta);
}

/** Fills the "Pages (N)" list, filtered by `query`, with the current page highlighted. */
export function renderPagesList(
  summary: HTMLElement,
  list: HTMLElement,
  view: WikiView,
  query: string,
  navigate: (path: string) => void,
): void {
  summary.textContent = `Pages (${view.info.pages.length})`;
  const pages = filterPages(view.info.pages, query);
  if (pages.length === 0) {
    const none = document.createElement("li");
    none.className = "wiki-pages-empty";
    none.textContent = "No matching pages";
    list.replaceChildren(none);
    return;
  }
  list.replaceChildren(
    ...pages.map((page) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = page.title;
      button.title = page.title;
      button.classList.toggle("current-page", page.path.toLowerCase() === view.page.path.toLowerCase());
      button.addEventListener("click", () => navigate(page.path));
      item.append(button);
      return item;
    }),
  );
}

/** Replaces the file-time "Last edited" with the author and time of the last git commit. */
export function showLastEdit(header: HTMLElement, edit: { author: string; timeMs: number }): void {
  const meta = header.querySelector<HTMLElement>(".wiki-meta");
  if (!meta) return;
  meta.textContent = `Last edited by ${edit.author}, ${relativeTime(edit.timeMs, Date.now())}`;
  meta.title = new Date(edit.timeMs).toLocaleString();
}

/** Mirrors `SearchHit` in `atc-markdown-core`. */
export interface SearchHit {
  page: WikiPage;
  matches: number;
  snippet: { before: string; hit: string; after: string } | null;
}

/** Fills the "Found in pages" list of a full-text search. */
export function renderSearchResults(
  title: HTMLElement,
  list: HTMLElement,
  hits: readonly SearchHit[] | undefined,
  open: (hit: SearchHit) => void,
): void {
  title.hidden = hits === undefined;
  if (hits === undefined) {
    list.replaceChildren();
    return;
  }
  title.textContent = hits.length === 0 ? "Not found in any page" : `Found in ${hits.length} page${hits.length === 1 ? "" : "s"}`;
  list.replaceChildren(
    ...hits.map((hit) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const name = document.createElement("span");
      name.className = "wiki-search-page";
      name.textContent = hit.page.title;
      const count = document.createElement("span");
      count.className = "wiki-search-count";
      count.textContent = hit.matches > 0 ? String(hit.matches) : "";
      button.append(name, count);
      if (hit.snippet) {
        const snippet = document.createElement("span");
        snippet.className = "wiki-search-snippet";
        const strong = document.createElement("mark");
        strong.textContent = hit.snippet.hit;
        snippet.append(hit.snippet.before, strong, hit.snippet.after);
        button.append(snippet);
      }
      button.addEventListener("click", () => open(hit));
      item.append(button);
      return item;
    }),
  );
}

/** Marks links to missing pages red, and (in the sidebar) the link to the current page. */
export function markLinks(container: HTMLElement, missing: readonly string[], currentPage?: string): HTMLElement | undefined {
  const missingSet = new Set(missing);
  let current: HTMLElement | undefined;
  for (const link of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    link.classList.toggle("missing-page", missingSet.has(href));
    const isCurrent = currentPage !== undefined && isSamePage(href, currentPage);
    link.classList.toggle("current-page", isCurrent);
    if (isCurrent) current ??= link;
  }
  return current;
}
