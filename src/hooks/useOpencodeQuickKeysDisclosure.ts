/**
 * useOpencodeQuickKeysDisclosure Hook (Issue #2106, split per screen in #2131)
 *
 * Owns the persisted open/closed state of the opencode quick-keys strip
 * ({@link OpencodeQuickKeys} in `collapsible` mode) — one preference per SCREEN
 * (`'mobile'` | `'desktop'`), never one shared between them.
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
 * ## Why PC gets its OWN key and its OWN default (Issue #2131)
 *
 * #2131 measured the PC split pane and found the strip costs 206px at one split
 * and **578px across eleven wrapped rows at three**, which left `TerminalDisplay`
 * 64px — a 90% loss, because the footer block is `flex-shrink-0` and the terminal
 * is the only `flex-1 min-h-0` sibling, so it absorbs the whole cost. So PC folds
 * too. But it does not share the phone's preference:
 *
 *   - **Separate key.** The phone's key is literally named `…:mobile:…`. Sharing
 *     it would mean closing the strip on a phone silently closes it on a desktop
 *     that has room for it, and vice versa. The two screens are answering
 *     different questions, so they get different answers.
 *   - **Opposite default.** The phone starts CLOSED because at 360x640 the open
 *     strip leaves the terminal ZERO pixels. A PC pane at one split keeps 456px
 *     of terminal with the strip open, which is usable, and #2046's whole point
 *     is that these chords have no other route in — so PC starts OPEN and the
 *     user folds it when a third split squeezes the pane.
 *
 * @module hooks/useOpencodeQuickKeysDisclosure
 */

'use client';

import { useCallback } from 'react';
import { useLocalStorageState } from './useLocalStorageState';

/**
 * Which screen's disclosure preference a strip reads (Issue #2131).
 *
 * Not a viewport measurement — it is the CALLER naming itself.
 * `MobileTerminalTab` is the mobile surface and `TerminalSplitPaneContent` is
 * the desktop one; both are rendered by a layout that has already decided which
 * screen it is (`useIsMobile`), so re-deriving it here would be a second,
 * disagreeing source of the same fact.
 */
export type OpencodeQuickKeysLayout = 'mobile' | 'desktop';

/** Device-wide localStorage key for the MOBILE quick-keys disclosure. */
export const OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY =
  'commandmate:mobile:opencodeQuickKeysOpen';

/**
 * Device-wide localStorage key for the PC (split pane) disclosure (Issue #2131).
 *
 * Deliberately NOT the mobile key: see the module docblock. `desktop:` mirrors
 * the `mobile:` segment that has been in the other key since #2106, so the pair
 * reads as one namespace with two screens rather than two unrelated settings.
 */
export const OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY =
  'commandmate:desktop:opencodeQuickKeysOpen';

/**
 * Closed by default (Issue #2106).
 *
 * Not a taste call: the measurement above is what sets it. Flipping this to
 * `true` restores the pre-#2106 layout, which is why
 * `tests/unit/hooks/useOpencodeQuickKeysDisclosure-2106.test.ts` asserts the
 * constant itself and not merely the hook's first render.
 */
export const OPENCODE_QUICK_KEYS_DEFAULT_OPEN = false;

/**
 * PC starts OPEN (Issue #2131).
 *
 * Also not a taste call, and deliberately the OPPOSITE of the phone's. #2131
 * measured 206px of strip against a 800px-wide pane at one split — the terminal
 * keeps 456px, which is a working terminal — so defaulting PC to closed would
 * hide seventeen otherwise-unreachable chords to buy pixels that pane is not
 * short of. The 3-split case (64px of terminal) is what the toggle is for.
 *
 * Asserted as a constant in `tests/unit/hooks/…-2131.test.ts` for the same
 * reason {@link OPENCODE_QUICK_KEYS_DEFAULT_OPEN} is: a first-render check alone
 * would stay green if this flipped and the hook negated it.
 */
export const OPENCODE_QUICK_KEYS_DESKTOP_DEFAULT_OPEN = true;

/** The (key, default) pair each screen reads. One row per screen, no fallthrough. */
export const OPENCODE_QUICK_KEYS_DISCLOSURE_BY_LAYOUT: Readonly<
  Record<OpencodeQuickKeysLayout, { readonly storageKey: string; readonly defaultOpen: boolean }>
> = {
  mobile: {
    storageKey: OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY,
    defaultOpen: OPENCODE_QUICK_KEYS_DEFAULT_OPEN,
  },
  desktop: {
    storageKey: OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY,
    defaultOpen: OPENCODE_QUICK_KEYS_DESKTOP_DEFAULT_OPEN,
  },
};

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
 * Read/write the persisted disclosure state of one screen's quick-keys strip.
 *
 * SSR-safe: starts at that screen's default and hydrates from localStorage on
 * mount, exactly like {@link useGitPaneTabState}.
 *
 * @param layout - Which screen is asking (Issue #2131). Defaults to `'mobile'`,
 *   which is the only caller that existed before #2131 and keeps every
 *   pre-#2131 call site reading the identical key and default.
 */
export function useOpencodeQuickKeysDisclosure(
  layout: OpencodeQuickKeysLayout = 'mobile',
): UseOpencodeQuickKeysDisclosureReturn {
  const { storageKey, defaultOpen } = OPENCODE_QUICK_KEYS_DISCLOSURE_BY_LAYOUT[layout];
  const { value: open, setValue: setOpen, isAvailable } = useLocalStorageState<boolean>({
    key: storageKey,
    defaultValue: defaultOpen,
    validate: isBoolean,
  });

  const toggle = useCallback(() => setOpen((prev) => !prev), [setOpen]);

  return { open, toggle, isPersistent: isAvailable };
}

export default useOpencodeQuickKeysDisclosure;
