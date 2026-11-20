import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  host,
  toHostError,
  type AgentConfig,
  type AgentEvent,
  type AgentTable,
  type ApprovalDecision,
  type HostError,
  type SafetyMode,
  type TurnSummary,
} from '../host';
import {
  applyAgentEvent,
  approvalAnswered,
  emptyChat,
  turnFailed,
  turnFinished,
  userSent,
  type ChatState,
} from '../lib/chat';

type Action =
  | { type: 'sent'; text: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'answered'; id: string; decision: ApprovalDecision }
  | { type: 'finished'; summary: TurnSummary }
  | { type: 'failed'; error: HostError }
  | { type: 'reset' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'sent':
      return userSent(state, action.text);
    case 'event':
      return applyAgentEvent(state, action.event);
    case 'answered':
      return approvalAnswered(state, action.id, action.decision);
    case 'finished':
      return turnFinished(state, action.summary);
    case 'failed':
      return turnFailed(state, action.error);
    case 'reset':
      return emptyChat;
  }
}

/** A row result the assistant produced, with the statement behind it. */
export interface AgentResult {
  callId: string;
  tool: string;
  sql: string | null;
  table: AgentTable;
  engineNotes: string[];
  elapsedMs: number;
}

export interface Agent {
  /** Null until the first read. `inference` is null when chat is not configured. */
  config: AgentConfig | null;
  setConfig: (config: AgentConfig) => void;
  chat: ChatState;
  send: (text: string) => void;
  /** Stops the running turn. A statement already started is not interrupted. */
  stop: () => void;
  answer: (approvalId: string, decision: 'accept' | 'decline') => void;
  /** Starts a new conversation. */
  reset: () => void;
  setSafetyMode: (mode: SafetyMode) => void;
  /** Counts turns that have ended, so other panes know when to refresh. */
  turnsEnded: number;
}

/** The chat: configuration, conversation and the calls that drive a turn. */
export function useAgent(onResult: (result: AgentResult) => void): Agent {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [chat, dispatch] = useReducer(reducer, emptyChat);
  const [turnsEnded, setTurnsEnded] = useState(0);
  const onResultRef = useRef(onResult);
  // What each running tool call is, so a result can be shown with its SQL.
  const calls = useRef(new Map<string, { tool: string; sql: string | null }>());

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let active = true;
    host.agent.config().then(
      (loaded) => {
        if (active) {
          setConfig(loaded);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  const send = useCallback((text: string) => {
    const message = text.trim();
    if (message === '') {
      return;
    }
    dispatch({ type: 'sent', text: message });
    host.agent
      .send(message, (event) => {
        dispatch({ type: 'event', event });
        if (event.event === 'toolCallStarted') {
          calls.current.set(event.data.id, { tool: event.data.tool, sql: event.data.sql });
        } else if (event.event === 'toolCallFinished') {
          const call = calls.current.get(event.data.id);
          calls.current.delete(event.data.id);
          if (event.data.table && !event.data.isError) {
            onResultRef.current({
              callId: event.data.id,
              tool: call?.tool ?? '',
              sql: call?.sql ?? null,
              table: event.data.table,
              engineNotes: event.data.engineNotes,
              elapsedMs: event.data.elapsedMs,
            });
          }
        }
      })
      .then(
        (summary) => {
          dispatch({ type: 'finished', summary });
        },
        (error: unknown) => {
          dispatch({ type: 'failed', error: toHostError(error) });
        },
      )
      .finally(() => {
        calls.current.clear();
        setTurnsEnded((count) => count + 1);
      });
  }, []);

  const stop = useCallback(() => {
    void host.agent.stop().catch(() => undefined);
  }, []);

  const answer = useCallback((approvalId: string, decision: 'accept' | 'decline') => {
    // Shown at once. If the host no longer knows the prompt, the tool call
    // ends as dismissed and the card follows.
    dispatch({ type: 'answered', id: approvalId, decision });
    void host.agent.approve(approvalId, decision).catch(() => undefined);
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
    void host.agent.reset().catch(() => undefined);
  }, []);

  const setSafetyMode = useCallback((mode: SafetyMode) => {
    setConfig((current) => (current ? { ...current, safetyMode: mode } : current));
    host.agent.setSafetyMode(mode).then(
      (saved) => {
        setConfig((current) => (current ? { ...current, safetyMode: saved } : current));
      },
      () => undefined,
    );
  }, []);

  return { config, setConfig, chat, send, stop, answer, reset, setSafetyMode, turnsEnded };
}
