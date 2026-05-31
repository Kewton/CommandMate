/**
 * Test helpers for Issue #728 terminal-splits (Vitest + jsdom)
 *
 * Centralizes localStorage seeding utilities so that hook and component
 * tests don't have to know the storage-key shape.
 */

import {
  getTerminalSplitsStorageKey,
  type TerminalSplitConfig,
} from '@/config/terminal-split-config';

/** Legacy MessageInput draft key prefix (pre-#728). */
const LEGACY_DRAFT_KEY_PREFIX = 'commandmate:draft-message:';

/** Seed a terminal-splits localStorage entry for a given worktreeId. */
export function mockTerminalSplitsLocalStorage(
  worktreeId: string,
  state: unknown,
): void {
  window.localStorage.setItem(
    getTerminalSplitsStorageKey(worktreeId),
    typeof state === 'string' ? state : JSON.stringify(state),
  );
}

/** Read back a terminal-splits localStorage entry as a parsed config (or null). */
export function readTerminalSplitsLocalStorage(
  worktreeId: string,
): TerminalSplitConfig | null {
  const raw = window.localStorage.getItem(getTerminalSplitsStorageKey(worktreeId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TerminalSplitConfig;
  } catch {
    return null;
  }
}

/** Seed the legacy (pre-#728) draft key for MessageInput migration tests. */
export function seedLegacyDraftKey(worktreeId: string, value: string): void {
  window.localStorage.setItem(`${LEGACY_DRAFT_KEY_PREFIX}${worktreeId}`, value);
}

/** Read the legacy draft key (used to assert it gets deleted after migration). */
export function readLegacyDraftKey(worktreeId: string): string | null {
  return window.localStorage.getItem(`${LEGACY_DRAFT_KEY_PREFIX}${worktreeId}`);
}

/** Clear every terminal-splits / legacy-draft localStorage entry. */
export function clearTerminalSplitsLocalStorage(): void {
  // jsdom localStorage; iterate keys defensively.
  const toRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    if (
      key.startsWith('commandmate:terminalSplits:') ||
      key.startsWith('commandmate:draft-message:')
    ) {
      toRemove.push(key);
    }
  }
  for (const key of toRemove) {
    window.localStorage.removeItem(key);
  }
}
