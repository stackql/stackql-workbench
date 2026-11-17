// The state of the chat pane, built from the events the host streams during
// a turn. Pure functions, so the mapping can be tested without a host.

import type {
  AgentEvent,
  AgentTable,
  ApprovalDecision,
  ApprovalRequest,
  HostError,
  SafetyMode,
  TurnSummary,
} from '../host/types';

export interface ApprovalState {
  request: ApprovalRequest;
  /** `pending` until the operator answers. */
  decision: 'pending' | ApprovalDecision;
}

export interface ToolItem {
  kind: 'tool';
  key: string;
  callId: string;
  tool: string;
  /** The statement, when the tool takes one. Always shown as SQL. */
  sql: string | null;
  arguments: unknown;
  status: 'running' | 'done' | 'error';
  text: string;
  table: AgentTable | null;
  /** Provider API failures the engine reported while the tool ran. */
  engineNotes: string[];
  elapsedMs: number | null;
  approval: ApprovalState | null;
}

export type ChatItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | ToolItem
  | { kind: 'notice'; key: string; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'session'; key: string; mode: SafetyMode; protocolVersion: string; tools: number };

export interface ChatState {
  items: ChatItem[];
  /** A turn is running. */
  busy: boolean;
  /** Counter for item keys. */
  next: number;
}

export const emptyChat: ChatState = { items: [], busy: false, next: 0 };

function push(state: ChatState, build: (key: string) => ChatItem): ChatState {
  return {
    ...state,
    items: [...state.items, build(`item-${state.next}`)],
    next: state.next + 1,
  };
}

function mapTools(state: ChatState, change: (item: ToolItem) => ToolItem): ChatState {
  return {
    ...state,
    items: state.items.map((item) => (item.kind === 'tool' ? change(item) : item)),
  };
}

/** The operator sent a message, which starts a turn. */
export function userSent(state: ChatState, text: string): ChatState {
  return { ...push(state, (key) => ({ kind: 'user', key, text })), busy: true };
}

/** Applies one host event. */
export function applyAgentEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.event) {
    case 'sessionStarted':
      return push(state, (key) => ({ kind: 'session', key, ...event.data }));
    case 'assistantText':
      return push(state, (key) => ({ kind: 'assistant', key, text: event.data.text }));
    case 'toolCallStarted':
      return push(state, (key) => ({
        kind: 'tool',
        key,
        callId: event.data.id,
        tool: event.data.tool,
        sql: event.data.sql,
        arguments: event.data.arguments,
        status: 'running',
        text: '',
        table: null,
        engineNotes: [],
        elapsedMs: null,
        approval: null,
      }));
    case 'approvalRequested': {
      // The engine asks while the tool call it gates is running. Tools run
      // one at a time, so that is the one still marked running.
      const target = [...state.items]
        .reverse()
        .find((item): item is ToolItem => item.kind === 'tool' && item.status === 'running');
      if (!target) {
        // Nothing to attach it to. It still has to be answerable.
        return push(state, (key) => ({
          kind: 'tool',
          key,
          callId: event.data.request.id,
          tool: event.data.request.tool ?? 'approval',
          sql: event.data.request.sql,
          arguments: {},
          status: 'running',
          text: '',
          table: null,
          engineNotes: [],
          elapsedMs: null,
          approval: { request: event.data.request, decision: 'pending' },
        }));
      }
      return mapTools(state, (item) =>
        item.key === target.key
          ? { ...item, approval: { request: event.data.request, decision: 'pending' } }
          : item,
      );
    }
    case 'toolCallFinished':
      return mapTools(state, (item) =>
        item.callId === event.data.id && item.status === 'running'
          ? {
              ...item,
              status: event.data.isError ? 'error' : 'done',
              text: event.data.text,
              table: event.data.table,
              engineNotes: event.data.engineNotes,
              elapsedMs: event.data.elapsedMs,
              // A prompt that was still open when the call ended was dismissed.
              approval:
                item.approval?.decision === 'pending'
                  ? { ...item.approval, decision: 'cancel' }
                  : item.approval,
            }
          : item,
      );
    case 'notice':
      return push(state, (key) => ({
        kind: 'notice',
        key,
        text: event.data.message,
        tone: 'warn',
      }));
  }
}

/** The operator answered an approval prompt. */
export function approvalAnswered(
  state: ChatState,
  approvalId: string,
  decision: ApprovalDecision,
): ChatState {
  return mapTools(state, (item) =>
    item.approval?.request.id === approvalId && item.approval.decision === 'pending'
      ? { ...item, approval: { ...item.approval, decision } }
      : item,
  );
}

function settle(state: ChatState): ChatState {
  // Anything still marked running when the turn ends did not finish.
  return mapTools({ ...state, busy: false }, (item) =>
    item.status === 'running'
      ? {
          ...item,
          status: 'error',
          text: item.text || 'This did not finish.',
          approval:
            item.approval?.decision === 'pending'
              ? { ...item.approval, decision: 'cancel' }
              : item.approval,
        }
      : item,
  );
}

/** The turn ended. */
export function turnFinished(state: ChatState, summary: TurnSummary): ChatState {
  let next = settle(state);
  if (summary.stopped) {
    next = push(next, (key) => ({
      kind: 'notice',
      key,
      tone: 'warn',
      text: 'Stopped. A statement the engine had already started may still complete.',
    }));
  } else if (summary.stop.kind === 'refused') {
    const detail = summary.stop.detail;
    next = push(next, (key) => ({ kind: 'notice', key, tone: 'warn', text: detail }));
  } else if (summary.stop.kind === 'maxTokens') {
    next = push(next, (key) => ({
      kind: 'notice',
      key,
      tone: 'warn',
      text: 'The reply was cut off by the output limit. Ask it to continue.',
    }));
  }
  return next;
}

/** The turn failed before it could finish, for example a rejected API key. */
export function turnFailed(state: ChatState, error: HostError): ChatState {
  return push(settle(state), (key) => ({
    kind: 'notice',
    key,
    tone: 'error',
    text: error.message,
  }));
}

/** The approval prompts that are waiting for an answer. */
export function pendingApprovals(state: ChatState): ApprovalRequest[] {
  return state.items.flatMap((item) =>
    item.kind === 'tool' && item.approval?.decision === 'pending' ? [item.approval.request] : [],
  );
}

export type Segment =
  { kind: 'text'; text: string } | { kind: 'code'; language: string; code: string };

/**
 * Splits assistant text into prose and fenced code blocks, so that SQL the
 * model proposes can be shown as code and opened in the editor.
 */
export function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(last, match.index);
    if (before.trim() !== '') {
      segments.push({ kind: 'text', text: before.trim() });
    }
    segments.push({ kind: 'code', language: (match[1] ?? '').toLowerCase(), code: match[2] ?? '' });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim() !== '') {
    segments.push({ kind: 'text', text: rest.trim() });
  }
  return segments;
}

/** True for a code block worth offering to the editor. */
export function looksLikeSql(segment: Segment): boolean {
  if (segment.kind !== 'code') {
    return false;
  }
  if (segment.language === 'sql' || segment.language === 'iql' || segment.language === 'stackql') {
    return true;
  }
  return (
    segment.language === '' &&
    /^\s*(select|insert|update|delete|replace|exec|show|describe|registry|with)\b/i.test(
      segment.code,
    )
  );
}

const TOOL_TITLES: Record<string, string> = {
  server_info: 'Server info',
  list_providers: 'List providers',
  list_services: 'List services',
  list_resources: 'List resources',
  list_methods: 'List methods',
  describe_method: 'Describe method',
  validate_select_query: 'Validate query',
  run_select_query: 'Run query',
  run_mutation_query: 'Run mutation',
  run_lifecycle_operation: 'Run lifecycle operation',
  list_registry: 'List registry',
  pull_provider: 'Install provider',
  reload_credentials: 'Reload credentials',
  query_library_search: 'Search query library',
  query_library_get: 'Get query library entry',
};

export function toolTitle(tool: string): string {
  return TOOL_TITLES[tool] ?? tool;
}

/** A one-line summary of a tool's arguments, for tools that take no SQL. */
export function argumentSummary(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }
  return Object.entries(args as Record<string, unknown>)
    .filter(([key, value]) => key !== 'sql' && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

export const SAFETY_MODES: { mode: SafetyMode; label: string; description: string }[] = [
  {
    mode: 'read_only',
    label: 'Read only',
    description: 'Queries only. Every change is refused.',
  },
  {
    mode: 'safe',
    label: 'Safe',
    description: 'Queries run. Every change asks you first.',
  },
  {
    mode: 'delete_safe',
    label: 'Delete safe',
    description: 'Inserts and updates run. Deletes and lifecycle operations ask you first.',
  },
  {
    mode: 'full_access',
    label: 'Full access',
    description: 'Everything runs without asking.',
  },
];
