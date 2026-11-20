//! Small shared helpers.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks a mutex, recovering the guard if another thread panicked while
/// holding it. The data guarded in this crate stays consistent across a
/// panic, so poisoning carries no information worth failing on.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Shortens text for logs and status lines without splitting a character.
pub fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!("{head}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_text() {
        assert_eq!(truncate("abc", 5), "abc");
    }

    #[test]
    fn truncate_cuts_on_a_character_boundary() {
        assert_eq!(truncate("héllo wörld", 4), "héll...");
    }
}
