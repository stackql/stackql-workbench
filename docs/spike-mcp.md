# MCP spike

This note records how `stackql mcp` behaves over stdio when driven by the Rust MCP SDK, tested against a real binary. The agent runtime is built on these answers.

## Setup

The probe is `src-tauri/examples/mcp_spike.rs`. It starts the MCP server as a child process, keeps ownership of the process, and hands the SDK only the two pipes. That is how the host does it, because one supervisor has to own every child.

| Item | Value |
|---|---|
| Engine | `stackql v1.0.888 Windows (f7b4116)` |
| Client | `rmcp` 3.11.0, features `client` and `transport-async-rw` |
| Platform | Windows 11 x64 |
| Date | 2026-11-18 |
| Credentials | None. The one approved mutation targets a provider with no credentials and a repository that does not exist |

To reproduce, run this from `src-tauri`.

```
cargo run --example mcp_spike
```

## Summary

Each row is something the agent runtime relies on.

| Question | Answer |
|---|---|
| Does `rmcp` support the client side of elicitation? | Yes. `ClientHandler::create_elicitation` is called with the server's request and may take as long as it needs to answer |
| Does it support protocol revision negotiation? | Yes. Every revision offered was negotiated, and the negotiated value is readable afterwards |
| Can the host own the process? | Yes. A `(stdout, stdin)` pair is a valid transport, so the supervisor spawns the child and the SDK never does |
| What do tools return? | Rendered text for the model and a structured payload for programs. Row results are `{ "rows": [ { column: value } ] }` |
| How does approval arrive? | As a form elicitation whose message holds the tool, the query class and the exact SQL. The schema has no fields. Accept, decline and cancel all behave as documented |
| What if the client does not advertise elicitation? | Gated tools are refused with a message pointing at `full_access` |
| Upstream provider failures | **Hidden from the model.** The tool returns "no results" with no error. The reason is only on the server's stderr |
| Audit log | JSONL, one record per tool call, in the directory given by `server.audit.file.dir` |
| Shutdown | The server exits with code 0 when its stdin closes |

## Starting the server

The host starts the server like this. The config is inline JSON.

```
stackql mcp --mcp.server.type=stdio --approot <dir> --mcp.config '{"server":{"transport":"stdio","mode":"safe","audit":{"format":"jsonl","file":{"dir":"<dir>"}}}}'
```

On stderr the server prints the audit file it opened and a start line. Nothing but protocol frames goes to stdout.

```
sink file: <audit dir>\stackql_mcp_server_20261117T230717Z.log
[stackql mcp] 2026-11-17T23:07:17.2019176Z starting: version=1.0.888 platform=Windows pid=26460 transport=stdio ...
```

## Protocol revision negotiation

The client offered four revisions in turn. Each connected and listed all 15 tools.

```
offered 2024-11-05: connected in 360 ms, negotiated Some("2024-11-05"), server Some("stackql v0.1.1")
offered 2025-06-18: connected in 84 ms, negotiated Some("2025-06-18"), server Some("stackql v0.1.1")
offered 2025-11-25: connected in 88 ms, negotiated Some("2025-11-25"), server Some("stackql v0.1.1")
offered 2026-07-28: connected in 123 ms, negotiated Some("2025-11-25"), server Some("stackql v0.1.1")
```

Notes:

- `rmcp` offers `2026-07-28` by default, the revision with no `initialize` handshake. Against this server over stdio that settled on `2025-11-25`.
- The host offers `2025-11-25` explicitly (`ProtocolVersion::LATEST_WITH_INITIALIZE`). On that revision the approval prompt is a server-initiated `elicitation/create` request, which is the simpler of the two approval flows. The newer round-trip flow was also exercised and worked through the same handler.
- The server reports its own name and version as `stackql v0.1.1`, which is not the engine version. The engine version comes from the `server_info` tool.
- The handshake returns 25,106 characters of instructions. They are written for the model and the host passes them on as part of the system prompt.
- Connecting takes about 90 ms once the binary is warm.

## Tools

The server publishes 15 tools. Every one has a title and all four behaviour hints.

```
describe_method          args=[format, method, provider, resource, row_limit, service]   readOnly=true
list_methods             args=[format, method, provider, resource, row_limit, service]   readOnly=true
list_providers           args=[]                                                         readOnly=true
list_registry            args=[format, provider, version]                                readOnly=true  openWorld=true
list_resources           args=[format, method, provider, resource, row_limit, service]   readOnly=true
list_services            args=[format, method, provider, resource, row_limit, service]   readOnly=true
pull_provider            args=[format, provider, version]                                idempotent=true openWorld=true
query_library_get        args=[format, id, params]            required=[id]              readOnly=true
query_library_search     args=[format, include_mutations, intent, limit, provider, service, tags] required=[intent] readOnly=true
reload_credentials       args=[format, provider]                                         idempotent=true
run_lifecycle_operation  args=[format, row_limit, source, sql] required=[sql]            destructive=true openWorld=true
run_mutation_query       args=[format, row_limit, source, sql] required=[sql]            destructive=true openWorld=true
run_select_query         args=[format, row_limit, source, sql] required=[sql]            openWorld=true
server_info              args=[]                                                         readOnly=true
validate_select_query    args=[format, row_limit, source, sql] required=[sql]            readOnly=true
```

The input schemas are plain JSON Schema objects with `additionalProperties: false`. The host passes them to the inference backend unchanged.

```
run_select_query input schema: {"additionalProperties":false,"properties":{"format":{"description":"text content render format: markdown (default) or json","type":"string"},"row_limit":{"type":"integer"},"source":{...},"sql":{"type":"string"}},"required":["sql"],"type":"object"}
```

The `list_*` schemas mark nothing as required even where the tool needs a provider or a service. The server validates that itself and returns a tool error.

## Results

Every result has one text block and, on success, a structured payload.

```
> list_providers {}
    is_error=None text="| name | version | | |---|---| | | github | v26.08.00448 | ..."
    structured={"rows":[{"name":"github","version":"v26.08.00448"},{"name":"homebrew","version":"v25.01.00292"},{"name":"stackql_preview","version":"internal"}]}

> run_select_query {"sql":"SELECT name, license, versions FROM homebrew.formula.formula WHERE formula_name = 'wget'"}
    [307 ms] is_error=None text="| license | name | versions | ..."
    structured={"rows":[{"license":"GPL-3.0-or-later","name":"wget","versions":"{\"bottle\":true,\"head\":\"HEAD\",\"stable\":\"1.25.0\"}"}]}

> server_info {}
    structured={"build_date":"2026-11-05T00:26:03Z","commit":"f7b4116","is_read_only":false,"mode":"safe","platform":"Windows","provider_registry":"https://registry.stackql.app/providers","sql_backend":"sqlite3","transport":"stdio","version":"1.0.888"}

> pull_provider {"provider":"homebrew"}
    structured={"messages":["homebrew provider, version 'v25.01.00292' successfully installed"],"timestamp":"..."}
```

How the host uses them:

- The text block goes to the model. It is the form the server renders for that purpose.
- The structured `rows` go to the grid, so agent results appear in the same grid as editor results. Values are text, as on the pg wire channel.
- Row objects come back with their keys in alphabetical order, not in the order of the `SELECT` list. The grid therefore shows agent result columns alphabetically.

## Failures

A tool error is a normal result with `is_error` set and the reason in the text. A protocol error is reserved for things like an unknown tool.

```
> list_services {"provider":"no_such_provider"}
    is_error=Some(true) text="failed to extract query results: no provider document for ..."
> run_select_query {}
    is_error=Some(true) text="validating \"arguments\": validating root: required: missing properties: [\"sql\"]"
> no_such_tool {}
    protocol error: Mcp error: -32602: unknown tool "no_such_tool"
> run_select_query {"sql":"DELETE FROM github.repos.repos WHERE ..."}
    is_error=Some(true) text="tool \"run_select_query\" refused: mutation_delete statements run through run_mutation_query or run_lifecycle_operation"
```

An upstream provider failure is not an error at all. The statement below asked a provider API for something that does not exist and got HTTP 404. The model is told there were no results.

```
> run_select_query {"sql":"SELECT name FROM homebrew.formula.formula WHERE formula_name = 'no-such-formula-xyz-123'"}
    [940 ms] is_error=None text="**no results**"
    structured={"rows":[]}

server stderr:
  http response status code: 404, response body: <!DOCTYPE html> ...
```

This is the same behaviour found on the pg wire channel, and here it reaches a model that will reason from it. The host therefore watches the server's stderr during each tool call. When a line reporting an HTTP status appears, the host shows it to the operator beside the tool result and appends a short note to the text the model receives, so that an empty result caused by a failed call is not read as "there is nothing there".

## Approval

In `safe` mode a mutation produces a form elicitation. The message carries the tool, the query class and the exact SQL. The requested schema is an object with no properties, so there is nothing to fill in: the answer is the action alone.

```
> run_mutation_query {"sql":"DELETE FROM github.repos.repos WHERE owner = 'nobody-xyz' AND repo = 'nothing-xyz'"}
    elicitation request received:
      {
        "mode": "form",
        "message": "Approve run_mutation_query (mutation_delete)?\n\nSQL: DELETE FROM github.repos.repos WHERE owner = 'nobody-xyz' AND repo = 'nothing-xyz'",
        "requestedSchema": { "type": "object", "properties": {} }
      }
```

The three answers:

| Answer | Tool result |
|---|---|
| decline | `is_error`, `tool "run_mutation_query" refused: user declined approval` |
| cancel | `is_error`, `tool "run_mutation_query" refused: approval prompt was dismissed` |
| accept | The statement runs. Here it failed at the provider: `delete over HTTP error: 404 NOT FOUND` |

Other cases:

- A lifecycle operation asks the same way, with `(lifecycle)` as the class.
- A statement the server cannot parse is classed `unknown` and also asks for approval, even through `run_select_query`. `SELEC 1` produced `Approve run_select_query (unknown)?`. The approval card can therefore appear for a read tool.
- A client that does not advertise elicitation is refused: `server is in 'safe' mode and the MCP client does not support elicitation. Restart the server in 'full_access' mode if you trust this client, or use an elicitation-capable client`.
- In `read_only` mode the refusal is immediate: `refused: server is in 'read_only' mode`.

The host turns each elicitation into an approval card that shows the message and the SQL, and waits for the operator. It never answers on its own. If the operator stops the turn while a card is open, the answer is cancel.

## Audit log

The server writes one JSONL record per tool call into the directory from `server.audit.file.dir`. The file name is `stackql_mcp_server_<UTC timestamp to the second>.log`, so there is one file per server start, and servers started in the same second share one.

```
{"timestamp":"2026-11-18T10:07:21.4836763+11:00","tool":"list_providers","mode":"safe","decision":"allow","query_class":"select","duration_ms":1}
{"timestamp":"2026-11-18T10:07:21.4865902+11:00","tool":"run_mutation_query","mode":"safe","decision":"needs_approval_declined","query_class":"mutation_delete","sql":"DELETE FROM github.repos.repos WHERE owner = 'nobody-xyz' AND repo = 'nothing-xyz'","args":{"row_limit":0,"sql":"..."},"duration_ms":0,"error":"tool \"run_mutation_query\" refused: user declined approval"}
{"timestamp":"2026-11-18T10:07:21.300807+11:00","tool":"run_mutation_query","mode":"read_only","decision":"refuse_immediate","query_class":"mutation_delete","sql":"...","duration_ms":0,"error":"..."}
{"timestamp":"2026-11-18T10:07:21.205568+11:00","tool":"run_mutation_query","mode":"safe","decision":"needs_approval_unavailable", ...}
```

The decisions seen were `allow`, `needs_approval_declined`, `refuse_immediate` and `needs_approval_unavailable`. The activity pane reads these files. Result rows are never in them.

## Shutdown

Closing the client closes the server's stdin, and the server exits cleanly.

```
client closed: Ok(Cancelled)
server process after its stdin closed: Ok(Ok(ExitStatus(ExitStatus(0))))
```

The supervisor still kills the process if it is alive after that, and the job object or watchdog covers a force quit.

## Open items for the maintainer

- An upstream failure on the agent channel is reported to the model as an empty result. The host adds a note from stderr, but an error result from the server would be safer.
- Row objects lose the column order of the statement.
- The `list_*` tool schemas do not mark their required arguments.
