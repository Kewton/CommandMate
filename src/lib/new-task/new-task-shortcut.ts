/**
 * New task keyboard bindings (Issue #3511).
 *
 * - Mod+Shift+O opens the dialog from any screen under the shell. The same
 *   chord ChatGPT uses for "New chat", and free in this app: the registered
 *   chords are Mod+K / Mod+F / Mod+S / Mod+Shift+M / Mod+Shift+F /
 *   Mod+Shift+Enter / Ctrl+M (`src/config/keyboard-shortcuts.ts`).
 * - Mod+Enter sends from inside the dialog. Plain Enter stays a newline in the
 *   request field, so a multi-line request never goes out half-written.
 *
 * The rows are listed in the `?` overlay next to the central registry's
 * (`KeyboardShortcutsOverlay`).
 */

import { MOD_KEY_TOKEN, type KeyboardShortcut } from '@/config/keyboard-shortcuts';

/** The two New task rows the `?` overlay lists. */
export const NEW_TASK_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: 'newTask', keys: [MOD_KEY_TOKEN, 'Shift', 'O'], scope: 'global' },
  { id: 'newTaskSend', keys: [MOD_KEY_TOKEN, '↵'], scope: 'global' },
] as const;

type ChordEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'
>;

/** IME composition: keydown fires with isComposing / keyCode 229 mid-convert. */
function isComposingEvent(event: ChordEvent): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** Mod+Shift+O — opens the New task dialog. */
export function isOpenNewTaskChord(event: ChordEvent): boolean {
  if (isComposingEvent(event)) return false;
  if (!event.shiftKey || event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  // `code` covers keyboard layouts whose O key does not produce a Latin "o".
  return event.key.toLowerCase() === 'o' || event.code === 'KeyO';
}

/** Mod+Enter (without Shift / Alt) — sends from the dialog. */
export function isSendNewTaskChord(event: ChordEvent): boolean {
  if (isComposingEvent(event)) return false;
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return false;
  return event.metaKey || event.ctrlKey;
}
