// The activity pane's rows: the operator's statement history and the
// engine's agent audit log, merged into one list by time.

import type { Activity, AuditRecord, HistoryEntry } from '../host/types';

export interface ActivityRow {
  key: string;
  /** Milliseconds since the Unix epoch. 0 when the time could not be read. */
  time: number;
  channel: 'operator' | 'agent';
  /** The statement, or the tool name when the call carried no statement. */
  label: string;
  /** The statement, when there is one to open in the editor. */
  sql: string | null;
  outcome: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
  /** Extra detail: rows and time, or the safety mode and classification. */
  detail: string;
  error: string | null;
}

const DECISIONS: Record<string, { outcome: string; tone: ActivityRow['tone'] }> = {
  allow: { outcome: 'Ran', tone: 'ok' },
  needs_approval_accepted: { outcome: 'Approved and ran', tone: 'ok' },
  needs_approval_declined: { outcome: 'Declined', tone: 'warn' },
  needs_approval_cancelled: { outcome: 'Dismissed', tone: 'warn' },
  needs_approval_unavailable: { outcome: 'Refused, no approval possible', tone: 'error' },
  refuse_immediate: { outcome: 'Refused', tone: 'error' },
};

function operatorRow(entry: HistoryEntry, index: number): ActivityRow {
  const failed = entry.outcome === 'error';
  const abandoned = entry.outcome === 'abandoned';
  const parts: string[] = [];
  if (entry.rows !== null) {
    parts.push(`${entry.rows.toLocaleString('en-US')} ${entry.rows === 1 ? 'row' : 'rows'}`);
  }
  if (!abandoned) {
    parts.push(`${entry.elapsedMs.toLocaleString('en-US')} ms`);
  }
  return {
    key: `o-${entry.timestampMs}-${index}`,
    time: entry.timestampMs,
    channel: 'operator',
    label: entry.sql,
    sql: entry.sql,
    outcome: failed ? 'Failed' : abandoned ? 'Stopped waiting' : 'Ran',
    tone: failed ? 'error' : abandoned ? 'warn' : 'ok',
    detail: parts.join(', '),
    error: entry.error,
  };
}

function agentRow(record: AuditRecord, index: number): ActivityRow {
  const known = DECISIONS[record.decision];
  // A call the engine allowed can still have failed when it ran.
  const failedAfterAllow = record.error !== null && known?.tone === 'ok';
  const parts = [record.mode, record.queryClass].filter((part) => part !== '');
  if (record.durationMs !== null) {
    parts.push(`${record.durationMs.toLocaleString('en-US')} ms`);
  }
  const time = Date.parse(record.timestamp);
  return {
    key: `a-${record.timestamp}-${index}`,
    time: Number.isNaN(time) ? 0 : time,
    channel: 'agent',
    label: record.sql ?? record.tool,
    sql: record.sql,
    outcome: failedAfterAllow ? 'Ran, with an error' : (known?.outcome ?? record.decision),
    tone: failedAfterAllow ? 'error' : (known?.tone ?? 'muted'),
    detail: [record.sql === null ? '' : record.tool, ...parts].filter((p) => p !== '').join(', '),
    error: record.error,
  };
}

/** Merges both records, newest first. */
export function activityRows(activity: Activity): ActivityRow[] {
  return [...activity.operator.map(operatorRow), ...activity.agent.map(agentRow)].sort(
    (a, b) => b.time - a.time,
  );
}

export function formatTime(time: number): string {
  if (time === 0) {
    return '';
  }
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? clock
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
