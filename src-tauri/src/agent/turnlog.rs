//! What goes wrong in a turn, written to the app's log.
//!
//! A tool call that fails is part of how a model works: it reads the error,
//! corrects the statement and runs it again. The conversation does not list
//! those attempts. They are written here, with the statement and what came
//! back, so that they can be read when someone needs them.
//!
//! This watches the events of a turn on their way to the webview. It changes
//! none of them, and it makes no judgement of its own: a call is logged as
//! failed when the engine, or the agent, said it failed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::runtime::{AgentEvent, TurnSummary};
use crate::applog::AppLog;
use crate::connection::SafetyMode;
use crate::error::HostResult;
use crate::util::lock;

/// A tool call that has started and not yet ended.
struct OpenCall {
    tool: String,
    sql: Option<String>,
    arguments: Value,
    agent: Option<String>,
}

pub struct TurnLog {
    log: Arc<AppLog>,
    /// The backend the turn runs on, as settings name it.
    backend: String,
    model: String,
    mode: SafetyMode,
    open: Mutex<HashMap<String, OpenCall>>,
}

impl TurnLog {
    pub fn new(log: Arc<AppLog>, backend: &str, model: &str, mode: SafetyMode) -> Self {
        Self {
            log,
            backend: backend.to_string(),
            model: model.to_string(),
            mode,
            open: Mutex::new(HashMap::new()),
        }
    }

    /// Takes note of one event of the turn.
    pub fn observe(&self, event: &AgentEvent) {
        match event {
            AgentEvent::ToolCallStarted {
                id,
                tool,
                arguments,
                sql,
                agent,
                ..
            } => {
                lock(&self.open).insert(
                    id.clone(),
                    OpenCall {
                        tool: tool.clone(),
                        sql: sql.clone(),
                        arguments: arguments.clone(),
                        agent: agent.clone(),
                    },
                );
            }
            AgentEvent::ToolCallFinished {
                id,
                is_error,
                text,
                elapsed_ms,
                ..
            } => {
                let call = lock(&self.open).remove(id);
                if !*is_error {
                    return;
                }
                let (tool, sql, arguments, agent) = match call {
                    Some(call) => (Some(call.tool), call.sql, Some(call.arguments), call.agent),
                    None => (None, None, None, None),
                };
                self.log.error(
                    "tool_call_failed",
                    json!({
                        "backend": self.backend,
                        "model": self.model,
                        "mode": self.mode.as_str(),
                        "tool": tool,
                        "subagent": agent,
                        // The statement says it all when there is one.
                        "sql": sql,
                        "arguments": if sql.is_some() { None } else { arguments },
                        "error": text,
                        "elapsedMs": elapsed_ms,
                    }),
                );
            }
            AgentEvent::Notice { message } => {
                self.log.warn(
                    "notice",
                    json!({ "backend": self.backend, "message": message }),
                );
            }
            _ => {}
        }
    }

    /// The turn ended. A turn that failed is logged with the reason. One
    /// that ended in the ordinary way is logged with its size, so that the
    /// failures beside it can be placed.
    pub fn finished(&self, outcome: &HostResult<TurnSummary>) {
        match outcome {
            Ok(summary) => self.log.info(
                "turn_finished",
                json!({
                    "backend": self.backend,
                    "model": self.model,
                    "mode": self.mode.as_str(),
                    "steps": summary.steps,
                    "toolCalls": summary.tool_calls,
                    "stopped": summary.stopped,
                    "stop": summary.stop,
                }),
            ),
            Err(err) => self.log.error(
                "turn_failed",
                json!({
                    "backend": self.backend,
                    "model": self.model,
                    "mode": self.mode.as_str(),
                    "kind": err.kind(),
                    "error": err.to_string(),
                }),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::super::backend::{StopReason, Usage};
    use super::*;
    use crate::error::HostError;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-turnlog-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// The records of a log, without the one written when it starts.
    fn records(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|record| record["event"] != "app_started")
            .collect()
    }

    fn started(id: &str, tool: &str, arguments: Value) -> AgentEvent {
        AgentEvent::ToolCallStarted {
            id: id.into(),
            tool: tool.into(),
            sql: arguments
                .get("sql")
                .and_then(Value::as_str)
                .map(str::to_string),
            arguments,
            agent: None,
            step: 1,
        }
    }

    fn finished(id: &str, is_error: bool, text: &str) -> AgentEvent {
        AgentEvent::ToolCallFinished {
            id: id.into(),
            is_error,
            text: text.into(),
            table: None,
            engine_notes: Vec::new(),
            elapsed_ms: 17,
        }
    }

    #[test]
    fn a_failed_call_is_logged_with_its_statement_and_what_came_back() {
        let dir = temp_dir("failed");
        let log = Arc::new(AppLog::start(&dir));
        let turn = TurnLog::new(
            log.clone(),
            "github_copilot",
            "small",
            SafetyMode::DeleteSafe,
        );

        turn.observe(&started(
            "c1",
            "run_select_query",
            json!({ "sql": "SELEC 1" }),
        ));
        turn.observe(&started(
            "c2",
            "run_select_query",
            json!({ "sql": "SELECT 1" }),
        ));
        turn.observe(&finished("c1", true, "syntax error at position 1"));
        turn.observe(&finished("c2", false, "| 1 |"));

        let written = records(log.path().unwrap());
        assert_eq!(written.len(), 1, "a call that worked is not logged");
        let record = &written[0];
        assert_eq!(record["event"], "tool_call_failed");
        assert_eq!(record["level"], "error");
        assert_eq!(record["tool"], "run_select_query");
        assert_eq!(record["sql"], "SELEC 1");
        assert_eq!(record["error"], "syntax error at position 1");
        assert_eq!(record["elapsedMs"], 17);
        assert_eq!(record["backend"], "github_copilot");
        assert_eq!(record["model"], "small");
        assert_eq!(record["mode"], "delete_safe");
        // The statement is there once, not again inside the arguments.
        assert!(record.get("arguments").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_call_with_no_statement_is_logged_with_its_arguments() {
        let dir = temp_dir("arguments");
        let log = Arc::new(AppLog::start(&dir));
        let turn = TurnLog::new(log.clone(), "gemini", "", SafetyMode::Safe);
        turn.observe(&AgentEvent::ToolCallStarted {
            id: "c1".into(),
            tool: "list_services".into(),
            arguments: json!({ "provider": "nope" }),
            sql: None,
            agent: Some("github-count".into()),
            step: 1,
        });
        turn.observe(&finished("c1", true, "no such provider"));
        // A result for a call that was never announced is still logged.
        turn.observe(&finished("c9", true, "who knows"));

        let written = records(log.path().unwrap());
        assert_eq!(written.len(), 2);
        assert_eq!(written[0]["arguments"], json!({ "provider": "nope" }));
        assert_eq!(written[0]["subagent"], "github-count");
        assert!(written[0].get("sql").is_none());
        assert_eq!(written[1]["error"], "who knows");
        assert!(written[1].get("tool").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn notices_and_the_end_of_the_turn_are_logged() {
        let dir = temp_dir("end");
        let log = Arc::new(AppLog::start(&dir));
        let turn = TurnLog::new(
            log.clone(),
            "anthropic",
            "claude-opus-5-5",
            SafetyMode::Safe,
        );
        turn.observe(&AgentEvent::Notice {
            message: "Stopped after 40 steps without a final answer.".into(),
        });
        // Text and the start of a session are not this log's business.
        turn.observe(&AgentEvent::AssistantText {
            text: "Here is the answer.".into(),
        });
        turn.finished(&Ok(TurnSummary {
            steps: 3,
            tool_calls: 2,
            stopped: false,
            stop: StopReason::EndTurn,
            usage: Usage::default(),
        }));
        turn.finished(&Err(HostError::Agent("The API key was rejected.".into())));

        let written = records(log.path().unwrap());
        assert_eq!(
            written
                .iter()
                .map(|record| record["event"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["notice", "turn_finished", "turn_failed"]
        );
        assert_eq!(written[0]["level"], "warn");
        assert_eq!(written[1]["toolCalls"], 2);
        assert_eq!(written[1]["stop"]["kind"], "endTurn");
        assert_eq!(written[2]["level"], "error");
        assert_eq!(written[2]["kind"], "agent");
        assert_eq!(written[2]["error"], "The API key was rejected.");
        let _ = std::fs::remove_dir_all(dir);
    }
}
