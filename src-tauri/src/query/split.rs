//! Splitting editor text into statements.
//!
//! `stackql srv` runs only the first statement of a simple query message and
//! drops the rest without an error (see `docs/spike-pgwire.md`). The host
//! therefore splits the text itself and sends one statement per message.

/// Splits SQL text on semicolons that are not inside a string, a quoted
/// identifier or a comment. Statements are trimmed. Pieces that hold nothing
/// but whitespace and comments are dropped.
pub fn split_statements(input: &str) -> Vec<String> {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Normal,
        SingleQuote,
        DoubleQuote,
        LineComment,
        BlockComment,
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut has_content = false;
    let mut state = State::Normal;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match state {
            State::Normal => match c {
                ';' => {
                    if has_content {
                        out.push(current.trim().to_string());
                    }
                    current.clear();
                    has_content = false;
                    continue;
                }
                '\'' => {
                    state = State::SingleQuote;
                    has_content = true;
                }
                '"' => {
                    state = State::DoubleQuote;
                    has_content = true;
                }
                '-' if chars.peek() == Some(&'-') => state = State::LineComment,
                '/' if chars.peek() == Some(&'*') => {
                    current.push(c);
                    if let Some(star) = chars.next() {
                        current.push(star);
                    }
                    state = State::BlockComment;
                    continue;
                }
                c if !c.is_whitespace() => has_content = true,
                _ => {}
            },
            // A doubled quote is an escaped quote and stays inside the literal.
            State::SingleQuote if c == '\'' => {
                if chars.peek() == Some(&'\'') {
                    current.push(c);
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                    continue;
                }
                state = State::Normal;
            }
            State::DoubleQuote if c == '"' => {
                if chars.peek() == Some(&'"') {
                    current.push(c);
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                    continue;
                }
                state = State::Normal;
            }
            State::LineComment if c == '\n' => state = State::Normal,
            State::BlockComment if c == '*' && chars.peek() == Some(&'/') => {
                current.push(c);
                if let Some(slash) = chars.next() {
                    current.push(slash);
                }
                state = State::Normal;
                continue;
            }
            _ => {}
        }
        current.push(c);
    }

    if has_content {
        out.push(current.trim().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_statement_is_returned_trimmed() {
        assert_eq!(
            split_statements("  SHOW PROVIDERS  "),
            vec!["SHOW PROVIDERS"]
        );
        assert_eq!(split_statements("SHOW PROVIDERS;"), vec!["SHOW PROVIDERS"]);
    }

    #[test]
    fn statements_are_split_on_semicolons() {
        assert_eq!(
            split_statements("SHOW VERSION; SHOW PROVIDERS;\nSELECT 1"),
            vec!["SHOW VERSION", "SHOW PROVIDERS", "SELECT 1"]
        );
    }

    #[test]
    fn empty_pieces_are_dropped() {
        assert_eq!(split_statements(""), Vec::<String>::new());
        assert_eq!(split_statements(" ;; ; "), Vec::<String>::new());
        assert_eq!(
            split_statements("SELECT 1;;SELECT 2"),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn semicolons_in_string_literals_do_not_split() {
        assert_eq!(
            split_statements("SELECT 'a;b' AS x; SELECT 2"),
            vec!["SELECT 'a;b' AS x", "SELECT 2"]
        );
    }

    #[test]
    fn escaped_quotes_stay_inside_the_literal() {
        assert_eq!(
            split_statements("SELECT 'it''s; fine' AS x; SELECT 2"),
            vec!["SELECT 'it''s; fine' AS x", "SELECT 2"]
        );
    }

    #[test]
    fn semicolons_in_quoted_identifiers_do_not_split() {
        assert_eq!(
            split_statements("SELECT \"odd;name\" FROM t; SELECT 2"),
            vec!["SELECT \"odd;name\" FROM t", "SELECT 2"]
        );
    }

    #[test]
    fn semicolons_in_comments_do_not_split() {
        assert_eq!(
            split_statements("SELECT 1 -- not; a split\n; SELECT 2 /* nor; this */;"),
            vec!["SELECT 1 -- not; a split", "SELECT 2 /* nor; this */"]
        );
    }

    #[test]
    fn comment_only_pieces_are_dropped() {
        assert_eq!(
            split_statements("-- just a note\n; /* another */ ; SELECT 1"),
            vec!["SELECT 1"]
        );
        assert_eq!(split_statements("-- nothing here"), Vec::<String>::new());
    }

    #[test]
    fn a_leading_comment_stays_with_its_statement() {
        assert_eq!(
            split_statements("-- list them\nSHOW PROVIDERS;"),
            vec!["-- list them\nSHOW PROVIDERS"]
        );
    }

    #[test]
    fn a_quote_inside_a_comment_does_not_open_a_string() {
        assert_eq!(
            split_statements("SELECT 1 -- don't worry\n; SELECT 2"),
            vec!["SELECT 1 -- don't worry", "SELECT 2"]
        );
    }

    #[test]
    fn an_unterminated_string_keeps_the_rest_together() {
        assert_eq!(
            split_statements("SELECT 'open; SELECT 2"),
            vec!["SELECT 'open; SELECT 2"]
        );
    }

    #[test]
    fn minus_and_slash_operators_are_not_comments() {
        assert_eq!(
            split_statements("SELECT 4 - 2 AS a, 4 / 2 AS b; SELECT 1"),
            vec!["SELECT 4 - 2 AS a, 4 / 2 AS b", "SELECT 1"]
        );
    }
}
