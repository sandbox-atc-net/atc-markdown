//! Tauri shell for Atc.Markdown. Logic lives in `atc-markdown-core`; this crate
//! only wires OS events and commands to it.

mod commands;
mod file_open;
mod git;
mod menu;
mod settings;
mod watcher;
mod wikis;

use tauri::{AppHandle, Emitter, Manager, RunEvent};

use file_open::PendingPaths;
use settings::SettingsStore;
use watcher::DocumentWatcher;
use wikis::WikiRegistry;

/// Builds and runs the app.
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let app = tauri::Builder::default()
        // Must be registered first so a second launch is caught before anything else runs.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            file_open::on_second_instance(app, &args, &cwd);
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingPaths::default())
        .manage(WikiRegistry::default())
        .setup(|app| {
            // Load syntax definitions in the background so the first document opens fast.
            std::thread::spawn(atc_markdown_core::warm_up);
            app.manage(SettingsStore::load(app.path().app_config_dir().ok()));
            app.manage(DocumentWatcher::new(app.handle().clone()));
            app.set_menu(menu::build(app.handle())?)?;
            app.on_menu_event(|app, event| menu::on_event(app, &event));
            file_open::on_startup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_document,
            commands::close_document,
            commands::read_source,
            commands::save_source,
            commands::render_source,
            commands::lint_source,
            commands::fix_source,
            commands::lint_rules,
            commands::code_languages,
            commands::exit_app,
            commands::close_all_documents,
            commands::path_kind,
            commands::open_wiki,
            commands::open_wiki_page,
            commands::close_wiki,
            commands::search_wiki,
            commands::git_last_edited,
            commands::follow_link,
            commands::describe_link,
            commands::reveal_path,
            commands::highlight_css,
            commands::take_pending_paths,
            commands::log_frontend_error,
            commands::get_settings,
            commands::update_settings,
            commands::code_themes,
            commands::default_settings,
            commands::reveal_settings_file,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(handle_run_event),
        Err(error) => tracing::error!(%error, "failed to start Atc.Markdown"),
    }
}

fn handle_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        // A quit from the OS (e.g. Cmd+Q on macOS) while the window is open:
        // let the frontend ask about unsaved changes first; it then calls `exit_app`.
        // `code` is set when the app itself exits, which must not be stopped.
        RunEvent::ExitRequested {
            api, code: None, ..
        } if app.get_webview_window("main").is_some() => {
            api.prevent_exit();
            let _ = app.emit(menu::MENU_COMMAND_EVENT, "exit");
        }
        // macOS delivers double-clicked files as an event instead of argv.
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => file_open::on_opened_urls(app, &urls),
        _ => {}
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
