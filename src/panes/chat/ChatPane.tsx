import { useEffect, useRef, useState } from 'react';
import type { AgentConfig, SafetyMode } from '../../host/types';
import {
  SAFETY_MODES,
  looksLikeSql,
  pendingApprovals,
  splitFences,
  type ChatItem,
  type ChatState,
  type ToolItem,
} from '../../lib/chat';
import { IconButton } from '../../ui/IconButton';
import { ErrorMark, OpenInEditor, Send, Spinner, Stop, Trash, Warning } from '../../ui/icons';
import { ToolCard } from './ToolCard';

const BACKEND_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  openai_compatible: 'OpenAI-compatible',
};

interface ChatPaneProps {
  config: AgentConfig;
  chat: ChatState;
  engineRunning: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onReset: () => void;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
  onSafetyMode: (mode: SafetyMode) => void;
  onOpenInEditor: (sql: string) => void;
  onShowTable: (item: ToolItem) => void;
}

/** The conversation with the assistant. */
export function ChatPane({
  config,
  chat,
  engineRunning,
  onSend,
  onStop,
  onReset,
  onAnswer,
  onSafetyMode,
  onOpenInEditor,
  onShowTable,
}: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const waiting = pendingApprovals(chat).length > 0;
  const mode = SAFETY_MODES.find((m) => m.mode === config.safetyMode);
  const inference = config.inference;
  const model =
    inference?.model || config.backends.find((b) => b.kind === inference?.kind)?.defaultModel || '';

  // Keep the newest item in view as the turn progresses.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.items.length, waiting]);

  const send = () => {
    if (chat.busy || !engineRunning || draft.trim() === '') {
      return;
    }
    onSend(draft);
    setDraft('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-alt">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="min-w-0 truncate text-ink-muted" title="Inference backend and model">
          {inference ? `${BACKEND_LABEL[inference.kind] ?? inference.kind} · ${model}` : ''}
        </span>
        <span className="flex-1" />
        <label className="flex shrink-0 items-center gap-1 text-ink-muted">
          Safety
          <select
            aria-label="Safety mode"
            className="h-6 rounded border border-line bg-surface px-1 text-ink"
            value={config.safetyMode}
            disabled={chat.busy}
            title={mode?.description}
            onChange={(event) => {
              onSafetyMode(event.target.value as SafetyMode);
            }}
          >
            {SAFETY_MODES.map((option) => (
              <option key={option.mode} value={option.mode} title={option.description}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <IconButton label="New conversation" disabled={chat.busy} onClick={onReset}>
          <Trash />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2" role="log" aria-label="Conversation">
        {chat.items.length === 0 ? (
          <div className="px-1 text-ink-muted">
            <p className="mb-2">
              Ask about your providers in plain language. The assistant works through the engine and
              shows every statement it runs as SQL.
            </p>
            <p className="mb-1">{mode ? `${mode.label} mode: ${mode.description}` : ''}</p>
            <p>The engine decides what needs your approval. Nothing is approved for you.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {chat.items.map((item) => (
              <Item
                key={item.key}
                item={item}
                onOpenInEditor={onOpenInEditor}
                onShowTable={onShowTable}
                onAnswer={onAnswer}
              />
            ))}
            {chat.busy && !waiting && (
              <div className="flex items-center gap-2 px-1 text-ink-muted">
                <Spinner /> Working
              </div>
            )}
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="shrink-0 border-t border-line p-2">
        {waiting && (
          <div className="mb-1 flex items-center gap-1.5 text-warn">
            <Warning /> Waiting for your decision above.
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Message"
            rows={2}
            className="selectable min-h-[44px] flex-1 resize-none rounded border border-line bg-surface px-2 py-1.5"
            placeholder={
              engineRunning
                ? 'Ask the assistant. Enter sends, Shift+Enter adds a line.'
                : 'The engine is not running.'
            }
            value={draft}
            disabled={!engineRunning}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          {chat.busy ? (
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-1 rounded border border-line bg-surface px-3 hover:bg-surface-sunken"
              title="Stops the turn. A statement the engine has already started is not interrupted."
              onClick={onStop}
            >
              <Stop /> Stop
            </button>
          ) : (
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-1 rounded bg-brand px-3 font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
              disabled={!engineRunning || draft.trim() === ''}
              onClick={send}
            >
              <Send /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ItemProps {
  item: ChatItem;
  onOpenInEditor: (sql: string) => void;
  onShowTable: (item: ToolItem) => void;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
}

function Item({ item, onOpenInEditor, onShowTable, onAnswer }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="selectable ml-6 self-end rounded bg-brand px-2.5 py-1.5 break-words whitespace-pre-wrap text-on-brand">
          {item.text}
        </div>
      );
    case 'assistant':
      return <AssistantText text={item.text} onOpenInEditor={onOpenInEditor} />;
    case 'tool':
      return (
        <ToolCard
          item={item}
          onOpenInEditor={onOpenInEditor}
          onShowTable={onShowTable}
          onAnswer={onAnswer}
        />
      );
    case 'session': {
      const mode = SAFETY_MODES.find((m) => m.mode === item.mode);
      return (
        <div className="px-1 text-[11px] text-ink-muted">
          Engine session opened in {mode?.label ?? item.mode} mode, {item.tools} tools.
        </div>
      );
    }
    case 'notice':
      return (
        <div
          className={`selectable flex items-start gap-1.5 px-1 ${
            item.tone === 'error'
              ? 'text-danger'
              : item.tone === 'warn'
                ? 'text-warn'
                : 'text-ink-muted'
          }`}
        >
          {item.tone === 'error' ? (
            <ErrorMark className="mt-0.5 shrink-0" />
          ) : (
            <Warning className="mt-0.5 shrink-0" />
          )}
          <span className="break-words whitespace-pre-wrap">{item.text}</span>
        </div>
      );
  }
}

/** Assistant text, with fenced code shown as code and SQL offered to the editor. */
function AssistantText({
  text,
  onOpenInEditor,
}: {
  text: string;
  onOpenInEditor: (sql: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-1">
      {splitFences(text).map((segment, index) =>
        segment.kind === 'text' ? (
          <div key={index} className="selectable break-words whitespace-pre-wrap">
            {segment.text}
          </div>
        ) : (
          <div key={index} className="relative rounded border border-line bg-surface">
            <pre className="selectable m-0 max-h-60 overflow-auto py-1.5 pr-8 pl-2 font-mono text-[12px] break-words whitespace-pre-wrap">
              {segment.code}
            </pre>
            {looksLikeSql(segment) && (
              <div className="absolute top-0.5 right-0.5">
                <IconButton
                  label="Open in editor"
                  onClick={() => {
                    onOpenInEditor(segment.code);
                  }}
                >
                  <OpenInEditor />
                </IconButton>
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
