//! Which rules run, and their parameters, in the `.markdownlint.json` format:
//!
//! ```json
//! { "default": true, "MD013": { "line_length": 120 }, "no-inline-html": false }
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::{RULES, rule_info};

/// Project config file names, in the order they are looked for in each folder.
pub const CONFIG_FILE_NAMES: &[&str] = &[
    ".markdownlint.jsonc",
    ".markdownlint.json",
    ".markdownlint.yaml",
    ".markdownlint.yml",
];

/// One rule's setting.
#[derive(Debug, Clone, PartialEq)]
pub enum RuleConfig {
    /// The rule doesn't run.
    Off,
    /// The rule runs with these parameters (missing ones use the rule's defaults).
    On(Map<String, Value>),
}

/// Rule settings. Rules that are not mentioned follow `default`, then their own default.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LintConfig {
    default: Option<bool>,
    rules: BTreeMap<&'static str, RuleConfig>,
}

/// A config file that could not be read.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// Reading the file failed.
    #[error("could not read {path}: {source}")]
    Io {
        /// The file.
        path: PathBuf,
        /// Why.
        source: std::io::Error,
    },
    /// The file is not valid JSON / YAML.
    #[error("{path} is not valid: {message}")]
    Invalid {
        /// The file.
        path: PathBuf,
        /// What is wrong.
        message: String,
    },
}

impl LintConfig {
    /// The app's defaults for GitHub-style documents: long lines allowed, a few
    /// common HTML elements allowed, deprecated rules off.
    pub fn app_defaults() -> Self {
        let mut config = Self::default();
        config.set("MD013", RuleConfig::Off);
        let allowed = [
            "details", "summary", "br", "img", "kbd", "sub", "sup", "picture", "source",
        ];
        let mut params = Map::new();
        params.insert(
            "allowed_elements".to_owned(),
            Value::Array(
                allowed
                    .iter()
                    .map(|s| Value::String((*s).to_owned()))
                    .collect(),
            ),
        );
        config.set("MD033", RuleConfig::On(params));
        config
    }

    /// Sets a rule by id or name. Unknown names are ignored.
    pub fn set(&mut self, rule: &str, setting: RuleConfig) {
        if let Some(info) = rule_info(rule) {
            self.rules.insert(info.id, setting);
        }
    }

    /// Turns a rule on or off, keeping its parameters when it stays on.
    pub fn set_enabled(&mut self, rule: &str, on: bool) {
        let Some(info) = rule_info(rule) else { return };
        if !on {
            self.rules.insert(info.id, RuleConfig::Off);
        } else if self.params(info.id).is_none() {
            self.rules.insert(info.id, RuleConfig::On(Map::new()));
        }
    }

    /// Sets one parameter of a rule (and turns it on).
    pub fn set_param(&mut self, rule: &str, key: &str, value: Value) {
        let Some(info) = rule_info(rule) else { return };
        let mut params = self.params(info.id).cloned().unwrap_or_default();
        params.insert(key.to_owned(), value);
        self.rules.insert(info.id, RuleConfig::On(params));
    }

    /// The parameters of a rule that runs, or `None` if it is off.
    pub fn params(&self, id: &str) -> Option<&Map<String, Value>> {
        static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
        match self.rules.get(id) {
            Some(RuleConfig::On(params)) => Some(params),
            Some(RuleConfig::Off) => None,
            None => {
                let on = self.default.unwrap_or_else(|| {
                    RULES
                        .iter()
                        .find(|r| r.id == id)
                        .is_some_and(|r| r.default_on)
                });
                on.then(|| &*EMPTY)
            }
        }
    }

    /// Only these rules (ids or names), with their current parameters; the rest off.
    #[must_use]
    pub fn restricted_to(&self, rules: &[String]) -> Self {
        let keep: Vec<&str> = rules
            .iter()
            .filter_map(|r| rule_info(r))
            .map(|r| r.id)
            .collect();
        let mut only = Self {
            default: Some(false),
            rules: BTreeMap::new(),
        };
        for id in keep {
            if let Some(params) = self.params(id) {
                only.rules.insert(id, RuleConfig::On(params.clone()));
            }
        }
        only
    }

    /// True if the rule runs.
    pub fn is_enabled(&self, id: &str) -> bool {
        self.params(id).is_some()
    }

    /// A project config on top of this one: what the project sets wins, and
    /// `"default": false` there turns off every rule it doesn't mention.
    #[must_use]
    pub fn with_project(&self, project: &Self) -> Self {
        let mut merged = self.clone();
        if let Some(default) = project.default {
            for info in RULES {
                if !project.rules.contains_key(info.id) {
                    // Deprecated rules (MD002, MD006) stay as they are.
                    if default && !info.default_on {
                        continue;
                    }
                    if default {
                        // On with the app's parameters, or the rule's own defaults.
                        let params = self.params(info.id).cloned().unwrap_or_default();
                        merged.rules.insert(info.id, RuleConfig::On(params));
                    } else {
                        merged.rules.insert(info.id, RuleConfig::Off);
                    }
                }
            }
        }
        for (id, setting) in &project.rules {
            merged.rules.insert(id, setting.clone());
        }
        merged
    }

    /// Reads a config object (`{"default": true, "MD013": false, …}`).
    pub fn from_value(value: &Value) -> Self {
        let mut config = Self::default();
        let Some(object) = value.as_object() else {
            return config;
        };
        for (key, value) in object {
            if key == "default" {
                config.default = value.as_bool();
                continue;
            }
            match value {
                Value::Bool(false) => config.set(key, RuleConfig::Off),
                Value::Object(params) => {
                    // markdownlint also accepts `"enabled": false` inside the object.
                    if params.get("enabled").and_then(Value::as_bool) == Some(false) {
                        config.set(key, RuleConfig::Off);
                    } else {
                        config.set(key, RuleConfig::On(params.clone()));
                    }
                }
                // Severity names ("warning"/"error") mean on too.
                Value::Bool(true) | Value::String(_) => config.set(key, RuleConfig::On(Map::new())),
                _ => {}
            }
        }
        config
    }

    /// Parses `.markdownlint.json` / `.jsonc` text (comments and trailing commas allowed).
    ///
    /// # Errors
    /// The text is not valid JSON.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let cleaned = strip_jsonc(text);
        let value: Value = serde_json::from_str(&cleaned).map_err(|e| e.to_string())?;
        Ok(Self::from_value(&value))
    }

    /// Parses `.markdownlint.yaml` text (the simple two-level form config files use).
    ///
    /// # Errors
    /// A line could not be understood.
    pub fn from_yaml(text: &str) -> Result<Self, String> {
        Ok(Self::from_value(&parse_simple_yaml(text)?))
    }

    /// Reads a config file, choosing the format by its extension.
    ///
    /// # Errors
    /// The file can't be read or parsed.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let yaml = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("yaml") || e.eq_ignore_ascii_case("yml"));
        let parsed = if yaml {
            Self::from_yaml(&text)
        } else {
            Self::from_json(&text)
        };
        parsed.map_err(|message| ConfigError::Invalid {
            path: path.to_path_buf(),
            message,
        })
    }
}

/// The nearest project config file, searching from `dir` up to the drive root.
pub fn find_config_file(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find_map(|folder| {
        CONFIG_FILE_NAMES
            .iter()
            .map(|name| folder.join(name))
            .find(|path| path.is_file())
    })
}

/// Removes `//` and `/* */` comments and trailing commas, outside strings.
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match (c, chars.get(i + 1)) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            ('/', Some('*')) => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
            (',', _) => {
                // Drop the comma if only whitespace/comments come before `}` or `]`.
                let rest: String = chars[i + 1..].iter().collect();
                let next = strip_jsonc_comments_only(&rest);
                if !next.trim_start().starts_with(['}', ']']) {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// The start of `rest` without leading whitespace and comments (enough to see the next token).
fn strip_jsonc_comments_only(rest: &str) -> &str {
    let mut s = rest.trim_start();
    loop {
        if let Some(after) = s.strip_prefix("//") {
            s = after.find('\n').map_or("", |n| &after[n..]).trim_start();
        } else if let Some(after) = s.strip_prefix("/*") {
            s = after
                .find("*/")
                .map_or("", |n| &after[n + 2..])
                .trim_start();
        } else {
            return s;
        }
    }
}

/// `key: value` lines with one nested level and simple lists — what markdownlint
/// YAML configs contain. Anything fancier is an error rather than a guess.
fn parse_simple_yaml(text: &str) -> Result<Value, String> {
    let mut root = Map::new();
    let mut current: Option<String> = None;
    let mut list_key: Option<String> = None;
    for (number, raw) in text.lines().enumerate() {
        let line = strip_yaml_comment(raw);
        if line.trim().is_empty() || line.trim() == "---" {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let content = line.trim();
        let error = || format!("line {}: cannot read `{}`", number + 1, raw.trim());
        if let Some(item) = content.strip_prefix("- ") {
            let (Some(rule), Some(key)) = (&current, &list_key) else {
                return Err(error());
            };
            let params = root
                .get_mut(rule)
                .and_then(Value::as_object_mut)
                .ok_or_else(error)?;
            if let Some(Value::Array(items)) = params.get_mut(key) {
                items.push(yaml_scalar(item));
            }
            continue;
        }
        let (key, value) = content.split_once(':').ok_or_else(error)?;
        let key = unquote(key.trim()).to_owned();
        let value = value.trim();
        if indent == 0 {
            list_key = None;
            if value.is_empty() {
                root.insert(key.clone(), Value::Object(Map::new()));
                current = Some(key);
            } else {
                root.insert(key, yaml_scalar(value));
                current = None;
            }
        } else {
            let rule = current.as_ref().ok_or_else(error)?;
            let params = root
                .get_mut(rule)
                .and_then(Value::as_object_mut)
                .ok_or_else(error)?;
            if value.is_empty() {
                params.insert(key.clone(), Value::Array(Vec::new()));
                list_key = Some(key);
            } else {
                params.insert(key, yaml_scalar(value));
                list_key = None;
            }
        }
    }
    Ok(Value::Object(root))
}

fn strip_yaml_comment(line: &str) -> &str {
    let mut quote = None;
    for (i, c) in line.char_indices() {
        match (c, quote) {
            ('"' | '\'', None) => quote = Some(c),
            (q, Some(open)) if q == open => quote = None,
            ('#', None) if i == 0 || line[..i].ends_with([' ', '\t']) => return &line[..i],
            _ => {}
        }
    }
    line
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s
}

fn yaml_scalar(value: &str) -> Value {
    let value = value.trim();
    if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        return Value::Array(
            inner
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(yaml_scalar)
                .collect(),
        );
    }
    match value {
        "true" | "True" | "yes" | "on" => return Value::Bool(true),
        "false" | "False" | "no" | "off" => return Value::Bool(false),
        "null" | "~" => return Value::Null,
        _ => {}
    }
    if let Ok(n) = value.parse::<i64>() {
        return Value::from(n);
    }
    Value::String(unquote(value).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_jsonc_with_comments_and_trailing_commas() {
        let config = LintConfig::from_json(
            "{\n  // long lines are fine\n  \"MD013\": false,\n  /* html */ \"no-inline-html\": false,\n  \"MD007\": { \"indent\": 4, },\n}",
        )
        .unwrap();
        assert!(!config.is_enabled("MD013"));
        assert!(!config.is_enabled("MD033"));
        assert_eq!(config.params("MD007").unwrap()["indent"], 4);
        assert!(config.is_enabled("MD001"));
    }

    #[test]
    fn keeps_commas_and_slashes_inside_strings() {
        let config =
            LintConfig::from_json(r#"{ "MD026": { "punctuation": ".,// /*" }, }"#).unwrap();
        assert_eq!(config.params("MD026").unwrap()["punctuation"], ".,// /*");
    }

    #[test]
    fn default_false_turns_off_unmentioned_rules() {
        let config = LintConfig::from_json(r#"{ "default": false, "MD001": true }"#).unwrap();
        assert!(config.is_enabled("MD001"));
        assert!(!config.is_enabled("MD009"));
    }

    #[test]
    fn project_config_wins_over_app_settings() {
        let app = LintConfig::app_defaults();
        assert!(!app.is_enabled("MD013"));
        let project =
            LintConfig::from_json(r#"{ "MD013": { "line_length": 200 }, "MD033": false }"#)
                .unwrap();
        let merged = app.with_project(&project);
        assert_eq!(merged.params("MD013").unwrap()["line_length"], 200);
        assert!(!merged.is_enabled("MD033"));
        assert!(merged.is_enabled("MD009"));
    }

    #[test]
    fn reads_yaml() {
        let config = LintConfig::from_yaml(
            "# comment\ndefault: true\nMD013:\n  line_length: 100\n  code_blocks: false\nMD033:\n  allowed_elements:\n    - br\n    - details\nno-trailing-punctuation: false\n",
        )
        .unwrap();
        assert_eq!(config.params("MD013").unwrap()["line_length"], 100);
        assert_eq!(config.params("MD013").unwrap()["code_blocks"], false);
        assert_eq!(
            config.params("MD033").unwrap()["allowed_elements"][1],
            "details"
        );
        assert!(!config.is_enabled("MD026"));
    }

    #[test]
    fn accepts_both_markdownlint_name_styles() {
        let config =
            LintConfig::from_json(r#"{ "heading-increment": false, "header-style": false }"#)
                .unwrap();
        assert!(!config.is_enabled("MD001"));
        assert!(!config.is_enabled("MD003"));
    }

    #[test]
    fn finds_the_nearest_config_upwards() {
        let dir = std::env::temp_dir().join(format!("atc-lint-config-{}", std::process::id()));
        let nested = dir.join("docs").join("guide");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join(".markdownlint.json"), "{}").unwrap();
        assert_eq!(
            find_config_file(&nested),
            Some(dir.join(".markdownlint.json"))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
