//! Code block rules: MD014, MD031, MD040, MD046.

use super::super::context::{CodeBlock, Ctx, quote_prefix};
use super::super::{Issue, TextEdit};
use super::{Params, indent_of};

pub(super) fn md014(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for block in &ctx.code_blocks {
        // (line, column of `$`, column after `$` and its spaces)
        let mut dollars = Vec::new();
        let mut all = true;
        for line in block.content_lines.clone() {
            let text = ctx.line_text(line);
            let prefix = quote_prefix(text).len();
            let col = prefix + indent_of(&text[prefix..]);
            let rest = &text[col..];
            if rest.is_empty() {
                continue;
            }
            match rest.strip_prefix('$') {
                Some(after) if after.starts_with([' ', '\t']) => {
                    dollars.push((line, col, col + 1 + indent_of(after)));
                }
                _ => {
                    all = false;
                    break;
                }
            }
        }
        if !all {
            continue;
        }
        for (line, from, to) in dollars {
            let mut issue = ctx.issue(
                "MD014",
                line,
                from,
                ctx.line_text(line).len(),
                "Dollar signs used before commands without showing output",
            );
            issue.fix = Some(vec![ctx.edit(line, from, to, "")]);
            out.push(issue);
        }
    }
}

pub(super) fn md031(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let list_items = params.bool(&["list_items"], true);
    let first_content = ctx.front_matter_lines + 1;
    for block in ctx.code_blocks.iter().filter(|b| b.fenced) {
        let in_list = ctx
            .lists
            .iter()
            .any(|l| l.start_line <= block.start_line && block.end_line <= l.end_line);
        if in_list && !list_items {
            continue;
        }
        if block.start_line > first_content
            && !ctx.starts_container(block.start_line, block.col)
            && !ctx.is_blank(block.start_line - 1)
        {
            let mut issue = ctx.line_issue(
                "MD031",
                block.start_line,
                "Fenced code blocks should be surrounded by blank lines",
            );
            issue.fix = Some(vec![ctx.insert_blank_before(block.start_line)]);
            out.push(issue);
        }
        if block.closed && block.end_line < ctx.line_count() && !ctx.is_blank(block.end_line + 1) {
            let mut issue = ctx.line_issue(
                "MD031",
                block.end_line,
                "Fenced code blocks should be surrounded by blank lines",
            );
            issue.fix = Some(vec![ctx.insert_blank_after(block.end_line)]);
            out.push(issue);
        }
    }
}

pub(super) fn md040(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    for block in ctx
        .code_blocks
        .iter()
        .filter(|b| b.fenced && b.info.trim().is_empty())
    {
        let fence_line = ctx.line_text(block.start_line);
        let len = fence_line.trim_end().len();
        let mut issue = ctx.issue(
            "MD040",
            block.start_line,
            block.col,
            len,
            "Fenced code blocks should have a language specified",
        );
        // Fixable only when the first line tells the language (`#!/bin/bash`, `<?xml`).
        let first_code = block
            .content_lines
            .clone()
            .next()
            .map(|line| ctx.line_text(line))
            .map(|text| text[quote_prefix(text).len()..].trim_start());
        if let Some(language) = first_code.and_then(crate::highlight::guess_fence_language) {
            let fence = &fence_line[block.col..];
            let marker = fence.len() - fence.trim_start_matches(['`', '~']).len();
            let at = block.col + marker;
            issue.fix = Some(vec![ctx.edit(block.start_line, at, at, language)]);
        }
        out.push(issue);
    }
}

pub(super) fn md046(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let style = params.str(&["style"], "consistent");
    let mut expected = match style {
        "fenced" => Some(true),
        "indented" => Some(false),
        _ => None,
    };
    for block in &ctx.code_blocks {
        let want = *expected.get_or_insert(block.fenced);
        if block.fenced != want {
            let (expected, actual) = if want {
                ("fenced", "indented")
            } else {
                ("indented", "fenced")
            };
            let mut issue = ctx.line_issue(
                "MD046",
                block.start_line,
                format!("Code block style (Expected: {expected}; Actual: {actual})"),
            );
            // Only indented → fenced: a fenced block can hold everything an
            // indented one can, but not the other way round (language, blank
            // lines at the start or end).
            if want {
                issue.fix = to_fenced(ctx, block);
            }
            out.push(issue);
        }
    }
}

/// Edits that turn an indented code block into a fenced one with the same
/// content: a fence line before and after, and 4 columns of indent removed
/// from every line. None when the layout is unusual (tabs in the indent, code
/// on a list marker line, lines laid out differently from the first).
fn to_fenced(ctx: &Ctx<'_>, block: &CodeBlock) -> Option<Vec<TextEdit>> {
    let col = block.col;
    let first = ctx.line_text(block.start_line);
    if col < 4 || ctx.starts_container(block.start_line, col) {
        return None;
    }
    let lead = first.get(..col)?;
    let container = &lead[..col - 4];
    if lead.contains('\t') || !lead[col - 4..].bytes().all(|b| b == b' ') {
        return None;
    }

    let mut longest_run = 0;
    let mut edits = Vec::new();
    for line in block.content_lines.clone() {
        let text = ctx.line_text(line);
        let blank = text[quote_prefix(text).len()..].trim().is_empty();
        if !blank {
            // A tab right after the indent may be partly indent (it can reach
            // past the 4 columns), which the byte column doesn't show.
            if text.get(..col) != Some(lead) || text[col..].starts_with('\t') {
                return None;
            }
            let code = &text[col..];
            let unindented = code.trim_start_matches(' ');
            if code.len() - unindented.len() <= 3 {
                let run = unindented.len() - unindented.trim_start_matches('`').len();
                longest_run = longest_run.max(run);
            }
        }
        // Blank lines lose their indent too (whitespace inside a fenced block is kept).
        let end = text.len().min(col);
        if end > col - 4 {
            if !text
                .get(col - 4..end)
                .is_some_and(|s| s.bytes().all(|b| b == b' '))
            {
                return None;
            }
            if line != block.start_line {
                edits.push(ctx.edit(line, col - 4, end, ""));
            }
        }
    }

    let fence = "`".repeat(if longest_run >= 3 { longest_run + 1 } else { 3 });
    edits.insert(
        0,
        ctx.edit(
            block.start_line,
            0,
            col,
            format!("{container}{fence}{}{container}", ctx.eol()),
        ),
    );
    let last = ctx.line_text(block.end_line).len();
    edits.push(ctx.edit(
        block.end_line,
        last,
        last,
        format!("{}{container}{fence}", ctx.eol()),
    ));
    Some(edits)
}
