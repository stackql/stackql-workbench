//! The provider dictionary published by stackql.io, and the pure logic for
//! turning a provider name into an icon.
//!
//! The dictionary is a list of categories. Each category lists providers
//! with a display name, the address of the provider's documentation site and
//! the path of its icon on stackql.io:
//!
//! ```json
//! { "name": "Databricks Account",
//!   "registryAliases": ["databricks"],
//!   "href": "https://databricks-account-provider.stackql.io/",
//!   "icon": "/img/providers/databricks/favicon.ico",
//!   "invertOnDark": true }
//! ```
//!
//! It does not carry the engine's provider name. That is derived from the
//! documentation address: `databricks-account-provider.stackql.io` is the
//! provider `databricks_account`.

use std::collections::HashMap;

use base64::Engine;
use serde::Deserialize;

/// Where the dictionary is published.
pub const DICTIONARY_URL: &str =
    "https://raw.githubusercontent.com/stackql/stackql.io/main/src/configs/providers.json";

/// Icon paths in the dictionary are relative to this site.
pub const ICON_BASE: &str = "https://stackql.io";

/// A copy of the dictionary taken when the app was built. Used when the
/// published one cannot be fetched.
pub const SNAPSHOT: &str = include_str!("providers.snapshot.json");

const DOC_HOST_SUFFIX: &str = "-provider.stackql.io";
const ICON_EXTENSIONS: [&str; 6] = ["ico", "png", "svg", "jpg", "jpeg", "webp"];

#[derive(Debug, Deserialize)]
struct RawCategory {
    #[serde(default)]
    providers: Vec<RawProvider>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProvider {
    #[serde(default)]
    name: String,
    #[serde(default)]
    href: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    registry_aliases: Vec<String>,
    #[serde(default)]
    invert_on_dark: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub display_name: String,
    /// Path on [`ICON_BASE`], already checked by [`safe_icon_path`].
    pub icon_path: String,
    /// The icon is dark on a transparent background and needs inverting on a
    /// dark surface.
    pub invert_on_dark: bool,
}

#[derive(Debug, Default)]
pub struct Directory {
    by_provider: HashMap<String, Entry>,
}

impl Directory {
    /// Parses the dictionary. Entries without a usable icon path are skipped.
    pub fn parse(json: &str) -> Result<Self, String> {
        let categories: Vec<RawCategory> = serde_json::from_str(json)
            .map_err(|err| format!("not a provider dictionary: {err}"))?;
        let mut by_provider = HashMap::new();
        let mut by_icon_folder = Vec::new();

        for raw in categories.into_iter().flat_map(|c| c.providers) {
            let Some(icon_path) = safe_icon_path(&raw.icon) else {
                continue;
            };
            let entry = Entry {
                display_name: raw.name,
                icon_path,
                invert_on_dark: raw.invert_on_dark,
            };
            let names = provider_from_href(&raw.href)
                .into_iter()
                .chain(raw.registry_aliases.iter().map(|alias| normalise(alias)));
            for name in names {
                by_provider.entry(name).or_insert_with(|| entry.clone());
            }
            if let Some(folder) = icon_folder(&entry.icon_path) {
                by_icon_folder.push((folder, entry));
            }
        }

        // The icon folder is usually the provider name too. It only fills
        // gaps, so it never overrides a name taken from a documentation address.
        for (folder, entry) in by_icon_folder {
            by_provider.entry(folder).or_insert(entry);
        }

        if by_provider.is_empty() {
            return Err("the provider dictionary has no usable entries".to_string());
        }
        Ok(Self { by_provider })
    }

    /// Finds the entry for an engine provider name such as `entra_id`.
    pub fn lookup(&self, provider: &str) -> Option<&Entry> {
        self.by_provider.get(&normalise(provider))
    }

    pub fn len(&self) -> usize {
        self.by_provider.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_provider.is_empty()
    }
}

/// Provider names use underscores. Documentation addresses use hyphens.
pub fn normalise(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace('-', "_")
}

/// `https://azure-stack-provider.stackql.io/` is the provider `azure_stack`.
fn provider_from_href(href: &str) -> Option<String> {
    let rest = href.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    let slug = host.strip_suffix(DOC_HOST_SUFFIX)?;
    if slug.is_empty() {
        return None;
    }
    Some(normalise(slug))
}

/// `/img/providers/aws/favicon.ico` is in the folder `aws`.
fn icon_folder(icon_path: &str) -> Option<String> {
    let rest = icon_path.strip_prefix("/img/providers/")?;
    let (folder, _) = rest.split_once('/')?;
    Some(normalise(folder))
}

/// Accepts only a plain path to an image under `/img/` on the icon site.
///
/// The dictionary is fetched from the network, so its contents are not
/// trusted to name an arbitrary address. A full URL, a path that climbs out
/// with `..`, a query string or an unexpected file type is refused.
pub fn safe_icon_path(path: &str) -> Option<String> {
    let path = path.trim();
    if !path.starts_with("/img/") || path.contains("..") || path.contains("//") {
        return None;
    }
    let plain = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'));
    if !plain {
        return None;
    }
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    ICON_EXTENSIONS
        .contains(&extension.as_str())
        .then(|| path.to_string())
}

pub fn icon_url(icon_path: &str) -> String {
    format!("{ICON_BASE}{icon_path}")
}

/// A flat file name for the on-disk cache. Providers that share an icon
/// share a cache file.
pub fn cache_file_name(icon_path: &str) -> String {
    icon_path.trim_start_matches('/').replace('/', "_")
}

/// Works out the image type from its first bytes. The file extension and
/// the server's content type are not trusted.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // SVG is text. Look for the root element near the start.
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    if head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

/// Encodes an image as a `data:` URL the webview can show without a network
/// request of its own.
pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      { "id": "cloud", "name": "Cloud", "providers": [
        { "name": "Amazon Web Services", "href": "https://aws-provider.stackql.io/",
          "icon": "/img/providers/aws/favicon.ico" },
        { "name": "AWS Cloud Control", "href": "https://awscc-provider.stackql.io/",
          "icon": "/img/providers/aws/favicon.ico" },
        { "name": "Azure Stack", "href": "https://azure-stack-provider.stackql.io/",
          "icon": "/img/providers/azure/favicon.ico" }
      ]},
      { "id": "data", "name": "Data", "providers": [
        { "name": "Databricks Account", "registryAliases": ["databricks"],
          "href": "https://databricks-account-provider.stackql.io/",
          "icon": "/img/providers/databricks/favicon.ico" },
        { "name": "Microsoft Entra ID", "href": "https://entra-id-provider.stackql.io/",
          "icon": "/img/providers/entra_id/entra_id_icon.svg" },
        { "name": "GitHub", "href": "https://github-provider.stackql.io/",
          "icon": "/img/providers/github/favicon.ico", "invertOnDark": true },
        { "name": "Elsewhere", "href": "https://elsewhere-provider.stackql.io/",
          "icon": "https://example.com/logo.png" }
      ]}
    ]"#;

    #[test]
    fn the_provider_name_comes_from_the_documentation_address() {
        let dir = Directory::parse(SAMPLE).unwrap();
        assert_eq!(
            dir.lookup("aws").unwrap().display_name,
            "Amazon Web Services"
        );
        assert_eq!(
            dir.lookup("awscc").unwrap().display_name,
            "AWS Cloud Control"
        );
        assert_eq!(
            dir.lookup("azure_stack").unwrap().display_name,
            "Azure Stack"
        );
        assert_eq!(
            dir.lookup("entra_id").unwrap().display_name,
            "Microsoft Entra ID"
        );
        assert_eq!(
            dir.lookup("databricks_account").unwrap().icon_path,
            "/img/providers/databricks/favicon.ico"
        );
    }

    #[test]
    fn registry_aliases_resolve_too() {
        let dir = Directory::parse(SAMPLE).unwrap();
        assert_eq!(
            dir.lookup("databricks").unwrap().display_name,
            "Databricks Account"
        );
    }

    #[test]
    fn lookup_ignores_case_and_hyphen_style() {
        let dir = Directory::parse(SAMPLE).unwrap();
        assert!(dir.lookup("GitHub").is_some());
        assert!(dir.lookup("azure-stack").is_some());
        assert!(dir.lookup(" aws ").is_some());
    }

    #[test]
    fn the_icon_folder_fills_gaps_without_overriding() {
        let dir = Directory::parse(SAMPLE).unwrap();
        // No documentation address says "azure", but the icon folder does.
        assert_eq!(dir.lookup("azure").unwrap().display_name, "Azure Stack");
        // "aws" has its own entry, which the shared folder must not replace.
        assert_eq!(
            dir.lookup("aws").unwrap().display_name,
            "Amazon Web Services"
        );
    }

    #[test]
    fn invert_on_dark_is_carried() {
        let dir = Directory::parse(SAMPLE).unwrap();
        assert!(dir.lookup("github").unwrap().invert_on_dark);
        assert!(!dir.lookup("aws").unwrap().invert_on_dark);
    }

    #[test]
    fn unknown_providers_and_unsafe_entries_have_no_icon() {
        let dir = Directory::parse(SAMPLE).unwrap();
        assert!(dir.lookup("stackql_preview").is_none());
        // Its icon was a full URL to another site, so the entry was skipped.
        assert!(dir.lookup("elsewhere").is_none());
    }

    #[test]
    fn rubbish_is_an_error_not_an_empty_directory() {
        assert!(Directory::parse("{}").is_err());
        assert!(Directory::parse("[]").is_err());
        assert!(Directory::parse("not json").is_err());
    }

    #[test]
    fn the_bundled_snapshot_parses_and_knows_common_providers() {
        let dir = Directory::parse(SNAPSHOT).unwrap();
        assert!(dir.len() >= 30, "only {} providers", dir.len());
        for provider in [
            "aws", "google", "azure", "github", "homebrew", "k8s", "okta",
        ] {
            assert!(dir.lookup(provider).is_some(), "{provider} missing");
        }
        assert!(dir.lookup("openai_admin").unwrap().invert_on_dark);
    }

    #[test]
    fn only_plain_image_paths_on_the_icon_site_are_accepted() {
        assert_eq!(
            safe_icon_path("/img/providers/aws/favicon.ico").as_deref(),
            Some("/img/providers/aws/favicon.ico")
        );
        assert!(safe_icon_path("/img/providers/entra_id/entra_id_icon.svg").is_some());
        for bad in [
            "",
            "https://example.com/x.png",
            "//example.com/x.png",
            "/img/../secret.png",
            "/img/providers/aws/favicon.ico?x=1",
            "/img/providers/aws/run.exe",
            "/other/aws/favicon.ico",
            "/img/providers/a b/favicon.ico",
            "/img//example.com/x.png",
        ] {
            assert_eq!(safe_icon_path(bad), None, "{bad:?} should be refused");
        }
    }

    #[test]
    fn icon_urls_and_cache_names() {
        assert_eq!(
            icon_url("/img/providers/aws/favicon.ico"),
            "https://stackql.io/img/providers/aws/favicon.ico"
        );
        assert_eq!(
            cache_file_name("/img/providers/aws/favicon.ico"),
            "img_providers_aws_favicon.ico"
        );
    }

    #[test]
    fn image_types_are_recognised_from_content() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_mime(&[0, 0, 1, 0, 3, 0]), Some("image/x-icon"));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(
            sniff_mime(b"<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\">"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff_mime(b"<!DOCTYPE html><html>not found</html>"), None);
        assert_eq!(sniff_mime(b""), None);
    }

    #[test]
    fn data_urls_are_base64() {
        assert_eq!(data_url("image/png", b"hi!"), "data:image/png;base64,aGkh");
    }
}
