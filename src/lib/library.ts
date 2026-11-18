// The query library as the operator sees it: entries grouped by use case,
// narrowed to the providers that are installed, and searched. The entries
// and everything said about them come from the library's own index.

import type { LibraryEntry } from '../host/types';

export interface UseCase {
  key: string;
  label: string;
}

/**
 * The use cases entries are listed under, in the order they are shown, with
 * the library tags that name each.
 */
const USE_CASES: (UseCase & { tags: string[] })[] = [
  { key: 'security', label: 'Security', tags: ['security', 'cspm', 'compliance'] },
  { key: 'analytics', label: 'Analytics', tags: ['analytics'] },
  { key: 'inventory', label: 'Inventory', tags: ['inventory'] },
  {
    key: 'lifecycle',
    label: 'Lifecycle and operations',
    tags: ['lifecycle', 'provisioning', 'operations', 'mutation', 'bootstrap'],
  },
  { key: 'reference', label: 'Reference', tags: ['reference'] },
];
const OTHER: UseCase = { key: 'other', label: 'Other' };

/** The use case an entry is listed under: the first of its tags that names one. */
export function entryUseCase(entry: LibraryEntry): UseCase {
  for (const tag of entry.tags) {
    const found = USE_CASES.find((useCase) => useCase.tags.includes(tag));
    if (found) {
      return { key: found.key, label: found.label };
    }
  }
  return OTHER;
}

/** Whether every provider an entry names is installed. */
export function usable(entry: LibraryEntry, installed: ReadonlySet<string>): boolean {
  return entry.providers.length > 0 && entry.providers.every((name) => installed.has(name));
}

/** The providers an entry names that are not installed. */
export function missingProviders(entry: LibraryEntry, installed: ReadonlySet<string>): string[] {
  return entry.providers.filter((name) => !installed.has(name));
}

export interface LibraryFilter {
  /** Words that must all appear in an entry. */
  search: string;
  installed: ReadonlySet<string>;
  /** Leave out entries for providers that are not installed. */
  installedOnly: boolean;
}

function haystack(entry: LibraryEntry): string {
  return [
    entry.id,
    entry.title,
    entry.description,
    ...entry.providers,
    ...entry.services,
    ...entry.tags,
    ...entry.keywords,
    ...entry.intentKeywords,
  ]
    .join('\n')
    .toLowerCase();
}

export function filterEntries(entries: LibraryEntry[], filter: LibraryFilter): LibraryEntry[] {
  const words = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (filter.installedOnly && !usable(entry, filter.installed)) {
      return false;
    }
    if (words.length === 0) {
      return true;
    }
    const text = haystack(entry);
    return words.every((word) => text.includes(word));
  });
}

export interface LibraryGroup {
  useCase: UseCase;
  entries: LibraryEntry[];
}

/** Entries under their use case, each group by provider and then title. */
export function groupEntries(entries: LibraryEntry[]): LibraryGroup[] {
  const groups = new Map<string, LibraryGroup>();
  for (const entry of entries) {
    const useCase = entryUseCase(entry);
    const group = groups.get(useCase.key) ?? { useCase, entries: [] };
    group.entries.push(entry);
    groups.set(useCase.key, group);
  }
  const order = [...USE_CASES.map((useCase) => useCase.key), OTHER.key];
  return order.flatMap((key) => {
    const group = groups.get(key);
    if (!group) {
      return [];
    }
    group.entries.sort(
      (a, b) =>
        (a.providers[0] ?? '').localeCompare(b.providers[0] ?? '') ||
        a.title.localeCompare(b.title),
    );
    return [group];
  });
}

/** The names a template asks for, written `{{name}}`, each once and in order. */
export function placeholders(statement: string): string[] {
  const names: string[] = [];
  for (const match of statement.matchAll(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * What goes in the editor for an entry's statement: where it came from,
 * what has to be filled in, and the statement as the library has it.
 */
export function editorText(entry: Pick<LibraryEntry, 'id' | 'title'>, statement: string): string {
  const names = placeholders(statement);
  return [
    `-- ${entry.title} (query library: ${entry.id})`,
    ...(names.length > 0 ? [`-- Replace each {{name}} before running: ${names.join(', ')}.`] : []),
    statement.trim(),
    '',
  ].join('\n');
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Things to ask, taken from library entries that can run here: stable,
 * read-only, and for installed providers. Entries that need nothing filled
 * in come first, and each provider is used once before any is used twice.
 */
export function librarySuggestions(
  entries: LibraryEntry[],
  installed: ReadonlySet<string>,
  limit: number,
): string[] {
  const candidates = entries
    .filter(
      (entry) =>
        usable(entry, installed) &&
        entry.status === 'stable' &&
        !entry.mutation &&
        (entry.intentKeywords[0] ?? '') !== '',
    )
    .map((entry, position) => ({ entry, position }))
    .sort(
      (a, b) =>
        a.entry.requiredParams.length - b.entry.requiredParams.length || a.position - b.position,
    )
    .map(({ entry }) => entry);

  const picked: LibraryEntry[] = [];
  const used = new Set<string>();
  for (const pass of [true, false]) {
    for (const entry of candidates) {
      if (picked.length >= limit) {
        break;
      }
      const provider = entry.providers[0] ?? '';
      if (picked.includes(entry) || (pass && used.has(provider))) {
        continue;
      }
      picked.push(entry);
      used.add(provider);
    }
  }
  return picked.map((entry) => sentence(entry.intentKeywords[0] ?? ''));
}

/** A question about what is installed. It needs no credentials and no library. */
export const METADATA_SUGGESTION = 'Which providers are installed?';

/** What is offered when the library has nothing for the installed providers. */
export const FALLBACK_SUGGESTIONS = [
  METADATA_SUGGESTION,
  'What providers can I install from the registry?',
  'What can I query in the github provider?',
];

/** The chips under an empty chat: one about metadata, the rest from the library. */
export function chatSuggestions(entries: LibraryEntry[], installed: ReadonlySet<string>): string[] {
  const fromLibrary = librarySuggestions(entries, installed, 2);
  return fromLibrary.length > 0 ? [METADATA_SUGGESTION, ...fromLibrary] : FALLBACK_SUGGESTIONS;
}
