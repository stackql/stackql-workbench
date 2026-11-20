// A result set as CSV, JSON or a Markdown table. Pure text in, text out.
// The host saves the text. Nothing here touches a file.

import type { Row } from '../host/types';
import { looksLikeJson } from './cell';

const CSV_SPECIAL = /[",\r\n]/;

function csvField(value: string | null): string {
  if (value === null) {
    return '';
  }
  return CSV_SPECIAL.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180: CRLF between records, quotes doubled. A NULL is an empty field. */
export function toCsv(columns: string[], rows: Row[]): string {
  return `${[columns, ...rows].map((record) => record.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** Column names made unique, so an object can hold every column. */
export function uniqueKeys(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const count = (seen.get(column) ?? 0) + 1;
    seen.set(column, count);
    return count === 1 ? column : `${column}_${count}`;
  });
}

/**
 * The engine sends every value as text. An object or an array is put in
 * the file as JSON, because its shape is unambiguous. Anything else stays
 * the text the engine sent: a number is not guessed from its digits.
 */
function jsonValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (looksLikeJson(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // Not JSON after all.
    }
  }
  return value;
}

/** An array with one object for each row, keyed by column name. */
export function toJson(columns: string[], rows: Row[]): string {
  const keys = uniqueKeys(columns);
  const records = rows.map((row) =>
    Object.fromEntries(keys.map((key, index) => [key, jsonValue(row[index] ?? null)])),
  );
  return `${JSON.stringify(records, null, 2)}\n`;
}

function markdownCell(value: string | null): string {
  if (value === null) {
    return '';
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n|\r/g, ' ');
}

/** A Markdown table. A cell is kept on one line and its pipes are escaped. */
export function toMarkdownTable(columns: string[], rows: Row[]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return `${[
    line(columns.map(markdownCell)),
    line(columns.map(() => '---')),
    ...rows.map((row) => line(columns.map((_, index) => markdownCell(row[index] ?? null)))),
  ].join('\n')}\n`;
}

const two = (value: number) => String(value).padStart(2, '0');

/** The name a saved result is offered under, for example stackql-result-20261118-174500.csv. */
export function exportFileName(extension: string, now: Date): string {
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `stackql-result-${day}-${time}.${extension}`;
}
