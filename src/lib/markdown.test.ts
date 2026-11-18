import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, type Inline } from './markdown';

/** A compact rendering of inline nodes, to keep the expectations readable. */
function show(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return node.text;
        case 'strong':
          return `<b>${show(node.children)}</b>`;
        case 'em':
          return `<i>${show(node.children)}</i>`;
        case 'code':
          return `<code>${node.text}</code>`;
        case 'link':
          return `<a ${node.url}>${show(node.children)}</a>`;
      }
    })
    .join('');
}

const inline = (text: string) => show(parseInline(text));

describe('parseInline', () => {
  it('reads bold, italic and code', () => {
    expect(inline('Only **stackql_preview** is installed.')).toBe(
      'Only <b>stackql_preview</b> is installed.',
    );
    expect(inline('an *important* point and _another_')).toBe(
      'an <i>important</i> point and <i>another</i>',
    );
    expect(inline('run `SHOW PROVIDERS` first')).toBe('run <code>SHOW PROVIDERS</code> first');
    expect(inline('**bold with `code` inside**')).toBe('<b>bold with <code>code</code> inside</b>');
  });

  it('leaves names with underscores alone', () => {
    expect(inline('the run_select_query tool and stackql_preview')).toBe(
      'the run_select_query tool and stackql_preview',
    );
    expect(inline('aws.ec2.instances has instance_id and instance_type')).toBe(
      'aws.ec2.instances has instance_id and instance_type',
    );
  });

  it('leaves SQL stars alone', () => {
    expect(inline('SELECT * FROM a WHERE b * c > 1')).toBe('SELECT * FROM a WHERE b * c > 1');
    expect(inline('SELECT COUNT(*) FROM a and COUNT(*) FROM b')).toBe(
      'SELECT COUNT(*) FROM a and COUNT(*) FROM b',
    );
    expect(inline('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('leaves markers that never close as text', () => {
    expect(inline('a **bold that is still being typed')).toBe('a **bold that is still being typed');
    expect(inline('a `code that never ends')).toBe('a `code that never ends');
    expect(inline('one *star')).toBe('one *star');
  });

  it('reads links and keeps their address', () => {
    expect(inline('see [the docs](https://stackql.io/docs) for more')).toBe(
      'see <a https://stackql.io/docs>the docs</a> for more',
    );
    expect(inline('an [array] index and (parens)')).toBe('an [array] index and (parens)');
  });

  it('does not treat code as markup', () => {
    expect(inline('`**not bold**` and `a_b_c`')).toBe(
      '<code>**not bold**</code> and <code>a_b_c</code>',
    );
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines and keeps line breaks inside one', () => {
    const blocks = parseBlocks('First line\nsecond line\n\nNext paragraph');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
    expect(blocks[0]?.kind === 'paragraph' && blocks[0].lines.map(show)).toEqual([
      'First line',
      'second line',
    ]);
  });

  it('reads headings and caps their level', () => {
    const blocks = parseBlocks('# Title\n## Section\n##### Deep');
    expect(blocks.map((b) => (b.kind === 'heading' ? [b.level, show(b.content)] : null))).toEqual([
      [1, 'Title'],
      [2, 'Section'],
      [3, 'Deep'],
    ]);
  });

  it('does not read a hash without a space as a heading', () => {
    expect(parseBlocks('#hashtag')[0]?.kind).toBe('paragraph');
  });

  it('reads a bullet list with nesting and continuation lines', () => {
    const [list] = parseBlocks('- one\n- two\n  carries on\n  - nested **bold**\n- three');
    expect(list).toMatchObject({ kind: 'list', ordered: false });
    expect(list?.kind === 'list' && list.items.map((i) => [i.depth, show(i.content)])).toEqual([
      [0, 'one'],
      [0, 'two carries on'],
      [1, 'nested <b>bold</b>'],
      [0, 'three'],
    ]);
  });

  it('reads a numbered list and where it starts', () => {
    const [list] = parseBlocks('3. third\n4. fourth');
    expect(list).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    expect(list?.kind === 'list' && list.items).toHaveLength(2);
  });

  it('reads a table', () => {
    const [table] = parseBlocks(
      '| Bucket | Region |\n|---|---|\n| alpine-analytics-lake | us-east-1 |\n| `a|b` | us-west-2 |',
    );
    expect(table?.kind).toBe('table');
    if (table?.kind !== 'table') {
      return;
    }
    expect(table.header.map(show)).toEqual(['Bucket', 'Region']);
    expect(table.rows.map((row) => row.map(show))).toEqual([
      ['alpine-analytics-lake', 'us-east-1'],
      ['<code>a|b</code>', 'us-west-2'],
    ]);
  });

  it('keeps a table square when rows are short or long', () => {
    const [table] = parseBlocks('a | b\n--|--\n| 1 |\n1 | 2 | 3');
    expect(table?.kind === 'table' && table.rows.map((row) => row.map(show))).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('does not read a line with a pipe as a table without the dashes', () => {
    expect(parseBlocks('a | b\nc | d')[0]?.kind).toBe('paragraph');
  });

  it('reads a rule and carries on', () => {
    expect(parseBlocks('above\n\n---\n\nbelow').map((b) => b.kind)).toEqual([
      'paragraph',
      'rule',
      'paragraph',
    ]);
  });

  it('reads a reply with several kinds of block', () => {
    const blocks = parseBlocks(
      'Found **65 S3 buckets** across 6 regions.\n\n| Bucket | Region |\n|---|---|\n| a | us-east-1 |\n\nNext steps:\n1. Pick a region\n2. Run the query',
    );
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'table', 'paragraph', 'list']);
  });

  it('has nothing for empty text', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('  \n\n ')).toEqual([]);
  });
});
