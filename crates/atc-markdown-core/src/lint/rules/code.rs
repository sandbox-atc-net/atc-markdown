//! Code block rules: MD014, MD031, MD040, MD046.

use super::super::Issue;
use super::super::context::{Ctx, quote_prefix};
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
        let len = ctx.line_text(block.start_line).trim_end().len();
        out.push(ctx.issue(
            "MD040",
            block.start_line,
            block.col,
            len,
            "Fenced code blocks should have a language specified",
        ));
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
            out.push(ctx.line_issue(
                "MD046",
                block.start_line,
                format!("Code block style (Expected: {expected}; Actual: {actual})"),
            ));
        }
    }
}
