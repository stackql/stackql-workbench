//! A client for the Agent Client Protocol, version 1, over a byte stream.
//!
//! ACP is JSON-RPC 2.0 with one message per line. An agent the operator
//! installed runs the model and the tools. This side sends prompts, receives
//! what the agent does as notifications, and answers the few requests an
//! agent may make of its client.
//!
//! It is written by hand. The part needed here is small, and the behaviour
//! that matters was observed against a real agent. See `docs/spike-acp.md`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::connection::{AgentChannel, LogBuffer};
use crate::util::lock;

/// The protocol revision this client speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// JSON-RPC: the method does not exist. The answer to a request this client
/// does not implement.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// ACP: the agent needs the operator to sign in first.
pub const AUTH_REQUIRED: i64 = -32000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AcpError {
    /// The agent answered a request with an error.
    #[error("{message}")]
    Rpc { code: i64, message: String },
    /// The agent went away.
    #[error("The agent closed the connection.")]
    Closed,
}

/// Something the agent sent that is not the answer to a request.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Notification {
        method: String,
        params: Value,
    },
    /// The agent asks something of its client. It waits for
    /// [`AcpClient::respond`] or [`AcpClient::respond_error`].
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, AcpError>>>>>;

pub struct AcpClient {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    diagnostics: LogBuffer,
    reader: tokio::task::JoinHandle<()>,
    /// Keeps the agent process alive. Dropping it ends the agent.
    _keepalive: Box<dyn std::any::Any + Send + Sync>,
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl AcpClient {
    /// Starts reading from the channel. Notifications and requests from the
    /// agent arrive on the returned receiver, in order.
    pub fn connect(channel: AgentChannel) -> (Arc<Self>, mpsc::UnboundedReceiver<Incoming>) {
        let AgentChannel {
            reader,
            writer,
            diagnostics,
            keepalive,
        } = channel;
        let pending: Pending = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();

        let task = tokio::spawn(read_loop(
            reader,
            pending.clone(),
            closed.clone(),
            incoming_tx,
        ));

        let client = Arc::new(Self {
            writer: tokio::sync::Mutex::new(writer),
            pending,
            next_id: AtomicU64::new(1),
            closed,
            diagnostics,
            reader: task,
            _keepalive: keepalive,
        });
        (client, incoming_rx)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// The last lines the agent wrote outside the protocol.
    pub fn diagnostics_tail(&self, lines: usize) -> Vec<String> {
        self.diagnostics.tail(lines)
    }

    async fn write(&self, message: &Value) -> Result<(), AcpError> {
        if self.is_closed() {
            return Err(AcpError::Closed);
        }
        // serde_json writes no raw newline inside a value, so one message is
        // one line, which is what the framing needs.
        let mut line = message.to_string();
        line.push('\n');
        let mut writer = self.writer.lock().await;
        let sent = async {
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await
        }
        .await;
        sent.map_err(|_| {
            self.closed.store(true, Ordering::SeqCst);
            AcpError::Closed
        })
    }

    /// Sends a request and waits for its answer, for as long as it takes. A
    /// prompt stays open for the whole turn.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id, tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(err) = self.write(&message).await {
            lock(&self.pending).remove(&id);
            return Err(err);
        }
        rx.await.unwrap_or(Err(AcpError::Closed))
    }

    /// Sends a notification. There is no answer to wait for.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), AcpError> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    /// Answers a request from the agent.
    pub async fn respond(&self, id: Value, result: Value) -> Result<(), AcpError> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    /// Refuses a request from the agent.
    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), AcpError> {
        self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }))
        .await
    }
}

async fn read_loop(
    reader: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
    pending: Pending,
    closed: Arc<AtomicBool>,
    incoming: mpsc::UnboundedSender<Incoming>,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Anything that is not a JSON object is not protocol. Skip it and
        // keep going: one stray line must not end the session.
        let Ok(Value::Object(mut message)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = message.remove("id").filter(|id| !id.is_null());
        if let Some(Value::String(method)) = message.remove("method") {
            let params = message.remove("params").unwrap_or(Value::Null);
            let item = match id {
                Some(id) => Incoming::Request { id, method, params },
                None => Incoming::Notification { method, params },
            };
            if incoming.send(item).is_err() {
                break;
            }
            continue;
        }
        // No method, so it is the answer to one of our requests.
        let Some(waiter) = id
            .as_ref()
            .and_then(Value::as_u64)
            .and_then(|id| lock(&pending).remove(&id))
        else {
            continue;
        };
        let outcome = match message.remove("error") {
            Some(error) => Err(AcpError::Rpc {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The agent reported an error without a message.")
                    .to_string(),
            }),
            None => Ok(message.remove("result").unwrap_or(Value::Null)),
        };
        let _ = waiter.send(outcome);
    }

    // The stream ended. Nothing that is waiting will get an answer now.
    closed.store(true, Ordering::SeqCst);
    let waiting: Vec<_> = lock(&pending).drain().collect();
    for (_, waiter) in waiting {
        let _ = waiter.send(Err(AcpError::Closed));
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! A scripted agent on the other end of an in-memory stream.

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

    use super::*;

    pub struct FakeAgent {
        lines: tokio::io::Lines<BufReader<ReadHalf<DuplexStream>>>,
        writer: WriteHalf<DuplexStream>,
    }

    /// A connected client and the agent it talks to.
    pub fn pair() -> (Arc<AcpClient>, mpsc::UnboundedReceiver<Incoming>, FakeAgent) {
        let (ours, theirs) = tokio::io::duplex(1 << 16);
        let (our_read, our_write) = tokio::io::split(ours);
        let (client, incoming) = AcpClient::connect(AgentChannel {
            reader: Box::new(our_read),
            writer: Box::new(our_write),
            diagnostics: LogBuffer::default(),
            keepalive: Box::new(()),
        });
        (client, incoming, FakeAgent::over(theirs))
    }

    impl FakeAgent {
        /// An agent on one end of an in-memory stream.
        pub fn over(stream: DuplexStream) -> Self {
            let (read, write) = tokio::io::split(stream);
            Self {
                lines: BufReader::new(read).lines(),
                writer: write,
            }
        }

        /// The next message the client sent.
        pub async fn receive(&mut self) -> Value {
            let line = self
                .lines
                .next_line()
                .await
                .expect("read from client")
                .expect("client closed");
            serde_json::from_str(&line).expect("client sent JSON")
        }

        /// Receives a request for `method` and returns its id and params.
        pub async fn expect(&mut self, method: &str) -> (Value, Value) {
            let message = self.receive().await;
            assert_eq!(message["method"], method, "unexpected message {message}");
            (message["id"].clone(), message["params"].clone())
        }

        pub async fn send(&mut self, message: Value) {
            let mut line = message.to_string();
            line.push('\n');
            self.writer.write_all(line.as_bytes()).await.expect("write");
        }

        pub async fn send_raw(&mut self, text: &str) {
            self.writer.write_all(text.as_bytes()).await.expect("write");
        }

        pub async fn result(&mut self, id: Value, result: Value) {
            self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                .await;
        }

        pub async fn error(&mut self, id: Value, code: i64, message: &str) {
            self.send(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message }
            }))
            .await;
        }

        pub async fn update(&mut self, session: &str, update: Value) {
            self.send(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": { "sessionId": session, "update": update }
            }))
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::pair;
    use super::*;

    #[tokio::test]
    async fn a_request_gets_its_own_answer() {
        let (client, _incoming, mut agent) = pair();
        let asking = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request("initialize", json!({ "protocolVersion": 1 }))
                    .await
            }
        });

        let (id, params) = agent.expect("initialize").await;
        assert_eq!(params["protocolVersion"], 1);
        agent.result(id, json!({ "protocolVersion": 1 })).await;

        let answer = asking.await.unwrap().unwrap();
        assert_eq!(answer["protocolVersion"], 1);
    }

    #[tokio::test]
    async fn answers_are_matched_by_id_not_by_order() {
        let (client, _incoming, mut agent) = pair();
        let first = tokio::spawn({
            let client = client.clone();
            async move { client.request("a", Value::Null).await }
        });
        let (first_id, _) = agent.expect("a").await;
        let second = tokio::spawn({
            let client = client.clone();
            async move { client.request("b", Value::Null).await }
        });
        let (second_id, _) = agent.expect("b").await;

        agent.result(second_id, json!("for b")).await;
        agent.result(first_id, json!("for a")).await;

        assert_eq!(first.await.unwrap().unwrap(), json!("for a"));
        assert_eq!(second.await.unwrap().unwrap(), json!("for b"));
    }

    #[tokio::test]
    async fn an_error_answer_carries_its_code_and_message() {
        let (client, _incoming, mut agent) = pair();
        let asking = tokio::spawn({
            let client = client.clone();
            async move { client.request("session/new", json!({})).await }
        });
        let (id, _) = agent.expect("session/new").await;
        agent
            .error(id, AUTH_REQUIRED, "Authentication required")
            .await;

        assert_eq!(
            asking.await.unwrap().unwrap_err(),
            AcpError::Rpc {
                code: AUTH_REQUIRED,
                message: "Authentication required".to_string()
            }
        );
    }

    #[tokio::test]
    async fn notifications_and_requests_from_the_agent_arrive_in_order() {
        let (client, mut incoming, mut agent) = pair();
        agent
            .update("s1", json!({ "sessionUpdate": "agent_message_chunk" }))
            .await;
        agent
            .send(json!({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "session/request_permission",
                "params": { "sessionId": "s1" }
            }))
            .await;

        match incoming.recv().await.unwrap() {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "session/update");
                assert_eq!(params["sessionId"], "s1");
            }
            other => panic!("expected a notification, got {other:?}"),
        }
        let Incoming::Request { id, method, .. } = incoming.recv().await.unwrap() else {
            panic!("expected a request");
        };
        assert_eq!(method, "session/request_permission");
        // Id 0 is a real id. It must not be mistaken for "no id".
        assert_eq!(id, json!(0));

        client
            .respond(id, json!({ "outcome": { "outcome": "cancelled" } }))
            .await
            .unwrap();
        let answer = agent.receive().await;
        assert_eq!(answer["id"], 0);
        assert_eq!(answer["result"]["outcome"]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn an_unsupported_request_can_be_refused() {
        let (client, _incoming, mut agent) = pair();
        client
            .respond_error(json!(7), METHOD_NOT_FOUND, "Method not found")
            .await
            .unwrap();
        let answer = agent.receive().await;
        assert_eq!(answer["id"], 7);
        assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn lines_that_are_not_protocol_are_skipped() {
        let (client, mut incoming, mut agent) = pair();
        agent.send_raw("some banner text\n\n[1, 2]\n").await;
        agent
            .send(json!({ "jsonrpc": "2.0", "method": "ping", "params": {} }))
            .await;
        match incoming.recv().await.unwrap() {
            Incoming::Notification { method, .. } => assert_eq!(method, "ping"),
            other => panic!("expected the notification, got {other:?}"),
        }
        assert!(!client.is_closed());
    }

    #[tokio::test]
    async fn every_message_is_one_line_even_with_newlines_in_the_text() {
        let (client, _incoming, mut agent) = pair();
        client
            .notify("session/cancel", json!({ "note": "line one\nline two" }))
            .await
            .unwrap();
        let message = agent.receive().await;
        assert_eq!(message["params"]["note"], "line one\nline two");
        assert!(message.get("id").is_none(), "a notification has no id");
    }

    #[tokio::test]
    async fn the_agent_going_away_fails_what_is_waiting() {
        let (client, mut incoming, mut agent) = pair();
        let asking = tokio::spawn({
            let client = client.clone();
            async move { client.request("session/prompt", json!({})).await }
        });
        agent.expect("session/prompt").await;
        drop(agent);

        assert_eq!(asking.await.unwrap().unwrap_err(), AcpError::Closed);
        assert!(incoming.recv().await.is_none());
        assert!(client.is_closed());
        assert_eq!(
            client.request("session/prompt", json!({})).await,
            Err(AcpError::Closed)
        );
    }
}
