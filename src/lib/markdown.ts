// A small reader for the markdown models write in replies: headings, lists,
// tables, emphasis, inline code and links. Fenced code is split out before
// this runs. See `splitFences`.
//
// It produces a tree and never HTML, so nothing a model writes can become
// markup. Text it does not recognise stays as it was typed.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; children: Inline[]; url: string };

export interface ListItem {
  /** How far the item is indented, from 0. */
  depth: number;
  content: Inline[];
}

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' };

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (char: string | undefined) => char !== undefined && WORD.test(char);
const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);

/**
 * Finds the end of an emphasis run that opens at `from` with `marker`.
 * The closing marker must follow something that is not a space.
 */
function closing(text: string, marker: string, from: number): number {
  let at = text.indexOf(marker, from);
  while (at !== -1) {
    if (at > from && !isSpace(text[at - 1])) {
      return at;
    }
    at = text.indexOf(marker, at + 1);
  }
  return -1;
}

/** Reads emphasis, inline code and links out of one run of text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      out.push({ kind: 'text', text: plain });
      plain = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    const before = text[i - 1];

    if (char === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (char === '*' && text[i + 1] === '*') {
      const end = closing(text, '**', i + 2);
      if (end !== -1 && !isSpace(text[i + 2])) {
        flush();
        out.push({ kind: 'strong', children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    } else if (char === '*' || char === '_') {
      // A single marker opens emphasis only at the start of a word. That
      // keeps snake_case names, SELECT * and COUNT(*) as they were typed.
      const opens = !isWord(before) && before !== '(' && before !== char && isWord(text[i + 1]);
      if (opens) {
        let end = closing(text, char, i + 1);
        // The closing marker must end a word, not sit inside one.
        while (end !== -1 && (isWord(text[end + 1]) || text[end + 1] === char)) {
          end = closing(text, char, end + 1);
        }
        if (end !== -1) {
          flush();
          out.push({ kind: 'em', children: parseInline(text.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    } else if (char === '[') {
      const label = text.indexOf('](', i + 1);
      const end = label === -1 ? -1 : text.indexOf(')', label + 2);
      if (label > i + 1 && end !== -1 && !text.slice(i + 1, label).includes('\n')) {
        const url = text.slice(label + 2, end).trim();
        if (url !== '' && !/\s/.test(url)) {
          flush();
          out.push({ kind: 'link', children: parseInline(text.slice(i + 1, label)), url });
          i = end + 1;
          continue;
        }
      }
    }
    plain += char;
    i += 1;
  }
  flush();
  return out;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** The cells of one table row. A pipe inside inline code is not a divider. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed.charAt(i);
    if (char === '`') {
      inCode = !inCode;
    }
    if (char === '\\' && trimmed[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|' && !inCode) {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  out.push(cell.trim());
  return out;
}

function listMatch(
  line: string,
): { ordered: boolean; start: number; indent: number; text: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { ordered: false, start: 1, indent: (bullet[1] ?? '').length, text: bullet[2] ?? '' };
  }
  const numbered = NUMBERED.exec(line);
  if (numbered) {
    return {
      ordered: true,
      start: Number(numbered[2]),
      indent: (numbered[1] ?? '').length,
      text: numbered[3] ?? '',
    };
  }
  return null;
}

/** Reads text into blocks. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraph.map(parseInline) });
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      endParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      const level = Math.min((heading[1] ?? '#').length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, content: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    // A table is a row of cells with a row of dashes under it.
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && next.includes('-') && TABLE_RULE.test(next)) {
      const header = cells(line);
      if (cells(next).length === header.length) {
        endParagraph();
        const rows: Inline[][][] = [];
        i += 2;
        while (
          i < lines.length &&
          (lines[i] ?? '').includes('|') &&
          (lines[i] ?? '').trim() !== ''
        ) {
          const row = cells(lines[i] ?? '');
          // Short rows are padded and long ones cut, so the grid stays square.
          rows.push(header.map((_, column) => parseInline(row[column] ?? '')));
          i += 1;
        }
        blocks.push({ kind: 'table', header: header.map(parseInline), rows });
        continue;
      }
    }

    const first = listMatch(line);
    if (first) {
      endParagraph();
      const items: { indent: number; text: string }[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const item = listMatch(current);
        if (item) {
          items.push({ indent: item.indent, text: item.text });
        } else if (current.trim() !== '' && /^\s+/.test(current) && items.length > 0) {
          // An indented line carries on the item above it.
          const last = items[items.length - 1];
          if (last) {
            last.text += ` ${current.trim()}`;
          }
        } else {
          break;
        }
        i += 1;
      }
      // Depth is the rank of an item's indent among the indents used.
      const indents = [...new Set(items.map((item) => item.indent))].sort((a, b) => a - b);
      blocks.push({
        kind: 'list',
        ordered: first.ordered,
        start: first.start,
        items: items.map((item) => ({
          depth: Math.min(indents.indexOf(item.indent), 3),
          content: parseInline(item.text),
        })),
      });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  endParagraph();
  return blocks;
}
