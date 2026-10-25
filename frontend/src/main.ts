import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyText, enhance, enhanceRich } from "./enhance";
import {
  applied,
  needsRerender,
  stepTextSize,
  type Settings,
  type SettingsChanges,
} from "./settings";
import { renderSettingsView, type CodeThemeChoice } from "./settings-view";
import { findMatches } from "./find";
import { highlightCurrent, outlineItems, renderOutline } from "./outline";
import { MAX_CLOSED, MAX_RECENT, parseRecent, remember, type RecentEntry } from "./recent";
import { currentEntry, navigate, startHistory, step, type History } from "./history";
import { describeLink, type BubbleContent, type IconName, type LinkPreview, type LinkTarget } from "./links";
import { parseSession, startupState, toSession, type Session, type SessionTab } from "./session";
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  openTab,
  replaceTab,
  SETTINGS_TAB_PATH,
  uniqueTabPath,
  updateTab,
  type OpenDocument,
  type TabState,
} from "./tabs";
import { isInside, pageUrl, type WikiDocument, type WikiInfo, type WikiView } from "./wiki";
import {
  markLinks,
  renderPagesList,
  renderSearchResults,
  renderWikiHeader,
  showLastEdit,
  type SearchHit,
} from "./wiki-view";

const APP_NAME = "Atc.Markdown";
const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd"];
const MARKDOWN_PATTERN = new RegExp(`\\.(${MARKDOWN_EXTENSIONS.join("|")})$`, "i");

/** Things the user can do from the menu or the keyboard. Mirrors `COMMAND_IDS` in `src-tauri/src/menu.rs`. */
const COMMANDS = [
  "open",
  "open-wiki",
  "close-tab",
  "go-back",
  "go-forward",
  "toggle-sidebar",
  "find-page",
  "settings",
  "toggle-outline",
  "reopen-tab",
  "print",
  "reload",
  "find",
  "find-next",
  "find-previous",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "next-tab",
  "previous-tab",
] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

/** Mirrors `PathKind` in `src-tauri/src/commands.rs`. */
type PathKind = { kind: "wiki"; root: string } | { kind: "document"; wikiRoot: string | null };

const element = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const tabBar = element<HTMLElement>("#tabs");
const viewport = element<HTMLElement>("#viewport");
const content = element<HTMLElement>("#content");
const preview = element<HTMLElement>("#preview");
const empty = element<HTMLElement>("#empty");
const findBar = element<HTMLElement>("#find-bar");
const findInput = element<HTMLInputElement>("#find-input");
const findCount = element<HTMLElement>("#find-count");
const linkStatus = element<HTMLElement>("#link-status");
const linkMenu = element<HTMLElement>("#link-menu");
const wikiSidebar = element<HTMLElement>("#wiki-sidebar");
const wikiSidebarBody = element<HTMLElement>("#wiki-sidebar-body");
const wikiPages = element<HTMLDetailsElement>("#wiki-pages");
const wikiPagesSummary = element<HTMLElement>("#wiki-pages-summary");
const wikiPagesFilter = element<HTMLInputElement>("#wiki-pages-filter");
const wikiPagesList = element<HTMLElement>("#wiki-pages-list");
const wikiSearchTitle = element<HTMLElement>("#wiki-search-title");
const wikiSearchResults = element<HTMLElement>("#wiki-search-results");
const wikiSplitter = element<HTMLElement>("#wiki-splitter");
const wikiHeader = element<HTMLElement>("#wiki-header");
const wikiFooter = element<HTMLElement>("#wiki-footer");
const wikiBanner = element<HTMLElement>("#wiki-banner");
const settingsView = element<HTMLElement>("#settings-view");
const outline = element<HTMLElement>("#outline");
const outlineList = element<HTMLElement>("#outline-list");
const toast = element<HTMLElement>("#toast");
const recentSection = element<HTMLElement>("#recent");
const recentList = element<HTMLElement>("#recent-list");

let state: TabState = emptyTabs;
/** The user's settings; replaced on every `settings-changed` event. */
let settings: Settings;
let codeThemes: CodeThemeChoice[] = [];
/** The tab currently shown, to avoid needless re-renders. */
let shown: OpenDocument | undefined;
/** The sidebar currently shown, so its scroll position survives page changes. */
let shownSidebar: WikiDocument | null | undefined;
/** Scroll position per tab, so switching tabs keeps your place. */
const scrollPositions = new Map<string, number>();
/** Where to scroll when a wiki tab shows a new page (set by navigation). */
let pendingScroll: { tab: string; top: number; fragment?: string } | undefined;

/** The file shown in the active tab (the current page for a wiki). */
const shownPath = (): string | undefined => shown?.wiki?.page.path ?? shown?.path;
/** The wiki folder of the active tab, if it is a wiki. */
/** The wiki folder of the active tab, if it is a wiki (a wiki can be open in several tabs). */
const shownWikiRoot = (): string | undefined => shown?.wiki?.info.root;

// ---------------------------------------------------------------- rendering

function setState(next: TabState): void {
  if (shown) scrollPositions.set(shown.path, content.scrollTop);
  state = next;
  saveSession();
  render();
}

function render(): void {
  tabBar.replaceChildren(...state.tabs.map(renderTab), renderNewTabButton());

  const doc = activeTab(state);
  empty.hidden = doc !== undefined;
  preview.hidden = doc === undefined || doc.settings === true;
  settingsView.hidden = doc?.settings !== true;

  if (doc !== shown) {
    // `html` was sanitized in Rust (ammonia) before it reached us.
    preview.innerHTML = doc?.html ?? "";
    enhance(preview);
    if (doc?.settings) renderSettings();
    renderWiki(doc);
    renderBanner(doc);

    const scroll = pendingScroll?.tab === doc?.path ? pendingScroll : undefined;
    pendingScroll = undefined;
    const top = scroll ? scroll.top : doc ? (scrollPositions.get(doc.path) ?? 0) : 0;
    content.scrollTop = top;
    shown = doc;
    if (scroll?.fragment) scrollToId(scroll.fragment);
    if (doc && !doc.settings) void renderRich(doc, top, scroll?.fragment);
    updateOutline();
    if (doc && !doc.settings && !doc.html.includes('class="error"')) rememberRecent(doc);
    if (!doc) renderRecent();

    void getCurrentWindow().setTitle(windowTitle(doc));
    // The old matches pointed into the replaced HTML.
    if (!findBar.hidden) runFind();
    hideLinkStatus();
    closeLinkMenu();
    linkPreviews.clear();
  }
}

/** Shows the headings of the active document beside it (when the setting is on). */
function updateOutline(): void {
  const doc = activeTab(state);
  const items = doc && !doc.settings && settings.appearance.showOutline ? outlineItems(preview) : [];
  outline.hidden = items.length === 0;
  const onRight = settings.wiki.sidebarPosition !== "right";
  viewport.classList.toggle("outline-right", !outline.hidden && onRight);
  viewport.classList.toggle("outline-left", !outline.hidden && !onRight);
  renderOutline(outlineList, items, (id) => scrollToId(id));
  highlightCurrent(outlineList, preview, content);
}

let toastTimer: number | undefined;

/** A short confirmation at the bottom of the window. */
function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1600);
}

/**
 * Draws diagrams and math (async, libraries loaded on demand). They change the
 * page height, so the scroll position is restored once they are in.
 */
async function renderRich(doc: OpenDocument, top: number, fragment?: string): Promise<void> {
  const options = {
    mermaid: settings.rendering.mermaid,
    math: settings.rendering.math,
    dark: document.documentElement.dataset.theme === "dark",
  };
  try {
    const changed = await enhanceRich(preview, options);
    if (!changed || shown !== doc) return;
    if (fragment) scrollToId(fragment);
    else content.scrollTop = top;
    if (!findBar.hidden) runFind();
  } catch (error) {
    reportError(error);
  }
}

/** Shows the active tab again from scratch (e.g. diagrams after a theme change). */
function rerenderShown(): void {
  if (!shown) return;
  scrollPositions.set(shown.path, content.scrollTop);
  shown = undefined;
  shownSidebar = undefined;
  render();
}

function windowTitle(doc: OpenDocument | undefined): string {
  if (!doc) return APP_NAME;
  if (doc.wiki) return `${doc.wiki.page.title} – ${doc.wiki.info.name} – ${APP_NAME}`;
  return `${doc.title} – ${APP_NAME}`;
}

function renderTab(doc: OpenDocument, index: number): HTMLElement {
  const tab = document.createElement("div");
  tab.className = doc.wiki ? "tab wiki" : "tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", String(index === state.activeIndex));
  tab.title = doc.wiki ? `${doc.wiki.info.name} wiki – ${doc.path}` : doc.path;
  tab.addEventListener("click", () => setState(activateTab(state, index)));
  tab.addEventListener("auxclick", (e) => {
    if (e.button === 1) closeDocument(index);
  });

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = doc.title;

  const close = document.createElement("button");
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "Close (Ctrl+W)";
  close.setAttribute("aria-label", `Close ${doc.title}`);
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeDocument(index);
  });

  tab.append(label, close);
  return tab;
}

function renderNewTabButton(): HTMLElement {
  const button = document.createElement("button");
  button.className = "tab-new";
  button.textContent = "+";
  button.title = "Open file (Ctrl+O)";
  button.setAttribute("aria-label", "Open file");
  button.addEventListener("click", () => void showOpenDialog());
  return button;
}

/** Shows or hides the wiki sidebar, header and footer for the active tab. */
function renderWiki(doc: OpenDocument | undefined): void {
  const view = doc?.wiki;
  wikiSidebar.hidden = !view;
  wikiSplitter.hidden = !view;
  wikiHeader.hidden = !view;
  viewport.classList.toggle("has-sidebar", Boolean(view));
  if (!view) {
    wikiFooter.hidden = true;
    shownSidebar = undefined;
    return;
  }

  renderWikiHeader(wikiHeader, view, {
    back: () => runCommand("go-back"),
    forward: () => runCommand("go-forward"),
    // Straight to the browser: wiki link resolution would map this URL back to the local page.
    openUrl: (url) => void invoke("follow_link", { documentPath: view.page.path, href: url }).catch(reportError),
  });
  void showGitLastEdit(view);

  if (view.sidebar !== shownSidebar) {
    // Sanitized in Rust.
    wikiSidebarBody.innerHTML = view.sidebar?.html ?? "";
    wikiSidebarBody.hidden = !view.sidebar;
    shownSidebar = view.sidebar;
  }
  // Without a _Sidebar.md the page list is the navigation, so show it open.
  if (!view.sidebar) wikiPages.open = true;
  else if (shown?.path !== doc?.path) wikiPages.open = settings.wiki.pageList === "expanded";
  const current = markLinks(wikiSidebarBody, view.sidebar?.missingLinks ?? [], view.page.name);
  current?.scrollIntoView({ block: "nearest" });
  renderPagesList(wikiPagesSummary, wikiPagesList, view, wikiPagesFilter.value, (path) => void goToWikiPage(path));

  markLinks(preview, view.page.missingLinks);
  wikiFooter.hidden = !view.footer;
  wikiFooter.innerHTML = view.footer?.html ?? "";
  enhance(wikiFooter);
  if (view.footer) markLinks(wikiFooter, view.footer.missingLinks);
}

/** Git authors and times per page, so each is only asked once per session. */
const lastEdits = new Map<string, Promise<{ author: string; timeMs: number } | null>>();

async function showGitLastEdit(view: WikiView): Promise<void> {
  const path = view.page.path;
  let edit = lastEdits.get(path);
  if (!edit) {
    edit = invoke<{ author: string; timeMs: number } | null>("git_last_edited", { root: view.info.root, path }).catch(
      () => null,
    );
    lastEdits.set(path, edit);
  }
  const result = await edit;
  if (result && shown?.wiki?.page.path === path) showLastEdit(wikiHeader, result);
}

/** For a file that is a page of a wiki, offers to open the whole wiki. */
function renderBanner(doc: OpenDocument | undefined): void {
  const root = doc && !doc.wiki && settings.wiki.offerOpenAsWiki ? doc.wikiRoot : undefined;
  wikiBanner.hidden = !root;
  if (!root || !doc) return;
  const name = root.split(/[\\/]/).pop()?.replace(/\.wiki$/i, "") ?? root;
  const text = document.createElement("span");
  text.textContent = `This page is part of the “${name}” wiki.`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Open as wiki";
  const path = doc.path;
  button.addEventListener("click", () => void openWiki(root, path).catch(reportError));
  wikiBanner.replaceChildren(text, button);
}

// ---------------------------------------------------------------- documents

async function tryLoadDocument(path: string): Promise<OpenDocument | undefined> {
  try {
    return await invoke<OpenDocument>("open_document", { path });
  } catch {
    return undefined;
  }
}

async function loadDocument(path: string, wikiRoot?: string): Promise<OpenDocument> {
  try {
    const doc = await invoke<OpenDocument>("open_document", { path });
    return wikiRoot ? { ...doc, wikiRoot } : doc;
  } catch (error) {
    return errorDocument(path, String(error));
  }
}

/** Loads whatever a path is: a wiki folder or a Markdown file. Other files are skipped. */
async function loadPath(path: string): Promise<OpenDocument | undefined> {
  const kind = await invoke<PathKind>("path_kind", { path });
  if (kind.kind === "wiki") {
    try {
      return await loadWikiTab(kind.root);
    } catch (error) {
      return errorDocument(path, String(error));
    }
  }
  if (!MARKDOWN_PATTERN.test(path)) return undefined;
  return loadDocument(path, kind.wikiRoot ?? undefined);
}

/**
 * Opens paths in new tabs. With `fromOs` and the "Replace current tab" setting,
 * a file opened from Explorer/Finder takes the place of the active document.
 */
async function openPaths(paths: string[], fromOs = false): Promise<void> {
  for (const path of paths) {
    const kind = await invoke<PathKind>("path_kind", { path });
    if (kind.kind === "wiki") {
      // An open wiki is switched to, not reloaded at Home.
      await openWiki(kind.root);
      continue;
    }
    const doc = await loadPath(path);
    if (!doc) continue;
    const active = activeTab(state);
    const replace =
      fromOs && settings.files.openFromOs === "replaceCurrent" && active && !active.wiki && !active.settings;
    if (replace && active.path.toLowerCase() !== doc.path.toLowerCase()) {
      void invoke("close_document", { path: active.path });
      scrollPositions.delete(active.path);
      setState(replaceTab(state, state.activeIndex, doc));
    } else {
      setState(openTab(state, doc));
    }
  }
}

async function reloadDocument(path: string): Promise<void> {
  const old = state.tabs.find((tab) => tab.path.toLowerCase() === path.toLowerCase());
  const doc = await loadDocument(path, old?.wikiRoot);
  const wasShown = shown?.path === doc.path;
  const scroll = content.scrollTop;
  setState(updateTab(state, doc));
  if (wasShown) content.scrollTop = scroll;
}

function closeDocument(index: number): void {
  const doc = state.tabs[index];
  if (!doc) return;
  if (!doc.settings) {
    const entry: SessionTab = doc.wiki
      ? { kind: "wiki", root: doc.wiki.info.root, page: doc.wiki.page.path }
      : { kind: "document", path: doc.path };
    closedTabs = [entry, ...closedTabs].slice(0, MAX_CLOSED);
  }
  scrollPositions.delete(doc.path);
  if (doc.wiki) {
    // Keep watching what another tab still shows.
    const root = doc.wiki.info.root;
    const files = [doc.wiki.page.path, doc.wiki.sidebar?.path, doc.wiki.footer?.path].filter(
      (file): file is string => file !== undefined && !fileShownElsewhere(file, doc.path),
    );
    const lastTabOfWiki = !state.tabs.some((t) => t !== doc && t.wiki?.info.root === root);
    if (lastTabOfWiki) void invoke("close_wiki", { root, files });
    else for (const path of files) void invoke("close_document", { path });
  } else if (!doc.settings) {
    void invoke("close_document", { path: doc.path });
  }
  setState(closeTab(state, index));
}

/** True if a tab other than `exceptTab` shows `file` (as a document or a wiki page, sidebar or footer). */
function fileShownElsewhere(file: string, exceptTab: string): boolean {
  const same = (path: string | undefined) => path?.toLowerCase() === file.toLowerCase();
  return state.tabs.some(
    (t) =>
      t.path !== exceptTab &&
      (t.wiki ? same(t.wiki.page.path) || same(t.wiki.sidebar?.path) || same(t.wiki.footer?.path) : same(t.path)),
  );
}

function errorDocument(path: string, message: string): OpenDocument {
  const title = path.split(/[\\/]/).pop() ?? path;
  return { path, title, html: errorHtml(message) };
}

function errorHtml(message: string): string {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  return p.outerHTML;
}

async function openPendingPaths(): Promise<void> {
  await openPaths(await invoke<string[]>("take_pending_paths"), true);
}

async function showOpenDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
  });
  if (selected) await openPaths(Array.isArray(selected) ? selected : [selected]);
}

async function showOpenWikiDialog(): Promise<void> {
  const selected = await openDialog({ directory: true, multiple: false, title: "Open wiki folder" });
  if (typeof selected === "string") await openWiki(selected);
}

// ---------------------------------------------------------------- wiki

async function loadWikiPage(root: string, path: string): Promise<WikiDocument> {
  try {
    return await invoke<WikiDocument>("open_wiki_page", { root, path });
  } catch (error) {
    const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? path;
    return {
      path,
      name,
      title: name.replace(/-/g, " "),
      html: errorHtml(String(error)),
      missingLinks: [],
      modifiedMs: null,
    };
  }
}

async function loadOptionalPage(root: string, path: string | null): Promise<WikiDocument | null> {
  return path ? loadWikiPage(root, path) : null;
}

/** Indexes a wiki and renders `page` (default: Home) with its sidebar and footer. */
async function loadWikiTab(root: string, page?: string, history?: History): Promise<OpenDocument> {
  const info = await invoke<WikiInfo>("open_wiki", { root });
  const known = page && info.pages.some((p) => p.path.toLowerCase() === page.toLowerCase());
  const pagePath = known ? page : info.home;
  const [pageDoc, sidebar, footer] = await Promise.all([
    loadWikiPage(info.root, pagePath),
    loadOptionalPage(info.root, info.sidebar),
    loadOptionalPage(info.root, info.footer),
  ]);
  return wikiTab({ info, page: pageDoc, sidebar, footer, history: history ?? startHistory(pageDoc.path) });
}

/** A wiki tab. `tabPath` is the tab's id: the wiki folder, or `folder::2`… for more tabs of it. */
function wikiTab(view: WikiView, tabPath = view.info.root): OpenDocument {
  return { path: tabPath, title: view.info.name, html: view.page.html, wiki: view };
}

/** Ctrl+click / middle-click on a wiki link: the page in a new tab of the same wiki. */
async function openWikiPageInNewTab(path: string, fragment?: string | null): Promise<void> {
  const root = shownWikiRoot();
  if (!root) return;
  const tab = await loadWikiTab(root, path);
  const tabPath = uniqueTabPath(
    state.tabs.map((t) => t.path),
    root,
  );
  pendingScroll = { tab: tabPath, top: 0, fragment: fragment ?? undefined };
  setState(openTab(state, { ...tab, path: tabPath }));
}

/** Opens a wiki folder in a tab (or switches to it), optionally at a page. */
async function openWiki(root: string, page?: string): Promise<void> {
  const info = await invoke<WikiInfo>("open_wiki", { root });
  const index = state.tabs.findIndex((tab) => tab.wiki?.info.root.toLowerCase() === info.root.toLowerCase());
  if (index >= 0) {
    setState(activateTab(state, index));
    if (page) await goToWikiPage(page);
    return;
  }
  setState(openTab(state, await loadWikiTab(info.root, page)));
}

/** Shows another page in the active wiki tab and adds it to the tab's history. */
async function goToWikiPage(path: string, fragment?: string | null): Promise<void> {
  const tab = shown;
  if (!tab?.wiki) return;
  const view = tab.wiki;
  if (view.page.path.toLowerCase() === path.toLowerCase()) {
    if (fragment) scrollToId(fragment);
    else content.scrollTop = 0;
    return;
  }
  const history = navigate(view.history, path, content.scrollTop);
  await showWikiPage(tab, path, history, 0, fragment ?? undefined);
}

/** Back (-1) or forward (+1) in the active wiki tab. */
async function stepWikiHistory(direction: -1 | 1): Promise<void> {
  const tab = shown;
  if (!tab?.wiki) return;
  const history = step(tab.wiki.history, direction, content.scrollTop);
  if (!history) return;
  const entry = currentEntry(history);
  await showWikiPage(tab, entry.path, history, entry.scroll);
}

async function showWikiPage(
  tab: OpenDocument,
  path: string,
  history: History,
  scroll: number,
  fragment?: string,
): Promise<void> {
  const view = tab.wiki;
  if (!view) return;
  const page = await loadWikiPage(view.info.root, path);
  // Stop watching the page we left (unless something still shows it).
  const old = view.page.path;
  if (![page.path, view.sidebar?.path, view.footer?.path].includes(old) && !fileShownElsewhere(old, tab.path)) {
    void invoke("close_document", { path: old });
  }
  // The tab may have changed while the page loaded; use its latest version.
  const latest = state.tabs.find((t) => t.path === tab.path)?.wiki ?? view;
  pendingScroll = { tab: tab.path, top: scroll, fragment };
  setState(updateTab(state, wikiTab({ ...latest, page, history }, tab.path)));
}

/** Re-renders whatever part of a wiki tab `path` is (page, sidebar or footer). */
async function refreshWikiFile(tab: OpenDocument, path: string): Promise<void> {
  const view = tab.wiki;
  if (!view) return;
  const same = (doc: WikiDocument | null) => doc?.path.toLowerCase() === path.toLowerCase();
  if (!same(view.page) && !same(view.sidebar) && !same(view.footer)) return;
  const doc = await loadWikiPage(view.info.root, path);
  const latest = state.tabs.find((t) => t.path === tab.path)?.wiki ?? view;
  const next: WikiView = {
    ...latest,
    page: same(latest.page) ? doc : latest.page,
    sidebar: same(latest.sidebar) ? doc : latest.sidebar,
    footer: same(latest.footer) ? doc : latest.footer,
  };
  const isShown = shown?.path === tab.path;
  const scroll = content.scrollTop;
  if (isShown) pendingScroll = { tab: tab.path, top: scroll };
  setState(updateTab(state, wikiTab(next, tab.path)));
}

/** Pages were added, renamed or removed: refresh the page list (and the page, if it moved). */
async function refreshWikiPages(root: string): Promise<void> {
  const isThisWiki = (t: OpenDocument) => t.wiki?.info.root.toLowerCase() === root.toLowerCase();
  if (!state.tabs.some(isThisWiki)) return;
  const info = await invoke<WikiInfo>("open_wiki", { root });
  // Most events are plain edits, already handled by `document-changed`.
  const names = (i: WikiInfo) => JSON.stringify([i.pages.map((p) => p.path), i.sidebar, i.footer]);
  for (const tab of state.tabs.filter(isThisWiki)) {
    const latest = tab.wiki;
    if (!latest || names(info) === names(latest.info)) continue;
    if (shown?.path === tab.path) pendingScroll = { tab: tab.path, top: content.scrollTop };
    setState(updateTab(state, wikiTab({ ...latest, info }, tab.path)));
  }
}

/** Reloads the active tab from disk (F5). */
async function reloadActive(): Promise<void> {
  const tab = shown;
  if (!tab) return;
  if (!tab.wiki) {
    await reloadDocument(tab.path);
    return;
  }
  const reloaded = await loadWikiTab(tab.wiki.info.root, tab.wiki.page.path, tab.wiki.history);
  pendingScroll = { tab: tab.path, top: content.scrollTop };
  setState(updateTab(state, { ...reloaded, path: tab.path }));
}

/** A file changed on disk: reload every tab that shows it. */
function onDocumentChanged(path: string): void {
  if (!settings.files.autoReload) return;
  for (const tab of state.tabs) {
    if (tab.wiki) void refreshWikiFile(tab, path).catch(reportError);
    else if (tab.path.toLowerCase() === path.toLowerCase()) void reloadDocument(path).catch(reportError);
  }
}

// ---------------------------------------------------------------- settings

/** Saves a change; the `settings-changed` event then applies it everywhere. */
function updateSettings(changes: SettingsChanges): void {
  void invoke<Settings>("update_settings", { changes }).then(onSettingsChanged, reportError);
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const THEME_KEY = "atc-markdown.theme";

/** Applies theme, classes and CSS variables for the current settings. */
/** True while the print preview is open (the page must not change under it). */
let printing = false;
window.addEventListener("beforeprint", () => (printing = true));
window.addEventListener("afterprint", () => {
  printing = false;
  applySettings();
});

function applySettings(): void {
  // Print mode reports a light colour scheme; redrawing now would print diagrams as source.
  if (printing) return;
  const look = applied(settings, systemDark.matches);
  const themeChanged = document.documentElement.dataset.theme !== look.theme;
  document.documentElement.dataset.theme = look.theme;
  // Diagrams are drawn in the theme's colours.
  if (themeChanged && preview.querySelector(".mermaid-diagram")) rerenderShown();
  for (const [name, on] of Object.entries(look.classes)) document.body.classList.toggle(name, on);
  for (const [name, value] of Object.entries(look.vars)) document.documentElement.style.setProperty(name, value);
  if (!settings.appearance.readingFont) document.documentElement.style.removeProperty("--font-sans");
  if (!settings.appearance.codeFont) document.documentElement.style.removeProperty("--font-mono");
  try {
    // Remembered so the next start paints in the right colours before settings load.
    localStorage.setItem(THEME_KEY, look.theme);
  } catch {
    // Only a startup flash then.
  }
}

/** Uses the last theme straight away, so a dark-mode start doesn't flash white. */
function applyCachedTheme(): void {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    document.documentElement.dataset.theme = theme === "dark" || theme === "light" ? theme : systemDark.matches ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = systemDark.matches ? "dark" : "light";
  }
}

function onSettingsChanged(next: Settings): void {
  const before = settings;
  settings = next;
  applySettings();
  if (before.appearance.codeTheme !== next.appearance.codeTheme) void loadHighlightCss().catch(reportError);
  if (needsRerender(before, next)) void reloadAllTabs().catch(reportError);
  else if (before.rendering.mermaid !== next.rendering.mermaid) rerenderShown();
  if (shown?.settings) renderSettings();
  updateOutline();
  // Wiki chrome (page list, banner) reads settings while rendering.
  if (before.wiki.offerOpenAsWiki !== next.wiki.offerOpenAsWiki) renderBanner(shown);
}

function renderSettings(): void {
  renderSettingsView(settingsView, settings, codeThemes, {
    update: updateSettings,
    reset: (section) => {
      void invoke<Settings>("default_settings")
        .then((defaults) => updateSettings({ [section]: defaults[section] } as SettingsChanges))
        .catch(reportError);
    },
    revealFile: () => void invoke("reveal_settings_file").catch(reportError),
  });
}

function openSettings(): void {
  setState(openTab(state, { path: SETTINGS_TAB_PATH, title: "Settings", html: "", settings: true }));
}

/** Renders every open tab again (after a rendering setting changed). */
async function reloadAllTabs(): Promise<void> {
  for (const tab of state.tabs) {
    if (tab.settings) continue;
    if (tab.wiki) {
      const latest = state.tabs.find((t) => t.path === tab.path)?.wiki ?? tab.wiki;
      const reloaded = { ...(await loadWikiTab(latest.info.root, latest.page.path, latest.history)), path: tab.path };
      if (shown?.path === tab.path) pendingScroll = { tab: tab.path, top: content.scrollTop };
      setState(updateTab(state, reloaded));
    } else {
      await reloadDocument(tab.path);
    }
  }
}

/**
 * Settings used to live in browser storage; move them into settings.json once.
 */
function migrateOldSettings(): void {
  try {
    const keys = ["atc-markdown.zoom", "atc-markdown.sidebar-width", "atc-markdown.sidebar-hidden"] as const;
    const [zoom, width, hidden] = keys.map((key) => localStorage.getItem(key));
    const changes: SettingsChanges = {};
    if (zoom && Number(zoom) > 0) changes.appearance = { textSize: Math.round(Number(zoom) * 100) };
    if (width || hidden) {
      changes.wiki = {};
      if (width && Number(width) > 0) changes.wiki.sidebarWidth = Math.round(Number(width));
      if (hidden) changes.wiki.sidebarVisible = hidden !== "true";
    }
    if (Object.keys(changes).length > 0) updateSettings(changes);
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Nothing to migrate.
  }
}

// ---------------------------------------------------------------- sidebar

function toggleSidebar(): void {
  updateSettings({ wiki: { sidebarVisible: !settings.wiki.sidebarVisible } });
}

let searchTimer: number | undefined;
let searchRun = 0;

/** Full-text search across the wiki, a moment after typing stops (3+ characters). */
function scheduleWikiSearch(): void {
  window.clearTimeout(searchTimer);
  const query = wikiPagesFilter.value.trim();
  const root = shownWikiRoot();
  if (!root || query.length < 3) {
    renderSearchResults(wikiSearchTitle, wikiSearchResults, undefined, () => {});
    return;
  }
  searchTimer = window.setTimeout(() => {
    const run = ++searchRun;
    void invoke<SearchHit[]>("search_wiki", { root, query })
      .then((hits) => {
        if (run !== searchRun) return;
        renderSearchResults(wikiSearchTitle, wikiSearchResults, hits, (hit) => void openSearchHit(hit, query));
      })
      .catch(reportError);
  }, 250);
}

/** Opens a search result and highlights the text with Find. */
async function openSearchHit(hit: SearchHit, query: string): Promise<void> {
  await goToWikiPage(hit.page.path);
  findInput.value = query;
  openFind();
  scrollToCurrentMatch();
}

/** Ctrl+P: jump to a page of the active wiki by typing part of its title. */
function focusPageFilter(): void {
  if (!shown?.wiki) return;
  if (!settings.wiki.sidebarVisible) updateSettings({ wiki: { sidebarVisible: true } });
  document.body.classList.remove("sidebar-hidden", "page-list-hidden");
  wikiPages.open = true;
  wikiPagesFilter.focus();
  wikiPagesFilter.select();
  wikiPages.scrollIntoView({ block: "nearest" });
}

function wireSidebar(): void {
  wikiSplitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    wikiSplitter.setPointerCapture(e.pointerId);
    wikiSplitter.classList.add("dragging");
    const box = viewport.getBoundingClientRect();
    const onRight = settings.wiki.sidebarPosition === "right";
    let width = settings.wiki.sidebarWidth;
    const move = (m: PointerEvent) => {
      const raw = onRight ? box.right - m.clientX : m.clientX - box.left;
      width = Math.round(Math.min(Math.max(raw, 160), box.width * 0.5));
      document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    };
    const up = () => {
      wikiSplitter.classList.remove("dragging");
      wikiSplitter.removeEventListener("pointermove", move);
      updateSettings({ wiki: { sidebarWidth: width } });
    };
    wikiSplitter.addEventListener("pointermove", move);
    wikiSplitter.addEventListener("pointerup", up, { once: true });
  });

  wikiPagesFilter.addEventListener("input", () => {
    const view = shown?.wiki;
    if (view) renderPagesList(wikiPagesSummary, wikiPagesList, view, wikiPagesFilter.value, (path) => void goToWikiPage(path));
    scheduleWikiSearch();
  });
  wikiPagesFilter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      wikiPagesList.querySelector("button")?.click();
    } else if (e.key === "Escape") {
      wikiPagesFilter.value = "";
      wikiPagesFilter.dispatchEvent(new Event("input"));
    }
  });
}

// ---------------------------------------------------------------- recent & closed

const RECENT_KEY = "atc-markdown.recent";
/** Closed tabs, newest first (this session only). */
let closedTabs: SessionTab[] = [];


function loadRecent(): RecentEntry[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

function saveRecent(list: RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Not remembered then.
  }
}

function rememberRecent(doc: OpenDocument): void {
  const entry: RecentEntry = doc.wiki
    ? { kind: "wiki", path: doc.path, title: doc.title }
    : { kind: "document", path: doc.path, title: doc.title };
  saveRecent(remember(loadRecent(), entry, MAX_RECENT));
}

/** The "Recent" list on the start page. */
function renderRecent(): void {
  const list = loadRecent();
  recentSection.hidden = list.length === 0;
  recentList.replaceChildren(
    ...list.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.title = entry.path;
      const name = document.createElement("span");
      name.className = "recent-name";
      name.textContent = `${entry.kind === "wiki" ? "📚" : "📄"} ${entry.title}`;
      const where = document.createElement("span");
      where.className = "recent-path";
      where.textContent = entry.path;
      button.append(name, where);
      button.addEventListener("click", () => void openPaths([entry.path]).catch(reportError));
      item.append(button);
      return item;
    }),
  );
}

/** Ctrl+Shift+T: opens the last closed tab again. */
async function reopenClosedTab(): Promise<void> {
  const [tab, ...rest] = closedTabs;
  if (!tab) return;
  closedTabs = rest;
  const doc = await restoreTab(tab);
  if (!doc) {
    showToast("That file is no longer there");
    return;
  }
  // A wiki may still be open in another tab; the reopened one gets its own tab.
  const path = doc.wiki
    ? uniqueTabPath(
        state.tabs.map((t) => t.path),
        doc.path,
      )
    : doc.path;
  setState(openTab(state, { ...doc, path }));
}

// ---------------------------------------------------------------- session

const SESSION_KEY = "atc-markdown.session";

function saveSession(): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(toSession(state)));
  } catch {
    // Storage can be unavailable; tabs then just aren't reopened.
  }
}

function loadSession(): Session | undefined {
  try {
    return parseSession(localStorage.getItem(SESSION_KEY));
  } catch {
    return undefined;
  }
}

async function restoreTab(tab: SessionTab): Promise<OpenDocument | undefined> {
  if (tab.kind === "document") {
    const doc = await tryLoadDocument(tab.path);
    if (!doc) return undefined;
    const kind = await invoke<PathKind>("path_kind", { path: doc.path });
    return kind.kind === "document" && kind.wikiRoot ? { ...doc, wikiRoot: kind.wikiRoot } : doc;
  }
  try {
    return await loadWikiTab(tab.root, tab.page);
  } catch {
    return undefined;
  }
}

/**
 * Reopens last session's tabs together with the files the app was started
 * with, in one step, so the started-with file always ends up active.
 */
async function startup(): Promise<void> {
  const session = settings.files.restoreSession ? loadSession() : undefined;
  const pending = await invoke<string[]>("take_pending_paths");
  const [restored, opened] = await Promise.all([
    Promise.all((session?.tabs ?? []).map(restoreTab)),
    Promise.all(pending.map((path) => loadPath(path).catch(() => undefined))),
  ]);
  const openedDocs = opened.filter((doc): doc is OpenDocument => doc !== undefined);
  const ids: string[] = [];
  for (const [i, doc] of restored.entries()) {
    if (!doc?.wiki) continue;
    const id = uniqueTabPath(ids, doc.path);
    ids.push(id);
    restored[i] = { ...doc, path: id };
  }
  setState(startupState(restored, session?.active ?? null, openedDocs));
}

// ---------------------------------------------------------------- links

function scrollToId(id: string): void {
  const target = preview.querySelector(`[id="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: "start" });
}

const isMac = navigator.userAgent.includes("Mac");

function linkFromEvent(e: Event): HTMLAnchorElement | null {
  return e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
}

// The webview never navigates: every click is handed to Rust, which decides.
async function followHref(href: string, newTab = false): Promise<void> {
  const documentPath = shownPath();
  if (!documentPath) return;
  const wikiRoot = shownWikiRoot();
  if (settings.links.confirmExternal) {
    const preview = await describeHref(href);
    if (preview?.kind === "external" && !/^mailto:/i.test(preview.url)) {
      const ok = await ask(`Open this address in your browser?\n\n${preview.url}`, {
        title: "Open web link",
        kind: "info",
        okLabel: "Open",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    }
  }
  const target = await invoke<LinkTarget>("follow_link", { documentPath, href, wikiRoot });
  switch (target.kind) {
    case "anchor":
      scrollToId(target.id);
      break;
    case "document":
      if (wikiRoot && isInside(wikiRoot, target.path)) {
        if (newTab) await openWikiPageInNewTab(target.path, target.fragment);
        else await goToWikiPage(target.path, target.fragment);
      } else {
        await openPaths([target.path]);
        if (target.fragment) scrollToId(target.fragment);
      }
      break;
    default:
      break; // external links and local files are handled in Rust
  }
}

async function handleLinkClick(e: MouseEvent): Promise<void> {
  const link = linkFromEvent(e);
  if (!link) return;
  e.preventDefault();
  closeLinkMenu();
  if (link.classList.contains("anchor")) {
    await copySectionLink(link);
    return;
  }
  const href = link.getAttribute("href");
  if (href) await followHref(href, e.ctrlKey || e.metaKey || e.button === 1);
}

/**
 * The "#" next to a heading: jumps there and copies a link to the section —
 * the github.com address for a wiki page, otherwise a Markdown link.
 */
async function copySectionLink(anchor: HTMLAnchorElement): Promise<void> {
  const id = (anchor.getAttribute("href") ?? "").replace(/^#/, "");
  if (!id) return;
  scrollToId(id);
  const heading = anchor.parentElement?.textContent?.trim() ?? id;
  const view = shown?.wiki;
  const url = view ? pageUrl(view.info.url, view.page.name) : undefined;
  const link = url ? `${url}#${id}` : `[${heading}](#${id})`;
  await copyText(link);
  showToast(url ? "Link to section copied" : "Markdown link to section copied");
}

// ---------------------------------------------------------------- link preview

/** Results of `describe_link`, per document and href. Cleared when the shown document changes. */
const linkPreviews = new Map<string, Promise<LinkPreview>>();

function describeHref(href: string): Promise<LinkPreview> | undefined {
  const documentPath = shownPath();
  if (!documentPath) return undefined;
  const key = `${documentPath}\n${href}`;
  let result = linkPreviews.get(key);
  if (!result) {
    result = invoke<LinkPreview>("describe_link", { documentPath, href, wikiRoot: shownWikiRoot() });
    linkPreviews.set(key, result);
  }
  return result;
}

const ICONS: Record<IconName | "warning", string> = {
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  blocked: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  warning:
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
};

function icon(name: IconName | "warning"): HTMLElement {
  const el = document.createElement("span");
  el.className = "link-status-icon";
  // Static markup from ICONS above; no document content goes in here.
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return el;
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function fillLinkStatus(bubble: BubbleContent): void {
  const target = document.createElement("span");
  target.className = "link-status-target";
  const strong = document.createElement("b");
  strong.textContent = bubble.target.strong;
  target.append(bubble.target.before, strong, bubble.target.after);

  const parts: HTMLElement[] = [icon(bubble.icon), span("link-status-action", bubble.action), target];
  if (bubble.problem) parts.push(span("link-status-problem", `(${bubble.problem})`));
  if (bubble.warning) {
    const warning = document.createElement("div");
    warning.className = "link-status-warning";
    warning.append(icon("warning"), bubble.warning);
    parts.push(warning);
  }
  linkStatus.replaceChildren(...parts);
  linkStatus.classList.toggle("blocked", bubble.icon === "blocked");
}

let hoveredLink: HTMLAnchorElement | undefined;
let linkStatusTimer: number | undefined;

function linkContext(link: HTMLAnchorElement) {
  const path = shownPath() ?? "";
  return {
    linkText: link.textContent ?? "",
    documentDir: path.replace(/[\\/][^\\/]*$/, ""),
    isOpen: (p: string) => state.tabs.some((tab) => tab.path.toLowerCase() === p.toLowerCase()),
    headingText: (id: string) => preview.querySelector(`[id="${CSS.escape(id)}"]`)?.textContent?.trim(),
    isMac,
    wikiRoot: shownWikiRoot(),
  };
}

function showLinkStatus(link: HTMLAnchorElement): void {
  hoveredLink = link;
  window.clearTimeout(linkStatusTimer);
  if (!settings.links.statusBubble) return;
  const href = link.getAttribute("href");
  if (!href) return;
  linkStatusTimer = window.setTimeout(() => {
    describeHref(href)?.then((result) => {
      if (hoveredLink !== link) return;
      fillLinkStatus(describeLink(result, linkContext(link)));
      // Move to the right corner if the bubble would cover the link itself.
      const box = content.getBoundingClientRect();
      const rect = link.getBoundingClientRect();
      linkStatus.classList.toggle("right", rect.bottom > box.bottom - 56 && rect.left < box.left + box.width * 0.6);
      linkStatus.classList.add("visible");
      linkStatus.setAttribute("aria-hidden", "false");
    }, reportError);
  }, 100);
}

function hideLinkStatus(): void {
  hoveredLink = undefined;
  window.clearTimeout(linkStatusTimer);
  linkStatus.classList.remove("visible");
  linkStatus.setAttribute("aria-hidden", "true");
}

// ---------------------------------------------------------------- link context menu

function menuItem(label: string, action: () => unknown): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("click", () => {
    closeLinkMenu();
    Promise.resolve()
      .then(action)
      .catch(reportError);
  });
  return button;
}

async function openLinkMenu(link: HTMLAnchorElement, x: number, y: number): Promise<void> {
  const href = link.getAttribute("href");
  const result = href ? await describeHref(href) : undefined;
  const documentPath = shownPath();
  if (!href || !result || !documentPath) return;

  const items = [menuItem(result.kind === "external" ? "Open link" : "Open", () => followHref(href))];
  let address: string | undefined;
  if (result.kind === "external") address = result.url;
  else if (result.kind === "document" || result.kind === "localFile") address = result.path;
  else if (result.kind === "anchor") address = `${documentPath}#${result.id}`;
  if (address !== undefined) {
    const text = address;
    items.push(menuItem(result.kind === "external" ? "Copy link address" : "Copy path", () => copyText(text)));
  }
  if ((result.kind === "document" || result.kind === "localFile") && result.exists) {
    const path = result.path;
    items.push(menuItem(isMac ? "Show in Finder" : "Show in Explorer", () => invoke("reveal_path", { path })));
  }

  hideLinkStatus();
  linkMenu.replaceChildren(...items);
  linkMenu.hidden = false;
  // Keep the menu inside the window.
  const { width, height } = linkMenu.getBoundingClientRect();
  linkMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  linkMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  items[0]?.focus();
}

function closeLinkMenu(): void {
  linkMenu.hidden = true;
}

function handleMenuKeys(e: KeyboardEvent): void {
  const items = [...linkMenu.querySelectorAll<HTMLButtonElement>("button")];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const direction = e.key === "ArrowDown" ? 1 : -1;
    items[(index + direction + items.length) % items.length]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeLinkMenu();
  }
}

/** Link clicks, hover previews and context menus for every rendered area. */
function wireLinks(): void {
  for (const area of [preview, wikiSidebarBody, wikiFooter]) {
    area.addEventListener("click", (e) => void handleLinkClick(e).catch(reportError));
    // Middle-click opens in a new tab (and must not start auto-scrolling).
    area.addEventListener("mousedown", (e) => {
      if (e.button === 1 && linkFromEvent(e)) e.preventDefault();
    });
    area.addEventListener("auxclick", (e) => {
      if (e.button === 1 && linkFromEvent(e)) void handleLinkClick(e).catch(reportError);
    });
    area.addEventListener("mouseover", (e) => {
      const link = linkFromEvent(e);
      if (link && link !== hoveredLink) showLinkStatus(link);
      else if (!link && hoveredLink) hideLinkStatus();
    });
    area.addEventListener("mouseleave", hideLinkStatus);
    area.addEventListener("focusin", (e) => {
      const link = linkFromEvent(e);
      if (link) showLinkStatus(link);
    });
    area.addEventListener("focusout", hideLinkStatus);
    area.addEventListener("contextmenu", (e) => {
      const link = linkFromEvent(e);
      if (!link) return;
      e.preventDefault();
      void openLinkMenu(link, e.clientX, e.clientY).catch(reportError);
    });
  }
  let outlineFrame = 0;
  content.addEventListener(
    "scroll",
    () => {
      if (outline.hidden) return;
      cancelAnimationFrame(outlineFrame);
      outlineFrame = requestAnimationFrame(() => highlightCurrent(outlineList, preview, content));
    },
    { passive: true },
  );
  for (const scroller of [content, wikiSidebar]) {
    scroller.addEventListener(
      "scroll",
      () => {
        hideLinkStatus();
        closeLinkMenu();
      },
      { passive: true },
    );
  }
  linkMenu.addEventListener("keydown", handleMenuKeys);
  document.addEventListener("mousedown", (e) => {
    if (!linkMenu.hidden && !linkMenu.contains(e.target as Node)) closeLinkMenu();
  });
  window.addEventListener("blur", () => {
    hideLinkStatus();
    closeLinkMenu();
  });
  // Mouse back/forward buttons navigate wiki history.
  document.addEventListener("mouseup", (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      runCommand(e.button === 3 ? "go-back" : "go-forward");
    }
  });
}

// ---------------------------------------------------------------- find

/** The CSS Custom Highlight API marks matches without touching the HTML (Safari < 17.2 lacks it). */
const canHighlight = typeof Highlight !== "undefined" && "highlights" in CSS;

let matches: Range[] = [];
let current = -1;

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function openFind(): void {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  runFind();
}

function closeFind(): void {
  findBar.hidden = true;
  matches = [];
  current = -1;
  paintMatches();
  if (document.activeElement === findInput) findInput.blur();
}

/** Searches the shown document and selects the first match from the top of the view. */
function runFind(): void {
  const nodes = preview.hidden ? [] : textNodes(preview);
  matches = findMatches(
    nodes.map((node) => node.data),
    findInput.value,
  ).map(({ start, end }) => {
    const range = document.createRange();
    range.setStart(nodes[start.node]!, start.offset);
    range.setEnd(nodes[end.node]!, end.offset);
    return range;
  });

  const top = content.getBoundingClientRect().top;
  current = matches.findIndex((range) => range.getBoundingClientRect().bottom > top);
  if (current < 0 && matches.length > 0) current = 0;
  paintMatches();
}

function stepFind(direction: 1 | -1): void {
  if (findBar.hidden) {
    openFind();
    return;
  }
  if (matches.length === 0) return;
  current = (current + direction + matches.length) % matches.length;
  paintMatches();
  scrollToCurrentMatch();
}

function paintMatches(): void {
  const range = matches[current];
  if (canHighlight) {
    CSS.highlights.set("find-match", new Highlight(...matches));
    CSS.highlights.set("find-current", range ? new Highlight(range) : new Highlight());
  } else if (range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  const query = findInput.value;
  findCount.textContent = query === "" ? "" : matches.length === 0 ? "No results" : `${current + 1} of ${matches.length}`;
  findInput.classList.toggle("no-results", query !== "" && matches.length === 0);
}

function scrollToCurrentMatch(): void {
  const range = matches[current];
  if (!range) return;
  const rect = range.getBoundingClientRect();
  const view = content.getBoundingClientRect();
  if (rect.top < view.top + 48 || rect.bottom > view.bottom - 24) {
    content.scrollTop += rect.top - view.top - view.height / 3;
  }
}

function handleFindKeys(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  }
}

// ---------------------------------------------------------------- zoom

// Zoom is the "Text size" setting.

function setTextSize(percent: number): void {
  // Apply at once for a responsive feel; the settings event confirms it.
  document.documentElement.style.setProperty("--zoom", String(percent / 100));
  updateSettings({ appearance: { textSize: percent } });
}

function stepZoom(direction: 1 | -1): void {
  setTextSize(stepTextSize(settings.appearance.textSize, direction));
}

/** Print / Save as PDF (the print stylesheet shows just the document, in light colours). */
function printDocument(): void {
  if (!shown || shown.settings) return;
  window.print();
}

// ---------------------------------------------------------------- commands

function stepTab(direction: 1 | -1): void {
  if (state.tabs.length < 2) return;
  setState(activateTab(state, (state.activeIndex + direction + state.tabs.length) % state.tabs.length));
}

function runCommand(command: Command): void {
  const run = (task: Promise<void>) => void task.catch(reportError);
  switch (command) {
    case "open":
      run(showOpenDialog());
      break;
    case "open-wiki":
      run(showOpenWikiDialog());
      break;
    case "close-tab":
      if (state.activeIndex >= 0) closeDocument(state.activeIndex);
      break;
    case "go-back":
      run(stepWikiHistory(-1));
      break;
    case "go-forward":
      run(stepWikiHistory(1));
      break;
    case "toggle-sidebar":
      toggleSidebar();
      break;
    case "find-page":
      focusPageFilter();
      break;
    case "settings":
      openSettings();
      break;
    case "reopen-tab":
      run(reopenClosedTab());
      break;
    case "toggle-outline":
      updateSettings({ appearance: { showOutline: !settings.appearance.showOutline } });
      break;
    case "print":
      printDocument();
      break;
    case "reload":
      run(reloadActive());
      break;
    case "find":
      openFind();
      break;
    case "find-next":
      stepFind(1);
      break;
    case "find-previous":
      stepFind(-1);
      break;
    case "zoom-in":
      stepZoom(1);
      break;
    case "zoom-out":
      stepZoom(-1);
      break;
    case "zoom-reset":
      setTextSize(100);
      break;
    case "next-tab":
      stepTab(1);
      break;
    case "previous-tab":
      stepTab(-1);
      break;
  }
}

/** Maps a key press to a command. Also claims the browser's own shortcuts (reload, find). */
function commandForKey(e: KeyboardEvent): Command | undefined {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "F5" || (mod && key === "r")) return "reload";
  if (e.key === "F3") return e.shiftKey ? "find-previous" : "find-next";
  if (e.altKey && !mod && e.key === "ArrowLeft") return "go-back";
  if (e.altKey && !mod && e.key === "ArrowRight") return "go-forward";
  if (e.key === "BrowserBack") return "go-back";
  if (e.key === "BrowserForward") return "go-forward";
  if (!mod) return undefined;
  if (e.ctrlKey && e.key === "Tab") return e.shiftKey ? "previous-tab" : "next-tab";
  switch (key) {
    case "o":
      return e.shiftKey ? "open-wiki" : "open";
    case "w":
      return "close-tab";
    case "t":
      return e.shiftKey ? "reopen-tab" : undefined;
    case "b":
      return "toggle-sidebar";
    case "p":
      return e.shiftKey ? "print" : "find-page";
    case ",":
      return "settings";
    case "l":
      return e.shiftKey ? "toggle-outline" : undefined;
    case "f":
      return "find";
    case "g":
      return e.shiftKey ? "find-previous" : "find-next";
    case "+":
    case "=":
      return "zoom-in";
    case "-":
      return "zoom-out";
    case "0":
      return "zoom-reset";
    default:
      return undefined;
  }
}

function handleKeys(e: KeyboardEvent): void {
  const command = commandForKey(e);
  if (command) {
    e.preventDefault();
    runCommand(command);
  } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    setState(activateTab(state, Number(e.key) - 1));
  } else if (e.key === "Escape" && !findBar.hidden) {
    e.preventDefault();
    closeFind();
  }
}

// ---------------------------------------------------------------- startup

/** Loads (or replaces) the code colours for the chosen code theme. */
async function loadHighlightCss(): Promise<void> {
  let style = document.querySelector<HTMLStyleElement>("style#highlight-css");
  if (!style) {
    style = document.createElement("style");
    style.id = "highlight-css";
    document.head.append(style);
  }
  style.textContent = await invoke<string>("highlight_css");
}

function wireFindBar(): void {
  findInput.addEventListener("input", () => {
    runFind();
    scrollToCurrentMatch();
  });
  findInput.addEventListener("keydown", handleFindKeys);
  element("#find-previous").addEventListener("click", () => stepFind(-1));
  element("#find-next").addEventListener("click", () => stepFind(1));
  element("#find-close").addEventListener("click", closeFind);
}

async function main(): Promise<void> {
  applyCachedTheme();
  settings = await invoke<Settings>("get_settings");
  applySettings();
  migrateOldSettings();
  systemDark.addEventListener("change", applySettings);
  codeThemes = await invoke<CodeThemeChoice[]>("code_themes");

  document.addEventListener("keydown", handleKeys);
  wireLinks();
  wireSidebar();
  wireFindBar();
  element("#open-button").addEventListener("click", () => runCommand("open"));
  element("#open-wiki-button").addEventListener("click", () => runCommand("open-wiki"));
  element("#recent-clear").addEventListener("click", () => {
    saveRecent([]);
    renderRecent();
  });
  render();
  renderRecent();

  // After a webview reload, documents from before are no longer shown.
  await invoke("close_all_documents");
  await loadHighlightCss();
  await listen<Settings>("settings-changed", (event) => onSettingsChanged(event.payload));

  await getCurrentWebview().onDragDropEvent((event) => {
    const { payload } = event;
    document.body.classList.toggle("dragging", payload.type === "enter" || payload.type === "over");
    if (payload.type === "drop") {
      // Folders open as wikis; Markdown files as documents; anything else is ignored.
      void openPaths(payload.paths).catch(reportError);
    }
  });

  await listen<string>("document-changed", (event) => onDocumentChanged(event.payload));
  await listen<string>("wiki-changed", (event) => void refreshWikiPages(event.payload).catch(reportError));
  await listen<string>("menu-command", (event) => {
    if (isCommand(event.payload)) runCommand(event.payload);
  });

  await startup();

  // Listen first, then drain the queue, so no path is missed.
  await listen("files-pending", () => void openPendingPaths().catch(reportError));
  await openPendingPaths();
}

function reportError(error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  void invoke("log_frontend_error", { message }).catch(() => {});
}

window.addEventListener("error", (e) => reportError(e.error ?? e.message));
// A blocked resource (e.g. by the CSP) is not an "error" event; log it too.
document.addEventListener("securitypolicyviolation", (e) =>
  reportError(`CSP blocked ${e.blockedURI || "inline content"} (${e.violatedDirective})`),
);
window.addEventListener("unhandledrejection", (e) => reportError(e.reason));
main().catch(reportError);
