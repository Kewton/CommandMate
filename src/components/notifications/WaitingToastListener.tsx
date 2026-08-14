/**
 * Cross-screen "a branch is waiting for you" toast (Issue #1788).
 *
 * Renders nothing. Mounted once in the app shell (`AppProviders`) rather than in
 * the worktree detail screen, because the whole point is the screen you are
 * *not* looking at: while you work in one branch, another one hitting a
 * permission dialog should reach you within seconds instead of on the next poll.
 *
 * Three rules keep it from becoming noise — all three are acceptance criteria,
 * not polish:
 *
 * 1. **Never for the worktree on screen.** That one already draws a PromptPanel;
 *    a toast on top of it says nothing and covers something.
 * 2. **Once per episode.** The dedup key is `waitingSince` (Issue #1786's frozen
 *    episode start), not the arrival time: a wait that changes character —
 *    permission dialog answered into a selection list — is still one wait, keeps
 *    its `since`, and gets one toast. A second toast for the same block is the
 *    fastest way to teach someone to ignore toasts.
 * 3. **Switchable off.** `useInAppWaitingToast`, default on.
 *
 * The events come from the shared realtime connection, whose rooms
 * `useWorktreesCache` already subscribes to for every worktree in the sidebar —
 * no new subscription, and therefore no way to receive a room this client was
 * not authorized to join.
 *
 * @module components/notifications/WaitingToastListener
 */

'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/common/Toast';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import { useInAppWaitingToast } from '@/hooks/useInAppNotificationPrefs';
import type { RealtimeEvent } from '@/lib/realtime/types';

/**
 * Longer than the 3 s default: this one is worth reading and worth clicking, and
 * a notification you have to catch is a notification you miss.
 */
export const WAITING_TOAST_DURATION_MS = 8000;

/**
 * Cap on remembered episode keys. Reached only after hundreds of distinct waits
 * in one page session; clearing wholesale is fine because every live episode's
 * toast has long since been shown and dismissed.
 */
const MAX_REMEMBERED_EPISODES = 500;

/**
 * The worktree currently on screen, or null.
 *
 * Matches `/worktrees/<id>` and anything under it (the file viewer, the diff
 * pane) — all of them are "looking at that branch".
 */
export function worktreeIdFromPathname(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = /^\/worktrees\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Dedup key for one waiting episode of one agent instance. */
export function episodeKey(
  worktreeId: string,
  instance: string | null,
  waitingSince: number | null,
): string {
  return `${worktreeId}|${instance ?? '-'}|${waitingSince ?? 'no-since'}`;
}

export function WaitingToastListener() {
  const t = useTranslations('notifications');
  const { showToast } = useToast();
  const { addListener } = useRealtime();
  const { enabled } = useInAppWaitingToast();
  const pathname = usePathname();
  const router = useRouter();
  const cache = useOptionalWorktreesCacheContext();

  // Everything the listener needs to read at fire time goes through a ref, so
  // the effect below is not torn down and re-registered on every navigation or
  // every worktree-list refresh. Re-registering is not merely wasteful here: the
  // dedup set lives in this component, and a listener churning between frames
  // would be a listener that misses one.
  const latest = useRef({ enabled, pathname, worktrees: cache?.worktrees, showToast, t, router });
  latest.current = { enabled, pathname, worktrees: cache?.worktrees, showToast, t, router };

  const seenEpisodes = useRef<Set<string>>(new Set());

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
        // The wait ended. Forget this instance's episodes so the next one is
        // announced even in the (pathological) case of a repeated `since`.
        const prefix = `${worktreeId}|${instance ?? '-'}|`;
        for (const key of seenEpisodes.current) {
          if (key.startsWith(prefix)) seenEpisodes.current.delete(key);
        }
        return;
      }

      const current = latest.current;
      if (!current.enabled) return;
      if (worktreeIdFromPathname(current.pathname) === worktreeId) return;

      const key = episodeKey(worktreeId, instance, waitingSince);
      if (seenEpisodes.current.has(key)) return;
      if (seenEpisodes.current.size >= MAX_REMEMBERED_EPISODES) seenEpisodes.current.clear();
      seenEpisodes.current.add(key);

      const name =
        current.worktrees?.find((wt) => wt.id === worktreeId)?.name ?? worktreeId;
      current.showToast(
        current.t('inApp.waitingToast', { name }),
        'warning',
        WAITING_TOAST_DURATION_MS,
        { onClick: () => current.router.push(`/worktrees/${encodeURIComponent(worktreeId)}`) },
      );
    });
  }, [addListener]);

  return null;
}
