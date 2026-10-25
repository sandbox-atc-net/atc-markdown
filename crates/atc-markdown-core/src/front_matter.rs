//! YAML front matter (`---` block at the top of a file), shown like GitHub does:
//! a one-row table of `key: value` pairs, or the YAML itself when it is nested.

/// The YAML between the `---` delimiter lines.
pub(crate) fn body(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.first().is_some_and(|l| l.trim() == "---") {
        lines.remove(0);
    }
    if lines
        .last()
        .is_some_and(|l| matches!(l.trim(), "---" | "..."))
    {
        lines.pop();
    }
    lines.join("\n")
}

/// Parses flat `key: value` lines. Returns `None` for anything else (nested maps,
/// lists, multi-line strings), which is then shown as a YAML code block.
pub(crate) fn flat_pairs(yaml: &str) -> Option<Vec<(String, String)>> {
    let mut pairs = Vec::new();
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with([' ', '\t']) || trimmed.starts_with('-') {
            return None;
        }
        let (key, value) = trimmed.split_once(':')?;
        let key = key.trim();
        let value = value.trim();
        let multiline = matches!(value, "" | "|" | ">" | "|-" | ">-" | "|+" | ">+");
        if key.is_empty() || multiline {
            return None;
        }
        pairs.push((unquote(key).to_owned(), unquote(value).to_owned()));
    }
    (!pairs.is_empty()).then_some(pairs)
}

/// A one-row table with the keys as headings, as on github.com.
pub(crate) fn table_html(pairs: &[(String, String)]) -> String {
    let cells = |tag: &str, pick: fn(&(String, String)) -> &String| {
        let mut out = String::new();
        for pair in pairs {
            out.push('<');
            out.push_str(tag);
            out.push('>');
            out.push_str(&escape(pick(pair)));
            out.push_str("</");
            out.push_str(tag);
            out.push('>');
        }
        out
    };
    format!(
        "<table class=\"front-matter\"><thead><tr>{}</tr></thead><tbody><tr>{}</tr></tbody></table>\n",
        cells("th", |p| &p.0),
        cells("td", |p| &p.1)
    )
}

fn unquote(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        &text[1..text.len() - 1]
    } else {
        text
    }
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_yaml_body() {
        assert_eq!(body("---\ntitle: A\n---\n\n"), "title: A");
        assert_eq!(body("---\na: 1\nb: 2\n...\n"), "a: 1\nb: 2");
    }

    #[test]
    fn parses_flat_pairs() {
        let pairs =
            flat_pairs("title: \"Hello\"\ntags: [a, b]\n# comment\nurl: https://x.y/z").unwrap();
        assert_eq!(
            pairs,
            [
                ("title".to_owned(), "Hello".to_owned()),
                ("tags".to_owned(), "[a, b]".to_owned()),
                ("url".to_owned(), "https://x.y/z".to_owned()),
            ]
        );
    }

    #[test]
    fn rejects_nested_yaml() {
        assert_eq!(flat_pairs("nested:\n  x: 1"), None);
        assert_eq!(flat_pairs("list:\n- a"), None);
        assert_eq!(flat_pairs("text: |\n  line"), None);
        assert_eq!(flat_pairs("no colon here"), None);
        assert_eq!(flat_pairs(""), None);
    }

    #[test]
    fn escapes_table_cells() {
        let html = table_html(&[("t<i>".into(), "a & \"b\"".into())]);
        assert_eq!(
            html,
            "<table class=\"front-matter\"><thead><tr><th>t&lt;i&gt;</th></tr></thead><tbody><tr><td>a &amp; &quot;b&quot;</td></tr></tbody></table>\n"
        );
    }
}
