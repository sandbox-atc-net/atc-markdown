//! GitHub wiki folders: a local clone of `<repo>.wiki` browsed like github.com/…/wiki.
//!
//! GitHub wiki rules implemented here:
//! - every `*.md` file is a page; its name is the file name without extension,
//!   and its title is that name with dashes shown as spaces;
//! - `_Sidebar.md` and `_Footer.md` are shown around every page;
//! - links name pages, not files: `[[Page Name]]`, `[[Text|Page-Name]]`,
//!   `[text](Page-Name)` and `https://github.com/<owner>/<repo>/wiki/Page-Name`
//!   all point to `Page-Name.md`, matched case-insensitively with spaces as dashes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::document::{DocumentError, read_markdown, strip_verbatim_prefix};
use crate::links::{LinkTarget, is_markdown_file};
use crate::paths::{has_scheme, percent_decode, percent_encode_component};
use crate::render::{
    LinkRewrite, LinkRewriter, RenderOptions, Rendered, SanitizedHtml, render_wiki_page,
};

const SIDEBAR: &str = "_sidebar";
const FOOTER: &str = "_footer";
const HOME: &str = "home";
/// Pages in subfolders count too (GitHub flattens them), but only this deep.
const MAX_DEPTH: usize = 4;

/// A page of the wiki.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    /// File name without extension, e.g. `Working-with-Enums`.
    pub name: String,
    /// Name as GitHub shows it, e.g. `Working with Enums`.
    pub title: String,
    /// Absolute path to the file.
    pub path: PathBuf,
}

/// The GitHub repository a wiki belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRepo {
    /// Owner (user or organization).
    pub owner: String,
    /// Repository name, without `.wiki`.
    pub repo: String,
}

/// A wiki folder and its pages.
#[derive(Debug, Clone)]
pub struct Wiki {
    root: PathBuf,
    name: String,
    pages: Vec<WikiPage>,
    /// Page key → index into `pages`.
    by_key: HashMap<String, usize>,
    sidebar: Option<PathBuf>,
    footer: Option<PathBuf>,
    repo: Option<GitHubRepo>,
}

/// What the frontend needs to show a wiki.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiInfo {
    /// The wiki folder.
    pub root: PathBuf,
    /// Display name, e.g. `atc-rest-api-source-generator`.
    pub name: String,
    /// The page to show first (`Home`).
    pub home: PathBuf,
    /// All pages, sorted by title.
    pub pages: Vec<WikiPage>,
    /// `https://github.com/<owner>/<repo>/wiki`, when known.
    pub url: Option<String>,
    /// `_Sidebar.md`, if present.
    pub sidebar: Option<PathBuf>,
    /// `_Footer.md`, if present.
    pub footer: Option<PathBuf>,
}

/// A rendered wiki page (or sidebar/footer).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDocument {
    /// Absolute path to the file.
    pub path: PathBuf,
    /// Page name, e.g. `Working-with-Enums`.
    pub name: String,
    /// Page title, e.g. `Working with Enums`.
    pub title: String,
    /// Rendered and sanitized HTML. Internal links use the page name as href.
    pub html: SanitizedHtml,
    /// Links (as they appear in `html`) to pages that don't exist.
    pub missing_links: Vec<String>,
    /// Last modified, in milliseconds since the Unix epoch.
    pub modified_ms: Option<u64>,
    /// Local image files the page uses (not sent to the frontend).
    #[serde(skip)]
    pub local_images: Vec<PathBuf>,
}

/// A page that matched a full-text search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The page.
    pub page: WikiPage,
    /// How often the text occurs in the page.
    pub matches: usize,
    /// Text around the first match, if the text (not just the title) matched.
    pub snippet: Option<Snippet>,
}

/// Text around a match, split so the match can be shown in bold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snippet {
    /// Text before the match.
    pub before: String,
    /// The matched text, as written in the page.
    pub hit: String,
    /// Text after the match.
    pub after: String,
}

/// Some text either side of a match (more after than before, so the match
/// stays visible in a two-line preview), on one line, without Markdown noise.
/// The lowercase terms of a search: words, and `"quoted phrases"` as one term.
/// One-letter words are dropped (they match nearly every page).
fn search_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for (i, part) in query.split('"').enumerate() {
        let part = part.trim().to_lowercase();
        if i % 2 == 1 {
            terms.push(part); // inside quotes
        } else {
            terms.extend(part.split_whitespace().map(str::to_owned));
        }
    }
    terms.retain(|t| t.chars().count() >= 2);
    terms.sort();
    terms.dedup();
    terms
}

fn snippet(text: &str, lower: &str, at: usize, len: usize) -> Option<Snippet> {
    // `to_lowercase` can change byte lengths; only use offsets that line up.
    if lower.len() != text.len() || !text.is_char_boundary(at) || !text.is_char_boundary(at + len) {
        return None;
    }
    let start = text[..at]
        .char_indices()
        .rev()
        .nth(30)
        .map_or(0, |(i, _)| i);
    let end = text[at + len..]
        .char_indices()
        .nth(80)
        .map_or(text.len(), |(i, _)| at + len + i);
    let before = clean_snippet(&text[start..at]);
    let after = clean_snippet(&text[at + len..end]);
    Some(Snippet {
        before: if start > 0 {
            format!("…{}", before.trim_start())
        } else {
            before
        },
        hit: text[at..at + len].to_owned(),
        after: if end < text.len() {
            format!("{}…", after.trim_end())
        } else {
            after
        },
    })
}

/// Text on one line without Markdown markup: heading `#`s, emphasis, code
/// ticks, table pipes and quote marks. A `#` inside a word (C#, F#) stays.
fn clean_snippet(text: &str) -> String {
    text.split_whitespace()
        .filter(|word| !word.chars().all(|c| c == '#' || c == '>' || c == '|'))
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['*', '`', '|'], "")
}

/// What a link in a wiki page points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WikiHref<'a> {
    /// An existing page, with an optional `#fragment`.
    Page {
        /// The page.
        page: &'a WikiPage,
        /// Fragment without `#`.
        fragment: Option<String>,
    },
    /// Looks like a page link, but there is no such page.
    Missing {
        /// The page name that was looked for.
        name: String,
    },
    /// Not a page link (web link, image, other file, anchor…).
    Other,
}

/// Returns the wiki folder for `path`: the folder itself, or the folder of a file in it.
pub fn find_wiki_root(path: &Path) -> Option<PathBuf> {
    let dir = if path.is_dir() { path } else { path.parent()? };
    is_wiki_dir(dir).then(|| dir.to_path_buf())
}

/// A folder is treated as a wiki when it is named `*.wiki`, its git remote is a
/// `.wiki` repository, or it has both `Home.md` and `_Sidebar.md`.
pub fn is_wiki_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let named_wiki = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_ascii_lowercase().ends_with(".wiki"));
    let has = |name: &str| dir.join(name).is_file();
    named_wiki
        || git_origin(dir).is_some_and(|url| {
            strip_suffix_ignore_case_opt(strip_suffix_ignore_case(&url, ".git"), ".wiki").is_some()
        })
        || (has("Home.md") && has("_Sidebar.md"))
}

impl Wiki {
    /// Indexes the wiki in `root`.
    ///
    /// # Errors
    ///
    /// Fails if `root` can't be read or contains no Markdown files.
    pub fn open(root: &Path) -> Result<Self, DocumentError> {
        let io_err = |source| DocumentError::Io {
            path: root.to_path_buf(),
            source,
        };
        let root = strip_verbatim_prefix(fs::canonicalize(root).map_err(io_err)?);

        let mut files = Vec::new();
        collect_markdown(&root, 0, &mut files);
        files.sort();

        let mut pages = Vec::new();
        let (mut sidebar, mut footer) = (None, None);
        for path in files {
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            match page_key(name).as_str() {
                SIDEBAR => sidebar = sidebar.or(Some(path)),
                FOOTER => footer = footer.or(Some(path)),
                _ => pages.push(WikiPage {
                    title: name.replace('-', " "),
                    name: name.to_owned(),
                    path,
                }),
            }
        }
        if pages.is_empty() && sidebar.is_none() {
            return Err(DocumentError::NotAFile(root));
        }
        pages.sort_by_key(|page| page.title.to_lowercase());

        let mut by_key = HashMap::new();
        for (index, page) in pages.iter().enumerate() {
            // The first file wins if two only differ by case or spaces/dashes.
            by_key.entry(page_key(&page.name)).or_insert(index);
        }

        let repo = git_origin(&root).as_deref().and_then(parse_github_remote);
        let name = repo.as_ref().map_or_else(
            || {
                let folder = root.file_name().map(|n| n.to_string_lossy().into_owned());
                let folder = folder.unwrap_or_else(|| "Wiki".to_owned());
                strip_suffix_ignore_case(&folder, ".wiki").to_owned()
            },
            |repo| repo.repo.clone(),
        );

        Ok(Self {
            root,
            name,
            pages,
            by_key,
            sidebar,
            footer,
            repo,
        })
    }

    /// The wiki folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// All pages, sorted by title.
    pub fn pages(&self) -> &[WikiPage] {
        &self.pages
    }

    /// `_Sidebar.md`, if present.
    pub fn sidebar(&self) -> Option<&Path> {
        self.sidebar.as_deref()
    }

    /// `_Footer.md`, if present.
    pub fn footer(&self) -> Option<&Path> {
        self.footer.as_deref()
    }

    /// The `Home` page, or the first page if there is none.
    pub fn home(&self) -> Option<&WikiPage> {
        self.find_page(HOME).or_else(|| self.pages.first())
    }

    /// Finds a page by name, the way GitHub does: case-insensitive, spaces = dashes.
    pub fn find_page(&self, name: &str) -> Option<&WikiPage> {
        self.by_key.get(&page_key(name)).map(|&i| &self.pages[i])
    }

    /// The page stored in `path`, if it is one of this wiki's pages.
    pub fn page_at(&self, path: &Path) -> Option<&WikiPage> {
        self.pages.iter().find(|page| same_path(&page.path, path))
    }

    /// Summary for the frontend.
    pub fn info(&self) -> WikiInfo {
        WikiInfo {
            root: self.root.clone(),
            name: self.name.clone(),
            home: self
                .home()
                .map_or_else(|| self.root.clone(), |page| page.path.clone()),
            pages: self.pages.clone(),
            url: self
                .repo
                .as_ref()
                .map(|r| format!("https://github.com/{}/{}/wiki", r.owner, r.repo)),
            sidebar: self.sidebar.clone(),
            footer: self.footer.clone(),
        }
    }

    /// Works out whether `href` (as written in a page) points to a wiki page.
    pub fn classify_href(&self, href: &str) -> WikiHref<'_> {
        let href = href.trim();
        if href.is_empty() || href.starts_with('#') || href.starts_with('/') {
            return WikiHref::Other;
        }
        let (target, fragment) = match href.split_once('#') {
            Some((target, fragment)) => (target, Some(percent_decode(fragment))),
            None => (href, None),
        };
        let fragment = fragment.filter(|f| !f.is_empty());

        let name = if has_scheme(target) {
            match self.github_page_name(target) {
                Some(name) => name,
                None => return WikiHref::Other,
            }
        } else {
            let target = target.split('?').next().unwrap_or_default();
            // GitHub flattens folders: a page is found by its name alone.
            let last = target.rsplit(['/', '\\']).next().unwrap_or_default();
            let last = percent_decode(last);
            let has_other_extension = Path::new(&last)
                .extension()
                .is_some_and(|_| !is_markdown_file(Path::new(&last)));
            if let Some(page) = self.find_page(&last) {
                return WikiHref::Page { page, fragment };
            }
            if last.is_empty() || has_other_extension || last == "." || last == ".." {
                return WikiHref::Other;
            }
            last
        };

        match self.find_page(&name) {
            Some(page) => WikiHref::Page { page, fragment },
            None => WikiHref::Missing { name },
        }
    }

    /// The link target for `href` in a wiki page. Page links resolve inside the
    /// wiki; anything else falls back to [`crate::resolve_link`].
    pub fn resolve_link(&self, document_path: &Path, href: &str) -> LinkTarget {
        match self.classify_href(href) {
            WikiHref::Page { page, fragment } => LinkTarget::Document {
                path: page.path.clone(),
                fragment,
            },
            WikiHref::Missing { name } => LinkTarget::Document {
                path: self.root.join(format!("{}.md", name.replace(' ', "-"))),
                fragment: None,
            },
            WikiHref::Other => crate::resolve_link(document_path, href),
        }
    }

    /// Renders unsaved editor text of the page at `path` (for the live preview).
    pub fn render_text(
        self: &Arc<Self>,
        path: &Path,
        text: &str,
        options: &RenderOptions,
    ) -> Rendered {
        let base_dir = path.parent().unwrap_or(&self.root).to_path_buf();
        render_wiki_page(
            text,
            &base_dir,
            Arc::clone(self) as Arc<dyn LinkRewriter>,
            options,
        )
    }

    /// Reads and renders a page, `_Sidebar.md` or `_Footer.md` of this wiki.
    ///
    /// # Errors
    ///
    /// Fails like [`crate::load_document`] if the file can't be read.
    pub fn render(
        self: &Arc<Self>,
        path: &Path,
        options: &RenderOptions,
    ) -> Result<WikiDocument, DocumentError> {
        let source = read_markdown(path)?;
        let base_dir = source.path.parent().unwrap_or(&self.root).to_path_buf();
        let rendered = render_wiki_page(
            &source.text,
            &base_dir,
            Arc::clone(self) as Arc<dyn LinkRewriter>,
            options,
        );

        let name = source
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let modified_ms = source
            .modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| u64::try_from(d.as_millis()).ok());

        let mut missing_links = rendered.missing_links;
        missing_links.sort();
        missing_links.dedup();

        Ok(WikiDocument {
            title: name.replace('-', " "),
            name,
            path: source.path,
            html: rendered.html,
            missing_links,
            modified_ms,
            local_images: rendered.local_images,
        })
    }

    /// Searches the text of every page, case-insensitively. Every word of the
    /// query must occur (in any order; `"quoted words"` as a phrase), in the
    /// text or the title. Pages whose title has them all come first, then by
    /// number of matches. At most `limit` results.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let terms = search_terms(query);
        if terms.is_empty() {
            return Vec::new();
        }
        // The snippet shows the most specific (longest) term found in the text.
        let mut by_length = terms.clone();
        by_length.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
        let mut hits: Vec<(bool, usize, SearchHit)> = self
            .pages
            .iter()
            .filter_map(|page| {
                let text = fs::read_to_string(&page.path).ok()?;
                let lower = text.to_lowercase();
                let title = page.title.to_lowercase();
                let mut count = 0;
                for term in &terms {
                    let n = lower.matches(term.as_str()).count();
                    if n == 0 && !title.contains(term.as_str()) {
                        return None;
                    }
                    count += n;
                }
                let in_title = terms.iter().all(|t| title.contains(t.as_str()));
                let snippet = by_length.iter().find_map(|term| {
                    let at = lower.find(term.as_str())?;
                    snippet(&text, &lower, at, term.len())
                });
                Some((
                    in_title,
                    count,
                    SearchHit {
                        page: page.clone(),
                        matches: count,
                        snippet,
                    },
                ))
            })
            .collect();
        hits.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.cmp(&a.1))
                .then(a.2.page.title.cmp(&b.2.page.title))
        });
        hits.into_iter()
            .take(limit)
            .map(|(_, _, hit)| hit)
            .collect()
    }

    /// For `https://github.com/<owner>/<repo>/wiki[/Page]`, the page name (`Home` for the bare URL).
    fn github_page_name(&self, url: &str) -> Option<String> {
        let repo = self.repo.as_ref()?;
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))?;
        let rest = rest.strip_prefix("www.").unwrap_or(rest);
        let rest = strip_prefix_ignore_case(rest, "github.com/")?;
        let rest = strip_prefix_ignore_case(rest, &format!("{}/{}/wiki", repo.owner, repo.repo))?;
        let rest = rest.split('?').next().unwrap_or_default();
        match rest.trim_matches('/') {
            "" if rest.is_empty() || rest == "/" => Some("Home".to_owned()),
            page if rest.starts_with('/') && !page.contains('/') => Some(percent_decode(page)),
            _ => None,
        }
    }
}

impl LinkRewriter for Wiki {
    /// Page links get the canonical page name as href, so the frontend can match
    /// them against the current page; missing pages are reported.
    fn rewrite(&self, href: &str) -> LinkRewrite {
        match self.classify_href(href) {
            WikiHref::Page { page, fragment } => {
                let mut href = percent_encode_component(&page.name);
                if let Some(fragment) = fragment {
                    href.push('#');
                    href.push_str(&percent_encode_component(&fragment));
                }
                LinkRewrite::Replace(href)
            }
            WikiHref::Missing { .. } => LinkRewrite::Missing,
            WikiHref::Other => LinkRewrite::Keep,
        }
    }
}

/// The lookup key for a page name: decoded, without `.md`, spaces as dashes, lowercase.
fn page_key(name: &str) -> String {
    let name = percent_decode(name.trim());
    let name = ["md", "markdown", "mdown", "mkd"]
        .iter()
        .find_map(|ext| strip_suffix_ignore_case_opt(&name, &format!(".{ext}")))
        .unwrap_or(&name);
    name.trim().replace(' ', "-").to_lowercase()
}

fn collect_markdown(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && !hidden && depth < MAX_DEPTH {
            collect_markdown(&path, depth + 1, out);
        } else if kind.is_file() && is_markdown_file(&path) {
            out.push(path);
        }
    }
}

/// The `origin` URL from the folder's git config, if any. `.git` may be a folder
/// or a file pointing elsewhere (`gitdir: …`, used by worktrees and submodules).
fn git_origin(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = fs::read_to_string(&dot_git).ok()?;
        let target = text.trim().strip_prefix("gitdir:")?.trim();
        dir.join(target)
    };
    let config = fs::read_to_string(git_dir.join("config")).ok()?;
    let mut in_origin = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line
                .replace(' ', "")
                .eq_ignore_ascii_case("[remote\"origin\"]");
        } else if in_origin
            && let Some(url) = line.strip_prefix("url")
            && let Some(url) = url.trim_start().strip_prefix('=')
        {
            return Some(url.trim().to_owned());
        }
    }
    None
}

/// Parses `https://github.com/o/r.wiki(.git)`, `git@github.com:o/r.wiki.git` or
/// `ssh://git@github.com/o/r.wiki.git`.
fn parse_github_remote(url: &str) -> Option<GitHubRepo> {
    let url = url.trim();
    let path = [
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
        "git@github.com:",
    ]
    .iter()
    .find_map(|prefix| strip_prefix_ignore_case(url, prefix))?;
    let path = path.trim_end_matches('/');
    let path = strip_suffix_ignore_case(path, ".git");
    let path = strip_suffix_ignore_case(path, ".wiki");
    let (owner, repo) = path.split_once('/')?;
    (!owner.is_empty() && !repo.is_empty() && !repo.contains('/')).then(|| GitHubRepo {
        owner: owner.to_owned(),
        repo: repo.to_owned(),
    })
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn strip_suffix_ignore_case_opt<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let split = text.len().checked_sub(suffix.len())?;
    let tail = text.get(split..)?;
    tail.eq_ignore_ascii_case(suffix).then(|| &text[..split])
}

fn strip_suffix_ignore_case<'a>(text: &'a str, suffix: &str) -> &'a str {
    strip_suffix_ignore_case_opt(text, suffix).unwrap_or(text)
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small wiki in a temp folder, named `*.wiki` with a GitHub origin.
    fn fixture(name: &str) -> Arc<Wiki> {
        let root = std::env::temp_dir()
            .join("atc-markdown-wiki-tests")
            .join(format!("{name}.wiki"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("images")).unwrap();
        fs::create_dir_all(root.join("guides")).unwrap();
        fs::write(
            root.join(".git/config"),
            "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/atc-net/demo.wiki\n",
        )
        .unwrap();
        let files = [
            (
                "Home.md",
                "# Home\n\n[[Getting Started]] · [[Docs|Working-with-CSharp-Client]] · [[Missing Page]]\n\n[Overlays](Working-with-Overlays) · [web](https://github.com/atc-net/demo/wiki/Working-with-Overlays#apply)\n\n![logo](images/logo.png) [other repo](https://github.com/atc-net/demo/blob/main/README.md)",
            ),
            ("Getting-Started.md", "# Start"),
            ("Working-with-CSharp-Client.md", "# C#"),
            ("Working-with-Overlays.md", "## Apply\n"),
            ("guides/Deep-Page.md", "deep"),
            ("_Sidebar.md", "- [[Home]]\n- [[Getting Started]]"),
            ("_Footer.md", "footer"),
            ("images/logo.png", ""),
        ];
        for (file, text) in files {
            fs::write(root.join(file), text).unwrap();
        }
        Arc::new(Wiki::open(&root).unwrap())
    }

    fn page_name(wiki: &Wiki, href: &str) -> Option<String> {
        match wiki.classify_href(href) {
            WikiHref::Page { page, .. } => Some(page.name.clone()),
            _ => None,
        }
    }

    #[test]
    fn indexes_pages_sidebar_and_footer() {
        let wiki = fixture("index");
        let names: Vec<_> = wiki.pages().iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Deep-Page",
                "Getting-Started",
                "Home",
                "Working-with-CSharp-Client",
                "Working-with-Overlays"
            ]
        );
        assert!(wiki.sidebar().is_some());
        assert!(wiki.footer().is_some());
        assert_eq!(wiki.home().unwrap().name, "Home");
        assert_eq!(wiki.info().name, "demo");
        assert_eq!(
            wiki.info().url.as_deref(),
            Some("https://github.com/atc-net/demo/wiki")
        );
        assert_eq!(wiki.pages()[1].title, "Getting Started");
    }

    #[test]
    fn finds_pages_like_github() {
        let wiki = fixture("find");
        for href in [
            "Getting Started",
            "getting-started",
            "Getting%20Started",
            "Getting-Started.md",
            "./Getting-Started",
            "sub/folder/Getting-Started",
            "Deep Page",
        ] {
            assert!(page_name(&wiki, href).is_some(), "{href}");
        }
    }

    #[test]
    fn maps_github_wiki_urls_to_local_pages() {
        let wiki = fixture("urls");
        assert_eq!(
            page_name(
                &wiki,
                "https://github.com/atc-net/demo/wiki/Working-with-Overlays#apply"
            ),
            Some("Working-with-Overlays".into())
        );
        assert_eq!(
            page_name(&wiki, "https://GitHub.com/ATC-NET/demo/wiki"),
            Some("Home".into())
        );
        assert_eq!(
            page_name(&wiki, "https://github.com/atc-net/demo/wiki/"),
            Some("Home".into())
        );
        assert_eq!(
            page_name(&wiki, "https://github.com/atc-net/demo/blob/main/x.md"),
            None
        );
        assert_eq!(
            page_name(&wiki, "https://github.com/someone-else/demo/wiki/Home"),
            None
        );
    }

    #[test]
    fn keeps_fragments() {
        let wiki = fixture("fragments");
        assert!(matches!(
            wiki.classify_href("Working-with-Overlays#Apply%20now"),
            WikiHref::Page { fragment: Some(f), .. } if f == "Apply now"
        ));
    }

    #[test]
    fn leaves_other_links_alone() {
        let wiki = fixture("other");
        for href in [
            "#section",
            "images/logo.png",
            "file.pdf",
            "https://example.com",
            "mailto:a@b.c",
            "",
        ] {
            assert_eq!(wiki.classify_href(href), WikiHref::Other, "{href}");
        }
    }

    #[test]
    fn reports_missing_pages() {
        let wiki = fixture("missing");
        assert!(matches!(
            wiki.classify_href("No Such Page"),
            WikiHref::Missing { .. }
        ));
        assert!(matches!(
            wiki.classify_href("https://github.com/atc-net/demo/wiki/Nope"),
            WikiHref::Missing { .. }
        ));
    }

    #[test]
    fn traversal_cannot_leave_the_wiki() {
        let wiki = fixture("traversal");
        // Only the last segment is used, and only indexed pages can match.
        for href in ["../../secret", "..\\..\\Windows\\win", "../../etc/passwd"] {
            assert!(
                !matches!(wiki.classify_href(href), WikiHref::Page { .. }),
                "{href}"
            );
        }
        match wiki.resolve_link(&wiki.root().join("Home.md"), "../outside/Getting-Started") {
            LinkTarget::Document { path, .. } => assert!(path.starts_with(wiki.root())),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn renders_pages_with_canonical_links_and_missing_list() {
        let wiki = fixture("render");
        let home = wiki.home().unwrap().path.clone();
        let doc = wiki.render(&home, &RenderOptions::default()).unwrap();
        let html = doc.html.as_str();
        assert!(html.contains(r#"href="Getting-Started""#), "{html}");
        assert!(
            html.contains(
                r#"href="Working-with-CSharp-Client" rel="noopener noreferrer">Docs</a>"#
            ),
            "{html}"
        );
        assert!(
            html.contains(r#"href="Working-with-Overlays#apply""#),
            "{html}"
        );
        assert!(html.contains("blob/main/README.md"), "{html}");
        assert_eq!(doc.missing_links.len(), 1, "{:?}", doc.missing_links);
        assert_eq!(doc.local_images.len(), 1);
        assert_eq!(doc.title, "Home");
        assert!(doc.modified_ms.is_some());
    }

    #[test]
    fn searches_page_text_and_titles() {
        let wiki = fixture("search");
        let hits = wiki.search("start", 10);
        // "Getting-Started" matches by title (and text), so it comes first.
        assert_eq!(hits[0].page.name, "Getting-Started");
        // Case-insensitive; the snippet keeps the page's own spelling.
        let hits = wiki.search("APPLY", 10);
        let overlays = hits
            .iter()
            .find(|hit| hit.page.name == "Working-with-Overlays")
            .unwrap();
        assert_eq!(overlays.snippet.as_ref().unwrap().hit, "Apply");
        assert_eq!(wiki.search("x", 10), Vec::new(), "too short");
        assert_eq!(wiki.search("nothing-like-this", 10), Vec::new());
    }

    #[test]
    fn search_needs_every_word_in_any_order_and_keeps_quoted_phrases() {
        let wiki = fixture("search-words");
        let names = |query: &str| -> Vec<String> {
            let mut names: Vec<_> = wiki
                .search(query, 10)
                .into_iter()
                .map(|h| h.page.name)
                .collect();
            names.sort();
            names
        };
        // Overlays: "with" from the title, "apply" from the text; Home has both in links.
        assert_eq!(names("apply with"), ["Home", "Working-with-Overlays"]);
        assert_eq!(names("APPLY overlays"), ["Home", "Working-with-Overlays"]);
        assert_eq!(names("apply client"), ["Home"]);
        // No page has both words (the footer is not a page).
        assert_eq!(names("apply footer"), Vec::<String>::new());
        // Words in any order; a phrase must be as written.
        assert_eq!(names("started getting"), ["Getting-Started", "Home"]);
        assert_eq!(names("\"getting started\""), ["Getting-Started", "Home"]);
        assert_eq!(names("\"started getting\""), Vec::<String>::new());
        // The snippet shows the longest word.
        let hits = wiki.search("w overlays apply", 10);
        let overlays = hits
            .iter()
            .find(|h| h.page.name == "Working-with-Overlays")
            .unwrap();
        // "overlays" is the longest word, but only in the title: the snippet shows "apply".
        assert_eq!(overlays.snippet.as_ref().unwrap().hit, "Apply");
        let hits = wiki.search("w apply", 10);
        let overlays = hits
            .iter()
            .find(|h| h.page.name == "Working-with-Overlays")
            .unwrap();
        assert_eq!(overlays.snippet.as_ref().unwrap().hit, "Apply");
    }

    #[test]
    fn splits_search_terms() {
        assert_eq!(search_terms("  Foo  bar "), ["bar", "foo"]);
        assert_eq!(
            search_terms("a \"Getting Started\" x go"),
            ["getting started", "go"]
        );
        assert_eq!(search_terms("\"unclosed phrase"), ["unclosed phrase"]);
        assert_eq!(search_terms("a b"), Vec::<String>::new());
        assert_eq!(search_terms("dup DUP"), ["dup"]);
    }

    #[test]
    fn snippets_drop_markup_but_keep_csharp() {
        assert_eq!(
            clean_snippet("## Use the C# client\n> **bold** `code` | cell |"),
            "Use the C# client bold code cell"
        );
    }

    #[test]
    fn parses_github_remotes() {
        let expected = Some(GitHubRepo {
            owner: "atc-net".into(),
            repo: "demo".into(),
        });
        for url in [
            "https://github.com/atc-net/demo.wiki",
            "https://github.com/atc-net/demo.wiki.git",
            "git@github.com:atc-net/demo.wiki.git",
            "ssh://git@github.com/atc-net/demo.wiki.git",
        ] {
            assert_eq!(parse_github_remote(url), expected, "{url}");
        }
        assert_eq!(parse_github_remote("https://gitlab.com/a/b.wiki"), None);
    }

    #[test]
    fn detects_wiki_folders() {
        let wiki = fixture("detect");
        assert!(is_wiki_dir(wiki.root()));
        assert_eq!(
            find_wiki_root(&wiki.root().join("Home.md")).as_deref(),
            Some(wiki.root())
        );
        assert!(!is_wiki_dir(&std::env::temp_dir()));
    }
}
