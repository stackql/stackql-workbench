# StackQL Workbench

This file is the working agreement for coding agents in this repository. Read it and `README.md` in full before changing anything.

## What this is

StackQL Workbench is the desktop UI for [StackQL](https://github.com/stackql/stackql). It combines a query IDE with a chat interface over a local `stackql` engine. It is a native app for Windows and macOS, installed beside the `stackql` binary by the StackQL MSI and PKG installers. Linux is out of scope.

## Status

Pre-alpha, milestone M0 not yet started. Update this line when a milestone lands. The roadmap is in `README.md`.

## Architecture rules

These rules are fixed. If one cannot be met, stop and ask instead of working around it.

- The webview is not served over HTTP and opens no network listener. It loads from the app bundle and reaches the host only through typed IPC commands and events.
- The webview holds no secrets and makes no direct calls to the engine, to inference providers or to the filesystem. All of that goes through the host.
- The engine is reached over two channels that are not interchangeable.
  - Human channel: `stackql srv` over the Postgres wire protocol. Used by the explorer and the editor. Statements here are written or explicitly run by the operator.
  - Agent channel: `stackql mcp` over stdio. Used only by the agent runtime. Statements here originate from a model.
- The engine enforces safety. Do not build a second SQL classifier or approval gate in the host. Pass the workspace safety mode to the MCP server and implement the client side of its approval flow.
- All engine access sits behind a `Connection` interface. Only `LocalConnection` exists for now. Code above that interface must not assume the engine is a child process, because a remote connection comes later.
- All inference sits behind an `InferenceBackend` interface. The chat UI works unchanged across backends. With no backend configured the chat pane is hidden and the IDE is fully usable.
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
| MCP client | `rmcp` (the official Rust MCP SDK) |
| Secrets | OS keychain through the `keyring` crate |
| Package manager | npm |

The MCP client library must support the client side of elicitation and protocol revision negotiation. Confirm that before committing to it.

## Repository layout

The intended layout is below. Keep it current as the code lands.

```
stackql-workbench/
  src/                  webview (React)
    panes/              explorer, editor, results, chat, activity, settings
    host/               typed wrappers over IPC
  src-tauri/            host (Rust)
    src/
      engine/           discovery, supervisor, process lifecycle
      connection/       Connection trait, LocalConnection
      query/            pg wire client, row streaming, cancel
      agent/            MCP client, InferenceBackend trait, backends, loop
      secrets/          keychain access
      config/           settings and workspaces
      ipc/              command and event definitions
  docs/                 design notes and spike reports
```

Only `src/host/` may import Tauri APIs. Panes call the typed wrappers in that directory.

## Commands

These are the expected commands. Milestone M0 must make them true and then update this section with anything that differs.

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

## Engine interface

The facts in this section were read from `stackql` `main` in November 2026. Confirm them against `stackql --help` for the installed version. The reference docs are `docs/mcp.md` and `pkg/mcp_server/README.md` in the stackql repository.

### Discovery

Resolve the `stackql` binary in this order and stop at the first hit.

1. Explicit path in settings
2. `STACKQL_BIN` environment variable
3. Sibling of the Workbench executable
4. Well-known install locations for the platform
5. `PATH`

Show the resolved path and version in the UI. If nothing is found, say so plainly and point at the settings field.

### Process lifecycle

One supervisor owns every child process.

- Children must not outlive the app, including after a crash or force quit. Use a job object on Windows and a process group on macOS.
- Wait for readiness with a timeout. Surface failures in the UI with the captured stderr.
- Capture stderr of every child. For a stdio MCP process, stdout carries protocol frames only.

### `stackql srv` (human channel)

The explorer and the editor use this channel.

- Always pass `--pgsrv.address 127.0.0.1`. The default is `0.0.0.0`.
- Pass `--pgsrv.port` with a free port chosen by the host. The default is 5466 and may be taken.
- Use the simple query protocol until the M0 spike confirms what else the server supports. Do not assume prepared statements, typed columns or cancel behave as they do in PostgreSQL.
- Upstream API failures may surface as an empty result plus a notice or a stderr line, not as an error. Capture pg notices and `srv` stderr and show them beside the result.
- The explorer is built from metadata statements: `SHOW PROVIDERS`, `SHOW SERVICES IN`, `SHOW RESOURCES IN`, `SHOW METHODS IN` and `DESCRIBE`. Quote or validate identifiers; never build statements by raw string interpolation of UI input.

### `stackql mcp` (agent channel)

Only the agent runtime uses this channel.

- Always pass `--mcp.server.type=stdio`. The default transport is HTTP.
- Configuration is inline JSON through `--mcp.config`. This app sets `server.mode`, `server.render` and `server.audit.file.dir`.
- The audit log is on by default and writes JSONL. Set `server.audit.file.dir` to the app data directory, otherwise the log lands in the working directory. The activity pane reads this log.
- Ask for JSON results, either per call with `format: "json"` or with `server.render: "json"`, so agent results render in the same grid as editor results.

The workspace safety setting maps directly onto `server.mode`.

| Mode | SELECT and metadata | INSERT, UPDATE, REPLACE | DELETE | EXEC |
|---|---|---|---|---|
| `read_only` | allow | refuse | refuse | refuse |
| `safe` (default) | allow | needs approval | needs approval | needs approval |
| `delete_safe` | allow | allow | needs approval | needs approval |
| `full_access` | allow | allow | allow | allow |

"Needs approval" is implemented with MCP elicitation. The host's MCP client must advertise the elicitation capability, otherwise gated tools are refused. The approval card in the UI is the answer to the server's `elicitation/create` request. Show the exact SQL on the card. Never auto-accept.

### Credentials

Provider credentials are environment variables read by the engine. The app never parses or displays their values.

- Apps launched from Finder or the Dock on macOS do not inherit shell profile exports. Do not rely on the app's own environment.
- The host builds the child environment explicitly. Values come from the OS keychain and are injected at spawn, or from an operator-supplied dotenv file passed with `--env.file`.
- The MCP `reload_credentials` tool re-sources `--env.file`. `stackql srv` needs a restart to pick up changes.
- The UI shows variable names and whether they are set. Never log or display environment contents.

## Inference

Backends are built in this order.

1. API key. Gemini first because it works on the free tier, then Anthropic, OpenAI and any OpenAI-compatible base URL, which covers local inference. The host runs the loop and owns the MCP client.
2. ChatGPT plan sign-in through OpenAI's Sign in with ChatGPT programme. This needs a client ID issued to this project. Do not start it until the maintainer confirms the client ID exists.
3. Delegated. An ACP agent that the operator has installed and signed in to themselves, for example Claude Code through its ACP adapter. In this mode the agent is the MCP client and spawns its own `stackql mcp`. Start that process in `read_only` until the agent's elicitation handling is verified.

These rules hold for every backend.

- Never reuse, read or proxy another product's OAuth credentials or client IDs. That includes Claude Code, Gemini CLI and Codex. Never add a vendor login button without a client ID issued to this project for that purpose.
- API keys and tokens live in the OS keychain. Never in settings files, logs, the webview or `localStorage`.
- The model never sees credentials. Tool results are the only engine data it receives.

## UI notes

A few fixed points for the interface.

- Brand colour is Classic Blue, `#0F4C81`.
- Saved queries are plain `.iql` files on disk, not an app database.
- Pane set: explorer tree, editor tabs, results grid, chat, activity, settings.
- Nested JSON is common in results. The grid needs a cell viewer for it.

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

The licence is decided: MIT, the same as `stackql`.
