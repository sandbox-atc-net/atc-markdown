//! Markdown → sanitized HTML.

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use serde::Serialize;

use crate::highlight::Highlighter;
use crate::paths::{asset_url, resolve_relative};

/// HTML that has been through the sanitizer and is safe to insert into the webview.
///
/// The only way to build one is through this module, so unsanitized HTML cannot
/// reach the UI by accident.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SanitizedHtml(String);

impl SanitizedHtml {
    /// The sanitized HTML as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The result of rendering a document that lives on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// Sanitized HTML.
    pub html: SanitizedHtml,
    /// Local image files the HTML refers to. The app must allow the webview to load these.
    pub local_images: Vec<PathBuf>,
    /// Links (as written) that point to pages that don't exist. Only filled in wiki mode.
    pub missing_links: Vec<String>,
}

/// What to do with a link's `href` while sanitizing (used by wiki mode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LinkRewrite {
    /// Leave the link as written.
    Keep,
    /// Replace the href, e.g. with a canonical page name.
    Replace(String),
    /// The link points to a page that doesn't exist.
    Missing,
}

/// Decides how links are rewritten while sanitizing.
pub(crate) trait LinkRewriter: Send + Sync {
    fn rewrite(&self, href: &str) -> LinkRewrite;
}

/// Renders GitHub Flavored Markdown to sanitized HTML, without resolving local images.
///
/// Raw HTML in the source is allowed through the parser and then cleaned by an
/// allow-list sanitizer: scripts, event handlers and `javascript:` URLs are removed.
pub fn render_markdown(source: &str) -> SanitizedHtml {
    render_with(source, None, None).html
}

/// Renders a document located in `base_dir`.
///
/// Relative image paths (`![](./img.png)`) are resolved against `base_dir` and
/// rewritten to asset-protocol URLs the webview can load. Links are left as written;
/// see [`crate::resolve_link`] for what happens when one is clicked.
pub fn render_document(source: &str, base_dir: &Path) -> Rendered {
    render_with(source, Some(base_dir), None)
}

/// Renders a wiki page: `[[Page]]` links are enabled and every link goes through `links`.
pub(crate) fn render_wiki_page(
    source: &str,
    base_dir: &Path,
    links: Arc<dyn LinkRewriter>,
) -> Rendered {
    render_with(source, Some(base_dir), Some(links))
}

fn render_with(
    source: &str,
    base_dir: Option<&Path>,
    links: Option<Arc<dyn LinkRewriter>>,
) -> Rendered {
    let mut plugins = comrak::options::Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&Highlighter);
    let options = if links.is_some() {
        &*WIKI_COMRAK_OPTIONS
    } else {
        &*COMRAK_OPTIONS
    };
    let html = comrak::markdown_to_html_with_plugins(source, options, &plugins);

    if base_dir.is_none() && links.is_none() {
        return Rendered {
            html: SanitizedHtml(SANITIZER.clean(&html).to_string()),
            local_images: Vec::new(),
            missing_links: Vec::new(),
        };
    }

    let found = Arc::new(Mutex::new(Found::default()));
    let html = filtering_sanitizer(base_dir.map(Path::to_path_buf), links, Arc::clone(&found))
        .clean(&html)
        .to_string();
    let found = std::mem::take(&mut *found.lock().unwrap_or_else(PoisonError::into_inner));
    Rendered {
        html: SanitizedHtml(html),
        local_images: found.images,
        missing_links: found.missing_links,
    }
}

/// What the sanitizer's attribute filter collected while cleaning.
#[derive(Debug, Default)]
struct Found {
    images: Vec<PathBuf>,
    missing_links: Vec<String>,
}

static COMRAK_OPTIONS: LazyLock<comrak::Options<'static>> = LazyLock::new(|| {
    let mut options = comrak::Options::default();
    let ext = &mut options.extension;
    ext.strikethrough = true;
    ext.table = true;
    ext.autolink = true;
    ext.tasklist = true;
    ext.footnotes = true;
    ext.header_id_prefix = Some(String::new());
    // Raw HTML is passed through here and cleaned by the sanitizer afterwards.
    options.render.r#unsafe = true;
    options
});

/// GitHub wiki pages also support `[[Page]]` and `[[Link text|Page]]`.
static WIKI_COMRAK_OPTIONS: LazyLock<comrak::Options<'static>> = LazyLock::new(|| {
    let mut options = COMRAK_OPTIONS.clone();
    options.extension.wikilinks_title_before_pipe = true;
    options
});

fn base_sanitizer() -> ammonia::Builder<'static> {
    let mut builder = ammonia::Builder::default();
    builder
        .add_generic_attributes(["id", "class"])
        .add_tags(["input", "section"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("th", ["align"])
        .add_tag_attributes("td", ["align"])
        .add_tag_attributes(
            "a",
            ["aria-label", "data-footnote-ref", "data-footnote-backref"],
        )
        .add_tag_attributes("section", ["data-footnotes"])
        .link_rel(Some("noopener noreferrer"));
    // Web links only; relative links stay as written. `asset` is the scheme of
    // rewritten local images on macOS/Linux.
    builder.url_schemes(HashSet::from(["http", "https", "mailto", "asset"]));
    builder
}

static SANITIZER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(base_sanitizer);

/// A sanitizer that also rewrites relative `<img src>` to asset URLs (recording
/// them), and passes link hrefs through `links` when given.
fn filtering_sanitizer(
    base_dir: Option<PathBuf>,
    links: Option<Arc<dyn LinkRewriter>>,
    found: Arc<Mutex<Found>>,
) -> ammonia::Builder<'static> {
    let mut builder = base_sanitizer();
    builder.attribute_filter(move |element, attribute, value| {
        let record =
            |f: &dyn Fn(&mut Found)| f(&mut found.lock().unwrap_or_else(PoisonError::into_inner));
        match (element, attribute) {
            ("img", "src") => {
                let image = base_dir
                    .as_deref()
                    .and_then(|dir| resolve_relative(dir, value))
                    .filter(|p| is_image_file(p));
                match image {
                    Some(path) => {
                        let url = asset_url(&path);
                        record(&|found| found.images.push(path.clone()));
                        Some(Cow::Owned(url))
                    }
                    None => Some(Cow::Borrowed(value)),
                }
            }
            ("a", "href") => match links.as_deref().map(|links| links.rewrite(value)) {
                Some(LinkRewrite::Replace(href)) => Some(Cow::Owned(href)),
                Some(LinkRewrite::Missing) => {
                    record(&|found| found.missing_links.push(value.to_owned()));
                    Some(Cow::Borrowed(value))
                }
                Some(LinkRewrite::Keep) | None => Some(Cow::Borrowed(value)),
            },
            _ => Some(Cow::Borrowed(value)),
        }
    });
    builder
}

/// Only these file types may be loaded from disk by a document.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
];

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.iter().any(|i| i.eq_ignore_ascii_case(ext)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::highlight_css;

    #[test]
    fn renders_heading_with_anchor_id() {
        let html = render_markdown("# Hello World");
        assert!(
            html.as_str().contains(r#"id="hello-world""#),
            "{}",
            html.as_str()
        );
        assert!(
            html.as_str().contains(r##"href="#hello-world""##),
            "{}",
            html.as_str()
        );
    }

    #[test]
    fn removes_script_tags() {
        let html = render_markdown("Hi <script>alert(1)</script>");
        assert!(!html.as_str().contains("<script"));
        assert!(!html.as_str().contains("alert(1)"));
    }

    #[test]
    fn removes_event_handlers() {
        let html = render_markdown(r#"<img src="x.png" onerror="alert(1)">"#);
        assert!(!html.as_str().contains("onerror"));
    }

    #[test]
    fn removes_javascript_links() {
        let html = render_markdown("[click](javascript:alert(1))");
        assert!(!html.as_str().contains("javascript:"));
    }

    #[test]
    fn keeps_task_list_checkboxes() {
        let html = render_markdown("- [x] done\n- [ ] todo");
        assert!(html.as_str().contains(r#"type="checkbox""#));
        assert!(html.as_str().contains("checked"));
    }

    #[test]
    fn keeps_relative_links() {
        let html = render_markdown("[other](./other.md)");
        assert!(html.as_str().contains(r#"href="./other.md""#));
    }

    #[test]
    fn highlights_fenced_code_with_classes() {
        let html = render_markdown("```rust\nfn main() {}\n```");
        assert!(html.as_str().contains(r#"class="hl-"#), "{}", html.as_str());
        assert!(!html.as_str().contains("style="), "{}", html.as_str());
    }

    #[test]
    fn highlight_css_has_light_and_dark_rules() {
        let css = highlight_css();
        assert!(css.contains(".hl-"));
        assert!(css.contains("@media (prefers-color-scheme: dark)"));
        // The light theme must not apply in dark mode.
        assert!(css.starts_with("@media not (prefers-color-scheme: dark)"));
    }

    #[test]
    fn rewrites_relative_images_to_asset_urls() {
        let base = std::env::temp_dir();
        let rendered = render_document("![logo](./img/logo.png)", &base);
        assert_eq!(
            rendered.local_images,
            vec![base.join("img").join("logo.png")]
        );
        assert!(
            rendered.html.as_str().contains("asset.localhost")
                || rendered.html.as_str().contains("asset://localhost")
        );
    }

    #[test]
    fn leaves_remote_images_alone() {
        let rendered = render_document("![badge](https://example.com/b.svg)", Path::new("/x"));
        assert_eq!(rendered.local_images, Vec::<PathBuf>::new());
        assert!(
            rendered
                .html
                .as_str()
                .contains(r#"src="https://example.com/b.svg""#)
        );
    }

    #[test]
    fn does_not_expose_non_image_files() {
        let rendered = render_document(r#"<img src="../../secrets.txt">"#, Path::new("/x/y"));
        assert_eq!(rendered.local_images, Vec::<PathBuf>::new());
        assert!(!rendered.html.as_str().contains("asset"));
    }

    #[test]
    fn does_not_rewrite_links_to_asset_urls() {
        let rendered = render_document("[doc](./other.md)", Path::new("/x"));
        assert!(rendered.html.as_str().contains(r#"href="./other.md""#));
    }
}
