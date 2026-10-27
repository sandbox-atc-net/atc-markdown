// The Settings tab: sections of controls built from a declarative list, with a
// search box. Every change is applied at once; there is no Save button.

import { TEXT_SIZES, type LintRule, type Settings, type SettingsChanges } from "./settings";

type Section = keyof Omit<Settings, "version">;

interface FieldBase {
  section: Section;
  key: string;
  label: string;
  hint?: string;
}

type Field =
  | (FieldBase & { kind: "select"; options: readonly (readonly [string, string])[]; numeric?: boolean })
  | (FieldBase & { kind: "toggle" })
  | (FieldBase & { kind: "text"; placeholder: string })
  /** A list of names, edited as comma-separated text. */
  | (FieldBase & { kind: "list"; placeholder: string })
  | (FieldBase & { kind: "rule"; defaultOn: boolean });

export interface CodeThemeChoice {
  id: string;
  label: string;
}

export interface SettingsActions {
  update(changes: SettingsChanges): void;
  reset(section: Section): void;
  revealFile(): void;
}

const onOff = (label: string, section: Section, key: string, hint?: string): Field => ({
  kind: "toggle",
  section,
  key,
  label,
  hint,
});

/** One switch per lint rule (MD013 is set by "Maximum line length"). */
function ruleFields(rules: readonly LintRule[]): Field[] {
  return rules
    .filter((rule) => rule.id !== "MD013")
    .map((rule) => ({
      kind: "rule",
      section: "linting",
      key: rule.id,
      label: `${rule.id} ${rule.alias}`,
      hint: `${rule.description}${rule.fixable ? " · can be fixed" : ""}`,
      defaultOn: rule.defaultOn,
    }));
}

function sections(
  codeThemes: readonly CodeThemeChoice[],
  lintRules: readonly LintRule[],
): { id: Section; title: string; fields: Field[] }[] {
  return [
    {
      id: "appearance",
      title: "Appearance",
      fields: [
        {
          kind: "select",
          section: "appearance",
          key: "theme",
          label: "Theme",
          hint: "System follows the Windows / macOS setting.",
          options: [
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ],
        },
        {
          kind: "select",
          section: "appearance",
          key: "codeTheme",
          label: "Code colours",
          hint: "Colours for code blocks, in light and dark mode.",
          options: codeThemes.map((t) => [t.id, t.label] as const),
        },
        {
          kind: "select",
          section: "appearance",
          key: "textSize",
          label: "Text size",
          hint: "Ctrl + and Ctrl − change it too.",
          options: TEXT_SIZES.map((size) => [String(size), `${size} %`] as const),
          numeric: true,
        },
        {
          kind: "select",
          section: "appearance",
          key: "readingWidth",
          label: "Reading width",
          options: [
            ["narrow", "Narrow"],
            ["medium", "Medium"],
            ["wide", "Wide"],
            ["full", "Full window"],
          ],
        },
        {
          kind: "text",
          section: "appearance",
          key: "readingFont",
          label: "Reading font",
          hint: "A font installed on this computer, e.g. Georgia. Empty = system font.",
          placeholder: "System font",
        },
        {
          kind: "text",
          section: "appearance",
          key: "codeFont",
          label: "Code font",
          hint: "e.g. Cascadia Code, JetBrains Mono. Empty = system monospace font.",
          placeholder: "System monospace font",
        },
        onOff("Outline", "appearance", "showOutline", "The headings of the document beside it. Ctrl+Shift+L shows or hides it."),
      ],
    },
    {
      id: "layout",
      title: "Layout",
      fields: [
        {
          kind: "select",
          section: "layout",
          key: "sidePanelPosition",
          label: "Side panel position",
          hint: "Where the Explorer and the wiki sidebar are. The outline goes on the other side.",
          options: [
            ["left", "Left"],
            ["right", "Right"],
          ],
        },
      ],
    },
    {
      id: "folder",
      title: "Folder",
      fields: [
        onOff("Show the Explorer", "folder", "explorerVisible", "The files of the open folder. Ctrl+B shows or hides it."),
        onOff(
          "Preview tabs",
          "folder",
          "previewTabs",
          "One click opens a file in a preview tab (title in italics) that the next click replaces. Double-click keeps it open.",
        ),
        onOff("Reveal the active file", "folder", "revealActiveFile", "Select the file of the active tab in the Explorer."),
        onOff("Compact folders", "folder", "compactFolders", "A folder that only holds one folder is shown on one row: docs/guides."),
        onOff("Respect .gitignore", "folder", "respectGitignore", "Leave out what .gitignore ignores. Also for folder search and Lint Folder."),
        {
          kind: "list",
          section: "folder",
          key: "skipFolders",
          label: "Folders to skip",
          hint: "Folder names, separated by commas. Hidden folders (.git, .vs) are always skipped.",
          placeholder: "node_modules, bin, obj, target",
        },
      ],
    },
    {
      id: "wiki",
      title: "Wiki",
      fields: [
        onOff("Show the sidebar", "wiki", "sidebarVisible", "Ctrl+B shows or hides it."),
        {
          kind: "select",
          section: "wiki",
          key: "pageList",
          label: "Page list",
          hint: "The “Pages (N)” list under the sidebar.",
          options: [
            ["collapsed", "Collapsed"],
            ["expanded", "Expanded"],
            ["hidden", "Hidden"],
          ],
        },
        onOff("Page header", "wiki", "pageHeader", "Page title, last edited and “Open on GitHub”."),
        onOff("Show _Footer.md", "wiki", "showFooter"),
        onOff("Offer “Open as wiki”", "wiki", "offerOpenAsWiki", "When a file you open is a page of a wiki."),
      ],
    },
    {
      id: "files",
      title: "Opening files",
      fields: [
        onOff("Reopen last session's tabs on start", "files", "restoreSession"),
        {
          kind: "select",
          section: "files",
          key: "openFromOs",
          label: "File opened from Explorer / Finder",
          options: [
            ["newTab", "Opens in a new tab"],
            ["replaceCurrent", "Replaces the current tab"],
          ],
        },
        onOff("Reload when the file changes on disk", "files", "autoReload"),
      ],
    },
    {
      id: "links",
      title: "Links",
      fields: [
        onOff("Show where a link goes", "links", "statusBubble", "The bubble in the corner when you point at a link."),
        onOff("Ask before opening web links", "links", "confirmExternal"),
        onOff("Mark web links with ↗", "links", "externalMarker"),
      ],
    },
    {
      id: "rendering",
      title: "Rendering",
      fields: [
        {
          kind: "select",
          section: "rendering",
          key: "frontMatter",
          label: "Front matter",
          hint: "The YAML block at the top of some files.",
          options: [
            ["table", "Table (like GitHub)"],
            ["raw", "YAML"],
            ["hidden", "Hidden"],
          ],
        },
        onOff("Emoji shortcodes", "rendering", "emoji", ":rocket: → 🚀"),
        onOff("Mermaid diagrams", "rendering", "mermaid"),
        onOff("Math", "rendering", "math", "$…$ and $$…$$"),
      ],
    },
    {
      id: "editor",
      title: "Editor",
      fields: [
        onOff("Show line numbers", "editor", "lineNumbers", "In the editor's left margin. Ctrl+Shift+N or the # button in the editor."),
        onOff("Wrap long lines", "editor", "wrapLines"),
        {
          kind: "select",
          section: "editor",
          key: "defaultMode",
          label: "Open files in",
          hint: "Ctrl+E switches between preview and editor.",
          options: [
            ["preview", "Preview"],
            ["split", "Editor + preview side by side"],
            ["edit", "Editor"],
          ],
        },
      ],
    },
    {
      id: "linting",
      title: "Linting",
      fields: [
        onOff("Show lint issues", "linting", "enabled", "Style problems are underlined in the editor (markdownlint rules)."),
        onOff(
          "Use the project's .markdownlint.json",
          "linting",
          "useProjectConfig",
          "The nearest .markdownlint.json / .jsonc / .yaml above the file wins over the settings below.",
        ),
        {
          kind: "select",
          section: "linting",
          key: "lineLength",
          label: "Maximum line length",
          hint: "MD013. Long lines are normal in prose and tables, so it is off by default.",
          options: [
            ["0", "Off"],
            ["80", "80"],
            ["100", "100"],
            ["120", "120"],
            ["160", "160"],
            ["200", "200"],
          ],
          numeric: true,
        },
        {
          kind: "select",
          section: "linting",
          key: "listIndent",
          label: "Nested list indent",
          hint: "MD007. Spaces per level of a nested bullet list.",
          options: [
            ["2", "2 spaces"],
            ["3", "3 spaces"],
            ["4", "4 spaces"],
          ],
          numeric: true,
        },
        onOff("Fix issues when saving", "linting", "fixOnSave", "Only issues that can be fixed safely, like trailing spaces."),
        onOff("Preview fixes", "linting", "previewFixes", "Show what “Fix all” changes before applying it."),
        onOff("Show issues in the viewer", "linting", "showInViewer", "The number of lint issues in the toolbar, also when only viewing."),
        ...ruleFields(lintRules),
      ],
    },
    {
      id: "code",
      title: "Code blocks",
      fields: [
        {
          kind: "select",
          section: "code",
          key: "copyButton",
          label: "Copy button",
          options: [
            ["hover", "When pointing at the code"],
            ["always", "Always"],
            ["off", "Off"],
          ],
        },
        onOff("Wrap long lines", "code", "wrapLines"),
        onOff("Line numbers", "code", "lineNumbers", "Not shown while long lines wrap."),
      ],
    },
  ];
}

function value(settings: Settings, field: Field): unknown {
  if (field.kind === "rule") return settings.linting.rules[field.key] ?? field.defaultOn;
  return (settings[field.section] as Record<string, unknown>)[field.key];
}

function control(settings: Settings, field: Field, actions: SettingsActions): HTMLElement {
  const id = `setting-${field.section}-${field.key}`;
  const change = (v: unknown) => actions.update({ [field.section]: { [field.key]: v } } as SettingsChanges);

  if (field.kind === "rule") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.className = "toggle";
    input.checked = value(settings, field) === true;
    input.addEventListener("change", () => {
      // The whole map is replaced; keep only rules that differ from their default.
      const rules = { ...settings.linting.rules };
      if (input.checked === field.defaultOn) delete rules[field.key];
      else rules[field.key] = input.checked;
      actions.update({ linting: { rules } });
    });
    return input;
  }
  if (field.kind === "toggle") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.className = "toggle";
    input.checked = value(settings, field) === true;
    input.addEventListener("change", () => change(input.checked));
    return input;
  }
  if (field.kind === "text") {
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.className = "settings-text";
    input.placeholder = field.placeholder;
    input.spellcheck = false;
    input.value = String(value(settings, field) ?? "");
    input.addEventListener("change", () => change(input.value.trim()));
    return input;
  }
  if (field.kind === "list") {
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.className = "settings-text";
    input.placeholder = field.placeholder;
    input.spellcheck = false;
    const list = value(settings, field);
    input.value = Array.isArray(list) ? list.join(", ") : "";
    input.addEventListener("change", () =>
      change(
        input.value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    );
    return input;
  }
  const select = document.createElement("select");
  select.id = id;
  for (const [optionValue, label] of field.options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = String(value(settings, field));
  select.addEventListener("change", () => change(field.numeric ? Number(select.value) : select.value));
  return select;
}

/** Builds (or rebuilds) the settings page, keeping the search text and focus. */
export function renderSettingsView(
  container: HTMLElement,
  settings: Settings,
  codeThemes: readonly CodeThemeChoice[],
  lintRules: readonly LintRule[],
  actions: SettingsActions,
): void {
  const focusedId = document.activeElement?.id;
  const oldSearch = container.querySelector<HTMLInputElement>(".settings-search");
  const query = oldSearch?.value ?? "";

  const title = document.createElement("h1");
  title.textContent = "Settings";

  const search = document.createElement("input");
  search.type = "search";
  search.id = "settings-search";
  search.className = "settings-search";
  search.placeholder = "Search settings";
  search.setAttribute("aria-label", "Search settings");
  search.value = query;

  const body = document.createElement("div");
  for (const section of sections(codeThemes, lintRules)) {
    const card = document.createElement("section");
    card.className = "settings-section";
    card.dataset.section = section.id;

    const header = document.createElement("div");
    header.className = "settings-section-header";
    const heading = document.createElement("h2");
    heading.textContent = section.title;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-reset";
    reset.textContent = "Reset to defaults";
    reset.addEventListener("click", () => actions.reset(section.id));
    header.append(heading, reset);
    card.append(header);

    for (const field of section.fields) {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.dataset.search = `${section.title} ${field.label} ${field.hint ?? ""}`.toLowerCase();
      const text = document.createElement("div");
      const label = document.createElement("label");
      label.htmlFor = `setting-${field.section}-${field.key}`;
      label.textContent = field.label;
      text.append(label);
      if (field.hint) {
        const hint = document.createElement("p");
        hint.className = "settings-hint";
        hint.textContent = field.hint;
        text.append(hint);
      }
      row.append(text, control(settings, field, actions));
      card.append(row);
    }
    body.append(card);
  }

  const footer = document.createElement("p");
  footer.className = "settings-hint settings-footer";
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "settings-reset";
  reveal.textContent = "Show settings file";
  reveal.addEventListener("click", () => actions.revealFile());
  footer.append("Settings are saved in settings.json. ", reveal);

  container.replaceChildren(title, search, body, footer);

  const filter = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const card of body.querySelectorAll<HTMLElement>(".settings-section")) {
      let visible = 0;
      for (const row of card.querySelectorAll<HTMLElement>(".settings-row")) {
        const match = words.every((w) => row.dataset.search?.includes(w));
        row.hidden = !match;
        if (match) visible += 1;
      }
      card.hidden = visible === 0;
    }
  };
  search.addEventListener("input", filter);
  filter();

  if (focusedId) document.getElementById(focusedId)?.focus();
}
