//! Snapshot tests: every `tests/fixtures/*.md` file is rendered and compared with
//! its stored snapshot. Review changes with `cargo insta review`.

use atc_markdown_core::render_markdown;

#[test]
fn render_fixtures() {
    insta::glob!("fixtures/*.md", |path| {
        let source = std::fs::read_to_string(path).unwrap();
        insta::assert_snapshot!(render_markdown(&source).as_str());
    });
}
