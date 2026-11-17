import { useEffect, useMemo, useState } from 'react';
import { host, toHostError, type Activity } from '../../host';
import { activityRows, formatTime, type ActivityRow } from '../../lib/activity';
import { IconButton } from '../../ui/IconButton';
import { OpenInEditor, Refresh, Spinner } from '../../ui/icons';

const TONE: Record<ActivityRow['tone'], string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  error: 'text-danger',
  muted: 'text-ink-muted',
};

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
  // The request that has come back. Loading is any other request.
  const [settled, setSettled] = useState<string | null>(null);
  const request = `${refreshToken}:${manual}`;
  const loading = settled !== request;

  useEffect(() => {
    let active = true;
    host
      .activity(300)
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-alt">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="text-ink-muted">Every statement run, newest first</span>
        <span className="flex-1" />
        {loading && <Spinner className="text-ink-muted" />}
        <IconButton
          label="Reload activity"
          onClick={() => {
            setManual((n) => n + 1);
          }}
        >
          <Refresh />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="selectable px-3 py-2 text-danger">{error}</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-ink-muted">
            {activity ? 'Nothing has been run yet.' : 'Loading'}
          </p>
        ) : (
          rows.map((row) => <Row key={row.key} row={row} onOpenInEditor={onOpenInEditor} />)
        )}
      </div>
    </div>
  );
}

function Row({ row, onOpenInEditor }: { row: ActivityRow; onOpenInEditor: (sql: string) => void }) {
  const sql = row.sql;
  return (
    <div className="group border-b border-line/70 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded-sm px-1 text-[10px] font-semibold ${
            row.channel === 'agent' ? 'bg-brand text-on-brand' : 'border border-line text-ink-muted'
          }`}
          title={
            row.channel === 'agent'
              ? 'Run by the assistant, through the agent channel'
              : 'Run by you, from the editor'
          }
        >
          {row.channel === 'agent' ? 'Agent' : 'You'}
        </span>
        <span className={`shrink-0 ${TONE[row.tone]}`}>{row.outcome}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-muted">{row.detail}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
          {formatTime(row.time)}
        </span>
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
      </div>
      <div
        className="selectable mt-0.5 line-clamp-3 font-mono text-[12px] break-words whitespace-pre-wrap"
        title={row.label}
      >
        {row.label}
      </div>
      {row.error && (
        <div
          className="selectable mt-0.5 line-clamp-2 text-[12px] break-words text-danger"
          title={row.error}
        >
          {row.error}
        </div>
      )}
    </div>
  );
}
