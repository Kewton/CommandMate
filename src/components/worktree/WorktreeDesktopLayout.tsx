/**
 * WorktreeDesktopLayout Component (Issue #727, simplified by Issue #730)
 *
 * 2-column desktop layout:
 *   [ActivityPane (variable, optional)] + Resizer + [Right pane (flex)]
 *
 * History was moved inside the Right pane via `TerminalContainer` (Issue #730),
 * and the outer ActivityBar now runs full-height managed by the parent
 * (`WorktreeDetailRefactored`). Mobile fallback was also removed: the parent
 * renders `MobileContent` on its own for the mobile path.
 *
 * - When `activityPane` is null, the activity column AND its trailing resizer
 *   are hidden.
 * - Each pane is wrapped in ErrorBoundary for fault isolation.
 *
 * Issue #3589: the activity pane is laid OVER the right pane unless it is
 * pinned (`activityPanePinned`), so opening it no longer narrows the terminal.
 * Only a pinned pane takes a column (and a resizer) as before. The frame the
 * pane is shown in — title, pin, × and the overlay's Esc / outside-press
 * dismissal — is {@link PaneOverlayFrame}, below, shared with other panels of
 * the same kind (Issue #3591).
 */

'use client';

import React, { useState, useCallback, useRef, useMemo, memo, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Pin, PinOff, X } from 'lucide-react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { Tooltip } from '@/components/common/Tooltip';
import {
  usePaneOverlayDismiss,
  type PaneDismissReason,
} from '@/hooks/useActivityPaneOverlay';
import { PaneResizer } from './PaneResizer';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for WorktreeDesktopLayout component (Issue #730 simplified 2-column API).
 */
export interface WorktreeDesktopLayoutProps {
  /** Activity Pane content. Pass `null` to hide the column entirely. */
  activityPane: ReactNode | null;
  /** Right column (history + terminal + file panel). Always rendered. */
  rightPane: ReactNode;

  /** Width of the activity pane column in percent (default 18). */
  activityPaneWidth?: number;
  /** Minimum pane width in percent (default 10). */
  minPaneWidth?: number;
  /** Maximum pane width in percent (default 60). */
  maxPaneWidth?: number;

  /** Called when the activity pane is resized (delta in percent). */
  onActivityPaneResize?: (nextPercent: number) => void;

  /**
   * Issue #3589: `true` lays the activity pane out beside the right pane (a
   * column with a resizer, the pre-#3589 layout); `false` lays it over the
   * right pane, whose width then does not change. Defaults to `true` so a
   * caller that does not know about pinning keeps the old layout.
   */
  activityPanePinned?: boolean;

  /**
   * Issue #3589: when given, the activity pane is shown inside a
   * {@link PaneOverlayFrame} (title row with pin / ×, and — while unpinned —
   * Esc / outside-press dismissal). Its `pinned` is `activityPanePinned`.
   * Omit to render `activityPane` bare, as before.
   */
  activityPaneFrame?: Omit<PaneOverlayFrameProps, 'children' | 'pinned'>;

  /** Optional extra className for the root element. */
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ACTIVITY_PANE_WIDTH = 18;
const DEFAULT_MIN_PANE_WIDTH = 10;
const DEFAULT_MAX_PANE_WIDTH = 60;

/**
 * Issue #3589: the overlay keeps the percent width of the pinned column but
 * never gets narrower than this — over the body there is no reason to squeeze
 * a file tree into 18% of a small window.
 */
const OVERLAY_MIN_WIDTH_PX = 280;

const ACTIVITY_PANE_ID = 'worktree-activity-pane';
const RIGHT_PANE_ID = 'worktree-right-pane';

// ============================================================================
// Main component
// ============================================================================

export const WorktreeDesktopLayout = memo(function WorktreeDesktopLayout({
  activityPane,
  rightPane,
  activityPaneWidth = DEFAULT_ACTIVITY_PANE_WIDTH,
  minPaneWidth = DEFAULT_MIN_PANE_WIDTH,
  maxPaneWidth = DEFAULT_MAX_PANE_WIDTH,
  onActivityPaneResize,
  activityPanePinned = true,
  activityPaneFrame,
  className = '',
}: WorktreeDesktopLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useTranslations('worktree');

  // Internal width state (controlled fallback when no on*Resize callback is provided).
  const [localActivityWidth, setLocalActivityWidth] = useState(activityPaneWidth);

  // Effective width follows props if "controlled", otherwise the internal state.
  const effectiveActivityWidth = onActivityPaneResize ? activityPaneWidth : localActivityWidth;

  const handleActivityResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const percentDelta = (delta / w) * 100;
      const current = onActivityPaneResize ? activityPaneWidth : localActivityWidth;
      const next = Math.min(maxPaneWidth, Math.max(minPaneWidth, current + percentDelta));
      if (onActivityPaneResize) onActivityPaneResize(next);
      else setLocalActivityWidth(next);
    },
    [activityPaneWidth, localActivityWidth, minPaneWidth, maxPaneWidth, onActivityPaneResize]
  );

  const containerClassName = useMemo(
    () => `relative flex h-full min-h-0 ${className}`.trim(),
    [className]
  );

  const showActivityCol = activityPane !== null;
  const framedActivityPane =
    showActivityCol && activityPaneFrame ? (
      <PaneOverlayFrame {...activityPaneFrame} pinned={activityPanePinned}>
        {activityPane}
      </PaneOverlayFrame>
    ) : (
      activityPane
    );

  return (
    <div ref={containerRef} className="h-full">
      <div
        data-testid="desktop-layout"
        role="main"
        className={containerClassName}
      >
        {/* Activity Pane (variable, optional), pinned: a column beside the body */}
        {showActivityCol && activityPanePinned && (
          <>
            <div
              id={ACTIVITY_PANE_ID}
              data-testid="activity-pane-slot"
              data-pinned="true"
              aria-label={t('desktopLayout.activityPane')}
              style={{ width: `${effectiveActivityWidth}%` }}
              className="flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out"
            >
              <ErrorBoundary componentName="ActivityPane">{framedActivityPane}</ErrorBoundary>
            </div>
            <PaneResizer
              onResize={handleActivityResize}
              orientation="horizontal"
              ariaValueNow={effectiveActivityWidth}
            />
          </>
        )}

        {/* Issue #3589: not pinned — over the body, which keeps its width. */}
        {showActivityCol && !activityPanePinned && (
          <div
            id={ACTIVITY_PANE_ID}
            data-testid="activity-pane-slot"
            data-pinned="false"
            aria-label={t('desktopLayout.activityPane')}
            style={{ width: `${effectiveActivityWidth}%`, minWidth: OVERLAY_MIN_WIDTH_PX }}
            className="absolute inset-y-0 left-0 z-20 max-w-full overflow-hidden border-r border-border bg-surface shadow-lg"
          >
            <ErrorBoundary componentName="ActivityPane">{framedActivityPane}</ErrorBoundary>
          </div>
        )}

        {/* Right pane (history + terminal + file panel) — fills remaining space */}
        <div
          id={RIGHT_PANE_ID}
          data-testid="right-pane-slot"
          aria-label={t('desktopLayout.terminalPane')}
          className="flex-grow overflow-hidden min-w-0"
        >
          <ErrorBoundary componentName="TerminalPane">{rightPane}</ErrorBoundary>
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// PaneOverlayFrame (Issue #3589)
// ============================================================================

export interface PaneOverlayFrameProps {
  /** Heading shown in the frame's title row. */
  title: string;
  /**
   * Pin state — owned by the caller via `usePanePinnedState(storageKey)` from
   * `@/hooks/useActivityPaneOverlay`, which persists it under that key. The
   * frame only shows it and reports clicks; whether the panel is then laid
   * out beside or over the body is the layout's call (see
   * `WorktreeDesktopLayout`'s `activityPanePinned`).
   */
  pinned: boolean;
  /** Pin button clicked. */
  onTogglePinned: () => void;
  /** × clicked. Always closes, edits or not. */
  onClose: () => void;
  /**
   * Esc / an outside press asked to close the (unpinned) panel. Never called
   * while pinned. See `usePaneOverlayDismiss` for when each one fires.
   */
  onDismiss: (reason: PaneDismissReason) => void;
  /** Regions a press in which is not "outside" (the panel's own toggle). */
  ignoreOutsideSelectors?: readonly string[];
  /** Extra unsaved-edits signal; while true an outside press does not close. */
  isDirty?: () => boolean;
  /** Changing it forgets the frame's "edited" flag (new content shown). */
  resetKey?: unknown;
  /** Prefix for the frame's test ids. */
  testIdPrefix?: string;
  children: ReactNode;
}

/**
 * The frame a side panel is shown in: a title row with pin and × buttons over
 * the panel's own content. While unpinned it also closes the panel on Esc and
 * on a press outside it (both guarded — see `usePaneOverlayDismiss`).
 *
 * Reusable: the activity pane uses it (Issue #3589) and other panels that
 * open over the body can use the same one (Issue #3591).
 */
export const PaneOverlayFrame = memo(function PaneOverlayFrame({
  title,
  pinned,
  onTogglePinned,
  onClose,
  onDismiss,
  ignoreOutsideSelectors,
  isDirty,
  resetKey,
  testIdPrefix = 'pane-overlay',
  children,
}: PaneOverlayFrameProps) {
  const t = useTranslations('worktree');
  const frameRef = useRef<HTMLDivElement>(null);
  const { panelProps } = usePaneOverlayDismiss({
    enabled: !pinned,
    panelRef: frameRef,
    onDismiss,
    ignoreSelectors: ignoreOutsideSelectors,
    isDirty,
    resetKey,
  });

  const pinLabel = pinned ? t('desktopLayout.unpinPane') : t('desktopLayout.pinPane');
  const iconButtonClass =
    'flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div
      ref={frameRef}
      data-testid={`${testIdPrefix}-frame`}
      data-pinned={pinned ? 'true' : 'false'}
      className="h-full flex flex-col min-h-0 bg-surface"
      {...panelProps}
    >
      <div className="flex items-center gap-1 h-9 flex-shrink-0 pl-3 pr-1 border-b border-border">
        <span
          data-testid={`${testIdPrefix}-title`}
          className="flex-1 min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {title}
        </span>
        <Tooltip content={pinLabel} placement="bottom">
          <button
            type="button"
            onClick={onTogglePinned}
            aria-pressed={pinned}
            aria-label={pinLabel}
            data-testid={`${testIdPrefix}-pin`}
            className={`${iconButtonClass} ${pinned ? 'text-accent-600 dark:text-accent-400' : ''}`.trim()}
          >
            {pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Tooltip content={t('desktopLayout.closePane')} placement="bottom">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('desktopLayout.closePane')}
            data-testid={`${testIdPrefix}-close`}
            className={iconButtonClass}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
});

export default WorktreeDesktopLayout;
