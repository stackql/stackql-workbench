// What the conversation draws, checked on the markup the components
// produce. The layout itself is tested in `lib/conversation.test.ts`. This
// is about what reaches the page: that a chart block becomes a chart, that a
// failed call leaves nothing behind, and that a model's words stay words.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTable, TurnSummary } from '../../host/types';
import {
  applyAgentEvent,
  emptyChat,
  turnFinished,
  userSent,
  type ChatState,
  type ToolItem,
} from '../../lib/chat';
import { conversationBlocks } from '../../lib/conversation';
import { AssistantText } from './AssistantText';
import { ResultCard } from './ResultCard';
import { Steps } from './Steps';

const ended: TurnSummary = {
  steps: 2,
  toolCalls: 1,
  stopped: false,
  stop: { kind: 'endTurn' },
  usage: { inputTokens: 1, outputTokens: 1 },
};

const MONTHS: AgentTable = {
  columns: ['issues_created', 'month'],
  rows: [
    ['1', '2023-01'],
    ['46', '2023-10'],
    ['13', '2026-10'],
  ],
  totalRows: 3,
  truncated: false,
};

const SQL = 'SELECT month, COUNT(*) AS issues_created FROM github.issues.issues GROUP BY month';

function conversation(events: AgentEvent[]): ChatState {
  return turnFinished(events.reduce(applyAgentEvent, userSent(emptyChat, 'plot it')), ended);
}

const state = conversation([
  {
    event: 'toolCallStarted',
    data: { id: 'c1', tool: 'run_select_query', arguments: {}, sql: 'SELEC nope', step: 1 },
  },
  {
    event: 'toolCallFinished',
    data: {
      id: 'c1',
      isError: true,
      text: 'syntax error at position 426 near GROUP',
      table: null,
      engineNotes: [],
      elapsedMs: 17,
    },
  },
  {
    event: 'toolCallStarted',
    data: { id: 'c2', tool: 'run_select_query', arguments: {}, sql: SQL, step: 1 },
  },
  {
    event: 'toolCallFinished',
    data: { id: 'c2', isError: false, text: 'ok', table: MONTHS, engineNotes: [], elapsedMs: 2100 },
  },
]);

const tables = state.items.filter(
  (item): item is ToolItem => item.kind === 'tool' && item.table !== null,
);
const noop = () => undefined;

function reply(text: string): string {
  return renderToStaticMarkup(
    <AssistantText text={text} onOpenInEditor={noop} charts={{ tables, onShowTable: noop }} />,
  );
}

describe('a chart block in a reply', () => {
  const chart = '{"type":"bar","title":"Issues per month","x":"month","y":["issues_created"]}';

  it('is drawn as a chart of the result set that has its columns', () => {
    const html = reply(`Here is the trend.\n\n\`\`\`chart\n${chart}\n\`\`\``);
    expect(html).toContain('data-chart-block="bar"');
    expect(html).toContain('data-chart="bar"');
    // One bar for each row, in the first colour of the palette.
    expect(html.match(/<path[^>]*data-series="0"/g)).toHaveLength(3);
    expect(html).toContain('fill="var(--chart-1)"');
    expect(html).toContain('Issues per month');
    // The block itself is not shown as text.
    expect(html).not.toContain('&quot;type&quot;');
    // The words around it are still there.
    expect(html).toContain('Here is the trend.');
  });

  it('has the table one click away, and a way to the statement and to a file', () => {
    const html = reply(`\`\`\`chart\n${chart}\n\`\`\``);
    expect(html).toContain('aria-label="View"');
    expect(html).toContain('title="Chart"');
    expect(html).toContain('title="Table"');
    expect(html).toContain('aria-label="Show the statement"');
    expect(html).toContain('aria-label="Download as CSV"');
    expect(html).toContain('aria-label="Open in the results grid"');
  });

  it('says it is being drawn while the block is still arriving', () => {
    const html = reply('Here is the trend.\n\n```chart\n{"type":"bar","x":"mon');
    expect(html).toContain('data-chart-block="writing"');
    expect(html).toContain('Drawing the chart');
    expect(html).not.toContain('&quot;type&quot;');
  });

  it('is shown as it was written, with the reason, when it cannot be drawn', () => {
    const html = reply('```chart\n{"type":"bar","x":"week","y":["issues_created"]}\n```');
    expect(html).toContain('data-chart-block="unread"');
    expect(html).toContain('This chart could not be drawn.');
    expect(html).toContain('No result set in this conversation has the columns');
    expect(html).toContain('&quot;week&quot;');
  });

  it('draws a line over time and a pie of parts', () => {
    const line = reply('```chart\n{"type":"line","x":"month","y":["issues_created"]}\n```');
    expect(line).toContain('data-chart="line"');
    expect(line).toContain('stroke="var(--chart-1)"');
    // Years along the axis, since the months span more than two of them.
    expect(line).toContain('>2024</text>');

    const pie = reply('```chart\n{"type":"pie","x":"month","y":["issues_created"]}\n```');
    expect(pie).toContain('data-chart="pie"');
    expect(pie.match(/<path[^>]*data-series=/g)).toHaveLength(3);
    // Every part is named with its amount and its share.
    expect(pie).toContain('77%');
    expect(pie).toContain('>60</text>');
  });

  it('shows a result set as a table when that is what the block asks for', () => {
    const html = reply('```chart\n{"type":"table","title":"By month"}\n```');
    expect(html).toContain('data-chart-block="table"');
    expect(html).toContain('data-result-card="table"');
    expect(html).toContain('By month');
    expect(html).toContain('role="grid"');
    // A table has no chart to switch to.
    expect(html).not.toContain('aria-label="View"');
  });

  it('draws rows the block carries itself', () => {
    const html = reply(
      '```chart\n{"type":"bar","x":"k","y":["a","b"],"stacked":true,"data":[{"k":"x","a":1,"b":2}]}\n```',
    );
    expect(html).toContain('data-chart="bar"');
    // Two series, so there is a legend, and no statement to show.
    expect(html).toContain('data-chart-legend');
    expect(html).not.toContain('aria-label="Show the statement"');
    expect(html).not.toContain('aria-label="Open in the results grid"');
  });

  it('never turns what a model wrote into markup', () => {
    const html = reply(
      '```chart\n{"type":"bar","title":"<img src=x onerror=alert(1)>","x":"k","y":["v"],"data":[{"k":"<script>alert(1)</script>","v":1}]}\n```',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('is left as code where no result sets are given, as in a library document', () => {
    const html = renderToStaticMarkup(
      <AssistantText text={`\`\`\`chart\n${chart}\n\`\`\``} onOpenInEditor={noop} />,
    );
    expect(html).not.toContain('data-chart-block');
    expect(html).toContain('&quot;type&quot;');
  });
});

describe('the steps of a turn', () => {
  const blocks = conversationBlocks(state);
  const steps = blocks.find((block) => block.kind === 'steps');
  if (steps?.kind !== 'steps') {
    throw new Error('The turn has steps.');
  }
  const html = renderToStaticMarkup(
    <Steps block={steps} onOpenInEditor={noop} onAnswer={noop} renderNote={() => null} />,
  );

  it('are folded away once the turn has ended', () => {
    expect(html).toContain('data-steps="done"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('1 step');
    // Folded, so no call is drawn.
    expect(html).not.toContain('data-tool=');
  });

  it('hold nothing of a call that failed, in any block of the conversation', () => {
    const all = renderToStaticMarkup(
      <>
        {blocks.map((block) =>
          block.kind === 'steps' ? (
            <Steps
              key={block.key}
              // Open, to see every step there is.
              block={{ ...block, active: true }}
              onOpenInEditor={noop}
              onAnswer={noop}
              renderNote={() => null}
            />
          ) : block.kind === 'result' && block.item.table ? (
            <ResultCard
              key={block.key}
              columns={block.item.table.columns}
              rows={block.item.table.rows}
              sql={block.item.sql}
            />
          ) : null,
        )}
      </>,
    );
    expect(all).not.toContain('syntax error');
    expect(all).not.toContain('SELEC nope');
    // The call that worked is there, with what it ran.
    expect(all.match(/data-tool="run_select_query"/g)).toHaveLength(1);
    expect(all).toContain('data-status="done"');
    expect(all).toContain('3 rows');
  });
});

describe('the result set a turn is shown with', () => {
  const html = renderToStaticMarkup(
    <ResultCard
      columns={MONTHS.columns}
      rows={MONTHS.rows}
      totalRows={5000}
      sql={SQL}
      onOpenGrid={noop}
    />,
  );

  it('is a table whose columns sort', () => {
    expect(html).toContain('data-result-card="table"');
    expect(html).toContain('role="grid"');
    expect(html.match(/aria-sort="none"/g)).toHaveLength(2);
    expect(html).toContain('issues_created: click to sort');
  });

  it('can be downloaded, and says when rows were not all kept', () => {
    expect(html).toContain('aria-label="Download as CSV"');
    expect(html).toContain('first 3 of 5,000 rows');
  });

  it('keeps its statement out of the way until it is asked for', () => {
    expect(html).toContain('aria-label="Show the statement"');
    expect(html).not.toContain('github.issues.issues');
  });
});
