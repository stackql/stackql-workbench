// The app's commands: what the menu bar lists and which keys run them.
// Kept free of React so the mapping can be tested.

export type CommandId =
  | 'newChat'
  | 'newTab'
  | 'showChat'
  | 'showExplorer'
  | 'showActivity'
  | 'toggleSidebar'
  | 'openSettings'
  | 'openModelSettings'
  | 'restartEngine'
  | 'refreshExplorer'
  | 'goToResource'
  | 'themeSystem'
  | 'themeLight'
  | 'themeDark'
  | 'run'
  | 'runSelection'
  | 'addProvider'
  | 'checkUpdates'
  | 'reloadCredentials'
  | 'openDocs'
  | 'openQueryLibrary'
  | 'reportIssue'
  | 'about'
  | 'exit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'selectAll';

/** A key with the platform's command modifier: Ctrl, or Cmd on macOS. */
export interface Shortcut {
  key: string;
  shift?: boolean;
  /**
   * False for keys the webview already handles, such as Ctrl+C. They are
   * listed in the menu so they can be found, and left to the webview.
   */
  handled?: boolean;
}

export type MenuEntry =
  | {
      kind: 'command';
      id: CommandId;
      label: string;
      shortcut?: Shortcut;
      /** One of a set of which exactly one is chosen. It is drawn with a mark when it is. */
      choice?: boolean;
    }
  | { kind: 'separator' };

export interface Menu {
  label: string;
  entries: MenuEntry[];
}

const command = (id: CommandId, label: string, shortcut?: Shortcut): MenuEntry => ({
  kind: 'command',
  id,
  label,
  ...(shortcut ? { shortcut } : {}),
});
const choice = (id: CommandId, label: string): MenuEntry => ({
  kind: 'command',
  id,
  label,
  choice: true,
});
const separator: MenuEntry = { kind: 'separator' };
const native = (key: string): Shortcut => ({ key, handled: false });

export const MENUS: Menu[] = [
  {
    label: 'File',
    entries: [
      command('newChat', 'New Chat', { key: 'n' }),
      separator,
      command('openModelSettings', 'Model Backend...'),
      command('openSettings', 'Settings...', { key: ',' }),
      separator,
      command('restartEngine', 'Restart Engine'),
      separator,
      command('exit', 'Exit'),
    ],
  },
  {
    label: 'Edit',
    entries: [
      command('undo', 'Undo', native('z')),
      command('redo', 'Redo', native('y')),
      separator,
      command('cut', 'Cut', native('x')),
      command('copy', 'Copy', native('c')),
      separator,
      command('selectAll', 'Select All', native('a')),
    ],
  },
  {
    label: 'View',
    entries: [
      command('showChat', 'Chat', { key: '1' }),
      command('showExplorer', 'Explorer', { key: '2' }),
      command('showActivity', 'Activity', { key: '3' }),
      separator,
      command('goToResource', 'Go to Resource...', { key: 'p' }),
      command('refreshExplorer', 'Refresh Explorer'),
      separator,
      command('toggleSidebar', 'Toggle Sidebar', { key: 'b' }),
      separator,
      choice('themeSystem', 'Theme: Follow the System'),
      choice('themeLight', 'Theme: Light'),
      choice('themeDark', 'Theme: Dark'),
    ],
  },
  {
    label: 'Query',
    entries: [
      // The editor has these keys. They are listed here so they can be found.
      command('run', 'Run', native('Enter')),
      command('runSelection', 'Run Selection or Current Statement', {
        ...native('Enter'),
        shift: true,
      }),
      separator,
      command('newTab', 'New Tab', { key: 't' }),
    ],
  },
  {
    label: 'Providers',
    entries: [
      command('addProvider', 'Add from Registry...'),
      command('checkUpdates', 'Check for Updates'),
      separator,
      // On the operator's channel new credentials are read when the engine starts.
      command('reloadCredentials', 'Reload Credentials (Restarts the Engine)'),
    ],
  },
  {
    label: 'Help',
    entries: [
      command('openDocs', 'Documentation'),
      command('openQueryLibrary', 'Query Library'),
      command('reportIssue', 'Report an Issue'),
      separator,
      command('about', 'About StackQL Workbench'),
    ],
  },
];

/** How a shortcut is written in the menu, for example Ctrl+N or Cmd+N. */
export function shortcutLabel(shortcut: Shortcut, isMac: boolean): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return [isMac ? 'Cmd' : 'Ctrl', ...(shortcut.shift ? ['Shift'] : []), key].join('+');
}

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * The command a key press asks for, if any. Only the app's own shortcuts
 * are matched. Editing keys stay with the webview.
 */
export function commandForKey(press: KeyPress, isMac: boolean): CommandId | null {
  const modifier = isMac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (!modifier || press.altKey) {
    return null;
  }
  const key = press.key.toLowerCase();
  for (const menu of MENUS) {
    for (const entry of menu.entries) {
      if (
        entry.kind === 'command' &&
        entry.shortcut &&
        entry.shortcut.handled !== false &&
        entry.shortcut.key === key &&
        (entry.shortcut.shift ?? false) === press.shiftKey
      ) {
        return entry.id;
      }
    }
  }
  return null;
}
