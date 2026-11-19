//! What a model is told about how its work is shown.
//!
//! How a result is to be read is the engine's to say, and its MCP server
//! says it. This is about something the engine knows nothing of: what this
//! app draws. A model has to be told that its calls are folded away as
//! steps, which result set the operator is shown, and how to ask for a
//! chart, because drawing is this app's capability and not the engine's.
//!
//! Both ways a turn runs use the same text. The host's own loop puts it in
//! the system prompt. A delegated agent has a system prompt of its own, so
//! it gets the text ahead of the first message.

/// How the conversation shows a turn, and the chart block. The format of
/// the block is read by `src/lib/chart.ts` in the webview and described in
/// `docs/charts.md`. Keep the three in step.
pub const PRESENTATION: &str = "How your work is shown to the operator:\n\
- The operator reads your answer. Above it, the calls you made are listed as steps, folded away, \
each with its SQL and its result.\n\
- The rows your last statement returned are shown under the steps as a table the operator can \
sort and download. When you ask for several statements in one step, the rows of each are shown. \
Do not restate rows. Add interpretation only: what the rows mean, what stands out, what to do \
next.\n\
- If your answer holds chart blocks, those are shown in place of those tables, each with its own \
data table.\n\
- A call that fails is not shown. Correct it and carry on. Do not describe the attempts and do \
not quote error text. If something could not be done, say so once, in plain words, with what the \
operator can do about it.\n\
- When you propose a statement for the operator to run, show the SQL in a fenced sql block.\n\n\
Charts: when the operator asks for a chart, a plot, a graph or a trend, or when a picture says it \
better than rows, put a fenced code block with the language chart in your answer, holding one \
JSON object. For example:\n\
```chart\n\
{\"type\": \"bar\", \"title\": \"Issues created per month\", \"x\": \"month\", \"y\": [\"issues_created\"]}\n\
```\n\
- type is one of bar, line, area, pie, scatter and table. Use line or area for a trend over time, \
bar to compare amounts, pie only for a few parts of one whole, and table to show a result set as \
a table.\n\
- x names the column for the horizontal axis, or for the names of the slices. y lists one or more \
numeric columns. When rows carry a series name in a column, name that column as series and give \
one column in y.\n\
- The chart is drawn from the most recent result set that has those columns. Name the columns \
exactly as the result has them, and shape the result with SQL first (GROUP BY, ORDER BY, column \
aliases) so that it is ready to draw. Do not repeat the rows in the block.\n\
- Draw what can be read: a few dozen points at most, and no more than 8 series. For a ranking, \
take the top rows with ORDER BY and LIMIT.\n\
- Only when no one result set holds the data, give it in the block: \
\"data\": [{\"month\": \"2026-01\", \"open\": 3, \"closed\": 5}]\n\
- Optional members: \"stacked\": true for bar, \"horizontal\": true for bar with long names, \
\"xLabel\" and \"yLabel\" for axis titles.\n\
- Never draw a chart out of text characters, and never describe a chart that you did not put in \
a block.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_is_told_what_the_operator_sees() {
        assert!(PRESENTATION.contains("listed as steps"));
        assert!(PRESENTATION.contains("sort and download"));
        assert!(PRESENTATION.contains("A call that fails is not shown"));
        assert!(PRESENTATION.contains("fenced sql block"));
    }

    #[test]
    fn the_chart_block_is_described_with_an_example_that_is_valid_json() {
        let start = PRESENTATION.find("```chart\n").unwrap() + "```chart\n".len();
        let end = start + PRESENTATION[start..].find("\n```").unwrap();
        let example: serde_json::Value = serde_json::from_str(&PRESENTATION[start..end]).unwrap();
        assert_eq!(example["type"], "bar");
        assert_eq!(example["x"], "month");
        assert_eq!(example["y"][0], "issues_created");
        for kind in ["bar", "line", "area", "pie", "scatter", "table"] {
            assert!(PRESENTATION.contains(kind), "{kind}");
        }
        assert!(PRESENTATION.contains("\"data\": [{"));
    }

    #[test]
    fn nothing_here_tells_a_model_how_to_read_a_result() {
        // That is the engine's to say. This text is about presentation only.
        for phrase in ["http", "status code", "retry", "404", "401"] {
            assert!(
                !PRESENTATION.to_lowercase().contains(phrase),
                "{phrase} belongs to the engine's guidance"
            );
        }
    }
}
