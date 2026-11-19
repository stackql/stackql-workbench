//! Opening the app's own links in the operator's browser.
//!
//! The webview names a link. It never supplies an address, so nothing a
//! model writes, and nothing else on a page, can be opened this way.

use serde::Deserialize;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use super::AppState;
use crate::error::{HostError, HostResult};

/// The links the Help menu offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Link {
    Docs,
    QueryLibrary,
    Issues,
}

impl Link {
    pub const ALL: [Self; 3] = [Self::Docs, Self::QueryLibrary, Self::Issues];

    pub fn url(self) -> &'static str {
        match self {
            Self::Docs => "https://stackql.io/docs",
            Self::QueryLibrary => "https://stackql.io/docs/query-library",
            Self::Issues => "https://github.com/stackql/stackql-workbench/issues",
        }
    }
}

/// Opens one of the app's links in the default browser.
#[tauri::command]
pub fn open_link(app: tauri::AppHandle, link: Link) -> HostResult<()> {
    app.opener()
        .open_url(link.url(), None::<&str>)
        .map_err(|err| HostError::Internal(format!("Could not open {}: {err}", link.url())))
}

/// Shows the app's log file for this run in the system's file manager.
/// The host holds the path. The webview names nothing, and is told nothing
/// but the path that was shown.
#[tauri::command]
pub fn reveal_log(app: tauri::AppHandle, state: State<'_, AppState>) -> HostResult<String> {
    let path = state.log.path().ok_or_else(|| {
        HostError::Internal("No log is being kept, because its folder could not be created.".into())
    })?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|err| HostError::Internal(format!("Could not show {}: {err}", path.display())))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_link_is_an_https_address_of_the_project() {
        for link in Link::ALL {
            let url = link.url();
            assert!(
                url.starts_with("https://stackql.io/")
                    || url.starts_with("https://github.com/stackql/"),
                "{url}"
            );
        }
    }

    #[test]
    fn a_link_is_named_not_given_as_an_address() {
        let link: Link = serde_json::from_str("\"queryLibrary\"").unwrap();
        assert_eq!(link, Link::QueryLibrary);
        assert!(serde_json::from_str::<Link>("\"https://example.com\"").is_err());
    }
}
