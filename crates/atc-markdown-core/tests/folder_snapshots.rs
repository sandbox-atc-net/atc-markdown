//! Snapshot test of the Explorer tree of the fixture folder `tests/folder/demo`:
//! only Markdown files and the folders that lead to them, folders first, numbers
//! in natural order, hidden folders left out, wiki folders marked. Review
//! changes with `cargo insta review`.

#![allow(
    clippy::expect_used,
    reason = "helpers of a test: a broken fixture should fail loudly"
)]

use std::fmt::Write;
use std::path::Path;

use atc_markdown_core::{FolderEntry, ScanOptions, folder_tree, search_folder};

fn demo() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/folder/demo")
}

fn draw(entries: &[FolderEntry], depth: usize, out: &mut String) {
    for entry in entries {
        let indent = "  ".repeat(depth);
        match &entry.children {
            Some(children) => {
                let wiki = if entry.wiki { "  (wiki)" } else { "" };
                let _ = writeln!(out, "{indent}▾ {}/{wiki}  [{}]", entry.name, entry.relative);
                draw(children, depth + 1, out);
            }
            None => {
                let _ = writeln!(out, "{indent}  {}  [{}]", entry.name, entry.relative);
            }
        }
    }
}

#[test]
fn explorer_tree_of_the_demo_folder() {
    let tree = folder_tree(&demo(), &ScanOptions::default()).expect("fixture folder");
    let mut out = format!(
        "{}  ({} files, truncated: {})\n",
        tree.name, tree.files, tree.truncated
    );
    draw(&tree.entries, 0, &mut out);
    insta::assert_snapshot!(out);
}

#[test]
fn folder_search_finds_files_by_text_and_path() {
    let hits = search_folder(&demo(), &ScanOptions::default(), "setup", 10).expect("search");
    let titles: Vec<_> = hits.iter().map(|h| h.page.title.as_str()).collect();
    // The file named setup first, then README.md that links to it.
    assert_eq!(titles, ["docs/2-setup.md", "README.md"]);
}
