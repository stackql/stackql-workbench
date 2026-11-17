//! The agent runtime: the MCP client, the inference backends and the loop.
//!
//! This is the only part of the host that talks to a model, and the only
//! part that uses the engine's agent channel.

pub mod approvals;
pub mod backend;
pub mod backends;
pub mod mcp;
pub mod runtime;
