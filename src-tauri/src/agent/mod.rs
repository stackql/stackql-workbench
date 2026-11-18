//! The agent runtime: the MCP client, the inference backends and the loop.
//!
//! This is the only part of the host that talks to a model, and the only
//! part that uses the engine's agent channel.
//!
//! There are two ways a turn runs. With an API key backend the host runs
//! the loop and is the MCP client. With a delegated agent, an agent the
//! operator installed runs the loop and is the MCP client, and the host
//! drives it over the Agent Client Protocol.

pub mod acp;
pub mod approvals;
pub mod backend;
pub mod backends;
pub mod copilot;
pub mod delegate;
pub mod mcp;
pub mod runtime;
