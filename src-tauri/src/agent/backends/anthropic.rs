//! Claude, through the Anthropic Messages API, with an API key.
//!
//! There is no official Anthropic SDK for Rust, so this speaks the REST API
//! directly. Wire format notes, from Anthropic's API reference as read in
//! November 2026:
//!
//! - `POST {base}/v1/messages` with `x-api-key` and `anthropic-version`.
//! - Tools are `{ name, description, input_schema }`. The MCP tool schemas
//!   pass unchanged.
//! - The reply is a list of content blocks. `tool_use` blocks are the tool
//!   calls. Thinking blocks must go back exactly as they came, so the whole
//!   list is kept and returned untouched.
//! - Every result for one assistant turn goes back in a single `user`
//!   message, as `tool_result` blocks.
//! - No sampling parameters and no thinking configuration are sent. Current
//!   models reject the former and choose the latter themselves, and leaving
//!   both out works on every model an operator might pick.
//! - A request can be declined: HTTP 200 with `stop_reason: "refusal"`.

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::post_json;
use crate::agent::backend::{
    ChatRequest, ChatResponse, InferenceBackend, InferenceError, Message, StopReason, ToolCall,
    Usage,
};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";

pub(super) const API_VERSION: &str = "2026-10-21";
/// Kept below the size at which a non-streaming request risks a timeout.
const MAX_TOKENS: u32 = 16_000;

/// Server-side fallback: when one of these models declines a request on
/// policy grounds, the API reruns it on a fallback model inside the same
/// call. It is opt-in per request, and only these models take it.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MODELS_WITH_FALLBACK: [&str; 5] = [
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
];

pub struct Anthropic {
    http: reqwest::Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl Anthropic {
    pub fn new(http: reqwest::Client, base_url: String, model: String, api_key: String) -> Self {
        Self {
            http,
            base_url,
            model,
            api_key,
        }
    }
}

impl InferenceBackend for Anthropic {
    fn complete<'a>(
        &'a self,
        request: ChatRequest<'a>,
    ) -> BoxFuture<'a, Result<ChatResponse, InferenceError>> {
        async move {
            let body = build_request(&self.model, &request);
            let mut headers = vec![
                ("x-api-key", self.api_key.as_str()),
                ("anthropic-version", API_VERSION),
            ];
            if uses_fallback(&self.model) {
                headers.push(("anthropic-beta", FALLBACK_BETA));
            }
            let reply = post_json(
                &self.http,
                &format!("{}/v1/messages", self.base_url),
                &headers,
                &body,
                error_message,
            )
            .await?;
            parse_response(&reply)
        }
        .boxed()
    }
}

fn uses_fallback(model: &str) -> bool {
    MODELS_WITH_FALLBACK.contains(&model)
}

pub(super) fn error_message(body: &Value) -> Option<String> {
    let error = body.get("error")?;
    let message = error.get("message")?.as_str()?;
    let kind = error.get("type").and_then(Value::as_str).unwrap_or("");
    Some(
        format!("{kind}: {message}")
            .trim_start_matches(": ")
            .to_string(),
    )
}

pub fn build_request(model: &str, request: &ChatRequest<'_>) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("max_tokens".into(), json!(MAX_TOKENS));
    // Caches the longest stable prefix: tools, system text and the
    // conversation so far. Each step of a turn resends all of that.
    body.insert("cache_control".into(), json!({ "type": "ephemeral" }));
    if !request.system.is_empty() {
        body.insert("system".into(), json!(request.system));
    }
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
    }
    if uses_fallback(model) {
        body.insert("fallbacks".into(), json!("default"));
    }
    body.insert(
        "messages".into(),
        Value::Array(request.messages.iter().map(message_of).collect()),
    );
    Value::Object(body)
}

fn message_of(message: &Message) -> Value {
    match message {
        Message::User { text } => json!({ "role": "user", "content": text }),
        // The model's content goes back exactly as it arrived. Thinking
        // blocks in it are only valid unchanged.
        Message::Assistant { raw: Some(raw), .. } => {
            json!({ "role": "assistant", "content": raw })
        }
        Message::Assistant {
            text, tool_calls, ..
        } => {
            let mut content = Vec::new();
            if !text.is_empty() {
                content.push(json!({ "type": "text", "text": text }));
            }
            for call in tool_calls {
                content.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": call.arguments,
                }));
            }
            if content.is_empty() {
                content.push(json!({ "type": "text", "text": "(no reply)" }));
            }
            json!({ "role": "assistant", "content": content })
        }
        // One user message holds every result. Splitting them across
        // messages teaches the model to stop calling tools in parallel.
        Message::ToolResults { results } => {
            let content: Vec<Value> = results
                .iter()
                .map(|result| {
                    let mut block = json!({
                        "type": "tool_result",
                        "tool_use_id": result.call_id,
                        "content": result.content,
                    });
                    if result.is_error {
                        block["is_error"] = json!(true);
                    }
                    block
                })
                .collect();
            json!({ "role": "user", "content": content })
        }
    }
}

pub fn parse_response(reply: &Value) -> Result<ChatResponse, InferenceError> {
    let blocks = reply
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| InferenceError::Protocol("the reply had no content list".into()))?;

    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(piece) = block.get("text").and_then(Value::as_str) {
                    text.push_str(piece);
                }
            }
            Some("tool_use") => {
                let id = block.get("id").and_then(Value::as_str);
                let name = block.get("name").and_then(Value::as_str);
                let (Some(id), Some(name)) = (id, name) else {
                    return Err(InferenceError::Protocol(
                        "a tool call had no id or no name".into(),
                    ));
                };
                tool_calls.push(ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: block
                        .get("input")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                });
            }
            // Thinking and other block kinds are kept in the raw reply and
            // are not shown as answer text.
            _ => {}
        }
    }

    // Check why the model stopped before trusting the content.
    let stop = match reply.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => {
            let detail = reply
                .pointer("/stop_details/explanation")
                .and_then(Value::as_str)
                .or_else(|| {
                    reply
                        .pointer("/stop_details/category")
                        .and_then(Value::as_str)
                })
                .unwrap_or("no reason given");
            StopReason::Refused(format!("The model declined this request: {detail}"))
        }
        Some("tool_use") => StopReason::ToolUse,
        Some("end_turn" | "stop_sequence") | None => StopReason::EndTurn,
        Some("max_tokens") => StopReason::MaxTokens,
        Some(other) => StopReason::Other(other.to_string()),
    };
    // A declined reply may still list tool calls. They must not run.
    if matches!(stop, StopReason::Refused(_)) {
        tool_calls.clear();
    }

    let count = |name: &str| {
        reply
            .pointer(&format!("/usage/{name}"))
            .and_then(Value::as_u64)
    };
    // Cached input is reported apart from uncached input. The total is what
    // the operator cares about.
    let input_parts = [
        count("input_tokens"),
        count("cache_creation_input_tokens"),
        count("cache_read_input_tokens"),
    ];
    let usage = Usage {
        input_tokens: input_parts
            .iter()
            .any(Option::is_some)
            .then(|| input_parts.iter().flatten().sum()),
        output_tokens: count("output_tokens"),
        cached_input_tokens: count("cache_read_input_tokens"),
    };

    Ok(ChatResponse {
        text,
        tool_calls,
        raw: (!blocks.is_empty()).then(|| Value::Array(blocks.clone())),
        stop,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::backend::{ToolOutcome, ToolSpec};
    use crate::agent::backends::testing::serve_once;

    fn tools() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "run_select_query".into(),
            description: "Execute a SELECT.".into(),
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "sql": { "type": "string" } },
                "required": ["sql"]
            }),
            destructive: Some(false),
        }]
    }

    #[test]
    fn the_request_has_the_expected_shape() {
        let messages = vec![Message::User {
            text: "list providers".into(),
        }];
        let tools = tools();
        let body = build_request(
            "claude-opus-5-5",
            &ChatRequest {
                system: "be brief",
                messages: &messages,
                tools: &tools,
            },
        );
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(body["tools"][0]["name"], "run_select_query");
        // The MCP schema is passed through as it is.
        assert_eq!(body["tools"][0]["input_schema"], tools[0].input_schema);
        assert_eq!(
            body["messages"][0],
            json!({ "role": "user", "content": "list providers" })
        );
        // Nothing that current models reject.
        for absent in ["temperature", "top_p", "top_k", "thinking", "tool_choice"] {
            assert!(body.get(absent).is_none(), "{absent} should not be sent");
        }
    }

    #[test]
    fn fallback_is_requested_only_for_models_that_take_it() {
        let messages = vec![Message::User { text: "hi".into() }];
        let request = ChatRequest {
            system: "",
            messages: &messages,
            tools: &[],
        };
        assert_eq!(
            build_request("claude-opus-5-5", &request)["fallbacks"],
            "default"
        );
        assert_eq!(
            build_request("claude-sonnet-5-5", &request)["fallbacks"],
            "default"
        );
        assert!(
            build_request("claude-haiku-5-5", &request)
                .get("fallbacks")
                .is_none()
        );
        assert!(
            build_request("some-other-model", &request)
                .get("fallbacks")
                .is_none()
        );
    }

    #[test]
    fn a_tool_use_reply_is_parsed_and_kept_whole() {
        let reply = json!({
            "content": [
                { "type": "thinking", "thinking": "", "signature": "sig-1" },
                { "type": "text", "text": "Let me check." },
                { "type": "tool_use", "id": "toolu_1", "name": "run_select_query", "input": { "sql": "SELECT 1" } },
                { "type": "tool_use", "id": "toolu_2", "name": "list_providers", "input": {} }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 12, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0, "output_tokens": 40 }
        });
        let response = parse_response(&reply).unwrap();
        assert_eq!(response.text, "Let me check.");
        assert_eq!(response.tool_calls.len(), 2);
        assert_eq!(response.tool_calls[0].id, "toolu_1");
        assert_eq!(response.tool_calls[0].arguments["sql"], "SELECT 1");
        assert_eq!(response.stop, StopReason::ToolUse);
        // Cached and uncached input are added together.
        assert_eq!(response.usage.input_tokens, Some(912));
        assert_eq!(response.usage.output_tokens, Some(40));
        // What was read from the cache is in the input, and also told apart.
        assert_eq!(response.usage.cached_input_tokens, Some(900));
        // The thinking block survives in what is kept for replay.
        assert_eq!(response.raw.as_ref().unwrap()[0]["signature"], "sig-1");
    }

    #[test]
    fn the_kept_reply_is_sent_back_untouched_followed_by_one_message_of_results() {
        let raw = json!([
            { "type": "thinking", "thinking": "", "signature": "sig-1" },
            { "type": "tool_use", "id": "toolu_1", "name": "run_select_query", "input": { "sql": "SELECT 1" } },
            { "type": "tool_use", "id": "toolu_2", "name": "run_mutation_query", "input": { "sql": "DELETE" } }
        ]);
        let messages = vec![
            Message::User { text: "go".into() },
            Message::Assistant {
                text: String::new(),
                tool_calls: Vec::new(),
                raw: Some(raw.clone()),
            },
            Message::ToolResults {
                results: vec![
                    ToolOutcome {
                        call_id: "toolu_1".into(),
                        name: "run_select_query".into(),
                        content: "| one |".into(),
                        is_error: false,
                    },
                    ToolOutcome {
                        call_id: "toolu_2".into(),
                        name: "run_mutation_query".into(),
                        content: "refused: user declined approval".into(),
                        is_error: true,
                    },
                ],
            },
        ];
        let body = build_request(
            "claude-opus-5-5",
            &ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            },
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "assistant", "content": raw })
        );
        let results = &body["messages"][2];
        assert_eq!(results["role"], "user");
        assert_eq!(results["content"].as_array().unwrap().len(), 2);
        assert_eq!(
            results["content"][0],
            json!({ "type": "tool_result", "tool_use_id": "toolu_1", "content": "| one |" })
        );
        assert_eq!(results["content"][1]["is_error"], true);
        assert!(body.get("system").is_none());
    }

    #[test]
    fn a_turn_the_host_wrote_itself_is_sent_as_plain_blocks() {
        let messages = vec![Message::Assistant {
            text: "[The operator stopped this turn.]".into(),
            tool_calls: Vec::new(),
            raw: None,
        }];
        let body = build_request(
            "m",
            &ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            },
        );
        assert_eq!(
            body["messages"][0]["content"],
            json!([{ "type": "text", "text": "[The operator stopped this turn.]" }])
        );
    }

    #[test]
    fn a_refusal_is_reported_and_runs_no_tools() {
        let reply = json!({
            "content": [{ "type": "tool_use", "id": "toolu_1", "name": "run_mutation_query", "input": {} }],
            "stop_reason": "refusal",
            "stop_details": { "type": "refusal", "category": "cyber", "explanation": "This request was declined." }
        });
        let response = parse_response(&reply).unwrap();
        assert!(
            matches!(&response.stop, StopReason::Refused(m) if m.contains("This request was declined."))
        );
        assert!(response.tool_calls.is_empty());
    }

    #[test]
    fn stop_reasons_map_across() {
        let with = |reason: &str| {
            parse_response(
                &json!({ "content": [{ "type": "text", "text": "x" }], "stop_reason": reason }),
            )
            .unwrap()
            .stop
        };
        assert_eq!(with("end_turn"), StopReason::EndTurn);
        assert_eq!(with("max_tokens"), StopReason::MaxTokens);
        assert_eq!(with("pause_turn"), StopReason::Other("pause_turn".into()));
    }

    #[test]
    fn a_reply_without_content_is_a_protocol_error() {
        assert!(matches!(
            parse_response(&json!({ "stop_reason": "end_turn" })),
            Err(InferenceError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn the_request_carries_the_key_the_version_and_the_fallback_beta() {
        let (base, captured) = serve_once(
            200,
            json!({ "content": [{ "type": "text", "text": "hello" }], "stop_reason": "end_turn", "usage": { "input_tokens": 5, "output_tokens": 2 } }),
        )
        .await;
        let backend = Anthropic::new(
            reqwest::Client::new(),
            base,
            "claude-opus-5-5".into(),
            "sk-test".into(),
        );
        let messages = vec![Message::User { text: "hi".into() }];
        let response = backend
            .complete(ChatRequest {
                system: "sys",
                messages: &messages,
                tools: &[],
            })
            .await
            .unwrap();
        assert_eq!(response.text, "hello");

        let request = captured.await.unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v1/messages");
        assert_eq!(request.header("x-api-key"), Some("sk-test"));
        assert_eq!(request.header("anthropic-version"), Some(API_VERSION));
        assert_eq!(request.header("anthropic-beta"), Some(FALLBACK_BETA));
        assert_eq!(request.body["fallbacks"], "default");
    }

    #[tokio::test]
    async fn a_model_without_fallback_gets_no_beta_header() {
        let (base, captured) = serve_once(
            200,
            json!({ "content": [{ "type": "text", "text": "ok" }], "stop_reason": "end_turn" }),
        )
        .await;
        let backend = Anthropic::new(
            reqwest::Client::new(),
            base,
            "claude-haiku-5-5".into(),
            "sk-test".into(),
        );
        let messages = vec![Message::User { text: "hi".into() }];
        backend
            .complete(ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            })
            .await
            .unwrap();
        let request = captured.await.unwrap();
        assert_eq!(request.header("anthropic-beta"), None);
        assert!(request.body.get("fallbacks").is_none());
    }

    #[tokio::test]
    async fn errors_are_classified_by_status() {
        let cases = [
            (401, "authentication_error", "invalid x-api-key"),
            (429, "rate_limit_error", "slow down"),
            (529, "overloaded_error", "Overloaded"),
            (400, "invalid_request_error", "prompt is too long"),
        ];
        for (status, kind, message) in cases {
            let (base, _captured) = serve_once(
                status,
                json!({ "type": "error", "error": { "type": kind, "message": message } }),
            )
            .await;
            let backend = Anthropic::new(reqwest::Client::new(), base, "m".into(), "k".into());
            let messages = vec![Message::User { text: "hi".into() }];
            let err = backend
                .complete(ChatRequest {
                    system: "",
                    messages: &messages,
                    tools: &[],
                })
                .await
                .unwrap_err();
            let matched = match status {
                401 => matches!(err, InferenceError::Auth(_)),
                429 => matches!(err, InferenceError::RateLimited(_)),
                529 => matches!(err, InferenceError::Unavailable(_)),
                _ => matches!(err, InferenceError::InvalidRequest(_)),
            };
            assert!(matched, "status {status} gave {err:?}");
            assert!(err.to_string().contains(message), "{err}");
        }
    }
}
