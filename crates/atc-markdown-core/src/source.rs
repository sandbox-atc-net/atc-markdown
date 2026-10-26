//! Reading and saving a Markdown file's text for editing.
//!
//! The editor works with `\n` line breaks and no byte order mark. To keep a
//! saved file byte-identical apart from the user's edits, reading records the
//! file's line ending and BOM, and saving puts them back.
//!
//! Saving is atomic (a temp file next to the target, then a rename) and checks
//! a fingerprint of the bytes, so a file changed by another program since it
//! was opened is never overwritten by accident.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::document::{DocumentError, MAX_DOCUMENT_BYTES, strip_verbatim_prefix};

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// The line break a file uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    /// `\n` (Unix, macOS, and most Git checkouts).
    #[default]
    Lf,
    /// `\r\n` (Windows).
    Crlf,
}

impl LineEnding {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
        }
    }
}

/// A file's text, ready for the editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    /// Canonical path.
    pub path: PathBuf,
    /// The text with `\n` line breaks and without a BOM.
    pub text: String,
    /// The line ending to write back (the one most lines use).
    pub line_ending: LineEnding,
    /// The file started with a UTF-8 byte order mark.
    pub bom: bool,
    /// Fingerprint of the bytes on disk, to notice changes by other programs.
    pub fingerprint: String,
}

/// Why a save failed.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum SaveError {
    /// The file changed on disk since it was opened (and `force` was not set).
    #[error("the file was changed by another program")]
    Changed(String),
    /// The file is read-only.
    #[error("the file is read-only")]
    ReadOnly(String),
    /// Any other problem writing the file.
    #[error("{0}")]
    Io(String),
}

/// The canonical form of a path (as documents use it), or the path itself if
/// it can't be resolved.
pub fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).map_or_else(|_| path.to_path_buf(), strip_verbatim_prefix)
}

/// A short fingerprint of file contents: length + 64-bit FNV-1a hash.
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{}-{hash:016x}", bytes.len())
}

/// Reads a Markdown file for editing.
///
/// # Errors
///
/// Fails if the file can't be read, is too large or is not UTF-8.
pub fn read_source(path: &Path) -> Result<SourceFile, DocumentError> {
    let io_err = |source| DocumentError::Io {
        path: path.to_path_buf(),
        source,
    };
    let canonical = strip_verbatim_prefix(fs::canonicalize(path).map_err(io_err)?);
    let bytes = fs::read(&canonical).map_err(io_err)?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(DocumentError::TooLarge {
            size: bytes.len() as u64,
            path: canonical,
        });
    }
    let fingerprint = fingerprint(&bytes);
    let (bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes.as_slice()),
    };
    let raw = std::str::from_utf8(body).map_err(|_| DocumentError::NotUtf8(canonical.clone()))?;
    Ok(SourceFile {
        path: canonical,
        line_ending: detect_line_ending(raw),
        text: normalize_line_breaks(raw),
        bom,
        fingerprint,
    })
}

/// The line ending most lines use (ties and files without line breaks: LF).
pub fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

/// Turns `\r\n` and lone `\r` into `\n`, as the editor does.
pub fn normalize_line_breaks(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// The bytes to write for editor text with a given line ending and BOM.
pub fn encode(text: &str, line_ending: LineEnding, bom: bool) -> Vec<u8> {
    let text = normalize_line_breaks(text);
    let text = match line_ending {
        LineEnding::Lf => text,
        LineEnding::Crlf => text.replace('\n', line_ending.as_str()),
    };
    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

/// What to write and what to check before writing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    /// Editor text (`\n` line breaks).
    pub text: String,
    /// Line ending to write.
    pub line_ending: LineEnding,
    /// Write a UTF-8 byte order mark first.
    pub bom: bool,
    /// Fingerprint from when the file was read or last saved; `None` for a new file.
    pub expected: Option<String>,
    /// Overwrite even if the file changed on disk.
    #[serde(default)]
    pub force: bool,
}

/// Saves editor text to `path` atomically. Returns the new fingerprint.
///
/// # Errors
///
/// [`SaveError::Changed`] if the file on disk no longer matches `expected`
/// (unless `force`), [`SaveError::ReadOnly`] for read-only files, and
/// [`SaveError::Io`] for anything else.
pub fn save_source(path: &Path, request: &SaveRequest) -> Result<String, SaveError> {
    let io = |error: io::Error| SaveError::Io(error.to_string());

    if let Ok(metadata) = fs::metadata(path) {
        if metadata.permissions().readonly() {
            return Err(SaveError::ReadOnly(path.display().to_string()));
        }
        if let (Some(expected), false) = (&request.expected, request.force) {
            let current = fs::read(path).map_err(io)?;
            if &fingerprint(&current) != expected {
                return Err(SaveError::Changed(path.display().to_string()));
            }
        }
    }

    let bytes = encode(&request.text, request.line_ending, request.bom);
    let temp = temp_path(path);
    fs::write(&temp, &bytes).map_err(io)?;
    if let Err(error) = rename_with_retry(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(match error.kind() {
            io::ErrorKind::PermissionDenied => SaveError::Io(format!(
                "could not replace the file (it may be open in another program): {error}"
            )),
            _ => io(error),
        });
    }
    Ok(fingerprint(&bytes))
}

/// `.name.md.atc-save` next to the file: hidden, and not a Markdown extension,
/// so the file watcher ignores it.
fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.atc-save"))
}

/// On Windows, a virus scanner or sync client can hold the file for a moment.
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied && attempt < 5 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(40 * attempt));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("atc-markdown-source-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(source: &SourceFile) -> SaveRequest {
        SaveRequest {
            text: source.text.clone(),
            line_ending: source.line_ending,
            bom: source.bom,
            expected: Some(source.fingerprint.clone()),
            force: false,
        }
    }

    #[test]
    fn unedited_save_keeps_the_exact_bytes() {
        let dir = temp_dir("roundtrip");
        let cases: [(&str, &[u8]); 5] = [
            ("lf.md", b"# A\n\ntext\n"),
            ("crlf.md", b"# A\r\n\r\ntext\r\n"),
            ("bom-crlf.md", b"\xEF\xBB\xBF# A\r\ntext\r\n"),
            ("no-final-newline.md", b"# A\ntext"),
            ("empty.md", b""),
        ];
        for (name, bytes) in cases {
            let path = dir.join(name);
            fs::write(&path, bytes).unwrap();
            let source = read_source(&path).unwrap();
            assert!(!source.text.contains('\r'), "{name}");
            save_source(&path, &request(&source)).unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes, "{name}");
        }
    }

    #[test]
    fn edits_use_the_files_line_ending() {
        let dir = temp_dir("edit");
        let path = dir.join("a.md");
        fs::write(&path, b"one\r\ntwo\r\n").unwrap();
        let source = read_source(&path).unwrap();
        let mut req = request(&source);
        req.text = "one\nnew\ntwo\n".into();
        let fingerprint = save_source(&path, &req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one\r\nnew\r\ntwo\r\n");
        assert_eq!(fingerprint, super::fingerprint(b"one\r\nnew\r\ntwo\r\n"));
    }

    #[test]
    fn refuses_to_overwrite_a_file_changed_elsewhere() {
        let dir = temp_dir("conflict");
        let path = dir.join("a.md");
        fs::write(&path, b"mine").unwrap();
        let source = read_source(&path).unwrap();
        fs::write(&path, b"theirs").unwrap();
        let err = save_source(&path, &request(&source)).unwrap_err();
        assert!(matches!(err, SaveError::Changed(_)), "{err:?}");
        assert_eq!(fs::read(&path).unwrap(), b"theirs");
        // Unless forced.
        let mut req = request(&source);
        req.force = true;
        save_source(&path, &req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"mine");
    }

    #[test]
    fn refuses_read_only_files() {
        let dir = temp_dir("readonly");
        let path = dir.join("a.md");
        fs::write(&path, b"x").unwrap();
        let source = read_source(&path).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions.clone()).unwrap();
        let err = save_source(&path, &request(&source)).unwrap_err();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(matches!(err, SaveError::ReadOnly(_)), "{err:?}");
    }

    #[test]
    fn saves_new_files_and_leaves_no_temp_file() {
        let dir = temp_dir("new");
        let path = dir.join("new.md");
        let req = SaveRequest {
            text: "hi\n".into(),
            line_ending: LineEnding::Lf,
            bom: false,
            expected: None,
            force: false,
        };
        save_source(&path, &req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hi\n");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn detects_the_main_line_ending() {
        assert_eq!(detect_line_ending("a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(detect_line_ending("a\nb\nc\r\n"), LineEnding::Lf);
        assert_eq!(detect_line_ending("one line"), LineEnding::Lf);
    }
}
