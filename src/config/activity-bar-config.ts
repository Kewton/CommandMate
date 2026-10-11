/**
 * Activity Bar Configuration (Issue #727)
 *
 * Defines the VS Code-style Activity Bar identifiers and metadata.
 * This module is consumed by:
 *   - `src/hooks/useActivityBarState.ts`
 *   - `src/components/worktree/HeaderToolBar.tsx` (PC, Issue #3591)
 *   - `src/components/worktree/ActivityBar.tsx` (no longer mounted on PC)
 *   - `src/components/worktree/ActivityPane.tsx`
 *   - `src/components/worktree/WorktreeDetailRefactored.tsx`
 *
 * The Activity Bar was a 48px-wide vertical bar that hosted the activities
 * below. Issue #3591: on PC they are icons at the right of the worktree header
 * ({@link HEADER_TOOLS}) and the Verification chip; the names below keep the
 * "activity bar" wording (storage keys, test helpers, the mobile tabs).
 * Re-clicking the active icon toggles the ActivityPane closed (null).
 */

import type { ComponentType, SVGProps } from 'react';
import { Files, GitBranch, StickyNote, Calendar, Bot, Timer, ListTodo, Sparkles, ShieldCheck, KeyRound } from 'lucide-react';

/**
 * Unique identifier for an activity in the Activity Bar.
 */
export type ActivityId =
  | 'files'
  | 'git'
  | 'notes'
  | 'schedules'
  | 'agent'
  | 'timer'
  | 'todo'
  | 'skills'
  | 'verification'
  | 'env';

/**
 * Metadata for a single Activity Bar icon.
 */
export interface ActivityDefinition {
  /** Stable identifier */
  id: ActivityId;
  /**
   * Tooltip / aria-label translation key within the `worktree` namespace
   * (Issue #1277).
   *
   * The label is stored as a KEY rather than a literal because `t()` cannot be
   * called at module scope; consumers resolve it at render time via
   * `useTranslations('worktree')` — see `ActivityBar.tsx`.
   */
  labelKey: string;
  /** Lucide icon component reference */
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

/**
 * Ordered list of activities rendered top-to-bottom in the Activity Bar.
 * The order here is the visual order in the ActivityBar UI and the keyboard
 * navigation order (ArrowDown/ArrowUp).
 */
export const ACTIVITIES: readonly ActivityDefinition[] = [
  // Issue #2616: the two-sheet `Files`, not the single-sheet `File` — at 20px
  // `File` and `notes`' `StickyNote` both read as one dog-eared page.
  { id: 'files', labelKey: 'activityBar.files', icon: Files },
  { id: 'git', labelKey: 'activityBar.git', icon: GitBranch },
  { id: 'notes', labelKey: 'activityBar.notes', icon: StickyNote },
  { id: 'schedules', labelKey: 'activityBar.schedules', icon: Calendar },
  { id: 'agent', labelKey: 'activityBar.agent', icon: Bot },
  { id: 'timer', labelKey: 'activityBar.timer', icon: Timer },
  // Issue #1015: branch-scoped ToDo list.
  { id: 'todo', labelKey: 'activityBar.todo', icon: ListTodo },
  // Issue #1441: worktree-scoped Skill install/uninstall management.
  { id: 'skills', labelKey: 'activityBar.skills', icon: Sparkles },
  // Issue #1816: the execution contract and the verification gates. Appended
  // rather than inserted so the existing ArrowUp/ArrowDown order — which users
  // and tests both index by position — is unchanged.
  { id: 'verification', labelKey: 'activityBar.verification', icon: ShieldCheck },
  // Issue #1968: the masked `.env` editor. Appended for the same reason
  // `verification` was — the ArrowUp/ArrowDown order is indexed by position by
  // both users and tests, so an insert would silently renumber every tab.
  { id: 'env', labelKey: 'activityBar.env', icon: KeyRound },
] as const;

/**
 * The activity whose entry point is not a header tool (Issue #3591): the
 * Verification pane opens from the Verification chip on the second row
 * (`VerificationStatusChip`, #3590), which already says where the branch
 * stands. It stays in {@link ACTIVITIES} — the pane, its label and the stored
 * state are unchanged — and is only left out of {@link HEADER_TOOLS}.
 */
export const CHIP_ACTIVITY_ID: ActivityId = 'verification';

/**
 * The tools drawn at the right of the PC worktree header (Issue #3591), in
 * {@link ACTIVITIES} order — the order of the ←/→ keys. Every activity except
 * {@link CHIP_ACTIVITY_ID}. On a narrow header the trailing ones fold behind a
 * "…" button (`useDesktopHeaderFit`).
 */
export const HEADER_TOOLS: readonly ActivityDefinition[] = ACTIVITIES.filter(
  (activity) => activity.id !== CHIP_ACTIVITY_ID
);

/**
 * Set of valid ActivityId values for runtime validation.
 */
export const VALID_ACTIVITY_IDS: ReadonlySet<ActivityId> = new Set<ActivityId>(
  ACTIVITIES.map((a) => a.id)
);

/**
 * The first activity in the bar — where keyboard focus lands when no activity
 * is open (`ActivityBar`'s roving tabindex).
 *
 * Issue #3589: no longer what an unvisited worktree opens. That is
 * {@link INITIAL_ACTIVITY} (closed), so the terminal starts at full width.
 */
export const DEFAULT_ACTIVITY: ActivityId = 'files';

/**
 * What the worktree screen shows when nothing is stored for the worktree (or
 * the stored value is not a known activity) — Issue #3589: `null`, the pane
 * starts closed. Before #3589 this was {@link DEFAULT_ACTIVITY} ('files'),
 * which took ~18% of the body away from the terminal on every first visit.
 *
 * A stored value (an activity or {@link ACTIVITY_CLOSED_SENTINEL}) is still
 * honoured as-is.
 */
export const INITIAL_ACTIVITY: ActivityId | null = null;

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
 * stored value" (an unvisited worktree), which defaults to
 * {@link INITIAL_ACTIVITY} (closed since Issue #3589).
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

/**
 * localStorage key for whether the activity pane is pinned (Issue #3589).
 *
 * - `'true'`  → pinned: the pane sits beside the body and narrows it (the
 *   pre-#3589 layout).
 * - anything else / absent → not pinned: the pane is laid OVER the body, which
 *   keeps its width, and closes on Esc / × / a re-click of its icon / an
 *   outside click / opening a file.
 *
 * One global key, not one per worktree: pinning is a choice about how the
 * screen is laid out, so it carries across worktrees. Read and written by
 * `usePanePinnedState` in `src/hooks/useActivityPaneOverlay.ts`.
 */
export const ACTIVITY_PANE_PINNED_STORAGE_KEY = 'commandmate.worktree.activityPanePinned';
