/**
 * Centralized Status Color Configuration
 *
 * SF1: Consolidates color settings that were duplicated across:
 * - BranchStatusIndicator.tsx
 * - MobileHeader.tsx
 * - WorktreeDetailRefactored.tsx
 *
 * G1: waiting status uses the warning token to distinguish from ready (success token)
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
  /** Accessible label for the status */
  label: string;
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
 * Base status configuration for sidebar components
 * Used by: BranchStatusIndicator
 */
export const SIDEBAR_STATUS_CONFIG: Record<SidebarStatusType, StatusConfig> = {
  idle: {
    className: STATUS_COLORS.idle,
    label: 'Idle',
    type: 'dot',
  },
  ready: {
    className: STATUS_COLORS.ready,
    label: 'Ready',
    type: 'dot',
  },
  running: {
    className: STATUS_COLORS.spinner,
    label: 'Running',
    type: 'spinner',
  },
  waiting: {
    className: STATUS_COLORS.waiting,
    label: 'Waiting for response',
    type: 'dot',
  },
  generating: {
    className: STATUS_COLORS.spinner,
    label: 'Generating',
    type: 'spinner',
  },
};

/**
 * Status configuration for mobile header
 * Used by: MobileHeader
 */
export const MOBILE_STATUS_CONFIG: Record<WorktreeStatusType, StatusConfig> = {
  idle: {
    className: STATUS_COLORS.idle,
    label: 'Idle',
    type: 'dot',
  },
  ready: {
    className: STATUS_COLORS.ready,
    label: 'Ready',
    type: 'dot',
  },
  running: {
    className: STATUS_COLORS.spinner,
    label: 'Running',
    type: 'spinner',
  },
  waiting: {
    className: STATUS_COLORS.waiting,
    label: 'Waiting for response',
    type: 'dot',
  },
  error: {
    className: STATUS_COLORS.error,
    label: 'Error',
    type: 'dot',
  },
};

/**
 * Status configuration for desktop header in worktree detail
 * Used by: WorktreeDetailRefactored (DesktopHeader)
 */
export const DESKTOP_STATUS_CONFIG: Record<WorktreeStatusType, StatusConfig> = {
  idle: {
    className: STATUS_COLORS.idle,
    label: 'Idle - No active session',
    type: 'dot',
  },
  ready: {
    className: STATUS_COLORS.ready,
    label: 'Ready - Waiting for input',
    type: 'dot',
  },
  running: {
    className: STATUS_COLORS.spinner,
    label: 'Running - Processing',
    type: 'spinner',
  },
  waiting: {
    className: STATUS_COLORS.waiting,
    label: 'Waiting - User input required',
    type: 'dot',
  },
  error: {
    className: STATUS_COLORS.error,
    label: 'Error',
    type: 'dot',
  },
};
