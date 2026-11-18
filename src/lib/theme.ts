// Which theme the app shows, and the contrast between two colours.
// The colours themselves are tokens in src/styles.css.

/** What the operator chose under View. */
export type ThemeChoice = 'system' | 'light' | 'dark';
/** What is drawn. */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'workbench.theme';

/** Reads a stored choice. Anything unknown follows the system. */
export function parseThemeChoice(stored: string | null): ThemeChoice {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** The theme to draw: the operator's choice, or the system's when they left it alone. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === 'system') {
    return systemDark ? 'dark' : 'light';
  }
  return choice;
}

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) {
    throw new Error(`Not a six digit colour: ${hex}`);
  }
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Relative luminance, as WCAG 2 defines it. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const share = channel / 255;
    return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The WCAG 2 contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
