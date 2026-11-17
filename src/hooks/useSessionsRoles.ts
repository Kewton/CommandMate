/**
 * useSessionsRoles — what the /sessions role filter needs (Issue #4389).
 *
 * - `roles`: every role (`GET /api/roles`), for the checklist.
 * - `source`: the role of every instance (`GET /api/sessions/roles`, read once for
 *   the whole list). A failed read becomes `rolesUnavailable: true`, so the filter
 *   drops the role condition and the screen says so instead of silently showing
 *   all or nothing.
 *
 * Instance roles change as agents start and stop, so they are re-read on
 * {@link UseSessionsRolesResult.reload} and every {@link SESSIONS_ROLES_POLL_MS}
 * while `poll` is true (the page passes "a role condition is chosen"). The route
 * costs git work, so it is not read on the worktree list's short interval.
 * Each read adopts only its latest request, so a late reply never overwrites a
 * newer one.
 *
 * @module hooks/useSessionsRoles
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionsApi } from '@/lib/api-client';
import { roleApi } from '@/lib/api-client-agent-roles';
import type { SessionsRoleSource } from '@/lib/sessions-filter';
import type { AgentRoleSummary } from '@/types/agent-roles';

export const SESSIONS_ROLES_POLL_MS = 30_000;

export type SessionsRolesStatus = 'loading' | 'ok' | 'error';

export interface UseSessionsRolesResult {
  /** Every role; `null` until read or when the list could not be read. */
  roles: AgentRoleSummary[] | null;
  /**
   * Issue #4388: whether `roles` was read. `loading` only until the first read
   * settles; a later failed re-read turns it to `error`. Lets the default filter
   * tell "not read yet" and "could not read" apart from "this role was deleted".
   */
  rolesStatus: SessionsRolesStatus;
  /** Instance roles; `null` until the first read finishes. */
  source: SessionsRoleSource | null;
  reload: () => void;
}

export function useSessionsRoles({ poll }: { poll: boolean }): UseSessionsRolesResult {
  const [roles, setRoles] = useState<AgentRoleSummary[] | null>(null);
  const [rolesStatus, setRolesStatus] = useState<SessionsRolesStatus>('loading');
  const [source, setSource] = useState<SessionsRoleSource | null>(null);
  const mounted = useRef(true);
  // Only the latest request of each read is adopted (as in useWorktreesCache):
  // a slower earlier reply — success or failure — must not undo a newer one.
  const sourceSeq = useRef(0);
  const rolesSeq = useRef(0);

  const readSource = useCallback(async () => {
    const seq = ++sourceSeq.current;
    let next: SessionsRoleSource;
    try {
      const body = await sessionsApi.getRoles();
      next = {
        roleByWorktree: body.roleByWorktree ?? {},
        rolesUnavailable: body.rolesUnavailable === true,
      };
    } catch {
      next = { roleByWorktree: {}, rolesUnavailable: true };
    }
    if (!mounted.current || seq !== sourceSeq.current) return;
    setSource(next);
  }, []);

  const readRoles = useCallback(async () => {
    const seq = ++rolesSeq.current;
    const result = await roleApi.list();
    if (!mounted.current || seq !== rolesSeq.current) return;
    setRoles(result.ok ? result.data.roles : null);
    setRolesStatus(result.ok ? 'ok' : 'error');
  }, []);

  const reload = useCallback(() => {
    void readRoles();
    void readSource();
  }, [readRoles, readSource]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => void readSource(), SESSIONS_ROLES_POLL_MS);
    return () => clearInterval(timer);
  }, [poll, readSource]);

  return { roles, rolesStatus, source, reload };
}
