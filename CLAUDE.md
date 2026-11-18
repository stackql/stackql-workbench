# StackQL Workbench

This file is the working agreement for coding agents in this repository. Read it and `README.md` in full before changing anything.

## What this is

StackQL Workbench is the desktop UI for [StackQL](https://github.com/stackql/stackql). It combines a query IDE with a chat interface over a local `stackql` engine. It is a native app for Windows and macOS, installed beside the `stackql` binary by the StackQL MSI and PKG installers. Linux is out of scope.

## Status

Pre-alpha. This much has landed on Windows.

- M0, foundations: engine discovery and supervision, the pg wire query service, the explorer, one editor buffer and the results grid.
- The core of M3, chat: the MCP client with approvals, the agent loop, the activity pane, and API key backends for Gemini, Anthropic and OpenAI-compatible servers. Anthropic and OpenAI-compatible were M4 items and came along because the backend interface made them cheap.
- The first delegated agent, an M5 item: the GitHub Copilot CLI, driven over the Agent Client Protocol. It uses the sign-in the CLI already has.
- A chat-first layout: chat is the view the app opens in, with a side menu for the explorer and activity, and File, Edit and View menus.
- Most of M1, the query IDE: editor tabs, completion from provider metadata, the JSON cell viewer, statement history, export as CSV and JSON, and a `stackql exec` command for a statement.

Not started: the rest of M1 (saved `.iql` files, cancel, a streaming grid), M2 (packaging), plan sign-in and any delegated agent other than the Copilot CLI. Replies from the API key backends are not streamed yet. Replies from the Copilot CLI are.

What has and has not been run:

- Everything has been run on Windows 11 x64 against `stackql` v1.0.888.
- Nothing has been run on macOS. The process supervision code for Unix is tested on Linux. The rest of the macOS-only code, the keychain store among it, has only been written.
- No API key backend has been run against a real inference provider. Each is tested against a local stub that checks what goes on the wire, and the loop is tested against a real `stackql mcp` with a scripted model.
- The Copilot backend has been run for real, against GitHub Copilot CLI 1.0.113 with a signed-in account. Its protocol handling is also tested against a scripted agent.

Update this section when a milestone lands. The roadmap is in `README.md`.

## Architecture rules

These rules are fixed. If one cannot be met, stop and ask instead of working around it.

- The webview is not served over HTTP and opens no network listener. It loads from the app bundle and reaches the host only through typed IPC commands and events.
  - This holds for built apps. `npm run tauri dev` is the one exception: it loads the webview from the Vite dev server, bound to `127.0.0.1:5173`, for hot reload. Nothing in the app may depend on that server existing.
- The webview holds no secrets and makes no direct calls to the engine, to inference providers or to the filesystem. All of that goes through the host.
- The engine is reached over two channels that are not interchangeable.
  - Human channel: `stackql srv` over the Postgres wire protocol. Used by the explorer and the editor. Statements here are written or explicitly run by the operator.
  - Agent channel: `stackql mcp` over stdio. Used only by the agent runtime. Statements here originate from a model.
- The engine enforces safety. Do not build a second SQL classifier or approval gate in the host. Pass the workspace safety mode to the MCP server and implement the client side of its approval flow.
- All engine access sits behind a `Connection` interface. Only `LocalConnection` exists for now. Code above that interface must not assume the engine is a child process, because a remote connection comes later.
- Inference sits behind one of two seams. A model API sits behind the `InferenceBackend` interface, and the host runs the loop. An agent the operator installed sits behind the ACP client in `agent/acp.rs`, and the agent runs the loop. The chat UI works unchanged across both.
- Chat is the default view. With no backend configured, sending a message opens the model backend settings and keeps what was typed. The explorer and the editor are fully usable without a backend.
- SQL is the interchange between the agent and the operator. Agent-proposed statements are shown as SQL, can be opened in an editor tab, and every executed statement from either channel is recorded in history.
- No Deno, no HTTP middleware tier, no Next.js. The earlier `stackql-playground` and `stackql-middleware` prototypes are reference material for layout and API shape only.

## Stack

These are the chosen defaults. Check the current stable version and API of each dependency in its official documentation before using it. Do not rely on memory for library APIs.

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Host | Rust (stable) with tokio |
| UI | React, TypeScript (strict), Vite |
| Editor | CodeMirror 6 |
| Results grid | TanStack Table with TanStack Virtual |
| Styling | Tailwind CSS |
| pg wire client | `tokio-postgres` |
| MCP client | `rmcp` (the official Rust MCP SDK), client and async read-write transport only |
| Secrets | OS keychain through `keyring-core` with the Windows and Apple native stores |
| Package manager | npm |
| Webview tests | Vitest with jsdom |
| Lint and format | ESLint with typescript-eslint, Prettier, rustfmt, clippy |
| Process supervision | `windows-sys` job object on Windows, process group plus a pipe watchdog on Unix |
| Clipboard | `arboard`, write only, through a host command |
| Save dialog | `tauri-plugin-dialog`, called from host commands only. The webview has no access to it |
| Completion | `@codemirror/autocomplete`, with a source written in this repository |
| HTTPS client | `reqwest` with the OS TLS stack (`native-tls`) |
| ACP client | Written in this repository: JSON-RPC over stdio, protocol version 1, the client side only |
| Markdown in replies | Written in this repository: a small reader that builds a tree, never HTML |

The MCP client library must support the client side of elicitation and protocol revision negotiation. `rmcp` 3.11 does both. That was confirmed against the real engine and is recorded in `docs/spike-mcp.md`.

The `keyring` crate is now a thin layer over `keyring-core` plus one store crate per platform. The host depends on those directly and installs the platform store at startup.

Version constraints found while building M0:

- Rust 1.90 or later. Current Tauri 2 releases need it. Use rustup's stable toolchain, the same one CI uses.
- TypeScript is pinned to 6.0.x. TypeScript 7 ships no compiler API, and typescript-eslint supports up to 6.0. Move to 7 when typescript-eslint does.
- TanStack Table is v9. Its API differs from v8: `useTable`, and features are registered with `tableFeatures`.
- `rmcp` needs Rust 1.88 or later, which the Tauri requirement already covers.

## Repository layout

The layout is below. Keep it current as the code lands.

```
stackql-workbench/
  src/                  webview (React)
    host/               typed wrappers over IPC, the only Tauri imports
    lib/                pure logic with tests: results, cells, export formats, explorer tree, statement templates, completion, tabs, history, the CLI command, chat, activity, menu, markdown
    state/              hooks that connect the host to the panes
    panes/              shell (menu bar, side menu), chat, explorer, editor, results, activity, settings, statusbar
    ui/                 small shared components
  src-tauri/            host (Rust)
    src/
      engine/           discovery, data folder, port selection, supervisor, job object, watchdog
      connection/       Connection trait, LocalConnection, safety mode, agent channel
      query/            pg wire session, statement splitting, results, explorer statements
      agent/            MCP client, approvals, InferenceBackend trait, backends, loop, ACP client, delegated agent
      secrets/          keychain access
      activity/         operator history, engine audit log reader
      icons/            provider icon lookup, fetch and cache
      config/           settings
      ipc/              command and event definitions, saving an export
    examples/           pgwire_spike and mcp_spike, the probes behind the spike reports
    tests/              integration tests against a real stackql
  scripts/              test launcher
  docs/                 design notes and spike reports
```

Only `src/host/` may import Tauri APIs. Panes call the typed wrappers in that directory.

## Commands

These commands all pass on Windows. Run them from the repository root unless noted.

```
npm install
npm run tauri dev
npm run lint
npm run typecheck
npm test

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Other commands that are useful:

```
npm run format                              format the webview sources
npm run tauri build -- --no-bundle          release build of the executable, no installer
npm run tauri build -- --debug --no-bundle  the debug build CI runs
cd src-tauri && cargo run --example pgwire_spike   rerun the pg wire probe
cd src-tauri && cargo run --example mcp_spike      rerun the MCP probe
```

Things to know about them:

- `npm run lint` runs ESLint and then `prettier --check`.
- `npm test` goes through `scripts/test.js`. Vitest fails on Windows when the working directory is spelled with a lower-case drive letter, which an editor terminal can do. The launcher corrects that.
- `cargo test` includes integration tests that start a real `stackql`. They are skipped, with a note on stderr, when no binary is found. They need no credentials and no network.
- The release executable is `src-tauri/target/release/stackql-workbench.exe` on Windows.
- The engine's `--approot` is `.stackql` beside the Workbench executable. For a build from this repository that is `src-tauri/target/release/.stackql`, or `target/debug/.stackql` under `npm run tauri dev`. Where that folder cannot be written to, the fallback is `<app data dir>/engine`, which on Windows is `%APPDATA%\io.stackql.workbench\engine`. The operator can name another folder in Settings.
- Settings are in `<app config dir>/settings.json`. The agent audit log is in `<app data dir>/audit` and the operator's statement history in `<app data dir>/history.jsonl`. Those two do not move with the engine's data folder.
- One test writes and removes a throwaway entry in the real OS keychain. It skips itself where no keychain can be opened.
- An editor's language server can build in the same `target` directory and hold a file the build needs, which shows up as linker error `LNK1104` on Windows. Running the command again clears it.

## Engine interface

The facts in this section were read from `stackql` `main` in November 2026, and the `srv` facts were then tested against `stackql` v1.0.888. The evidence is in `docs/spike-pgwire.md`. Confirm against `stackql --help` for the installed version. The reference docs are `docs/mcp.md` and `pkg/mcp_server/README.md` in the stackql repository.

### Discovery

Resolve the `stackql` binary in this order and stop at the first hit.

1. Explicit path in settings
2. `STACKQL_BIN` environment variable
3. Sibling of the Workbench executable
4. Well-known install locations for the platform
5. `PATH`

Show the resolved path and version in the UI. If nothing is found, say so plainly and point at the settings field.

The two explicit sources are strict. If the settings path or `STACKQL_BIN` is set and does not point to a file, that is an error and the search stops there. Running a different binary than the one the operator named would be worse than stopping.

### Process lifecycle

One supervisor owns every child process.

- Children must not outlive the app, including after a crash or force quit. Use a job object on Windows, created with kill-on-close. On macOS a process group is not enough on its own, because nothing signals the group when the app receives SIGKILL. Each child therefore also gets a watchdog: `/bin/sh` blocked on a pipe that only the app holds open, which signals the group when the pipe closes.
- On Windows a child can start out in a job of its own. A packaged app does, and a program on `PATH` can be an alias for one. Such a process cannot join a job that already has members, so it gets a kill-on-close job to itself. An empty job always takes it.
- The watchdog script must stay POSIX. `kill -s TERM -- -PGID` works in every `/bin/sh` tried. `kill -TERM -- -PGID` does not.
- Start console children with `CREATE_NO_WINDOW` on Windows, otherwise a console window flashes up.
- Wait for readiness with a timeout. Surface failures in the UI with the captured stderr.
- Capture stderr of every child. For a stdio MCP process, stdout carries protocol frames only.

### `stackql srv` (human channel)

The explorer and the editor use this channel. Every point below was tested. See `docs/spike-pgwire.md`.

Flags the host passes:

- `--pgsrv.address 127.0.0.1`, always. The default is `0.0.0.0` and the listener has no authentication.
- `--pgsrv.port` with a free port chosen by the host. The default is 5466 and may be taken.
- `--approot` with the engine's data folder, always. The engine's own default is `.stackql` in the working directory, so the provider cache would otherwise follow wherever the app was started from. The host resolves the folder in this order and stops at the first hit.
  1. Explicit folder in settings. This source is strict: a folder that is not a full path, or cannot be created or written to, is an error and the engine does not start.
  2. `.stackql` beside the Workbench executable. Skipped inside a macOS app bundle, because adding a file to a signed bundle breaks its signature.
  3. `<app data dir>/engine`. Used when the folder beside the executable cannot be written to, which is the normal case for an app installed under `Program Files`. The settings pane says so.
- The Workbench does not share the operator's own `.stackql` folder unless they point it there.
- `--pgsrv.debug.enable`. Without it an upstream API failure is an empty, successful result with the reason only on stderr. With it the reason arrives as a pg notice on the connection that ran the statement.
- `--env.file` when the operator has set a credentials file.

How the server behaves:

- Simple query protocol only. The extended protocol does not work through `tokio-postgres`. Statements are never parameterised.
- One statement per message. The server runs the first statement in a message and silently drops the rest, so the host splits editor text and sends statements one at a time. It also cuts at a semicolon inside a string literal, which the host cannot work around.
- Every value is text. Type OIDs carry no information. A SQL NULL arrives as an empty string.
- The command tag has no row count. The host counts rows.
- Rows do not stream. They all arrive when the statement finishes.
- There is no cancel. A cancel request has no effect and closing the connection does not stop the work. The UI offers "stop waiting" and says the statement may still complete. Restarting the engine is the only way to stop a statement.
- Errors carry a severity, the code `XXUUU` and a message. Nothing else.
- Notices accumulate on a connection and are sent again with every later statement. The host reports only the newly appended text on the long-lived editor session.
- Readiness: connect and run `SHOW VERSION`. The engine is ready about 100 ms after spawn. Give each connect attempt its own short timeout, because Windows retries a refused loopback connect for about half a second.

How the host uses it:

- The editor has one long-lived session. Each explorer statement gets its own short-lived session.
- The explorer is built from metadata statements: `SHOW PROVIDERS`, `SHOW EXTENDED SERVICES IN`, `SHOW EXTENDED RESOURCES IN`, `SHOW EXTENDED METHODS IN`, `DESCRIBE EXTENDED` and `DESCRIBE METHOD EXTENDED`. Results are mapped by column name, not position.
- Identifiers are validated and written in double quotes. This engine version rejects backticks. Never build statements by raw string interpolation of UI input.
- A zero-row result that comes with a notice is shown with the notice beside it, not as plain "no data". The notice is what the provider answered. The UI passes it on and does not rule on it. See Provider errors and empty results.

### `stackql mcp` (agent channel)

Only the agent runtime uses this channel. Every point below was tested. See `docs/spike-mcp.md`.

How the host starts it:

- `--mcp.server.type=stdio`, always. The default transport is HTTP.
- `--approot` with the same directory `srv` uses, and `--env.file` when the operator has set a credentials file.
- Configuration is inline JSON through `--mcp.config`. The host sets `server.transport`, `server.mode`, `server.request_timeout` and `server.audit`.
- `server.audit.file.dir` is a directory under the app data directory, otherwise the log lands in the working directory. The log is JSONL, one record per tool call, one file per server start. The activity pane reads it.
- `server.request_timeout` is raised from its 30 second default, which a paged provider query can exceed.

How the server behaves:

- Every protocol revision the SDK offers is negotiated. The host offers `2025-11-25`, the newest one with an `initialize` handshake. On it the approval prompt is a server-initiated elicitation, the simpler of the two approval flows.
- 15 tools. Each result carries rendered text for the model and a structured payload. Row results are `{ "rows": [...] }`, which the host turns into a table for the grid. Nothing needs to be set to get JSON: the structured payload is always there.
- The handshake returns about 25,000 characters of guidance for the model. The host puts it in the system prompt.
- A provider call that fails comes back as a tool error: `upstream http error: {"http_status": 401, "retryable": false}: ...`. A lookup that finds nothing comes back as an empty result with no error, and what the provider said is on the server's stderr. The server's instructions tell a model how to read each. The host shows the stderr line to the operator beside the tool result and adds nothing to what the model receives. See Provider errors and empty results.
- A statement the server cannot parse is classed `unknown` and asks for approval, even through the read tool.
- Every tool carries hints. The tools that take no SQL say they are read-only. The SQL tools never claim that, because what they do depends on the statement, but each says whether it can make a destructive change: `run_mutation_query` and `run_lifecycle_operation` can, the rest cannot.
- One server runs tool calls at the same time. Four single-request statements sent together were answered in about the time of one.
- The server exits when its stdin closes.

How the host uses it:

- The connection supplies the two byte streams. The agent runtime never spawns the process itself, and the supervisor owns it like any other child.
- One session is kept per safety mode. Changing the mode opens a new session, because the mode is fixed when the server starts.
- For a delegated agent the connection starts the agent instead, and tells it how to start the MCP server in the workspace safety mode. The agent is then the MCP client. See Inference.

The workspace safety setting maps directly onto `server.mode`.

| Mode | SELECT and metadata | INSERT, UPDATE, REPLACE | DELETE | EXEC |
|---|---|---|---|---|
| `read_only` | allow | refuse | refuse | refuse |
| `safe` (default) | allow | needs approval | needs approval | needs approval |
| `delete_safe` | allow | allow | needs approval | needs approval |
| `full_access` | allow | allow | allow | allow |

"Needs approval" is implemented with MCP elicitation. The host's MCP client must advertise the elicitation capability, otherwise gated tools are refused. The approval card in the UI is the answer to the server's `elicitation/create` request. Show the exact SQL on the card. Never auto-accept.

The request is a form with no fields. Its message holds the tool, the query class and the SQL. The host waits for the operator for as long as it takes. With nobody listening the answer is decline, and stopping the turn answers cancel.

### Provider errors and empty results

Where this is handled was decided by the maintainer on 18 November 2026: in the engine, not in this app. Do not add logic for it here.

- On the agent channel the engine's MCP server already handles it. It runs statements with strict upstream errors, so a provider call that fails is a tool error carrying the status and whether a retry can help. A lookup that finds nothing is an empty result, because "not found" is a valid answer. The server's instructions tell a model how to read each. They are in `pkg/mcp_server/content/instructions/06-errors.md` in the stackql repository.
- That was checked against v1.0.888 with no provider credentials in the environment. A call that needs a sign-in returned the tool error. A list for an owner that does not exist returned no rows.
- On the human channel `srv` answers a provider call that returned nothing with an empty, successful result, and with `--pgsrv.debug.enable` a notice carries what the provider said. That stays. The server cannot fail a statement because a lookup found nothing, and the engine reaches providers over more than one protocol, gRPC among them.
- This app passes on what the engine says and adds nothing. It does not sort a provider's answer by status code, does not call an answer a failure, and does not add to or change what a model is told about a result. If something seems to need that, the change belongs in the engine's MCP server.
- An earlier version of this file, and of `docs/spike-mcp.md`, said the MCP server hides provider failures from the model. That was wrong. It came from testing one lookup that found nothing and taking it for every kind of failure. Test more than one case before recording an engine behaviour, and read the engine's source when it is to hand.

### Credentials

Provider credentials are environment variables read by the engine. The app never parses or displays their values.

- Apps launched from Finder or the Dock on macOS do not inherit shell profile exports. Do not rely on the app's own environment.
- The host builds the child environment explicitly. Values come from the OS keychain and are injected at spawn, or from an operator-supplied dotenv file passed with `--env.file`.
- Until the keychain store for provider credentials exists, the engine starts with the app's own environment as the base, plus the `--env.file` from settings. That works on Windows, where the app sees the user's environment variables. On macOS the env file is the dependable route.
- The MCP `reload_credentials` tool re-sources `--env.file`. `stackql srv` needs a restart to pick up changes.
- The UI shows variable names and whether they are set. Never log or display environment contents.

## Inference

Backends are built in this order.

1. API key. Gemini first because it works on the free tier, then Anthropic, OpenAI and any OpenAI-compatible base URL, which covers local inference. The host runs the loop and owns the MCP client.
2. ChatGPT plan sign-in through OpenAI's Sign in with ChatGPT programme. This needs a client ID issued to this project. Do not start it until the maintainer confirms the client ID exists.
3. Delegated. An ACP agent that the operator has installed and signed in to themselves. In this mode the agent is the MCP client and spawns its own `stackql mcp`. Each agent needs its own launcher, because how the engine's MCP server is handed over and how tools are restricted differs from one agent to the next. Verify an agent's elicitation handling before building on it, and record it in `docs/`.

What exists now under item 1:

| Backend | API | Default model | Notes |
|---|---|---|---|
| Gemini | `generateContent` | `gemini-4-hydrogen` | The model's reply is kept and sent back untouched, because function calls carry a signature that must be returned in place |
| Anthropic | Messages API over REST, since there is no official Rust SDK | `claude-opus-5-5` | Thinking blocks are returned untouched. For models that support it, server-side fallback on a declined request is switched on |
| OpenAI-compatible | Chat Completions | none, the operator names it | Covers local inference. Some of OpenAI's newest models take tool calls only through its Responses API, which is not implemented |

How they are built:

- A backend turns the shared conversation into one request and the reply back into text and tool calls. It holds no state. The loop, the MCP client and the approval flow are the same for all of them.
- Each keeps the provider's own form of a reply and replays it as it was. Do not rebuild a reply from its parsed parts.
- No sampling parameters are sent. Current models from all three providers ignore or reject them.
- Replies are not streamed. A turn shows progress per tool call.
- The tool calls of one reply run at the same time when the engine marks the tool as not destructive, with `destructiveHint: false`. That covers its query and discovery tools. A tool the engine marks as destructive, or one that carries no hint, runs alone and in the model's order, so what follows a change sees the change. The host takes the engine's word for this and reads nothing into the statement. Results go back to the model in the order it asked.
- More than one approval prompt can be open at once. A prompt is shown on the tool call that sent the statement.
- The API key is read from the keychain when a turn starts. Settings hold the backend, the model and the address, never the key.

What exists now under item 3 is the GitHub Copilot CLI. Every point was tested. See `docs/spike-acp.md`.

- The host starts `copilot --acp` under the supervisor and speaks ACP version 1 to it over stdio.
- The engine's MCP server is named in a file passed with `--additional-mcp-config`, under the name `stackql`. The CLI rejects a stdio MCP server passed in `session/new`, and then silently uses the operator's own Copilot configuration, so that route must not be used.
- `--available-tools` lists the engine's tools, read from the engine at start. The model then has no shell, no file access and no other MCP server. `--allow-tool=stackql` stops the CLI asking about each engine tool call.
- The workspace safety mode is passed to the engine as for the other backends. The CLI does not relay MCP elicitation, so the engine refuses a statement that needs approval instead of asking. It fails closed. Do not put a gate of the host's own in its place.
- A `session/request_permission` from the agent is declined and the operator is told. None is expected, and one means the agent is reaching for something outside the engine.
- The model is chosen with `session/set_config_option`. Empty leaves the CLI's own choice. The settings pane lists the models with what each costs against the operator's plan.
- The engine's stderr goes to the CLI, so the operator is not shown what a provider said when a lookup found nothing. Errors are not affected: they come back as tool errors on this path as on the other.
- Subagents can be allowed, as a setting that is off by default and marked experimental. With it on, the CLI's `task` tool is added to `--available-tools`. A subagent gets the same tools as the agent that starts it, the engine's and `task`, and uses the same MCP server, so the same safety mode. That was tested: a subagent asked for a shell and for a file write had neither.
- They are off by default because they were safe and not dependable. In a real turn a small model reached for subagents when it was stuck on a large result, they nested four deep, and the turn was slower and its answer wrong. Do not turn them on by default without testing that again.
- The first prompt tells the agent when to use subagents: independent lookups across providers, services or resources, never a change. That direction lives here because starting agents is the client's capability. The engine cannot start one.
- A subagent's tool calls carry its id under `_meta["github.com/copilot"]`. The host marks each call with the subagent's name, shows the start of a subagent with its task, and keeps a subagent's own message text out of the conversation. A turn is stopped when a subagent starts a subagent of its own, and when more than 12 are started. The CLI itself stops nesting at depth four.
- The CLI has three kinds of subagent. `general-purpose` has the engine's tools and runs on the session's model. `task` has them and runs on a model the CLI picks, `gpt-6-luna` when tested. `explore` has none of the engine's tools. None of the three has a shell or file access under this tool list. The first prompt asks for `general-purpose` in `sync` mode and rules out `explore` and background mode. That advice is in the Copilot profile, not in the general guidance. What subagents cost was not measured.

These rules hold for every backend.

- Never reuse, read or proxy another product's OAuth credentials or client IDs. That includes Claude Code, Gemini CLI and Codex. Never add a vendor login button without a client ID issued to this project for that purpose.
- API keys and tokens live in the OS keychain. Never in settings files, logs, the webview or `localStorage`.
- The model never sees credentials. Tool results are the only engine data it receives.

## UI notes

A few fixed points for the interface.

- Brand colour is Classic Blue, `#0F4C81`.
- The app icon is StackQL's own favicon. The files in `src-tauri/icons/` were generated with `npx tauri icon` from `static/android-chrome-512x512.png` in the `stackql/stackql.io` repository, which is the same mark as its `favicon.ico` at a usable resolution.
- Provider nodes in the explorer show the provider's own icon. The host resolves it through the provider dictionary published at `src/configs/providers.json` in `stackql/stackql.io`, fetches the icon from `stackql.io`, caches it in the app cache directory and passes it to the webview as a `data:` URL. A provider with no entry, or whose icon cannot be fetched, shows the letter badge. Providers built into the engine, such as `stackql_preview`, show the StackQL icon, which is compiled in. The webview itself still makes no network calls. A snapshot of the dictionary is compiled in as a fallback.
- Saved queries are plain `.iql` files on disk, not an app database.
- Layout: a menu bar with File, Edit and View, a side menu, one main view at a time, and the status bar. The views are chat, the explorer with the editor and results, and activity. Settings is a dialog. Chat is the view the app opens in.
- The menus are drawn in the webview, not by the OS, so they are the same on both platforms and can be tested like the rest of the page. They repeat what the side menu and the panes offer.
- Every view stays mounted while another is shown, so the editor keeps its text and history and a running turn keeps its place.
- Row results from the assistant are shown in the conversation, first rows only, with a way to open the full result in the grid.
- Replies are read as markdown by a small reader in `src/lib/markdown.ts` that builds a tree. Model output is never turned into HTML. Links are shown and never opened.
- Under a method the explorer groups fields into Inputs and Outputs, both collapsed until opened. A field is an input when the engine's param type starts with `input`, and an output otherwise.
- The explorer does not list `stackql_preview`, the provider built into the engine. It is hidden for now and may come back. The name is in `HIDDEN_PROVIDERS` in `query/explorer.rs` and nowhere else. Only the tree leaves it out: `SHOW PROVIDERS` in the editor and the engine's answers to a model are not filtered.
- The explorer filter looks only at what has been loaded, and nothing is fetched on a keystroke. Starting a filter reads each provider's services, one statement for each provider. Enter reads the resources of every service not opened yet, four at a time, with progress, and Esc stops it. Methods are matched where a resource's methods have been opened. Under a filter at most 400 rows are drawn.
- A statement generated from the explorer opens in a new tab and does not run. It is a template built from what the engine reports for the method, with `<name>` where a value is needed. `DESCRIBE EXTENDED` from the menu, and installing or updating a provider, run on the human channel like anything else the operator runs, so they are in the history.
- A provider shows an update marker when `REGISTRY LIST` has a newer version than `SHOW PROVIDERS` reports. The engine asks the registry, so this needs the network. When it cannot be asked, no marker is shown.
- A method's SQL verb is drawn as a pill before its name, in one colour for SELECT and another for the rest. The colour follows the verb the engine reports and decides nothing.
- Nested JSON is common in results. The grid has a cell viewer for it, with pretty print and copy.
- Completion in the editor reads only what the explorer has loaded. It asks the engine for nothing, so a level that has not been opened in the explorer offers no names. After a keyword that takes a name, and after a dot, it offers the next level of provider, service and resource. Elsewhere it offers the fields of the resources the statement names.
- The statement history is the operator's own, from `history.jsonl`: statements only, each listed once, most recent first. A statement opens in a new tab, and runs only when the operator says so.
- A result is exported as CSV or JSON. The webview builds the text and the host saves it where the operator chooses in the system's save dialog. In JSON an object or an array is nested and everything else stays the text the engine sent, because the engine gives no types.
- "Copy as CLI" writes a `stackql exec` command with the full path of the binary and the engine's data folder, for PowerShell on Windows and a POSIX shell on macOS. The statement follows `--`, so one that starts with a comment is not read as a flag. In PowerShell a statement that holds a double quote goes through a temporary file, because the two PowerShell generations pass a double quote differently. The shapes are in `docs/spike-pgwire.md`.

## Conventions

Keep changes small and reviewable.

- Rust: `cargo fmt`, clippy clean with warnings denied, no `unwrap` or `expect` outside tests, typed errors that serialise cleanly across IPC.
- TypeScript: strict mode, no `any`, ESLint and Prettier clean.
- Tests sit beside the code. Integration tests that need a real `stackql` are skipped when the binary is absent and must not need cloud credentials. Use metadata statements.
- Before building on an assumption about engine behaviour, test it against the real binary and record the finding in `docs/`.
- Justify every new dependency in the commit message. Prefer the standard library and the stack table above.
- Commit in small steps with conventional commit messages. Do not push, tag or open pull requests unless asked.
- Never commit secrets, `.env` files or audit logs.
- When a decision changes, update this file and `README.md` in the same commit.

## Writing style

This applies to docs, comments, commit messages and UI copy.

- Plain ASCII punctuation. Use `-` where a dash is needed and `->` for arrows. No emojis.
- Matter-of-fact tone. No hyperbole and no marketing language.
- In markdown, put a sentence between a heading and any heading or table that follows it.
- Refer to other infrastructure-as-code tools in abstract terms. Do not name competing products in docs or UI copy.

## Open questions

Raise these with the maintainer when the work reaches them. Do not decide them alone.

- How Workbench versions are pinned to engine releases, and the minimum engine version check at startup.
- How the MSI handles a missing WebView2 runtime on older Windows versions.
- Signing and notarisation identities for the Windows executable and the macOS app bundle.
- Whether `srv` should later co-host the MCP server so the IDE and the agent share one engine session.
- Whether loopback pg wire needs TLS with a per-launch client certificate.

These came out of the Copilot work.

- Whether the Copilot CLI will relay MCP elicitation to an ACP client. Until it does there is no approval card on that path.
- Whether macOS should get a native menu bar in place of, or as well as, the one drawn in the webview.

These came out of the two engine spikes and need an answer from the engine side.

- `srv` has no cancel. It needs to send `BackendKeyData` and handle a cancel request before M1 can offer more than "stop waiting".
- `srv` runs only the first statement in a message, and cuts at a semicolon inside a string literal.
- Row objects from the MCP server lose the column order of the statement.

The licence is decided: MIT, the same as `stackql`.
