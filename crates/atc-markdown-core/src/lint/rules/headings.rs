//! Heading rules: MD001–MD003, MD018–MD026, MD036, MD041.

use std::collections::HashSet;

use comrak::nodes::NodeValue;

use super::super::context::{Ctx, Heading};
use super::super::{Issue, TextEdit};
use super::{Params, indent_of};

/// The parts of an ATX heading line: `##  Text  ##`.
#[derive(Debug)]
struct Atx {
    /// Column of the first `#`.
    col: usize,
    hashes: usize,
    /// Spaces/tabs after the opening hashes.
    left_spaces: usize,
    /// Columns of the text (without surrounding spaces).
    text_from: usize,
    text_to: usize,
    /// Spaces before the closing hashes, and the closing hashes (0 if none).
    right_spaces: usize,
    closing: usize,
}

/// Splits a line that starts (after `col`) with `#` into its parts.
fn atx_parts(line: &str, col: usize) -> Option<Atx> {
    let rest = line.get(col..)?;
    let hashes = rest.bytes().take_while(|&b| b == b'#').count();
    if hashes == 0 {
        return None;
    }
    let after = &rest[hashes..];
    let left_spaces = indent_of(after);
    let body = after.trim_end_matches([' ', '\t']);
    let body_end = col + hashes + body.len();
    let inner = body.trim_end_matches('#');
    let mut closing = body.len() - inner.len();
    let trimmed_inner = inner.trim_end_matches([' ', '\t']);
    let mut right_spaces = inner.len() - trimmed_inner.len();
    // `\#` is a literal hash, and hashes need a space before them to close the heading
    // (except when we are looking for exactly that mistake, which MD020 handles).
    if closing > 0 && trimmed_inner.ends_with('\\') {
        closing = 0;
        right_spaces = 0;
    }
    let text_from = col + hashes + left_spaces;
    let text_to = if closing > 0 {
        body_end - closing - right_spaces
    } else {
        body_end
    };
    Some(Atx {
        col,
        hashes,
        left_spaces,
        text_from,
        text_to: text_to.max(text_from),
        right_spaces,
        closing,
    })
}

/// Lines where a heading starts, for rules that scan text lines.
fn heading_lines(ctx: &Ctx<'_>) -> HashSet<usize> {
    ctx.headings.iter().map(|h| h.start_line).collect()
}

fn heading_issue(
    ctx: &Ctx<'_>,
    rule: &'static str,
    h: &Heading,
    message: impl Into<String>,
) -> Issue {
    let line = ctx.line_text(h.start_line);
    ctx.issue(rule, h.start_line, h.col, line.trim_end().len(), message)
}

/// The top-level heading is already there: the wiki page title, or `title:` in front matter.
fn has_external_title(ctx: &Ctx<'_>) -> bool {
    ctx.wiki || ctx.front_matter_title
}

pub(super) fn md001(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    let mut previous: Option<u8> = has_external_title(ctx).then_some(1);
    for h in &ctx.headings {
        if let Some(prev) = previous
            && h.level > prev + 1
        {
            out.push(heading_issue(
                ctx,
                "MD001",
                h,
                format!("Expected: h{}; Actual: h{}", prev + 1, h.level),
            ));
        }
        previous = Some(h.level);
    }
}

pub(super) fn md002(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    if has_external_title(ctx) {
        return;
    }
    let level = params.usize(&["level"], 1);
    if let Some(h) = ctx.headings.first()
        && usize::from(h.level) != level
    {
        out.push(heading_issue(
            ctx,
            "MD002",
            h,
            format!("Expected: h{level}; Actual: h{}", h.level),
        ));
    }
}

fn style_of(h: &Heading) -> &'static str {
    if h.setext {
        "setext"
    } else if h.closed {
        "atx_closed"
    } else {
        "atx"
    }
}

pub(super) fn md003(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let mut style = params.str(&["style"], "consistent");
    if style == "consistent" {
        let Some(first) = ctx.headings.first() else {
            return;
        };
        style = match style_of(first) {
            // Levels 3–6 can't be setext, so atx is fine there.
            "setext" => "setext_with_atx",
            other => other,
        };
    }
    for h in &ctx.headings {
        let actual = style_of(h);
        let small = h.level > 2;
        let expected = match style {
            "atx" => "atx",
            "atx_closed" => "atx_closed",
            "setext" | "setext_with_atx" if small => {
                if actual == "setext" {
                    "atx"
                } else {
                    actual
                }
            }
            "setext_with_atx_closed" if small => "atx_closed",
            "setext" | "setext_with_atx" | "setext_with_atx_closed" => "setext",
            _ => return,
        };
        if actual == expected {
            continue;
        }
        let mut issue = heading_issue(
            ctx,
            "MD003",
            h,
            format!("Expected: {expected}; Actual: {actual}"),
        );
        issue.fix = convert_heading(ctx, h, expected);
        out.push(issue);
    }
}

/// Edits that rewrite a heading in another style.
fn convert_heading(ctx: &Ctx<'_>, h: &Heading, to: &str) -> Option<Vec<TextEdit>> {
    let line = ctx.line_text(h.start_line);
    let hashes = "#".repeat(usize::from(h.level));
    if h.setext {
        // Single-line setext text only.
        if h.end_line != h.start_line + 1 {
            return None;
        }
        let text = line[h.col..].trim_end();
        let heading = match to {
            "atx" => format!("{hashes} {text}"),
            "atx_closed" => format!("{hashes} {text} {hashes}"),
            _ => return None,
        };
        let underline_end = ctx.offset(h.end_line, ctx.line_text(h.end_line).len());
        return Some(vec![TextEdit {
            start: ctx.offset(h.start_line, h.col),
            end: underline_end,
            insert: heading,
        }]);
    }
    let atx = atx_parts(line, h.col)?;
    let text = &line[atx.text_from..atx.text_to];
    let heading = match to {
        "atx" => format!("{hashes} {text}"),
        "atx_closed" => format!("{hashes} {text} {hashes}"),
        "setext" if h.level <= 2 => {
            let mark = if h.level == 1 { "=" } else { "-" };
            let prefix = super::super::context::quote_prefix(line);
            format!(
                "{text}\n{prefix}{}",
                mark.repeat(text.chars().count().max(3))
            )
        }
        _ => return None,
    };
    Some(vec![ctx.edit(
        h.start_line,
        h.col,
        line.trim_end().len(),
        heading,
    )])
}

pub(super) fn md018(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    let headings = heading_lines(ctx);
    for line in 1..=ctx.line_count() {
        if !ctx.is_text(line) || headings.contains(&line) || ctx.table_lines[line - 1] {
            continue;
        }
        let text = ctx.line_text(line);
        let col = super::super::context::quote_prefix(text).len();
        let col = col + indent_of(&text[col..]);
        let rest = &text[col..];
        let hashes = rest.bytes().take_while(|&b| b == b'#').count();
        if !(1..=6).contains(&hashes) {
            continue;
        }
        let Some(next) = rest[hashes..].chars().next() else {
            continue;
        };
        // `#Heading#` is MD020; the keycap emoji `#️⃣` is not a heading.
        if next.is_whitespace()
            || rest.trim_end().ends_with('#')
            || next == '\u{fe0f}'
            || next == '\u{20e3}'
        {
            continue;
        }
        let mut issue = ctx.issue("MD018", line, col, text.len(), "No space after the hash");
        issue.fix = Some(vec![ctx.edit(line, col + hashes, col + hashes, " ")]);
        out.push(issue);
    }
}

pub(super) fn md019(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for h in ctx.headings.iter().filter(|h| !h.setext && !h.closed) {
        let line = ctx.line_text(h.start_line);
        let Some(atx) = atx_parts(line, h.col) else {
            continue;
        };
        if atx.left_spaces > 1 && atx.text_to > atx.text_from {
            let from = atx.col + atx.hashes;
            let mut issue = ctx.issue(
                "MD019",
                h.start_line,
                from,
                atx.text_from,
                "Multiple spaces after the hash",
            );
            issue.fix = Some(vec![ctx.edit(h.start_line, from, atx.text_from, " ")]);
            out.push(issue);
        }
    }
}

pub(super) fn md020(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for line in 1..=ctx.line_count() {
        if !ctx.is_text(line) || ctx.table_lines[line - 1] {
            continue;
        }
        let text = ctx.line_text(line);
        let col = super::super::context::quote_prefix(text).len();
        let col = col + indent_of(&text[col..]);
        if !text[col..].starts_with('#') {
            continue;
        }
        let rest = text[col..].trim_end();
        let hashes = rest.bytes().take_while(|&b| b == b'#').count();
        let inner = rest[hashes..].trim_end_matches('#');
        let closing = rest.len() - hashes - inner.len();
        let content = inner.trim_matches([' ', '\t']);
        if closing == 0 || content.is_empty() || content.ends_with('\\') {
            continue;
        }
        let left = indent_of(inner);
        let right = inner.len() - inner.trim_end_matches([' ', '\t']).len();
        if left > 0 && right > 0 {
            continue;
        }
        let mut issue = ctx.issue(
            "MD020",
            line,
            col,
            col + rest.len(),
            "No space inside the hashes",
        );
        let open = col + hashes;
        let close = col + hashes + inner.len();
        let mut edits = Vec::new();
        if left == 0 {
            edits.push(ctx.edit(line, open, open, " "));
        }
        if right == 0 {
            edits.push(ctx.edit(line, close, close, " "));
        }
        issue.fix = Some(edits);
        out.push(issue);
    }
}

pub(super) fn md021(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for h in ctx.headings.iter().filter(|h| h.closed && !h.setext) {
        let line = ctx.line_text(h.start_line);
        let Some(atx) = atx_parts(line, h.col) else {
            continue;
        };
        if atx.closing == 0 || (atx.left_spaces <= 1 && atx.right_spaces <= 1) {
            continue;
        }
        let mut issue = heading_issue(ctx, "MD021", h, "Multiple spaces inside the hashes");
        let mut edits = Vec::new();
        if atx.left_spaces > 1 {
            edits.push(ctx.edit(h.start_line, atx.col + atx.hashes, atx.text_from, " "));
        }
        if atx.right_spaces > 1 {
            edits.push(ctx.edit(
                h.start_line,
                atx.text_to,
                atx.text_to + atx.right_spaces,
                " ",
            ));
        }
        issue.fix = Some(edits);
        out.push(issue);
    }
}

pub(super) fn md022(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let above = params.usize(&["lines_above"], 1);
    let below = params.usize(&["lines_below"], 1);
    for h in &ctx.headings {
        let first_content = ctx.front_matter_lines + 1;
        if above > 0 && h.start_line > first_content && !ctx.starts_container(h.start_line, h.col) {
            let blanks = (1..=above)
                .take_while(|&n| {
                    h.start_line > n
                        && h.start_line - n >= first_content
                        && ctx.is_blank(h.start_line - n)
                })
                .count();
            let at_top = h.start_line - blanks <= first_content;
            if blanks < above && !at_top {
                let mut issue = heading_issue(
                    ctx,
                    "MD022",
                    h,
                    format!("Expected: {above} blank line above"),
                );
                issue.fix = Some(vec![ctx.insert_blank_before(h.start_line)]);
                out.push(issue);
            }
        }
        if below > 0 && h.end_line < ctx.line_count() {
            let blanks = (1..=below)
                .take_while(|&n| h.end_line + n <= ctx.line_count() && ctx.is_blank(h.end_line + n))
                .count();
            let at_end = h.end_line + blanks >= ctx.line_count();
            if blanks < below && !at_end {
                let mut issue = heading_issue(
                    ctx,
                    "MD022",
                    h,
                    format!("Expected: {below} blank line below"),
                );
                issue.fix = Some(vec![ctx.insert_blank_after(h.end_line)]);
                out.push(issue);
            }
        }
    }
}

pub(super) fn md023(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for h in ctx.headings.iter().filter(|h| h.top_level && h.col > 0) {
        let mut issue = heading_issue(ctx, "MD023", h, "Heading is indented");
        let mut edits = vec![ctx.edit(h.start_line, 0, h.col, "")];
        if h.setext {
            for line in h.start_line + 1..=h.end_line {
                let indent = indent_of(ctx.line_text(line));
                if indent > 0 {
                    edits.push(ctx.edit(line, 0, indent, ""));
                }
            }
        }
        issue.fix = Some(edits);
        out.push(issue);
    }
}

pub(super) fn md024(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let siblings_only = params.bool(&["siblings_only", "allow_different_nesting"], false);
    let mut seen: HashSet<(Option<usize>, String)> = HashSet::new();
    // Index of the heading each level currently sits under.
    let mut parents: Vec<(u8, usize)> = Vec::new();
    for (index, h) in ctx.headings.iter().enumerate() {
        while parents.last().is_some_and(|&(level, _)| level >= h.level) {
            parents.pop();
        }
        let parent = if siblings_only {
            parents.last().map(|&(_, i)| i)
        } else {
            None
        };
        let text = h.text.trim().to_owned();
        if !text.is_empty() && !seen.insert((parent, text.clone())) {
            out.push(heading_issue(
                ctx,
                "MD024",
                h,
                format!("Duplicate heading: {text}"),
            ));
        }
        parents.push((h.level, index));
    }
}

pub(super) fn md025(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let level = params.usize(&["level"], 1);
    let first_line = (ctx.front_matter_lines + 1..=ctx.line_count()).find(|&n| !ctx.is_blank(n));
    let mut has_title = has_external_title(ctx);
    for h in ctx
        .headings
        .iter()
        .filter(|h| usize::from(h.level) == level)
    {
        if has_title {
            out.push(heading_issue(
                ctx,
                "MD025",
                h,
                format!("Multiple top-level headings (h{level}) in the same document"),
            ));
        } else if Some(h.start_line) == first_line {
            has_title = true;
        }
    }
}

const HEADING_PUNCTUATION: &str = ".,;:!。，；：！";

pub(super) fn md026(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let punctuation = params.str(&["punctuation"], HEADING_PUNCTUATION);
    for h in &ctx.headings {
        // The last line of the heading text, and where the text ends on it.
        let (line, end) = if h.setext {
            let line = h.end_line - 1;
            (line, ctx.line_text(line).trim_end().len())
        } else {
            let Some(atx) = atx_parts(ctx.line_text(h.start_line), h.col) else {
                continue;
            };
            (h.start_line, atx.text_to)
        };
        let text = &ctx.line_text(line)[..end];
        let trimmed = text.trim_end_matches(|c| punctuation.contains(c));
        if trimmed.len() == text.len() || trimmed.trim().is_empty() {
            continue;
        }
        // `&copy;` and `&#169;` end in `;` but are characters, not punctuation.
        if text.ends_with(';') && is_entity_end(text) {
            continue;
        }
        let found = &text[trimmed.len()..];
        let mut issue = ctx.issue(
            "MD026",
            line,
            trimmed.len(),
            end,
            format!("Trailing punctuation in heading: '{found}'"),
        );
        issue.fix = Some(vec![ctx.edit(line, trimmed.len(), end, "")]);
        out.push(issue);
    }
}

fn is_entity_end(text: &str) -> bool {
    let Some(amp) = text.rfind('&') else {
        return false;
    };
    let name = &text[amp + 1..text.len() - 1];
    !name.is_empty()
        && (name.bytes().all(|b| b.is_ascii_alphanumeric())
            || name.strip_prefix('#').is_some_and(|n| {
                let n = n.strip_prefix(['x', 'X']).unwrap_or(n);
                !n.is_empty() && n.bytes().all(|b| b.is_ascii_hexdigit())
            }))
}

const EMPHASIS_PUNCTUATION: &str = ".,;:!?。，；：！？";

pub(super) fn md036(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let punctuation = params.str(&["punctuation"], EMPHASIS_PUNCTUATION);
    for node in ctx.root.descendants() {
        let data = node.data.borrow();
        if !matches!(data.value, NodeValue::Paragraph) {
            continue;
        }
        let parent_ok = node.parent().is_some_and(|p| {
            matches!(
                p.data.borrow().value,
                NodeValue::Document | NodeValue::BlockQuote
            )
        });
        let mut children = node.children();
        let (Some(only), None) = (children.next(), children.next()) else {
            continue;
        };
        if !parent_ok
            || !matches!(
                only.data.borrow().value,
                NodeValue::Emph | NodeValue::Strong
            )
        {
            continue;
        }
        let mut inner = only.children();
        let (Some(text_node), None) = (inner.next(), inner.next()) else {
            continue;
        };
        let NodeValue::Text(text) = &text_node.data.borrow().value else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || text.ends_with(|c| punctuation.contains(c)) {
            continue;
        }
        let line = data.sourcepos.start.line;
        if data.sourcepos.end.line != line {
            continue;
        }
        let col = data.sourcepos.start.column.saturating_sub(1);
        out.push(ctx.issue(
            "MD036",
            line,
            col,
            ctx.line_text(line).trim_end().len(),
            format!("Emphasis used instead of a heading: {text}"),
        ));
    }
}

pub(super) fn md041(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    if has_external_title(ctx) {
        return;
    }
    let level = params.usize(&["level"], 1);
    let first = ctx
        .root
        .children()
        .find(|node| match &node.data.borrow().value {
            NodeValue::FrontMatter(_) => false,
            NodeValue::HtmlBlock(html) => {
                let t = html.literal.trim();
                !(t.starts_with("<!--") && t.ends_with("-->"))
            }
            _ => true,
        });
    let Some(first) = first else { return };
    let data = first.data.borrow();
    let ok = match &data.value {
        NodeValue::Heading(h) => usize::from(h.level) == level,
        NodeValue::HtmlBlock(html) => html
            .literal
            .trim_start()
            .get(..3)
            .is_some_and(|tag| tag.eq_ignore_ascii_case(&format!("<h{level}"))),
        _ => false,
    };
    if !ok {
        let line = data.sourcepos.start.line;
        out.push(ctx.line_issue(
            "MD041",
            line,
            format!("First line in a file should be a top-level heading (h{level})"),
        ));
    }
}
