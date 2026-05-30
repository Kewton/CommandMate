/**
 * ActivityBar Component (Issue #727)
 *
 * VS Code-style vertical 48px Activity Bar. Hosts 6 activity icons.
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
 */

'use client';

import React, { memo, useCallback, useRef } from 'react';
import { ACTIVITIES, type ActivityId } from '@/config/activity-bar-config';

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
      id={ACTIVITY_BAR_ID}
      data-testid="activity-bar"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Activity Bar"
      className={`flex flex-col items-stretch w-12 flex-shrink-0 bg-gray-100 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 ${className}`.trim()}
    >
      {ACTIVITIES.map((activity, index) => {
        const Icon = activity.icon;
        const isActive = active === activity.id;
        return (
          <button
            key={activity.id}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={activity.label}
            aria-controls={ACTIVITY_PANE_ID}
            title={activity.label}
            tabIndex={isActive || (active === null && index === 0) ? 0 : -1}
            onClick={() => onToggle(activity.id)}
            onKeyDown={(e) => handleKeyDown(e, index, activity.id)}
            data-testid={`activity-bar-button-${activity.id}`}
            className={`flex items-center justify-center h-12 w-12 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-inset ${
              isActive
                ? 'text-cyan-600 dark:text-cyan-400 border-l-2 border-cyan-600 dark:border-cyan-400 bg-white dark:bg-gray-900'
                : 'text-gray-500 dark:text-gray-400 border-l-2 border-transparent hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            <Icon size={20} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
});

export default ActivityBar;
