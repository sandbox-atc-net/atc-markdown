//! Inline rules: MD011, MD033, MD034, MD037, MD038, MD039.
//!
//! These scan text lines with inline code and escapes masked out, because the
//! mistakes they look for are often not parsed as the intended construct.

use super::super::Issue;
use super::super::context::{Ctx, Kind};
use super::Params;

/// Lines to scan: ordinary Markdown text.
fn text_lines<'c>(ctx: &'c Ctx<'_>) -> impl Iterator<Item = usize> + 'c {
    (1..=ctx.line_count()).filter(|&n| ctx.is_text(n))
}

pub(super) fn md011(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for line in text_lines(ctx) {
        let masked = ctx.masked(line);
        let bytes = masked.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'(' {
                i += 1;
                continue;
            }
            let Some(close) = bytes[i + 1..].iter().position(|&b| b == b')' || b == b'(') else {
                break;
            };
            let close = i + 1 + close;
            if bytes[close] == b'(' || close == i + 1 || bytes.get(close + 1) != Some(&b'[') {
                i = close.max(i + 1);
                continue;
            }
            let url_start = close + 2;
            if matches!(bytes.get(url_start), Some(b'^' | b']') | None) {
                i = close + 1;
                continue;
            }
            let Some(end) = bytes[url_start..].iter().position(|&b| b == b']') else {
                break;
            };
            let end = url_start + end;
            if bytes.get(end + 1) == Some(&b'(') {
                i = end + 1;
                continue;
            }
            let text = ctx.line_text(line);
            let label = &text[i + 1..close];
            let url = &text[url_start..end];
            let mut issue = ctx.issue(
                "MD011",
                line,
                i,
                end + 1,
                format!("Reversed link syntax: {}", &text[i..=end]),
            );
            issue.fix = Some(vec![ctx.edit(
                line,
                i,
                end + 1,
                format!("[{label}]({url})"),
            )]);
            out.push(issue);
            i = end + 1;
        }
    }
}

pub(super) fn md033(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let allowed: Vec<String> = params
        .list(&["allowed_elements"])
        .into_iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    for line in 1..=ctx.line_count() {
        if !matches!(ctx.kind(line), Kind::Text | Kind::Html) {
            continue;
        }
        let masked = ctx.masked(line);
        let bytes = masked.as_bytes();
        for i in 0..bytes.len() {
            if bytes[i] != b'<' || !bytes.get(i + 1).is_some_and(u8::is_ascii_alphabetic) {
                continue;
            }
            let name_len = bytes[i + 1..]
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric() || **b == b'-')
                .count();
            let after = bytes.get(i + 1 + name_len);
            // `<https://…>` and `<me@example.com>` are autolinks, not HTML.
            if !matches!(after, None | Some(b' ' | b'\t' | b'>' | b'/')) {
                continue;
            }
            let name = masked[i + 1..i + 1 + name_len].to_ascii_lowercase();
            if allowed.contains(&name) {
                continue;
            }
            let end = bytes[i..]
                .iter()
                .position(|&b| b == b'>')
                .map_or(i + 1 + name_len, |p| i + p + 1);
            out.push(ctx.issue(
                "MD033",
                line,
                i,
                end,
                format!("Inline HTML [Element: {name}]"),
            ));
        }
    }
}

/// Where a bare URL starting at `i` ends (trailing punctuation and unbalanced `)` excluded).
fn url_end(bytes: &[u8], i: usize) -> usize {
    let mut end = i;
    while end < bytes.len() && !matches!(bytes[end], b' ' | b'\t' | b'<' | b'>' | b'"' | b'`') {
        end += 1;
    }
    loop {
        match bytes[i..end].last() {
            Some(b'.' | b',' | b';' | b':' | b'!' | b'?' | b'*' | b'_' | b'~' | b'\'') => end -= 1,
            Some(b')') => {
                let balance = bytes[i..end].iter().fold(0_i32, |n, &b| match b {
                    b'(' => n + 1,
                    b')' => n - 1,
                    _ => n,
                });
                if balance < 0 {
                    end -= 1;
                } else {
                    break;
                }
            }
            _ => break,
        }
    }
    end
}

/// True if position `i` is inside `[link text]` that is followed by `(` or `[`,
/// or inside an HTML tag.
fn in_link_text_or_tag(bytes: &[u8], i: usize) -> bool {
    let before = &bytes[..i];
    if let Some(open) = before.iter().rposition(|&b| b == b'<')
        && !before[open..].contains(&b'>')
        && bytes
            .get(open + 1)
            .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'/')
    {
        return true;
    }
    let Some(open) = before.iter().rposition(|&b| b == b'[') else {
        return false;
    };
    if before[open..].contains(&b']') {
        return false;
    }
    bytes[i..]
        .iter()
        .position(|&b| b == b']')
        .is_some_and(|close| matches!(bytes.get(i + close + 1), Some(b'(' | b'[')))
}

pub(super) fn md034(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let allow_quoted = params.bool(&["allow_quoted"], false);
    for line in text_lines(ctx) {
        let masked = ctx.masked(line);
        let bytes = masked.as_bytes();
        // `[id]: https://…` reference definitions.
        let trimmed = masked.trim_start();
        let definition = trimmed.starts_with('[') && trimmed.contains("]:");
        let mut i = 0;
        while i < bytes.len() {
            let rest = &bytes[i..];
            let scheme = ["https://", "http://", "ftp://"].iter().find(|s| {
                rest.len() >= s.len() && rest[..s.len()].eq_ignore_ascii_case(s.as_bytes())
            });
            let Some(scheme) = scheme else {
                i += 1;
                continue;
            };
            let end = url_end(bytes, i);
            let prev = i.checked_sub(1).map(|p| bytes[p]);
            let prev2 = i.checked_sub(2).map(|p| bytes[p]);
            let word_start = !prev.is_some_and(|b| b.is_ascii_alphanumeric());
            let skip = !word_start
                || definition
                || matches!(prev, Some(b'<' | b'=' | b'/'))
                || (prev == Some(b'(') && prev2 == Some(b']'))
                || (allow_quoted && matches!(prev, Some(b'"' | b'\'')))
                || end <= i + scheme.len()
                || in_link_text_or_tag(bytes, i);
            if !skip {
                let url = &ctx.line_text(line)[i..end];
                let mut issue = ctx.issue("MD034", line, i, end, format!("Bare URL used: {url}"));
                issue.fix = Some(vec![ctx.edit(line, i, end, format!("<{url}>"))]);
                out.push(issue);
            }
            i = end.max(i + 1);
        }
    }
}

/// A run of `*` or `_` at `i`: (char, length).
fn marker_run(bytes: &[u8], i: usize) -> Option<(u8, usize)> {
    let c = *bytes.get(i)?;
    if c != b'*' && c != b'_' {
        return None;
    }
    if i > 0 && bytes[i - 1] == c {
        return None;
    }
    Some((c, bytes[i..].iter().take_while(|&&b| b == c).count()))
}

fn is_space(b: Option<&u8>) -> bool {
    matches!(b, Some(b' ' | b'\t'))
}

/// Start/end of a word: nothing, whitespace or punctuation.
fn is_boundary(b: Option<&u8>) -> bool {
    b.is_none_or(|b| {
        b.is_ascii_whitespace() || (b.is_ascii_punctuation() && *b != b'*' && *b != b'_')
    })
}

pub(super) fn md037(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for line in text_lines(ctx) {
        let masked = ctx.masked(line);
        let bytes = masked.as_bytes();
        let content_start = super::super::context::quote_prefix(&masked).len();
        let first = content_start + super::indent_of(&masked[content_start..]);
        // A thematic break (`* * *`) is not emphasis.
        if masked[first..]
            .bytes()
            .all(|b| matches!(b, b'*' | b'_' | b'-' | b' ' | b'\t'))
        {
            continue;
        }
        let mut i = first;
        // Skip a list marker at the start of the line.
        if matches!(bytes.get(i), Some(b'*' | b'-' | b'+')) && is_space(bytes.get(i + 1)) {
            i += 2;
        }
        while i < bytes.len() {
            let Some((c, n)) = marker_run(bytes, i) else {
                i += 1;
                continue;
            };
            if n > 3 || !is_boundary(i.checked_sub(1).and_then(|p| bytes.get(p))) {
                i += n;
                continue;
            }
            let inner_start = i + n;
            // The next run of the same marker and length closes it.
            let mut j = inner_start;
            let mut close = None;
            while j < bytes.len() {
                if let Some((c2, n2)) = marker_run(bytes, j) {
                    if c2 == c && n2 == n {
                        close = Some(j);
                        break;
                    }
                    j += n2;
                } else {
                    j += 1;
                }
            }
            let Some(close) = close else { break };
            let inner = &masked[inner_start..close];
            let lead = inner.len() - inner.trim_start().len();
            let trail = inner.len() - inner.trim_end().len();
            let closes_word = is_boundary(bytes.get(close + n));
            if inner.trim().is_empty() || !closes_word || (lead == 0 && trail == 0) {
                i = if closes_word { close + n } else { inner_start };
                continue;
            }
            let mut issue = ctx.issue(
                "MD037",
                line,
                i,
                close + n,
                format!(
                    "Spaces inside emphasis markers: {}",
                    &ctx.line_text(line)[i..close + n]
                ),
            );
            let mut edits = Vec::new();
            if lead > 0 {
                edits.push(ctx.edit(line, inner_start, inner_start + lead, ""));
            }
            if trail > 0 {
                edits.push(ctx.edit(line, close - trail, close, ""));
            }
            issue.fix = Some(edits);
            out.push(issue);
            i = close + n;
        }
    }
}

pub(super) fn md038(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for line in text_lines(ctx) {
        let text = ctx.line_text(line);
        for &(from, to) in ctx.code_spans(line) {
            let run = text[from..to].bytes().take_while(|&b| b == b'`').count();
            let inner_start = from + run;
            let inner_end = to - run;
            let inner = &text[inner_start..inner_end];
            if inner.trim().is_empty() {
                continue;
            }
            let lead = inner.len() - inner.trim_start().len();
            let trail = inner.len() - inner.trim_end().len();
            if lead == 0 && trail == 0 {
                continue;
            }
            // One space on each side is needed when the code starts or ends with a backtick.
            let core = inner.trim();
            let padded = lead == 1 && trail == 1 && (core.starts_with('`') || core.ends_with('`'));
            if padded {
                continue;
            }
            let keep = usize::from(core.starts_with('`') || core.ends_with('`'));
            let mut issue = ctx.issue(
                "MD038",
                line,
                from,
                to,
                format!("Spaces inside code span elements: {}", &text[from..to]),
            );
            let mut edits = Vec::new();
            if lead > keep {
                edits.push(ctx.edit(line, inner_start, inner_start + lead - keep, ""));
            }
            if trail > keep {
                edits.push(ctx.edit(line, inner_end - trail + keep, inner_end, ""));
            }
            issue.fix = Some(edits);
            out.push(issue);
        }
    }
}

pub(super) fn md039(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for line in text_lines(ctx) {
        let masked = ctx.masked(line);
        let bytes = masked.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let is_link = bytes[i] == b'['
                && (i == 0 || bytes[i - 1] != b'!')
                && bytes.get(i + 1) != Some(&b'^');
            if !is_link {
                i += 1;
                continue;
            }
            // The matching `]`, allowing nested brackets (images in links).
            let mut depth = 0;
            let mut close = None;
            for (k, &b) in bytes.iter().enumerate().skip(i) {
                match b {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(k);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(close) = close else { break };
            if !matches!(bytes.get(close + 1), Some(b'(' | b'[')) {
                i += 1;
                continue;
            }
            let inner = &masked[i + 1..close];
            let lead = inner.len() - inner.trim_start().len();
            let trail = inner.len() - inner.trim_end().len();
            if !inner.trim().is_empty() && (lead > 0 || trail > 0) {
                let mut issue = ctx.issue(
                    "MD039",
                    line,
                    i,
                    close + 1,
                    format!(
                        "Spaces inside link text: {}",
                        &ctx.line_text(line)[i..=close]
                    ),
                );
                let mut edits = Vec::new();
                if lead > 0 {
                    edits.push(ctx.edit(line, i + 1, i + 1 + lead, ""));
                }
                if trail > 0 {
                    edits.push(ctx.edit(line, close - trail, close, ""));
                }
                issue.fix = Some(edits);
                out.push(issue);
            }
            i += 1;
        }
    }
}
