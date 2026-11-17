//! Result types that cross IPC, and the pure logic that shapes them.
//!
//! What the engine sends is described in `docs/spike-pgwire.md`. In short:
//! every value is text, the command tag carries no row count, and notices
//! pile up on a connection.

use serde::Serialize;

/// One row. Values are text, or `None` for a protocol NULL.
pub type Row = Vec<Option<String>>;

/// A pg notice. For this engine the useful text is in `detail`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

/// Why a statement failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    /// Severity from the server's error response, when there was one.
    pub severity: Option<String>,
    /// SQLSTATE from the server. This engine sends `XXUUU` for everything.
    pub code: Option<String>,
    pub message: String,
    /// True when the connection is no longer usable.
    pub connection_lost: bool,
}

impl QueryError {
    /// An error reported by the engine in an error response.
    pub fn from_server(severity: &str, code: &str, message: &str) -> Self {
        Self {
            severity: Some(severity.to_string()),
            code: Some(code.to_string()),
            message: message.to_string(),
            connection_lost: false,
        }
    }

    /// An error raised on the client side: connect failure, broken socket,
    /// protocol violation.
    pub fn from_client(message: impl Into<String>, connection_lost: bool) -> Self {
        Self {
            severity: None,
            code: None,
            message: message.into(),
            connection_lost,
        }
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Events streamed to the webview while a run is in progress. A run is one
/// or more statements, executed in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum QueryEvent {
    StatementStarted {
        index: usize,
        total: usize,
        sql: String,
    },
    /// Column names. Sent even when the statement returns no rows.
    Columns {
        index: usize,
        columns: Vec<String>,
    },
    /// A batch of rows. Batches arrive in order.
    Rows {
        index: usize,
        rows: Vec<Row>,
    },
    Notice {
        index: usize,
        notice: Notice,
    },
    /// Lines the engine wrote to stderr while the statement ran.
    EngineLog {
        index: usize,
        lines: Vec<String>,
    },
    StatementFinished {
        index: usize,
        row_count: u64,
        elapsed_ms: u64,
    },
    StatementFailed {
        index: usize,
        error: QueryError,
        elapsed_ms: u64,
    },
}

/// The outcome of a whole run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    /// Statements found in the text.
    pub statements: usize,
    /// Statements that ran to completion.
    pub completed: usize,
    /// True when a statement failed. Later statements were not run.
    pub failed: bool,
    /// True when the operator stopped waiting. The engine has no cancel, so
    /// the statement that was running may still complete there.
    pub abandoned: bool,
    pub elapsed_ms: u64,
}

/// A complete result held in memory. Used for metadata statements, which are
/// small.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
    pub notices: Vec<Notice>,
}

impl ResultSet {
    /// Index of a column by name. Column order is not relied on.
    pub fn column(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c == name)
    }
}

/// Groups rows into batches so a large result crosses IPC in pieces. The
/// engine sends all rows at the end of a statement, so this does not make
/// rows appear sooner. It keeps any one IPC message small.
#[derive(Debug)]
pub struct Batcher {
    rows: Vec<Row>,
    bytes: usize,
    max_rows: usize,
    max_bytes: usize,
    total: u64,
}

impl Batcher {
    pub const DEFAULT_MAX_ROWS: usize = 500;
    pub const DEFAULT_MAX_BYTES: usize = 512 * 1024;

    pub fn new(max_rows: usize, max_bytes: usize) -> Self {
        Self {
            rows: Vec::new(),
            bytes: 0,
            max_rows: max_rows.max(1),
            max_bytes: max_bytes.max(1),
            total: 0,
        }
    }

    /// Adds a row. Returns a batch when one is full.
    pub fn push(&mut self, row: Row) -> Option<Vec<Row>> {
        self.bytes += row.iter().flatten().map(String::len).sum::<usize>();
        self.rows.push(row);
        self.total += 1;
        if self.rows.len() >= self.max_rows || self.bytes >= self.max_bytes {
            self.take()
        } else {
            None
        }
    }

    /// Returns whatever is left.
    pub fn finish(&mut self) -> Option<Vec<Row>> {
        self.take()
    }

    /// Rows seen so far. This is the row count, since the engine's command
    /// tag does not carry one.
    pub fn total(&self) -> u64 {
        self.total
    }

    fn take(&mut self) -> Option<Vec<Row>> {
        if self.rows.is_empty() {
            return None;
        }
        self.bytes = 0;
        Some(std::mem::take(&mut self.rows))
    }
}

impl Default for Batcher {
    fn default() -> Self {
        Self::new(Self::DEFAULT_MAX_ROWS, Self::DEFAULT_MAX_BYTES)
    }
}

/// Works out which part of a notice is new on a long-lived connection.
///
/// The engine keeps one notice buffer per connection and never clears it.
/// After the first notice, every later statement on that connection gets the
/// whole accumulated text again, including statements that succeed. This
/// tracker remembers the text already reported and passes on only what was
/// appended.
#[derive(Debug, Default)]
pub struct NoticeTracker {
    seen_detail: String,
}

impl NoticeTracker {
    /// Returns the notice with only its new text, or `None` when it carries
    /// nothing that has not been reported already.
    pub fn fresh(&mut self, notice: Notice) -> Option<Notice> {
        let Some(detail) = notice.detail.as_deref() else {
            // Nothing to compare. Pass it through.
            return Some(notice);
        };
        if detail == self.seen_detail {
            return None;
        }
        let new_part = if !self.seen_detail.is_empty() && detail.starts_with(&self.seen_detail) {
            detail[self.seen_detail.len()..].trim_start()
        } else {
            detail
        }
        .to_string();
        self.seen_detail = detail.to_string();
        if new_part.is_empty() {
            return None;
        }
        Some(Notice {
            detail: Some(new_part),
            ..notice
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Row {
        values.iter().map(|v| Some((*v).to_string())).collect()
    }

    fn notice(detail: Option<&str>) -> Notice {
        Notice {
            severity: "NOTICE".into(),
            code: "01000".into(),
            message: "a notice level event has occurred".into(),
            detail: detail.map(str::to_string),
        }
    }

    #[test]
    fn batcher_flushes_on_row_count() {
        let mut b = Batcher::new(2, usize::MAX);
        assert_eq!(b.push(row(&["a"])), None);
        assert_eq!(b.push(row(&["b"])), Some(vec![row(&["a"]), row(&["b"])]));
        assert_eq!(b.push(row(&["c"])), None);
        assert_eq!(b.finish(), Some(vec![row(&["c"])]));
        assert_eq!(b.finish(), None);
        assert_eq!(b.total(), 3);
    }

    #[test]
    fn batcher_flushes_on_size() {
        let mut b = Batcher::new(usize::MAX, 10);
        assert_eq!(b.push(row(&["12345"])), None);
        // 5 + 6 bytes crosses the limit.
        assert!(b.push(row(&["123456"])).is_some());
        // The byte counter starts again after a flush.
        assert_eq!(b.push(row(&["1"])), None);
    }

    #[test]
    fn batcher_counts_nulls_as_empty() {
        let mut b = Batcher::new(usize::MAX, 4);
        assert_eq!(b.push(vec![None, None, None]), None);
        assert_eq!(b.total(), 1);
    }

    #[test]
    fn batcher_with_no_rows_yields_nothing() {
        let mut b = Batcher::default();
        assert_eq!(b.finish(), None);
        assert_eq!(b.total(), 0);
    }

    #[test]
    fn first_notice_is_reported_whole() {
        let mut t = NoticeTracker::default();
        let got = t
            .fresh(notice(Some("http response status code: 404")))
            .unwrap();
        assert_eq!(
            got.detail.as_deref(),
            Some("http response status code: 404")
        );
    }

    #[test]
    fn a_repeat_of_the_same_text_is_old_news() {
        // What the engine does for a successful statement after a failed one.
        let mut t = NoticeTracker::default();
        t.fresh(notice(Some("first failure")));
        assert_eq!(t.fresh(notice(Some("first failure"))), None);
        assert_eq!(t.fresh(notice(Some("first failure"))), None);
    }

    #[test]
    fn only_the_appended_text_is_reported() {
        let mut t = NoticeTracker::default();
        t.fresh(notice(Some("first failure")));
        let got = t
            .fresh(notice(Some("first failure\nsecond failure")))
            .unwrap();
        assert_eq!(got.detail.as_deref(), Some("second failure"));
        // And the buffer keeps growing from there.
        let got = t
            .fresh(notice(Some("first failure\nsecond failure\nthird")))
            .unwrap();
        assert_eq!(got.detail.as_deref(), Some("third"));
    }

    #[test]
    fn the_same_failure_twice_is_reported_twice() {
        // Accumulation doubles the text, so the second half is new.
        let mut t = NoticeTracker::default();
        t.fresh(notice(Some("boom\n")));
        let got = t.fresh(notice(Some("boom\nboom\n"))).unwrap();
        assert_eq!(got.detail.as_deref(), Some("boom\n"));
    }

    #[test]
    fn unrelated_text_is_reported_whole() {
        // If the engine ever stops accumulating, nothing is lost.
        let mut t = NoticeTracker::default();
        t.fresh(notice(Some("first failure")));
        let got = t.fresh(notice(Some("a different failure"))).unwrap();
        assert_eq!(got.detail.as_deref(), Some("a different failure"));
    }

    #[test]
    fn a_notice_without_detail_passes_through() {
        let mut t = NoticeTracker::default();
        assert_eq!(t.fresh(notice(None)), Some(notice(None)));
        assert_eq!(t.fresh(notice(None)), Some(notice(None)));
    }

    #[test]
    fn result_set_finds_columns_by_name() {
        let rs = ResultSet {
            columns: vec!["name".into(), "version".into()],
            ..ResultSet::default()
        };
        assert_eq!(rs.column("version"), Some(1));
        assert_eq!(rs.column("missing"), None);
    }

    #[test]
    fn events_serialise_in_the_shape_the_webview_expects() {
        let event = QueryEvent::StatementFinished {
            index: 0,
            row_count: 3,
            elapsed_ms: 12,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "event": "statementFinished",
                "data": { "index": 0, "rowCount": 3, "elapsedMs": 12 }
            })
        );

        let event = QueryEvent::Rows {
            index: 1,
            rows: vec![vec![Some("a".into()), None]],
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({ "event": "rows", "data": { "index": 1, "rows": [["a", null]] } })
        );
    }

    #[test]
    fn errors_serialise_with_camel_case_fields() {
        let err = QueryError::from_server("ERROR", "XXUUU", "query returns error: nope");
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({
                "severity": "ERROR",
                "code": "XXUUU",
                "message": "query returns error: nope",
                "connectionLost": false
            })
        );
    }
}
