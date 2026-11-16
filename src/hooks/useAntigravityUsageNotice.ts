/**
 * useAntigravityUsageNotice (Issue #4438)
 *
 * Whether the Antigravity usage notice is still to be shown in this browser.
 *
 * ## Where "seen" is remembered: localStorage, per browser
 *
 * Not the server's settings: a phone or a second browser shows it once more, and a
 * notice shown twice costs a click, while one never shown on the device someone
 * actually uses costs them the warning. It also needs no server write for something
 * that only steers what this screen shows.
 *
 * The stored value is the date the terms were checked (`ANTIGRAVITY_TERMS_CHECKED_AT`),
 * so a later re-check of the terms shows the notice again.
 *
 * Every failure leans towards showing it: storage that cannot be read (private mode,
 * blocked site data, an exception) counts as "not seen", and a write that fails still
 * hides it for the mounted screens only — the next load shows it again.
 *
 * Imports only the pure policy module, never `declaration.ts` (which reads
 * `process.env`): what the server was told is not shown here.
 *
 * @module hooks/useAntigravityUsageNotice
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { ANTIGRAVITY_TERMS_CHECKED_AT } from '@/lib/tool-policy/policy';
import type { CLIToolType } from '@/lib/cli-tools/types';

export const ANTIGRAVITY_NOTICE_STORAGE_KEY = 'commandmate:antigravity-usage-notice:dismissed';

/** Fired on `window` when the notice is closed, so every mounted screen hides it. */
const DISMISS_EVENT = 'commandmate:antigravity-usage-notice-dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(ANTIGRAVITY_NOTICE_STORAGE_KEY) === ANTIGRAVITY_TERMS_CHECKED_AT;
  } catch {
    return false;
  }
}

export interface AntigravityUsageNotice {
  /** True when `tool` is antigravity and the notice has not been closed. */
  shouldShow: (tool: CLIToolType | '') => boolean;
  /** Close it here and remember that (best effort). */
  dismiss: () => void;
}

export function useAntigravityUsageNotice(): AntigravityUsageNotice {
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    const onDismiss = (): void => setDismissed(true);
    window.addEventListener(DISMISS_EVENT, onDismiss);
    return () => window.removeEventListener(DISMISS_EVENT, onDismiss);
  }, []);

  const shouldShow = useCallback(
    (tool: CLIToolType | '') => tool === 'antigravity' && !dismissed,
    [dismissed],
  );

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(ANTIGRAVITY_NOTICE_STORAGE_KEY, ANTIGRAVITY_TERMS_CHECKED_AT);
    } catch {
      // Not remembered: the next load shows it again, which is the safe side.
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }, []);

  return { shouldShow, dismiss };
}
