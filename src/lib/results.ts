// The state of a run in the results pane, built up from the events the host
// streams. Pure functions, so the mapping can be tested without a host.

import type { HostError, Notice, QueryError, QueryEvent, Row, RunSummary } from '../host/types';

export type StatementStatus = 'running' | 'done' | 'failed' | 'abandoned';

export interface StatementResult {
  index: number;
  sql: string;
  status: StatementStatus;
  /** Null until the engine has described the result. Some statements never do. */
  columns: string[] | null;
  rows: Row[];
  /** Set when the statement finishes. The engine does not report a count, the host counts. */
  rowCount: number | null;
  elapsedMs: number | null;
  notices: Notice[];
  /** Lines the engine wrote to stderr while the statement ran. */
  engineLog: string[];
  error: QueryError | null;
}

export interface RunState {
  runId: string | null;
  /** Who produced it: the operator from the editor, or the assistant. */
  origin: 'operator' | 'agent';
  running: boolean;
  /** Statements found in the text. Known once the first one starts. */
  total: number;
  statements: StatementResult[];
  summary: RunSummary | null;
  /** Set when the host call itself failed, for example because the engine is down. */
  hostError: HostError | null;
}

export const emptyRun: RunState = {
  runId: null,
  origin: 'operator',
  running: false,
  total: 0,
  statements: [],
  summary: null,
  hostError: null,
};

export function startRun(runId: string): RunState {
  return { ...emptyRun, runId, running: true };
}

function newStatement(index: number, sql: string): StatementResult {
  return {
    index,
    sql,
    status: 'running',
    columns: null,
    rows: [],
    rowCount: null,
    elapsedMs: null,
    notices: [],
    engineLog: [],
    error: null,
  };
}

function update(
  state: RunState,
  index: number,
  change: (statement: StatementResult) => StatementResult,
): RunState {
  if (!state.statements.some((s) => s.index === index)) {
    // An event for a statement that never started. Nothing to attach it to.
    return state;
  }
  return {
    ...state,
    statements: state.statements.map((s) => (s.index === index ? change(s) : s)),
  };
}

/**
 * A finished run made from a row result the assistant produced, so that it
 * shows in the same grid as the operator's own results.
 */
export function agentRun(
  id: string,
  sql: string,
  columns: string[],
  rows: Row[],
  elapsedMs: number,
  engineNotes: string[],
): RunState {
  const statement: StatementResult = {
    ...newStatement(0, sql),
    status: 'done',
    columns,
    rows,
    rowCount: rows.length,
    elapsedMs,
    // Shown the same way as an upstream failure on the operator's channel.
    notices: engineNotes.map((note) => ({
      severity: 'NOTICE',
      code: '',
      message: note,
      detail: note,
    })),
  };
  return { ...emptyRun, runId: id, origin: 'agent', total: 1, statements: [statement] };
}

/** Applies one host event. */
export function applyEvent(state: RunState, event: QueryEvent): RunState {
  switch (event.event) {
    case 'statementStarted':
      return {
        ...state,
        total: event.data.total,
        statements: [...state.statements, newStatement(event.data.index, event.data.sql)],
      };
    case 'columns':
      return update(state, event.data.index, (s) => ({ ...s, columns: event.data.columns }));
    case 'rows':
      return update(state, event.data.index, (s) => ({
        ...s,
        rows: s.rows.concat(event.data.rows),
      }));
    case 'notice':
      return update(state, event.data.index, (s) => ({
        ...s,
        notices: [...s.notices, event.data.notice],
      }));
    case 'engineLog':
      return update(state, event.data.index, (s) => ({
        ...s,
        engineLog: s.engineLog.concat(event.data.lines),
      }));
    case 'statementFinished':
      return update(state, event.data.index, (s) => ({
        ...s,
        status: 'done',
        rowCount: event.data.rowCount,
        elapsedMs: event.data.elapsedMs,
      }));
    case 'statementFailed':
      return update(state, event.data.index, (s) => ({
        ...s,
        status: 'failed',
        error: event.data.error,
        elapsedMs: event.data.elapsedMs,
      }));
  }
}

/** Applies the outcome of the host call that ran the statements. */
export function finishRun(state: RunState, summary: RunSummary): RunState {
  return {
    ...state,
    running: false,
    summary,
    // A statement still marked running was the one the operator stopped waiting for.
    statements: state.statements.map((s) =>
      s.status === 'running' ? { ...s, status: summary.abandoned ? 'abandoned' : 'failed' } : s,
    ),
  };
}

/** Applies a failure of the host call itself. */
export function failRun(state: RunState, error: HostError): RunState {
  return {
    ...state,
    running: false,
    hostError: error,
    statements: state.statements.map((s) =>
      s.status === 'running' ? { ...s, status: 'failed' } : s,
    ),
  };
}

/**
 * The statement whose result the grid should show: the last one that
 * produced a result set, or failing that the last one.
 */
export function gridStatement(state: RunState): StatementResult | null {
  for (let i = state.statements.length - 1; i >= 0; i -= 1) {
    const statement = state.statements[i];
    if (statement?.columns && statement.columns.length > 0) {
      return statement;
    }
  }
  return state.statements.at(-1) ?? null;
}

/**
 * True when a statement succeeded with no rows but the engine attached a
 * notice. That is how a failed provider API call shows up: the engine
 * reports success with an empty result. See docs/spike-pgwire.md.
 */
export function looksLikeUpstreamFailure(statement: StatementResult): boolean {
  return statement.status === 'done' && statement.rows.length === 0 && statement.notices.length > 0;
}

/** Number of things in the messages area that deserve attention. */
export function attentionCount(state: RunState): number {
  let count = state.hostError ? 1 : 0;
  for (const statement of state.statements) {
    if (statement.error) {
      count += 1;
    }
    count += statement.notices.length;
  }
  return count;
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export function formatRowCount(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'row' : 'rows'}`;
}
