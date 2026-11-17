//! Approval requests: the client side of the engine's approval flow.
//!
//! The engine decides what needs approval and asks through MCP elicitation.
//! This module only carries the question to the operator and the answer
//! back. It never answers on its own. There is no host-side rule about which
//! statements are safe, because the engine owns that decision.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::util::lock;

/// What the operator is asked to approve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    /// The engine's message, exactly as sent.
    pub message: String,
    /// The tool the model called, when the message names one.
    pub tool: Option<String>,
    /// The engine's classification, for example `mutation_delete`.
    pub query_class: Option<String>,
    /// The exact SQL, when the message carries it.
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    Decline,
    /// The prompt went away without an answer, for example because the
    /// operator stopped the turn.
    Cancel,
}

type Listener = Box<dyn Fn(ApprovalRequest) + Send + Sync>;

#[derive(Default)]
pub struct Approvals {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
    listener: Mutex<Option<Listener>>,
    next: AtomicU64,
}

impl Approvals {
    /// Sets who is shown new requests. With nobody listening a request is
    /// declined, because there is nobody to ask.
    pub fn set_listener(&self, listener: Option<Listener>) {
        *lock(&self.listener) = listener;
    }

    /// Asks the operator and waits for the answer, however long it takes.
    pub async fn ask(&self, message: String) -> ApprovalDecision {
        let id = format!("approval-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);

        let request = parse_request(id.clone(), message);
        let shown = match lock(&self.listener).as_ref() {
            Some(listener) => {
                listener(request);
                true
            }
            None => false,
        };
        if !shown {
            lock(&self.pending).remove(&id);
            return ApprovalDecision::Decline;
        }
        // The sender is dropped only if the request is discarded unanswered.
        rx.await.unwrap_or(ApprovalDecision::Cancel)
    }

    /// Delivers the operator's answer. Returns false if there is no such
    /// request, for example because it was already answered.
    pub fn resolve(&self, id: &str, decision: ApprovalDecision) -> bool {
        match lock(&self.pending).remove(id) {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    /// Cancels every request that is still waiting.
    pub fn cancel_all(&self) {
        let waiting: Vec<_> = lock(&self.pending).drain().collect();
        for (_, tx) in waiting {
            let _ = tx.send(ApprovalDecision::Cancel);
        }
    }

    pub fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }
}

/// Reads the tool, the class and the SQL out of the engine's message.
///
/// The message looks like this:
///
/// ```text
/// Approve run_mutation_query (mutation_delete)?
///
/// SQL: DELETE FROM ...
/// ```
///
/// The whole message is always shown as well, so nothing is lost if the
/// wording changes and these fields come back empty.
fn parse_request(id: String, message: String) -> ApprovalRequest {
    let first_line = message.lines().next().unwrap_or_default();
    let (tool, query_class) = first_line
        .strip_prefix("Approve ")
        .and_then(|rest| rest.strip_suffix('?'))
        .map(|rest| match rest.split_once(" (") {
            Some((tool, class)) => (
                Some(tool.trim().to_string()),
                class.strip_suffix(')').map(|c| c.trim().to_string()),
            ),
            None => (Some(rest.trim().to_string()), None),
        })
        .unwrap_or((None, None));
    let sql = message
        .split_once("\nSQL: ")
        .map(|(_, sql)| sql.trim().to_string())
        .filter(|sql| !sql.is_empty());
    ApprovalRequest {
        id,
        message,
        tool: tool.filter(|t| !t.is_empty()),
        query_class: query_class.filter(|c| !c.is_empty()),
        sql,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const MESSAGE: &str = "Approve run_mutation_query (mutation_delete)?\n\nSQL: DELETE FROM github.repos.repos WHERE owner = 'x' AND repo = 'y'";

    fn listening(approvals: &Approvals) -> Arc<Mutex<Vec<ApprovalRequest>>> {
        let seen: Arc<Mutex<Vec<ApprovalRequest>>> = Arc::default();
        let sink = seen.clone();
        approvals.set_listener(Some(Box::new(move |request| {
            sink.lock().unwrap().push(request);
        })));
        seen
    }

    #[test]
    fn the_engine_message_is_parsed() {
        let request = parse_request("a-1".into(), MESSAGE.into());
        assert_eq!(request.tool.as_deref(), Some("run_mutation_query"));
        assert_eq!(request.query_class.as_deref(), Some("mutation_delete"));
        assert_eq!(
            request.sql.as_deref(),
            Some("DELETE FROM github.repos.repos WHERE owner = 'x' AND repo = 'y'")
        );
        assert_eq!(request.message, MESSAGE);
    }

    #[test]
    fn multi_line_sql_is_kept_whole() {
        let request = parse_request(
            "a-1".into(),
            "Approve run_mutation_query (mutation_create)?\n\nSQL: INSERT INTO t\nSELECT 1,\n  2"
                .into(),
        );
        assert_eq!(
            request.sql.as_deref(),
            Some("INSERT INTO t\nSELECT 1,\n  2")
        );
    }

    #[test]
    fn an_unfamiliar_message_still_carries_its_text() {
        let request = parse_request("a-1".into(), "Do you want to proceed?".into());
        assert_eq!(request.tool, None);
        assert_eq!(request.query_class, None);
        assert_eq!(request.sql, None);
        assert_eq!(request.message, "Do you want to proceed?");
    }

    #[tokio::test]
    async fn a_request_waits_for_the_operator() {
        let approvals = Arc::new(Approvals::default());
        let seen = listening(&approvals);

        let asking = approvals.clone();
        let task = tokio::spawn(async move { asking.ask(MESSAGE.into()).await });

        // Nothing is decided until the operator answers.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!task.is_finished());
        assert_eq!(approvals.pending_count(), 1);

        let id = seen.lock().unwrap()[0].id.clone();
        assert!(approvals.resolve(&id, ApprovalDecision::Accept));
        assert_eq!(task.await.unwrap(), ApprovalDecision::Accept);
        assert_eq!(approvals.pending_count(), 0);
    }

    #[tokio::test]
    async fn with_nobody_listening_the_answer_is_decline() {
        let approvals = Approvals::default();
        assert_eq!(
            approvals.ask(MESSAGE.into()).await,
            ApprovalDecision::Decline
        );
        assert_eq!(approvals.pending_count(), 0);
    }

    #[tokio::test]
    async fn cancelling_answers_every_waiting_request() {
        let approvals = Arc::new(Approvals::default());
        let _seen = listening(&approvals);
        let a = approvals.clone();
        let b = approvals.clone();
        let first = tokio::spawn(async move { a.ask("one".into()).await });
        let second = tokio::spawn(async move { b.ask("two".into()).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        approvals.cancel_all();

        assert_eq!(first.await.unwrap(), ApprovalDecision::Cancel);
        assert_eq!(second.await.unwrap(), ApprovalDecision::Cancel);
    }

    #[tokio::test]
    async fn an_answer_is_accepted_once() {
        let approvals = Arc::new(Approvals::default());
        let seen = listening(&approvals);
        let asking = approvals.clone();
        let task = tokio::spawn(async move { asking.ask(MESSAGE.into()).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let id = seen.lock().unwrap()[0].id.clone();

        assert!(approvals.resolve(&id, ApprovalDecision::Decline));
        assert!(!approvals.resolve(&id, ApprovalDecision::Accept));
        assert!(!approvals.resolve("no-such-id", ApprovalDecision::Accept));
        assert_eq!(task.await.unwrap(), ApprovalDecision::Decline);
    }

    #[test]
    fn decisions_serialise_in_camel_case() {
        assert_eq!(
            serde_json::to_value(ApprovalDecision::Accept).unwrap(),
            serde_json::json!("accept")
        );
        assert_eq!(
            serde_json::from_value::<ApprovalDecision>(serde_json::json!("decline")).unwrap(),
            ApprovalDecision::Decline
        );
    }
}
