/**
 * Where New task last sent (Issue #3511).
 *
 * A target is a worktree ID plus an instance ID — never a display name, which
 * an alias rename or a branch switch would change under it. Kept per browser in
 * localStorage, newest first, at most {@link MAX_RECENT_TARGETS}.
 *
 * Neither function throws: SSR (no window), a private window or a refused
 * storage behave as "nothing recorded", and the dialog still works.
 */

/** One send destination. */
export interface NewTaskTarget {
  worktreeId: string;
  instanceId: string;
}

export const RECENT_TARGETS_STORAGE_KEY = 'commandmate.newTask.recentTargets';

/** How many destinations the dialog offers as shortcuts. */
export const MAX_RECENT_TARGETS = 3;

function isTarget(value: unknown): value is NewTaskTarget {
  if (value === null || typeof value !== 'object') return false;
  const { worktreeId, instanceId } = value as Record<string, unknown>;
  return typeof worktreeId === 'string' && worktreeId !== ''
    && typeof instanceId === 'string' && instanceId !== '';
}

export function sameTarget(a: NewTaskTarget, b: NewTaskTarget): boolean {
  return a.worktreeId === b.worktreeId && a.instanceId === b.instanceId;
}

/** The recorded destinations, newest first. Malformed entries are dropped. */
export function readRecentTargets(): NewTaskTarget[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_TARGETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isTarget)
      .map(({ worktreeId, instanceId }) => ({ worktreeId, instanceId }))
      .slice(0, MAX_RECENT_TARGETS);
  } catch {
    return [];
  }
}

/** Record `target` as the newest destination and return the new list. */
export function pushRecentTarget(target: NewTaskTarget): NewTaskTarget[] {
  const next = [
    { worktreeId: target.worktreeId, instanceId: target.instanceId },
    ...readRecentTargets().filter((entry) => !sameTarget(entry, target)),
  ].slice(0, MAX_RECENT_TARGETS);
  if (typeof window === 'undefined') return next;
  try {
    window.localStorage.setItem(RECENT_TARGETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not recorded on a storage that refuses writes; the send itself went out.
  }
  return next;
}
