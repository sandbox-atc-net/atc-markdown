//! User settings, stored as `settings.json` in the OS app-config folder.
//!
//! Loading never fails: the file is merged onto the defaults one key at a time,
//! and a key that is unknown or has an invalid value is simply skipped. So an
//! older or newer app version, or a hand edit gone wrong, can't lose the rest.

// On/off settings are naturally bools.
#![allow(clippy::struct_excessive_bools)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use atc_markdown_core::{FrontMatterStyle, RenderOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Event sent to the frontend with the new settings after every change.
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";

const FILE_NAME: &str = "settings.json";
const VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadingWidth {
    #[default]
    Medium,
    Narrow,
    Wide,
    Full,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageList {
    #[default]
    Collapsed,
    Expanded,
    Hidden,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenIn {
    #[default]
    NewTab,
    ReplaceCurrent,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyButton {
    #[default]
    Hover,
    Always,
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    pub theme: Theme,
    /// Id from `atc_markdown_core::CODE_THEMES`.
    pub code_theme: String,
    /// Percent; Ctrl +/- changes it.
    pub text_size: u32,
    pub reading_width: ReadingWidth,
    /// CSS font family; empty = system default.
    pub reading_font: String,
    /// CSS font family; empty = system default.
    pub code_font: String,
    /// The outline panel (document headings) is shown.
    pub show_outline: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            code_theme: atc_markdown_core::CODE_THEMES[0].id.to_owned(),
            text_size: 100,
            reading_width: ReadingWidth::Medium,
            reading_font: String::new(),
            code_font: String::new(),
            show_outline: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WikiSettings {
    pub sidebar_position: Side,
    pub sidebar_visible: bool,
    pub sidebar_width: u32,
    pub page_list: PageList,
    pub page_header: bool,
    pub show_footer: bool,
    pub offer_open_as_wiki: bool,
}

impl Default for WikiSettings {
    fn default() -> Self {
        Self {
            sidebar_position: Side::Left,
            sidebar_visible: true,
            sidebar_width: 280,
            page_list: PageList::Collapsed,
            page_header: true,
            show_footer: true,
            offer_open_as_wiki: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FileSettings {
    pub restore_session: bool,
    pub open_from_os: OpenIn,
    pub auto_reload: bool,
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            restore_session: true,
            open_from_os: OpenIn::NewTab,
            auto_reload: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkSettings {
    pub status_bubble: bool,
    pub confirm_external: bool,
    pub external_marker: bool,
}

impl Default for LinkSettings {
    fn default() -> Self {
        Self {
            status_bubble: true,
            confirm_external: false,
            external_marker: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RenderingSettings {
    pub front_matter: FrontMatterStyle,
    pub emoji: bool,
    pub mermaid: bool,
    pub math: bool,
}

impl Default for RenderingSettings {
    fn default() -> Self {
        Self {
            front_matter: FrontMatterStyle::Table,
            emoji: true,
            mermaid: true,
            math: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeSettings {
    pub copy_button: CopyButton,
    pub wrap_lines: bool,
    pub line_numbers: bool,
}

/// All user settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub appearance: Appearance,
    pub wiki: WikiSettings,
    pub files: FileSettings,
    pub links: LinkSettings,
    pub rendering: RenderingSettings,
    pub code: CodeSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: VERSION,
            appearance: Appearance::default(),
            wiki: WikiSettings::default(),
            files: FileSettings::default(),
            links: LinkSettings::default(),
            rendering: RenderingSettings::default(),
            code: CodeSettings::default(),
        }
    }
}

impl Settings {
    /// Builds settings from JSON, keeping every valid key and skipping the rest.
    pub fn from_value(user: &Value) -> Self {
        Self::default().merge(user)
    }

    /// These settings with the valid keys of `user` applied on top.
    pub fn merge(&self, user: &Value) -> Self {
        let mut merged = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(sections) = user.as_object() {
            for (section, values) in sections {
                let Some(values) = values.as_object() else {
                    continue;
                };
                for (key, value) in values {
                    let mut candidate = merged.clone();
                    let Some(slot) = candidate.get_mut(section).and_then(|s| s.get_mut(key)) else {
                        continue; // unknown section or key
                    };
                    *slot = value.clone();
                    if serde_json::from_value::<Self>(candidate.clone()).is_ok() {
                        merged = candidate;
                    }
                }
            }
        }
        serde_json::from_value::<Self>(merged)
            .unwrap_or_default()
            .normalized()
    }

    /// Clamps numbers and replaces unknown ids, so the UI never gets nonsense.
    fn normalized(mut self) -> Self {
        self.version = VERSION;
        self.appearance.text_size = self.appearance.text_size.clamp(50, 300);
        self.wiki.sidebar_width = self.wiki.sidebar_width.clamp(160, 900);
        let code_theme = atc_markdown_core::code_theme(&self.appearance.code_theme).id;
        code_theme.clone_into(&mut self.appearance.code_theme);
        self.appearance.reading_font = clean_font(&self.appearance.reading_font);
        self.appearance.code_font = clean_font(&self.appearance.code_font);
        self
    }

    /// The choices that change rendered HTML.
    pub fn render_options(&self) -> RenderOptions {
        RenderOptions {
            front_matter: self.rendering.front_matter,
            emoji: self.rendering.emoji,
            math: self.rendering.math,
        }
    }
}

/// A font name goes into CSS; keep only characters a font family list needs.
fn clean_font(font: &str) -> String {
    font.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | ',' | '-' | '_' | '"' | '\''))
        .take(200)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The settings in memory and on disk.
#[derive(Debug)]
pub struct SettingsStore {
    path: Option<PathBuf>,
    settings: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads `settings.json` from `dir` (defaults if missing or unreadable).
    pub fn load(dir: Option<PathBuf>) -> Self {
        let path = dir.map(|dir| dir.join(FILE_NAME));
        let settings = path
            .as_deref()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map_or_else(Settings::default, |value| Settings::from_value(&value));
        Self {
            path,
            settings: Mutex::new(settings),
        }
    }

    /// Where the settings are saved, if the OS config folder is known.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn get(&self) -> Settings {
        self.settings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Applies the valid keys of `value` (a full or partial settings object) and saves.
    pub fn update(&self, value: &Value) -> Settings {
        let settings = {
            let mut current = self.settings.lock().unwrap_or_else(PoisonError::into_inner);
            *current = current.merge(value);
            current.clone()
        };
        if let Some(path) = &self.path
            && let Err(error) = save(path, &settings)
        {
            tracing::warn!(%error, ?path, "could not save settings");
        }
        settings
    }
}

/// Writes atomically: a temp file next to the target, then a rename.
fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json)?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_round_trip() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(Settings::from_value(&value), Settings::default());
    }

    #[test]
    fn keeps_valid_keys_and_skips_invalid_or_unknown_ones() {
        let settings = Settings::from_value(&json!({
            "appearance": { "theme": "dark", "textSize": "huge", "unknown": 1 },
            "wiki": { "sidebarPosition": "right", "pageList": "sideways" },
            "nope": { "x": 1 },
            "code": "not an object"
        }));
        assert_eq!(settings.appearance.theme, Theme::Dark);
        assert_eq!(settings.appearance.text_size, 100);
        assert_eq!(settings.wiki.sidebar_position, Side::Right);
        assert_eq!(settings.wiki.page_list, PageList::Collapsed);
        assert_eq!(settings.code, CodeSettings::default());
    }

    #[test]
    fn clamps_and_cleans_values() {
        let settings = Settings::from_value(&json!({
            "appearance": { "textSize": 5000, "codeTheme": "nope", "readingFont": "Georgia; } body { x" },
            "wiki": { "sidebarWidth": 10 }
        }));
        assert_eq!(settings.appearance.text_size, 300);
        assert_eq!(settings.appearance.code_theme, "github");
        assert_eq!(settings.appearance.reading_font, "Georgia  body  x");
        assert_eq!(settings.wiki.sidebar_width, 160);
    }

    #[test]
    fn broken_input_gives_defaults() {
        assert_eq!(Settings::from_value(&json!(null)), Settings::default());
        assert_eq!(Settings::from_value(&json!([1, 2])), Settings::default());
    }

    #[test]
    fn saves_and_loads() {
        let dir = std::env::temp_dir().join("atc-markdown-settings-test");
        let _ = fs::remove_dir_all(&dir);
        let store = SettingsStore::load(Some(dir.clone()));
        assert_eq!(store.get(), Settings::default());
        store.update(&json!({ "files": { "restoreSession": false } }));
        // A partial update keeps everything else.
        store.update(&json!({ "appearance": { "theme": "light" } }));
        let reloaded = SettingsStore::load(Some(dir));
        assert!(!reloaded.get().files.restore_session);
        assert_eq!(reloaded.get().appearance.theme, Theme::Light);
    }
}
