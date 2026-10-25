# Atc.Markdown

A fast, cross-platform Markdown viewer for Windows, macOS and Linux, built with Rust and [Tauri 2](https://tauri.app).

- Double-click a `.md` file to open it rendered (GitHub Flavored Markdown)
- Drag and drop files onto the window
- Tabs for multiple files
- Planned: side-by-side editor with live preview

## Project layout

| Path | What it is |
|---|---|
| `crates/atc-markdown-core` | Pure Rust library: Markdown → sanitized HTML, document loading, argv parsing. No UI – most tests live here. |
| `src-tauri` | Thin Tauri app shell: windows, OS file-open events, commands. |
| `frontend` | TypeScript + Vite UI: tabs, preview, drag & drop. |
| `Cargo.toml` | Cargo workspace (the Rust equivalent of a `.sln`). |

## Prerequisites

- Rust (stable) via [rustup](https://rustup.rs)
- Node.js 24+
- **Windows:** Visual Studio with the *Desktop development with C++* workload, WebView2 (preinstalled on Windows 11)
- **macOS:** Xcode Command Line Tools
- **Linux:** see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Develop

```sh
npm install
npm run tauri dev                                   # run the app with hot reload
npm run tauri -- dev -- -- "C:\full\path\to\file.md"  # run and open a file (simulates double-click)
```

Use an absolute path: `tauri dev` runs the app from inside `src-tauri`, so relative paths resolve there.
Set `RUST_LOG=debug` to see which files the app receives.

## Test & lint

```sh
cargo test --workspace          # Rust unit, snapshot and property tests
cargo insta review              # review changed HTML snapshots (cargo install cargo-insta)
npm test                        # frontend unit tests (Vitest)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo deny check                # licenses & advisories (cargo install cargo-deny)
```

## Build installers

```sh
npm run tauri build
```

Output goes to `target/release/bundle/` (MSI/NSIS on Windows, `.app`/`.dmg` on macOS, deb/rpm/AppImage on Linux).
File associations for `.md` only take effect from an **installed** build, not from `tauri dev`.

## License

MIT
