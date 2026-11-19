//! OpenAI's Chat Completions API, and any server that implements it.
//!
//! This is the format local inference servers speak, which is why it is the
//! one used here: a configurable base URL covers OpenAI and local models
//! alike. Wire format:
//!
//! - `POST {base}/chat/completions`, where the base normally ends in `/v1`.
//!   The key goes in `Authorization: Bearer`. A local server may need none.
//! - Tools are `{ type: "function", function: { name, description, parameters } }`.
//! - A tool call's arguments arrive as a JSON string, not an object.
//! - Each result goes back as its own `tool` message, matched by
//!   `tool_call_id`.
//!
//! Limitation: OpenAI's documentation says some of its newest models take
//! tool calls only through its Responses API, which this does not implement.

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::post_json;
use crate::agent::backend::{
    ChatRequest, ChatResponse, InferenceBackend, InferenceError, Message, StopReason, ToolCall,
    Usage,
};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// The key under which arguments that were not valid JSON are passed on. The
/// engine rejects the unknown argument, and that error tells the model to
/// try again, which is better than guessing what it meant.
const UNPARSED_ARGUMENTS: &str = "unparsed_arguments";

pub struct OpenAiCompatible {
    http: reqwest::Client,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

impl OpenAiCompatible {
    pub fn new(
        http: reqwest::Client,
        base_url: String,
        model: String,
        api_key: Option<String>,
    ) -> Self {
        Self {
            http,
            base_url,
            model,
            api_key,
        }
    }
}

impl InferenceBackend for OpenAiCompatible {
    fn complete<'a>(
        &'a self,
        request: ChatRequest<'a>,
    ) -> BoxFuture<'a, Result<ChatResponse, InferenceError>> {
        async move {
            let body = build_request(&self.model, &request);
            let bearer = self.api_key.as_ref().map(|key| format!("Bearer {key}"));
            let headers: Vec<(&str, &str)> = bearer
                .as_deref()
                .map(|value| ("authorization", value))
                .into_iter()
                .collect();
            let reply = post_json(
                &self.http,
                &format!("{}/chat/completions", self.base_url),
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

fn error_message(body: &Value) -> Option<String> {
    let error = body.get("error")?;
    // Some compatible servers send the error as a bare string.
    if let Some(text) = error.as_str() {
        return Some(text.to_string());
    }
    error.get("message")?.as_str().map(str::to_string)
}

pub fn build_request(model: &str, request: &ChatRequest<'_>) -> Value {
    let mut messages = Vec::new();
    if !request.system.is_empty() {
        // "system" is the role every compatible server understands.
        messages.push(json!({ "role": "system", "content": request.system }));
    }
    for message in request.messages {
        push_message(&mut messages, message);
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("messages".into(), Value::Array(messages));
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
    }
    Value::Object(body)
}

fn push_message(out: &mut Vec<Value>, message: &Message) {
    match message {
        Message::User { text } => out.push(json!({ "role": "user", "content": text })),
        Message::Assistant { raw: Some(raw), .. } => out.push(raw.clone()),
        Message::Assistant {
            text, tool_calls, ..
        } => {
            let mut assistant = json!({ "role": "assistant", "content": text });
            if !tool_calls.is_empty() {
                let calls: Vec<Value> = tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": Value::Object(call.arguments.clone()).to_string(),
                            }
                        })
                    })
                    .collect();
                assistant["tool_calls"] = Value::Array(calls);
            }
            out.push(assistant);
        }
        // One message per result. There is no flag for a failed call, so
        // the content says so.
        Message::ToolResults { results } => {
            for result in results {
                let content = if result.is_error {
                    format!("Error: {}", result.content)
                } else {
                    result.content.clone()
                };
                out.push(json!({
                    "role": "tool",
                    "tool_call_id": result.call_id,
                    "content": content,
                }));
            }
        }
    }
}

pub fn parse_response(reply: &Value) -> Result<ChatResponse, InferenceError> {
    let choice = reply
        .pointer("/choices/0")
        .ok_or_else(|| InferenceError::Protocol("the reply had no choices".into()))?;
    let message = choice
        .get("message")
        .ok_or_else(|| InferenceError::Protocol("the reply had no message".into()))?;

    let text = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let mut tool_calls = Vec::new();
    for (index, call) in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let name = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .ok_or_else(|| InferenceError::Protocol("a tool call had no name".into()))?;
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map_or_else(|| format!("call_{}", index + 1), str::to_string);
        tool_calls.push(ToolCall {
            id,
            name: name.to_string(),
            arguments: parse_arguments(call.pointer("/function/arguments")),
        });
    }

    let refusal = message
        .get("refusal")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty());
    let stop = if let Some(refusal) = refusal {
        tool_calls.clear();
        StopReason::Refused(refusal.to_string())
    } else if !tool_calls.is_empty() {
        StopReason::ToolUse
    } else {
        match choice.get("finish_reason").and_then(Value::as_str) {
            Some("stop") | None => StopReason::EndTurn,
            Some("length") => StopReason::MaxTokens,
            Some("content_filter") => {
                StopReason::Refused("The reply was withheld by a content filter.".to_string())
            }
            Some(other) => StopReason::Other(other.to_string()),
        }
    };

    // `prompt_tokens` is the whole input and `completion_tokens` the whole
    // output, reasoning included. A server that caches says how much of the
    // input it read from its cache. A local server usually says none of it.
    let usage = Usage {
        input_tokens: reply
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_u64),
        output_tokens: reply
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64),
        cached_input_tokens: reply
            .pointer("/usage/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_u64),
    };

    // The message goes back as it came, so that fields a particular server
    // adds to it are not lost. Calls that had no id get the one made up
    // here, so that their results can be matched.
    let mut raw = message.clone();
    if raw.get("role").is_none() {
        raw["role"] = json!("assistant");
    }
    if let Some(calls) = raw.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for (call, parsed) in calls.iter_mut().zip(&tool_calls) {
            call["id"] = json!(parsed.id);
        }
    }

    Ok(ChatResponse {
        text,
        tool_calls,
        raw: Some(raw),
        stop,
        usage,
    })
}

/// Arguments arrive as a JSON string. Some servers send an object instead.
fn parse_arguments(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(object)) => object.clone(),
        Some(Value::String(text)) if text.trim().is_empty() => Map::new(),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(object)) => object,
            _ => {
                let mut wrapped = Map::new();
                wrapped.insert(UNPARSED_ARGUMENTS.to_string(), json!(text));
                wrapped
            }
        },
        _ => Map::new(),
    }
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
            input_schema: json!({ "type": "object", "properties": { "sql": { "type": "string" } }, "required": ["sql"] }),
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
            "local-model",
            &ChatRequest {
                system: "be brief",
                messages: &messages,
                tools: &tools,
            },
        );
        assert_eq!(body["model"], "local-model");
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "be brief" })
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "list providers" })
        );
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "run_select_query");
        assert_eq!(
            body["tools"][0]["function"]["parameters"],
            tools[0].input_schema
        );
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn tool_calls_are_parsed_from_string_arguments() {
        let reply = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        { "id": "call_a", "type": "function", "function": { "name": "run_select_query", "arguments": "{\"sql\":\"SELECT 1\"}" } },
                        { "id": "call_b", "type": "function", "function": { "name": "list_providers", "arguments": "" } }
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 100, "completion_tokens": 20, "prompt_tokens_details": { "cached_tokens": 64 } }
        });
        let response = parse_response(&reply).unwrap();
        assert_eq!(response.text, "");
        assert_eq!(response.tool_calls[0].id, "call_a");
        assert_eq!(response.tool_calls[0].arguments["sql"], "SELECT 1");
        assert!(response.tool_calls[1].arguments.is_empty());
        assert_eq!(response.stop, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, Some(100));
        assert_eq!(response.usage.output_tokens, Some(20));
        assert_eq!(response.usage.cached_input_tokens, Some(64));
    }

    #[test]
    fn arguments_that_are_not_json_are_passed_on_for_the_engine_to_reject() {
        let arguments = parse_arguments(Some(&json!("{not json")));
        assert_eq!(arguments[UNPARSED_ARGUMENTS], "{not json");
        // An object, which some servers send, is taken as it is.
        assert_eq!(parse_arguments(Some(&json!({ "sql": "x" })))["sql"], "x");
        assert!(parse_arguments(None).is_empty());
    }

    #[test]
    fn the_assistant_turn_and_one_message_per_result_go_back() {
        let reply = json!({ "choices": [{ "message": {
            "role": "assistant", "content": null,
            "tool_calls": [{ "id": "call_a", "type": "function", "function": { "name": "run_select_query", "arguments": "{}" } }]
        }}]});
        let response = parse_response(&reply).unwrap();
        let messages = vec![
            Message::User { text: "go".into() },
            response.into_message(),
            Message::ToolResults {
                results: vec![
                    ToolOutcome {
                        call_id: "call_a".into(),
                        name: "run_select_query".into(),
                        content: "| one |".into(),
                        is_error: false,
                    },
                    ToolOutcome {
                        call_id: "call_b".into(),
                        name: "run_mutation_query".into(),
                        content: "refused".into(),
                        is_error: true,
                    },
                ],
            },
        ];
        let body = build_request(
            "m",
            &ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            },
        );
        let sent = body["messages"].as_array().unwrap();
        assert_eq!(sent.len(), 4);
        assert_eq!(sent[1]["tool_calls"][0]["id"], "call_a");
        assert_eq!(
            sent[2],
            json!({ "role": "tool", "tool_call_id": "call_a", "content": "| one |" })
        );
        assert_eq!(sent[3]["content"], "Error: refused");
    }

    #[test]
    fn a_call_without_an_id_gets_one_that_matches_its_result() {
        let reply = json!({ "choices": [{ "message": {
            "content": "", "tool_calls": [{ "function": { "name": "list_providers", "arguments": "{}" } }]
        }}]});
        let response = parse_response(&reply).unwrap();
        assert_eq!(response.tool_calls[0].id, "call_1");
        let raw = response.raw.unwrap();
        assert_eq!(raw["tool_calls"][0]["id"], "call_1");
        assert_eq!(raw["role"], "assistant");
    }

    #[test]
    fn a_turn_the_host_wrote_itself_is_sent_with_string_arguments() {
        let mut arguments = Map::new();
        arguments.insert("sql".into(), json!("SELECT 1"));
        let messages = vec![Message::Assistant {
            text: "running".into(),
            tool_calls: vec![ToolCall {
                id: "call_x".into(),
                name: "run_select_query".into(),
                arguments,
            }],
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
            body["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{\"sql\":\"SELECT 1\"}"
        );
    }

    #[test]
    fn finish_reasons_and_refusals_map_across() {
        let with = |finish: &str| {
            parse_response(
                &json!({ "choices": [{ "message": { "content": "x" }, "finish_reason": finish }] }),
            )
            .unwrap()
            .stop
        };
        assert_eq!(with("stop"), StopReason::EndTurn);
        assert_eq!(with("length"), StopReason::MaxTokens);
        assert!(matches!(with("content_filter"), StopReason::Refused(_)));

        let refused = parse_response(&json!({ "choices": [{ "message": {
            "content": null, "refusal": "I can't help with that.",
            "tool_calls": [{ "id": "c", "function": { "name": "run_mutation_query", "arguments": "{}" } }]
        }}]}))
        .unwrap();
        assert_eq!(
            refused.stop,
            StopReason::Refused("I can't help with that.".into())
        );
        assert!(refused.tool_calls.is_empty());
    }

    #[test]
    fn a_reply_without_choices_is_a_protocol_error() {
        assert!(matches!(
            parse_response(&json!({ "object": "chat.completion" })),
            Err(InferenceError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn the_request_goes_to_chat_completions_with_a_bearer_key() {
        let (base, captured) = serve_once(
            200,
            json!({ "choices": [{ "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }] }),
        )
        .await;
        let backend = OpenAiCompatible::new(
            reqwest::Client::new(),
            format!("{base}/v1"),
            "m".into(),
            Some("sk-test".into()),
        );
        let messages = vec![Message::User { text: "hi".into() }];
        let response = backend
            .complete(ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            })
            .await
            .unwrap();
        assert_eq!(response.text, "hello");
        let request = captured.await.unwrap();
        assert_eq!(request.path, "/v1/chat/completions");
        assert_eq!(request.header("authorization"), Some("Bearer sk-test"));
    }

    #[tokio::test]
    async fn a_local_server_gets_no_authorization_header() {
        let (base, captured) = serve_once(
            200,
            json!({ "choices": [{ "message": { "content": "ok" }, "finish_reason": "stop" }] }),
        )
        .await;
        let backend = OpenAiCompatible::new(reqwest::Client::new(), base, "m".into(), None);
        let messages = vec![Message::User { text: "hi".into() }];
        backend
            .complete(ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            })
            .await
            .unwrap();
        assert_eq!(captured.await.unwrap().header("authorization"), None);
    }

    #[tokio::test]
    async fn errors_carry_the_server_message_in_either_shape() {
        for body in [
            json!({ "error": { "message": "Incorrect API key provided", "type": "invalid_request_error" } }),
            json!({ "error": "Incorrect API key provided" }),
        ] {
            let (base, _captured) = serve_once(401, body).await;
            let backend = OpenAiCompatible::new(reqwest::Client::new(), base, "m".into(), None);
            let messages = vec![Message::User { text: "hi".into() }];
            let err = backend
                .complete(ChatRequest {
                    system: "",
                    messages: &messages,
                    tools: &[],
                })
                .await
                .unwrap_err();
            assert!(matches!(&err, InferenceError::Auth(m) if m.contains("Incorrect API key")));
        }
    }
}
