//! The query library, for the operator.
//!
//! The library is published in the `stackql/query-library.stackql.io`
//! repository: an index of its entries, and one markdown document for each
//! entry. The webview makes no network calls of its own, so the host fetches
//! both, keeps them in the app cache directory and hands the webview the
//! index and the text of a document.
//!
//! One host is contacted, and only under that repository's path. An entry
//! is named by its id, which is checked before it is put in an address.
//!
//! Nothing here runs a statement. An entry's statement is a template the
//! operator opens in the editor.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{HostError, HostResult};

const BASE: &str = "https://raw.githubusercontent.com/stackql/query-library.stackql.io/main";
const INDEX_PATH: &str = "static/docs/query-library/index.json";
const DOCUMENTS_PATH: &str = "query-library/queries";

/// How long a downloaded index is used before it is fetched again.
const INDEX_MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a downloaded document is used before it is fetched again.
const DOCUMENT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ID_CHARS: usize = 200;

/// One entry of the library, as its index describes it. Fields the index
/// leaves out are empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct LibraryEntry {
    /// For example `github/repos/org-repos-list`. Also the document's path.
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub intent_keywords: Vec<String>,
    /// The library's own word on whether the statement changes anything.
    #[serde(default)]
    pub mutation: bool,
    #[serde(default)]
    pub verb: String,
    /// For example `stable` or `draft`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub required_params: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawIndex {
    #[serde(default)]
    build_id: String,
    #[serde(default)]
    entries: Vec<LibraryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndex {
    pub entries: Vec<LibraryEntry>,
    /// The library build the index came from.
    pub build_id: String,
    /// The library could not be reached, and this is the copy kept from
    /// an earlier time.
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocument {
    pub id: String,
    /// The document without its front matter.
    pub markdown: String,
    /// The entry's statement: the first SQL block under its Query heading.
    pub statement: Option<String>,
}

/// Whether an id is safe to put in an address and a file name: two to four
/// parts separated by slashes, each made of lower-case letters, digits,
/// underscores and hyphens.
pub fn valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_ID_CHARS {
        return false;
    }
    let parts: Vec<&str> = id.split('/').collect();
    (2..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
        })
}

/// Reads the index. Entries whose id could not be fetched later are left out.
pub fn parse_index(text: &str) -> HostResult<(String, Vec<LibraryEntry>)> {
    let raw: RawIndex = serde_json::from_str(text).map_err(|err| {
        HostError::Internal(format!("The query library index could not be read: {err}"))
    })?;
    let entries = raw
        .entries
        .into_iter()
        .filter(|entry| valid_id(&entry.id))
        .collect();
    Ok((raw.build_id, entries))
}

/// The document without the front matter between its opening `---` lines.
pub fn strip_front_matter(text: &str) -> &str {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return text;
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return rest[offset + line.len()..].trim_start_matches(['\r', '\n']);
        }
        offset += line.len();
    }
    // An opening line with no closing one. Leave the text as it is.
    text
}

/// The first SQL block under the `## Query` heading, or failing that the
/// first SQL block in the document.
pub fn first_statement(markdown: &str) -> Option<String> {
    let lines: Vec<&str> = markdown.lines().collect();
    let heading = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("## query"));
    sql_block(&lines[heading.unwrap_or(0)..]).or_else(|| sql_block(&lines))
}

fn sql_block(lines: &[&str]) -> Option<String> {
    let start = lines.iter().position(|line| {
        let fence = line.trim();
        fence.eq_ignore_ascii_case("```sql")
    })?;
    let body: Vec<&str> = lines[start + 1..]
        .iter()
        .take_while(|line| line.trim() != "```")
        .copied()
        .collect();
    let text = body.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Fetches and caches the library.
pub struct Library {
    http: Option<reqwest::Client>,
    cache_dir: PathBuf,
}

impl Library {
    pub fn new(cache_dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("stackql-workbench/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok();
        Self { http, cache_dir }
    }

    /// A library that never touches the network. It answers from the cache
    /// directory only.
    pub fn offline(cache_dir: PathBuf) -> Self {
        Self {
            http: None,
            cache_dir,
        }
    }

    /// The index. A copy fetched recently is used as it is, unless `refresh`
    /// asks for a new one. When the library cannot be reached an older copy
    /// is returned and marked as such.
    pub async fn index(&self, refresh: bool) -> HostResult<LibraryIndex> {
        let path = self.cache_dir.join("index.json");
        let cached = read_cached(&path).and_then(|(text, age)| {
            parse_index(&text)
                .ok()
                .map(|(build_id, entries)| (build_id, entries, age))
        });

        if !refresh
            && let Some((build_id, entries, age)) = &cached
            && *age < INDEX_MAX_AGE
        {
            return Ok(LibraryIndex {
                entries: entries.clone(),
                build_id: build_id.clone(),
                from_cache: false,
            });
        }

        let url = format!("{BASE}/{INDEX_PATH}");
        if let Some(text) = self.fetch(&url, MAX_INDEX_BYTES).await
            && let Ok((build_id, entries)) = parse_index(&text)
        {
            write_cache(&path, text.as_bytes());
            return Ok(LibraryIndex {
                entries,
                build_id,
                from_cache: false,
            });
        }

        match cached {
            Some((build_id, entries, _)) => Ok(LibraryIndex {
                entries,
                build_id,
                from_cache: true,
            }),
            None => Err(HostError::Internal(
                "The query library could not be reached, and there is no earlier copy to show."
                    .into(),
            )),
        }
    }

    /// The document of one entry.
    pub async fn document(&self, id: &str) -> HostResult<LibraryDocument> {
        if !valid_id(id) {
            return Err(HostError::Internal(format!(
                "'{}' is not a query library entry.",
                id.escape_default()
            )));
        }
        let path = self
            .cache_dir
            .join("documents")
            .join(format!("{}.md", id.replace('/', "__")));
        let cached = read_cached(&path);

        let text = match &cached {
            Some((text, age)) if *age < DOCUMENT_MAX_AGE => Some(text.clone()),
            _ => {
                let url = format!("{BASE}/{DOCUMENTS_PATH}/{id}.md");
                match self.fetch(&url, MAX_DOCUMENT_BYTES).await {
                    Some(text) => {
                        write_cache(&path, text.as_bytes());
                        Some(text)
                    }
                    // An old copy is better than none.
                    None => cached.map(|(text, _)| text),
                }
            }
        };
        let Some(text) = text else {
            return Err(HostError::Internal(format!(
                "The query library entry {id} could not be fetched."
            )));
        };

        let markdown = strip_front_matter(&text).to_string();
        let statement = first_statement(&markdown);
        Ok(LibraryDocument {
            id: id.to_string(),
            markdown,
            statement,
        })
    }

    /// Fetches text, giving up on anything that is not a success, is larger
    /// than `limit` or is not UTF-8.
    async fn fetch(&self, url: &str, limit: usize) -> Option<String> {
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
        if bytes.len() > limit {
            return None;
        }
        String::from_utf8(bytes.to_vec()).ok()
    }
}

fn read_cached(path: &Path) -> Option<(String, Duration)> {
    let text = std::fs::read_to_string(path).ok()?;
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    Some((text, age))
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

    const INDEX: &str = r#"{
      "build_id": "ql-1",
      "entries": [
        {
          "id": "github/repos/org-repos-list",
          "title": "GitHub repositories in an organization",
          "description": "Lists all repositories.",
          "providers": ["github"],
          "services": ["repos"],
          "tags": ["github", "repos", "inventory"],
          "keywords": ["repo list"],
          "intent_keywords": ["list repos in my github org"],
          "mutation": false,
          "verb": "select",
          "status": "stable",
          "required_params": ["org"]
        },
        { "id": "aws/s3/buckets-list" },
        { "id": "../../etc/passwd", "title": "not an entry" },
        { "id": "Upper/Case/x" }
      ]
    }"#;

    const DOCUMENT: &str = "---\ntitle: GitHub repositories\nparams:\n  - name: org\n---\n\nLists every repository.\n\n## Query\n\n```sql\nSELECT name\nFROM github.repos.repos\nWHERE org = '{{org}}';\n```\n\n## Variation: sorted\n\n```sql\nSELECT name FROM github.repos.repos WHERE org = '{{org}}' AND sort = 'pushed';\n```\n";

    fn cache(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-library-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_id_is_checked_before_it_is_used() {
        assert!(valid_id("github/repos/org-repos-list"));
        assert!(valid_id("aws/cloud_control/resource-request-by-token"));
        assert!(valid_id("a/b"));
        for bad in [
            "",
            "single",
            "a/b/c/d/e",
            "../x",
            "a//b",
            "a/b/",
            "/a/b",
            "A/b",
            "a/b.md",
            "a/b c",
            "a\\b",
            "https://example.com/x",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(!valid_id(&format!("a/{}", "b".repeat(300))));
    }

    #[test]
    fn the_index_is_read_and_unusable_ids_are_left_out() {
        let (build, entries) = parse_index(INDEX).unwrap();
        assert_eq!(build, "ql-1");
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["github/repos/org-repos-list", "aws/s3/buckets-list"]);
        assert_eq!(entries[0].required_params, ["org"]);
        assert_eq!(entries[0].intent_keywords, ["list repos in my github org"]);
        // An entry with only an id still reads, with everything else empty.
        assert_eq!(entries[1].title, "");
        assert!(!entries[1].mutation);
        assert!(parse_index("not json").is_err());
    }

    #[test]
    fn an_entry_goes_to_the_webview_in_camel_case() {
        let (_, entries) = parse_index(INDEX).unwrap();
        let json = serde_json::to_value(&entries[0]).unwrap();
        assert_eq!(json["requiredParams"], serde_json::json!(["org"]));
        assert_eq!(
            json["intentKeywords"],
            serde_json::json!(["list repos in my github org"])
        );
    }

    #[test]
    fn front_matter_is_taken_off() {
        let body = strip_front_matter(DOCUMENT);
        assert!(body.starts_with("Lists every repository."), "{body}");
        assert!(!body.contains("params:"));
        // No front matter, or one that never closes, leaves the text alone.
        assert_eq!(strip_front_matter("# Title\n\ntext"), "# Title\n\ntext");
        assert_eq!(
            strip_front_matter("---\ntitle: x\nno end"),
            "---\ntitle: x\nno end"
        );
        assert!(strip_front_matter("---\r\ntitle: x\r\n---\r\n\r\nBody").starts_with("Body"));
    }

    #[test]
    fn the_statement_is_the_first_sql_block_under_the_query_heading() {
        let statement = first_statement(strip_front_matter(DOCUMENT)).unwrap();
        assert_eq!(
            statement,
            "SELECT name\nFROM github.repos.repos\nWHERE org = '{{org}}';"
        );
        // A block before the heading is not the entry's statement.
        let early = "```sql\nSELECT 1;\n```\n\n## Query\n\n```sql\nSELECT 2;\n```\n";
        assert_eq!(first_statement(early).unwrap(), "SELECT 2;");
        // With no Query heading the first block is used.
        assert_eq!(
            first_statement("text\n\n```sql\nSELECT 3;\n```\n").unwrap(),
            "SELECT 3;"
        );
        assert_eq!(first_statement("no code here"), None);
        assert_eq!(first_statement("```python\nprint(1)\n```"), None);
    }

    #[tokio::test]
    async fn a_cached_index_is_served_without_the_network() {
        let dir = cache("index");
        std::fs::write(dir.join("index.json"), INDEX).unwrap();
        let index = Library::offline(dir.clone()).index(false).await.unwrap();
        assert_eq!(index.entries.len(), 2);
        assert_eq!(index.build_id, "ql-1");
        assert!(!index.from_cache);
        // Asked for a new copy with no network, the old one is marked as old.
        let again = Library::offline(dir.clone()).index(true).await.unwrap();
        assert!(again.from_cache);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn with_no_network_and_no_copy_the_index_is_an_error() {
        let dir = cache("empty");
        let err = Library::offline(dir.clone())
            .index(false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("could not be reached"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_cached_document_is_read_into_its_body_and_statement() {
        let dir = cache("document");
        std::fs::create_dir_all(dir.join("documents")).unwrap();
        std::fs::write(
            dir.join("documents")
                .join("github__repos__org-repos-list.md"),
            DOCUMENT,
        )
        .unwrap();
        let library = Library::offline(dir.clone());
        let document = library
            .document("github/repos/org-repos-list")
            .await
            .unwrap();
        assert!(document.markdown.starts_with("Lists every repository."));
        assert!(
            document
                .statement
                .as_deref()
                .is_some_and(|sql| sql.starts_with("SELECT name"))
        );

        assert!(library.document("github/repos/missing").await.is_err());
        let refused = library.document("../secrets").await.unwrap_err();
        assert!(refused.to_string().contains("not a query library entry"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
