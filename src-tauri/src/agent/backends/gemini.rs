//! Gemini, through the `generateContent` REST method, with an API key.
//!
//! Wire format notes, from the Gemini API documentation as read in November
//! 2026:
//!
//! - `POST {base}/v1beta/models/{model}:generateContent`, key in the
//!   `x-goog-api-key` header.
//! - Tools go in `tools[].functionDeclarations`. `parametersJsonSchema`
//!   takes a standard JSON Schema, so the MCP tool schemas pass unchanged.
//! - A function call is a part of the model's reply. Newer models attach a
//!   `thoughtSignature` to it, which must come back exactly where it was.
//!   The whole reply is therefore kept and returned untouched.
//! - Results go back as `functionResponse` parts in one `user` turn, matched
//!   to their calls by `id`.
//! - Sampling parameters such as temperature are not sent. Current models
//!   ignore them and later ones are documented to reject them.

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::post_json;
use crate::agent::backend::{
    ChatRequest, ChatResponse, InferenceBackend, InferenceError, Message, StopReason, ToolCall,
    Usage,
};

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
/// Available on the free tier, and the model the documentation points new
/// projects at.
pub const DEFAULT_MODEL: &str = "gemini-4-hydrogen";

/// Output limit. It includes the model's reasoning, so it is generous.
const MAX_OUTPUT_TOKENS: u32 = 32_768;
/// Marks a call id this client invented because the model sent none. Such an
/// id is for matching inside the host only and is not sent back.
const LOCAL_ID_PREFIX: &str = "local-call-";

pub struct Gemini {
    http: reqwest::Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl Gemini {
    pub fn new(http: reqwest::Client, base_url: String, model: String, api_key: String) -> Self {
        Self {
            http,
            base_url,
            model,
            api_key,
        }
    }

    fn url(&self) -> String {
        // Accept a model written as "models/name", as the list API returns it.
        let model = self.model.trim_start_matches("models/");
        format!("{}/v1beta/models/{model}:generateContent", self.base_url)
    }
}

impl InferenceBackend for Gemini {
    fn complete<'a>(
        &'a self,
        request: ChatRequest<'a>,
    ) -> BoxFuture<'a, Result<ChatResponse, InferenceError>> {
        async move {
            let body = build_request(&request);
            let reply = post_json(
                &self.http,
                &self.url(),
                &[("x-goog-api-key", &self.api_key)],
                &body,
                error_message,
            )
            .await
            .map_err(reclassify_key_error)?;
            parse_response(&reply)
        }
        .boxed()
    }
}

pub(super) fn error_message(body: &Value) -> Option<String> {
    let error = body.get("error")?;
    let message = error.get("message")?.as_str()?;
    let status = error.get("status").and_then(Value::as_str).unwrap_or("");
    Some(format!("{status} {message}").trim().to_string())
}

/// A bad key comes back as 400 INVALID_ARGUMENT, not as 401.
pub(super) fn reclassify_key_error(err: InferenceError) -> InferenceError {
    match err {
        InferenceError::InvalidRequest(message) if message.contains("API key") => {
            InferenceError::Auth(message)
        }
        other => other,
    }
}

pub fn build_request(request: &ChatRequest<'_>) -> Value {
    let mut body = Map::new();
    if !request.system.is_empty() {
        body.insert(
            "systemInstruction".into(),
            json!({ "parts": [{ "text": request.system }] }),
        );
    }
    body.insert(
        "contents".into(),
        Value::Array(request.messages.iter().map(content_of).collect()),
    );
    if !request.tools.is_empty() {
        let declarations: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parametersJsonSchema": tool.input_schema,
                })
            })
            .collect();
        body.insert(
            "tools".into(),
            json!([{ "functionDeclarations": declarations }]),
        );
    }
    body.insert(
        "generationConfig".into(),
        json!({ "maxOutputTokens": MAX_OUTPUT_TOKENS }),
    );
    Value::Object(body)
}

fn content_of(message: &Message) -> Value {
    match message {
        Message::User { text } => json!({ "role": "user", "parts": [{ "text": text }] }),
        // The model's own reply goes back exactly as it arrived, signatures
        // included. Rebuilding it would lose them.
        Message::Assistant { raw: Some(raw), .. } => raw.clone(),
        Message::Assistant {
            text, tool_calls, ..
        } => {
            let mut parts = Vec::new();
            if !text.is_empty() {
                parts.push(json!({ "text": text }));
            }
            for call in tool_calls {
                let mut function_call = json!({ "name": call.name, "args": call.arguments });
                if !call.id.starts_with(LOCAL_ID_PREFIX) {
                    function_call["id"] = json!(call.id);
                }
                parts.push(json!({ "functionCall": function_call }));
            }
            if parts.is_empty() {
                parts.push(json!({ "text": "" }));
            }
            json!({ "role": "model", "parts": parts })
        }
        Message::ToolResults { results } => {
            let parts: Vec<Value> = results
                .iter()
                .map(|result| {
                    // The response must be an object. An "error" key is how a
                    // failed call is reported.
                    let key = if result.is_error { "error" } else { "result" };
                    let mut response = json!({
                        "name": result.name,
                        "response": { key: result.content },
                    });
                    if !result.call_id.starts_with(LOCAL_ID_PREFIX) {
                        response["id"] = json!(result.call_id);
                    }
                    json!({ "functionResponse": response })
                })
                .collect();
            json!({ "role": "user", "parts": parts })
        }
    }
}

pub fn parse_response(reply: &Value) -> Result<ChatResponse, InferenceError> {
    // The API counts the prompt, the reply and the model's thinking apart,
    // and gives the total as their sum. Thinking is billed as output, so it
    // is counted as output here. The prompt count already holds what was
    // read from the cache.
    let count = |name: &str| {
        reply
            .pointer(&format!("/usageMetadata/{name}"))
            .and_then(Value::as_u64)
    };
    let sum = |parts: [Option<u64>; 2]| {
        parts
            .iter()
            .any(Option::is_some)
            .then(|| parts.iter().flatten().sum())
    };
    let usage = Usage {
        input_tokens: sum([count("promptTokenCount"), count("toolUsePromptTokenCount")]),
        output_tokens: sum([count("candidatesTokenCount"), count("thoughtsTokenCount")]),
        cached_input_tokens: count("cachedContentTokenCount"),
    };

    let Some(candidate) = reply.pointer("/candidates/0") else {
        // No candidates means the prompt itself was blocked.
        let reason = reply
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
            .unwrap_or("no reason given");
        return Ok(ChatResponse {
            text: String::new(),
            tool_calls: Vec::new(),
            raw: None,
            stop: StopReason::Refused(format!("The request was blocked: {reason}")),
            usage,
        });
    };

    let content = candidate.get("content");
    let parts = content
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for part in &parts {
        // Parts flagged as thought are the model's reasoning, not its answer.
        if part.get("thought").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(piece) = part.get("text").and_then(Value::as_str) {
            text.push_str(piece);
        }
        if let Some(call) = part.get("functionCall") {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| InferenceError::Protocol("a function call had no name".into()))?;
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map_or_else(
                    || format!("{LOCAL_ID_PREFIX}{}", tool_calls.len() + 1),
                    str::to_string,
                );
            let arguments = call
                .get("args")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            tool_calls.push(ToolCall {
                id,
                name: name.to_string(),
                arguments,
            });
        }
    }

    let finish = candidate
        .get("finishReason")
        .and_then(Value::as_str)
        .unwrap_or("");
    let stop = if !tool_calls.is_empty() {
        StopReason::ToolUse
    } else {
        match finish {
            "STOP" | "" => StopReason::EndTurn,
            "MAX_TOKENS" => StopReason::MaxTokens,
            "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
                StopReason::Refused(format!("The model stopped: {finish}"))
            }
            other => StopReason::Other(other.to_string()),
        }
    };

    // Only keep the reply for replay when it has something in it. An empty
    // one cannot be sent back.
    let raw = content.filter(|_| !parts.is_empty()).map(|c| {
        let mut c = c.clone();
        if c.get("role").is_none() {
            c["role"] = json!("model");
        }
        c
    });

    Ok(ChatResponse {
        text,
        tool_calls,
        raw,
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
    fn the_request_carries_system_text_tools_and_no_sampling_parameters() {
        let messages = vec![Message::User {
            text: "list providers".into(),
        }];
        let tools = tools();
        let body = build_request(&ChatRequest {
            system: "be brief",
            messages: &messages,
            tools: &tools,
        });
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be brief");
        assert_eq!(
            body["contents"][0],
            json!({ "role": "user", "parts": [{ "text": "list providers" }] })
        );
        let declaration = &body["tools"][0]["functionDeclarations"][0];
        assert_eq!(declaration["name"], "run_select_query");
        // The MCP schema is passed through as it is.
        assert_eq!(declaration["parametersJsonSchema"], tools[0].input_schema);
        assert!(declaration.get("parameters").is_none());
        assert!(body["generationConfig"].get("temperature").is_none());
        assert_eq!(
            body["generationConfig"]["maxOutputTokens"],
            MAX_OUTPUT_TOKENS
        );
    }

    #[test]
    fn without_tools_the_tools_field_is_left_out() {
        let messages = vec![Message::User { text: "hi".into() }];
        let body = build_request(&ChatRequest {
            system: "",
            messages: &messages,
            tools: &[],
        });
        assert!(body.get("tools").is_none());
        assert!(body.get("systemInstruction").is_none());
    }

    #[test]
    fn a_function_call_reply_is_parsed_and_kept_whole() {
        let reply = json!({
            "candidates": [{
                "content": { "role": "model", "parts": [
                    { "thought": true, "text": "I should list providers." },
                    { "text": "Looking that up." },
                    { "functionCall": { "id": "fc-1", "name": "run_select_query", "args": { "sql": "SELECT 1" } },
                      "thoughtSignature": "sig-abc" },
                    { "functionCall": { "id": "fc-2", "name": "list_providers", "args": {} } }
                ]},
                "finishReason": "STOP"
            }],
            "usageMetadata": { "promptTokenCount": 120, "cachedContentTokenCount": 100, "candidatesTokenCount": 30, "thoughtsTokenCount": 50, "totalTokenCount": 200 }
        });
        let response = parse_response(&reply).unwrap();
        // Reasoning is not answer text.
        assert_eq!(response.text, "Looking that up.");
        assert_eq!(response.tool_calls.len(), 2);
        assert_eq!(response.tool_calls[0].id, "fc-1");
        assert_eq!(response.tool_calls[0].arguments["sql"], "SELECT 1");
        assert_eq!(response.tool_calls[1].name, "list_providers");
        assert_eq!(response.stop, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, Some(120));
        // Thinking is counted apart from the reply and billed as output.
        assert_eq!(response.usage.output_tokens, Some(80));
        assert_eq!(response.usage.cached_input_tokens, Some(100));
        // The signature survives in the kept reply.
        assert_eq!(
            response.raw.as_ref().unwrap()["parts"][2]["thoughtSignature"],
            "sig-abc"
        );
    }

    #[test]
    fn the_kept_reply_is_sent_back_untouched_followed_by_the_results() {
        let raw = json!({ "role": "model", "parts": [
            { "functionCall": { "id": "fc-1", "name": "run_select_query", "args": { "sql": "SELECT 1" } },
              "thoughtSignature": "sig-abc" }
        ]});
        let messages = vec![
            Message::User { text: "go".into() },
            Message::Assistant {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "fc-1".into(),
                    name: "run_select_query".into(),
                    arguments: Map::new(),
                }],
                raw: Some(raw.clone()),
            },
            Message::ToolResults {
                results: vec![
                    ToolOutcome {
                        call_id: "fc-1".into(),
                        name: "run_select_query".into(),
                        content: "| one |".into(),
                        is_error: false,
                    },
                    ToolOutcome {
                        call_id: "fc-2".into(),
                        name: "run_mutation_query".into(),
                        content: "refused: user declined approval".into(),
                        is_error: true,
                    },
                ],
            },
        ];
        let body = build_request(&ChatRequest {
            system: "",
            messages: &messages,
            tools: &[],
        });
        assert_eq!(body["contents"][1], raw);
        // All results for one model turn share one user turn, matched by id.
        let results = &body["contents"][2];
        assert_eq!(results["role"], "user");
        assert_eq!(
            results["parts"][0]["functionResponse"],
            json!({ "id": "fc-1", "name": "run_select_query", "response": { "result": "| one |" } })
        );
        assert_eq!(
            results["parts"][1]["functionResponse"]["response"],
            json!({ "error": "refused: user declined approval" })
        );
    }

    #[test]
    fn a_call_without_an_id_gets_a_local_one_that_is_not_sent_back() {
        let reply = json!({ "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "list_providers", "args": {} } }
        ]}}]});
        let response = parse_response(&reply).unwrap();
        let id = response.tool_calls[0].id.clone();
        assert!(id.starts_with(LOCAL_ID_PREFIX));
        // A reply that arrived without a role still goes back as the model's.
        assert_eq!(response.raw.as_ref().unwrap()["role"], "model");

        let messages = vec![Message::ToolResults {
            results: vec![ToolOutcome {
                call_id: id,
                name: "list_providers".into(),
                content: "ok".into(),
                is_error: false,
            }],
        }];
        let body = build_request(&ChatRequest {
            system: "",
            messages: &messages,
            tools: &[],
        });
        assert!(
            body["contents"][0]["parts"][0]["functionResponse"]
                .get("id")
                .is_none()
        );
    }

    #[test]
    fn finish_reasons_map_to_stop_reasons() {
        let with = |finish: &str| {
            parse_response(&json!({ "candidates": [{
                "content": { "role": "model", "parts": [{ "text": "x" }] },
                "finishReason": finish
            }]}))
            .unwrap()
            .stop
        };
        assert_eq!(with("STOP"), StopReason::EndTurn);
        assert_eq!(with("MAX_TOKENS"), StopReason::MaxTokens);
        assert!(matches!(with("SAFETY"), StopReason::Refused(_)));
        assert_eq!(
            with("MALFORMED_FUNCTION_CALL"),
            StopReason::Other("MALFORMED_FUNCTION_CALL".into())
        );
    }

    #[test]
    fn a_blocked_prompt_is_a_refusal_not_a_crash() {
        let response =
            parse_response(&json!({ "promptFeedback": { "blockReason": "SAFETY" } })).unwrap();
        assert!(matches!(&response.stop, StopReason::Refused(m) if m.contains("SAFETY")));
        assert!(response.text.is_empty());
        assert_eq!(response.raw, None);
    }

    #[test]
    fn an_empty_reply_is_not_kept_for_replay() {
        let response = parse_response(&json!({ "candidates": [{
            "content": { "role": "model", "parts": [] }, "finishReason": "MAX_TOKENS"
        }]}))
        .unwrap();
        assert_eq!(response.raw, None);
        assert_eq!(response.stop, StopReason::MaxTokens);
    }

    #[tokio::test]
    async fn the_request_goes_to_the_right_place_with_the_key_in_a_header() {
        let (base, captured) = serve_once(
            200,
            json!({ "candidates": [{ "content": { "role": "model", "parts": [{ "text": "hello" }] }, "finishReason": "STOP" }] }),
        )
        .await;
        let backend = Gemini::new(
            reqwest::Client::new(),
            base,
            "models/gemini-test".into(),
            "key-123".into(),
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
        assert_eq!(request.path, "/v1beta/models/gemini-test:generateContent");
        assert_eq!(request.header("x-goog-api-key"), Some("key-123"));
        // The key is never in the URL.
        assert!(!request.path.contains("key-123"));
        assert_eq!(request.body["contents"][0]["parts"][0]["text"], "hi");
    }

    #[tokio::test]
    async fn a_rejected_key_is_reported_as_an_auth_problem() {
        let (base, _captured) = serve_once(
            400,
            json!({ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT" } }),
        )
        .await;
        let backend = Gemini::new(reqwest::Client::new(), base, "m".into(), "bad".into());
        let messages = vec![Message::User { text: "hi".into() }];
        let err = backend
            .complete(ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            })
            .await
            .unwrap_err();
        assert!(
            matches!(&err, InferenceError::Auth(m) if m.contains("API key not valid")),
            "{err:?}"
        );
        // The error text does not repeat the key.
        assert!(!err.to_string().contains("bad\""));
    }

    #[tokio::test]
    async fn rate_limiting_is_reported_as_such() {
        let (base, _captured) = serve_once(
            429,
            json!({ "error": { "code": 429, "message": "Quota exceeded", "status": "RESOURCE_EXHAUSTED" } }),
        )
        .await;
        let backend = Gemini::new(reqwest::Client::new(), base, "m".into(), "k".into());
        let messages = vec![Message::User { text: "hi".into() }];
        let err = backend
            .complete(ChatRequest {
                system: "",
                messages: &messages,
                tools: &[],
            })
            .await
            .unwrap_err();
        assert!(matches!(&err, InferenceError::RateLimited(m) if m.contains("RESOURCE_EXHAUSTED")));
    }
}
