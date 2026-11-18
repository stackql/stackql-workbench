//! Inference backends that authenticate with an API key.
//!
//! Each one translates the shared conversation into its provider's wire
//! format and back. None of them holds state between calls, and none of them
//! ever sees engine credentials: a conversation contains only what the
//! operator typed and what tools returned.

pub mod anthropic;
pub mod gemini;
pub mod openai;

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::backend::{
    BackendKind, InferenceBackend, InferenceError, classify_http_error, classify_transport_error,
};
use crate::config::InferenceSettings;
use crate::util::truncate;

/// How long one model call may take. Models that reason before answering
/// can take minutes.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// The model used when the operator has not chosen one.
pub fn default_model(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::Gemini => gemini::DEFAULT_MODEL,
        BackendKind::Anthropic => anthropic::DEFAULT_MODEL,
        // There is no sensible default for an arbitrary compatible server.
        BackendKind::OpenaiCompatible => "",
        // Empty leaves the choice to the agent.
        BackendKind::GithubCopilot => "",
    }
}

/// The address used when the operator has not set one.
pub fn default_base_url(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::Gemini => gemini::DEFAULT_BASE_URL,
        BackendKind::Anthropic => anthropic::DEFAULT_BASE_URL,
        BackendKind::OpenaiCompatible => openai::DEFAULT_BASE_URL,
        // A delegated agent has no address of ours.
        BackendKind::GithubCopilot => "",
    }
}

/// Builds the backend the settings describe.
pub fn build(
    settings: &InferenceSettings,
    api_key: Option<String>,
) -> Result<Arc<dyn InferenceBackend>, InferenceError> {
    if settings.kind.is_delegated() {
        // A delegated agent runs its own loop. It has no request to build.
        return Err(InferenceError::InvalidRequest(
            "This backend is an agent, not a model API.".to_string(),
        ));
    }
    let model = if settings.model.trim().is_empty() {
        default_model(settings.kind).to_string()
    } else {
        settings.model.trim().to_string()
    };
    if model.is_empty() {
        return Err(InferenceError::InvalidRequest(
            "No model is set. Choose one in Settings.".to_string(),
        ));
    }
    let base_url = settings
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| default_base_url(settings.kind))
        .trim_end_matches('/')
        .to_string();
    let api_key = api_key.filter(|key| !key.trim().is_empty());
    if api_key.is_none() && !settings.kind.key_optional() {
        return Err(InferenceError::Auth(
            "No API key is stored for this backend".to_string(),
        ));
    }
    let http = http_client()?;
    Ok(match settings.kind {
        BackendKind::Gemini => Arc::new(gemini::Gemini::new(
            http,
            base_url,
            model,
            api_key.unwrap_or_default(),
        )),
        BackendKind::Anthropic => Arc::new(anthropic::Anthropic::new(
            http,
            base_url,
            model,
            api_key.unwrap_or_default(),
        )),
        BackendKind::OpenaiCompatible => Arc::new(openai::OpenAiCompatible::new(
            http, base_url, model, api_key,
        )),
        BackendKind::GithubCopilot => {
            return Err(InferenceError::InvalidRequest(
                "This backend is an agent, not a model API.".to_string(),
            ));
        }
    })
}

fn http_client() -> Result<reqwest::Client, InferenceError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("stackql-workbench/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| InferenceError::Network(err.to_string()))
}

/// Posts JSON and returns the parsed reply. `error_message` digs the
/// provider's message out of an error body.
async fn post_json(
    http: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
    body: &Value,
    error_message: fn(&Value) -> Option<String>,
) -> Result<Value, InferenceError> {
    let mut request = http.post(url).json(body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request
        .send()
        .await
        .map_err(|err| classify_transport_error(&err))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| classify_transport_error(&err))?;

    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| error_message(&json))
            .unwrap_or_else(|| truncate(text.trim(), 300));
        return Err(classify_http_error(
            status.as_u16(),
            format!("HTTP {}: {message}", status.as_u16()),
        ));
    }
    serde_json::from_str(&text)
        .map_err(|err| InferenceError::Protocol(format!("the reply was not JSON: {err}")))
}

#[cfg(test)]
pub(crate) mod testing {
    //! A one-shot HTTP server for backend tests. It records the request it
    //! receives and answers with a canned reply, so a test can check exactly
    //! what a backend puts on the wire without calling a real provider.

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    pub struct Captured {
        pub method: String,
        pub path: String,
        /// Header names are lower-cased.
        pub headers: Vec<(String, String)>,
        pub body: serde_json::Value,
    }

    impl Captured {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        }
    }

    /// Starts a server that answers one request. Returns its base URL and a
    /// receiver for what it was sent.
    pub async fn serve_once(
        status: u16,
        reply: serde_json::Value,
    ) -> (String, oneshot::Receiver<Captured>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut chunk = [0u8; 8192];
            let (head_end, length) = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0, "the client closed before sending a full request");
                data.extend_from_slice(&chunk[..n]);
                if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&data[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map_or(0, |v| v.trim().parse::<usize>().unwrap());
                    break (end + 4, length);
                }
            };
            while data.len() < head_end + length {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0, "the client closed before sending the whole body");
                data.extend_from_slice(&chunk[..n]);
            }

            let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
            let mut lines = head.lines();
            let mut request_line = lines.next().unwrap_or_default().split_whitespace();
            let method = request_line.next().unwrap_or_default().to_string();
            let path = request_line.next().unwrap_or_default().to_string();
            let headers = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect();
            let body = serde_json::from_slice(&data[head_end..head_end + length])
                .unwrap_or(serde_json::Value::Null);

            let payload = reply.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            let _ = socket.shutdown().await;
            let _ = tx.send(Captured {
                method,
                path,
                headers,
                body,
            });
        });
        (format!("http://{address}"), rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(kind: BackendKind, model: &str, base_url: Option<&str>) -> InferenceSettings {
        InferenceSettings {
            kind,
            model: model.to_string(),
            base_url: base_url.map(str::to_string),
            program: None,
        }
    }

    #[test]
    fn a_backend_that_needs_a_key_is_not_built_without_one() {
        for kind in [BackendKind::Gemini, BackendKind::Anthropic] {
            let err = build(&settings(kind, "", None), None).err().unwrap();
            assert!(matches!(err, InferenceError::Auth(_)), "{kind:?}");
            let err = build(&settings(kind, "", None), Some("   ".into()))
                .err()
                .unwrap();
            assert!(matches!(err, InferenceError::Auth(_)), "{kind:?}");
        }
    }

    #[test]
    fn a_compatible_server_needs_a_model_but_not_a_key() {
        let err = build(&settings(BackendKind::OpenaiCompatible, "", None), None)
            .err()
            .unwrap();
        assert!(matches!(err, InferenceError::InvalidRequest(_)));
        assert!(
            build(
                &settings(
                    BackendKind::OpenaiCompatible,
                    "local-model",
                    Some("http://127.0.0.1:11434/v1/")
                ),
                None
            )
            .is_ok()
        );
    }

    #[test]
    fn defaults_exist_where_they_make_sense() {
        assert!(!default_model(BackendKind::Gemini).is_empty());
        assert!(!default_model(BackendKind::Anthropic).is_empty());
        assert!(default_model(BackendKind::OpenaiCompatible).is_empty());
        for kind in [
            BackendKind::Gemini,
            BackendKind::Anthropic,
            BackendKind::OpenaiCompatible,
        ] {
            assert!(default_base_url(kind).starts_with("https://"));
        }
    }
}
