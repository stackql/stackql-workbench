# Spike: a delegated agent over ACP

This note records what was tested before building the delegated chat backend, the one in which an agent the operator already has installed and signed in to runs the model. It was run on Windows 11 x64 against GitHub Copilot CLI 1.0.113 and `stackql` v1.0.888, on 18 November 2026.

## Why

The API key backends need a key from an inference provider. An operator who already pays for a coding agent would rather use that. The Agent Client Protocol (ACP) lets one program drive another program's agent over stdio, and the agent keeps its own sign-in. Workbench never sees or handles that credential, which is what the inference rules in `CLAUDE.md` require.

The questions were whether the agent can be made to use only the Workbench's engine, in the Workbench's safety mode, and whether the engine's approval prompt survives the trip.

## Method

The probe is hand-built JSON-RPC over the stdio of `copilot --acp`, so no client library hides anything. The wire shapes were taken from the protocol documentation at agentclientprotocol.com and from `copilot help acp`, `copilot help mcp` and `copilot help permissions`.

Four prompts were sent in total, all on the cheapest model the account offers. Everything else below was learned from the handshake and from opening sessions, which use no quota.

## Findings

Each finding is something that was observed, not read.

| Question | Finding |
|---|---|
| Framing | One JSON-RPC message per line on stdout and stdin. Logs go to stderr or to `--log-dir` |
| Protocol version | `1` is offered and accepted |
| Sign-in | The CLI uses its own. `initialize` lists one method, `copilot-login`, which is to run `copilot login` in a terminal. There is nothing for the client to do or hold |
| Agent capabilities | `loadSession`, `sessionCapabilities.close` and `list`, `mcpCapabilities.http` and `sse`. No `systemPrompt` capability |
| `session/new` | Returns `sessionId`, `models.availableModels` with a usage multiplier per model, `models.currentModelId`, `modes` and `configOptions` |
| Choosing a model | `session/set_config_option` with `configId: "model"` works |
| MCP servers passed in `session/new` | A stdio server is rejected. The log says `Rejecting non-http/sse MCP server "..." from client`. The request still succeeds, and the session carries on with the servers from the operator's own Copilot configuration |
| MCP servers passed at start | `--additional-mcp-config @file` works, and a server named there replaces one of the same name from the operator's configuration |
| What the model can reach by default | A shell, file reads and writes, web fetch and every MCP server the operator has configured |
| Restricting tools | `--available-tools` with the names `stackql-<tool>` leaves the model with those tools only. The CLI reports the rest as disabled |
| Permission prompts | An MCP tool call asks through `session/request_permission` unless a rule allows it. `--allow-tool=stackql` allows the server's tools, and no prompt is sent |
| Tool calls | `tool_call` carries `toolCallId`, `title` (`stackql-run_select_query`), `kind` and `rawInput` with the arguments. Calls can run in parallel |
| Tool results | `tool_call_update` carries `status`, the rendered text, and `rawOutput.structuredContent` with the same `{ "rows": [...] }` payload the host gets when it is the MCP client. A failure carries `rawOutput.message` |
| Text | `agent_message_chunk` streams the reply in small pieces, each with a `messageId`. Lines the CLI itself adds, such as the list of disabled tools, come as chunks with no `messageId` |
| Approval prompts | Not relayed. See below |
| Audit log | The engine writes it as usual, to `server.audit.file.dir`. The activity pane needs no change |

## The approval prompt does not get through

In `safe` mode the engine asks for approval with an MCP elicitation, and refuses if the client cannot answer one. The Copilot CLI does not advertise elicitation to MCP servers in ACP mode. That held even when the ACP client advertised `elicitation.form`, the ACP capability for showing such a prompt.

The engine's answer to a gated statement was:

```
tool "run_mutation_query" refused: server is in 'safe' mode and the MCP client
does not support elicitation. Restart the server in 'full_access' mode if you
trust this client, or use an elicitation-capable client
```

The audit log recorded the decision as `needs_approval_unavailable`. Nothing was run.

So the engine fails closed. With this backend a statement that needs approval is refused, not asked about. What the modes come to is below.

| Mode | With an API key backend | With the Copilot CLI |
|---|---|---|
| `read_only` | Reads only | Reads only |
| `safe` | Changes ask for approval | Changes are refused |
| `delete_safe` | Inserts and updates run, deletes and `EXEC` ask | Inserts and updates run, deletes and `EXEC` are refused |
| `full_access` | Everything runs | Everything runs |

The host does not put a gate of its own in the way. The CLI's permission prompt could be shown as an approval card, but it works on tool names, not on what a statement does, and it would only matter with the engine in `full_access`. That would move the decision out of the engine, which `CLAUDE.md` rules out.

## What the host does

These follow from the findings.

- Starts `copilot --acp` itself, under the supervisor, with the engine's MCP server named in `--additional-mcp-config`. The server is called `stackql`, so it replaces an entry of that name in the operator's own configuration instead of running beside it.
- Passes `--available-tools` with the engine's tool names, read from the engine, so the model has no shell, no file access and no other MCP server.
- Passes `--allow-tool=stackql`, `--disable-builtin-mcps`, `--no-custom-instructions` and `--no-ask-user`.
- Passes the workspace safety mode to the engine as it does for the other backends. The mode is fixed when the CLI starts, so changing it starts a new CLI session.
- Declines any `session/request_permission`. With the flags above none is expected, and one would mean the agent is reaching for something outside the engine.
- Uses an empty folder under the app data directory as the session's working directory.

## Limits

These are known and accepted for now.

- No approval card with this backend. See above.
- The engine's stderr goes to the CLI, not to the host, so the operator is not shown what a provider said when a lookup found nothing. A call that fails is not affected: the engine returns it as a tool error, which the CLI passes on.
- The CLI keeps its own session history, so Workbench conversations appear there.
- A different ACP agent needs its own launcher. How the engine's MCP server is handed over, and how tools are restricted, is specific to each agent.
- ACP support in the Copilot CLI is in public preview.

## Open questions

These need an answer from outside this repository.

- Whether the Copilot CLI will relay MCP elicitation to an ACP client that advertises `elicitation.form`. If it does, the approval card works with no change to the engine.
- Whether the CLI will accept stdio MCP servers in `session/new`, as the protocol describes. That would remove the config file.
