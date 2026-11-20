//! Provider icons for the explorer.
//!
//! The webview makes no network calls of its own. The host looks a provider
//! up in the dictionary published by stackql.io, fetches its icon from that
//! site, keeps it in the app cache directory and hands it to the webview as
//! a `data:` URL. A provider with no entry, or whose icon cannot be fetched,
//! has no icon and the explorer falls back to its letter badge. Providers
//! built into the engine, such as `stackql_preview`, show StackQL's own icon,
//! which is compiled in.
//!
//! Only two hosts are ever contacted: the one that publishes the dictionary
//! and the icon site. Icon paths from the dictionary are checked before use.

pub mod directory;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tokio::sync::OnceCell;

use self::directory::{Directory, Entry};
use crate::util::lock;

/// How long a downloaded copy of the dictionary is used before it is
/// fetched again.
const DICTIONARY_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a cached icon is used before it is fetched again.
const ICON_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_ICON_BYTES: usize = 512 * 1024;
const MAX_DICTIONARY_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// StackQL's own icon, compiled in. Shown for the providers that are built
/// into the engine, which the published dictionary does not list.
const STACKQL_ICON: &[u8] = include_bytes!("../../icons/64x64.png");

/// The icon for a provider that is part of the engine itself, such as
/// `stackql_preview`.
fn built_in_icon(key: &str) -> Option<ProviderIcon> {
    let built_in = key == "stackql" || key.starts_with("stackql_");
    built_in.then(|| ProviderIcon {
        data_url: directory::data_url("image/png", STACKQL_ICON),
        invert_on_dark: false,
        display_name: "StackQL".to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIcon {
    /// The image as a `data:` URL.
    pub data_url: String,
    /// The icon is dark on a transparent background.
    pub invert_on_dark: bool,
    /// The provider's display name, for example "Amazon Web Services".
    pub display_name: String,
}

pub struct ProviderIcons {
    http: Option<reqwest::Client>,
    cache_dir: PathBuf,
    directory: OnceCell<Directory>,
    /// Answers already worked out in this session, including "no icon".
    resolved: Mutex<HashMap<String, Option<ProviderIcon>>>,
}

impl ProviderIcons {
    pub fn new(cache_dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .https_only(true)
            .redirect(reqwest::redirect::Policy::limited(3))
            .user_agent(concat!("stackql-workbench/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok();
        Self {
            http,
            cache_dir,
            directory: OnceCell::new(),
            resolved: Mutex::new(HashMap::new()),
        }
    }

    /// A service that never touches the network. It answers from the cache
    /// directory and the bundled dictionary only.
    pub fn offline(cache_dir: PathBuf) -> Self {
        Self {
            http: None,
            cache_dir,
            directory: OnceCell::new(),
            resolved: Mutex::new(HashMap::new()),
        }
    }

    /// Icons for the given providers. Providers without an icon are left out.
    pub async fn icons(&self, providers: &[String]) -> HashMap<String, ProviderIcon> {
        let lookups = providers
            .iter()
            .map(|name| async move { self.icon(name).await.map(|icon| (name.clone(), icon)) });
        futures_util::future::join_all(lookups)
            .await
            .into_iter()
            .flatten()
            .collect()
    }

    /// The icon for one provider, or `None` when there is none to show.
    pub async fn icon(&self, provider: &str) -> Option<ProviderIcon> {
        let key = directory::normalise(provider);
        if let Some(known) = lock(&self.resolved).get(&key) {
            return known.clone();
        }
        let icon = self.resolve(&key).await;
        lock(&self.resolved).insert(key, icon.clone());
        icon
    }

    async fn resolve(&self, key: &str) -> Option<ProviderIcon> {
        // The published dictionary wins if it ever lists a built-in provider.
        match self.dictionary_icon(key).await {
            Some(icon) => Some(icon),
            None => built_in_icon(key),
        }
    }

    async fn dictionary_icon(&self, key: &str) -> Option<ProviderIcon> {
        let entry = self.directory().await.lookup(key)?.clone();
        let bytes = self.icon_bytes(&entry).await?;
        let mime = directory::sniff_mime(&bytes)?;
        Some(ProviderIcon {
            data_url: directory::data_url(mime, &bytes),
            invert_on_dark: entry.invert_on_dark,
            display_name: entry.display_name,
        })
    }

    async fn directory(&self) -> &Directory {
        self.directory
            .get_or_init(|| async { self.load_directory().await })
            .await
    }

    /// The freshest dictionary available: a recent download, then a new
    /// download, then an old download, then the copy built into the app.
    async fn load_directory(&self) -> Directory {
        let path = self.cache_dir.join("providers.json");
        let cached = read_cached(&path);

        if let Some((text, age)) = &cached
            && *age < DICTIONARY_MAX_AGE
            && let Ok(parsed) = Directory::parse(text)
        {
            return parsed;
        }

        if let Some(bytes) = self
            .fetch(directory::DICTIONARY_URL, MAX_DICTIONARY_BYTES)
            .await
            && let Ok(text) = String::from_utf8(bytes)
            && let Ok(parsed) = Directory::parse(&text)
        {
            write_cache(&path, text.as_bytes());
            return parsed;
        }

        if let Some((text, _)) = &cached
            && let Ok(parsed) = Directory::parse(text)
        {
            return parsed;
        }

        Directory::parse(directory::SNAPSHOT).unwrap_or_default()
    }

    async fn icon_bytes(&self, entry: &Entry) -> Option<Vec<u8>> {
        let path = self
            .cache_dir
            .join("icons")
            .join(directory::cache_file_name(&entry.icon_path));

        let cached = std::fs::read(&path).ok().filter(|b| is_image(b));
        if let Some(bytes) = &cached
            && file_age(&path).is_some_and(|age| age < ICON_MAX_AGE)
        {
            return Some(bytes.clone());
        }

        let url = directory::icon_url(&entry.icon_path);
        match self
            .fetch(&url, MAX_ICON_BYTES)
            .await
            .filter(|b| is_image(b))
        {
            Some(bytes) => {
                write_cache(&path, &bytes);
                Some(bytes)
            }
            // An old copy is better than the letter badge.
            None => cached,
        }
    }

    /// Fetches a URL, giving up on anything that is not a success or is
    /// larger than `limit`.
    async fn fetch(&self, url: &str, limit: usize) -> Option<Vec<u8>> {
        let http = self.http.as_ref()?;
        let response = http.get(url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        (bytes.len() <= limit).then(|| bytes.to_vec())
    }
}

fn is_image(bytes: &[u8]) -> bool {
    directory::sniff_mime(bytes).is_some()
}

fn file_age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

fn read_cached(path: &Path) -> Option<(String, Duration)> {
    let text = std::fs::read_to_string(path).ok()?;
    Some((text, file_age(path)?))
}

/// The cache is a convenience. A failed write is not worth reporting.
fn write_cache(path: &Path, bytes: &[u8]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot-really-pixels";

    fn cache(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-icons-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("icons")).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_cached_icon_is_served_without_the_network() {
        let dir = cache("hit");
        std::fs::write(dir.join("icons").join("img_providers_aws_favicon.ico"), PNG).unwrap();
        let icons = ProviderIcons::offline(dir.clone());

        let icon = icons.icon("aws").await.expect("cached icon");
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(icon.display_name, "Amazon Web Services");
        assert!(!icon.invert_on_dark);

        // awscc shares the same icon file in the dictionary.
        assert!(icons.icon("awscc").await.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_provider_without_an_entry_has_no_icon() {
        let dir = cache("unknown");
        let icons = ProviderIcons::offline(dir.clone());
        assert_eq!(icons.icon("no_such_provider").await, None);
        // Not a built-in just because the name mentions stackql somewhere.
        assert_eq!(icons.icon("my_stackql_thing").await, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn built_in_providers_show_the_stackql_icon_without_the_network() {
        let dir = cache("builtin");
        let icons = ProviderIcons::offline(dir.clone());

        let icon = icons.icon("stackql_preview").await.expect("built-in icon");
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(icon.display_name, "StackQL");
        assert!(!icon.invert_on_dark);
        // The compiled-in file really is an image.
        assert_eq!(directory::sniff_mime(STACKQL_ICON), Some("image/png"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_icon_that_cannot_be_fetched_falls_back_to_none() {
        // In the dictionary, nothing in the cache, and no network.
        let dir = cache("miss");
        let icons = ProviderIcons::offline(dir.clone());
        assert_eq!(icons.icon("github").await, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_cached_file_that_is_not_an_image_is_ignored() {
        let dir = cache("corrupt");
        std::fs::write(
            dir.join("icons").join("img_providers_aws_favicon.ico"),
            b"<html>404</html>",
        )
        .unwrap();
        let icons = ProviderIcons::offline(dir.clone());
        assert_eq!(icons.icon("aws").await, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_downloaded_dictionary_in_the_cache_is_preferred_to_the_snapshot() {
        let dir = cache("dictionary");
        std::fs::write(
            dir.join("providers.json"),
            r#"[{ "providers": [{ "name": "Brand New", "href": "https://brandnew-provider.stackql.io/", "icon": "/img/providers/brandnew/favicon.png" }] }]"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("icons").join("img_providers_brandnew_favicon.png"),
            PNG,
        )
        .unwrap();
        let icons = ProviderIcons::offline(dir.clone());

        assert_eq!(
            icons.icon("brandnew").await.unwrap().display_name,
            "Brand New"
        );
        // The snapshot was not consulted, so a provider only it knows is absent.
        assert_eq!(icons.icon("aws").await, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn icons_returns_only_the_providers_that_have_one() {
        let dir = cache("batch");
        std::fs::write(dir.join("icons").join("img_providers_aws_favicon.ico"), PNG).unwrap();
        let icons = ProviderIcons::offline(dir.clone());

        let found = icons
            .icons(&[
                "aws".to_string(),
                "no_such_provider".to_string(),
                "github".to_string(),
            ])
            .await;
        assert_eq!(found.keys().collect::<Vec<_>>(), vec!["aws"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_icon_serialises_in_camel_case() {
        let icon = ProviderIcon {
            data_url: "data:image/png;base64,AA==".into(),
            invert_on_dark: true,
            display_name: "GitHub".into(),
        };
        assert_eq!(
            serde_json::to_value(icon).unwrap(),
            serde_json::json!({
                "dataUrl": "data:image/png;base64,AA==",
                "invertOnDark": true,
                "displayName": "GitHub"
            })
        );
    }
}
