//! Linting every Markdown file in a folder (a docs folder or a wiki), for a
//! report of the issues per file.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{LintConfig, lint};
use crate::folder::{ScanOptions, markdown_files};
use crate::source::read_source;
use crate::wiki::is_wiki_dir;

/// A file lists at most this many issues of each rule (the counts include all of them).
pub const MAX_ISSUES_PER_RULE: usize = 50;

/// One issue in a folder report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIssue {
    /// Rule id, e.g. `MD009`.
    pub rule: &'static str,
    /// Rule name, e.g. `no-trailing-spaces` (not sent: the frontend has the rule list).
    #[serde(skip)]
    pub alias: &'static str,
    /// What is wrong.
    pub message: String,
    /// 1-based line.
    pub line: usize,
    /// 1-based column, in characters.
    pub column: usize,
    /// The issue has a fix.
    pub fixable: bool,
}

/// A file with issues, or one that couldn't be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLint {
    /// The file.
    pub path: PathBuf,
    /// The path below the folder, with `/` separators.
    pub relative: String,
    /// Its issues in line order, at most [`MAX_ISSUES_PER_RULE`] of each rule.
    pub issues: Vec<FolderIssue>,
    /// The number of issues, including those left out of `issues`.
    pub total: usize,
    /// The number of issues per rule (all issues counted).
    pub rule_counts: BTreeMap<&'static str, usize>,
    /// Why the file couldn't be linted (not UTF-8, too large…).
    pub error: Option<String>,
}

/// The issues of all Markdown files in a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderLint {
    /// The folder that was linted.
    pub root: PathBuf,
    /// Number of Markdown files linted.
    pub scanned: usize,
    /// Files with issues or errors, in path order (clean files are left out).
    pub files: Vec<FileLint>,
    /// There were more than [`ScanOptions::max_files`] files; the rest were skipped.
    pub truncated: bool,
    /// Problems with configuration files (each reported once).
    pub config_errors: Vec<String>,
    /// Issues and files per rule, most issues first (all issues counted).
    pub rules: Vec<RuleCount>,
}

/// How often a rule was broken in a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleCount {
    /// Rule id.
    pub rule: &'static str,
    /// Number of issues.
    pub issues: usize,
    /// Number of files with at least one.
    pub files: usize,
}

/// Lints every Markdown file below `root` (found with the shared folder
/// scanner, so the same files as the Explorer shows). `config_for` gives the
/// configuration for a file, and an error message if its configuration file is
/// broken. Files in a wiki folder are linted as wiki pages (the page name is the
/// title). The files are read and linted on all CPU cores.
pub fn lint_folder(
    root: &Path,
    scan: &ScanOptions,
    mut config_for: impl FnMut(&Path) -> (LintConfig, Option<String>),
) -> FolderLint {
    let found = markdown_files(root, scan);
    let (paths, truncated) = (found.files, found.truncated);

    // Configuration and wiki-ness per file, in order (cheap, and `config_for`
    // may cache), then the slow part in parallel.
    let mut wiki_dirs: HashMap<PathBuf, bool> = HashMap::new();
    let mut config_errors: Vec<String> = Vec::new();
    let jobs: Vec<(&PathBuf, LintConfig, bool)> = paths
        .iter()
        .map(|path| {
            let dir = path.parent().unwrap_or(root).to_path_buf();
            let wiki = *wiki_dirs
                .entry(dir)
                .or_insert_with_key(|dir| is_wiki_dir(dir));
            let (config, error) = config_for(path);
            if let Some(error) = error
                && !config_errors.contains(&error)
            {
                config_errors.push(error);
            }
            (path, config, wiki)
        })
        .collect();

    let threads = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let chunk = jobs.len().div_ceil(threads).max(1);
    let results: Vec<Option<(FileLint, Vec<&'static str>)>> = std::thread::scope(|scope| {
        let workers: Vec<_> = jobs
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .map(|(path, config, wiki)| lint_file(root, path, config, *wiki))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    });

    let mut counts: BTreeMap<&'static str, RuleCount> = BTreeMap::new();
    let mut files = Vec::new();
    for (file, rules) in results.into_iter().flatten() {
        let mut seen = Vec::new();
        for rule in rules {
            let count = counts.entry(rule).or_insert(RuleCount {
                rule,
                issues: 0,
                files: 0,
            });
            count.issues += 1;
            if !seen.contains(&rule) {
                seen.push(rule);
                count.files += 1;
            }
        }
        files.push(file);
    }
    let mut rules: Vec<RuleCount> = counts.into_values().collect();
    rules.sort_by(|a, b| b.issues.cmp(&a.issues).then(a.rule.cmp(b.rule)));
    FolderLint {
        root: root.to_path_buf(),
        scanned: paths.len(),
        files,
        truncated,
        config_errors,
        rules,
    }
}

/// One file's entry (None if it is clean) and the rule of each of its issues.
fn lint_file(
    root: &Path,
    path: &Path,
    config: &LintConfig,
    wiki: bool,
) -> Option<(FileLint, Vec<&'static str>)> {
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let source = match read_source(path) {
        Ok(source) => source,
        Err(error) => {
            let file = FileLint {
                path: path.to_path_buf(),
                relative,
                issues: Vec::new(),
                total: 0,
                rule_counts: BTreeMap::new(),
                error: Some(error.to_string()),
            };
            return Some((file, Vec::new()));
        }
    };
    let issues = lint(&source.text, config, wiki);
    if issues.is_empty() {
        return None;
    }
    let rules = issues.iter().map(|issue| issue.rule).collect();
    let total = issues.len();
    let mut rule_counts = BTreeMap::new();
    for issue in &issues {
        *rule_counts.entry(issue.rule).or_insert(0) += 1;
    }
    let mut listed: BTreeMap<&str, usize> = BTreeMap::new();
    let issues = issues
        .into_iter()
        .filter(|issue| {
            let listed = listed.entry(issue.rule).or_insert(0);
            *listed += 1;
            *listed <= MAX_ISSUES_PER_RULE
        })
        .map(|issue| FolderIssue {
            column: column(&source.text, issue.start),
            fixable: issue.fix.is_some(),
            rule: issue.rule,
            alias: issue.alias,
            message: issue.message,
            line: issue.line,
        })
        .collect();
    let file = FileLint {
        path: source.path,
        relative,
        issues,
        total,
        rule_counts,
        error: None,
    };
    Some((file, rules))
}

/// 1-based character column of a byte offset.
fn column(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    let mut start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let end = (start..=offset)
        .rev()
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(start);
    text[start..end].chars().count() + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("atc-lint-folder-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reports_files_with_issues_in_path_order() {
        let dir = temp_dir("report");
        fs::write(dir.join("b.md"), "# B\n\ntrailing \n").unwrap();
        fs::write(dir.join("clean.md"), "# Clean\n").unwrap();
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::write(dir.join("docs/a.md"), "# A\n\næ\tb\n").unwrap();
        fs::write(dir.join("not-markdown.txt"), "x \n").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/hidden.md"), "x \n").unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("node_modules/pkg/README.md"), "x \n").unwrap();
        fs::write(dir.join("latin1.md"), b"# A\n\n\xe6\n").unwrap();

        let report = lint_folder(&dir, &ScanOptions::default(), |_| {
            (LintConfig::app_defaults(), None)
        });
        assert_eq!(report.scanned, 4);
        assert!(!report.truncated);
        let names: Vec<_> = report.files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(names, ["b.md", "docs/a.md", "latin1.md"]);

        let b = &report.files[0];
        assert_eq!(b.issues.len(), 1);
        assert_eq!(
            (b.issues[0].rule, b.issues[0].line, b.issues[0].column),
            ("MD009", 3, 9)
        );
        assert!(b.issues[0].fixable);
        // The column counts characters (æ is one), not bytes.
        assert_eq!(report.files[1].issues[0].rule, "MD010");
        assert_eq!(report.files[1].issues[0].column, 2);
        assert!(report.files[2].error.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lints_wiki_pages_as_wiki_pages_and_reports_config_errors_once() {
        let dir = temp_dir("wiki");
        let wiki = dir.join("project.wiki");
        fs::create_dir_all(&wiki).unwrap();
        // No H1 is fine on a wiki page (the page name is the title).
        fs::write(wiki.join("Page.md"), "Text\n").unwrap();
        fs::write(dir.join("doc.md"), "Text\n").unwrap();
        fs::write(dir.join("other.md"), "Text\n").unwrap();

        let report = lint_folder(&dir, &ScanOptions::default(), |_| {
            (LintConfig::app_defaults(), Some("bad config".into()))
        });
        let names: Vec<_> = report.files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(names, ["doc.md", "other.md"]);
        assert_eq!(report.files[0].issues[0].rule, "MD041");
        assert_eq!(report.config_errors, ["bad config"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_the_issues_per_file_but_counts_them_all() {
        let dir = temp_dir("cap");
        fs::write(
            dir.join("many.md"),
            format!("# Many\n\n{}", "x \n".repeat(250)),
        )
        .unwrap();
        fs::write(dir.join("one.md"), "# One\n\nx \n\tz\n").unwrap();

        let report = lint_folder(&dir, &ScanOptions::default(), |_| {
            (LintConfig::app_defaults(), None)
        });
        let many = &report.files[0];
        assert_eq!((many.issues.len(), many.total), (MAX_ISSUES_PER_RULE, 250));
        assert_eq!(report.files[1].total, 2);
        assert_eq!(many.rule_counts.get("MD009"), Some(&250));
        let counts: Vec<_> = report
            .rules
            .iter()
            .map(|r| (r.rule, r.issues, r.files))
            .collect();
        assert_eq!(counts, [("MD009", 251, 2), ("MD010", 1, 1)]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn columns_are_characters() {
        assert_eq!(column("abc", 0), 1);
        assert_eq!(column("a\nææb", 6), 3);
        assert_eq!(column("x", 99), 2);
    }
}
