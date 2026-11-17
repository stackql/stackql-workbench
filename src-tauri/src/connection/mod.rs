//! The seam between the app and an engine.
//!
//! Everything above this trait talks to "a connection" and must not assume
//! the engine is a child process on this machine. `LocalConnection` is the
//! only implementation for now. A remote connection comes later and must not
//! need changes above this line.

pub mod local;

use futures_util::future::BoxFuture;
use serde::Serialize;
use tokio::sync::watch;

use crate::error::HostResult;
use crate::query::result::{QueryEvent, ResultSet, RunSummary};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    Stopped,
    Starting,
    Running,
    Failed,
}

/// What the status bar shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    /// Where the engine is. For a local engine, the path of the binary.
    pub location: Option<String>,
    /// How the location was found, for example "PATH" or "settings".
    pub location_source: Option<String>,
    pub version: Option<String>,
    /// The address statements are sent to.
    pub endpoint: Option<String>,
    /// Why the engine is not running, when it should be.
    pub error: Option<String>,
    /// The last lines the engine wrote to stderr. Shown with a failure.
    pub log_tail: Vec<String>,
}

impl EngineStatus {
    pub fn stopped() -> Self {
        Self {
            state: EngineState::Stopped,
            location: None,
            location_source: None,
            version: None,
            endpoint: None,
            error: None,
            log_tail: Vec::new(),
        }
    }
}

/// Receives the events of a run as they happen.
pub type EventSink = Box<dyn Fn(QueryEvent) + Send + Sync>;

pub trait Connection: Send + Sync + 'static {
    /// The current status.
    fn status(&self) -> EngineStatus;

    /// A receiver that changes whenever the status does.
    fn watch_status(&self) -> watch::Receiver<EngineStatus>;

    /// Brings the engine up. Returns the resulting status. A failure is
    /// reported in the status, not as an error, because it is a state the UI
    /// shows and the operator can act on.
    fn start(&self) -> BoxFuture<'_, EngineStatus>;

    /// Stops and starts the engine. This is also the only way to stop a
    /// statement that is running, since the engine has no cancel.
    fn restart(&self) -> BoxFuture<'_, EngineStatus>;

    /// Stops the engine. Called when the app exits.
    fn shutdown(&self) -> BoxFuture<'_, ()>;

    /// Runs the statements in `sql` in order on the operator's session,
    /// stopping at the first failure. Events go to `sink` as they happen.
    ///
    /// This is the human channel: the text was written or explicitly run by
    /// the operator.
    fn run(
        &self,
        run_id: String,
        sql: String,
        sink: EventSink,
    ) -> BoxFuture<'_, HostResult<RunSummary>>;

    /// Stops waiting for a run. Returns false if there is no such run.
    ///
    /// This does not stop the statement in the engine. See
    /// `docs/spike-pgwire.md`.
    fn abandon(&self, run_id: &str) -> bool;

    /// Runs one host-built statement on its own short-lived session and
    /// returns the whole result. Used for metadata. Never pass text from the
    /// webview here.
    fn fetch(&self, sql: String) -> BoxFuture<'_, HostResult<ResultSet>>;
}
