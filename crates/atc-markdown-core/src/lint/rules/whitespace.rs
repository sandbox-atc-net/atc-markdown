//! Whitespace rules: MD009, MD010, MD012, MD013, MD047.

use super::super::Issue;
use super::super::context::{Ctx, Kind};
use super::Params;

pub(super) fn md009(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let br_spaces = params.usize(&["br_spaces"], 2);
    for line in 1..=ctx.line_count() {
        if !matches!(ctx.kind(line), Kind::Text | Kind::Html) {
            continue;
        }
        let text = ctx.line_text(line);
        let trimmed = text.trim_end_matches(' ');
        let spaces = text.len() - trimmed.len();
        if spaces == 0 {
            continue;
        }
        // Two (or `br_spaces`) spaces at the end of a text line are a line break.
        let line_break = br_spaces >= 2 && spaces == br_spaces && !trimmed.trim().is_empty();
        if line_break {
            continue;
        }
        let mut issue = ctx.issue(
            "MD009",
            line,
            trimmed.len(),
            text.len(),
            format!("Trailing spaces: {spaces}"),
        );
        // More spaces than needed for a line break: keep the break, drop the rest.
        let keeps_break = br_spaces >= 2
            && spaces > br_spaces
            && ctx.kind(line) == Kind::Text
            && !trimmed.trim().is_empty()
            && line < ctx.line_count()
            && !ctx.is_blank(line + 1);
        let keep = if keeps_break { br_spaces } else { 0 };
        issue.fix = Some(vec![ctx.edit(line, trimmed.len() + keep, text.len(), "")]);
        out.push(issue);
    }
}

pub(super) fn md010(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let code_blocks =
        params.bool(&["code_blocks"], true) && !params.bool(&["ignore_code_blocks"], false);
    let spaces_per_tab = params.usize(&["spaces_per_tab"], 4).max(1);
    for line in 1..=ctx.line_count() {
        match ctx.kind(line) {
            Kind::FrontMatter => continue,
            Kind::Code | Kind::Fence if !code_blocks => continue,
            _ => {}
        }
        let text = ctx.line_text(line);
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'\t' {
                i += 1;
                continue;
            }
            let run = bytes[i..].iter().take_while(|&&b| b == b'\t').count();
            let mut issue = ctx.issue("MD010", line, i, i + run, "Hard tab");
            issue.fix = Some(vec![ctx.edit(
                line,
                i,
                i + run,
                " ".repeat(run * spaces_per_tab),
            )]);
            out.push(issue);
            i += run;
        }
    }
}

pub(super) fn md012(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let maximum = params.usize(&["maximum"], 1);
    let mut run = 0;
    for line in 1..=ctx.line_count() {
        let blank = ctx.kind(line) == Kind::Text && ctx.line_text(line).trim().is_empty();
        if !blank {
            run = 0;
            continue;
        }
        run += 1;
        if run > maximum {
            let mut issue = ctx.issue(
                "MD012",
                line,
                0,
                0,
                format!("Multiple consecutive blank lines (Expected: {maximum}; Actual: {run})"),
            );
            issue.fix = Some(vec![super::super::TextEdit {
                start: ctx.offset(line, 0),
                end: ctx.offset(line + 1, 0),
                insert: String::new(),
            }]);
            out.push(issue);
        }
    }
}

pub(super) fn md013(ctx: &Ctx<'_>, params: &Params<'_>, out: &mut Vec<Issue>) {
    let line_length = params.usize(&["line_length"], 80);
    let heading_length = params.usize(&["heading_line_length"], line_length);
    let code_length = params.usize(&["code_block_line_length"], line_length);
    let check_code =
        params.bool(&["code_blocks"], true) && !params.bool(&["ignore_code_blocks"], false);
    let check_tables = params.bool(&["tables"], true);
    let check_headings = params.bool(&["headings", "headers"], true);
    let strict = params.bool(&["strict"], false);
    let headings: std::collections::HashSet<usize> = ctx
        .headings
        .iter()
        .flat_map(|h| h.start_line..=h.end_line)
        .collect();
    for line in 1..=ctx.line_count() {
        let limit = match ctx.kind(line) {
            Kind::FrontMatter => continue,
            Kind::Code | Kind::Fence if !check_code => continue,
            Kind::Code | Kind::Fence => code_length,
            _ if headings.contains(&line) && !check_headings => continue,
            _ if headings.contains(&line) => heading_length,
            _ if ctx.table_lines[line - 1] && !check_tables => continue,
            _ => line_length,
        };
        let text = ctx.line_text(line);
        let chars = text.chars().count();
        if chars <= limit {
            continue;
        }
        let from = text
            .char_indices()
            .nth(limit)
            .map_or(text.len(), |(i, _)| i);
        // A long URL or word that can't be wrapped is fine (unless strict).
        if !strict && !text[from..].contains(char::is_whitespace) {
            continue;
        }
        // Link reference definitions can't be wrapped either.
        let trimmed = text.trim_start();
        if trimmed.starts_with('[') && trimmed.contains("]:") && !trimmed.trim_end().contains(' ') {
            continue;
        }
        out.push(ctx.issue(
            "MD013",
            line,
            from,
            text.len(),
            format!("Line length (Expected: {limit}; Actual: {chars})"),
        ));
    }
}

pub(super) fn md047(ctx: &Ctx<'_>, _: &Params<'_>, out: &mut Vec<Issue>) {
    if ctx.text.is_empty() || ctx.text.ends_with('\n') {
        return;
    }
    let line = ctx.line_count();
    let len = ctx.line_text(line).len();
    let mut issue = ctx.issue(
        "MD047",
        line,
        len,
        len,
        "Files should end with a single newline character",
    );
    issue.fix = Some(vec![ctx.edit(line, len, len, "\n")]);
    out.push(issue);
}
