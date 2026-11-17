import { describe, expect, it } from 'vitest';
import type { Activity } from '../host/types';
import { activityRows, formatTime } from './activity';

const activity: Activity = {
  operator: [
    {
      timestampMs: Date.parse('2026-11-18T10:00:00Z'),
      sql: 'SHOW PROVIDERS',
      outcome: 'ok',
      rows: 3,
      elapsedMs: 4,
      error: null,
    },
    {
      timestampMs: Date.parse('2026-11-18T10:02:00Z'),
      sql: 'SELEC 1',
      outcome: 'error',
      rows: null,
      elapsedMs: 1,
      error: 'syntax error',
    },
    {
      timestampMs: Date.parse('2026-11-18T10:04:00Z'),
      sql: 'SELECT slow',
      outcome: 'abandoned',
      rows: null,
      elapsedMs: 0,
      error: null,
    },
  ],
  agent: [
    {
      timestamp: '2026-11-18T21:01:00+11:00',
      tool: 'list_providers',
      mode: 'safe',
      decision: 'allow',
      queryClass: 'select',
      sql: null,
      durationMs: 1,
      error: null,
    },
    {
      timestamp: '2026-11-18T21:03:00+11:00',
      tool: 'run_mutation_query',
      mode: 'safe',
      decision: 'needs_approval_declined',
      queryClass: 'mutation_delete',
      sql: 'DELETE FROM t',
      durationMs: 0,
      error: 'refused: user declined approval',
    },
    {
      timestamp: '2026-11-18T21:05:00+11:00',
      tool: 'run_select_query',
      mode: 'safe',
      decision: 'allow',
      queryClass: 'select',
      sql: 'SELECT x',
      durationMs: 40,
      error: 'no such column',
    },
  ],
};

describe('activityRows', () => {
  const rows = activityRows(activity);

  it('merges both channels, newest first, across time zones', () => {
    expect(rows.map((r) => r.label)).toEqual([
      'SELECT x',
      'SELECT slow',
      'DELETE FROM t',
      'SELEC 1',
      'list_providers',
      'SHOW PROVIDERS',
    ]);
    expect(rows.map((r) => r.channel)).toEqual([
      'agent',
      'operator',
      'agent',
      'operator',
      'agent',
      'operator',
    ]);
  });

  it('describes what the operator ran', () => {
    const ok = rows.find((r) => r.label === 'SHOW PROVIDERS');
    expect(ok).toMatchObject({
      outcome: 'Ran',
      tone: 'ok',
      detail: '3 rows, 4 ms',
      sql: 'SHOW PROVIDERS',
    });
    const failed = rows.find((r) => r.label === 'SELEC 1');
    expect(failed).toMatchObject({ outcome: 'Failed', tone: 'error', error: 'syntax error' });
    const abandoned = rows.find((r) => r.label === 'SELECT slow');
    expect(abandoned).toMatchObject({ outcome: 'Stopped waiting', tone: 'warn', detail: '' });
  });

  it('describes what the agent did, using the engine decision', () => {
    const declined = rows.find((r) => r.label === 'DELETE FROM t');
    expect(declined).toMatchObject({
      outcome: 'Declined',
      tone: 'warn',
      detail: 'run_mutation_query, safe, mutation_delete, 0 ms',
    });
    const listed = rows.find((r) => r.label === 'list_providers');
    expect(listed).toMatchObject({
      outcome: 'Ran',
      tone: 'ok',
      sql: null,
      detail: 'safe, select, 1 ms',
    });
  });

  it('does not call an allowed call that failed a success', () => {
    const failed = rows.find((r) => r.label === 'SELECT x');
    expect(failed).toMatchObject({ outcome: 'Ran, with an error', tone: 'error' });
  });

  it('shows an unknown decision as the engine wrote it', () => {
    const [row] = activityRows({
      operator: [],
      agent: [
        {
          timestamp: 'not a date',
          tool: 'list_providers',
          mode: 'safe',
          decision: 'something_new',
          queryClass: 'select',
          sql: null,
          durationMs: 1,
          error: null,
        },
      ],
    });
    expect(row).toMatchObject({ outcome: 'something_new', tone: 'muted', time: 0 });
  });

  it('gives every row a distinct key', () => {
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('formatTime', () => {
  it('shows only the clock for today and the date otherwise', () => {
    const now = new Date();
    now.setHours(9, 5, 7, 0);
    expect(formatTime(now.getTime())).toBe('09:05:07');
    expect(formatTime(new Date(2020, 0, 2, 3, 4, 5).getTime())).toBe('2020-01-02 03:04:05');
    expect(formatTime(0)).toBe('');
  });
});
