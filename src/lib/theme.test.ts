import { describe, expect, it } from 'vitest';
// The tokens, read from the stylesheet the app ships.
import css from '../styles.css?raw';
import { contrastRatio, parseThemeChoice, resolveTheme } from './theme';

describe('the theme choice', () => {
  it('follows the system unless the operator chose', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('reads what was stored, and falls back to the system', () => {
    expect(parseThemeChoice('dark')).toBe('dark');
    expect(parseThemeChoice('light')).toBe('light');
    expect(parseThemeChoice('system')).toBe('system');
    expect(parseThemeChoice(null)).toBe('system');
    expect(parseThemeChoice('purple')).toBe('system');
  });
});

describe('contrastRatio', () => {
  it('matches the known values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The usual example of the lightest grey that passes AA on white.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });
});

function block(start: string): string {
  const at = css.indexOf(start);
  if (at < 0) {
    throw new Error(`No ${start} block in styles.css`);
  }
  return css.slice(at, css.indexOf('}', at));
}

function tokens(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/--([a-z][a-z0-9-]*):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    if (match[1] && match[2]) {
      found[match[1]] = match[2];
    }
  }
  return found;
}

const light = { ...tokens(block('@theme {')), ...tokens(block(':root {')) };
const dark = { ...light, ...tokens(block(":root[data-theme='dark'] {")) };

/** Text and the surfaces it is drawn on. AA asks for 4.5 to 1. */
const PAIRS: [string, string[]][] = [
  ['color-ink', ['color-surface', 'color-surface-alt', 'color-surface-sunken']],
  ['color-ink-muted', ['color-surface', 'color-surface-alt', 'color-surface-sunken']],
  ['color-accent', ['color-surface', 'color-surface-alt', 'color-surface-sunken']],
  ['color-danger', ['color-surface', 'color-surface-alt']],
  ['color-warn', ['color-surface', 'color-surface-alt']],
  ['color-ok', ['color-surface', 'color-surface-alt']],
  ['color-on-brand', ['color-brand', 'color-brand-dark', 'color-brand-light']],
  ['syntax-keyword', ['color-surface']],
  ['syntax-string', ['color-surface']],
  ['syntax-number', ['color-surface']],
  ['syntax-comment', ['color-surface']],
  ['syntax-type', ['color-surface']],
  ['syntax-func', ['color-surface']],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('the %s theme', (_name, theme) => {
  it('defines every token the pairs name', () => {
    for (const [text, surfaces] of PAIRS) {
      for (const token of [text, ...surfaces]) {
        expect(theme[token], token).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it.each(PAIRS.flatMap(([text, surfaces]) => surfaces.map((surface) => [text, surface])))(
    'draws %s on %s at 4.5 to 1 or better',
    (text, surface) => {
      const ratio = contrastRatio(theme[text] ?? '', theme[surface] ?? '');
      expect(
        ratio,
        `${theme[text]} on ${theme[surface]} is ${ratio.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});

/** The series of a chart, in their fixed order. */
const CHART = Array.from({ length: 8 }, (_, index) => `chart-${index + 1}`);

describe.each([
  ['light', light, 2],
  ['dark', dark, 3],
])('the chart colours of the %s theme', (_name, theme, floor) => {
  it('are eight, each of them different', () => {
    const values = CHART.map((token) => theme[token]?.toLowerCase());
    for (const value of values) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(values).size).toBe(CHART.length);
  });

  // A mark is not text, so the bar is lower than for ink. The light theme
  // has three steps under 3 to 1, which the table beside every chart is
  // there to make up for. None may fade into the surface.
  it.each(CHART)(`draws %s on the surface at ${floor} to 1 or better`, (token) => {
    const ratio = contrastRatio(theme[token] ?? '', theme['color-surface'] ?? '');
    expect(ratio, `${theme[token]} is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(floor);
  });
});

describe('the brand colour', () => {
  it('is Classic Blue in both themes, with no second blue beside it', () => {
    expect(light['color-brand']?.toLowerCase()).toBe('#0f4c81');
    expect(dark['color-brand']?.toLowerCase()).toBe('#0f4c81');
  });
});
