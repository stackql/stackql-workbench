// The activity pane's rows: the operator's statement history and the
// engine's agent audit log, merged into one list by time.
//
// What happened to an agent's call is the engine's decision, read from its
// audit log. Nothing here works an outcome out from the statement.

import type { Activity, AuditRecord, HistoryEntry } from '../host/types';

/** What became of a statement, in the terms the list is filtered by. */
export type OutcomeKind =
  'ran' | 'failed' | 'refused' | 'approved' | 'declined' | 'stopped' | 'other';

export interface ActivityRow {
  key: string;
  /** Milliseconds since the Unix epoch. 0 when the time could not be read. */
  time: number;
  channel: 'operator' | 'agent';
  /** The safety mode an agent's call ran under. Empty for the operator. */
  mode: string;
  /** The statement, or the tool name when the call carried no statement. */
  label: string;
  /** The statement, when there is one to open in the editor. */
  sql: string | null;
  durationMs: number | null;
  /** Rows returned. The engine's audit log has no count, so agent rows have none. */
  rowCount: number | null;
  kind: OutcomeKind;
  /** The outcome in words. An engine decision this app does not know is shown as written. */
  outcome: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
  /** For an agent's call: the tool and the engine's classification. */
  detail: string;
  /** For an agent's call: the engine tool that was called. */
  tool: string | null;
  /** For an agent's call: the engine's decision as written in its log. */
  decision: string | null;
  error: string | null;
}

const DECISIONS: Record<string, { outcome: string; tone: ActivityRow['tone']; kind: OutcomeKind }> =
  {
    allow: { outcome: 'Ran', tone: 'ok', kind: 'ran' },
    needs_approval_accepted: { outcome: 'Approved and ran', tone: 'ok', kind: 'approved' },
    needs_approval_declined: { outcome: 'Declined', tone: 'warn', kind: 'declined' },
    needs_approval_cancelled: { outcome: 'Dismissed', tone: 'warn', kind: 'declined' },
    needs_approval_unavailable: {
      outcome: 'Refused, no approval possible',
      tone: 'error',
      kind: 'refused',
    },
    refuse_immediate: { outcome: 'Refused', tone: 'error', kind: 'refused' },
  };

function operatorRow(entry: HistoryEntry, index: number): ActivityRow {
  const failed = entry.outcome === 'error';
  const abandoned = entry.outcome === 'abandoned';
  return {
    key: `o-${entry.timestampMs}-${index}`,
    time: entry.timestampMs,
    channel: 'operator',
    mode: '',
    label: entry.sql,
    sql: entry.sql,
    // The app stopped waiting, so it does not know how long the engine took.
    durationMs: abandoned ? null : entry.elapsedMs,
    rowCount: entry.rows,
    kind: failed ? 'failed' : abandoned ? 'stopped' : 'ran',
    outcome: failed ? 'Failed' : abandoned ? 'Stopped waiting' : 'Ran',
    tone: failed ? 'error' : abandoned ? 'warn' : 'ok',
    detail: '',
    tool: null,
    decision: null,
    error: entry.error,
  };
}

function agentRow(record: AuditRecord, index: number): ActivityRow {
  const known = DECISIONS[record.decision];
  // A call the engine allowed can still have failed when it ran.
  const failedAfterAllow = record.error !== null && known?.tone === 'ok';
  const time = Date.parse(record.timestamp);
  return {
    key: `a-${record.timestamp}-${index}`,
    time: Number.isNaN(time) ? 0 : time,
    channel: 'agent',
    mode: record.mode,
    label: record.sql ?? record.tool,
    sql: record.sql,
    durationMs: record.durationMs,
    rowCount: null,
    kind: failedAfterAllow ? 'failed' : (known?.kind ?? 'other'),
    outcome: failedAfterAllow ? 'Ran, with an error' : (known?.outcome ?? record.decision),
    tone: failedAfterAllow ? 'error' : (known?.tone ?? 'muted'),
    detail: [record.sql === null ? '' : record.tool, record.queryClass]
      .filter((part) => part !== '')
      .join(', '),
    tool: record.tool,
    decision: record.decision,
    error: record.error,
  };
}

/** Merges both records, newest first. */
export function activityRows(activity: Activity): ActivityRow[] {
  return [...activity.operator.map(operatorRow), ...activity.agent.map(agentRow)].sort(
    (a, b) => b.time - a.time,
  );
}

export interface ActivityFilter {
  actor: 'all' | ActivityRow['channel'];
  outcome: 'all' | OutcomeKind;
}

export const NO_FILTER: ActivityFilter = { actor: 'all', outcome: 'all' };

/** The outcomes the list can be narrowed to, in the order they are offered. */
export const OUTCOME_CHOICES: { value: OutcomeKind; label: string }[] = [
  { value: 'ran', label: 'Ran' },
  { value: 'failed', label: 'Failed' },
  { value: 'refused', label: 'Refused' },
  { value: 'approved', label: 'Approved' },
  { value: 'declined', label: 'Declined' },
  { value: 'stopped', label: 'Stopped waiting' },
];

export function filterActivity(rows: ActivityRow[], filter: ActivityFilter): ActivityRow[] {
  return rows.filter(
    (row) =>
      (filter.actor === 'all' || row.channel === filter.actor) &&
      (filter.outcome === 'all' || row.kind === filter.outcome),
  );
}

/** One JSON object on each line, in the order given. */
export function activityJsonl(rows: ActivityRow[]): string {
  return rows
    .map((row) =>
      JSON.stringify({
        time: row.time === 0 ? null : new Date(row.time).toISOString(),
        actor: row.channel,
        mode: row.mode === '' ? null : row.mode,
        statement: row.sql,
        tool: row.tool,
        durationMs: row.durationMs,
        rows: row.rowCount,
        outcome: row.kind,
        decision: row.decision,
        error: row.error,
      }),
    )
    .map((line) => `${line}\n`)
    .join('');
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
