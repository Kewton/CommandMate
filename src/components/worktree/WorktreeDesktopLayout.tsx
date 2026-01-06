/**
 * WorktreeDesktopLayout Component
 *
 * Two-column grid layout with resizable panes.
 * Wraps each pane in ErrorBoundary for fault isolation.
 * Responsive: switches to single column on mobile.
 */

'use client';

import React, { useState, useCallback, useRef, useMemo, memo, ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { useIsMobile } from '@/hooks/useIsMobile';
import { PaneResizer } from './PaneResizer';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for WorktreeDesktopLayout component
 */
export interface WorktreeDesktopLayoutProps {
  /** Content for the left pane */
  leftPane: ReactNode;
  /** Content for the right pane */
  rightPane: ReactNode;
  /** Initial width of left pane as percentage (default: 50) */
  initialLeftWidth?: number;
  /** Minimum width of left pane as percentage (default: 20) */
  minLeftWidth?: number;
  /** Maximum width of left pane as percentage (default: 80) */
  maxLeftWidth?: number;
  /** Additional CSS classes */
  className?: string;
}

/** Props for MobileLayout sub-component */
interface MobileLayoutProps {
  leftPane: ReactNode;
  rightPane: ReactNode;
}

/** Props for DesktopLayout sub-component */
interface DesktopLayoutProps {
  leftPane: ReactNode;
  rightPane: ReactNode;
  leftWidth: number;
  onResize: (delta: number) => void;
  className: string;
}

/** Active pane type for mobile layout */
type ActivePane = 'left' | 'right';

// ============================================================================
// Constants
// ============================================================================

/** Default pane width settings */
const DEFAULT_LEFT_WIDTH = 50;
const DEFAULT_MIN_WIDTH = 20;
const DEFAULT_MAX_WIDTH = 80;

/** Tab labels for mobile layout */
const TAB_LABELS = {
  left: 'History',
  right: 'Terminal',
} as const;

/** Component names for ErrorBoundary */
const COMPONENT_NAMES = {
  left: 'HistoryPane',
  right: 'TerminalPane',
} as const;

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Tab button for mobile layout.
 * Memoized to prevent unnecessary re-renders.
 */
const TabButton = memo(function TabButton({
  pane,
  isActive,
  onClick,
}: {
  pane: ActivePane;
  isActive: boolean;
  onClick: () => void;
}) {
  const baseClasses = 'flex-1 py-2 px-4 text-sm font-medium transition-colors';
  const activeClasses = 'text-blue-400 border-b-2 border-blue-400 bg-gray-900';
  const inactiveClasses = 'text-gray-400 hover:text-gray-300';

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={`${pane}-panel`}
      onClick={onClick}
      className={`${baseClasses} ${isActive ? activeClasses : inactiveClasses}`}
    >
      {TAB_LABELS[pane]}
    </button>
  );
});

/**
 * Mobile layout component - single column with toggle.
 * Memoized to prevent unnecessary re-renders.
 */
const MobileLayout = memo(function MobileLayout({
  leftPane,
  rightPane,
}: MobileLayoutProps) {
  const [activePane, setActivePane] = useState<ActivePane>('right');

  const handleLeftClick = useCallback(() => setActivePane('left'), []);
  const handleRightClick = useCallback(() => setActivePane('right'), []);

  const currentPane = activePane === 'left' ? leftPane : rightPane;

  return (
    <div data-testid="mobile-layout" className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 bg-gray-800" role="tablist">
        <TabButton pane="left" isActive={activePane === 'left'} onClick={handleLeftClick} />
        <TabButton pane="right" isActive={activePane === 'right'} onClick={handleRightClick} />
      </div>

      {/* Active pane content */}
      <div
        id={`${activePane}-panel`}
        role="tabpanel"
        className="flex-1 overflow-hidden"
      >
        <ErrorBoundary componentName={COMPONENT_NAMES[activePane]}>
          {currentPane}
        </ErrorBoundary>
      </div>
    </div>
  );
});

/**
 * Desktop layout component - two columns with resizer.
 * Memoized to prevent unnecessary re-renders.
 */
const DesktopLayout = memo(function DesktopLayout({
  leftPane,
  rightPane,
  leftWidth,
  onResize,
  className,
}: DesktopLayoutProps) {
  // Memoize pane width styles
  const leftPaneStyle = useMemo(() => ({ width: `${leftWidth}%` }), [leftWidth]);
  const rightPaneStyle = useMemo(() => ({ width: `${100 - leftWidth}%` }), [leftWidth]);

  // Memoize container className
  const containerClassName = useMemo(
    () => `flex h-full min-h-0 ${className}`.trim(),
    [className]
  );

  return (
    <div
      data-testid="desktop-layout"
      role="main"
      className={containerClassName}
    >
      {/* Left pane */}
      <div
        data-testid="left-pane"
        aria-label="History pane"
        style={leftPaneStyle}
        className="flex-shrink-0 overflow-hidden"
      >
        <ErrorBoundary componentName={COMPONENT_NAMES.left}>
          {leftPane}
        </ErrorBoundary>
      </div>

      {/* Resizer */}
      <PaneResizer onResize={onResize} orientation="horizontal" ariaValueNow={leftWidth} />

      {/* Right pane */}
      <div
        data-testid="right-pane"
        aria-label="Terminal pane"
        style={rightPaneStyle}
        className="flex-grow overflow-hidden"
      >
        <ErrorBoundary componentName={COMPONENT_NAMES.right}>
          {rightPane}
        </ErrorBoundary>
      </div>
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * WorktreeDesktopLayout component for two-column layout with resizable panes.
 *
 * Features:
 * - Resizable panes with drag support
 * - Responsive design (mobile/desktop)
 * - Error boundary isolation for each pane
 * - Keyboard and touch support
 *
 * @example
 * ```tsx
 * <WorktreeDesktopLayout
 *   leftPane={<HistoryPane messages={messages} />}
 *   rightPane={<TerminalDisplay output={output} />}
 *   initialLeftWidth={40}
 *   minLeftWidth={20}
 *   maxLeftWidth={60}
 * />
 * ```
 */
export const WorktreeDesktopLayout = memo(function WorktreeDesktopLayout({
  leftPane,
  rightPane,
  initialLeftWidth = DEFAULT_LEFT_WIDTH,
  minLeftWidth = DEFAULT_MIN_WIDTH,
  maxLeftWidth = DEFAULT_MAX_WIDTH,
  className = '',
}: WorktreeDesktopLayoutProps) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(initialLeftWidth);

  /**
   * Handle resize from PaneResizer.
   * Converts pixel delta to percentage and updates state with clamping.
   */
  const handleResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.offsetWidth;
      if (containerWidth === 0) return;

      // Convert pixel delta to percentage
      const percentageDelta = (delta / containerWidth) * 100;

      setLeftWidth((prev) => {
        const newWidth = prev + percentageDelta;
        // Clamp to min/max bounds
        return Math.min(maxLeftWidth, Math.max(minLeftWidth, newWidth));
      });
    },
    [minLeftWidth, maxLeftWidth]
  );

  // Render mobile layout for small screens
  if (isMobile) {
    return <MobileLayout leftPane={leftPane} rightPane={rightPane} />;
  }

  // Render desktop layout with resizable panes
  return (
    <div ref={containerRef} className="h-full">
      <DesktopLayout
        leftPane={leftPane}
        rightPane={rightPane}
        leftWidth={leftWidth}
        onResize={handleResize}
        className={className}
      />
    </div>
  );
});

export default WorktreeDesktopLayout;
