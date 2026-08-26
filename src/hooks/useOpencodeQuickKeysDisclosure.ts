/**
 * useOpencodeQuickKeysDisclosure Hook (Issue #2106)
 *
 * Owns the persisted open/closed state of the mobile opencode quick-keys strip
 * ({@link OpencodeQuickKeys} in `collapsible` mode).
 *
 * ## Why the strip needed a disclosure at all
 *
 * #2046 put seventeen 44px targets under the phone's terminal. Measured in a
 * real browser (`tests/e2e/mobile-opencode-quick-keys-2106.spec.ts`), that strip
 * wraps to SEVEN rows and occupies **378px** at both 390x730 and 360x640 — which
 * left the terminal 40px at 390x730 and **0px** at 360x640. The Issue's paper
 * estimate was ~265px for the strip and ~140px left for the terminal; the real
 * numbers are worse, and at the narrow width the terminal is not merely small
 * but entirely absent. So the default here is CLOSED.
 *
 * Closing it costs nothing #2046 was protecting: the strip exists because a
 * read-only mobile pane has no other route to opencode's chords, and one tap on
 * a 44px toggle is still a route.
 *
 * ## Why the key is device-wide rather than per-worktree
 *
 * Every opencode pane renders the identical seventeen keys, so the preference is
 * a fact about this phone's screen, not about a worktree. A per-worktree key
 * (the shape {@link useMobileSelectedInstances} uses, where the stored value
 * genuinely differs per worktree) would silently reset to closed on every new
 * worktree and make the user re-open it each time.
 *
 * @module hooks/useOpencodeQuickKeysDisclosure
 */

'use client';

import { useCallback } from 'react';
import { useLocalStorageState } from './useLocalStorageState';

/** Device-wide localStorage key for the mobile quick-keys disclosure. */
export const OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY =
  'commandmate:mobile:opencodeQuickKeysOpen';

/**
 * Closed by default (Issue #2106).
 *
 * Not a taste call: the measurement above is what sets it. Flipping this to
 * `true` restores the pre-#2106 layout, which is why
 * `tests/unit/hooks/useOpencodeQuickKeysDisclosure-2106.test.ts` asserts the
 * constant itself and not merely the hook's first render.
 */
export const OPENCODE_QUICK_KEYS_DEFAULT_OPEN = false;

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** Return shape of {@link useOpencodeQuickKeysDisclosure}. */
export interface UseOpencodeQuickKeysDisclosureReturn {
  /** Whether the key strip is expanded (persisted across reloads). */
  open: boolean;
  /** Flip the strip open/closed and persist the new state. */
  toggle: () => void;
  /** Whether localStorage persistence is active (false during SSR). */
  isPersistent: boolean;
}

/**
 * Read/write the persisted disclosure state of the mobile quick-keys strip.
 *
 * SSR-safe: starts at {@link OPENCODE_QUICK_KEYS_DEFAULT_OPEN} and hydrates from
 * localStorage on mount, exactly like {@link useGitPaneTabState}.
 */
export function useOpencodeQuickKeysDisclosure(): UseOpencodeQuickKeysDisclosureReturn {
  const { value: open, setValue: setOpen, isAvailable } = useLocalStorageState<boolean>({
    key: OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY,
    defaultValue: OPENCODE_QUICK_KEYS_DEFAULT_OPEN,
    validate: isBoolean,
  });

  const toggle = useCallback(() => setOpen((prev) => !prev), [setOpen]);

  return { open, toggle, isPersistent: isAvailable };
}

export default useOpencodeQuickKeysDisclosure;
