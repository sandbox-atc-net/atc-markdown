//! Reloads open documents when they change on disk.
//!
//! We watch each document's *folder* rather than the file itself: many editors
//! save by writing a temp file and renaming it, which breaks a watch on the file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use tauri::{AppHandle, Emitter};

/// Event sent to the frontend with the path of a changed document.
pub const DOCUMENT_CHANGED_EVENT: &str = "document-changed";

const DEBOUNCE: Duration = Duration::from_millis(200);

/// Watches the folders of all open documents.
pub struct DocumentWatcher {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    files: Arc<Mutex<HashSet<PathBuf>>>,
    /// Folder → number of open documents in it.
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
        let files = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
        let watched = Arc::clone(&files);

        let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let changed: HashSet<PathBuf> = {
                let watched = watched.lock().unwrap_or_else(PoisonError::into_inner);
                events
                    .into_iter()
                    .map(|event| event.path)
                    .filter(|path| watched.contains(path))
                    .collect()
            };
            for path in changed {
                tracing::debug!(?path, "document changed on disk");
                let _ = app.emit(DOCUMENT_CHANGED_EVENT, &path);
            }
        })
        .inspect_err(|error| tracing::warn!(%error, "file watching disabled"))
        .ok();

        Self {
            debouncer: Mutex::new(debouncer),
            files,
            dirs: Mutex::new(HashMap::new()),
        }
    }

    /// Starts watching `file`. Calling it again for the same file is harmless.
    pub fn watch(&self, file: &Path) {
        let Some(dir) = file.parent() else { return };
        if !lock(&self.files).insert(file.to_path_buf()) {
            return;
        }
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

    /// Stops watching `file` (and its folder, once no open document is left in it).
    pub fn unwatch(&self, file: &Path) {
        let Some(dir) = file.parent() else { return };
        if !lock(&self.files).remove(file) {
            return;
        }
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

    /// Stops watching every document.
    pub fn unwatch_all(&self) {
        lock(&self.files).clear();
        let mut dirs = lock(&self.dirs);
        if let Some(debouncer) = lock(&self.debouncer).as_mut() {
            for dir in dirs.keys() {
                let _ = debouncer.watcher().unwatch(dir);
            }
        }
        dirs.clear();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
