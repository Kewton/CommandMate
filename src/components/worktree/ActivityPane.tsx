/**
 * ActivityPane Component (Issue #727)
 *
 * Renders the content for the currently active ActivityId from the
 * VS Code-style Activity Bar.
 *
 * Design note:
 *   The parent (WorktreeDetailRefactored) owns all of the data + callbacks
 *   needed by each activity child (FileTreeView, GitPane, MemoPane,
 *   ExecutionLogPane, AgentInstancesPane, TimerPane). To keep this component
 *   thin and decoupled, the parent constructs each child node and passes
 *   them in via the `activities` map. ActivityPane simply picks the right
 *   one and wraps it in an ErrorBoundary.
 *
 * Layout:
 *   - id="worktree-activity-pane" (referenced by ActivityBar's aria-controls).
 *   - Fills the parent column height.
 */

'use client';

import React, { memo, type ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import type { ActivityId } from '@/config/activity-bar-config';

/**
 * Map of pre-built activity content keyed by ActivityId.
 * Use `null` for activities the caller does not want to render (rare).
 */
export type ActivityContentMap = Partial<Record<ActivityId, ReactNode>>;

export interface ActivityPaneProps {
  /** Currently active activity. `null` means render nothing. */
  active: ActivityId | null;
  /** Map of pre-built activity contents (parent-owned). */
  activities: ActivityContentMap;
  /** Optional className for the root container. */
  className?: string;
}

const ACTIVITY_PANE_ID = 'worktree-activity-pane';

const ERROR_BOUNDARY_NAMES: Record<ActivityId, string> = {
  files: 'FileTreeView',
  git: 'GitPane',
  notes: 'MemoPane',
  schedules: 'ExecutionLogPane',
  // Issue #2067: the `agent` activity renders AgentInstancesPane (see
  // WorktreeDetailDesktop's `activityContent`), not AgentSettingsPane — the
  // mobile checkbox pane, which this map has never pointed at. The name is what
  // an ErrorBoundary crash report is filed under, so the wrong one sends whoever
  // reads the report to the wrong file.
  agent: 'AgentInstancesPane',
  timer: 'TimerPane',
  todo: 'TodoPane',
  skills: 'WorktreeSkillsPane',
  verification: 'VerificationPane',
  env: 'EnvManagerPane',
};

export const ActivityPane = memo(function ActivityPane({
  active,
  activities,
  className = '',
}: ActivityPaneProps) {
  // Closed state — render an empty stub so the parent layout can still measure
  // the pane and hide it (the desktop layout handles the "no column" case;
  // this guard is defensive).
  if (active === null) {
    return (
      <div
        id={ACTIVITY_PANE_ID}
        data-testid="activity-pane"
        data-active="none"
        className={`h-full flex flex-col ${className}`.trim()}
      />
    );
  }

  const content = activities[active];
  const componentName = ERROR_BOUNDARY_NAMES[active];

  return (
    <div
      id={ACTIVITY_PANE_ID}
      data-testid="activity-pane"
      data-active={active}
      role="tabpanel"
      aria-labelledby={`activity-bar-button-${active}`}
      className={`h-full flex flex-col min-h-0 ${className}`.trim()}
    >
      <ErrorBoundary componentName={componentName}>
        {content ?? null}
      </ErrorBoundary>
    </div>
  );
});

export default ActivityPane;
