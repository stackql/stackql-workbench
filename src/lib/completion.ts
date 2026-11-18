// Completion for the editor, from what the explorer has already loaded.
// Nothing here asks the engine for anything, so a keystroke costs nothing.
// A level that has not been opened in the explorer offers no names.

import type { ChildState, TreeNode } from './explorerTree';

export interface FieldInfo {
  name: string;
  type: string;
}

/** The names the explorer holds. A lookup is null when that level is not loaded. */
export interface Catalog {
  providers: string[];
  services: (provider: string) => string[] | null;
  resources: (provider: string, service: string) => string[] | null;
  fields: (provider: string, service: string, resource: string) => FieldInfo[] | null;
}

export const EMPTY_CATALOG: Catalog = {
  providers: [],
  services: () => null,
  resources: () => null,
  fields: () => null,
};

/** Reads the explorer's loaded nodes as a catalog. */
export function catalogFrom(roots: TreeNode[], children: ReadonlyMap<string, ChildState>): Catalog {
  const loaded = (id: string): TreeNode[] | null => {
    const state = children.get(id);
    return state?.status === 'loaded' ? state.nodes : null;
  };
  return {
    providers: roots.map((root) => root.label),
    services: (provider) => loaded(`p:${provider}`)?.map((node) => node.label) ?? null,
    resources: (provider, service) =>
      loaded(`s:${provider}.${service}`)?.map((node) => node.label) ?? null,
    fields: (provider, service, resource) => {
      const name = `${provider}.${service}.${resource}`;
      const found = new Map<string, FieldInfo>();
      for (const node of loaded(`fg:${name}`) ?? []) {
        found.set(node.label, { name: node.label, type: node.detail });
      }
      // What a method takes and returns counts too, where it has been opened.
      for (const method of loaded(`mg:${name}`) ?? []) {
        for (const group of loaded(method.id) ?? []) {
          for (const param of group.children ?? []) {
            if (!found.has(param.label)) {
              found.set(param.label, { name: param.label, type: param.detail });
            }
          }
        }
      }
      return found.size > 0 ? [...found.values()] : null;
    },
  };
}

export interface Suggestion {
  label: string;
  kind: 'provider' | 'service' | 'resource' | 'field';
  /** Shown beside the label: what it is, or a field's type. */
  detail: string;
}

export interface Suggestions {
  /** How many characters before the cursor the chosen option replaces. */
  replace: number;
  options: Suggestion[];
}

/** The statement the cursor is in, and the part of it before the cursor. */
export function currentStatement(
  text: string,
  cursor: number,
): { before: string; statement: string } {
  const start = text.lastIndexOf(';', cursor - 1) + 1;
  const next = text.indexOf(';', cursor);
  return {
    before: text.slice(start, cursor),
    statement: text.slice(start, next === -1 ? text.length : next),
  };
}

const PART = String.raw`(?:"[^"]*"|[A-Za-z_][\w-]*)`;
const TABLE = new RegExp(
  String.raw`\b(?:from|join|into|update)\s+(${PART})\.(${PART})\.(${PART})`,
  'gi',
);
const unquote = (part: string) => part.replace(/^"/, '').replace(/"$/, '');

/** Keywords that are followed by the name of a provider, service or resource. */
const BEFORE_A_NAME = new Set(['from', 'join', 'into', 'update', 'describe', 'desc', 'exec']);

function inStringOrComment(before: string): boolean {
  let quotes = 0;
  for (const character of before) {
    if (character === "'") {
      quotes += 1;
    }
  }
  if (quotes % 2 === 1) {
    return true;
  }
  const line = before.slice(before.lastIndexOf('\n') + 1);
  return line.replace(/'[^']*'/g, '').includes('--');
}

function expectsName(head: string, statement: string): boolean {
  const last = /([A-Za-z_]+)\s*$/.exec(head)?.[1]?.toLowerCase() ?? '';
  const prior = /([A-Za-z_]+)\s+[A-Za-z_]+\s*$/.exec(head)?.[1]?.toLowerCase() ?? '';
  if (BEFORE_A_NAME.has(last)) {
    return true;
  }
  if ((last === 'extended' || last === 'method') && (prior === 'describe' || prior === 'desc')) {
    return true;
  }
  // SHOW SERVICES IN provider, and the like. Not the IN of a WHERE clause.
  return last === 'in' && /^\s*show\b/i.test(statement);
}

/**
 * What to offer at the cursor. `before` is the statement up to the cursor
 * and `statement` is all of it. `explicit` is true when the operator asked
 * for completion, as opposed to it starting while they type.
 *
 * After a keyword that takes a name, and after a dot, the next level of
 * the provider hierarchy is offered. Elsewhere the fields of the resources
 * the statement names are offered. Null means there is nothing to add to
 * the keywords.
 */
export function suggest(
  catalog: Catalog,
  before: string,
  statement: string,
  explicit: boolean,
): Suggestions | null {
  if (inStringOrComment(before)) {
    return null;
  }
  const word = /[\w".-]*$/.exec(before)?.[0] ?? '';
  const parts = word.split('.');
  const last = parts[parts.length - 1] ?? '';
  const names = parts.slice(0, -1).map(unquote);
  const named = expectsName(before.slice(0, before.length - word.length), statement);
  const first = names[0];

  if (named || (first !== undefined && catalog.providers.includes(first))) {
    const [provider, service] = names;
    const level: [string[] | null, Suggestion['kind']] =
      provider === undefined
        ? [catalog.providers, 'provider']
        : service === undefined
          ? [catalog.services(provider), 'service']
          : names.length === 2
            ? [catalog.resources(provider, service), 'resource']
            : [null, 'resource'];
    const [labels, kind] = level;
    if (labels === null || labels.length === 0) {
      return null;
    }
    return {
      replace: last.length,
      options: [...labels].sort().map((label) => ({ label, kind, detail: kind })),
    };
  }

  // A column, perhaps after an alias and a dot.
  if (last === '' && names.length === 0 && !explicit) {
    return null;
  }
  const fields = new Map<string, FieldInfo>();
  for (const match of statement.matchAll(TABLE)) {
    const [provider, service, resource] = match.slice(1).map((part) => unquote(part));
    if (provider === undefined || service === undefined || resource === undefined) {
      continue;
    }
    for (const field of catalog.fields(provider, service, resource) ?? []) {
      if (!fields.has(field.name)) {
        fields.set(field.name, field);
      }
    }
  }
  if (fields.size === 0) {
    return null;
  }
  return {
    replace: last.length,
    options: [...fields.values()].map((field) => ({
      label: field.name,
      kind: 'field',
      detail: field.type,
    })),
  };
}

/**
 * What an empty editor shows: a commented statement that runs against an
 * installed provider, or against the registry when nothing is installed.
 */
export function sampleStatement(providers: string[]): string {
  const provider = [...providers].sort()[0];
  if (provider === undefined) {
    return [
      '-- No provider is installed yet. This lists what the registry offers:',
      '-- REGISTRY LIST;',
    ].join('\n');
  }
  return [
    '-- A statement to start from:',
    `-- SHOW SERVICES IN ${provider};`,
    '-- Or right-click a resource in the explorer and choose Generate SELECT.',
  ].join('\n');
}
