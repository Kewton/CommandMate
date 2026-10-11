/**
 * Worktree lifecycle status ("how far along is this branch") — Issue #3594.
 *
 * Not to be confused with the CLI status (`BranchStatus`: idle / running /
 * waiting …), which is what the agent is doing right now. This one is set by
 * the user: Not set / Ready / In Progress / In Review / Done, stored on the
 * worktree row and changed with `PATCH /api/worktrees/<id> { status }`.
 */

import type { Worktree } from '@/types/models';

/** A set lifecycle status; `null` is "Not set". */
export type WorktreeLifecycleStatus = NonNullable<Worktree['status']>;

/**
 * The choices, in menu order (Issue #1277: `labelKey` is resolved against the
 * `worktree` namespace at the call site). Shared by the row's "…" → Status
 * submenu and the Info field's select.
 */
export const WORKTREE_STATUS_OPTIONS: ReadonlyArray<{
  value: WorktreeLifecycleStatus | null;
  labelKey: string;
}> = [
  { value: null, labelKey: 'worktreeStatus.notSet' },
  { value: 'ready', labelKey: 'worktreeStatus.ready' },
  { value: 'in_progress', labelKey: 'worktreeStatus.inProgress' },
  { value: 'in_review', labelKey: 'worktreeStatus.inReview' },
  { value: 'done', labelKey: 'worktreeStatus.done' },
];

/** `worktree` namespace key for a status label ("Not set" for null). */
export function worktreeStatusLabelKey(status: WorktreeLifecycleStatus | null | undefined): string {
  return (
    WORKTREE_STATUS_OPTIONS.find((option) => option.value === (status ?? null))?.labelKey ??
    'worktreeStatus.notSet'
  );
}

/**
 * Pill colours of a set status — the same tones the Sessions screen uses, so
 * "In Review" looks alike wherever it is shown.
 */
export const WORKTREE_STATUS_BADGE_CLASSES: Record<WorktreeLifecycleStatus, string> = {
  ready: 'bg-muted text-muted-foreground',
  in_progress: 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400',
  in_review: 'bg-info-subtle text-info-foreground',
  done: 'bg-success-subtle text-success-foreground',
};

/** The colour a narrow row shrinks the pill to (a dot). */
export const WORKTREE_STATUS_DOT_CLASSES: Record<WorktreeLifecycleStatus, string> = {
  ready: 'bg-muted-foreground',
  in_progress: 'bg-accent-500',
  in_review: 'bg-info',
  done: 'bg-success',
};

/**
 * Save a worktree's lifecycle status. Resolves with the updated worktree;
 * rejects when the server refuses or cannot be reached, so the caller can tell
 * the user and put the old value back.
 */
export async function patchWorktreeStatus(
  worktreeId: string,
  status: WorktreeLifecycleStatus | null
): Promise<Worktree> {
  const response = await fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update worktree status: HTTP ${response.status}`);
  }
  return (await response.json()) as Worktree;
}
