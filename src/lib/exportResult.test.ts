import { describe, expect, it } from 'vitest';
import { exportFileName, toCsv, toJson, toMarkdownTable, uniqueKeys } from './exportResult';

describe('toCsv', () => {
  it('writes a header and one record for each row, ended by CRLF', () => {
    expect(
      toCsv(
        ['name', 'stars'],
        [
          ['stackql', '512'],
          ['docs', '3'],
        ],
      ),
    ).toBe('name,stars\r\nstackql,512\r\ndocs,3\r\n');
  });

  it('quotes a field that holds a comma, a quote or a line break', () => {
    expect(toCsv(['a'], [['x,y'], ['say "hi"'], ['two\nlines']])).toBe(
      'a\r\n"x,y"\r\n"say ""hi"""\r\n"two\nlines"\r\n',
    );
  });

  it('leaves a NULL empty and writes only the header when there are no rows', () => {
    expect(toCsv(['a', 'b'], [[null, 'x']])).toBe('a,b\r\n,x\r\n');
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });
});

describe('toJson', () => {
  it('writes one object for each row', () => {
    expect(JSON.parse(toJson(['name', 'stars'], [['stackql', '512']]))).toEqual([
      { name: 'stackql', stars: '512' },
    ]);
  });

  it('nests objects and arrays, and leaves other values as the text the engine sent', () => {
    const [record] = JSON.parse(
      toJson(
        ['owner', 'topics', 'count', 'flag', 'broken', 'nothing'],
        [['{"login":"stackql"}', '["sql","cloud"]', '42', 'true', '{not json}', null]],
      ),
    ) as Record<string, unknown>[];
    expect(record).toEqual({
      owner: { login: 'stackql' },
      topics: ['sql', 'cloud'],
      count: '42',
      flag: 'true',
      broken: '{not json}',
      nothing: null,
    });
  });

  it('keeps every column when two share a name', () => {
    expect(uniqueKeys(['id', 'name', 'id', 'id'])).toEqual(['id', 'name', 'id_2', 'id_3']);
    expect(JSON.parse(toJson(['id', 'id'], [['1', '2']]))).toEqual([{ id: '1', id_2: '2' }]);
  });

  it('writes an empty array for no rows', () => {
    expect(toJson(['a'], [])).toBe('[]\n');
  });
});

describe('toMarkdownTable', () => {
  it('writes a header, a rule and the rows', () => {
    expect(toMarkdownTable(['name', 'stars'], [['stackql', '512']])).toBe(
      '| name | stars |\n| --- | --- |\n| stackql | 512 |\n',
    );
  });

  it('keeps a cell on one line and escapes what would break the table', () => {
    expect(toMarkdownTable(['v'], [['a|b'], ['two\r\nlines'], [null], ['back\\slash']])).toBe(
      '| v |\n| --- |\n| a\\|b |\n| two lines |\n|  |\n| back\\\\slash |\n',
    );
  });
});

describe('exportFileName', () => {
  it('carries the local date and time', () => {
    expect(exportFileName('csv', new Date(2026, 10, 18, 9, 5, 7))).toBe(
      'stackql-result-20261118-090507.csv',
    );
  });
});
