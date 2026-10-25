//! Turning process arguments into files to open.

use std::path::{Path, PathBuf};

/// Extracts file paths from a process argument list (`argv`).
///
/// Used both at startup and when a second instance forwards its arguments.
/// The first argument (the program itself) is skipped, as are flags starting
/// with `-`. Relative paths are resolved against `cwd`. Paths are not checked
/// for existence here; opening a missing file shows an error in the UI instead.
pub fn paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let arg = arg.as_ref().trim();
            if arg.is_empty() || arg.starts_with('-') {
                return None;
            }
            let path = Path::new(arg);
            Some(if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_program_name() {
        let cwd = Path::new("/work");
        assert_eq!(
            paths_from_args(["app.exe"], cwd),
            [] as [std::path::PathBuf; 0]
        );
    }

    #[test]
    fn resolves_relative_paths_against_cwd() {
        let cwd = Path::new("/work");
        assert_eq!(
            paths_from_args(["app", "docs/a.md"], cwd),
            vec![cwd.join("docs/a.md")]
        );
    }

    #[test]
    fn keeps_absolute_paths() {
        let abs = std::env::temp_dir().join("a.md");
        let args = ["app".to_string(), abs.display().to_string()];
        assert_eq!(paths_from_args(args, Path::new("/work")), vec![abs]);
    }

    #[test]
    fn ignores_flags_and_empty_args() {
        let cwd = Path::new("/work");
        let paths = paths_from_args(["app", "--flag", "", "-x", "b.md"], cwd);
        assert_eq!(paths, vec![cwd.join("b.md")]);
    }
}
