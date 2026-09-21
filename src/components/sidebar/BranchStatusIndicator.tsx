/**
 * BranchStatusIndicator Component
 *
 * Displays a colored dot indicating the branch's current status.
 * Delegates rendering to the shared StatusDot primitive (Issue #1051): active
 * states (running/generating) glow and pulse, waiting pulses harder still
 * (Issue #1787), and the rest are static dots.
 *
 * Issue #2775 adds one look that is not a `BranchStatus`: "cannot tell", for a
 * `ready` that is only `ready` because no rule could read the agent's frame. It
 * is a static hollow gray ring — no motion (it is not a reading of work), not
 * green (it is not a reading of readiness), and labelled "Unknown". The ring is
 * exported so every surface that draws an agent dot draws the same one.
 */

'use client';

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import type { BranchStatus, BranchWaitingKind } from '@/types/sidebar';
import { StatusDot } from '@/components/ui/StatusDot';

// ============================================================================
// Constants
// ============================================================================

/**
 * Classes that turn a `ready` StatusDot into the "cannot tell" ring (Issue #2775).
 *
 * Applied through StatusDot's `className`, which `cn` merges last, so
 * `bg-transparent` replaces the `ready` fill. `border-*` rather than `ring-*`
 * because `ring` is how the running and waiting dots mark themselves; a border
 * is a shape none of the five statuses uses. StatusDot itself is shared UI and
 * stays untouched — `status` is still `ready`, and no other status is ever
 * drawn with these classes (see {@link resolveUnclassifiedDot}).
 */
export const UNCLASSIFIED_STATUS_DOT_CLASS = 'bg-transparent border-2 border-muted-foreground';

/**
 * `common.*` dictionary key for the "cannot tell" label (Issue #2775).
 *
 * The existing generic `common.status.unknown` word ("Unknown" / "不明"), which
 * StatusDot already uses for a status it does not recognise — the same meaning.
 */
export const UNCLASSIFIED_STATUS_LABEL_KEY = 'status.unknown';

/**
 * Whether a dot should be drawn as "cannot tell" (Issue #2775).
 *
 * `unclassified` is the caller's reading of the published flag
 * (`isUnclassifiedCliStatus` / `isBranchUnclassified`). The `ready` check here
 * is the render-side half of the guarantee that a `running` — least of all one
 * with positive evidence — can never lose its glow to this look: whatever a
 * caller passes, only a `ready` dot is ever redrawn.
 */
export function resolveUnclassifiedDot(status: string, unclassified?: boolean): boolean {
  return unclassified === true && status === 'ready';
}

// ============================================================================
// Types
// ============================================================================

/** Props for BranchStatusIndicator */
export interface BranchStatusIndicatorProps {
  /** Current branch status */
  status: BranchStatus;
  /**
   * Optional accessible label override (Issue #867).
   * When provided (e.g. a per-agent breakdown like "Claude: running, Codex: idle"),
   * it replaces the default status-config label for both `title` and `aria-label`.
   * Falls back to the status config label when omitted.
   */
  label?: string;
  /**
   * Kind of wait behind a `waiting` status (Issue #1787). Absent → strong
   * emphasis, which is the correct fallback for a payload that predates #1786.
   */
  waitingKind?: BranchWaitingKind | null;
  /**
   * The `ready` in `status` is a fallback for a frame nothing could read
   * (Issue #2775): draw the "cannot tell" ring instead. Ignored for every
   * status but `ready`.
   */
  unclassified?: boolean;
}

// ============================================================================
// Component
// ============================================================================

/**
 * BranchStatusIndicator displays a colored status dot or spinner
 *
 * @example
 * ```tsx
 * <BranchStatusIndicator status="running" />
 * ```
 */
export const BranchStatusIndicator = memo(function BranchStatusIndicator({
  status,
  label,
  waitingKind,
  unclassified,
}: BranchStatusIndicatorProps) {
  const tCommon = useTranslations('common');
  // Issue #2775: StatusDot would label a `ready` dot "Ready", which is the one
  // word this look exists to avoid — so the default label is resolved here.
  const showUnclassified = resolveUnclassifiedDot(status, unclassified);
  // Issue #867: `label` (per-agent breakdown) overrides the default; StatusDot
  // falls back to the status's own label when omitted.
  return (
    <StatusDot
      data-testid="status-indicator"
      status={status}
      label={showUnclassified ? (label ?? tCommon(UNCLASSIFIED_STATUS_LABEL_KEY)) : label}
      waitingKind={waitingKind}
      size="lg"
      className={showUnclassified ? UNCLASSIFIED_STATUS_DOT_CLASS : undefined}
      data-unclassified={showUnclassified ? 'true' : undefined}
    />
  );
});
