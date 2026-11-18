# Work order: StackQL Workbench UX pass

This work order covers wording, explorer, chat, editor, results and branding changes to `stackql-workbench`. It does not change the engine, the MCP server or the approval flow.

## Basis

This was written from screenshots of the build on 18 Nov 2026 (branch `m3-chat`), not from the code. Where this file and the code disagree about what already exists, the code wins: skip the item and say so in the report. `CLAUDE.md` overrides this file on architecture and conventions.

## Before starting

Reply with a plan and wait for a go-ahead before changing anything. The plan maps each item below to the files it touches, names any new runtime dependency, and lists items that already exist or that hit a stop condition.

## Rules

These hold for every group.

- The engine classifies and gates statements. The app only renders. Do not add client-side statement classification that decides what runs.
- Never display, log or persist environment variable values. Names and set/not set only.
- Do not show SQL that the engine did not run unless it is labelled as an equivalent.
- All colours come from theme tokens. No hard-coded colour values in components.
- Every icon-only control gets a tooltip and an accessible name.
- Comments stay short. No narrative comments.

## Stop conditions

Stop and report instead of working around any of these.

- An item needs a change in `stackql`, the MCP server or a provider document.
- An item needs data the engine does not expose (for example the executed statement on a tool result, the SQL verb of a method, or the variables a provider expects).
- An item would alter the elicitation or approval path, or auto-accept anything.
- A filter or autocomplete design would crawl a whole provider's metadata on a keystroke.
- The lint, typecheck, test or build commands in `CLAUDE.md` fail for a reason unrelated to this work.

## Commit groups

Work the groups in order. Each group lands as its own commit or short commit series, passes the merge gate by itself, and can be reverted without touching the others.

### Group A: mode labelling and wording

- Replace the strings in the table below.

| Where | Current | New |
|---|---|---|
| Read-only helper | (none) | Queries run. Changes are refused by the engine. |
| Safe helper | Queries run. Every change is refused, because this agent cannot show the approval prompt. The engine decides what is refused. | Queries run. Each change needs your approval before it runs. |
| Delete-safe helper | (as built) | Queries and changes run. DELETE and EXEC need your approval. |
| Full access helper | (as built) | Everything runs without approval. |
| Chat placeholder | Ask the assistant. Enter sends, Shift+Enter adds a line. | Ask about your providers |
| Below the input | (none) | Small text: Enter to send, Shift+Enter for a new line |
| Status bar path | `C:\...\stackql.exe (install location)` | Removed from the bar. Shown in the engine popover as "Engine binary" |

Acceptance: the label always describes what will happen to a change statement in the current session, and no helper text mentions a limitation that does not apply to the selected backend.

### Group B: chat

The landing copy says every statement is shown as SQL. The tool cards do not yet do that.

- Tool cards show SQL. For `run_select_query` and `run_mutation_query`, show the statement from the tool arguments. For metadata tools, show the executed statement if the tool result or audit entry carries it. If it does not, show a verified equivalent under the label "Equivalent SQL" (for example `SHOW PROVIDERS;`, `SHOW SERVICES IN github;`, `REGISTRY LIST;`). Tools with no SQL form show the tool name and arguments.
- Each card with SQL has "Open in editor", which opens the statement in a new editor tab without running it. "Open in grid" stays.
- The session line becomes chips: agent and version, model, mode, "15 engine tools only". ACP version and the rest go in a popover on click.
- Where the backend accepts instructions from the app, add: do not restate rows that a tool card already shows, add interpretation only.
- Suggestion chips: keep one metadata chip. The others are task-based and come from query library entries for installed providers, so they are known to run. With no matching entries, fall back to the current chips.
- The unlabelled icon at the top right of a chat gets a tooltip and accessible name.

Acceptance: asking "Which providers are installed?" produces one card with the rows and its SQL, and no repeated list underneath.

### Group C: explorer

The tree has to stay usable with a provider the size of `aws`, and method rows have to be readable.

- Filter input above the tree. Substring match on provider, service, resource and method names. Matches keep their parents expanded. Esc clears. State in the plan how unloaded levels are handled.
- Ctrl+P (Cmd+P on macOS) opens a jump box that accepts `provider.service.resource` and selects that node.
- Method rows show the SQL verb as a pill before the name (SELECT, INSERT, UPDATE, REPLACE, DELETE, EXEC) instead of a truncated suffix. SELECT uses one colour and change verbs another. The pill text carries the meaning, not the colour.
- Full name on hover for any truncated row. The explorer pane is resizable and its width persists.
- Tooltips for the S, R, F, M, fn, in and out badges.
- Context menu on a resource: Generate SELECT (fields listed, required parameters as `WHERE` placeholders), Copy qualified name, DESCRIBE EXTENDED. On a method: generate a statement for that method. Generated statements open in a new tab and do not run.
- Internal providers such as `stackql_preview` are listed in the tree with an "internal" label, so the tree matches what the agent reports.
- Each provider shows credential state (set or missing, names only) with a link to Settings.
- Each provider shows "update available" when the registry has a newer version, with an Update action. Add an "Add provider" action that lists the registry, if one does not already exist.

Acceptance: with `aws` and `github` installed, a resource can be found by typing part of its name, two methods with the same truncated name can be told apart without hovering, and a generated SELECT for a resource with required parameters runs once the placeholders are filled.

### Group D: editor and results

The editor is a single blank buffer and the grid shows nested values as raw text.

- Autocomplete from metadata the explorer has already loaded: provider, service and resource after `FROM`, fields in the select list and `WHERE`, and keywords.
- Tabs, run selection, and a local statement history (statements only, no results).
- An empty editor shows a commented sample statement for an installed provider.
- JSON cells open in a viewer with pretty print and copy.
- Export as CSV and JSON. Copy as Markdown table.
- "Copy as CLI" produces a `stackql exec` command for the current statement, quoted for PowerShell on Windows and for a POSIX shell on macOS.

Acceptance: a statement written in the editor can be re-run from history, exported, and pasted into a terminal as a working `stackql exec` command.

### Group E: activity, status bar and menus

The Activity pane reads the engine audit log. This group checks its coverage and tidies the window chrome.

- Activity shows, per entry: time, actor (operator or the agent backend), mode, statement, duration, row count and outcome (ran, refused, approved, declined). Filter by actor and outcome. Export as JSONL. If the audit log lacks a field, stop and report. Do not infer it.
- Status bar shows engine state, engine version and the listening address. Clicking the address copies a connection string, if the address is the pg wire port. Confirm that in the plan.
- An engine popover holds the binary path, registry and restart.
- Native menu gains Query (Run, Run selection, New tab), Providers (Add from registry, Check for updates, Reload credentials) and Help (Documentation, Query library, Report an issue, About).

Acceptance: a refused change made by the agent can be found in Activity by filtering on actor and outcome.

### Group F: branding and theme

Classic Blue currently appears only on the Run button and the status bar, and the solid blue bar resembles another editor.

- StackQL wordmark in the sidebar header, next to the collapse control.
- Classic Blue is the primary token: primary buttons, selection, links and focus rings. Use the existing brand value. Do not introduce a second blue.
- Status bar becomes neutral, with a coloured dot for engine state.
- Monospace face for identifiers in the tree, tool cards and SQL.
- Dark theme that follows the OS setting, with an override under View. Text contrast meets WCAG AA in both themes.

Acceptance: every view in this work order renders correctly in light and dark, and the product is identifiable as StackQL from a screenshot with the title bar cropped.

### Group G: query library pane

The query library is reachable by the agent through `query_library_search` and `query_library_get` but not by the operator.

- A "Library" entry in the sidebar lists entries grouped by use case, filtered to installed providers by default, with search.
- Selecting an entry shows its description and statement. "Open in editor" opens it in a new tab.
- State in the plan how the app reads the library. If the only route is the MCP tools, say so and wait.

Acceptance: an operator with no chat backend configured can find and run a library query for an installed provider.

## Out of scope

Leave these alone: engine and MCP server changes, new inference backends, remote connections, the approval flow, `stackql-deploy` integration, charts.

## Merge gate

Each group passes the lint, typecheck, test and build commands defined in `CLAUDE.md` and `package.json`, and the app starts and runs a SELECT against an installed provider on Windows.

## Report

When finished, report per group: what changed, what was skipped because it already existed, and what was stopped and why. Include a light and a dark screenshot of each changed view.

## Burn order

Delete this file in the final commit.

## Decisions from the plan review, 18 Nov 2026

The maintainer answered the plan as follows. These override the text above where they differ.

1. Editor tabs are built first, as a short step before Group B, because B and C open statements "in a new tab".
2. The query library is read from the `stackql/query-library.stackql.io` repository, under `query-library/queries`, as markdown documents. The host fetches and caches it. The MCP tools are not used for this.
3. `stackql_preview` stays hidden from the explorer. The item in Group C that lists internal providers is dropped. The difference from what the agent reports is accepted.
4. Two plugins are added: `tauri-plugin-dialog` for the save dialog on export, and `tauri-plugin-opener` for Help links.
5. The wordmark is `static/img/logo-original.svg` from `stackql/stackql.io`.
6. The stop conditions below are skipped here and go to an engine work order.
7. This file is added now and deleted in the final commit.

Also agreed in the plan:

- The menus are drawn in the webview, by an earlier decision recorded in `CLAUDE.md`. Query, Providers and Help are added there, not to a native menu.
- With the Copilot backend a change that needs approval is refused, so that backend keeps its own helper strings. The strings in the Group A table apply to the API key backends.
- "Reload credentials" restarts the engine on the human channel, and its label says so.
- Group A creates the engine popover with the binary path. Group E completes it.

Stopped, with the reason:

- Group C, credential state per provider: the engine exposes the expected variables only through the MCP `reload_credentials` tool, which also re-sources the env file.
- Group E, row count on agent entries: the audit record has no row count.
- Group E, which agent backend made an entry: not in the audit record. Agent entries are labelled "Agent".
- Group E, registry in the engine popover: found only on the MCP `server_info` tool, not on `srv`.
