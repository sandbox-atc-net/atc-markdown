//! The rules, grouped by what they check. Each check gets the document context
//! and its parameters, and pushes issues.

mod blocks;
mod code;
mod headings;
mod inline;
mod lists;
mod whitespace;

use serde_json::{Map, Value};

use super::context::Ctx;
use super::{Issue, RuleInfo};

pub(super) type Check = fn(&Ctx<'_>, &Params<'_>, &mut Vec<Issue>);

const fn rule(
    id: &'static str,
    alias: &'static str,
    description: &'static str,
    fixable: bool,
) -> RuleInfo {
    RuleInfo {
        id,
        alias,
        description,
        fixable,
        default_on: true,
    }
}

const fn deprecated(id: &'static str, alias: &'static str, description: &'static str) -> RuleInfo {
    RuleInfo {
        id,
        alias,
        description,
        fixable: false,
        default_on: false,
    }
}

pub(super) const RULES: &[RuleInfo] = &[
    rule(
        "MD001",
        "heading-increment",
        "Heading levels should only increment by one level at a time",
        false,
    ),
    deprecated(
        "MD002",
        "first-heading-h1",
        "First heading should be a top-level heading",
    ),
    rule(
        "MD003",
        "heading-style",
        "Heading style should be consistent",
        true,
    ),
    rule(
        "MD004",
        "ul-style",
        "Unordered list style should be consistent",
        true,
    ),
    rule(
        "MD005",
        "list-indent",
        "List items at the same level should have the same indentation",
        true,
    ),
    deprecated(
        "MD006",
        "ul-start-left",
        "Bulleted lists should start at the beginning of the line",
    ),
    rule("MD007", "ul-indent", "Unordered list indentation", true),
    rule("MD009", "no-trailing-spaces", "No trailing spaces", true),
    rule("MD010", "no-hard-tabs", "No hard tabs", true),
    rule("MD011", "no-reversed-links", "Reversed link syntax", true),
    rule(
        "MD012",
        "no-multiple-blanks",
        "No multiple consecutive blank lines",
        true,
    ),
    rule("MD013", "line-length", "Line length", false),
    rule(
        "MD014",
        "commands-show-output",
        "Dollar signs used before commands without showing output",
        true,
    ),
    rule(
        "MD018",
        "no-missing-space-atx",
        "No space after hash on atx style heading",
        true,
    ),
    rule(
        "MD019",
        "no-multiple-space-atx",
        "Multiple spaces after hash on atx style heading",
        true,
    ),
    rule(
        "MD020",
        "no-missing-space-closed-atx",
        "No space inside hashes on closed atx style heading",
        true,
    ),
    rule(
        "MD021",
        "no-multiple-space-closed-atx",
        "Multiple spaces inside hashes on closed atx style heading",
        true,
    ),
    rule(
        "MD022",
        "blanks-around-headings",
        "Headings should be surrounded by blank lines",
        true,
    ),
    rule(
        "MD023",
        "heading-start-left",
        "Headings must start at the beginning of the line",
        true,
    ),
    rule(
        "MD024",
        "no-duplicate-heading",
        "Multiple headings with the same content",
        false,
    ),
    rule(
        "MD025",
        "single-h1",
        "Multiple top-level headings in the same document",
        false,
    ),
    rule(
        "MD026",
        "no-trailing-punctuation",
        "Trailing punctuation in heading",
        true,
    ),
    rule(
        "MD027",
        "no-multiple-space-blockquote",
        "Multiple spaces after blockquote symbol",
        true,
    ),
    rule(
        "MD028",
        "no-blanks-blockquote",
        "Blank line inside blockquote",
        false,
    ),
    rule("MD029", "ol-prefix", "Ordered list item prefix", true),
    rule(
        "MD030",
        "list-marker-space",
        "Spaces after list markers",
        true,
    ),
    rule(
        "MD031",
        "blanks-around-fences",
        "Fenced code blocks should be surrounded by blank lines",
        true,
    ),
    rule(
        "MD032",
        "blanks-around-lists",
        "Lists should be surrounded by blank lines",
        true,
    ),
    rule("MD033", "no-inline-html", "Inline HTML", false),
    rule("MD034", "no-bare-urls", "Bare URL used", true),
    rule("MD035", "hr-style", "Horizontal rule style", true),
    rule(
        "MD036",
        "no-emphasis-as-heading",
        "Emphasis used instead of a heading",
        false,
    ),
    rule(
        "MD037",
        "no-space-in-emphasis",
        "Spaces inside emphasis markers",
        true,
    ),
    rule(
        "MD038",
        "no-space-in-code",
        "Spaces inside code span elements",
        true,
    ),
    rule(
        "MD039",
        "no-space-in-links",
        "Spaces inside link text",
        true,
    ),
    rule(
        "MD040",
        "fenced-code-language",
        "Fenced code blocks should have a language specified",
        false,
    ),
    rule(
        "MD041",
        "first-line-heading",
        "First line in a file should be a top-level heading",
        false,
    ),
    rule("MD046", "code-block-style", "Code block style", false),
    rule(
        "MD047",
        "single-trailing-newline",
        "Files should end with a single newline character",
        true,
    ),
];

/// The same rules under their older (markdownlint Ruby / earlier JS) names.
pub(super) const OTHER_NAMES: &[(&str, &str)] = &[
    ("header-increment", "MD001"),
    ("first-header-h1", "MD002"),
    ("header-style", "MD003"),
    ("blanks-around-headers", "MD022"),
    ("header-start-left", "MD023"),
    ("no-duplicate-header", "MD024"),
    ("single-title", "MD025"),
    ("no-emphasis-as-header", "MD036"),
    ("first-line-h1", "MD041"),
];

/// The check of each rule, in the same order as [`RULES`].
pub(super) const CHECKS: [Check; 39] = [
    headings::md001,
    headings::md002,
    headings::md003,
    lists::md004,
    lists::md005,
    lists::md006,
    lists::md007,
    whitespace::md009,
    whitespace::md010,
    inline::md011,
    whitespace::md012,
    whitespace::md013,
    code::md014,
    headings::md018,
    headings::md019,
    headings::md020,
    headings::md021,
    headings::md022,
    headings::md023,
    headings::md024,
    headings::md025,
    headings::md026,
    blocks::md027,
    blocks::md028,
    lists::md029,
    lists::md030,
    code::md031,
    lists::md032,
    inline::md033,
    inline::md034,
    blocks::md035,
    headings::md036,
    inline::md037,
    inline::md038,
    inline::md039,
    code::md040,
    headings::md041,
    code::md046,
    whitespace::md047,
];

/// A rule's parameters, with typed getters that fall back to the default.
#[derive(Debug)]
pub(super) struct Params<'a>(&'a Map<String, Value>);

impl<'a> Params<'a> {
    pub fn new(map: &'a Map<String, Value>) -> Self {
        Self(map)
    }

    fn get(&self, keys: &[&str]) -> Option<&'a Value> {
        keys.iter().find_map(|k| self.0.get(*k))
    }

    pub fn usize(&self, keys: &[&str], default: usize) -> usize {
        self.get(keys)
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(default)
    }

    pub fn bool(&self, keys: &[&str], default: bool) -> bool {
        self.get(keys).and_then(Value::as_bool).unwrap_or(default)
    }

    /// A string parameter; markdownlint Ruby writes styles as `:consistent`.
    pub fn str(&self, keys: &[&str], default: &'a str) -> &'a str {
        self.get(keys)
            .and_then(Value::as_str)
            .map_or(default, |s| s.strip_prefix(':').unwrap_or(s))
    }

    /// A list, given as an array or a comma-separated string.
    pub fn list(&self, keys: &[&str]) -> Vec<String> {
        match self.get(keys) {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            Some(Value::String(s)) => s
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// Count of leading spaces/tabs.
pub(super) fn indent_of(text: &str) -> usize {
    text.len() - text.trim_start_matches([' ', '\t']).len()
}
