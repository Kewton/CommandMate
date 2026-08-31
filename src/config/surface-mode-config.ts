/**
 * Surface Mode Configuration (Issue #2193)
 *
 * The persistence and deep-link boundary for {@link SurfaceMode} — which
 * surface occupies the *output* half of a worktree session (`terminal` or
 * `chat`). Consumed by:
 *   - `src/components/worktree/TerminalSplitPaneContent.tsx` (PC, per split)
 *   - `src/components/worktree/MobileTerminalTab.tsx`        (phone, per worktree)
 *   - `src/hooks/useWorktreeTabState.ts`                     (`?view=` deep link)
 *
 * Modeled on `activity-bar-config.ts` (Issue #858): a pure module of key
 * builders and guarded read/write helpers, so the two screens cannot drift into
 * two different key shapes or two different fallback rules. Deliberately free of
 * React — the state wiring is a `useState` + `useEffect` in each consumer, which
 * is what keeps this importable from a plain unit test with no renderer.
 *
 * ## Scope of a key
 *
 *   PC     `commandmate.worktree.surfaceMode-<worktreeId>-split-<splitIndex>`
 *   Phone  `commandmate.worktree.surfaceMode-<worktreeId>-mobile`
 *
 * Per split on PC because the panes are independent surfaces onto different
 * agents — watching one agent's transcript while the other's TUI is on screen is
 * the point. The phone shows one pane at a time, so it has one preference.
 *
 * ### Why the `-split-` / `-mobile` discriminators (deviation from Issue #2193)
 *
 * The Issue specifies `…-<worktreeId>-<splitIndex>` and `…-<worktreeId>`. Those
 * two shapes COLLIDE, because a worktree id is a slug of its directory basename
 * (`deriveWorktreeId`, Issue #1621) and may therefore end in `-<digit>`: the
 * phone's key for worktree `proj-1` and split 1's key for worktree `proj` are
 * both `commandmate.worktree.surfaceMode-proj-1`. Two unrelated worktrees would
 * then share one preference across two different screens.
 *
 * Adding a non-numeric discriminator to each shape closes it: every PC key ends
 * in `-split-<n>` and every phone key in `-mobile`, so no id suffix can forge
 * the other family's shape. Asserted in
 * `tests/unit/config/surface-mode-config-2193.test.ts`.
 *
 * ## Why every access is wrapped
 *
 * `localStorage` is not merely absent under SSR: reading it throws outright in a
 * browser configured to block site data, and writing it throws on quota in
 * private mode. A display preference is never worth a render-killing exception,
 * so every path here degrades to {@link DEFAULT_SURFACE_MODE}.
 */

import { DEFAULT_SURFACE_MODE, isSurfaceMode, type SurfaceMode } from '@/types/ui-state';

/**
 * Shared prefix of every surfaceMode key. Mirrors
 * `ACTIVITY_BAR_STORAGE_KEY_PREFIX` so the worktree-scoped preferences all sort
 * together in devtools.
 */
export const SURFACE_MODE_STORAGE_KEY_PREFIX = 'commandmate.worktree.surfaceMode-';

/**
 * The query parameter that deep-links a surface mode (`?view=chat`).
 *
 * Independent of the existing `?pane=` parameter — the two compose
 * (`?pane=terminal&view=chat`), because they answer different questions: which
 * pane is open, and which surface that pane shows.
 */
export const SURFACE_MODE_VIEW_PARAM = 'view';

/**
 * Per-split key for the PC layout. The `-split-` segment is what keeps it out of
 * {@link getMobileSurfaceModeStorageKey}'s namespace — see the module docblock.
 */
export function getSplitSurfaceModeStorageKey(worktreeId: string, splitIndex: number): string {
  return `${SURFACE_MODE_STORAGE_KEY_PREFIX}${worktreeId}-split-${splitIndex}`;
}

/** Per-worktree key for the mobile terminal tab. */
export function getMobileSurfaceModeStorageKey(worktreeId: string): string {
  return `${SURFACE_MODE_STORAGE_KEY_PREFIX}${worktreeId}-mobile`;
}

/**
 * Read a persisted mode, falling back to {@link DEFAULT_SURFACE_MODE} for a
 * missing value, an unparseable one, and a storage that throws.
 */
export function readSurfaceMode(storageKey: string): SurfaceMode {
  if (typeof window === 'undefined') return DEFAULT_SURFACE_MODE;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (isSurfaceMode(raw)) return raw;
  } catch {
    /* storage unavailable (private mode / site data blocked) */
  }
  return DEFAULT_SURFACE_MODE;
}

/** Persist a mode. Silently a no-op when storage is unavailable or full. */
export function writeSurfaceMode(storageKey: string, mode: SurfaceMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, mode);
  } catch {
    /* storage unavailable / quota exceeded */
  }
}

/**
 * Validate `?view=` out of a raw query string.
 *
 * Returns `null` — not the default — for "no usable value", so the caller can
 * tell "the URL asked for terminal" apart from "the URL asked for nothing" and
 * only let the former override localStorage.
 */
export function parseSurfaceModeParam(search: string | null | undefined): SurfaceMode | null {
  if (!search) return null;
  try {
    const raw = new URLSearchParams(search).get(SURFACE_MODE_VIEW_PARAM);
    return isSurfaceMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The current document's `?view=`, validated. SSR-safe (`null` on the server).
 *
 * Read off `window.location` rather than next/navigation's `useSearchParams`
 * because the consumers are deep inside memoized component trees that are
 * rendered by seventeen existing test files with no router in scope; this keeps
 * the deep link working without making a router a mount requirement.
 */
export function readSurfaceModeFromLocation(): SurfaceMode | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseSurfaceModeParam(window.location.search);
  } catch {
    return null;
  }
}

/**
 * Resolve the mode a surface should open in.
 *
 * Precedence: a valid `?view=` wins over localStorage, and is written back to
 * localStorage so the deep link becomes the surface's preference from then on
 * (a shared `?view=chat` link should not silently revert on the next visit).
 * Everything else falls through to the persisted value, then the default.
 *
 * @param storageKey key from {@link getSplitSurfaceModeStorageKey} /
 *   {@link getMobileSurfaceModeStorageKey}
 * @param viewParam  pre-resolved `?view=` value; omit to read the live URL.
 *   Pass `null` explicitly to ignore the URL entirely.
 */
export function resolveSurfaceMode(
  storageKey: string,
  viewParam?: SurfaceMode | null,
): SurfaceMode {
  const fromUrl = viewParam === undefined ? readSurfaceModeFromLocation() : viewParam;
  if (fromUrl) {
    writeSurfaceMode(storageKey, fromUrl);
    return fromUrl;
  }
  return readSurfaceMode(storageKey);
}
