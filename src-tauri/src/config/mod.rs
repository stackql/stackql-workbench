//! Settings, stored as a JSON file in the app config directory.
//!
//! Secrets never go in this file. API keys and tokens live in the OS
//! keychain.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::agent::backend::BackendKind;
use crate::connection::SafetyMode;
use crate::error::{HostError, HostResult};
use crate::util::lock;

/// Which model the chat uses. The API key is not here. It is in the OS
/// keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceSettings {
    pub kind: BackendKind,
    /// Empty means the backend's default model.
    #[serde(default)]
    pub model: String,
    /// Empty means the backend's default address.
    #[serde(default)]
    pub base_url: Option<String>,
    /// For a delegated agent: where its program is. Empty means search
    /// `PATH`.
    #[serde(default)]
    pub program: Option<String>,
    /// For a delegated agent: whether it may split independent lookups
    /// across subagents. Off unless the operator turns it on. In testing a
    /// model also reached for subagents when it was stuck, which made a
    /// turn slower and no better. See `docs/spike-acp.md`.
    #[serde(default)]
    pub subagents: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Explicit location of the `stackql` binary. Empty means search for it.
    pub engine_path: Option<String>,
    /// A dotenv file the engine sources at startup, passed with `--env.file`.
    /// The app never reads it.
    pub env_file: Option<String>,
    /// The engine's data folder, passed with `--approot`. Empty means the
    /// default: beside the app, or under the app data directory when that
    /// cannot be written to.
    pub approot: Option<String>,
    /// What the agent may do without asking. Passed to the engine, which
    /// enforces it.
    pub safety_mode: SafetyMode,
    /// The inference backend. `None` means chat is not configured, and the
    /// chat pane is hidden.
    pub inference: Option<InferenceSettings>,
}

impl Settings {
    /// Trims text fields and turns empty ones into `None`.
    pub fn normalised(mut self) -> Self {
        self.engine_path = clean(self.engine_path);
        self.env_file = clean(self.env_file);
        self.approot = clean(self.approot);
        if let Some(inference) = &mut self.inference {
            inference.model = inference.model.trim().to_string();
            inference.base_url = clean(inference.base_url.take());
            inference.program = clean(inference.program.take());
        }
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
                ..Settings::default()
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
                approot: Some(" D:\\stackql data ".into()),
                ..Settings::default()
            })
            .unwrap();
        assert_eq!(
            saved.engine_path.as_deref(),
            Some("C:\\Program Files\\StackQL\\stackql.exe")
        );
        assert_eq!(saved.env_file, None);
        assert_eq!(saved.approot.as_deref(), Some("D:\\stackql data"));
    }

    #[test]
    fn the_data_folder_round_trips_and_defaults_to_unset() {
        assert_eq!(Settings::default().approot, None);
        let path = temp_file("approot");
        let store = SettingsStore::load(path.clone());
        store
            .replace(Settings {
                approot: Some("D:\\stackql".into()),
                ..Settings::default()
            })
            .unwrap();
        let reloaded = SettingsStore::load(path.clone()).get();
        assert_eq!(reloaded.approot.as_deref(), Some("D:\\stackql"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"approot\""), "{text}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
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
    fn the_safety_mode_defaults_to_safe_and_chat_to_unconfigured() {
        let settings = Settings::default();
        assert_eq!(settings.safety_mode, SafetyMode::Safe);
        assert_eq!(settings.inference, None);
    }

    #[test]
    fn inference_settings_round_trip_and_never_hold_a_key() {
        let path = temp_file("inference");
        let store = SettingsStore::load(path.clone());
        store
            .replace(Settings {
                safety_mode: SafetyMode::DeleteSafe,
                inference: Some(InferenceSettings {
                    kind: BackendKind::Gemini,
                    model: "  gemini-test  ".into(),
                    base_url: Some("   ".into()),
                    program: Some("  ".into()),
                    subagents: false,
                }),
                ..Settings::default()
            })
            .unwrap();

        let reloaded = SettingsStore::load(path.clone()).get();
        assert_eq!(reloaded.safety_mode, SafetyMode::DeleteSafe);
        let inference = reloaded.inference.unwrap();
        assert_eq!(inference.kind, BackendKind::Gemini);
        assert_eq!(inference.model, "gemini-test");
        assert_eq!(inference.base_url, None);
        assert_eq!(inference.program, None);
        assert!(!inference.subagents);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"safetyMode\": \"delete_safe\""), "{text}");
        assert!(
            !text.to_lowercase().contains("key"),
            "no key belongs in settings: {text}"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn subagents_are_off_unless_the_operator_turned_them_on() {
        let path = temp_file("subagents");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Saved before the choice existed.
        std::fs::write(
            &path,
            r#"{ "inference": { "kind": "github_copilot", "model": "" } }"#,
        )
        .unwrap();
        let inference = SettingsStore::load(path.clone()).get().inference.unwrap();
        assert!(!inference.subagents);

        std::fs::write(
            &path,
            r#"{ "inference": { "kind": "github_copilot", "model": "", "subagents": true } }"#,
        )
        .unwrap();
        let inference = SettingsStore::load(path.clone()).get().inference.unwrap();
        assert!(inference.subagents);
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
