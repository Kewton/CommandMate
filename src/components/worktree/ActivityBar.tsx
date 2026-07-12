/**
 * ActivityBar Component (Issue #727, updated by Issue #730)
 *
 * VS Code-style vertical 48px Activity Bar. Hosts 7 activity icons.
 *
 * Behavior:
 *   - Clicking an inactive icon switches to that activity.
 *   - Re-clicking the active icon toggles the ActivityPane closed.
 *   - Keyboard: Tab focuses each tab; ArrowUp/ArrowDown move focus within
 *     the tablist; Enter/Space activate the focused tab.
 *
 * Accessibility:
 *   - role="tablist" + aria-orientation="vertical"
 *   - Each button: role="tab", aria-selected, aria-label, aria-controls
 *   - id="worktree-activity-bar"
 *
 * Issue #730:
 *   - The native `title` attribute is replaced with a custom `Tooltip`
 *     component so styling matches the dark UI and shows after a 100ms
 *     hover delay. `aria-label` is kept as the primary accessible name and
 *     the Tooltip is `aria-hidden="true"` to avoid duplicate announcements.
 *   - The Tooltip wraps each button in a `<span tabindex="-1">`, so the
 *     internal `buttonRefs` still point at the actual `<button>` and the
 *     ArrowUp/ArrowDown/Home/End keyboard navigation keeps working.
 *
 * Issue #747:
 *   - The sidebar (Branches list) open/close toggle (hamburger) now lives at
 *     the TOP of the ActivityBar, replacing the one that used to sit in the
 *     DesktopHeader. It reads/controls the sidebar via `useSidebarContext()`.
 *   - The toggle is rendered OUTSIDE the `role="tablist"` element so it is not
 *     part of the roving-tabindex Arrow/Home/End navigation and does not change
 *     the tab count or WAI-ARIA tablist semantics.
 */

'use client';

import React, { memo, useCallback, useRef } from 'react';
import { Menu } from 'lucide-react';
import { ACTIVITIES, type ActivityId } from '@/config/activity-bar-config';
import { Tooltip } from '@/components/common/Tooltip';
import { useSidebarContext } from '@/contexts/SidebarContext';

export interface ActivityBarProps {
  /** Currently active activity, or null when ActivityPane is closed. */
  active: ActivityId | null;
  /**
   * Called when the user wants to "toggle" an activity:
   * - If the clicked activity is already active → close (parent should pass null to its state).
   * - Else → set the clicked activity as active.
   * Implementations typically delegate to `useActivityBarState().toggle`.
   */
  onToggle: (activity: ActivityId) => void;
  /** Optional extra className for the root element. */
  className?: string;
}

const ACTIVITY_BAR_ID = 'worktree-activity-bar';
const ACTIVITY_PANE_ID = 'worktree-activity-pane';

export const ActivityBar = memo(function ActivityBar({
  active,
  onToggle,
  className = '',
}: ActivityBarProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Issue #747: the Branches-sidebar toggle is hosted at the top of the
  // ActivityBar and drives the sidebar directly via SidebarContext.
  const { isOpen: isSidebarOpen, toggle: toggleSidebar } = useSidebarContext();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number, activity: ActivityId) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle(activity);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (index + 1) % ACTIVITIES.length;
        buttonRefs.current[next]?.focus();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = (index - 1 + ACTIVITIES.length) % ACTIVITIES.length;
        buttonRefs.current[prev]?.focus();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        buttonRefs.current[0]?.focus();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        buttonRefs.current[ACTIVITIES.length - 1]?.focus();
        return;
      }
    },
    [onToggle]
  );

  return (
    <div
      data-testid="activity-bar"
      className={`flex flex-col items-stretch w-12 flex-shrink-0 bg-gray-100 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 ${className}`.trim()}
    >
      {/* Issue #747: Sidebar (Branches) toggle. Rendered OUTSIDE the tablist so
          it is excluded from the roving-tabindex Arrow/Home/End navigation and
          does not change the tab count or WAI-ARIA tablist semantics. */}
      <Tooltip content="Toggle sidebar" placement="right">
        <button
          type="button"
          data-testid="activity-bar-toggle-sidebar"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
          aria-expanded={isSidebarOpen}
          className="flex items-center justify-center h-12 w-12 text-gray-500 dark:text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
      </Tooltip>
      {/* Separator between the sidebar toggle and the activity tabs */}
      <div
        className="mx-2 my-1 border-b border-gray-200 dark:border-gray-700"
        aria-hidden="true"
      />
      <div
        id={ACTIVITY_BAR_ID}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Activity Bar"
        className="flex flex-col items-stretch"
      >
        {ACTIVITIES.map((activity, index) => {
          const Icon = activity.icon;
          const isActive = active === activity.id;
          return (
            <Tooltip key={activity.id} content={activity.label} placement="right">
              <button
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={activity.label}
                aria-controls={ACTIVITY_PANE_ID}
                tabIndex={isActive || (active === null && index === 0) ? 0 : -1}
                onClick={() => onToggle(activity.id)}
                onKeyDown={(e) => handleKeyDown(e, index, activity.id)}
                data-testid={`activity-bar-button-${activity.id}`}
                className={`flex items-center justify-center h-12 w-12 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset ${
                  isActive
                    ? 'text-accent-600 dark:text-accent-400 border-l-2 border-accent-600 dark:border-accent-400 bg-white dark:bg-gray-900'
                    : 'text-gray-500 dark:text-gray-400 border-l-2 border-transparent hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                <Icon size={20} aria-hidden="true" />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});

export default ActivityBar;
