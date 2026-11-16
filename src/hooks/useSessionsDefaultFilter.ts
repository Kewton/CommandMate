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
 * - I3': saves are serial — the next PUT goes out only after the previous one
 *   answered, and of the clicks made meanwhile only the last waits. So the
 *   server's last write is always the default this page shows.
 * - I4: nothing saved / the read failed → the page is left as it is (no filter).
 * - I5: `differs` is `differsFromDefault(current, default)` and nothing else.
 * - I6: "every chosen role was deleted" is not "no role chosen": when nothing else
 *   is left, the deleted ids stay in the condition so the list stays narrowed
 *   (0 rows) instead of showing everything.
 * - I7: a GET is guarded by its own effect's flag; an older reply (StrictMode
 *   runs the effect twice) is dropped, success or failure.
 *
 * @module hooks/useSessionsDefaultFilter
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, sessionsApi } from '@/lib/api-client';
import { applySessionsDefaultFilter, differsFromDefault } from '@/lib/sessions-default-filter';
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

function isEmptyCondition(c: SessionsFilterCondition): boolean {
  return c.branchPattern === '' && c.roleIds.length === 0 && !c.includeNoRole && !c.includeAmbiguous;
}

/**
 * The default against the roles that exist now. Deleted roles are left out
 * (`applySessionsDefaultFilter`), except that when that would leave no condition
 * at all, the deleted ids are kept: they match nothing, so the list stays
 * narrowed instead of widening to every session (I6).
 */
function resolveDefault(
  stored: SessionsFilterCondition,
  existingRoleIds: readonly string[]
): { condition: SessionsFilterCondition; droppedRoleIds: string[] } {
  const result = applySessionsDefaultFilter(stored, existingRoleIds);
  if (result.droppedRoleIds.length > 0 && isEmptyCondition(result.condition)) {
    return { condition: { ...result.condition, roleIds: [...result.droppedRoleIds] }, droppedRoleIds: result.droppedRoleIds };
  }
  return { condition: result.condition, droppedRoleIds: result.droppedRoleIds };
}

export function useSessionsDefaultFilter({
  current,
  existingRoleIds,
  rolesReadiness,
  apply,
}: UseSessionsDefaultFilterOptions): UseSessionsDefaultFilterResult {
  /** undefined = still reading; null = nothing saved or the read failed (I4). */
  const [stored, setStored] = useState<SessionsFilterCondition | null | undefined>(undefined);
  const [droppedRoleIds, setDroppedRoleIds] = useState<string[]>([]);
  const [knownRoleIds, setKnownRoleIds] = useState<readonly string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<SessionsDefaultSaveError | null>(null);

  const mounted = useRef(true);
  const touched = useRef(false);
  const applied = useRef(false);
  /** A PUT is out (I3'). */
  const saveInFlight = useRef(false);
  /** The last condition clicked while a PUT was out; sent when it answers. */
  const pendingSave = useRef<SessionsFilterCondition | null>(null);
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
      const result = resolveDefault(stored, existingRoleIds);
      applyRef.current(result.condition);
      setDroppedRoleIds(result.droppedRoleIds);
    } else {
      // Roles unknown: keep the stored roles; nothing is reported as deleted.
      applyRef.current(copyCondition(stored));
    }
  }, [stored, rolesReadiness, existingRoleIds]);

  const roleIdsForDefault = rolesReadiness === 'ready' && existingRoleIds ? existingRoleIds : knownRoleIds;

  const defaults = useMemo<SessionsFilterCondition | null>(() => {
    if (!stored) return null;
    return roleIdsForDefault ? resolveDefault(stored, roleIdsForDefault).condition : stored;
  }, [stored, roleIdsForDefault]);

  // I5: the mark is this function's answer and nothing else.
  const differs = differsFromDefault(current, defaults);

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
      const result = resolveDefault(stored, roleIdsForDefault);
      applyRef.current(result.condition);
      setDroppedRoleIds(result.droppedRoleIds);
    } else {
      applyRef.current(copyCondition(stored));
    }
  }, [stored, roleIdsForDefault]);

  /** Send `first`, then whatever was clicked meanwhile, one PUT at a time (I3'). */
  const runSaves = useCallback(async (first: SessionsFilterCondition) => {
    saveInFlight.current = true;
    let outcome: { ok: true } | { ok: false; error: SessionsDefaultSaveError } = { ok: true };
    try {
      let next: SessionsFilterCondition | null = first;
      while (next) {
        pendingSave.current = null;
        try {
          const body = await sessionsApi.putDefaultFilter(next);
          if (!mounted.current) return;
          // Answers come in the order sent, so this is the server's latest write.
          savedOnce.current = true;
          setStored(copyCondition(body.filter));
          setDroppedRoleIds([]);
          outcome = { ok: true };
        } catch (error) {
          if (!mounted.current) return;
          // I3: the condition and the default stay as they are.
          outcome = {
            ok: false,
            error:
              error instanceof ApiError && error.status === 400
                ? { kind: 'invalid', detail: error.message }
                : { kind: 'failed' },
          };
        }
        next = pendingSave.current;
      }
    } finally {
      saveInFlight.current = false;
    }
    // Only the last request's outcome is shown (I3).
    setSaving(false);
    if (outcome.ok) setSaved(true);
    else setSaveError(outcome.error);
  }, []);

  const saveAsDefault = useCallback(async () => {
    // Saving declares the current condition as chosen: a late initial read must not replace it.
    touched.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    const condition = copyCondition(current);
    if (saveInFlight.current) {
      pendingSave.current = condition;
      return;
    }
    await runSaves(condition);
  }, [current, runSaves]);

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
