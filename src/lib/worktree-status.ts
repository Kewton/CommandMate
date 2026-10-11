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

// ============================================================================
// Saves vs. fetches already on the wire (Issue #3594)
// ============================================================================

/**
 * A counter that moves on every successful save. A fetch notes it when it
 * STARTS; when its reply lands, any worktree saved after that point keeps the
 * saved value, because the reply was read from the server before the save and
 * would put the old status back (Done → a late poll says Ready → Ready).
 */
let statusSaveGeneration = 0;

/** Latest successful save per worktree id. */
const savedStatuses = new Map<string, { generation: number; status: WorktreeLifecycleStatus | null }>();

/** Per-worktree tail of the save queue (see {@link saveWorktreeStatus}). */
const saveQueues = new Map<string, Promise<unknown>>();

/** Note this when a fetch of worktree data starts. */
export function currentWorktreeStatusGeneration(): number {
  return statusSaveGeneration;
}

/** Record a save the server has accepted. */
export function markWorktreeStatusSaved(
  worktreeId: string,
  status: WorktreeLifecycleStatus | null
): void {
  statusSaveGeneration += 1;
  savedStatuses.set(worktreeId, { generation: statusSaveGeneration, status });
}

/**
 * The status a fetch reply should show for one worktree: the reply's own,
 * unless a save landed after the fetch started — then the saved one.
 */
export function resolveFetchedWorktreeStatus(
  worktreeId: string,
  fetchedStatus: Worktree['status'],
  fetchStartedAt: number
): Worktree['status'] {
  const saved = savedStatuses.get(worktreeId);
  return saved && saved.generation > fetchStartedAt ? saved.status : fetchedStatus;
}

/**
 * {@link resolveFetchedWorktreeStatus} over one worktree. Returns the same
 * object when nothing is overridden.
 */
export function applySavedWorktreeStatus<T extends Pick<Worktree, 'id' | 'status'>>(
  worktree: T,
  fetchStartedAt: number
): T {
  const status = resolveFetchedWorktreeStatus(worktree.id, worktree.status, fetchStartedAt);
  return status === worktree.status ? worktree : { ...worktree, status };
}

/**
 * {@link applySavedWorktreeStatus} over a list. Returns the same array when
 * nothing is overridden.
 */
export function applySavedWorktreeStatuses<T extends Pick<Worktree, 'id' | 'status'>>(
  worktrees: T[],
  fetchStartedAt: number
): T[] {
  let changed = false;
  const next = worktrees.map((worktree) => {
    const applied = applySavedWorktreeStatus(worktree, fetchStartedAt);
    if (applied !== worktree) changed = true;
    return applied;
  });
  return changed ? next : worktrees;
}

/**
 * Save a worktree's status in pick order. Saves of the same worktree wait for
 * the previous one to settle (whatever its outcome), so the last pick is the
 * last PATCH the server sees. A successful save is recorded with
 * {@link markWorktreeStatusSaved} before the promise resolves.
 */
export function saveWorktreeStatus(
  worktreeId: string,
  status: WorktreeLifecycleStatus | null
): Promise<Worktree> {
  const previous = saveQueues.get(worktreeId) ?? Promise.resolve();
  const save = previous
    .catch(() => undefined)
    .then(() => patchWorktreeStatus(worktreeId, status))
    .then((updated) => {
      markWorktreeStatusSaved(worktreeId, status);
      return updated;
    });
  const tail = save.catch(() => undefined);
  saveQueues.set(worktreeId, tail);
  void tail.then(() => {
    if (saveQueues.get(worktreeId) === tail) saveQueues.delete(worktreeId);
  });
  return save;
}

/** Exported only for tests — forget every recorded save and queue. */
export function __resetWorktreeStatusSaves(): void {
  statusSaveGeneration = 0;
  savedStatuses.clear();
  saveQueues.clear();
}
