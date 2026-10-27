//! Full-text search across Markdown files (the pages of a wiki, or the files of
//! an open folder), with a snippet around the first match.

use std::fs;
use std::path::Path;

use serde::Serialize;

/// Text around a match, split so the match can be shown in bold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snippet {
    /// Text before the match.
    pub before: String,
    /// The matched text, as written in the file.
    pub hit: String,
    /// Text after the match.
    pub after: String,
}

/// How a file matched a search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TextMatch {
    /// How often the words occur in the text.
    pub matches: usize,
    /// Text around the first match, if the text (not just the title) matched.
    pub snippet: Option<Snippet>,
}

/// Searches the text of `items`, case-insensitively. Every word of the query
/// must occur (in any order; `"quoted words"` as a phrase), in the text or the
/// title. Items whose title has them all come first, then by number of
/// matches, then by title. At most `limit` results.
pub(crate) fn search<'a, T>(
    items: &'a [T],
    path: impl Fn(&T) -> &Path,
    title: impl Fn(&T) -> &str,
    query: &str,
    limit: usize,
) -> Vec<(&'a T, TextMatch)> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }
    // The snippet shows the most specific (longest) term found in the text.
    let mut by_length = terms.clone();
    by_length.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
    let mut hits: Vec<(bool, &T, TextMatch)> = items
        .iter()
        .filter_map(|item| {
            let text = fs::read_to_string(path(item)).ok()?;
            let lower = text.to_lowercase();
            let item_title = title(item).to_lowercase();
            let mut count = 0;
            for term in &terms {
                let n = lower.matches(term.as_str()).count();
                if n == 0 && !item_title.contains(term.as_str()) {
                    return None;
                }
                count += n;
            }
            let in_title = terms.iter().all(|t| item_title.contains(t.as_str()));
            let snippet = by_length.iter().find_map(|term| {
                let at = lower.find(term.as_str())?;
                snippet(&text, &lower, at, term.len())
            });
            Some((
                in_title,
                item,
                TextMatch {
                    matches: count,
                    snippet,
                },
            ))
        })
        .collect();
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.2.matches.cmp(&a.2.matches))
            .then_with(|| title(a.1).cmp(title(b.1)))
    });
    hits.into_iter()
        .take(limit)
        .map(|(_, item, found)| (item, found))
        .collect()
}

/// The lowercase terms of a search: words, and `"quoted phrases"` as one term.
/// One-letter words are dropped (they match nearly every file).
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

/// Some text either side of a match (more after than before, so the match
/// stays visible in a two-line preview), on one line, without Markdown noise.
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
    // Keep the space next to the match ("rendered preview Status", not "renderedpreviewStatus").
    let mut before = clean_snippet(&text[start..at]);
    if !before.is_empty() && text[..at].ends_with(char::is_whitespace) {
        before.push(' ');
    }
    let mut after = clean_snippet(&text[at + len..end]);
    if !after.is_empty() && text[at + len..].starts_with(char::is_whitespace) {
        after.insert(0, ' ');
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn snippets_keep_the_spaces_around_the_match() {
        let text = "a live rendered preview
Status line";
        let lower = text.to_lowercase();
        let at = lower.find("preview").unwrap_or_default();
        let found = snippet(text, &lower, at, 7).unwrap_or_else(|| unreachable!());
        assert_eq!(
            (
                found.before.as_str(),
                found.hit.as_str(),
                found.after.as_str()
            ),
            ("a live rendered ", "preview", " Status line")
        );
        let inside = snippet("C#Sharp", "c#sharp", 2, 5).unwrap_or_else(|| unreachable!());
        assert_eq!((inside.before.as_str(), inside.after.as_str()), ("C#", ""));
    }

    #[test]
    fn snippets_drop_markup_but_keep_csharp() {
        assert_eq!(
            clean_snippet("## Use the C# client\n> **bold** `code` | cell |"),
            "Use the C# client bold code cell"
        );
    }
}
