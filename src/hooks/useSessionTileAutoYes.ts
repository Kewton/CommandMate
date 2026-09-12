/**
 * useSessionTileAutoYes — one `/sessions` tile's Auto-Yes toggle (Issue #2512).
 *
 * ## Read: the list payload, never a request per tile
 *
 * The state comes from `worktree.autoYesByInstance`, which `GET /api/worktrees`
 * fills in from the server's in-memory Auto-Yes map. The page already holds one
 * poll of that list, so a wall of twenty tiles costs zero extra requests for
 * twenty toggles. The alternative — each tile asking
 * `GET /api/worktrees/:id/auto-yes` — is N requests per refresh for a value the
 * list can carry for free (its cost is the tmux probe, measured in
 * `docs/design/sessions-tile-polling-2511.md` §3.4).
 *
 * ## Write: the existing route, then the list
 *
 * A toggle posts to `POST /api/worktrees/:id/auto-yes` with this tile's
 * `(cliToolId, instanceId)` — the body `useWorktreeDetailController` sends —
 * and then asks the list cache to re-read, so the tile and every other surface
 * of this browser agree now rather than at the next poll (20–60s with a live
 * socket).
 *
 * ## The override
 *
 * The route's answer is shown immediately and held until the list has caught
 * up, in the manner of `useSessionNote` (#2427). It is released on EITHER of:
 *
 * - **landed** — the row reads what the route answered; or
 * - **superseded** — the refresh this toggle asked for has resolved and the
 *   row has been replaced since. That second signal is what keeps the override
 *   from outliving a state the server changed on its own in the meantime (a
 *   stop pattern that matched within the same second): the refreshed row is
 *   the truth even though it is not what this tile wrote.
 *
 * "Resolved" is not "rendered": the cache applies a refresh inside
 * `startTransition`, so the row this hook sees when the promise settles is
 * still the pre-refresh one. That row is what is recorded, and the override
 * lets go on the first render that carries a different one.
 *
 * ## Expiry
 *
 * The server resolves an expired state to disabled at read time, so the list
 * never re-reports a finished countdown. Between polls the countdown runs out
 * on the client instead, and `AutoYesToggle` already flips to OFF at 00:00 on
 * its own (#959) — an expired Auto-Yes on a tile looks exactly like one that
 * was never enabled, which is what it is.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import type { AutoYesInstanceSummary, AutoYesToggleParams } from '@/types/auto-yes';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

/** What a tile with nothing armed reads. One object, so memoised readers stay stable. */
export const AUTO_YES_OFF: Readonly<AutoYesInstanceSummary> = Object.freeze({
  enabled: false,
  expiresAt: null,
});

/**
 * One instance's Auto-Yes as the list row carries it. Anything that is not an
 * enabled entry reads as off, so a malformed or absent value can never render
 * as a confident ON.
 */
export function readTileAutoYes(
  worktree: Pick<Worktree, 'autoYesByInstance'>,
  instanceId: string,
): Readonly<AutoYesInstanceSummary> {
  const entry = worktree.autoYesByInstance?.[instanceId];
  if (!entry || entry.enabled !== true) return AUTO_YES_OFF;
  return {
    enabled: true,
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
  };
}

/** A toggle's answer, held until the list agrees. */
export interface TileAutoYesOverride {
  /** The instance the toggle was for; a different instance never reads it. */
  instanceId: string;
  /** What `POST /auto-yes` answered. */
  value: AutoYesInstanceSummary;
  /**
   * The row on screen when the refresh this toggle asked for resolved, or null
   * while it is still outstanding. See the module comment.
   */
  settledRow: Worktree | null;
}

/** Whether an override has done its job. Pure, so the release rule is testable alone. */
export function isTileAutoYesOverrideReleased(
  override: TileAutoYesOverride,
  stored: Readonly<AutoYesInstanceSummary>,
  row: Worktree,
): boolean {
  const landed =
    stored.enabled === override.value.enabled &&
    (!stored.enabled || stored.expiresAt === override.value.expiresAt);
  const superseded = override.settledRow !== null && row !== override.settledRow;
  return landed || superseded;
}

export interface UseSessionTileAutoYesOptions {
  /** The list-cache row the tile is showing. */
  worktree: Worktree;
  /** The agent the selected instance runs. */
  cliToolId: CLIToolType;
  /** The selected instance (the primary's id is its tool id). */
  instanceId: string;
}

export interface UseSessionTileAutoYesResult {
  enabled: boolean;
  expiresAt: number | null;
  /** `AutoYesToggle`'s `onToggle`. Never rejects. */
  toggle: (params: AutoYesToggleParams) => Promise<void>;
}

export function useSessionTileAutoYes({
  worktree,
  cliToolId,
  instanceId,
}: UseSessionTileAutoYesOptions): UseSessionTileAutoYesResult {
  const refreshList = useOptionalWorktreesCacheContext()?.refresh;
  const worktreeId = worktree.id;

  const stored = useMemo(() => readTileAutoYes(worktree, instanceId), [worktree, instanceId]);

  const [override, setOverride] = useState<TileAutoYesOverride | null>(null);
  // Read when a refresh settles, which is outside any render.
  const rowRef = useRef(worktree);
  rowRef.current = worktree;

  const active =
    override !== null &&
    override.instanceId === instanceId &&
    !isTileAutoYesOverrideReleased(override, stored, worktree)
      ? override
      : null;

  // Rendering already ignores a released override (above), so this only tidies
  // state — there is no frame in which the stale value shows.
  useEffect(() => {
    if (override !== null && active === null) setOverride(null);
  }, [override, active]);

  const toggle = useCallback(
    async (params: AutoYesToggleParams): Promise<void> => {
      let answer: AutoYesInstanceSummary;
      try {
        const response = await fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/auto-yes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: params.enabled,
            cliToolId,
            instanceId,
            duration: params.duration,
            stopPattern: params.stopPattern,
          }),
        });
        // A refused toggle changed nothing on the server, so the row is still
        // the truth and there is nothing to hold.
        if (!response.ok) return;
        const data = (await response.json()) as { enabled?: unknown; expiresAt?: unknown };
        const enabled = data.enabled === true;
        answer = {
          enabled,
          expiresAt: enabled && typeof data.expiresAt === 'number' ? data.expiresAt : null,
        };
      } catch {
        return;
      }
      const held: TileAutoYesOverride = { instanceId, value: answer, settledRow: null };
      setOverride(held);

      try {
        await refreshList?.();
      } catch {
        // The cache reports its own failures; the next poll replaces the row.
      }
      setOverride((current) =>
        current === held ? { ...held, settledRow: rowRef.current } : current,
      );
    },
    [worktreeId, cliToolId, instanceId, refreshList],
  );

  const shown = active ? active.value : stored;
  return { enabled: shown.enabled, expiresAt: shown.expiresAt, toggle };
}

export default useSessionTileAutoYes;
