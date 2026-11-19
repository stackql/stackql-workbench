import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTable, ApprovalRequest, TurnSummary } from '../host/types';
import {
  applyAgentEvent,
  approvalAnswered,
  emptyChat,
  toolTitle,
  turnFailed,
  turnFinished,
  userSent,
  type ChatState,
} from './chat';
import {
  callSummary,
  conversationBlocks,
  hasRows,
  isHiddenCall,
  presentsCharts,
  stepsLabel,
  usageDetail,
  usageLabel,
  type Block,
  type StepsBlock,
} from './conversation';

const ended: TurnSummary = {
  steps: 2,
  toolCalls: 1,
  stopped: false,
  stop: { kind: 'endTurn' },
  // A provider that reports no counts, unless a test says otherwise.
  usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
};

const table = (columns: string[], rows: (string | null)[][]): AgentTable => ({
  columns,
  rows,
  totalRows: rows.length,
  truncated: false,
});

const started = (id: string, tool: string, sql: string | null, step = 1): AgentEvent => ({
  event: 'toolCallStarted',
  data: { id, tool, arguments: sql ? { sql } : {}, sql, step },
});

const finished = (id: string, result: AgentTable | null = null, isError = false): AgentEvent => ({
  event: 'toolCallFinished',
  data: {
    id,
    isError,
    text: isError ? 'syntax error at position 426' : 'ok',
    table: result,
    engineNotes: [],
    elapsedMs: 12,
  },
});

const said = (text: string): AgentEvent => ({ event: 'assistantText', data: { text } });

function play(events: AgentEvent[], from: ChatState = userSent(emptyChat, 'hello')): ChatState {
  return events.reduce(applyAgentEvent, from);
}

const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);

function stepsOf(blocks: Block[]): StepsBlock {
  const found = blocks.find((block): block is StepsBlock => block.kind === 'steps');
  if (!found) {
    throw new Error('No steps in this conversation.');
  }
  return found;
}

const MONTHS = table(
  ['month', 'issues'],
  [
    ['2026-10', '13'],
    ['2026-11', '8'],
  ],
);

describe('a turn that answers from one statement', () => {
  const state = turnFinished(
    play([
      started('c1', 'list_providers', null),
      finished('c1', table(['name'], [['github']])),
      said('I will count by month.'),
      started('c2', 'run_select_query', 'SELECT month, issues FROM t'),
      finished('c2', MONTHS),
      said('October was the busiest month.'),
    ]),
    ended,
  );
  const blocks = conversationBlocks(state);

  it('is the message, the steps, the result and the answer', () => {
    expect(kinds(blocks)).toEqual(['item', 'steps', 'result', 'answer']);
  });

  it('keeps every call and what was written between them as steps', () => {
    const steps = stepsOf(blocks);
    expect(steps.steps.map((step) => step.kind)).toEqual(['call', 'note', 'call']);
    expect(steps.calls).toBe(2);
    expect(steps.active).toBe(false);
    expect(stepsLabel(steps, toolTitle)).toBe('2 steps');
  });

  it('shows the last statement that returned rows, not the output of a lookup', () => {
    const result = blocks.find((block) => block.kind === 'result');
    expect(result?.kind === 'result' && result.item.callId).toBe('c2');
  });

  it('takes what was written after the last call as the answer', () => {
    const answer = blocks.find((block) => block.kind === 'answer');
    expect(answer?.kind === 'answer' && answer.text).toBe('October was the busiest month.');
  });
});

describe('a call that failed', () => {
  const state = turnFinished(
    play([
      started('c1', 'run_select_query', 'SELEC 1'),
      finished('c1', null, true),
      said('That did not parse. Trying again.'),
      started('c2', 'run_select_query', 'SELECT month, issues FROM t'),
      finished('c2', MONTHS),
      started('c3', 'run_select_query', 'SELECT nope'),
      finished('c3', null, true),
      said('Here is the count by month.'),
    ]),
    ended,
  );
  const blocks = conversationBlocks(state);

  it('is not listed among the steps', () => {
    const steps = stepsOf(blocks);
    const calls = steps.steps.flatMap((step) => (step.kind === 'call' ? [step.item.callId] : []));
    expect(calls).toEqual(['c2']);
    expect(steps.calls).toBe(1);
    expect(stepsLabel(steps, toolTitle)).toBe('1 step');
  });

  it('puts no error text anywhere in what is drawn', () => {
    expect(JSON.stringify(blocks)).not.toContain('syntax error');
  });

  it('is still in the chat state, where it ended as an error', () => {
    const errors = state.items.filter((item) => item.kind === 'tool' && item.status === 'error');
    expect(errors).toHaveLength(2);
    expect(errors.every((item) => item.kind === 'tool' && isHiddenCall(item))).toBe(true);
  });

  it('leaves no steps at all when every call failed', () => {
    const none = conversationBlocks(
      turnFinished(
        play([
          started('c1', 'run_select_query', 'SELEC 1'),
          finished('c1', null, true),
          said('I could not run that, because the provider needs a sign-in.'),
        ]),
        ended,
      ),
    );
    expect(kinds(none)).toEqual(['item', 'answer']);
  });
});

describe('a call the operator was asked about', () => {
  const request: ApprovalRequest = {
    id: 'approval-1',
    message: 'Approve run_mutation_query (mutation_delete)?',
    tool: 'run_mutation_query',
    queryClass: 'mutation_delete',
    sql: 'DELETE FROM t',
  };
  const asked = play([
    started('c1', 'run_mutation_query', 'DELETE FROM t'),
    { event: 'approvalRequested', data: { request } },
  ]);

  it('marks the steps as waiting while the prompt is open', () => {
    const steps = stepsOf(conversationBlocks(asked));
    expect(steps.waiting).toBe(true);
    expect(steps.active).toBe(true);
  });

  it('stays among the steps when it then fails, because the decision was theirs', () => {
    const declined = applyAgentEvent(
      approvalAnswered(asked, 'approval-1', 'decline'),
      finished('c1', null, true),
    );
    const steps = stepsOf(conversationBlocks(turnFinished(declined, ended)));
    expect(steps.steps).toHaveLength(1);
    expect(steps.waiting).toBe(false);
    const call = steps.steps[0];
    expect(call?.kind === 'call' && call.item.status).toBe('error');
    expect(call?.kind === 'call' && isHiddenCall(call.item)).toBe(false);
  });
});

describe('a turn that is still running', () => {
  it('shows what is being written as the answer until a call follows it', () => {
    const writing = play([said('Let me look.')]);
    expect(kinds(conversationBlocks(writing))).toEqual(['item', 'answer']);

    const calling = applyAgentEvent(writing, started('c1', 'run_select_query', 'SELECT 1'));
    const blocks = conversationBlocks(calling);
    expect(kinds(blocks)).toEqual(['item', 'steps']);
    const steps = stepsOf(blocks);
    expect(steps.steps.map((step) => step.kind)).toEqual(['note', 'call']);
    expect(steps.active).toBe(true);
    expect(steps.running?.callId).toBe('c1');
    expect(stepsLabel(steps, toolTitle)).toBe('Working: Run query');
  });

  it('puts the result under the steps as soon as there is one', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT month, issues FROM t'),
      finished('c1', MONTHS),
      started('c2', 'run_select_query', 'SELECT 2'),
    ]);
    expect(kinds(conversationBlocks(state))).toEqual(['item', 'steps', 'result']);
    expect(stepsLabel(stepsOf(conversationBlocks(state)), toolTitle)).toBe('Working: Run query');
  });

  it('says only that it is working when no call is running', () => {
    const between = play([started('c1', 'list_providers', null), finished('c1')]);
    expect(stepsLabel(stepsOf(conversationBlocks(between)), toolTitle)).toBe('Working');
  });
});

describe('a turn that ended without words after its last call', () => {
  it('takes the last thing written as the answer', () => {
    const state = turnFinished(
      play([
        said('There are two months of data.'),
        started('c1', 'run_select_query', 'SELECT month, issues FROM t'),
        finished('c1', MONTHS),
      ]),
      ended,
    );
    // It is drawn below the steps and the result, where an answer goes.
    const blocks = conversationBlocks(state);
    expect(kinds(blocks)).toEqual(['item', 'steps', 'result', 'answer']);
    const answer = blocks[blocks.length - 1];
    expect(answer?.kind === 'answer' && answer.text).toBe('There are two months of data.');
  });

  it('keeps the notice of a turn that failed', () => {
    const state = turnFailed(play([started('c1', 'run_select_query', 'SELECT 1')]), {
      kind: 'agent',
      message: 'The API key was rejected.',
    });
    const blocks = conversationBlocks(state);
    // The call never finished, so it ended as an error and is not listed.
    expect(kinds(blocks)).toEqual(['item', 'item']);
    const notice = blocks[1];
    expect(notice?.kind === 'item' && notice.item.kind === 'notice' && notice.item.text).toBe(
      'The API key was rejected.',
    );
  });
});

describe('an answer with a chart block', () => {
  const chart = '```chart\n{"type":"bar","x":"month","y":["issues"]}\n```';
  const state = turnFinished(
    play([
      started('c1', 'run_select_query', 'SELECT month, issues FROM t'),
      finished('c1', MONTHS),
      said(`Issues by month:\n\n${chart}`),
    ]),
    ended,
  );

  it('is shown with its charts, and not with the table as well', () => {
    expect(kinds(conversationBlocks(state))).toEqual(['item', 'steps', 'answer']);
  });

  it('is given the result sets a chart can be drawn from', () => {
    const answer = conversationBlocks(state).find((block) => block.kind === 'answer');
    expect(answer?.kind === 'answer' && answer.tables.map((item) => item.callId)).toEqual(['c1']);
  });

  it('can draw from a result an earlier turn produced', () => {
    const next = turnFinished(
      [said(`Again as a line:\n\n${chart}`)].reduce(
        applyAgentEvent,
        userSent(state, 'now as a line'),
      ),
      ended,
    );
    const blocks = conversationBlocks(next);
    expect(kinds(blocks)).toEqual(['item', 'steps', 'answer', 'item', 'answer']);
    const last = blocks[blocks.length - 1];
    expect(last?.kind === 'answer' && last.tables.map((item) => item.callId)).toEqual(['c1']);
  });

  it('counts a chart block that is still being written', () => {
    expect(presentsCharts('Here:\n\n```chart\n{"type":"ba')).toBe(true);
    expect(presentsCharts('```sql\nSELECT 1\n```')).toBe(false);
    expect(presentsCharts('No blocks here.')).toBe(false);
  });
});

describe('several turns', () => {
  it('each get their own steps and result', () => {
    const first = turnFinished(
      play([
        started('c1', 'run_select_query', 'SELECT 1 AS n'),
        finished('c1', table(['n'], [['1']])),
        said('One.'),
      ]),
      ended,
    );
    const second = turnFinished(
      [
        started('c2', 'run_select_query', 'SELECT 2 AS n'),
        finished('c2', table(['n'], [['2']])),
        said('Two.'),
      ].reduce(applyAgentEvent, userSent(first, 'and again')),
      ended,
    );
    const blocks = conversationBlocks(second);
    expect(kinds(blocks)).toEqual([
      'item',
      'steps',
      'result',
      'answer',
      'item',
      'steps',
      'result',
      'answer',
    ]);
    const results = blocks.flatMap((block) => (block.kind === 'result' ? [block.item.callId] : []));
    expect(results).toEqual(['c1', 'c2']);
    // Only the last turn can be the one that is running.
    expect(blocks.every((block) => block.kind !== 'steps' || !block.active)).toBe(true);
  });
});

describe('the result sets a turn is shown with', () => {
  const one = (n: string) => table(['n'], [[n]]);
  const shown = (events: AgentEvent[]) =>
    conversationBlocks(turnFinished(play(events), ended)).flatMap((block) =>
      block.kind === 'result' ? [block.item.callId] : [],
    );

  it('are those of the statements the assistant asked for together, last', () => {
    expect(
      shown([
        // Looked up on the way, in an earlier step.
        started('probe', 'run_select_query', 'SELECT 0', 1),
        finished('probe', one('0')),
        // Asked for together.
        started('details', 'run_select_query', 'SELECT 1', 2),
        started('count', 'run_select_query', 'SELECT 2', 2),
        finished('count', one('2')),
        finished('details', one('1')),
        said('Here are both.'),
      ]),
    ).toEqual(['details', 'count']);
  });

  it('leave out a statement of that step that failed or returned nothing', () => {
    expect(
      shown([
        started('a', 'run_select_query', 'SELECT 1', 3),
        started('b', 'run_select_query', 'SELEC 2', 3),
        started('c', 'run_select_query', 'SELECT 3', 3),
        finished('a', one('1')),
        finished('b', null, true),
        finished('c', table(['n'], [])),
        said('One of them had rows.'),
      ]),
    ).toEqual(['a']);
  });

  it('are not the output of a lookup, which is not a statement', () => {
    expect(
      shown([
        started('q', 'run_select_query', 'SELECT 1', 1),
        finished('q', one('1')),
        started('meta', 'list_providers', null, 2),
        finished('meta', table(['name'], [['github']])),
        said('Done.'),
      ]),
    ).toEqual(['q']);
  });

  it('are at most four, the last four', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(
      shown([
        ...ids.map((id) => started(id, 'run_select_query', `SELECT '${id}'`, 1)),
        ...ids.map((id) => finished(id, one(id))),
        said('Many.'),
      ]),
    ).toEqual(['c', 'd', 'e', 'f']);
  });

  it('are none when the turn ran no statement that returned rows', () => {
    expect(
      shown([
        started('meta', 'list_providers', null, 1),
        finished('meta', table(['name'], [['github']])),
        said('GitHub is installed.'),
      ]),
    ).toEqual([]);
  });
});

describe('what a turn used', () => {
  const usage = { inputTokens: 19353, outputTokens: 92, cachedInputTokens: 9533 };
  const counted = { ...ended, usage };

  it('is said on the line that heads the steps', () => {
    const blocks = conversationBlocks(
      turnFinished(
        play([
          started('c1', 'run_select_query', 'SELECT month, issues FROM t'),
          finished('c1', MONTHS),
          said('Two months.'),
        ]),
        counted,
      ),
    );
    // No block of its own: the steps carry it.
    expect(kinds(blocks)).toEqual(['item', 'steps', 'result', 'answer']);
    expect(stepsOf(blocks).usage).toEqual(usage);
  });

  it('takes the place of the steps, above the answer, in a turn that has none', () => {
    const blocks = conversationBlocks(turnFinished(play([said('Hello.')]), counted));
    expect(kinds(blocks)).toEqual(['item', 'usage', 'answer']);
    const block = blocks[1];
    expect(block?.kind === 'usage' && block.usage).toEqual(usage);
  });

  it('is still said when every call failed and nothing was answered', () => {
    const blocks = conversationBlocks(
      turnFinished(
        play([started('c1', 'run_select_query', 'SELEC 1'), finished('c1', null, true)]),
        counted,
      ),
    );
    expect(kinds(blocks)).toEqual(['item', 'usage']);
  });

  it('belongs to its own turn', () => {
    const first = turnFinished(play([said('One.')]), counted);
    const second = turnFinished(
      [
        started('c1', 'run_select_query', 'SELECT month, issues FROM t'),
        finished('c1', MONTHS),
        said('Two.'),
      ].reduce(applyAgentEvent, userSent(first, 'again')),
      { ...ended, usage: { inputTokens: 500, outputTokens: 7, cachedInputTokens: null } },
    );
    const blocks = conversationBlocks(second);
    expect(kinds(blocks)).toEqual(['item', 'usage', 'answer', 'item', 'steps', 'result', 'answer']);
    expect(stepsOf(blocks).usage?.inputTokens).toBe(500);
  });

  it('is not shown while the turn runs, since it is not known yet', () => {
    const running = play([started('c1', 'run_select_query', 'SELECT 1')]);
    expect(stepsOf(conversationBlocks(running)).usage).toBeNull();
  });
});

describe('usageLabel and usageDetail', () => {
  it('says the counts in full, with what was cached', () => {
    expect(usageLabel({ inputTokens: 19353, outputTokens: 92, cachedInputTokens: 9533 })).toBe(
      '19,353 tokens in (9,533 cached), 92 out',
    );
    expect(usageLabel({ inputTokens: 1204, outputTokens: 86, cachedInputTokens: null })).toBe(
      '1,204 tokens in, 86 out',
    );
    // Nothing cached is nothing worth a bracket.
    expect(usageLabel({ inputTokens: 1204, outputTokens: 86, cachedInputTokens: 0 })).toBe(
      '1,204 tokens in, 86 out',
    );
  });

  it('leaves out a count the provider did not report', () => {
    expect(usageLabel({ inputTokens: 300, outputTokens: null, cachedInputTokens: 150 })).toBe(
      '300 tokens in (150 cached)',
    );
    expect(usageLabel({ inputTokens: null, outputTokens: 40, cachedInputTokens: null })).toBe(
      '40 tokens out',
    );
    expect(usageLabel({ inputTokens: null, outputTokens: null, cachedInputTokens: 9 })).toBe('');
  });

  it('explains that the counts cover every call to the model', () => {
    const plain = usageDetail({ inputTokens: 10, outputTokens: 2, cachedInputTokens: null });
    expect(plain).toContain('added up over every call to the model');
    expect(plain).not.toContain('cache');
    expect(usageDetail({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 })).toContain(
      'part of the tokens in',
    );
  });
});

describe('hasRows', () => {
  it('is true only for a finished call with rows', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT 1'),
      finished('c1', table(['n'], [])),
      started('c2', 'run_select_query', 'SELECT 2'),
      finished('c2', table(['n'], [['2']])),
      started('c3', 'run_select_query', 'SELECT 3'),
    ]);
    const calls = state.items.flatMap((item) => (item.kind === 'tool' ? [item] : []));
    expect(calls.map(hasRows)).toEqual([false, true, false]);
  });
});

describe('callSummary', () => {
  it('is the statement on one line, or the arguments, cut when long', () => {
    const state = play([
      started('c1', 'run_select_query', 'SELECT a,\n       b\nFROM   t'),
      started('c2', 'list_services', null),
    ]);
    const calls = state.items.flatMap((item) => (item.kind === 'tool' ? [item] : []));
    const [first, second] = calls;
    if (!first || !second) {
      throw new Error('Two calls were expected.');
    }
    expect(callSummary(first, '')).toBe('SELECT a, b FROM t');
    expect(callSummary(second, 'provider: github')).toBe('provider: github');
    expect(callSummary(first, '', 12)).toBe('SELECT a,...');
  });
});
