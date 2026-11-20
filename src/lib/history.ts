// The editor's statement history: what the operator ran, most recent
// first, each statement listed once. Statements only, never results.

import type { HistoryEntry } from '../host/types';

export interface HistoryItem {
  sql: string;
  /** When it was last run. Milliseconds since the Unix epoch. */
  timestampMs: number;
  /** How the last run ended: ok, error or abandoned. */
  outcome: string;
  /** How many times it was run. */
  runs: number;
}

/**
 * The statements in `entries`, most recently run first. Runs of the same
 * statement are folded into one item. `search` keeps the items that hold
 * the text, whatever its case.
 */
export function recentStatements(entries: HistoryEntry[], search = ''): HistoryItem[] {
  const items = new Map<string, HistoryItem>();
  for (const entry of entries) {
    const sql = entry.sql.trim();
    if (sql === '') {
      continue;
    }
    const known = items.get(sql);
    if (!known) {
      items.set(sql, { sql, timestampMs: entry.timestampMs, outcome: entry.outcome, runs: 1 });
    } else {
      known.runs += 1;
      if (entry.timestampMs >= known.timestampMs) {
        known.timestampMs = entry.timestampMs;
        known.outcome = entry.outcome;
      }
    }
  }
  const text = search.trim().toLowerCase();
  return [...items.values()]
    .filter((item) => text === '' || item.sql.toLowerCase().includes(text))
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

/** A statement on one line, for a list. */
export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** How long ago something happened, in words short enough for a list. */
export function timeAgo(timestampMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
