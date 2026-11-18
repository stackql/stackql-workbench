import { useMemo, type ReactNode } from 'react';
import { parseBlocks, type Block, type Inline } from '../../lib/markdown';

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={index}>{inline(node.children)}</strong>;
      case 'em':
        return <em key={index}>{inline(node.children)}</em>;
      case 'code':
        return (
          <code
            key={index}
            className="rounded bg-surface-sunken px-1 py-px font-mono text-[12px] break-words"
          >
            {node.text}
          </code>
        );
      case 'link':
        // The webview goes nowhere. The address is shown so it can be read
        // and copied, and nothing is opened.
        return (
          <span key={index} className="text-accent underline" title={node.url}>
            {inline(node.children)}
          </span>
        );
    }
  });
}

const HEADING_CLASS = {
  1: 'text-[17px] font-semibold',
  2: 'text-[15px] font-semibold',
  3: 'text-[13px] font-semibold',
} as const;

const INDENT = ['pl-0', 'pl-5', 'pl-10', 'pl-[60px]'] as const;

function block(node: Block, key: number): ReactNode {
  switch (node.kind) {
    case 'paragraph':
      return (
        <p key={key} className="m-0 leading-relaxed break-words">
          {node.lines.map((line, index) => (
            <span key={index}>
              {index > 0 && <br />}
              {inline(line)}
            </span>
          ))}
        </p>
      );
    case 'heading':
      return (
        <div
          key={key}
          role="heading"
          aria-level={node.level + 1}
          className={`mt-1 ${HEADING_CLASS[node.level]}`}
        >
          {inline(node.content)}
        </div>
      );
    case 'rule':
      return <hr key={key} className="my-1 border-0 border-t border-line" />;
    case 'list': {
      // Numbers count per depth, so a nested list starts again from one.
      const counters = [node.start, 1, 1, 1];
      return (
        <div key={key} role="list" className="flex flex-col gap-1">
          {node.items.map((item, index) => {
            const number = counters[item.depth] ?? 1;
            counters[item.depth] = number + 1;
            for (let deeper = item.depth + 1; deeper < counters.length; deeper += 1) {
              counters[deeper] = 1;
            }
            return (
              <div
                key={index}
                role="listitem"
                className={`flex gap-2 leading-relaxed ${INDENT[item.depth] ?? 'pl-0'}`}
              >
                <span className="w-4 shrink-0 text-right text-ink-muted tabular-nums">
                  {node.ordered && item.depth === 0 ? `${number}.` : '-'}
                </span>
                <span className="min-w-0 break-words">{inline(item.content)}</span>
              </div>
            );
          })}
        </div>
      );
    }
    case 'table':
      return (
        <div key={key} className="max-w-full overflow-auto rounded border border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {node.header.map((cell, index) => (
                  <th
                    key={index}
                    className="border-b border-line bg-surface-alt px-2 py-1 text-left font-semibold"
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, index) => (
                <tr key={index} className="border-b border-line last:border-b-0">
                  {row.map((cell, position) => (
                    <td key={position} className="px-2 py-1 align-top break-words">
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Reply text, with the markdown models write shown as formatting. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="selectable flex flex-col gap-2">{blocks.map(block)}</div>;
}
