import { describe, expect, it } from "vitest";
import { commandForKey, type KeyPress } from "./commands";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const ctrl = (key: string, shift = false) => press(key, { ctrlKey: true, shiftKey: shift });

describe("commandForKey", () => {
  it("maps app shortcuts", () => {
    expect(commandForKey(ctrl("s"))).toBe("save");
    expect(commandForKey(ctrl("S", true))).toBe("save-as");
    expect(commandForKey(ctrl("n"))).toBe("new-file");
    expect(commandForKey(ctrl("N", true))).toBe("editor-line-numbers");
    expect(commandForKey(ctrl("e"))).toBe("toggle-edit");
    expect(commandForKey(ctrl("O", true))).toBe("open-folder");
    expect(commandForKey(ctrl("f"))).toBe("find");
    expect(commandForKey(ctrl("F", true))).toBe("find-in-folder");
    expect(commandForKey(ctrl("F", true), true)).toBe("find-in-folder");
    expect(commandForKey(press("F5"))).toBe("reload");
    expect(commandForKey(press("ArrowLeft", { altKey: true }))).toBe("go-back");
    expect(commandForKey(press("s"))).toBeUndefined();
  });

  it("leaves the editor's own keys to the editor", () => {
    // Find, find next, Escape-like and selection keys belong to CodeMirror.
    expect(commandForKey(ctrl("f"), true)).toBeUndefined();
    expect(commandForKey(press("F3"), true)).toBeUndefined();
    expect(commandForKey(ctrl("g"), true)).toBeUndefined();
    expect(commandForKey(press("ArrowLeft", { altKey: true }), true)).toBeUndefined();
    expect(commandForKey(ctrl("L", true), true)).toBeUndefined();
    expect(commandForKey(ctrl("b"), true)).toBeUndefined();
  });

  it("keeps app commands working from the editor", () => {
    expect(commandForKey(ctrl("s"), true)).toBe("save");
    expect(commandForKey(ctrl("w"), true)).toBe("close-tab");
    expect(commandForKey(ctrl("e"), true)).toBe("toggle-edit");
    expect(commandForKey(press("Tab", { ctrlKey: true }), true)).toBe("next-tab");
    expect(commandForKey(press("F5"), true)).toBe("reload");
  });

  it("maps the lint shortcuts on US and Nordic keyboards", () => {
    expect(commandForKey(ctrl("M", true))).toBe("lint-panel");
    expect(commandForKey(ctrl("m"))).toBeUndefined();
    expect(commandForKey(ctrl(">", true), true)).toBe("lint-fix-all");
    expect(commandForKey(ctrl(":", true), true)).toBe("lint-fix-all");
    expect(commandForKey(ctrl("."))).toBeUndefined();
  });
});
