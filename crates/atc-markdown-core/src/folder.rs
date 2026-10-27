//! Finding the Markdown files in a folder. One scanner for everything that
//! walks a folder: the Explorer tree of an open folder, the page list of a
//! wiki, folder search and "Lint Folder".
//!
//! Skipped: hidden files and folders (`.git`, `.vs`, …), folders named in
//! [`ScanOptions::skipped_dirs`] (`node_modules`, `bin`, `obj`, `target`),
//! paths ignored by `.gitignore` (when [`ScanOptions::respect_gitignore`]), and
//! symlinks / junctions (never followed, so a scan can't leave the folder).

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::document::{DocumentError, strip_verbatim_prefix};
use crate::links::is_markdown_file;
use crate::search::{self};
use crate::wiki::{SearchHit, WikiPage, is_wiki_dir};

/// Folders that hold installed or generated files, not documentation.
pub const DEFAULT_SKIPPED_DIRS: &[&str] = &["node_modules", "bin", "obj", "target"];

/// At most this many files are scanned; the result says when there were more.
pub const MAX_FOLDER_FILES: usize = 5000;

/// How deep a scan goes by default.
pub const MAX_FOLDER_DEPTH: usize = 16;

/// What a folder scan skips, and how far it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOptions {
    /// Folder names to skip (case-insensitive), wherever they are.
    pub skipped_dirs: Vec<String>,
    /// Skip what `.gitignore` (and `.ignore`, `.git/info/exclude`) ignore.
    pub respect_gitignore: bool,
    /// At most this many files.
    pub max_files: usize,
    /// Folder levels below the root.
    pub max_depth: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            skipped_dirs: DEFAULT_SKIPPED_DIRS.iter().map(|&d| d.to_owned()).collect(),
            respect_gitignore: true,
            max_files: MAX_FOLDER_FILES,
            max_depth: MAX_FOLDER_DEPTH,
        }
    }
}

/// The Markdown files below a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownFiles {
    /// The files, in path order (case-insensitive).
    pub files: Vec<PathBuf>,
    /// There were more than [`ScanOptions::max_files`]; the rest were left out.
    pub truncated: bool,
}

/// Finds the Markdown files below `root`.
pub fn markdown_files(root: &Path, options: &ScanOptions) -> MarkdownFiles {
    let skipped: Vec<String> = options
        .skipped_dirs
        .iter()
        .map(|d| d.trim().to_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    let gitignore = options.respect_gitignore;
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(false)
        .hidden(true)
        .ignore(gitignore)
        .git_ignore(gitignore)
        .git_exclude(gitignore)
        // Not the machine-wide ignore file: the tree must not depend on who opens it.
        .git_global(false)
        .parents(gitignore)
        // A folder with a .gitignore but no git repository (yet) counts too.
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(options.max_depth.saturating_add(1)))
        .sort_by_file_name(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()))
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            entry.depth() == 0
                || !is_dir
                || !skipped.contains(&entry.file_name().to_string_lossy().to_lowercase())
        })
        .build();

    let mut files = Vec::new();
    let mut truncated = false;
    for entry in walker.flatten() {
        // `file_type` doesn't follow symlinks: a link is neither a file nor a folder here.
        if !entry.file_type().is_some_and(|t| t.is_file()) || !is_markdown_file(entry.path()) {
            continue;
        }
        if files.len() == options.max_files {
            truncated = true;
            break;
        }
        files.push(entry.into_path());
    }
    files.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    MarkdownFiles { files, truncated }
}

/// A file or folder in the Explorer tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// File or folder name.
    pub name: String,
    /// Full path.
    pub path: PathBuf,
    /// Path below the opened folder, with `/` separators.
    pub relative: String,
    /// Set on folders: what they contain (folders first, then files).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FolderEntry>>,
    /// The folder is a GitHub wiki (it can be opened as one).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub wiki: bool,
}

/// An opened folder: only its Markdown files, and the folders that lead to them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTree {
    /// The folder (canonical path).
    pub root: PathBuf,
    /// Its name.
    pub name: String,
    /// The folder itself is a GitHub wiki.
    pub wiki: bool,
    /// Top-level entries: folders first, then files, each in natural order.
    pub entries: Vec<FolderEntry>,
    /// Number of Markdown files in the tree.
    pub files: usize,
    /// There were more than [`ScanOptions::max_files`] files; the rest are left out.
    pub truncated: bool,
}

/// A folder while the tree is built: its folders by name, and its file names.
#[derive(Default)]
struct Node {
    dirs: BTreeMap<String, Node>,
    files: Vec<String>,
}

/// Scans `root` for the Explorer tree.
///
/// # Errors
///
/// Fails if `root` is not a readable folder.
pub fn folder_tree(root: &Path, options: &ScanOptions) -> Result<FolderTree, DocumentError> {
    let root = canonical_folder(root)?;
    let scan = markdown_files(&root, options);

    let mut top = Node::default();
    for file in &scan.files {
        let Ok(relative) = file.strip_prefix(&root) else {
            continue;
        };
        let parts: Vec<String> = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let Some((name, dirs)) = parts.split_last() else {
            continue;
        };
        let mut node = &mut top;
        for dir in dirs {
            node = node.dirs.entry(dir.clone()).or_default();
        }
        node.files.push(name.clone());
    }

    let name = root.file_name().map_or_else(
        || root.to_string_lossy().into_owned(),
        |n| n.to_string_lossy().into_owned(),
    );
    Ok(FolderTree {
        wiki: is_wiki_dir(&root),
        entries: build(top, &root, ""),
        files: scan.files.len(),
        truncated: scan.truncated,
        name,
        root,
    })
}

/// The entries of a folder: folders first, then files, each in natural order.
fn build(node: Node, dir: &Path, relative: &str) -> Vec<FolderEntry> {
    let join = |name: &str| {
        if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        }
    };
    let mut folders: Vec<FolderEntry> = node
        .dirs
        .into_iter()
        .map(|(name, child)| {
            let path = dir.join(&name);
            let rel = join(&name);
            FolderEntry {
                children: Some(build(child, &path, &rel)),
                wiki: is_wiki_dir(&path),
                name,
                path,
                relative: rel,
            }
        })
        .collect();
    folders.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    let mut files: Vec<FolderEntry> = node
        .files
        .into_iter()
        .map(|name| FolderEntry {
            path: dir.join(&name),
            relative: join(&name),
            children: None,
            wiki: false,
            name,
        })
        .collect();
    files.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    folders.extend(files);
    folders
}

/// Full-text search across the Markdown files of a folder (same rules as the
/// wiki search). A hit's `page.title` is the path below the folder, `page.name`
/// the file name without extension.
///
/// # Errors
///
/// Fails if `root` is not a readable folder.
pub fn search_folder(
    root: &Path,
    options: &ScanOptions,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, DocumentError> {
    let root = canonical_folder(root)?;
    let files: Vec<WikiPage> = markdown_files(&root, options)
        .files
        .into_iter()
        .map(|path| WikiPage {
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            title: path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/"),
            path,
        })
        .collect();
    Ok(
        search::search(&files, |f| &f.path, |f| &f.title, query, limit)
            .into_iter()
            .map(|(page, found)| SearchHit {
                page: page.clone(),
                matches: found.matches,
                snippet: found.snippet,
            })
            .collect(),
    )
}

fn canonical_folder(root: &Path) -> Result<PathBuf, DocumentError> {
    let root =
        strip_verbatim_prefix(fs::canonicalize(root).map_err(|source| DocumentError::Io {
            path: root.to_path_buf(),
            source,
        })?);
    if root.is_dir() {
        Ok(root)
    } else {
        Err(DocumentError::NotAFile(root))
    }
}

/// Compares names like a file manager: case-insensitive, with numbers by value
/// (`2-setup` before `10-deploy`).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a_rest, mut b_rest) = (a, b);
    loop {
        match (a_rest.is_empty(), b_rest.is_empty()) {
            (true, true) => return a.cmp(b), // equal ignoring case: still a stable order
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        let (a_part, a_next) = split_chunk(a_rest);
        let (b_part, b_next) = split_chunk(b_rest);
        let a_digits = a_part.starts_with(|c: char| c.is_ascii_digit());
        let b_digits = b_part.starts_with(|c: char| c.is_ascii_digit());
        let order = if a_digits && b_digits {
            let a_num = a_part.trim_start_matches('0');
            let b_num = b_part.trim_start_matches('0');
            a_num.len().cmp(&b_num.len()).then_with(|| a_num.cmp(b_num))
        } else {
            a_part.to_lowercase().cmp(&b_part.to_lowercase())
        };
        if order != Ordering::Equal {
            return order;
        }
        a_rest = a_next;
        b_rest = b_next;
    }
}

/// The leading run of digits or of non-digits, and the rest.
fn split_chunk(text: &str) -> (&str, &str) {
    let digits = text.starts_with(|c: char| c.is_ascii_digit());
    let end = text
        .find(|c: char| c.is_ascii_digit() != digits)
        .unwrap_or(text.len());
    text.split_at(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atc-folder-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn names(entries: &[FolderEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn sorts_naturally_and_ignoring_case() {
        let mut names = vec![
            "10-deploy.md",
            "2-setup.md",
            "b.md",
            "A.md",
            "1-intro.md",
            "a2.md",
            "a10.md",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            [
                "1-intro.md",
                "2-setup.md",
                "10-deploy.md",
                "a2.md",
                "a10.md",
                "A.md",
                "b.md"
            ]
        );
        assert_eq!(natural_cmp("file007", "file7"), "file007".cmp("file7"));
    }

    #[test]
    fn tree_has_only_markdown_files_and_the_folders_that_lead_to_them() {
        let dir = temp_dir("tree");
        write(&dir, "README.md", "# Root");
        write(&dir, "CHANGELOG.markdown", "x");
        write(&dir, "docs/guides/api/setup.md", "x");
        write(&dir, "docs/10-later.md", "x");
        write(&dir, "docs/2-first.md", "x");
        write(&dir, "src/main.rs", "fn main() {}");
        write(&dir, "src/deep/empty/notes.txt", "x");
        fs::create_dir_all(dir.join("empty")).unwrap();

        let tree = folder_tree(&dir, &ScanOptions::default()).unwrap();
        assert_eq!(
            names(&tree.entries),
            ["docs", "CHANGELOG.markdown", "README.md"]
        );
        assert_eq!(tree.files, 5);
        let docs = tree.entries[0].children.as_ref().unwrap();
        assert_eq!(names(docs), ["guides", "2-first.md", "10-later.md"]);
        let api = &docs[0].children.as_ref().unwrap()[0];
        assert_eq!(api.relative, "docs/guides/api");
        assert_eq!(
            api.children.as_ref().unwrap()[0].relative,
            "docs/guides/api/setup.md"
        );
        assert!(tree.entries[1].children.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_hidden_build_and_gitignored_folders() {
        let dir = temp_dir("skip");
        write(&dir, "keep.md", "x");
        write(&dir, ".git/info.md", "x");
        write(&dir, ".github/PULL_REQUEST_TEMPLATE.md", "x");
        write(&dir, "node_modules/pkg/README.md", "x");
        write(&dir, "src/Bin/Debug/x.md", "x");
        write(&dir, "obj/x.md", "x");
        write(&dir, "target/doc/x.md", "x");
        write(&dir, "generated/api.md", "x");
        write(&dir, "notes/draft.md", "x");
        write(&dir, ".gitignore", "generated/\n*.draft.md\n");
        write(&dir, "notes/secret.draft.md", "x");

        let files = |options: &ScanOptions| -> Vec<String> {
            markdown_files(&dir, options)
                .files
                .iter()
                .map(|p| {
                    p.strip_prefix(&dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect()
        };
        assert_eq!(
            files(&ScanOptions::default()),
            ["keep.md", "notes/draft.md"]
        );

        let everything = ScanOptions {
            skipped_dirs: Vec::new(),
            respect_gitignore: false,
            ..ScanOptions::default()
        };
        assert_eq!(
            files(&everything),
            [
                "generated/api.md",
                "keep.md",
                "node_modules/pkg/README.md",
                "notes/draft.md",
                "notes/secret.draft.md",
                "obj/x.md",
                "src/Bin/Debug/x.md",
                "target/doc/x.md",
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stops_at_the_file_limit() {
        let dir = temp_dir("limit");
        for i in 0..5 {
            write(&dir, &format!("f{i}.md"), "x");
        }
        let options = ScanOptions {
            max_files: 3,
            ..ScanOptions::default()
        };
        let scan = markdown_files(&dir, &options);
        assert_eq!(scan.files.len(), 3);
        assert!(scan.truncated);
        assert!(!markdown_files(&dir, &ScanOptions::default()).truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn depth_is_limited() {
        let dir = temp_dir("depth");
        write(&dir, "a/b/c/deep.md", "x");
        let shallow = ScanOptions {
            max_depth: 2,
            ..ScanOptions::default()
        };
        assert_eq!(markdown_files(&dir, &shallow).files, Vec::<PathBuf>::new());
        let deep = ScanOptions {
            max_depth: 3,
            ..ScanOptions::default()
        };
        assert_eq!(markdown_files(&dir, &deep).files.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_out_of_the_folder() {
        let outside = temp_dir("outside");
        write(&outside, "secret.md", "x");
        let dir = temp_dir("links");
        write(&dir, "inside.md", "x");
        std::os::unix::fs::symlink(&outside, dir.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("file-link.md")).unwrap();
        let tree = folder_tree(&dir, &ScanOptions::default()).unwrap();
        assert_eq!(names(&tree.entries), ["inside.md"]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn marks_wiki_folders() {
        let dir = temp_dir("wikis");
        write(&dir, "project.wiki/Home.md", "x");
        write(&dir, "docs/a.md", "x");
        let tree = folder_tree(&dir, &ScanOptions::default()).unwrap();
        let wiki: Vec<_> = tree
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.wiki))
            .collect();
        assert_eq!(wiki, [("docs", false), ("project.wiki", true)]);
        assert!(!tree.wiki);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn searches_the_files_of_a_folder() {
        let dir = temp_dir("search");
        write(&dir, "README.md", "# Overview\n\nHow to apply overlays.");
        write(&dir, "docs/overlays.md", "# Overlays\n\nNothing else.");
        write(&dir, "docs/other.md", "# Other");
        let hits = search_folder(&dir, &ScanOptions::default(), "overlays", 10).unwrap();
        let titles: Vec<_> = hits.iter().map(|h| h.page.title.as_str()).collect();
        // The file name matches too, so docs/overlays.md comes first.
        assert_eq!(titles, ["docs/overlays.md", "README.md"]);
        assert_eq!(hits[1].snippet.as_ref().unwrap().hit, "overlays");
        assert!(folder_tree(&dir.join("README.md"), &ScanOptions::default()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
