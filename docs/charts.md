# Chart blocks

This note describes how a model asks the Workbench for a chart, and how the conversation shows a turn. The model is told the same in `src-tauri/src/agent/guidance.rs`. The block is read by `src/lib/chart.ts` and placed by `src/lib/chartLayout.ts`. Keep the three in step.

## Why a block and not a tool

Drawing is this app's capability. The engine cannot draw, and a delegated agent is held to the engine's tools and nothing else, so a chart tool of the host's own would not reach it. A fenced block in the reply works the same on both ways a turn runs, because both end in text the chat pane already reads.

The block is data. It is parsed as JSON, checked, and drawn as SVG by this app's own components. Nothing in it is run, and nothing a model writes becomes markup: a title or a label goes on the page as a text node.

There is no charting dependency. Bars, lines, areas, points and a ring cover what a result set from a provider needs, and drawing them here keeps every colour a token, so a chart follows the theme like the rest of the app.

## The block

A fenced code block with the language `chart`, holding one JSON object.

````
```chart
{"type": "bar", "title": "Issues created per month", "x": "month", "y": ["issues_created"]}
```
````

The members are these.

| Member | Meaning |
|---|---|
| `type` | `bar`, `line`, `area`, `pie`, `scatter` or `table`. `column` is read as `bar`, and `donut` as `pie` |
| `title` | What the card is headed with. Without it the card is named after the columns |
| `x` | The column along the horizontal axis, or the one that names the parts of a pie |
| `y` | One or more columns that hold numbers. One name may be given as text |
| `series` | A column whose values name the series, for rows that carry one. Then only the first `y` column is drawn |
| `stacked` | `true` stacks the bars of each position. Bars only |
| `horizontal` | `true` lays the bars down, which suits long names. Bars only |
| `xLabel`, `yLabel` | Titles for the axes |
| `columns` | For a table: the columns to show, in order |
| `data` | Rows given in the block, as a list of objects. See below |

A `table` block needs none of `x` and `y`. It shows a result set as a table.

## Where the rows come from

A block names columns. The rows are found in this order.

1. The `data` member, when the block has one.
2. The most recent result set in the conversation that has every column the block names. A name matches whatever its case, and a name written exactly as the result has it wins.

So a model shapes the result with SQL, with `GROUP BY`, `ORDER BY` and column aliases, and then names its columns. It does not copy rows into the block. `data` is for when no one result set holds what is to be drawn, for example two results put together.

A block whose columns no result set has is not drawn. It is shown as the text it is, with the reason above it.

## How the values are read

The engine sends every value as text. A chart reads numbers out of that text, and also `1,234` and `45%`. A value that is not a number is left out, and the chart says how many were.

For a line, an area or a scatter chart the `x` column is read as time when every value is a year, a month, a day or a date with a time, and as a number when every value is one. Then the points are placed where they fall, so a month with no rows leaves a gap and does not sit next to its neighbour. A time with no zone is taken as UTC. Anything else is a name, and names are spaced evenly in the order of the rows. Bars always treat `x` as names.

Rows that share a point are added together when the block names a `series` column, and so are the rows of one part of a pie. A pie leaves out amounts that are not above zero.

## Limits

These keep a chart readable. Where one applies, the chart says so under the plot.

- At most 8 series or parts, which is the number of chart colours. With more, the 7 largest are kept and the rest are added together as `Other`.
- At most 200 bars standing up or 25 lying down, and 2,000 points on a line. The first are kept, so a model orders the rows before it draws them. The table view always has every row.
- At most 5,000 rows in `data`.

A chart has one value axis. Two measures of different size belong in two charts.

## What is drawn

The mark specifications are fixed, so charts look alike.

- A bar is at most 24 pixels thick, square at the baseline and rounded at its other end. Bars and stacked segments that touch are kept apart by a 2 pixel gap in the surface colour, not by an outline.
- A line is 2 pixels. Points are marked while there are 30 or fewer on a line.
- An area is the line with a wash of its colour at one tenth strength.
- Gridlines are solid hairlines at round values. Axis values are written in full under ten thousand and short above, one style for a whole axis.
- Two or more series get a legend. One series gets none, since the title names it.
- Text is drawn in the ink tokens and never in a series colour.

The pointer finds a position, not a mark: the whole plot answers it, and the tooltip lists every series at that position. The arrow keys do the same from the keyboard. Every chart has a table view of the same rows one click away, which is also where a value is read without hovering.

## Colours

The eight series colours are the tokens `--chart-1` to `--chart-8` in `src/styles.css`, with a second set for the dark theme. They are used in order and never cycled. The first is a step of Classic Blue.

The order is what keeps neighbouring series apart for colour-blind readers. The set was checked as a whole in each theme, against the surface it is drawn on, for lightness, chroma, separation under simulated protanopia and deuteranopia, and separation for full-colour vision. Do not add or reorder a colour by eye. In the light theme three of the eight sit under 3 to 1 against white, which the table view is there to make up for. A test holds every chart colour to a floor against the surface in both themes.

## How a turn is shown

A turn is shown as its answer. What the assistant did on the way is one list of steps above it, open while the turn runs and folded away when it ends.

- A step is a call the assistant made, with its SQL and its result, or what the assistant wrote before going on to another call.
- A call that failed is not listed. A model reads the error, corrects the statement and runs it again. Those attempts are written to the app's log, with the statement and what came back.
- A call the operator was asked to approve stays in the list whatever became of it, because the decision was theirs. If they approved it and it then failed, the step says why.
- The last statement of the turn that returned rows is shown under the steps as a table that sorts and downloads. So are the statements the assistant asked for together with it, in the same step, up to four in all: a question that takes two statements is shown with both, and what was looked up on the way to them stays in the steps. An answer that holds chart blocks is shown with those instead, each with its own table.
- What the turn used is said on the line that heads the steps, once the turn has ended: `6 steps  25,469 tokens in (12,631 cached), 158 out`. A turn with no steps says it on a line of its own in the same place. It is small and to the side, since it is not part of the answer. See "Token counts" below.
- The host says which step of the model a call belongs to. Its own loop knows each step. A delegated agent does not say where a step ends, so there the calls that follow one of the agent's messages count as one step.

Every statement the agent runs is still on record: the engine writes each one to its audit log, which the Activity view lists with its outcome.

## Token counts

The counts are the provider's own, passed on. Nothing is estimated: a count a provider does not report is not shown, and a provider that reports none leaves the line out.

- Tokens in is everything the model was sent in the turn, whether or not the provider read part of it from its cache. The cached part is said in brackets where the provider tells it apart.
- Tokens out is everything the model wrote, with its thinking where the provider counts it.
- Both are added up over every call to the model in the turn. Each call sends the conversation so far again, with the engine's guidance, so a turn of ten calls counts that ten times. That is how it is billed where billing is by the token.

Where each count comes from is below.

| Backend | Tokens in | Cached | Tokens out |
|---|---|---|---|
| Gemini | `promptTokenCount` plus `toolUsePromptTokenCount` | `cachedContentTokenCount` | `candidatesTokenCount` plus `thoughtsTokenCount`, which the API counts apart and bills as output |
| Anthropic | `input_tokens` plus the two cache counts, which the API reports apart from it | `cache_read_input_tokens` | `output_tokens` |
| OpenAI-compatible | `prompt_tokens` | `prompt_tokens_details.cached_tokens`, which a local server usually does not send | `completion_tokens` |
| GitHub Copilot CLI | `inputTokens` from the answer to the prompt | `cachedReadTokens` | `outputTokens`. The run observed did not show whether that holds the model's thinking |

A turn that fails before it ends has no count, because the host learns the count from how the turn ends. On the Copilot CLI the count is not the cost: that plan is billed by the request. What the CLI reports was observed, and is in `docs/spike-acp.md`.

## The log

The host writes its own log, one file for each run of the app, in `<app data dir>/logs`. A file is named `stackql_workbench_<UTC time>.log` and holds one JSON object on each line. Help > Show Log File opens the folder with the current file selected. The 20 newest files are kept.

It is a different record from the engine's audit log in `<app data dir>/audit`, which the engine writes.

| Event | When |
|---|---|
| `app_started` | The app starts |
| `engine_running`, `engine_failed` | The engine comes up, or does not |
| `tool_call_failed` | A call the assistant made ended as an error, with the tool, the statement or arguments, and what came back |
| `notice` | The host had something to tell the operator during a turn |
| `turn_finished`, `turn_failed` | A turn ends. A turn that finished is written with its token counts, where the provider reported them |

A record never holds an API key, an environment value or what the operator typed to the assistant.
