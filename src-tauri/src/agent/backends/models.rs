//! The models a backend offers, read from the provider, so the settings pane
//! can offer a list instead of a blank field.
//!
//! Wire format notes, from each provider's API reference as read in
//! November 2026:
//!
//! - Gemini: `GET {base}/v1beta/models` with `x-goog-api-key`. Up to 1000
//!   models a page with `pageSize`. A reply with `nextPageToken` has another
//!   page, asked for with `pageToken`. `name` is `models/{id}`. A model that
//!   can hold a conversation lists `generateContent` in
//!   `supportedGenerationMethods`, which is the call the backend makes.
//! - Anthropic: `GET {base}/v1/models` with `x-api-key` and
//!   `anthropic-version`. Up to 1000 models a page with `limit`. A reply with
//!   `has_more` has another page, asked for with `after_id` set to `last_id`.
//!   Each model has `id`, `display_name` and `lifecycle`.
//! - OpenAI and compatible servers: `GET {base}/models`, with a bearer key
//!   when there is one. One page, `data[].id`. There is no display name and
//!   no capability field, so every model the server lists is offered.
//!
//! Listing models is free with all three and counts against no quota.

use serde::Serialize;
use serde_json::Value;

use super::{anthropic, gemini, get_json, http_client, openai, resolve_base_url};
use crate::agent::backend::{BackendKind, InferenceError};

/// Stops a provider that keeps sending a next page from looping forever.
const MAX_PAGES: usize = 20;

/// One model a backend offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// What goes in the settings and on the wire.
    pub id: String,
    /// What the provider calls it. The id when the provider gives no name.
    pub name: String,
}

/// Asks the provider which models the key can use. `base_url` is the
/// operator's address, or `None` for the provider's own.
pub async fn list(
    kind: BackendKind,
    base_url: Option<&str>,
    api_key: Option<String>,
) -> Result<Vec<ModelOption>, InferenceError> {
    let api_key = api_key.filter(|key| !key.trim().is_empty());
    if kind.is_delegated() {
        return Err(InferenceError::InvalidRequest(
            "This backend is an agent, not a model API.".to_string(),
        ));
    }
    if api_key.is_none() && !kind.key_optional() {
        return Err(InferenceError::Auth(
            "Enter an API key to list the models".to_string(),
        ));
    }
    let base = resolve_base_url(kind, base_url);
    let key = api_key.unwrap_or_default();
    let http = http_client()?;
    let models = match kind {
        BackendKind::Gemini => list_gemini(&http, &base, &key).await?,
        BackendKind::Anthropic => list_anthropic(&http, &base, &key).await?,
        BackendKind::OpenaiCompatible => list_openai(&http, &base, &key).await?,
        BackendKind::GithubCopilot => Vec::new(),
    };
    Ok(dedupe(models))
}

async fn list_gemini(
    http: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<Vec<ModelOption>, InferenceError> {
    let url = format!("{base}/v1beta/models");
    let headers = [("x-goog-api-key", key)];
    let mut models = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![("pageSize", "1000")];
        if let Some(token) = token.as_deref() {
            query.push(("pageToken", token));
        }
        let reply = get_json(http, &url, &query, &headers, gemini::error_message)
            .await
            .map_err(gemini::reclassify_key_error)?;
        let (page, next) = gemini_page(&reply);
        models.extend(page);
        match next {
            Some(next) => token = Some(next),
            None => break,
        }
    }
    Ok(models)
}

async fn list_anthropic(
    http: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<Vec<ModelOption>, InferenceError> {
    let url = format!("{base}/v1/models");
    let headers = [
        ("x-api-key", key),
        ("anthropic-version", anthropic::API_VERSION),
    ];
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![("limit", "1000")];
        if let Some(after) = after.as_deref() {
            query.push(("after_id", after));
        }
        let reply = get_json(http, &url, &query, &headers, anthropic::error_message).await?;
        let (page, next) = anthropic_page(&reply);
        models.extend(page);
        match next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    Ok(models)
}

async fn list_openai(
    http: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<Vec<ModelOption>, InferenceError> {
    let bearer = format!("Bearer {key}");
    let headers: Vec<(&str, &str)> = if key.is_empty() {
        Vec::new()
    } else {
        vec![("authorization", bearer.as_str())]
    };
    let reply = get_json(
        http,
        &format!("{base}/models"),
        &[],
        &headers,
        openai::error_message,
    )
    .await?;
    Ok(openai_models(&reply))
}

fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// One page from Gemini: the models that take `generateContent`, and the
/// token for the next page.
fn gemini_page(reply: &Value) -> (Vec<ModelOption>, Option<String>) {
    let models = reply
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            model
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| {
                    methods
                        .iter()
                        .any(|m| m.as_str() == Some("generateContent"))
                })
        })
        .filter_map(|model| {
            let name = text(model, "name")?;
            let id = name.strip_prefix("models/").unwrap_or(name);
            Some(ModelOption {
                id: id.to_string(),
                name: text(model, "displayName").unwrap_or(id).to_string(),
            })
        })
        .collect();
    let next = text(reply, "nextPageToken").map(str::to_string);
    (models, next)
}

/// One page from Anthropic: the models that can still be called, and the id
/// to start the next page after.
fn anthropic_page(reply: &Value) -> (Vec<ModelOption>, Option<String>) {
    let models = reply
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| text(model, "lifecycle") != Some("retired"))
        .filter_map(|model| {
            let id = text(model, "id")?;
            let name = text(model, "display_name").unwrap_or(id);
            let name = if text(model, "lifecycle") == Some("deprecated") {
                format!("{name} (deprecated)")
            } else {
                name.to_string()
            };
            Some(ModelOption {
                id: id.to_string(),
                name,
            })
        })
        .collect();
    let more = reply
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next = if more {
        text(reply, "last_id").map(str::to_string)
    } else {
        None
    };
    (models, next)
}

/// The models of an OpenAI-compatible server, by id. The order a server
/// sends them in means nothing, so they are sorted.
fn openai_models(reply: &Value) -> Vec<ModelOption> {
    let mut models: Vec<ModelOption> = reply
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = text(model, "id")?;
            Some(ModelOption {
                id: id.to_string(),
                name: id.to_string(),
            })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

/// Keeps the first of each id.
fn dedupe(models: Vec<ModelOption>) -> Vec<ModelOption> {
    let mut seen = std::collections::HashSet::new();
    models
        .into_iter()
        .filter(|model| seen.insert(model.id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::backends::testing::serve_once;
    use serde_json::json;

    #[test]
    fn gemini_offers_only_models_that_take_generate_content() {
        let reply = json!({
            "models": [
                {
                    "name": "models/gemini-test-flash",
                    "displayName": "Gemini Test Flash",
                    "supportedGenerationMethods": ["generateContent", "countTokens"]
                },
                {
                    "name": "models/text-embedding-test",
                    "displayName": "Embedding",
                    "supportedGenerationMethods": ["embedContent"]
                },
                {
                    "name": "models/gemini-no-name",
                    "supportedGenerationMethods": ["generateContent"]
                },
                { "name": "models/no-methods" }
            ],
            "nextPageToken": "page-2"
        });
        let (models, next) = gemini_page(&reply);
        assert_eq!(
            models,
            vec![
                ModelOption {
                    id: "gemini-test-flash".into(),
                    name: "Gemini Test Flash".into()
                },
                ModelOption {
                    id: "gemini-no-name".into(),
                    name: "gemini-no-name".into()
                },
            ]
        );
        assert_eq!(next.as_deref(), Some("page-2"));
        let (_, last) = gemini_page(&json!({ "models": [], "nextPageToken": "" }));
        assert_eq!(last, None);
    }

    #[test]
    fn anthropic_leaves_out_retired_models_and_marks_deprecated_ones() {
        let reply = json!({
            "data": [
                { "id": "claude-new", "display_name": "Claude New", "lifecycle": "active" },
                { "id": "claude-old", "display_name": "Claude Old", "lifecycle": "deprecated" },
                { "id": "claude-gone", "display_name": "Claude Gone", "lifecycle": "retired" },
                { "id": "claude-plain" }
            ],
            "has_more": true,
            "last_id": "claude-plain"
        });
        let (models, next) = anthropic_page(&reply);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            ["Claude New", "Claude Old (deprecated)", "claude-plain"]
        );
        assert_eq!(next.as_deref(), Some("claude-plain"));
        let (_, last) = anthropic_page(&json!({ "data": [], "has_more": false, "last_id": "x" }));
        assert_eq!(last, None);
    }

    #[test]
    fn a_compatible_server_lists_every_model_sorted_once() {
        let reply = json!({
            "object": "list",
            "data": [
                { "id": "zeta", "object": "model" },
                { "id": "alpha", "object": "model" },
                { "object": "model" }
            ]
        });
        let ids: Vec<String> = dedupe(openai_models(&reply))
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["alpha", "zeta"]);
        let twice = vec![
            ModelOption {
                id: "a".into(),
                name: "first".into(),
            },
            ModelOption {
                id: "a".into(),
                name: "second".into(),
            },
        ];
        assert_eq!(dedupe(twice)[0].name, "first");
    }

    #[tokio::test]
    async fn a_backend_that_needs_a_key_asks_for_one_before_calling() {
        for kind in [BackendKind::Gemini, BackendKind::Anthropic] {
            let err = list(kind, None, Some("  ".into())).await.unwrap_err();
            assert!(matches!(err, InferenceError::Auth(_)), "{kind:?}");
        }
        let err = list(BackendKind::GithubCopilot, None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, InferenceError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn gemini_is_asked_with_the_key_in_a_header() {
        let reply = json!({ "models": [{
            "name": "models/gemini-test",
            "displayName": "Gemini Test",
            "supportedGenerationMethods": ["generateContent"]
        }] });
        let (base, request) = serve_once(200, reply).await;
        let models = list(BackendKind::Gemini, Some(&base), Some("key-123".into()))
            .await
            .unwrap();
        assert_eq!(models[0].id, "gemini-test");
        let request = request.await.unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1beta/models?pageSize=1000");
        assert_eq!(request.header("x-goog-api-key"), Some("key-123"));
        assert!(!request.path.contains("key-123"));
    }

    #[tokio::test]
    async fn anthropic_is_asked_with_its_key_and_version_headers() {
        let reply = json!({
            "data": [{ "id": "claude-test", "display_name": "Claude Test" }],
            "has_more": false
        });
        let (base, request) = serve_once(200, reply).await;
        let models = list(BackendKind::Anthropic, Some(&base), Some("sk-test".into()))
            .await
            .unwrap();
        assert_eq!(models[0].name, "Claude Test");
        let request = request.await.unwrap();
        assert_eq!(request.path, "/v1/models?limit=1000");
        assert_eq!(request.header("x-api-key"), Some("sk-test"));
        assert_eq!(
            request.header("anthropic-version"),
            Some(anthropic::API_VERSION)
        );
    }

    #[tokio::test]
    async fn a_compatible_server_is_asked_with_a_bearer_key_only_when_there_is_one() {
        let reply = json!({ "data": [{ "id": "local-model" }] });
        let (base, request) = serve_once(200, reply.clone()).await;
        let models = list(
            BackendKind::OpenaiCompatible,
            Some(&format!("{base}/v1/")),
            None,
        )
        .await
        .unwrap();
        assert_eq!(models[0].id, "local-model");
        let request = request.await.unwrap();
        assert_eq!(request.path, "/v1/models");
        assert_eq!(request.header("authorization"), None);

        let (base, request) = serve_once(200, reply).await;
        list(
            BackendKind::OpenaiCompatible,
            Some(&format!("{base}/v1")),
            Some("sk-local".into()),
        )
        .await
        .unwrap();
        let request = request.await.unwrap();
        assert_eq!(request.header("authorization"), Some("Bearer sk-local"));
    }

    #[tokio::test]
    async fn a_rejected_key_is_reported_as_one() {
        let reply = json!({ "error": {
            "code": 400,
            "message": "API key not valid. Please pass a valid API key.",
            "status": "INVALID_ARGUMENT"
        } });
        let (base, _request) = serve_once(400, reply).await;
        let err = list(BackendKind::Gemini, Some(&base), Some("bad".into()))
            .await
            .unwrap_err();
        assert!(matches!(err, InferenceError::Auth(_)), "{err:?}");
    }
}
