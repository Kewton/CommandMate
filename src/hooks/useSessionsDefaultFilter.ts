/**
 * useSessionsDefaultFilter — the saved default condition of /sessions (Issue #4388).
 *
 * The page owns the condition; this hook reads the saved default
 * (`GET /api/settings/sessions-filter`), applies it to the page once, saves the
 * current condition as the default (`PUT`), puts it back, and says whether the
 * page is looking at something other than the default. Changes made on the page
 * are never saved implicitly: leaving the page and coming back starts again
 * from the default.
 *
 * The rules come from `@/lib/sessions-default-filter` and are not re-made here:
 * deleted roles are dropped by `applySessionsDefaultFilter`, the mark is
 * `differsFromDefault`.
 *
 * Invariants (each has a test in tests/unit/hooks/useSessionsDefaultFilter-4388.test.ts):
 * - I1: a change the user makes before the default arrives is not overwritten by it.
 * - I2: the default is applied once, after the role list is settled. When roles
 *   cannot be read, stored roles are kept as they are (not reported as deleted).
 * - I3: a failed save changes neither the condition nor the default; of
 *   overlapping saves only the latest request's result is adopted.
 * - I3' / I3'': saves are serial — the next PUT goes out only after the previous
 *   one answered, and of the clicks made meanwhile only the last waits. The wait
 *   lives in module state, one per destination (the PUT URL), so it survives
 *   leaving the page and coming back; another destination is never held back.
 *   So within one tab the server's last write is the default this page shows.
 *   (Two tabs saving at once are out of scope: that needs a version on the server.)
 * - I4: nothing saved / the read failed → the page is left as it is (no filter).
 * - I5: `differs` is `differsFromDefault(current, default)` and nothing else.
 * - I6 / I6': "every chosen role was deleted" is not "no role chosen": when nothing
 *   else is left, the deleted ids stay in the condition so the list stays narrowed
 *   (0 rows) instead of showing everything. "Nothing else is left" is the filter's
 *   own judgement (`isEmptyFilter`: `compileBranchPattern` + `hasRoleCondition`,
 *   whitespace trimmed there), not a copy.
 * - I8: the deleted-role notice is derived every render — the ids of the current
 *   condition (and, while the page shows the default, of the saved default) that
 *   are not among the roles that exist. It is not a separate state a save clears.
 * - I7: a GET is guarded by its own effect's flag; an older reply (StrictMode
 *   runs the effect twice) is dropped, success or failure.
 *
 * @module hooks/useSessionsDefaultFilter
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, SESSIONS_DEFAULT_FILTER_PATH, sessionsApi } from '@/lib/api-client';
import { applySessionsDefaultFilter, differsFromDefault } from '@/lib/sessions-default-filter';
import { compileBranchPattern, hasRoleCondition } from '@/lib/sessions-filter';
import type { SessionsFilterCondition } from '@/types/sessions-default-filter';

/**
 * Whether the role list can be used to tell a deleted role.
 * - `loading`: not read yet — wait.
 * - `ready`: read; a stored role missing from it was deleted.
 * - `unavailable`: could not be read — do not judge (keep stored roles).
 */
export type SessionsRolesReadiness = 'loading' | 'ready' | 'unavailable';

export type SessionsDefaultSaveError =
  | { kind: 'invalid'; detail: string }
  | { kind: 'failed' };

export interface UseSessionsDefaultFilterOptions {
  /** The condition the page shows now. */
  current: SessionsFilterCondition;
  /** Ids of the roles that exist (used when `rolesReadiness` is `ready`). */
  existingRoleIds: readonly string[] | null;
  rolesReadiness: SessionsRolesReadiness;
  /** Replace the page's condition. */
  apply: (condition: SessionsFilterCondition) => void;
}

export interface UseSessionsDefaultFilterResult {
  /** The default as it applies now (deleted roles dropped when known); null = none. */
  defaults: SessionsFilterCondition | null;
  /** True once a saved default is known. */
  hasDefault: boolean;
  /** The current condition is not the default (I5). */
  differs: boolean;
  /** Role ids dropped from the default because they were deleted. */
  droppedRoleIds: string[];
  /** Call on every change the user makes to the condition (I1). */
  noteUserChange: () => void;
  /** Put the default back (no-op when there is none). */
  resetToDefault: () => void;
  /** Save the current condition as the default. */
  saveAsDefault: () => Promise<void>;
  saving: boolean;
  saved: boolean;
  saveError: SessionsDefaultSaveError | null;
}

function copyCondition(c: SessionsFilterCondition): SessionsFilterCondition {
  return { ...c, roleIds: [...c.roleIds] };
}

/**
 * The default against the roles that exist now. Deleted roles are left out
 * (`applySessionsDefaultFilter`), except that when that would leave no condition
 * at all, the deleted ids are kept: they match nothing, so the list stays
 * narrowed instead of widening to every session (I6 / I6').
 */
function resolveDefault(
  stored: SessionsFilterCondition,
  existingRoleIds: readonly string[]
): SessionsFilterCondition {
  const result = applySessionsDefaultFilter(stored, existingRoleIds);
  if (result.droppedRoleIds.length > 0 && isEmptyFilter(result.condition)) {
    return { ...result.condition, roleIds: [...result.droppedRoleIds] };
  }
  return result.condition;
}

/**
 * True when the condition sets nothing, judged only by /sessions' own filter
 * (src/lib/sessions-filter.ts): no branch pattern (empty / whitespace-only, the
 * trim is there) and no role condition (I6').
 */
function isEmptyFilter(c: SessionsFilterCondition): boolean {
  const branch = compileBranchPattern(c.branchPattern);
  return branch.regex === null && branch.error === null && !hasRoleCondition(c);
}

function missingRoleIds(ids: readonly string[], existing: readonly string[]): string[] {
  return ids.filter((id) => !existing.includes(id));
}

/** How one queued save ended. `superseded`: a later click replaced it before it was sent. */
export type SerialSaveResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'superseded' };

interface SaveJob {
  send: () => Promise<unknown>;
  settle: (result: SerialSaveResult<unknown>) => void;
}
interface SaveLane {
  busy: boolean;
  pending: SaveJob | null;
}

/** I3'': one lane per destination, outside any mount, so a remounted page still waits. */
const saveLanes = new Map<string, SaveLane>();

async function drainLane(lane: SaveLane, first: SaveJob): Promise<void> {
  lane.busy = true;
  let job: SaveJob | null = first;
  while (job) {
    let result: SerialSaveResult<unknown>;
    try {
      result = { status: 'fulfilled', value: await job.send() };
    } catch (reason) {
      result = { status: 'rejected', reason };
    }
    job.settle(result);
    job = lane.pending;
    lane.pending = null;
  }
  lane.busy = false;
}

/**
 * Send to `key` one at a time: while a send is out, the latest call waits and an
 * earlier waiting call is answered `superseded` without being sent. Different keys
 * never wait for each other.
 */
export function sendSerially<T>(key: string, send: () => Promise<T>): Promise<SerialSaveResult<T>> {
  let lane = saveLanes.get(key);
  if (!lane) {
    lane = { busy: false, pending: null };
    saveLanes.set(key, lane);
  }
  const target = lane;
  return new Promise<SerialSaveResult<T>>((resolve) => {
    const job: SaveJob = { send, settle: (r) => resolve(r as SerialSaveResult<T>) };
    if (target.busy) {
      target.pending?.settle({ status: 'superseded' });
      target.pending = job;
      return;
    }
    void drainLane(target, job);
  });
}

/** Tests only: forget every lane, so one test's unanswered save does not hold the next. */
export function resetSessionsDefaultFilterSaveQueueForTests(): void {
  saveLanes.clear();
}

export function useSessionsDefaultFilter({
  current,
  existingRoleIds,
  rolesReadiness,
  apply,
}: UseSessionsDefaultFilterOptions): UseSessionsDefaultFilterResult {
  /** undefined = still reading; null = nothing saved or the read failed (I4). */
  const [stored, setStored] = useState<SessionsFilterCondition | null | undefined>(undefined);
  const [knownRoleIds, setKnownRoleIds] = useState<readonly string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<SessionsDefaultSaveError | null>(null);

  const mounted = useRef(true);
  const touched = useRef(false);
  const applied = useRef(false);
  /** Number of the latest save clicked on this mount: only its outcome is shown (I3). */
  const saveSeq = useRef(0);
  const savedOnce = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    mounted.current = true;
    // I7: this effect's own flag — a later run (StrictMode) makes this reply stale.
    let active = true;
    void (async () => {
      let next: SessionsFilterCondition | null;
      try {
        const body = await sessionsApi.getDefaultFilter();
        next = body.configured ? copyCondition(body.filter) : null;
      } catch {
        next = null; // I4: a failed read filters nothing.
      }
      if (!active) return;
      // A save that already succeeded is newer than this read.
      if (savedOnce.current) return;
      setStored(next);
    })();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  // Remember the last role list that could be read, so a later failed re-read
  // does not make the default look different.
  useEffect(() => {
    if (rolesReadiness === 'ready' && existingRoleIds) setKnownRoleIds(existingRoleIds);
  }, [rolesReadiness, existingRoleIds]);

  // I1 / I2 / I4: apply the default once, after the role list has settled.
  useEffect(() => {
    if (applied.current || stored === undefined) return;
    if (stored === null) {
      applied.current = true;
      return;
    }
    if (rolesReadiness === 'loading') return;
    applied.current = true;
    if (touched.current) return;
    if (rolesReadiness === 'ready' && existingRoleIds) {
      applyRef.current(resolveDefault(stored, existingRoleIds));
    } else {
      // Roles unknown: keep the stored roles; nothing is reported as deleted.
      applyRef.current(copyCondition(stored));
    }
  }, [stored, rolesReadiness, existingRoleIds]);

  const roleIdsForDefault = rolesReadiness === 'ready' && existingRoleIds ? existingRoleIds : knownRoleIds;

  const defaults = useMemo<SessionsFilterCondition | null>(() => {
    if (!stored) return null;
    return roleIdsForDefault ? resolveDefault(stored, roleIdsForDefault) : stored;
  }, [stored, roleIdsForDefault]);

  // I5: the mark is this function's answer and nothing else.
  const differs = differsFromDefault(current, defaults);

  // I8: derived every render, never stored apart from the condition.
  const droppedRoleIds = useMemo(() => {
    if (!roleIdsForDefault) return []; // I2: roles never read — nothing is "deleted".
    const ids = new Set(missingRoleIds(current.roleIds, roleIdsForDefault));
    if (stored && !differs) for (const id of missingRoleIds(stored.roleIds, roleIdsForDefault)) ids.add(id);
    return [...ids];
  }, [current.roleIds, stored, differs, roleIdsForDefault]);

  const noteUserChange = useCallback(() => {
    touched.current = true;
    setSaved(false);
    setSaveError(null);
  }, []);

  const resetToDefault = useCallback(() => {
    if (!stored) return;
    touched.current = true;
    setSaved(false);
    setSaveError(null);
    if (roleIdsForDefault) {
      applyRef.current(resolveDefault(stored, roleIdsForDefault));
    } else {
      applyRef.current(copyCondition(stored));
    }
  }, [stored, roleIdsForDefault]);

  const saveAsDefault = useCallback(async () => {
    const seq = ++saveSeq.current;
    // Saving declares the current condition as chosen: a late initial read must not replace it.
    touched.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    const condition = copyCondition(current);
    // I3'': waits for any PUT to the same place that is still out, even from an earlier visit.
    const result = await sendSerially(SESSIONS_DEFAULT_FILTER_PATH, () => sessionsApi.putDefaultFilter(condition));
    if (!mounted.current || result.status === 'superseded') return;
    if (result.status === 'fulfilled') {
      // Answers come in the order sent, so this is the server's latest write.
      savedOnce.current = true;
      setStored(copyCondition(result.value.filter));
    }
    if (seq !== saveSeq.current) return; // a later click on this page shows its own outcome
    setSaving(false);
    if (result.status === 'fulfilled') {
      setSaved(true);
    } else {
      // I3: the condition and the default stay as they are.
      const error = result.reason;
      setSaveError(
        error instanceof ApiError && error.status === 400
          ? { kind: 'invalid', detail: error.message }
          : { kind: 'failed' }
      );
    }
  }, [current]);

  return {
    defaults,
    hasDefault: Boolean(stored),
    differs,
    droppedRoleIds,
    noteUserChange,
    resetToDefault,
    saveAsDefault,
    saving,
    saved,
    saveError,
  };
}
