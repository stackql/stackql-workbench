// How a conversation is laid out, worked out from the chat state. Pure
// functions, so the layout can be tested without a page.
//
// A turn is shown as its answer. What the assistant did on the way is kept
// in one list of steps, folded away once the turn has ended: the calls it
// made, each with its SQL and its result, and what it wrote between them.
// A call that failed is not listed. A model reads the error, corrects the
// statement and runs it again, and that is part of how it works, not
// something to put in front of the operator. The host writes every failed
// call to the app's log.

import { splitFences, type ChatItem, type ChatState, type ToolItem } from './chat';

export type Step =
  /** A call the assistant made. */
  | { kind: 'call'; key: string; item: ToolItem }
  /** What the assistant wrote before going on to another call. */
  | { kind: 'note'; key: string; text: string; tables: ToolItem[] };

type PlainItem = Extract<ChatItem, { kind: 'user' | 'session' | 'notice' }>;

export interface StepsBlock {
  kind: 'steps';
  key: string;
  steps: Step[];
  /** How many of the steps are calls. */
  calls: number;
  /** The turn these steps belong to is still running. */
  active: boolean;
  /** A step is waiting for the operator's decision. */
  waiting: boolean;
  /** The call that is running now, if one is. */
  running: ToolItem | null;
}

export type Block =
  | { kind: 'item'; key: string; item: PlainItem }
  | StepsBlock
  /** A result set a turn is shown with, when its answer presents none itself. */
  | { kind: 'result'; key: string; item: ToolItem }
  | {
      kind: 'answer';
      key: string;
      text: string;
      /** The result sets a chart block in the text can be drawn from, oldest first. */
      tables: ToolItem[];
    };

/**
 * A call that failed is left out, unless the operator was asked about it:
 * then the call is theirs to see, with what they decided and how it ended.
 */
export function isHiddenCall(item: ToolItem): boolean {
  return item.status === 'error' && item.approval === null;
}

/** A call that finished with a result set that has something in it. */
export function hasRows(item: ToolItem): boolean {
  return (
    item.status === 'done' &&
    item.table !== null &&
    item.table.columns.length > 0 &&
    item.table.rows.length > 0
  );
}

/** A call that finished with a result set a chart could be drawn from. */
function hasTable(item: ToolItem): boolean {
  return item.status === 'done' && item.table !== null && item.table.columns.length > 0;
}

/** True when the text holds a chart block, closed or still being written. */
export function presentsCharts(text: string): boolean {
  return splitFences(text).some(
    (segment) => segment.kind === 'code' && segment.language === 'chart',
  );
}

/** The turns of a conversation: each starts with what the operator sent. */
function turns(items: ChatItem[]): ChatItem[][] {
  const out: ChatItem[][] = [];
  for (const item of items) {
    const current = out[out.length - 1];
    if (item.kind === 'user' || !current) {
      out.push([item]);
    } else {
      current.push(item);
    }
  }
  return out;
}

/**
 * Which item of a turn is its answer: what the assistant wrote after its
 * last call. While a turn runs that can still change, since a call may
 * follow. A turn that has ended with a call last has no words after it, and
 * then the last thing the assistant wrote is taken as the answer.
 */
function answerIndex(items: ChatItem[], active: boolean): number {
  let lastText = -1;
  let lastCall = -1;
  items.forEach((item, index) => {
    if (item.kind === 'assistant' && item.text.trim() !== '') {
      lastText = index;
    } else if (item.kind === 'tool') {
      lastCall = index;
    }
  });
  if (lastText > lastCall) {
    return lastText;
  }
  return active ? -1 : lastText;
}

function addStep(block: StepsBlock, step: Step): void {
  block.steps.push(step);
  if (step.kind === 'call') {
    block.calls += 1;
    block.waiting ||= step.item.approval?.decision === 'pending';
    if (step.item.status === 'running') {
      block.running = step.item;
    }
  }
}

/** The most result sets a turn is shown with. The steps hold the rest. */
export const MAX_SHOWN_RESULTS = 4;

/**
 * The result sets a turn is shown with: those of the last statement that
 * returned rows, and of the statements the assistant asked for together
 * with it. A question that takes two statements to answer is shown with
 * both, and what the assistant looked up on the way to them is not.
 */
export function shownResults(items: ChatItem[]): ToolItem[] {
  const withRows = items.filter(
    (item): item is ToolItem => item.kind === 'tool' && item.sql !== null && hasRows(item),
  );
  const last = withRows[withRows.length - 1];
  if (!last) {
    return [];
  }
  const together = last.step === null ? [last] : withRows.filter((item) => item.step === last.step);
  return together.slice(-MAX_SHOWN_RESULTS);
}

/**
 * Lays one turn out and adds its blocks. `tables` holds every result set so
 * far, in every turn, and this turn's are added to it: a chart can be drawn
 * from a result an earlier turn produced.
 */
function layoutTurn(items: ChatItem[], active: boolean, tables: ToolItem[], blocks: Block[]): void {
  const answerAt = answerIndex(items, active);
  const shown = shownResults(items);
  const results = (): Block[] =>
    shown.map((item) => ({ kind: 'result', key: `result-${item.key}`, item }));
  const steps: StepsBlock = {
    kind: 'steps',
    key: '',
    steps: [],
    calls: 0,
    active,
    waiting: false,
    running: null,
  };
  // Where the steps were put, once there is a first step to show.
  let stepsAt = -1;
  const step = (next: Step) => {
    if (stepsAt < 0) {
      steps.key = `steps-${next.key}`;
      stepsAt = blocks.length;
      blocks.push(steps);
    }
    addStep(steps, next);
  };
  const answer = (item: { key: string; text: string }) => {
    // An answer that presents results itself is shown with those.
    // Otherwise the turn's result sets go in front of it.
    if (!presentsCharts(item.text)) {
      blocks.push(...results());
    }
    blocks.push({ kind: 'answer', key: item.key, text: item.text, tables: tables.slice() });
  };

  // An answer that calls came after is drawn below them, like any other.
  let held: { key: string; text: string } | null = null;
  let answered = false;
  for (const [index, item] of items.entries()) {
    if (item.kind === 'tool') {
      if (hasTable(item)) {
        tables.push(item);
      }
      if (!isHiddenCall(item)) {
        step({ kind: 'call', key: item.key, item });
      }
    } else if (item.kind !== 'assistant') {
      blocks.push({ kind: 'item', key: item.key, item });
    } else if (item.text.trim() === '') {
      // Nothing was written.
    } else if (index !== answerAt) {
      step({ kind: 'note', key: item.key, text: item.text, tables: tables.slice() });
    } else if (items.slice(index + 1).some((later) => later.kind === 'tool')) {
      held = item;
    } else {
      answer(item);
      answered = true;
    }
  }

  if (held) {
    answer(held);
  } else if (!answered) {
    // No answer yet, or none at all. The results go under the steps.
    blocks.splice(stepsAt >= 0 ? stepsAt + 1 : blocks.length, 0, ...results());
  }
}

/** Lays the conversation out as blocks, in the order they are drawn. */
export function conversationBlocks(state: ChatState): Block[] {
  const blocks: Block[] = [];
  const tables: ToolItem[] = [];
  const all = turns(state.items);
  all.forEach((items, turn) => {
    layoutTurn(items, state.busy && turn === all.length - 1, tables, blocks);
  });
  return blocks;
}

/** What a step list is headed with. */
export function stepsLabel(block: StepsBlock, title: (tool: string) => string): string {
  if (block.active) {
    return block.running ? `Working: ${title(block.running.tool)}` : 'Working';
  }
  if (block.calls === 0) {
    return 'Notes';
  }
  return block.calls === 1 ? '1 step' : `${block.calls} steps`;
}

/** One line that says what a call was about: the start of its statement, or its arguments. */
export function callSummary(item: ToolItem, argumentText: string, maxLength = 140): string {
  const text = (item.sql ?? argumentText).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}
