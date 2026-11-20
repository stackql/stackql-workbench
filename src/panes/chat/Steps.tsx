import { useState, type ReactNode } from 'react';
import type { TokenUsage } from '../../host/types';
import { argumentSummary, toolTitle, type ApprovalState, type ToolItem } from '../../lib/chat';
import {
  callSummary,
  stepsLabel,
  usageDetail,
  usageLabel,
  type Step,
  type StepsBlock,
} from '../../lib/conversation';
import { equivalentSql } from '../../lib/equivalentSql';
import { formatElapsed, formatRowCount } from '../../lib/results';
import { nextSort, sortRows, type SortState } from '../../lib/sortRows';
import { Check, ChevronDown, ChevronRight, ErrorMark, Spinner, Warning } from '../../ui/icons';
import { DataTable, SqlBlock } from './ResultCard';

interface StepsProps {
  block: StepsBlock;
  onOpenInEditor: (sql: string) => void;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
  /** Draws what the assistant wrote between two calls. */
  renderNote: (step: Extract<Step, { kind: 'note' }>) => ReactNode;
}

/**
 * What the assistant did on the way to its answer: the calls it made, and
 * what it wrote between them. Open while the turn runs, folded away once it
 * has ended, and always open when a call is waiting for a decision. A call
 * that failed is not here. See `lib/conversation.ts`.
 */
export function Steps({ block, onOpenInEditor, onAnswer, renderNote }: StepsProps) {
  // What the operator chose. Until they choose, the list follows the turn.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = block.waiting || (chosen ?? block.active);

  return (
    <div data-steps={block.active ? 'running' : 'done'}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1 text-ink-muted hover:bg-surface-sunken hover:text-ink"
          onClick={() => {
            setChosen(!open);
          }}
        >
          {block.active ? (
            block.waiting ? (
              <Warning className="shrink-0 text-warn" />
            ) : (
              <Spinner className="shrink-0" />
            )
          ) : open ? (
            <ChevronDown className="shrink-0" />
          ) : (
            <ChevronRight className="shrink-0" />
          )}
          <span className="truncate">{stepsLabel(block, toolTitle)}</span>
          {block.active &&
            (open ? <ChevronDown className="shrink-0" /> : <ChevronRight className="shrink-0" />)}
        </button>
        {block.usage && <UsageText usage={block.usage} />}
      </div>

      {open && (
        <div className="mt-1 ml-[9px] flex flex-col gap-0.5 border-l border-line pl-3">
          {block.steps.map((step) =>
            step.kind === 'note' ? (
              <div key={step.key} className="py-1 text-ink-muted" data-step="note">
                {renderNote(step)}
              </div>
            ) : (
              <Call
                key={step.key}
                item={step.item}
                onOpenInEditor={onOpenInEditor}
                onAnswer={onAnswer}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a turn used, in tokens, as the provider counted it. Small and to the
 * side: it is there for whoever wants it and is not part of the answer.
 */
export function UsageText({ usage }: { usage: TokenUsage }) {
  const label = usageLabel(usage);
  if (label === '') {
    return null;
  }
  return (
    <span
      className="selectable shrink-0 text-[12px] text-ink-muted tabular-nums"
      title={usageDetail(usage)}
      data-usage
    >
      {label}
    </span>
  );
}

interface CallProps {
  item: ToolItem;
  onOpenInEditor: (sql: string) => void;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
}

/** One call: a line that says what it was, and its SQL and result on request. */
function Call({ item, onOpenInEditor, onAnswer }: CallProps) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const waiting = item.approval?.decision === 'pending';
  const summary = callSummary(item, argumentSummary(item.arguments));
  // A metadata tool carries no statement. Show one the operator could run
  // for the same answer, and say that is what it is.
  const equivalent = item.sql === null ? equivalentSql(item.tool, item.arguments) : null;
  const table = item.table !== null && item.table.columns.length > 0 ? item.table : null;
  // A change the operator approved and that then failed is theirs to know about.
  const failed = item.status === 'error' && item.approval?.decision === 'accept';

  return (
    <div data-tool={item.tool} data-status={item.status}>
      <button
        type="button"
        aria-expanded={open}
        className="flex h-6 w-full items-center gap-2 rounded px-1 text-left hover:bg-surface-sunken"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <span className="shrink-0">
          {item.status === 'running' ? (
            waiting ? (
              <Warning className="text-warn" />
            ) : (
              <Spinner className="text-ink-muted" />
            )
          ) : item.status === 'error' ? (
            <ErrorMark className="text-ink-muted" />
          ) : (
            <Check className="text-ok" />
          )}
        </span>
        <span className="shrink-0">{toolTitle(item.tool)}</span>
        {item.agent !== null && (
          <span
            className="shrink-0 rounded-full border border-line px-1.5 text-[11px] text-ink-muted"
            title={`Run by the subagent ${item.agent}`}
          >
            {item.agent}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
          {summary}
        </span>
        {table && item.status === 'done' && (
          <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
            {formatRowCount(table.totalRows)}
          </span>
        )}
        {item.elapsedMs !== null && (
          <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
            {formatElapsed(item.elapsedMs)}
          </span>
        )}
      </button>

      {/* A prompt is never folded away: the engine waits on it. */}
      {item.approval && (waiting || open) && (
        <div className="my-1 overflow-hidden rounded-lg border border-line">
          <ApprovalCard approval={item.approval} onAnswer={onAnswer} />
        </div>
      )}

      {open && (
        <div className="my-1 overflow-hidden rounded-lg border border-line bg-surface [&>:first-child]:border-t-0">
          {item.sql !== null && (
            <SqlBlock
              sql={item.sql}
              onOpen={() => {
                onOpenInEditor(item.sql ?? '');
              }}
            />
          )}
          {equivalent !== null && (
            <SqlBlock
              label="Equivalent SQL"
              sql={equivalent}
              onOpen={() => {
                onOpenInEditor(equivalent);
              }}
            />
          )}
          {item.status === 'running' ? (
            <div className="border-t border-line px-2 py-1 text-ink-muted">Running</div>
          ) : failed ? (
            <pre className="selectable m-0 border-t border-line px-2 py-1 font-mono text-[12px] break-words whitespace-pre-wrap text-danger">
              {item.text.trim() || 'This did not complete.'}
            </pre>
          ) : item.status === 'error' ? null : table && table.rows.length > 0 ? (
            <div className="border-t border-line">
              <DataTable
                columns={table.columns}
                rows={sortRows(table.rows, sort)}
                sort={sort}
                onSort={(column) => {
                  setSort((current) => nextSort(current, column));
                }}
                visibleRows={6}
              />
            </div>
          ) : (
            <pre className="selectable m-0 max-h-60 overflow-auto border-t border-line px-2 py-1 font-mono text-[12px] break-words whitespace-pre-wrap">
              {table ? 'No rows.' : item.text.trim() || '(no output)'}
            </pre>
          )}

          {item.engineNotes.length > 0 && (
            <div className="border-t border-line px-2 py-1 text-ink-muted">
              <div>
                A provider answered a call with this while the statement ran. The assistant was
                given the result above and not this message.
              </div>
              {item.engineNotes.map((note, index) => (
                <div key={index} className="selectable truncate font-mono text-[12px]" title={note}>
                  {note}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
      <div className="bg-surface px-2 py-1 text-ink-muted" role="status">
        {DECIDED[decision]}
      </div>
    );
  }

  return (
    <div className="bg-warn/10 px-2 py-2" role="alertdialog" aria-label="Approval needed">
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
