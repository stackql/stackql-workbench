import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  THEME_KEY,
  parseThemeChoice,
  resolveTheme,
  type Theme,
  type ThemeChoice,
} from '../lib/theme';

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

function storedChoice(): ThemeChoice {
  try {
    return parseThemeChoice(window.localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Puts the theme on the root element, where the stylesheet looks for it. */
function show(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Shows the right theme before the app draws, so it does not flash the other one. */
export function applyStoredTheme() {
  show(resolveTheme(storedChoice(), window.matchMedia(SYSTEM_DARK).matches));
}

function watchSystem(changed: () => void) {
  const query = window.matchMedia(SYSTEM_DARK);
  query.addEventListener('change', changed);
  return () => {
    query.removeEventListener('change', changed);
  };
}

export interface ThemeControl {
  /** What the operator chose. */
  choice: ThemeChoice;
  /** What is drawn. */
  theme: Theme;
  setChoice: (choice: ThemeChoice) => void;
}

/** The theme: the system's, unless the operator chose one under View. */
export function useTheme(): ThemeControl {
  const [choice, setStored] = useState(storedChoice);
  const systemDark = useSyncExternalStore(
    watchSystem,
    () => window.matchMedia(SYSTEM_DARK).matches,
  );
  const theme = resolveTheme(choice, systemDark);

  useEffect(() => {
    show(theme);
  }, [theme]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setStored(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice then lasts until the app closes.
    }
  }, []);

  return { choice, theme, setChoice };
}
