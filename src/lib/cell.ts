// How a grid cell is shown. The engine sends every value as text and gives
// no usable type information, so JSON is recognised by looking at the value.

export type CellContent =
  | { kind: 'null' }
  | { kind: 'text'; text: string }
  | { kind: 'json'; text: string; pretty: string };

/** Cheap check used while rendering the grid. Does not parse. */
export function looksLikeJson(value: string | null): boolean {
  if (value === null || value.length < 2) {
    return false;
  }
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '{' && last === '}') || (first === '[' && last === ']');
}

/** Full classification for the cell viewer. Parses the value once. */
export function describeCell(value: string | null): CellContent {
  if (value === null) {
    return { kind: 'null' };
  }
  const trimmed = value.trim();
  if (looksLikeJson(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return { kind: 'json', text: value, pretty: JSON.stringify(parsed, null, 2) };
      }
    } catch {
      // Not JSON after all. Show it as text.
    }
  }
  return { kind: 'text', text: value };
}

const PREVIEW_CHARS = 300;

/** The text drawn in a grid cell: one line, cut to a sensible length. */
export function cellPreview(value: string | null): string {
  if (value === null) {
    return 'NULL';
  }
  const flat = value.length > PREVIEW_CHARS ? value.slice(0, PREVIEW_CHARS) : value;
  return flat.replace(/\s+/g, ' ');
}
