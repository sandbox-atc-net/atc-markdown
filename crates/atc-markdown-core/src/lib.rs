//! UI-independent core of Atc.Markdown.
//!
//! Everything that can be tested without a window lives here: Markdown rendering
//! and sanitizing, loading documents from disk, resolving links, and turning
//! command-line arguments into file paths. The Tauri app is a thin shell around this crate.

#![warn(missing_docs)]

mod args;
mod document;
mod front_matter;
mod highlight;
mod links;
mod paths;
mod render;
mod wiki;

pub use args::paths_from_args;
pub use document::{
    Document, DocumentError, MAX_DOCUMENT_BYTES, load_document, load_document_with,
};
pub use highlight::{
    CODE_THEMES, CodeTheme, code_language, code_theme, highlight_css, highlight_css_for, warm_up,
};
pub use links::{
    LinkPreview, LinkTarget, MARKDOWN_EXTENSIONS, describe_link, is_markdown_file, preview_target,
    resolve_link,
};
pub use render::{
    FrontMatterStyle, RenderOptions, Rendered, SanitizedHtml, render_document,
    render_document_with, render_markdown,
};
pub use wiki::{
    GitHubRepo, SearchHit, Snippet, Wiki, WikiDocument, WikiHref, WikiInfo, WikiPage,
    find_wiki_root, is_wiki_dir,
};
