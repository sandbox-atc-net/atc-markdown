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
mod lint;
mod paths;
mod render;
mod source;
mod wiki;

pub use args::paths_from_args;
pub use document::{
    Document, DocumentError, MAX_DOCUMENT_BYTES, load_document, load_document_with,
};
pub use highlight::{
    CODE_THEMES, CodeTheme, FenceLanguage, code_language, code_theme, fence_languages,
    guess_fence_language, highlight_css, highlight_css_for, warm_up,
};
pub use links::{
    LinkPreview, LinkTarget, MARKDOWN_EXTENSIONS, describe_link, is_markdown_file, preview_target,
    resolve_link,
};
pub use lint::{
    CONFIG_FILE_NAMES, ConfigError, Diagnostic, FileLint, FolderIssue, FolderLint, Issue,
    LintConfig, MAX_FOLDER_FILES, MAX_ISSUES_PER_RULE, RULES, RuleConfig, RuleCount, RuleInfo,
    TextEdit, Utf16Edit, apply_fixes, find_config_file, fix_all, lint, lint_folder, lint_utf16,
    rule_info,
};
pub use render::{
    FrontMatterStyle, RenderOptions, Rendered, SanitizedHtml, render_document,
    render_document_with, render_markdown,
};
pub use source::{
    LineEnding, SaveError, SaveRequest, SourceFile, canonical_path, detect_line_ending, encode,
    fingerprint, normalize_line_breaks, read_source, save_source,
};
pub use wiki::{
    GitHubRepo, SearchHit, Snippet, Wiki, WikiDocument, WikiHref, WikiInfo, WikiPage,
    find_wiki_root, is_wiki_dir,
};
