// Editor tabs: which buffers are open and which one is in front. Pure, so
// it can be tested. The text of a buffer lives in its editor and is only
// passed through here to be saved and restored.

export interface Tab {
  id: string;
  title: string;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string;
  /** Counter for ids and for "Query N" titles. */
  next: number;
}

/** What is written to storage: the tabs with their text. */
export interface SavedTabs {
  tabs: { id: string; title: string; text: string }[];
  activeId: string;
  next: number;
}

const TITLE_LENGTH = 28;

/** A short name for a tab: the start of its first statement, or "Query N". */
export function titleFor(text: string, number: number): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('--'));
  if (!line) {
    return `Query ${number}`;
  }
  const flat = line.replace(/\s+/g, ' ').replace(/;$/, '');
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 3).trimEnd()}...` : flat;
}

/** One tab holding `text`. The state a first run starts from. */
export function singleTab(text: string): SavedTabs {
  return { tabs: [{ id: 'tab-1', title: 'Query 1', text }], activeId: 'tab-1', next: 2 };
}

/**
 * Reads what was saved. Anything that is not the expected shape gives one
 * tab holding `fallbackText`, so a damaged entry never loses the editor.
 */
export function restoreTabs(saved: string | null, fallbackText: string): SavedTabs {
  if (saved === null) {
    return singleTab(fallbackText);
  }
  try {
    const parsed = JSON.parse(saved) as Partial<SavedTabs> | null;
    const tabs = Array.isArray(parsed?.tabs)
      ? parsed.tabs.filter(
          (tab): tab is SavedTabs['tabs'][number] =>
            typeof tab === 'object' &&
            typeof tab.id === 'string' &&
            typeof tab.title === 'string' &&
            typeof tab.text === 'string',
        )
      : [];
    if (tabs.length === 0 || new Set(tabs.map((t) => t.id)).size !== tabs.length) {
      return singleTab(fallbackText);
    }
    const activeId = tabs.some((t) => t.id === parsed?.activeId)
      ? (parsed?.activeId as string)
      : (tabs[0]?.id ?? 'tab-1');
    const next =
      typeof parsed?.next === 'number' && parsed.next > tabs.length ? parsed.next : tabs.length + 1;
    return { tabs, activeId, next };
  } catch {
    return singleTab(fallbackText);
  }
}

export function stateOf(saved: SavedTabs): TabsState {
  return {
    tabs: saved.tabs.map(({ id, title }) => ({ id, title })),
    activeId: saved.activeId,
    next: saved.next,
  };
}

/** Opens a new tab at the end and brings it to the front. Returns its id too. */
export function addTab(state: TabsState, text = ''): { state: TabsState; id: string } {
  const id = `tab-${state.next}`;
  return {
    id,
    state: {
      tabs: [...state.tabs, { id, title: titleFor(text, state.next) }],
      activeId: id,
      next: state.next + 1,
    },
  };
}

/**
 * Closes a tab. If it was in front, its neighbour comes to the front. The
 * last tab cannot be closed away: an empty one takes its place.
 */
export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return state;
  }
  const remaining = state.tabs.filter((tab) => tab.id !== id);
  if (remaining.length === 0) {
    return addTab({ ...state, tabs: [] }).state;
  }
  const activeId =
    state.activeId === id
      ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? state.activeId)
      : state.activeId;
  return { ...state, tabs: remaining, activeId };
}

export function activateTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

/** Puts the tabs and their text into the form that is saved. */
export function saveTabs(state: TabsState, text: (id: string) => string): string {
  const saved: SavedTabs = {
    tabs: state.tabs.map((tab) => ({ ...tab, text: text(tab.id) })),
    activeId: state.activeId,
    next: state.next,
  };
  return JSON.stringify(saved);
}
