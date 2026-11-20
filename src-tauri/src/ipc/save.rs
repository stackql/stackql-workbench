//! Saving text the operator exports.
//!
//! The webview hands over the text and a suggested name. Where it goes is
//! chosen by the operator in the system's save dialog, never by the webview.

use std::path::Path;

use serde::Deserialize;
use tauri_plugin_dialog::DialogExt;

use crate::error::{HostError, HostResult};

/// What is being saved, which decides the file type offered in the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveKind {
    Csv,
    Json,
    Jsonl,
}

impl SaveKind {
    fn filter(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Csv => ("CSV", &["csv"]),
            Self::Json => ("JSON", &["json"]),
            Self::Jsonl => ("JSON Lines", &["jsonl"]),
        }
    }
}

/// The last component of a suggested name, so a name from the webview can
/// never carry a folder with it.
fn file_name_only(suggested: &str) -> String {
    Path::new(suggested)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "export".to_string())
}

fn write_text(path: &Path, contents: &str) -> HostResult<()> {
    std::fs::write(path, contents)
        .map_err(|err| HostError::Internal(format!("Could not save {}: {err}", path.display())))
}

/// Asks the operator where to save `contents` and writes it there. Returns
/// the path, or `None` when the dialog was dismissed.
#[tauri::command]
pub async fn save_text_file(
    window: tauri::WebviewWindow,
    suggested_name: String,
    kind: SaveKind,
    contents: String,
) -> HostResult<Option<String>> {
    let (label, extensions) = kind.filter();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(file_name_only(&suggested_name))
        .add_filter(label, extensions)
        .save_file(move |picked| {
            let _ = sender.send(picked);
        });
    let picked = receiver
        .await
        .map_err(|_| HostError::Internal("The save dialog closed unexpectedly.".into()))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|err| HostError::Internal(format!("That location cannot be written to: {err}")))?;
    let shown = path.display().to_string();
    tauri::async_runtime::spawn_blocking(move || write_text(&path, &contents))
        .await
        .map_err(|err| HostError::Internal(format!("Could not save the file: {err}")))??;
    Ok(Some(shown))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggested_name_never_carries_a_folder() {
        assert_eq!(file_name_only("result.csv"), "result.csv");
        assert_eq!(file_name_only("../../etc/result.csv"), "result.csv");
        assert_eq!(file_name_only("/tmp/result.csv"), "result.csv");
        assert_eq!(file_name_only(""), "export");
        assert_eq!(file_name_only(".."), "export");
        #[cfg(windows)]
        assert_eq!(file_name_only(r"C:\Windows\result.csv"), "result.csv");
    }

    #[test]
    fn each_kind_offers_its_own_file_type() {
        assert_eq!(SaveKind::Csv.filter().1, ["csv"]);
        assert_eq!(SaveKind::Json.filter().1, ["json"]);
        assert_eq!(SaveKind::Jsonl.filter().1, ["jsonl"]);
        let kind: SaveKind = serde_json::from_str("\"jsonl\"").unwrap();
        assert_eq!(kind, SaveKind::Jsonl);
    }

    #[test]
    fn text_is_written_as_given_and_a_failure_names_the_file() {
        let dir = std::env::temp_dir().join(format!("wb-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("out.csv");
        write_text(&file, "a,b\r\n1,2\r\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a,b\r\n1,2\r\n");

        let missing = dir.join("no-such-folder").join("out.csv");
        let err = write_text(&missing, "x").unwrap_err();
        assert!(err.to_string().contains("out.csv"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
