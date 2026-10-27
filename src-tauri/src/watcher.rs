//! One watcher for everything on disk the app shows: open documents (reloaded
//! when they change), and whole folder trees — open wikis and the folder open
//! in the Explorer — whose file lists change when files or folders are added,
//! renamed or removed.
//!
//! A document is watched through its *folder* rather than the file itself:
//! many editors save by writing a temp file and renaming it, which breaks a
//! watch on the file. Trees are watched recursively.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
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
/// Event sent to the frontend with the root of an open folder whose tree may have changed.
pub const FOLDER_CHANGED_EVENT: &str = "folder-changed";

const DEBOUNCE: Duration = Duration::from_millis(200);

/// What kind of tree a watched root is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TreeKind {
    Wiki,
    Folder,
}

/// What is being watched. Shared with the OS watcher's callback.
#[derive(Debug, Default)]
struct Watched {
    files: HashSet<PathBuf>,
    /// Tree roots, with the folder names skipped inside them (lowercase).
    trees: HashMap<(PathBuf, TreeKind), Vec<String>>,
}

/// How many documents and trees need a folder watched.
#[derive(Debug, Default)]
struct DirUse {
    files: usize,
    trees: usize,
    /// How the folder is watched now.
    mode: Option<RecursiveMode>,
}

/// Watches the folders of all open documents, wikis and the open folder.
pub struct DocumentWatcher {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched: Arc<Mutex<Watched>>,
    dirs: Mutex<HashMap<PathBuf, DirUse>>,
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
            let paths: Vec<PathBuf> = events.into_iter().map(|event| event.path).collect();
            let (files, trees) = {
                let watched = lock(&shared);
                let files: HashSet<PathBuf> = paths
                    .iter()
                    .filter(|path| watched.files.contains(*path))
                    .cloned()
                    .collect();
                let trees: HashSet<(PathBuf, TreeKind)> = watched
                    .trees
                    .iter()
                    .filter(|((root, _), skipped)| {
                        paths.iter().any(|path| changes_tree(root, skipped, path))
                    })
                    .map(|(key, _)| key.clone())
                    .collect();
                (files, trees)
            };
            for (root, kind) in trees {
                match kind {
                    TreeKind::Wiki => {
                        tracing::debug!(?root, "wiki pages changed on disk");
                        app.state::<WikiRegistry>().invalidate(&root);
                        let _ = app.emit(WIKI_CHANGED_EVENT, &root);
                    }
                    TreeKind::Folder => {
                        tracing::debug!(?root, "folder tree changed on disk");
                        let _ = app.emit(FOLDER_CHANGED_EVENT, &root);
                    }
                }
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
            self.change_dir(dir, |d| d.files += 1);
        }
    }

    /// Stops watching `file` (and its folder, once nothing else needs it).
    pub fn unwatch(&self, file: &Path) {
        let Some(dir) = file.parent() else { return };
        if lock(&self.watched).files.remove(file) {
            self.change_dir(dir, |d| d.files = d.files.saturating_sub(1));
        }
    }

    /// Starts watching a whole folder tree (a wiki or the open folder) for
    /// added, renamed and removed Markdown files and folders. Changes inside
    /// hidden folders and folders named in `skipped` are ignored.
    pub fn watch_tree(&self, root: &Path, kind: TreeKind, skipped: &[String]) {
        let skipped = skipped.iter().map(|s| s.trim().to_lowercase()).collect();
        let new = lock(&self.watched)
            .trees
            .insert((root.to_path_buf(), kind), skipped)
            .is_none();
        if new {
            self.change_dir(root, |d| d.trees += 1);
        }
    }

    /// Stops watching a folder tree.
    pub fn unwatch_tree(&self, root: &Path, kind: TreeKind) {
        let removed = lock(&self.watched)
            .trees
            .remove(&(root.to_path_buf(), kind))
            .is_some();
        if removed {
            self.change_dir(root, |d| d.trees = d.trees.saturating_sub(1));
        }
    }

    /// Stops watching everything.
    pub fn unwatch_all(&self) {
        {
            let mut watched = lock(&self.watched);
            watched.files.clear();
            watched.trees.clear();
        }
        let mut dirs = lock(&self.dirs);
        if let Some(debouncer) = lock(&self.debouncer).as_mut() {
            for dir in dirs.keys() {
                let _ = debouncer.watcher().unwatch(dir);
            }
        }
        dirs.clear();
    }

    /// Updates who needs `dir`, and watches it recursively, flat or not at all.
    fn change_dir(&self, dir: &Path, update: impl FnOnce(&mut DirUse)) {
        let mut dirs = lock(&self.dirs);
        let entry = dirs.entry(dir.to_path_buf()).or_default();
        update(entry);
        let wanted = if entry.trees > 0 {
            Some(RecursiveMode::Recursive)
        } else if entry.files > 0 {
            Some(RecursiveMode::NonRecursive)
        } else {
            None
        };
        if wanted != entry.mode {
            if let Some(debouncer) = lock(&self.debouncer).as_mut() {
                if entry.mode.is_some() {
                    let _ = debouncer.watcher().unwatch(dir);
                }
                if let Some(mode) = wanted
                    && let Err(error) = debouncer.watcher().watch(dir, mode)
                {
                    tracing::warn!(%error, ?dir, "could not watch folder");
                }
            }
            entry.mode = wanted;
        }
        if entry.mode.is_none() {
            dirs.remove(dir);
        }
    }
}

/// True if a change at `path` can change the file list of the tree at `root`:
/// a Markdown file, or a folder (added, removed or renamed — a removed path no
/// longer exists, so it can't be told apart from a removed file), outside
/// hidden and skipped folders.
fn changes_tree(root: &Path, skipped: &[String], path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let ignored = relative.components().any(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name.starts_with('.') || skipped.contains(&name.to_lowercase())
        }
        _ => false,
    });
    !ignored && !relative.as_os_str().is_empty() && (is_markdown_file(path) || !path.is_file())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_markdown_and_folder_changes_outside_skipped_folders_count() {
        let root = std::env::temp_dir().join(format!("atc-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/code.rs"), "").unwrap();
        let skipped = vec!["target".to_owned()];
        let counts = |relative: &str| changes_tree(&root, &skipped, &root.join(relative));

        assert!(counts("docs/new.md"));
        assert!(counts("docs"), "a folder");
        assert!(counts("removed-folder"), "gone: may have been a folder");
        assert!(!counts("docs/code.rs"), "an existing non-Markdown file");
        assert!(!counts(".git/index"));
        assert!(!counts("target/doc/x.md"));
        assert!(!counts("Target/x.md"), "names are compared ignoring case");
        assert!(!counts(""), "the root itself");
        assert!(!changes_tree(&root, &skipped, Path::new("/elsewhere/a.md")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
