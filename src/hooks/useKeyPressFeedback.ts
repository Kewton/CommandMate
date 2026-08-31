'use client';

/**
 * useKeyPressFeedback — the owned press-highlight timer for the terminal key
 * strips (Issue #2176, extracted from the fix #2174 landed in
 * {@link OpencodeQuickKeys}).
 *
 * ## What it is
 *
 * Every on-screen key strip that drives the read-only terminal through
 * `useSpecialKeys` shows the same transient press feedback: the pressed button
 * lights up synchronously and goes dark exactly
 * {@link KEY_PRESS_FEEDBACK_RESET_MS} later. Three components render that —
 * {@link OpencodeQuickKeys}, `TerminalEscapeHatch` and `NavigationButtons` — and
 * before #2176 all three wrote the timer themselves.
 *
 * ## Why it is one hook and not three copies
 *
 * All three wrote it the same WRONG way: a bare
 * `setTimeout(() => setActiveKey(null), KEY_PRESS_FEEDBACK_RESET_MS)` whose id
 * nobody kept, so nothing could cancel it. A pane unmounted inside those 150 ms
 * left a callback that still ran and still wrote state into a tree that was
 * gone. In a browser that is inert — React drops the update on a torn-down root.
 * Under jsdom it is not: the callback outlives the test that armed it and fires
 * against an environment whose `window` has already been torn down, surfacing as
 * an unhandled error charged to whichever test happens to be running. Every test
 * in the file passes and vitest still exits 1, in a PR that never touched these
 * components (#2174 did exactly that to PR #2170 and PR #2173).
 *
 * #2174 fixed one of the three. Fixing the other two by copying the fix would
 * have left the same hole open for the fourth strip somebody adds later, so the
 * timer moved here instead: the id lives in a ref and is cleared in both places
 * that can invalidate it — the next press (which re-arms from zero rather than
 * inheriting the previous press's remaining time) and unmount. That is the shape
 * every other transient feedback timer in this tree already uses
 * ({@link CopyButton}, `TruncationTooltip`, `MemoCard`).
 *
 * Nothing observable moves in any of the three callers: the highlight still
 * appears synchronously on press and still clears exactly
 * `KEY_PRESS_FEEDBACK_RESET_MS` later.
 *
 * ## What it deliberately does NOT do
 *
 * It does not send anything. The key transport stays in `useSpecialKeys`, which
 * every caller keeps calling itself — this hook owns the highlight and nothing
 * else, so a caller that wants to light a button without sending a key (or send
 * without lighting) is not fighting it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

export interface KeyPressFeedback {
  /**
   * The id of the key currently shown as pressed, or `null`. Callers compare it
   * against their own key ids to pick the pressed-state classes.
   */
  activeKey: string | null;
  /**
   * Light `key` up now and clear it {@link KEY_PRESS_FEEDBACK_RESET_MS} later.
   * Referentially stable, so callers can list it in a `useCallback` dep array
   * without re-creating their handlers on every render.
   */
  markPressed: (key: string) => void;
}

export function useKeyPressFeedback(): KeyPressFeedback {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const markPressed = useCallback((key: string) => {
    setActiveKey(key);
    // Re-arm from zero: without this the previous press's timer would still be
    // pending and would clear the CURRENT press's highlight early.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setActiveKey(null);
    }, KEY_PRESS_FEEDBACK_RESET_MS);
  }, []);

  return { activeKey, markPressed };
}
