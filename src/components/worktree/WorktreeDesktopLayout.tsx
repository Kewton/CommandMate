/**
 * WorktreeDesktopLayout Component
 *
 * Two-column grid layout with resizable panes
 * Wraps each pane in ErrorBoundary for fault isolation
 * Responsive: switches to single column on mobile
 */

'use client';

import React, { useState, useCallback, useRef, memo, ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { useIsMobile } from '@/hooks/useIsMobile';
import { PaneResizer } from './PaneResizer';

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

/** Default pane width settings */
const DEFAULT_LEFT_WIDTH = 50;
const DEFAULT_MIN_WIDTH = 20;
const DEFAULT_MAX_WIDTH = 80;

/**
 * Mobile layout component - single column with toggle
 */
function MobileLayout({
  leftPane,
  rightPane,
}: {
  leftPane: ReactNode;
  rightPane: ReactNode;
}) {
  const [activePane, setActivePane] = useState<'left' | 'right'>('right');

  return (
    <div data-testid="mobile-layout" className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 bg-gray-800">
        <button
          onClick={() => setActivePane('left')}
          className={`flex-1 py-2 px-4 text-sm font-medium transition-colors ${
            activePane === 'left'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-900'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          History
        </button>
        <button
          onClick={() => setActivePane('right')}
          className={`flex-1 py-2 px-4 text-sm font-medium transition-colors ${
            activePane === 'right'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-900'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          Terminal
        </button>
      </div>

      {/* Active pane content */}
      <div className="flex-1 overflow-hidden">
        <ErrorBoundary componentName={activePane === 'left' ? 'HistoryPane' : 'TerminalPane'}>
          {activePane === 'left' ? leftPane : rightPane}
        </ErrorBoundary>
      </div>
    </div>
  );
}

/**
 * Desktop layout component - two columns with resizer
 */
function DesktopLayout({
  leftPane,
  rightPane,
  leftWidth,
  onResize,
  className,
}: {
  leftPane: ReactNode;
  rightPane: ReactNode;
  leftWidth: number;
  onResize: (delta: number) => void;
  className: string;
}) {
  return (
    <div
      data-testid="desktop-layout"
      role="main"
      className={`flex h-full min-h-0 ${className}`}
    >
      {/* Left pane */}
      <div
        data-testid="left-pane"
        aria-label="History pane"
        style={{ width: `${leftWidth}%` }}
        className="flex-shrink-0 overflow-hidden"
      >
        <ErrorBoundary componentName="HistoryPane">
          {leftPane}
        </ErrorBoundary>
      </div>

      {/* Resizer */}
      <PaneResizer onResize={onResize} orientation="horizontal" ariaValueNow={leftWidth} />

      {/* Right pane */}
      <div
        data-testid="right-pane"
        aria-label="Terminal pane"
        style={{ width: `${100 - leftWidth}%` }}
        className="flex-grow overflow-hidden"
      >
        <ErrorBoundary componentName="TerminalPane">
          {rightPane}
        </ErrorBoundary>
      </div>
    </div>
  );
}

/**
 * WorktreeDesktopLayout component for two-column layout with resizable panes
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
   * Handle resize from PaneResizer
   * Converts pixel delta to percentage and updates state
   */
  const handleResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;

      const containerWidth = containerRef.current.offsetWidth;
      if (containerWidth === 0) return;

      // Convert pixel delta to percentage
      const percentageDelta = (delta / containerWidth) * 100;

      setLeftWidth((prev) => {
        const newWidth = prev + percentageDelta;
        // Clamp to min/max
        return Math.min(maxLeftWidth, Math.max(minLeftWidth, newWidth));
      });
    },
    [minLeftWidth, maxLeftWidth]
  );

  // Render mobile or desktop layout
  if (isMobile) {
    return <MobileLayout leftPane={leftPane} rightPane={rightPane} />;
  }

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
