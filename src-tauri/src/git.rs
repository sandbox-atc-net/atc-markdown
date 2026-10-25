//! "Last edited by …" for wiki pages, from `git log`.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// The last commit that touched a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastEdit {
    pub author: String,
    /// Commit time, in milliseconds since the Unix epoch.
    pub time_ms: u64,
}

/// Asks git for the last commit of `file` in the repository at `repo`.
/// Returns `None` when git is not installed, the folder is not a repository,
/// or the file has no commits yet.
pub fn last_edit(repo: &Path, file: &Path) -> Option<LastEdit> {
    let mut command = Command::new("git");
    command
        .current_dir(repo)
        .args(["log", "-1", "--format=%an%x09%ct", "--"])
        .arg(file);
    #[cfg(windows)]
    {
        // Don't flash a console window for every page.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse(&String::from_utf8_lossy(&output.stdout))
}

fn parse(line: &str) -> Option<LastEdit> {
    let (author, seconds) = line.trim().split_once('\t')?;
    let seconds: u64 = seconds.trim().parse().ok()?;
    Some(LastEdit {
        author: author.trim().to_owned(),
        time_ms: seconds.saturating_mul(1000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_output() {
        assert_eq!(
            parse("Jane Doe\t1761400000\n"),
            Some(LastEdit {
                author: "Jane Doe".into(),
                time_ms: 1_761_400_000_000
            })
        );
        assert_eq!(parse(""), None);
        assert_eq!(parse("no tab"), None);
        assert_eq!(parse("A\tnot-a-number"), None);
    }

    #[test]
    fn is_none_outside_a_repository() {
        let dir = std::env::temp_dir();
        assert_eq!(last_edit(&dir, &dir.join("nothing.md")), None);
    }
}
