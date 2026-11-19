//! The app's own log.
//!
//! One file for each run of the app, named `stackql_workbench_<UTC time>.log`,
//! with one JSON object on each line. It holds what the operator does not
//! need in front of them: a tool call that failed and that the model went on
//! to correct, a turn that could not start, an engine that did not come up.
//!
//! The engine's MCP server keeps its own audit log. That is a different
//! record, written by the engine, in a different folder. This one is written
//! by the host and nothing reads it back.
//!
//! Nothing secret is written here. A record holds statements, tool arguments
//! and what the engine or a provider answered. It never holds an API key, an
//! environment value or what the operator typed to the assistant.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::util::{lock, truncate};

const FILE_PREFIX: &str = "stackql_workbench_";
const FILE_EXTENSION: &str = "log";
/// Log files beyond this many are removed when the app starts, oldest first.
const MAX_LOG_FILES: usize = 20;
/// Nothing more is written to a file that has reached this size.
const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
/// Text in one field beyond this is cut. A provider can answer with a page.
const MAX_FIELD_CHARS: usize = 16_000;
/// What every record starts with. A field cannot take one of these names.
const RESERVED: [&str; 3] = ["timestamp", "level", "event"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

pub struct AppLog {
    /// `None` records nothing, for tests and for a folder that cannot be made.
    path: Option<PathBuf>,
    write: Mutex<()>,
}

impl AppLog {
    /// Starts the log for this run in `dir`, and removes the oldest files
    /// when there are too many. A folder that cannot be created gives a log
    /// that records nothing: logging never stops the app.
    pub fn start(dir: &Path) -> Self {
        Self::start_at(dir, SystemTime::now())
    }

    fn start_at(dir: &Path, now: SystemTime) -> Self {
        if std::fs::create_dir_all(dir).is_err() {
            return Self::disabled();
        }
        prune(dir, MAX_LOG_FILES.saturating_sub(1));
        let log = Self {
            path: Some(dir.join(file_name(now))),
            write: Mutex::new(()),
        };
        log.info(
            "app_started",
            serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            }),
        );
        log
    }

    /// A log that records nothing.
    pub fn disabled() -> Self {
        Self {
            path: None,
            write: Mutex::new(()),
        }
    }

    /// The file this run writes to.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn info(&self, event: &str, fields: Value) {
        self.record(Level::Info, event, fields);
    }

    pub fn warn(&self, event: &str, fields: Value) {
        self.record(Level::Warn, event, fields);
    }

    pub fn error(&self, event: &str, fields: Value) {
        self.record(Level::Error, event, fields);
    }

    /// Appends one record. `fields` is an object whose members are written
    /// beside the time, the level and the event. A failure to write is
    /// ignored, because the log is never the reason something fails.
    pub fn record(&self, level: Level, event: &str, fields: Value) {
        let Some(path) = &self.path else { return };
        let line = record_line(SystemTime::now(), level, event, fields);
        let _guard = lock(&self.write);
        if std::fs::metadata(path).is_ok_and(|meta| meta.len() >= MAX_LOG_BYTES) {
            return;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// One record as a line of JSON. The time, the level and the event come
/// first and cannot be replaced by a field of the same name.
///
/// The line is put together by hand so that those three lead it, which is
/// what someone reading the file looks for. The fields follow in the order
/// of their names.
fn record_line(now: SystemTime, level: Level, event: &str, fields: Value) -> String {
    let text = |value: &str| Value::String(value.to_string()).to_string();
    let mut line = format!(
        "{{\"timestamp\":{},\"level\":{},\"event\":{}",
        text(&timestamp(now)),
        text(level.as_str()),
        text(event)
    );
    if let Value::Object(fields) = fields {
        for (key, value) in fields {
            if RESERVED.contains(&key.as_str()) || value.is_null() {
                continue;
            }
            line.push(',');
            line.push_str(&text(&key));
            line.push(':');
            line.push_str(&shortened(value).to_string());
        }
    }
    line.push('}');
    line
}

/// Cuts long text, at any depth, so one record cannot fill the file.
fn shortened(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(truncate(&text, MAX_FIELD_CHARS)),
        Value::Array(items) => Value::Array(items.into_iter().map(shortened).collect()),
        Value::Object(members) => Value::Object(
            members
                .into_iter()
                .map(|(key, member)| (key, shortened(member)))
                .collect(),
        ),
        other => other,
    }
}

/// Removes the oldest log files in `dir` until at most `keep` are left. The
/// names sort by time, so the oldest come first.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_log_file(path))
        .collect();
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for file in files.iter().take(extra) {
        let _ = std::fs::remove_file(file);
    }
}

fn is_log_file(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == FILE_EXTENSION)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(FILE_PREFIX))
}

fn since_epoch(now: SystemTime) -> (u64, u32) {
    now.duration_since(UNIX_EPOCH).map_or((0, 0), |elapsed| {
        (elapsed.as_secs(), elapsed.subsec_millis())
    })
}

/// The date and time in UTC for a count of seconds since the Unix epoch:
/// year, month, day, hour, minute, second.
fn utc(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rest = u32::try_from(secs % 86_400).unwrap_or(0);
    // Days to a date in the proleptic Gregorian calendar, by counting from
    // 1 March of year 0 so that the leap day is the last day of a year.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
    )
}

/// RFC 3339 in UTC with milliseconds, for example `2026-11-19T03:47:15.120Z`.
fn timestamp(now: SystemTime) -> String {
    let (secs, millis) = since_epoch(now);
    let (year, month, day, hour, minute, second) = utc(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// For example `stackql_workbench_20261119T034715Z.log`. The engine names
/// its audit files the same way, with its own prefix.
fn file_name(now: SystemTime) -> String {
    let (secs, _) = since_epoch(now);
    let (year, month, day, hour, minute, second) = utc(secs);
    format!(
        "{FILE_PREFIX}{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z.{FILE_EXTENSION}"
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-applog-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn lines(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn dates_are_worked_out_in_utc() {
        assert_eq!(utc(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(utc(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        // A leap day in a century year that is a leap year, and an ordinary one.
        assert_eq!(utc(951_782_400), (2000, 2, 29, 0, 0, 0));
        assert_eq!(utc(1_709_164_800), (2024, 2, 29, 0, 0, 0));
        // The last second of a year and the first of the next.
        assert_eq!(utc(1_704_067_199), (2023, 12, 31, 23, 59, 59));
        assert_eq!(utc(1_704_067_200), (2024, 1, 1, 0, 0, 0));
    }

    #[test]
    fn the_file_is_named_for_the_time_the_app_started() {
        assert_eq!(
            file_name(at(1_700_000_000)),
            "stackql_workbench_20231114T221320Z.log"
        );
        assert_eq!(
            timestamp(at(1_700_000_000) + Duration::from_millis(7)),
            "2023-11-14T22:13:20.007Z"
        );
    }

    #[test]
    fn a_run_gets_its_own_file_with_one_record_on_each_line() {
        let dir = temp_dir("records");
        let log = AppLog::start_at(&dir, at(1_700_000_000));
        let path = log.path().unwrap().to_path_buf();
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            "stackql_workbench_20231114T221320Z.log"
        );
        log.error(
            "tool_call_failed",
            json!({ "tool": "run_select_query", "sql": "SELEC 1", "error": "line one\nline two" }),
        );
        log.warn("notice", json!({ "message": "something to know" }));

        let records = lines(&path);
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["event"], "app_started");
        assert_eq!(records[0]["level"], "info");
        assert_eq!(records[1]["event"], "tool_call_failed");
        assert_eq!(records[1]["level"], "error");
        assert_eq!(records[1]["sql"], "SELEC 1");
        // A message with a line break is still one line of the file.
        assert_eq!(records[1]["error"], "line one\nline two");
        assert_eq!(records[2]["level"], "warn");
        let stamp = records[1]["timestamp"].as_str().unwrap();
        assert!(stamp.ends_with('Z') && stamp.len() == 24, "{stamp}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_field_cannot_replace_the_time_the_level_or_the_event() {
        let line = record_line(
            at(0),
            Level::Info,
            "real",
            json!({ "event": "forged", "level": "error", "timestamp": "never", "kept": 1, "absent": null }),
        );
        // The three lead the line, in that order, and each is there once.
        assert!(
            line.starts_with(
                r#"{"timestamp":"1970-01-01T00:00:00.000Z","level":"info","event":"real","#
            ),
            "{line}"
        );
        assert_eq!(line.matches("\"event\"").count(), 1);
        let record: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(record["event"], "real");
        assert_eq!(record["level"], "info");
        assert_eq!(record["timestamp"], "1970-01-01T00:00:00.000Z");
        assert_eq!(record["kept"], 1);
        assert!(record.get("absent").is_none());
    }

    #[test]
    fn long_text_is_cut_at_any_depth() {
        let long = "x".repeat(MAX_FIELD_CHARS + 500);
        let line = record_line(
            at(0),
            Level::Error,
            "big",
            json!({ "error": long, "arguments": { "sql": long } }),
        );
        let record: Value = serde_json::from_str(&line).unwrap();
        assert!(record["error"].as_str().unwrap().chars().count() <= MAX_FIELD_CHARS + 3);
        assert!(
            record["arguments"]["sql"].as_str().unwrap().chars().count() <= MAX_FIELD_CHARS + 3
        );
    }

    #[test]
    fn old_files_are_removed_and_other_files_are_left_alone() {
        let dir = temp_dir("prune");
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..MAX_LOG_FILES + 5 {
            let name = file_name(at(1_700_000_000 + index as u64));
            std::fs::write(dir.join(name), "{}\n").unwrap();
        }
        std::fs::write(dir.join("notes.txt"), "mine").unwrap();
        std::fs::write(dir.join("stackql_mcp_server_20231114T221320Z.log"), "{}").unwrap();

        let log = AppLog::start_at(&dir, at(1_800_000_000));
        let mut ours: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| is_log_file(path))
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        ours.sort();
        assert_eq!(ours.len(), MAX_LOG_FILES);
        // The newest are kept, with the one this run started.
        assert_eq!(
            ours.last().map(String::as_str),
            log.path()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str())
        );
        assert_eq!(ours[0], file_name(at(1_700_000_000 + 6)));
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("stackql_mcp_server_20231114T221320Z.log").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_log_with_nowhere_to_write_records_nothing_and_does_not_fail() {
        let log = AppLog::disabled();
        assert!(log.path().is_none());
        log.error("anything", json!({ "a": 1 }));

        // A folder that cannot be made, because a file is in the way.
        let dir = temp_dir("blocked");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("in-the-way");
        std::fs::write(&file, "x").unwrap();
        let log = AppLog::start(&file.join("logs"));
        assert!(log.path().is_none());
        log.info("anything", json!({}));
        let _ = std::fs::remove_dir_all(dir);
    }
}
