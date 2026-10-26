//! Inline suppressions, as in markdownlint:
//!
//! ```markdown
//! <!-- markdownlint-disable MD013 -->      … off from here
//! <!-- markdownlint-enable MD013 -->       … on again
//! <!-- markdownlint-disable-line MD033 --> … off on this line
//! <!-- markdownlint-disable-next-line -->  … off on the next line (all rules)
//! <!-- markdownlint-disable-file MD041 --> … off in the whole file
//! <!-- markdownlint-capture --> / <!-- markdownlint-restore -->
//! ```

use super::context::{Ctx, Kind};
use super::{RULES, rule_info};

/// Bit set of enabled rules (by index in [`RULES`]).
type Mask = u64;

const ALL: Mask = (1 << RULES.len()) - 1;

/// The rules that are enabled on each line (index 0 = line 1).
pub(super) fn enabled_rules(ctx: &Ctx<'_>) -> Vec<Mask> {
    let comments: Vec<(usize, Vec<Directive>)> = (1..=ctx.line_count())
        .filter(|&n| matches!(ctx.kind(n), Kind::Text | Kind::Html))
        .map(|n| (n, directives(ctx.line_text(n))))
        .filter(|(_, d)| !d.is_empty())
        .collect();

    let mut file_mask = ALL;
    for (_, list) in &comments {
        for d in list {
            match d.action {
                "disable-file" => file_mask &= !d.rules,
                "enable-file" => file_mask |= d.rules,
                _ => {}
            }
        }
    }

    let mut masks = vec![file_mask; ctx.line_count()];
    let mut current = file_mask;
    let mut saved = Vec::new();
    let mut next_line: Option<(usize, Mask)> = None;
    let mut comments = comments.into_iter().peekable();
    for line in 1..=ctx.line_count() {
        let mut this_line = !0;
        if let Some((n, list)) = comments.next_if(|(n, _)| *n == line) {
            debug_assert_eq!(n, line);
            for d in list {
                match d.action {
                    "disable" => current &= !d.rules,
                    "enable" => current |= d.rules & file_mask,
                    "disable-line" => this_line &= !d.rules,
                    "disable-next-line" => next_line = Some((line + 1, !d.rules)),
                    "capture" => saved.push(current),
                    "restore" => current = saved.pop().unwrap_or(file_mask),
                    _ => {}
                }
            }
        }
        if let Some((n, mask)) = next_line
            && n == line
        {
            this_line &= mask;
            next_line = None;
        }
        masks[line - 1] = current & this_line;
    }
    masks
}

pub(super) fn is_enabled(masks: &[Mask], line: usize, rule: &str) -> bool {
    let Some(index) = RULES.iter().position(|r| r.id == rule) else {
        return true;
    };
    let mask = line
        .checked_sub(1)
        .and_then(|i| masks.get(i))
        .copied()
        .unwrap_or(ALL);
    mask & (1 << index) != 0
}

#[derive(Debug)]
struct Directive {
    action: &'static str,
    rules: Mask,
}

const ACTIONS: &[&str] = &[
    "disable-next-line",
    "disable-line",
    "disable-file",
    "enable-file",
    "disable",
    "enable",
    "capture",
    "restore",
];

/// The `markdownlint-…` comments on a line.
fn directives(text: &str) -> Vec<Directive> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("<!--") {
        let after = &rest[open + 4..];
        let Some(close) = after.find("-->") else {
            break;
        };
        let body = after[..close].trim();
        rest = &after[close + 3..];
        let Some(command) = body.strip_prefix("markdownlint-") else {
            continue;
        };
        let Some(action) = ACTIONS.iter().find(|a| {
            command.starts_with(**a)
                && command[a.len()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        }) else {
            continue;
        };
        let names: Vec<&str> = command[action.len()..].split_whitespace().collect();
        let rules = if names.is_empty() {
            ALL
        } else {
            names
                .iter()
                .filter_map(|name| rule_info(name))
                .filter_map(|info| RULES.iter().position(|r| r.id == info.id))
                .fold(0, |mask, i| mask | (1 << i))
        };
        found.push(Directive { action, rules });
    }
    found
}
