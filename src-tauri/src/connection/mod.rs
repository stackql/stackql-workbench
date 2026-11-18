//! The seam between the app and an engine.
//!
//! Everything above this trait talks to "a connection" and must not assume
//! the engine is a child process on this machine. `LocalConnection` is the
//! only implementation for now. A remote connection comes later and must not
//! need changes above this line.

pub mod local;

use std::any::Any;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;

pub use crate::engine::logbuf::LogBuffer;
use crate::error::HostResult;
use crate::query::result::{QueryEvent, ResultSet, RunSummary};

/// The workspace safety setting. It maps directly onto the MCP server's
/// `server.mode`. The engine does the classification and the gating. The
/// host only passes the mode on and renders the approval prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyMode {
    ReadOnly,
    #[default]
    Safe,
    DeleteSafe,
    FullAccess,
}

impl SafetyMode {
    /// The value the engine expects in `server.mode`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Safe => "safe",
            Self::DeleteSafe => "delete_safe",
            Self::FullAccess => "full_access",
        }
    }
}

/// A byte stream to the engine's MCP server, for the agent runtime only.
///
/// For a local engine this is the stdio of a child process. For a remote
/// engine it would be something else, which is why the agent runtime gets
/// streams and not a process.
pub struct AgentChannel {
    /// Protocol frames from the server.
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    /// Protocol frames to the server.
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// What the server writes outside the protocol. Upstream failures show
    /// up here and nowhere else.
    pub diagnostics: LogBuffer,
    /// Keeps the channel open. Dropping it tears the channel down.
    pub keepalive: Box<dyn Any + Send + Sync>,
}

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
    /// Where the engine keeps its provider cache, when that is a folder on
    /// this machine.
    pub data_folder: Option<String>,
    /// How the data folder was chosen, for example "settings".
    pub data_folder_source: Option<String>,
    /// Set when the data folder is not the one the operator would expect,
    /// with the reason.
    pub data_folder_note: Option<String>,
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
            data_folder: None,
            data_folder_source: None,
            data_folder_note: None,
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

    /// Opens the agent channel: a fresh MCP server session in the given
    /// safety mode. Statements sent here originate from a model, so this is
    /// kept apart from the operator's channel on purpose.
    fn open_agent_channel(&self, mode: SafetyMode) -> BoxFuture<'_, HostResult<AgentChannel>>;

    /// The directory the engine writes its agent audit log to, if it keeps
    /// one where the host can read it.
    fn audit_dir(&self) -> Option<std::path::PathBuf>;
}
