//! The native app menu. Custom items are forwarded to the frontend as a
//! [`MENU_COMMAND_EVENT`] carrying the item id; the frontend owns the behaviour,
//! so menu items and keyboard shortcuts run the same code.

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event sent to the frontend with the id of the chosen menu item.
pub const MENU_COMMAND_EVENT: &str = "menu-command";

/// Ids of the custom menu items. Must match `Command` in `frontend/src/main.ts`.
pub const COMMAND_IDS: &[&str] = &[
    "open",
    "close-tab",
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
        .item(&item("open", "&Open…", &m("O"))?)
        .separator()
        .item(&item("close-tab", "&Close Tab", &m("W"))?);
    if !cfg!(target_os = "macos") {
        file = file.separator().quit_with_text("E&xit");
    }

    let mut edit = SubmenuBuilder::new(app, "&Edit");
    if cfg!(target_os = "macos") {
        // WKWebView only gets Copy / Select All through the menu.
        edit = edit.copy().select_all().separator();
    }
    let edit = edit
        .item(&item("find", "&Find…", &m("F"))?)
        .item(&item("find-next", "Find &Next", "F3")?)
        .item(&item("find-previous", "Find &Previous", "Shift+F3")?);

    let view = SubmenuBuilder::new(app, "&View")
        .item(&item("reload", "&Reload", "F5")?)
        .separator()
        .item(&item("zoom-in", "Zoom &In", &m("="))?)
        .item(&item("zoom-out", "Zoom &Out", &m("-"))?)
        .item(&item("zoom-reset", "&Actual Size", &m("0"))?)
        .separator()
        .item(&item("next-tab", "Ne&xt Tab", "Ctrl+Tab")?)
        .item(&item("previous-tab", "Pre&vious Tab", "Ctrl+Shift+Tab")?);

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        // On macOS the first submenu is the application menu.
        let app_menu = SubmenuBuilder::new(app, &package.name)
            .about(Some(about.clone()))
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
    menu = menu
        .item(&file.build()?)
        .item(&edit.build()?)
        .item(&view.build()?);

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

/// Forwards custom menu items to the frontend.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let id = event.id().as_ref();
    if COMMAND_IDS.contains(&id)
        && let Some(window) = app.get_webview_window("main")
    {
        let _ = window.emit(MENU_COMMAND_EVENT, id);
    }
}
