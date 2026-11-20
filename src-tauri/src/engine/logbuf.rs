//! A bounded buffer of lines captured from a child's stderr.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::util::{lock, truncate};

const MAX_LINES: usize = 1000;
const MAX_LINE_CHARS: usize = 4000;

#[derive(Debug, Default)]
struct Inner {
    lines: VecDeque<(u64, String)>,
    next_seq: u64,
}

/// Keeps the most recent stderr lines of one child. Each line has a sequence
/// number so a caller can ask for "everything since this point", which is how
/// engine output gets attached to the statement that was running at the time.
#[derive(Debug, Clone, Default)]
pub struct LogBuffer {
    inner: Arc<Mutex<Inner>>,
}

impl LogBuffer {
    pub fn push(&self, line: &str) {
        let mut inner = lock(&self.inner);
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.lines.push_back((seq, truncate(line, MAX_LINE_CHARS)));
        while inner.lines.len() > MAX_LINES {
            inner.lines.pop_front();
        }
    }

    /// The sequence number the next line will get.
    pub fn mark(&self) -> u64 {
        lock(&self.inner).next_seq
    }

    /// Lines pushed at or after `mark`, oldest first.
    pub fn since(&self, mark: u64) -> Vec<String> {
        lock(&self.inner)
            .lines
            .iter()
            .filter(|(seq, _)| *seq >= mark)
            .map(|(_, line)| line.clone())
            .collect()
    }

    /// The last `count` lines, oldest first.
    pub fn tail(&self, count: usize) -> Vec<String> {
        let inner = lock(&self.inner);
        let skip = inner.lines.len().saturating_sub(count);
        inner
            .lines
            .iter()
            .skip(skip)
            .map(|(_, line)| line.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_returns_lines_after_the_mark() {
        let buf = LogBuffer::default();
        buf.push("one");
        let mark = buf.mark();
        buf.push("two");
        buf.push("three");
        assert_eq!(buf.since(mark), vec!["two", "three"]);
        assert_eq!(buf.since(buf.mark()), Vec::<String>::new());
    }

    #[test]
    fn tail_returns_the_most_recent_lines() {
        let buf = LogBuffer::default();
        for i in 0..5 {
            buf.push(&format!("line {i}"));
        }
        assert_eq!(buf.tail(2), vec!["line 3", "line 4"]);
        assert_eq!(buf.tail(100).len(), 5);
    }

    #[test]
    fn is_bounded() {
        let buf = LogBuffer::default();
        for i in 0..(MAX_LINES + 50) {
            buf.push(&format!("{i}"));
        }
        assert_eq!(buf.tail(usize::MAX).len(), MAX_LINES);
        assert_eq!(buf.tail(1), vec![format!("{}", MAX_LINES + 49)]);
        // A mark taken before the overflow still works, it just sees less.
        assert_eq!(buf.since(0).len(), MAX_LINES);
    }

    #[test]
    fn long_lines_are_cut() {
        let buf = LogBuffer::default();
        buf.push(&"x".repeat(MAX_LINE_CHARS + 10));
        assert_eq!(buf.tail(1)[0].chars().count(), MAX_LINE_CHARS + 3);
    }
}
