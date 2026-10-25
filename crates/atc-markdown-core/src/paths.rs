//! Small path and URL helpers shared by rendering and link handling.

use std::path::{Component, Path, PathBuf};

/// Returns `true` if `href` starts with a URL scheme such as `https:` or `mailto:`.
///
/// A single letter followed by `:` (e.g. `C:`) is treated as a Windows drive, not a scheme.
pub fn has_scheme(href: &str) -> bool {
    let Some((scheme, _)) = href.split_once(':') else {
        return false;
    };
    scheme.len() > 1
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Resolves a relative link or image path against `base_dir`.
///
/// Strips `?query` and `#fragment`, decodes `%20`-style escapes and removes
/// `.`/`..` segments. Returns `None` for URLs with a scheme, protocol-relative
/// URLs (`//host`) and pure anchors (`#x`).
pub fn resolve_relative(base_dir: &Path, href: &str) -> Option<PathBuf> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') || href.starts_with("//") || has_scheme(href) {
        return None;
    }
    let without_fragment = href.split(['#', '?']).next().unwrap_or_default();
    if without_fragment.is_empty() {
        return None;
    }
    let decoded = percent_decode(without_fragment);
    let path = Path::new(&decoded);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    };
    Some(normalize(&joined))
}

/// Removes `.` and `..` segments without touching the file system.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Decodes `%XX` escapes. Invalid escapes are kept as-is; invalid UTF-8 is replaced.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|b| hex_value(*b)),
                bytes.get(i + 2).and_then(|b| hex_value(*b)),
            )
        {
            out.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Encodes like JavaScript's `encodeURIComponent`.
pub fn percent_encode_component(input: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// URL under which the webview can load a local file through Tauri's asset protocol.
///
/// Matches `convertFileSrc` from `@tauri-apps/api`.
pub fn asset_url(path: &Path) -> String {
    let encoded = percent_encode_component(&path.to_string_lossy());
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_schemes() {
        assert!(has_scheme("https://example.com"));
        assert!(has_scheme("mailto:a@b.c"));
        assert!(has_scheme("javascript:alert(1)"));
        assert!(!has_scheme("C:/docs/a.md"));
        assert!(!has_scheme("docs/a.md"));
        assert!(!has_scheme("a.md#x:y"));
    }

    #[test]
    fn resolves_relative_paths() {
        let base = Path::new("/docs/guide");
        assert_eq!(
            resolve_relative(base, "./img/a.png"),
            Some(PathBuf::from("/docs/guide/img/a.png"))
        );
        assert_eq!(
            resolve_relative(base, "../other.md#intro"),
            Some(PathBuf::from("/docs/other.md"))
        );
        assert_eq!(
            resolve_relative(base, "my%20file.md?x=1"),
            Some(PathBuf::from("/docs/guide/my file.md"))
        );
    }

    #[test]
    fn does_not_resolve_urls_or_anchors() {
        let base = Path::new("/docs");
        assert_eq!(resolve_relative(base, "https://example.com/a.png"), None);
        assert_eq!(resolve_relative(base, "//cdn.example.com/a.png"), None);
        assert_eq!(resolve_relative(base, "#section"), None);
        assert_eq!(resolve_relative(base, ""), None);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%C3%A6%C3%B8%C3%A5"), "æøå");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(
            percent_encode_component(r"C:\My Docs\æ.png"),
            "C%3A%5CMy%20Docs%5C%C3%A6.png"
        );
        assert_eq!(percent_encode_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
    }

    #[test]
    fn builds_platform_asset_url() {
        let url = asset_url(Path::new("/x/a b.png"));
        if cfg!(windows) {
            assert_eq!(url, "http://asset.localhost/%2Fx%2Fa%20b.png");
        } else {
            assert_eq!(url, "asset://localhost/%2Fx%2Fa%20b.png");
        }
    }
}
