//! Block quote and horizontal rule rules: MD027, MD028, MD035.

use std::collections::BTreeSet;

use comrak::nodes::NodeValue;

use super::super::Issue;
use super::super::context::{Ctx, Kind, quote_prefix};
use super::Params;

pub(super) fn md027(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    let mut lines = BTreeSet::new();
    for quote in &ctx.quotes {
        lines.extend(quote.start_line..=quote.end_line.min(ctx.line_count()));
    }
    for line in lines {
        // Code is indented on purpose, and list text is indented to line up with the item.
        let in_list = ctx
            .lists
            .iter()
            .any(|l| l.in_quote && l.start_line <= line && line <= l.end_line);
        if ctx.kind(line) != Kind::Text || in_list {
            continue;
        }
        let text = ctx.line_text(line);
        let prefix = quote_prefix(text);
        let Some(last) = prefix.rfind('>') else {
            continue;
        };
        let after = &text[last + 1..];
        let spaces = after.len() - after.trim_start_matches(' ').len();
        if spaces < 2 || after.trim().is_empty() {
            continue;
        }
        let from = last + 1;
        let mut issue = ctx.issue(
            "MD027",
            line,
            from,
            from + spaces,
            "Multiple spaces after blockquote symbol",
        );
        issue.fix = Some(vec![ctx.edit(line, from, from + spaces, " ")]);
        out.push(issue);
    }
}

pub(super) fn md028(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    let mut reported = BTreeSet::new();
    for (i, first) in ctx.quotes.iter().enumerate() {
        // The next quote that starts after this one ends.
        let Some(next) = ctx.quotes[i + 1..]
            .iter()
            .find(|q| q.start_line > first.end_line)
        else {
            continue;
        };
        let between = first.end_line + 1..next.start_line;
        if between.is_empty() || !between.clone().all(|n| ctx.line_text(n).trim().is_empty()) {
            continue;
        }
        for line in between {
            if reported.insert(line) {
                out.push(ctx.issue("MD028", line, 0, 0, "Blank line inside blockquote"));
            }
        }
    }
}

pub(super) fn md035(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let configured = params.str(&["style"], "consistent");
    let mut expected: Option<String> = (configured != "consistent").then(|| configured.to_owned());
    for node in ctx.root.descendants() {
        let data = node.data.borrow();
        if !matches!(data.value, NodeValue::ThematicBreak) {
            continue;
        }
        let line = data.sourcepos.start.line;
        let text = ctx.line_text(line);
        let from = quote_prefix(text).len();
        let from = from + (text.len() - from - text[from..].trim_start().len());
        let rule = text[from..].trim_end();
        let want = expected.get_or_insert_with(|| rule.to_owned()).clone();
        if rule != want {
            let mut issue = ctx.issue(
                "MD035",
                line,
                from,
                from + rule.len(),
                format!("Horizontal rule style (Expected: {want}; Actual: {rule})"),
            );
            issue.fix = Some(vec![ctx.edit(line, from, from + rule.len(), want)]);
            out.push(issue);
        }
    }
}
