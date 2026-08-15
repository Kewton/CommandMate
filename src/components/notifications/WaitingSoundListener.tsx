/**
 * The opt-in waiting chime (Issue #1789).
 *
 * Renders nothing. Mounted once in the app shell next to
 * {@link module:components/notifications/WaitingToastListener}, and driven by
 * the same realtime frames: Issue #1788 broadcasts the waiting *edge*, which is
 * exactly the moment a sound is wanted. Deriving it from the count instead would
 * mean re-deriving "went up" from a list that also changes for a dozen unrelated
 * reasons, and would chime on a reload that merely *discovers* an old wait.
 *
 * Separate from the toast listener rather than folded into it, because the two
 * differ on every axis that matters: the toast is on by default and suppressed
 * for the worktree on screen; the chime is off by default and, once you have
 * asked for it, is wanted wherever you are — a sound is a signal to look at the
 * screen, so suppressing it based on which screen is showing gets it backwards.
 *
 * What they do share is {@link episodeKey}: one chime per waiting episode, keyed
 * on Issue #1786's frozen `waitingSince`, so a wait that changes character
 * mid-flight (permission dialog answered into a selection list) does not chime
 * twice.
 *
 * @module components/notifications/WaitingSoundListener
 */

'use client';

import { useEffect, useRef } from 'react';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import { useInAppWaitingSound } from '@/hooks/useInAppNotificationPrefs';
import { episodeKey } from '@/components/notifications/WaitingToastListener';
import { playWaitingSound, unlockWaitingSound } from '@/lib/pwa/notification-sound';
import type { RealtimeEvent } from '@/lib/realtime/types';

/** Cap on remembered episode keys, mirroring the toast listener's. */
const MAX_REMEMBERED_EPISODES = 500;

/**
 * Gestures that count as "the user has interacted with this page".
 *
 * All three, because browsers disagree: `pointerdown` covers mouse, pen and (in
 * every current engine) touch, `touchstart` covers the older ones that do not
 * synthesise pointer events, and `keydown` covers the keyboard-only user, whose
 * chime should not depend on them ever touching a pointing device.
 */
const UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'keydown'] as const;

export function WaitingSoundListener() {
  const { addListener } = useRealtime();
  const { enabled } = useInAppWaitingSound();

  // Read at fire time, so flipping the toggle does not tear down and
  // re-register the listener — which would drop the dedup set with it.
  const latest = useRef({ enabled });
  latest.current = { enabled };

  const seenEpisodes = useRef<Set<string>>(new Set());

  // Arm the audio context on the first user gesture. Registered unconditionally
  // rather than only when the toggle is on: the toggle itself is flipped by a
  // gesture, and a user who enables the chime and then leaves the tab alone
  // would otherwise never have armed anything.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const arm = () => unlockWaitingSound();
    for (const type of UNLOCK_EVENTS) {
      window.addEventListener(type, arm, { once: true, passive: true });
    }
    return () => {
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, arm);
    };
  }, []);

  useEffect(() => {
    return addListener((event: RealtimeEvent) => {
      if (event.type !== 'session_status_changed') return;
      const worktreeId = event.worktreeId;
      if (typeof worktreeId !== 'string' || worktreeId.length === 0) return;

      const waiting = (event as { isWaitingForResponse?: boolean }).isWaitingForResponse;
      if (typeof waiting !== 'boolean') return;

      const instance = (event as { instance?: string | null }).instance ?? null;
      const waitingSince = (event as { waitingSince?: number | null }).waitingSince ?? null;

      if (!waiting) {
        const prefix = `${worktreeId}|${instance ?? '-'}|`;
        for (const key of seenEpisodes.current) {
          if (key.startsWith(prefix)) seenEpisodes.current.delete(key);
        }
        return;
      }

      if (!latest.current.enabled) return;

      const key = episodeKey(worktreeId, instance, waitingSince);
      if (seenEpisodes.current.has(key)) return;
      if (seenEpisodes.current.size >= MAX_REMEMBERED_EPISODES) seenEpisodes.current.clear();
      seenEpisodes.current.add(key);

      // Returns false when the browser has no Web Audio or refused the graph.
      // Nothing to do about it and nothing to report: see the module docblock
      // of `lib/pwa/notification-sound`.
      playWaitingSound();
    });
  }, [addListener]);

  return null;
}
