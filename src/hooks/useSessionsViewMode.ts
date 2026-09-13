/**
 * useSessionsViewMode — how `/sessions` lays its worktrees out (Issue #2509).
 *
 * Two values, `list` (the pre-#2509 rows) and `tile` (chat-bearing tiles, two
 * columns), persisted in localStorage with no server round-trip. That is the
 * same shape `RepositoryTabBarModeSelector` / `SidebarContext` use for
 * `repoTabBarMode`, and for the same reason: this is a *display preference* of
 * one browser, not a property of the worktrees, so putting it on the server
 * would make one user's choice everybody's.
 *
 * The default is `list` on purpose. Tile mode mounts a live chat surface per
 * visible session; a user who has never asked for it must keep the screen they
 * had, so a missing or corrupted stored value resolves to `list` rather than to
 * whatever is newest.
 *
 * Stored as the bare string (`tile`) rather than JSON (`"tile"`) so the value is
 * readable in devtools — {@link isValidSessionsViewMode} is what makes a
 * hand-edited or stale value harmless, not the quoting.
 *
 * @module hooks/useSessionsViewMode
 */

'use client';

import { useCallback } from 'react';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';

/** The layouts `/sessions` can be in, in the order the selector renders them. */
export const SESSIONS_VIEW_MODES = ['list', 'tile'] as const;

/** One of {@link SESSIONS_VIEW_MODES}. */
export type SessionsViewMode = typeof SESSIONS_VIEW_MODES[number];

/** Back-compatible default: the rows that existed before Issue #2509. */
export const DEFAULT_SESSIONS_VIEW_MODE: SessionsViewMode = 'list';

/** localStorage key. `mcbd-` prefixed like every other preference in this app. */
export const SESSIONS_VIEW_MODE_STORAGE_KEY = 'mcbd-sessions-view-mode';

/**
 * Narrow an unknown stored value to a {@link SessionsViewMode}.
 *
 * @param value - Candidate read back from localStorage
 * @returns true when `value` is one of {@link SESSIONS_VIEW_MODES}
 */
export function isValidSessionsViewMode(value: unknown): value is SessionsViewMode {
  return typeof value === 'string'
    && (SESSIONS_VIEW_MODES as ReadonlyArray<string>).includes(value);
}

/** What {@link useSessionsViewMode} hands back. */
export interface UseSessionsViewModeReturn {
  viewMode: SessionsViewMode;
  setViewMode: (mode: SessionsViewMode) => void;
}

/**
 * Read and write the `/sessions` layout preference.
 *
 * SSR and the first client render both see {@link DEFAULT_SESSIONS_VIEW_MODE};
 * the stored value is applied in an effect, which is what keeps the markup the
 * server produced and the markup the client hydrates identical.
 *
 * @returns The current mode and a setter that also persists it
 *
 * @example
 * ```tsx
 * const { viewMode, setViewMode } = useSessionsViewMode();
 * ```
 */
export function useSessionsViewMode(): UseSessionsViewModeReturn {
  const { value, setValue } = useLocalStorageState<SessionsViewMode>({
    key: SESSIONS_VIEW_MODE_STORAGE_KEY,
    defaultValue: DEFAULT_SESSIONS_VIEW_MODE,
    validate: isValidSessionsViewMode,
    serialize: (mode) => mode,
    deserialize: (stored) => stored,
  });

  const setViewMode = useCallback(
    (mode: SessionsViewMode) => setValue(mode),
    [setValue],
  );

  return { viewMode: value, setViewMode };
}

export default useSessionsViewMode;
