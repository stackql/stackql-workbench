import { describe, expect, it } from 'vitest';
import { cellPreview, describeCell, looksLikeJson } from './cell';

describe('looksLikeJson', () => {
  it('recognises objects and arrays by their brackets', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson('[]')).toBe(true);
    expect(looksLikeJson('[1,2]')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(looksLikeJson(null)).toBe(false);
    expect(looksLikeJson('')).toBe(false);
    expect(looksLikeJson('{')).toBe(false);
    expect(looksLikeJson('true')).toBe(false);
    expect(looksLikeJson('42')).toBe(false);
    expect(looksLikeJson('{oops]')).toBe(false);
    expect(looksLikeJson('plain text')).toBe(false);
  });
});

describe('describeCell', () => {
  it('reports a protocol null', () => {
    expect(describeCell(null)).toEqual({ kind: 'null' });
  });

  it('pretty-prints a JSON object', () => {
    const cell = describeCell('{"bottle":true,"stable":"1.25.0"}');
    expect(cell.kind).toBe('json');
    if (cell.kind === 'json') {
      expect(cell.pretty).toBe('{\n  "bottle": true,\n  "stable": "1.25.0"\n}');
      expect(cell.text).toBe('{"bottle":true,"stable":"1.25.0"}');
    }
  });

  it('pretty-prints a JSON array', () => {
    const cell = describeCell('["a","b"]');
    expect(cell).toMatchObject({ kind: 'json', pretty: '[\n  "a",\n  "b"\n]' });
  });

  it('treats text that only looks like JSON as text', () => {
    expect(describeCell('{not json}')).toEqual({ kind: 'text', text: '{not json}' });
    expect(describeCell('[unterminated')).toEqual({ kind: 'text', text: '[unterminated' });
  });

  it('treats scalars as text, as the engine sends them', () => {
    expect(describeCell('true')).toEqual({ kind: 'text', text: 'true' });
    expect(describeCell('42')).toEqual({ kind: 'text', text: '42' });
    expect(describeCell('')).toEqual({ kind: 'text', text: '' });
  });

  it('tolerates surrounding whitespace around JSON', () => {
    expect(describeCell('  {"a":1}\n').kind).toBe('json');
  });
});

describe('cellPreview', () => {
  it('shows NULL for a protocol null', () => {
    expect(cellPreview(null)).toBe('NULL');
  });

  it('flattens whitespace to one line', () => {
    expect(cellPreview('line one\n  line two\ttabbed')).toBe('line one line two tabbed');
  });

  it('cuts long values', () => {
    expect(cellPreview('x'.repeat(1000))).toHaveLength(300);
  });

  it('leaves short values alone', () => {
    expect(cellPreview('wget')).toBe('wget');
    expect(cellPreview('')).toBe('');
  });
});
