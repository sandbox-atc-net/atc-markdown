//! Snapshot tests of the fixture wiki in `tests/wiki/demo.wiki`: the rendered
//! pages, sidebar and footer, with page links, a missing page, a subfolder page
//! and images. Review changes with `cargo insta review`.

#![allow(
    clippy::expect_used,
    reason = "helpers of a test: a broken fixture should fail loudly"
)]

use std::fmt::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use atc_markdown_core::{RenderOptions, Wiki};

fn demo_wiki() -> Arc<Wiki> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/wiki/demo.wiki");
    Arc::new(Wiki::open(&root).expect("fixture wiki"))
}

/// The page's HTML and missing links, with the wiki folder's path replaced by
/// `<wiki>` so the snapshot is the same on every machine.
fn render(wiki: &Arc<Wiki>, path: &Path) -> String {
    let doc = wiki
        .render(path, &RenderOptions::default())
        .expect("page renders");
    let html = portable_asset_urls(doc.html.as_str(), wiki.root());
    format!(
        "title: {}\nmissing links: {:?}\nlocal images: {}\n---\n{html}",
        doc.title,
        doc.missing_links,
        doc.local_images.len()
    )
}

/// Local image URLs hold the percent-encoded absolute path, with an OS-specific
/// scheme. They become `asset:<wiki>/images/x.svg`.
fn portable_asset_urls(html: &str, root: &Path) -> String {
    let root = root.to_string_lossy().replace('\\', "/");
    let mut out = String::new();
    let mut rest = html;
    loop {
        let next = ["http://asset.localhost/", "asset://localhost/"]
            .iter()
            .filter_map(|scheme| rest.find(scheme).map(|at| (at, scheme.len())))
            .min();
        let Some((at, scheme_len)) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..at]);
        let url = &rest[at + scheme_len..];
        let end = url.find('"').unwrap_or(url.len());
        let path = percent_decode(&url[..end]).replace('\\', "/");
        let relative = path.strip_prefix(&root).unwrap_or(&path);
        let _ = write!(out, "asset:<wiki>{relative}");
        rest = &url[end..];
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn page(wiki: &Arc<Wiki>, name: &str) -> PathBuf {
    wiki.find_page(name).expect("page exists").path.clone()
}

#[test]
fn wiki_pages_sidebar_and_footer() {
    let wiki = demo_wiki();
    let info = wiki.info();
    let pages: Vec<_> = wiki.pages().iter().map(|p| p.title.as_str()).collect();
    insta::assert_snapshot!("pages", format!("name: {}\npages: {pages:?}", info.name));
    insta::assert_snapshot!("home", render(&wiki, &page(&wiki, "Home")));
    insta::assert_snapshot!(
        "getting_started",
        render(&wiki, &page(&wiki, "Getting-Started"))
    );
    insta::assert_snapshot!("subfolder_page", render(&wiki, &page(&wiki, "Deep-Guide")));
    insta::assert_snapshot!("sidebar", render(&wiki, wiki.sidebar().expect("sidebar")));
    insta::assert_snapshot!("footer", render(&wiki, wiki.footer().expect("footer")));
}
