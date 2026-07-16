/**
 * Centralized Status Color Configuration
 *
 * SF1: Consolidates color settings that were duplicated across the status
 * surfaces. Consumers today are `ReviewTab` and Sessions (SIDEBAR_STATUS_CONFIG)
 * plus the worktree-detail DesktopHeader (DESKTOP_STATUS_LABEL_KEYS);
 * BranchStatusIndicator and MobileHeader now render <StatusDot> directly.
 *
 * G1: waiting status uses the warning token to distinguish from ready (success token)
 *
 * Issue #1304: labels are stored as dictionary *keys*, never literals. This is a
 * module-scope config imported by many components, so t() cannot be called here
 * (Issue #1271) — the render site resolves the key.
 */

// ============================================================================
// Types
// ============================================================================

/** Base status types common to all components */
export type BaseStatusType = 'idle' | 'ready' | 'running' | 'waiting';

/** Extended status types for sidebar (includes generating) */
export type SidebarStatusType = BaseStatusType | 'generating';

/** Extended status types for worktree detail (includes error) */
export type WorktreeStatusType = BaseStatusType | 'error';

/**
 * Display type for status indicator.
 * @deprecated Issue #1078: `'spinner'` is being retired in favour of the unified
 * `<StatusDot>` (running = green glow). Only `ReviewTab.tsx` still branches on it.
 */
export type StatusDisplayType = 'dot' | 'spinner';

/** Status configuration interface */
export interface StatusConfig {
  /** Tailwind CSS class for the color */
  className: string;
  /**
   * Key into the `common.status.*` dictionary for the accessible label
   * (Issue #1273 defined these generic keys; #1304 reuses them here). A literal
   * would pin the label to English at module scope, where t() cannot run.
   */
  labelKey: string;
  /** Display type: 'dot' for static circle, 'spinner' for animated */
  type: StatusDisplayType;
}

// ============================================================================
// Color Constants
// ============================================================================

/** Centralized color class definitions */
export const STATUS_COLORS = {
  /** Muted for idle/inactive state */
  idle: 'bg-muted-foreground',
  /** Success token for ready/active state */
  ready: 'bg-success',
  /**
   * @deprecated Issue #1078: the blue rotating-ring spinner is being unified
   * into the single `<StatusDot>` visual language (running = green glow). Kept
   * only because `ReviewTab.tsx` still consumes the `type: 'spinner'` branch;
   * remove this constant and the `type: 'spinner'` configs below once that last
   * consumer migrates to `<StatusDot>`.
   */
  spinner: 'border-info',
  /** Warning token for waiting state (G1: distinguishes from ready) */
  waiting: 'bg-warning',
  /** Danger token for error state */
  error: 'bg-danger',
} as const;

// ============================================================================
// Status Configurations
// ============================================================================

/**
 * Base status configuration for the agent status dots.
 * Used by: ReviewTab, Sessions page.
 *
 * Every label here is one of the generic `common.status.*` words, so the keys
 * are reused verbatim rather than re-declared (Issue #1304).
 */
export const SIDEBAR_STATUS_CONFIG: Record<SidebarStatusType, StatusConfig> = {
  idle: {
    className: STATUS_COLORS.idle,
    labelKey: 'status.idle',
    type: 'dot',
  },
  ready: {
    className: STATUS_COLORS.ready,
    labelKey: 'status.ready',
    type: 'dot',
  },
  running: {
    className: STATUS_COLORS.spinner,
    labelKey: 'status.running',
    type: 'spinner',
  },
  waiting: {
    className: STATUS_COLORS.waiting,
    labelKey: 'status.waiting',
    type: 'dot',
  },
  generating: {
    className: STATUS_COLORS.spinner,
    labelKey: 'status.generating',
    type: 'spinner',
  },
};

/**
 * Long-form status descriptions for the worktree-detail desktop header
 * (Issue #1304). Keys are relative to the `worktree` namespace.
 *
 * Unlike SIDEBAR_STATUS_CONFIG these are *not* the generic `common.status.*`
 * words ("Idle - No active session" vs. "Idle"), so they need their own entries.
 *
 * `error` is intentionally absent: its label is exactly the generic
 * `common.status.error` that <StatusDot> already resolves when no `label` is
 * passed, so re-declaring it here would duplicate the wording that #1273
 * centralised. The map is Partial for that reason — an absent key means
 * "let StatusDot use its generic default".
 *
 * Only the label varies per status here; the dot's color/motion comes from
 * <StatusDot> itself, which is why this is a key map rather than a StatusConfig.
 */
export const DESKTOP_STATUS_LABEL_KEYS: Partial<Record<WorktreeStatusType, string>> = {
  idle: 'detailStatus.idle',
  ready: 'detailStatus.ready',
  running: 'detailStatus.running',
  waiting: 'detailStatus.waiting',
};
