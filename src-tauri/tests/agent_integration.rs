//! The agent loop against a real `stackql mcp`, with a scripted stand-in for
//! the model.
//!
//! No inference provider is called and no API key is needed: the "model"
//! here replies from a script. Everything else is real: the engine process,
//! the MCP session, the tool calls, the approval prompts and the audit log.
//!
//! Skipped, with a note on stderr, when no `stackql` binary can be found.
//! No cloud credentials and no network are needed. The one mutation that is
//! sent is never approved.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use stackql_workbench_lib::activity::read_audit;
use stackql_workbench_lib::agent::approvals::ApprovalDecision;
use stackql_workbench_lib::agent::backend::{
    ChatRequest, ChatResponse, InferenceBackend, InferenceError, Message, StopReason, ToolCall,
    Usage,
};
use stackql_workbench_lib::agent::runtime::{AgentEvent, AgentRuntime, Emit};
use stackql_workbench_lib::config::{Settings, SettingsStore};
use stackql_workbench_lib::connection::local::LocalConnection;
use stackql_workbench_lib::connection::{Connection, EngineState, SafetyMode};
use stackql_workbench_lib::engine::approot::Defaults as ApprootDefaults;
use stackql_workbench_lib::engine::discovery::{self, Inputs};

const DELETE_SQL: &str =
    "DELETE FROM github.repos.repos WHERE owner = 'nobody-xyz' AND repo = 'nothing-xyz'";

fn engine_available() -> bool {
    let found = discovery::resolve(&Inputs::from_environment(None), |p| p.is_file()).is_ok();
    if !found {
        eprintln!("skipped: no stackql binary found (set STACKQL_BIN or add stackql to PATH)");
    }
    found
}

/// What the scripted model was sent on one call.
#[derive(Clone)]
struct Seen {
    system: String,
    messages: Vec<Message>,
    tool_names: Vec<String>,
}

/// A model that replies from a script and remembers what it was asked.
struct Scripted {
    replies: Mutex<VecDeque<ChatResponse>>,
    seen: Mutex<Vec<Seen>>,
}

impl Scripted {
    fn new(replies: Vec<ChatResponse>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

impl InferenceBackend for Scripted {
    fn complete<'a>(
        &'a self,
        request: ChatRequest<'a>,
    ) -> BoxFuture<'a, Result<ChatResponse, InferenceError>> {
        self.seen.lock().unwrap().push(Seen {
            system: request.system.to_string(),
            messages: request.messages.to_vec(),
            tool_names: request.tools.iter().map(|t| t.name.clone()).collect(),
        });
        let reply = self.replies.lock().unwrap().pop_front();
        async move { reply.ok_or_else(|| InferenceError::Protocol("the script ran out".into())) }
            .boxed()
    }
}

fn calls(calls: &[(&str, &str, Value)]) -> ChatResponse {
    ChatResponse {
        text: String::new(),
        tool_calls: calls
            .iter()
            .map(|(id, name, args)| ToolCall {
                id: (*id).to_string(),
                name: (*name).to_string(),
                arguments: args.as_object().cloned().unwrap_or_else(Map::new),
            })
            .collect(),
        raw: None,
        stop: StopReason::ToolUse,
        usage: Usage {
            input_tokens: Some(100),
            output_tokens: Some(10),
        },
    }
}

fn says(text: &str) -> ChatResponse {
    ChatResponse {
        text: text.to_string(),
        tool_calls: Vec::new(),
        raw: None,
        stop: StopReason::EndTurn,
        usage: Usage {
            input_tokens: Some(200),
            output_tokens: Some(20),
        },
    }
}

struct Fixture {
    connection: Arc<LocalConnection>,
    runtime: Arc<AgentRuntime>,
    approot: PathBuf,
}

async fn fixture(name: &str) -> Fixture {
    let approot = std::env::temp_dir().join(format!("wb-agent-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&approot);
    let settings = Arc::new(SettingsStore::in_memory(Settings::default()));
    let connection = Arc::new(
        LocalConnection::new(
            ApprootDefaults::fixed(approot.clone()),
            approot.join("audit"),
            settings,
        )
        .unwrap(),
    );
    let status = connection.start().await;
    assert_eq!(
        status.state,
        EngineState::Running,
        "engine did not start: {:?}",
        status.error
    );
    let runtime = Arc::new(AgentRuntime::new(connection.clone()));
    Fixture {
        connection,
        runtime,
        approot,
    }
}

async fn teardown(fixture: Fixture) {
    fixture.runtime.reset().await;
    fixture.connection.shutdown().await;
    let _ = std::fs::remove_dir_all(fixture.approot);
}

fn collector() -> (Emit, Arc<Mutex<Vec<AgentEvent>>>) {
    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink = events.clone();
    let emit: Emit = Arc::new(move |event| sink.lock().unwrap().push(event));
    (emit, events)
}

/// Collects events and answers every approval prompt with `decision`, the
/// way the operator would by pressing a button.
fn answering(
    runtime: &Arc<AgentRuntime>,
    decision: ApprovalDecision,
) -> (Emit, Arc<Mutex<Vec<AgentEvent>>>) {
    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink = events.clone();
    let runtime = runtime.clone();
    let emit: Emit = Arc::new(move |event| {
        if let AgentEvent::ApprovalRequested { request } = &event {
            let runtime = runtime.clone();
            let id = request.id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(40)).await;
                runtime.approvals().resolve(&id, decision);
            });
        }
        sink.lock().unwrap().push(event);
    });
    (emit, events)
}

fn tool_results(seen: &Seen) -> Vec<(String, bool)> {
    seen.messages
        .iter()
        .filter_map(|m| match m {
            Message::ToolResults { results } => Some(results),
            _ => None,
        })
        .flatten()
        .map(|r| (r.content.clone(), r.is_error))
        .collect()
}

#[tokio::test]
async fn a_turn_runs_tools_through_the_engine_and_feeds_the_results_back() {
    if !engine_available() {
        return;
    }
    let fx = fixture("tools").await;
    let model = Scripted::new(vec![
        calls(&[
            ("c1", "list_providers", json!({})),
            (
                "c2",
                "run_select_query",
                json!({ "sql": "SELECT 1 AS one" }),
            ),
        ]),
        says("There is one provider installed."),
    ]);
    let (emit, events) = collector();

    let summary = fx
        .runtime
        .send(
            model.clone(),
            SafetyMode::Safe,
            "what is installed?".into(),
            emit,
        )
        .await
        .unwrap();

    assert_eq!(summary.steps, 2);
    assert_eq!(summary.tool_calls, 2);
    assert!(!summary.stopped);
    assert_eq!(summary.stop, StopReason::EndTurn);
    assert_eq!(summary.usage.input_tokens, Some(300));

    let events = events.lock().unwrap().clone();
    // A session was opened in the requested mode, on a revision with a handshake.
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::SessionStarted { mode: SafetyMode::Safe, protocol_version, tools }
            if protocol_version == "2025-11-25" && *tools == 15
    )));
    // The statement is surfaced as SQL before it runs.
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCallStarted { id, tool, sql: Some(sql), .. }
            if id == "c2" && tool == "run_select_query" && sql == "SELECT 1 AS one"
    )));
    // Row results come back as a table for the grid.
    let providers = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ToolCallFinished {
                id,
                table: Some(table),
                is_error: false,
                ..
            } if id == "c1" => Some(table.clone()),
            _ => None,
        })
        .expect("list_providers should return a table");
    assert_eq!(providers.columns, vec!["name", "version"]);
    assert!(
        providers
            .rows
            .iter()
            .any(|row| row[0].as_deref() == Some("stackql_preview"))
    );
    let one = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ToolCallFinished {
                id,
                table: Some(table),
                ..
            } if id == "c2" => Some(table.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(one.rows, vec![vec![Some("1".to_string())]]);
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::AssistantText { text } if text == "There is one provider installed."
    )));

    // What the model was given.
    let seen = model.seen();
    assert_eq!(seen.len(), 2);
    assert!(seen[0].tool_names.contains(&"run_select_query".to_string()));
    assert!(
        seen[0]
            .tool_names
            .contains(&"run_mutation_query".to_string())
    );
    // The engine's own guidance is part of the system prompt.
    assert!(seen[0].system.contains("StackQL Workbench"));
    assert!(seen[0].system.contains("<provider>.<service>.<resource>"));
    assert!(
        matches!(&seen[0].messages[..], [Message::User { text }] if text == "what is installed?")
    );
    // Both results went back, in one message, before the second call.
    let results = tool_results(&seen[1]);
    assert_eq!(results.len(), 2);
    assert!(results[0].0.contains("stackql_preview"));
    assert!(!results[0].1);

    // The engine recorded what the agent did.
    let audit = read_audit(&fx.connection.audit_dir().unwrap(), 50);
    assert!(
        audit
            .iter()
            .any(|r| r.tool == "list_providers" && r.decision == "allow")
    );
    assert!(
        audit
            .iter()
            .any(|r| r.tool == "run_select_query" && r.sql.as_deref() == Some("SELECT 1 AS one"))
    );

    teardown(fx).await;
}

#[tokio::test]
async fn a_mutation_waits_for_the_operator_and_a_decline_reaches_the_model() {
    if !engine_available() {
        return;
    }
    let fx = fixture("decline").await;
    let model = Scripted::new(vec![
        calls(&[("c1", "run_mutation_query", json!({ "sql": DELETE_SQL }))]),
        says("Understood, I will not delete it."),
    ]);
    let (emit, events) = answering(&fx.runtime, ApprovalDecision::Decline);

    let summary = fx
        .runtime
        .send(
            model.clone(),
            SafetyMode::Safe,
            "delete that repo".into(),
            emit,
        )
        .await
        .unwrap();
    assert_eq!(summary.steps, 2);
    assert!(!summary.stopped);

    let events = events.lock().unwrap().clone();
    // The card shows the engine's classification and the exact SQL.
    let request = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ApprovalRequested { request } => Some(request.clone()),
            _ => None,
        })
        .expect("the engine should ask for approval in safe mode");
    assert_eq!(request.tool.as_deref(), Some("run_mutation_query"));
    assert_eq!(request.query_class.as_deref(), Some("mutation_delete"));
    assert_eq!(request.sql.as_deref(), Some(DELETE_SQL));
    assert!(request.message.contains(DELETE_SQL));

    // Declined: the tool reports an error and nothing ran.
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCallFinished { id, is_error: true, text, .. }
            if id == "c1" && text.contains("declined")
    )));
    let results = tool_results(&model.seen()[1]);
    assert_eq!(results.len(), 1);
    assert!(results[0].1, "the model must see the refusal as an error");
    assert!(results[0].0.contains("declined"));

    let audit = read_audit(&fx.connection.audit_dir().unwrap(), 50);
    assert!(audit.iter().any(|r| {
        r.tool == "run_mutation_query"
            && r.decision == "needs_approval_declined"
            && r.query_class == "mutation_delete"
            && r.sql.as_deref() == Some(DELETE_SQL)
    }));

    teardown(fx).await;
}

#[tokio::test]
async fn read_only_mode_refuses_without_asking() {
    if !engine_available() {
        return;
    }
    let fx = fixture("readonly").await;
    let model = Scripted::new(vec![
        calls(&[("c1", "run_mutation_query", json!({ "sql": DELETE_SQL }))]),
        says("That is not allowed here."),
    ]);
    let (emit, events) = collector();

    fx.runtime
        .send(
            model.clone(),
            SafetyMode::ReadOnly,
            "delete that repo".into(),
            emit,
        )
        .await
        .unwrap();

    let events = events.lock().unwrap().clone();
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::ApprovalRequested { .. })),
        "read_only refuses outright, so there is nothing to approve"
    );
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCallFinished { is_error: true, text, .. } if text.contains("read_only")
    )));
    let audit = read_audit(&fx.connection.audit_dir().unwrap(), 50);
    assert!(
        audit
            .iter()
            .any(|r| r.mode == "read_only" && r.decision == "refuse_immediate")
    );

    teardown(fx).await;
}

#[tokio::test]
async fn nothing_is_approved_when_nobody_answers_and_the_turn_is_stopped() {
    if !engine_available() {
        return;
    }
    let fx = fixture("stop").await;
    let model = Scripted::new(vec![
        calls(&[("c1", "run_mutation_query", json!({ "sql": DELETE_SQL }))]),
        // Used by the turn after the stopped one.
        says("Still here."),
    ]);

    // Nobody answers the prompt. The operator stops the turn instead.
    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink = events.clone();
    let stopper = fx.runtime.clone();
    let emit: Emit = Arc::new(move |event| {
        if matches!(event, AgentEvent::ApprovalRequested { .. }) {
            let stopper = stopper.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                assert!(stopper.stop(), "a turn should be running");
            });
        }
        sink.lock().unwrap().push(event);
    });

    let summary = tokio::time::timeout(
        Duration::from_secs(20),
        fx.runtime.send(
            model.clone(),
            SafetyMode::Safe,
            "delete that repo".into(),
            emit,
        ),
    )
    .await
    .expect("a stopped turn must return")
    .unwrap();
    assert!(summary.stopped);
    assert_eq!(summary.steps, 1);
    assert_eq!(fx.runtime.approvals().pending_count(), 0);

    // The prompt was never accepted, so the engine never ran the statement.
    let audit = read_audit(&fx.connection.audit_dir().unwrap(), 50);
    assert!(
        !audit.iter().any(|r| r.decision == "needs_approval_accepted"
            || r.decision == "allow" && r.tool == "run_mutation_query"),
        "{audit:?}"
    );

    // The conversation is still usable, and still well formed: the stopped
    // call has a result, so a provider would accept the history.
    let (emit, _events) = collector();
    let summary = fx
        .runtime
        .send(
            model.clone(),
            SafetyMode::Safe,
            "are you there?".into(),
            emit,
        )
        .await
        .unwrap();
    assert_eq!(summary.steps, 1);
    let history = &model.seen()[1].messages;
    let stopped_results = history
        .iter()
        .filter_map(|m| match m {
            Message::ToolResults { results } => Some(results),
            _ => None,
        })
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(stopped_results.len(), 1);
    assert_eq!(stopped_results[0].call_id, "c1");
    assert!(stopped_results[0].is_error);
    assert!(matches!(history.last(), Some(Message::User { text }) if text == "are you there?"));

    teardown(fx).await;
}

#[tokio::test]
async fn a_failed_model_call_leaves_no_half_turn_behind() {
    if !engine_available() {
        return;
    }
    let fx = fixture("modelerror").await;
    // An empty script: the first call fails.
    let failing = Scripted::new(vec![]);
    let (emit, _events) = collector();
    let err = fx
        .runtime
        .send(failing, SafetyMode::Safe, "hello".into(), emit)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("could not be read"), "{err}");

    // The failed message is not in the history of the next turn.
    let model = Scripted::new(vec![says("Hi.")]);
    let (emit, _events) = collector();
    fx.runtime
        .send(model.clone(), SafetyMode::Safe, "hello again".into(), emit)
        .await
        .unwrap();
    assert!(matches!(
        &model.seen()[0].messages[..],
        [Message::User { text }] if text == "hello again"
    ));

    teardown(fx).await;
}

#[tokio::test]
async fn changing_the_safety_mode_opens_a_new_engine_session() {
    if !engine_available() {
        return;
    }
    let fx = fixture("modes").await;
    let model = Scripted::new(vec![says("one"), says("two"), says("three")]);

    let mut sessions = Vec::new();
    for mode in [SafetyMode::Safe, SafetyMode::Safe, SafetyMode::ReadOnly] {
        let (emit, events) = collector();
        fx.runtime
            .send(model.clone(), mode, "hi".into(), emit)
            .await
            .unwrap();
        let started = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, AgentEvent::SessionStarted { .. }))
            .count();
        sessions.push(started);
    }
    // Opened once, reused while the mode stayed the same, reopened on change.
    assert_eq!(sessions, vec![1, 0, 1]);
    // The conversation carried across all three turns.
    assert_eq!(model.seen()[2].messages.len(), 5);

    teardown(fx).await;
}

#[tokio::test]
async fn without_a_running_engine_the_turn_fails_plainly() {
    let approot = std::env::temp_dir().join(format!("wb-agent-it-{}-noengine", std::process::id()));
    let settings = Arc::new(SettingsStore::in_memory(Settings::default()));
    let connection = Arc::new(
        LocalConnection::new(
            ApprootDefaults::fixed(approot.clone()),
            approot.join("audit"),
            settings,
        )
        .unwrap(),
    );
    let runtime = AgentRuntime::new(connection);
    let (emit, _events) = collector();
    let err = runtime
        .send(
            Scripted::new(vec![says("x")]),
            SafetyMode::Safe,
            "hi".into(),
            emit,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("engine is not running"), "{err}");
}
