/**
 * Activity Bar Configuration (Issue #727)
 *
 * Defines the VS Code-style Activity Bar identifiers and metadata.
 * This module is consumed by:
 *   - `src/hooks/useActivityBarState.ts`
 *   - `src/components/worktree/ActivityBar.tsx`
 *   - `src/components/worktree/ActivityPane.tsx`
 *   - `src/components/worktree/WorktreeDetailRefactored.tsx`
 *
 * The Activity Bar is a 48px-wide vertical bar that hosts 7 activities.
 * Re-clicking the active icon toggles the ActivityPane closed (null).
 */

import type { ComponentType, SVGProps } from 'react';
import { File, GitBranch, StickyNote, Calendar, Bot, Timer, ListTodo } from 'lucide-react';

/**
 * Unique identifier for an activity in the Activity Bar.
 */
export type ActivityId = 'files' | 'git' | 'notes' | 'schedules' | 'agent' | 'timer' | 'todo';

/**
 * Metadata for a single Activity Bar icon.
 */
export interface ActivityDefinition {
  /** Stable identifier */
  id: ActivityId;
  /** Tooltip text */
  label: string;
  /** Lucide icon component reference */
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

/**
 * Ordered list of activities rendered top-to-bottom in the Activity Bar.
 * The order here is the visual order in the ActivityBar UI and the keyboard
 * navigation order (ArrowDown/ArrowUp).
 */
export const ACTIVITIES: readonly ActivityDefinition[] = [
  { id: 'files', label: 'Files', icon: File },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'notes', label: 'Notes', icon: StickyNote },
  { id: 'schedules', label: 'Schedules', icon: Calendar },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'timer', label: 'Timer', icon: Timer },
  // Issue #1015: branch-scoped ToDo list. Label is hardcoded English (i18n
  // non-transit), consistent with the other PC Activity Bar labels.
  { id: 'todo', label: 'ToDo', icon: ListTodo },
] as const;

/**
 * Set of valid ActivityId values for runtime validation.
 */
export const VALID_ACTIVITY_IDS: ReadonlySet<ActivityId> = new Set<ActivityId>(
  ACTIVITIES.map((a) => a.id)
);

/**
 * Default activity selected on first visit / fallback when persisted value is invalid.
 */
export const DEFAULT_ACTIVITY: ActivityId = 'files';

/**
 * localStorage key prefix used by `useActivityBarState` (Issue #858).
 *
 * The active activity is persisted *per worktree* — the full key is
 * `${ACTIVITY_BAR_STORAGE_KEY_PREFIX}${worktreeId}`. This mirrors the
 * per-worktree CLI tab key (`activeCliTab-<worktreeId>`) so the Activity Bar
 * open/closed state no longer leaks across branch (worktree) switches.
 *
 * Prior to #858 a single global key (`commandmate.worktree.activeActivity`,
 * no worktree suffix) was used, which caused the hidden/shown state to reset
 * when switching branches.
 */
export const ACTIVITY_BAR_STORAGE_KEY_PREFIX = 'commandmate.worktree.activeActivity-';

/**
 * Sentinel value persisted to localStorage to represent the *explicitly closed*
 * (hidden) pane state (Issue #858).
 *
 * Unlike the pre-#858 behavior — which intentionally did NOT persist the closed
 * state — the closed state is now stored so that hiding the pane on one branch
 * survives a round-trip to another branch and back. It is distinct from "no
 * stored value" (an unvisited worktree), which still defaults to
 * {@link DEFAULT_ACTIVITY}.
 */
export const ACTIVITY_CLOSED_SENTINEL = '__closed__';

/**
 * Build the per-worktree localStorage key for the Activity Bar state.
 */
export function getActivityBarStorageKey(worktreeId: string): string {
  return `${ACTIVITY_BAR_STORAGE_KEY_PREFIX}${worktreeId}`;
}

/**
 * Runtime type guard for ActivityId.
 */
export function isActivityId(value: unknown): value is ActivityId {
  return typeof value === 'string' && VALID_ACTIVITY_IDS.has(value as ActivityId);
}
