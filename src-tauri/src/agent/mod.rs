//! The agent runtime: the MCP client, the inference backends and the loop.
//!
//! This is the only part of the host that talks to a model, and the only
//! part that uses the engine's agent channel.
//!
//! There are two ways a turn runs. With an API key backend the host runs
//! the loop and is the MCP client. With a delegated agent, an agent the
//! operator installed runs the loop and is the MCP client, and the host
//! drives it over the Agent Client Protocol.

/// What a model is told about a result with no rows. One text for both
/// ways a turn runs.
///
/// The engine answers a provider call that returned nothing with an empty
/// result, whatever the reason was. That is by design. A lookup of one thing
/// that does not exist is an ordinary question with an ordinary answer, and
/// the engine speaks to providers over more than one protocol, so it does
/// not sort answers by status code. The same holds here: this text names no
/// protocol and no code. It tells the model what an empty result does and
/// does not show, and how to check before leaning on one.
macro_rules! empty_result_guidance {
    () => {
        "- An empty result means the query returned no rows. When you looked one thing up to see \
whether it exists, that is the answer: it does not exist, or you cannot see it. It is not proof \
that a provider has none of something. A provider can also return nothing when access is \
denied, when it is throttling, or when a parameter such as a region or project is wrong, and the \
engine does not tell these apart.\n\
- Before you tell the operator that a provider has none of something, or act on something being \
absent, check that the provider is answering in this conversation: an earlier query against the \
same provider and service returned rows, or a small query that should return rows does. If you \
cannot confirm it, say that the query returned no rows and that this is unconfirmed.\n\
- An empty result is never proof that a change happened. Query for the thing you changed.\n"
    };
}

pub mod acp;
pub mod approvals;
pub mod backend;
pub mod backends;
pub mod copilot;
pub mod delegate;
pub mod mcp;
pub mod runtime;
