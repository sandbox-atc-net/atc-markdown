//! Commands the frontend can call. Each one is a thin wrapper around the core crate.
//!
//! Tauri commands take owned arguments and `State` by value, hence the
//! `needless_pass_by_value` allows.

use std::path::PathBuf;

use atc_markdown_core::{Document, LinkPreview, LinkTarget};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::file_open::PendingPaths;
use crate::watcher::DocumentWatcher;

/// Reads and renders a Markdown file, and starts watching it for changes.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_document(
    app: AppHandle,
    watcher: State<'_, DocumentWatcher>,
    path: PathBuf,
) -> Result<Document, String> {
    let document = atc_markdown_core::load_document(&path).map_err(|error| {
        tracing::warn!(%error, "failed to open document");
        error.to_string()
    })?;

    // Let the webview load exactly the local images this document uses.
    let scope = app.asset_protocol_scope();
    for image in &document.local_images {
        if let Err(error) = scope.allow_file(image) {
            tracing::warn!(%error, ?image, "could not allow image");
        }
    }

    watcher.watch(&document.path);
    Ok(document)
}

/// Called when a tab is closed: stop watching the file.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn close_document(watcher: State<'_, DocumentWatcher>, path: PathBuf) {
    watcher.unwatch(&path);
}

/// Called when the frontend starts (or is reloaded): forget documents from before.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn close_all_documents(watcher: State<'_, DocumentWatcher>) {
    watcher.unwatch_all();
}

/// Handles a clicked link. Web links open in the system browser and other local
/// files are revealed in the file manager; the result tells the frontend what to do
/// for anchors and Markdown documents.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn follow_link(app: AppHandle, document_path: PathBuf, href: String) -> LinkTarget {
    let target = atc_markdown_core::resolve_link(&document_path, &href);
    let result = match &target {
        LinkTarget::External { url } => app.opener().open_url(url, None::<&str>),
        LinkTarget::LocalFile { path } if path.exists() => app.opener().reveal_item_in_dir(path),
        _ => Ok(()),
    };
    if let Err(error) = result {
        tracing::warn!(%error, ?target, "could not follow link");
    }
    target
}

/// Describes a link for the hover preview. Opens nothing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn describe_link(document_path: PathBuf, href: String) -> LinkPreview {
    atc_markdown_core::describe_link(&document_path, &href)
}

/// Shows a file in Explorer / Finder ("Show in folder" on a link).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn reveal_path(app: AppHandle, path: PathBuf) {
    if let Err(error) = app.opener().reveal_item_in_dir(&path) {
        tracing::warn!(%error, ?path, "could not reveal file");
    }
}

/// CSS for syntax-highlighted code blocks (light + dark).
#[tauri::command]
pub fn highlight_css() -> &'static str {
    atc_markdown_core::highlight_css()
}

/// Returns (and clears) the files the OS asked us to open.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn take_pending_paths(pending: State<'_, PendingPaths>) -> Vec<PathBuf> {
    let paths = pending.take();
    tracing::debug!(?paths, "frontend took pending paths");
    paths
}

/// Lets the frontend write unexpected errors to the app log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn log_frontend_error(message: String) {
    tracing::error!(target: "frontend", "{message}");
}
