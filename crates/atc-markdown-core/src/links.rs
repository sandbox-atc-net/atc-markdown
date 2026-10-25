//! Deciding what clicking a link in a rendered document should do.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::paths::{has_scheme, resolve_relative};

/// File extensions opened as Markdown documents inside the app.
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd"];

/// What a link points to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkTarget {
    /// A heading or footnote in the same document (`#id`).
    Anchor {
        /// The id without the leading `#`.
        id: String,
    },
    /// Another Markdown file: open it in a tab.
    Document {
        /// Absolute path to the file.
        path: PathBuf,
        /// Optional `#id` to scroll to after opening.
        fragment: Option<String>,
    },
    /// Some other local file (image, PDF, …): reveal it in the file manager.
    LocalFile {
        /// Absolute path to the file.
        path: PathBuf,
    },
    /// A web or mail link: open it in the system browser / mail client.
    External {
        /// The URL as written.
        url: String,
    },
    /// Anything else (unknown scheme, empty link): do nothing.
    Unsupported,
}

/// Works out what `href`, found in the document at `document_path`, points to.
pub fn resolve_link(document_path: &Path, href: &str) -> LinkTarget {
    let href = href.trim();
    if let Some(id) = href.strip_prefix('#') {
        return LinkTarget::Anchor {
            id: crate::paths::percent_decode(id),
        };
    }
    if has_scheme(href) {
        let scheme = href
            .split(':')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        return if matches!(scheme.as_str(), "http" | "https" | "mailto") {
            LinkTarget::External {
                url: href.to_string(),
            }
        } else {
            LinkTarget::Unsupported
        };
    }

    let base_dir = document_path.parent().unwrap_or(Path::new(""));
    let Some(path) = resolve_relative(base_dir, href) else {
        return LinkTarget::Unsupported;
    };
    if is_markdown_file(&path) {
        let fragment = href
            .split_once('#')
            .map(|(_, f)| crate::paths::percent_decode(f))
            .filter(|f| !f.is_empty());
        LinkTarget::Document { path, fragment }
    } else {
        LinkTarget::LocalFile { path }
    }
}

/// What hovering a link shows: its target, and whether a local target exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkPreview {
    /// Where the link goes (the same answer clicking it would give).
    #[serde(flatten)]
    pub target: LinkTarget,
    /// `false` if the link points to a local file that is missing.
    pub exists: bool,
}

/// Describes a link for the hover preview, without opening anything.
pub fn describe_link(document_path: &Path, href: &str) -> LinkPreview {
    let target = resolve_link(document_path, href);
    let exists = match &target {
        LinkTarget::Document { path, .. } | LinkTarget::LocalFile { path } => path.exists(),
        _ => true,
    };
    LinkPreview { target, exists }
}

/// Returns `true` if the path has a Markdown file extension.
pub fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|m| m.eq_ignore_ascii_case(ext))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "/docs/guide/readme.md";

    fn resolve(href: &str) -> LinkTarget {
        resolve_link(Path::new(DOC), href)
    }

    #[test]
    fn anchors() {
        assert_eq!(
            resolve("#install"),
            LinkTarget::Anchor {
                id: "install".into()
            }
        );
    }

    #[test]
    fn external_links() {
        assert_eq!(
            resolve("https://example.com"),
            LinkTarget::External {
                url: "https://example.com".into()
            }
        );
        assert!(matches!(
            resolve("MAILTO:a@b.c"),
            LinkTarget::External { .. }
        ));
    }

    #[test]
    fn dangerous_or_unknown_schemes_are_unsupported() {
        assert_eq!(resolve("javascript:alert(1)"), LinkTarget::Unsupported);
        assert_eq!(resolve("file:///etc/passwd"), LinkTarget::Unsupported);
        assert_eq!(resolve(""), LinkTarget::Unsupported);
    }

    #[test]
    fn markdown_links_open_as_documents() {
        assert_eq!(
            resolve("../api/Index.MD#usage"),
            LinkTarget::Document {
                path: PathBuf::from("/docs/api/Index.MD"),
                fragment: Some("usage".into())
            }
        );
        assert_eq!(
            resolve("other.md"),
            LinkTarget::Document {
                path: PathBuf::from("/docs/guide/other.md"),
                fragment: None
            }
        );
    }

    #[test]
    fn other_local_files() {
        assert_eq!(
            resolve("./diagram.pdf"),
            LinkTarget::LocalFile {
                path: PathBuf::from("/docs/guide/diagram.pdf")
            }
        );
    }

    #[test]
    fn describe_link_reports_missing_local_files() {
        let dir = std::env::temp_dir();
        let doc = dir.join("doc.md");
        let preview = describe_link(&doc, "./surely-missing-file-1b2c.md");
        assert!(!preview.exists);
        assert!(matches!(preview.target, LinkTarget::Document { .. }));
    }

    #[test]
    fn describe_link_serializes_flat() {
        let preview = describe_link(Path::new("/docs/a.md"), "https://example.com");
        let json = serde_json::to_value(&preview).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "external", "url": "https://example.com", "exists": true })
        );
    }
}
