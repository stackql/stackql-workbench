import { useState } from 'react';
import type { Notice } from '../../host/types';
import {
  formatElapsed,
  formatRowCount,
  looksLikeUpstreamFailure,
  type RunState,
  type StatementResult,
} from '../../lib/results';
import { Check, ErrorMark, Spinner, Stop, Warning } from '../../ui/icons';

const COLLAPSED_LINES = 8;

/** Notices, errors and engine output for each statement of a run. */
export function Messages({ run }: { run: RunState }) {
  if (run.statements.length === 0 && !run.hostError) {
    return <p className="px-3 py-2 text-ink-muted">Nothing to report yet.</p>;
  }
  return (
    <div className="selectable h-full min-h-0 overflow-auto bg-surface px-3 py-2">
      {run.hostError && (
        <div className="mb-2 flex items-start gap-2 text-danger">
          <ErrorMark className="mt-0.5 shrink-0" />
          <span>{run.hostError.message}</span>
        </div>
      )}
      {run.statements.map((statement) => (
        <StatementMessages key={statement.index} statement={statement} />
      ))}
      {run.summary?.abandoned && (
        <p className="mt-2 flex items-start gap-2 text-warn">
          <Warning className="mt-0.5 shrink-0" />
          <span>
            You stopped waiting. The engine cannot cancel a statement, so it may still be running
            there, and a statement that changes something may still complete. Restart the engine to
            stop it for certain.
          </span>
        </p>
      )}
    </div>
  );
}

function outcome(statement: StatementResult): string {
  const time = statement.elapsedMs === null ? '' : ` in ${formatElapsed(statement.elapsedMs)}`;
  switch (statement.status) {
    case 'running':
      return 'Running';
    case 'done':
      return statement.columns === null
        ? `Done${time}`
        : `${formatRowCount(statement.rowCount ?? statement.rows.length)}${time}`;
    case 'failed':
      return `Failed${time}`;
    case 'abandoned':
      return 'Stopped waiting';
  }
}

function StatementMessages({ statement }: { statement: StatementResult }) {
  const upstream = looksLikeUpstreamFailure(statement);
  return (
    <div className="mb-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {statement.status === 'running' ? (
            <Spinner className="text-ink-muted" />
          ) : statement.status === 'failed' ? (
            <ErrorMark className="text-danger" />
          ) : statement.status === 'abandoned' ? (
            <Stop className="text-warn" />
          ) : upstream ? (
            <Warning className="text-warn" />
          ) : (
            <Check className="text-ok" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px]" title={statement.sql}>
            {statement.sql.replace(/\s+/g, ' ')}
          </div>
          <div className="text-ink-muted">{outcome(statement)}</div>
        </div>
      </div>

      {statement.error && (
        <div className="mt-1 ml-6 text-danger">
          <pre className="m-0 font-mono text-[12px] break-words whitespace-pre-wrap">
            {statement.error.message.trim()}
          </pre>
          {(statement.error.code ?? statement.error.severity) && (
            <div className="text-[11px] text-ink-muted">
              {[statement.error.severity, statement.error.code].filter(Boolean).join(' ')}
              {statement.error.connectionLost ? ', connection lost' : ''}
            </div>
          )}
        </div>
      )}

      {upstream && (
        <p className="mt-1 ml-6 text-warn">
          No rows came back and the engine reported a problem. A failed provider API call looks like
          this: the statement succeeds with an empty result.
        </p>
      )}

      {statement.notices.map((notice, index) => (
        <NoticeBlock key={index} notice={notice} />
      ))}

      {statement.engineLog.length > 0 && (
        <LongText label="Engine output" text={statement.engineLog.join('\n')} tone="muted" />
      )}
    </div>
  );
}

function NoticeBlock({ notice }: { notice: Notice }) {
  const text = notice.detail?.trim() ?? notice.message;
  return <LongText label={`${notice.severity} ${notice.code}`.trim()} text={text} tone="warn" />;
}

function LongText({ label, text, tone }: { label: string; text: string; tone: 'warn' | 'muted' }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > COLLAPSED_LINES || text.length > 1200;
  const shown = open || !long ? text : lines.slice(0, COLLAPSED_LINES).join('\n').slice(0, 1200);

  return (
    <div className="mt-1 ml-6">
      <div className={`text-[11px] ${tone === 'warn' ? 'text-warn' : 'text-ink-muted'}`}>
        {label}
      </div>
      <pre className="m-0 rounded border border-line bg-surface-alt p-2 font-mono text-[12px] break-words whitespace-pre-wrap">
        {shown}
        {long && !open ? '\n...' : ''}
      </pre>
      {long && (
        <button
          type="button"
          className="mt-0.5 text-[11px] text-accent hover:underline"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {open ? 'Show less' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}
