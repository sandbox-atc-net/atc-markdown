import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commandForKey, isCommand, type Command } from "./commands";
import { MarkdownEditor, type EditorOptions, type LintIssue } from "./editor";
import type { FenceLanguage } from "./fence-languages";
import { parseSourcePos, previewScrollFor, type Block } from "./scroll-sync";
import { copyText, enhance, enhanceRich } from "./enhance";
import {
  applied,
  needsRerender,
  stepTextSize,
  type Settings,
  type SettingsChanges,
  type LintRule,
  type ViewMode,
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
  isAppView,
  openTab,
  replaceTab,
  SETTINGS_TAB_PATH,
  uniqueTabPath,
  updateTab,
  UNTITLED_PREFIX,
  type EditInfo,
  type OpenDocument,
  type TabState,
} from "./tabs";
import {
  lintReportPath,
  renderLintReport,
  type FolderLint,
} from "./lint-report-view";
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
const reportView = element<HTMLElement>("#report-view");
const docBar = element<HTMLElement>("#doc-bar");
const editorPane = element<HTMLElement>("#editor-pane");
const editorSplitter = element<HTMLElement>("#editor-splitter");
const outline = element<HTMLElement>("#outline");
const outlineList = element<HTMLElement>("#outline-list");
const toast = element<HTMLElement>("#toast");
const recentSection = element<HTMLElement>("#recent");
const recentList = element<HTMLElement>("#recent-list");

let state: TabState = emptyTabs;
/** The user's settings; replaced on every `settings-changed` event. */
let settings: Settings;
let codeThemes: CodeThemeChoice[] = [];
let lintRules: LintRule[] = [];
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
  preview.hidden = doc === undefined || isAppView(doc);
  settingsView.hidden = doc?.settings !== true;
  reportView.hidden = doc?.lintReport === undefined;
  renderEditorLayout(doc);

  // Typing changes only the edit state (dirty marker); the preview is then updated
  // by the live render, not from the disk version here.
  const sameContent =
    doc !== undefined &&
    shown !== undefined &&
    doc.path === shown.path &&
    doc.html === shown.html &&
    doc.wiki === shown.wiki &&
    doc.settings === shown.settings &&
    doc.lintReport === shown.lintReport;
  if (doc !== shown && sameContent) {
    shown = doc;
    void getCurrentWindow().setTitle(windowTitle(doc));
  } else if (doc !== shown) {
    // `html` was sanitized in Rust (ammonia) before it reached us.
    preview.innerHTML = (doc && liveHtml.get(doc.path)) ?? doc?.html ?? "";
    enhance(preview);
    if (doc?.settings) renderSettings();
    if (doc?.lintReport) renderReport(doc.lintReport);
    renderWiki(doc);
    renderBanner(doc);

    const scroll = pendingScroll?.tab === doc?.path ? pendingScroll : undefined;
    pendingScroll = undefined;
    const top = scroll ? scroll.top : doc ? (scrollPositions.get(doc.path) ?? 0) : 0;
    content.scrollTop = top;
    shown = doc;
    if (scroll?.fragment) scrollToId(scroll.fragment);
    if (doc && !isAppView(doc)) void renderRich(doc, top, scroll?.fragment);
    updateOutline();
    if (doc && !isAppView(doc) && !doc.html.includes('class="error"')) rememberRecent(doc);
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
  const items = doc && !isAppView(doc) && settings.appearance.showOutline ? outlineItems(preview) : [];
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
  return `${doc.edit?.dirty ? "● " : ""}${doc.title} – ${APP_NAME}`;
}

function renderTab(doc: OpenDocument, index: number): HTMLElement {
  const tab = document.createElement("div");
  tab.className = doc.wiki ? "tab wiki" : doc.edit?.dirty ? "tab dirty" : "tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", String(index === state.activeIndex));
  tab.title = doc.wiki
    ? `${doc.wiki.info.name} wiki – ${doc.path}`
    : doc.lintReport
      ? `Lint report – ${doc.lintReport.root}`
      : doc.path;
  tab.addEventListener("click", () => setState(activateTab(state, index)));
  tab.addEventListener("auxclick", (e) => {
    if (e.button === 1) void closeDocument(index);
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
    void closeDocument(index);
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
    edit: () => void editWikiPage().catch(reportError),
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
    // A tab being edited is only switched to: loading it again would drop its edit state.
    const editing = state.tabs.findIndex((t) => t.edit !== undefined && t.path.toLowerCase() === path.toLowerCase());
    if (editing >= 0) {
      setState(activateTab(state, editing));
      continue;
    }
    const doc = await loadPath(path);
    if (!doc) continue;
    const active = activeTab(state);
    const replace =
      fromOs &&
      settings.files.openFromOs === "replaceCurrent" &&
      active &&
      !active.wiki &&
      !isAppView(active) &&
      !active.edit?.dirty &&
      !active.edit?.untitled;
    const alreadyOpen = state.tabs.some((t) => t.path.toLowerCase() === doc.path.toLowerCase());
    if (replace && active.path.toLowerCase() !== doc.path.toLowerCase()) {
      void invoke("close_document", { path: active.path });
      scrollPositions.delete(active.path);
      forgetEditor(active.path);
      setState(replaceTab(state, state.activeIndex, doc));
    } else {
      setState(openTab(state, doc));
    }
    if (!alreadyOpen && settings.editor.defaultMode !== "preview") await setMode(settings.editor.defaultMode);
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

async function closeDocument(index: number): Promise<void> {
  const asked = state.tabs[index];
  if (!asked) return;
  if (!(await confirmDiscard(asked))) return;
  // The tab list may have changed while the dialog was open.
  index = state.tabs.findIndex((t) => t.path === asked.path);
  const doc = state.tabs[index];
  if (!doc) return;
  forgetEditor(doc.path);
  if (doc.edit?.untitled) {
    setState(closeTab(state, index));
    return;
  }
  if (!isAppView(doc)) {
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
  } else if (!isAppView(doc)) {
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
  if (tab.lintReport) {
    await lintFolder(tab.lintReport.root);
    return;
  }
  if (tab.settings) return;
  if (tab.edit && editor.has(tab.path)) {
    if (tab.edit.untitled) return;
    if (tab.edit.dirty) {
      const discard = await ask("Reload from disk? Your unsaved changes will be lost.", {
        title: "Reload",
        kind: "warning",
        okLabel: "Reload",
        cancelLabel: "Cancel",
      });
      if (!discard) return;
    }
    await reloadFromDisk(tab.path);
    return;
  }
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
    else if (tab.path.toLowerCase() !== path.toLowerCase()) continue;
    else if (tab.edit && editor.has(tab.path)) void onEditedFileChanged(tab.path).catch(reportError);
    else void reloadDocument(path).catch(reportError);
  }
}

// ---------------------------------------------------------------- editing

/** The editor (one CodeMirror view; each tab has its own text and undo history). */
let editor: MarkdownEditor;
/** The text last loaded from or saved to disk, per tab, to know if there are unsaved edits. */
const savedDocs = new Map<string, ReturnType<MarkdownEditor["doc"]>>();
/** The latest live preview HTML per tab (newer than the tab's disk HTML while editing). */
const liveHtml = new Map<string, string>();
let untitledCount = 0;

/** Mirrors `SourceFile` in `atc-markdown-core`. */
interface SourceFile {
  path: string;
  text: string;
  lineEnding: "lf" | "crlf";
  bom: boolean;
  fingerprint: string;
}

const modeOf = (doc: OpenDocument | undefined): ViewMode =>
  doc && !doc.wiki && !isAppView(doc) ? (doc.edit?.mode ?? "preview") : "preview";

function forgetEditor(path: string): void {
  editor.forget(path);
  savedDocs.delete(path);
  liveHtml.delete(path);
}

function updateEdit(path: string, patch: Partial<EditInfo>): void {
  const doc = state.tabs.find((t) => t.path === path);
  if (!doc?.edit) return;
  setState(updateTab(state, { ...doc, edit: { ...doc.edit, ...patch } }));
}

/** Shows or hides the editor pane and toolbar for the active tab's mode. */
function renderEditorLayout(doc: OpenDocument | undefined): void {
  const mode = modeOf(doc);
  editorPane.hidden = mode === "preview";
  editorSplitter.hidden = mode !== "split";
  content.hidden = mode === "edit";
  viewport.classList.toggle("mode-edit", mode === "edit");
  viewport.classList.toggle("mode-split", mode === "split");
  if (doc && mode !== "preview") editor.show(doc.path);
  else editor.hide();
  renderDocBar(doc);
}

/** The toolbar above a document: view mode, line numbers, save state. */
function renderDocBar(doc: OpenDocument | undefined): void {
  docBar.hidden = !doc || Boolean(doc.wiki) || isAppView(doc);
  if (docBar.hidden || !doc) return;
  const mode = modeOf(doc);

  const modes = document.createElement("div");
  modes.className = "modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "View");
  for (const [value, label, title] of [
    ["preview", "Preview", "Rendered document"],
    ["split", "Split", "Editor and preview side by side"],
    ["edit", "Editor", "Markdown source only"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = `${title} (Ctrl+E switches)`;
    button.setAttribute("aria-pressed", String(mode === value));
    button.addEventListener("click", () => void setMode(value).catch(reportError));
    modes.append(button);
  }
  const parts: HTMLElement[] = [modes];

  if (mode !== "preview") {
    const numbersButton = document.createElement("button");
    numbersButton.type = "button";
    numbersButton.className = "tool";
    numbersButton.textContent = "#";
    numbersButton.title = "Show line numbers (Ctrl+Shift+N)";
    numbersButton.setAttribute("aria-label", "Show line numbers");
    numbersButton.setAttribute("aria-pressed", String(settings.editor.lineNumbers));
    numbersButton.addEventListener("click", () => runCommand("editor-line-numbers"));
    parts.push(numbersButton);
    if (settings.linting.enabled && editor.has(doc.path)) parts.push(lintButton(editor.lintCount(doc.path)));
  }

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  parts.push(spacer);

  const edit = doc.edit;
  const status = document.createElement("span");
  status.className = "status";
  if (edit?.conflict) {
    status.className = "status conflict";
    status.textContent = "Changed on disk by another program";
    const reload = toolButton("Reload", "Load the file from disk; your unsaved changes are lost", () =>
      void reloadFromDisk(doc.path).catch(reportError),
    );
    const keep = toolButton("Keep mine", "Keep your version; saving will ask before overwriting", () =>
      updateEdit(doc.path, { conflict: undefined }),
    );
    parts.push(status, reload, keep);
  } else if (edit?.untitled) {
    status.textContent = "New file – not saved yet";
    parts.push(status, toolButton("Save…", "Save (Ctrl+S)", () => runCommand("save"), true));
  } else if (edit?.dirty) {
    status.className = "status dirty";
    status.textContent = "Unsaved changes";
    parts.push(status, toolButton("Save", "Save (Ctrl+S)", () => runCommand("save"), true));
  } else if (edit) {
    status.textContent = `Saved · ${edit.lineEnding.toUpperCase()}${edit.bom ? " · BOM" : ""}`;
    parts.push(status);
  }
  docBar.replaceChildren(...parts);
}

/** "⚠ 7": the lint issue count; opens the problems list. */
function lintButton(count: number): HTMLButtonElement {
  const button = toolButton(
    count === 0 ? "✓" : `⚠ ${count}`,
    count === 0 ? "No lint issues" : `${count} lint issue${count === 1 ? "" : "s"} – show them (Ctrl+Shift+M)`,
    () => runCommand("lint-panel"),
  );
  button.className = count === 0 ? "tool lint-count clean" : "tool lint-count";
  button.setAttribute("aria-label", button.title);
  return button;
}

function toolButton(label: string, title: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "tool primary" : "tool";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

/** Loads a document's text into the editor the first time it is edited. */
async function ensureEditor(doc: OpenDocument): Promise<EditInfo | undefined> {
  if (doc.edit && editor.has(doc.path)) return doc.edit;
  try {
    const source = await invoke<SourceFile>("read_source", { path: doc.path });
    editor.open(doc.path, source.text);
    savedDocs.set(doc.path, editor.doc(doc.path));
    return {
      mode: "preview",
      dirty: false,
      lineEnding: source.lineEnding,
      bom: source.bom,
      fingerprint: source.fingerprint,
    };
  } catch (error) {
    await message(`This file can't be edited: ${String(error)}`, { title: "Edit", kind: "error" });
    return undefined;
  }
}

/** Preview, Split or Editor for the active document. */
async function setMode(mode: ViewMode): Promise<void> {
  const doc = activeTab(state);
  if (!doc || doc.wiki || isAppView(doc)) return;
  if (mode === modeOf(doc)) return;
  const edit = mode === "preview" ? doc.edit : await ensureEditor(doc);
  if (mode !== "preview" && !edit) return;
  const latest = state.tabs.find((t) => t.path === doc.path) ?? doc;
  setState(updateTab(state, { ...latest, edit: edit ? { ...edit, mode } : undefined }));
  if (mode !== "preview") {
    if (!liveHtml.has(doc.path)) void liveRender(doc.path).catch(reportError);
    editor.focus();
    requestAnimationFrame(syncPreviewToEditor);
  }
}

/** Ctrl+E: preview ⇄ editor (the editor mode from settings, Split if that is Preview). */
async function toggleEdit(): Promise<void> {
  const doc = activeTab(state);
  if (doc?.wiki) {
    await editWikiPage();
    return;
  }
  const preferred = settings.editor.defaultMode === "preview" ? "split" : settings.editor.defaultMode;
  await setMode(modeOf(doc) === "preview" ? preferred : "preview");
}

/** "Edit page" in a wiki: the page as a document tab, editor beside the preview. */
async function editWikiPage(): Promise<void> {
  const view = shown?.wiki;
  if (!view) return;
  const doc = await loadDocument(view.page.path, view.info.root);
  setState(openTab(state, doc));
  await setMode("split");
}

/** Ctrl+N: a new, empty Markdown file in the editor. */
function newFile(): void {
  untitledCount += 1;
  const path = uniqueTabPath(
    state.tabs.map((t) => t.path),
    `${UNTITLED_PREFIX}${untitledCount}`,
  );
  editor.open(path, "");
  savedDocs.set(path, editor.doc(path));
  const windows = navigator.userAgent.includes("Windows");
  setState(
    openTab(state, {
      path,
      title: `Untitled-${untitledCount}.md`,
      html: "",
      edit: {
        mode: settings.editor.defaultMode === "edit" ? "edit" : "split",
        dirty: false,
        untitled: true,
        lineEnding: windows ? "crlf" : "lf",
        bom: false,
        fingerprint: null,
      },
    }),
  );
  editor.focus();
}

// --- live preview

let renderTimer: number | undefined;
let renderRun = 0;

function onEditorChanged(path: string): void {
  const doc = state.tabs.find((t) => t.path === path);
  if (!doc?.edit) return;
  const saved = savedDocs.get(path);
  const current = editor.doc(path);
  const dirty = !(saved && current && saved.eq(current));
  if (dirty !== doc.edit.dirty) updateEdit(path, { dirty });
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void liveRender(path).catch(reportError), 150);
}

/** Renders the editor text into the preview. The latest run wins. */
async function liveRender(path: string): Promise<void> {
  const run = ++renderRun;
  const doc = state.tabs.find((t) => t.path === path);
  if (!doc) return;
  const result = await invoke<{ html: string; missingLinks: string[] }>("render_source", {
    text: editor.text(path),
    path: doc.edit?.untitled ? null : path,
    wikiRoot: doc.wikiRoot ?? null,
  });
  if (run !== renderRun) return;
  liveHtml.set(path, result.html);
  if (shown?.path !== path) return;
  preview.innerHTML = result.html;
  enhance(preview);
  if (doc.wikiRoot) markLinks(preview, result.missingLinks);
  syncPreviewToEditor();
  updateOutline();
  if (!findBar.hidden) runFind();
  linkPreviews.clear();
  const rich = await enhanceRich(preview, {
    mermaid: settings.rendering.mermaid,
    math: settings.rendering.math,
    dark: document.documentElement.dataset.theme === "dark",
  });
  if (rich && run === renderRun) syncPreviewToEditor();
}

// --- scroll sync (editor → preview)

function onEditorScrolled(): void {
  if (modeOf(activeTab(state)) === "split") requestAnimationFrame(syncPreviewToEditor);
}

/** Scrolls the preview to the part of the document at the top of the editor. */
function syncPreviewToEditor(): void {
  if (modeOf(activeTab(state)) !== "split") return;
  const base = content.getBoundingClientRect().top - content.scrollTop;
  const blocks: Block[] = [];
  for (const element of preview.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
    // Top-level blocks only: nested ones (list items…) are covered by their parent.
    if (element.parentElement?.closest("[data-sourcepos]")) continue;
    const lines = parseSourcePos(element.dataset.sourcepos);
    if (!lines) continue;
    const rect = (element.closest(".code-block") ?? element).getBoundingClientRect();
    blocks.push({ startLine: lines[0], endLine: lines[1], top: rect.top - base, height: rect.height });
  }
  content.scrollTop = Math.max(0, previewScrollFor(blocks, editor.topLine()) - 8);
}

function wireEditorSplitter(): void {
  editorSplitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    editorSplitter.setPointerCapture(e.pointerId);
    editorSplitter.classList.add("dragging");
    const box = viewport.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      const left = editorPane.getBoundingClientRect().left;
      const width = Math.min(Math.max(m.clientX - left, 240), box.width - 240);
      viewport.style.setProperty("--editor-width", `${Math.round(width)}px`);
    };
    const up = () => {
      editorSplitter.classList.remove("dragging");
      editorSplitter.removeEventListener("pointermove", move);
    };
    editorSplitter.addEventListener("pointermove", move);
    editorSplitter.addEventListener("pointerup", up, { once: true });
  });
}

// --- saving

/** Ctrl+S / Ctrl+Shift+S on the active document. */
async function saveActive(saveAs: boolean): Promise<void> {
  const doc = activeTab(state);
  if (!doc?.edit) return; // Nothing edited (Ctrl+S is still claimed, so the webview doesn't act on it).
  await saveTab(doc, saveAs);
}

/** Saves a tab. Returns false if it was not saved (cancelled or failed). */
async function saveTab(doc: OpenDocument, saveAs = false, force = false): Promise<boolean> {
  const edit = doc.edit;
  if (!edit) return true;
  const isNew = edit.untitled === true || saveAs;
  if (!isNew && !edit.dirty && !force) return true;

  let path = doc.path;
  if (isNew) {
    const chosen = await saveDialog({
      title: saveAs ? "Save as" : "Save",
      defaultPath: edit.untitled ? doc.title : doc.path,
      filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
    });
    if (!chosen) return false;
    path = chosen;
  }

  if (settings.linting.enabled && settings.linting.fixOnSave) await fixTab(doc.path, SAFE_ON_SAVE, true);
  const request = {
    text: editor.text(doc.path),
    lineEnding: edit.lineEnding,
    bom: edit.bom,
    expected: isNew ? null : edit.fingerprint,
    force,
  };
  let fingerprint: string;
  try {
    fingerprint = await invoke<string>("save_source", { path, request });
  } catch (error) {
    const failure = error as { kind?: string; message?: string };
    if (failure.kind === "changed") {
      const answer = await message(`“${doc.title}” was changed by another program since you opened it.`, {
        title: "File changed on disk",
        kind: "warning",
        buttons: { yes: "Overwrite", no: "Reload theirs", cancel: "Cancel" },
      });
      if (answer === "Overwrite" || answer === "Yes") return saveTab(doc, saveAs, true);
      if (answer === "Reload theirs" || answer === "No") await reloadFromDisk(doc.path);
      return false;
    }
    const reason = failure.kind === "readOnly" ? "The file is read-only." : (failure.message ?? String(error));
    await message(`Could not save “${doc.title}”.\n\n${reason}`, { title: "Save", kind: "error" });
    return false;
  }

  const oldPath = doc.path;
  if (path !== oldPath) {
    // Saved under a new name: the tab now is that file.
    editor.rename(oldPath, path);
    savedDocs.delete(oldPath);
    const html = liveHtml.get(oldPath);
    liveHtml.delete(oldPath);
    if (html !== undefined) liveHtml.set(path, html);
    scrollPositions.delete(oldPath);
    if (!edit.untitled) void invoke("close_document", { path: oldPath });
  }
  savedDocs.set(path, editor.doc(path));
  const index = state.tabs.findIndex((t) => t.path === oldPath);
  const latest = state.tabs[index] ?? doc;
  const saved: OpenDocument = {
    ...latest,
    path,
    title: path.split(/[\\/]/).pop() ?? path,
    edit: { ...(latest.edit ?? edit), dirty: false, untitled: undefined, conflict: undefined, fingerprint },
  };
  const tabs = state.tabs.slice();
  if (index >= 0) tabs[index] = saved;
  setState({ ...state, tabs });
  rememberRecent(saved);
  showToast(`Saved ${saved.title}`);
  return true;
}

/** Loads the file from disk into the editor (keeping the cursor where it can). */
async function reloadFromDisk(path: string, source?: SourceFile): Promise<void> {
  const file = source ?? (await invoke<SourceFile>("read_source", { path }));
  editor.replaceText(path, file.text);
  savedDocs.set(path, editor.doc(path));
  updateEdit(path, {
    dirty: false,
    conflict: undefined,
    fingerprint: file.fingerprint,
    lineEnding: file.lineEnding,
    bom: file.bom,
  });
  await liveRender(path);
}

/** A file open in the editor changed on disk. */
async function onEditedFileChanged(path: string): Promise<void> {
  const doc = state.tabs.find((t) => t.path === path);
  if (!doc?.edit) return;
  const file = await invoke<SourceFile>("read_source", { path });
  // Our own save (or a change that ended up identical).
  if (file.fingerprint === doc.edit.fingerprint) return;
  if (doc.edit.dirty) updateEdit(path, { conflict: true });
  else await reloadFromDisk(path, file);
}

// --- closing with unsaved changes

/** Asks what to do with unsaved changes. Returns false if the user cancels. */
async function confirmDiscard(doc: OpenDocument): Promise<boolean> {
  if (!doc.edit?.dirty && !(doc.edit?.untitled && editor.text(doc.path) !== "")) return true;
  setState(activateTab(state, state.tabs.findIndex((t) => t.path === doc.path)));
  const answer = await message(`Do you want to save the changes to “${doc.title}”?`, {
    title: "Unsaved changes",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't save", cancel: "Cancel" },
  });
  if (answer === "Save" || answer === "Yes") return saveTab(state.tabs.find((t) => t.path === doc.path) ?? doc);
  return answer === "Don't save" || answer === "No";
}

/** Window close (and Exit): ask about every tab with unsaved changes first. */
async function onCloseRequested(event: { preventDefault(): void }): Promise<void> {
  const unsaved = state.tabs.filter((t) => t.edit?.dirty || (t.edit?.untitled && editor.text(t.path) !== ""));
  if (unsaved.length === 0) return;
  event.preventDefault();
  for (const doc of unsaved) {
    const latest = state.tabs.find((t) => t.path === doc.path);
    if (latest && !(await confirmDiscard(latest))) return;
  }
  await getCurrentWindow().destroy();
}

// ---------------------------------------------------------------- linting

/**
 * Fixes applied on save: whitespace and blank lines only, checked on all ATC
 * docs not to change the rendered page. (MD010 changes code, MD018 can turn
 * "#123 is fixed" into a heading, MD027/MD031 can change quotes and lists.)
 */
const SAFE_ON_SAVE = ["MD009", "MD012", "MD019", "MD021", "MD022", "MD023", "MD032", "MD047"];

/** Project config files we already warned about, so a broken one is reported once. */
const reportedConfigErrors = new Set<string>();

interface LintResult {
  diagnostics: LintIssue[];
  configFile: string | null;
  configError: string | null;
}

/** Where the editor's text comes from, for finding the project config and wiki rules. */
function lintTarget(tab: string): { path: string | null; wikiRoot: string | null } {
  const doc = state.tabs.find((t) => t.path === tab);
  return { path: doc && !doc.edit?.untitled ? doc.path : null, wikiRoot: doc?.wikiRoot ?? null };
}

async function lintTab(tab: string, text: string): Promise<LintIssue[]> {
  const result = await invoke<LintResult>("lint_source", { text, ...lintTarget(tab) });
  if (result.configError && result.configFile && !reportedConfigErrors.has(result.configFile)) {
    reportedConfigErrors.add(result.configFile);
    showToast(`Lint config ignored: ${result.configError}`);
  }
  return result.diagnostics;
}

/** Fixes lint issues (of `rules`, or all) in a tab, as one undo step. */
async function fixTab(tab: string, rules: string[], quiet = false): Promise<void> {
  const text = editor.text(tab);
  const fixed = await invoke<string>("fix_source", {
    text,
    ...lintTarget(tab),
    rules: rules.length > 0 ? rules : null,
  });
  if (fixed !== text) editor.replaceText(tab, fixed);
  else if (!quiet) showToast("Nothing to fix automatically");
}

/** Opens the problems list; shows the editor first if only the preview is visible. */
async function showProblems(): Promise<void> {
  const doc = activeTab(state);
  if (!doc || doc.wiki || isAppView(doc)) return;
  if (modeOf(doc) === "preview") await setMode("split");
  editor.openProblems();
}

// --- folder lint report

/** Asks for a folder (the open wiki or the document's folder first) and lints it. */
async function chooseFolderToLint(): Promise<void> {
  const doc = activeTab(state);
  const lastFolder = doc?.lintReport?.root ?? doc?.wiki?.info.root ?? doc?.wikiRoot;
  const docFolder = doc && !isAppView(doc) && !doc.edit?.untitled ? doc.path.replace(/[\\/][^\\/]*$/, "") : undefined;
  const folder = await openDialog({ directory: true, title: "Lint folder", defaultPath: lastFolder ?? docFolder });
  if (typeof folder === "string") await lintFolder(folder);
}

/** Lints every Markdown file in a folder and shows the report in its tab. */
async function lintFolder(root: string): Promise<void> {
  if (!settings.linting.enabled) {
    await message("Linting is turned off in Settings → Linting.", { title: "Lint folder", kind: "info" });
    return;
  }
  showToast("Linting the folder…");
  const report = await invoke<FolderLint>("lint_folder", { root });
  const name = report.root.split(/[\\/]/).filter(Boolean).pop() ?? report.root;
  const path = lintReportPath(report.root);
  const tab: OpenDocument = { path, title: `Lint: ${name}`, html: "", lintReport: report };
  const open = state.tabs.some((t) => t.path === path);
  setState(open ? activateTab(updateTab(state, tab), state.tabs.findIndex((t) => t.path === path)) : openTab(state, tab));
  const total = report.files.reduce((sum, f) => sum + f.total, 0);
  showToast(total === 0 ? "No lint issues" : `${total} lint issue${total === 1 ? "" : "s"}`);
}

function renderReport(report: FolderLint): void {
  renderLintReport(reportView, report, lintRules, {
    open: (path, line, column) => void openAtLine(path, line, column).catch(reportError),
    rerun: () => void lintFolder(report.root).catch(reportError),
  });
}

/** Opens a file (or switches to its tab) and puts the editor's cursor on a line. */
async function openAtLine(path: string, line: number, column: number): Promise<void> {
  const open = state.tabs.findIndex((t) => !isAppView(t) && t.path.toLowerCase() === path.toLowerCase());
  if (open >= 0) setState(activateTab(state, open));
  else await openPaths([path]);
  const doc = activeTab(state);
  if (!doc || doc.path.toLowerCase() !== path.toLowerCase()) return;
  if (modeOf(doc) === "preview") await setMode(settings.editor.defaultMode === "edit" ? "edit" : "split");
  editor.goTo(doc.path, line, column);
}

function editorOptions(): EditorOptions {
  return { ...settings.editor, lint: settings.linting.enabled };
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
  if (
    before.editor.lineNumbers !== next.editor.lineNumbers ||
    before.editor.wrapLines !== next.editor.wrapLines ||
    before.linting.enabled !== next.linting.enabled
  ) {
    editor.setOptions(editorOptions());
    renderDocBar(activeTab(state));
  }
  if (JSON.stringify(before.linting) !== JSON.stringify(next.linting)) editor.relint();
  updateOutline();
  // Wiki chrome (page list, banner) reads settings while rendering.
  if (before.wiki.offerOpenAsWiki !== next.wiki.offerOpenAsWiki) renderBanner(shown);
}

function renderSettings(): void {
  renderSettingsView(settingsView, settings, codeThemes, lintRules, {
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
    if (isAppView(tab)) continue;
    if (tab.wiki) {
      const latest = state.tabs.find((t) => t.path === tab.path)?.wiki ?? tab.wiki;
      const reloaded = { ...(await loadWikiTab(latest.info.root, latest.page.path, latest.history)), path: tab.path };
      if (shown?.path === tab.path) pendingScroll = { tab: tab.path, top: content.scrollTop };
      setState(updateTab(state, reloaded));
    } else if (tab.edit && editor.has(tab.path)) {
      await liveRender(tab.path);
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
  if (doc.edit?.untitled) return;
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
  if (!shown || isAppView(shown)) return;
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
    case "new-file":
      newFile();
      break;
    case "save":
      run(saveActive(false));
      break;
    case "save-as":
      run(saveActive(true));
      break;
    case "exit":
      // Goes through the window's close check (unsaved changes).
      run(getCurrentWindow().close());
      break;
    case "toggle-edit":
      run(toggleEdit());
      break;
    case "mode-preview":
      run(setMode("preview"));
      break;
    case "mode-split":
      run(setMode("split"));
      break;
    case "mode-edit":
      run(setMode("edit"));
      break;
    case "editor-line-numbers":
      updateSettings({ editor: { lineNumbers: !settings.editor.lineNumbers } });
      break;
    case "lint-panel":
      run(showProblems());
      break;
    case "lint-folder":
      run(chooseFolderToLint());
      break;
    case "lint-fix-all": {
      const doc = activeTab(state);
      if (doc && editor.has(doc.path) && modeOf(doc) !== "preview") run(fixTab(doc.path, []));
      break;
    }
    case "open":
      run(showOpenDialog());
      break;
    case "open-wiki":
      run(showOpenWikiDialog());
      break;
    case "close-tab":
      if (state.activeIndex >= 0) run(closeDocument(state.activeIndex));
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
      if (modeOf(activeTab(state)) === "edit") editor.openSearch();
      else       openFind();
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

function handleKeys(e: KeyboardEvent): void {
  // The editor already handled it (its own shortcuts call preventDefault).
  if (e.defaultPrevented) return;
  const inEditor = e.target instanceof Node && editorPane.contains(e.target);
  const command = commandForKey(e, inEditor);
  if (command) {
    e.preventDefault();
    runCommand(command);
  } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    setState(activateTab(state, Number(e.key) - 1));
  } else if (e.key === "Escape" && !findBar.hidden && !inEditor) {
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

  lintRules = await invoke<LintRule[]>("lint_rules");
  editor = new MarkdownEditor(editorPane, editorOptions(), {
    changed: onEditorChanged,
    scrolled: onEditorScrolled,
    lint: lintTab,
    fixAll: (tab, rules) => void fixTab(tab, rules).catch(reportError),
    linted: (tab) => {
      const doc = activeTab(state);
      if (doc?.path === tab) renderDocBar(doc);
    },
  });
  // Not needed for the first paint; the list arrives while the window opens.
  void invoke<FenceLanguage[]>("code_languages")
    .then((languages) => editor.setFenceLanguages(languages))
    .catch(reportError);
  wireEditorSplitter();
  await getCurrentWindow().onCloseRequested(onCloseRequested);

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
