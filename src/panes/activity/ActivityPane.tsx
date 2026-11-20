import { useEffect, useMemo, useState } from 'react';
import { host, toHostError, type Activity } from '../../host';
import {
  NO_FILTER,
  OUTCOME_CHOICES,
  activityJsonl,
  activityRows,
  filterActivity,
  formatTime,
  type ActivityFilter,
  type ActivityRow,
} from '../../lib/activity';
import { formatElapsed } from '../../lib/results';
import { IconButton } from '../../ui/IconButton';
import { Download, OpenInEditor, Refresh, Spinner } from '../../ui/icons';

const TONE: Record<ActivityRow['tone'], string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  error: 'text-danger',
  muted: 'text-ink-muted',
};

/** Time, actor, mode, statement, duration, rows, outcome, and the row's action. */
const COLUMNS =
  'grid grid-cols-[104px_48px_86px_minmax(0,1fr)_72px_52px_minmax(96px,170px)_24px] gap-x-3 px-2';

const two = (value: number) => String(value).padStart(2, '0');

function exportName(now: Date): string {
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `stackql-activity-${day}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.jsonl`;
}

interface ActivityPaneProps {
  /** Changing this value reloads the list. */
  refreshToken: number;
  onOpenInEditor: (sql: string) => void;
}

/**
 * What was run, by whom. Statements the operator ran come from the app's
 * history. What the agent did comes from the engine's own audit log.
 */
export function ActivityPane({ refreshToken, onOpenInEditor }: ActivityPaneProps) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>(NO_FILTER);
  // What the last export did.
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  // The request that has come back. Loading is any other request.
  const [settled, setSettled] = useState<string | null>(null);
  const request = `${refreshToken}:${manual}`;
  const loading = settled !== request;

  useEffect(() => {
    let active = true;
    host
      .activity(1000)
      .then(
        (loaded) => {
          if (active) {
            setActivity(loaded);
            setError(null);
          }
        },
        (reason: unknown) => {
          if (active) {
            setError(toHostError(reason).message);
          }
        },
      )
      .finally(() => {
        if (active) {
          setSettled(request);
        }
      });
    return () => {
      active = false;
    };
  }, [request]);

  const rows = useMemo(() => (activity ? activityRows(activity) : []), [activity]);
  const shown = useMemo(() => filterActivity(rows, filter), [rows, filter]);
  const filtered = filter.actor !== 'all' || filter.outcome !== 'all';

  const save = () => {
    host.saveTextFile(exportName(new Date()), 'jsonl', activityJsonl(shown)).then(
      (path) => {
        if (path !== null) {
          setNote({ text: `Saved ${path}`, failed: false });
        }
      },
      (reason: unknown) => {
        setNote({ text: toHostError(reason).message, failed: true });
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-alt">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <label className="flex items-center gap-1 text-ink-muted">
          Run by
          <select
            className="h-6 rounded border border-line bg-surface px-1 text-ink"
            value={filter.actor}
            onChange={(event) => {
              setFilter({ ...filter, actor: event.target.value as ActivityFilter['actor'] });
            }}
          >
            <option value="all">Anyone</option>
            <option value="operator">You</option>
            <option value="agent">Agent</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-ink-muted">
          Outcome
          <select
            className="h-6 rounded border border-line bg-surface px-1 text-ink"
            value={filter.outcome}
            onChange={(event) => {
              setFilter({ ...filter, outcome: event.target.value as ActivityFilter['outcome'] });
            }}
          >
            <option value="all">Any</option>
            {OUTCOME_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <span className="shrink-0 text-ink-muted tabular-nums" role="status">
          {filtered
            ? `${shown.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}`
            : `${rows.length.toLocaleString('en-US')} newest first`}
        </span>
        {filtered && (
          <button
            type="button"
            className="h-6 shrink-0 rounded border border-line bg-surface px-2 hover:bg-surface-sunken"
            onClick={() => {
              setFilter(NO_FILTER);
            }}
          >
            Clear
          </button>
        )}
        <span className="flex-1" />
        {note !== null && (
          <span
            title={note.text}
            className={`selectable max-w-[40%] truncate ${note.failed ? 'text-danger' : 'text-ink-muted'}`}
          >
            {note.text}
          </span>
        )}
        {loading && <Spinner className="text-ink-muted" />}
        <IconButton
          label="Export what is listed as JSONL"
          disabled={shown.length === 0}
          onClick={save}
        >
          <Download />
        </IconButton>
        <IconButton
          label="Reload activity"
          onClick={() => {
            setManual((n) => n + 1);
          }}
        >
          <Refresh />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        {/* Inside the scrolling area, so it lines up with the rows beside a scrollbar. */}
        <div
          className={`${COLUMNS} sticky top-0 z-10 h-6 items-center border-b border-line bg-surface-alt text-[11px] font-semibold tracking-wide text-ink-muted uppercase`}
        >
          <span>Time</span>
          <span>By</span>
          <span>Mode</span>
          <span>Statement</span>
          <span className="text-right">Duration</span>
          <span className="text-right">Rows</span>
          <span>Outcome</span>
          <span />
        </div>
        {error ? (
          <p className="selectable px-3 py-2 text-danger">{error}</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-2 text-ink-muted">
            {!activity
              ? 'Loading'
              : rows.length === 0
                ? 'Nothing has been run yet.'
                : 'Nothing matches the filters.'}
          </p>
        ) : (
          shown.map((row) => <Row key={row.key} row={row} onOpenInEditor={onOpenInEditor} />)
        )}
      </div>
    </div>
  );
}

function Row({ row, onOpenInEditor }: { row: ActivityRow; onOpenInEditor: (sql: string) => void }) {
  const sql = row.sql;
  const agent = row.channel === 'agent';
  return (
    <div className={`${COLUMNS} group items-start border-b border-line/70 py-1.5`}>
      <span className="text-[12px] text-ink-muted tabular-nums">{formatTime(row.time)}</span>
      <span>
        <span
          className={`rounded-sm px-1 text-[10px] font-semibold ${
            agent ? 'bg-brand text-on-brand' : 'border border-line text-ink-muted'
          }`}
          title={
            agent
              ? 'Run by the assistant, through the agent channel'
              : 'Run by you, from the editor'
          }
        >
          {agent ? 'Agent' : 'You'}
        </span>
      </span>
      <span
        className="truncate font-mono text-[12px] text-ink-muted"
        title={
          agent ? 'The safety mode the engine applied' : 'The safety mode applies to the agent'
        }
      >
        {row.mode}
      </span>
      <div className="min-w-0">
        <div
          className="selectable line-clamp-2 font-mono text-[12px] break-words whitespace-pre-wrap"
          title={row.label}
        >
          {row.label}
        </div>
        {row.detail !== '' && (
          <div className="truncate text-[11px] text-ink-muted" title="Engine tool and query class">
            {row.detail}
          </div>
        )}
        {row.error && (
          <div
            className="selectable line-clamp-2 text-[12px] break-words text-danger"
            title={row.error}
          >
            {row.error}
          </div>
        )}
      </div>
      <span className="text-right text-[12px] text-ink-muted tabular-nums">
        {row.durationMs === null ? '' : formatElapsed(row.durationMs)}
      </span>
      <span
        className="text-right text-[12px] text-ink-muted tabular-nums"
        title={agent ? 'The engine does not record a row count for the agent' : undefined}
      >
        {row.rowCount === null ? '' : row.rowCount.toLocaleString('en-US')}
      </span>
      <span className={TONE[row.tone]} title={row.decision ?? undefined}>
        {row.outcome}
      </span>
      <span>
        {sql !== null && (
          <IconButton
            label="Open in editor"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => {
              onOpenInEditor(sql);
            }}
          >
            <OpenInEditor />
          </IconButton>
        )}
      </span>
    </div>
  );
}
