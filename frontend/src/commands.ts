// Commands (from the menu or the keyboard) and which key runs which command.
// Pure, so the key routing can be unit tested.

/** Things the user can do from the menu or the keyboard. Mirrors `COMMAND_IDS` in `src-tauri/src/menu.rs`. */
export const COMMANDS = [
  "new-file",
  "open",
  "open-wiki",
  "save",
  "save-as",
  "close-tab",
  "reopen-tab",
  "print",
  "exit",
  "go-back",
  "go-forward",
  "toggle-sidebar",
  "find-page",
  "settings",
  "toggle-outline",
  "toggle-edit",
  "mode-preview",
  "mode-split",
  "mode-edit",
  "editor-line-numbers",
  "lint-panel",
  "lint-fix-all",
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

export type Command = (typeof COMMANDS)[number];

export const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

/** The parts of a key event that decide the command. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Commands that still run while typing in the editor. Everything else (Find,
 * F3, Escape, Alt+arrows, Ctrl+Shift+L, …) is left to the editor's own keys.
 */
const IN_EDITOR: ReadonlySet<Command> = new Set<Command>([
  "new-file",
  "open",
  "open-wiki",
  "save",
  "save-as",
  "close-tab",
  "reopen-tab",
  "print",
  "settings",
  "toggle-edit",
  "editor-line-numbers",
  "lint-panel",
  "lint-fix-all",
  "reload",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "next-tab",
  "previous-tab",
]);

/**
 * Maps a key press to a command. Also claims the browser's own shortcuts
 * (reload, find, save page) so the webview never acts on them.
 */
export function commandForKey(e: KeyPress, inEditor = false): Command | undefined {
  const command = commandForKeyAnywhere(e);
  if (inEditor && command && !IN_EDITOR.has(command)) return undefined;
  return command;
}

function commandForKeyAnywhere(e: KeyPress): Command | undefined {
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
    case "n":
      return e.shiftKey ? "editor-line-numbers" : "new-file";
    case "o":
      return e.shiftKey ? "open-wiki" : "open";
    case "s":
      return e.shiftKey ? "save-as" : "save";
    case "e":
      return "toggle-edit";
    case "m":
      return e.shiftKey ? "lint-panel" : undefined;
    // Ctrl+Shift+. (Shift+. is ">" on US and ":" on Nordic keyboards).
    case ".":
    case ">":
    case ":":
      return e.shiftKey ? "lint-fix-all" : undefined;
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
