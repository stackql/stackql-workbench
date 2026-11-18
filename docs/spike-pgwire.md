# pg wire spike

This note records how `stackql srv` behaves on the Postgres wire protocol, tested against a real binary. Later milestones build on these answers, so each one comes with the evidence it rests on.

## Setup

The probe is `src-tauri/examples/pgwire_spike.rs`. It starts the engine itself on a free loopback port with a scratch `--approot`, then talks to it two ways: with hand-built protocol frames, so no client library hides anything, and through `tokio-postgres` 0.7.18, the client the host uses.

| Item | Value |
|---|---|
| Engine | `stackql v1.0.888 Windows (f7b4116)`, build date 2026-11-05 |
| Platform | Windows 11 x64 |
| Client | `tokio-postgres` 0.7.18 with `NoTls` |
| Date | 2026-11-18 |
| Credentials | None. Statements use provider metadata and two providers that serve public data without authentication (`homebrew`, `github`) |

To reproduce, run this from `src-tauri`. `--only <section>` runs one section.

```
cargo run --example pgwire_spike
```

Nothing here has been run on macOS. The wire behaviour is engine code and is expected to match, but the readiness timings are from Windows only.

## Summary

Each row is an answer to one of the spike questions. The sections below hold the evidence.

| Question | Answer |
|---|---|
| Does `tokio-postgres` connect cleanly? | Yes, with `NoTls`. No password, no TLS, any user and database name accepted |
| Startup, auth, TLS | `AuthenticationOk` straight away, six `ParameterStatus` messages, **no `BackendKeyData`**. An `SSLRequest` is answered `N` |
| Query protocols | Simple protocol only. The extended protocol is not usable through `tokio-postgres` |
| Several statements in one message | **Only the first statement runs. The rest are dropped without an error.** The cut is at the first semicolon, even inside a string literal |
| Identifier quoting | Double quotes, accepted in every metadata statement. Backticks are rejected |
| Column type information | Every column is type OID 25 (`text`) in text format. The one exception seen is `count(*)`, which is OID 1700 (`numeric`). `typlen` is 1024 for everything |
| Are values text? | Yes, always. Booleans arrive as `true`/`false`, numbers as digits, objects and arrays as JSON text |
| NULL | `SELECT NULL` arrives as an empty string, not as a protocol NULL |
| Row count | The command tag is `OK`, with no count. The client must count rows |
| Do rows stream? | No. All rows arrive together when the statement finishes |
| Concurrent connections | Work. Results are correct per connection. Provider calls are serialised across connections, metadata statements are not blocked |
| Are sessions independent? | Errors and notices are per connection. Tables are shared across connections |
| Cancel | **Not supported.** A cancel request has no effect, and closing the connection does not stop the work either |
| Errors | `ErrorResponse` with severity `ERROR`, code `XXUUU` every time, and a message. No position, detail or hint. The connection stays usable |
| Upstream provider failures | By default: an empty, successful result, and the reason only on the engine's stderr. With `--pgsrv.debug.enable`: the reason arrives as a pg notice instead |
| Readiness | 80 to 135 ms from spawn. A successful connect followed by `SHOW VERSION` is a reliable check. Each connect attempt needs its own short timeout |

## Startup, auth and TLS

The server asks for nothing. It replies `AuthenticationOk` to any startup message, including one with no parameters at all, and reports itself as server version `150000`.

```
SSLRequest reply: 'N' (S = TLS, N = no TLS)
startup params [("user", "stackql"), ("database", "stackql")]:
  Authentication code=0 (0 = AuthenticationOk)
  ParameterStatus server_encoding=UTF8
  ParameterStatus client_encoding=UTF8
  ParameterStatus standard_conforming_strings=on
  ParameterStatus is_superuser=off
  ParameterStatus session_authorization=stackql
  ParameterStatus server_version=150000
  ReadyForQuery status=I
startup params [("user", "anyone")]:
  ... identical, session_authorization=anyone
startup params [("user", "stackql"), ("database", "nonexistent_db"), ("application_name", "spike"), ("client_encoding", "UTF8")]:
  ... identical
startup params []:
  ... identical, session_authorization=
tokio-postgres connect (user only, NoTls): ok, server_version=Some("150000"), client_encoding=Some("UTF8")
```

Three things follow from this.

- There is no authentication on the listener unless mTLS is configured with `--pgsrv.tls`. Binding to `127.0.0.1` is the only protection, so the host must always pass `--pgsrv.address 127.0.0.1`. Any local process can connect. The open question about a per-launch client certificate stays open.
- `tokio-postgres` with `NoTls` sends no `SSLRequest` under either `SslMode::Disable` or `SslMode::Prefer`. That was read from its `connect_tls.rs`. The host sets `SslMode::Disable` to make the intent explicit.
- The server never sends `BackendKeyData`. `tokio-postgres` therefore holds process id 0 and secret key 0, and a cancel request cannot name a session. See the cancel section.

## Query protocols

The simple protocol works. `tokio-postgres` returns a `RowDescription`, the rows as text and a `CommandComplete`.

```
-- simple protocol through tokio-postgres
  RowDescription ["name", "version"]
  Row [Some("github"), Some("v26.08.00448")]
  Row [Some("homebrew"), Some("v25.01.00292")]
  Row [Some("stackql_preview"), Some("internal")]
  CommandComplete 0
```

`CommandComplete 0` is `tokio-postgres` parsing the tag `OK`, which carries no row count. The host counts rows itself.

The extended protocol does not work through `tokio-postgres`. `Parse` and `Describe` are accepted, but `Describe` reports no parameters and no columns, even for a statement containing `$1`. The server then sends the `RowDescription` during `Execute`, which PostgreSQL never does, and `tokio-postgres` rejects it.

```
-- extended protocol: prepare (Parse, Describe, Sync)
  prepare ok: SHOW PROVIDERS -> params [], columns []
  prepare ok: SELECT name FROM homebrew.formula.formula WHERE formula_name = $1 -> params [], columns []
-- extended protocol: query without parameters
  query failed: non-db error: unexpected message from server (closed=false)
-- extended protocol: query with a text parameter
  query failed: non-db error: expected 0 parameters but got 1 (closed=false)
-- extended protocol: query_typed (no separate prepare round trip)
  query_typed failed: non-db error: unexpected message from server (closed=false)

> Parse/Describe/Bind/Describe/Execute/Sync SHOW PROVIDERS   (raw frames)
  RowDescription messages 1, rows 3, tags ["OK"], ready Some('I')
  other  ["ParseComplete", "ParameterDescription []", "NoData", "BindComplete", "NoData"]
```

The raw frames show the server does implement the extended flow in its own way, which is why other drivers can use it. It is not usable from this client. The host uses the simple protocol only, so statements are never parameterised. Explorer statements are built in the host from validated identifiers, not from interpolated UI input.

### Several statements in one message

This is the finding most likely to surprise. When a simple query message holds more than one statement, the server runs the first and silently drops the rest. A syntax error in a later statement is not reported.

```
> SHOW VERSION; SHOW PROVIDERS;
  RowDescription messages 1, rows 1, tags ["OK"], ready Some('I')
  column version
  row    ["1.0.888"]

> SHOW VERSION; SELEC 1; SHOW PROVIDERS;
  RowDescription messages 1, rows 1, tags ["OK"], ready Some('I')
  row    ["1.0.888"]
```

The host must split editor text into statements and send them one at a time. `stackql exec` does run every statement in its input, so this is specific to `srv`.

The cut is made at the first semicolon in the message, with no regard for quoting. A semicolon inside a string literal ends the statement there, and what is left fails to parse. `stackql exec` handles the same text correctly.

```
> SELECT 1 AS one, 'a;b' AS s          (sent through srv)
  ERROR  query returns error: ... syntax error at position 20 near 'a'

> stackql exec "SELECT 1 AS one, 'a;b' AS s"
  [{"one":"1","s":"a;b"}]
```

The host's splitter respects string literals, quoted identifiers and comments, so it never cuts a statement in the wrong place. It cannot rescue a literal that contains a semicolon, because the engine cuts it again. Such a statement fails with a syntax error until the engine is fixed.

Other edge cases, for completeness: an empty string and a lone `;` both get `EmptyQueryResponse`. A message holding only a comment gets a `RowDescription` with no columns and the tag `OK`. A trailing `;` or a trailing `--` comment is fine.

## Column types and values

Every column of every metadata statement and every provider `SELECT` came back as type OID 25 with format code 0, which is text. `typlen` is 1024 and `table_oid` and `attnum` are 0, none of which match PostgreSQL. The host must not interpret them.

```
> SELECT 1 AS one, 'x' AS s, 1.5 AS f, NULL AS n, 1 = 1 AS b
  column one   type_oid=25  typlen=1024 typmod=-1 format=0 table_oid=0 attnum=0
  column s     type_oid=25  ...
  column f     type_oid=25  ...
  column n     type_oid=25  ...
  column b     type_oid=25  ...
  row    ["1", "x", "1.5", "", "1"]

> SELECT name, deprecated, versions, aliases, revision, tap FROM homebrew.formula.formula WHERE formula_name = 'wget'
  row    ["wget", "false", "{\"bottle\":true,\"head\":\"HEAD\",\"stable\":\"1.25.0\"}", "[]", "2", "homebrew/core"]

> SELECT count(*) AS n FROM github.repos.repos WHERE org = 'stackql'
  column n     type_oid=1700 typlen=1024 typmod=-1 format=0
  row    ["68"]
```

Consequences for the grid:

- Treat every value as text. Type OIDs say nothing useful, so the grid detects JSON by looking at the value: a cell that starts with `{` or `[` and parses is offered in the cell viewer.
- `NULL` and the empty string cannot be told apart. `SELECT NULL` produced a zero-length value, not the protocol NULL marker. The host still maps a protocol NULL to `null` in case the engine sends one, but the grid cannot promise to show NULLs.
- A statement with no matching rows still returns its `RowDescription`, so the grid can show headers for an empty result.

## Rows do not stream

Rows are buffered in the engine and sent together at the end. The probe used `simple_query_raw`, which yields messages as they arrive, on a statement that makes twelve provider calls in sequence.

```
-- simple_query_raw: do rows arrive incrementally?
   2774 ms RowDescription
   2774 ms Row Some("wget")
   2774 ms Row Some("curl")
   ...
   2774 ms Row Some("xz")
   2774 ms CommandComplete 0
```

Everything, including the `RowDescription`, arrived at 2774 ms. The host still forwards rows to the webview in batches, because a large result should not cross IPC as one message, but the operator sees nothing until the statement completes. A progress indicator is honest. A partial grid is not possible.

## Concurrent connections and sessions

Several connections work at once and each gets its own correct result.

```
backend key data per connection: [(None, None), (None, None), (None, None), (None, None)]
one connection, 8 upstream calls: 191 ms, rows 8
four connections at once, wall time 1841 ms
  conn 0: 109 ms, rows 8, correct rows true, errors 0
  conn 1: 956 ms, rows 8, correct rows true, errors 0
  conn 2: 1810 ms, rows 8, correct rows true, errors 0
  conn 3: 1840 ms, rows 8, correct rows true, errors 0
metadata statement issued 300 ms into a 2067 ms statement on another connection: finished at 305 ms (took 2 ms)
```

The four statements finished one after another, not together, which fits the engine's default `--execution.concurrency.limit 1`: provider calls queue across connections. The timings are also affected by the upstream API serving repeat requests faster, so treat the numbers as indicative. A metadata statement on a second connection was not held up by a slow statement on the first. That is what the explorer needs.

Session independence is partial.

```
error on A (errors 1), then B still fine: true
> [A] SET SESSION "$.auth.github.type" = 'null_auth'      tags ["OK"]
> [A] SHOW TRANSACTION ISOLATION LEVEL                    row ["read committed"]
> [A] BEGIN                                               tags ["OK"]
> [A] COMMIT                                              tags ["OK"]
> [A] CREATE TABLE spike_t (id int)                       tags ["OK"]
> [A] SELECT * FROM spike_t                               column id, rows 0
> [B] SELECT * FROM spike_t                               column id, rows 0
B after A closed: rows 1, errors 0
```

- An error on one connection does not disturb another, and closing one leaves the other working.
- A table created on connection A is visible on connection B. The SQL backend is shared by the whole engine process.
- `SET SESSION` is accepted. Whether its effect is limited to the connection was not tested, because observing it needs provider credentials. The notice buffer is per connection, see below, so some per-connection state exists.

The host keeps one long-lived connection for the editor, so that whatever session state the engine holds behaves as it would in `psql`, and opens a short-lived connection for each explorer statement. A handshake costs about 3 ms.

## Cancel

Cancel does not work, in any form.

The server sends no `BackendKeyData`, so there is no process id or secret key to put in a `CancelRequest`. `tokio-postgres` sends one anyway with zeros. To see what actually happens, the engine was started with `--http.log.enabled`, which logs each provider call, and a statement making 60 provider calls was interrupted 250 ms in.

```
-- baseline: 60 upstream calls, not cancelled
  BackendKeyData in handshake: false
  elapsed 12145 ms, rows 60, errors 0
-- tokio-postgres cancel_token().cancel_query sent 250 ms in
  cancel_query result: Ok(())
  statement completed normally in 1011 ms with 62 messages
  upstream requests logged before the cancel: 0, after: 60
-- closing the client socket 250 ms into the statement
  upstream requests logged before the close: 0, after: 60
  engine still serving new connections: true
-- dropping the tokio-postgres client 250 ms into the statement
  upstream requests logged before the drop: 0, after: 60
```

After the cancel request the statement ran to completion and returned every row. After the client closed its socket, the engine still made all 60 provider calls. The baseline is slower than the later runs only because the upstream API answers repeat requests faster.

Consequences:

- The host does not offer "cancel". It offers "stop waiting", which abandons the result and reconnects the editor session. The UI says plainly that the statement keeps running in the engine and that a mutation may still complete.
- The only way to actually stop a statement is to restart the engine, which the status bar offers.
- M1 lists cancel as a feature. It needs engine support first: `BackendKeyData` at startup and a handler for `CancelRequest`. This is a question for the maintainer.

## Errors

Every error is an `ErrorResponse` with three fields: severity `ERROR`, the code `XXUUU`, and a message that starts with `query returns error: `. There is no position, detail or hint, and the code does not vary with the kind of error. The connection is ready for the next statement afterwards.

```
> SELEC 1
  ERROR  {'C': "XXUUU", 'M': "query returns error: error:  You have an error in your stackql syntax; parser error: Code: INVALID_ARGUMENT syntax error at position 6 near 'SELEC' ", 'S': "ERROR"}
> SHOW SERVICES IN nosuchprovider
  ERROR  {'C': "XXUUU", 'M': "query returns error: no provider document for 'stackql_unstable_nosuchprovider' under '<approot>\\src\\nosuchprovider'", 'S': "ERROR"}
> SELECT name FROM homebrew.formula.formula
  ERROR  {'C': "XXUUU", 'M': "query returns error: omnisdk: formula (stackql_unstable_homebrew.formula.formula): no satisfiable select method (get_formula needs formula_name)", 'S': "ERROR"}
> SELECT nosuchcolumn FROM homebrew.formula.formula WHERE formula_name = 'wget'
  ERROR  {'C': "XXUUU", 'M': "query returns error: omnisdk: output \"nosuchcolumn\": no such column: nosuchcolumn (no table has a column \"nosuchcolumn\")", 'S': "ERROR"}
> REGISTRY PULL nosuchprovider
  ERROR  {'C': "XXUUU", 'M': "query returns error: could not resolve provider 'nosuchprovider'", 'S': "ERROR"}

connection still usable after the errors: true
-- the same errors through tokio-postgres
  SELEC 1: DbError severity=ERROR code=XXUUU message="query returns error: ..." detail=None hint=None position=None where=None routine=None
  client.is_closed after errors: false
```

The host carries severity, code and message across IPC and strips nothing. A syntax error position is sometimes present inside the message text ("at position 6"), but it is not a protocol field, so the editor cannot mark the location reliably.

## Upstream provider failures

This is the behaviour [CLAUDE.md](../CLAUDE.md) warned about, now pinned down. When a provider API call fails, the statement **succeeds with zero rows**. Nothing on the wire says anything went wrong.

With default flags the reason goes only to the engine's stderr.

```
-- server started with default flags
> SELECT login FROM github.users.users
  RowDescription messages 1, rows 0, tags ["OK"], ready Some('I')
  column login
  srv    [  1.298s stderr] http response status code: 401, response body: {"message":"Requires authentication", ... ,"status":"401"}
  notices via tokio-postgres poll_message: []
```

With `--pgsrv.debug.enable` the same text arrives as a `NoticeResponse` on the connection that ran the statement, and stderr stays silent. The notice has severity `NOTICE`, code `01000`, the fixed message `a notice level event has occurred`, and the useful text in the detail field.

```
-- server started with --pgsrv.debug.enable
> SELECT name FROM homebrew.formula.formula WHERE formula_name = 'no-such-formula-xyz-123'
  RowDescription messages 1, rows 0, tags [""], ready Some('I')
  NOTICE {'C': "01000", 'D': "http response status code: 404, response body: <!DOCTYPE html> ...", 'M': "a notice level event has occurred", 'S': "NOTICE", 'V': "NOTICE"}
```

`--pgsrv.loglevel DEBUG` changed nothing visible. `--http.log.enabled` logs every request and the full response body to stderr, which is far too much to leave on.

A partial failure looks like a smaller result. One good branch and one failing branch of a `UNION ALL` returned the good row and no error.

### Notices accumulate on a connection

The notice buffer is per connection and is never cleared. Once a statement has produced a notice, every later statement on that connection gets the whole accumulated text again, including statements that succeed.

```
== notices under --pgsrv.debug.enable ==
  A SHOW PROVIDERS:      rows 3,  tags ["OK"], notices 0
  A good select:         rows 1,  tags ["OK"], notices 0
  A failing select 1:    rows 0,  tags [""],   notices 1 [detail 9427 chars, 'status code' occurrences 1]
  A SHOW PROVIDERS:      rows 3,  tags [""],   notices 1 [detail 9427 chars, 'status code' occurrences 1]
  A good select:         rows 1,  tags [""],   notices 1 [detail 9427 chars, 'status code' occurrences 1]
  A failing select 2:    rows 0,  tags [""],   notices 1 [detail 9607 chars, 'status code' occurrences 2]
  A syntax error:        rows 0,  tags [],     errors 1, notices 0
  A REGISTRY LIST:       rows 44, tags [""],   notices 1 [detail 9607 chars, 'status code' occurrences 2]
  B failing select 2 (fresh connection): notices 1 [detail 180 chars, 'status code' occurrences 1]
  C good select (new connection after failures elsewhere): rows 1, tags ["OK"], notices 0
  engine stderr/stdout lines captured with the flag on: 0
```

Consequences:

- The host starts `srv` with `--pgsrv.debug.enable`. A notice tied to the connection is far better attribution than a stderr line with no statement attached.
- On the long-lived editor connection the host remembers the notice text it has already shown and reports only what was appended. A repeat of the same text is treated as old news.
- Stderr is still captured and shown, since the engine may write other things there.
- A zero-row result with a notice is the signature of an upstream failure. The results pane shows the notice prominently in that case, so an empty grid is not mistaken for "no data".
- The command tag changes from `OK` to an empty string once a notice exists. The host does not rely on the tag.

## Metadata statements

These are the exact column names and order the explorer relies on, read from `RowDescription`. Every column is text.

| Statement | Columns, in order |
|---|---|
| `SHOW VERSION` | `version` |
| `SHOW EXTENDED VERSION` | `version`, `commit`, `build_date`, `platform` |
| `SHOW PROVIDERS` | `name`, `version` |
| `SHOW EXTENDED PROVIDERS` | `name`, `version` |
| `REGISTRY LIST` | `provider`, `version` |
| `REGISTRY PULL <provider>` | No result set. Tag `OK` |
| `SHOW SERVICES IN <provider>` | `id`, `name`, `title` |
| `SHOW EXTENDED SERVICES IN <provider>` | `id`, `name`, `title`, `description`, `version`, `preferred` |
| `SHOW RESOURCES IN <provider>.<service>` | `name`, `id` |
| `SHOW EXTENDED RESOURCES IN <provider>.<service>` | `name`, `id`, `description` |
| `SHOW METHODS IN <provider>.<service>.<resource>` | `MethodName`, `RequiredParams`, `SQLVerb` |
| `SHOW EXTENDED METHODS IN <provider>.<service>.<resource>` | `MethodName`, `RequiredParams`, `SQLVerb`, `description` |
| `DESCRIBE <provider>.<service>.<resource>` | `name`, `type` |
| `DESCRIBE EXTENDED <provider>.<service>.<resource>` | `name`, `type`, `description` |
| `DESCRIBE METHOD <provider>.<service>.<resource>.<method>` | `name`, `type`, `param_type`, `shape` |
| `DESCRIBE METHOD EXTENDED <...>` | `name`, `type`, `param_type`, `shape`, `description` |

Sample rows, to show the shapes:

```
> SHOW PROVIDERS
  row    ["github", "v26.08.00448"]
  row    ["homebrew", "v25.01.00292"]
  row    ["stackql_preview", "internal"]

> SHOW SERVICES IN homebrew
  row    ["formula:v25.01.00292", "formula", "Homebrew Formulae API"]

> SHOW RESOURCES IN homebrew.formula
  row    ["formula", "homebrew.formula.formula"]
  row    ["vw_build_errors", "homebrew.formula.vw_build_errors"]

> SHOW EXTENDED METHODS IN github.repos.repos
  row    ["list_for_org", "org", "SELECT", "repos/list-for-org"]
  row    ["list_for_user", "username", "SELECT", "repos/list-for-user"]
  row    ["list_public", "", "SELECT", "repos/list-public"]

> DESCRIBE homebrew.formula.formula
  row    ["name", "string"]
  row    ["aliases", "array"]
  row    ["analytics", "object"]

> DESCRIBE METHOD homebrew.formula.formula.get_formula
  row    ["formula_name", "string", "input_required", "string"]
  row    ["aliases", "array", "output", "array"]
```

Notes for the explorer:

- The service `id` is `<name>:<version>`, not a path. Use `name` to build the next level.
- The resource `id` is the fully qualified name, `<provider>.<service>.<resource>`.
- A fresh approot lists one provider, `stackql_preview` with version `internal`. Others appear after `REGISTRY PULL`.
- `RequiredParams` is a comma-separated string and may be empty.
- `param_type` is `input_required`, `input_optional` or `output`. The `output` rows are the columns a `SELECT` through that method can return.
- Views show up as resources (`vw_*`). `DESCRIBE` on a view can return an empty `type`.
- The keyword order is `DESCRIBE METHOD EXTENDED`. `DESCRIBE EXTENDED METHOD` is a syntax error.
- Identifiers are quoted with double quotes. Every statement in the table above accepts double-quoted names, for example `SHOW EXTENDED RESOURCES IN "homebrew"."formula"`, so the host quotes every name it puts in a statement. Backticks are rejected everywhere in this engine version, although the public documentation suggests them for names that contain dots.
- A column name that is a reserved word, such as `desc`, must be written in double quotes.
- `SHOW EXTENDED METHODS` on a large provider took 251 ms the first time, while the provider document loaded. Everything else took single-digit milliseconds.

## Readiness

The engine was started five times and polled, with each connect attempt limited to 40 ms.

```
run 1: tcp accept 132 ms, handshake ready 134 ms, first SHOW VERSION result 135 ms, attempts 3
run 2: tcp accept 129 ms, handshake ready 131 ms, first SHOW VERSION result 132 ms, attempts 3
run 3: tcp accept 130 ms, handshake ready 134 ms, first SHOW VERSION result 135 ms, attempts 3
run 4: tcp accept 78 ms, handshake ready 81 ms, first SHOW VERSION result 82 ms, attempts 2
run 5: tcp accept 132 ms, handshake ready 134 ms, first SHOW VERSION result 135 ms, attempts 3
```

The engine is ready roughly 80 to 135 ms after spawn. The spread is the polling interval, not the engine.

An earlier run without the 40 ms limit reported about 520 ms every time, with the first attempt succeeding. On Windows a connect to a loopback port that is not listening yet is retried inside the OS for about half a second before it fails, so one unbounded attempt hides the real figure. The host must put its own short timeout on each connect attempt.

```
run 1: tcp accept 516 ms, handshake ready 519 ms, first SHOW VERSION result 523 ms, attempts 1   (unbounded connect)
```

There was no gap between the port accepting connections and statements working: the handshake and `SHOW VERSION` succeeded within 5 ms of the first accepted connection. The engine prints nothing on stdout or stderr at startup, so there is no log line to wait for.

The readiness check the host uses: connect with a short per-attempt timeout and run `SHOW VERSION`, retrying until it returns one row, with an overall timeout of 15 seconds. `SHOW VERSION` needs no provider, no registry access and no credentials, and its result doubles as the engine version shown in the status bar. If the child exits first, the host reports the captured stderr instead of waiting out the timeout.

## What this changes

These are the decisions the findings forced, and where they landed.

| Finding | Decision |
|---|---|
| Simple protocol only | The host uses `simple_query_raw`. No prepared statements, no parameters |
| Only the first statement in a message runs | The host splits editor text into statements and sends them one at a time, stopping at the first error |
| No row count in the tag | The host counts rows |
| Everything is text | The result type carries column names only. The grid detects JSON from the value |
| No streaming | Rows cross IPC in batches for size reasons, with a busy indicator while waiting |
| No cancel | "Stop waiting" abandons the result and reconnects. The UI says the statement may still complete |
| Upstream failures are silent by default | `srv` is started with `--pgsrv.debug.enable`, and notices are shown beside the result |
| Notices accumulate per connection | The editor connection reports only newly appended notice text |
| Default approot is the working directory | The host passes `--approot` explicitly: a folder of its own beside the executable, or one the operator names |

## Open items for the maintainer

These came out of the spike and need an engine-side answer.

- Cancel needs `BackendKeyData` and a `CancelRequest` handler in `srv`. Without them M1's cancel is a "stop waiting" button only.
- Dropping statements after the first, with no error, looks like a defect in `srv`. The host works around it by splitting.
- `srv` cuts a message at the first semicolon even inside a string literal, so a literal containing a semicolon cannot be sent. There is no host-side workaround.
- The per-connection notice buffer is never cleared. The host works around it, but a fix in the engine would be cleaner.
- A provider call that returns nothing gives success with zero rows, which is easy to misread. This report first suggested an error. The maintainer has since decided the behaviour stays: an empty result is the right answer to a lookup of something that does not exist. The host shows the notice beside the empty result and does not rule on it. See Provider errors and empty results in `CLAUDE.md`.
- `NULL` arrives as an empty string.
- Whether `SET SESSION` is scoped to the connection was not verified.
