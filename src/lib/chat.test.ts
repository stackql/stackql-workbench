import { describe, expect, it } from 'vitest';
import type { AgentEvent, ApprovalRequest, TurnSummary } from '../host/types';
import {
  applyAgentEvent,
  approvalAnswered,
  argumentSummary,
  chatProgress,
  chatTitle,
  emptyChat,
  looksLikeSql,
  modeDescription,
  pendingApprovals,
  splitFences,
  toolTitle,
  turnFailed,
  turnFinished,
  userSent,
  type ChatState,
  type ToolItem,
} from './chat';

const DELETE_SQL = "DELETE FROM github.repos.repos WHERE owner = 'x' AND repo = 'y'";

const request: ApprovalRequest = {
  id: 'approval-1',
  message: `Approve run_mutation_query (mutation_delete)?\n\nSQL: ${DELETE_SQL}`,
  tool: 'run_mutation_query',
  queryClass: 'mutation_delete',
  sql: DELETE_SQL,
};

const summary = (over: Partial<TurnSummary> = {}): TurnSummary => ({
  steps: 2,
  toolCalls: 1,
  stopped: false,
  stop: { kind: 'endTurn' },
  usage: { inputTokens: 100, outputTokens: 10 },
  ...over,
});

function play(events: AgentEvent[], from: ChatState = userSent(emptyChat, 'hello')): ChatState {
  return events.reduce(applyAgentEvent, from);
}

const started = (id: string, tool: string, sql: string | null): AgentEvent => ({
  event: 'toolCallStarted',
  data: { id, tool, arguments: sql ? { sql } : {}, sql },
});

const finished = (id: string, isError = false, text = 'ok'): AgentEvent => ({
  event: 'toolCallFinished',
  data: { id, isError, text, table: null, engineNotes: [], elapsedMs: 12 },
});

function tools(state: ChatState): ToolItem[] {
  return state.items.filter((item): item is ToolItem => item.kind === 'tool');
}

describe('a turn', () => {
  it('starts busy with the operator message', () => {
    const state = userSent(emptyChat, 'what is installed?');
    expect(state.busy).toBe(true);
    expect(state.items).toEqual([{ kind: 'user', key: 'item-0', text: 'what is installed?' }]);
  });

  it('shows a tool call with its SQL, then its result', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT 1'),
      {
        event: 'toolCallFinished',
        data: {
          id: 'c1',
          isError: false,
          text: '| one |',
          table: { columns: ['one'], rows: [['1']], totalRows: 1, truncated: false },
          engineNotes: [],
          elapsedMs: 30,
        },
      },
      { event: 'assistantText', data: { text: 'It is 1.' } },
    ]);
    const [tool] = tools(state);
    expect(tool).toMatchObject({
      tool: 'run_select_query',
      sql: 'SELECT 1',
      status: 'done',
      elapsedMs: 30,
    });
    expect(tool?.table?.rows).toEqual([['1']]);
    expect(state.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'It is 1.' });
  });

  it('gives every item a distinct key', () => {
    const state = play([
      { event: 'sessionStarted', data: { mode: 'safe', protocolVersion: '2025-11-25', tools: 15 } },
      started('c1', 'list_providers', null),
      finished('c1'),
      { event: 'assistantText', data: { text: 'done' } },
    ]);
    const keys = state.items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks a failed tool call and keeps engine notes', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT x'),
      {
        event: 'toolCallFinished',
        data: {
          id: 'c1',
          isError: false,
          text: '**no results**',
          table: { columns: [], rows: [], totalRows: 0, truncated: false },
          engineNotes: ['http response status code: 404'],
          elapsedMs: 900,
        },
      },
      started('c2', 'list_services', null),
      finished('c2', true, 'no provider document'),
    ]);
    const [first, second] = tools(state);
    expect(first?.engineNotes).toEqual(['http response status code: 404']);
    expect(second).toMatchObject({ status: 'error', text: 'no provider document' });
  });
});

describe('approval', () => {
  const asked = play([
    started('c1', 'run_mutation_query', DELETE_SQL),
    { event: 'approvalRequested', data: { request } },
  ]);

  it('attaches the prompt to the tool call that is waiting on it', () => {
    const [tool] = tools(asked);
    expect(tool?.approval).toEqual({ request, decision: 'pending' });
    expect(tool?.status).toBe('running');
    expect(pendingApprovals(asked)).toEqual([request]);
  });

  it('records the operator answer and stops listing the prompt as pending', () => {
    const answered = approvalAnswered(asked, 'approval-1', 'decline');
    expect(tools(answered)[0]?.approval?.decision).toBe('decline');
    expect(pendingApprovals(answered)).toEqual([]);
  });

  it('does not change an answer once given', () => {
    const declined = approvalAnswered(asked, 'approval-1', 'decline');
    const again = approvalAnswered(declined, 'approval-1', 'accept');
    expect(tools(again)[0]?.approval?.decision).toBe('decline');
  });

  it('ignores an answer for an unknown prompt', () => {
    expect(approvalAnswered(asked, 'approval-99', 'accept')).toEqual(asked);
  });

  it('treats a prompt still open when the call ends as dismissed', () => {
    const ended = applyAgentEvent(asked, finished('c1', true, 'approval prompt was dismissed'));
    expect(tools(ended)[0]?.approval?.decision).toBe('cancel');
    expect(pendingApprovals(ended)).toEqual([]);
  });

  it('never loses a prompt that arrives with no tool call running', () => {
    const state = play([{ event: 'approvalRequested', data: { request } }]);
    expect(pendingApprovals(state)).toEqual([request]);
    expect(tools(state)[0]?.sql).toBe(DELETE_SQL);
  });

  it('attaches to the running call, not an earlier finished one', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT 1'),
      finished('c1'),
      started('c2', 'run_mutation_query', DELETE_SQL),
      { event: 'approvalRequested', data: { request } },
    ]);
    const [first, second] = tools(state);
    expect(first?.approval).toBeNull();
    expect(second?.approval?.decision).toBe('pending');
  });
});

describe('approval while several calls run', () => {
  const OTHER_SQL = "DELETE FROM github.repos.repos WHERE owner = 'x' AND repo = 'z'";
  const ask = (id: string, sql: string): AgentEvent => ({
    event: 'approvalRequested',
    data: { request: { ...request, id, sql, message: `Approve?\n\nSQL: ${sql}` } },
  });

  it('goes to the call that sent the statement, not to the newest one', () => {
    const state = play([
      started('c1', 'run_mutation_query', DELETE_SQL),
      started('c2', 'run_mutation_query', OTHER_SQL),
      started('c3', 'run_select_query', 'SELECT 1'),
      ask('approval-1', DELETE_SQL),
    ]);
    const [first, second, third] = tools(state);
    expect(first?.approval?.request.id).toBe('approval-1');
    expect(second?.approval).toBeNull();
    expect(third?.approval).toBeNull();
  });

  it('gives two calls with the same statement a prompt each', () => {
    const state = play([
      started('c1', 'run_mutation_query', DELETE_SQL),
      started('c2', 'run_mutation_query', DELETE_SQL),
      ask('approval-1', DELETE_SQL),
      ask('approval-2', DELETE_SQL),
    ]);
    const [first, second] = tools(state);
    expect(first?.approval?.request.id).toBe('approval-1');
    expect(second?.approval?.request.id).toBe('approval-2');
    expect(pendingApprovals(state)).toHaveLength(2);
  });

  it('answers each prompt on its own', () => {
    let state = play([
      started('c1', 'run_mutation_query', DELETE_SQL),
      started('c2', 'run_mutation_query', OTHER_SQL),
      ask('approval-1', DELETE_SQL),
      ask('approval-2', OTHER_SQL),
    ]);
    state = approvalAnswered(state, 'approval-2', 'decline');
    const [first, second] = tools(state);
    expect(first?.approval?.decision).toBe('pending');
    expect(second?.approval?.decision).toBe('decline');
  });

  it('falls back to the newest call still waiting when nothing matches', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT 1'),
      started('c2', 'run_select_query', 'SELECT 2'),
      ask('approval-1', 'SELECT something else'),
    ]);
    const [first, second] = tools(state);
    expect(first?.approval).toBeNull();
    expect(second?.approval?.request.id).toBe('approval-1');
  });
});

describe('the end of a turn', () => {
  it('clears busy', () => {
    const state = turnFinished(play([{ event: 'assistantText', data: { text: 'hi' } }]), summary());
    expect(state.busy).toBe(false);
    expect(state.items.at(-1)).toMatchObject({ kind: 'assistant' });
  });

  it('says so when the operator stopped it, and settles what was running', () => {
    const state = turnFinished(
      play([
        started('c1', 'run_mutation_query', DELETE_SQL),
        { event: 'approvalRequested', data: { request } },
      ]),
      summary({ stopped: true }),
    );
    const [tool] = tools(state);
    expect(tool?.status).toBe('error');
    expect(tool?.approval?.decision).toBe('cancel');
    expect(state.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'warn' });
    expect(pendingApprovals(state)).toEqual([]);
  });

  it('reports a refusal and a cut-off reply', () => {
    const refused = turnFinished(
      userSent(emptyChat, 'x'),
      summary({ stop: { kind: 'refused', detail: 'The model declined this request.' } }),
    );
    expect(refused.items.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'The model declined this request.',
    });

    const cut = turnFinished(userSent(emptyChat, 'x'), summary({ stop: { kind: 'maxTokens' } }));
    expect(cut.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'warn' });
  });

  it('shows a failure as an error and clears busy', () => {
    const state = turnFailed(userSent(emptyChat, 'x'), {
      kind: 'agent',
      message: 'The inference provider rejected the API key.',
    });
    expect(state.busy).toBe(false);
    expect(state.items.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'error',
      text: 'The inference provider rejected the API key.',
    });
  });
});

describe('splitFences', () => {
  it('returns plain text as one segment', () => {
    expect(splitFences('Just words.')).toEqual([{ kind: 'text', text: 'Just words.' }]);
  });

  it('separates prose from fenced code', () => {
    const segments = splitFences(
      'Here is the query:\n\n```sql\nSELECT name\nFROM github.repos.repos\n```\n\nIt lists repos.',
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'Here is the query:' },
      { kind: 'code', language: 'sql', code: 'SELECT name\nFROM github.repos.repos' },
      { kind: 'text', text: 'It lists repos.' },
    ]);
  });

  it('handles several blocks and a block with no language', () => {
    const segments = splitFences('```\nSHOW PROVIDERS\n```\nthen\n```json\n{"a":1}\n```');
    expect(segments.map((s) => s.kind)).toEqual(['code', 'text', 'code']);
    expect(segments[0]).toMatchObject({ language: '', code: 'SHOW PROVIDERS' });
    expect(segments[2]).toMatchObject({ language: 'json' });
  });

  it('leaves an unterminated fence as text', () => {
    expect(splitFences('```sql\nSELECT 1')).toEqual([{ kind: 'text', text: '```sql\nSELECT 1' }]);
  });

  it('returns nothing for blank text', () => {
    expect(splitFences('  \n ')).toEqual([]);
  });
});

describe('looksLikeSql', () => {
  it('accepts sql fences and unlabelled statements', () => {
    expect(looksLikeSql({ kind: 'code', language: 'sql', code: 'anything' })).toBe(true);
    expect(looksLikeSql({ kind: 'code', language: '', code: '  select 1' })).toBe(true);
    expect(looksLikeSql({ kind: 'code', language: '', code: 'REGISTRY PULL github' })).toBe(true);
  });

  it('rejects other code and prose', () => {
    expect(looksLikeSql({ kind: 'code', language: 'json', code: '{"select": 1}' })).toBe(false);
    expect(looksLikeSql({ kind: 'code', language: '', code: 'name | version' })).toBe(false);
    expect(looksLikeSql({ kind: 'text', text: 'select 1' })).toBe(false);
  });
});

describe('labels', () => {
  it('names known tools and falls back to the raw name', () => {
    expect(toolTitle('run_mutation_query')).toBe('Run mutation');
    expect(toolTitle('something_new')).toBe('something_new');
  });

  it('summarises arguments without repeating the SQL', () => {
    expect(argumentSummary({ provider: 'github', service: 'repos' })).toBe(
      'provider: github, service: repos',
    );
    expect(argumentSummary({ sql: 'SELECT 1', row_limit: 10 })).toBe('row_limit: 10');
    expect(argumentSummary({})).toBe('');
    expect(argumentSummary(null)).toBe('');
  });
});

describe('a reply that arrives in pieces', () => {
  const delta = (id: string, text: string): AgentEvent => ({
    event: 'assistantDelta',
    data: { id, text },
  });

  it('joins the pieces of one message into one item', () => {
    const state = play([delta('m1', 'Let me '), delta('m1', 'check.')]);
    const replies = state.items.filter((item) => item.kind === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Let me check.' });
  });

  it('starts a new item for a new message', () => {
    const state = play([delta('m1', 'First.'), delta('m2', 'Second.')]);
    const texts = state.items.flatMap((item) => (item.kind === 'assistant' ? [item.text] : []));
    expect(texts).toEqual(['First.', 'Second.']);
  });

  it('finds its message past a tool call that started in between', () => {
    const state = play([
      delta('m1', 'Running '),
      started('c1', 'run_select_query', 'SELECT 1'),
      delta('m1', 'it now.'),
      finished('c1'),
      delta('m2', 'Done.'),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(state.items[1]).toMatchObject({ text: 'Running it now.' });
    expect(state.items[3]).toMatchObject({ text: 'Done.' });
  });

  it('keeps whole replies and pieces apart', () => {
    const state = play([
      { event: 'assistantText', data: { text: 'Whole.' } },
      delta('m1', 'Piece.'),
    ]);
    const texts = state.items.flatMap((item) => (item.kind === 'assistant' ? [item.text] : []));
    expect(texts).toEqual(['Whole.', 'Piece.']);
  });

  it('moves the progress marker with every piece', () => {
    const before = play([delta('m1', 'a')]);
    const after = applyAgentEvent(before, delta('m1', 'b'));
    expect(chatProgress(after)).toBeGreaterThan(chatProgress(before));
    expect(chatProgress(applyAgentEvent(after, delta('m2', 'c')))).toBeGreaterThan(
      chatProgress(after),
    );
  });
});

describe('a delegated agent', () => {
  it('shows what was started, in which mode and with which model', () => {
    const state = play([
      {
        event: 'delegateStarted',
        data: {
          mode: 'safe',
          agent: 'GitHub Copilot CLI',
          version: '1.0.113',
          protocol: 'ACP 1',
          model: 'small',
          tools: 15,
        },
      },
    ]);
    expect(state.items[1]).toMatchObject({
      kind: 'session',
      mode: 'safe',
      tools: 15,
      agent: 'GitHub Copilot CLI',
      agentVersion: '1.0.113',
      agentProtocol: 'ACP 1',
      model: 'small',
    });
  });

  it('says changes are refused where another backend would ask', () => {
    expect(modeDescription('safe', false)).toBe(
      'Queries run. Each change needs your approval before it runs.',
    );
    expect(modeDescription('delete_safe', false)).toBe(
      'Queries and changes run. DELETE and EXEC need your approval.',
    );
    // An API key backend can show the prompt, so nothing says it cannot.
    for (const mode of ['read_only', 'safe', 'delete_safe', 'full_access'] as const) {
      expect(modeDescription(mode, false)).not.toContain('cannot');
    }
    // A delegated agent cannot, so a change is refused and the text says so.
    expect(modeDescription('safe', true)).toContain('refused');
    expect(modeDescription('safe', true)).not.toContain('needs your approval');
    expect(modeDescription('delete_safe', true)).toContain('refused');
    // Where nothing needs approval the two read the same.
    expect(modeDescription('read_only', true)).toBe(modeDescription('read_only', false));
    expect(modeDescription('full_access', true)).toBe(modeDescription('full_access', false));
  });
});

describe('subagents', () => {
  it('marks a call with the subagent that made it', () => {
    const state = play([
      {
        event: 'toolCallStarted',
        data: { id: 't1', tool: 'subagent', arguments: { task: 'Count github repos' }, sql: null },
      },
      {
        event: 'toolCallStarted',
        data: {
          id: 'q1',
          tool: 'run_select_query',
          arguments: { sql: 'SELECT 1' },
          sql: 'SELECT 1',
          agent: 'github-count',
        },
      },
    ]);
    const [task, query] = tools(state);
    expect(task).toMatchObject({ tool: 'subagent', agent: null });
    expect(query).toMatchObject({ tool: 'run_select_query', agent: 'github-count' });
    expect(toolTitle('subagent')).toBe('Subagent');
    expect(argumentSummary(task?.arguments)).toBe('task: Count github repos');
  });

  it('finishes a subagent and its calls each by their own id', () => {
    const state = play([
      started('t1', 'subagent', null),
      { ...started('q1', 'run_select_query', 'SELECT 1') },
      finished('q1'),
      finished('t1', false, 'github has 90 repos.'),
    ]);
    const [task, query] = tools(state);
    expect(query?.status).toBe('done');
    expect(task).toMatchObject({ status: 'done', text: 'github has 90 repos.' });
  });
});

describe('chatTitle', () => {
  it('is null before the first message', () => {
    expect(chatTitle(emptyChat)).toBeNull();
  });

  it('is the start of the first message, on one line', () => {
    const state = userSent(userSent(emptyChat, 'How many\n  buckets do I have?'), 'and regions?');
    expect(chatTitle(state)).toBe('How many buckets do I have?');
  });

  it('is cut when long', () => {
    const title = chatTitle(userSent(emptyChat, 'word '.repeat(40)), 20);
    expect(title).toHaveLength(20);
    expect(title?.endsWith('...')).toBe(true);
  });
});
