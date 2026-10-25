//! Reloads open documents when they change on disk, and tells open wikis when
//! pages are added, renamed or removed.
//!
//! We watch each document's *folder* rather than the file itself: many editors
//! save by writing a temp file and renaming it, which breaks a watch on the file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use atc_markdown_core::is_markdown_file;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use tauri::{AppHandle, Emitter, Manager};

use crate::wikis::WikiRegistry;

/// Event sent to the frontend with the path of a changed document.
pub const DOCUMENT_CHANGED_EVENT: &str = "document-changed";
/// Event sent to the frontend with the root of a wiki whose page list may have changed.
pub const WIKI_CHANGED_EVENT: &str = "wiki-changed";

const DEBOUNCE: Duration = Duration::from_millis(200);

/// What is being watched. Shared with the OS watcher's callback.
#[derive(Debug, Default)]
struct Watched {
    files: HashSet<PathBuf>,
    wiki_roots: HashSet<PathBuf>,
}

/// Watches the folders of all open documents and wikis.
pub struct DocumentWatcher {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched: Arc<Mutex<Watched>>,
    /// Folder → number of open documents and wikis that need it.
    dirs: Mutex<HashMap<PathBuf, usize>>,
}

impl std::fmt::Debug for DocumentWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DocumentWatcher").finish_non_exhaustive()
    }
}

impl DocumentWatcher {
    /// Creates the watcher. If the OS watcher cannot start, auto-reload is disabled.
    pub fn new(app: AppHandle) -> Self {
        let watched = Arc::new(Mutex::new(Watched::default()));
        let shared = Arc::clone(&watched);

        let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let (files, wikis): (HashSet<PathBuf>, HashSet<PathBuf>) = {
                let watched = lock(&shared);
                let paths: Vec<PathBuf> = events.into_iter().map(|event| event.path).collect();
                let files = paths
                    .iter()
                    .filter(|path| watched.files.contains(*path))
                    .cloned()
                    .collect();
                let wikis = paths
                    .iter()
                    .filter(|path| is_markdown_file(path))
                    .filter_map(|path| path.parent())
                    .filter(|dir| watched.wiki_roots.contains(*dir))
                    .map(Path::to_path_buf)
                    .collect();
                (files, wikis)
            };
            for root in wikis {
                tracing::debug!(?root, "wiki pages changed on disk");
                app.state::<WikiRegistry>().invalidate(&root);
                let _ = app.emit(WIKI_CHANGED_EVENT, &root);
            }
            for path in files {
                tracing::debug!(?path, "document changed on disk");
                let _ = app.emit(DOCUMENT_CHANGED_EVENT, &path);
            }
        })
        .inspect_err(|error| tracing::warn!(%error, "file watching disabled"))
        .ok();

        Self {
            debouncer: Mutex::new(debouncer),
            watched,
            dirs: Mutex::new(HashMap::new()),
        }
    }

    /// Starts watching `file`. Calling it again for the same file is harmless.
    pub fn watch(&self, file: &Path) {
        let Some(dir) = file.parent() else { return };
        if lock(&self.watched).files.insert(file.to_path_buf()) {
            self.retain_dir(dir);
        }
    }

    /// Stops watching `file` (and its folder, once nothing else needs it).
    pub fn unwatch(&self, file: &Path) {
        let Some(dir) = file.parent() else { return };
        if lock(&self.watched).files.remove(file) {
            self.release_dir(dir);
        }
    }

    /// Starts watching a wiki folder for added, renamed and removed pages.
    pub fn watch_wiki(&self, root: &Path) {
        if lock(&self.watched).wiki_roots.insert(root.to_path_buf()) {
            self.retain_dir(root);
        }
    }

    /// Stops watching a wiki folder.
    pub fn unwatch_wiki(&self, root: &Path) {
        if lock(&self.watched).wiki_roots.remove(root) {
            self.release_dir(root);
        }
    }

    /// Stops watching everything.
    pub fn unwatch_all(&self) {
        {
            let mut watched = lock(&self.watched);
            watched.files.clear();
            watched.wiki_roots.clear();
        }
        let mut dirs = lock(&self.dirs);
        if let Some(debouncer) = lock(&self.debouncer).as_mut() {
            for dir in dirs.keys() {
                let _ = debouncer.watcher().unwatch(dir);
            }
        }
        dirs.clear();
    }

    fn retain_dir(&self, dir: &Path) {
        let mut dirs = lock(&self.dirs);
        let count = dirs.entry(dir.to_path_buf()).or_insert(0);
        *count += 1;
        if *count == 1
            && let Some(debouncer) = lock(&self.debouncer).as_mut()
            && let Err(error) = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive)
        {
            tracing::warn!(%error, ?dir, "could not watch folder");
        }
    }

    fn release_dir(&self, dir: &Path) {
        let mut dirs = lock(&self.dirs);
        if let Some(count) = dirs.get_mut(dir) {
            *count -= 1;
            if *count == 0 {
                dirs.remove(dir);
                if let Some(debouncer) = lock(&self.debouncer).as_mut() {
                    let _ = debouncer.watcher().unwatch(dir);
                }
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
