use serde_json::json;

use super::*;

/// No issues.
const NONE: Vec<Issue> = Vec::new();

/// A config with only `rule` on (with `params`).
fn only(rule: &str, params: serde_json::Value) -> LintConfig {
    let mut value = json!({ "default": false });
    value[rule] = if params.is_null() {
        json!(true)
    } else {
        params
    };
    LintConfig::from_value(&value)
}

fn issues(rule: &str, text: &str) -> Vec<Issue> {
    lint(text, &only(rule, serde_json::Value::Null), false)
}

fn lines(rule: &str, text: &str) -> Vec<usize> {
    issues(rule, text).iter().map(|i| i.line).collect()
}

fn fixed(rule: &str, text: &str) -> String {
    fix_all(text, &only(rule, serde_json::Value::Null), false)
}

/// (rule, bad example, good example) from markdownlint's RULES.md.
const RULES_MD_EXAMPLES: &[(&str, &str, &str)] = &[
    (
        "MD001",
        "# Header 1\n\n### Header 3\n\nWe skipped out a 2nd level header\n",
        "# Header 1\n\n## Header 2\n\n### Header 3\n\n#### Header 4\n\n## Another Header 2\n\n### Another Header 3\n",
    ),
    (
        "MD002",
        "## This isn't a H1 header\n\n### Another header\n",
        "# Start with a H1 header\n\n## Then use a H2 for subsections\n",
    ),
    (
        "MD003",
        "# ATX style H1\n\n## Closed ATX style H2 ##\n\nSetext style H1\n===============\n",
        "# ATX style H1\n\n## ATX style H2\n",
    ),
    (
        "MD004",
        "* Item 1\n+ Item 2\n- Item 3\n",
        "* Item 1\n* Item 2\n* Item 3\n",
    ),
    (
        "MD005",
        "* Item 1\n\n    * Nested Item 1\n    * Nested Item 2\n   * A misaligned item\n",
        "* Item 1\n  * Nested Item 1\n  * Nested Item 2\n  * Nested Item 3\n",
    ),
    (
        "MD006",
        "Some text\n\n  * List item\n  * List item\n",
        "Some test\n\n* List item\n* List item\n",
    ),
    (
        "MD007",
        "* List item\n   * Nested list item indented by 3 spaces\n",
        "* List item\n  * Nested list item indented by 2 spaces\n",
    ),
    ("MD009", "Some text \n", "Some text\n"),
    (
        "MD010",
        "Some text\n\n\t* hard tab character used to indent the list item\n",
        "Some text\n\n    * Spaces used to indent the list item instead\n",
    ),
    (
        "MD011",
        "(Incorrect link syntax)[http://www.example.com/]\n",
        "[Correct link syntax](http://www.example.com/)\n",
    ),
    (
        "MD012",
        "Some text here\n\n\nSome more text here\n",
        "Some text here\n\nSome more text here\n",
    ),
    (
        "MD013",
        "word word word word word word word word word word word word word word word word word word word word\n",
        "Short line\n",
    ),
    (
        "MD014",
        "```sh\n$ ls\n$ cat foo\n$ less bar\n```\n",
        "```sh\n$ ls\nfoo bar\n$ cat foo\nHello world\n```\n",
    ),
    (
        "MD018",
        "#Header 1\n\n##Header 2\n",
        "# Header 1\n\n## Header 2\n",
    ),
    (
        "MD019",
        "#  Header 1\n\n##  Header 2\n",
        "# Header 1\n\n## Header 2\n",
    ),
    (
        "MD020",
        "#Header 1#\n\n##Header 2##\n",
        "# Header 1 #\n\n## Header 2 ##\n",
    ),
    (
        "MD021",
        "#  Header 1  #\n\n##  Header 2  ##\n",
        "# Header 1 #\n\n## Header 2 ##\n",
    ),
    (
        "MD022",
        "# Header 1\nSome text\n\nSome more text\n## Header 2\n",
        "# Header 1\n\nSome text\n\nSome more text\n\n## Header 2\n",
    ),
    (
        "MD023",
        "Some text\n\n  # Indented header\n",
        "Some text\n\n# Header\n",
    ),
    (
        "MD024",
        "# Some text\n\n## Some text\n",
        "# Some text\n\n## Some more text\n",
    ),
    (
        "MD025",
        "# Top level header\n\n# Another top level header\n",
        "# Title\n\n## Header\n\n## Another header\n",
    ),
    ("MD026", "# This is a header.\n", "# This is a header\n"),
    (
        "MD027",
        ">  This is a block quote with bad indentation\n>  there should only be one.\n",
        "> This is a blockquote with correct\n> indentation.\n",
    ),
    (
        "MD028",
        "> This is a blockquote\n> which is immediately followed by\n\n> this blockquote.\n",
        "> This is a blockquote.\n>\n> This is the same blockquote.\n",
    ),
    (
        "MD029",
        "1. Do this.\n3. Do that.\n2. Done.\n",
        "1. Do this.\n2. Do that.\n3. Done.\n",
    ),
    ("MD030", "*  Foo\n*  Bar\n", "* Foo\n* Bar\n"),
    (
        "MD031",
        "Some text\n```\nCode block\n```\n\n```\nAnother code block\n```\nSome more text\n",
        "Some text\n\n```\nCode block\n```\n\n```\nAnother code block\n```\n\nSome more text\n",
    ),
    (
        "MD032",
        "Some text\n* Some\n* List\n\n1. Some\n2. List\n\nSome text\n",
        "Some text\n\n* Some\n* List\n\n1. Some\n2. List\n\nSome text\n",
    ),
    (
        "MD033",
        "<h1>Inline HTML header</h1>\n",
        "# Markdown header\n",
    ),
    (
        "MD034",
        "For more information, see http://www.example.com/.\n",
        "For more information, see <http://www.example.com/>.\n",
    ),
    (
        "MD035",
        "---\n\n- - -\n\n***\n",
        "Text\n\n---\n\nMore\n\n---\n",
    ),
    (
        "MD036",
        "**My document**\n\nLorem ipsum dolor sit amet...\n\n_Another section_\n\nConsectetur.\n",
        "# My document\n\nLorem ipsum dolor sit amet...\n",
    ),
    (
        "MD037",
        "Here is some ** bold ** text.\n\nHere is some * italic * text.\n\nHere is some more __ bold __ text.\n\nHere is some more _ italic _ text.\n",
        "Here is some **bold** text.\n\nHere is some *italic* text.\n\nHere is some more __bold__ text.\n\nHere is some more _italic_ text.\n",
    ),
    (
        "MD038",
        "` some text `\n\n`some text `\n\n` some text`\n",
        "`some text`\n",
    ),
    (
        "MD039",
        "[ a link ](http://www.example.com/)\n",
        "[a link](http://www.example.com/)\n",
    ),
    (
        "MD040",
        "```\n#!/bin/bash\necho Hello world\n```\n",
        "```bash\n#!/bin/bash\necho Hello world\n```\n",
    ),
    (
        "MD041",
        "This is a file without a header\n",
        "# File with header\n\nThis is a file with a top level header\n",
    ),
    (
        "MD046",
        "Some text.\n\n```ruby\nCode\n```\n\n    Code block\n\nSome more text.\n",
        "Some text.\n\n```ruby\nCode block\n```\n\nSome more text.\n",
    ),
    (
        "MD047",
        "# Heading\n\nThis file ends without a newline.",
        "# Heading\n\nThis file ends with a newline.\n",
    ),
];

/// Each rule's "bad" example from markdownlint's RULES.md fires, and its "good" example doesn't.
#[test]
fn rules_md_examples() {
    let cases = RULES_MD_EXAMPLES;
    let mut failures = Vec::new();
    for (rule, bad, good) in cases {
        if issues(rule, bad).is_empty() {
            failures.push(format!("{rule}: bad example not reported"));
        }
        let wrong = issues(rule, good);
        if !wrong.is_empty() {
            failures.push(format!("{rule}: good example reported: {wrong:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    // Every rule has a case.
    for info in RULES {
        assert!(
            cases.iter().any(|(r, _, _)| *r == info.id),
            "{} has no example",
            info.id
        );
    }
}

#[test]
fn positions_point_at_the_problem() {
    let text = "Some text   \n";
    let issue = &issues("MD009", text)[0];
    assert_eq!(&text[issue.start..issue.end], "   ");
    assert_eq!(issue.line, 1);
    assert_eq!(issue.alias, "no-trailing-spaces");

    let text = "# Title\n\nSee https://example.com/a_(b) now.\n";
    let issue = &issues("MD034", text)[0];
    assert_eq!(&text[issue.start..issue.end], "https://example.com/a_(b)");
}

#[test]
fn utf16_offsets_count_like_the_editor() {
    // æøå are 2 bytes in UTF-8 but 1 unit in UTF-16; the emoji is 4 bytes and 2 units.
    let text = "# Title\n\nÆøå 😀 text \n";
    let diagnostics = lint_utf16(text, &only("MD009", serde_json::Value::Null), false);
    let d = &diagnostics[0];
    let utf16: Vec<u16> = text.encode_utf16().collect();
    assert_eq!(String::from_utf16(&utf16[d.from..d.to]).unwrap(), " ");
    assert_eq!(d.from, "# Title\n\nÆøå 😀 text".encode_utf16().count());
    let fix = &d.fix.as_ref().unwrap()[0];
    assert_eq!((fix.from, fix.to), (d.from, d.to));
}

#[test]
fn code_blocks_front_matter_and_inline_code_are_not_text() {
    let text = "---\ntitle: x\n---\n\n```\n#NotAHeading\n(a)[b] http://x.y\n```\n\nUse `#hash` and `(a)[b]`.\n";
    for rule in ["MD018", "MD011", "MD034"] {
        assert_eq!(issues(rule, text), NONE, "{rule}: {:?}", issues(rule, text));
    }
}

#[test]
fn links_and_autolinks_are_not_bare_urls() {
    let text = "[x](https://a.b) <https://a.b> [https://a.b](https://a.b)\n\n[ref]: https://a.b\n\n<a href=\"https://a.b\">x</a>\n";
    assert_eq!(issues("MD034", text), vec![]);
    assert_eq!(lines("MD034", "(see https://a.b)\n"), vec![1]);
}

#[test]
fn code_spans_can_cross_lines() {
    // The span opened on line 1 closes on line 2; the next one is `b`.
    let text = "Set `a\nwarning` does **x**: of an `b` here\n";
    assert_eq!(issues("MD038", text), NONE, "{:?}", issues("MD038", text));
    assert_eq!(fixed("MD038", text), text);
}

#[test]
fn non_ascii_text_does_not_break_the_scanners() {
    let text = "# Façade ≤ π\n\nÆøå ç https://a.b ° *x* ** y ** `æ ` [ ø ](u) (å)[b] <ø> é\n";
    for info in RULES {
        let _ = lint(text, &only(info.id, serde_json::Value::Null), false);
    }
    let _ = fix_all(text, &LintConfig::app_defaults(), false);
}

#[test]
fn alerts_count_as_block_quotes() {
    let text = "> [!NOTE]\n>  Two spaces.\n";
    assert_eq!(lines("MD027", text), vec![2]);
}

#[test]
fn html_comments_are_not_inline_html() {
    assert_eq!(issues("MD033", "<!-- a comment -->\n\nText\n"), NONE);
    assert_eq!(lines("MD033", "Text <br> more\n"), vec![1]);
    let allowed = lint(
        "Text <br> and <kbd>Ctrl</kbd>\n",
        &only("MD033", json!({ "allowed_elements": ["br", "kbd"] })),
        false,
    );
    assert_eq!(allowed, NONE, "{allowed:?}");
}

#[test]
fn wiki_pages_have_their_title_as_h1() {
    let text = "## Section\n\nText\n";
    assert_eq!(
        lint(text, &only("MD041", serde_json::Value::Null), true),
        NONE
    );
    assert_ne!(
        lint(text, &only("MD041", serde_json::Value::Null), false),
        NONE
    );
}

#[test]
fn front_matter_title_counts_as_the_top_heading() {
    let text = "---\ntitle: Hello\n---\n\n## Section\n";
    assert_eq!(issues("MD041", text), NONE);
    assert_eq!(issues("MD001", text), NONE);
    assert_eq!(
        lines("MD025", "---\ntitle: Hello\n---\n\n# Again\n"),
        vec![5]
    );
}

#[test]
fn duplicate_headings_under_different_parents_with_siblings_only() {
    let text = "# Log\n\n## 2.0\n\n### Fixes\n\n## 1.0\n\n### Fixes\n";
    assert_eq!(lines("MD024", text), vec![9]);
    let config = only("MD024", json!({ "siblings_only": true }));
    assert_eq!(lint(text, &config, false), NONE);
}

#[test]
fn ordered_lists_one_or_ordered() {
    assert_eq!(issues("MD029", "1. a\n1. b\n1. c\n"), NONE);
    assert_eq!(issues("MD029", "1. a\n2. b\n3. c\n"), NONE);
    assert_eq!(lines("MD029", "1. a\n1. b\n2. c\n"), vec![3]);
}

#[test]
fn nested_lists_follow_the_indent_setting() {
    let text = "* a\n    * b\n";
    assert_eq!(lines("MD007", text), vec![2]);
    assert_eq!(
        lint(text, &only("MD007", json!({ "indent": 4 })), false),
        NONE
    );
    // Sub-lists of ordered lists are not checked.
    assert_eq!(issues("MD007", "1. a\n   * b\n"), NONE);
}

#[test]
fn suppression_comments() {
    let text = "<!-- markdownlint-disable MD009 -->\na \n<!-- markdownlint-enable MD009 -->\nb \nc  x \n<!-- markdownlint-disable-next-line -->\nd \ne <!-- markdownlint-disable-line no-trailing-spaces --> \n";
    assert_eq!(lines("MD009", text), vec![4, 5]);

    let text = "<!-- markdownlint-disable-file MD009 -->\na \n";
    assert_eq!(issues("MD009", text), NONE);

    let text = "<!-- markdownlint-capture -->\n<!-- markdownlint-disable -->\na \n<!-- markdownlint-restore -->\nb \n";
    assert_eq!(lines("MD009", text), vec![5]);
}

#[test]
fn fixes() {
    // Three spaces before a text line are a line break: keep two.
    assert_eq!(fixed("MD009", "a   \nb\n"), "a  \nb\n");
    assert_eq!(fixed("MD009", "a   \n\nb \n"), "a\n\nb\n");
    assert_eq!(fixed("MD010", "a\tb\n"), "a    b\n");
    assert_eq!(fixed("MD011", "(text)[url]\n"), "[text](url)\n");
    assert_eq!(fixed("MD012", "a\n\n\n\nb\n"), "a\n\nb\n");
    assert_eq!(fixed("MD018", "#Title\n"), "# Title\n");
    assert_eq!(fixed("MD019", "##   Title\n"), "## Title\n");
    assert_eq!(fixed("MD020", "##Title##\n"), "## Title ##\n");
    assert_eq!(fixed("MD021", "##  Title   ##\n"), "## Title ##\n");
    assert_eq!(
        fixed("MD022", "# A\ntext\n## B\nmore\n"),
        "# A\n\ntext\n\n## B\n\nmore\n"
    );
    assert_eq!(fixed("MD023", "  # A\n"), "# A\n");
    assert_eq!(fixed("MD026", "# Done!\n"), "# Done\n");
    assert_eq!(fixed("MD027", ">   quote\n"), "> quote\n");
    assert_eq!(fixed("MD029", "1. a\n3. b\n7. c\n"), "1. a\n2. b\n3. c\n");
    assert_eq!(fixed("MD030", "-   a\n-   b\n"), "- a\n- b\n");
    assert_eq!(
        fixed("MD031", "text\n```js\nx\n```\nmore\n"),
        "text\n\n```js\nx\n```\n\nmore\n"
    );
    assert_eq!(
        fixed("MD032", "text\n- a\n- b\n\nmore\n"),
        "text\n\n- a\n- b\n\nmore\n"
    );
    assert_eq!(
        fixed("MD034", "see https://a.b/c.\n"),
        "see <https://a.b/c>.\n"
    );
    assert_eq!(
        fixed("MD035", "a\n\n---\n\nb\n\n***\n"),
        "a\n\n---\n\nb\n\n---\n"
    );
    assert_eq!(
        fixed("MD037", "some ** bold ** and * it *\n"),
        "some **bold** and *it*\n"
    );
    assert_eq!(fixed("MD038", "use ` code ` here\n"), "use `code` here\n");
    assert_eq!(fixed("MD039", "[ link ](x)\n"), "[link](x)\n");
    assert_eq!(fixed("MD047", "text"), "text\n");
    assert_eq!(fixed("MD004", "* a\n- b\n+ c\n"), "* a\n* b\n* c\n");
    assert_eq!(fixed("MD007", "* a\n   * b\n"), "* a\n  * b\n");
    assert_eq!(
        fixed("MD014", "```sh\n$ ls\n$ pwd\n```\n"),
        "```sh\nls\npwd\n```\n"
    );
    assert_eq!(fixed("MD003", "# A\n\nB\n---\n"), "# A\n\n## B\n");
}

#[test]
fn fix_all_is_idempotent_and_keeps_the_rendering_for_whitespace_fixes() {
    let text = "# Title\n\nSome text   \nmore\ttext\n\n\n\n* a\n* b\n\n> quote\n";
    let config = LintConfig::app_defaults();
    let once = fix_all(text, &config, false);
    assert_eq!(fix_all(&once, &config, false), once);
    assert!(lint(&once, &config, false).iter().all(|i| i.fix.is_none()));

    let whitespace =
        LintConfig::from_value(&json!({ "default": false, "MD009": true, "MD012": true }));
    let fixed = fix_all("a   \nb\n\n\n\nc\n", &whitespace, false);
    assert_eq!(
        crate::render_markdown(&fixed).as_str(),
        crate::render_markdown("a   \nb\n\n\n\nc\n").as_str()
    );
}

#[test]
fn every_rule_has_a_name_and_lookup_works() {
    assert_eq!(RULES.len(), 39);
    assert_eq!(rule_info("md013").unwrap().alias, "line-length");
    assert_eq!(rule_info("header-increment").unwrap().id, "MD001");
    assert!(rule_info("MD051").is_none());
}

#[test]
fn app_defaults_are_quiet_on_a_tidy_document() {
    let text = "# Title\n\nIntro with a [link](https://example.com) and `code`.\n\n## Section\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n```csharp\nvar x = 1;\n```\n\n> [!NOTE]\n> A note.\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    let found = lint(text, &LintConfig::app_defaults(), false);
    assert_eq!(found, NONE, "{found:#?}");
}
