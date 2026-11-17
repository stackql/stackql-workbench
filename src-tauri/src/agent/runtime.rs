//! The agent loop: conversation, model, tools, approvals.
//!
//! The host runs the loop and owns the MCP client. A turn goes: send the
//! conversation to the model, run the tools it asks for through the engine's
//! MCP server, send the results back, and repeat until the model answers
//! without asking for a tool.
//!
//! Safety is the engine's job. The loop passes the workspace safety mode to
//! the MCP server and relays its approval prompts to the operator. It makes
//! no judgement of its own about any statement.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Notify;

use super::approvals::{ApprovalRequest, Approvals};
use super::backend::{
    ChatRequest, InferenceBackend, Message, StopReason, ToolCall, ToolOutcome, Usage,
};
use super::mcp::{McpSession, ToolResult};
use crate::connection::{Connection, SafetyMode};
use crate::error::{HostError, HostResult};
use crate::query::result::Row;
use crate::util::{lock, truncate};

/// A turn that runs this many model calls is stopped. It is far more than a
/// real task needs and guards against a model that never settles.
const MAX_STEPS: usize = 40;
/// Tool output beyond this is cut before it goes to the model.
const MAX_MODEL_CHARS: usize = 60_000;
/// Tool text beyond this is cut before it goes to the webview. The grid
/// shows the rows, so the text is only a preview there.
const MAX_UI_TEXT_CHARS: usize = 6_000;
/// Rows beyond this are not sent to the webview for one tool result.
const MAX_UI_ROWS: usize = 5_000;

const PREAMBLE: &str = "You are the assistant inside StackQL Workbench, a desktop tool for querying \
cloud and SaaS providers with SQL through a local StackQL engine. You work through the tools \
provided, which run against that engine.\n\n\
How to work here:\n\
- The operator sees every statement you run, as SQL, and sees row results in a grid. Summarise \
what you found instead of repeating large tables.\n\
- When you run or propose a statement, show the SQL.\n\
- Statements that change something may need the operator's approval. The tool asks for it. If the \
operator declines, do not try again or look for another way to make the same change. Say what \
you would have done and stop.\n\
- An empty result can mean a provider API call failed, not that nothing exists. When a tool \
result carries a note from the engine about a failed call, tell the operator about it.\n\
- You never see credentials and you do not need them. If a provider reports missing credentials, \
tell the operator which provider needs them.\n\n\
The engine's own guidance follows.\n\n";

/// A row result, in the same shape the editor's grid uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
    /// Rows the tool returned, which can be more than were sent on.
    pub total_rows: usize,
    pub truncated: bool,
}

/// What the webview is told while a turn runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum AgentEvent {
    /// A session with the engine's MCP server was opened for this turn.
    SessionStarted {
        mode: SafetyMode,
        protocol_version: String,
        tools: usize,
    },
    AssistantText {
        text: String,
    },
    ToolCallStarted {
        id: String,
        tool: String,
        arguments: Value,
        /// The statement, when the tool takes one. Shown as SQL.
        sql: Option<String>,
    },
    /// The engine wants the operator's approval before it runs something.
    ApprovalRequested {
        request: ApprovalRequest,
    },
    ToolCallFinished {
        id: String,
        is_error: bool,
        text: String,
        table: Option<Table>,
        /// Provider API failures the engine reported while the tool ran.
        engine_notes: Vec<String>,
        elapsed_ms: u64,
    },
    Notice {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    /// Calls made to the model.
    pub steps: usize,
    pub tool_calls: usize,
    /// The operator stopped the turn.
    pub stopped: bool,
    pub stop: StopReason,
    pub usage: Usage,
}

pub type Emit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

#[derive(Default)]
struct State {
    session: Option<(SafetyMode, McpSession)>,
    messages: Vec<Message>,
}

pub struct AgentRuntime {
    connection: Arc<dyn Connection>,
    approvals: Arc<Approvals>,
    state: tokio::sync::Mutex<State>,
    stop: Mutex<Option<Arc<Notify>>>,
}

/// Undoes the per-turn wiring when a turn ends, however it ends.
struct TurnGuard<'a> {
    runtime: &'a AgentRuntime,
}

impl Drop for TurnGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.runtime.stop) = None;
        self.runtime.approvals.set_listener(None);
        // A prompt nobody can answer any more must not stay open.
        self.runtime.approvals.cancel_all();
    }
}

impl AgentRuntime {
    pub fn new(connection: Arc<dyn Connection>) -> Self {
        Self {
            connection,
            approvals: Arc::new(Approvals::default()),
            state: tokio::sync::Mutex::new(State::default()),
            stop: Mutex::new(None),
        }
    }

    pub fn approvals(&self) -> &Arc<Approvals> {
        &self.approvals
    }

    /// Asks the running turn to stop. Returns false if no turn is running.
    ///
    /// An open approval prompt is answered with cancel. A statement the
    /// engine has already started is not interrupted by this.
    pub fn stop(&self) -> bool {
        let stop = lock(&self.stop).clone();
        match stop {
            Some(stop) => {
                stop.notify_one();
                self.approvals.cancel_all();
                true
            }
            None => false,
        }
    }

    /// Forgets the conversation and closes the engine session.
    pub async fn reset(&self) {
        self.stop();
        let mut state = self.state.lock().await;
        state.messages.clear();
        if let Some((_, session)) = state.session.take() {
            session.close().await;
        }
    }

    /// Runs one turn: the operator's message, then model and tool steps
    /// until the model answers.
    pub async fn send(
        &self,
        backend: Arc<dyn InferenceBackend>,
        mode: SafetyMode,
        text: String,
        emit: Emit,
    ) -> HostResult<TurnSummary> {
        let mut state = self.state.try_lock().map_err(|_| {
            HostError::Agent("The assistant is still working on the previous message.".to_string())
        })?;

        let stop = Arc::new(Notify::new());
        *lock(&self.stop) = Some(stop.clone());
        let listener = emit.clone();
        self.approvals.set_listener(Some(Box::new(move |request| {
            listener(AgentEvent::ApprovalRequested { request });
        })));
        let _guard = TurnGuard { runtime: self };

        let State { session, messages } = &mut *state;

        // A session is tied to the safety mode it was started with.
        let reusable = session
            .as_ref()
            .is_some_and(|(current, s)| *current == mode && !s.is_closed());
        if !reusable {
            if let Some((_, old)) = session.take() {
                old.close().await;
            }
            let channel = self.connection.open_agent_channel(mode).await?;
            let fresh = McpSession::connect(channel, self.approvals.clone()).await?;
            emit(AgentEvent::SessionStarted {
                mode,
                protocol_version: fresh.protocol_version().to_string(),
                tools: fresh.tools().len(),
            });
            *session = Some((mode, fresh));
        }
        let Some((_, mcp)) = session.as_ref() else {
            return Err(HostError::Agent("No engine session.".to_string()));
        };

        let system = format!("{PREAMBLE}{}", mcp.instructions());
        let turn_start = messages.len();
        messages.push(Message::User { text });

        let mut summary = TurnSummary {
            steps: 0,
            tool_calls: 0,
            stopped: false,
            stop: StopReason::EndTurn,
            usage: Usage::default(),
        };

        loop {
            if summary.steps >= MAX_STEPS {
                emit(AgentEvent::Notice {
                    message: format!(
                        "Stopped after {MAX_STEPS} steps without a final answer. Ask again to continue."
                    ),
                });
                summary.stop = StopReason::Other("step limit".to_string());
                break;
            }

            let request = ChatRequest {
                system: &system,
                messages,
                tools: mcp.tools(),
            };
            let reply = tokio::select! {
                reply = backend.complete(request) => Some(reply),
                () = stop.notified() => None,
            };
            let Some(reply) = reply else {
                summary.stopped = true;
                messages.push(stopped_message());
                break;
            };
            let reply = match reply {
                Ok(reply) => reply,
                Err(err) => {
                    // Nothing came back for this message, so take it out
                    // again. The operator can send it once more.
                    if summary.steps == 0 {
                        messages.truncate(turn_start);
                    }
                    return Err(HostError::Agent(err.to_string()));
                }
            };

            summary.steps += 1;
            summary.usage = add_usage(summary.usage, reply.usage);
            summary.stop = reply.stop.clone();
            if !reply.text.trim().is_empty() {
                emit(AgentEvent::AssistantText {
                    text: reply.text.clone(),
                });
            }
            let calls = reply.tool_calls.clone();
            messages.push(reply.into_message());
            if calls.is_empty() {
                break;
            }

            let mut outcomes = Vec::with_capacity(calls.len());
            for call in &calls {
                if summary.stopped {
                    // The provider needs a result for every call it made.
                    outcomes.push(ToolOutcome {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        content: "The operator stopped this turn before this tool ran.".to_string(),
                        is_error: true,
                    });
                    continue;
                }
                summary.tool_calls += 1;
                match self.run_tool(mcp, call, &stop, &emit).await? {
                    Some(outcome) => outcomes.push(outcome),
                    None => {
                        summary.stopped = true;
                        outcomes.push(ToolOutcome {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            content: "The operator stopped this turn before this tool finished. \
                                      It may still have taken effect."
                                .to_string(),
                            is_error: true,
                        });
                    }
                }
            }
            messages.push(Message::ToolResults { results: outcomes });
            if summary.stopped {
                messages.push(stopped_message());
                break;
            }
        }

        Ok(summary)
    }

    /// Runs one tool call. `None` means the operator stopped the turn while
    /// it was running.
    async fn run_tool(
        &self,
        mcp: &McpSession,
        call: &ToolCall,
        stop: &Notify,
        emit: &Emit,
    ) -> HostResult<Option<ToolOutcome>> {
        let sql = call
            .arguments
            .get("sql")
            .and_then(Value::as_str)
            .map(str::to_string);
        emit(AgentEvent::ToolCallStarted {
            id: call.id.clone(),
            tool: call.name.clone(),
            arguments: Value::Object(call.arguments.clone()),
            sql,
        });

        let started = Instant::now();
        let result = tokio::select! {
            result = mcp.call(&call.name, call.arguments.clone()) => Some(result),
            () = stop.notified() => None,
        };
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let Some(result) = result else {
            emit(AgentEvent::ToolCallFinished {
                id: call.id.clone(),
                is_error: true,
                text: "Stopped. The engine cannot cancel a statement, so it may still complete."
                    .to_string(),
                table: None,
                engine_notes: Vec::new(),
                elapsed_ms,
            });
            return Ok(None);
        };
        let result = result?;

        emit(AgentEvent::ToolCallFinished {
            id: call.id.clone(),
            is_error: result.is_error,
            text: truncate(&result.text, MAX_UI_TEXT_CHARS),
            table: result.structured.as_ref().and_then(table_from_structured),
            engine_notes: result.engine_notes.clone(),
            elapsed_ms,
        });

        Ok(Some(ToolOutcome {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: content_for_model(&result),
            is_error: result.is_error,
        }))
    }
}

fn stopped_message() -> Message {
    Message::Assistant {
        text: "[The operator stopped this turn.]".to_string(),
        tool_calls: Vec::new(),
        raw: None,
    }
}

fn add_usage(total: Usage, step: Usage) -> Usage {
    let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };
    Usage {
        input_tokens: add(total.input_tokens, step.input_tokens),
        output_tokens: add(total.output_tokens, step.output_tokens),
    }
}

/// The tool result as the model receives it: the server's rendering, cut if
/// it is very long, plus a note when the engine reported a failed provider
/// call. Without the note the model would read a failed call as "no data".
pub fn content_for_model(result: &ToolResult) -> String {
    let mut text = if result.text.trim().is_empty() {
        result
            .structured
            .as_ref()
            .map_or_else(|| "(no output)".to_string(), Value::to_string)
    } else {
        result.text.clone()
    };
    let length = text.chars().count();
    if length > MAX_MODEL_CHARS {
        text = text.chars().take(MAX_MODEL_CHARS).collect();
        text.push_str(&format!(
            "\n\n[Output cut: {} more characters. Narrow the query or select fewer columns.]",
            length - MAX_MODEL_CHARS
        ));
    }
    if !result.engine_notes.is_empty() {
        text.push_str(
            "\n\nNote from the engine: a provider API call failed while this ran, so an empty \
             or short result may not mean there is no data.",
        );
        for note in &result.engine_notes {
            text.push_str("\n- ");
            text.push_str(note);
        }
    }
    text
}

/// Turns `{ "rows": [ { column: value } ] }` into a table for the grid.
/// Returns `None` for payloads that are not row results.
pub fn table_from_structured(value: &Value) -> Option<Table> {
    let rows = value.get("rows")?.as_array()?;
    let mut columns: Vec<String> = Vec::new();
    for row in rows {
        for key in row.as_object()?.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    let cells = rows
        .iter()
        .take(MAX_UI_ROWS)
        .map(|row| {
            columns
                .iter()
                .map(|column| match row.get(column) {
                    None | Some(Value::Null) => None,
                    Some(Value::String(text)) => Some(text.clone()),
                    Some(other) => Some(other.to_string()),
                })
                .collect()
        })
        .collect();
    Some(Table {
        columns,
        rows: cells,
        total_rows: rows.len(),
        truncated: rows.len() > MAX_UI_ROWS,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn result(text: &str, structured: Option<Value>, notes: &[&str]) -> ToolResult {
        ToolResult {
            text: text.to_string(),
            structured,
            is_error: false,
            engine_notes: notes.iter().map(|n| (*n).to_string()).collect(),
        }
    }

    #[test]
    fn row_results_become_a_table() {
        let table = table_from_structured(&json!({
            "rows": [
                { "name": "wget", "license": "GPL-3.0-or-later", "revision": 2 },
                { "name": "jq", "license": null, "deprecated": false }
            ]
        }))
        .unwrap();
        assert_eq!(
            table.columns,
            vec!["license", "name", "revision", "deprecated"]
        );
        assert_eq!(
            table.rows[0],
            vec![
                Some("GPL-3.0-or-later".to_string()),
                Some("wget".to_string()),
                Some("2".to_string()),
                None
            ]
        );
        assert_eq!(
            table.rows[1],
            vec![
                None,
                Some("jq".to_string()),
                None,
                Some("false".to_string())
            ]
        );
        assert_eq!(table.total_rows, 2);
        assert!(!table.truncated);
    }

    #[test]
    fn nested_values_are_kept_as_json_text() {
        let table = table_from_structured(&json!({ "rows": [{ "tags": ["a", "b"] }] })).unwrap();
        assert_eq!(table.rows[0], vec![Some("[\"a\",\"b\"]".to_string())]);
    }

    #[test]
    fn an_empty_row_result_is_an_empty_table() {
        let table = table_from_structured(&json!({ "rows": [] })).unwrap();
        assert!(table.columns.is_empty());
        assert!(table.rows.is_empty());
    }

    #[test]
    fn other_payloads_are_not_tables() {
        assert_eq!(table_from_structured(&json!({ "valid": true })), None);
        assert_eq!(table_from_structured(&json!({ "messages": ["ok"] })), None);
        assert_eq!(table_from_structured(&json!({ "rows": "nope" })), None);
        assert_eq!(table_from_structured(&json!({ "rows": [1, 2] })), None);
    }

    #[test]
    fn large_row_results_are_capped_for_the_webview() {
        let rows: Vec<Value> = (0..MAX_UI_ROWS + 10).map(|i| json!({ "n": i })).collect();
        let table = table_from_structured(&json!({ "rows": rows })).unwrap();
        assert_eq!(table.rows.len(), MAX_UI_ROWS);
        assert_eq!(table.total_rows, MAX_UI_ROWS + 10);
        assert!(table.truncated);
    }

    #[test]
    fn the_model_gets_the_server_rendering() {
        let text = content_for_model(&result("| name |\n|---|\n| wget |", None, &[]));
        assert_eq!(text, "| name |\n|---|\n| wget |");
    }

    #[test]
    fn a_failed_provider_call_is_pointed_out_to_the_model() {
        let text = content_for_model(&result(
            "**no results**",
            Some(json!({ "rows": [] })),
            &["http response status code: 404, response body: Not Found"],
        ));
        assert!(text.starts_with("**no results**"));
        assert!(text.contains("a provider API call failed"));
        assert!(text.contains("http response status code: 404"));
    }

    #[test]
    fn very_long_output_is_cut_for_the_model() {
        let long = "x".repeat(MAX_MODEL_CHARS + 500);
        let text = content_for_model(&result(&long, None, &[]));
        assert!(text.contains("[Output cut: 500 more characters."));
        assert!(text.chars().count() < MAX_MODEL_CHARS + 200);
    }

    #[test]
    fn a_result_with_no_text_falls_back_to_the_payload() {
        let text = content_for_model(&result("", Some(json!({ "valid": true })), &[]));
        assert_eq!(text, "{\"valid\":true}");
        assert_eq!(content_for_model(&result("  ", None, &[])), "(no output)");
    }

    #[test]
    fn usage_adds_up_across_steps() {
        let total = add_usage(
            Usage {
                input_tokens: Some(10),
                output_tokens: None,
            },
            Usage {
                input_tokens: Some(5),
                output_tokens: Some(7),
            },
        );
        assert_eq!(total.input_tokens, Some(15));
        assert_eq!(total.output_tokens, Some(7));
        assert_eq!(
            add_usage(Usage::default(), Usage::default()),
            Usage::default()
        );
    }

    #[test]
    fn events_serialise_in_the_shape_the_webview_expects() {
        let event = AgentEvent::ToolCallStarted {
            id: "c1".into(),
            tool: "run_select_query".into(),
            arguments: json!({ "sql": "SELECT 1" }),
            sql: Some("SELECT 1".into()),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "event": "toolCallStarted",
                "data": {
                    "id": "c1",
                    "tool": "run_select_query",
                    "arguments": { "sql": "SELECT 1" },
                    "sql": "SELECT 1"
                }
            })
        );
        let event = AgentEvent::SessionStarted {
            mode: SafetyMode::DeleteSafe,
            protocol_version: "2025-11-25".into(),
            tools: 15,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "event": "sessionStarted",
                "data": { "mode": "delete_safe", "protocolVersion": "2025-11-25", "tools": 15 }
            })
        );
    }
}
