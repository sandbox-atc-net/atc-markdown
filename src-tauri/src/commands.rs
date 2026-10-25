//! Commands the frontend can call. Each one is a thin wrapper around the core crate.
//!
//! Commands that read and render files are `async`, so Tauri runs them off the
//! main thread and a large page can't freeze the window. Async commands that
//! borrow `State` must return a `Result`.
//!
//! Tauri commands take owned arguments and `State` by value, hence the
//! `needless_pass_by_value` allows.

use std::path::{Path, PathBuf};

use atc_markdown_core::{Document, LinkPreview, LinkTarget, WikiDocument, WikiInfo};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::file_open::PendingPaths;
use crate::watcher::DocumentWatcher;
use crate::wikis::WikiRegistry;

/// Reads and renders a Markdown file, and starts watching it for changes.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn open_document(
    app: AppHandle,
    watcher: State<'_, DocumentWatcher>,
    path: PathBuf,
) -> Result<Document, String> {
    let document = atc_markdown_core::load_document(&path).map_err(|error| {
        tracing::warn!(%error, "failed to open document");
        error.to_string()
    })?;
    allow_images(&app, &document.local_images);
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

/// How the frontend should open a path.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PathKind {
    /// A wiki folder.
    Wiki {
        /// The wiki folder.
        root: PathBuf,
    },
    /// A Markdown file; `wiki_root` is set when the file is a page of a wiki.
    #[serde(rename_all = "camelCase")]
    Document {
        /// The wiki the file belongs to, if any.
        wiki_root: Option<PathBuf>,
    },
}

/// Tells the frontend whether a path is a wiki folder or a document. Any folder
/// opened on purpose is shown as a wiki; a file inside a wiki folder is a document
/// that can also be opened as part of its wiki.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn path_kind(path: PathBuf) -> PathKind {
    if path.is_dir() {
        PathKind::Wiki { root: path }
    } else {
        PathKind::Document {
            wiki_root: atc_markdown_core::find_wiki_root(&path),
        }
    }
}

/// Indexes a wiki folder and starts watching it for added or removed pages.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn open_wiki(
    watcher: State<'_, DocumentWatcher>,
    wikis: State<'_, WikiRegistry>,
    root: PathBuf,
) -> Result<WikiInfo, String> {
    let wiki = wikis.open(&root).map_err(|error| {
        tracing::warn!(%error, "failed to open wiki");
        format!("Not a wiki folder: {error}")
    })?;
    watcher.watch_wiki(wiki.root());
    Ok(wiki.info())
}

/// Renders a page (or `_Sidebar.md` / `_Footer.md`) of an open wiki and watches it.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn open_wiki_page(
    app: AppHandle,
    watcher: State<'_, DocumentWatcher>,
    wikis: State<'_, WikiRegistry>,
    root: PathBuf,
    path: PathBuf,
) -> Result<WikiDocument, String> {
    let wiki = wikis.get(&root).map_err(|error| error.to_string())?;
    if !path.exists() {
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Err(format!(
            "The page “{}” does not exist in this wiki.",
            name.replace('-', " ")
        ));
    }
    let document = wiki.render(&path).map_err(|error| {
        tracing::warn!(%error, "failed to open wiki page");
        error.to_string()
    })?;
    allow_images(&app, &document.local_images);
    watcher.watch(&document.path);
    Ok(document)
}

/// Called when a wiki tab is closed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn close_wiki(watcher: State<'_, DocumentWatcher>, root: PathBuf, files: Vec<PathBuf>) {
    for file in &files {
        watcher.unwatch(file);
    }
    watcher.unwatch_wiki(&root);
}

/// Handles a clicked link. Web links open in the system browser and other local
/// files are revealed in the file manager; the result tells the frontend what to do
/// for anchors and Markdown documents. In a wiki, page links resolve to wiki pages.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn follow_link(
    app: AppHandle,
    wikis: State<'_, WikiRegistry>,
    document_path: PathBuf,
    href: String,
    wiki_root: Option<PathBuf>,
) -> LinkTarget {
    let target = resolve(&wikis, &document_path, &href, wiki_root.as_deref());
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
pub fn describe_link(
    wikis: State<'_, WikiRegistry>,
    document_path: PathBuf,
    href: String,
    wiki_root: Option<PathBuf>,
) -> LinkPreview {
    atc_markdown_core::preview_target(resolve(&wikis, &document_path, &href, wiki_root.as_deref()))
}

fn resolve(
    wikis: &WikiRegistry,
    document_path: &Path,
    href: &str,
    wiki_root: Option<&Path>,
) -> LinkTarget {
    match wiki_root.map(|root| wikis.get(root)) {
        Some(Ok(wiki)) => wiki.resolve_link(document_path, href),
        _ => atc_markdown_core::resolve_link(document_path, href),
    }
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

/// Lets the webview load exactly the local images a document uses.
fn allow_images(app: &AppHandle, images: &[PathBuf]) {
    let scope = app.asset_protocol_scope();
    for image in images {
        if let Err(error) = scope.allow_file(image) {
            tracing::warn!(%error, ?image, "could not allow image");
        }
    }
}
