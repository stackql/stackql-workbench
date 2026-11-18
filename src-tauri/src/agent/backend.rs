//! The seam between the agent loop and a model.
//!
//! Everything above this trait is the same for every backend: the loop, the
//! MCP client, the approval flow and the chat UI. A backend only turns a
//! conversation into one request to its provider and the reply back into
//! text and tool calls.

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A tool the model may call. The schema comes from the MCP server and is
/// passed through unchanged.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub input_schema: Value,
}

/// A tool call the model asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// Identifies the call so its result can be matched to it.
    pub id: String,
    pub name: String,
    pub arguments: Map<String, Value>,
}

/// What a tool call produced, as the model will see it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    pub call_id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
}

/// One turn of the conversation, in a shape every backend can translate.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    User {
        text: String,
    },
    Assistant {
        text: String,
        tool_calls: Vec<ToolCall>,
        /// The provider's own representation of this turn. A backend sends
        /// it back as it was, because some providers attach state to their
        /// replies that must be returned untouched. Only the backend that
        /// produced it may interpret it.
        raw: Option<Value>,
    },
    ToolResults {
        results: Vec<ToolOutcome>,
    },
}

pub struct ChatRequest<'a> {
    pub system: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum StopReason {
    /// The model finished its answer.
    EndTurn,
    /// The model wants tools run.
    ToolUse,
    /// The reply was cut off by the output limit.
    MaxTokens,
    /// The provider declined to answer.
    Refused(String),
    Other(String),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub raw: Option<Value>,
    pub stop: StopReason,
    pub usage: Usage,
}

impl ChatResponse {
    /// The assistant turn to append to the conversation.
    pub fn into_message(self) -> Message {
        Message::Assistant {
            text: self.text,
            tool_calls: self.tool_calls,
            raw: self.raw,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InferenceError {
    #[error("The inference provider rejected the API key. Check it in Settings. ({0})")]
    Auth(String),
    #[error("The inference provider is rate limiting or out of quota. ({0})")]
    RateLimited(String),
    #[error("The inference provider is unavailable. Try again shortly. ({0})")]
    Unavailable(String),
    #[error("The inference provider rejected the request. ({0})")]
    InvalidRequest(String),
    #[error("Could not reach the inference provider. ({0})")]
    Network(String),
    #[error("The inference provider sent a reply that could not be read. ({0})")]
    Protocol(String),
}

/// Which family of API a backend speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    Gemini,
    Anthropic,
    /// OpenAI's Chat Completions API, and any server that implements it,
    /// which covers local inference.
    OpenaiCompatible,
    /// The GitHub Copilot CLI, driven as a delegated agent. It runs the
    /// model with the operator's own sign-in, which this app never sees.
    GithubCopilot,
}

impl BackendKind {
    /// Every backend, in the order the settings pane lists them.
    pub const ALL: [Self; 4] = [
        Self::Gemini,
        Self::Anthropic,
        Self::OpenaiCompatible,
        Self::GithubCopilot,
    ];

    /// The name the API key is stored under in the OS keychain. `None` for
    /// a backend that has no key of ours to store.
    pub fn secret_name(self) -> Option<&'static str> {
        match self {
            Self::Gemini => Some("inference.gemini.api_key"),
            Self::Anthropic => Some("inference.anthropic.api_key"),
            Self::OpenaiCompatible => Some("inference.openai_compatible.api_key"),
            Self::GithubCopilot => None,
        }
    }

    /// Whether the backend can work without an API key. A local server
    /// usually has none, and a delegated agent signs in by itself.
    pub fn key_optional(self) -> bool {
        matches!(self, Self::OpenaiCompatible | Self::GithubCopilot)
    }

    /// Whether an agent the operator installed runs the model and the
    /// tools, instead of the host's own loop.
    pub fn is_delegated(self) -> bool {
        matches!(self, Self::GithubCopilot)
    }
}

pub trait InferenceBackend: Send + Sync {
    /// Sends the conversation to the model and returns its next turn.
    fn complete<'a>(
        &'a self,
        request: ChatRequest<'a>,
    ) -> BoxFuture<'a, Result<ChatResponse, InferenceError>>;
}

/// Turns an HTTP failure into the matching error. Shared by the backends,
/// which differ only in how they dig a message out of the body.
pub fn classify_http_error(status: u16, message: String) -> InferenceError {
    match status {
        401 | 403 => InferenceError::Auth(message),
        402 | 429 => InferenceError::RateLimited(message),
        408 | 500..=599 => InferenceError::Unavailable(message),
        _ => InferenceError::InvalidRequest(message),
    }
}

/// Turns a transport failure into an error. The text never includes the
/// request, so a key in a header cannot leak into it.
pub fn classify_transport_error(err: &reqwest::Error) -> InferenceError {
    let what = if err.is_timeout() {
        "the request timed out"
    } else if err.is_connect() {
        "could not connect"
    } else if err.is_decode() || err.is_body() {
        "the reply was not readable"
    } else {
        "the request failed"
    };
    InferenceError::Network(what.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_statuses_map_to_the_right_error() {
        assert!(matches!(
            classify_http_error(401, "x".into()),
            InferenceError::Auth(_)
        ));
        assert!(matches!(
            classify_http_error(403, "x".into()),
            InferenceError::Auth(_)
        ));
        assert!(matches!(
            classify_http_error(429, "x".into()),
            InferenceError::RateLimited(_)
        ));
        assert!(matches!(
            classify_http_error(503, "x".into()),
            InferenceError::Unavailable(_)
        ));
        assert!(matches!(
            classify_http_error(400, "x".into()),
            InferenceError::InvalidRequest(_)
        ));
        assert!(matches!(
            classify_http_error(404, "x".into()),
            InferenceError::InvalidRequest(_)
        ));
    }

    #[test]
    fn backend_kinds_serialise_in_snake_case() {
        assert_eq!(
            serde_json::to_value(BackendKind::OpenaiCompatible).unwrap(),
            serde_json::json!("openai_compatible")
        );
        assert_eq!(
            serde_json::from_value::<BackendKind>(serde_json::json!("gemini")).unwrap(),
            BackendKind::Gemini
        );
    }

    #[test]
    fn each_backend_has_its_own_keychain_entry() {
        let names = [
            BackendKind::Gemini.secret_name(),
            BackendKind::Anthropic.secret_name(),
            BackendKind::OpenaiCompatible.secret_name(),
        ];
        assert_eq!(
            names.iter().collect::<std::collections::HashSet<_>>().len(),
            3
        );
        assert!(names.iter().all(Option::is_some));
        assert!(BackendKind::OpenaiCompatible.key_optional());
        assert!(!BackendKind::Gemini.key_optional());
    }

    #[test]
    fn a_delegated_agent_has_no_key_of_ours() {
        let kind = BackendKind::GithubCopilot;
        assert!(kind.is_delegated());
        assert_eq!(kind.secret_name(), None);
        assert!(kind.key_optional());
        assert_eq!(
            serde_json::to_value(kind).unwrap(),
            serde_json::json!("github_copilot")
        );
        for other in [
            BackendKind::Gemini,
            BackendKind::Anthropic,
            BackendKind::OpenaiCompatible,
        ] {
            assert!(!other.is_delegated());
        }
        assert_eq!(BackendKind::ALL.len(), 4);
    }
}
