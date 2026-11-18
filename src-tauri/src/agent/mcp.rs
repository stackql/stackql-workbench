//! The MCP client for the engine's agent channel.
//!
//! Only the agent runtime uses this. The connection supplies the byte
//! streams, so this module does not know or care that they belong to a child
//! process. What the server does on this channel is recorded in
//! `docs/spike-mcp.md`.

use std::any::Any;
use std::sync::Arc;

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

/// What a tool call produced.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    /// The server's rendering for the model.
    pub text: String,
    /// The typed payload. Row results are `{ "rows": [ ... ] }`.
    pub structured: Option<Value>,
    pub is_error: bool,
    /// Upstream failures the engine reported on stderr while the tool ran.
    pub engine_notes: Vec<String>,
}

pub struct McpSession {
    service: RunningService<RoleClient, Handler>,
    tools: Vec<ToolSpec>,
    instructions: String,
    protocol_version: String,
    diagnostics: LogBuffer,
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
            })
            .collect();

        Ok(Self {
            service,
            tools,
            instructions,
            protocol_version,
            diagnostics,
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
    pub async fn call(&self, name: &str, arguments: Map<String, Value>) -> HostResult<ToolResult> {
        let mark = self.diagnostics.mark();
        let params = CallToolRequestParams::new(name.to_string()).with_arguments(arguments);
        let outcome = self.service.call_tool(params).await;
        let engine_notes = upstream_notes(&self.diagnostics.since(mark));

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
