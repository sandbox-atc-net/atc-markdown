//! Property tests: the renderer must never panic and never let scripts through,
//! whatever the input.

use atc_markdown_core::render_markdown;
use proptest::prelude::*;

proptest! {
    #[test]
    fn never_panics_on_arbitrary_input(source in any::<String>()) {
        let _ = render_markdown(&source);
    }

    #[test]
    fn never_emits_script_tags(
        prefix in "[a-zA-Z #*>\\-\\n]{0,40}",
        suffix in "[a-zA-Z #*>\\-\\n]{0,40}",
    ) {
        let source = format!("{prefix}<script>alert(1)</script>{suffix}");
        let html = render_markdown(&source);
        prop_assert!(!html.as_str().to_ascii_lowercase().contains("<script"));
    }
}
