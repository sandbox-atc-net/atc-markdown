//! Markdown linting with the markdownlint rules (MD001–MD047), and fixes.
//!
//! The text is parsed with the same comrak options as the preview, so a rule
//! sees exactly the structure that is rendered. Rules that look for text which
//! `CommonMark` does *not* parse as the intended construct (`#Heading`,
//! `** bold **`, `(text)[url]`) scan the source lines instead, with code blocks,
//! front matter, HTML blocks and inline code masked out.
//!
//! Configuration follows the `.markdownlint.json` format used by VS Code and CI.

mod config;
mod context;
mod rules;
mod suppress;

use serde::Serialize;

pub use config::{CONFIG_FILE_NAMES, ConfigError, LintConfig, RuleConfig, find_config_file};

/// A markdownlint rule: id, name and what it checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInfo {
    /// `MD001` … `MD047`.
    pub id: &'static str,
    /// The markdownlint name, e.g. `heading-increment`.
    pub alias: &'static str,
    /// What the rule wants, as a short sentence.
    pub description: &'static str,
    /// Whether the rule can fix (some of) its issues.
    pub fixable: bool,
    /// On unless the configuration says otherwise.
    pub default_on: bool,
}

/// One change to the text: replace `start..end` (byte offsets) with `insert`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextEdit {
    /// Byte offset where the replaced text starts.
    pub start: usize,
    /// Byte offset just after the replaced text.
    pub end: usize,
    /// The new text.
    pub insert: String,
}

/// A problem found by a rule, with byte offsets into the linted text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    /// Rule id, e.g. `MD009`.
    pub rule: &'static str,
    /// Rule name, e.g. `no-trailing-spaces`.
    pub alias: &'static str,
    /// What is wrong, shown to the user.
    pub message: String,
    /// 1-based line number.
    pub line: usize,
    /// Byte offset where the problem starts.
    pub start: usize,
    /// Byte offset just after the problem (equal to `start` for a point).
    pub end: usize,
    /// Edits that fix it, if the rule can.
    pub fix: Option<Vec<TextEdit>>,
}

/// All rules, in id order.
pub const RULES: &[RuleInfo] = rules::RULES;

/// The rule with this id or name (case-insensitive).
pub fn rule_info(name: &str) -> Option<&'static RuleInfo> {
    RULES
        .iter()
        .find(|r| r.id.eq_ignore_ascii_case(name) || r.alias.eq_ignore_ascii_case(name))
        .or_else(|| {
            rules::OTHER_NAMES
                .iter()
                .find(|(other, _)| other.eq_ignore_ascii_case(name))
                .and_then(|(_, id)| RULES.iter().find(|r| r.id == *id))
        })
}

/// Lints Markdown text. `wiki_page` is true for a GitHub wiki page, whose title
/// (the file name) acts as its top-level heading.
pub fn lint(text: &str, config: &LintConfig, wiki_page: bool) -> Vec<Issue> {
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, text, crate::render::parse_options(wiki_page));
    let ctx = context::Ctx::new(text, root, wiki_page);

    let mut issues = Vec::new();
    for (info, check) in RULES.iter().zip(rules::CHECKS) {
        if let Some(params) = config.params(info.id) {
            check(&ctx, &rules::Params::new(params), &mut issues);
        }
    }
    let enabled = suppress::enabled_rules(&ctx);
    issues.retain(|issue| suppress::is_enabled(&enabled, issue.line, issue.rule));
    issues.sort_by(|a, b| (a.start, a.rule).cmp(&(b.start, b.rule)));
    issues
}

/// Applies the fixes of `issues` to `text`. Overlapping fixes are skipped
/// (the next run picks them up).
pub fn apply_fixes(text: &str, issues: &[Issue]) -> String {
    let mut edits: Vec<&TextEdit> = issues
        .iter()
        .filter_map(|i| i.fix.as_ref())
        .flatten()
        .collect();
    edits.sort_by_key(|e| (e.start, e.end));
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for edit in edits {
        if edit.start < at || edit.end > text.len() {
            continue;
        }
        out.push_str(&text[at..edit.start]);
        out.push_str(&edit.insert);
        at = edit.end;
    }
    out.push_str(&text[at..]);
    out
}

/// Fixes everything that can be fixed, running the rules again until nothing changes.
pub fn fix_all(text: &str, config: &LintConfig, wiki_page: bool) -> String {
    let mut text = text.to_owned();
    for _ in 0..8 {
        let issues = lint(&text, config, wiki_page);
        if !issues.iter().any(|i| i.fix.is_some()) {
            break;
        }
        let fixed = apply_fixes(&text, &issues);
        if fixed == text {
            break;
        }
        text = fixed;
    }
    text
}

/// An [`Issue`] with positions in UTF-16 code units, as editors in a browser count them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    /// Rule id.
    pub rule: &'static str,
    /// Rule name.
    pub alias: &'static str,
    /// What is wrong.
    pub message: String,
    /// 1-based line number.
    pub line: usize,
    /// UTF-16 offset where the problem starts.
    pub from: usize,
    /// UTF-16 offset just after the problem.
    pub to: usize,
    /// Edits that fix it, in UTF-16 offsets.
    pub fix: Option<Vec<Utf16Edit>>,
}

/// A [`TextEdit`] in UTF-16 offsets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Utf16Edit {
    /// UTF-16 offset where the replaced text starts.
    pub from: usize,
    /// UTF-16 offset just after the replaced text.
    pub to: usize,
    /// The new text.
    pub insert: String,
}

/// Lints and converts the positions to UTF-16 for the editor.
pub fn lint_utf16(text: &str, config: &LintConfig, wiki_page: bool) -> Vec<Diagnostic> {
    let index = Utf16Index::new(text);
    lint(text, config, wiki_page)
        .into_iter()
        .map(|issue| Diagnostic {
            rule: issue.rule,
            alias: issue.alias,
            message: issue.message,
            line: issue.line,
            from: index.offset(issue.start),
            to: index.offset(issue.end),
            fix: issue.fix.map(|edits| {
                edits
                    .into_iter()
                    .map(|e| Utf16Edit {
                        from: index.offset(e.start),
                        to: index.offset(e.end),
                        insert: e.insert,
                    })
                    .collect()
            }),
        })
        .collect()
}

/// Converts byte offsets to UTF-16 offsets, line by line.
struct Utf16Index<'a> {
    text: &'a str,
    /// (byte offset, UTF-16 offset) of each line start.
    lines: Vec<(usize, usize)>,
}

impl<'a> Utf16Index<'a> {
    fn new(text: &'a str) -> Self {
        let mut lines = vec![(0, 0)];
        let mut utf16 = 0;
        for (i, ch) in text.char_indices() {
            utf16 += ch.len_utf16();
            if ch == '\n' {
                lines.push((i + 1, utf16));
            }
        }
        Self { text, lines }
    }

    fn offset(&self, byte: usize) -> usize {
        let byte = byte.min(self.text.len());
        let line = self.lines.partition_point(|&(start, _)| start <= byte) - 1;
        let (start, utf16) = self.lines[line];
        let slice = self.text.get(start..byte).unwrap_or_default();
        utf16 + slice.encode_utf16().count()
    }
}

#[cfg(test)]
mod tests;
