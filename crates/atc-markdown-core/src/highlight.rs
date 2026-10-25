//! Syntax highlighting for fenced code blocks.
//!
//! Uses the large syntax set from `two-face` (the one `bat` ships) and maps the
//! fence names people actually write (` ```csharp `, ` ```ps1 `, ` ```ts `) to the
//! right grammar. Output is class-based (`hl-*`); colours come from [`highlight_css`].

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

use comrak::adapters::SyntaxHighlighterAdapter;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedThemeName;

pub(crate) const CLASS_PREFIX: &str = "hl-";

/// Fence names that don't match a grammar's own name or file extension.
/// Keys are lowercase; values are syntax names in the `two-face` set.
const ALIASES: &[(&str, &str)] = &[
    // .NET
    ("csharp", "C#"),
    ("c-sharp", "C#"),
    ("dotnet", "C#"),
    ("fsharp", "F#"),
    ("f#", "F#"),
    ("fs", "F#"), // `.fs` is also a GLSL extension; in Markdown it means F#
    ("razor", "HTML"),
    ("cshtml", "HTML"),
    ("xaml", "XML"),
    ("csproj", "XML"),
    ("fsproj", "XML"),
    ("props", "XML"),
    ("targets", "XML"),
    ("nuspec", "XML"),
    ("resx", "XML"),
    ("config", "XML"),
    // Shells
    ("powershell", "PowerShell"),
    ("pwsh", "PowerShell"),
    ("ps", "PowerShell"),
    ("ps1", "PowerShell"),
    ("psm1", "PowerShell"),
    ("shell", "Bourne Again Shell (bash)"),
    ("console", "Bourne Again Shell (bash)"),
    ("shellsession", "Bourne Again Shell (bash)"),
    ("terminal", "Bourne Again Shell (bash)"),
    ("batch", "Batch File"),
    ("bat", "Batch File"),
    ("cmd", "Batch File"),
    // Web
    ("ts", "TypeScript"),
    ("typescript", "TypeScript"),
    ("tsx", "TypeScriptReact"),
    ("jsonc", "JSON"),
    ("json5", "JSON"),
    ("node", "JavaScript"),
    ("mjs", "JavaScript"),
    ("cjs", "JavaScript"),
    // Data and infrastructure
    ("docker", "Dockerfile"),
    ("dockerfile", "Dockerfile"),
    ("hcl", "Terraform"),
    ("tf", "Terraform"),
    ("terraform", "Terraform"),
    ("bicep", "TypeScript"), // no Bicep grammar; TypeScript gets strings, comments and keywords mostly right
    ("editorconfig", "INI"),
    ("env", "DotENV"),
    ("dotenv", "DotENV"),
    ("tsql", "SQL"),
    ("mssql", "SQL"),
    ("mysql", "SQL"),
    ("postgres", "SQL"),
    ("postgresql", "SQL"),
    ("plsql", "SQL"),
    ("sqlite", "SQL"),
    // Other languages
    ("golang", "Go"),
    ("objc", "Objective-C"),
    ("objective-c", "Objective-C"),
    ("kt", "Kotlin"),
    ("proto", "Protocol Buffer"),
    ("protobuf", "Protocol Buffer"),
    ("text", "Plain Text"),
    ("txt", "Plain Text"),
    ("plain", "Plain Text"),
    ("plaintext", "Plain Text"),
];

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

static ALIAS_MAP: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| ALIASES.iter().copied().collect());

const CLASS_STYLE: ClassStyle = ClassStyle::SpacedPrefixed {
    prefix: CLASS_PREFIX,
};

/// The comrak plugin that writes class-based highlighted HTML.
#[derive(Debug)]
pub(crate) struct Highlighter;

impl SyntaxHighlighterAdapter for Highlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        let syntax = match lang {
            Some(lang) if !lang.trim().is_empty() => find_syntax(lang),
            _ => SYNTAXES.find_syntax_by_first_line(code),
        }
        .unwrap_or_else(|| SYNTAXES.find_syntax_plain_text());

        let mut html = ClassedHTMLGenerator::new_with_class_style(syntax, &SYNTAXES, CLASS_STYLE);
        for line in LinesWithEndings::from(code) {
            if html
                .parse_html_for_line_which_includes_newline(line)
                .is_err()
            {
                // A grammar failed on this input: show the code unhighlighted.
                return comrak::html::escape(output, code);
            }
        }
        output.write_str(&html.finalize())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn fmt::Write,
        _attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        comrak::html::write_opening_tag(output, "pre", [("class", "syntax-highlighting")])
    }

    fn write_code_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        comrak::html::write_opening_tag(output, "code", attributes)
    }
}

/// Finds the grammar for a fence name such as `csharp`, `C#`, `ps1` or `json`.
fn find_syntax(fence: &str) -> Option<&'static SyntaxReference> {
    // Info strings can carry extra words or attributes: "rust,ignore", "js title=x".
    let token = fence
        .split([',', ' ', '\t', '{'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_lowercase();
    if token.is_empty() {
        return None;
    }
    match ALIAS_MAP.get(token.as_str()) {
        Some(name) => SYNTAXES.find_syntax_by_name(name),
        None => SYNTAXES.find_syntax_by_token(&token),
    }
}

/// The grammar used for a fence name, or `None` if the block is shown as plain text.
pub fn code_language(fence: &str) -> Option<&'static str> {
    find_syntax(fence)
        .map(|syntax| syntax.name.as_str())
        .filter(|name| *name != "Plain Text")
}

/// A choice of code colours: one theme for light mode and one for dark mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeTheme {
    /// Id stored in settings, e.g. `github`.
    pub id: &'static str,
    /// Name shown to the user.
    pub label: &'static str,
    #[serde(skip)]
    light: EmbeddedThemeName,
    #[serde(skip)]
    dark: EmbeddedThemeName,
}

/// The code colour choices; the first one is the default.
pub const CODE_THEMES: &[CodeTheme] = &[
    CodeTheme {
        id: "github",
        label: "GitHub / One Half Dark",
        light: EmbeddedThemeName::Github,
        dark: EmbeddedThemeName::OneHalfDark,
    },
    CodeTheme {
        id: "one-half",
        label: "One Half",
        light: EmbeddedThemeName::OneHalfLight,
        dark: EmbeddedThemeName::OneHalfDark,
    },
    CodeTheme {
        id: "solarized",
        label: "Solarized",
        light: EmbeddedThemeName::SolarizedLight,
        dark: EmbeddedThemeName::SolarizedDark,
    },
    CodeTheme {
        id: "gruvbox",
        label: "Gruvbox",
        light: EmbeddedThemeName::GruvboxLight,
        dark: EmbeddedThemeName::GruvboxDark,
    },
    CodeTheme {
        id: "catppuccin",
        label: "Catppuccin (Latte / Mocha)",
        light: EmbeddedThemeName::CatppuccinLatte,
        dark: EmbeddedThemeName::CatppuccinMocha,
    },
    CodeTheme {
        id: "monokai",
        label: "Monokai",
        light: EmbeddedThemeName::MonokaiExtendedLight,
        dark: EmbeddedThemeName::MonokaiExtended,
    },
    CodeTheme {
        id: "coldark",
        label: "Coldark",
        light: EmbeddedThemeName::ColdarkCold,
        dark: EmbeddedThemeName::ColdarkDark,
    },
    CodeTheme {
        id: "base16-ocean",
        label: "Base16 Ocean",
        light: EmbeddedThemeName::Base16OceanLight,
        dark: EmbeddedThemeName::Base16OceanDark,
    },
    CodeTheme {
        id: "dracula",
        label: "Inspired GitHub / Dracula",
        light: EmbeddedThemeName::InspiredGithub,
        dark: EmbeddedThemeName::Dracula,
    },
];

/// Finds a code theme by id, falling back to the default.
pub fn code_theme(id: &str) -> CodeTheme {
    CODE_THEMES
        .iter()
        .copied()
        .find(|theme| theme.id == id)
        .unwrap_or(CODE_THEMES[0])
}

/// CSS for highlighted code blocks in the default code theme.
pub fn highlight_css() -> String {
    highlight_css_for(CODE_THEMES[0].id)
}

/// CSS for highlighted code blocks in a code theme.
///
/// The app sets `data-theme="dark"` on `<html>` in dark mode. Each theme is
/// scoped to its own mode (so a rule only one theme has, e.g. for string quotes,
/// can't leak into the other mode), and paper always gets the light theme.
pub fn highlight_css_for(id: &str) -> String {
    let theme = code_theme(id);
    let themes = &*THEMES;
    let css = |name| {
        syntect::html::css_for_theme_with_class_style(themes.get(name), CLASS_STYLE)
            .unwrap_or_default()
    };
    let (light, dark) = (css(theme.light), css(theme.dark));
    format!(
        ":root:not([data-theme=\"dark\"]) {{\n{light}\n}}\n\
         @media print {{\n:root {{\n{light}\n}}\n}}\n\
         @media screen {{\n:root[data-theme=\"dark\"] {{\n{dark}\n}}\n}}\n"
    )
}

static THEMES: LazyLock<two_face::theme::EmbeddedLazyThemeSet> =
    LazyLock::new(two_face::theme::extra);

/// Loads the syntax set and themes ahead of time, so the first document opens fast.
pub fn warm_up() {
    LazyLock::force(&SYNTAXES);
    let _ = highlight_css();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fence names people commonly use; each must get real highlighting.
    const COMMON_FENCES: &[&str] = &[
        "csharp",
        "cs",
        "c#",
        "C#",
        "fsharp",
        "fs",
        "razor",
        "cshtml",
        "xaml",
        "csproj",
        "json",
        "jsonc",
        "js",
        "javascript",
        "jsx",
        "ts",
        "typescript",
        "tsx",
        "html",
        "css",
        "scss",
        "xml",
        "yaml",
        "yml",
        "toml",
        "ini",
        "sql",
        "tsql",
        "bash",
        "sh",
        "shell",
        "zsh",
        "console",
        "powershell",
        "pwsh",
        "ps1",
        "bat",
        "cmd",
        "dockerfile",
        "docker",
        "hcl",
        "terraform",
        "bicep",
        "python",
        "py",
        "go",
        "golang",
        "rust",
        "rs",
        "java",
        "kotlin",
        "kt",
        "swift",
        "c",
        "cpp",
        "c++",
        "objc",
        "php",
        "ruby",
        "rb",
        "lua",
        "dart",
        "r",
        "diff",
        "patch",
        "markdown",
        "md",
        "graphql",
        "proto",
        "makefile",
        "cmake",
        "http",
        "env",
        "vue",
        "svelte",
        "scala",
        "groovy",
        "perl",
        "haskell",
        "elixir",
        "erlang",
        "nix",
        "zig",
        "latex",
    ];

    #[test]
    fn common_fences_are_highlighted() {
        let plain: Vec<_> = COMMON_FENCES
            .iter()
            .filter(|fence| code_language(fence).is_none())
            .collect();
        assert_eq!(plain, Vec::<&&str>::new(), "fences rendered as plain text");
    }

    #[test]
    fn aliases_point_at_existing_syntaxes() {
        for (alias, name) in ALIASES {
            assert!(
                SYNTAXES.find_syntax_by_name(name).is_some(),
                "alias {alias} → missing syntax {name}"
            );
        }
    }

    #[test]
    fn resolves_fences_to_the_expected_grammar() {
        assert_eq!(code_language("csharp"), Some("C#"));
        assert_eq!(code_language("CSharp"), Some("C#"));
        assert_eq!(code_language("ps1"), Some("PowerShell"));
        assert_eq!(code_language("fs"), Some("F#"));
        assert_eq!(code_language("rust,ignore"), Some("Rust"));
        assert_eq!(code_language("json title=\"x\""), Some("JSON"));
    }

    #[test]
    fn unknown_and_plain_fences_are_plain() {
        assert_eq!(code_language("no-such-language"), None);
        assert_eq!(code_language("text"), None);
        assert_eq!(code_language(""), None);
    }
}
