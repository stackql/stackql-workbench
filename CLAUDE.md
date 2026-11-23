# StackQL Workbench

This file is the working agreement for coding agents in this repository. Read it and `README.md` in full before changing anything.

## What this is

StackQL Workbench is the desktop UI for [StackQL](https://github.com/stackql/stackql). It combines a query IDE with a chat interface over a local `stackql` engine. It is a native app for Windows and macOS, installed beside the `stackql` binary by the StackQL MSI and PKG installers. Linux is out of scope.

## Status

Pre-alpha. This much has landed on Windows.

- M0, foundations: engine discovery and supervision, the pg wire query service, the explorer, one editor buffer and the results grid.
- The core of M3, chat: the MCP client with approvals, the agent loop, the activity pane, and API key backends for Gemini, Anthropic and OpenAI-compatible servers. Anthropic and OpenAI-compatible were M4 items and came along because the backend interface made them cheap.
- The first delegated agent, an M5 item: the GitHub Copilot CLI, driven over the Agent Client Protocol. It uses the sign-in the CLI already has.
- A chat-first layout: chat is the view the app opens in, with a side menu for the explorer and activity, and File, Edit, View, Query, Providers and Help menus.
- Most of M1, the query IDE: editor tabs, completion from provider metadata, the JSON cell viewer, statement history, export as CSV and JSON, and a `stackql exec` command for a statement.
- A query library view: the entries of the published query library, for the operator, with no chat backend needed.
- A conversation that shows a turn as its answer: the calls the assistant made are a list of steps that folds away, a call that failed is written to the app's log and not listed, the result set is a table that sorts and downloads, and a model can ask for a chart with a chart block.
- Version 0.2.0, the settings: the model of an API key backend is chosen from the list its provider gives, each backend keeps its own key, the reason a backend cannot be saved yet is said beside the button, and every path has a Browse button that opens the system's dialog.

Not started: the rest of M1 (saved `.iql` files, cancel, a streaming grid), M2 (packaging), plan sign-in and any delegated agent other than the Copilot CLI. Replies from the API key backends are not streamed yet. Replies from the Copilot CLI are.

CI has a job that builds a universal macOS disk image and keeps it as a workflow artifact, so the app can be tried on a Mac. The signature is ad hoc and nothing is notarised. It is a test build, not M2.

CI also keeps what the StackQL MSI and PKG are built from: the optimised Windows executable for each processor the MSI comes for, as `stackql-workbench-windows-x64` and `stackql-workbench-windows-arm64`, and the Mac app bundle, packed with tar, as `stackql-workbench-macos-universal-app`. Each comes with its SHA-256. Neither is signed for release. The maintainer said on 19 November 2026 that the StackQL release signs what it ships, so this repository holds no signing identity and signs nothing but the ad hoc signature a Mac needs to run the app at all. Workflow artifacts last 90 days and are not a release.

A build that ships comes from a release of this repository. The maintainer decided that on 20 November 2026. Publishing a release from the tag `v<version>` runs the Release workflow, which builds the three files from the commit the tag names and attaches them: `stackql-workbench_windows_amd64.exe`, `stackql-workbench_windows_arm64.exe` and `stackql-workbench_darwin_multiarch.app.tar.gz`, each with a `.sha256` beside it. The build scripts of the two installers fetch the files of the newest release. `.github/workflows/build.yml` builds, checks and names the files, and both CI and the Release workflow call it, so what a release attaches has been put together on every run before it. `scripts/check-release-tag.js` stops a release whose tag is not the version the app carries. No release has been made yet, so the step that attaches the files has not run.

What has and has not been run:

- Everything has been run on Windows 11 x64 against `stackql` v1.0.888.
- The app has not been opened on a Mac. The macOS-only code has run only in tests, on the macOS runner in CI.
- CI first ran on 19 November 2026 and passes on both runners. On macOS that is lint, the 302 webview tests, clippy and 260 host tests against `stackql` v1.0.888: the supervisor, the watchdog and the integration tests that start a real engine. The keychain test reported ok, but it skips itself without failing when the keychain refuses it, so the macOS keychain store is not confirmed.
- The bundle job builds the universal disk image and its checks pass: both architectures are in the executable and the ad hoc signature verifies.
- No Mac older than macOS 13 was tried, so the refusal to open the app there has not been seen. What CI checks is that the bundle declares the minimum.
- Windows on Arm has run only in CI, on GitHub's `windows-11-arm` runner, with the Rust toolchain and Node both built for Arm and `stackql` v1.0.888 from the release's arm64 archive. Lint, the webview tests, clippy and the host tests pass there: 270 unit tests, and the integration tests that start a real engine. The optimised executable built there names arm64 as its processor and asks for the same 19 libraries as the x64 one. The app has not been opened on an Arm machine, and the x64 executable was not tried under emulation.
- Homebrew installs `stackql` v0.12.824. With it two agent tests failed on the macOS runner: a row value arrived as `{"String":"1","Valid":true}`, and tool calls did not overlap. With v1.0.888 from the release package the same tests pass on the same runner, so CI installs the package on macOS. The app does not check the engine's version, which is one of the open questions.
- No API key backend has been run against a real inference provider. Each is tested against a local stub that checks what goes on the wire, and the loop is tested against a real `stackql mcp` with a scripted model.
- The Copilot backend has been run for real, against GitHub Copilot CLI 1.0.113 with a signed-in account. Its protocol handling is also tested against a scripted agent.
- The explorer, completion, history, export through the save dialog, the activity filters, the theme choice and the query library were each driven in the built app on Windows. The "Copy as CLI" commands were run in Windows PowerShell 5.1 and PowerShell 7 against the real engine. The POSIX form was checked in a shell under WSL with a stand-in program, not on macOS.
- The Help menu's links have not been opened by a test. The address each one opens is tested. Help > Show Log File has not been clicked either, since it opens a window on the desktop. The log file it shows was read after real turns.
- The conversation layout, the charts and the sortable table were driven in the built app on Windows in both themes, with a scripted model against the real engine: a declined approval, a call that failed and was not listed, each chart type, a chart that could not be drawn, sorting, and a CSV saved through the save dialog. Two turns were then run for real through the Copilot CLI 1.0.114 on `claude-haiku-4.5`. In the first the model wrote a chart block from the guidance on its first try. In the second three of its calls failed on the way: none was listed, and all three were in the log with their statement or arguments. No API key backend has drawn a chart from a real model.
- Which engine an installed app starts was checked on Windows with a build of the app and a copy of `stackql.exe` in one folder, the way the MSI lays them out. With nothing set it started the engine beside it. With `STACKQL_BIN` naming another engine, and with it pointing nowhere, it still did, and said the variable was not used. With a path in settings it started that engine, and with a path in settings that pointed nowhere it stopped with the reason. The folder was one an ordinary account can write to, so the fallback of the data folder under `Program Files` was not part of this. The macOS rule has run only as unit tests.
- What the Windows executable asks the system for was read from its import tables before and after the C runtime was linked in. Before, it asked for seven libraries of the Universal C runtime. After, for 19 libraries that are all Windows itself.
- The page renderer was checked on Windows 11 with a build of the app in a folder of its own. With nothing beside it, the renderer process ran from the system's WebView2. With a copy of that runtime in a `WebView2Runtime` folder beside it, the renderer process ran from that folder and the app came up with its engine. With a `WebView2Runtime` folder that held no runtime, the system's was used. The copy was of the runtime Windows had installed, version 157, not of Microsoft's Fixed Version package, which has the same layout and was not downloaded.
- No machine without a WebView2 runtime was tried, and no freshly installed Windows 11. A machine without one was imitated on Windows 11 by pointing the loader's variable at an empty folder. The optimised build from CI showed the app's own dialog, the heading and the one sentence each on one line, and no terminal: the process had no console host, where a debug build has one. It exited with code 1 when the dialog was closed. A click on the link, sent to the dialog of a debug build, brought Microsoft's page up in the browser and left the dialog open. Nothing is written to the app's log, which starts after the window is made. Before the check was added, the optimised build showed Tauri's own dialog and then ended in a panic.
- The data folder of an installed app was checked on Windows with the app and a copy of `stackql.exe` in a folder the account could read and run from but not write to, which is what `Program Files` is to an ordinary account. The app was started with that folder as its working folder. It started the engine beside it, the engine's data folder was `<app data dir>/engine`, and nothing was added to the folder of the app. The real `Program Files` was not used, since that needs an administrator, and the note in the settings pane was not looked at in that run.
- That run was before an installed app used the home folder. After the change the same layout was run again: the engine beside the app was started on `.stackql` in the home folder, the app listed the providers the operator's own `stackql` command had pulled there, and nothing was added to the folder of the app. The app alone in a folder it could write to, which is what a build is, kept a `.stackql` folder beside itself and listed no providers. The fallback to the local app data directory has run only in tests, and the macOS rule only as unit tests.
- The token counts were seen in the built app with a scripted model, and for real through the Copilot CLI: one prompt to a probe to see what the CLI sends, and one turn through the app, which showed the count on the steps line and in the log. The counts of Gemini, Anthropic and an OpenAI-compatible server are read as their documentation describes and tested against stubs, not against the real services.
- The settings of 0.2.0 were driven in a debug build on Windows, in both themes. Opened on an OpenAI-compatible backend with the address of a stand-in server, the pane asked it for its models once, with no key, and showed them as a list with the saved model chosen. Switched to Gemini with no key stored, it said "Enter an API key to save." beside a Save button that was not available. Browse opened the system's folder dialog for the data folder and its file dialog for the credentials file and for the engine, each under its own title, and the path chosen went into the field. Cancel left the field as it was. The model lists of Gemini, Anthropic and OpenAI themselves have not been read: each is tested against a stub that checks what goes on the wire. The dialogs have not been opened on macOS.
- The supervisor's tests see a child end by waiting on a handle to it on Windows, and with `kill -0` on Unix. They used to ask `tasklist`, which on a busy machine could use up the time a test allowed. They passed 30 runs in a row with every core busy. With twice as many busy loops as cores a different test, `an_unexpected_exit_is_reported_with_its_code`, missed its 10 second limit twice in 30 runs.

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
| Save and open dialogs | `tauri-plugin-dialog`, called from host commands only: saving an export and choosing a path in Settings. The webview has no access to it |
| Links | `tauri-plugin-opener`, called from one host command that holds a fixed list of the app's own links, and from the dialog shown when no WebView2 runtime is found |
| Completion | `@codemirror/autocomplete`, with a source written in this repository |
| HTTPS client | `reqwest` with the OS TLS stack (`native-tls`) |
| ACP client | Written in this repository: JSON-RPC over stdio, protocol version 1, the client side only |
| Markdown in replies | Written in this repository: a small reader that builds a tree, never HTML |
| Charts in replies | Written in this repository: a chart block read as data and drawn as SVG. No charting library, in the webview or the host |
| App log | Written in this repository: one JSON lines file for each run, in the app data directory |

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
    lib/                pure logic with tests: results, cells, sorting, export formats, explorer tree, statement templates, completion, tabs, history, the CLI command, chat, the conversation layout, the chart block and its layout, activity, the query library, menu, theme, markdown, the model choice
    state/              hooks that connect the host to the panes
    panes/              shell (menu bar, side menu), chat, explorer, editor, results, library, activity, settings, statusbar
    ui/                 small shared components
  src-tauri/            host (Rust)
    src/
      engine/           discovery, data folder, port selection, supervisor, job object, watchdog
      connection/       Connection trait, LocalConnection, safety mode, agent channel
      query/            pg wire session, statement splitting, results, explorer statements
      agent/            MCP client, approvals, InferenceBackend trait, backends and the models they list, loop, ACP client, delegated agent, what a model is told about presentation, the turn log
      secrets/          keychain access
      activity/         operator history, engine audit log reader
      icons/            provider icon lookup, fetch and cache
      library/          the query library's index and documents, fetch and cache
      config/           settings
      ipc/              command and event definitions, saving an export, choosing a path, the app's own links
      applog.rs         the app's own log
      webview_runtime.rs  the page renderer on Windows: using one shipped beside the app, and the dialog shown when there is none
    .cargo/             build flags: the C runtime linked in on Windows
    examples/           pgwire_spike and mcp_spike, the probes behind the spike reports
    tests/              integration tests against a real stackql
  scripts/              test launcher, the check of what a Windows executable asks the system for, the check of a release tag against the app's version
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
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg   on a Mac, the test build CI keeps
```

Things to know about them:

- `npm run lint` runs ESLint and then `prettier --check`.
- `npm test` goes through `scripts/test.js`. Vitest fails on Windows when the working directory is spelled with a lower-case drive letter, which an editor terminal can do. The launcher corrects that.
- `cargo test` includes integration tests that start a real `stackql`. They are skipped, with a note on stderr, when no binary is found. They need no credentials and no network.
- The release executable is `src-tauri/target/release/stackql-workbench.exe` on Windows.
- The engine's `--approot` depends on how the app got there. An installed app uses `.stackql` in the home folder, the one the `stackql` command uses. A build from this repository uses `.stackql` beside its executable: `src-tauri/target/release/.stackql`, or `target/debug/.stackql` under `npm run tauri dev`. Where the folder cannot be written to, the fallback is `<app local data dir>/engine`, which on Windows is `%LOCALAPPDATA%\io.stackql.workbench\engine`. The operator can name another folder in Settings.
- Settings are in `<app config dir>/settings.json`. The agent audit log is in `<app data dir>/audit` and the operator's statement history in `<app data dir>/history.jsonl`. Those two do not move with the engine's data folder.
- The app's own log is in `<app data dir>/logs`, one file for each run, named `stackql_workbench_<UTC time>.log`. The host writes it and nothing reads it back. It is apart from the engine's audit log, which the engine writes. The 20 newest files are kept.
- The binaries are built to need nothing from the system that has to be installed. The maintainer asked for that on 19 November 2026.
  - Windows: the C runtime is linked in whole, with `+crt-static` in `src-tauri/.cargo/config.toml`. Tauri's own default links the Visual C++ runtime in and leaves the Universal C runtime to Windows, and it would undo the flag for that part, so `build.windows.staticVCRuntime` is `false` in `tauri.conf.json`. Keep the two together. `node scripts/check-exe-imports.js <exe>` reads the import tables and fails on a runtime library. With `x64` or `arm64` after the path it also fails when the executable is built for another processor. CI runs it on each optimised build.
  - macOS: the app links only to system frameworks and libraries under `/usr/lib`. CI checks that with `otool`. CI also checks that the bundle declares the macOS version in `tauri.conf.json` as its minimum and that both architectures are built for it.
  - The WebView2 runtime is the one thing a Windows executable cannot carry. `webview_runtime.rs` uses a runtime in a `WebView2Runtime` folder beside the executable when there is one, by setting the loader's variable before anything else runs, and the system's runtime otherwise. Which was used is in the app's log. A runtime beside the app wins over a variable that was already set, the same rule the engine follows.
  - The installers do not ship that folder, so the system's runtime is the normal case. Microsoft says the runtime is included as part of Windows 11 and is on the vast majority of Windows 10 devices. Where there is none, the app says so before it starts anything. `webview_runtime::require` asks the question Tauri asks before it makes a window. Where the answer is no it shows a dialog of the system's, "StackQL Workbench requires the Microsoft Edge WebView2 Runtime", with a link to Microsoft's page, and exits. The maintainer asked for that on 20 November 2026, in place of any change to the installer. Without it the app ends in a panic, behind a dialog of Tauri's that names no app.
  - The dialog says that line and one sentence more: "See" the address "for installation instructions." The maintainer asked for it to be that short. It does not say what the runtime is for or where it was looked for, and it is the same whatever the reason no runtime could be used. Do not add to it.
  - A debug build is a console program, so a terminal opens with it, and with this dialog. The optimised build is a windowed program and opens none.
- To run a build beside an installed copy without sharing its settings, history and logs, give it another identifier: `npm run tauri build -- --debug --no-bundle --config <file>` with a file that holds `{ "identifier": "io.stackql.workbench.dev" }`. The app data and config directories are named after the identifier.
- One test writes and removes a throwaway entry in the real OS keychain. It skips itself where no keychain can be opened.
- An editor's language server can build in the same `target` directory and hold a file the build needs, which shows up as linker error `LNK1104` on Windows. Running the command again clears it.

## Engine interface

The facts in this section were read from `stackql` `main` in November 2026, and the `srv` facts were then tested against `stackql` v1.0.888. The evidence is in `docs/spike-pgwire.md`. Confirm against `stackql --help` for the installed version. The reference docs are `docs/mcp.md` and `pkg/mcp_server/README.md` in the stackql repository.

### Discovery

Resolve the `stackql` binary in this order and stop at the first hit.

1. Explicit path in settings
2. The engine installed with the app
3. `STACKQL_BIN` environment variable
4. Well-known install locations for the platform
5. `PATH`

Show the resolved path and version in the UI. If nothing is found, say so plainly and point at the settings field.

The engine installed with the app is the default. The maintainer decided that on 19 November 2026, for the MSI and then for macOS: the installers ship the two together, and that pair is the one built and tested together. Only a path in settings comes before it, because that is a choice the operator can only make after the install. `STACKQL_BIN` used to come second. It now comes after, since a variable can be older than the install and would swap the engine without anyone choosing that. When the variable is set and passed over, the status says so, and a variable that points nowhere does not stop the installed engine from starting.

What "installed with the app" means differs by platform, because the installers lay the pair out differently.

- Windows: `stackql.exe` in the same folder as the Workbench executable. That is where the MSI puts it.
- macOS: for an app that runs from a bundle, an engine inside the bundle beside the executable, and failing that `/usr/local/bin/stackql`, which is where the PKG puts the command. The PKG does not put an engine inside the bundle today. If a later one does, that one is found first.
- A build from this repository has no engine beside it and, on macOS, is not in a bundle. It has no installer behind it, so there the variable is still the next thing tried.

On an Intel Mac the common package manager also links its `stackql` into `/usr/local/bin`. The app cannot tell that one from the PKG's. Whichever is at that path is taken as the installed engine, as it was the first place looked before this change.

The two explicit sources are strict when they are reached. If the settings path is set and does not point to a file, or `STACKQL_BIN` is the source in turn and does not, that is an error and the search stops there. Running a different binary than the one the operator named would be worse than stopping.

### Process lifecycle

One supervisor owns every child process.

- Children must not outlive the app, including after a crash or force quit. Use a job object on Windows, created with kill-on-close. On macOS a process group is not enough on its own, because nothing signals the group when the app receives SIGKILL. Each child therefore also gets a watchdog: `/bin/sh` blocked on a pipe that only the app holds open, which signals the group when the pipe closes.
- On Windows a child can start out in a job of its own. A packaged app does, and a program on `PATH` can be an alias for one. Such a process cannot join a job that already has members, so it gets a kill-on-close job to itself. An empty job always takes it.
- The watchdog script must stay POSIX. `kill -s TERM -- -PGID` works in every `/bin/sh` tried. `kill -TERM -- -PGID` does not.
- Start console children with `CREATE_NO_WINDOW` on Windows, otherwise a console window flashes up.
- Wait for readiness with a timeout. Surface failures in the UI with the captured stderr.
- The port is chosen first and given to the engine after, and something else can take it in between. The engine then exits at once, with exit code 0. The host starts it again on a fresh port, up to three times, before it reports a failure. An engine that is running and does not answer is not started again. This showed up in CI, where tests start engines side by side.
- Capture stderr of every child. For a stdio MCP process, stdout carries protocol frames only.

### `stackql srv` (human channel)

The explorer and the editor use this channel. Every point below was tested. See `docs/spike-pgwire.md`.

Flags the host passes:

- `--pgsrv.address 127.0.0.1`, always. The default is `0.0.0.0` and the listener has no authentication.
- `--pgsrv.port` with a free port chosen by the host. The default is 5466 and may be taken.
- `--approot` with the engine's data folder, always. The engine's own default is `.stackql` in the working directory, so the provider cache would otherwise follow wherever the app was started from. The host resolves the folder in this order and stops at the first hit.
  1. Explicit folder in settings. This source is strict: a folder that is not a full path, or cannot be created or written to, is an error and the engine does not start.
  2. For an installed app, `.stackql` in the home folder. For a build that was not installed, `.stackql` beside the Workbench executable.
  3. `<app local data dir>/engine`. Used when the second cannot be written to. The settings pane says so.
- An installed app shares the home folder's `.stackql` with the `stackql` command. The maintainer decided that on 20 November 2026. The installers put the command and the app down together, the command shell the MSI installs starts the command in the home folder, and a provider pulled in one should be there in the other.
- An app counts as installed when the engine sits beside its executable, which is how the MSI lays them out, or when it runs from a macOS bundle. It is the reading discovery makes of "the engine installed with the app".
- An installed app writes nothing to the folder it was installed in. The MSI installs for the whole machine under `Program Files`, where an ordinary account cannot write, and a macOS bundle is signed. Its state is kept for each user.
- A build from this repository does not share the operator's `.stackql` folder unless they point it there. It keeps its own beside the executable, so development and tests stay apart from the operator's providers.
- The fallback is in the local app data directory because it is a cache that can be pulled again. It used to be in the app data directory, which on Windows follows a user from machine to machine, and a cache of two providers measured 95 MB.
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
- Leaving a failed call out of the conversation is a matter of display, decided by the maintainer on 19 November 2026. The model still receives the engine's error exactly as the engine sent it, and the host writes it to the app's log. A call counts as failed when the engine, or the agent, said it failed. Nothing in the app works that out.
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
- Each backend keeps its own key in the keychain, so switching back to a backend does not ask for its key again. Removing the model backend deletes the key of the backend it removes.
- The settings pane offers the models a backend's provider lists, from `agent/backends/models.rs`: Gemini's model list narrowed to the models that take `generateContent`, Anthropic's without retired models, and everything an OpenAI-compatible server lists. It is asked when the pane opens on a backend whose key is stored, or on a server of the operator's own that needs no key, and otherwise on List models. A key typed and not saved yet is sent with that request and kept nowhere. When the list cannot be read, the model stays a field to type in, with the provider's message under it.
- Every backend reports what a call used in the same three counts: the whole input, the part of it read from the provider's cache, and the output, with the model's thinking where the provider counts it. The host adds them up over the calls of a turn. A count a provider does not send stays unknown and is not turned into zero.
- A model is told how its work is shown, and how to ask for a chart, by one text in `agent/guidance.rs`. The host's loop puts it in the system prompt ahead of the engine's guidance. A delegated agent gets it with the first message. It is about presentation only, which is this app's to say because drawing is this app's capability. It says nothing about how a result is to be read. A test holds it to that.

What exists now under item 3 is the GitHub Copilot CLI. Every point was tested. See `docs/spike-acp.md`.

- The host starts `copilot --acp` under the supervisor and speaks ACP version 1 to it over stdio.
- The engine's MCP server is named in a file passed with `--additional-mcp-config`, under the name `stackql`. The CLI rejects a stdio MCP server passed in `session/new`, and then silently uses the operator's own Copilot configuration, so that route must not be used.
- `--available-tools` lists the engine's tools, read from the engine at start. The model then has no shell, no file access and no other MCP server. `--allow-tool=stackql` stops the CLI asking about each engine tool call.
- The workspace safety mode is passed to the engine as for the other backends. The CLI does not relay MCP elicitation, so the engine refuses a statement that needs approval instead of asking. It fails closed. Do not put a gate of the host's own in its place.
- A `session/request_permission` from the agent is declined and the operator is told. None is expected, and one means the agent is reaching for something outside the engine.
- The model is chosen with `session/set_config_option`. Empty leaves the CLI's own choice. The settings pane lists the models with what each costs against the operator's plan.
- The CLI reports what a turn used in the answer to `session/prompt`, and the host passes that on. It is not what the operator pays, since the plan is billed by the request. The CLI also sends `usage_update` with how full the model's context window is, which the host does not use yet.
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

- Brand colour is Classic Blue, `#0F4C81`. It is the primary colour: primary buttons, the selection, links, focus rings, the tab in front and the wordmark. There is no second blue. The lighter and darker blues are steps of it, kept as tokens.
- Every colour is a token in `src/styles.css`. A component names a token and never a colour value. The dark theme applies when the root element carries `data-theme="dark"`. That follows the system setting unless the operator picks Light or Dark under View, and the pick is kept in the webview's local storage.
- A test reads the stylesheet and checks each pair of text and surface against WCAG AA, 4.5 to 1, in both themes. A token change that breaks a pair fails the test.
- The StackQL wordmark heads the side menu. Its outline is `static/img/logo-original.svg` from `stackql/stackql.io`, drawn in the accent colour so it follows the theme.
- The status bar is neutral. A coloured dot carries the engine's state.
- The app icon is StackQL's own favicon. The files in `src-tauri/icons/` were generated with `npx tauri icon` from `static/android-chrome-512x512.png` in the `stackql/stackql.io` repository, which is the same mark as its `favicon.ico` at a usable resolution.
- Provider nodes in the explorer show the provider's own icon. The host resolves it through the provider dictionary published at `src/configs/providers.json` in `stackql/stackql.io`, fetches the icon from `stackql.io`, caches it in the app cache directory and passes it to the webview as a `data:` URL. A provider with no entry, or whose icon cannot be fetched, shows the letter badge. Providers built into the engine, such as `stackql_preview`, show the StackQL icon, which is compiled in. The webview itself still makes no network calls. A snapshot of the dictionary is compiled in as a fallback.
- The Library view lists the query library for the operator. The host reads it from the `stackql/query-library.stackql.io` repository on `raw.githubusercontent.com`: the index at `static/docs/query-library/index.json`, and one markdown document for each entry under `query-library/queries`. Both are kept in the app cache directory, and an older copy is shown, and marked, when the library cannot be reached. The webview still makes no network calls. The MCP library tools are the agent's and are not used here.
- An entry's id is checked before it is put in an address. A document's front matter is taken off, not parsed, and the rest is drawn by the same markdown reader as a reply. The entry's statement is the first SQL block under its Query heading.
- A library statement is a template, with `{{name}}` where a value goes. It opens in a new tab under a comment that names the entry and what to fill in. The app fills nothing in and runs nothing.
- Entries are grouped by use case, which is the first of the entry's own tags that names one. By default only entries whose providers are all installed are listed.
- Under an empty conversation one suggestion asks about metadata and the others come from library entries that can run here: stable, not a mutation, and for installed providers. With none, the earlier fixed suggestions are shown.
- Saved queries are plain `.iql` files on disk, not an app database.
- Every path in Settings can be typed or chosen with Browse, which opens the system's own file or folder dialog through a host command. The webview names what the path is for, and the host decides the kind of dialog, its title and the file types it offers first. A chosen path goes into the field like typed text and is saved with the rest.
- A save button that is not available says why beside it, for example that an API key is needed. A reason given only on hover was missed.
- Layout: a menu bar with File, Edit, View, Query, Providers and Help, a side menu, one main view at a time, and the status bar. The views are chat, the explorer with the editor and results, the query library, and activity. Settings is a dialog. Chat is the view the app opens in.
- The menus are drawn in the webview, not by the OS, so they are the same on both platforms and can be tested like the rest of the page. They repeat what the side menu and the panes offer.
- Every view stays mounted while another is shown, so the editor keeps its text and history and a running turn keeps its place.
- A turn is shown as its answer. The layout is worked out in `src/lib/conversation.ts`, and `docs/charts.md` describes it.
  - What the assistant did on the way is one list of steps above the answer: each call with its SQL and its result, and what the assistant wrote before going on to another call. The list is open while the turn runs and folded away when it ends. It is always open while a call waits for the operator's decision.
  - A call that failed is not listed, and its error text is drawn nowhere. The host writes it to the app's log. Help > Show Log File shows the file. The Activity view still lists every statement the agent ran, with the engine's decision.
  - A call the operator was asked about stays in the list whatever became of it. If they approved it and it then failed, the step shows why, because the outcome of their own decision is theirs to see.
  - A turn that fails as a whole, for example on a rejected API key, still says so in the conversation.
  - What the turn used, in tokens, is said on the line that heads the steps once the turn has ended, small and to the side: tokens in, the part of them the provider read from its cache, and tokens out. A turn with no steps says it on a line of its own in the same place. It is the provider's own count, added up over every call to the model in the turn, and is never estimated: a count that was not reported is left out. `docs/charts.md` says where each backend's counts come from.
  - The last statement of the turn that returned rows is shown under the steps as a table, with the statements the assistant asked for in the same step, up to four in all. An answer that holds chart blocks is shown with those instead. The host marks each call with the step that asked for it. For a delegated agent, which does not say where a step ends, the calls that follow one of its messages count as one step.
- A result set in the conversation is a table of every row the host sent, in the same grid as the results pane. A click on a column sorts by it: ascending, descending, then the order of arrival. Numbers sort by size and empty values go last. The download control saves the rows as CSV, in the order shown, through the system's save dialog. The results pane sorts the same way.
- A model asks for a chart with a fenced block of the language `chart` that holds one JSON object. The format, where the rows come from, the limits and the mark rules are in `docs/charts.md`.
  - The block is data. It is parsed, checked and drawn as SVG by components in this repository. Nothing in it is run and nothing a model writes becomes markup.
  - The rows come from the most recent result set that has the columns the block names, or from the block itself. A block that cannot be drawn is shown as the text it is, with the reason.
  - A chart and its table are two views of the same rows, one click apart. A chart has one value axis and at most eight series.
  - The series colours are the tokens `--chart-1` to `--chart-8`, used in order and never cycled. The order keeps neighbours apart for colour-blind readers and was checked as a set in each theme. Do not add or reorder one by eye.
- Replies are read as markdown by a small reader in `src/lib/markdown.ts` that builds a tree. Model output is never turned into HTML. Links are shown and never opened.
- The only links the app opens are its own, from the Help menu and the About dialog: the documentation, the query library and the issue tracker. The webview names a link and the host holds its address, so nothing on a page can have an address opened. One more is opened with no webview at all: Microsoft's page for the WebView2 runtime, from the dialog the host shows when no runtime is found. The host holds that address too.
- Activity lists time, who ran it, the safety mode, the statement, the duration, the row count and the outcome, and can be narrowed by who and by outcome. For the agent the outcome is the engine's `decision` from its audit log, grouped for the filter and never worked out from the statement. The audit log has no row count and does not say which backend made a call, so agent rows show no count and are labelled "Agent". What is listed can be saved as JSONL.
- The status bar shows the engine state, its version and the pg wire address. A click on the address copies `postgres://stackql@127.0.0.1:<port>/stackql?sslmode=disable`. The popover on the state holds the binary, the data folder and Restart.
- "Reload Credentials" in the Providers menu restarts the engine, and says so. On the human channel that is the only way credentials are read again.
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

Signing is decided too. The maintainer signs the Windows executable and the macOS app, and notarises the app, in the StackQL release that ships them. This repository signs nothing for release.

So is the page renderer. The maintainer said on 20 November 2026 that the binaries are to stay small and run on most modern Windows and Mac machines, not carry a runtime of several hundred megabytes. The installers do not ship the WebView2 runtime, and the app uses the one Windows has. The `WebView2Runtime` folder beside the app still works for anyone who needs it.

Three more were decided the same day.

- Windows on Arm gets an executable built for Arm. The StackQL MSI is built for x64 and for arm64, and the maintainer said to build a native arm64 executable if emulation would not do. It would not: Windows emulates x64 only from Windows 11, there is no Arm machine here to try it on, and the arm64 MSI ships an engine built for Arm. CI builds and tests on GitHub's `windows-11-arm` runner, against the engine from `stackql_windows_arm64.zip`. Nothing is built across processors.
- The installer is not changed for the WebView2 runtime. The MSI adds the executable beside `stackql.exe` and nothing else: it neither ships the runtime nor installs it. The maintainer first chose an option in the MSI to install the runtime and then, the same day, chose this. Where the runtime is missing the app says so itself, in a dialog when it starts. Do not put an installer of the runtime in the host either.
- The oldest macOS the app supports is 13. `bundle.macOS.minimumSystemVersion` in `tauri.conf.json` is `13.0`, which goes into the bundle's `Info.plist` and sets the version the executable is built for. An older macOS refuses to open the app. The reason is the styling library, which needs the WebKit of Safari 16.4, from March 2023, and on a Mac the renderer is the WebKit of that macOS. Safari 16.4 came to macOS 13 in an update, so the first releases of macOS 13 have an older renderer and are still let in.
