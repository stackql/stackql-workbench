import { describe, expect, it } from 'vitest';
import type { QueryEvent, RunSummary } from '../host/types';
import {
  applyEvent,
  attentionCount,
  emptyRun,
  failRun,
  finishRun,
  formatElapsed,
  formatRowCount,
  gridStatement,
  looksLikeUpstreamFailure,
  startRun,
  type RunState,
} from './results';

function play(events: QueryEvent[], from: RunState = startRun('run-1')): RunState {
  return events.reduce(applyEvent, from);
}

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  statements: 1,
  completed: 1,
  failed: false,
  abandoned: false,
  elapsedMs: 10,
  ...over,
});

const notice = {
  severity: 'NOTICE',
  code: '01000',
  message: 'a notice level event has occurred',
  detail: 'http response status code: 404',
};

describe('applyEvent', () => {
  it('builds a result from the events of one statement', () => {
    const state = play([
      { event: 'statementStarted', data: { index: 0, total: 1, sql: 'SHOW PROVIDERS' } },
      { event: 'columns', data: { index: 0, columns: ['name', 'version'] } },
      { event: 'rows', data: { index: 0, rows: [['github', 'v1']] } },
      { event: 'rows', data: { index: 0, rows: [['homebrew', 'v2']] } },
      { event: 'statementFinished', data: { index: 0, rowCount: 2, elapsedMs: 7 } },
    ]);

    expect(state.total).toBe(1);
    expect(state.statements).toHaveLength(1);
    const [statement] = state.statements;
    expect(statement).toMatchObject({
      sql: 'SHOW PROVIDERS',
      status: 'done',
      columns: ['name', 'version'],
      rowCount: 2,
      elapsedMs: 7,
    });
    expect(statement?.rows).toEqual([
      ['github', 'v1'],
      ['homebrew', 'v2'],
    ]);
  });

  it('keeps row batches in order and preserves nulls', () => {
    const state = play([
      { event: 'statementStarted', data: { index: 0, total: 1, sql: 'SELECT 1' } },
      { event: 'rows', data: { index: 0, rows: [['a', null]] } },
      {
        event: 'rows',
        data: {
          index: 0,
          rows: [
            [null, 'b'],
            ['c', 'd'],
          ],
        },
      },
    ]);
    expect(state.statements[0]?.rows).toEqual([
      ['a', null],
      [null, 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps statements apart', () => {
    const state = play([
      { event: 'statementStarted', data: { index: 0, total: 2, sql: 'SHOW VERSION' } },
      { event: 'columns', data: { index: 0, columns: ['version'] } },
      { event: 'rows', data: { index: 0, rows: [['1.0.888']] } },
      { event: 'statementFinished', data: { index: 0, rowCount: 1, elapsedMs: 2 } },
      { event: 'statementStarted', data: { index: 1, total: 2, sql: 'SELEC 1' } },
      {
        event: 'statementFailed',
        data: {
          index: 1,
          error: { severity: 'ERROR', code: 'XXUUU', message: 'syntax', connectionLost: false },
          elapsedMs: 1,
        },
      },
    ]);
    expect(state.statements.map((s) => s.status)).toEqual(['done', 'failed']);
    expect(state.statements[0]?.rows).toEqual([['1.0.888']]);
    expect(state.statements[1]?.error?.code).toBe('XXUUU');
    expect(state.statements[1]?.rows).toEqual([]);
  });

  it('attaches notices and engine log lines to their statement', () => {
    const state = play([
      { event: 'statementStarted', data: { index: 0, total: 1, sql: 'SELECT x' } },
      { event: 'columns', data: { index: 0, columns: ['x'] } },
      { event: 'notice', data: { index: 0, notice } },
      { event: 'engineLog', data: { index: 0, lines: ['line one', 'line two'] } },
      { event: 'statementFinished', data: { index: 0, rowCount: 0, elapsedMs: 80 } },
    ]);
    expect(state.statements[0]?.notices).toEqual([notice]);
    expect(state.statements[0]?.engineLog).toEqual(['line one', 'line two']);
  });

  it('ignores an event for a statement that never started', () => {
    const state = play([{ event: 'rows', data: { index: 3, rows: [['x']] } }]);
    expect(state.statements).toEqual([]);
  });

  it('does not mutate the previous state', () => {
    const before = play([
      { event: 'statementStarted', data: { index: 0, total: 1, sql: 'SELECT 1' } },
      { event: 'rows', data: { index: 0, rows: [['a']] } },
    ]);
    const rowsBefore = before.statements[0]?.rows;
    const after = applyEvent(before, { event: 'rows', data: { index: 0, rows: [['b']] } });
    expect(rowsBefore).toEqual([['a']]);
    expect(after.statements[0]?.rows).toEqual([['a'], ['b']]);
  });
});

describe('finishRun and failRun', () => {
  it('marks the run as finished', () => {
    const state = finishRun(
      play([
        { event: 'statementStarted', data: { index: 0, total: 1, sql: 'SELECT 1' } },
        { event: 'statementFinished', data: { index: 0, rowCount: 0, elapsedMs: 1 } },
      ]),
      summary(),
    );
    expect(state.running).toBe(false);
    expect(state.summary?.completed).toBe(1);
  });

  it('marks the statement the operator stopped waiting for as abandoned', () => {
    const state = finishRun(
      play([{ event: 'statementStarted', data: { index: 0, total: 1, sql: 'SELECT slow' } }]),
      summary({ completed: 0, abandoned: true }),
    );
    expect(state.statements[0]?.status).toBe('abandoned');
  });

  it('records a failure of the host call', () => {
    const state = failRun(startRun('run-1'), {
      kind: 'engineNotRunning',
      message: 'The engine is not running.',
    });
    expect(state.running).toBe(false);
    expect(state.hostError?.kind).toBe('engineNotRunning');
  });
});

describe('gridStatement', () => {
  it('is null when nothing has run', () => {
    expect(gridStatement(emptyRun)).toBeNull();
  });

  it('prefers the last statement that produced a result set', () => {
    const state = play([
      { event: 'statementStarted', data: { index: 0, total: 2, sql: 'SHOW PROVIDERS' } },
      { event: 'columns', data: { index: 0, columns: ['name'] } },
      { event: 'statementFinished', data: { index: 0, rowCount: 0, elapsedMs: 1 } },
      { event: 'statementStarted', data: { index: 1, total: 2, sql: 'REGISTRY PULL github' } },
      { event: 'statementFinished', data: { index: 1, rowCount: 0, elapsedMs: 900 } },
    ]);
    expect(gridStatement(state)?.sql).toBe('SHOW PROVIDERS');
  });

  it('falls back to the last statement when none has columns', () => {
    const state = play([
      { event: 'statementStarted', data: { index: 0, total: 1, sql: 'REGISTRY PULL github' } },
    ]);
    expect(gridStatement(state)?.sql).toBe('REGISTRY PULL github');
  });
});

describe('looksLikeUpstreamFailure', () => {
  const base = play([
    { event: 'statementStarted', data: { index: 0, total: 1, sql: 'SELECT x' } },
    { event: 'columns', data: { index: 0, columns: ['x'] } },
  ]);

  it('is true for a successful empty result with a notice', () => {
    const state = play(
      [
        { event: 'notice', data: { index: 0, notice } },
        { event: 'statementFinished', data: { index: 0, rowCount: 0, elapsedMs: 80 } },
      ],
      base,
    );
    const [statement] = state.statements;
    expect(statement && looksLikeUpstreamFailure(statement)).toBe(true);
    expect(attentionCount(state)).toBe(1);
  });

  it('is false for a plain empty result', () => {
    const state = play(
      [{ event: 'statementFinished', data: { index: 0, rowCount: 0, elapsedMs: 3 } }],
      base,
    );
    const [statement] = state.statements;
    expect(statement && looksLikeUpstreamFailure(statement)).toBe(false);
    expect(attentionCount(state)).toBe(0);
  });

  it('is false when rows came back with the notice', () => {
    const state = play(
      [
        { event: 'rows', data: { index: 0, rows: [['wget']] } },
        { event: 'notice', data: { index: 0, notice } },
        { event: 'statementFinished', data: { index: 0, rowCount: 1, elapsedMs: 80 } },
      ],
      base,
    );
    const [statement] = state.statements;
    expect(statement && looksLikeUpstreamFailure(statement)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0 ms');
    expect(formatElapsed(999)).toBe('999 ms');
    expect(formatElapsed(1234)).toBe('1.23 s');
    expect(formatElapsed(12_345)).toBe('12.3 s');
    expect(formatElapsed(125_000)).toBe('2 min 5 s');
  });

  it('formats row counts', () => {
    expect(formatRowCount(0)).toBe('0 rows');
    expect(formatRowCount(1)).toBe('1 row');
    expect(formatRowCount(12_345)).toBe('12,345 rows');
  });
});
