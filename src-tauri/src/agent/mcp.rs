//! The MCP client for the engine's agent channel.
//!
//! Only the agent runtime uses this. The connection supplies the byte
//! streams, so this module does not know or care that they belong to a child
//! process. What the server does on this channel is recorded in
//! `docs/spike-mcp.md`.

use std::any::Any;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientConfig, ElicitRequestParams, ElicitResult,
    ElicitationAction, ElicitationCapability, FormElicitationCapability, Implementation,
    ProtocolVersion,
};
use rmcp::service::{RequestContext, RoleClient, RunningService};
use rmcp::{ClientHandler, ErrorData, ServiceExt};
use serde_json::{Map, Value};

use super::approvals::{ApprovalDecision, Approvals};
use super::backend::ToolSpec;
use crate::connection::{AgentChannel, LogBuffer};
use crate::error::{HostError, HostResult};
use crate::util::truncate;

/// The marker on a line the engine writes to stderr with what a provider
/// answered. It is shown to the operator beside the tool result and goes
/// nowhere else.
///
/// The engine's MCP server deals with provider errors itself. A call that
/// fails comes back as a tool error with the status and whether a retry can
/// help. A lookup that finds nothing comes back as an empty result, because
/// "not found" is a valid answer, and what the provider said is left on
/// stderr. That last line is what this picks up. It is a display of the
/// engine's own output, not a judgement: nothing here decides that a call
/// failed, and nothing is added to what the model receives.
const UPSTREAM_FAILURE_MARKER: &str = "http response status code:";
const MAX_NOTE_CHARS: usize = 400;
const MAX_NOTES: usize = 5;

/// The client half of the handshake and of the approval flow.
struct Handler {
    approvals: Arc<Approvals>,
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        // Without the elicitation capability the server refuses every gated
        // tool, since it would have nobody to ask.
        let mut elicitation = ElicitationCapability::default();
        elicitation.form = Some(FormElicitationCapability::default());
        let mut capabilities = ClientCapabilities::default();
        capabilities.elicitation = Some(elicitation);

        ClientConfig::new(
            capabilities,
            Implementation::new("stackql-workbench", env!("CARGO_PKG_VERSION")),
        )
        // The newest revision with an initialize handshake. On it the server
        // sends the approval prompt itself, in the middle of the tool call.
        .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE)
    }

    /// The server asks for approval. The operator answers. Nothing here
    /// decides on the operator's behalf.
    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let message = match request {
            ElicitRequestParams::FormElicitationParams { message, .. } => message,
            // The engine does not send any other kind. One that cannot be
            // shown as an approval card is declined.
            _ => return Ok(ElicitResult::new(ElicitationAction::Decline)),
        };
        Ok(match self.approvals.ask(message).await {
            // The engine's approval form has no fields to fill in.
            ApprovalDecision::Accept => {
                ElicitResult::new(ElicitationAction::Accept).with_content(Value::Object(Map::new()))
            }
            ApprovalDecision::Decline => ElicitResult::new(ElicitationAction::Decline),
            ApprovalDecision::Cancel => ElicitResult::new(ElicitationAction::Cancel),
        })
    }
}

/// Tells whether a tool call had the server to itself.
///
/// What a provider answered is read from the server's stderr, which has no
/// way to say which call a line belongs to. When calls overlap, a line
/// cannot be tied to one of them, so it is shown for none.
#[derive(Default)]
struct Overlap {
    in_flight: AtomicUsize,
    /// More than one call has been in flight since the server was last idle.
    crowded: AtomicBool,
}

impl Overlap {
    fn enter(&self) -> Flight<'_> {
        if self.in_flight.fetch_add(1, Ordering::SeqCst) > 0 {
            self.crowded.store(true, Ordering::SeqCst);
        }
        Flight { overlap: self }
    }
}

/// One call in flight. Dropping it ends the call, however it ended, so a
/// call that is abandoned half way is not counted for ever.
struct Flight<'a> {
    overlap: &'a Overlap,
}

impl Flight<'_> {
    /// True when no other call has been in flight alongside this one.
    fn alone(&self) -> bool {
        !self.overlap.crowded.load(Ordering::SeqCst)
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        if self.overlap.in_flight.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.overlap.crowded.store(false, Ordering::SeqCst);
        }
    }
}

/// What a tool call produced.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    /// The server's rendering for the model.
    pub text: String,
    /// The typed payload. Row results are `{ "rows": [ ... ] }`.
    pub structured: Option<Value>,
    pub is_error: bool,
    /// What a provider answered, as the engine wrote it to stderr while the
    /// tool ran. For the operator only. Empty when calls overlapped.
    pub engine_notes: Vec<String>,
}

pub struct McpSession {
    service: RunningService<RoleClient, Handler>,
    tools: Vec<ToolSpec>,
    instructions: String,
    protocol_version: String,
    diagnostics: LogBuffer,
    overlap: Overlap,
    /// Keeps the channel open for as long as the session lives.
    _keepalive: Box<dyn Any + Send + Sync>,
}

impl McpSession {
    /// Runs the handshake over the channel and reads the tool list.
    pub async fn connect(channel: AgentChannel, approvals: Arc<Approvals>) -> HostResult<Self> {
        let AgentChannel {
            reader,
            writer,
            diagnostics,
            keepalive,
        } = channel;

        let service = Handler { approvals }
            .serve((reader, writer))
            .await
            .map_err(|err| {
                let tail = diagnostics.tail(8).join("\n");
                HostError::Agent(format!(
                    "Could not start a session with the engine's MCP server: {err}\n{tail}"
                ))
            })?;

        let info = service.peer_info();
        let instructions = info
            .as_ref()
            .and_then(|i| i.instructions.clone())
            .unwrap_or_default();
        let protocol_version = info
            .as_ref()
            .map(|i| i.protocol_version.to_string())
            .unwrap_or_default();

        let tools = service
            .list_all_tools()
            .await
            .map_err(|err| HostError::Agent(format!("Could not list the engine's tools: {err}")))?
            .into_iter()
            .map(|tool| ToolSpec {
                name: tool.name.to_string(),
                description: tool.description.map(|d| d.to_string()).unwrap_or_default(),
                input_schema: Value::Object((*tool.input_schema).clone()),
                destructive: tool.annotations.as_ref().and_then(|a| a.destructive_hint),
            })
            .collect();

        Ok(Self {
            service,
            tools,
            instructions,
            protocol_version,
            diagnostics,
            overlap: Overlap::default(),
            _keepalive: keepalive,
        })
    }

    pub fn tools(&self) -> &[ToolSpec] {
        &self.tools
    }

    /// Guidance the server wrote for the model.
    pub fn instructions(&self) -> &str {
        &self.instructions
    }

    /// The protocol revision the two sides settled on.
    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn is_closed(&self) -> bool {
        self.service.is_closed()
    }

    /// Calls a tool. A failure the server reports is a result with
    /// `is_error` set, which goes back to the model. `Err` means the session
    /// itself is no longer usable.
    ///
    /// Calls may overlap. The server runs them at the same time.
    pub async fn call(&self, name: &str, arguments: Map<String, Value>) -> HostResult<ToolResult> {
        let flight = self.overlap.enter();
        let mark = self.diagnostics.mark();
        let params = CallToolRequestParams::new(name.to_string()).with_arguments(arguments);
        let outcome = self.service.call_tool(params).await;
        let engine_notes = if flight.alone() {
            upstream_notes(&self.diagnostics.since(mark))
        } else {
            Vec::new()
        };

        match outcome {
            Ok(result) => {
                let text = result
                    .content
                    .iter()
                    .filter_map(|block| block.as_text().map(|t| t.text.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(ToolResult {
                    text,
                    structured: result.structured_content,
                    is_error: result.is_error.unwrap_or(false),
                    engine_notes,
                })
            }
            Err(err) if self.service.is_closed() => Err(HostError::Agent(format!(
                "The engine's MCP server stopped: {err}\n{}",
                self.diagnostics.tail(8).join("\n")
            ))),
            // For example an unknown tool. The model can recover from that.
            Err(err) => Ok(ToolResult {
                text: format!("The tool call failed: {err}"),
                structured: None,
                is_error: true,
                engine_notes,
            }),
        }
    }

    /// Ends the session. The server exits when its input closes.
    pub async fn close(self) {
        let _ = self.service.cancel().await;
    }
}

/// Picks the lines that report what a provider answered, one short note
/// per line. The response body that follows the status is cut, since it
/// can be a whole web page.
pub fn upstream_notes(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter(|line| line.contains(UPSTREAM_FAILURE_MARKER))
        .take(MAX_NOTES)
        .map(|line| truncate(line.trim(), MAX_NOTE_CHARS))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_is_alone_only_when_nothing_else_ran_beside_it() {
        let overlap = Overlap::default();

        let first = overlap.enter();
        assert!(first.alone());
        drop(first);

        // Two at once: neither had the server to itself, whichever ends first.
        let a = overlap.enter();
        let b = overlap.enter();
        assert!(!a.alone());
        assert!(!b.alone());
        drop(b);
        assert!(!a.alone(), "it overlapped with one that has since ended");

        // One that starts while the crowd is thinning still overlapped.
        let c = overlap.enter();
        drop(a);
        assert!(!c.alone());
        drop(c);

        // Idle again, so the next call starts clean.
        let after = overlap.enter();
        assert!(after.alone());
    }

    #[test]
    fn a_call_abandoned_half_way_is_not_counted_for_ever() {
        let overlap = Overlap::default();
        {
            // Dropped without finishing, as when the operator stops a turn.
            let _abandoned = overlap.enter();
        }
        assert!(overlap.enter().alone());
    }

    #[test]
    fn upstream_failures_are_picked_out_of_engine_output() {
        let lines = vec![
            "sink file: C:\\somewhere\\audit.log".to_string(),
            "http response status code: 404, response body: <!DOCTYPE html>".to_string(),
            "<html>".to_string(),
            "  <head>".to_string(),
            "http response status code: 401, response body: {\"message\":\"Requires authentication\"}"
                .to_string(),
        ];
        let notes = upstream_notes(&lines);
        assert_eq!(notes.len(), 2);
        assert!(notes[0].starts_with("http response status code: 404"));
        assert!(notes[1].contains("401"));
    }

    #[test]
    fn a_long_body_is_cut_and_the_count_is_capped() {
        let long = format!(
            "http response status code: 500, response body: {}",
            "x".repeat(5000)
        );
        let lines: Vec<String> = (0..20).map(|_| long.clone()).collect();
        let notes = upstream_notes(&lines);
        assert_eq!(notes.len(), MAX_NOTES);
        assert!(notes[0].chars().count() <= MAX_NOTE_CHARS + 3);
    }

    #[test]
    fn ordinary_output_produces_no_notes() {
        let lines = vec!["[stackql mcp] starting".to_string(), String::new()];
        assert!(upstream_notes(&lines).is_empty());
    }
}
