import { describe, expect, it } from 'vitest';
import { MENUS, commandForKey, shortcutLabel, type KeyPress } from './menu';

const press = (key: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('the menus', () => {
  it('are File, Edit, View, Query, Providers and Help', () => {
    expect(MENUS.map((menu) => menu.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Query',
      'Providers',
      'Help',
    ]);
  });

  it('say that reloading credentials restarts the engine', () => {
    const labels = MENUS.flatMap((menu) =>
      menu.entries.flatMap((entry) =>
        entry.kind === 'command' && entry.id === 'reloadCredentials' ? [entry.label] : [],
      ),
    );
    expect(labels).toEqual(['Reload Credentials (Restarts the Engine)']);
  });

  it('list each command once', () => {
    const ids = MENUS.flatMap((menu) =>
      menu.entries.flatMap((entry) => (entry.kind === 'command' ? [entry.id] : [])),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('give no two commands the same key', () => {
    const keys = MENUS.flatMap((menu) =>
      menu.entries.flatMap((entry) =>
        entry.kind === 'command' && entry.shortcut
          ? [`${entry.shortcut.shift ? 'shift+' : ''}${entry.shortcut.key}`]
          : [],
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never start or end with a separator, or have two in a row', () => {
    for (const menu of MENUS) {
      const kinds = menu.entries.map((entry) => entry.kind);
      expect(kinds[0]).toBe('command');
      expect(kinds[kinds.length - 1]).toBe('command');
      kinds.forEach((kind, index) => {
        if (kind === 'separator') {
          expect(kinds[index + 1]).toBe('command');
        }
      });
    }
  });
});

describe('shortcutLabel', () => {
  it('names the modifier for the platform', () => {
    expect(shortcutLabel({ key: 'n' }, false)).toBe('Ctrl+N');
    expect(shortcutLabel({ key: 'n' }, true)).toBe('Cmd+N');
    expect(shortcutLabel({ key: ',' }, false)).toBe('Ctrl+,');
    expect(shortcutLabel({ key: 'p', shift: true }, false)).toBe('Ctrl+Shift+P');
    expect(shortcutLabel({ key: 'Enter' }, false)).toBe('Ctrl+Enter');
    expect(shortcutLabel({ key: 'Enter', shift: true }, true)).toBe('Cmd+Shift+Enter');
  });
});

describe('commandForKey', () => {
  it('maps the app shortcuts on Windows', () => {
    expect(commandForKey(press('n', { ctrlKey: true }), false)).toBe('newChat');
    expect(commandForKey(press('N', { ctrlKey: true }), false)).toBe('newChat');
    expect(commandForKey(press(',', { ctrlKey: true }), false)).toBe('openSettings');
    expect(commandForKey(press('1', { ctrlKey: true }), false)).toBe('showChat');
    expect(commandForKey(press('2', { ctrlKey: true }), false)).toBe('showExplorer');
    expect(commandForKey(press('3', { ctrlKey: true }), false)).toBe('showActivity');
    expect(commandForKey(press('b', { ctrlKey: true }), false)).toBe('toggleSidebar');
    expect(commandForKey(press('t', { ctrlKey: true }), false)).toBe('newTab');
    expect(commandForKey(press('p', { ctrlKey: true }), false)).toBe('goToResource');
  });

  it('uses Cmd on macOS, not Ctrl', () => {
    expect(commandForKey(press('n', { metaKey: true }), true)).toBe('newChat');
    expect(commandForKey(press('n', { ctrlKey: true }), true)).toBeNull();
    expect(commandForKey(press('n', { metaKey: true }), false)).toBeNull();
  });

  it('leaves editing keys to the webview', () => {
    for (const key of ['z', 'y', 'x', 'c', 'a', 'v']) {
      expect(commandForKey(press(key, { ctrlKey: true }), false)).toBeNull();
    }
  });

  it('ignores plain keys and other modifier combinations', () => {
    expect(commandForKey(press('n'), false)).toBeNull();
    expect(commandForKey(press('n', { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(commandForKey(press('n', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    // Running is the editor's key. It is listed in the menu and left to the editor.
    expect(commandForKey(press('Enter', { ctrlKey: true }), false)).toBeNull();
    expect(commandForKey(press('Enter', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });
});
