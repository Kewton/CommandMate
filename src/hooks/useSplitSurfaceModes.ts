/**
 * useSplitSurfaceModes Hook (Issue #2259)
 *
 * Lets the PC Action bar see which surface each split currently shows.
 *
 * ## Why this exists
 *
 * `surfaceMode` (Issue #2193) is owned by each `TerminalSplitPaneContent`:
 * `useState` seeded from `resolveSurfaceMode()` and persisted per split. The
 * History column only exists in the *terminal* surface — `chatSurfaceSlot`
 * deliberately renders the transcript alone (#2232: chat is not the History
 * column) — so with every split in chat mode the Action bar's History toggle
 * flips a state nothing is reading. Issue #2259 disables the toggle there, and
 * that verdict needs the modes in the CONTAINER, which sits above the panes.
 *
 * ## Why an event and not a prop
 *
 * The panes are supplied to the container through the caller's `renderPane`
 * render prop, so there is no downward channel to reverse — a "report your
 * mode" callback would have to be threaded through `WorktreeDetailDesktop`,
 * which owns neither piece of state. The panes already persist every change to
 * localStorage; this hook reads that same store and listens for a CustomEvent
 * so the bar updates within the same tick as the pane, exactly the mechanism
 * `useHistoryPaneState` / `useFilePanelState` use to keep their own multiple
 * mounts in sync (a same-window `localStorage.setItem` fires no `storage`
 * event, so polling or `storage` alone would not do).
 *
 * ## Ordering
 *
 * The initial read runs in the container's mount effect, which React flushes
 * AFTER its children's — so by the time it runs, every pane has already
 * resolved its mode and written a `?view=` deep link back to storage. The read
 * therefore sees the same value the pane is rendering, and every later change
 * arrives as an event.
 */

'use client';

import { useEffect, useState } from 'react';
import {
  getSplitSurfaceModeStorageKey,
  readSurfaceMode,
} from '@/config/surface-mode-config';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';

/** CustomEvent broadcast by a split when its output surface changes. */
export const SURFACE_MODE_CHANGE_EVENT = 'commandmate:surfaceModeChange';

export interface SurfaceModeChangeDetail {
  worktreeId: string;
  splitIndex: number;
  mode: SurfaceMode;
}

/** Announce a split's new output surface to same-page observers. */
export function emitSurfaceModeChange(detail: SurfaceModeChangeDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent<SurfaceModeChangeDetail>(SURFACE_MODE_CHANGE_EVENT, {
        detail,
      }),
    );
  } catch {
    /* CustomEvent may be unavailable in very old environments */
  }
}

function readAll(worktreeId: string, splitCount: number): SurfaceMode[] {
  if (typeof window === 'undefined') {
    return Array.from({ length: splitCount }, () => DEFAULT_SURFACE_MODE);
  }
  return Array.from({ length: splitCount }, (_, index) =>
    readSurfaceMode(getSplitSurfaceModeStorageKey(worktreeId, index)),
  );
}

/**
 * The output surface of each split of `worktreeId`, index-aligned with the
 * container's `splits` array.
 *
 * SSR-safe: the first render returns `DEFAULT_SURFACE_MODE` for every split
 * (same shape as the panes themselves), replaced on mount by what is persisted.
 */
export function useSplitSurfaceModes(
  worktreeId: string,
  splitCount: number,
): SurfaceMode[] {
  const [modes, setModes] = useState<SurfaceMode[]>(() =>
    Array.from({ length: splitCount }, () => DEFAULT_SURFACE_MODE),
  );

  useEffect(() => {
    setModes(readAll(worktreeId, splitCount));
  }, [worktreeId, splitCount]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<SurfaceModeChangeDetail>).detail;
      if (!detail) return;
      if (detail.worktreeId !== worktreeId) return;
      const { splitIndex, mode } = detail;
      setModes((prev) => {
        if (splitIndex < 0 || splitIndex >= prev.length) return prev;
        if (prev[splitIndex] === mode) return prev;
        const next = [...prev];
        next[splitIndex] = mode;
        return next;
      });
    };
    window.addEventListener(SURFACE_MODE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(SURFACE_MODE_CHANGE_EVENT, onChange);
  }, [worktreeId]);

  return modes;
}

export default useSplitSurfaceModes;
