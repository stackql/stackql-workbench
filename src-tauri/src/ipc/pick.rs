//! Choosing a file or a folder for a setting, in the system's own dialog.
//!
//! The webview says what the path is for. The host decides whether that is
//! a file or a folder, what the dialog is titled and which files it offers.
//! The webview gets back the path the operator chose and nothing else.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri_plugin_dialog::DialogExt;

use crate::error::{HostError, HostResult};

/// What a path in the settings is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathPurpose {
    /// The `stackql` binary.
    Engine,
    /// The folder the engine keeps its providers in.
    DataFolder,
    /// A dotenv file the engine reads.
    EnvFile,
    /// The program of a delegated agent, the Copilot CLI.
    Agent,
}

/// How the dialog for one purpose is set up.
#[derive(Debug, PartialEq, Eq)]
struct Picker {
    folder: bool,
    title: &'static str,
    /// The file types offered first on Windows, where programs have one.
    /// Every file can still be chosen. A Mac program has no extension, so
    /// there no filter is set.
    programs: &'static [&'static str],
}

impl PathPurpose {
    fn picker(self) -> Picker {
        match self {
            Self::Engine => Picker {
                folder: false,
                title: "Choose the stackql program",
                programs: &["exe"],
            },
            Self::DataFolder => Picker {
                folder: true,
                title: "Choose the engine data folder",
                programs: &[],
            },
            Self::EnvFile => Picker {
                folder: false,
                title: "Choose a credentials file",
                programs: &[],
            },
            Self::Agent => Picker {
                folder: false,
                title: "Choose the GitHub Copilot CLI",
                // The npm install is a .cmd shim. Other installs are an .exe.
                programs: &["exe", "cmd"],
            },
        }
    }
}

/// Where the dialog opens: the folder the field names, or the folder of
/// the file it names, when that folder exists.
fn start_folder(current: Option<&str>) -> Option<PathBuf> {
    let current = current?.trim().trim_matches('"');
    if current.is_empty() {
        return None;
    }
    let path = Path::new(current);
    if path.is_dir() {
        return Some(path.to_path_buf());
    }
    path.parent()
        .filter(|parent| parent.is_dir())
        .map(Path::to_path_buf)
}

/// Opens the system's dialog for a setting. `current` is what the field
/// holds now, or the path in use, and only decides where the dialog opens.
/// Returns the chosen path, or `None` when the dialog was dismissed.
#[tauri::command]
pub async fn pick_path(
    window: tauri::WebviewWindow,
    purpose: PathPurpose,
    current: Option<String>,
) -> HostResult<Option<String>> {
    let picker = purpose.picker();
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(picker.title);
    if let Some(folder) = start_folder(current.as_deref()) {
        dialog = dialog.set_directory(folder);
    }
    if cfg!(windows) && !picker.programs.is_empty() {
        dialog = dialog
            .add_filter("Programs", picker.programs)
            .add_filter("All files", &["*"]);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if picker.folder {
        dialog
            .set_can_create_directories(true)
            .pick_folder(move |picked| {
                let _ = sender.send(picked);
            });
    } else {
        dialog.pick_file(move |picked| {
            let _ = sender.send(picked);
        });
    }
    let picked = receiver
        .await
        .map_err(|_| HostError::Internal("The dialog closed unexpectedly.".into()))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|err| HostError::Internal(format!("That location cannot be used: {err}")))?;
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_data_folder_is_a_folder() {
        for purpose in [
            PathPurpose::Engine,
            PathPurpose::EnvFile,
            PathPurpose::Agent,
        ] {
            assert!(!purpose.picker().folder, "{purpose:?}");
        }
        assert!(PathPurpose::DataFolder.picker().folder);
    }

    #[test]
    fn programs_are_offered_first_and_a_credentials_file_has_no_filter() {
        assert_eq!(PathPurpose::Engine.picker().programs, ["exe"]);
        assert_eq!(PathPurpose::Agent.picker().programs, ["exe", "cmd"]);
        // A dotenv file is usually called .env, which has no extension.
        assert!(PathPurpose::EnvFile.picker().programs.is_empty());
    }

    #[test]
    fn the_webview_names_a_purpose_in_camel_case() {
        let purpose: PathPurpose = serde_json::from_str("\"dataFolder\"").unwrap();
        assert_eq!(purpose, PathPurpose::DataFolder);
        let purpose: PathPurpose = serde_json::from_str("\"envFile\"").unwrap();
        assert_eq!(purpose, PathPurpose::EnvFile);
        assert!(serde_json::from_str::<PathPurpose>("\"anything\"").is_err());
    }

    #[test]
    fn the_dialog_opens_where_the_field_points_when_that_exists() {
        let dir = std::env::temp_dir().join(format!("wb-pick-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("stackql.exe");
        std::fs::write(&file, "").unwrap();
        let shown = dir.display().to_string();

        assert_eq!(start_folder(Some(&shown)), Some(dir.clone()));
        assert_eq!(
            start_folder(Some(&file.display().to_string())),
            Some(dir.clone())
        );
        // A file that is not there yet still opens in its folder.
        assert_eq!(
            start_folder(Some(&dir.join("new.env").display().to_string())),
            Some(dir.clone())
        );
        assert_eq!(
            start_folder(Some(&format!("\"{shown}\""))),
            Some(dir.clone())
        );
        assert_eq!(
            start_folder(Some(&dir.join("gone").join("x").display().to_string())),
            None
        );
        assert_eq!(start_folder(Some("   ")), None);
        assert_eq!(start_folder(None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
