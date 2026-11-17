//! The error type that crosses IPC.

use serde::Serialize;

/// An error the webview can show. It serialises as `{ "kind": ..., "message": ... }`
/// so the UI can branch on the kind without parsing text.
#[derive(Debug, Clone, thiserror::Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum HostError {
    /// No `stackql` binary could be resolved.
    #[error("{0}")]
    EngineNotFound(String),
    /// The engine was found but did not start or did not become ready.
    #[error("{0}")]
    EngineStart(String),
    /// A request needed a running engine and there was none.
    #[error("The engine is not running.")]
    EngineNotRunning,
    /// The statement could not be sent or its result could not be read.
    #[error("{0}")]
    Query(String),
    /// A statement is already running on the editor session.
    #[error("A statement is already running.")]
    Busy,
    /// A name from the UI was not a valid identifier.
    #[error("{0}")]
    InvalidIdentifier(String),
    /// Settings could not be read or written.
    #[error("{0}")]
    Settings(String),
    /// The agent runtime failed.
    #[error("{0}")]
    Agent(String),
    /// A secret could not be read from or written to the OS keychain.
    #[error("{0}")]
    Secrets(String),
    /// Anything else.
    #[error("{0}")]
    Internal(String),
}

impl From<std::io::Error> for HostError {
    fn from(err: std::io::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

pub type HostResult<T> = Result<T, HostError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_with_kind_and_message() {
        let json = serde_json::to_value(HostError::EngineNotFound("nope".into())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "engineNotFound", "message": "nope" })
        );
    }

    #[test]
    fn unit_variants_serialise_with_kind_only() {
        let json = serde_json::to_value(HostError::Busy).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "busy" }));
    }
}
