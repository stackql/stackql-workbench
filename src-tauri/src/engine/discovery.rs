//! Finding the `stackql` binary and reading its version.
//!
//! Resolution order, first hit wins:
//!
//! 1. Explicit path in settings
//! 2. The engine installed with the app: beside the Workbench executable,
//!    and on macOS, for an app that runs from a bundle, where the PKG puts
//!    the `stackql` command
//! 3. `STACKQL_BIN` environment variable
//! 4. Well-known install locations for the platform
//! 5. `PATH`
//!
//! The installers ship `stackql` with the Workbench, and that pair is the
//! one that was built and tested together. So the engine installed with the
//! app is the default, and the one thing that comes before it is a path the
//! operator set in Settings, which can only happen after the install. An
//! environment variable can be older than the install and would otherwise
//! swap the engine without anyone having chosen that. When the variable is
//! set and passed over, the status says so.
//!
//! The two platforms lay the pair out differently. The MSI puts the two
//! executables in one folder. On macOS the app is a bundle in
//! `/Applications` and the PKG puts the command in `/usr/local/bin`. An
//! engine inside the bundle, beside the executable, is found first if a
//! later PKG puts one there.
//!
//! A build from this repository has no engine beside it and no installer
//! behind it, so there the variable is the next thing tried.
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
    Sibling,
    /// Where the app's own installer puts the engine, when that is not
    /// beside the app.
    WithApp,
    EnvVar,
    WellKnown,
    Path,
}

impl Source {
    /// A short label for the status bar.
    pub fn label(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Sibling => "beside the app",
            Self::WithApp => "installed with the app",
            Self::EnvVar => "STACKQL_BIN",
            Self::WellKnown => "install location",
            Self::Path => "PATH",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub source: Source,
    /// `STACKQL_BIN` is set and was not used, because the engine beside the
    /// app comes first.
    pub env_passed_over: bool,
}

impl Resolved {
    fn new(path: PathBuf, source: Source) -> Self {
        Self {
            path,
            source,
            env_passed_over: false,
        }
    }

    /// How the binary was found, in a few words for the status bar. It says
    /// when a variable the operator set was passed over, so that an engine
    /// other than the one they named is never run without a word.
    pub fn found_via(&self) -> String {
        if self.env_passed_over {
            format!(
                "{} (STACKQL_BIN is set and not used. To use another engine, set it in Settings)",
                self.source.label()
            )
        } else {
            self.source.label().to_string()
        }
    }
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
    /// Where the installer that put this app down also puts the engine,
    /// when that is not beside the executable. See [`installed_with_app`].
    pub with_app: Vec<PathBuf>,
    pub well_known: Vec<PathBuf>,
    pub path_var: Option<OsString>,
}

impl Inputs {
    /// Reads the real environment of this process.
    pub fn from_environment(settings_path: Option<PathBuf>) -> Self {
        let exe = std::env::current_exe().ok();
        Self {
            settings_path,
            env_bin: std::env::var_os("STACKQL_BIN").filter(|v| !v.is_empty()),
            exe_dir: exe
                .as_deref()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            with_app: installed_with_app(exe.as_deref(), cfg!(target_os = "macos")),
            well_known: well_known_locations(|name| std::env::var_os(name)),
            path_var: std::env::var_os("PATH"),
        }
    }
}

/// Where the StackQL PKG puts the `stackql` command on macOS.
const MACOS_PKG_DIR: &str = "/usr/local/bin";

/// Where the installer that put an installed copy of this app down also
/// puts the engine, when that is not beside the executable.
///
/// On Windows there is no such place. The MSI puts the two side by side,
/// which the search already covers.
///
/// On macOS the app is a bundle, and the PKG puts the `stackql` command in
/// `/usr/local/bin` so that a terminal finds it. An app that runs from a
/// bundle takes that one as its own, the same as an engine beside it. A
/// build that is not in a bundle is a build from this repository. It has no
/// installer behind it, and for it that folder is one more place to look.
pub fn installed_with_app(exe: Option<&Path>, macos: bool) -> Vec<PathBuf> {
    if macos && exe.is_some_and(super::in_app_bundle) {
        vec![PathBuf::from(MACOS_PKG_DIR).join(BINARY_NAME)]
    } else {
        Vec::new()
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
        out.push(PathBuf::from(MACOS_PKG_DIR).join(BINARY_NAME));
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
            Ok(Resolved::new(path.clone(), Source::Settings))
        } else {
            Err(DiscoveryError::SettingsPathInvalid(
                path.display().to_string(),
            ))
        };
    }

    // The engine that was installed with the app. It comes before the
    // variable, which is not even looked at here: a variable left over from
    // before the install, right or wrong, must not stop the pair that
    // shipped together from starting.
    if let Some(dir) = &inputs.exe_dir {
        let path = dir.join(BINARY_NAME);
        if is_file(&path) {
            return Ok(Resolved {
                path,
                source: Source::Sibling,
                env_passed_over: inputs.env_bin.is_some(),
            });
        }
    }
    // The same, for an installer that puts the engine somewhere other than
    // beside the app. An engine beside the app comes first: it is the one
    // that cannot have been put there by anything else.
    for path in &inputs.with_app {
        if is_file(path) {
            return Ok(Resolved {
                path: path.clone(),
                source: Source::WithApp,
                env_passed_over: inputs.env_bin.is_some(),
            });
        }
    }

    if let Some(value) = &inputs.env_bin {
        let path = PathBuf::from(value);
        return if is_file(&path) {
            Ok(Resolved::new(path, Source::EnvVar))
        } else {
            Err(DiscoveryError::EnvPathInvalid(path.display().to_string()))
        };
    }

    for path in &inputs.well_known {
        if is_file(path) {
            return Ok(Resolved::new(path.clone(), Source::WellKnown));
        }
    }

    if let Some(path_var) = &inputs.path_var {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let path = dir.join(BINARY_NAME);
            if is_file(&path) {
                return Ok(Resolved::new(path, Source::Path));
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
            with_app: Vec::new(),
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
    fn the_engine_beside_the_app_is_the_default() {
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.env_bin = None;
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Sibling);
        assert_eq!(found.path, PathBuf::from("/app").join(BINARY_NAME));
        assert!(!found.env_passed_over);
        assert_eq!(found.found_via(), "beside the app");
    }

    #[test]
    fn the_engine_beside_the_app_comes_before_the_variable_and_says_so() {
        // Everything is there but a path in settings.
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Sibling);
        assert_eq!(found.path, PathBuf::from("/app").join(BINARY_NAME));
        // An engine other than the one the variable names is not run
        // without a word.
        assert!(found.env_passed_over);
        let how = found.found_via();
        assert!(how.starts_with("beside the app"), "{how}");
        assert!(how.contains("STACKQL_BIN is set and not used"), "{how}");
        assert!(how.contains("Settings"), "{how}");
    }

    #[test]
    fn a_stale_variable_does_not_stop_the_engine_beside_the_app() {
        // Left over from before the install, and pointing nowhere.
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.env_bin = Some(OsString::from("/env/missing"));
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Sibling);
        assert!(found.env_passed_over);
    }

    #[test]
    fn the_variable_is_third_and_is_what_a_build_with_no_engine_beside_it_uses() {
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.exe_dir = Some(PathBuf::from("/elsewhere"));
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::EnvVar);
        assert_eq!(found.path, PathBuf::from("/env/stackql-env"));
        assert!(!found.env_passed_over);
    }

    /// An app the PKG installed on a Mac, with the command the PKG put down.
    const MAC_APP: &str = "/Applications/StackQL Workbench.app/Contents/MacOS/stackql-workbench";

    fn mac_install() -> (Inputs, Vec<String>) {
        let exe = Path::new(MAC_APP);
        let pkg_command = bin_in("/usr/local/bin");
        let inputs = Inputs {
            settings_path: None,
            env_bin: None,
            exe_dir: exe.parent().map(Path::to_path_buf),
            with_app: installed_with_app(Some(exe), true),
            // What the search knows about on a Mac, the PKG's folder included.
            well_known: vec![
                PathBuf::from(&pkg_command),
                PathBuf::from(bin_in("/opt/homebrew/bin")),
            ],
            path_var: path_var(&["/usr/bin"]),
        };
        (inputs, vec![pkg_command, bin_in("/opt/homebrew/bin")])
    }

    #[test]
    fn on_a_mac_only_an_installed_app_has_an_installer_behind_it() {
        let app = Path::new(MAC_APP);
        assert_eq!(
            installed_with_app(Some(app), true),
            vec![PathBuf::from(bin_in("/usr/local/bin"))]
        );
        // A build from this repository is not in a bundle.
        let build =
            Path::new("/Users/dev/stackql-workbench/src-tauri/target/debug/stackql-workbench");
        assert!(installed_with_app(Some(build), true).is_empty());
        // The MSI puts the engine beside the app, so Windows has no such place.
        assert!(installed_with_app(Some(app), false).is_empty());
        assert!(installed_with_app(None, true).is_empty());
    }

    #[test]
    fn on_a_mac_the_installed_app_takes_the_command_the_installer_put_down() {
        let (inputs, files) = mac_install();
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::WithApp);
        assert_eq!(found.path, PathBuf::from(bin_in("/usr/local/bin")));
        assert_eq!(found.found_via(), "installed with the app");
    }

    #[test]
    fn on_a_mac_the_variable_does_not_replace_the_installed_engine_either() {
        for value in ["/env/stackql-env", "/env/missing"] {
            let (mut inputs, mut files) = mac_install();
            inputs.env_bin = Some(OsString::from(value));
            files.push("/env/stackql-env".to_string());
            let found = resolve_with(&inputs, &files).unwrap();
            assert_eq!(found.source, Source::WithApp, "{value}");
            assert!(found.env_passed_over);
            assert!(
                found
                    .found_via()
                    .contains("STACKQL_BIN is set and not used")
            );
        }
    }

    #[test]
    fn on_a_mac_a_path_in_settings_still_wins() {
        let (mut inputs, mut files) = mac_install();
        inputs.settings_path = Some(PathBuf::from("/custom/stackql-custom"));
        files.push("/custom/stackql-custom".to_string());
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Settings);
    }

    #[test]
    fn on_a_mac_an_engine_inside_the_bundle_comes_before_the_command() {
        // Not where the PKG puts it today. If a later one does, it is found.
        let (inputs, mut files) = mac_install();
        let inside = Path::new(MAC_APP)
            .with_file_name(BINARY_NAME)
            .display()
            .to_string();
        files.push(inside.clone());
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Sibling);
        assert_eq!(found.path, PathBuf::from(inside));
    }

    #[test]
    fn on_a_mac_a_build_from_the_repository_still_tries_the_variable_first() {
        // The command is installed on this Mac too, but this build has no
        // installer behind it, so what the developer named is used.
        let build =
            Path::new("/Users/dev/stackql-workbench/src-tauri/target/debug/stackql-workbench");
        let (mut inputs, mut files) = mac_install();
        inputs.exe_dir = build.parent().map(Path::to_path_buf);
        inputs.with_app = installed_with_app(Some(build), true);
        inputs.env_bin = Some(OsString::from("/env/stackql-env"));
        files.push("/env/stackql-env".to_string());
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::EnvVar);
        // Without the variable it is found as one of the usual places.
        inputs.env_bin = None;
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::WellKnown);
        assert_eq!(found.path, PathBuf::from(bin_in("/usr/local/bin")));
    }

    #[test]
    fn on_a_mac_an_installed_app_with_no_installed_command_searches_on() {
        // The command was removed, or the app was copied over by hand.
        let (mut inputs, _) = mac_install();
        let files = vec![bin_in("/opt/homebrew/bin")];
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::WellKnown);
        assert_eq!(found.path, PathBuf::from(bin_in("/opt/homebrew/bin")));
        // And then the variable is back in its place, strict as ever.
        inputs.env_bin = Some(OsString::from("/env/missing"));
        let err = resolve_with(&inputs, &files).unwrap_err();
        assert!(matches!(err, DiscoveryError::EnvPathInvalid(_)));
    }

    #[test]
    fn a_path_in_settings_still_wins_over_the_engine_beside_the_app() {
        // The operator's own choice, made after the install.
        let (inputs, files) = everything();
        let found = resolve_with(&inputs, &files).unwrap();
        assert_eq!(found.source, Source::Settings);
        assert!(!found.env_passed_over);
        assert_eq!(found.found_via(), "settings");
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
        // With no engine beside the app the variable is what was asked for,
        // and the install location further down is not used in its place.
        let (mut inputs, files) = everything();
        inputs.settings_path = None;
        inputs.exe_dir = Some(PathBuf::from("/elsewhere"));
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
