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

export interface UseSessionsRolesResult {
  /** Every role; `null` until read or when the list could not be read. */
  roles: AgentRoleSummary[] | null;
  /** Instance roles; `null` until the first read finishes. */
  source: SessionsRoleSource | null;
  reload: () => void;
}

export function useSessionsRoles({ poll }: { poll: boolean }): UseSessionsRolesResult {
  const [roles, setRoles] = useState<AgentRoleSummary[] | null>(null);
  const [source, setSource] = useState<SessionsRoleSource | null>(null);
  const mounted = useRef(true);

  const readSource = useCallback(async () => {
    try {
      const body = await sessionsApi.getRoles();
      if (!mounted.current) return;
      setSource({
        roleByWorktree: body.roleByWorktree ?? {},
        rolesUnavailable: body.rolesUnavailable === true,
      });
    } catch {
      if (mounted.current) setSource({ roleByWorktree: {}, rolesUnavailable: true });
    }
  }, []);

  const readRoles = useCallback(async () => {
    const result = await roleApi.list();
    if (!mounted.current) return;
    setRoles(result.ok ? result.data.roles : null);
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

  return { roles, source, reload };
}
