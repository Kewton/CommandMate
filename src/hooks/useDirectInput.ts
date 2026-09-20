'use client';

/**
 * useDirectInput — ordered sender for the direct-input API (Issue #2766).
 *
 * `useSpecialKeys` fires one `fetch` per press and never looks back. That is
 * fine for a button strip, where a press is a deliberate gesture hundreds of
 * milliseconds apart. It is NOT fine for a keyboard: `keydown` arrives every few
 * tens of milliseconds, HTTP responses come back in whatever order the server
 * and the network settle on, and `abcdefghij` typed in a second would reach the
 * pane as some permutation of itself. tmux has no sequence number to repair it
 * with — whatever order the writes land in IS the order the agent read.
 *
 * So this hook keeps **exactly one request in flight**. Anything the user types
 * while that request is open is pushed onto a queue, and the moment the response
 * lands the whole queue goes out as ONE request (capped at
 * {@link MAX_DIRECT_INPUT_EVENTS} — the route rejects a longer array — with the
 * remainder riding the request after that). Typing faster therefore makes the
 * batches bigger, never the order looser.
 *
 * A failure **discards the queue** rather than retrying it. The keys in there
 * were aimed at a screen the user was looking at when they pressed them; the
 * pane has since moved on, and replaying `Enter` into whatever is on screen now
 * is precisely the stray keystroke #1017/#1494 built their guards against. The
 * user is told (`error`) and types again.
 *
 * Issue #2176 is the other trap this file has to respect: the refresh timer is
 * held in a ref and cleared on unmount, because the very keys sent here are the
 * ones that dismiss the overlay the bar is mounted under.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { NAV_KEY_REFRESH_DELAY_MS } from '@/config/ui-feedback-config';
import { MAX_DIRECT_INPUT_EVENTS, type DirectInputEvent } from '@/types/direct-input';

/**
 * The single message a failure produces, as an i18n key under the `worktree`
 * namespace. A key rather than prose so the hook stays renderer-agnostic, and a
 * FIXED one rather than the server's text: the status code and the body are
 * operator detail, and the only thing the user can act on is "it did not go
 * through — look at the session and try again".
 */
export const DIRECT_INPUT_ERROR_KEY = 'directInput.error';

export interface UseDirectInputResult {
  /** Queue these events for the pane, preserving the order they were given in. */
  send: (events: readonly DirectInputEvent[]) => void;
  /** {@link DIRECT_INPUT_ERROR_KEY} while the last send failed, else `null`. */
  error: string | null;
}

export function useDirectInput(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  onSent?: () => void,
): UseDirectInputResult {
  const [error, setError] = useState<string | null>(null);

  const queueRef = useRef<DirectInputEvent[]>([]);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read through a ref so a parent that re-creates `onSent` every render does
  // not re-create `send`, and so a response that lands mid-update still calls
  // the current one.
  const onSentRef = useRef(onSent);
  useEffect(() => {
    onSentRef.current = onSent;
  }, [onSent]);

  useEffect(() => {
    // Re-armed on mount, not only initialised: React 19 StrictMode mounts,
    // unmounts and mounts again, and the second mount must not inherit the
    // first one's `false`.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  const send = useCallback(
    (events: readonly DirectInputEvent[]) => {
      if (events.length === 0) return;
      // The next attempt clears the last failure. `null` when already `null` is
      // a bail-out in React, so this costs no render on the common path.
      setError(null);
      queueRef.current.push(...events);

      // Named so the response handler can re-enter it for the next batch. One
      // call site per state: nothing else may start a request.
      const run = (): void => {
        if (inFlightRef.current) return;
        const batch = queueRef.current.splice(0, MAX_DIRECT_INPUT_EVENTS);
        if (batch.length === 0) return;
        inFlightRef.current = true;

        // Issue #869's body shape, byte-for-byte: the primary instance sends no
        // `instanceId` at all.
        const body = instanceId && instanceId !== cliToolId
          ? { cliToolId, events: batch, instanceId }
          : { cliToolId, events: batch };

        fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/direct-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`direct-input responded ${res.status}`);
            inFlightRef.current = false;
            if (queueRef.current.length > 0) {
              // More arrived while this one was open: straight into the next
              // request, without a refresh in between — the user is still typing
              // and the frame they want is the one after the LAST key.
              run();
              return;
            }
            if (!mountedRef.current) return;
            if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = setTimeout(() => {
              refreshTimerRef.current = null;
              onSentRef.current?.();
            }, NAV_KEY_REFRESH_DELAY_MS);
          })
          .catch(() => {
            inFlightRef.current = false;
            // Drop what was aimed at a screen that has since moved on.
            queueRef.current = [];
            if (!mountedRef.current) return;
            setError(DIRECT_INPUT_ERROR_KEY);
          });
      };

      run();
    },
    [worktreeId, cliToolId, instanceId],
  );

  return { send, error };
}
