//! Open wikis, indexed once and re-indexed when pages are added or removed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use atc_markdown_core::{DocumentError, Wiki};

/// Wikis by root folder.
#[derive(Debug, Default)]
pub struct WikiRegistry(Mutex<HashMap<PathBuf, Arc<Wiki>>>);

impl WikiRegistry {
    /// Indexes (or re-indexes) the wiki in `root`.
    pub fn open(&self, root: &Path) -> Result<Arc<Wiki>, DocumentError> {
        let wiki = Arc::new(Wiki::open(root)?);
        self.lock()
            .insert(wiki.root().to_path_buf(), Arc::clone(&wiki));
        Ok(wiki)
    }

    /// The wiki in `root`, indexing it if needed.
    pub fn get(&self, root: &Path) -> Result<Arc<Wiki>, DocumentError> {
        if let Some(wiki) = self.lock().get(root) {
            return Ok(Arc::clone(wiki));
        }
        self.open(root)
    }

    /// Forgets a wiki so the next [`Self::get`] re-indexes it (pages added or removed).
    pub fn invalidate(&self, root: &Path) {
        self.lock().remove(root);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Arc<Wiki>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
