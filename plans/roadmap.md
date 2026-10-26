# Atc.Markdown – Roadmap

A cross-platform desktop Markdown viewer (and later editor) written in Rust.

| | |
|---|---|
| **Targets** | Windows 11 (tier 1), macOS (tier 1), Linux (tier 2 – "maybe") |
| **Phase 1** | Viewer: double-click `*.md` → opens and renders; drag & drop; tabs for multiple files |
| **Phase 2** | Editor: side-by-side raw Markdown editor + live rendered preview |
| **Status** | Phase 1 viewer working on Windows (2026-10-25) |
| **Legend** | ✅ done · 🚧 in progress · ⬜ not started |

---

## 1. Technology decision

### Chosen: Tauri 2 + comrak (Rust core) + TypeScript/Vite frontend

| Concern | Choice | Why |
|---|---|---|
| App shell | **Tauri 2** | Small binaries, native installers (MSI/NSIS, `.app`/`.dmg`, deb/rpm/AppImage), built-in file associations (`bundle.fileAssociations`), official plugins for single-instance, dialogs, opener, updater. |
| Markdown → HTML | **comrak** (in Rust) | Port of GitHub's `cmark-gfm`; implements *all* GFM extensions (tables, task lists, strikethrough, autolinks, footnotes). Used by crates.io, docs.rs, lib.rs and GitLab. |
| Sanitizing | **ammonia** (or comrak with unsafe HTML disabled) | Allow-list HTML sanitizer – Markdown can contain raw HTML that would otherwise run inside a webview with IPC access. |
| Code highlighting | `syntect` via comrak plugin (Rust side) | Keeps rendering deterministic and testable in Rust. |
| Frontend | **TypeScript + Vite**, no heavy framework (Svelte optional if UI grows) | Tab bar, preview pane, later editor. Minimal JS = minimal attack surface and build complexity. |
| Editor (Phase 2) | **CodeMirror 6** | Mature, accessible, Markdown mode, large-file friendly. |
| File watching | **notify** crate | Auto-reload in Phase 1; external-change conflict detection in Phase 2. |

### Rejected alternative: egui + egui_commonmark (pure Rust, immediate mode)

- egui_commonmark supports only a *subset* of GFM, and its last release noted was 0.16.1 (2024).
- Rich rendering (Mermaid, KaTeX, GitHub-like CSS) and a full-featured text editor would need to be built by hand – this would block Phase 2.
- Pure-Rust UI benefits (slightly faster startup, no webview) do not outweigh the rendering fidelity a Markdown viewer needs.

Iced and Slint were also considered; same rendering-fidelity problem as egui, and Slint has a GPL/commercial license model.

---

## 2. Architecture

```
atc-markdown/
├─ Cargo.toml                 # cargo workspace
├─ crates/
│  └─ atc-markdown-core/      # PURE library – no Tauri dependency
│     ├─ src/render.rs        # markdown -> sanitized HTML (comrak + ammonia + syntect)
│     ├─ src/document.rs      # Document { path, content, dirty, ... }
│     ├─ src/args.rs          # argv -> file paths (used at startup + second instance)
│     └─ src/links.rs         # resolve relative links/images against document dir
├─ src-tauri/                 # thin shell: commands just call core
│  ├─ src/main.rs
│  ├─ src/commands.rs         # open_file, render, list_tabs, ...
│  ├─ src/file_open.rs        # argv / single-instance / RunEvent::Opened handling
│  ├─ capabilities/           # minimal Tauri 2 permissions
│  └─ tauri.conf.json         # fileAssociations, CSP, bundle config
├─ frontend/                  # TypeScript + Vite
│  ├─ src/tabs.ts             # pure tab state (open/close/activate/dedupe), Vitest-tested
│  ├─ src/preview.ts
│  └─ src/editor.ts           # Phase 2
├─ tests/fixtures/*.md        # shared Markdown fixtures
└─ plans/roadmap.md
```

**Key principle:** all logic that *can* live in `atc-markdown-core` *does*. The Tauri layer is glue. This means most tests run without a GUI, fast, on every OS.

### File-open paths (four distinct cases – each needs its own test)

| # | Case | How the path arrives |
|---|---|---|
| 1 | Windows/Linux, app **not running** | Process `argv` *(verify in spike)* |
| 2 | Windows/Linux, app **already running** | `tauri-plugin-single-instance` callback `(app, args, cwd)` – does nothing by default, we must open a tab + focus the window *(verify `args` contains the path in spike)* |
| 3 | macOS, app **not running** | `RunEvent::Opened { urls }` – can fire *before* the frontend is ready → store paths in managed state, frontend pulls them on startup |
| 4 | macOS, app **already running** | `RunEvent::Opened` → emit an event to the frontend → open tab |

Plus: **drag & drop** via Tauri's *native* window drag-drop event (gives real file paths). HTML5 drop handlers in the webview do not give paths and may not fire on Windows when native DnD is enabled.

### Security model

- Sanitize all rendered HTML (ammonia allow-list); no `<script>`, no `on*` attributes, no `javascript:` URLs.
- Strict CSP in `tauri.conf.json` (`default-src 'self'`; no remote scripts; images limited to `self` + asset protocol).
- Minimal Tauri 2 capabilities – only the commands and plugins actually used.
- External links open in the system browser via the opener plugin, **never** by navigating the webview.
- Local images are served through the asset protocol, scoped to the opened document's directory.

---

## 3. Phases

### Phase 0 – Foundation & spike (≈1 week)

Goal: prove the risky platform bits before building features.

- ✅ `git init`, `.gitignore`, `README.md`, license, `rust-toolchain.toml` (pin stable), `.editorconfig`
- ✅ Cargo workspace with `atc-markdown-core` + `src-tauri`; Vite frontend scaffold
- ✅ Lint config: `rustfmt.toml`, workspace `[lints]` table (clippy `pedantic` as warn, selected `deny`), `deny.toml`
- ✅ CI skeleton (GitHub Actions) – see §5 (not yet run on GitHub)
- ✅ Windows dev build verified: argv cold start (case 1) and second instance (case 2) both reach the frontend (2026-10-25)
- ⬜ **Spike:** build installers on Windows and macOS and verify all four file-open paths from §2 (double-click from Explorer/Finder) — Windows NSIS install verified by user 2026-10-25; macOS pending
- ⬜ **Spike:** verify native drag & drop delivers paths on Windows/macOS
- ✅ **Spike:** verify relative image `![](./img.png)` renders via asset protocol
- ⬜ Decide: plain TS vs Svelte for frontend

**Acceptance:** an installed hello-world build on Win11 and macOS receives a double-clicked `.md` path (cold + warm start) and logs it.

### Phase 1 – Viewer (MVP)

**1a. Rendering core**
- ✅ `render(markdown, base_dir) -> SanitizedHtml` in core using comrak with GFM extensions (tables, task lists, strikethrough, autolink, footnotes, heading anchors)
- ✅ Syntax highlighting for fenced code blocks (syntect)
- ✅ ammonia sanitizing; relative link/image resolution
- ✅ GitHub-like CSS with light/dark theme following the OS

**1a+. Link target preview (show where a link goes before clicking)**

UX: a browser-style **status bubble** in the bottom-left corner of the document area, like Chrome/Edge/VS Code, rather than a native `title` tooltip. A tooltip appears late (~1 s), covers the text being read, and can't show an icon or a type. The bubble appears quickly, never covers the link, and is the convention users already know.

```
┌──────────────────────────────────────────────┐
│ ... see the [deployment guide] for details   │
│                                              │
│╭───────────────────────────────────────╮     │
││ 📄 Open in new tab · docs/deploy.md   │     │  ← bottom-left, small, semi-opaque
│╰───────────────────────────────────────╯     │
└──────────────────────────────────────────────┘
```

- ✅ Show the bubble on mouse hover **and** keyboard focus (Tab through links), with ~100 ms delay to show and ~150 ms fade-out; hide on scroll, mouse leave and tab switch
- ✅ Show the *resolved* target and what a click will do, with an icon per link kind (mirrors `LinkTarget` from core):
  | Kind | Bubble text |
  |---|---|
  | External | 🌐 `https://`**`github.com`**`/atc-net/…` – host in bold; opens in browser |
  | Markdown document | 📄 Open in new tab · `docs/deploy.md` (+ `#section` if any); "already open" if it is |
  | Anchor in same doc | # Jump to "Section title" (heading text, not just the id) |
  | Other local file | 📁 Show in Explorer/Finder · `assets/diagram.drawio`; "(not found)" in muted red if it doesn't exist |
  | Unsupported/blocked (`javascript:`, `file:`, …) | ⛔ Blocked link · not opened |
  | Mailto | ✉ Email `name@example.com` |
- ✅ Anti-spoofing: if the link text looks like a URL/domain and differs from the real host (e.g. text `microsoft.com`, target `micros0ft.example`), add a ⚠ warning in the bubble; show punycode (`xn--`) hosts decoded *and* raw — both done; when the text names another site *and* the host is punycode, both warnings are shown
- ✅ Resolution in Rust via a side-effect-free `describe_link(document_path, href)` command (same `resolve_link` as `follow_link`, so the preview never disagrees with the click); results cached per document in the frontend
- ✅ Long paths/URLs: middle-ellipsis (`https://github.com/…/blob/main/README.md`) with max width ~60% of the window; full value available via "Copy link address"
- ✅ Right-click context menu on links: Open, Copy link address, (for local files) Show in Explorer/Finder
- ✅ External links get a subtle ↗ marker after the link text (CSS only), so they can be told apart even without hovering
- ✅ Accessibility: bubble is `aria-live="polite"` and `aria-hidden` while hidden; respects `prefers-reduced-motion` (no fade)
- ✅ Tests: core unit tests for `describe_link` per kind; Vitest for the ellipsis and spoof-detection helpers

**1b. Opening files**
- ✅ File association for `.md`, `.markdown` (`bundle.fileAssociations`)
- ✅ Single-instance: second launch opens a new tab in the running window and focuses it
- ⬜ Drag & drop one or many files onto the window → one tab per file (implemented; needs a manual check)
- ✅ File → Open dialog (`tauri-plugin-dialog`), Ctrl/Cmd+O
- ✅ Encoding: UTF-8 (with/without BOM); clear error tab for unreadable/binary files

**1c. Tabs**
- ✅ Tab bar: open, close (middle-click, Ctrl/Cmd+W), switch (Ctrl+Tab, Ctrl/Cmd+1..9)
- ✅ Opening an already-open file activates its tab (dedupe by canonical path)
- ✅ Clicking a link to another local `.md` opens it in a new tab
- ✅ Tooltip with full path; window title shows active file

**1d. Quality of life**
- ✅ Auto-reload when the file changes on disk (`notify`, debounced)
- ✅ Remember window size/position (`tauri-plugin-window-state`)
- ✅ Reopen last tabs on start (open paths + active tab in localStorage; missing files skipped)
- ✅ Zoom (Ctrl/Cmd +/-/0, remembered)
- ✅ Per-tab scroll position kept when switching tabs
- ✅ External links open in the system browser; other local files are revealed in Explorer/Finder
- ✅ Find in page (Ctrl/Cmd+F, Enter/Shift+Enter, F3, Esc) — own find bar using the CSS Custom Highlight API; replaces WebView2's built-in bar
- ✅ Native app menu (File/Edit/View/Help; macOS app + Window menus). Items forward to the frontend's command dispatcher; shortcuts are shown but handled in JS (no accelerators → no double-firing). macOS menu untested
- ✅ F5 / Ctrl+R reload the active document instead of the webview (a webview reload used to wipe all tabs)

**1e. Code block highlighting (all common languages)**

Goal: fenced code blocks such as ` ```csharp `, ` ```json `, ` ```powershell ` show colored keywords, strings, comments and types, so they look like code in an editor rather than plain text in a box.

Status (checked 2026-10-25): syntect's built-in syntax set already colours `rust`, `cs`/`c#`, `json`, `js`, `python`, `sql`, `yaml`, `xml`, `html`, `css`, `bash`/`sh`, `go`, `java`, `c`/`cpp`, `markdown`, `diff`. These render as **plain text** today: `csharp`, `fsharp`/`fs`, `razor`/`cshtml`, `ts`/`typescript`/`tsx`/`jsx`, `jsonc`, `toml`, `scss`, `powershell`/`ps1`/`pwsh`, `shell`, `dockerfile`, `kotlin`, `swift`, `ini`, `graphql`, `bicep`, `hcl`/`terraform`, `vb`.

- ✅ Add the extra syntaxes from the `two-face` crate (the syntax/theme set `bat` ships: TypeScript, TOML, PowerShell, Dockerfile, Kotlin, Swift, F#, …) instead of maintaining `.sublime-syntax` files ourselves — done with the onig regex engine (the pure-Rust engine set lacks PowerShell)
- ✅ Fence-name alias map in core (`csharp`→C#, `ts`→TypeScript, `ps1`/`pwsh`→PowerShell, `yml`→YAML, `jsonc`→JSON, `shell`/`zsh`/`console`→Bash, `cshtml`→Razor, `tf`→HCL, …); lookup is case-insensitive
- ✅ Missing grammars (e.g. Bicep, Razor) fall back to the closest related grammar, or to plain text without error
- ✅ Theme check: keywords, strings, comments, numbers and types are clearly distinguishable in both light and dark mode (e.g. GitHub light/dark-like themes); readable contrast on the code-block background — themes: GitHub (light), OneHalfDark (dark); each scoped to its own mode
- ✅ Test: a fixture with one block per supported fence name, plus a test asserting none of them renders as `hl-text hl-plain` (stops regressions when the alias list or crates change)
- ✅ Measure the impact of the extra syntax set on startup time and binary size (lazy-load the syntax set if it is noticeable) — measured: app 6.5 → 7.2 MB, installer 2.2 → 2.7 MB; syntaxes load on a background thread at startup
- ✅ Nice to have: small language label and a "Copy" button on each code block (see Phase 1.8)

**Acceptance criteria**
- A ` ```csharp ` block shows `public`, `class`, `var` and `return` in keyword colour, strings in string colour and `//` comments in comment colour; the same holds for `json`, `typescript`, `powershell`, `yaml`, `xml`, `sql`, `bash`.
- Double-clicking `README.md` in Explorer/Finder opens it rendered — in a new tab of the running instance if one exists.
- Dragging 3 `.md` files onto the window opens 3 tabs.
- GFM fixture (tables, task lists, footnotes, code) renders like GitHub.
- A `.md` containing `<script>alert(1)</script>` and `[x](javascript:alert(1))` executes nothing.
- Relative images next to the file render.

### Phase 1.5 – Distribution — postponed

> **Postponed** (decided 2026-10-26): the app is still a proof of concept; release workflow, code signing and the macOS/Linux packages wait until it is ready for other users. Local NSIS builds (`npx tauri build --bundles nsis`) are used meanwhile.

- ⬜ Windows: MSI/NSIS installer, code signing (avoid SmartScreen warnings)
- ⬜ macOS: `.app` + `.dmg`, Developer ID signing + notarization (avoid Gatekeeper block); universal binary (x64 + arm64)
- ⬜ Linux (tier 2): deb/rpm (register MimeType via `.desktop`; note AppImage does **not** register file associations)
- ⬜ Release workflow with `tauri-action`; optional auto-update (`tauri-plugin-updater`)

### Phase 1.7 – GitHub Wiki mode (open a cloned wiki folder)

Status 2026-10-26: implemented, unit-tested and checked in the app against the real wiki (sidebar and in-page navigation, back/forward, page highlight, Ctrl+P, session restore).

Goal: open a local clone of a GitHub wiki (e.g. `D:\Code\atc-net\atc-rest-api-source-generator.wiki`) and browse it so it looks and feels like clicking around on `https://github.com/atc-net/atc-rest-api-source-generator/wiki`, but offline and instantly.

```
┌ Tabs: [📚 atc-rest-api-source-generator wiki] [README.md] ────────────────┐
│ 📚 atc-rest-api-source-generator  ›  Working with Enums     ◀ ▶  🔍 Find page │
├────────────────────────┬──────────────────────────────────────────────────┤
│ _Sidebar.md (rendered) │ Working with Enums                    (page title)│
│ 🏠 Home                │ Last edited 2 days ago · 28 KB                    │
│ 📖 Getting Started     │ ───────────────────────────────────────────────── │
│  • OpenAPI in 10 Min   │ (Working-with-Enums.md rendered)                  │
│  ▸ Working with Enums ◀│                                                   │
│ ⚙️ Features            │                                                   │
│  …                     │ ───────────────────────────────────────────────── │
│ ▾ Pages (52)  [filter] │ _Footer.md (if present)                           │
├────────────────────────┴──────────────────────────────────────────────────┤
```

**Opening**
- ✅ File → Open Wiki Folder… (Ctrl/Cmd+Shift+O); drag a folder onto the window; folder path as command-line argument
- ✅ Detect a wiki folder: name ends in `.wiki`, or `Home.md` + `_Sidebar.md` exist, or git `origin` ends in `.wiki.git`. Opening `Home.md` (or any page) inside such a folder offers "Open as wiki" in an info bar
- ⬜ Later (Phase 1.5 installer): Explorer/Finder context menu "Open as wiki with Atc.Markdown" on folders

**Layout (a wiki is one tab)**
- ✅ Two panels: left = rendered `_Sidebar.md` (independent scroll), right = current page, default `Home.md`
- ✅ Resizable splitter (width remembered); sidebar collapsible (Ctrl/Cmd+B); falls back to an auto-generated page list if `_Sidebar.md` is missing
- ✅ "Pages (N)" list at the bottom of the sidebar with a filter box, like GitHub's page list — all `*.md` except `_Sidebar`/`_Footer`, titles from file names (dashes → spaces)
- 🚧 Page header like GitHub: page title from the file name, "last edited …" from `git log` (falls back to file modified time) — done with file modified time; `git log` author/date not yet
- ✅ `_Footer.md` rendered under every page
- ✅ Current page highlighted in the sidebar and scrolled into view
- ✅ Tab title = wiki name (folder name without `.wiki`); window title = `Page – Wiki – Atc.Markdown`

**Navigation – GitHub wiki link rules**
- ✅ Wiki links: `[[Page Name]]`, `[[Link text|Page-Name]]`, `[[Page Name#section]]` (comrak `wikilinks_title_after_pipe`), spaces → dashes, matched case-insensitively to `Page-Name.md`
- ✅ Plain links without extension: `[text](Working-with-Overlays)` and `(Page#anchor)` resolve to `Working-with-Overlays.md`
- ✅ Absolute links to the same wiki (`https://github.com/<owner>/<repo>/wiki/<Page>`, owner/repo from git `origin`, else from folder name) open locally instead of in the browser; the status bubble says "Open wiki page" and shows the local page
- ✅ Links to a missing page are shown in red (like GitHub's "new page" links), status bubble: "Page not found"
- ✅ Images relative to the wiki root (`images/x.png`) load via the asset scope (only inside the wiki folder)
- ✅ Clicking a page link navigates **within the wiki tab** (no new tab); Ctrl/Cmd+click or middle-click opens it in a new tab
- ✅ Back/forward history per wiki tab: ◀ ▶ buttons, Alt+←/→, mouse back/forward buttons; scroll position restored on back
- ✅ Scroll to top on new page; to the anchor when the link has `#section`
- 🚧 Find page (Ctrl/Cmd+P): quick-open over page titles; full-text search across pages (later) — Ctrl+P focuses the page filter; full-text search not yet

**Behaviour**
- ✅ Folder watcher: new/renamed/deleted pages update the page list; edits to the current page, `_Sidebar.md` or `_Footer.md` re-render live
- ✅ Session restore reopens wiki tabs on the page you were on
- ✅ Security: page resolution never leaves the wiki folder (no `..` traversal); same sanitizer as normal documents

**Tests**
- ✅ Core unit tests for the wiki link resolver (`[[...]]` variants, extensionless links, case-insensitivity, GitHub URL mapping, missing pages, traversal attempts)
- 🚧 Fixture mini-wiki (`Home.md`, `_Sidebar.md`, `_Footer.md`, `images/`) with snapshot tests of the rendered sidebar and a page — fixture wiki covered by unit tests; no snapshot yet. Also checked: all 653 internal links of the real atc-rest-api-source-generator wiki resolve
- ✅ Manual check against `atc-rest-api-source-generator.wiki` side by side with the github.com wiki

**Acceptance criteria**
- Opening `D:\Code\atc-net\atc-rest-api-source-generator.wiki` shows `Home` on the right and the rendered `_Sidebar.md` on the left.
- Clicking "🔌 Working with C# Client" in the sidebar shows `Working-with-CSharp-Client.md` in the same tab; ◀ returns to Home at the same scroll position.
- `[[Working with TypeScript Client]]`, `(Working-with-Overlays)` and `https://github.com/atc-net/atc-rest-api-source-generator/wiki/Marker-Files` all open the local page.
- Images under `images/` render; a link to a page that doesn't exist is red and does nothing harmful.

### Phase 1.8 – Viewer polish (finish everything about *viewing* before editing)

Status 2026-10-26: implemented, unit-tested and checked in the app (front matter, alerts, emoji, code copy/label, Mermaid, math, look-alike link warning, outline, settings tab with live theme/sidebar changes, wiki full-text search, git "last edited by"). Later also checked: Ctrl+click / middle-click new wiki tab, reopen closed tab, line numbers, printing (fixed: diagrams printed as source, alert icons missing). Known: diagrams print in the screen theme's colours (dark boxes on paper in dark mode).

Based on what the ~1,200 Markdown files under `D:\Code\atc-net` actually use (399 start with YAML front matter, 23 use emoji shortcodes, 11 Mermaid diagrams, 9 GitHub alerts, 6 math).

**GitHub rendering fidelity**
- ✅ YAML front matter shown as a small table like GitHub (nested values fall back to a YAML code block) instead of a rule + loose text
- ✅ GitHub alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` with icon and colour
- ✅ Emoji shortcodes (`:white_check_mark:` → ✅)
- ✅ `<details>`/`<summary>` keep their `open` state
- ✅ Corpus check: render every `.md` under `D:\Code\atc-net` (read-only) and report math false positives, converted shortcodes, nested front matter, panics

**Code blocks**
- ✅ Copy button (icon, "Copied" feedback) and language label on each code block; not part of Find or text selection; hidden when printing

**User settings**

UX: **Settings** opens as its own tab (Edit → Settings…, Ctrl+, / macOS: app menu → Settings…, Cmd+,), grouped in sections with a search box, every change applied live (no Save button), "Reset to defaults" per section. Stored by Rust in `settings.json` in the OS app-config folder (not browser storage), so it survives webview resets and can be backed up or edited by hand.

| Section | Setting | Options (default first) |
|---|---|---|
| Appearance | Theme | System · Light · Dark |
| | Code colours | GitHub / One Half Dark (default) · Solarized · Monokai · Nord · Dracula … (light + dark pair from the bundled themes) |
| | Text size | 100 % (replaces the remembered zoom; Ctrl +/- still works) |
| | Reading width | Medium (900 px) · Narrow · Wide · Full window |
| | Reading font | System sans · Serif · Custom font name |
| | Code font | System monospace · Custom font name |
| Wiki | Sidebar position | **Left** · Right |
| | Sidebar shown when a wiki opens | On · Off |
| | Page list ("Pages (N)") | Collapsed · Expanded · Hidden |
| | Page header (title, last edited, GitHub link) | On · Off |
| | Show `_Footer.md` | On · Off |
| | Offer "Open as wiki" for files inside a wiki | On · Off |
| Opening files | Reopen last session's tabs on start | On · Off |
| | File opened from Explorer/Finder | New tab · Replace current tab |
| | Reload when the file changes on disk | On · Off |
| Links | Show where a link goes (status bubble) | On · Off |
| | Ask before opening web links | Off · On |
| | Mark web links with ↗ | On · Off |
| Rendering | Front matter | Table · Hidden · Raw YAML |
| | Emoji shortcodes · Mermaid diagrams · Math | On · Off (each) |
| Code blocks | Copy button | On hover · Always · Off |
| | Long lines | Scroll · Wrap |
| | Line numbers | Off · On |
| Advanced | "Show settings file" (log level postponed: the app has no log file yet) | — |

- ✅ Rust `settings.rs`: typed struct with `#[serde(default)]` (missing/unknown keys never break loading; invalid values fall back to defaults), `version` field for migrations, atomic write, commands `get_settings`/`update_settings`, `settings-changed` event so every window updates
- ✅ Theme switching without `prefers-color-scheme` only: `data-theme` on `<html>` resolved from System via `matchMedia`, and the highlight CSS keyed on it (light theme on paper when printing)
- ✅ Rendering settings (front matter, emoji, Mermaid, math) passed to core as `RenderOptions`; changing them re-renders open tabs
- ✅ Settings tab UI with sections, search, live apply, reset per section; migrate the existing zoom / sidebar width / sidebar hidden values from browser storage on first start
- ✅ Tests: serde defaults + round-trip + unknown/invalid values (Rust); settings-to-CSS mapping (Vitest)

**Reading aids**
- ✅ Outline panel: headings of the current document, current section highlighted while scrolling, click to jump (toggle Ctrl/Cmd+Shift+L)
- ✅ Hover a heading to show a "#" that copies a link to that section

**Diagrams & math (like GitHub)**
- ✅ Mermaid diagrams (` ```mermaid `), bundled locally, `securityLevel: 'strict'`, loaded only when a document has one; follow light/dark theme
- ✅ Math with KaTeX (`$…$`, `$$…$$`), bundled locally, loaded only when needed

**Output**
- ✅ Print / Save as PDF (macOS: `window.print()` is known to be unreliable in WKWebView — check on a Mac) (Ctrl/Cmd+P is taken by "Go to page" in wikis → File → Print, Ctrl/Cmd+Shift+P): print stylesheet, whole document, light colours on paper

**Files**
- ✅ Recent files and wikis on the empty start page; reopen closed tab (Ctrl/Cmd+Shift+T)

**Wiki leftovers**
- ✅ Full-text search across all wiki pages, results with snippets; opening a result highlights the match
- ✅ "Last edited by <author>, <when>" from `git log` (async, falls back to file time)
- ✅ Ctrl/Cmd+click or middle-click opens a wiki page in a new tab (a wiki can be open in several tabs; tab id `folder::2`…)

**Links**
- ✅ Decode punycode hosts in the link bubble (show `аpple.com` *and* the raw `xn--pple-43d.com`)

### Phase 2 – Editor (side-by-side)

Status 2026-10-26: built and unit-tested; editing, live preview, save and reload checked in the app.

- ✅ View modes per tab: **Preview** | **Edit** | **Split** (editor left, preview right) – toggle Ctrl/Cmd+E
- ✅ CodeMirror 6 editor with Markdown highlighting, line numbers, soft wrap
- ✅ Line numbers in a gutter on the left side of the editor:
  - user setting **Editor → Show line numbers** (On by default), stored in `settings.json`
  - toggle button in the editor's toolbar (`#` icon, pressed state shows whether they are on) and View → Line Numbers (Ctrl/Cmd+Shift+N); the button and the menu change the same setting, so all editor tabs follow
  - current line number highlighted; with soft wrap, a wrapped line keeps one number (continuation rows are blank)
  - the gutter also hosts lint markers (Phase 2.1) and stays visible for them when numbers are off
  - separate from the "Line numbers" setting for code blocks in the preview
- ✅ Live preview: debounced (~150 ms) re-render through core
- 🚧 Scroll sync between editor and preview (source-position mapping from comrak `sourcepos`) — both ways: the pane last scrolled, clicked or typed in leads and the other follows (no ping-pong, and re-rendering or switching tabs doesn't drag the editor along); fractional lines so it is smooth inside long blocks. Editor side checked in a headless browser (scroll to line → top line round trip within a pixel); not yet checked on screen
- ✅ Dirty indicator on tab (●), Save (Ctrl/Cmd+S), Save As, New file
- 🚧 Unsaved-changes prompt on tab close, window close and app quit — implemented (Save / Don't save / Cancel; File → Exit and macOS quit go through it); not yet checked on screen
- 🚧 External-change conflict: file changed on disk while dirty → ask reload/keep — clean editor reloads in place (checked); dirty → conflict bar implemented, not yet checked on screen
- ✅ Atomic save (write temp + rename), preserve line endings and BOM — checked: CRLF+BOM file byte-identical apart from the edit; 1,153 of 1,155 ATC files round-trip exactly (2 have mixed line endings)

**Acceptance:** edit in left pane → preview updates without flicker; closing a dirty tab prompts; saved file is byte-identical apart from the edits.

### Phase 2.1 – Markdown linting (markdownlint rules) and auto-fix

Goal: while editing, highlight style problems using the rules from [markdownlint](https://github.com/markdownlint/markdownlint/blob/main/docs/RULES.md) (MD001–MD047), and later fix them automatically — one at a time or all at once.

Status 2026-10-26: all 39 rules, fixes, suppressions and config built and tested in core; editor integration built, not yet checked on screen.

Decision: rule names, config format and defaults follow the JS markdownlint (what VS Code and CI use, and what `atc-docs` / `atc-wpf` already configure in `.markdownlint.json`), with the Ruby names accepted as aliases. So MD007 indent defaults to 2, MD029 to `one_or_ordered`, MD046 to `consistent`, and the deprecated MD002 / MD006 are off by default.

✅ **Rules (39)** — implemented in Rust core (pure, testable): comrak's syntax tree with `sourcepos` for structure (headings, lists, code blocks, links) plus line scanning for whitespace rules.

| Group | Rules |
|---|---|
| Headings | MD001 header-increment · MD002 first-header-h1 · MD003 header-style · MD018 no-missing-space-atx · MD019 no-multiple-space-atx · MD020 no-missing-space-closed-atx · MD021 no-multiple-space-closed-atx · MD022 blanks-around-headers · MD023 header-start-left · MD024 no-duplicate-header · MD025 single-h1 · MD026 no-trailing-punctuation · MD036 no-emphasis-as-header · MD041 first-line-h1 |
| Lists | MD004 ul-style · MD005 list-indent · MD006 ul-start-left · MD007 ul-indent · MD029 ol-prefix · MD030 list-marker-space · MD032 blanks-around-lists |
| Whitespace | MD009 no-trailing-spaces · MD010 no-hard-tabs · MD012 no-multiple-blanks · MD013 line-length · MD047 single-trailing-newline |
| Code | MD014 commands-show-output · MD031 blanks-around-fences · MD038 no-space-in-code · MD040 fenced-code-language · MD046 code-block-style |
| Links & inline | MD011 no-reversed-links · MD033 no-inline-html · MD034 no-bare-urls · MD037 no-space-in-emphasis · MD039 no-space-in-links |
| Block quotes & rules | MD027 no-multiple-space-blockquote · MD028 no-blanks-blockquote · MD035 hr-style |

**Showing issues**
- 🚧 Editor (Phase 2): wavy underline on the exact range, icon in the gutter, hover shows rule id + message + "Fix" / "Fix all MDxxx" buttons — built (`@codemirror/lint` 6.9.7, own gutter so markers stay without line numbers); not yet checked on screen. All issues are warnings for now
- 🚧 Problems panel (Ctrl/Cmd+Shift+M, View → Lint Problems; F8 = next issue): list for the open file, click to jump; count as a "⚠ 7" button in the editor toolbar — built, not yet checked on screen
- 🚧 Viewer: optional "⚠ N" badge in the document toolbar while viewing (off by default — viewing should stay quiet; Settings → Linting → Show issues in the viewer); click opens the editor with the problems list; counted again after a reload or a lint settings change. Not for wiki tabs (they have no document toolbar) — built, not yet checked on screen
- 🚧 Lint a whole folder / wiki (View → Lint Folder…): a report tab with the issue counts per rule (click to filter) and the files with issues (expand to list them; click an issue to open the file in the editor at that line). Same settings and project config files as the editor; files in a wiki folder are linted as wiki pages; hidden folders and `node_modules` skipped; at most 5,000 files and 50 listed issues per rule and file (counts include all). All 1,155 files under `D:\Code\atc-net`: 68,730 issues in 0.6 s (files read and linted in parallel) — built, not yet checked on screen

**Configuration**
- ✅ Settings → Linting: on/off, use project config, maximum line length (MD013, Off by default), nested list indent (MD007), fix on save, and a switch per rule; other parameters (MD004 `style`, MD033 `allowed_elements`, MD026 `punctuation`, …) come from the project config file
- ✅ Project config wins over app settings: nearest `.markdownlint.jsonc` / `.json` / `.yaml` / `.yml` above the file (comments and trailing commas allowed; `"default": false` honoured; unknown rules like MD051 ignored); a broken file is reported once and the app settings are used
- ⬜ Ruby `.mdlrc` / style files (they are Ruby code; only if someone needs them)
- ✅ Inline suppressions: `markdownlint-disable` / `enable` (all or listed rules, ids or names), `disable-line`, `disable-next-line`, `disable-file` / `enable-file`, `capture` / `restore`
- ✅ Sensible defaults for GitHub-style docs: MD013 off, MD033 allowing `details`, `summary`, `br`, `img`, `kbd`, `sub`, `sup`, `picture`, `source`; in a wiki folder the page title counts as the H1 (MD041/MD002 off, MD001/MD025 start from h1), and so does a front matter `title:`

**Auto-fix (later step)**
- ✅ Fix engine in core: each fix is a list of text edits (range → replacement); "fix all" re-runs the rules until nothing changes (idempotent); one undo step in the editor per fix / per "Fix all"
- 🚧 Quick fix on an issue, "Fix all of this rule", "Fix all in file" (Ctrl/Cmd+Shift+., View → Fix All Lint Issues), fix-on-save (off by default; only MD009, MD012, MD019, MD021, MD022, MD023, MD032, MD047 — checked on the corpus not to change the rendering; MD010, MD018, MD027, MD031 can) — built, not yet checked on screen
- ✅ Fixable: MD003 (atx ↔ closed atx, setext → atx, atx → setext for h1/h2), MD004, MD005, MD007 (not inside quotes), MD009 (keeps a 2-space line break), MD010, MD011, MD012, MD014, MD018, MD019, MD020, MD021, MD022, MD023, MD026, MD027, MD029, MD030 (single-block items only), MD031, MD032, MD034, MD035, MD037, MD038, MD039, MD040 (see below), MD046 (see below), MD047. Fixes keep the file's line breaks (CRLF stays CRLF)
- ✅ MD046 fix: indented → fenced (same rendering: unit tests per layout — list, quote, quote in list, blank lines, backtick fences inside — and 200,000 generated documents); not offered for a tab right after the indent or code on a list marker line. Fenced → indented is not offered (it would lose the language and leading/trailing blank lines)
- ✅ Not auto-fixable (need a human): MD001, MD002, MD006, MD013, MD024, MD025, MD028, MD033, MD036, MD041; MD040 only when the first line tells the language (`#!/bin/bash`, `#!/usr/bin/env python3`, `<?xml`, `<!DOCTYPE html`, `<?php`, `@echo off`)
- 🚧 MD040 pick-list of languages: the fence names the preview's highlighter knows (≈200, popular first, grammar shown beside each) are completed while typing after an opening fence (Ctrl+Space right after the backticks), and the MD040 issue has a "Language…" button that opens the list — built, not yet checked on screen
- 🚧 Preview of a "Fix all" (file or one rule) as a diff before applying: a dialog with the changed lines in red/green, two lines of context, old and new line numbers, tabs and trailing spaces made visible, and a summary ("12 issues: MD009 × 8, MD012 × 4"); Apply / Cancel (Escape). On by default (Settings → Linting → Preview fixes); fix-on-save and the single "Fix" button apply directly — built, not yet checked on screen

**Tests**
- ✅ Per rule: the bad and good example of every rule from RULES.md, plus targeted cases (positions, UTF-16 offsets with æøå/emoji, code spans across lines, alerts, front matter, wiki pages, suppressions)
- ✅ Per fix: expected output; fix-all twice changes nothing; whitespace-only fixes keep the rendered HTML (unit test + corpus)
- ✅ Corpus check: all 1,187 `.md` files under `D:\Code\atc-net` (read-only): no panics, fix-all idempotent everywhere, ~0.5 s for all files (slowest 24 ms); the only rendering change from whitespace fixes is MD027 turning `>  [!TIP]` into the alert it was meant to be. Most issues are in generated CodeDoc files (MD034 bare URLs, MD022/MD031 blank lines)

### Phase 2.2 – Azure DevOps wiki pages (open, edit and save directly) — postponed (future feature)

> **Postponed** (decided 2026-10-26): kept as a future feature; not planned for now. The design below stays as the starting point when it is picked up again.

Goal: open pages of an Azure DevOps wiki (project wiki or code wiki) straight from Azure DevOps, edit several of them in tabs, and save back — no browser, no copy-paste. Never silently overwrite someone else's edit.

**Connecting**
- ⬜ File → Open from Azure DevOps…: paste a wiki page URL (`https://dev.azure.com/{org}/{project}/_wiki/wikis/{wiki}/{id}/{Page}`) or pick organization → project → wiki → page from a tree
- ⬜ Sign-in: Personal Access Token (scope *Wiki: Read & write*; later *Work Items*) or Microsoft Entra ID (reuse the Azure CLI / Visual Studio sign-in where available); secrets stored in the OS credential store (Windows Credential Manager / macOS Keychain via the `keyring` crate), never in `settings.json`
- ⬜ Connections listed in Settings (organization, sign-in method, test connection, remove)

**Pages in tabs**
- ⬜ Each page opens in its own tab (icon ☁ + page title), same viewer/editor as local files: preview, split, live preview, Find, outline
- ⬜ Rendering follows Azure DevOps wiki Markdown: `[[_TOC_]]`, `[[_TOSP_]]` (sub-pages), `::: mermaid`, `/Page-Name` and `/.attachments/…` links, `@mentions` and `#123` work item links shown as links
- ⬜ Sidebar with the wiki's page tree (from the Pages API, honouring `.order`); click to open, Ctrl+click for a new tab — like the GitHub wiki mode
- ⬜ Save (Ctrl+S) writes the page through the REST API (`PUT …/_apis/wiki/wikis/{wiki}/pages?path=…` with `If-Match: <ETag>`), with an optional commit comment
- ⬜ Images pasted or dropped into a page are uploaded as wiki attachments (later)

**Concurrent edits — never overwrite someone else's work**
- ⬜ Every page keeps the `ETag` (page version) it was loaded with; saving sends it as `If-Match`, so Azure DevOps rejects the save (412) if anyone changed the page meanwhile
- ⬜ Remote watcher, like the file watcher: while a page is open, poll its version (lightweight `GET` without content, every ~30 s and when the window gets focus; backoff on errors/offline)
  - no local edits → reload the page automatically (cursor and scroll kept), small "Updated by <author>" note
  - local edits → conflict bar: "Changed in Azure DevOps by <author> at <time>": **Show changes** (diff of theirs vs yours) · **Reload theirs** · **Keep mine** (saving then asks before overwriting)
- ⬜ A rejected save (412) opens the same conflict choice instead of failing
- ⬜ Offline: edits stay in the tab (and in a local draft file) until saved; clear "offline" status

**Later: work items**
- ⬜ Open Epic / Feature / Product Backlog Item / User Story / Task / Bug by id or URL: title, state, assigned to, and the rich-text fields (Description, Acceptance Criteria, Repro Steps) shown and edited as Markdown (Azure DevOps' Markdown format for multi-line fields; HTML fields converted)
- ⬜ Save with optimistic concurrency (`test /rev` in the JSON Patch), same conflict handling and watcher as wiki pages
- ⬜ Links between work items and wiki pages open in tabs

**Tests**
- ⬜ REST client against a recorded/mocked Azure DevOps API (no network in CI): load, save, 412 conflict, auth failure, paging of the page tree
- ⬜ Manual check against a real test project wiki: two people editing the same page

### Phase 3 – Later ideas (unprioritized)

- Mermaid diagrams and KaTeX math (libraries bundled locally, output sanitized)
- Table of contents / outline sidebar; folder/workspace sidebar
- Export to HTML/PDF; print
- Formatting toolbar, paste-image-to-file
- Session restore, recent files, settings UI
- Spell check, i18n

---

## 4. Rust coding best practices (applied)

- **Toolchain:** pin stable in `rust-toolchain.toml`; set `rust-version` (MSRV) in workspace `Cargo.toml`; edition 2024.
- **Workspace hygiene:** shared `[workspace.dependencies]` and `[workspace.lints]`; commit `Cargo.lock` (it is an application).
- **Formatting/lints:** `cargo fmt --check`; `cargo clippy --all-targets --all-features -- -D warnings`; enable `clippy::pedantic` as warnings and fix or allow consciously.
- **Errors:** `thiserror` for typed errors in core; `anyhow` only at the app boundary; Tauri commands return `Result<T, String>`-serializable errors — never `unwrap()`/`expect()` on user input or I/O.
- **No panics across IPC:** every command validates input (paths canonicalized, must be a file, size limit).
- **Logging:** `tracing` + `tracing-subscriber` (file log in release, console in dev).
- **Types over strings:** newtypes like `SanitizedHtml`, `DocumentId` so unsanitized HTML cannot reach the webview by accident.
- **Supply chain:** `cargo-deny` (licenses, advisories, duplicate crates, banned sources); Dependabot/Renovate.
- **Docs:** `///` doc comments on public core API; `#![warn(missing_docs)]` in core.

---

## 5. Testing strategy

| Layer | Tool | What it covers | Runs on |
|---|---|---|---|
| Unit | `cargo nextest` | core: tab model, link resolution, encoding, errors | all OS, every PR |
| Snapshot | **insta** | rendered HTML for each fixture in `tests/fixtures/` (GFM, edge cases, XSS payloads) | all OS |
| Property | **proptest** | tab invariants (no duplicates, active tab always valid, close/open sequences); renderer never panics on arbitrary input | all OS |
| Fuzz (optional) | `cargo-fuzz` | renderer + sanitizer on random input | nightly / scheduled |
| Command | Tauri mock runtime (`tauri::test`) | commands wired correctly, state handling, startup-path queue for macOS | all OS |
| Frontend | **Vitest** | tab bar, keyboard shortcuts, preview DOM updates | all OS |
| E2E | **WebdriverIO + tauri-driver** | open via argv, drag-drop simulation, tabs, Phase 2 edit/save | Windows + Linux |
| Manual checklist | — | the four file-open paths on installed builds, signing, Gatekeeper/SmartScreen | each release |

**Known gap – macOS E2E:** the official `tauri-driver` does not support macOS (WKWebView has no desktop WebDriver). Options: WebdriverIO's embedded WebDriver plugin (free, adds a small Rust plugin in test builds only) or CrabNebula's paid driver. Start with manual macOS checks; revisit in Phase 1.5.

**Coverage:** `cargo-llvm-cov` on core; aim for high coverage on core, not on the Tauri glue.

### CI (GitHub Actions)

- Matrix: `windows-latest`, `macos-latest`, `ubuntu-latest` (Linux tier 2 – may be allowed to fail initially).
- Jobs: `fmt` → `clippy -D warnings` → `nextest` (+ JUnit output) → `insta` (fail on pending snapshots) → `vitest` → `cargo-deny` → bundle (`tauri-action`) → E2E (Win/Linux).
- `--locked` everywhere; pin action versions; cache with `Swatinem/rust-cache`.
- Separate scheduled job: fuzzing + `cargo audit`.

---

## 6. Assumptions & open questions

- **"Tab1 / Tab2" in Phase 2** is interpreted as the two panes of a side-by-side split (editor | preview) inside one document tab — not two separate document tabs. Please confirm.
- **Linux** is tier 2: built and unit-tested in CI, packaged as deb/rpm, but no release blocker.
- **Code signing:** need a Windows certificate and an Apple Developer account before Phase 1.5.
- **Frontend framework:** plain TypeScript by default; switch to Svelte if the UI grows (settings, sidebars).
- **Repo hosting:** GitHub (Actions for CI). Now: <https://github.com/sandbox-atc-net/atc-markdown>; later moves to <https://github.com/atc-net/atc-markdown>. When moving: update repo URLs (README, `Cargo.toml` `repository`, updater endpoint if used), re-add CI secrets/signing certificates, and keep a redirect via GitHub's repo transfer.
- **Name/identifier:** bundle identifier `net.atc.markdown` (in `tauri.conf.json`); keep it stable across the repo move — changing it later breaks file associations and saved settings.

---

## 7. Sources

- [Tauri 2 – File associations (RunEvent::Opened, fileAssociations)](https://v2.tauri.app/learn/mobile-file-associations/)
- [Tauri 2 – Single Instance plugin](https://v2.tauri.app/plugin/single-instance/)
- [Tauri 2 – Testing / WebDriver](https://v2.tauri.app/develop/tests/)
- [WebdriverIO – Tauri desktop testing](https://webdriver.io/docs/desktop-testing/tauri)
- [CrabNebula – Tauri E2E tests (macOS driver)](https://docs.crabnebula.dev/plugins/tauri-e2e-tests/)
- [comrak on lib.rs](https://lib.rs/crates/comrak) · [comrak announcement (GFM completeness)](https://users.rust-lang.org/t/release-comrak-commonmark-gfm-compatible-markdown-parser/10340)
- [egui_commonmark](https://github.com/lampsitter/egui_commonmark)
- [Rust GUI frameworks: egui vs iced vs slint (2026)](https://www.pistack.xyz/posts/2026-08-25-rust-gui-frameworks-egui-iced-slint-comparison/)
- [Tauri vs iced vs egui performance comparison](https://lukaskalbertodt.github.io/2023/02/03/tauri-iced-egui-performance-comparison.html)
- [Ammonia HTML sanitizer usage](https://alanwsmith.com/en/2um6lang)
- [Rust testing research (nextest, insta, proptest)](https://docs.rs/crate/gor-cli/0.2.0/source/docs/research/research-testing.md) · [Rust CI/CD research](https://docs.rs/crate/gor-cli/0.2.0/source/docs/research/research-cicd.md)
- [ci-baseline-rust (fmt, clippy -D warnings, cargo-deny)](https://github.com/boinkor-net/ci-baseline-rust)
