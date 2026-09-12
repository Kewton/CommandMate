'use client';

/**
 * SessionTileGrid — the two-column wall of {@link SessionTile}s (Issue #2509).
 *
 * Layout, and the viewport bookkeeping that makes the layout affordable.
 *
 * ## Columns
 *
 * `grid-cols-1 xl:grid-cols-2`: one column below Tailwind's `xl` (1280px), two
 * at or above it. The Issue asks for one column below 768px as well, and this
 * satisfies that a fortiori — everything under 1280px is one column — which is
 * also why `useIsMobile` is not consulted here. A media query that the browser
 * re-evaluates on resize is strictly better than a hook that has to re-render
 * to notice, and it is correct during SSR, where `useIsMobile` seeds `false`.
 *
 * ## Height
 *
 * Fixed, not content-driven. A chat transcript has no natural height, so tiles
 * sized by their content would be a column of wildly unequal cards that re-flows
 * every time a reply lands — and two columns whose rows never line up. The card
 * scrolls inside itself instead; the page scrolls between cards.
 *
 * ## Which tiles are awake
 *
 * Each tile sits in a slot that watches its own visibility and hands the verdict
 * down as `enabled`. The slot exists because a hook cannot be called in a loop:
 * one `useInViewport` per tile means one component per tile.
 */

import { memo } from 'react';
import { SessionTile } from '@/components/sessions/SessionTile';
import { useInViewport } from '@/hooks/useInViewport';
import type { Worktree } from '@/types/models';

/**
 * Tile height (Tailwind arbitrary value). Inside the 480–560px window the Issue
 * names: tall enough for a readable transcript plus the header, short enough
 * that a 1080p screen shows two rows of tiles.
 */
export const SESSION_TILE_HEIGHT_CLASS = 'h-[32rem]';

/**
 * How far outside the viewport a tile starts polling.
 *
 * One tile-height of lead time, so a tile the reader is scrolling towards has
 * already attached and fetched by the time it is on screen — the alternative is
 * a visibly empty card that fills in a moment later, every time.
 */
export const SESSION_TILE_ROOT_MARGIN = '512px';

/**
 * One grid cell: observes its own visibility, renders one tile.
 *
 * The observed element is this wrapper rather than the tile's own root so that
 * the ref survives whatever the tile does with its internals, and so that an
 * off-screen tile — which renders a bare placeholder — still has a box of the
 * right size for the observer to measure.
 */
const SessionTileSlot = memo(function SessionTileSlot({ worktree }: { worktree: Worktree }) {
  const { ref, inViewport } = useInViewport<HTMLDivElement>({
    rootMargin: SESSION_TILE_ROOT_MARGIN,
  });

  return (
    <div ref={ref} className={`min-w-0 ${SESSION_TILE_HEIGHT_CLASS}`}>
      <SessionTile worktree={worktree} enabled={inViewport} />
    </div>
  );
});

export interface SessionTileGridProps {
  /** Already filtered and sorted by the page; rendered in the order given. */
  worktrees: Worktree[];
}

export const SessionTileGrid = memo(function SessionTileGrid({
  worktrees,
}: SessionTileGridProps) {
  return (
    <div
      className="grid grid-cols-1 gap-4 xl:grid-cols-2"
      data-testid="sessions-tile-grid"
    >
      {worktrees.map((worktree) => (
        // Keyed by id so a polling re-render never remounts a tile — remounting
        // one would drop its transcript and re-attach its poller.
        <SessionTileSlot key={worktree.id} worktree={worktree} />
      ))}
    </div>
  );
});

export default SessionTileGrid;
