// Copying text goes through the host. The webview's own clipboard API depends
// on focus and on how the platform webview treats the app's origin, so the
// host does it instead, the same way on every platform.

import { invoke } from '@tauri-apps/api/core';

/** Copies text to the system clipboard. Resolves to false if it could not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await invoke('clipboard_write_text', { text });
    return true;
  } catch {
    return false;
  }
}
