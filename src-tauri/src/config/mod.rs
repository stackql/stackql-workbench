//! Settings, stored as a JSON file in the app config directory.
//!
//! Secrets never go in this file. API keys and tokens live in the OS
//! keychain.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{HostError, HostResult};
use crate::util::lock;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Explicit location of the `stackql` binary. Empty means search for it.
    pub engine_path: Option<String>,
    /// A dotenv file the engine sources at startup, passed with `--env.file`.
    /// The app never reads it.
    pub env_file: Option<String>,
}

impl Settings {
    /// Trims text fields and turns empty ones into `None`.
    pub fn normalised(mut self) -> Self {
        self.engine_path = clean(self.engine_path);
        self.env_file = clean(self.env_file);
        self
    }
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().trim_matches('"').trim().to_string())
        .filter(|v| !v.is_empty())
}

pub struct SettingsStore {
    /// `None` keeps settings in memory only, for tests.
    path: Option<PathBuf>,
    current: Mutex<Settings>,
    load_warning: Option<String>,
}

impl SettingsStore {
    /// Reads the file. A missing file gives defaults. A file that cannot be
    /// parsed also gives defaults, with a warning to show the operator, and
    /// is left untouched until settings are next saved.
    pub fn load(path: PathBuf) -> Self {
        let (settings, load_warning) = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(settings) => (settings.normalised(), None),
                Err(err) => (
                    Settings::default(),
                    Some(format!(
                        "The settings file {} could not be read and defaults are in use: {err}",
                        path.display()
                    )),
                ),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (Settings::default(), None),
            Err(err) => (
                Settings::default(),
                Some(format!(
                    "The settings file {} could not be opened and defaults are in use: {err}",
                    path.display()
                )),
            ),
        };
        Self {
            path: Some(path),
            current: Mutex::new(settings),
            load_warning,
        }
    }

    pub fn in_memory(settings: Settings) -> Self {
        Self {
            path: None,
            current: Mutex::new(settings.normalised()),
            load_warning: None,
        }
    }

    pub fn get(&self) -> Settings {
        lock(&self.current).clone()
    }

    pub fn load_warning(&self) -> Option<&str> {
        self.load_warning.as_deref()
    }

    /// Saves new settings and returns them as stored.
    pub fn replace(&self, settings: Settings) -> HostResult<Settings> {
        let settings = settings.normalised();
        if let Some(path) = &self.path {
            write_atomically(path, &settings)?;
        }
        *lock(&self.current) = settings.clone();
        Ok(settings)
    }
}

fn write_atomically(path: &Path, settings: &Settings) -> HostResult<()> {
    let fail = |what: &str, err: &dyn std::fmt::Display| {
        HostError::Settings(format!("Could not {what} {}: {err}", path.display()))
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| fail("create the folder for", &e))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| fail("encode", &e))?;
    // Write beside the target and rename, so a crash cannot leave half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| fail("write", &e))?;
    std::fs::rename(&tmp, path).map_err(|e| fail("save", &e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("wb-settings-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("settings.json")
    }

    #[test]
    fn a_missing_file_gives_defaults_without_a_warning() {
        let store = SettingsStore::load(temp_file("missing"));
        assert_eq!(store.get(), Settings::default());
        assert_eq!(store.load_warning(), None);
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let path = temp_file("roundtrip");
        let store = SettingsStore::load(path.clone());
        store
            .replace(Settings {
                engine_path: Some("C:\\tools\\stackql.exe".into()),
                env_file: None,
            })
            .unwrap();

        let reloaded = SettingsStore::load(path.clone());
        assert_eq!(
            reloaded.get().engine_path.as_deref(),
            Some("C:\\tools\\stackql.exe")
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("enginePath"),
            "camelCase keys expected: {text}"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn blank_values_become_none_and_quotes_are_stripped() {
        let store = SettingsStore::in_memory(Settings::default());
        let saved = store
            .replace(Settings {
                engine_path: Some("  \"C:\\Program Files\\StackQL\\stackql.exe\"  ".into()),
                env_file: Some("   ".into()),
            })
            .unwrap();
        assert_eq!(
            saved.engine_path.as_deref(),
            Some("C:\\Program Files\\StackQL\\stackql.exe")
        );
        assert_eq!(saved.env_file, None);
    }

    #[test]
    fn a_corrupt_file_gives_defaults_and_a_warning() {
        let path = temp_file("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), Settings::default());
        assert!(store.load_warning().unwrap().contains("could not be read"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unknown_and_missing_keys_are_tolerated() {
        let path = temp_file("forward");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{ "futureKey": 1 }"#).unwrap();
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), Settings::default());
        assert_eq!(store.load_warning(), None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
