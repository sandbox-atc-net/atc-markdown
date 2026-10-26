//! List rules: MD004–MD007, MD029, MD030, MD032.

use std::collections::HashMap;

use super::super::Issue;
use super::super::context::{Ctx, Item, List};
use super::Params;

fn marker_issue(
    ctx: &Ctx<'_>,
    rule: &'static str,
    item: &Item,
    message: impl Into<String>,
) -> Issue {
    ctx.issue(
        rule,
        item.line,
        item.col,
        item.col + item.marker_len,
        message,
    )
}

fn style_name(marker: char) -> &'static str {
    match marker {
        '*' => "asterisk",
        '+' => "plus",
        _ => "dash",
    }
}

pub(super) fn md004(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let style = params.str(&["style"], "consistent");
    let fixed = match style {
        "asterisk" => Some('*'),
        "plus" => Some('+'),
        "dash" => Some('-'),
        _ => None,
    };
    let mut first: Option<char> = None;
    let mut per_level: HashMap<usize, char> = HashMap::new();
    for list in ctx.lists.iter().filter(|l| !l.ordered) {
        for item in &list.items {
            let expected = match (fixed, style) {
                (Some(c), _) => c,
                (None, "sublist") => *per_level.entry(list.depth).or_insert(item.marker),
                _ => *first.get_or_insert(item.marker),
            };
            if item.marker != expected {
                let mut issue = marker_issue(
                    ctx,
                    "MD004",
                    item,
                    format!(
                        "Expected: {}; Actual: {}",
                        style_name(expected),
                        style_name(item.marker)
                    ),
                );
                issue.fix = Some(vec![ctx.edit(
                    item.line,
                    item.col,
                    item.col + 1,
                    expected.to_string(),
                )]);
                out.push(issue);
            }
        }
    }
}

/// An edit that moves an item's marker to `col` (only for lines without a quote prefix).
fn reindent(ctx: &Ctx<'_>, item: &Item, col: usize) -> Option<Vec<super::super::TextEdit>> {
    let before = &ctx.line_text(item.line)[..item.col];
    before
        .bytes()
        .all(|b| b == b' ')
        .then(|| vec![ctx.edit(item.line, 0, item.col, " ".repeat(col))])
}

pub(super) fn md005(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for list in &ctx.lists {
        let Some(first) = list.items.first() else {
            continue;
        };
        for item in &list.items[1..] {
            let aligned_start = item.col == first.col;
            // Ordered lists may right-align their numbers (` 9.` / `10.`).
            let aligned_end =
                list.ordered && item.col + item.marker_len == first.col + first.marker_len;
            if aligned_start || aligned_end {
                continue;
            }
            let mut issue = marker_issue(
                ctx,
                "MD005",
                item,
                format!("Expected indentation: {}; Actual: {}", first.col, item.col),
            );
            issue.fix = reindent(ctx, item, first.col);
            out.push(issue);
        }
    }
}

pub(super) fn md006(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for list in ctx.lists.iter().filter(|l| l.top_level && !l.ordered) {
        if let Some(item) = list.items.first()
            && item.col > 0
        {
            out.push(marker_issue(
                ctx,
                "MD006",
                item,
                "List doesn't start at the beginning of the line",
            ));
        }
    }
}

pub(super) fn md007(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let indent = params.usize(&["indent"], 2);
    let start = if params.bool(&["start_indented"], false) {
        params.usize(&["start_indent"], indent)
    } else {
        0
    };
    for list in ctx
        .lists
        .iter()
        .filter(|l| !l.ordered && l.only_bullet_parents)
    {
        let expected = start + list.depth * indent;
        for item in &list.items {
            if item.col != expected {
                let mut issue = marker_issue(
                    ctx,
                    "MD007",
                    item,
                    format!("Expected indentation: {expected}; Actual: {}", item.col),
                );
                issue.fix = reindent(ctx, item, expected);
                out.push(issue);
            }
        }
    }
}

pub(super) fn md029(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let style = params.str(&["style"], "one_or_ordered");
    for list in ctx.lists.iter().filter(|l| l.ordered) {
        let numbers: Vec<u64> = list.items.iter().map(|i| i.number.unwrap_or(1)).collect();
        let Some(&first) = numbers.first() else {
            continue;
        };
        let same = numbers
            .get(1)
            .is_some_and(|&second| second == first && first <= 1);
        let expected = |index: u64| -> u64 {
            match style {
                "one" => 1,
                "zero" => 0,
                "ordered" => first + index,
                _ if same => first,
                _ => first + index,
            }
        };
        for (index, (item, &number)) in list.items.iter().zip(&numbers).enumerate() {
            let want = expected(index as u64);
            if number == want {
                continue;
            }
            let digits = item.marker_len - 1;
            let mut issue = ctx.issue(
                "MD029",
                item.line,
                item.col,
                item.col + digits,
                format!("Ordered list item prefix. Expected: {want}; Actual: {number}"),
            );
            issue.fix = Some(vec![ctx.edit(
                item.line,
                item.col,
                item.col + digits,
                want.to_string(),
            )]);
            out.push(issue);
        }
    }
}

fn is_multi(list: &List) -> bool {
    list.items.iter().any(|i| i.blocks > 1)
}

pub(super) fn md030(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    for list in &ctx.lists {
        let multi = is_multi(list);
        let key = match (list.ordered, multi) {
            (false, false) => "ul_single",
            (true, false) => "ol_single",
            (false, true) => "ul_multi",
            (true, true) => "ol_multi",
        };
        let expected = params.usize(&[key], 1);
        for item in &list.items {
            let Some(actual) = item.spaces_after else {
                continue;
            };
            // Five or more spaces start an indented code block inside the item.
            if actual == expected || actual >= 5 {
                continue;
            }
            let from = item.col + item.marker_len;
            let mut issue = ctx.issue(
                "MD030",
                item.line,
                from,
                from + actual,
                format!("Spaces after list markers. Expected: {expected}; Actual: {actual}"),
            );
            // Changing the space moves the item's text; only safe for one-block items.
            if item.blocks <= 1 {
                issue.fix = Some(vec![ctx.edit(
                    item.line,
                    from,
                    from + actual,
                    " ".repeat(expected),
                )]);
            }
            out.push(issue);
        }
    }
}

pub(super) fn md032(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    let first_content = ctx.front_matter_lines + 1;
    for list in ctx.lists.iter().filter(|l| !l.in_item) {
        let Some(first) = list.items.first() else {
            continue;
        };
        if list.start_line > first_content
            && !ctx.starts_container(first.line, first.col)
            && !ctx.is_blank(list.start_line - 1)
        {
            let mut issue = ctx.line_issue(
                "MD032",
                list.start_line,
                "Lists should be surrounded by blank lines",
            );
            issue.fix = Some(vec![ctx.insert_blank_before(list.start_line)]);
            out.push(issue);
        }
        // The list's range may include blank lines after it.
        let mut end = list.end_line.min(ctx.line_count());
        while end > list.start_line && ctx.is_blank(end) {
            end -= 1;
        }
        if end < ctx.line_count() && !ctx.is_blank(end + 1) {
            let mut issue =
                ctx.line_issue("MD032", end, "Lists should be surrounded by blank lines");
            issue.fix = Some(vec![ctx.insert_blank_after(end)]);
            out.push(issue);
        }
    }
}
