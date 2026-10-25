import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { findMatches } from "./find";
import { describeLink, type BubbleContent, type IconName, type LinkPreview, type LinkTarget } from "./links";
import { parseSession, toSession, type Session } from "./session";
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  openTab,
  updateTab,
  type OpenDocument,
  type TabState,
} from "./tabs";

const APP_NAME = "Atc.Markdown";
const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd"];
const MARKDOWN_PATTERN = new RegExp(`\\.(${MARKDOWN_EXTENSIONS.join("|")})$`, "i");

/** Things the user can do from the menu or the keyboard. Mirrors `COMMAND_IDS` in `src-tauri/src/menu.rs`. */
const COMMANDS = [
  "open",
  "close-tab",
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

const element = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const tabBar = element<HTMLElement>("#tabs");
const content = element<HTMLElement>("#content");
const preview = element<HTMLElement>("#preview");
const empty = element<HTMLElement>("#empty");
const openButton = element<HTMLButtonElement>("#open-button");
const findBar = element<HTMLElement>("#find-bar");
const findInput = element<HTMLInputElement>("#find-input");
const findCount = element<HTMLElement>("#find-count");
const linkStatus = element<HTMLElement>("#link-status");
const linkMenu = element<HTMLElement>("#link-menu");

let state: TabState = emptyTabs;
/** The document currently shown in the preview, to avoid needless re-renders. */
let shown: OpenDocument | undefined;
/** Scroll position per document path, so switching tabs keeps your place. */
const scrollPositions = new Map<string, number>();

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
  preview.hidden = doc === undefined;

  if (doc !== shown) {
    // `html` was sanitized in Rust (ammonia) before it reached us.
    preview.innerHTML = doc?.html ?? "";
    content.scrollTop = doc ? (scrollPositions.get(doc.path) ?? 0) : 0;
    shown = doc;
    void getCurrentWindow().setTitle(doc ? `${doc.title} – ${APP_NAME}` : APP_NAME);
    // The old matches pointed into the replaced HTML.
    if (!findBar.hidden) runFind();
    hideLinkStatus();
    closeLinkMenu();
    linkPreviews.clear();
  }
}

function renderTab(doc: OpenDocument, index: number): HTMLElement {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", String(index === state.activeIndex));
  tab.title = doc.path;
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

// ---------------------------------------------------------------- documents

async function tryLoadDocument(path: string): Promise<OpenDocument | undefined> {
  try {
    return await invoke<OpenDocument>("open_document", { path });
  } catch {
    return undefined;
  }
}

async function loadDocument(path: string): Promise<OpenDocument> {
  try {
    return await invoke<OpenDocument>("open_document", { path });
  } catch (error) {
    return errorDocument(path, String(error));
  }
}

async function openPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    const doc = await loadDocument(path);
    setState(openTab(state, doc));
  }
}

async function reloadDocument(path: string): Promise<void> {
  const doc = await loadDocument(path);
  const wasShown = shown?.path === doc.path;
  const scroll = content.scrollTop;
  setState(updateTab(state, doc));
  if (wasShown) content.scrollTop = scroll;
}

function closeDocument(index: number): void {
  const doc = state.tabs[index];
  if (!doc) return;
  scrollPositions.delete(doc.path);
  void invoke("close_document", { path: doc.path });
  setState(closeTab(state, index));
}

function errorDocument(path: string, message: string): OpenDocument {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  const title = path.split(/[\\/]/).pop() ?? path;
  return { path, title, html: p.outerHTML };
}

async function openPendingPaths(): Promise<void> {
  await openPaths(await invoke<string[]>("take_pending_paths"));
}

async function showOpenDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
  });
  if (selected) await openPaths(Array.isArray(selected) ? selected : [selected]);
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

/** Reopens the tabs from last time. Files that are gone are skipped. */
async function restoreSession(): Promise<void> {
  const session = loadSession();
  if (!session || session.paths.length === 0) return;

  const docs = await Promise.all(session.paths.map(tryLoadDocument));
  let next = state;
  for (const doc of docs) {
    if (doc) next = openTab(next, doc);
  }
  const active = next.tabs.findIndex((tab) => tab.path === session.active);
  if (active >= 0) next = activateTab(next, active);
  setState(next);
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
async function followHref(href: string): Promise<void> {
  if (!shown) return;
  const target = await invoke<LinkTarget>("follow_link", { documentPath: shown.path, href });
  switch (target.kind) {
    case "anchor":
      scrollToId(target.id);
      break;
    case "document":
      await openPaths([target.path]);
      if (target.fragment) scrollToId(target.fragment);
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
  const href = link.getAttribute("href");
  if (href) await followHref(href);
}

// ---------------------------------------------------------------- link preview

/** Results of `describe_link`, per document and href. Cleared when the shown document changes. */
const linkPreviews = new Map<string, Promise<LinkPreview>>();

function describeHref(href: string): Promise<LinkPreview> | undefined {
  if (!shown) return undefined;
  const key = `${shown.path}\n${href}`;
  let result = linkPreviews.get(key);
  if (!result) {
    result = invoke<LinkPreview>("describe_link", { documentPath: shown.path, href });
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
  const path = shown?.path ?? "";
  return {
    linkText: link.textContent ?? "",
    documentDir: path.replace(/[\\/][^\\/]*$/, ""),
    isOpen: (p: string) => state.tabs.some((tab) => tab.path.toLowerCase() === p.toLowerCase()),
    headingText: (id: string) => preview.querySelector(`[id="${CSS.escape(id)}"]`)?.textContent?.trim(),
    isMac,
  };
}

function showLinkStatus(link: HTMLAnchorElement): void {
  hoveredLink = link;
  window.clearTimeout(linkStatusTimer);
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

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

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
  if (!href || !result || !shown) return;

  const items = [menuItem(result.kind === "external" ? "Open link" : "Open", () => followHref(href))];
  let address: string | undefined;
  if (result.kind === "external") address = result.url;
  else if (result.kind === "document" || result.kind === "localFile") address = result.path;
  else if (result.kind === "anchor") address = `${shown.path}#${result.id}`;
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
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeLinkMenu();
  }
}

function wireLinks(): void {
  preview.addEventListener("click", (e) => void handleLinkClick(e).catch(reportError));
  preview.addEventListener("mouseover", (e) => {
    const link = linkFromEvent(e);
    if (link && link !== hoveredLink) showLinkStatus(link);
    else if (!link && hoveredLink) hideLinkStatus();
  });
  preview.addEventListener("mouseleave", hideLinkStatus);
  preview.addEventListener("focusin", (e) => {
    const link = linkFromEvent(e);
    if (link) showLinkStatus(link);
  });
  preview.addEventListener("focusout", hideLinkStatus);
  preview.addEventListener("contextmenu", (e) => {
    const link = linkFromEvent(e);
    if (!link) return;
    e.preventDefault();
    void openLinkMenu(link, e.clientX, e.clientY).catch(reportError);
  });
  content.addEventListener(
    "scroll",
    () => {
      hideLinkStatus();
      closeLinkMenu();
    },
    { passive: true },
  );
  linkMenu.addEventListener("keydown", handleMenuKeys);
  document.addEventListener("mousedown", (e) => {
    if (!linkMenu.hidden && !linkMenu.contains(e.target as Node)) closeLinkMenu();
  });
  window.addEventListener("blur", () => {
    hideLinkStatus();
    closeLinkMenu();
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

function stepFind(step: 1 | -1): void {
  if (findBar.hidden) {
    openFind();
    return;
  }
  if (matches.length === 0) return;
  current = (current + step + matches.length) % matches.length;
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

const ZOOM_KEY = "atc-markdown.zoom";
const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

function loadZoom(): number {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

let zoom = loadZoom();

function setZoom(value: number): void {
  zoom = value;
  document.documentElement.style.setProperty("--zoom", String(zoom));
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    // Storage can be unavailable; zoom then just isn't remembered.
  }
}

function stepZoom(direction: 1 | -1): void {
  const index = ZOOM_STEPS.indexOf(zoom);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
  if (next !== undefined) setZoom(next);
}

// ---------------------------------------------------------------- commands

function stepTab(step: 1 | -1): void {
  if (state.tabs.length < 2) return;
  setState(activateTab(state, (state.activeIndex + step + state.tabs.length) % state.tabs.length));
}

function runCommand(command: Command): void {
  switch (command) {
    case "open":
      void showOpenDialog();
      break;
    case "close-tab":
      if (state.activeIndex >= 0) closeDocument(state.activeIndex);
      break;
    case "reload":
      if (shown) void reloadDocument(shown.path);
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
      setZoom(1);
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
  if (!mod) return undefined;
  if (e.ctrlKey && e.key === "Tab") return e.shiftKey ? "previous-tab" : "next-tab";
  switch (key) {
    case "o":
      return "open";
    case "w":
      return "close-tab";
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

async function loadHighlightCss(): Promise<void> {
  const style = document.createElement("style");
  style.textContent = await invoke<string>("highlight_css");
  document.head.append(style);
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
  setZoom(zoom);
  document.addEventListener("keydown", handleKeys);
  wireLinks();
  openButton.addEventListener("click", () => void showOpenDialog());
  wireFindBar();
  render();

  // After a webview reload, documents from before are no longer shown.
  await invoke("close_all_documents");
  await loadHighlightCss();

  await getCurrentWebview().onDragDropEvent((event) => {
    const { payload } = event;
    document.body.classList.toggle("dragging", payload.type === "enter" || payload.type === "over");
    if (payload.type === "drop") {
      void openPaths(payload.paths.filter((p) => MARKDOWN_PATTERN.test(p)));
    }
  });

  await listen<string>("document-changed", (event) => void reloadDocument(event.payload));
  await listen<string>("menu-command", (event) => {
    if (isCommand(event.payload)) runCommand(event.payload);
  });

  // Restore first, so files opened by double-click end up as the active tab.
  await restoreSession();

  // Listen first, then drain the queue, so no path is missed.
  await listen("files-pending", () => void openPendingPaths());
  await openPendingPaths();
}

function reportError(error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  void invoke("log_frontend_error", { message }).catch(() => {});
}

window.addEventListener("error", (e) => reportError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason));
main().catch(reportError);
