/**
 * useSessionTileSurfaceMode — which surface one `/sessions` tile shows
 * (Issue #2510, Epic #2508 Phase 2).
 *
 * Phase 1 (#2509) gave a tile exactly one surface, `chat`. Phase 2 makes the
 * terminal usable in a tile, so the tile needs the same two-way choice the
 * worktree screen has — and a place to remember it.
 *
 * ## Scope of the preference
 *
 * One per worktree, `commandmate.sessions.tileSurfaceMode-<worktreeId>`. Per
 * worktree because the point of a wall of tiles is that they differ: an opencode
 * TUI on its terminal next to three claude sessions read as chat. It is NOT the
 * worktree screen's key (`commandmate.worktree.surfaceMode-…`, see
 * `config/surface-mode-config`): a tile is a glance at a half-width card, the
 * worktree screen is the full pane, and switching one must not switch the other.
 *
 * The key has a single shape, so the `-split-` / `-mobile` collision that
 * `surface-mode-config` guards against cannot arise inside this namespace, and
 * the namespace itself (`commandmate.sessions.`) is disjoint from that one.
 *
 * ## Default
 *
 * `chat`, fixed. That is the tile's Phase 1 behaviour and the Epic's decision —
 * a tile that has never been switched must keep looking the way it did. The
 * server-wide default surface setting (#2201) is deliberately not consulted: it
 * names what a *worktree screen* pane opens as, and a user who set it to
 * `terminal` for that full-width pane did not thereby ask for twenty
 * horizontally-scrolling terminals on `/sessions`.
 *
 * @module hooks/useSessionTileSurfaceMode
 */

'use client';

import { useCallback } from 'react';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import { isSurfaceMode, type SurfaceMode } from '@/types/ui-state';

/** Prefix of every tile surface key; the full key ends in the worktree id. */
export const SESSION_TILE_SURFACE_MODE_STORAGE_KEY_PREFIX = 'commandmate.sessions.tileSurfaceMode-';

/** What a tile shows until it is switched: the Phase 1 surface. */
export const DEFAULT_SESSION_TILE_SURFACE_MODE: SurfaceMode = 'chat';

/**
 * The localStorage key for one worktree's tile.
 *
 * @param worktreeId - The worktree the tile shows
 * @returns `commandmate.sessions.tileSurfaceMode-<worktreeId>`
 */
export function getSessionTileSurfaceModeStorageKey(worktreeId: string): string {
  return `${SESSION_TILE_SURFACE_MODE_STORAGE_KEY_PREFIX}${worktreeId}`;
}

/** What {@link useSessionTileSurfaceMode} hands back. */
export interface UseSessionTileSurfaceModeReturn {
  surfaceMode: SurfaceMode;
  setSurfaceMode: (mode: SurfaceMode) => void;
}

/**
 * Read and persist one tile's surface.
 *
 * SSR and the first client render see {@link DEFAULT_SESSION_TILE_SURFACE_MODE};
 * the stored value is applied in an effect (`useLocalStorageState`), so the
 * hydrated markup matches the server's. Stored as the bare string, validated on
 * read, so a hand-edited or future value (Epic #2192 keeps `xterm` open) falls
 * back to `chat` instead of to a surface the tile cannot draw.
 *
 * @param worktreeId - The worktree the tile shows
 * @returns The current surface and a setter that also persists it
 */
export function useSessionTileSurfaceMode(worktreeId: string): UseSessionTileSurfaceModeReturn {
  const { value, setValue } = useLocalStorageState<SurfaceMode>({
    key: getSessionTileSurfaceModeStorageKey(worktreeId),
    defaultValue: DEFAULT_SESSION_TILE_SURFACE_MODE,
    validate: isSurfaceMode,
    serialize: (mode) => mode,
    deserialize: (stored) => stored,
  });

  const setSurfaceMode = useCallback((mode: SurfaceMode) => setValue(mode), [setValue]);

  return { surfaceMode: value, setSurfaceMode };
}

export default useSessionTileSurfaceMode;
