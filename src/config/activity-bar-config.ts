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
 * The Activity Bar is a 48px-wide vertical bar that hosts 6 activities.
 * Re-clicking the active icon toggles the ActivityPane closed (null).
 */

import type { ComponentType, SVGProps } from 'react';
import { File, GitBranch, StickyNote, Calendar, Bot, Timer } from 'lucide-react';

/**
 * Unique identifier for an activity in the Activity Bar.
 */
export type ActivityId = 'files' | 'git' | 'notes' | 'schedules' | 'agent' | 'timer';

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
 * localStorage key used by `useActivityBarState`.
 * Only persists when an activity is selected. A `null` (closed) state is
 * intentionally NOT persisted — see useActivityBarState.ts for rationale.
 */
export const ACTIVITY_BAR_STORAGE_KEY = 'commandmate.worktree.activeActivity';

/**
 * Runtime type guard for ActivityId.
 */
export function isActivityId(value: unknown): value is ActivityId {
  return typeof value === 'string' && VALID_ACTIVITY_IDS.has(value as ActivityId);
}
