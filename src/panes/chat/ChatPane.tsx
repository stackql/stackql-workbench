import { useEffect, useRef, useState, type Ref } from 'react';
import type { AgentConfig, SafetyMode } from '../../host/types';
import {
  SAFETY_MODES,
  chatProgress,
  chatTitle,
  looksLikeSql,
  modeDescription,
  pendingApprovals,
  splitFences,
  type ChatItem,
  type ChatState,
  type ToolItem,
} from '../../lib/chat';
import { IconButton } from '../../ui/IconButton';
import {
  ArrowUp,
  Bot,
  ErrorMark,
  NewChat,
  OpenInEditor,
  Shield,
  Spinner,
  Stop,
  Warning,
} from '../../ui/icons';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

const BACKEND_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  openai_compatible: 'OpenAI-compatible',
  github_copilot: 'GitHub Copilot',
};

/** Things to ask that need no credentials, to get a first conversation going. */
const SUGGESTIONS = [
  'Which providers are installed?',
  'What providers can I install from the registry?',
  'What can I query in the github provider?',
];

interface ChatPaneProps {
  /** Null until the configuration has been read. */
  config: AgentConfig | null;
  chat: ChatState;
  engineRunning: boolean;
  /** Returns false when the message was not sent, so what was typed is kept. */
  onSend: (text: string) => boolean;
  onStop: () => void;
  onReset: () => void;
  onAnswer: (approvalId: string, decision: 'accept' | 'decline') => void;
  onSafetyMode: (mode: SafetyMode) => void;
  onOpenInEditor: (sql: string) => void;
  onShowTable: (item: ToolItem) => void;
  onOpenModelSettings: () => void;
}

/** The conversation with the assistant. This is the app's main view. */
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
  onOpenModelSettings,
}: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const waiting = pendingApprovals(chat).length > 0;
  const empty = chat.items.length === 0;
  const progress = chatProgress(chat);

  // Keep the newest text in view as the turn progresses.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [progress, waiting]);

  const send = () => {
    if (chat.busy || !engineRunning || draft.trim() === '') {
      return;
    }
    if (onSend(draft)) {
      setDraft('');
    }
  };

  const composer = (
    <Composer
      ref={input}
      config={config}
      draft={draft}
      busy={chat.busy}
      waiting={waiting}
      engineRunning={engineRunning}
      onDraft={setDraft}
      onSend={send}
      onStop={onStop}
      onSafetyMode={onSafetyMode}
      onOpenModelSettings={onOpenModelSettings}
    />
  );

  if (empty) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-auto px-6 py-8">
        <div className="w-full max-w-[720px]">
          <h1 className="m-0 text-[26px] font-light text-ink">What do you want to query?</h1>
          <p className="mt-1 mb-4 text-ink-muted">
            Ask about your cloud and SaaS providers in plain language. The assistant works through
            the engine and shows every statement it runs as SQL.
          </p>
          {composer}
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="h-7 rounded-full border border-line bg-surface px-3 text-ink-muted hover:bg-surface-sunken hover:text-ink"
                onClick={() => {
                  setDraft(suggestion);
                  input.current?.focus();
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-4">
        <span className="min-w-0 flex-1 truncate text-center text-ink-muted">
          {chatTitle(chat, 80)}
        </span>
        <IconButton label="New chat" disabled={chat.busy} onClick={onReset}>
          <NewChat />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto" role="log" aria-label="Conversation">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 px-6 py-3">
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
            <div className="flex items-center gap-2 text-ink-muted">
              <Spinner /> Working
            </div>
          )}
          <div ref={end} />
        </div>
      </div>

      <div className="shrink-0 px-6 pt-1 pb-4">
        <div className="mx-auto w-full max-w-[860px]">{composer}</div>
      </div>
    </div>
  );
}

interface ComposerProps {
  ref: Ref<HTMLTextAreaElement>;
  config: AgentConfig | null;
  draft: string;
  busy: boolean;
  /** An approval prompt is open. */
  waiting: boolean;
  engineRunning: boolean;
  onDraft: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  onSafetyMode: (mode: SafetyMode) => void;
  onOpenModelSettings: () => void;
}

/** Where the operator types, with the model and the safety mode under it. */
function Composer({
  ref,
  config,
  draft,
  busy,
  waiting,
  engineRunning,
  onDraft,
  onSend,
  onStop,
  onSafetyMode,
  onOpenModelSettings,
}: ComposerProps) {
  const inference = config?.inference ?? null;
  const option = config?.backends.find((b) => b.kind === inference?.kind);
  const delegated = option?.delegated ?? false;
  const model = inference?.model || option?.defaultModel || '';
  const mode = config?.safetyMode ?? 'safe';
  const backend = inference
    ? [BACKEND_LABEL[inference.kind] ?? inference.kind, model].filter(Boolean).join(', ')
    : 'Set up a model';

  return (
    <div>
      {waiting && (
        <div className="mb-1 flex items-center gap-1.5 text-warn">
          <Warning /> Waiting for your decision above.
        </div>
      )}
      <div className="rounded-2xl border border-line bg-surface shadow-sm focus-within:border-accent">
        <textarea
          ref={ref}
          aria-label="Message"
          rows={2}
          className="selectable block min-h-[56px] w-full resize-none rounded-2xl bg-transparent px-4 pt-3 pb-1 outline-none"
          placeholder={engineRunning ? 'Ask about your providers' : 'The engine is not running.'}
          value={draft}
          disabled={!engineRunning}
          onChange={(event) => {
            onDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <button
            type="button"
            className={`flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 hover:bg-surface-sunken ${
              inference ? 'text-ink-muted' : 'text-accent'
            }`}
            title={
              inference
                ? 'The model backend. Click to change it.'
                : 'No model backend is set up. Click to choose one.'
            }
            onClick={onOpenModelSettings}
          >
            <Bot className="shrink-0" />
            <span className="truncate">{backend}</span>
          </button>
          <label
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-ink-muted hover:bg-surface-sunken"
            title={modeDescription(mode, delegated)}
          >
            <Shield className="shrink-0" />
            <select
              aria-label="Safety mode"
              className="h-6 cursor-pointer bg-transparent text-ink-muted outline-none"
              value={mode}
              disabled={busy || config === null}
              onChange={(event) => {
                onSafetyMode(event.target.value as SafetyMode);
              }}
            >
              {SAFETY_MODES.map((entry) => (
                <option key={entry.mode} value={entry.mode}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <span className="flex-1" />
          {busy ? (
            <button
              type="button"
              aria-label="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface hover:bg-surface-sunken"
              title="Stops the turn. A statement the engine has already started is not interrupted."
              onClick={onStop}
            >
              <Stop />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand hover:bg-brand-dark disabled:opacity-40"
              disabled={!engineRunning || draft.trim() === ''}
              title="Send"
              onClick={onSend}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-start gap-3 px-2 text-[12px] text-ink-muted">
        <span className="min-w-0 flex-1" data-testid="mode-helper">
          {modeDescription(mode, delegated)}
        </span>
        <span className="shrink-0">Enter to send, Shift+Enter for a new line</span>
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
        <div className="selectable ml-12 self-end rounded-2xl bg-surface-sunken px-3.5 py-2 break-words whitespace-pre-wrap">
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
      const label = mode?.label ?? item.mode;
      return (
        <div className="text-[11px] text-ink-muted">
          {item.agent
            ? `${item.agent} started on the engine in ${label} mode with ${item.tools} engine tools and no others${
                item.model ? `. Model: ${item.model}` : ''
              }.`
            : `Engine session opened in ${label} mode, ${item.tools} tools.`}
        </div>
      );
    }
    case 'notice':
      return (
        <div
          className={`selectable flex items-start gap-1.5 ${
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
    <div className="flex flex-col gap-1.5">
      {splitFences(text).map((segment, index) =>
        segment.kind === 'text' ? (
          <Markdown key={index} text={segment.text} />
        ) : (
          <div key={index} className="relative rounded-lg border border-line bg-surface">
            <pre className="selectable m-0 max-h-60 overflow-auto py-2 pr-8 pl-3 font-mono text-[12px] break-words whitespace-pre-wrap">
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
