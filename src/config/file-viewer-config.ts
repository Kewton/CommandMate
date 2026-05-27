/**
 * File Viewer Configuration (Issue #723)
 *
 * Constants controlling the read-only large-file viewer's chunked fetch,
 * virtualized rendering, and polling-throttling thresholds.
 *
 * Used by:
 * - `src/components/worktree/FilePanelContent.tsx` (CodeViewer virtualization)
 * - `src/hooks/useFileContentPolling.ts` (large-file polling disable)
 * - `src/lib/file-operations.ts` `readFileLineRange()` (server-side bounds)
 * - `src/app/api/worktrees/[id]/files/[...path]/route.ts` (line-range mode)
 */

/**
 * Number of lines per chunked fetch.
 *
 * Chosen so that one chunk roughly covers ~10 viewport heights at 1080p / 24px line
 * height (~45 visible rows). Reduces fetch frequency while keeping each payload
 * bounded to a few hundred KB even for wide lines.
 */
export const VIEWER_CHUNK_LINE_SIZE = 500;

/**
 * Number of lines rendered above/below the visible viewport.
 *
 * Provides ~2 viewport heights of buffer so that small scroll jumps do not
 * trigger immediate chunk fetches. Used by `@tanstack/react-virtual` overscan.
 */
export const VIEWER_OVERSCAN_LINES = 100;

/**
 * File-size threshold (bytes) above which content-polling is disabled.
 *
 * Set conservatively to 1MB — half of {@link TEXT_MAX_SIZE_BYTES} (2MB) — so that
 * even editable files larger than ~1MB skip auto-reload while still allowing
 * manual refresh.
 *
 * Note: the numeric value coincides with the previous `TEXT_MAX_SIZE_BYTES`
 * (1MB) before Issue #723's bump, but the meaning is different — this is a
 * polling-throttle threshold, not an absolute upper limit.
 */
export const POLLING_DISABLED_THRESHOLD_BYTES = 1 * 1024 * 1024;
