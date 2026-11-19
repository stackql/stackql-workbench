# StackQL Workbench

Desktop query IDE and chat interface for [StackQL](https://github.com/stackql/stackql), for Windows and macOS.

Status: pre-alpha. The query IDE foundations (M0), the core of chat (M3) and chat through the GitHub Copilot CLI work on Windows. Nothing here is released yet, and nothing has been run on macOS.

## Overview

StackQL Workbench is a native desktop app that runs against the `stackql` engine installed on the same machine. It gives an operator two ways to work with cloud and SaaS providers as data sources accessed via SQL: a query IDE for statements they write themselves, and a chat interface in which a model proposes and runs statements under the engine's safety controls.

The planned capabilities are listed below.

- Provider explorer: a lazy tree of providers, services, resources, methods and fields
- Query library: the published library of working statements, grouped by use case, to open in the editor
- Query editor: tabs, StackQL-aware completion, saved `.iql` files
- Results grid: virtualised rows, JSON cell viewer, export
- Chat: the view the app opens in. It needs a model backend, and asks for one the first time a message is sent
- Approvals and activity: mutations proposed by a model wait for the operator, and every agent action is logged
- Settings: engine path, credentials profile, safety mode, inference backend

## Architecture

The app is a webview UI over a native host. The host owns every process, connection and secret. The webview is not served over HTTP and opens no network listener.

```mermaid
flowchart TB
    subgraph app["StackQL Workbench"]
        ui["Webview UI<br/>explorer, editor, results, chat, activity"]
        subgraph host["Native host (Rust)"]
            ipc["Typed IPC"]
            query["Query service<br/>pg wire client"]
            agent["Agent runtime<br/>MCP client, inference backends"]
            sup["Supervisor<br/>discovery, spawn, env, keychain"]
        end
    end
    srv["stackql srv<br/>pg wire on 127.0.0.1"]
    mcp["stackql mcp<br/>stdio"]
    llm["Inference provider"]
    cloud["Cloud and SaaS provider APIs"]

    ui <--> ipc
    ipc --> query
    ipc --> agent
    ipc --> sup
    query -->|pg wire| srv
    agent -->|MCP over stdio| mcp
    agent -->|HTTPS| llm
    sup -.->|spawns| srv
    sup -.->|spawns| mcp
    srv --> cloud
    mcp --> cloud
```

### Engine channels

The host reaches the engine over two channels with different trust levels. They are kept separate on purpose.

| Channel | Process | Transport | Used by | Statements come from |
|---|---|---|---|---|
| Human | `stackql srv` | Postgres wire protocol on 127.0.0.1 | Explorer, editor | The operator |
| Agent | `stackql mcp` | MCP over stdio | Agent runtime | A model |

### Running a statement from the editor

Statements the operator runs go straight down the human channel. Rows stream back to the grid in batches.

```mermaid
sequenceDiagram
    actor Operator
    participant UI as Webview UI
    participant Host as Host (query service)
    participant Srv as stackql srv
    participant API as Provider API

    Operator->>UI: Run statement
    UI->>Host: run_query over IPC
    Host->>Srv: Simple query on pg wire
    Srv->>API: REST or GraphQL calls
    API-->>Srv: Responses
    Srv-->>Host: Row stream and notices
    Host-->>UI: Row batches as events
    UI-->>Operator: Results grid and history entry
```

### A chat turn with an approval

Statements a model proposes go down the agent channel. The MCP server classifies each statement and, depending on the safety mode, asks the operator for approval through the host before running it.

```mermaid
sequenceDiagram
    actor Operator
    participant UI as Webview UI
    participant Agent as Host (agent runtime)
    participant LLM as Inference backend
    participant MCP as stackql mcp

    Operator->>UI: Chat message
    UI->>Agent: send_message over IPC
    Agent->>LLM: Messages and tool definitions
    LLM-->>Agent: Tool call run_mutation_query
    Agent->>MCP: tools/call
    Note over MCP: Mode is safe and the statement is a mutation
    MCP->>Agent: elicitation/create with the SQL
    Agent->>UI: Approval card
    Operator->>UI: Approve or decline
    UI->>Agent: Decision
    Agent->>MCP: Elicitation result
    MCP-->>Agent: Tool result as JSON
    Agent->>LLM: Tool result
    LLM-->>Agent: Final answer
    Agent-->>UI: Answer, rows in the grid, audit entry
```

### Safety modes

The workspace safety setting is passed to the MCP server as `server.mode`. The engine does the classification and the gating; the app only renders the approval.

| Mode | SELECT and metadata | INSERT, UPDATE, REPLACE | DELETE | EXEC |
|---|---|---|---|---|
| `read_only` | allow | refuse | refuse | refuse |
| `safe` (default) | allow | needs approval | needs approval | needs approval |
| `delete_safe` | allow | allow | needs approval | needs approval |
| `full_access` | allow | allow | allow | allow |

### Inference backends

Chat is optional. When it is enabled, the agent runtime talks to a model through one interface with several backends behind it.

```mermaid
flowchart LR
    rt["Agent runtime"] --> iface{{"InferenceBackend"}}
    iface --> key["API key<br/>Gemini, Anthropic, OpenAI, OpenAI-compatible"]
    iface --> plan["Plan sign-in<br/>Sign in with ChatGPT"]
    iface --> acp["Delegated<br/>ACP agent on this machine"]
```

The delegated backend that exists today is the GitHub Copilot CLI. It runs with the sign-in the CLI already has, which the app never sees, and it is given the engine's tools and nothing else. It cannot pass the engine's approval prompt on, so with it a statement that needs approval is refused instead of asked about. The findings behind this are in [docs/spike-acp.md](docs/spike-acp.md).

The backends differ in how the operator signs in and in who runs the agent loop.

| Backend | Sign-in | Agent loop | MCP client |
|---|---|---|---|
| API key | Key held in the OS keychain | Host | Host |
| Plan sign-in | Sign in with ChatGPT | Host | Host |
| Delegated | Whatever the installed ACP agent already uses | The agent | The agent |

### Connections

All engine access sits behind one interface. The first releases work only with the local engine. Connecting to a remote StackQL server comes later and does not change the UI.

```mermaid
flowchart LR
    panes["UI panes"] --> conn{{"Connection"}}
    conn --> lc["LocalConnection<br/>child processes on this machine"]
    conn -.-> rc["RemoteConnection, later<br/>pg wire with TLS, MCP over HTTP"]
```

## Credentials

Provider credentials are environment variables read by the engine, as they are for the `stackql` CLI. The host builds the environment for the engine processes from values in the OS keychain or from a dotenv file the operator points at. The UI shows which variables are set and never shows their values.

## Development

These steps were run on Windows 11.

Prerequisites:

- Rust stable toolchain, 1.90 or later, from rustup
- Node.js LTS
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform
- A `stackql` binary on `PATH`, or its location in the `STACKQL_BIN` environment variable

```
npm install
npm run tauri dev
```

To build the executable without an installer:

```
npm run tauri build -- --no-bundle
```

On Windows that produces `src-tauri/target/release/stackql-workbench.exe`.

Checks:

```
npm run lint
npm run typecheck
npm test

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The integration tests start a real `stackql` and are skipped when none is found. They need no cloud credentials and no network.

### Test build for macOS

CI builds the app for macOS on every run and keeps the disk image as the workflow artifact `stackql-workbench-macos-universal`. It runs on Apple Silicon and Intel. It is for testing and is not a release: the signature is ad hoc, with no Developer ID, and nothing is notarised.

To try it:

- Download the artifact from the run's page on GitHub, which needs a GitHub sign-in, and open the disk image inside it.
- Drag the app to Applications. macOS refuses to open it the first time. Allow it under System Settings, Privacy & Security, with Open Anyway. The other way is `xattr -dr com.apple.quarantine "/Applications/StackQL Workbench.app"` in a terminal.
- Install the `stackql` CLI from the PKG on the [release page](https://github.com/stackql/stackql/releases/latest). Homebrew has v0.12.824, which is older than the v1.0.888 this app is built and tested against. The app looks in `/usr/local/bin`, where the PKG puts it, and then in `/opt/homebrew/bin`. If it is somewhere else, set its path under Settings.
- An app started from Finder does not see variables exported in a shell profile. For provider credentials, set a dotenv file under Settings.

The same build on a Mac is `npm run tauri build -- --target universal-apple-darwin --bundles app,dmg`, after `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

### Using the app

The engine keeps its provider cache in a folder of the app's own: `.stackql` beside the executable, or the app data directory when that place cannot be written to, as under `Program Files`. A first run therefore lists no providers. Run `REGISTRY PULL github;` in the editor to install one. To use another folder, for example the `.stackql` folder you already use with the `stackql` CLI, set it under Settings.

Provider credentials are environment variables the engine reads. On Windows the engine sees the variables of your user account. To use a dotenv file, set it under Settings.

The app opens in chat. The side menu leads to the explorer, which holds the provider tree, the query editor and the results grid, to the query library, and to the activity list. The File, Edit, View, Query, Providers and Help menus repeat those.

Chat needs a model backend. The first time you send a message without one, the model backend settings open. There are two kinds.

- GitHub Copilot: uses the Copilot CLI installed on this machine and the sign-in it already has. Install the CLI, run `copilot login` once, then choose GitHub Copilot. Requests count against your Copilot plan, and the settings list each model with what it costs. There is an experimental setting that lets the agent hand the parts of a request that spans several providers to subagents. It is off by default.
- An API key for Gemini, Anthropic, or an OpenAI-compatible server, which covers local inference. The key goes to the operating system keychain.

With an API key backend, independent queries the model asks for in one step run at the same time.

Without a backend the explorer and the query editor work as before.

## Repository layout

The layout is shown below.

```
stackql-workbench/
  src/                  webview (React)
    host/               typed wrappers over IPC
    lib/                pure logic with tests
    state/              hooks that connect the host to the panes
    panes/              shell, chat, explorer, editor, results, library, activity, settings, statusbar
    ui/                 small shared components
  src-tauri/            host (Rust)
    src/
      engine/           discovery, supervisor, process lifecycle
      connection/       Connection trait, LocalConnection
      query/            pg wire client, statement splitting, results
      agent/            MCP client, approvals, backends, loop, ACP client, delegated agent
      secrets/          keychain access
      activity/         operator history and the engine audit log
      icons/            provider icons
      library/          the query library
      config/           settings
      ipc/              command and event definitions
    examples/           the probes behind the spike reports
    tests/              integration tests against a real stackql
  docs/                 design notes and spike reports
```

What the engine actually does on each channel is recorded in [docs/spike-pgwire.md](docs/spike-pgwire.md) and [docs/spike-mcp.md](docs/spike-mcp.md). What the Copilot CLI does as a delegated agent is in [docs/spike-acp.md](docs/spike-acp.md).

## Roadmap

Milestones are delivered in order where they depend on each other. Each one leaves the app in a usable state. M0 is done, and the core of M3 was built ahead of M1 and M2 so that both the IDE and chat could be tried together. The first delegated agent from M5, the GitHub Copilot CLI, is also in. Most of M1 is in: tabs, completion, the JSON cell viewer, history and export. Saved `.iql` files, cancel and a streaming grid are not.

| Milestone | Scope |
|---|---|
| M0 Foundations | App scaffold, engine discovery and supervision, pg wire spike, provider explorer, single editor and results grid, CI on Windows and macOS |
| M1 Query IDE | Editor tabs, completion from provider metadata, streaming grid with JSON cell viewer, cancel, history, saved `.iql` files, export |
| M2 Packaging | Signed artefacts consumed by the StackQL MSI and PKG builds, version pinning, first IDE-only release |
| M3 Chat | Agent loop, stdio MCP client with approvals, activity pane, Gemini API key backend, inference settings |
| M4 More backends | Anthropic, OpenAI and OpenAI-compatible keys, Sign in with ChatGPT |
| M5 Delegated agents | ACP backend for agents already installed on the machine |
| Later | Remote connection to a StackQL server |

## Packaging

StackQL Workbench has no installer of its own. It ships inside the StackQL installers, beside the `stackql` binary.

- Windows: the StackQL MSI installs `stackql-workbench.exe` next to `stackql.exe` and adds a Start Menu entry. The app needs the Microsoft WebView2 runtime, which is present on Windows 11.
- macOS: the StackQL PKG installs `StackQL Workbench.app` to `/Applications` alongside the `stackql` CLI.
- Bundle identifier: `io.stackql.workbench`.
- This repository builds the per-platform artefacts. The StackQL release workflow consumes a pinned Workbench version.

## Prior art

Two earlier prototypes informed the layout and the API shape. Neither is used at runtime.

- [stackql-playground](https://github.com/stackql/stackql-playground): a browser UI with an explorer tree, an editor and a results grid
- [stackql-middleware](https://github.com/stackql/stackql-middleware): an HTTP layer over `stackql srv`

## Licence

MIT, the same as `stackql`. See [LICENSE](LICENSE).
