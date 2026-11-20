//! A delegated agent session: an agent the operator installed runs the
//! model and the tools, and this side sends prompts and shows what happens.
//!
//! The agent is its own MCP client and starts the engine's MCP server
//! itself, in the workspace safety mode. The engine still decides what may
//! run. Nothing here judges a statement.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use super::acp::{
    AUTH_REQUIRED, AcpClient, AcpError, Incoming, METHOD_NOT_FOUND, PROTOCOL_VERSION,
};
use super::backend::{StopReason, Usage};
use super::guidance::PRESENTATION;
use super::runtime::{AgentEvent, Emit, MAX_UI_TEXT_CHARS, TurnSummary, table_from_structured};
use crate::connection::AgentChannel;
use crate::error::{HostError, HostResult};
use crate::util::truncate;

/// How long the agent gets to answer the handshake and open a session.
const SETUP_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the agent gets to wind a turn down after it is told to stop.
const CANCEL_GRACE: Duration = Duration::from_secs(15);
const LOG_TAIL_LINES: usize = 12;
/// A turn that starts more subagents than this is stopped. Each one is a
/// model of its own at work, and a subagent that is stuck starts more.
pub const MAX_SUBAGENTS: usize = 12;

/// Sent ahead of the first message of a session. The agent has its own
/// system prompt, which this app cannot set, so the context goes here.
const PRIMER: &str = "Context for this conversation: you are working inside StackQL Workbench, a \
desktop tool for querying cloud and SaaS providers with SQL through a local StackQL engine. Work \
only through the stackql tools.\n\
- If the engine refuses a statement because it needs approval, do not look for another way to \
make the same change. Show the SQL and say the operator can run it themselves in the query \
editor, or change the safety mode. Nothing else can approve it.\n\
- You never see credentials and you do not need them. If a provider reports missing \
credentials, say which provider needs them.";

/// Sent after the primer when the agent may use subagents. Whether to split
/// work, and how, is the client's to say: the engine cannot start agents.
const SUBAGENT_PRIMER: &str = "Subagents: when a request needs several independent lookups, for \
example the same question asked of different providers, services or resources, you may split \
the work across subagents with the task tool, one for each independent part, started at the \
same time.\n\
- Give each subagent all it needs in its prompt: the provider, what to find out, and to answer \
with the SQL it ran and a short result. It does not see this conversation.\n\
- Do not use a subagent for one query, or for a join or a union, which is one statement.\n\
- Do not use a subagent for anything that changes something. Make changes yourself, one at a \
time.\n\
- Start no more than four at once, and tell each one not to start subagents of its own.\n\
- When they are done, put their findings together in one answer.";

/// What differs from one agent to the next, apart from how it is started.
#[derive(Debug, Clone, Copy)]
pub struct Profile {
    /// The agent's name, for messages to the operator.
    pub name: &'static str,
    /// What the operator does when the agent is not signed in.
    pub sign_in_hint: &'static str,
    /// What the agent puts in front of the engine's tool names.
    pub tool_prefix: &'static str,
    /// The key under which the agent keeps its own additions to protocol
    /// messages, such as which subagent a tool call belongs to.
    pub vendor_key: &'static str,
    /// Events of the agent's own to ask for at the handshake. Empty when
    /// there are none.
    pub session_events: &'static [&'static str],
    /// How to start a subagent with this agent so that it can do the work:
    /// which kind and which mode. Added to the guidance on subagents. Empty
    /// when the agent needs no such advice.
    pub subagent_hint: &'static str,
}

/// A model the agent offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    pub description: String,
    /// What a request to this model costs against the operator's plan, as
    /// the agent words it, for example "1x".
    pub usage: Option<String>,
}

pub struct DelegateSession {
    client: Arc<AcpClient>,
    incoming: mpsc::UnboundedReceiver<Incoming>,
    profile: Profile,
    session_id: String,
    agent_version: String,
    models: Vec<ModelOption>,
    current_model: Option<String>,
    /// The context block has been sent.
    primed: bool,
    /// The agent was started with its subagent tool.
    subagents: bool,
    /// A turn was abandoned mid-way, so the session cannot be used again.
    broken: bool,
}

impl DelegateSession {
    /// Does the handshake and opens a session in `cwd`. `model` is set when
    /// the operator chose one. Otherwise the agent's own choice stands.
    pub async fn open(
        channel: AgentChannel,
        profile: Profile,
        cwd: &Path,
        model: Option<&str>,
        subagents: bool,
    ) -> HostResult<Self> {
        let (client, incoming) = AcpClient::connect(channel);
        let name = profile.name;

        let setup = |err: AcpError, client: &AcpClient| match err {
            AcpError::Rpc { code, .. } if code == AUTH_REQUIRED => {
                HostError::Agent(format!("{name} is not signed in. {}", profile.sign_in_hint))
            }
            AcpError::Rpc { message, .. } => {
                HostError::Agent(format!("{name} could not start a session: {message}"))
            }
            AcpError::Closed => HostError::Agent(with_log(
                format!("{name} stopped while starting."),
                &client.diagnostics_tail(LOG_TAIL_LINES),
            )),
        };
        let timed_out = |what: &str, client: &AcpClient| {
            HostError::Agent(with_log(
                format!(
                    "{name} did not {what} within {} seconds.",
                    SETUP_TIMEOUT.as_secs()
                ),
                &client.diagnostics_tail(LOG_TAIL_LINES),
            ))
        };

        // No file access and no terminal through this app. The agent gets
        // the engine's tools and nothing from the host.
        let mut capabilities = json!({
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false
        });
        if !profile.session_events.is_empty() {
            // Ask to be told when a subagent starts, so its tool calls can
            // be shown as its own and counted.
            capabilities["_meta"] =
                json!({ profile.vendor_key: { "events": profile.session_events } });
        }
        let hello = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": capabilities,
            "clientInfo": {
                "name": "stackql-workbench",
                "title": "StackQL Workbench",
                "version": env!("CARGO_PKG_VERSION")
            }
        });
        let initialised = tokio::time::timeout(SETUP_TIMEOUT, client.request("initialize", hello))
            .await
            .map_err(|_| timed_out("answer", &client))?
            .map_err(|err| setup(err, &client))?;
        let offered = initialised.get("protocolVersion").and_then(Value::as_u64);
        if offered != Some(PROTOCOL_VERSION) {
            return Err(HostError::Agent(format!(
                "{name} speaks a version of the agent protocol this app does not ({}).",
                offered.map_or_else(|| "none".to_string(), |v| v.to_string())
            )));
        }
        let agent_version = initialised
            .pointer("/agentInfo/version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let Some(cwd) = cwd.to_str() else {
            return Err(HostError::Agent(format!(
                "The folder for {name} sessions is not valid Unicode: {}",
                cwd.display()
            )));
        };
        // The engine's MCP server is named on the agent's command line, not
        // here. See the launcher for why.
        let opened = tokio::time::timeout(
            SETUP_TIMEOUT,
            client.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })),
        )
        .await
        .map_err(|_| timed_out("open a session", &client))?
        .map_err(|err| setup(err, &client))?;
        let Some(session_id) = opened.get("sessionId").and_then(Value::as_str) else {
            return Err(HostError::Agent(format!(
                "{name} opened a session without an id."
            )));
        };
        let session_id = session_id.to_string();
        let models = parse_models(&opened);
        let mut current_model = opened
            .pointer("/models/currentModelId")
            .and_then(Value::as_str)
            .map(str::to_string);

        if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            let set = client
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": "model", "value": model }),
                )
                .await;
            match set {
                Ok(_) => current_model = Some(model.to_string()),
                Err(AcpError::Rpc { message, .. }) => {
                    return Err(HostError::Agent(format!(
                        "{name} could not use the model \"{model}\": {message}. Choose another in Settings, or clear it to use the agent's own choice."
                    )));
                }
                Err(err) => return Err(setup(err, &client)),
            }
        }

        Ok(Self {
            client,
            incoming,
            profile,
            session_id,
            agent_version,
            models,
            current_model,
            primed: false,
            subagents,
            broken: false,
        })
    }

    /// Whether the session can take another prompt.
    pub fn is_closed(&self) -> bool {
        self.broken || self.client.is_closed()
    }

    pub fn agent_version(&self) -> &str {
        &self.agent_version
    }

    pub fn models(&self) -> &[ModelOption] {
        &self.models
    }

    pub fn current_model(&self) -> Option<&str> {
        self.current_model.as_deref()
    }

    /// Runs one turn. Events go to `emit` as the agent works. `stop` asks
    /// the agent to cancel.
    pub async fn prompt(
        &mut self,
        text: &str,
        stop: &Notify,
        emit: &Emit,
    ) -> HostResult<TurnSummary> {
        let name = self.profile.name;
        let mut blocks = Vec::new();
        if !self.primed {
            // The context, then how the work is shown, which is the same
            // text the host's own loop puts in its system prompt.
            blocks.push(json!({ "type": "text", "text": format!("{PRIMER}\n\n{PRESENTATION}") }));
            if self.subagents {
                let mut guidance = SUBAGENT_PRIMER.to_string();
                if !self.profile.subagent_hint.is_empty() {
                    guidance.push('\n');
                    guidance.push_str(self.profile.subagent_hint);
                }
                blocks.push(json!({ "type": "text", "text": guidance }));
            }
        }
        blocks.push(json!({ "type": "text", "text": text }));
        self.primed = true;

        let client = self.client.clone();
        let params = json!({ "sessionId": self.session_id, "prompt": blocks });
        let request = client.request("session/prompt", params);
        tokio::pin!(request);

        let mut turn = Turn::new(self.profile, self.session_id.clone());
        let mut cancelling = false;
        let mut incoming_open = true;
        let mut deadline: Option<tokio::time::Instant> = None;

        let outcome = loop {
            let grace = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                result = &mut request => break Some(result),
                item = self.incoming.recv(), if incoming_open => match item {
                    Some(item) => {
                        if let Some(reply) = turn.handle(item, emit) {
                            reply.send(&client).await;
                        }
                        // The turn went past a limit of this app's. Stop it
                        // and say why.
                        if !cancelling && let Some(reason) = turn.abort.take() {
                            emit(AgentEvent::Notice { message: reason });
                            cancelling = true;
                            deadline = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                            let _ = client
                                .notify("session/cancel", json!({ "sessionId": self.session_id }))
                                .await;
                        }
                    }
                    None => incoming_open = false,
                },
                () = stop.notified(), if !cancelling => {
                    cancelling = true;
                    deadline = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                    let _ = client
                        .notify("session/cancel", json!({ "sessionId": self.session_id }))
                        .await;
                }
                () = grace => break None,
            }
        };

        // What the agent sent before its answer is already queued.
        while let Ok(item) = self.incoming.try_recv() {
            if let Some(reply) = turn.handle(item, emit) {
                reply.send(&client).await;
            }
        }
        turn.settle(cancelling, emit);

        let mut summary = TurnSummary {
            steps: turn.steps,
            tool_calls: turn.tool_calls,
            stopped: cancelling,
            stop: StopReason::EndTurn,
            usage: Usage::default(),
        };
        match outcome {
            Some(Ok(result)) => {
                // The agent adds its model calls up itself and reports the
                // turn. Its input count holds what was read from the cache.
                let count = |name: &str| {
                    result
                        .pointer(&format!("/usage/{name}"))
                        .and_then(Value::as_u64)
                };
                summary.usage = Usage {
                    input_tokens: count("inputTokens"),
                    output_tokens: count("outputTokens"),
                    cached_input_tokens: count("cachedReadTokens"),
                };
                match result.get("stopReason").and_then(Value::as_str) {
                    Some("cancelled") => summary.stopped = true,
                    Some("max_tokens") => summary.stop = StopReason::MaxTokens,
                    Some("refusal") => {
                        summary.stop =
                            StopReason::Refused("The model declined to answer.".to_string());
                    }
                    Some("max_turn_requests") => {
                        emit(AgentEvent::Notice {
                            message: format!(
                                "{name} reached its limit of model requests for one turn. Ask again to continue."
                            ),
                        });
                        summary.stop = StopReason::Other("request limit".to_string());
                    }
                    _ => {}
                }
                Ok(summary)
            }
            Some(Err(AcpError::Rpc { code, .. })) if code == AUTH_REQUIRED => {
                Err(HostError::Agent(format!(
                    "{name} is not signed in. {}",
                    self.profile.sign_in_hint
                )))
            }
            Some(Err(AcpError::Rpc { message, .. })) => Err(HostError::Agent(format!(
                "{name} reported an error: {message}"
            ))),
            Some(Err(AcpError::Closed)) => {
                self.broken = true;
                Err(HostError::Agent(with_log(
                    format!("{name} stopped unexpectedly."),
                    &self.client.diagnostics_tail(LOG_TAIL_LINES),
                )))
            }
            None => {
                // Told to stop and never answered. The prompt is still open
                // on its side, so this session is finished.
                self.broken = true;
                summary.stopped = true;
                Ok(summary)
            }
        }
    }
}

fn with_log(message: String, tail: &[String]) -> String {
    if tail.is_empty() {
        message
    } else {
        format!("{message}\n{}", tail.join("\n"))
    }
}

fn parse_models(opened: &Value) -> Vec<ModelOption> {
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    opened
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = text(model, "modelId");
                    (!id.is_empty()).then(|| ModelOption {
                        name: text(model, "name"),
                        description: text(model, "description"),
                        usage: model
                            .pointer("/_meta/copilotUsage")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The name a call that starts a subagent is shown under.
pub const SUBAGENT_TOOL: &str = "subagent";

/// An answer owed to the agent.
#[derive(Debug, PartialEq)]
struct Reply {
    id: Value,
    answer: Result<Value, (i64, &'static str)>,
}

impl Reply {
    async fn send(self, client: &AcpClient) {
        let _ = match self.answer {
            Ok(result) => client.respond(self.id, result).await,
            Err((code, message)) => client.respond_error(self.id, code, message).await,
        };
    }
}

struct ToolState {
    started: Instant,
    finished: bool,
}

/// What has happened in the turn that is running.
struct Turn {
    profile: Profile,
    session_id: String,
    tools: HashMap<String, ToolState>,
    order: Vec<String>,
    last_message: Option<String>,
    steps: usize,
    tool_calls: usize,
    /// The subagents seen this turn, by the agent's id for each, with the
    /// name shown to the operator.
    agents: HashMap<String, String>,
    /// Set when this app has to stop the turn, with the reason.
    abort: Option<String>,
}

impl Turn {
    fn new(profile: Profile, session_id: String) -> Self {
        Self {
            profile,
            session_id,
            tools: HashMap::new(),
            order: Vec::new(),
            last_message: None,
            steps: 0,
            tool_calls: 0,
            agents: HashMap::new(),
            abort: None,
        }
    }

    /// Notes a subagent and returns the name shown for it. More than
    /// [`MAX_SUBAGENTS`] in one turn stops the turn.
    fn subagent(&mut self, id: &str, name: Option<&str>) -> String {
        if let Some(known) = self.agents.get(id) {
            return known.clone();
        }
        let number = self.agents.len() + 1;
        let label = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map_or_else(|| format!("subagent {number}"), |n| truncate(n, 40));
        self.agents.insert(id.to_string(), label.clone());
        if self.agents.len() > MAX_SUBAGENTS && self.abort.is_none() {
            self.abort = Some(format!(
                "Stopped: {} started more than {MAX_SUBAGENTS} subagents in one turn. Ask for less at once, or turn subagents off in Settings.",
                self.profile.name
            ));
        }
        label
    }

    /// The subagent an update belongs to, if it is not the main agent's.
    fn agent_of(&mut self, update: &Value) -> Option<String> {
        let id = update
            .get("_meta")?
            .get(self.profile.vendor_key)?
            .get("agentId")?
            .as_str()?
            .to_string();
        Some(self.subagent(&id, None))
    }

    /// One of the agent's own events. Only the start of a subagent is of
    /// interest: it gives the subagent's name before its first tool call.
    fn session_event(&mut self, params: &Value) {
        if params.get("sessionId").and_then(Value::as_str) != Some(&self.session_id)
            || params.get("type").and_then(Value::as_str) != Some("subagent.started")
        {
            return;
        }
        let Some(id) = params.get("agentId").and_then(Value::as_str) else {
            return;
        };
        let name = params
            .pointer("/data/agentDisplayName")
            .and_then(Value::as_str);
        let id = id.to_string();
        self.subagent(&id, name);

        // A subagent that starts a subagent was told not to. In testing it
        // was always one that could not do its job and tried to hand it on,
        // four deep, at a cost in time and no gain. Stop at the first.
        let nested = params
            .pointer("/data/parentId")
            .is_some_and(|parent| !parent.is_null());
        if nested && self.abort.is_none() {
            self.abort = Some(format!(
                "Stopped: a {} subagent started a subagent of its own, which usually means it could not do what it was asked. Ask again in smaller steps, or turn subagents off in Settings.",
                self.profile.name
            ));
        }
    }

    /// Takes one message from the agent. Returns the answer when the
    /// message was a request.
    fn handle(&mut self, item: Incoming, emit: &Emit) -> Option<Reply> {
        match item {
            Incoming::Notification { method, params } => {
                if method == "session/update"
                    && params.get("sessionId").and_then(Value::as_str) == Some(&self.session_id)
                    && let Some(update) = params.get("update")
                {
                    self.update(update, emit);
                } else if method.strip_suffix("/sessionEvent") == Some(self.profile.vendor_key) {
                    self.session_event(&params);
                }
                None
            }
            Incoming::Request { id, method, params } => Some(match method.as_str() {
                "session/request_permission" => self.permission(id, &params, emit),
                // No capability for anything else was advertised.
                _ => Reply {
                    id,
                    answer: Err((METHOD_NOT_FOUND, "Method not found")),
                },
            }),
        }
    }

    /// The agent asks whether it may run something. The engine's tools are
    /// allowed on its command line and never ask, so this is the agent
    /// reaching for something else. The answer is no, and the operator is
    /// told. Nothing is ever approved on the operator's behalf.
    fn permission(&mut self, id: Value, params: &Value, emit: &Emit) -> Reply {
        let what = params
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .unwrap_or("something");
        emit(AgentEvent::Notice {
            message: format!(
                "{} asked for permission to run \"{}\", which is not one of the engine's tools. It was declined.",
                self.profile.name,
                truncate(what, 200)
            ),
        });
        let reject = params
            .get("options")
            .and_then(Value::as_array)
            .and_then(|options| {
                options
                    .iter()
                    .find(|o| o.get("kind").and_then(Value::as_str) == Some("reject_once"))
            })
            .and_then(|option| option.get("optionId"))
            .cloned();
        let outcome = match reject {
            Some(option) => json!({ "outcome": "selected", "optionId": option }),
            None => json!({ "outcome": "cancelled" }),
        };
        Reply {
            id,
            answer: Ok(json!({ "outcome": outcome })),
        }
    }

    fn update(&mut self, update: &Value, emit: &Emit) {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                // What a subagent writes is its report to the agent that
                // started it. It arrives whole as the result of that call,
                // so the pieces are not shown as the assistant's own words.
                if self.agent_of(update).is_some() {
                    return;
                }
                let Some(text) = update.pointer("/content/text").and_then(Value::as_str) else {
                    return;
                };
                match update.get("messageId").and_then(Value::as_str) {
                    Some(message) => {
                        if self.last_message.as_deref() != Some(message) {
                            self.last_message = Some(message.to_string());
                            self.steps += 1;
                        }
                        emit(AgentEvent::AssistantDelta {
                            id: message.to_string(),
                            text: text.to_string(),
                        });
                    }
                    // A line from the agent program itself, not the model.
                    None => {
                        let line = text.trim();
                        let line = line.strip_prefix("Info: ").unwrap_or(line);
                        // It lists the tools it turned off at every start,
                        // which is this app's doing and not news.
                        if !line.is_empty() && !line.starts_with("Disabled tools:") {
                            emit(AgentEvent::Notice {
                                message: format!("{}: {line}", self.profile.name),
                            });
                        }
                    }
                }
            }
            Some("tool_call") => {
                let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return;
                };
                if !self.tools.contains_key(id) {
                    let title = update
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let raw = update.get("rawInput").cloned().unwrap_or(Value::Null);
                    // Whose call it is: the main agent's, or a subagent's.
                    let agent = self.agent_of(update);
                    self.tools.insert(
                        id.to_string(),
                        ToolState {
                            started: Instant::now(),
                            finished: false,
                        },
                    );
                    self.order.push(id.to_string());
                    self.tool_calls += 1;
                    // The call that starts a subagent names the kind of
                    // agent. Show it as a subagent with its task, not as a
                    // tool with a page of arguments.
                    let (tool, arguments) = if raw.get("agent_type").is_some() {
                        let task = raw
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(title);
                        (SUBAGENT_TOOL.to_string(), json!({ "task": task }))
                    } else {
                        (
                            title
                                .strip_prefix(self.profile.tool_prefix)
                                .unwrap_or(title)
                                .to_string(),
                            raw,
                        )
                    };
                    emit(AgentEvent::ToolCallStarted {
                        id: id.to_string(),
                        tool,
                        sql: arguments
                            .get("sql")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        arguments,
                        agent,
                        // The agent does not say where one of its model's
                        // steps ends. A message of its own does: the calls
                        // that follow one belong together.
                        step: self.steps,
                    });
                }
                self.finish_if_done(id, update, emit);
            }
            Some("tool_call_update") => {
                if let Some(id) = update.get("toolCallId").and_then(Value::as_str) {
                    self.finish_if_done(id, update, emit);
                }
            }
            // Thoughts, plans, usage and the agent's own bookkeeping are
            // not shown.
            _ => {}
        }
    }

    fn finish_if_done(&mut self, id: &str, update: &Value, emit: &Emit) {
        let failed = match update.get("status").and_then(Value::as_str) {
            Some("completed") => false,
            Some("failed") => true,
            _ => return,
        };
        let Some(state) = self.tools.get_mut(id) else {
            return;
        };
        if state.finished {
            return;
        }
        state.finished = true;
        let elapsed_ms = u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        emit(AgentEvent::ToolCallFinished {
            id: id.to_string(),
            is_error: failed,
            text: truncate(&result_text(update, failed), MAX_UI_TEXT_CHARS),
            table: update
                .pointer("/rawOutput/structuredContent")
                .and_then(table_from_structured),
            // The engine's stderr goes to the agent, not to this app, so
            // there is nothing to report here.
            engine_notes: Vec::new(),
            elapsed_ms,
        });
    }

    /// Closes the tool calls the agent never reported a result for.
    fn settle(&mut self, stopped: bool, emit: &Emit) {
        for id in &self.order {
            let Some(state) = self.tools.get_mut(id) else {
                continue;
            };
            if state.finished {
                continue;
            }
            state.finished = true;
            emit(AgentEvent::ToolCallFinished {
                id: id.clone(),
                is_error: true,
                text: if stopped {
                    "Stopped. The engine cannot cancel a statement, so it may still complete."
                        .to_string()
                } else {
                    format!("{} reported no result for this call.", self.profile.name)
                },
                table: None,
                engine_notes: Vec::new(),
                elapsed_ms: u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            });
        }
    }
}

/// The text of a tool result, as the engine rendered it.
fn result_text(update: &Value, failed: bool) -> String {
    if failed && let Some(message) = update.pointer("/rawOutput/message").and_then(Value::as_str) {
        return message.to_string();
    }
    let joined = |items: Option<&Value>, path: &str| {
        let parts: Vec<&str> = items
            .and_then(Value::as_array)?
            .iter()
            .filter_map(|item| item.pointer(path).and_then(Value::as_str))
            .collect();
        (!parts.is_empty()).then(|| parts.join("\n"))
    };
    // The engine's own text blocks, without the copy of the payload the
    // agent appends for the model.
    joined(update.pointer("/rawOutput/contents"), "/text")
        .or_else(|| joined(update.get("content"), "/content/text"))
        .or_else(|| {
            update
                .pointer("/rawOutput/content")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::acp::testing::FakeAgent;
    use super::*;
    use crate::connection::LogBuffer;

    const PROFILE: Profile = Profile {
        name: "Test Agent",
        sign_in_hint: "Run `agent login`.",
        tool_prefix: "stackql-",
        vendor_key: "example.com/agent",
        session_events: &["subagent.started"],
        subagent_hint: "- Use the plain kind of subagent.",
    };

    /// An update tagged as a subagent's.
    fn by(agent: &str, mut update: Value) -> Value {
        update["_meta"] = json!({ "example.com/agent": { "agentId": agent } });
        update
    }

    fn collector() -> (Emit, Arc<Mutex<Vec<AgentEvent>>>) {
        let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
        let sink = events.clone();
        let emit: Emit = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
    }

    /// A session wired to a scripted agent, past the handshake.
    async fn opened(model: Option<&'static str>) -> (DelegateSession, FakeAgent) {
        let (ours, theirs) = tokio::io::duplex(1 << 16);
        let (our_read, our_write) = tokio::io::split(ours);
        let channel = AgentChannel {
            reader: Box::new(our_read),
            writer: Box::new(our_write),
            diagnostics: LogBuffer::default(),
            keepalive: Box::new(()),
        };
        let mut agent = FakeAgent::over(theirs);
        let opening = tokio::spawn(async move {
            DelegateSession::open(channel, PROFILE, Path::new("/work"), model, true).await
        });

        let (id, params) = agent.expect("initialize").await;
        assert_eq!(params["protocolVersion"], 1);
        assert_eq!(params["clientCapabilities"]["terminal"], false);
        assert_eq!(params["clientCapabilities"]["fs"]["writeTextFile"], false);
        // The agent's own events are asked for under its own key.
        assert_eq!(
            params["clientCapabilities"]["_meta"]["example.com/agent"]["events"],
            json!(["subagent.started"])
        );
        agent
            .result(
                id,
                json!({ "protocolVersion": 1, "agentInfo": { "name": "T", "version": "9.9" } }),
            )
            .await;

        let (id, params) = agent.expect("session/new").await;
        assert_eq!(params["cwd"], "/work");
        assert_eq!(params["mcpServers"], json!([]));
        agent
            .result(
                id,
                json!({
                    "sessionId": "s1",
                    "models": {
                        "currentModelId": "small",
                        "availableModels": [
                            { "modelId": "small", "name": "Small", "description": "Cheap",
                              "_meta": { "copilotUsage": "0.33x" } },
                            { "modelId": "big", "name": "Big", "description": "Dear" }
                        ]
                    }
                }),
            )
            .await;

        if let Some(model) = model {
            let (id, params) = agent.expect("session/set_config_option").await;
            assert_eq!(params["configId"], "model");
            assert_eq!(params["value"], model);
            agent.result(id, json!({})).await;
        }
        (opening.await.unwrap().unwrap(), agent)
    }

    #[tokio::test]
    async fn opening_reads_the_version_and_the_models() {
        let (session, _agent) = opened(None).await;
        assert_eq!(session.agent_version(), "9.9");
        assert_eq!(session.current_model(), Some("small"));
        assert_eq!(
            session.models(),
            [
                ModelOption {
                    id: "small".into(),
                    name: "Small".into(),
                    description: "Cheap".into(),
                    usage: Some("0.33x".into()),
                },
                ModelOption {
                    id: "big".into(),
                    name: "Big".into(),
                    description: "Dear".into(),
                    usage: None,
                },
            ]
        );
        assert!(!session.is_closed());
    }

    #[tokio::test]
    async fn a_chosen_model_is_set_on_the_session() {
        let (session, _agent) = opened(Some("big")).await;
        assert_eq!(session.current_model(), Some("big"));
    }

    #[tokio::test]
    async fn an_agent_that_is_not_signed_in_says_how_to_sign_in() {
        let (client_side, agent_side) = tokio::io::duplex(1 << 16);
        let (read, write) = tokio::io::split(client_side);
        let channel = AgentChannel {
            reader: Box::new(read),
            writer: Box::new(write),
            diagnostics: LogBuffer::default(),
            keepalive: Box::new(()),
        };
        let mut agent = FakeAgent::over(agent_side);
        let opening = tokio::spawn(async move {
            DelegateSession::open(channel, PROFILE, Path::new("/work"), None, false).await
        });
        let (id, _) = agent.expect("initialize").await;
        agent.result(id, json!({ "protocolVersion": 1 })).await;
        let (id, _) = agent.expect("session/new").await;
        agent
            .error(id, AUTH_REQUIRED, "Authentication required")
            .await;

        let err = opening.await.unwrap().err().unwrap();
        let text = err.to_string();
        assert!(text.contains("not signed in"), "{text}");
        assert!(text.contains("agent login"), "{text}");
    }

    #[tokio::test]
    async fn an_agent_on_another_protocol_version_is_refused() {
        let (client_side, agent_side) = tokio::io::duplex(1 << 16);
        let (read, write) = tokio::io::split(client_side);
        let channel = AgentChannel {
            reader: Box::new(read),
            writer: Box::new(write),
            diagnostics: LogBuffer::default(),
            keepalive: Box::new(()),
        };
        let mut agent = FakeAgent::over(agent_side);
        let opening = tokio::spawn(async move {
            DelegateSession::open(channel, PROFILE, Path::new("/work"), None, false).await
        });
        let (id, _) = agent.expect("initialize").await;
        agent.result(id, json!({ "protocolVersion": 2 })).await;
        let err = opening.await.unwrap().err().unwrap();
        assert!(err.to_string().contains("version"), "{err}");
    }

    #[tokio::test]
    async fn a_turn_streams_text_and_reports_tool_calls() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Arc::new(Notify::new());
        let turn = tokio::spawn({
            let stop = stop.clone();
            async move {
                let summary = session.prompt("how many providers?", &stop, &emit).await;
                (session, summary)
            }
        });

        let (prompt_id, params) = agent.expect("session/prompt").await;
        assert_eq!(params["sessionId"], "s1");
        // The first prompt carries the context, how to use subagents, then
        // the operator's words.
        let blocks = params["prompt"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        let context = blocks[0]["text"].as_str().unwrap();
        assert!(context.contains("StackQL Workbench"));
        // How the work is shown, and how to ask for a chart, come with it.
        assert!(context.contains("How your work is shown"));
        assert!(context.contains("```chart"));
        let guidance = blocks[1]["text"].as_str().unwrap();
        assert!(guidance.starts_with("Subagents:"));
        // What this agent needs to be told about its own subagents follows.
        assert!(guidance.ends_with("- Use the plain kind of subagent."));
        assert_eq!(blocks[2]["text"], "how many providers?");

        // The agent's own line about disabled tools is not news.
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "Info: Disabled tools: edit, view" } }),
            )
            .await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": "thinking" } }),
            )
            .await;
        for piece in ["Let me ", "check."] {
            agent
                .update(
                    "s1",
                    json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m1",
                            "content": { "type": "text", "text": piece } }),
                )
                .await;
        }
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call", "toolCallId": "t1",
                        "title": "stackql-run_select_query", "kind": "execute", "status": "pending",
                        "rawInput": { "sql": "SHOW PROVIDERS" } }),
            )
            .await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                        "content": [{ "type": "content", "content": { "type": "text",
                            "text": "| name |\n|---|\n| github |\n\n\n{\"rows\":[{\"name\":\"github\"}]}" } }],
                        "rawOutput": {
                            "contents": [{ "type": "text", "text": "| name |\n|---|\n| github |\n" }],
                            "structuredContent": { "rows": [{ "name": "github" }] }
                        } }),
            )
            .await;
        // An update for some other session is not this turn's business.
        agent
            .update(
                "other",
                json!({ "sessionUpdate": "agent_message_chunk", "messageId": "x",
                        "content": { "type": "text", "text": "not ours" } }),
            )
            .await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m2",
                        "content": { "type": "text", "text": "One provider." } }),
            )
            .await;
        agent
            .result(
                prompt_id,
                json!({ "stopReason": "end_turn",
                        "usage": { "inputTokens": 19353, "outputTokens": 92, "totalTokens": 19445,
                            "thoughtTokens": 46, "cachedReadTokens": 9533, "cachedWriteTokens": 9805 } }),
            )
            .await;

        let (mut session, summary) = turn.await.unwrap();
        let summary = summary.unwrap();
        assert!(!summary.stopped);
        assert_eq!(summary.stop, StopReason::EndTurn);
        assert_eq!(summary.tool_calls, 1);
        assert_eq!(summary.steps, 2);
        // The shape the Copilot CLI sent when it was asked. See the spike report.
        assert_eq!(summary.usage.input_tokens, Some(19_353));
        assert_eq!(summary.usage.output_tokens, Some(92));
        assert_eq!(summary.usage.cached_input_tokens, Some(9_533));

        let events = events.lock().unwrap().clone();
        let deltas: Vec<(&str, &str)> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::AssistantDelta { id, text } => Some((id.as_str(), text.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            deltas,
            [("m1", "Let me "), ("m1", "check."), ("m2", "One provider.")]
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, AgentEvent::Notice { .. })),
            "nothing to tell the operator: {events:?}"
        );
        let started = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolCallStarted {
                    id,
                    tool,
                    sql,
                    step,
                    ..
                } => Some((id.clone(), tool.clone(), sql.clone(), *step)),
                _ => None,
            })
            .unwrap();
        // The call follows the agent's first message, so it is of step one.
        assert_eq!(
            started,
            (
                "t1".to_string(),
                "run_select_query".to_string(),
                Some("SHOW PROVIDERS".to_string()),
                1
            )
        );
        let finished = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolCallFinished {
                    is_error,
                    text,
                    table,
                    ..
                } => Some((*is_error, text.clone(), table.clone())),
                _ => None,
            })
            .unwrap();
        assert!(!finished.0);
        assert!(
            !finished.1.contains("\"rows\""),
            "the payload copy is left out"
        );
        let table = finished.2.unwrap();
        assert_eq!(table.columns, ["name"]);
        assert_eq!(table.rows, [[Some("github".to_string())]]);

        // The context is sent once.
        let (emit, _) = collector();
        let next = tokio::spawn(async move { session.prompt("and now?", &stop, &emit).await });
        let (id, params) = agent.expect("session/prompt").await;
        assert_eq!(params["prompt"].as_array().unwrap().len(), 1);
        agent.result(id, json!({ "stopReason": "end_turn" })).await;
        next.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn subagents_are_shown_with_their_task_and_their_calls_are_marked() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn =
            tokio::spawn(async move { session.prompt("audit two providers", &stop, &emit).await });
        let (prompt_id, _) = agent.expect("session/prompt").await;

        // The main agent starts a subagent.
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call", "toolCallId": "task1",
                        "title": "Count github repos", "kind": "other", "status": "pending",
                        "rawInput": { "name": "github-count", "agent_type": "task",
                            "description": "Count github repos",
                            "prompt": "A long prompt the operator does not need to read.",
                            "mode": "sync" } }),
            )
            .await;
        agent
            .send(json!({
                "jsonrpc": "2.0", "method": "example.com/agent/sessionEvent",
                "params": { "sessionId": "s1", "type": "subagent.started", "agentId": "a1",
                    "data": { "toolCallId": "task1", "agentDisplayName": "github-count" } }
            }))
            .await;
        // The subagent thinks aloud and runs a query.
        agent
            .update(
                "s1",
                by(
                    "a1",
                    json!({ "sessionUpdate": "agent_message_chunk", "messageId": "sub-m1",
                        "content": { "type": "text", "text": "Counting now." } }),
                ),
            )
            .await;
        agent
            .update(
                "s1",
                by(
                    "a1",
                    json!({ "sessionUpdate": "tool_call", "toolCallId": "q1",
                        "title": "stackql-run_select_query", "status": "pending",
                        "rawInput": { "sql": "SELECT COUNT(*) FROM github.repos.repos" } }),
                ),
            )
            .await;
        agent
            .update(
                "s1",
                by("a1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "q1",
                        "status": "completed",
                        "rawOutput": { "contents": [{ "type": "text", "text": "| n |\n|---|\n| 90 |" }],
                            "structuredContent": { "rows": [{ "n": 90 }] } } })),
            )
            .await;
        // Its report comes back as the result of the call that started it.
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "task1",
                        "status": "completed",
                        "content": [{ "type": "content",
                            "content": { "type": "text", "text": "github has 90 repos." } }] }),
            )
            .await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m1",
                        "content": { "type": "text", "text": "90 repos in github." } }),
            )
            .await;
        agent
            .result(prompt_id, json!({ "stopReason": "end_turn" }))
            .await;
        let summary = turn.await.unwrap().unwrap();
        assert!(!summary.stopped);
        assert_eq!(summary.tool_calls, 2);

        let events = events.lock().unwrap().clone();
        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCallStarted {
                    id,
                    tool,
                    arguments,
                    agent,
                    ..
                } => Some((id.as_str(), tool.as_str(), arguments.clone(), agent.clone())),
                _ => None,
            })
            .collect();
        // The start of a subagent shows its task and not its whole prompt.
        assert_eq!(
            started[0],
            (
                "task1",
                "subagent",
                json!({ "task": "Count github repos" }),
                None
            )
        );
        // The subagent's own call is an engine tool, marked with its name.
        assert_eq!(started[1].0, "q1");
        assert_eq!(started[1].1, "run_select_query");
        assert_eq!(started[1].3.as_deref(), Some("github-count"));

        // Only the main agent's words are shown as the reply.
        let said: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::AssistantDelta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(said, ["90 repos in github."]);

        // The subagent's report is the result of the call that started it.
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCallFinished { id, is_error: false, text, .. }
                if id == "task1" && text == "github has 90 repos."
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCallFinished { id, table: Some(_), .. } if id == "q1"
        )));
    }

    #[tokio::test]
    async fn a_subagent_with_no_start_event_still_gets_a_name() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("go", &stop, &emit).await });
        let (prompt_id, _) = agent.expect("session/prompt").await;
        for (call, who) in [("q1", "a1"), ("q2", "a2"), ("q3", "a1")] {
            agent
                .update(
                    "s1",
                    by(
                        who,
                        json!({ "sessionUpdate": "tool_call", "toolCallId": call,
                            "title": "stackql-list_providers", "status": "completed",
                            "rawInput": {} }),
                    ),
                )
                .await;
        }
        agent
            .result(prompt_id, json!({ "stopReason": "end_turn" }))
            .await;
        turn.await.unwrap().unwrap();

        let names: Vec<Option<String>> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCallStarted { agent, .. } => Some(agent.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            names,
            [
                Some("subagent 1".to_string()),
                Some("subagent 2".to_string()),
                Some("subagent 1".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn too_many_subagents_stop_the_turn_and_say_why() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("everything", &stop, &emit).await });
        let (prompt_id, _) = agent.expect("session/prompt").await;

        for n in 0..=MAX_SUBAGENTS {
            agent
                .send(json!({
                    "jsonrpc": "2.0", "method": "example.com/agent/sessionEvent",
                    "params": { "sessionId": "s1", "type": "subagent.started",
                        "agentId": format!("a{n}"), "data": { "agentDisplayName": format!("part {n}") } }
                }))
                .await;
        }
        // One past the limit: this side cancels, once.
        let message = agent.receive().await;
        assert_eq!(message["method"], "session/cancel");
        assert_eq!(message["params"]["sessionId"], "s1");
        agent
            .result(prompt_id, json!({ "stopReason": "cancelled" }))
            .await;

        let summary = turn.await.unwrap().unwrap();
        assert!(summary.stopped);
        let notices: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Notice { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(notices[0].contains("subagents"), "{}", notices[0]);
        assert!(notices[0].contains("Settings"), "{}", notices[0]);
    }

    #[tokio::test]
    async fn a_subagent_that_starts_a_subagent_stops_the_turn() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("count them", &stop, &emit).await });
        let (prompt_id, _) = agent.expect("session/prompt").await;

        // A subagent started by the main agent is fine.
        agent
            .send(json!({
                "jsonrpc": "2.0", "method": "example.com/agent/sessionEvent",
                "params": { "sessionId": "s1", "type": "subagent.started", "agentId": "a1",
                    "data": { "agentDisplayName": "count" } }
            }))
            .await;
        // One started by that subagent is not.
        agent
            .send(json!({
                "jsonrpc": "2.0", "method": "example.com/agent/sessionEvent",
                "params": { "sessionId": "s1", "type": "subagent.started", "agentId": "a2",
                    "data": { "agentDisplayName": "count again", "parentId": "a1" } }
            }))
            .await;
        let message = agent.receive().await;
        assert_eq!(message["method"], "session/cancel");
        agent
            .result(prompt_id, json!({ "stopReason": "cancelled" }))
            .await;

        let summary = turn.await.unwrap().unwrap();
        assert!(summary.stopped);
        let notices: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Notice { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(notices[0].contains("subagent of its own"), "{}", notices[0]);
    }

    #[tokio::test]
    async fn events_for_another_session_or_of_another_kind_are_ignored() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("go", &stop, &emit).await });
        let (prompt_id, _) = agent.expect("session/prompt").await;
        for params in [
            json!({ "sessionId": "other", "type": "subagent.started", "agentId": "x" }),
            json!({ "sessionId": "s1", "type": "subagent.completed", "agentId": "y" }),
            json!({ "sessionId": "s1", "type": "subagent.started" }),
        ] {
            agent
                .send(json!({ "jsonrpc": "2.0", "method": "example.com/agent/sessionEvent", "params": params }))
                .await;
        }
        // Some other vendor's event with the same ending is not ours.
        agent
            .send(
                json!({ "jsonrpc": "2.0", "method": "elsewhere.org/sessionEvent",
                "params": { "sessionId": "s1", "type": "subagent.started", "agentId": "z" } }),
            )
            .await;
        agent
            .update(
                "s1",
                by(
                    "a1",
                    json!({ "sessionUpdate": "tool_call", "toolCallId": "q1",
                        "title": "stackql-server_info", "status": "completed", "rawInput": {} }),
                ),
            )
            .await;
        agent
            .result(prompt_id, json!({ "stopReason": "end_turn" }))
            .await;
        turn.await.unwrap().unwrap();
        // None of those counted, so the first subagent seen is number one.
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCallStarted { agent: Some(name), .. } if name == "subagent 1"
        )));
    }

    #[tokio::test]
    async fn the_subagent_guidance_is_left_out_when_subagents_are_off() {
        let (client_side, agent_side) = tokio::io::duplex(1 << 16);
        let (read, write) = tokio::io::split(client_side);
        let channel = AgentChannel {
            reader: Box::new(read),
            writer: Box::new(write),
            diagnostics: LogBuffer::default(),
            keepalive: Box::new(()),
        };
        let mut agent = FakeAgent::over(agent_side);
        let opening = tokio::spawn(async move {
            DelegateSession::open(channel, PROFILE, Path::new("/work"), None, false).await
        });
        let (id, _) = agent.expect("initialize").await;
        agent.result(id, json!({ "protocolVersion": 1 })).await;
        let (id, _) = agent.expect("session/new").await;
        agent.result(id, json!({ "sessionId": "s1" })).await;
        let mut session = opening.await.unwrap().unwrap();

        let (emit, _) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("hello", &stop, &emit).await });
        let (prompt_id, params) = agent.expect("session/prompt").await;
        let blocks = params["prompt"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(
            !blocks
                .iter()
                .any(|b| b["text"].as_str().unwrap().contains("Subagents:"))
        );
        agent
            .result(prompt_id, json!({ "stopReason": "end_turn" }))
            .await;
        turn.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_statement_is_shown_as_a_failed_tool_call() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("delete it", &stop, &emit).await });

        let (prompt_id, _) = agent.expect("session/prompt").await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call", "toolCallId": "t1",
                        "title": "stackql-run_mutation_query", "status": "pending",
                        "rawInput": { "sql": "DELETE FROM x" } }),
            )
            .await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed",
                        "rawOutput": { "code": "failure",
                            "message": "refused: server is in 'safe' mode and the MCP client does not support elicitation" } }),
            )
            .await;
        agent
            .result(prompt_id, json!({ "stopReason": "end_turn" }))
            .await;
        turn.await.unwrap().unwrap();

        let events = events.lock().unwrap().clone();
        let finished = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolCallFinished { is_error, text, .. } => {
                    Some((*is_error, text.clone()))
                }
                _ => None,
            })
            .unwrap();
        assert!(finished.0);
        assert!(finished.1.contains("refused"), "{}", finished.1);
        // The host raised no approval of its own.
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, AgentEvent::ApprovalRequested { .. }))
        );
    }

    #[tokio::test]
    async fn a_permission_request_is_declined_and_the_operator_is_told() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("run a script", &stop, &emit).await });

        let (prompt_id, _) = agent.expect("session/prompt").await;
        agent
            .send(json!({
                "jsonrpc": "2.0", "id": 0, "method": "session/request_permission",
                "params": {
                    "sessionId": "s1",
                    "toolCall": { "toolCallId": "t9", "title": "rm -rf things", "kind": "execute" },
                    "options": [
                        { "optionId": "allow_once", "kind": "allow_once", "name": "Allow once" },
                        { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow" },
                        { "optionId": "reject_once", "kind": "reject_once", "name": "Deny" }
                    ]
                }
            }))
            .await;
        let answer = agent.receive().await;
        assert_eq!(answer["id"], 0);
        assert_eq!(answer["result"]["outcome"]["outcome"], "selected");
        assert_eq!(answer["result"]["outcome"]["optionId"], "reject_once");

        // With no way to say no, the answer is cancel, never yes.
        agent
            .send(json!({
                "jsonrpc": "2.0", "id": 1, "method": "session/request_permission",
                "params": { "sessionId": "s1", "toolCall": { "title": "x" },
                    "options": [{ "optionId": "allow_once", "kind": "allow_once", "name": "Allow" }] }
            }))
            .await;
        let answer = agent.receive().await;
        assert_eq!(answer["result"]["outcome"]["outcome"], "cancelled");

        // Anything else the agent asks of its client is refused.
        agent
            .send(
                json!({ "jsonrpc": "2.0", "id": 2, "method": "fs/write_text_file",
                          "params": { "path": "/etc/passwd", "content": "" } }),
            )
            .await;
        let answer = agent.receive().await;
        assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND);

        agent
            .result(prompt_id, json!({ "stopReason": "end_turn" }))
            .await;
        turn.await.unwrap().unwrap();

        let notices: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Notice { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 2);
        assert!(notices[0].contains("rm -rf things"), "{}", notices[0]);
        assert!(notices[0].contains("declined"), "{}", notices[0]);
    }

    #[tokio::test]
    async fn stopping_cancels_the_turn_and_closes_open_tool_calls() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Arc::new(Notify::new());
        let turn = tokio::spawn({
            let stop = stop.clone();
            async move {
                let summary = session.prompt("long one", &stop, &emit).await;
                (session, summary)
            }
        });

        let (prompt_id, _) = agent.expect("session/prompt").await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "tool_call", "toolCallId": "t1",
                        "title": "stackql-run_select_query", "status": "pending",
                        "rawInput": { "sql": "SELECT 1" } }),
            )
            .await;
        // Wait until the tool call has been seen, then stop.
        while events.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        stop.notify_one();

        let (id, params) = {
            let message = agent.receive().await;
            assert_eq!(message["method"], "session/cancel");
            (message.get("id").cloned(), message["params"].clone())
        };
        assert!(id.is_none(), "cancel is a notification");
        assert_eq!(params["sessionId"], "s1");
        agent
            .result(prompt_id, json!({ "stopReason": "cancelled" }))
            .await;

        let (session, summary) = turn.await.unwrap();
        assert!(summary.unwrap().stopped);
        assert!(
            !session.is_closed(),
            "a cancelled turn leaves the session usable"
        );
        let events = events.lock().unwrap().clone();
        let closed = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolCallFinished { is_error, text, .. } => {
                    Some((*is_error, text.clone()))
                }
                _ => None,
            })
            .unwrap();
        assert!(closed.0);
        assert!(closed.1.contains("Stopped"), "{}", closed.1);
    }

    #[tokio::test]
    async fn an_agent_that_dies_mid_turn_is_an_error_and_ends_the_session() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, _) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move {
            let outcome = session.prompt("hello", &stop, &emit).await;
            (session, outcome)
        });
        agent.expect("session/prompt").await;
        drop(agent);

        let (session, outcome) = turn.await.unwrap();
        let err = outcome.unwrap_err().to_string();
        assert!(err.contains("stopped unexpectedly"), "{err}");
        assert!(session.is_closed());
    }

    #[tokio::test]
    async fn a_line_from_the_agent_program_is_shown_as_a_notice() {
        let (mut session, mut agent) = opened(None).await;
        let (emit, events) = collector();
        let stop = Notify::new();
        let turn = tokio::spawn(async move { session.prompt("hi", &stop, &emit).await });
        let (prompt_id, _) = agent.expect("session/prompt").await;
        agent
            .update(
                "s1",
                json!({ "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text",
                            "text": "Info: Unknown tool name in the tool allowlist: \"stackql-x\"" } }),
            )
            .await;
        agent
            .result(prompt_id, json!({ "stopReason": "max_tokens" }))
            .await;
        let summary = turn.await.unwrap().unwrap();
        assert_eq!(summary.stop, StopReason::MaxTokens);
        let events = events.lock().unwrap().clone();
        assert_eq!(
            events,
            [AgentEvent::Notice {
                message: "Test Agent: Unknown tool name in the tool allowlist: \"stackql-x\""
                    .to_string()
            }]
        );
    }
}
