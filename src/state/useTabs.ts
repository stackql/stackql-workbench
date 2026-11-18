import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateTab,
  addTab,
  closeTab,
  restoreTabs,
  saveTabs,
  stateOf,
  type SavedTabs,
  type Tab,
} from '../lib/tabs';
import type { EditorHandle } from '../panes/editor/Editor';

const TABS_KEY = 'workbench.editor.tabs';
/** Where the single buffer was kept before there were tabs. */
const LEGACY_TEXT_KEY = 'workbench.editor.text';
const SAVE_DELAY_MS = 300;

function load(welcome: string): SavedTabs {
  try {
    const legacy = window.localStorage.getItem(LEGACY_TEXT_KEY);
    return restoreTabs(window.localStorage.getItem(TABS_KEY), legacy ?? welcome);
  } catch {
    return restoreTabs(null, welcome);
  }
}

export interface Tabs {
  tabs: Tab[];
  activeId: string;
  /** The text each tab's editor starts with. */
  initialText: (id: string) => string;
  /** The editor of the tab in front. */
  active: () => EditorHandle | undefined;
  /** Opens a new tab holding `text` and brings it to the front. */
  open: (text?: string) => void;
  close: (id: string) => void;
  activate: (id: string) => void;
  /** Gives the hook a tab's editor, or takes it away when it unmounts. */
  register: (id: string, handle: EditorHandle | null) => void;
  changed: (id: string, text: string) => void;
}

/** The editor's tabs. The text of each is kept in step with storage. */
export function useTabs(welcome: string): Tabs {
  const [saved] = useState(() => load(welcome));
  const [state, setState] = useState(() => stateOf(saved));
  // Text changes on every keystroke. It is kept out of React state so that
  // typing does not redraw the app.
  const texts = useRef(new Map(saved.tabs.map((tab) => [tab.id, tab.text])));
  const editors = useRef(new Map<string, EditorHandle>());
  const stateRef = useRef(state);
  const timer = useRef<number | undefined>(undefined);

  const persist = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          TABS_KEY,
          saveTabs(stateRef.current, (id) => texts.current.get(id) ?? ''),
        );
      } catch {
        // Storage is a convenience. Losing it is not worth interrupting anyone.
      }
    }, SAVE_DELAY_MS);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    persist();
  }, [state, persist]);

  const open = useCallback((text = '') => {
    setState((current) => {
      const next = addTab(current, text);
      texts.current.set(next.id, text);
      return next.state;
    });
  }, []);

  const close = useCallback((id: string) => {
    texts.current.delete(id);
    setState((current) => closeTab(current, id));
  }, []);

  const activate = useCallback((id: string) => {
    setState((current) => activateTab(current, id));
  }, []);

  const register = useCallback((id: string, handle: EditorHandle | null) => {
    if (handle) {
      editors.current.set(id, handle);
    } else {
      editors.current.delete(id);
    }
  }, []);

  const changed = useCallback(
    (id: string, text: string) => {
      texts.current.set(id, text);
      persist();
    },
    [persist],
  );

  const initialText = useCallback((id: string) => texts.current.get(id) ?? '', []);
  const active = useCallback(() => editors.current.get(stateRef.current.activeId), []);

  return {
    tabs: state.tabs,
    activeId: state.activeId,
    initialText,
    active,
    open,
    close,
    activate,
    register,
    changed,
  };
}
