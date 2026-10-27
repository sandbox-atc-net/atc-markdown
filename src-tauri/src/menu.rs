//! The native app menu. Custom items are forwarded to the frontend as a
//! [`MENU_COMMAND_EVENT`] carrying the item id; the frontend owns the behaviour,
//! so menu items and keyboard shortcuts run the same code.

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, Submenu,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event sent to the frontend with the id of the chosen menu item.
pub const MENU_COMMAND_EVENT: &str = "menu-command";

/// Ids of the custom menu items. Must match `Command` in `frontend/src/main.ts`.
pub const COMMAND_IDS: &[&str] = &[
    "open",
    "open-folder",
    "close-folder",
    "find-in-folder",
    "close-tab",
    "go-back",
    "go-forward",
    "toggle-sidebar",
    "find-page",
    "settings",
    "toggle-outline",
    "reopen-tab",
    "print",
    "new-file",
    "save",
    "save-as",
    "toggle-edit",
    "mode-preview",
    "mode-split",
    "mode-edit",
    "editor-line-numbers",
    "lint-panel",
    "lint-fix-all",
    "lint-folder",
    "exit",
    "reload",
    "find",
    "find-next",
    "find-previous",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
    "next-tab",
    "previous-tab",
];

/// Builds the menu bar.
///
/// Keyboard shortcuts are handled by the frontend, which always has focus, so they
/// are not registered as menu accelerators (that could run a command twice). On
/// Windows the shortcut is still shown, using the Win32 "text\tshortcut" convention.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, shortcut: &str| {
        let text = if cfg!(windows) {
            format!("{text}\t{shortcut}")
        } else {
            text.to_owned()
        };
        MenuItemBuilder::with_id(id, text).build(app)
    };
    let m = |key: &str| format!("Ctrl+{key}");

    let package = app.package_info();
    let about = AboutMetadataBuilder::new()
        .name(Some(package.name.clone()))
        .version(Some(package.version.to_string()))
        .copyright(Some("© ATC.Net. MIT License."))
        .build();

    let mut file = SubmenuBuilder::new(app, "&File")
        .item(&item("new-file", "&New", &m("N"))?)
        .item(&item("open", "&Open…", &m("O"))?)
        .item(&item("open-folder", "Open &Folder…", &m("Shift+O"))?)
        .item(&item("close-folder", "Close F&older", "")?)
        .separator()
        .item(&item("save", "&Save", &m("S"))?)
        .item(&item("save-as", "Save &As…", &m("Shift+S"))?)
        .separator()
        .item(&item("print", "&Print…", &m("Shift+P"))?)
        .separator()
        .item(&item("close-tab", "&Close Tab", &m("W"))?)
        .item(&item("reopen-tab", "&Reopen Closed Tab", &m("Shift+T"))?);
    if !cfg!(target_os = "macos") {
        // Not the predefined Quit: Exit must first ask about unsaved changes.
        file = file.separator().item(&item("exit", "E&xit", "Alt+F4")?);
    }

    let mut edit = SubmenuBuilder::new(app, "&Edit");
    if cfg!(target_os = "macos") {
        // WKWebView only gets Copy / Select All through the menu.
        edit = edit.copy().select_all().separator();
    }
    let mut edit = edit
        .item(&item("find", "&Find…", &m("F"))?)
        .item(&item("find-next", "Find &Next", "F3")?)
        .item(&item("find-previous", "Find &Previous", "Shift+F3")?)
        .item(&item("find-in-folder", "Find in F&older…", &m("Shift+F"))?);
    if !cfg!(target_os = "macos") {
        // macOS has Settings in the application menu instead.
        edit = edit
            .separator()
            .item(&item("settings", "&Settings…", &m(","))?);
    }

    let view = view_menu(app)?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        // On macOS the first submenu is the application menu.
        let app_menu = SubmenuBuilder::new(app, &package.name)
            .about(Some(about.clone()))
            .separator()
            .item(&item("settings", "Settings…", "")?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu = menu.item(&file.build()?).item(&edit.build()?).item(&view);

    if cfg!(target_os = "macos") {
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .fullscreen()
            .build()?;
        menu = menu.item(&window);
    } else {
        let help = SubmenuBuilder::new(app, "&Help")
            .about_with_text(format!("&About {}", package.name), Some(about))
            .build()?;
        menu = menu.item(&help);
    }

    menu.build()
}

/// View: modes, navigation, zoom and tabs.
fn view_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "&View")
        .item(&menu_item(app, "mode-preview", "&Preview", "")?)
        .item(&menu_item(
            app,
            "mode-split",
            "&Split (Editor + Preview)",
            "",
        )?)
        .item(&menu_item(app, "mode-edit", "&Editor", "")?)
        .item(&menu_item(app, "toggle-edit", "Toggle Editor", &ctrl("E"))?)
        .item(&menu_item(
            app,
            "editor-line-numbers",
            "Editor &Line Numbers",
            &ctrl("Shift+N"),
        )?)
        .item(&menu_item(
            app,
            "lint-panel",
            "Lint Pro&blems",
            &ctrl("Shift+M"),
        )?)
        .item(&menu_item(
            app,
            "lint-fix-all",
            "Fix All Lint Iss&ues",
            &ctrl("Shift+."),
        )?)
        .item(&menu_item(app, "lint-folder", "Lint &Folder…", "")?)
        .separator()
        .item(&menu_item(app, "reload", "&Reload", "F5")?)
        .separator()
        .item(&menu_item(app, "go-back", "&Back", "Alt+Left")?)
        .item(&menu_item(app, "go-forward", "&Forward", "Alt+Right")?)
        .item(&menu_item(
            app,
            "toggle-sidebar",
            "Explorer / Wiki &Sidebar",
            &ctrl("B"),
        )?)
        .item(&menu_item(
            app,
            "find-page",
            "&Go to Wiki Page…",
            &ctrl("P"),
        )?)
        .item(&menu_item(
            app,
            "toggle-outline",
            "&Outline",
            &ctrl("Shift+L"),
        )?)
        .separator()
        .item(&menu_item(app, "zoom-in", "Zoom &In", &ctrl("="))?)
        .item(&menu_item(app, "zoom-out", "Zoom &Out", &ctrl("-"))?)
        .item(&menu_item(app, "zoom-reset", "&Actual Size", &ctrl("0"))?)
        .separator()
        .item(&menu_item(app, "next-tab", "Ne&xt Tab", "Ctrl+Tab")?)
        .item(&menu_item(
            app,
            "previous-tab",
            "Pre&vious Tab",
            "Ctrl+Shift+Tab",
        )?)
        .build()
}

/// A menu item; on Windows the shortcut is shown after a tab character (Win32 convention).
fn menu_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    shortcut: &str,
) -> tauri::Result<MenuItem<R>> {
    let text = if cfg!(windows) && !shortcut.is_empty() {
        format!("{text}	{shortcut}")
    } else {
        text.to_owned()
    };
    MenuItemBuilder::with_id(id, text).build(app)
}

fn ctrl(key: &str) -> String {
    format!("Ctrl+{key}")
}

/// Forwards custom menu items to the frontend.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let id = event.id().as_ref();
    if COMMAND_IDS.contains(&id)
        && let Some(window) = app.get_webview_window("main")
    {
        let _ = window.emit(MENU_COMMAND_EVENT, id);
    }
}
