//! Finding the `stackql` binary and reading its version.
//!
//! Resolution order, first hit wins:
//!
//! 1. Explicit path in settings
//! 2. `STACKQL_BIN` environment variable
//! 3. Sibling of the Workbench executable
//! 4. Well-known install locations for the platform
//! 5. `PATH`
//!
//! The two explicit sources are strict. If the operator named a path and it is
//! not a file, that is reported as an error and the search does not carry on,
//! because quietly running a different binary than the one asked for would be
//! worse than stopping.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// File name of the engine binary on this platform.
pub const BINARY_NAME: &str = if cfg!(windows) {
    "stackql.exe"
} else {
    "stackql"
};

/// Where a resolved binary came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Settings,
    EnvVar,
    Sibling,
    WellKnown,
    Path,
}

impl Source {
    /// A short label for the status bar.
    pub fn label(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::EnvVar => "STACKQL_BIN",
            Self::Sibling => "beside the app",
            Self::WellKnown => "install location",
            Self::Path => "PATH",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DiscoveryError {
    #[error(
        "The engine path in settings does not point to a file: {0}. Correct it in Settings, or clear it to search for stackql automatically."
    )]
    SettingsPathInvalid(String),
    #[error("STACKQL_BIN does not point to a file: {0}. Correct or unset the variable.")]
    EnvPathInvalid(String),
    #[error(
        "No stackql binary was found. Set its location in Settings, or set STACKQL_BIN, or add stackql to PATH."
    )]
    NotFound,
}

/// Everything discovery looks at, gathered up front so the search itself is a
/// pure function and can be tested without touching the machine.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub settings_path: Option<PathBuf>,
    pub env_bin: Option<OsString>,
    pub exe_dir: Option<PathBuf>,
    pub well_known: Vec<PathBuf>,
    pub path_var: Option<OsString>,
}

impl Inputs {
    /// Reads the real environment of this process.
    pub fn from_environment(settings_path: Option<PathBuf>) -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf));
        Self {
            settings_path,
            env_bin: std::env::var_os("STACKQL_BIN").filter(|v| !v.is_empty()),
            exe_dir,
            well_known: well_known_locations(|name| std::env::var_os(name)),
            path_var: std::env::var_os("PATH"),
        }
    }
}

/// Install locations used by the StackQL installers and common package managers.
pub fn well_known_locations(env: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(dir) = env(var) {
                out.push(PathBuf::from(dir).join("StackQL").join(BINARY_NAME));
            }
        }
        if let Some(dir) = env("LOCALAPPDATA") {
            out.push(
                PathBuf::from(dir)
                    .join("Programs")
                    .join("StackQL")
                    .join(BINARY_NAME),
            );
        }
        out.dedup();
    } else {
        // The PKG installer puts the CLI in /usr/local/bin. The others are
        // where the common macOS package manager links binaries.
        out.push(PathBuf::from("/usr/local/bin").join(BINARY_NAME));
        out.push(PathBuf::from("/opt/homebrew/bin").join(BINARY_NAME));
    }
    out
}

/// Runs the search. `is_file` is injected so tests can describe a file system.
pub fn resolve(
    inputs: &Inputs,
    is_file: impl Fn(&Path) -> bool,
) -> Result<Resolved, DiscoveryError> {
    if let Some(path) = &inputs.settings_path {
        return if is_file(path) {
            Ok(Resolved {
                path: path.clone(),
                source: Source::Settings,
            })
        } else {
            Err(DiscoveryError::SettingsPathInvalid(
                path.display().to_string(),
            ))
        };
    }

    if let Some(value) = &inputs.env_bin {
        let path = PathBuf::from(value);
        return if is_file(&path) {
            Ok(Resolved {
                path,
                source: Source::EnvVar,
            })
        } else {
            Err(DiscoveryError::EnvPathInvalid(path.display().to_string()))
        };
    }

    if let Some(dir) = &inputs.exe_dir {
        let path = dir.join(BINARY_NAME);
        if is_file(&path) {
            return Ok(Resolved {
                path,
                source: Source::Sibling,
            });
        }
    }

    for path in &inputs.well_known {
        if is_file(path) {
            return Ok(Resolved {
                path: path.clone(),
                source: Source::WellKnown,
            });
        }
    }

    if let Some(path_var) = &inputs.path_var {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let path = dir.join(BINARY_NAME);
            if is_file(&path) {
                return Ok(Resolved {
                    path,
                    source: Source::Path,
                });
            }
        }
    }

    Err(DiscoveryError::NotFound)
}

/// What `stackql --version` reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineVersion {
    pub version: String,
    pub platform: Option<String>,
    pub commit: Option<String>,
}

/// Parses the first line of `stackql --version`, for example
/// `stackql v1.0.888 Windows (f7b4116)`.
pub fn parse_version(output: &str) -> Option<EngineVersion> {
    let line = output.lines().find(|l| !l.trim().is_empty())?.trim();
    let mut words = line.split_whitespace();
    if words.next()? != "stackql" {
        return None;
    }
    let version = words.next()?.trim_start_matches('v').to_string();
    if version.is_empty() || !version.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mut platform = None;
    let mut commit = None;
    for word in words {
        if let Some(inner) = word.strip_prefix('(').and_then(|w| w.strip_suffix(')')) {
            commit = Some(inner.to_string());
        } else if platform.is_none() {
            platform = Some(word.to_string());
        }
    }
    Some(EngineVersion {
        version,
        platform,
        commit,
    })
}

/// Asks the binary for its version. Fails if it does not answer in time or
/// the output is not recognised, which also catches a path that is not
/// really `stackql`.
pub async fn read_version(binary: &Path) -> Result<EngineVersion, String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::hide_console_window(&mut cmd);
    let output = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| {
            format!(
                "{} --version did not answer within 10 seconds.",
                binary.display()
            )
        })?
        .map_err(|err| format!("Could not run {}: {err}", binary.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_version(&stdout).ok_or_else(|| {
        format!(
            "{} does not look like stackql. Its --version output was not recognised.",
            binary.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn fs(files: &[&str]) -> impl Fn(&Path) -> bool + use<> {
        let set: HashSet<PathBuf> = files.iter().map(PathBuf::from).collect();
        move |p: &Path| set.contains(p)
    }

    fn path_var(dirs: &[&str]) -> Option<OsString> {
        std::env::join_paths(dirs.iter().map(PathBuf::from)).ok()
    }

    fn bin_in(dir: &str) -> String {
        PathBuf::from(dir).join(BINARY_NAME).display().to_string()
    }

    fn everything() -> (Inputs, Vec<String>) {
        let sibling = bin_in("/app");
        let well_known = bin_in("/opt/known");
        let on_path = bin_in("/usr/bin");
        let inputs = Inputs {
            settings_path: Some(PathBuf::from("/custom/stackql-custom")),
            env_bin: Some(OsString::from("/env/stackql-env")),
            exe_dir: Some(PathBuf::from("/app")),
            well_known: vec![PathBuf::from(&well_known)],
            path_var: path_var(&["/somewhere", "/usr/bin"]),
        };
        let files = vec![
            "/custom/stackql-custom".to_string(),
            "/env/stackql-env".to_string(),
            sibling,
            well_known,
            on_path,
        ];
        (inputs, files)
    }

    fn resolve_with(inputs: &Inputs, files: &[String]) -> Result<Resolved, DiscoveryError> {
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        resolve(inputs, fs(&refs))
    }

    #[test]
    fn settings_path_wins_over_everything() {
        let (inputs, files) = everything();
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Settings);
        assert_eq!(found.path, PathBuf::from("/custom/stackql-custom"));
    }

    #[test]
    fn env_var_is_second() {
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::EnvVar);
    }

    #[test]
    fn sibling_is_third() {
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.env_bin = None;
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Sibling);
        assert_eq!(found.path, PathBuf::from("/app").join(BINARY_NAME));
    }

    #[test]
    fn well_known_is_fourth() {
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.env_bin = None;
        inputs.exe_dir = Some(PathBuf::from("/elsewhere"));
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::WellKnown);
    }

    #[test]
    fn path_is_last_and_searched_in_order() {
        let (mut inputs, mut files) = everything();
        inputs.settings_path = None;
        inputs.env_bin = None;
        inputs.exe_dir = None;
        inputs.well_known.clear();
        inputs.path_var = path_var(&["/first", "/usr/bin"]);
        files.push(bin_in("/first"));
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Path);
        assert_eq!(found.path, PathBuf::from("/first").join(BINARY_NAME));
    }

    #[test]
    fn invalid_settings_path_is_an_error_not_a_fallthrough() {
        let (mut inputs, files) = everything();
        inputs.settings_path = Some(PathBuf::from("/custom/missing"));
        let err = resolve_with(&inputs, &files).unwrap_err();
        assert!(matches!(err, DiscoveryError::SettingsPathInvalid(_)));
    }

    #[test]
    fn invalid_env_var_is_an_error_not_a_fallthrough() {
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.env_bin = Some(OsString::from("/env/missing"));
        let err = resolve_with(&inputs, &files).unwrap_err();
        assert!(matches!(err, DiscoveryError::EnvPathInvalid(_)));
    }

    #[test]
    fn nothing_found_says_so() {
        let inputs = Inputs {
            path_var: path_var(&["/a", "/b"]),
            ..Inputs::default()
        };
        assert_eq!(resolve(&inputs, |_| false), Err(DiscoveryError::NotFound));
        assert!(DiscoveryError::NotFound.to_string().contains("Settings"));
    }

    #[test]
    fn empty_path_entries_are_skipped() {
        let inputs = Inputs {
            path_var: Some(OsString::from(if cfg!(windows) { ";;" } else { "::" })),
            ..Inputs::default()
        };
        // An empty entry must not resolve to a binary in the working directory.
        assert_eq!(resolve(&inputs, |_| true), Err(DiscoveryError::NotFound));
    }

    #[test]
    fn parses_the_version_line() {
        let v =
            parse_version("stackql v1.0.888 Windows (f7b4116)\nBuildDate: 2026-11-05\n").unwrap();
        assert_eq!(v.version, "1.0.888");
        assert_eq!(v.platform.as_deref(), Some("Windows"));
        assert_eq!(v.commit.as_deref(), Some("f7b4116"));
    }

    #[test]
    fn parses_a_version_line_without_extras() {
        let v = parse_version("stackql v0.9.1").unwrap();
        assert_eq!(v.version, "0.9.1");
        assert_eq!(v.platform, None);
        assert_eq!(v.commit, None);
    }

    #[test]
    fn rejects_output_from_another_program() {
        assert_eq!(parse_version("psql (PostgreSQL) 16.1"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("stackql"), None);
        assert_eq!(parse_version("stackql unknown"), None);
    }

    #[test]
    fn well_known_locations_use_the_platform_layout() {
        let locations = well_known_locations(|name| match name {
            "ProgramFiles" => Some(OsString::from("C:\\Program Files")),
            _ => None,
        });
        assert!(!locations.is_empty());
        assert!(locations.iter().all(|p| p.ends_with(BINARY_NAME)));
    }
}
