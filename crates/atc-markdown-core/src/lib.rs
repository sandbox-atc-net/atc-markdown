//! UI-independent core of Atc.Markdown.
//!
//! Everything that can be tested without a window lives here: Markdown rendering
//! and sanitizing, loading documents from disk, resolving links, and turning
//! command-line arguments into file paths. The Tauri app is a thin shell around this crate.

#![warn(missing_docs)]

mod args;
mod document;
mod highlight;
mod links;
mod paths;
mod render;

pub use args::paths_from_args;
pub use document::{Document, DocumentError, MAX_DOCUMENT_BYTES, load_document};
pub use highlight::{code_language, highlight_css, warm_up};
pub use links::{
    LinkPreview, LinkTarget, MARKDOWN_EXTENSIONS, describe_link, is_markdown_file, resolve_link,
};
pub use render::{Rendered, SanitizedHtml, render_document, render_markdown};
