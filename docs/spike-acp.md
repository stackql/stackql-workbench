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

## Subagents

This was tested on 18 November 2026, on the same versions, to see whether the CLI's subagents can be allowed without giving up the restriction to the engine. Three prompts were sent to the probe and two through the app.

The short version: allowing them is safe, and it is not yet dependable. They are off unless the operator turns them on.

The CLI has a `task` tool that starts a subagent. It is one of the tools the restriction above turns off. Adding `task` to `--available-tools` brings it back and nothing else.

| Question | Finding |
|---|---|
| What a subagent can use | The engine's tools and `task`. Asked to run a shell command and to create a file, a subagent had no tool for either. No permission was requested and nothing was written |
| Which engine a subagent talks to | The same MCP server process as the main agent. One audit file was opened for the session, and `server_info` called from a subagent reported the mode the server was started in |
| How a start is reported | A `tool_call` whose `rawInput` has `agent_type: "task"`, with `name`, `description` and `prompt`. Its result, when the subagent is done, is the subagent's report |
| How a subagent's work is reported | Its tool calls and message chunks are ordinary `session/update` messages that carry `_meta["github.com/copilot"].agentId`. The main agent's carry no `_meta` |
| Naming a subagent | Asking for `subagent.started` at the handshake, under `clientCapabilities._meta["github.com/copilot"].events`, gives a `github.com/copilot/sessionEvent` notification with the `agentId`, a display name, the call that started it and the model |
| Kinds of subagent | Three: `general-purpose`, `task` and `explore`. The model picks one with `agent_type`. See the table below |
| Running together | Two subagents started in one step ran at the same time |
| Nesting | A subagent can start subagents. One that could not do its job did so, and the CLI stopped it at depth four with `Maximum sub-agent depth of 4 reached` |

The three kinds were each asked to run a shell command, to create a file, and to call an engine tool.

| Kind | Shell | File write | Engine tools | Model |
|---|---|---|---|---|
| `general-purpose` | No | No | Yes | The session's model |
| `task` | No | No | Yes | `gpt-6-luna`, the agent definition's default |
| `explore` | No | No | No | `gpt-6-luna` |

So the restriction holds for every kind, and only two of them are of use here. This matters in practice. Left to choose, the model once picked `explore` in background mode. Those subagents could not reach the engine, their results had to be read back with a tool the agent does not have under this tool list, and the main agent ended up doing the lookups itself. The answer was right and the subagents were wasted.

A subagent that lacks a tool for its job tends to start a `task` subagent to try again, even when told not to. That is what the depth limit catches.

After the agent was told which kind to use, the same question was asked again without naming subagents. The model did the two lookups itself, at the same time, and got a large result. The CLI keeps a large tool result in a temporary file and tells the model to read it, and the model has no tool that reads files here. It then started a subagent to count the result. That subagent could not read the file either and started another, four deep, twice. Ten subagents ran, the turn took 108 seconds, and the count it gave was wrong. Earlier, the same question had been answered correctly in 27 seconds.

So what the model reached for subagents to do was not the dividing of independent work. It was a way out when it was stuck, and with the `task` tool to hand a stuck model costs more than without it. That was one small model, `claude-haiku-4.5`. A larger one was not tried.

What the host does with this:

- Leaves subagents off unless the operator turns them on in settings, where the setting is marked experimental.
- Adds `task` to the tool list when they are on.
- Tells the agent in the first prompt when to use them: for independent lookups only, never for a change, no more than four at once, and not from inside a subagent.
- Tells it how: `agent_type` `general-purpose`, `mode` `sync`, started in one step so they run together, and not the `explore` kind or background mode.
- Shows the start of a subagent with its task, and marks each tool call with the subagent that made it.
- Leaves a subagent's own message text out of the conversation. It arrives whole as the result of the call that started the subagent.
- Stops a turn in which a subagent starts a subagent of its own, at the first one, and says why. In every run where that happened the subagent had been unable to do its job.
- Stops a turn that starts more than 12 subagents, and says why.

## Token counts

This was tested on 19 November 2026 against GitHub Copilot CLI 1.0.114, to see whether the agent says what a turn used. One prompt was sent to the probe, on the cheapest model, and one through the app. The prompt to the probe made the model call one engine tool, so the turn took two calls to the model.

| Question | Finding |
|---|---|
| Does the answer to `session/prompt` carry a count | Yes. Beside `stopReason` it has `usage`, with `inputTokens`, `outputTokens`, `totalTokens`, `thoughtTokens`, `cachedReadTokens` and `cachedWriteTokens` |
| What the count covers | The whole turn, not one call to the model. The run observed gave `inputTokens` 19353 for two calls, while the context window held a little over 9,000 tokens at each |
| Whether the input count holds cached tokens | It did. 19353 was the 9533 read from the cache, the 9805 written to it, and 15 more |
| Whether thinking is in the total | `totalTokens` was `inputTokens` plus `outputTokens`. `thoughtTokens` was 46 and was not added on top, so it is either part of the output count or left out of the total |
| Anything while the turn runs | A `usage_update` after each call to the model, with `used` and `size`: how much of the model's context window the session takes up, 9,343 of 128,000 after the second call. It is not a count of what the turn used |

What the host does with this:

- Reads `inputTokens`, `outputTokens` and `cachedReadTokens` from the answer to the prompt, as the turn's use. The input count is taken as the whole input, cached or not, which is what the other backends report too.
- Does not add `thoughtTokens` to anything, since the run did not show whether the output count already holds it.
- Ignores `usage_update`. How full the context window is would be worth showing one day. It is a different number from what a turn used.

Whether the tokens of a subagent are in the turn's count was not tested.

On this backend the count is not what the operator pays. The plan is billed by the request, with a multiplier for the model, and the settings pane shows that multiplier. The count still says how large a turn was.

## Limits

These are known and accepted for now.

- No approval card with this backend. See above.
- The engine's stderr goes to the CLI, not to the host, so the operator is not shown what a provider said when a lookup found nothing. A call that fails is not affected: the engine returns it as a tool error, which the CLI passes on.
- The CLI keeps its own session history, so Workbench conversations appear there.
- A different ACP agent needs its own launcher. How the engine's MCP server is handed over, and how tools are restricted, is specific to each agent.
- What subagents cost was not measured. `--usage-output-file` cannot be combined with `--acp`. The CLI's help says subagents count on usage-based billing, and that on request-based billing a prompt costs one request.
- The model a subagent runs on cannot be set over ACP. Asking for the `general-purpose` kind gets the session's model. The agent can still choose another kind.
- ACP support in the Copilot CLI is in public preview.

## Open questions

These need an answer from outside this repository.

- Whether the Copilot CLI will relay MCP elicitation to an ACP client that advertises `elicitation.form`. If it does, the approval card works with no change to the engine.
- Whether the CLI will accept stdio MCP servers in `session/new`, as the protocol describes. That would remove the config file.
