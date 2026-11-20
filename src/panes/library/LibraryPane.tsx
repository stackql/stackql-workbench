import { useEffect, useMemo, useState } from 'react';
import { host, toHostError, type LibraryDocument, type LibraryEntry } from '../../host';
import {
  editorText,
  filterEntries,
  groupEntries,
  missingProviders,
  placeholders,
} from '../../lib/library';
import type { LibraryState } from '../../state/useLibrary';
import { IconButton } from '../../ui/IconButton';
import { OpenInEditor, Refresh, Search, Spinner } from '../../ui/icons';
import { AssistantText } from '../chat/AssistantText';

interface LibraryPaneProps {
  library: LibraryState;
  /** The names of the providers that are installed. */
  installed: string[];
  /** Opens a statement in a new editor tab. Nothing runs. */
  onOpenStatement: (sql: string) => void;
  /** Opens the list of providers the registry offers. */
  onAddProvider: () => void;
}

type Loaded =
  | { id: string; status: 'loading' }
  | { id: string; status: 'loaded'; document: LibraryDocument }
  | { id: string; status: 'error'; message: string };

/**
 * The query library: statements that are known to work, grouped by what
 * they are for. A statement is opened in the editor. Nothing here runs one.
 */
export function LibraryPane({
  library,
  installed,
  onOpenStatement,
  onAddProvider,
}: LibraryPaneProps) {
  const [search, setSearch] = useState('');
  const [installedOnly, setInstalledOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const installedSet = useMemo(() => new Set(installed), [installed]);
  const entries = useMemo(() => library.index?.entries ?? [], [library.index]);
  const shown = useMemo(
    () => filterEntries(entries, { search, installed: installedSet, installedOnly }),
    [entries, search, installedSet, installedOnly],
  );
  const groups = useMemo(() => groupEntries(shown), [shown]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    let active = true;
    host.library.document(selectedId).then(
      (document) => {
        if (active) {
          setLoaded({ id: selectedId, status: 'loaded', document });
        }
      },
      (reason: unknown) => {
        if (active) {
          setLoaded({ id: selectedId, status: 'error', message: toHostError(reason).message });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [selectedId]);

  // What is on hand for the entry in view. Anything else is still loading.
  const current: Loaded | null =
    selectedId === null
      ? null
      : loaded?.id === selectedId
        ? loaded
        : { id: selectedId, status: 'loading' };

  return (
    <div className="flex h-full min-h-0 bg-surface-alt">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2">
          <span className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
            Query library
          </span>
          <span className="flex items-center gap-1">
            {library.loading && <Spinner className="text-ink-muted" />}
            <IconButton label="Fetch the library again" onClick={library.refresh}>
              <Refresh />
            </IconButton>
          </span>
        </div>

        <div className="shrink-0 border-b border-line px-2 py-1.5">
          <div className="flex h-6 items-center gap-1 rounded border border-line bg-surface px-1.5 focus-within:border-accent">
            <Search className="shrink-0 text-ink-muted" />
            <input
              type="text"
              spellCheck={false}
              aria-label="Search the library"
              className="selectable h-full min-w-0 flex-1 bg-transparent outline-none"
              placeholder="Search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearch('');
                }
              }}
            />
          </div>
          <label className="mt-1.5 flex items-center gap-1.5 text-ink-muted">
            <input
              type="checkbox"
              checked={installedOnly}
              onChange={(event) => {
                setInstalledOnly(event.target.checked);
              }}
            />
            Installed providers only
            <span className="flex-1" />
            <span className="tabular-nums" role="status">
              {shown.length} of {entries.length}
            </span>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-surface py-1">
          {library.index === null ? (
            <p className="px-3 py-2 text-ink-muted">
              {library.error ? (
                <span className="selectable text-danger">{library.error}</span>
              ) : (
                'Fetching the library'
              )}
            </p>
          ) : (
            <>
              {library.index.fromCache && (
                <p className="px-3 py-1 text-[12px] text-warn">
                  The library could not be reached. This is the copy kept from an earlier time.
                </p>
              )}
              {groups.length === 0 && (
                <p className="px-3 py-2 text-ink-muted">
                  {entries.length === 0
                    ? 'The library has no entries.'
                    : installedOnly && search.trim() === ''
                      ? 'The library has nothing for the providers that are installed. Untick the box to see all of it.'
                      : 'Nothing matches.'}
                </p>
              )}
              {groups.map((group) => (
                <div key={group.useCase.key} role="group" aria-label={group.useCase.label}>
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                    {group.useCase.label}
                    <span className="ml-1 font-normal tabular-nums">{group.entries.length}</span>
                  </div>
                  {group.entries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      selected={entry.id === selectedId}
                      missing={missingProviders(entry, installedSet)}
                      onSelect={() => {
                        setSelectedId(entry.id);
                      }}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-auto bg-surface">
        {selected === null || current === null ? (
          <p className="px-4 py-3 text-ink-muted">
            Choose an entry to see what it does and its statement. Opening one puts the statement in
            a new editor tab. It runs when you run it.
          </p>
        ) : (
          <Detail
            entry={selected}
            loaded={current}
            missing={missingProviders(selected, installedSet)}
            onOpenStatement={onOpenStatement}
            onAddProvider={onAddProvider}
          />
        )}
      </div>
    </div>
  );
}

interface EntryRowProps {
  entry: LibraryEntry;
  selected: boolean;
  /** Providers the entry names that are not installed. */
  missing: string[];
  onSelect: () => void;
}

function EntryRow({ entry, selected, missing, onSelect }: EntryRowProps) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      title={entry.description}
      className={`flex w-full flex-col items-start gap-0.5 px-3 py-1 text-left hover:bg-surface-sunken ${
        selected ? 'bg-surface-sunken shadow-[inset_2px_0_0_var(--color-accent)]' : ''
      }`}
      onClick={onSelect}
    >
      <span className="w-full truncate">{entry.title}</span>
      <span className="flex w-full items-center gap-1.5 text-[11px] text-ink-muted">
        <span className="truncate font-mono">{entry.providers.join(', ')}</span>
        {missing.length > 0 && <Tag text="not installed" />}
        {entry.mutation && <Tag text="mutation" tone="warn" />}
        {entry.status !== '' && entry.status !== 'stable' && <Tag text={entry.status} />}
      </span>
    </button>
  );
}

function Tag({ text, tone }: { text: string; tone?: 'warn' }) {
  return (
    <span
      className={`shrink-0 rounded-sm border px-1 text-[10px] ${
        tone === 'warn' ? 'border-warn text-warn' : 'border-line text-ink-muted'
      }`}
    >
      {text}
    </span>
  );
}

interface DetailProps {
  entry: LibraryEntry;
  loaded: Loaded;
  missing: string[];
  onOpenStatement: (sql: string) => void;
  onAddProvider: () => void;
}

function Detail({ entry, loaded, missing, onOpenStatement, onAddProvider }: DetailProps) {
  const statement = loaded.status === 'loaded' ? loaded.document.statement : null;
  const names = statement === null ? entry.requiredParams : placeholders(statement);
  const open = (sql: string) => {
    onOpenStatement(editorText(entry, sql));
  };

  return (
    <div className="mx-auto max-w-[860px] px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[17px] font-semibold">{entry.title}</h2>
          <p className="selectable mt-1 mb-0 text-ink-muted">{entry.description}</p>
        </div>
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded bg-brand px-3 font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
          disabled={statement === null}
          title="Puts the statement in a new editor tab. It runs when you run it."
          onClick={() => {
            if (statement !== null) {
              open(statement);
            }
          }}
        >
          <OpenInEditor />
          Open in editor
        </button>
      </div>

      <dl className="mt-3 mb-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-ink-muted">Entry</dt>
        <dd className="selectable m-0 font-mono">{entry.id}</dd>
        <dt className="text-ink-muted">Providers</dt>
        <dd className="m-0 font-mono">{entry.providers.join(', ')}</dd>
        {names.length > 0 && (
          <>
            <dt className="text-ink-muted">To fill in</dt>
            <dd className="m-0 font-mono">{names.join(', ')}</dd>
          </>
        )}
        <dt className="text-ink-muted">Kind</dt>
        <dd className="m-0">
          {entry.mutation ? 'Mutation, as the library marks it' : entry.verb || 'Not stated'}
          {entry.status !== '' && `, ${entry.status}`}
        </dd>
      </dl>

      {missing.length > 0 && (
        <p className="mt-3 mb-0 flex items-center gap-2 rounded border border-line bg-surface-alt px-2 py-1.5">
          <span className="min-w-0 flex-1">
            This needs <span className="font-mono">{missing.join(', ')}</span>, which{' '}
            {missing.length === 1 ? 'is' : 'are'} not installed.
          </span>
          <button
            type="button"
            className="h-6 shrink-0 rounded border border-line bg-surface px-2 hover:bg-surface-sunken"
            onClick={onAddProvider}
          >
            Add provider
          </button>
        </p>
      )}

      <div className="mt-4 border-t border-line pt-3">
        {loaded.status === 'loading' && (
          <p className="flex items-center gap-2 text-ink-muted">
            <Spinner /> Fetching the entry
          </p>
        )}
        {loaded.status === 'error' && <p className="selectable text-danger">{loaded.message}</p>}
        {loaded.status === 'loaded' && (
          <AssistantText text={loaded.document.markdown} onOpenInEditor={open} />
        )}
      </div>
    </div>
  );
}
