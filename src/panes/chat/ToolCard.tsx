import { useState } from 'react';
import type { AgentTable } from '../../host/types';
import { argumentSummary, toolTitle, type ApprovalState, type ToolItem } from '../../lib/chat';
import { formatElapsed, formatRowCount } from '../../lib/results';
import { IconButton } from '../../ui/IconButton';
import { Check, ErrorMark, OpenInEditor, Spinner, Warning } from '../../ui/icons';

interface ToolCardProps {
  item: ToolItem;
  onOpenInEditor: (sql: string) => void;
  onShowTable: (item: ToolItem) => void;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
}

/** One tool call: what the assistant ran, whether it needed approval, and what came back. */
export function ToolCard({ item, onOpenInEditor, onShowTable, onAnswer }: ToolCardProps) {
  const [showText, setShowText] = useState(false);
  const args = argumentSummary(item.arguments);
  const waiting = item.approval?.decision === 'pending';

  return (
    <div
      className={`rounded-lg border bg-surface ${waiting ? 'border-warn' : 'border-line'}`}
      data-tool={item.tool}
    >
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="shrink-0">
          {item.status === 'running' ? (
            waiting ? (
              <Warning className="text-warn" />
            ) : (
              <Spinner className="text-ink-muted" />
            )
          ) : item.status === 'error' ? (
            <ErrorMark className="text-danger" />
          ) : (
            <Check className="text-ok" />
          )}
        </span>
        <span className="font-semibold">{toolTitle(item.tool)}</span>
        {item.agent !== null && (
          <span
            className="shrink-0 rounded-full border border-line px-1.5 text-[11px] text-ink-muted"
            title={`Run by the subagent ${item.agent}`}
          >
            {item.agent}
          </span>
        )}
        {args !== '' && <span className="selectable min-w-0 truncate text-ink-muted">{args}</span>}
        <span className="flex-1" />
        {item.elapsedMs !== null && (
          <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
            {formatElapsed(item.elapsedMs)}
          </span>
        )}
      </div>

      {item.sql !== null && (
        <SqlBlock
          sql={item.sql}
          onOpen={() => {
            onOpenInEditor(item.sql ?? '');
          }}
        />
      )}

      {item.approval && <ApprovalCard approval={item.approval} onAnswer={onAnswer} />}

      {item.status !== 'running' && (
        <div className="border-t border-line px-2 py-1">
          {item.status === 'error' ? (
            <pre className="selectable m-0 font-mono text-[12px] break-words whitespace-pre-wrap text-danger">
              {item.text.trim() || 'The tool reported an error.'}
            </pre>
          ) : item.table ? (
            <ResultPreview
              table={item.table}
              onShowTable={() => {
                onShowTable(item);
              }}
            />
          ) : (
            <>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setShowText((open) => !open);
                }}
              >
                {showText ? 'Hide output' : 'Show output'}
              </button>
              {showText && (
                <pre className="selectable m-0 mt-1 max-h-60 overflow-auto font-mono text-[12px] break-words whitespace-pre-wrap">
                  {item.text.trim() || '(no output)'}
                </pre>
              )}
            </>
          )}

          {item.engineNotes.length > 0 && (
            <div className="mt-1 flex items-start gap-1.5 text-ink-muted">
              <div className="min-w-0">
                <div>
                  A provider answered a call with this while the statement ran. The assistant was
                  given the result above and not this message.
                </div>
                {item.engineNotes.map((note, index) => (
                  <div
                    key={index}
                    className="selectable truncate font-mono text-[12px]"
                    title={note}
                  >
                    {note}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Rows shown in the conversation. The grid has the rest. */
const PREVIEW_ROWS = 8;

/** The first rows of a result, in place, with a way to the full grid. */
function ResultPreview({ table, onShowTable }: { table: AgentTable; onShowTable: () => void }) {
  const rows = table.rows.slice(0, PREVIEW_ROWS);
  const hasGrid = table.columns.length > 0;
  return (
    <div>
      {hasGrid && rows.length > 0 && (
        <div className="mb-1 max-h-60 overflow-auto rounded border border-line">
          <table className="selectable w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th
                    key={column}
                    className="sticky top-0 border-b border-line bg-surface-alt px-2 py-1 text-left font-semibold whitespace-nowrap"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-b border-line last:border-b-0">
                  {row.map((cell, position) => (
                    <td
                      key={position}
                      className="max-w-[320px] truncate px-2 py-1 align-top"
                      title={cell ?? 'null'}
                    >
                      {cell ?? <span className="text-ink-muted italic">null</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-ink-muted">
          {formatRowCount(table.totalRows)}
          {rows.length < table.totalRows ? `, first ${rows.length} shown here` : ''}
        </span>
        {hasGrid && (
          <button type="button" className="text-accent hover:underline" onClick={onShowTable}>
            Open in grid
          </button>
        )}
      </div>
    </div>
  );
}

function SqlBlock({ sql, onOpen }: { sql: string; onOpen: () => void }) {
  return (
    <div className="relative border-t border-line bg-surface-alt">
      <pre className="selectable m-0 max-h-48 overflow-auto py-1.5 pr-8 pl-2 font-mono text-[12px] break-words whitespace-pre-wrap">
        {sql}
      </pre>
      <div className="absolute top-0.5 right-0.5">
        <IconButton label="Open in editor" onClick={onOpen}>
          <OpenInEditor />
        </IconButton>
      </div>
    </div>
  );
}

const DECIDED: Record<Exclude<ApprovalState['decision'], 'pending'>, string> = {
  accept: 'You approved this.',
  decline: 'You declined this.',
  cancel: 'This prompt was dismissed without an answer.',
};

/**
 * The engine's approval prompt. The engine decides what needs approval and
 * the operator decides the answer. Nothing here answers on its own.
 */
function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: ApprovalState;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
}) {
  const { request, decision } = approval;
  const headline = request.message.split('\n')[0] ?? 'Approval needed';

  if (decision !== 'pending') {
    return (
      <div className="border-t border-line px-2 py-1 text-ink-muted" role="status">
        {DECIDED[decision]}
      </div>
    );
  }

  return (
    <div
      className="border-t border-warn bg-warn/10 px-2 py-2"
      role="alertdialog"
      aria-label="Approval needed"
    >
      <div className="font-semibold">{headline}</div>
      <div className="text-ink-muted">
        The engine will not run this until you decide.
        {request.queryClass ? ` It classed the statement as ${request.queryClass}.` : ''}
      </div>
      <pre className="selectable m-0 mt-1.5 max-h-48 overflow-auto rounded border border-line bg-surface p-2 font-mono text-[12px] break-words whitespace-pre-wrap">
        {request.sql ?? request.message}
      </pre>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          className="h-7 rounded border border-line bg-surface px-3 hover:bg-surface-sunken"
          onClick={() => {
            onAnswer(request.id, 'decline');
          }}
        >
          Decline
        </button>
        <button
          type="button"
          className="h-7 rounded bg-brand px-3 font-semibold text-on-brand hover:bg-brand-dark"
          onClick={() => {
            onAnswer(request.id, 'accept');
          }}
        >
          Approve and run
        </button>
      </div>
    </div>
  );
}
