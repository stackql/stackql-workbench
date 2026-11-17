//! What was run, by whom.
//!
//! Every statement executed through either channel is on record:
//!
//! - Statements the operator runs from the editor are appended to a history
//!   file by the host.
//! - Everything the agent does is written by the engine to its audit log,
//!   which the host reads and never writes.
//!
//! Neither record holds result rows.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::lock;

const MAX_HISTORY_BYTES: u64 = 4 * 1024 * 1024;

/// One statement the operator ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    pub sql: String,
    /// `ok`, `error` or `abandoned`.
    pub outcome: String,
    pub rows: Option<u64>,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

impl HistoryEntry {
    pub fn now(sql: String, outcome: &str, rows: Option<u64>, elapsed_ms: u64) -> Self {
        Self {
            timestamp_ms: now_ms(),
            sql,
            outcome: outcome.to_string(),
            rows,
            elapsed_ms,
            error: None,
        }
    }

    pub fn with_error(mut self, error: String) -> Self {
        self.error = Some(error);
        self
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The operator's statement history, one JSON object per line.
pub struct History {
    path: Option<PathBuf>,
    write: Mutex<()>,
}

impl History {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            write: Mutex::new(()),
        }
    }

    /// A history that records nothing, for tests.
    pub fn disabled() -> Self {
        Self {
            path: None,
            write: Mutex::new(()),
        }
    }

    /// Appends an entry. History is a convenience, so a failure to write it
    /// does not fail the statement that was run.
    pub fn record(&self, entry: &HistoryEntry) {
        let Some(path) = &self.path else { return };
        let Ok(line) = serde_json::to_string(entry) else {
            return;
        };
        let _guard = lock(&self.write);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Start over when the file gets large. The newest entries are the
        // ones that matter.
        if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_HISTORY_BYTES) {
            let _ = std::fs::rename(path, path.with_extension("jsonl.old"));
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    /// The most recent entries, newest last.
    pub fn list(&self, limit: usize) -> Vec<HistoryEntry> {
        let Some(path) = &self.path else {
            return Vec::new();
        };
        last_lines(path, limit)
            .iter()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

/// One record from the engine's agent audit log, passed through as the
/// engine wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    /// RFC 3339, as written by the engine.
    pub timestamp: String,
    pub tool: String,
    /// The safety mode in effect.
    pub mode: String,
    /// For example `allow`, `refuse_immediate` or `needs_approval_declined`.
    pub decision: String,
    pub query_class: String,
    pub sql: Option<String>,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
}

fn audit_record(value: &Value) -> Option<AuditRecord> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    Some(AuditRecord {
        timestamp: text("timestamp")?,
        tool: text("tool")?,
        mode: text("mode").unwrap_or_default(),
        decision: text("decision").unwrap_or_default(),
        query_class: text("query_class").unwrap_or_default(),
        sql: text("sql"),
        duration_ms: value.get("duration_ms").and_then(Value::as_u64),
        error: text("error"),
    })
}

/// Reads the most recent records from the engine's audit log directory,
/// newest last. The engine starts a new file each time it starts, named so
/// that the names sort by time.
pub fn read_audit(dir: &Path, limit: usize) -> Vec<AuditRecord> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
        .collect();
    files.sort();

    let mut records: Vec<AuditRecord> = Vec::new();
    for file in files.iter().rev() {
        if records.len() >= limit {
            break;
        }
        let mut batch: Vec<AuditRecord> = last_lines(file, limit - records.len())
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| audit_record(&value))
            .collect();
        // Older files go in front of what has been read so far.
        batch.append(&mut records);
        records = batch;
    }
    records
}

/// The last `limit` non-empty lines of a file, in file order.
fn last_lines(path: &Path, limit: usize) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let skip = lines.len().saturating_sub(limit);
    lines[skip..].iter().map(|l| (*l).to_string()).collect()
}

/// Both records together, for the activity pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub operator: Vec<HistoryEntry>,
    pub agent: Vec<AuditRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-activity-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn history_round_trips_and_keeps_order() {
        let dir = temp_dir("history");
        let history = History::new(dir.join("history.jsonl"));
        history.record(&HistoryEntry::now(
            "SHOW PROVIDERS".into(),
            "ok",
            Some(3),
            4,
        ));
        history.record(
            &HistoryEntry::now("SELEC 1".into(), "error", None, 1).with_error("syntax".into()),
        );
        history.record(&HistoryEntry::now(
            "SELECT slow".into(),
            "abandoned",
            None,
            900,
        ));

        let entries = history.list(10);
        assert_eq!(
            entries.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            vec!["SHOW PROVIDERS", "SELEC 1", "SELECT slow"]
        );
        assert_eq!(entries[0].rows, Some(3));
        assert_eq!(entries[1].error.as_deref(), Some("syntax"));
        assert!(entries[0].timestamp_ms > 1_700_000_000_000);

        // The limit keeps the newest.
        let last = history.list(2);
        assert_eq!(last[0].sql, "SELEC 1");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_history_file_is_an_empty_history() {
        let dir = temp_dir("nohistory");
        assert!(History::new(dir.join("none.jsonl")).list(10).is_empty());
        assert!(History::disabled().list(10).is_empty());
        History::disabled().record(&HistoryEntry::now("x".into(), "ok", None, 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_entries_serialise_in_camel_case() {
        let entry = HistoryEntry {
            timestamp_ms: 1,
            sql: "SELECT 1".into(),
            outcome: "ok".into(),
            rows: Some(1),
            elapsed_ms: 2,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "timestampMs": 1, "sql": "SELECT 1", "outcome": "ok",
                "rows": 1, "elapsedMs": 2, "error": null
            })
        );
    }

    #[test]
    fn audit_records_are_read_across_files_newest_last() {
        let dir = temp_dir("audit");
        // The real shapes, from docs/spike-mcp.md.
        std::fs::write(
            dir.join("stackql_mcp_server_20261117T230717Z.log"),
            concat!(
                r#"{"timestamp":"2026-11-18T10:07:17+11:00","tool":"server_info","mode":"safe","decision":"allow","query_class":"select","duration_ms":0}"#, "\n",
                r#"{"timestamp":"2026-11-18T10:07:18+11:00","tool":"run_select_query","mode":"safe","decision":"allow","query_class":"select","sql":"SELECT 1","args":{"row_limit":0,"sql":"SELECT 1"},"duration_ms":12}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("stackql_mcp_server_20261117T230721Z.log"),
            concat!(
                "not json\n",
                r#"{"timestamp":"2026-11-18T10:07:21+11:00","tool":"run_mutation_query","mode":"safe","decision":"needs_approval_declined","query_class":"mutation_delete","sql":"DELETE FROM t","duration_ms":0,"error":"tool \"run_mutation_query\" refused: user declined approval"}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(dir.join("unrelated.txt"), "ignored").unwrap();

        let records = read_audit(&dir, 10);
        assert_eq!(
            records.iter().map(|r| r.tool.as_str()).collect::<Vec<_>>(),
            vec!["server_info", "run_select_query", "run_mutation_query"]
        );
        assert_eq!(records[1].sql.as_deref(), Some("SELECT 1"));
        assert_eq!(records[1].duration_ms, Some(12));
        assert_eq!(records[2].decision, "needs_approval_declined");
        assert!(records[2].error.as_deref().unwrap().contains("declined"));

        // The limit keeps the newest, across the file boundary.
        let last_two = read_audit(&dir, 2);
        assert_eq!(
            last_two.iter().map(|r| r.tool.as_str()).collect::<Vec<_>>(),
            vec!["run_select_query", "run_mutation_query"]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_audit_directory_is_no_records() {
        assert!(read_audit(Path::new("/definitely/not/here"), 10).is_empty());
    }
}
