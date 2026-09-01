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
 *
 * ## The configured default (Issue #2201)
 *
 * A surface with NOTHING persisted no longer falls straight to
 * {@link DEFAULT_SURFACE_MODE}: it falls to the server-wide setting
 * (`app_settings.default_surface_mode`, `/api/settings/default-surface-mode`),
 * mirrored on the client by {@link getClientDefaultSurfaceMode}. The order is
 * "what this surface was last left as" first and "what the user asked new
 * surfaces to open as" second — a setting names the *starting* value, so
 * letting it outrank a mode the user switched to by hand would make the toggle
 * unable to stick.
 *
 * The mirror is deliberately synchronous and localStorage-backed rather than a
 * fetch, because every consumer reads this from a `useState` initializer during
 * render, where a promise resolves long after the value it would inform has
 * been returned. So the ladder is: mirror now, server later.
 * {@link readSurfaceMode} kicks off {@link ensureClientDefaultSurfaceMode} once
 * per page session in the background, and what that request buys is the NEXT
 * surface the user opens — including, after a reload, the first one. A device
 * that has never reached the server still opens on
 * {@link DEFAULT_SURFACE_MODE}, which is the pre-#2201 behaviour.
 *
 * The settings card seeds it directly from the payload it already fetched, so
 * saving the setting takes effect on that device without waiting for a reload.
 */

import { DEFAULT_SURFACE_MODE, isSurfaceMode, type SurfaceMode } from '@/types/ui-state';

/**
 * Shared prefix of every surfaceMode key. Mirrors
 * `ACTIVITY_BAR_STORAGE_KEY_PREFIX` so the worktree-scoped preferences all sort
 * together in devtools.
 */
export const SURFACE_MODE_STORAGE_KEY_PREFIX = 'commandmate.worktree.surfaceMode-';

/**
 * localStorage key holding this device's copy of the server-wide default
 * (Issue #2201).
 *
 * Outside {@link SURFACE_MODE_STORAGE_KEY_PREFIX} on purpose: that prefix is
 * the per-(worktree, surface) namespace, and a settings mirror sitting inside
 * it would be one `deriveWorktreeId` collision away from being read as some
 * worktree's persisted mode.
 */
export const DEFAULT_SURFACE_MODE_STORAGE_KEY = 'commandmate.settings.defaultSurfaceMode';

/** Where the client asks the server for the configured default (Issue #2201). */
export const DEFAULT_SURFACE_MODE_ENDPOINT = '/api/settings/default-surface-mode';

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
 * Read one key as a mode, or `null` for "nothing usable here".
 *
 * `null` rather than the default, for the same reason
 * {@link parseSurfaceModeParam} returns it: the caller has a further fallback
 * layer to consult and must be able to tell "stored: terminal" apart from
 * "stored: nothing".
 */
function readStoredMode(storageKey: string): SurfaceMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    return isSurfaceMode(raw) ? raw : null;
  } catch {
    /* storage unavailable (private mode / site data blocked) */
    return null;
  }
}

/**
 * Read a persisted mode, falling back to the configured default
 * (Issue #2201) for a missing value, an unparseable one, and a storage that
 * throws — and to {@link DEFAULT_SURFACE_MODE} when nothing is configured
 * either.
 *
 * The precedence is the whole point of the Issue and is asserted directly in
 * `tests/unit/config/surface-mode-default-2201.test.ts`: a surface that HAS
 * been left in a mode keeps it, whatever the setting now says. Inverting these
 * two lines would make every save on the settings screen silently reset every
 * surface the user had switched by hand.
 */
export function readSurfaceMode(storageKey: string): SurfaceMode {
  scheduleClientDefaultSurfaceModeSeed();
  return readStoredMode(storageKey) ?? getClientDefaultSurfaceMode();
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
 * Everything else falls through to the persisted value, then the configured
 * default (Issue #2201), then {@link DEFAULT_SURFACE_MODE} — the whole ladder
 * lives in {@link readSurfaceMode} so the URL layer cannot grow its own copy of
 * it.
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

// ============================================================================
// Configured default (Issue #2201)
// ============================================================================

/**
 * In-memory copy of the configured default.
 *
 * Only consulted when the localStorage mirror is unreadable — a browser that
 * blocks site data still gets the setting for the life of the page once
 * something has seeded it, instead of being pinned to the constant.
 */
let clientDefaultSurfaceMode: SurfaceMode = DEFAULT_SURFACE_MODE;

/** Listeners for {@link subscribeToClientDefaultSurfaceMode}. */
const defaultListeners = new Set<() => void>();

/**
 * The mode a surface with nothing persisted opens in.
 *
 * localStorage first, so the answer survives a reload without a request and is
 * available synchronously inside a `useState` initializer; the in-memory copy
 * is the fallback for a storage that refuses to answer. Returns
 * {@link DEFAULT_SURFACE_MODE} when neither holds anything, which is exactly
 * the pre-#2201 behaviour.
 */
export function getClientDefaultSurfaceMode(): SurfaceMode {
  return readStoredMode(DEFAULT_SURFACE_MODE_STORAGE_KEY) ?? clientDefaultSurfaceMode;
}

/**
 * Adopt a default sent by the server, mirroring it for later page loads.
 *
 * Validated with {@link isSurfaceMode} rather than trusted: whatever ships this
 * value is one JSON field away from being wrong, and a bad one must leave the
 * previous answer standing rather than push an unswitchable mode into every
 * surface that has no preference yet.
 *
 * @param value - Candidate mode from a server response
 * @returns true when the effective default changed
 */
export function setClientDefaultSurfaceMode(value: unknown): boolean {
  if (!isSurfaceMode(value)) return false;
  const changed = getClientDefaultSurfaceMode() !== value;
  clientDefaultSurfaceMode = value;
  writeSurfaceMode(DEFAULT_SURFACE_MODE_STORAGE_KEY, value);
  if (changed) {
    for (const listener of defaultListeners) listener();
  }
  return changed;
}

/**
 * Return the client default to the compiled-in constant, mirror included.
 * Used by tests and by a settings reset.
 */
export function resetClientDefaultSurfaceMode(): void {
  const changed = getClientDefaultSurfaceMode() !== DEFAULT_SURFACE_MODE;
  clientDefaultSurfaceMode = DEFAULT_SURFACE_MODE;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(DEFAULT_SURFACE_MODE_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }
  inFlightDefault = null;
  seededDefault = false;
  implicitSeedStarted = false;
  if (changed) {
    for (const listener of defaultListeners) listener();
  }
}

/** Subscribe to changes of the client default. Returns an unsubscribe function. */
export function subscribeToClientDefaultSurfaceMode(listener: () => void): () => void {
  defaultListeners.add(listener);
  return () => {
    defaultListeners.delete(listener);
  };
}

let inFlightDefault: Promise<SurfaceMode> | null = null;
let seededDefault = false;
let implicitSeedStarted = false;

/**
 * Start the background seed at most once per page session, from the read path.
 *
 * Fire-and-forget on purpose: {@link readSurfaceMode} runs inside `useState`
 * initializers during render and must stay synchronous, so the request cannot
 * inform the value being returned — it informs the next one. This is what
 * carries the setting to a device that has never opened the settings screen.
 *
 * Latched with its own flag rather than `seededDefault`, so a server that is
 * down does not turn every re-render into another request; an explicit
 * {@link ensureClientDefaultSurfaceMode} still retries.
 */
function scheduleClientDefaultSurfaceModeSeed(): void {
  if (implicitSeedStarted) return;
  if (typeof window === 'undefined') return;
  implicitSeedStarted = true;
  void ensureClientDefaultSurfaceMode();
}

/**
 * Seed the client default from the server, at most once per page session.
 *
 * Single-flight and idempotent, so two cards mounting in the same screen cost
 * one request. Failures are swallowed: the mirrored or compiled-in value is a
 * correct answer, and a settings fetch is never a reason to break a screen.
 *
 * Also reached from {@link readSurfaceMode}'s background seed, and callable
 * directly from a mount effect that wants the setting sooner.
 *
 * @returns The client default in force after the attempt
 */
export async function ensureClientDefaultSurfaceMode(): Promise<SurfaceMode> {
  if (seededDefault) return getClientDefaultSurfaceMode();
  if (inFlightDefault) return inFlightDefault;
  if (typeof fetch !== 'function') return getClientDefaultSurfaceMode();

  inFlightDefault = (async () => {
    try {
      const response = await fetch(DEFAULT_SURFACE_MODE_ENDPOINT);
      if (response.ok) {
        const body = await response.json();
        setClientDefaultSurfaceMode((body as { defaultSurfaceMode?: unknown })?.defaultSurfaceMode);
        seededDefault = true;
      }
    } catch {
      // Offline / server restarting: keep whatever the mirror already holds.
    } finally {
      inFlightDefault = null;
    }
    return getClientDefaultSurfaceMode();
  })();

  return inFlightDefault;
}
