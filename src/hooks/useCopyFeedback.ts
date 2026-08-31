'use client';

/**
 * useCopyFeedback — the owned "copied!" timer for every copy button in this
 * tree (Issue #2180, the copy-side twin of {@link useKeyPressFeedback} from
 * #2176).
 *
 * ## What it is
 *
 * A copy button flips to a check mark / "Copied!" the moment the clipboard
 * write resolves and goes back exactly {@link COPY_FEEDBACK_RESET_MS} later.
 * Five components render that — `MarkdownEditor`, `FileViewer` (twice),
 * `ReportTab`, `WorktreeInfoFields` (twice) and `FileToolbar` (twice) — and
 * before #2180 all five wrote the timer themselves.
 *
 * ## Why it is one hook and not five copies
 *
 * Three of the five wrote it the WRONG way: a bare
 * `setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS)` whose id nobody
 * kept, so nothing could cancel it. A pane unmounted inside those 2000 ms left
 * a callback that still ran and still wrote state into a tree that was gone. In
 * a browser that is inert — React drops the update on a torn-down root. Under
 * jsdom it is not: the callback outlives the test that armed it and fires
 * against an environment whose `window` has already been torn down, surfacing
 * as an unhandled error charged to whichever test happens to be running. Every
 * test in the file passes and vitest still exits 1, in a PR that never touched
 * these components (#2174 did exactly that to PR #2170 and PR #2173 with the
 * 150 ms press timer; the copy window is 2000 ms, so it is the easier one to
 * step in).
 *
 * The other two (`WorktreeInfoFields`, `FileToolbar`) already kept the id in a
 * ref. Fixing only the leaking three by copying their ref dance would have left
 * five hand-written copies of one three-line invariant and the same hole open
 * for the sixth copy button somebody adds later, so the timer moved here
 * instead: the id lives in a ref and is cleared in all three places that can
 * invalidate it — the next copy (which re-arms from zero rather than inheriting
 * the previous copy's remaining time), an explicit {@link CopyFeedback.reset}
 * and unmount.
 *
 * Nothing observable moves in any of the five callers: the confirmation still
 * appears as soon as the clipboard write resolves and still clears exactly
 * `COPY_FEEDBACK_RESET_MS` later.
 *
 * ## One instance per button, not per component
 *
 * `FileViewer`, `WorktreeInfoFields` and `FileToolbar` each show TWO
 * independent confirmations (content and path). They call this hook twice.
 * Sharing one instance between two buttons would make the second press cut the
 * first button's confirmation short, which is exactly why `WorktreeInfoFields`
 * kept `pathTimerRef` and `repoPathTimerRef` apart before #2180.
 *
 * ## What it deliberately does NOT do
 *
 * It does not touch the clipboard. `copyToClipboard` stays at the call site,
 * which every caller keeps awaiting itself — this hook owns the confirmation
 * and nothing else, so a caller that wants to confirm without copying (or copy
 * without confirming, as the silent failure paths do) is not fighting it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

export interface CopyFeedback {
  /** Whether the confirmation is currently showing. */
  copied: boolean;
  /**
   * Show the confirmation now and clear it `resetMs` later. Referentially
   * stable for a fixed `resetMs`, so callers can list it in a `useCallback` dep
   * array without re-creating their handlers on every render.
   */
  markCopied: () => void;
  /**
   * Hide the confirmation immediately and drop the pending timer. For callers
   * whose surface can be reset out from under a live confirmation — `FileViewer`
   * clears it when the modal closes or the file changes.
   */
  reset: () => void;
}

/**
 * @param resetMs How long the confirmation stays. Defaults to
 *   {@link COPY_FEEDBACK_RESET_MS}; the parameter exists for the compact copy
 *   button in the assistant message list, which uses the shorter
 *   `COPY_FEEDBACK_RESET_SHORT_MS`. Pass a module constant, not a value that
 *   changes per render, or `markCopied` stops being referentially stable.
 */
export function useCopyFeedback(resetMs: number = COPY_FEEDBACK_RESET_MS): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    // Re-arm from zero: without this the previous copy's timer would still be
    // pending and would clear the CURRENT copy's confirmation early.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, resetMs);
  }, [resetMs]);

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setCopied(false);
  }, []);

  return { copied, markCopied, reset };
}
