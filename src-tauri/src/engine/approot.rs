//! Choosing the engine's data folder, its `--approot`.
//!
//! The engine keeps its provider cache there. Its own default is `.stackql`
//! in the working directory, which for a desktop app is wherever it happened
//! to be started from, so the host always passes the folder explicitly.
//!
//! Resolution order, first hit wins:
//!
//! 1. Explicit folder in settings
//! 2. `.stackql` beside the Workbench executable
//! 3. A folder under the app data directory
//!
//! The explicit source is strict. If the operator named a folder and it
//! cannot be used, that is an error and the search stops there. The second
//! falls through to the third with a note, because an installed app usually
//! sits where an ordinary account cannot write.

use std::path::{Path, PathBuf};

/// The folder name used beside the executable. It is the name the engine
/// uses for its own default.
pub const FOLDER_NAME: &str = ".stackql";

/// Where a resolved data folder came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Settings,
    BesideApp,
    AppData,
}

impl Source {
    /// A short label for the settings pane.
    pub fn label(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::BesideApp => "beside the app",
            Self::AppData => "app data folder",
        }
    }
}

/// The folders tried when settings name none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defaults {
    /// `.stackql` beside the executable. `None` when there is no such place
    /// or it must not be written to.
    pub beside_app: Option<PathBuf>,
    /// A folder under the app data directory, which an ordinary account can
    /// always write to.
    pub fallback: PathBuf,
}

impl Defaults {
    /// The defaults for an app whose executable is `exe`.
    pub fn for_executable(exe: Option<&Path>, fallback: PathBuf) -> Self {
        Self {
            beside_app: exe.and_then(beside_executable),
            fallback,
        }
    }

    /// One fixed folder and nothing else. Tests use this.
    pub fn fixed(dir: PathBuf) -> Self {
        Self {
            beside_app: None,
            fallback: dir,
        }
    }
}

/// The data folder beside an executable, if there may be one.
///
/// There is none inside a macOS app bundle. Adding a file to a signed bundle
/// breaks its signature, and the bundle is replaced whole on update.
pub fn beside_executable(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent().filter(|dir| !dir.as_os_str().is_empty())?;
    if super::in_app_bundle(exe) {
        return None;
    }
    Some(dir.join(FOLDER_NAME))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub source: Source,
    /// Set when the folder is not the one the operator would expect, with
    /// the reason.
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApprootError {
    #[error(
        "The engine data folder in settings is not a full path: {0}. Give a full path in Settings, or clear it to use the default folder."
    )]
    SettingsPathRelative(String),
    #[error(
        "The engine data folder in settings cannot be used: {path} ({reason}). Correct it in Settings, or clear it to use the default folder."
    )]
    SettingsPathUnusable { path: String, reason: String },
    #[error(
        "The engine data folder {path} cannot be used ({reason}). Set a folder you can write to in Settings."
    )]
    NoneUsable { path: String, reason: String },
}

/// Creates the folder if it is missing and checks a file can be written in
/// it. This is the `prepare` that [`resolve`] is given outside tests.
pub fn prepare(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".workbench-write-test-{}", std::process::id()));
    std::fs::write(&probe, b"")?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Runs the search. `prepare` makes a folder ready and says whether it can
/// be used. It is injected so tests can describe a file system.
pub fn resolve(
    setting: Option<&Path>,
    defaults: &Defaults,
    prepare: impl Fn(&Path) -> std::io::Result<()>,
) -> Result<Resolved, ApprootError> {
    if let Some(path) = setting {
        // A relative path would be read against the directory the app was
        // started from, which is the thing an explicit folder is meant to
        // avoid.
        if !path.is_absolute() {
            return Err(ApprootError::SettingsPathRelative(
                path.display().to_string(),
            ));
        }
        return match prepare(path) {
            Ok(()) => Ok(Resolved {
                path: path.to_path_buf(),
                source: Source::Settings,
                note: None,
            }),
            Err(err) => Err(ApprootError::SettingsPathUnusable {
                path: path.display().to_string(),
                reason: err.to_string(),
            }),
        };
    }

    let mut note = None;
    if let Some(path) = &defaults.beside_app {
        match prepare(path) {
            Ok(()) => {
                return Ok(Resolved {
                    path: path.clone(),
                    source: Source::BesideApp,
                    note: None,
                });
            }
            Err(err) => {
                note = Some(format!(
                    "The folder beside the app, {}, cannot be written to ({err}), so the app data folder is used.",
                    path.display()
                ));
            }
        }
    }

    match prepare(&defaults.fallback) {
        Ok(()) => Ok(Resolved {
            path: defaults.fallback.clone(),
            source: Source::AppData,
            note,
        }),
        Err(err) => Err(ApprootError::NoneUsable {
            path: defaults.fallback.display().to_string(),
            reason: err.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io;

    use super::*;

    fn abs(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:{}", path.replace('/', "\\")))
        } else {
            PathBuf::from(path)
        }
    }

    fn defaults() -> Defaults {
        Defaults {
            beside_app: Some(abs("/apps/workbench/.stackql")),
            fallback: abs("/data/engine"),
        }
    }

    fn denied() -> io::Error {
        io::Error::new(io::ErrorKind::PermissionDenied, "access is denied")
    }

    /// A file system in which only the listed folders can be written to.
    /// Records what was tried, in order.
    fn writable<'a>(
        ok: &'a [PathBuf],
        tried: &'a RefCell<Vec<PathBuf>>,
    ) -> impl Fn(&Path) -> io::Result<()> + 'a {
        move |dir| {
            tried.borrow_mut().push(dir.to_path_buf());
            if ok.iter().any(|allowed| allowed == dir) {
                Ok(())
            } else {
                Err(denied())
            }
        }
    }

    #[test]
    fn the_folder_in_settings_wins_and_nothing_else_is_touched() {
        let chosen = abs("/my/approot");
        let ok = [chosen.clone(), abs("/apps/workbench/.stackql")];
        let tried = RefCell::new(Vec::new());
        let found = resolve(Some(&chosen), &defaults(), writable(&ok, &tried)).unwrap();
        assert_eq!(found.path, chosen);
        assert_eq!(found.source, Source::Settings);
        assert_eq!(found.note, None);
        assert_eq!(*tried.borrow(), vec![chosen]);
    }

    #[test]
    fn an_unusable_folder_in_settings_is_an_error_and_the_search_stops() {
        let chosen = abs("/locked/approot");
        let ok = [abs("/apps/workbench/.stackql"), abs("/data/engine")];
        let tried = RefCell::new(Vec::new());
        let err = resolve(Some(&chosen), &defaults(), writable(&ok, &tried)).unwrap_err();
        assert!(matches!(err, ApprootError::SettingsPathUnusable { .. }));
        let text = err.to_string();
        assert!(text.contains("Settings"), "points at settings: {text}");
        assert!(
            text.contains("access is denied"),
            "gives the reason: {text}"
        );
        assert_eq!(*tried.borrow(), vec![chosen]);
    }

    #[test]
    fn a_relative_folder_in_settings_is_an_error() {
        let tried = RefCell::new(Vec::new());
        let err = resolve(
            Some(Path::new("cache/stackql")),
            &defaults(),
            writable(&[], &tried),
        )
        .unwrap_err();
        assert!(matches!(err, ApprootError::SettingsPathRelative(_)));
        assert!(tried.borrow().is_empty(), "nothing may be created");
    }

    #[test]
    fn the_folder_beside_the_app_is_the_default() {
        let ok = [abs("/apps/workbench/.stackql"), abs("/data/engine")];
        let tried = RefCell::new(Vec::new());
        let found = resolve(None, &defaults(), writable(&ok, &tried)).unwrap();
        assert_eq!(found.path, abs("/apps/workbench/.stackql"));
        assert_eq!(found.source, Source::BesideApp);
        assert_eq!(found.note, None);
        assert_eq!(tried.borrow().len(), 1, "the fallback is not created");
    }

    #[test]
    fn a_read_only_install_folder_falls_back_to_app_data_with_a_note() {
        let ok = [abs("/data/engine")];
        let tried = RefCell::new(Vec::new());
        let found = resolve(None, &defaults(), writable(&ok, &tried)).unwrap();
        assert_eq!(found.path, abs("/data/engine"));
        assert_eq!(found.source, Source::AppData);
        let note = found.note.unwrap();
        assert!(note.contains(".stackql"), "names the folder: {note}");
        assert!(
            note.contains("access is denied"),
            "gives the reason: {note}"
        );
    }

    #[test]
    fn with_no_folder_beside_the_app_the_fallback_is_used_without_a_note() {
        let fixed = Defaults::fixed(abs("/data/engine"));
        let ok = [abs("/data/engine")];
        let tried = RefCell::new(Vec::new());
        let found = resolve(None, &fixed, writable(&ok, &tried)).unwrap();
        assert_eq!(found.path, abs("/data/engine"));
        assert_eq!(found.source, Source::AppData);
        assert_eq!(found.note, None);
    }

    #[test]
    fn nothing_usable_is_an_error_that_points_at_settings() {
        let tried = RefCell::new(Vec::new());
        let err = resolve(None, &defaults(), writable(&[], &tried)).unwrap_err();
        assert!(matches!(err, ApprootError::NoneUsable { .. }));
        assert!(err.to_string().contains("Settings"));
        assert_eq!(tried.borrow().len(), 2);
    }

    #[test]
    fn the_default_sits_beside_the_executable() {
        let exe = abs("/apps/workbench/stackql-workbench.exe");
        assert_eq!(
            beside_executable(&exe),
            Some(abs("/apps/workbench/.stackql"))
        );
        let made = Defaults::for_executable(Some(&exe), abs("/data/engine"));
        assert_eq!(made, defaults());
    }

    #[test]
    fn nothing_is_written_inside_a_macos_app_bundle() {
        let exe = Path::new("/Applications/StackQL Workbench.app/Contents/MacOS/stackql-workbench");
        assert_eq!(beside_executable(exe), None);
        let made = Defaults::for_executable(Some(exe), abs("/data/engine"));
        assert_eq!(made, Defaults::fixed(abs("/data/engine")));
    }

    #[test]
    fn an_unknown_executable_gives_only_the_fallback() {
        assert_eq!(beside_executable(Path::new("stackql-workbench")), None);
        let made = Defaults::for_executable(None, abs("/data/engine"));
        assert_eq!(made, Defaults::fixed(abs("/data/engine")));
    }

    #[test]
    fn prepare_creates_the_folder_and_leaves_nothing_in_it() {
        let root = std::env::temp_dir().join(format!("wb-approot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("nested").join(FOLDER_NAME);

        prepare(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // A second run on an existing folder is fine too.
        prepare(&dir).unwrap();

        // A file where the folder should be cannot be used.
        let file = root.join("a-file");
        std::fs::write(&file, b"x").unwrap();
        assert!(prepare(&file).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
