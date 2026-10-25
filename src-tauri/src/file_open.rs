//! The ways a file reaches the app from the OS.
//!
//! | Platform        | App not running         | App already running              |
//! |-----------------|-------------------------|----------------------------------|
//! | Windows / Linux | process argv            | single-instance plugin callback  |
//! | macOS           | `RunEvent::Opened`      | `RunEvent::Opened`               |
//!
//! Paths may arrive before the frontend is ready, so they are always queued in
//! [`PendingPaths`]. The frontend is then nudged with [`FILES_PENDING_EVENT`] and
//! pulls the queue with the `take_pending_paths` command — once on startup and
//! again on every nudge. That way no path is lost, whatever the timing.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use atc_markdown_core::paths_from_args;
use tauri::{AppHandle, Emitter, Manager};

/// Event telling the frontend that new paths are waiting in the queue.
pub const FILES_PENDING_EVENT: &str = "files-pending";

/// Paths waiting to be opened by the frontend.
#[derive(Debug, Default)]
pub struct PendingPaths(Mutex<Vec<PathBuf>>);

impl PendingPaths {
    fn push(&self, paths: impl IntoIterator<Item = PathBuf>) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend(paths);
    }

    /// Removes and returns every queued path.
    pub fn take(&self) -> Vec<PathBuf> {
        std::mem::take(
            &mut *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

/// Windows/Linux cold start: the file comes in argv.
pub fn on_startup(app: &AppHandle) {
    let cwd = std::env::current_dir().unwrap_or_default();
    queue(app, paths_from_args(std::env::args(), &cwd));
}

/// Windows/Linux warm start: a second instance forwards its argv and exits.
pub fn on_second_instance(app: &AppHandle, args: &[String], cwd: &str) {
    queue(app, paths_from_args(args, Path::new(cwd)));
}

/// macOS: files opened from Finder or dropped on the Dock icon.
#[cfg(target_os = "macos")]
pub fn on_opened_urls(app: &AppHandle, urls: &[tauri::Url]) {
    queue(
        app,
        urls.iter()
            .filter_map(|url| url.to_file_path().ok())
            .collect(),
    );
}

fn queue(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    tracing::info!(?paths, "queued files to open");
    app.state::<PendingPaths>().push(paths);
    if let Err(error) = app.emit(FILES_PENDING_EVENT, ()) {
        tracing::warn!(%error, "could not notify frontend about pending files");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_empties_the_queue() {
        let pending = PendingPaths::default();
        pending.push([PathBuf::from("a.md"), PathBuf::from("b.md")]);
        assert_eq!(pending.take().len(), 2);
        assert_eq!(pending.take(), [] as [std::path::PathBuf; 0]);
    }
}
