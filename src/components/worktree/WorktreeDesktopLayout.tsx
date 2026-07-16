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
 */

'use client';

import React, { useState, useCallback, useRef, useMemo, memo, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
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

  /** Optional extra className for the root element. */
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ACTIVITY_PANE_WIDTH = 18;
const DEFAULT_MIN_PANE_WIDTH = 10;
const DEFAULT_MAX_PANE_WIDTH = 60;

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
    () => `flex h-full min-h-0 ${className}`.trim(),
    [className]
  );

  const showActivityCol = activityPane !== null;

  return (
    <div ref={containerRef} className="h-full">
      <div
        data-testid="desktop-layout"
        role="main"
        className={containerClassName}
      >
        {/* Activity Pane (variable, optional) */}
        {showActivityCol && (
          <>
            <div
              id={ACTIVITY_PANE_ID}
              data-testid="activity-pane-slot"
              aria-label={t('desktopLayout.activityPane')}
              style={{ width: `${effectiveActivityWidth}%` }}
              className="flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out"
            >
              <ErrorBoundary componentName="ActivityPane">{activityPane}</ErrorBoundary>
            </div>
            <PaneResizer
              onResize={handleActivityResize}
              orientation="horizontal"
              ariaValueNow={effectiveActivityWidth}
            />
          </>
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

export default WorktreeDesktopLayout;
