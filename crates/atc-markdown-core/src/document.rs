//! Loading Markdown documents from disk.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::render::{SanitizedHtml, render_document};

/// Largest file we will open (20 MiB). Guards against accidentally opening huge files.
pub const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;

/// A Markdown file that has been read and rendered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Document {
    /// Canonical absolute path; used to detect a file that is already open.
    pub path: PathBuf,
    /// File name shown in the tab.
    pub title: String,
    /// Rendered and sanitized HTML.
    pub html: SanitizedHtml,
    /// Local image files referenced by the document (not sent to the frontend).
    #[serde(skip)]
    pub local_images: Vec<PathBuf>,
}

/// Why a document could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum DocumentError {
    /// The path does not exist or is not readable.
    #[error("cannot open '{path}': {source}")]
    Io {
        /// The path that failed.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The path is a directory or another non-file.
    #[error("'{0}' is not a file")]
    NotAFile(PathBuf),
    /// The file is larger than [`MAX_DOCUMENT_BYTES`].
    #[error("'{path}' is too large ({size} bytes, max {MAX_DOCUMENT_BYTES})")]
    TooLarge {
        /// The path that failed.
        path: PathBuf,
        /// Size of the file in bytes.
        size: u64,
    },
    /// The file is not valid UTF-8 text.
    #[error("'{0}' is not a UTF-8 text file")]
    NotUtf8(PathBuf),
}

/// Reads and renders the Markdown file at `path`.
///
/// # Errors
///
/// Returns a [`DocumentError`] if the file is missing, not a regular file,
/// larger than [`MAX_DOCUMENT_BYTES`], or not valid UTF-8.
pub fn load_document(path: &Path) -> Result<Document, DocumentError> {
    let source = read_markdown(path)?;
    let base_dir = source.path.parent().unwrap_or(Path::new(""));
    let rendered = render_document(&source.text, base_dir);

    Ok(Document {
        title: file_title(&source.path),
        html: rendered.html,
        local_images: rendered.local_images,
        path: source.path,
    })
}

/// A Markdown file read from disk, before rendering.
#[derive(Debug, Clone)]
pub(crate) struct MarkdownSource {
    /// Canonical absolute path, without the Windows verbatim (`\\?\`) prefix.
    pub path: PathBuf,
    /// The text, without a UTF-8 byte order mark.
    pub text: String,
    /// Last modification time, if the OS reports one.
    pub modified: Option<std::time::SystemTime>,
}

/// Reads a Markdown file with the same checks for every caller: it must be a
/// regular file, at most [`MAX_DOCUMENT_BYTES`], and UTF-8.
pub(crate) fn read_markdown(path: &Path) -> Result<MarkdownSource, DocumentError> {
    let io_err = |source| DocumentError::Io {
        path: path.to_path_buf(),
        source,
    };

    let path = fs::canonicalize(path).map_err(io_err)?;
    let metadata = fs::metadata(&path).map_err(io_err)?;
    if !metadata.is_file() {
        return Err(DocumentError::NotAFile(path));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(DocumentError::TooLarge {
            size: metadata.len(),
            path,
        });
    }

    let bytes = fs::read(&path).map_err(io_err)?;
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let text = std::str::from_utf8(bytes)
        .map_err(|_| DocumentError::NotUtf8(path.clone()))?
        .to_owned();

    Ok(MarkdownSource {
        path: strip_verbatim_prefix(path),
        text,
        modified: metadata.modified().ok(),
    })
}

fn file_title(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// On Windows `canonicalize` returns `\\?\C:\...`; show users the familiar `C:\...` form.
pub(crate) fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join("atc-markdown-core-tests");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn loads_and_renders_file() {
        let path = temp_file("loads.md", b"# Title");
        let doc = load_document(&path).unwrap();
        assert_eq!(doc.title, "loads.md");
        assert!(doc.html.as_str().starts_with(r#"<h1 id="title">Title"#));
        assert!(doc.path.is_absolute());
    }

    #[test]
    fn strips_utf8_bom() {
        let path = temp_file("bom.md", b"\xEF\xBB\xBF# Bom");
        let doc = load_document(&path).unwrap();
        assert!(
            doc.html.as_str().starts_with(r#"<h1 id="bom">Bom"#),
            "{}",
            doc.html.as_str()
        );
    }

    #[test]
    fn rejects_non_utf8() {
        let path = temp_file("binary.md", &[0xFF, 0xFE, 0x00, 0x80]);
        assert!(matches!(
            load_document(&path),
            Err(DocumentError::NotUtf8(_))
        ));
    }

    #[test]
    fn rejects_directory() {
        let dir = std::env::temp_dir();
        assert!(matches!(
            load_document(&dir),
            Err(DocumentError::NotAFile(_))
        ));
    }

    #[test]
    fn rejects_missing_file() {
        let path = std::env::temp_dir().join("does-not-exist-atc-markdown.md");
        assert!(matches!(
            load_document(&path),
            Err(DocumentError::Io { .. })
        ));
    }

    #[test]
    fn strips_windows_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\C:\x\a.md")),
            PathBuf::from(r"C:\x\a.md")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\a.md")),
            PathBuf::from(r"\\?\UNC\server\share\a.md")
        );
    }
}
